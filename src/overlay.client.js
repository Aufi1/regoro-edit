/*
 * regoro.de Inline-Editor — Browser-Overlay
 *
 * Plain, dependency-freies Browser-JS. Kein Bundler, kein Build.
 * Wird vom Editor-Host vor </body> eingebunden via <script src="/edit-assets/overlay.js">.
 *
 * Erwartet (vom Server injiziert):
 *   - window.__REGORO_EDIT__ = { pagePath, fileHash, pages?:string[], page?:string, ki?:boolean }
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
 * KI-Seitenleiste (nur wenn CFG.ki === true; sonst existiert sie nicht im DOM):
 *   POST /edit/agent           { auftrag } -> 200 { ok:true, laufId } | 400/409/429/503 { ok:false, grund }
 *   GET  /edit/agent/status    -> 200 { ok:true, laeuft, laufId, kontingent:{frei,gesamt,erschoepft,monat} }
 *   GET  /edit/agent/events    text/event-stream: text | werkzeug | tokens | fertig | fehler
 *   POST /edit/agent/abort     -> 200 { ok:true }  (idempotent)
 * Alle Agenten-Routen antworten unangemeldet mit 404, nie 401.
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
  // KI-Seitenleiste: Panel, offener Ereignisstrom und der zuletzt bekannte
  // Laufzustand. `agentQuelle` MUSS beim Schließen zugemacht werden — eine
  // offene EventSource verbindet sich sonst nach jedem Serverende von selbst
  // neu und hält den Lauf-Endpunkt dauerhaft belegt.
  var agentPanel = null;
  var agentQuelle = null;
  var agentLaeuft = false;
  // Die Sprechblase, an die gerade angehängt wird. `text`-Ereignisse kommen
  // token-für-token aus dem Modell — an einem echten Lauf gemessen waren es
  // für zwei Sätze über sechzig Stück („Nun", " fü", "ge ich", …). Je eine
  // Blase daraus zu machen wäre unlesbar; sie werden deshalb in EINE Blase
  // geschrieben, bis ein anderes Ereignis dazwischenkommt.
  var agentTextBlase = null;
  // Dauerhafte Sperre der Eingabe, unabhängig davon, ob gerade etwas läuft:
  // erschöpftes Kontingent oder ein Server, der keinen Zustand liefert. Ohne
  // dieses Flag hob `setAgentLaeuft(false)` am Ende jedes Stroms die Sperre
  // wieder auf — im Prüfstand gemessen: Nach der stillen Nachlese beim Öffnen
  // war „Auftrag geben" trotz aufgebrauchtem Kontingent wieder anklickbar, und
  // der Kunde lief in eine 429 statt in eine Erklärung.
  var agentGesperrt = false;
  // Das Monatskontingent aus der letzten Status-Abfrage. Die tokens-Ereignisse
  // eines Laufs tragen nur `frei`; ohne den gemerkten Gesamtwert müsste die
  // Anzeige mitten im Lauf das Format wechseln („noch X" statt „noch X von Y"),
  // und das sähe aus wie ein Fehler.
  var agentGesamt = null;
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
      /**
       * UNSERE OBERFLÄCHE IST EINE FLEX-SPALTE, KEINE RECHNUNG.
       *
       * Vorher war jedes Stück einzeln `position:fixed` mit `top:0`, und damit
       * musste die Höhe der Leiste an drei Stellen bekannt sein — erst als
       * feste 52, dann als gemessene Variable. Beides ist eine Rechnung, die
       * falsch werden kann: Die Leiste hat `flex-wrap:wrap` und wird schmal
       * zweizeilig.
       *
       * Jetzt sagt die Struktur, was gilt: Die Hülle spannt den Bildschirm,
       * die Leiste ist der erste Block, darunter kommt ein Block, der die
       * Panels trägt. Wo die Panels anfangen, RECHNET DER BROWSER aus — die
       * Höhe der Leiste steht nirgends mehr im CSS.
       *
       * `pointer-events` ist der Preis dafür: Die Hülle liegt über der
       * Website, also lässt sie Klicks durch (`none`), und die Teile, die
       * wirklich da sind, holen sie sich zurück (`auto`).
       */
      "#__regoro-shell{position:fixed;inset:0;z-index:2147483600;",
      "display:flex;flex-direction:column;pointer-events:none;}",
      "#__regoro-shell>*{pointer-events:auto;}",
      "#__regoro-unten{flex:1 1 auto;min-height:0;display:flex;justify-content:flex-end;",
      "pointer-events:none;}",
      "#__regoro-unten>*{pointer-events:auto;}",
      "#__regoro-bar{flex:0 0 auto;",
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
      "#__regoro-versions{width:380px;max-width:92vw;height:100%;",
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
      // KI-Seitenleiste. Gleiche Geometrie wie das Versionen-Panel, aber ein
      // höherer z-index (2147483603 > 2147483601): Beide schließen sich zwar
      // gegenseitig aus, aber wenn doch einmal beide offen sind, soll das
      // Chatfenster oben liegen — dort tippt der Kunde.
      "#__regoro-agent{width:var(--regoro-apanel);max-width:96vw;height:100%;",
      "z-index:2147483603;background:#fff;color:#16222e;box-shadow:-4px 0 18px rgba(0,0,0,.28);",
      "display:flex;flex-direction:column;",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;}",
      "#__regoro-agent *{box-sizing:border-box;}",
      "#__regoro-agent .__regoro-ahead{display:flex;align-items:center;justify-content:space-between;",
      "padding:14px 16px;background:#14324f;color:#fff;flex:0 0 auto;}",
      "#__regoro-agent .__regoro-ahead h2{margin:0;font-size:16px;font-weight:700;}",
      "#__regoro-agent .__regoro-aclose{appearance:none;background:transparent;border:0;",
      "color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 4px;}",
      "#__regoro-agent .__regoro-aquota{flex:0 0 auto;padding:8px 16px;background:#f5f8fa;",
      "border-bottom:1px solid #e2e8ec;font-size:12.5px;color:#5a6b78;}",
      "#__regoro-agent .__regoro-aquota.__regoro-aleer{background:#fff4e5;color:#663c00;}",
      "#__regoro-agent .__regoro-averlauf{flex:1 1 auto;overflow:auto;padding:12px 16px;",
      "display:flex;flex-direction:column;gap:10px;}",
      "#__regoro-agent .__regoro-anachricht{font-size:14px;line-height:1.5;white-space:pre-wrap;",
      "overflow-wrap:anywhere;border-radius:10px;padding:9px 12px;}",
      "#__regoro-agent .__regoro-avon-kunde{background:#14324f;color:#fff;align-self:flex-end;",
      "max-width:85%;}",
      "#__regoro-agent .__regoro-avon-agent{background:#f0f4f7;color:#16222e;align-self:flex-start;",
      "max-width:95%;}",
      "#__regoro-agent .__regoro-awerkzeug{font-size:12.5px;color:#5a6b78;align-self:flex-start;",
      "display:flex;align-items:center;gap:6px;}",
      "#__regoro-agent .__regoro-afehler{background:#fdecea;color:#b3261e;border:1px solid #f5c2bd;}",
      "#__regoro-agent .__regoro-afertig{background:#e9f7ef;color:#14663a;border:1px solid #b7e2c8;}",
      "#__regoro-agent .__regoro-adateien{margin:6px 0 0;padding-left:18px;font-size:13px;}",
      "#__regoro-agent .__regoro-aform{flex:0 0 auto;border-top:1px solid #e2e8ec;padding:10px 12px;",
      "display:flex;flex-direction:column;gap:8px;background:#fff;}",
      "#__regoro-agent textarea.__regoro-aeingabe{width:100%;min-height:66px;max-height:180px;",
      "resize:vertical;border:1px solid #cbd5dc;border-radius:8px;padding:8px 10px;font:inherit;",
      "font-size:14px;color:#16222e;background:#fff;}",
      "#__regoro-agent textarea.__regoro-aeingabe:focus{outline:2px solid #e2571e;outline-offset:-1px;}",
      "#__regoro-agent textarea.__regoro-aeingabe:disabled{background:#f5f8fa;color:#8a99a6;}",
      "#__regoro-agent .__regoro-azeile{display:flex;gap:8px;align-items:center;}",
      "#__regoro-agent button.__regoro-abtn{appearance:none;border:1px solid #cbd5dc;background:#f5f8fa;",
      "color:#16222e;border-radius:999px;padding:8px 16px;font:inherit;font-size:14px;cursor:pointer;}",
      "#__regoro-agent button.__regoro-abtn:hover{background:#e8eef2;}",
      "#__regoro-agent button.__regoro-abtn:disabled{opacity:.45;cursor:not-allowed;}",
      "#__regoro-agent button.__regoro-asenden{background:#e2571e;border-color:#e2571e;color:#fff;",
      "font-weight:600;flex:1 1 auto;}",
      "#__regoro-agent button.__regoro-asenden:hover{background:#cf4d18;}",
      "#__regoro-agent .__regoro-ahinweis{font-size:12.5px;color:#5a6b78;line-height:1.45;}",

      /**
       * Der Stopp-Knopf IST die Laufanzeige.
       *
       * Vorher gab es einen Knopf „Abbrechen", der immer dastand und nur grau
       * wurde — als Zustandsanzeige taugt das nicht, weil ein grauer Knopf auch
       * einfach ein grauer Knopf sein kann. Jetzt ist er nur da, WÄHREND
       * gearbeitet wird, und er pulst dabei. Wer ihn sieht, weiß: es läuft.
       */
      "#__regoro-agent button.__regoro-astop{flex:0 0 auto;width:34px;height:34px;padding:0;",
      "display:none;align-items:center;justify-content:center;border-radius:50%;",
      "border:1px solid #e2571e;background:#fff;color:#e2571e;cursor:pointer;}",
      "#__regoro-agent.__regoro-alaeuft button.__regoro-astop{display:inline-flex;}",
      "#__regoro-agent button.__regoro-astop::before{content:\"\";width:11px;height:11px;",
      "border-radius:2px;background:currentColor;",
      "animation:__regoro-apuls 1.1s ease-in-out infinite;}",
      "#__regoro-agent button.__regoro-astop:disabled{opacity:.5;cursor:default;}",
      "#__regoro-agent button.__regoro-astop:disabled::before{animation:none;}",

      /** „Es passiert gerade etwas" — im Verlauf, wo der Blick ohnehin liegt. */
      "#__regoro-agent .__regoro-atut{display:flex;gap:6px;align-items:center;padding:6px 2px;}",
      "#__regoro-agent .__regoro-atut i{width:6px;height:6px;border-radius:50%;background:#8fa3b0;",
      "animation:__regoro-apuls 1.1s ease-in-out infinite;}",
      "#__regoro-agent .__regoro-atut i:nth-child(2){animation-delay:.18s;}",
      "#__regoro-agent .__regoro-atut i:nth-child(3){animation-delay:.36s;}",
      "#__regoro-agent .__regoro-ahinweis.__regoro-awarn{color:#a83c12;font-weight:600;}",
      // Punkt-Animation, solange der Agent arbeitet.
      "#__regoro-agent .__regoro-apuls{display:inline-block;width:8px;height:8px;border-radius:50%;",
      "background:#e2571e;animation:__regoro-apuls 1.1s ease-in-out infinite;}",
      "@keyframes __regoro-apuls{0%,100%{opacity:.25}50%{opacity:1}}",
      // Body-Offset, damit der fixe Balken nichts verdeckt
      "body.__regoro-offset{padding-top:var(--regoro-barh,52px);}",

      /**
       * DIE SEITENLEISTE SCHIEBT, SIE ÜBERDECKT NICHT.
       *
       * Vorher lag sie als `position:fixed` über der Website — der Kunde
       * bearbeitete eine Seite, deren rechtes Viertel er nicht sehen konnte,
       * und genau dort steht bei diesen Vorlagen oft der Inhalt, um den es
       * geht. Jetzt bekommt der Body rechts Platz, und die Editor-Leiste endet
       * an derselben Kante.
       *
       * Nur eine Breite an einer Stelle: `--regoro-apanel`. Wer sie ändert,
       * ändert Panel, Body-Abstand und Leiste zugleich — auseinanderlaufen
       * können sie nicht.
       */
      ":root{--regoro-apanel:420px;}",

      /**
       * DIE PANELS BEGINNEN UNTER DER LEISTE, NICHT ÜBER IHR.
       *
       * Sie stand vorher unter dem Panel (z-index 2147483600 gegen …603) und
       * war damit verdeckt — inklusive „Speichern", „Versionen" und dem
       * Schließen-Knopf. Man kam aus dem Chat nur über seinen eigenen Knopf
       * heraus und konnte nicht speichern, ohne ihn zu verlassen.
       *
       * `--regoro-barh` wird GEMESSEN, nicht angenommen: Die Leiste hat
       * `flex-wrap:wrap` und wird auf schmalen Fenstern zweizeilig. Die feste
       * 52 stimmte dort nie — sie stand vorher schon im Body-Abstand und war
       * dort genauso falsch, nur weniger sichtbar.
       */
      "body.__regoro-agent-offen{padding-right:var(--regoro-apanel);}",
      "body.__regoro-agent-offen #__regoro-bar{right:var(--regoro-apanel);}",

      /**
       * AUF DEM HANDY GILT DAS GEGENTEIL: Die Seitenleiste nimmt die ganze
       * Breite — bei 420px neben einer 360px-Seite bliebe von beidem nichts
       * Brauchbares. Sie beginnt aber UNTER der Editor-Leiste (`top:52px`), und
       * der Body bekommt keinen rechten Abstand.
       *
       * Der Grund für die Ausnahme der Leiste: Sie trägt „Speichern",
       * „Versionen" und den Schließen-Knopf. Deckte der Chat sie zu, käme man
       * aus ihm nur noch über seinen eigenen Knopf heraus — und das Gespräch
       * ließe sich nicht speichern, ohne es zu verlassen.
       *
       * Dieselbe Regel für die Versionsliste: Auch sie ist ein Panel und würde
       * sonst auf dem Handy neben einer zu schmalen Seite kleben.
       */
      "@media (max-width:899px){",
      "  body.__regoro-agent-offen{padding-right:0;}",
      "  body.__regoro-agent-offen #__regoro-bar{right:0;}",
      "  #__regoro-agent,#__regoro-versions{flex:1 1 auto;width:auto;max-width:none;",
      "  box-shadow:0 -4px 18px rgba(0,0,0,.28);}",
      "}"
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
    // Nur wenn der Server einen Modellzugang hat. Ohne ihn antworten alle
    // Agenten-Routen mit 404 — ein Knopf, der zuverlässig nichts tut, ist
    // schlechter als gar keiner.
    ui.btnAgent = CFG.ki === true
      ? el("button", { class: "__regoro-btn", type: "button", title: "Der Website in normalen Sätzen sagen, was sich ändern soll" }, ["KI-Assistent"])
      : null;

    ui.status = el("span", { class: "__regoro-status" });
    var spacer = el("span", { class: "__regoro-spacer" });

    var formatBar = buildFormatToolbar();

    bar.appendChild(title);
    if (pageSwitcher) bar.appendChild(pageSwitcher);
    bar.appendChild(ui.btnEdit);
    bar.appendChild(ui.btnSave);
    bar.appendChild(ui.btnDiscard);
    bar.appendChild(ui.btnVersions);
    if (ui.btnAgent) bar.appendChild(ui.btnAgent);
    bar.appendChild(formatBar);
    bar.appendChild(spacer);
    bar.appendChild(ui.status);

    ui.btnEdit.addEventListener("click", toggleEditing);
    ui.btnSave.addEventListener("click", onSave);
    ui.btnDiscard.addEventListener("click", onDiscard);
    ui.btnVersions.addEventListener("click", onVersions);
    if (ui.btnAgent) ui.btnAgent.addEventListener("click", onAgent);

    var shell = el("div", { id: "__regoro-shell" });
    shell.appendChild(bar);
    shell.appendChild(el("div", { id: "__regoro-unten" }));
    document.body.appendChild(shell);
    document.body.classList.add("__regoro-offset");
    messeLeiste(bar);
    // Die Leiste bricht um, wenn das Fenster schmal wird. Die PANELS geht das
    // nichts mehr an — sie sitzen in der Hülle und rutschen von selbst mit.
    // Nur die Website darunter braucht den Wert noch (siehe messeLeiste).
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () { messeLeiste(bar); }).observe(bar);
    } else {
      window.addEventListener("resize", function () { messeLeiste(bar); });
    }
    updateButtons();
  }

  /** Der Platz, in den die Panels gehängt werden — unter der Leiste. */
  function unten() {
    return document.getElementById("__regoro-unten");
  }

  /**
   * Der EINZIGE verbliebene gemessene Wert, und nur noch für die Website.
   *
   * Die Panels brauchen ihn nicht mehr — sie sitzen als Blöcke unter der
   * Leiste, der Browser rechnet das aus. Für den Abstand des fremden `<body>`
   * geht es nicht ohne: Die Leiste liegt über der Seite, und um ihren Inhalt
   * nicht zu verdecken, muss die Seite wissen, wie hoch sie ist.
   *
   * Ganz ohne ginge es nur, indem wir den Inhalt der Kundenseite in einen
   * eigenen Container einwickeln — dann würde der Browser auch das ausrechnen.
   * Das ist bewusst NICHT gemacht: Es ist ein fremdes Dokument, und Regeln wie
   * `body > header` brechen, sobald etwas dazwischen steht.
   *
   * `ResizeObserver` statt `resize`, weil die Leiste auch ohne Fenstergrößen-
   * änderung umbrechen kann — etwa wenn ein Knopf dazukommt.
   */
  function messeLeiste(bar) {
    var h = bar && bar.offsetHeight ? bar.offsetHeight : 52;
    document.documentElement.style.setProperty("--regoro-barh", h + "px");
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
    // Beide Panels liegen am selben Bildschirmrand — offen wäre nur eines
    // sichtbar, und der Kunde klickte ins Unsichtbare.
    closeAgent();
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
    // Wie die KI-Seitenleiste: unter die Leiste, nicht darüber.
    (unten() || document.body).appendChild(panel);
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
  // KI-Seitenleiste
  //
  // Der Lauf gehört der WEBSITE, nicht diesem Browserfenster: Ein Reload oder
  // ein zweiter Tab hängt sich an denselben Lauf, und das Schließen des Panels
  // bricht nichts ab. Abgebrochen wird ausschließlich über den Knopf, der
  // /edit/agent/abort ruft. Deshalb fragt das Öffnen immer zuerst den Zustand
  // ab, statt von „nichts läuft" auszugehen.
  // ---------------------------------------------------------------------------
  /**
   * Merkt sich, ob die KI-Seitenleiste offen war — über den Seitenwechsel hinweg.
   *
   * Der Editor läuft auf jeder Seite der Website neu an; ohne dieses Merkzeichen
   * ist das Panel nach jedem Wechsel über die Seitenauswahl zu. Der Verlauf
   * selbst überlebt längst (er liegt beim Server), aber der Kunde musste die
   * Leiste jedes Mal von Hand wieder aufklappen — und hielt das Gespräch beim
   * ersten Mal für verloren.
   *
   * `sessionStorage` und nicht `localStorage`: Das gilt für DIESEN Tab und
   * diese Sitzung. Wer den Editor morgen neu öffnet, soll eine ruhige Seite
   * sehen und nicht ein Fenster, das er vor Tagen einmal aufgeklappt hat.
   *
   * Alles in try/catch: In einem privaten Fenster oder bei gesperrten
   * Website-Daten wirft schon der Zugriff. Das darf den Editor nicht kosten —
   * dann bleibt die Leiste eben zu.
   */
  var AGENT_MERK = "regoro-agent-offen";
  function merkeAgentOffen(offen) {
    try {
      if (offen) window.sessionStorage.setItem(AGENT_MERK, "1");
      else window.sessionStorage.removeItem(AGENT_MERK);
    } catch (e) { /* egal */ }
  }
  function warAgentOffen() {
    try {
      return window.sessionStorage.getItem(AGENT_MERK) === "1";
    } catch (e) {
      return false;
    }
  }

  function onAgent() {
    if (agentPanel) {
      closeAgent();
      return;
    }
    closeVersions();
    openAgent();
  }

  function closeAgent() {
    // Den Strom zuerst schließen: Eine offene EventSource verbindet sich sonst
    // nach jedem Ende von selbst neu, auch wenn das Panel längst weg ist.
    if (agentQuelle) {
      agentQuelle.close();
      agentQuelle = null;
    }
    if (agentPanel && agentPanel.parentNode) {
      agentPanel.parentNode.removeChild(agentPanel);
    }
    agentPanel = null;
    document.body.classList.remove("__regoro-agent-offen");
    merkeAgentOffen(false);
  }

  function openAgent() {
    var panel = el("div", { id: "__regoro-agent" });

    var head = el("div", { class: "__regoro-ahead" }, [
      el("h2", { text: "KI-Assistent" })
    ]);
    var closeBtn = el("button", {
      class: "__regoro-aclose", text: "\u00d7", type: "button", "aria-label": "Schließen"
    });
    closeBtn.addEventListener("click", closeAgent);
    head.appendChild(closeBtn);

    var quota = el("div", { class: "__regoro-aquota", text: "Kontingent wird geladen…" });
    // aria-live: Der Verlauf wächst asynchron; ohne das bekommt ein Screenreader
    // nichts davon mit.
    var verlauf = el("div", { class: "__regoro-averlauf", role: "log", "aria-live": "polite" });

    var eingabe = el("textarea", {
      class: "__regoro-aeingabe",
      placeholder: "Zum Beispiel: Leg eine Unterseite über Badsanierung an und verlink sie in der Navigation.",
      "aria-label": "Auftrag an den KI-Assistenten"
    });
    var senden = el("button", { class: "__regoro-abtn __regoro-asenden", type: "button", text: "Senden" });
    // Kein Text, sondern ein Symbol — und links vom Senden, weil er zum
    // laufenden Auftrag gehört und nicht zum nächsten.
    var abbrechen = el("button", {
      class: "__regoro-abtn __regoro-astop",
      type: "button",
      title: "Auftrag stoppen",
      "aria-label": "Auftrag stoppen"
    });
    var hinweis = el("div", { class: "__regoro-ahinweis" });

    var form = el("div", { class: "__regoro-aform" }, [
      eingabe,
      el("div", { class: "__regoro-azeile" }, [abbrechen, senden]),
      hinweis
    ]);

    panel.appendChild(head);
    panel.appendChild(quota);
    panel.appendChild(verlauf);
    panel.appendChild(form);
    (unten() || document.body).appendChild(panel);
    agentPanel = panel;
    // Erst JETZT, nicht vorher: Der Body soll nicht Platz freihalten für ein
    // Panel, das wegen eines Fehlers im Aufbau gar nicht erscheint.
    document.body.classList.add("__regoro-agent-offen");
    merkeAgentOffen(true);

    agentGesperrt = false;
    agentGesamt = null;
    ui.agent = {
      quota: quota, verlauf: verlauf, eingabe: eingabe,
      senden: senden, abbrechen: abbrechen, hinweis: hinweis
    };

    senden.addEventListener("click", onAuftragSenden);
    abbrechen.addEventListener("click", onAuftragAbbrechen);
    // Strg/Cmd+Enter schickt ab — Enter allein bleibt ein Zeilenumbruch, weil
    // ein Auftrag oft mehrere Sätze hat.
    eingabe.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onAuftragSenden();
      }
    });

    ladeAgentStatus();
  }

  /**
   * Der Satz, mit dem der Server „es gibt hier nichts zu sehen" ausdrückt.
   * Bewusst wörtlich verglichen: Die Fehlerform ist auf `{grund}` festgelegt,
   * ein zusätzliches Feld zur Unterscheidung gäbe es nicht. Ändert sich der
   * Wortlaut in host.ts, muss er hier mit — sonst zeigt eine frisch geöffnete
   * Leiste eine Fehlermeldung, wo nur nichts passiert ist.
   */
  var KEIN_LAUF = "Kein Lauf aktiv.";

  /**
   * Zustand vom Server holen: Kontingent, und ob gerade schon etwas läuft.
   * `nurKontingent` = nur die Anzeige auffrischen, nicht erneut anhängen
   * (sonst öffnete jeder Abschluss einen zweiten Strom auf sich selbst).
   */
  /**
   * Holt das bisherige Gespräch und stellt es in den Verlauf.
   *
   * DER GRUND IST DER SEITENWECHSEL. Der Editor läuft auf jeder Seite der
   * Website neu an; das Panel-DOM ist dann leer. Lauf und Verlauf hängen aber
   * am Site-Ordner, nicht an der Seite — es IST dasselbe Gespräch. Ohne diesen
   * Aufruf sah der Kunde nach dem Wechsel ein leeres Fenster und hielt sein
   * Gespräch für verloren.
   *
   * Fehler bleiben stumm: Ein nicht ladbarer Verlauf ist ärgerlich, aber kein
   * Grund, die Seitenleiste unbrauchbar zu machen — neue Aufträge gehen weiter.
   */
  function ladeVerlauf() {
    fetch("/edit/agent/verlauf", {
      credentials: "same-origin",
      headers: { "Accept": "application/json" }
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
      if (!agentPanel || !v || !v.nachrichten || !v.nachrichten.length) return;
      for (var i = 0; i < v.nachrichten.length; i++) {
        var n = v.nachrichten[i];
        // `agentNachricht` setzt `textContent` — Kundentext wird nie als HTML
        // eingesetzt. Wer das je auf innerHTML umstellt, muss maskieren.
        agentNachricht(n.text, n.rolle === "kunde" ? "kunde" : "agent");
      }
      agentAnsEnde(true);
    }).catch(function () {});
  }

  function ladeAgentStatus(nurKontingent) {
    fetch("/edit/agent/status", {
      credentials: "same-origin",
      headers: { "Accept": "application/json" }
    }).then(function (res) {
      if (!res.ok) throw new Error("Der KI-Assistent ist auf diesem Server nicht eingerichtet.");
      return res.json();
    }).then(function (st) {
      if (!agentPanel) return;                       // zwischenzeitlich geschlossen
      zeigeKontingent(st && st.kontingent);
      if (nurKontingent) return;
      // Erst den bisherigen Verlauf zeigen, dann anhängen: Sonst stünden neue
      // Ereignisse über alten Nachrichten.
      ladeVerlauf();
      if (st && st.laeuft) {
        // Ein Lauf ist schon unterwegs (Reload, Seitenwechsel, zweiter Tab,
        // anderes Gerät). Anhängen statt einen zweiten zu starten — der zweite
        // bekäme 409.
        //
        // KEINE MELDUNG MEHR DARÜBER. Sie stammte aus der Zeit, als der
        // Seitenwechsel wie ein fremder Zustand aussah („Es läuft bereits ein
        // Auftrag für diese Website. Ich hänge mich an."). Das Gespräch gilt
        // für die ganze Website, nicht für eine Seite — beim Wechsel ist
        // Weiterlaufen der Normalfall und braucht keinen Kommentar.
        verbindeStrom();
      } else {
        // Auch OHNE laufenden Auftrag anhängen: Der Server reicht den zuletzt
        // beendeten Lauf noch einmal aus. Ohne das verlöre der Kunde
        // Zusammenfassung und Dateiliste durch genau den versehentlichen
        // Reload, gegen den das Nachreichen antritt — und sähe bei einem
        // gescheiterten Lauf gar nicht, DASS er gescheitert ist. Er versuchte
        // es dann noch einmal und bezahlte denselben Fehlschlag zweimal.
        verbindeStrom({ nachlese: true });
      }
    }).catch(function (err) {
      if (!agentPanel) return;
      setAgentHinweis(err && err.message ? err.message : "Zustand nicht abrufbar.", true);
      agentGesperrt = true;
      setAgentLaeuft(agentLaeuft);
    });
  }

  function zeigeKontingent(k) {
    if (!agentPanel) return;
    var q = ui.agent.quota;
    if (!k || typeof k.frei !== "number") {
      q.textContent = "Kontingent unbekannt.";
      return;
    }
    if (typeof k.gesamt === "number") agentGesamt = k.gesamt;
    q.classList.toggle("__regoro-aleer", !!k.erschoepft);
    agentGesperrt = !!k.erschoepft;
    setAgentLaeuft(agentLaeuft);   // Sperre sofort auf den Knopf anwenden
    if (k.erschoepft) {
      q.textContent = "Das Monatskontingent ist aufgebraucht. Es setzt sich am Monatsersten zurück.";
      return;
    }
    var gesamt = typeof k.gesamt === "number" ? k.gesamt : agentGesamt;
    q.textContent = gesamt === null
      ? "Noch " + zahl(k.frei) + " Zeichen-Einheiten in diesem Monat."
      : "Noch " + zahl(k.frei) + " von " + zahl(gesamt) + " Zeichen-Einheiten in diesem Monat.";
  }

  function zahl(n) {
    try { return Number(n).toLocaleString("de-DE"); } catch (e) { return String(n); }
  }

  function setAgentHinweis(text, warnend) {
    if (!agentPanel) return;
    ui.agent.hinweis.className = "__regoro-ahinweis" + (warnend ? " __regoro-awarn" : "");
    ui.agent.hinweis.textContent = text || "";
  }

  /**
   * Text vom Agenten anhängen — an die laufende Blase, wenn es eine gibt.
   * Siehe agentTextBlase: Das Modell liefert einzelne Wortstücke.
   */
  /**
   * Ans Ende scrollen — aber NUR, wenn der Leser ohnehin schon unten steht.
   *
   * Vorher stand hier ein unbedingtes `scrollTop = scrollHeight` an drei
   * Stellen. Wer während eines Laufs nach oben scrollte, um nachzulesen, was
   * der Agent vorhin getan hat, wurde beim nächsten Ereignis wieder nach unten
   * gerissen — und ein Lauf sendet viele Ereignisse. Zurücklesen war damit
   * praktisch unmöglich, obwohl der Text die ganze Zeit dastand.
   *
   * Die Toleranz ist nicht null, sondern eine Zeilenhöhe: Ein Leser, der „unten
   * genug" steht, will dem Strom folgen; wer bewusst hochgescrollt hat, nicht.
   */
  function agentAnsEnde(erzwingen) {
    var v = ui.agent && ui.agent.verlauf;
    if (!v) return;
    if (!erzwingen) {
      var abstand = v.scrollHeight - v.scrollTop - v.clientHeight;
      if (abstand > 40) return;
    }
    v.scrollTop = v.scrollHeight;
  }

  function agentText(stueck) {
    if (!agentPanel || !stueck) return;
    if (!agentTextBlase) {
      agentTextBlase = agentNachricht(stueck, "agent");
      return;
    }
    agentTextBlase.textContent += stueck;
    agentAnsEnde(false);
  }

  /** Eine Zeile in den Verlauf hängen und ans Ende scrollen. */
  function agentNachricht(text, art) {
    if (!agentPanel) return null;
    var klasse = "__regoro-anachricht ";
    if (art === "kunde") klasse += "__regoro-avon-kunde";
    else if (art === "fehler") klasse += "__regoro-avon-agent __regoro-afehler";
    else if (art === "fertig") klasse += "__regoro-avon-agent __regoro-afertig";
    else klasse += "__regoro-avon-agent";
    var node = el("div", { class: klasse, text: text });
    ui.agent.verlauf.appendChild(node);
    // Der Kringel gehört ans Ende — sonst steht er nach einer neuen Zeile
    // mittendrin und sieht aus, als gehöre er zur alten.
    if (agentLaeuft) zeigeTut(true);
    // Eine eigene Nachricht des Kunden zieht den Blick immer mit.
    agentAnsEnde(art === "kunde");
    return node;
  }

  function agentWerkzeug(kurz) {
    if (!agentPanel) return;
    // Ein Werkzeug beendet den laufenden Satz — der nächste Text ist ein neuer.
    agentTextBlase = null;
    var node = el("div", { class: "__regoro-awerkzeug" }, [
      el("span", { class: "__regoro-apuls" }),
      el("span", { text: kurz })
    ]);
    ui.agent.verlauf.appendChild(node);
    agentAnsEnde(false);
    if (agentLaeuft) zeigeTut(true);
  }

  function setAgentLaeuft(laeuft) {
    agentLaeuft = laeuft;
    if (!agentPanel) return;
    // `agentGesperrt` überlebt das Ende eines Laufs — ein aufgebrauchtes
    // Kontingent wird nicht dadurch wieder voll, dass ein Strom zu Ende ist.
    ui.agent.senden.disabled = laeuft || agentGesperrt;
    ui.agent.eingabe.disabled = laeuft;
    ui.agent.abbrechen.disabled = !laeuft;
    // Zeigt den Stopp-Knopf und lässt ihn pulsen — er IST die Laufanzeige.
    agentPanel.classList.toggle("__regoro-alaeuft", !!laeuft);
    zeigeTut(laeuft);
    /**
     * DER HINWEIS GEHÖRT ZUM LAUF UND STIRBT MIT IHM.
     *
     * Vorher blieb „Abbruch angefordert…" stehen, nachdem im Verlauf längst
     * „Der Auftrag wurde abgebrochen" stand — zwei Meldungen über dasselbe,
     * eine davon veraltet. Der Verlauf ist die Wahrheit; die Zeile unter dem
     * Feld sagt nur, was JETZT gilt.
     */
    if (!laeuft) setAgentHinweis("");
  }

  /**
   * Der laufende Kringel im Verlauf.
   *
   * Der Stopp-Knopf sagt „es läuft", aber er steht unten am Eingabefeld. Beim
   * Lesen liegt der Blick im Verlauf, und dort vergingen zwischen zwei
   * Werkzeugaufrufen gemessen bis zu anderthalb Minuten ohne jedes Zeichen —
   * lang genug, dass es kaputt aussieht.
   */
  function zeigeTut(an) {
    if (!agentPanel) return;
    var da = ui.agent.verlauf.querySelector(".__regoro-atut");
    if (!an) {
      if (da && da.parentNode) da.parentNode.removeChild(da);
      return;
    }
    if (da) {
      // Immer ans Ende: Nach einem neuen Ereignis stünde er sonst mittendrin.
      ui.agent.verlauf.appendChild(da);
      return;
    }
    var node = el("div", { class: "__regoro-atut", "aria-label": "Der Assistent arbeitet" }, [
      el("i", {}), el("i", {}), el("i", {})
    ]);
    ui.agent.verlauf.appendChild(node);
    agentAnsEnde(false);
  }

  function onAuftragSenden() {
    if (!agentPanel || agentLaeuft) return;
    var auftrag = (ui.agent.eingabe.value || "").trim();
    if (!auftrag) {
      setAgentHinweis("Schreib zuerst, was sich ändern soll.", true);
      return;
    }
    // Ungespeicherte Text-Edits: Der Agent arbeitet auf der Datei auf Platte,
    // nicht auf dem DOM dieses Fensters. Liefe er los, schriebe er die Datei
    // neu — und die Änderungen hier im Browser wären beim nächsten Laden weg,
    // ohne dass jemand es gemerkt hätte. Deshalb ablehnen und den Grund nennen.
    if (isDirty()) {
      setAgentHinweis(
        "Es gibt ungespeicherte Änderungen an dieser Seite. Speichere sie zuerst — sonst " +
        "gingen sie verloren, sobald der Assistent die Datei neu schreibt.", true);
      return;
    }

    setAgentHinweis("");
    agentTextBlase = null;
    agentNachricht(auftrag, "kunde");
    ui.agent.eingabe.value = "";
    setAgentLaeuft(true);

    fetch("/edit/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ auftrag: auftrag })
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        return { status: res.status, ok: res.ok, body: body };
      });
    }).then(function (r) {
      if (!r.ok) {
        // Der Server liefert für jeden Fehlerfall einen deutschen Klartextsatz;
        // 404 hat als einzige keinen Rumpf (die Route existiert dann nicht).
        var grund = r.body && r.body.grund
          ? r.body.grund
          : "Der KI-Assistent ist gerade nicht verfügbar.";
        agentNachricht(grund, "fehler");
        setAgentLaeuft(false);
        ladeAgentStatus(true);             // nur die Kontingentanzeige nachziehen
        return;
      }
      verbindeStrom();
    }).catch(function () {
      agentNachricht("Der Auftrag konnte nicht abgeschickt werden.", "fehler");
      setAgentLaeuft(false);
    });
  }

  function onAuftragAbbrechen() {
    ui.agent.abbrechen.disabled = true;
    fetch("/edit/agent/abort", {
      method: "POST",
      credentials: "same-origin"
    }).catch(function () {
      /* Ist der Abbruch nicht angekommen, endet der Lauf regulär — kein Grund
         zur Panik im Browser. Der Strom meldet ohnehin, was passiert ist. */
    });
    // KEINE Hinweiszeile mehr: Der Knopf hört auf zu pulsen, und der Verlauf
    // meldet den Abbruch, sobald er durch ist. Zwei Meldungen über dasselbe
    // waren genau das Problem — die zweite blieb stehen.
  }

  /**
   * Hängt sich an den Ereignisstrom des laufenden Auftrags.
   *
   * EventSource verbindet sich nach jedem Serverende von selbst neu. Nach
   * `fertig`/`fehler` MUSS deshalb close() folgen — sonst fragt der Browser
   * endlos nach, bekommt jedes Mal „Kein Lauf aktiv." und der Verlauf füllt
   * sich mit Fehlermeldungen.
   */
  function verbindeStrom(opts) {
    // Nachlese = die Leiste wurde gerade geöffnet und es läuft nichts. Dann ist
    // alles, was kommt, die Wiederholung eines beendeten Laufs — und die
    // Antwort „Kein Lauf aktiv." bedeutet schlicht „es gab noch keinen".
    // Die darf NICHT als Fehler im Chatfenster landen: Wer die Leiste zum
    // ersten Mal öffnet, hat nichts falsch gemacht.
    var nachlese = !!(opts && opts.nachlese);
    if (agentQuelle) agentQuelle.close();
    // Im Nachlese-Modus bleibt die Eingabe offen: Es läuft ja nichts, was ein
    // zweiter Auftrag stören könnte.
    if (!nachlese) setAgentLaeuft(true);

    var quelle = new EventSource("/edit/agent/events");
    agentQuelle = quelle;
    var etwasGesehen = false;

    function schliessen() {
      if (agentQuelle === quelle) agentQuelle = null;
      quelle.close();
      setAgentLaeuft(false);
    }

    quelle.addEventListener("text", function (ev) {
      var d = parseEreignis(ev);
      if (d && typeof d.inhalt === "string") { etwasGesehen = true; agentText(d.inhalt); }
    });
    quelle.addEventListener("werkzeug", function (ev) {
      var d = parseEreignis(ev);
      if (d) { etwasGesehen = true; agentWerkzeug(d.kurz || d.name || "arbeitet…"); }
    });
    quelle.addEventListener("tokens", function (ev) {
      if (!agentPanel) return;
      var d = parseEreignis(ev);
      if (!d || typeof d.frei !== "number") return;
      // Durch dieselbe Anzeige wie die Status-Abfrage, nicht an ihr vorbei.
      // Vorher schrieb dieser Zweig direkt in die Zeile: Das Format sprang
      // mitten im Lauf (das „von Y" fiel weg), und eine WÄHREND des Laufs
      // erreichte Erschöpfung färbte die Leiste nicht — sie zog erst nach,
      // wenn der Strom endete. `frei: 0` heißt aufgebraucht; der Server
      // klammert mit Math.max(0, …), negativ wird es also nie.
      zeigeKontingent({ frei: d.frei, gesamt: agentGesamt, erschoepft: d.frei <= 0 });
    });
    quelle.addEventListener("fertig", function (ev) {
      var d = parseEreignis(ev) || {};
      etwasGesehen = true;
      schliessen();
      zeigeFertig(d);      // räumt agentTextBlase selbst auf
    });
    quelle.addEventListener("fehler", function (ev) {
      var d = parseEreignis(ev) || {};
      var grund = d.grund || "Der Auftrag ist gescheitert.";
      schliessen();
      agentTextBlase = null;
      // Der eine Fall, der schweigt: frisch geöffnete Leiste, nie ein Lauf.
      // Ein gescheiterter Lauf wird dagegen sehr wohl nachgereicht — sonst
      // versuchte es der Kunde noch einmal und bezahlte denselben Fehlschlag
      // ein zweites Mal.
      if (nachlese && !etwasGesehen && grund === KEIN_LAUF) return;
      agentNachricht(grund, "fehler");
      ladeAgentStatus(true);
    });
    quelle.onerror = function () {
      // Bricht die Verbindung ab, bevor ein Abschluss kam, versucht EventSource
      // es selbst erneut — das ist gewollt (WLAN-Wackler). Nur wenn der Browser
      // endgültig aufgegeben hat, ist es ein Fehler für den Kunden.
      if (quelle.readyState === 2 /* CLOSED */) {
        schliessen();
        // Im Nachlese-Modus lief nichts, was hätte abreißen können.
        if (nachlese && !etwasGesehen) return;
        setAgentHinweis("Die Verbindung zum Assistenten ist abgerissen. Der Auftrag läuft " +
          "möglicherweise weiter — öffne die Leiste neu, um nachzusehen.", true);
      }
    };
  }

  function parseEreignis(ev) {
    try {
      return JSON.parse(ev.data);
    } catch (e) {
      return null;                            // fremder Prozess, kaputte Zeile
    }
  }

  function zeigeFertig(d) {
    var zus = String(d.zusammenfassung || "Fertig.").trim();
    var dateien = Array.isArray(d.dateien) ? d.dateien : [];
    // KEINE geänderte Datei heißt: Es ist nichts passiert. Das darf nicht wie
    // ein Erfolg aussehen.
    //
    // Im Browser gemessen, an einem Lauf gegen einen toten Modellzugang: Die
    // Leiste meldete grün „Der Auftrag wurde bearbeitet." und „Die Änderung ist
    // live", während die Website byteidentisch blieb und kein Commit entstand.
    // Der Kunde hätte die Seite neu geladen, nichts gefunden und den Editor für
    // kaputt gehalten. Ein misslungener Lauf muss sich anfühlen wie „hat nicht
    // geklappt, nichts passiert" — genau das ist hier die Wahrheit, also wird
    // sie auch gesagt.
    var nichtsGeaendert = dateien.length === 0;
    var node;
    // Der Agent schickt seine Zusammenfassung ERST als text-Ereignisse und
    // danach noch einmal im fertig-Ereignis. Im Browser gemessen: derselbe
    // Absatz stand zweimal untereinander, einmal grau und einmal grün — das
    // sieht aus, als hätte der Assistent gestottert. Deshalb die schon
    // vorhandene Blase weiterverwenden, statt eine zweite anzuhängen.
    var laufend = agentTextBlase ? agentTextBlase.textContent.trim() : "";
    if (laufend && (laufend === zus || laufend.indexOf(zus) !== -1)) {
      node = agentTextBlase;
      node.className = "__regoro-anachricht __regoro-avon-agent" +
        (nichtsGeaendert ? "" : " __regoro-afertig");
    } else {
      node = agentNachricht(zus, nichtsGeaendert ? "agent" : "fertig");
    }
    agentTextBlase = null;
    if (!node) return;

    if (nichtsGeaendert) {
      node.appendChild(el("div", {
        class: "__regoro-ahinweis __regoro-awarn",
        text: "An der Website wurde nichts geändert."
      }));
      setAgentHinweis("Es wurde nichts geändert. Versuch es noch einmal, gern mit einem " +
        "genaueren Auftrag.");
      ladeAgentStatus(true);
      return;
    }

    var liste = el("ul", { class: "__regoro-adateien" });
    dateien.forEach(function (name) {
      liste.appendChild(el("li", { text: String(name) }));
    });
    node.appendChild(liste);
    // Die Seite im Browser ist jetzt veraltet: Der Agent hat die Datei auf
    // Platte geändert, dieses DOM kennt den alten Stand. Ein Reload ist kein
    // Vorschlag, sondern nötig — sonst überschriebe ein späteres Speichern
    // die Arbeit des Agenten (oder scheiterte am fileHash mit 409).
    var neu = el("button", { class: "__regoro-abtn", type: "button", text: "Seite neu laden" });
    neu.addEventListener("click", forceReload);
    node.appendChild(el("div", { class: "__regoro-azeile" }, [neu]));
    setAgentHinweis("Die Änderung ist live. Über „Versionen“ lässt sie sich zurücknehmen.");
    ladeAgentStatus(true);
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
  // fixe Toolbar, das Versionen-Panel, die KI-Seitenleiste und die aufgelegte
  // Bild-„ersetzen"-Badge. Fehlte #__regoro-agent hier, fräße der Navigations-Guard
  // im Edit-Modus jeden Klick auf „Auftrag geben" — die Leiste wäre stumm.
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
      "#__regoro-bar, #__regoro-versions, #__regoro-agent, .__regoro-img-badge"
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
    // War sie vor dem Seitenwechsel offen, geht sie wieder auf. `ui.btnAgent`
    // fehlt, wenn der Server keinen Modellzugang hat — dann gibt es nichts zu
    // öffnen, und das Merkzeichen bleibt folgenlos liegen.
    if (ui.btnAgent && warAgentOffen()) openAgent();
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
