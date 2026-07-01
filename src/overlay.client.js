/*
 * regoro.de Inline-Editor — Browser-Overlay
 *
 * Plain, dependency-freies Browser-JS. Kein Bundler, kein Build.
 * Wird vom Editor-Host vor </body> eingebunden via <script src="/edit-assets/overlay.js">.
 *
 * Erwartet (vom Server injiziert):
 *   - window.__REGORO_EDIT__ = { pagePath, fileHash, pages?:string[], page?:string }
 *   - data-edit-idx="N" auf jedem editierbaren Text-Lauf (inline-<span>, auch der
 *     Text rund um Inline-Links — Mixed-Content). Format gilt für den GANZEN Lauf.
 *   - data-edit-img-idx="N" auf jedem austauschbaren <img> (Bild-Upload im Edit-Modus).
 *   - data-edit-del-idx="N" auf jedem löschbaren/erweiterbaren Block-Element.
 *   - data-edit-br-idx="N" auf jedem <br> (per Backspace am Zeilenanfang löschbar).
 *
 * Befehlsbasiertes Modell (v3-B/v4): der Client schickt KEIN Markup, nur Ops;
 * der Server baut <strong>/<em>/<a>/<span style=color>. Whole-Run gilt für den ganzen
 * Lauf; Range-Ops (v4) formatieren einen markierten Teilbereich (Zeichen-Offsets).
 *
 * HTTP-Contract (alle same-origin):
 *   POST /edit/save  { pagePath, fileHash, edits: Op[] }   -> 200 {ok,fileHash} | 409
 *        Op = { idx, text?, bold?, italic?, underline?, link?, color? }  (Whole-Run; link/color=…|null)
 *           | { idx, start, end, bold?, italic?, underline?, color? }    (Range/Markierung, v4)
 *           | { idx, brAt }                                              (Enter -> <br> an Offset)
 *           | { op:"deleteBr", brIdx }                                   (<br> entfernen, Backspace)
 *           | { op:"delete", delIdx }                                    (Block löschen)
 *   POST /edit/upload          multipart: pagePath, imgIdx, image (Datei)
 *        -> 200 { ok:true, src, fileHash } | 400 { error } (committet serverseitig sofort)
 *   GET  /edit/versions?page=<basename>
 *        -> 200 [{ commit, date, subject }]
 *   GET  /edit/version/<commit>?page=<basename>   (read-only HTML-Vorschau)
 *   POST /edit/restore         { commit, pagePath } -> 200 { ok:true }
 *
 * Alle UI-Elemente und CSS-Klassen sind mit "__regoro" geprefixt, damit nichts
 * mit site/styles.css kollidiert.
 */
(function () {
  "use strict";

  var CFG = window.__REGORO_EDIT__;
  // 1. Ohne Config still nichts tun.
  if (!CFG || typeof CFG.pagePath !== "string" || typeof CFG.fileHash !== "string") {
    return;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var editing = false;
  // Pro editierbarem Lauf: { el, idx, original (Text), origFmt, fmt }.
  // fmt/origFmt = { bold:bool, italic:bool, link:string|null } — Format des GANZEN Laufs.
  var elements = [];
  var activeRun = null;     // aktuell fokussierter elements-Eintrag (für die Format-Toolbar)
  var versionsPanel = null;
  // Bild-Austausch-State.
  var images = [];          // [{ img, imgIdx, badge, imgClickHandler }]
  var fileInput = null;     // verstecktes <input type="file">, lazily erzeugt
  var activeImage = null;   // Bild, dessen Datei-Dialog gerade offen ist
  var uploadInFlight = false;
  var imageBadgeListenersBound = false; // scroll/resize-Reposition nur einmal binden
  // Struktur-Ops (delete/insert) — gesammelt bis zum Speichern.
  var structOps = [];       // [{op:"delete",delIdx} | {op:"insert",afterDelIdx}]
  // Bereich-basierte Format-Ops (v4) — gesammelt bis zum Speichern.
  // [{ idx, start, end, bold?, italic?, underline?, color? }] — Markierungs-Teilbereiche.
  var rangeOps = [];
  // Anzahl der beim letzten collectOps() verworfenen (veralteten) Fallback-Range-Ops
  // — für eine sichtbare Warnung beim Speichern (kein stilles Weglassen).
  var lastCollectDropped = 0;
  // Enter -> <br>: KEIN Queue mehr. Die brAt-Ops werden beim Speichern aus dem
  // finalen DOM abgeleitet (Vorschau-<br class="__regoro-br-preview"> pro Lauf),
  // damit Enter->Backspace im selben Zyklus ein sauberer No-op ist.
  // <br>-Lösch-Ops (Backspace am Zeilenanfang) für GESPEICHERTE <br> — [{ op:"deleteBr", brIdx }]
  var deleteBrOps = [];

  // pageBasename = letztes Pfadsegment von pagePath (Contract: page-Query = Basename).
  var pageBasename = CFG.pagePath.split("/").pop() || CFG.pagePath;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        if (k === "class") node.className = props[k];
        else if (k === "text") node.textContent = props[k];
        else if (k === "html") node.innerHTML = props[k];
        else node.setAttribute(k, props[k]);
      });
    }
    (children || []).forEach(function (c) {
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  // Format eines Laufs aus seinen DOM-Vorfahren ableiten (ganzer Lauf).
  // Liest <strong>/<b>, <em>/<i>, <u>, <a href> und eine inline gesetzte Textfarbe.
  function readFmt(node) {
    var bold = !!node.closest("strong, b");
    var italic = !!node.closest("em, i");
    var underline = !!node.closest("u");
    var anchor = node.closest("a[href]");
    var link = anchor ? anchor.getAttribute("href") : null;
    return { bold: bold, italic: italic, underline: underline, link: link, color: readColor(node) };
  }

  // Whole-Run-Farbe: eine inline gesetzte color am Span oder einem Vorfahr-Wrapper
  // (z.B. <span style="color:#..."> um den Lauf). Liefert Hex|null.
  // Nur EXPLIZIT gesetzte Inline-Farben zählen — nicht die vom Theme geerbte.
  function readColor(node) {
    var cur = node;
    var depth = 0;
    while (cur && cur.nodeType === 1 && depth < 4) {
      // contenteditable-Span trägt evtl. unsere Vorschau-Inline-Farbe -> die zählt mit.
      if (cur.style && cur.style.color) return normalizeHex(cur.style.color);
      cur = cur.parentElement;
      depth++;
    }
    return null;
  }

  // CSS-Farbe (rgb()/Hex/Name) best-effort in #rrggbb normalisieren.
  function normalizeHex(c) {
    if (!c) return null;
    c = String(c).trim();
    if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(c)) {
      return ("#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toLowerCase();
    }
    var m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) {
      return "#" + [m[1], m[2], m[3]].map(function (n) {
        var h = Number(n).toString(16);
        return h.length === 1 ? "0" + h : h;
      }).join("").toLowerCase();
    }
    return c; // unbekanntes Format unverändert lassen
  }

  // Editierbare Läufe einsammeln, Ausgangstext + Ausgangs-Format merken.
  function collectElements() {
    elements = [];
    var nodes = document.querySelectorAll("[data-edit-idx]");
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var idx = Number(node.getAttribute("data-edit-idx"));
      if (isNaN(idx)) continue;
      var fmt = readFmt(node);
      elements.push({
        el: node,
        idx: idx,
        original: node.textContent,
        origFmt: fmt,
        fmt: { bold: fmt.bold, italic: fmt.italic, underline: fmt.underline, link: fmt.link, color: fmt.color }
      });
    }
  }

  function textChanged(e) {
    return e.el.textContent !== e.original;
  }
  function fmtChanged(e) {
    return e.fmt.bold !== e.origFmt.bold ||
           e.fmt.italic !== e.origFmt.italic ||
           e.fmt.underline !== e.origFmt.underline ||
           e.fmt.link !== e.origFmt.link ||
           e.fmt.color !== e.origFmt.color;
  }

  // Dirty = Text-/Format-Änderung, oder Range-/deleteBr-/Struktur-Ops liegen vor,
  // oder es gibt ungespeicherte Vorschau-<br> im DOM (aus Enter).
  function isDirty() {
    if (structOps.length > 0 || rangeOps.length > 0 ||
        deleteBrOps.length > 0 || hasPreviewBr() || hasPreviewRangeFmt()) return true;
    for (var i = 0; i < elements.length; i++) {
      if (textChanged(elements[i]) || fmtChanged(elements[i])) return true;
    }
    return false;
  }

  // Alle Ops fürs Speichern sammeln:
  //   Whole-Run-Ops {idx,text?,bold?,italic?,underline?,link?,color?}
  //   + Range-Ops    {idx,start,end,bold?,italic?,underline?,color?}
  //   + BR-Ops       {idx,brAt}
  //   + deleteBr-Ops {op:"deleteBr",brIdx}
  //   + Struktur-Ops {op:"delete"|"insert",...}
  function collectOps() {
    var ops = [];
    lastCollectDropped = 0;
    var changedTextIdx = {}; // Läufe, deren Text sich geändert hat (idx -> true)
    for (var i = 0; i < elements.length; i++) {
      var e = elements[i];
      var tChanged = textChanged(e);
      var fChanged = fmtChanged(e);
      if (tChanged) changedTextIdx[e.idx] = true;
      if (!tChanged && !fChanged) continue;
      var op = { idx: e.idx };
      if (tChanged) op.text = e.el.textContent;
      // Format nur mitschicken, wenn es sich gegenüber dem Ausgangszustand geändert hat.
      if (e.fmt.bold !== e.origFmt.bold) op.bold = e.fmt.bold;
      if (e.fmt.italic !== e.origFmt.italic) op.italic = e.fmt.italic;
      if (e.fmt.underline !== e.origFmt.underline) op.underline = e.fmt.underline;
      if (e.fmt.link !== e.origFmt.link) op.link = e.fmt.link;
      if (e.fmt.color !== e.origFmt.color) op.color = e.fmt.color;
      ops.push(op);
    }
    // Additive Range-Format-Ops (bold/italic/underline/color) aus dem DOM ableiten —
    // pro Vorschau-Span die AKTUELLEN Offsets. So wandert die Formatierung mit
    // zwischenzeitlichen Textedits mit UND bleibt erhalten (statt verworfen zu werden).
    var domRangeOps = collectRangeOpsFromDom();
    for (var r2 = 0; r2 < domRangeOps.length; r2++) ops.push(domRangeOps[r2]);
    // Verbliebene gequeute Range-Ops (Entformatierung {which:false} bzw. Fallback,
    // wenn keine Vorschau möglich war) — fail-safe: bei Textänderung im selben Lauf
    // sind die fixen start/end veraltet -> verwerfen statt falsch anzuwenden.
    for (var k = 0; k < rangeOps.length; k++) {
      if (changedTextIdx[rangeOps[k].idx]) { lastCollectDropped++; continue; }
      ops.push(rangeOps[k]);
    }
    // BR-Ops aus dem FINALEN DOM ableiten (nicht aus einem Queue): pro Lauf jedes
    // ungespeicherte <br class="__regoro-br-preview"> -> {idx, brAt:offset}. Wurde eine
    // Vorschau-<br> per Backspace entfernt, ist sie nicht mehr im DOM -> keine Op.
    var brOpsFromDom = collectBrOpsFromDom();
    for (var b = 0; b < brOpsFromDom.length; b++) ops.push(brOpsFromDom[b]);
    // deleteBr-Ops anhängen (gespeichertes <br> per Backspace/Entf entfernt).
    for (var d = 0; d < deleteBrOps.length; d++) ops.push(deleteBrOps[d]);
    // Struktur-Ops anhängen (delete/insert).
    for (var j = 0; j < structOps.length; j++) ops.push(structOps[j]);
    return ops;
  }

  // brAt-Ops aus dem tatsächlichen DOM-Zustand der Läufe ableiten. Pro Lauf-Span
  // werden die enthaltenen Vorschau-<br> in Dokumentreihenfolge gefunden und für
  // jedes der Zeichen-Offset im Lauf-Text berechnet (charOffsetInRun bis zum <br>).
  function collectBrOpsFromDom() {
    var out = [];
    for (var i = 0; i < elements.length; i++) {
      var e = elements[i];
      var brs = e.el.querySelectorAll("br.__regoro-br-preview");
      for (var b = 0; b < brs.length; b++) {
        var br = brs[b];
        // Offset = Position des <br>-Knotens in seinem Elternknoten -> Zeichen-Offset.
        var parent = br.parentNode;
        var idxInParent = Array.prototype.indexOf.call(parent.childNodes, br);
        var off = charOffsetInRun(e.el, parent, idxInParent);
        if (off !== null) out.push({ idx: e.idx, brAt: off });
      }
    }
    return out;
  }

  // Liegen ungespeicherte Vorschau-<br> im DOM? (für isDirty/needsReload)
  function hasPreviewBr() {
    for (var i = 0; i < elements.length; i++) {
      if (elements[i].el.querySelector("br.__regoro-br-preview")) return true;
    }
    return false;
  }

  // Index eines Knotens unter seinem Elternknoten.
  function indexInParent(node) {
    var i = 0;
    var c = node.parentNode ? node.parentNode.firstChild : null;
    while (c && c !== node) { i++; c = c.nextSibling; }
    return i;
  }

  // Additive Range-Format-Ops (bold/italic/underline/color) aus dem DOM ableiten:
  // pro __regoro-range-fmt-Vorschau-Span die AKTUELLEN Zeichen-Offsets im Lauf-Text
  // (charOffsetInRun) + das im Inline-Style kodierte Format. Analog zu den <br>-Ops.
  // Vorteil: die Offsets wandern mit zwischenzeitlichen Textedits mit (kein Desync,
  // keine veralteten start/end), und die gewählte Formatierung bleibt erhalten.
  function collectRangeOpsFromDom() {
    var out = [];
    for (var i = 0; i < elements.length; i++) {
      var e = elements[i];
      var spans = e.el.querySelectorAll("span.__regoro-range-fmt");
      for (var s = 0; s < spans.length; s++) {
        var span = spans[s];
        var start = charOffsetInRun(e.el, span.parentNode, indexInParent(span));
        if (start === null) continue;
        var text = span.textContent || "";
        if (!text.length) continue;
        var op = { idx: e.idx, start: start, end: start + text.length };
        var st = span.style;
        var any = false;
        if (st.fontWeight === "700" || st.fontWeight === "bold") { op.bold = true; any = true; }
        if (st.fontStyle === "italic") { op.italic = true; any = true; }
        if ((st.textDecoration || "").indexOf("underline") !== -1) { op.underline = true; any = true; }
        if (st.color) { op.color = normalizeHex(st.color); any = true; }
        if (any) out.push(op);
      }
      // Entformatierungs-Marker: __regoro-range-unfmt-Spans -> {which:false}-Ops mit
      // AKTUELLEN Offsets (ebenfalls robust gegen zwischenzeitliche Textedits).
      var un = e.el.querySelectorAll("span.__regoro-range-unfmt");
      for (var u = 0; u < un.length; u++) {
        var m = un[u];
        var ustart = charOffsetInRun(e.el, m.parentNode, indexInParent(m));
        if (ustart === null) continue;
        var utext = m.textContent || "";
        if (!utext.length) continue;
        var uop = { idx: e.idx, start: ustart, end: ustart + utext.length };
        var uany = false;
        if (m.getAttribute("data-unfmt-bold")) { uop.bold = false; uany = true; }
        if (m.getAttribute("data-unfmt-italic")) { uop.italic = false; uany = true; }
        if (m.getAttribute("data-unfmt-underline")) { uop.underline = false; uany = true; }
        if (uany) out.push(uop);
      }
    }
    return out;
  }

  // Liegen ungespeicherte Range-Format-Vorschauen ODER Entformatierungs-Marker im DOM?
  function hasPreviewRangeFmt() {
    for (var i = 0; i < elements.length; i++) {
      if (elements[i].el.querySelector("span.__regoro-range-fmt, span.__regoro-range-unfmt")) return true;
    }
    return false;
  }

  // Liegen Struktur-Ops vor? Dann nach Save reload (frische Indizes).
  function hasStructuralOps() {
    return structOps.length > 0;
  }

  // Setzt eine der Ops einen Lauf auf leer (text==="")? Der Server entfernt dann
  // leere Markup-Hüllen -> Struktur ändert sich -> Reload nötig.
  function emptiesARun(ops) {
    for (var i = 0; i < ops.length; i++) {
      if (ops[i] && ops[i].text === "") return true;
    }
    return false;
  }

  // Enthält IRGENDEINE Op ein Format-Feld (Whole-Run oder Range)? Diese Ops fügen
  // serverseitig Wrapper hinzu/entfernen sie -> Client-DOM danach stale -> Reload.
  // hasOwnProperty, damit auch false/null-Werte (entformatieren/entlinken) zählen.
  function hasFormatOp(ops) {
    var fields = ["bold", "italic", "underline", "color", "link"];
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (!op) continue;
      for (var j = 0; j < fields.length; j++) {
        if (Object.prototype.hasOwnProperty.call(op, fields[j])) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Styles (injiziert, eindeutig geprefixt)
  // ---------------------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById("__regoro-style")) return;
    var css = [
      "#__regoro-bar{position:fixed;top:0;left:0;right:0;z-index:2147483600;",
      "display:flex;align-items:center;gap:10px;flex-wrap:wrap;",
      "padding:8px 14px;background:#14324f;color:#fff;",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;",
      "font-size:14px;line-height:1.2;box-shadow:0 2px 8px rgba(0,0,0,.25);",
      "box-sizing:border-box;}",
      "#__regoro-bar *{box-sizing:border-box;}",
      "#__regoro-bar .__regoro-title{font-weight:700;margin-right:6px;white-space:nowrap;}",
      "#__regoro-bar .__regoro-spacer{flex:1 1 auto;}",
      "#__regoro-bar button.__regoro-btn{appearance:none;border:1px solid rgba(255,255,255,.35);",
      "background:rgba(255,255,255,.08);color:#fff;border-radius:6px;padding:6px 12px;",
      "font:inherit;cursor:pointer;line-height:1.2;}",
      "#__regoro-bar button.__regoro-btn:hover{background:rgba(255,255,255,.2);}",
      "#__regoro-bar button.__regoro-btn:disabled{opacity:.45;cursor:not-allowed;}",
      "#__regoro-bar button.__regoro-primary{background:#e2571e;border-color:#e2571e;font-weight:600;}",
      "#__regoro-bar button.__regoro-primary:hover{background:#cf4d18;}",
      "#__regoro-bar .__regoro-status{font-size:13px;opacity:.95;min-height:1em;white-space:nowrap;}",
      "#__regoro-bar .__regoro-status.__regoro-err{color:#ffd0c2;font-weight:600;}",
      "#__regoro-bar .__regoro-status.__regoro-ok{color:#bff0cf;font-weight:600;}",
      // Seiten-Umschalter (<select> in der Leiste)
      "#__regoro-bar .__regoro-pages{appearance:none;-webkit-appearance:none;",
      "border:1px solid rgba(255,255,255,.35);background:rgba(255,255,255,.08);",
      "color:#fff;border-radius:6px;padding:6px 26px 6px 10px;font:inherit;font-size:14px;",
      "line-height:1.2;cursor:pointer;max-width:180px;",
      "background-image:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='white' stroke-width='1.5' fill='none'/></svg>\");",
      "background-repeat:no-repeat;background-position:right 9px center;}",
      "#__regoro-bar .__regoro-pages:hover{background-color:rgba(255,255,255,.2);}",
      "#__regoro-bar .__regoro-pages option{color:#16222e;}",
      // Editier-Highlight auf den (jetzt inline-<span>-)Text-Elementen.
      // Geringer outline-offset + box-decoration-break, damit benachbarte Inline-Spans
      // (Mixed-Content rund um Links) sich nicht überlappen und Umbrüche sauber aussehen.
      "[data-edit-idx].__regoro-active{outline:1px dashed rgba(226,87,30,.85);",
      "outline-offset:1px;cursor:text;",
      "-webkit-box-decoration-break:clone;box-decoration-break:clone;}",
      "[data-edit-idx].__regoro-active:focus{outline:2px solid #e2571e;",
      "background:rgba(226,87,30,.08);}",
      "[data-edit-idx].__regoro-dirty{background:rgba(226,87,30,.12);}",
      // Bild-Austausch: Affordance direkt am <img> (kein DOM-Wrapper, der Layout bricht).
      "[data-edit-img-idx].__regoro-img-editable{cursor:pointer;",
      "outline:2px dashed rgba(226,87,30,.7);outline-offset:2px;}",
      // Schwebende Badge am document.body, per JS über das Bild positioniert.
      ".__regoro-img-badge{position:absolute;z-index:2147483599;",
      "background:rgba(20,50,79,.92);color:#fff;border:0;border-radius:6px;",
      "padding:6px 10px;font:600 13px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;",
      "cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3);display:flex;align-items:center;gap:6px;}",
      ".__regoro-img-badge:hover{background:#e2571e;}",
      ".__regoro-img-badge[disabled]{opacity:.6;cursor:wait;}",
      // Versionen-Panel
      "#__regoro-versions{position:fixed;top:0;right:0;bottom:0;width:380px;max-width:92vw;",
      "z-index:2147483601;background:#fff;color:#16222e;box-shadow:-4px 0 18px rgba(0,0,0,.28);",
      "display:flex;flex-direction:column;",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;}",
      "#__regoro-versions *{box-sizing:border-box;}",
      "#__regoro-versions .__regoro-vhead{display:flex;align-items:center;justify-content:space-between;",
      "padding:14px 16px;background:#14324f;color:#fff;}",
      "#__regoro-versions .__regoro-vhead h2{margin:0;font-size:16px;font-weight:700;}",
      "#__regoro-versions .__regoro-vclose{appearance:none;background:transparent;border:0;",
      "color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 4px;}",
      "#__regoro-versions .__regoro-vbody{flex:1 1 auto;overflow:auto;padding:8px 0;}",
      "#__regoro-versions .__regoro-vmsg{padding:16px;color:#5a6b78;font-size:14px;}",
      "#__regoro-versions .__regoro-vitem{padding:12px 16px;border-bottom:1px solid #e2e8ec;}",
      "#__regoro-versions .__regoro-vdate{font-size:12px;color:#5a6b78;}",
      "#__regoro-versions .__regoro-vsubj{font-size:14px;margin:2px 0 8px;color:#16222e;}",
      "#__regoro-versions .__regoro-vactions{display:flex;gap:8px;flex-wrap:wrap;}",
      "#__regoro-versions button.__regoro-vbtn{appearance:none;border:1px solid #cbd5dc;",
      "background:#f5f8fa;color:#16222e;border-radius:6px;padding:5px 10px;font:inherit;",
      "font-size:13px;cursor:pointer;}",
      "#__regoro-versions button.__regoro-vbtn:hover{background:#e8eef2;}",
      "#__regoro-versions button.__regoro-vrestore{border-color:#e2571e;color:#a83c12;font-weight:600;}",
      // Format-Toolbar (B/I/Link/Entfernen/Absatz)
      "#__regoro-bar .__regoro-fmtbar{display:inline-flex;align-items:center;gap:6px;",
      "padding-left:10px;margin-left:2px;border-left:1px solid rgba(255,255,255,.25);}",
      "#__regoro-bar button.__regoro-fmtbtn{appearance:none;border:1px solid rgba(255,255,255,.35);",
      "background:rgba(255,255,255,.08);color:#fff;border-radius:6px;padding:6px 10px;",
      "font:inherit;font-size:14px;cursor:pointer;line-height:1.2;min-width:32px;}",
      "#__regoro-bar button.__regoro-fmtbtn:hover{background:rgba(255,255,255,.2);}",
      "#__regoro-bar button.__regoro-fmtbtn:disabled{opacity:.4;cursor:not-allowed;}",
      "#__regoro-bar button.__regoro-fmt-b{font-weight:800;}",
      "#__regoro-bar button.__regoro-fmt-i{font-style:italic;}",
      "#__regoro-bar button.__regoro-fmt-u{text-decoration:underline;}",
      "#__regoro-bar button.__regoro-pressed{background:#e2571e;border-color:#e2571e;}",
      // Farb-Control „A▾" + Dropdown-Panel
      "#__regoro-bar .__regoro-colorwrap{position:relative;display:inline-flex;}",
      "#__regoro-bar .__regoro-colorbtn{display:inline-flex;align-items:center;gap:2px;}",
      "#__regoro-bar .__regoro-colorbar{display:inline-block;width:14px;height:4px;border-radius:2px;",
      "background:transparent;box-shadow:0 0 0 1px rgba(255,255,255,.5);margin:0 2px;}",
      ".__regoro-colorpanel{position:absolute;top:calc(100% + 6px);right:0;z-index:2147483602;",
      "background:#fff;color:#16222e;border:1px solid #cbd5dc;border-radius:8px;",
      "box-shadow:0 6px 18px rgba(0,0,0,.25);padding:10px;width:220px;",
      "font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;}",
      ".__regoro-colorpanel *{box-sizing:border-box;}",
      ".__regoro-swatchgrid{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-bottom:10px;}",
      ".__regoro-swatch{width:26px;height:26px;border-radius:6px;border:1px solid rgba(0,0,0,.15);",
      "cursor:pointer;padding:0;}",
      ".__regoro-swatch:hover{outline:2px solid #14324f;outline-offset:1px;}",
      ".__regoro-colorrow{display:flex;align-items:center;gap:6px;margin-bottom:8px;}",
      ".__regoro-colorinput{width:34px;height:30px;padding:0;border:1px solid #cbd5dc;border-radius:6px;cursor:pointer;background:#fff;}",
      ".__regoro-colorhex{flex:1 1 auto;min-width:0;border:1px solid #cbd5dc;border-radius:6px;",
      "padding:5px 8px;font:inherit;font-size:13px;color:#16222e;}",
      // Panel-Buttons: eigene Klasse mit erhöhter Spezifität (#__regoro-bar ...), damit
      // die dunkle Toolbar-Regel (button.__regoro-fmtbtn) sie NICHT weiß-auf-weiß macht.
      "#__regoro-bar .__regoro-colorpanel button.__regoro-panelbtn{appearance:none;",
      "border:1px solid #cbd5dc;background:#f5f8fa;color:#16222e;border-radius:6px;",
      "padding:5px 10px;font:inherit;font-size:13px;cursor:pointer;line-height:1.2;}",
      "#__regoro-bar .__regoro-colorpanel button.__regoro-panelbtn:hover{background:#e8eef2;}",
      // Optische Format-Vorschau auf den Läufen (maßgeblich bleibt der Save-Op)
      "[data-edit-idx].__regoro-b{font-weight:700;}",
      "[data-edit-idx].__regoro-i{font-style:italic;}",
      "[data-edit-idx].__regoro-link{color:#1a5fb4;text-decoration:underline;}",
      // Block-Markierung: kurzes Highlight vor dem Löschen + Vormerkung „zu entfernen".
      "[data-edit-del-idx].__regoro-block-flash{outline:2px solid #e2571e;outline-offset:3px;",
      "transition:outline-color .2s;}",
      "[data-edit-del-idx].__regoro-block-del{opacity:.45;outline:2px dashed #e2571e;outline-offset:3px;}",
      // Body-Offset, damit der fixe Balken nichts verdeckt
      "body.__regoro-offset{padding-top:52px;}"
    ].join("");
    var style = el("style", { id: "__regoro-style" });
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Balken (fixiert oben)
  // ---------------------------------------------------------------------------
  var ui = {};
  function buildBar() {
    var bar = el("div", { id: "__regoro-bar" });

    var title = el("span", { class: "__regoro-title", text: "Regoro Editor" });

    var pageSwitcher = buildPageSwitcher(); // null wenn keine pages

    ui.btnEdit = el("button", { class: "__regoro-btn", text: "Bearbeiten", type: "button" });
    ui.btnSave = el("button", { class: "__regoro-btn __regoro-primary", text: "Speichern", type: "button" });
    ui.btnDiscard = el("button", { class: "__regoro-btn", text: "Verwerfen", type: "button" });
    ui.btnVersions = el("button", { class: "__regoro-btn", text: "Versionen", type: "button" });

    ui.status = el("span", { class: "__regoro-status" });
    var spacer = el("span", { class: "__regoro-spacer" });

    var formatBar = buildFormatToolbar();

    bar.appendChild(title);
    if (pageSwitcher) bar.appendChild(pageSwitcher);
    bar.appendChild(ui.btnEdit);
    bar.appendChild(ui.btnSave);
    bar.appendChild(ui.btnDiscard);
    bar.appendChild(ui.btnVersions);
    bar.appendChild(formatBar);
    bar.appendChild(spacer);
    bar.appendChild(ui.status);

    ui.btnEdit.addEventListener("click", toggleEditing);
    ui.btnSave.addEventListener("click", onSave);
    ui.btnDiscard.addEventListener("click", onDiscard);
    ui.btnVersions.addEventListener("click", onVersions);

    document.body.appendChild(bar);
    document.body.classList.add("__regoro-offset");
    updateButtons();
  }

  // ---------------------------------------------------------------------------
  // Format-Toolbar (B / I / U / Link / Farbe / Entfernen) — nur im Edit-Modus.
  // ---------------------------------------------------------------------------
  function buildFormatToolbar() {
    var wrap = el("span", { class: "__regoro-fmtbar" });
    wrap.style.display = "none"; // nur im Edit-Modus sichtbar

    ui.btnBold = el("button", { class: "__regoro-fmtbtn __regoro-fmt-b", type: "button", title: "Fett (Markierung oder ganzer Lauf)", "aria-label": "Fett" }, ["B"]);
    ui.btnItalic = el("button", { class: "__regoro-fmtbtn __regoro-fmt-i", type: "button", title: "Kursiv (Markierung oder ganzer Lauf)", "aria-label": "Kursiv" }, ["I"]);
    ui.btnUnderline = el("button", { class: "__regoro-fmtbtn __regoro-fmt-u", type: "button", title: "Unterstrichen (Markierung oder ganzer Lauf)", "aria-label": "Unterstrichen" }, ["U"]);
    ui.btnLink = el("button", { class: "__regoro-fmtbtn", type: "button", title: "Link setzen/ändern", "aria-label": "Link" }, ["🔗 Link"]);
    var colorControl = buildColorControl();
    ui.btnDelete = el("button", { class: "__regoro-fmtbtn", type: "button", title: "Markierung löschen, oder (ohne Markierung) ganzen Abschnitt entfernen", "aria-label": "Markierung oder Abschnitt entfernen" }, ["🗑 Entfernen"]);

    // mousedown-preventDefault hält Auswahl/Caret im Lauf, damit selectionInRun()
    // im click-Handler die Markierung noch sieht (sonst geht sie beim Klick verloren).
    ui.btnBold.addEventListener("mousedown", function (e) { e.preventDefault(); });
    ui.btnItalic.addEventListener("mousedown", function (e) { e.preventDefault(); });
    ui.btnUnderline.addEventListener("mousedown", function (e) { e.preventDefault(); });
    ui.btnLink.addEventListener("mousedown", function (e) { e.preventDefault(); });
    ui.btnDelete.addEventListener("mousedown", function (e) { e.preventDefault(); });
    ui.btnBold.addEventListener("click", function () { toggleRunFmt("bold"); });
    ui.btnItalic.addEventListener("click", function () { toggleRunFmt("italic"); });
    ui.btnUnderline.addEventListener("click", function () { toggleRunFmt("underline"); });
    ui.btnLink.addEventListener("click", onLinkClick);
    ui.btnDelete.addEventListener("click", onDeleteBlock);

    wrap.appendChild(ui.btnBold);
    wrap.appendChild(ui.btnItalic);
    wrap.appendChild(ui.btnUnderline);
    wrap.appendChild(ui.btnLink);
    wrap.appendChild(colorControl);
    wrap.appendChild(ui.btnDelete);
    ui.formatBar = wrap;
    return wrap;
  }

  // Marken-Palette (aus site/styles.css: --accent/--primary/--ink/--muted) + Defaults.
  var COLOR_SWATCHES = [
    { hex: "#e2571e", name: "Akzent-Orange" },
    { hex: "#14324f", name: "Navy" },
    { hex: "#16222e", name: "Tinte" },
    { hex: "#5a6b78", name: "Grau" },
    { hex: "#000000", name: "Schwarz" },
    { hex: "#ffffff", name: "Weiß" }
  ];

  // Farb-Control „A▾": Button öffnet ein Panel mit Swatches + freiem Hex/Color-Picker.
  function buildColorControl() {
    var holder = el("span", { class: "__regoro-colorwrap" });

    ui.btnColor = el("button", {
      class: "__regoro-fmtbtn __regoro-colorbtn", type: "button",
      title: "Textfarbe (Markierung oder ganzer Lauf)", "aria-label": "Textfarbe",
      "aria-haspopup": "true", "aria-expanded": "false"
    }, ["A", el("span", { class: "__regoro-colorbar" }), " ▾"]);
    ui.btnColor.addEventListener("mousedown", function (e) { e.preventDefault(); });
    ui.btnColor.addEventListener("click", function (e) {
      e.preventDefault();
      toggleColorPanel();
    });

    var panel = el("div", { class: "__regoro-colorpanel" });
    panel.style.display = "none";
    panel.addEventListener("mousedown", function (e) { e.preventDefault(); }); // Auswahl halten

    var grid = el("div", { class: "__regoro-swatchgrid" });
    COLOR_SWATCHES.forEach(function (sw) {
      var b = el("button", {
        class: "__regoro-swatch", type: "button", title: sw.name, "aria-label": sw.name
      });
      b.style.background = sw.hex;
      b.addEventListener("mousedown", function (e) { e.preventDefault(); });
      b.addEventListener("click", function (e) {
        e.preventDefault();
        applyColor(sw.hex);
        closeColorPanel();
      });
      grid.appendChild(b);
    });
    panel.appendChild(grid);

    // Freier Hex: nativer Color-Picker + Hex-Textfeld. (Panel-Buttons tragen NICHT
    // __regoro-fmtbtn — sonst gewänne die dunkle Toolbar-Regel und sie würden auf dem
    // hellen Panel weiß-auf-weiß; eigene helle Panel-Button-Klasse stattdessen.)
    var row = el("div", { class: "__regoro-colorrow" });
    ui.colorInput = el("input", { type: "color", class: "__regoro-colorinput", value: "#e2571e", "aria-label": "Farbe wählen" });
    ui.colorHex = el("input", { type: "text", class: "__regoro-colorhex", placeholder: "#rrggbb", "aria-label": "Hex-Farbe", maxlength: "7" });
    var applyBtn = el("button", { class: "__regoro-panelbtn __regoro-colorapply", type: "button", title: "Hex-Farbe übernehmen" }, ["Übernehmen"]);

    // Color-Input: bei Auswahl (change) sofort anwenden — kein „Übernehmen" nötig.
    ui.colorInput.addEventListener("input", function () { ui.colorHex.value = ui.colorInput.value; });
    ui.colorInput.addEventListener("change", function () {
      ui.colorHex.value = ui.colorInput.value;
      applyHexColor(ui.colorInput.value);
    });
    // Hex-Feld: bei Enter anwenden.
    ui.colorHex.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); applyHexColor(ui.colorHex.value); }
    });
    // „Übernehmen": Hex-Feld anwenden.
    applyBtn.addEventListener("mousedown", function (e) { e.preventDefault(); });
    applyBtn.addEventListener("click", function (e) {
      e.preventDefault();
      applyHexColor(ui.colorHex.value || ui.colorInput.value);
    });
    row.appendChild(ui.colorInput);
    row.appendChild(ui.colorHex);
    row.appendChild(applyBtn);
    panel.appendChild(row);

    holder.appendChild(ui.btnColor);
    holder.appendChild(panel);
    ui.colorPanel = panel;
    return holder;
  }

  // Selektions-Snapshot: bewahrt die zum Öffnen gültige Markierung/den Lauf, BEVOR ein
  // fokussierendes Control (Color-Input, Hex-Feld) den Fokus aus dem contenteditable
  // zieht und die Selektion verwirft.
  var savedRange = null;   // geklonte DOM-Range (Markierung) oder null
  var savedRun = null;     // fokussierter Lauf (für Whole-Run)
  function snapshotSelection() {
    var sel = window.getSelection && window.getSelection();
    savedRange = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0).cloneRange() : null;
    savedRun = activeRun || runAtSelection();
  }
  // Gemerkte Selektion wiederherstellen, damit applyColor wieder Markierung/Lauf sieht.
  function restoreSelection() {
    var sel = window.getSelection && window.getSelection();
    if (savedRange && sel) {
      try { sel.removeAllRanges(); sel.addRange(savedRange); } catch (e) { /* best-effort */ }
    }
    if (savedRun) activeRun = savedRun;
  }

  // Freie Hex-Farbe (Color-Input change / Hex-Enter / Übernehmen) validieren + anwenden.
  // restoreSelection, weil Color-Input/Hex-Feld zuvor den Fokus aus dem Lauf gezogen haben.
  function applyHexColor(raw) {
    var norm = normalizeHex((raw || "").trim());
    if (!/^#[0-9a-f]{6}$/.test(norm || "")) {
      setStatus("Bitte gültigen Hex-Wert eingeben (z.B. #e2571e).", "err");
      return;
    }
    restoreSelection();
    applyColor(norm);
    closeColorPanel();
  }

  function toggleColorPanel() {
    if (!ui.colorPanel) return;
    if (ui.colorPanel.style.display === "none") openColorPanel();
    else closeColorPanel();
  }
  function openColorPanel() {
    if (ui.btnColor.disabled) return;
    snapshotSelection(); // Markierung/Lauf merken, bevor Panel-Inputs den Fokus nehmen
    prefillColorInputs();  // Color-/Hex-Feld mit der Ist-Farbe der Selektion vorbelegen
    ui.colorPanel.style.display = "";
    ui.btnColor.setAttribute("aria-expanded", "true");
  }

  // Color-Input + Hex-Feld mit der AKTUELL gerenderten Textfarbe der Selektion/des
  // Laufs vorbelegen (nur Anzeige — sendet keine Op). Nutzt getComputedStyle, deckt
  // also auch geerbte Farben ab. Fallback #000000.
  function prefillColorInputs() {
    if (!ui.colorInput || !ui.colorHex) return;
    var hex = currentSelectionColorHex();
    ui.colorInput.value = hex;
    ui.colorHex.value = hex;
  }

  // Element der aktuellen Selektion/des Laufs bestimmen und dessen gerenderte Farbe
  // (getComputedStyle().color, rgb->#rrggbb) liefern. Default #000000.
  function currentSelectionColorHex() {
    var node = null;
    if (savedRange) {
      var c = savedRange.startContainer;
      node = c && (c.nodeType === 1 ? c : c.parentElement);
    }
    if (!node && savedRun && savedRun.el) node = savedRun.el;
    if (!node && activeRun && activeRun.el) node = activeRun.el;
    if (!node) node = document.body;
    try {
      var rgb = window.getComputedStyle(node).color;
      var hex = normalizeHex(rgb);
      if (/^#[0-9a-f]{6}$/.test(hex || "")) return hex;
    } catch (e) { /* Fallback unten */ }
    return "#000000";
  }
  function closeColorPanel() {
    if (!ui.colorPanel) return;
    ui.colorPanel.style.display = "none";
    ui.btnColor.setAttribute("aria-expanded", "false");
  }

  // Farbe SETZEN (hex = echte Farbe): bei Markierung -> Range-Op {idx,start,end,color};
  // sonst Whole-Run {idx,color}.
  function applyColor(hex) {
    var range = selectionInRun();
    if (range) {
      // Vorschau-Span = Quelle der Wahrheit (DOM-abgeleitet beim Speichern);
      // nur ohne Vorschau (komplexe Grenzen) die Op klassisch queuen.
      var colSpan = previewRange(range.run, range.start, range.end, "color", true, hex);
      if (!colSpan) rangeOps.push({ idx: range.run.idx, start: range.start, end: range.end, color: hex });
      setStatus("Farbe auf Markierung gesetzt — Speichern.", "ok");
      return;
    }
    if (selectionSpansMultipleRuns()) {
      setStatus("Bitte innerhalb eines Absatzes markieren.", "err");
      return;
    }
    var run = syncActiveRun();
    if (!run) {
      setStatus("Bitte zuerst in einen Text klicken oder etwas markieren.", "err");
      return;
    }
    run.fmt.color = hex;
    reflectRun(run);
    updateFormatToolbar();
    setStatus("Farbe auf Absatz gesetzt — Speichern.", "ok");
    if (run.el && typeof run.el.focus === "function") run.el.focus();
  }

  // Toolbar-Zustand an den aktuell fokussierten Lauf anpassen.
  function updateFormatToolbar() {
    if (!ui.formatBar) return;
    var hasRun = !!activeRun;
    ui.btnBold.disabled = !hasRun;
    ui.btnItalic.disabled = !hasRun;
    ui.btnUnderline.disabled = !hasRun;
    ui.btnLink.disabled = !hasRun;
    setPressed(ui.btnBold, hasRun && !!activeRun.fmt.bold);
    setPressed(ui.btnItalic, hasRun && !!activeRun.fmt.italic);
    setPressed(ui.btnUnderline, hasRun && !!activeRun.fmt.underline);
    setPressed(ui.btnLink, hasRun && !!activeRun.fmt.link);
    // Farb-Control: aktiv sobald ein Lauf fokussiert ist; Indikator zeigt Lauf-Farbe.
    if (ui.btnColor) {
      ui.btnColor.disabled = !hasRun;
      var indicator = ui.btnColor.querySelector(".__regoro-colorbar");
      if (indicator) indicator.style.background = (hasRun && activeRun.fmt.color) ? activeRun.fmt.color : "transparent";
    }
    // „Entfernen" ist aktiv sobald ein Lauf fokussiert ist: ohne Markierung löscht es
    // den Block des Laufs, mit Markierung den markierten Text.
    ui.btnDelete.disabled = !hasRun;
  }
  function setPressed(btn, on) {
    if (on) btn.classList.add("__regoro-pressed");
    else btn.classList.remove("__regoro-pressed");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  // Zeichen-Offset eines (container,offset)-Punkts relativ zum Textbeginn von runEl.
  // Robust auch bei verschachtelten Knoten: misst die Textlänge vom Lauf-Anfang
  // bis zum Punkt über eine DOM-Range.
  function charOffsetInRun(runEl, container, offset) {
    var r = document.createRange();
    r.selectNodeContents(runEl);
    try {
      r.setEnd(container, offset);
    } catch (e) {
      return null;
    }
    return r.toString().length;
  }

  // Liefert {run,start,end} wenn eine NICHT-collapsed Selektion vollständig in
  // genau EINEM [data-edit-idx]-Lauf liegt; sonst null. start<end (normalisiert).
  function selectionInRun() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    var a = sel.anchorNode, f = sel.focusNode;
    if (!a || !f) return null;
    var ae = a.nodeType === 1 ? a : a.parentElement;
    var fe = f.nodeType === 1 ? f : f.parentElement;
    if (!ae || !fe) return null;
    var aRun = ae.closest && ae.closest("[data-edit-idx]");
    var fRun = fe.closest && fe.closest("[data-edit-idx]");
    if (!aRun || aRun !== fRun) return null; // mehrlauf/außerhalb -> kein Einzel-Lauf-Fall
    var run = findRun(aRun);
    if (!run) return null;
    var o1 = charOffsetInRun(aRun, a, sel.anchorOffset);
    var o2 = charOffsetInRun(aRun, f, sel.focusOffset);
    if (o1 === null || o2 === null) return null;
    var start = Math.min(o1, o2), end = Math.max(o1, o2);
    if (start === end) return null;
    return { run: run, start: start, end: end };
  }

  // Liegt eine Selektion über MEHRERE Läufe? (für Hinweis)
  function selectionSpansMultipleRuns() {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    var a = sel.anchorNode, f = sel.focusNode;
    var ae = a && (a.nodeType === 1 ? a : a.parentElement);
    var fe = f && (f.nodeType === 1 ? f : f.parentElement);
    var aRun = ae && ae.closest && ae.closest("[data-edit-idx]");
    var fRun = fe && fe.closest && fe.closest("[data-edit-idx]");
    return !!(aRun && fRun && aRun !== fRun);
  }

  // Tag-Namen pro Format (für die DOM-Zustands-Prüfung der Selektion).
  var FMT_TAG = { bold: "strong, b", italic: "em, i", underline: "u" };

  // Ist die aktuelle Selektion für `which` BEREITS formatiert? Prüft aus dem DOM:
  //  - gespeichertes Markup: Anchor- UND Focus-Knoten liegen im SELBEN <strong>/<em>/<u>-Vorfahr.
  //  - ungespeicherte Vorschau: ein .__regoro-range-fmt-Wrapper mit gesetztem Inline-Style
  //    (fontWeight/fontStyle/textDecoration) umschließt die Selektion.
  // Liefert { active:boolean, previewSpan:Element|null } (previewSpan = ungespeicherter Wrapper).
  function selectionFmtState(which) {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0) return { active: false, previewSpan: null };
    var a = sel.anchorNode, f = sel.focusNode;
    var ae = a && (a.nodeType === 1 ? a : a.parentElement);
    var fe = f && (f.nodeType === 1 ? f : f.parentElement);
    if (!ae || !fe) return { active: false, previewSpan: null };

    // (1) Gespeichertes Format-Markup, das beide Selektions-Enden umschließt.
    var tag = FMT_TAG[which];
    if (tag) {
      var aw = ae.closest(tag), fw = fe.closest(tag);
      if (aw && aw === fw) return { active: true, previewSpan: null };
    }
    // (2) Ungespeicherter Vorschau-Wrapper mit passendem Inline-Style.
    var aPrev = closestPreviewWithFmt(ae, which);
    var fPrev = closestPreviewWithFmt(fe, which);
    if (aPrev && aPrev === fPrev) return { active: true, previewSpan: aPrev };

    return { active: false, previewSpan: null };
  }

  // Nächster .__regoro-range-fmt-Vorfahr, der `which` per Inline-Style gesetzt hat.
  function closestPreviewWithFmt(node, which) {
    var cur = node;
    while (cur && cur.nodeType === 1) {
      if (cur.classList && cur.classList.contains("__regoro-range-fmt")) {
        var s = cur.style;
        if (which === "bold" && (s.fontWeight === "700" || s.fontWeight === "bold")) return cur;
        if (which === "italic" && s.fontStyle === "italic") return cur;
        if (which === "underline" && (s.textDecoration || "").indexOf("underline") !== -1) return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  // B/I/U anwenden: bei Markierung innerhalb eines Laufs -> Range-Op {idx,start,end,...};
  // sonst Whole-Run-Toggle wie v3-B. Der EIN/AUS-Zustand wird bei Markierung aus dem
  // DOM bestimmt (selectionFmtState), damit ein bereits formatierter Bereich entformatiert
  // (false) statt doppelt formatiert wird.
  function toggleRunFmt(which) {
    var range = selectionInRun();
    if (range) {
      var state = selectionFmtState(which);
      if (!state.active) {
        // Nicht formatiert -> einschalten. Der Vorschau-Span ist die Quelle der
        // Wahrheit: die Range-Op wird beim Speichern aus dem DOM abgeleitet
        // (collectRangeOpsFromDom) und wandert so mit späteren Textedits mit.
        // Nur wenn keine Vorschau möglich ist (komplexe Grenzen), klassisch queuen.
        var addSpan = previewRange(range.run, range.start, range.end, which, true);
        if (!addSpan) rangeOps.push(makeRangeOp(range, which, true));
        setStatus(fmtLabel(which) + " auf Markierung gesetzt — Speichern.", "ok");
      } else if (state.previewSpan) {
        // Ungespeicherte Vorschau-Formatierung -> die zugehörige {which:true}-Op
        // zurücknehmen (analog zur <br>-Lösung) statt eine gegenläufige Op zu queuen.
        dropRangeOp(range, which, true);
        unpreviewRange(state.previewSpan, which);
        setStatus(fmtLabel(which) + " von Markierung entfernt — Speichern.", "ok");
      } else {
        // Bereits GESPEICHERTES Markup -> entformatieren (oder Entfernung zurücknehmen).
        // Der Entfernungs-Wunsch wird als DOM-Marker gesetzt, der mit Textedits
        // mitwandert; die {which:false}-Op wird beim Speichern daraus abgeleitet.
        var exUn = selectionUnfmtMarker(which);
        if (exUn) {
          removeUnfmtFlag(exUn, which); // erneuter Klick -> Entfernung zurücknehmen
          setStatus(fmtLabel(which) + " wieder gesetzt — Speichern.", "ok");
        } else {
          var uSpan = markUnfmt(range, which);
          if (!uSpan) rangeOps.push(makeRangeOp(range, which, false)); // Fallback
          setStatus(fmtLabel(which) + " von Markierung entfernt — Speichern.", "ok");
        }
      }
      return;
    }
    if (selectionSpansMultipleRuns()) {
      setStatus("Bitte innerhalb eines Absatzes markieren.", "err");
      return;
    }
    var run = syncActiveRun();
    if (!run) return;
    run.fmt[which] = !run.fmt[which];
    reflectRun(run);
    updateFormatToolbar();
    if (run.el && typeof run.el.focus === "function") run.el.focus();
  }

  // Range-Op {idx,start,end, [which]:value} sauber bauen.
  function makeRangeOp(range, which, value) {
    var op = { idx: range.run.idx, start: range.start, end: range.end };
    op[which] = value;
    return op;
  }

  // Eine vorher gequeute Range-Op (idx + identischer Bereich + Feld/Wert) zurücknehmen.
  // Letzte zuerst, damit das jüngste Einschalten sauber rückgängig gemacht wird.
  function dropRangeOp(range, which, value) {
    for (var i = rangeOps.length - 1; i >= 0; i--) {
      var op = rangeOps[i];
      if (op.idx === range.run.idx && op.start === range.start && op.end === range.end &&
          op[which] === value) {
        rangeOps.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  // Optische Entformatierung: ungespeicherten Vorschau-Wrapper für `which` zurücknehmen.
  // (Gespeichertes Markup wird clientseitig nicht aufgemacht — Range-Ops reloaden ohnehin.)
  function unpreviewRange(previewSpan, which) {
    var sel = window.getSelection && window.getSelection();
    if (previewSpan) {
      if (which === "bold") previewSpan.style.fontWeight = "";
      else if (which === "italic") previewSpan.style.fontStyle = "";
      else if (which === "underline") previewSpan.style.textDecoration = "";
      // Wrapper ohne verbleibende Format-Styles wieder entfernen (unwrappen).
      var st = previewSpan.style;
      if (!st.fontWeight && !st.fontStyle && !st.textDecoration && !st.color) {
        unwrap(previewSpan);
      }
    }
    if (sel) sel.removeAllRanges();
  }

  // Ein Element durch seine Kindknoten ersetzen (unwrap), Textstruktur normalisieren.
  function unwrap(elm) {
    var parent = elm.parentNode;
    if (!parent) return;
    while (elm.firstChild) parent.insertBefore(elm.firstChild, elm);
    parent.removeChild(elm);
    if (parent.normalize) parent.normalize();
  }

  // Entformatierungs-Marker: aktuelle Selektion in einen unsichtbaren
  // __regoro-range-unfmt-Span wickeln (KEIN Style — die Optik bleibt bis zum Reload).
  // data-unfmt-<which> markiert, welches gespeicherte Format entfernt werden soll.
  // Beim Speichern werden daraus {which:false}-Ops mit AKTUELLEN Offsets abgeleitet
  // (collectRangeOpsFromDom), robust gegen zwischenzeitliche Textedits.
  function markUnfmt(range, which) {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    var r = sel.getRangeAt(0);
    var span;
    try {
      span = document.createElement("span");
      span.className = "__regoro-range-unfmt";
      r.surroundContents(span);
    } catch (e) {
      return null; // komplexe Grenzen -> Op-Fallback greift
    }
    span.setAttribute("data-unfmt-" + which, "1");
    try {
      var keep = document.createRange();
      keep.selectNodeContents(span);
      sel.removeAllRanges();
      sel.addRange(keep);
    } catch (e) { /* best-effort */ }
    return span;
  }

  // Nächster __regoro-range-unfmt-Marker, der `which` entfernt und die Selektion umschließt.
  function selectionUnfmtMarker(which) {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    var a = sel.anchorNode, f = sel.focusNode;
    var ae = a && (a.nodeType === 1 ? a : a.parentElement);
    var fe = f && (f.nodeType === 1 ? f : f.parentElement);
    if (!ae || !fe) return null;
    var am = closestUnfmt(ae, which), fm = closestUnfmt(fe, which);
    return (am && am === fm) ? am : null;
  }
  function closestUnfmt(node, which) {
    var cur = node;
    while (cur && cur.nodeType === 1) {
      if (cur.classList && cur.classList.contains("__regoro-range-unfmt") &&
          cur.getAttribute("data-unfmt-" + which)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  // Eine Entfernung zurücknehmen: data-unfmt-<which> löschen; ohne weitere Flags unwrappen.
  function removeUnfmtFlag(span, which) {
    span.removeAttribute("data-unfmt-" + which);
    if (!span.getAttribute("data-unfmt-bold") &&
        !span.getAttribute("data-unfmt-italic") &&
        !span.getAttribute("data-unfmt-underline")) {
      unwrap(span);
    }
  }

  // Optische Vorschau eines Teilbereichs: den aktuell markierten Range in einen
  // __regoro-Preview-Span wickeln und das Format anwenden. Best-effort — schlägt
  // surroundContents fehl (Teilknoten-Grenzen), bleibt die Vorschau aus; der Save-Op
  // ist davon unberührt. Ändert den Textinhalt NICHT.
  function previewRange(run, start, end, which, value, color) {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    var range = sel.getRangeAt(0);
    var span;
    try {
      span = document.createElement("span");
      span.className = "__regoro-range-fmt";
      range.surroundContents(span);
    } catch (e) {
      return null; // komplexe Grenzen -> keine visuelle Vorschau, Op-Fallback greift
    }
    if (which === "bold" && value) span.style.fontWeight = "700";
    if (which === "italic" && value) span.style.fontStyle = "italic";
    if (which === "underline" && value) span.style.textDecoration = "underline";
    if (which === "color" && color) span.style.color = color;
    // Selektion auf den Wrapper-Inhalt erhalten, damit ein erneuter B/I/U-Klick
    // den Bereich als "bereits formatiert" erkennt (Toggle-OFF im selben Zyklus).
    try {
      var keep = document.createRange();
      keep.selectNodeContents(span);
      sel.removeAllRanges();
      sel.addRange(keep);
    } catch (e) { /* best-effort */ }
    return span; // Quelle der Wahrheit fürs DOM-abgeleitete Sammeln beim Speichern
  }

  function fmtLabel(which) {
    return which === "bold" ? "Fett" : which === "italic" ? "Kursiv" : which === "underline" ? "Unterstrichen" : which;
  }

  // Link setzen/ändern/entfernen am aktuellen Lauf.
  function onLinkClick() {
    var run = syncActiveRun();
    if (!run) return;
    var cur = run.fmt.link || "";
    var url = window.prompt(
      cur ? "Link-Adresse (leer lassen = Link entfernen):" : "Link-Adresse (URL):",
      cur);
    if (url === null) return; // Abbruch
    url = url.trim();
    if (!url) {
      // Leer: bei vorhandenem Link Rückfrage zum Entfernen.
      if (cur && window.confirm("Link entfernen?")) {
        run.fmt.link = null;
      }
    } else {
      run.fmt.link = url;
    }
    reflectRun(run);
    updateFormatToolbar();
    if (run.el && typeof run.el.focus === "function") run.el.focus();
  }

  // ---------------------------------------------------------------------------
  // Seiten-Umschalter
  // ---------------------------------------------------------------------------
  var PAGE_LABELS = {
    "index.html": "Startseite",
    "impressum.html": "Impressum",
    "datenschutz.html": "Datenschutz",
    "agb.html": "AGB"
  };
  function pageLabel(basename) {
    return PAGE_LABELS[basename] || basename;
  }

  // Aktueller Basename: bevorzugt CFG.page, sonst aus pagePath abgeleitet.
  function currentPage() {
    return (typeof CFG.page === "string" && CFG.page) ? CFG.page : pageBasename;
  }

  // Liefert <select> oder null (wenn pages fehlt/leer → kein Umschalter).
  function buildPageSwitcher() {
    var pages = CFG.pages;
    if (!Array.isArray(pages) || pages.length === 0) return null;

    var cur = currentPage();
    var select = el("select", {
      class: "__regoro-pages", "aria-label": "Seite wählen", title: "Seite wählen"
    });

    pages.forEach(function (basename) {
      if (typeof basename !== "string" || !basename) return;
      var opt = el("option", { value: basename, text: pageLabel(basename) });
      if (basename === cur) opt.setAttribute("selected", "selected");
      select.appendChild(opt);
    });
    // Falls der aktuelle Basename nicht in pages steht, trotzdem korrekt vorbelegen.
    select.value = cur;

    ui.pageSelect = select;
    select.addEventListener("change", onPageSwitch);
    return select;
  }

  function onPageSwitch() {
    var target = ui.pageSelect.value;
    var cur = currentPage();
    if (!target || target === cur) return;

    // Dirty-Guard: vor dem Wechsel warnen; bei Abbruch Auswahl zurücksetzen.
    if (isDirty() && !window.confirm(
      "Es gibt ungespeicherte Änderungen. Zu einer anderen Seite wechseln und Änderungen verwerfen?")) {
      ui.pageSelect.value = cur;
      return;
    }
    // Suffix-Edit-URLs: index.html -> /edit; <name>.html -> /<name>.html/edit.
    // root-absolute Navigation, zuverlässig unabhängig vom Trailing-Slash.
    bypassUnloadGuard = true; // beforeunload-Guard für gewollten Wechsel umgehen
    window.location.assign(editUrlForPage(target));
  }

  // Baut die Suffix-Edit-URL einer Seite: die Startseite (index.html) liegt unter
  // /edit (Root-Edit), jede andere Seite unter /<name>.html/edit. Der Basename
  // wird encodeURIComponent'et (defensiv; die Whitelist erlaubt nur [a-z0-9-]).
  function editUrlForPage(basename) {
    if (basename === "index.html") return "/edit";
    return "/" + encodeURIComponent(basename) + "/edit";
  }

  function setStatus(msg, kind) {
    ui.status.className = "__regoro-status" + (kind ? " __regoro-" + kind : "");
    ui.status.textContent = msg || "";
  }

  function updateButtons() {
    ui.btnEdit.textContent = editing ? "Bearbeiten beenden" : "Bearbeiten";
    ui.btnSave.disabled = !editing;
    ui.btnDiscard.disabled = !editing;
  }

  // ---------------------------------------------------------------------------
  // Editier-Modus
  // ---------------------------------------------------------------------------
  function findRun(node) {
    for (var i = 0; i < elements.length; i++) {
      if (elements[i].el === node) return elements[i];
    }
    return null;
  }

  // Dirty-Markierung + optische Format-Vorschau pro Lauf anwenden.
  function reflectRun(e) {
    if (!e) return;
    if (textChanged(e) || fmtChanged(e)) e.el.classList.add("__regoro-dirty");
    else e.el.classList.remove("__regoro-dirty");
    // Optische Sofort-Vorschau des Format-Befehls (maßgeblich bleibt der Op).
    e.el.classList.toggle("__regoro-b", !!e.fmt.bold);
    e.el.classList.toggle("__regoro-i", !!e.fmt.italic);
    e.el.classList.toggle("__regoro-link", !!e.fmt.link);
    // Gegen-Vorschau für Toggle-OFF: liegt der Lauf bereits in <strong>/<em>/<u>/<a>
    // (origFmt true), würde das geerbte Markup weiter wirken. Per Inline-Style
    // sichtbar zurücknehmen, damit das Entfernen optisch erkennbar ist.
    e.el.style.fontWeight = (!e.fmt.bold && e.origFmt.bold) ? "normal" : "";
    e.el.style.fontStyle = (!e.fmt.italic && e.origFmt.italic) ? "normal" : "";
    // text-decoration deckt Unterstrich UND Link-Unterstreichung ab:
    //   underline an -> "underline"; sonst wenn (underline/link war an, jetzt aus) -> "none".
    if (e.fmt.underline) {
      e.el.style.textDecoration = "underline";
    } else if ((e.origFmt.underline && !e.fmt.underline) || (e.origFmt.link && !e.fmt.link)) {
      e.el.style.textDecoration = "none";
    } else {
      e.el.style.textDecoration = "";
    }
    // Whole-Run-Farbe: Vorschau inline anwenden bzw. zurücknehmen.
    e.el.style.color = e.fmt.color ? e.fmt.color : "";
  }
  function reflectDirty(node) {
    reflectRun(findRun(node));
  }

  // Enter -> befehlsbasierter <br>; Backspace/Entf am Lauf-Rand -> angrenzendes <br> löschen.
  function onKeydown(e) {
    if (e.key === "Enter") { onEnterKey(e); return; }
    if (e.key === "Backspace") { onBackspaceKey(e); return; }
    if (e.key === "Delete") { onDeleteKey(e); return; }
  }

  // Enter -> kein natives <div>/<br>-Chaos, stattdessen NUR eine visuelle Vorschau-<br>
  // (<br class="__regoro-br-preview">) an der Caret-Position einfügen. Die brAt-Op wird
  // beim Speichern aus dem DOM abgeleitet (collectBrOpsFromDom) — kein Queue, kein Desync.
  function onEnterKey(e) {
    e.preventDefault();
    if (e.shiftKey) return; // Shift+Enter ebenfalls neutralisieren, keine Sonderbehandlung

    var run = findRun(e.target);
    var sel = window.getSelection && window.getSelection();
    if (!run || !sel || sel.rangeCount === 0) return;

    insertBrPreviewAt(sel); // optische Sofort-Vorschau; Op folgt beim Save aus dem DOM
    reflectRun(run);
    updateFormatToolbar();
    setStatus("Zeilenumbruch eingefügt — Speichern, um zu übernehmen.", "ok");
  }

  // Caret ist (ohne Markierung) am Lauf-ANFANG (Offset 0)?
  function caretAtRunStart(run, sel) {
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    var off = charOffsetInRun(run.el, sel.focusNode, sel.focusOffset);
    return off === 0;
  }
  // ... am Lauf-ENDE (Offset == Textlänge)?
  function caretAtRunEnd(run, sel) {
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    var off = charOffsetInRun(run.el, sel.focusNode, sel.focusOffset);
    return off !== null && off === run.el.textContent.length;
  }

  // Unmittelbar an den Lauf-Span angrenzendes Element in Dokumentreihenfolge
  // (dir<0 = davor, dir>0 = danach). Überspringt reine Whitespace-Textknoten; bricht
  // bei echtem Text dazwischen ab. Steigt aus inline-Wrappern (z.B. <strong>) auf, wenn
  // der Span dort am Rand sitzt — bleibt aber innerhalb des editierbaren Blocks.
  function adjacentElement(runEl, dir) {
    var block = runEl.closest("[data-edit-del-idx]") || runEl.parentElement;
    var cur = runEl;
    while (cur && cur !== block) {
      var node = dir < 0 ? cur.previousSibling : cur.nextSibling;
      while (node) {
        if (node.nodeType === 1) return node;               // Element gefunden
        if (node.nodeType === 3 && node.textContent.trim() !== "") return null; // echter Text dazwischen
        node = dir < 0 ? node.previousSibling : node.nextSibling;
      }
      cur = cur.parentElement; // am Rand des Wrappers -> eine Ebene hoch
    }
    return null;
  }

  // Ein angrenzendes <br> entfernen (Backspace am Anfang / Entf am Ende).
  // Gespeichertes <br> (data-edit-br-idx) -> deleteBr-Op. Ungespeicherte Vorschau-<br>
  // -> einfach aus dem DOM entfernen; da die brAt-Ops beim Save aus dem DOM abgeleitet
  // werden, entsteht dann gar keine Op (sauberer No-op, kein Queue-Desync).
  function removeAdjacentBr(e, run, dir) {
    var br = adjacentElement(run.el, dir);
    if (!br || br.tagName !== "BR") return false;
    e.preventDefault();

    if (br.hasAttribute("data-edit-br-idx")) {
      var brIdx = Number(br.getAttribute("data-edit-br-idx"));
      if (!isNaN(brIdx)) {
        // Doppelte deleteBr vermeiden.
        var dup = false;
        for (var i = 0; i < deleteBrOps.length; i++) {
          if (deleteBrOps[i].brIdx === brIdx) { dup = true; break; }
        }
        if (!dup) deleteBrOps.push({ op: "deleteBr", brIdx: brIdx });
      }
      if (br.parentNode) br.parentNode.removeChild(br); // optische Sofort-Vorschau
      setStatus("Zeilenumbruch entfernt — Speichern, um zu übernehmen.", "ok");
    } else {
      // Ungespeicherte Vorschau-<br>: nur aus dem DOM entfernen (Op leitet sich aus DOM ab).
      if (br.parentNode) br.parentNode.removeChild(br);
      setStatus("Zeilenumbruch entfernt.", "ok");
    }
    reflectRun(run);
    updateFormatToolbar();
    return true;
  }

  // Backspace am Lauf-Anfang -> vorangehendes <br> löschen (sonst native Bearbeitung).
  function onBackspaceKey(e) {
    var run = findRun(e.target);
    var sel = window.getSelection && window.getSelection();
    if (!run || !sel) return;
    if (!caretAtRunStart(run, sel)) return; // sonst nativ (Text löschen)
    removeAdjacentBr(e, run, -1);
  }

  // Entf am Lauf-Ende -> nachfolgendes <br> löschen (nice-to-have).
  function onDeleteKey(e) {
    var run = findRun(e.target);
    var sel = window.getSelection && window.getSelection();
    if (!run || !sel) return;
    if (!caretAtRunEnd(run, sel)) return; // sonst nativ
    removeAdjacentBr(e, run, +1);
  }

  // Visuelle <br>-Vorschau an der aktuellen Caret-Position einfügen (rein optisch).
  // Maßgeblich ist die brAt-Op; ändert den textContent nicht.
  function insertBrPreviewAt(sel) {
    try {
      var range = sel.getRangeAt(0);
      range.deleteContents();
      var br = document.createElement("br");
      br.className = "__regoro-br-preview";
      range.insertNode(br);
      // Caret hinter den <br> setzen.
      range.setStartAfter(br);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* Vorschau best-effort */ }
  }
  function onInput(e) {
    reflectDirty(e.target);
  }
  // Fokus auf einen Lauf -> aktiven Lauf merken + Format-Toolbar spiegeln.
  function onRunFocus(e) {
    var run = findRun(e.target);
    if (run) {
      activeRun = run;
      updateFormatToolbar();
    }
  }

  // Robust den Lauf ermitteln, in dem Caret/Selektion steckt — deterministisch
  // aus window.getSelection().focusNode (Fallback document.activeElement). So ist
  // der Ziel-Lauf auch bei verschachteltem Markup (<strong><span data-edit-idx>…)
  // und nach Fokuswechseln immer korrekt, unabhängig vom focus-Event-Timing.
  function runAtSelection() {
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount > 0) {
      var node = sel.focusNode || sel.anchorNode;
      if (node) {
        var elt = node.nodeType === 1 ? node : node.parentElement;
        if (elt && typeof elt.closest === "function") {
          var holder = elt.closest("[data-edit-idx]");
          var run = holder && findRun(holder);
          if (run) return run;
        }
      }
    }
    // Fallback: aktives Element.
    var ae = document.activeElement;
    if (ae && typeof ae.closest === "function") {
      var h2 = ae.closest("[data-edit-idx]");
      var r2 = h2 && findRun(h2);
      if (r2) return r2;
    }
    return null;
  }

  // Aktiven Lauf vor einer Toolbar-Aktion sicher bestimmen (Selektion gewinnt,
  // sonst der zuletzt fokussierte). Aktualisiert activeRun + Toolbar-Zustand.
  function syncActiveRun() {
    var run = runAtSelection();
    if (run) {
      activeRun = run;
      updateFormatToolbar();
    }
    return activeRun;
  }

  function setEditing(on) {
    editing = on;
    for (var i = 0; i < elements.length; i++) {
      var entry = elements[i];
      var node = entry.el;
      if (on) {
        node.setAttribute("contenteditable", "true");
        node.setAttribute("spellcheck", "false");
        node.classList.add("__regoro-active");
        node.addEventListener("keydown", onKeydown);
        node.addEventListener("input", onInput);
        node.addEventListener("focus", onRunFocus);
        reflectRun(entry);
      } else {
        node.removeAttribute("contenteditable");
        node.removeAttribute("spellcheck");
        node.classList.remove("__regoro-active");
        node.classList.remove("__regoro-dirty");
        node.classList.remove("__regoro-b", "__regoro-i", "__regoro-link");
        node.style.fontWeight = "";
        node.style.fontStyle = "";
        node.style.textDecoration = "";
        node.style.color = "";
        node.removeEventListener("keydown", onKeydown);
        node.removeEventListener("input", onInput);
        node.removeEventListener("focus", onRunFocus);
      }
    }
    if (!on) { activeRun = null; closeColorPanel(); }
    setImagesEditable(on);
    if (ui.formatBar) ui.formatBar.style.display = on ? "" : "none";
    updateButtons();
    updateFormatToolbar();
  }

  function toggleEditing() {
    if (editing) {
      // Beim Verlassen des Editier-Modus ungespeicherte Änderungen abfragen.
      if (isDirty() && !window.confirm(
        "Es gibt ungespeicherte Änderungen. Bearbeiten beenden und Änderungen verwerfen?")) {
        return;
      }
      if (isDirty()) resetToOriginal();
      setEditing(false);
      setStatus("");
    } else {
      setEditing(true);
      setStatus("Klick in einen Text, um ihn zu ändern.");
    }
  }

  function resetToOriginal() {
    for (var i = 0; i < elements.length; i++) {
      var e = elements[i];
      // textContent = original entfernt auch alle previewRange-Spans und <br>-Vorschauen.
      e.el.textContent = e.original;
      e.fmt = { bold: e.origFmt.bold, italic: e.origFmt.italic, underline: e.origFmt.underline, link: e.origFmt.link, color: e.origFmt.color };
      // reflectRun setzt Klassen + Inline-Style-Overrides konsistent zum (jetzt
      // zurückgesetzten) fmt — Toggle-OFF-Overrides verschwinden dabei.
      reflectRun(e);
    }
    structOps = [];
    rangeOps = [];
    deleteBrOps = [];
    // Vorschau-<br> wurden bereits durch textContent=original entfernt (kein Queue mehr).
    updateFormatToolbar();
  }

  // ---------------------------------------------------------------------------
  // Bild-Austausch (Upload vom Rechner)
  // ---------------------------------------------------------------------------
  function collectImages() {
    images = [];
    var nodes = document.querySelectorAll("[data-edit-img-idx]");
    for (var i = 0; i < nodes.length; i++) {
      var img = nodes[i];
      var imgIdx = Number(img.getAttribute("data-edit-img-idx"));
      if (isNaN(imgIdx)) continue;
      images.push({ img: img, imgIdx: imgIdx, badge: null, imgClickHandler: null });
    }
  }

  function ensureFileInput() {
    if (fileInput) return fileInput;
    fileInput = el("input", {
      type: "file",
      accept: "image/png,image/jpeg,image/webp,image/gif",
      style: "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;"
    });
    fileInput.addEventListener("change", onFileChosen);
    document.body.appendChild(fileInput);
    return fileInput;
  }

  // Affordance pro Bild ein-/ausschalten — OHNE DOM-Wrapper (der würde absolute
  // Positionierung/object-fit brechen, siehe .mini-hero img). Stattdessen:
  //  - Klick-Affordance direkt am <img> (cursor/outline/title via __regoro-img-editable),
  //    Klick aufs Bild öffnet den Datei-Dialog.
  //  - eine SCHWEBENDE Badge am document.body, per getBoundingClientRect() über dem Bild
  //    positioniert (neu berechnet bei scroll/resize) — nichts wird ins Bild-Eltern-DOM eingefügt.
  function setImagesEditable(on) {
    for (var i = 0; i < images.length; i++) {
      var rec = images[i];
      if (on) {
        rec.img.classList.add("__regoro-img-editable");
        rec.img.setAttribute("title", "Bild ersetzen");
        if (!rec.imgClickHandler) {
          (function (record) {
            record.imgClickHandler = function (e) {
              e.preventDefault();
              e.stopPropagation();
              openImagePicker(record);
            };
          })(rec);
          rec.img.addEventListener("click", rec.imgClickHandler);
        }
        if (!rec.badge) {
          var badge = el("button", {
            class: "__regoro-img-badge", type: "button", "aria-label": "Bild ersetzen"
          }, ["Bild ersetzen"]);
          (function (record) {
            badge.addEventListener("mousedown", function (e) { e.preventDefault(); });
            badge.addEventListener("click", function (e) {
              e.preventDefault();
              e.stopPropagation();
              openImagePicker(record);
            });
          })(rec);
          document.body.appendChild(badge); // schwebend, NICHT um das Bild
          rec.badge = badge;
        }
        rec.badge.style.display = "";
      } else {
        rec.img.classList.remove("__regoro-img-editable");
        rec.img.removeAttribute("title");
        if (rec.imgClickHandler) {
          rec.img.removeEventListener("click", rec.imgClickHandler);
          rec.imgClickHandler = null;
        }
        if (rec.badge) rec.badge.style.display = "none";
      }
    }
    if (on) {
      positionImageBadges();
      if (!imageBadgeListenersBound) {
        window.addEventListener("scroll", positionImageBadges, true);
        window.addEventListener("resize", positionImageBadges);
        imageBadgeListenersBound = true;
      }
    }
  }

  // Schwebende Bild-Badges über den jeweiligen Bildern positionieren.
  function positionImageBadges() {
    for (var i = 0; i < images.length; i++) {
      var rec = images[i];
      if (!rec.badge || rec.badge.style.display === "none") continue;
      var r = rec.img.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) { rec.badge.style.display = "none"; continue; }
      rec.badge.style.left = (window.scrollX + r.left + 8) + "px";
      rec.badge.style.top = (window.scrollY + r.top + 8) + "px";
    }
  }

  function openImagePicker(rec) {
    if (uploadInFlight) return;
    activeImage = rec;
    var input = ensureFileInput();
    input.value = ""; // erlaubt Auswahl derselben Datei erneut
    input.click();
  }

  function onFileChosen() {
    var file = fileInput && fileInput.files && fileInput.files[0];
    var rec = activeImage;
    activeImage = null;
    if (!file || !rec) return;
    uploadImage(rec, file);
  }

  function uploadImage(rec, file) {
    if (uploadInFlight) return;
    uploadInFlight = true;
    if (rec.badge) {
      rec.badge.setAttribute("disabled", "disabled");
      rec.badge.textContent = "Lädt…";
    }
    setStatus("Bild wird hochgeladen…");

    var fd = new FormData();
    fd.append("pagePath", CFG.pagePath);
    fd.append("imgIdx", String(rec.imgIdx));
    fd.append("image", file);

    // WICHTIG: keinen Content-Type setzen — der Browser setzt die multipart-Boundary.
    fetch("/edit/upload", {
      method: "POST",
      credentials: "same-origin",
      body: fd
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { status: res.status, ok: res.ok, data: data };
      });
    }).then(function (r) {
      if (r.status === 400) {
        var msg = (r.data && r.data.error) ? r.data.error
          : "Nur PNG/JPG/WebP/GIF bis 5 MB.";
        throw new Error(msg);
      }
      if (!r.ok || !r.data || !r.data.ok || typeof r.data.src !== "string") {
        throw new Error("Bild-Upload fehlgeschlagen (" + r.status + ").");
      }
      // Neues Bild sofort laden. Der Server liefert pro Upload einen neuen Pfad
      // (upload-xxx.<ext>), daher kein Cache-Busting nötig.
      rec.img.addEventListener("load", function reposOnce() {
        rec.img.removeEventListener("load", reposOnce);
        if (editing) positionImageBadges();
      });
      rec.img.src = r.data.src;
      if (typeof r.data.fileHash === "string") {
        CFG.fileHash = r.data.fileHash;
        window.__REGORO_EDIT__.fileHash = r.data.fileHash;
      }
      setStatus("Bild ersetzt.", "ok");
    }).catch(function (err) {
      setStatus(err && err.message ? err.message : "Bild-Upload fehlgeschlagen.", "err");
    }).then(function () {
      uploadInFlight = false;
      if (rec.badge) {
        rec.badge.removeAttribute("disabled");
        rec.badge.textContent = "Bild ersetzen";
        // Badge nur sichtbar lassen, wenn noch im Edit-Modus.
        rec.badge.style.display = editing ? "" : "none";
      }
      // Bildmaße können sich geändert haben -> Badge neu positionieren.
      if (editing) positionImageBadges();
    });
  }

  // ---------------------------------------------------------------------------
  // Block-Struktur (Entfernen / Einfügen) — gesteuert über die Toolbar.
  // (Keine per-Block-🗑-Handles mehr: das Löschen läuft ausschließlich über den
  //  Toolbar-Button „🗑 Entfernen", der auf den Block des fokussierten Laufs wirkt.)
  // ---------------------------------------------------------------------------
  // Den Block (data-edit-del-idx) finden, der den fokussierten Lauf enthält.
  function activeBlockForRun(run) {
    if (!run || !run.el || typeof run.el.closest !== "function") return null;
    return run.el.closest("[data-edit-del-idx]");
  }
  function blockDelIdx(block) {
    if (!block) return null;
    var v = Number(block.getAttribute("data-edit-del-idx"));
    return isNaN(v) ? null : v;
  }

  // Block per delIdx finden (für optische Markierung).
  function blockByDelIdx(delIdx) {
    return document.querySelector('[data-edit-del-idx="' + delIdx + '"]');
  }

  // Kurzes Highlight auf einem Block, damit klar ist, was entfernt wird.
  function flashBlock(block) {
    if (!block) return;
    block.classList.add("__regoro-block-flash");
    setTimeout(function () { block.classList.remove("__regoro-block-flash"); }, 600);
  }

  function deleteBlock(delIdx, block) {
    if (delIdx === null || delIdx === undefined) return;
    // Schon vorgemerkt?
    for (var i = 0; i < structOps.length; i++) {
      if (structOps[i].op === "delete" && structOps[i].delIdx === delIdx) {
        setStatus("Block bereits zum Entfernen vorgemerkt.");
        return;
      }
    }
    if (!block) block = blockByDelIdx(delIdx);
    // Vor der Rückfrage kurz markieren, damit der Nutzer sieht, was gemeint ist.
    flashBlock(block);
    if (!window.confirm(
      "Ganzen Abschnitt löschen?\n\nDie Änderung wird beim Speichern wirksam; danach wird die Seite neu geladen.")) {
      return;
    }
    structOps.push({ op: "delete", delIdx: delIdx });
    // Optische Vormerkung am Block (bleibt bis Speichern/Reload).
    if (block) block.classList.add("__regoro-block-del");
    setStatus("Abschnitt zum Entfernen vorgemerkt — Speichern, um zu übernehmen.");
  }

  // Nur den markierten Text innerhalb EINES Laufs löschen (normale Text-Änderung).
  // Schreibt den neuen Lauf-Text direkt in den Span -> collectOps erfasst {idx,text}.
  function deleteSelectionText(range) {
    var run = range.run;
    var cur = run.el.textContent;
    // Offsets in Zeichen des AKTUELLEN Lauf-Texts (charOffsetInRun misst gegen den
    // aktuellen DOM-Inhalt) -> markierten Bereich [start,end) herausschneiden.
    var next = cur.slice(0, range.start) + cur.slice(range.end);
    run.el.textContent = next; // kann "" sein, wenn der ganze Lauf markiert war
    var sel = window.getSelection && window.getSelection();
    if (sel) sel.removeAllRanges();
    reflectRun(run);
    updateFormatToolbar();
    setStatus(next === "" ? "Markierten Text gelöscht (Lauf jetzt leer) — Speichern." : "Markierten Text gelöscht — Speichern.", "ok");
    if (run.el && typeof run.el.focus === "function") run.el.focus();
  }

  // Toolbar-Button „🗑": markierungsabhängig.
  //  - Markierung in EINEM Lauf  -> nur den markierten Text löschen ({idx,text}).
  //  - Mehrlauf-Markierung       -> Hinweis (v1-Grenze).
  //  - keine Markierung          -> ganzen Block löschen (mit Rückfrage).
  function onDeleteBlock() {
    var range = selectionInRun();
    if (range) {
      deleteSelectionText(range);
      return;
    }
    if (selectionSpansMultipleRuns()) {
      setStatus("Bitte innerhalb eines Absatzes markieren.", "err");
      return;
    }
    var run = syncActiveRun();
    var block = activeBlockForRun(run);
    var delIdx = blockDelIdx(block);
    if (delIdx === null) {
      setStatus("Bitte zuerst in den zu löschenden Abschnitt klicken.", "err");
      return;
    }
    deleteBlock(delIdx, block);
  }

  // (Hinweis: „➕ Absatz" wurde entfernt — Absätze/Umbrüche entstehen jetzt über
  //  Enter -> {idx, brAt} im jeweiligen Lauf. Die insert-Op wird nicht mehr erzeugt.)

  // ---------------------------------------------------------------------------
  // Verwerfen
  // ---------------------------------------------------------------------------
  function onDiscard() {
    if (!editing) return;
    if (isDirty() && !window.confirm("Alle ungespeicherten Änderungen verwerfen?")) return;
    // Ein per Backspace optisch entferntes gespeichertes <br> sitzt zwischen den
    // Lauf-Spans; resetToOriginal (textContent pro Span) kann es nicht wiederherstellen
    // -> für einen sauberen Originalstand neu laden.
    var hadBrDeletion = deleteBrOps.length > 0;
    resetToOriginal();
    if (hadBrDeletion) { forceReload(); return; }
    setEditing(false);
    setStatus("Verworfen.", "ok");
  }

  // ---------------------------------------------------------------------------
  // Speichern
  // ---------------------------------------------------------------------------
  function onSave() {
    if (!editing) return;
    var edits = collectOps();
    var dropped = lastCollectDropped; // veraltete Fallback-Range-Ops (fast nie > 0)
    if (edits.length === 0 && dropped === 0) {
      setStatus("Keine Änderungen zu speichern.");
      return;
    }
    // Reload nach Erfolg, wenn sich die Dokumentstruktur/Lauf-Aufteilung ändert:
    // delete/insert (frische Indizes); Range-Ops (Server verschachtelt Teilbereiche
    // in neue <strong>/<em>/<span>); brAt-Ops (Server spaltet Text-Node + fügt <br> ein);
    // deleteBr-Ops (Server führt angrenzende Texte zusammen); eine Op leert einen Lauf
    // (text==="") -> leere Markup-Hüllen weg; ODER IRGENDEINE Format-Op (Whole-Run/Range
    // mit bold/italic/underline/color/link) -> Server fügt Wrapper hinzu/entfernt sie, das
    // Client-DOM ist danach stale (sonst sieht ein entformatierter Lauf weiter formatiert aus).
    var needsReload = hasStructuralOps() || rangeOps.length > 0 || hasPreviewBr() ||
                      hasPreviewRangeFmt() || deleteBrOps.length > 0 ||
                      emptiesARun(edits) || hasFormatOp(edits);
    ui.btnSave.disabled = true;
    setStatus("Speichern…");

    fetch("/edit/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        pagePath: CFG.pagePath,
        fileHash: CFG.fileHash,
        edits: edits
      })
    }).then(function (res) {
      if (res.status === 409) {
        handleConflict();
        return null;
      }
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("Speichern fehlgeschlagen (" + res.status + ")" + (t ? ": " + t : ""));
        });
      }
      return res.json();
    }).then(function (data) {
      if (!data) return; // Konflikt bereits behandelt
      if (data.ok && typeof data.fileHash === "string") {
        // Neuen fileHash übernehmen für Folge-Speicherungen.
        CFG.fileHash = data.fileHash;
        window.__REGORO_EDIT__.fileHash = data.fileHash;
      }
      if (dropped > 0) {
        // Seltener Fallback: mind. eine Range-Op wurde nach einer Textänderung im
        // selben Lauf verworfen (veraltete Offsets, kein DOM-Anker zum Ableiten).
        // NICHT still: warnen und NICHT automatisch neu laden (sonst geht der Hinweis
        // unter). Der Rest der Änderungen ist gespeichert.
        rangeOps = [];
        deleteBrOps = [];
        ui.btnSave.disabled = false;
        setStatus("Gespeichert — Hinweis: " + dropped + " Formatierung(en) konnten nach einer Textänderung nicht angewendet werden. Bitte erneut markieren und anwenden.", "err");
        return;
      }
      if (needsReload) {
        // Struktur/Lauf-Aufteilung hat sich geändert -> frischen Stand per Reload holen.
        setStatus("Gespeichert. Seite wird neu geladen…", "ok");
        forceReload();
        return;
      }
      // Ausgangs-Text UND -Format aktualisieren -> nichts mehr "dirty".
      for (var i = 0; i < elements.length; i++) {
        var e = elements[i];
        e.original = e.el.textContent;
        e.origFmt = { bold: e.fmt.bold, italic: e.fmt.italic, underline: e.fmt.underline, link: e.fmt.link, color: e.fmt.color };
        e.el.classList.remove("__regoro-dirty");
      }
      rangeOps = [];
      deleteBrOps = [];
      setEditing(false);
      setStatus("Gespeichert.", "ok");
    }).catch(function (err) {
      ui.btnSave.disabled = false;
      setStatus(err && err.message ? err.message : "Speichern fehlgeschlagen.", "err");
    });
  }

  function handleConflict() {
    setStatus("Datei wurde serverseitig geändert.", "err");
    ui.btnSave.disabled = false;
    if (window.confirm(
      "Diese Seite wurde zwischenzeitlich an anderer Stelle geändert. " +
      "Deine Änderungen können nicht gespeichert werden.\n\n" +
      "Seite jetzt neu laden? (Ungespeicherte Änderungen gehen dabei verloren.)")) {
      forceReload();
    }
  }

  // ---------------------------------------------------------------------------
  // Versionen-Panel
  // ---------------------------------------------------------------------------
  function onVersions() {
    // Dirty-Guard (Stufe 1): vor Öffnen warnen.
    if (isDirty() && !window.confirm(
      "Es gibt ungespeicherte Änderungen. Versionen öffnen und Änderungen ignorieren?\n" +
      "(Die Änderungen bleiben in der Seite, werden aber nicht gespeichert.)")) {
      return;
    }
    if (versionsPanel) {
      closeVersions();
      return;
    }
    openVersions();
  }

  function closeVersions() {
    if (versionsPanel && versionsPanel.parentNode) {
      versionsPanel.parentNode.removeChild(versionsPanel);
    }
    versionsPanel = null;
  }

  function openVersions() {
    var panel = el("div", { id: "__regoro-versions" });

    var head = el("div", { class: "__regoro-vhead" }, [
      el("h2", { text: "Versionen" })
    ]);
    var closeBtn = el("button", { class: "__regoro-vclose", text: "×", type: "button", "aria-label": "Schließen" });
    closeBtn.addEventListener("click", closeVersions);
    head.appendChild(closeBtn);

    var body = el("div", { class: "__regoro-vbody" }, [
      el("div", { class: "__regoro-vmsg", text: "Lade Versionen…" })
    ]);

    panel.appendChild(head);
    panel.appendChild(body);
    document.body.appendChild(panel);
    versionsPanel = panel;

    fetch("/edit/versions?page=" + encodeURIComponent(pageBasename), {
      credentials: "same-origin",
      headers: { "Accept": "application/json" }
    }).then(function (res) {
      if (!res.ok) throw new Error("Versionen konnten nicht geladen werden (" + res.status + ").");
      return res.json();
    }).then(function (list) {
      renderVersions(body, list);
    }).catch(function (err) {
      body.innerHTML = "";
      body.appendChild(el("div", {
        class: "__regoro-vmsg",
        text: err && err.message ? err.message : "Fehler beim Laden der Versionen."
      }));
    });
  }

  function renderVersions(body, list) {
    body.innerHTML = "";
    if (!Array.isArray(list) || list.length === 0) {
      body.appendChild(el("div", { class: "__regoro-vmsg", text: "Keine Versionen vorhanden." }));
      return;
    }
    list.forEach(function (v) {
      if (!v || !v.commit) return;
      var when = v.date ? formatDate(v.date) : "";
      var item = el("div", { class: "__regoro-vitem" }, [
        el("div", { class: "__regoro-vdate", text: when }),
        el("div", { class: "__regoro-vsubj", text: v.subject || "(ohne Beschreibung)" })
      ]);

      var actions = el("div", { class: "__regoro-vactions" });
      var preview = el("button", { class: "__regoro-vbtn", text: "Vorschau", type: "button" });
      preview.addEventListener("click", function () { onPreview(v.commit); });
      var restore = el("button", { class: "__regoro-vbtn __regoro-vrestore", text: "Diese Version speichern", type: "button" });
      restore.addEventListener("click", function () { onRestore(v.commit, v.subject); });

      actions.appendChild(preview);
      actions.appendChild(restore);
      item.appendChild(actions);
      body.appendChild(item);
    });
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    try {
      return d.toLocaleString("de-DE", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit"
      });
    } catch (e) {
      return d.toISOString();
    }
  }

  function onPreview(commit) {
    // Dirty-Guard (Stufe 1): vor read-only-Vorschau warnen.
    if (isDirty() && !window.confirm(
      "Es gibt ungespeicherte Änderungen. Vorschau einer alten Version öffnen?\n" +
      "(Die Vorschau öffnet in einem neuen Tab und ist nur zur Ansicht.)")) {
      return;
    }
    var url = "/edit/version/" + encodeURIComponent(commit) +
      "?page=" + encodeURIComponent(pageBasename);
    window.open(url, "_blank", "noopener");
  }

  function onRestore(commit, subject) {
    if (!window.confirm(
      "Diese Version wiederherstellen?\n\n" +
      (subject ? "„" + subject + "“\n\n" : "") +
      "Der aktuelle Stand wird durch diese Version ersetzt und als neue Version gesichert. " +
      "Die Seite wird danach neu geladen.")) {
      return;
    }
    fetch("/edit/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ commit: commit, pagePath: CFG.pagePath })
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("Wiederherstellen fehlgeschlagen (" + res.status + ")" + (t ? ": " + t : ""));
        });
      }
      return res.json();
    }).then(function (data) {
      if (data && data.ok) {
        // Restore committet serverseitig -> Seite neu laden.
        forceReload();
      } else {
        throw new Error("Wiederherstellen nicht bestätigt.");
      }
    }).catch(function (err) {
      window.alert(err && err.message ? err.message : "Wiederherstellen fehlgeschlagen.");
    });
  }

  // ---------------------------------------------------------------------------
  // Dirty-Guard: beforeunload + sicherer Reload
  // ---------------------------------------------------------------------------
  var bypassUnloadGuard = false;
  function onBeforeUnload(e) {
    if (bypassUnloadGuard) return;
    if (isDirty()) {
      e.preventDefault();
      e.returnValue = "";
      return "";
    }
  }
  function forceReload() {
    bypassUnloadGuard = true;
    window.location.reload();
  }

  // ---------------------------------------------------------------------------
  // Navigations-Guard: im Edit-Modus Links/Buttons/Submit unterdrücken,
  // damit der Cursor zum Editieren gesetzt wird statt zu navigieren.
  // ---------------------------------------------------------------------------

  // Liegt das Target in der eigenen Overlay-CHROME (Toolbar/Panel/aufgelegte Buttons)?
  // Dann NIE unterdrücken — diese Buttons sollen normal klickbar bleiben.
  //
  // WICHTIG (Fix Nav-Guard-Regression): NICHT einfach auf "[class^=__regoro]" prüfen.
  // Editierbare Seiten-Inhalte tragen selbst __regoro-Klassen (__regoro-active,
  // __regoro-b/i/link auf [data-edit-idx]-Läufen, __regoro-img-editable auf Bildern).
  // Ein solcher Selektor würde den angeklickten Link-/Button-Text fälschlich als
  // "eigene UI" erkennen und die Navigation NICHT unterdrücken. Eigene UI = nur die
  // fixe Toolbar, das Versionen-Panel und die aufgelegte Bild-„ersetzen"-Badge.
  function isOwnUI(target) {
    if (!target || typeof target.closest !== "function") return false;
    // Sicherheitsnetz: alles innerhalb eines editierbaren Inhalts-Elements ist
    // Seiteninhalt, niemals eigene UI — auch wenn es __regoro-Klassen trägt.
    if (target.closest("[data-edit-idx], [data-edit-img-idx], [data-edit-del-idx]")) {
      // Ausnahme: die aufgelegte Bild-Badge liegt DOM-technisch nah am Bild,
      // zählt aber als unsere UI.
      if (!target.closest(".__regoro-img-badge")) return false;
    }
    return !!target.closest(
      "#__regoro-bar, #__regoro-versions, .__regoro-img-badge"
    );
  }

  function onCaptureClick(e) {
    if (!editing) return;                       // nur im aktiven Edit-Modus
    var target = e.target;
    if (isOwnUI(target)) return;                // eigene Buttons funktionieren normal
    if (typeof target.closest !== "function") return;
    // Navigations-/Submit-auslösende Elemente.
    var nav = target.closest(
      'a[href], button, [role="button"], input[type="submit"], input[type="image"], summary'
    );
    if (!nav) return;
    // Nur den Default unterdrücken (Navigation/Submit) — KEIN stopPropagation,
    // damit die Browser-Caret-Platzierung im contenteditable-Span erhalten bleibt.
    e.preventDefault();
  }

  function onCaptureSubmit(e) {
    if (!editing) return;
    if (isOwnUI(e.target)) return;
    e.preventDefault();
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init() {
    injectStyles();
    collectElements();
    collectImages();
    buildBar();
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onCaptureClick, true);
    document.addEventListener("submit", onCaptureSubmit, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
