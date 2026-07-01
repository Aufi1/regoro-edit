/**
 * Contract A/B/v3-B — Kern: Zurückschreiben von Edits + Bild-src + Datei-Hash.
 *
 * v2: Text-Node-Adressierung (nodeValue). v3-B: befehlsbasierte Formatierung
 * (bold/italic/link), Löschen + Einfügen — der SERVER erzeugt jede Struktur,
 * der Client liefert nie Markup. Einzige user-Eingabe in Markup = href → via
 * isValidHref validiert. linkedom escaped Textinhalt automatisch.
 *
 * Resolve-then-mutate: ALLE Ziel-Knoten/-Elemente werden VOR jeder Mutation
 * aufgelöst, damit strukturändernde delete/insert die anderen idx nicht verrutschen.
 */
import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import {
  enumerateEditableTextNodes,
  enumerateImages,
  enumerateDeletable,
  enumerateBrs,
  isValidHref,
  normalizeColor,
} from "./contract.ts";

/** Run-Op (Lauf): Text + Formatierung. Mit start/end = Bereichs-Op (v4). */
export interface RunOp {
  idx: number;
  text?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  link?: string | null;
  color?: string | null;
  /** Bereichs-Op (v4): Zeichen-Offsets im Lauf-Text. Ohne = ganzer Lauf. */
  start?: number;
  end?: number;
  /** v5: <br> am Zeichen-Offset einfügen (Enter). */
  brAt?: number;
}

/** Struktur-Op: Block löschen / Absatz einfügen / <br> löschen. */
export interface StructOp {
  op: "delete" | "insert" | "deleteBr";
  delIdx?: number;
  afterDelIdx?: number | null;
  brIdx?: number;
}

export type Edit = RunOp | StructOp;

export interface ApplyResult {
  html: string;
  applied: number;
}

/** Stabiler SHA-256-Hex über den Datei-Inhalt (für Optimistic-Locking). */
export function fileSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// --- linkedom-Node-Hilfstypen (schmal gehalten) ----------------------------
interface LNode {
  nodeType: number;
  tagName?: string;
  nodeName?: string;
  nodeValue: string | null;
  textContent: string | null;
  parentNode: LNode | null;
  childNodes: ArrayLike<LNode>;
  firstChild: LNode | null;
  nextSibling: LNode | null;
  ownerDocument: LDocument;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  appendChild(n: LNode): LNode;
  insertBefore(n: LNode, ref: LNode | null): LNode;
  replaceChild(n: LNode, old: LNode): LNode;
  removeChild(n: LNode): LNode;
  splitText?(offset: number): LNode;
  normalize?(): void;
}
interface LDocument {
  createElement(tag: string): LNode;
  createTextNode?(text: string): LNode;
}

/** True, wenn die Run-Op einen Teilbereich adressiert (start/end gesetzt). */
function isRangeOp(op: RunOp): boolean {
  return typeof op.start === "number" || typeof op.end === "number";
}

/** True für eine <br>-Einfüge-Op (brAt gesetzt). */
function isBrOp(op: RunOp): boolean {
  return typeof op.brAt === "number";
}

/** Offset-tragende Run-Ops (Range oder brAt) müssen descending angewandt werden. */
function isOffsetOp(op: RunOp): boolean {
  return isRangeOp(op) || isBrOp(op);
}

/** Der für die descending-Sortierung relevante Offset einer Offset-Op. */
function offsetOf(op: RunOp): number {
  if (isBrOp(op)) return Number.isFinite(op.brAt) ? (op.brAt as number) : 0;
  return Number.isFinite(op.start) ? (op.start as number) : 0;
}

const ELEMENT_NODE = 1;

function tagOf(node: LNode): string {
  return (node.tagName ?? node.nodeName ?? "").toUpperCase();
}

function isOp(e: Edit): e is StructOp {
  return typeof (e as StructOp).op === "string";
}

/**
 * Findet den nächsten Vorfahren mit einem der Tags (innerhalb des Laufs).
 * Liefert null, wenn keiner existiert.
 */
function ancestorWithTag(node: LNode, tags: Set<string>): LNode | null {
  let cur: LNode | null = node.parentNode;
  while (cur && cur.nodeType === ELEMENT_NODE) {
    if (tags.has(tagOf(cur))) return cur;
    cur = cur.parentNode;
  }
  return null;
}

const STRONG_TAGS = new Set(["STRONG", "B"]);
const EM_TAGS = new Set(["EM", "I"]);
const U_TAGS = new Set(["U"]);
const A_TAGS = new Set(["A"]);

/** Inline-Format-Hüllen, die beim Wort-Löschen leer entfernt werden dürfen. */
const INLINE_WRAPPER_TAGS = new Set(["STRONG", "B", "EM", "I", "U", "A", "SPAN"]);

/** True, wenn der Knoten keinen sichtbaren Inhalt mehr hat (Text leer, nur leere Inline-Kinder). */
function isEmptyInline(node: LNode): boolean {
  return (node.textContent ?? "").trim() === "";
}

/**
 * Entfernt einen leeren Text-Node und danach rekursiv die leer gewordenen
 * Inline-Hüllen (<strong>/<em>/<u>/<a>/<span>) nach oben — NIE ein Block-Element.
 * Geschwister bleiben unangetastet.
 */
function removeEmptyRun(textNode: LNode): boolean {
  const parent = textNode.parentNode;
  if (!parent) return false;
  parent.removeChild(textNode);

  // Leer gewordene Inline-Hüllen nach oben aufräumen, solange sie kein
  // sichtbares Geschwister-Material mehr enthalten und Inline-Wrapper sind.
  let cur: LNode | null = parent;
  while (
    cur &&
    cur.nodeType === ELEMENT_NODE &&
    INLINE_WRAPPER_TAGS.has(tagOf(cur)) &&
    isEmptyInline(cur)
  ) {
    const up: LNode | null = cur.parentNode;
    if (!up) break;
    up.removeChild(cur);
    cur = up;
  }
  return true;
}

/**
 * Findet den nächsten <span>-Vorfahren mit einer `color:`-Deklaration im
 * style-Attribut (für „Farbe entfernen"). Liefert null, wenn keiner existiert.
 */
function ancestorColorSpan(node: LNode): LNode | null {
  let cur: LNode | null = node.parentNode;
  while (cur && cur.nodeType === ELEMENT_NODE) {
    if (tagOf(cur) === "SPAN" && cur.getAttribute) {
      const style = cur.getAttribute("style") ?? "";
      if (/(?:^|;)\s*color\s*:/i.test(style)) return cur;
    }
    cur = cur.parentNode;
  }
  return null;
}

/** Wrappt den Text-Node in ein neues Element <tag> (an Ort und Stelle). */
function wrapNode(node: LNode, tag: string): LNode {
  const doc = node.ownerDocument;
  const wrapper = doc.createElement(tag);
  const parent = node.parentNode;
  if (!parent) return node;
  parent.replaceChild(wrapper, node);
  wrapper.appendChild(node);
  return wrapper;
}

/** Ersetzt ein Wrapper-Element durch seine Kindknoten (unwrap) + normalize. */
function unwrapElement(wrapper: LNode): void {
  const parent = wrapper.parentNode;
  if (!parent) return;
  // Kinder in Reihenfolge vor den Wrapper schieben.
  while (wrapper.firstChild) {
    parent.insertBefore(wrapper.firstChild, wrapper);
  }
  parent.removeChild(wrapper);
  parent.normalize?.(); // benachbarte Text-Nodes zusammenführen
}

/** Nächster Vorfahre von `node`, dessen Tag `tags` matcht (oder null). */
function closestAncestor(node: LNode, tags: Set<string>): LNode | null {
  let cur: LNode | null = node.parentNode;
  while (cur && cur.nodeType === ELEMENT_NODE) {
    if (tags.has(tagOf(cur))) return cur;
    cur = cur.parentNode;
  }
  return null;
}

/** Nächster <span style="color:…">-Vorfahre von `node` (oder null). */
function closestColorSpan(node: LNode): LNode | null {
  return ancestorColorSpan(node);
}

/**
 * Löst `target` (Text-Node im Bereich) aus seinem nächsten Format-Wrapper `W`.
 * Voll-Abdeckung (W enthält nur target-Inhalt) → W auspacken. Teilbereich → W
 * aufspalten: Inhalt VOR target bleibt in W, target kommt plain dahinter, Inhalt
 * NACH target wandert in einen Klon von W. Liefert true, wenn ein Wrapper traf.
 */
function unwrapRange(target: LNode, findWrapper: (n: LNode) => LNode | null): boolean {
  const wrapper = findWrapper(target);
  if (!wrapper) return false;
  const parent = wrapper.parentNode;
  if (!parent) return false;

  // Den direkten Kind-Zweig von wrapper bestimmen, der target enthält.
  let branch: LNode = target;
  while (branch.parentNode && branch.parentNode !== wrapper) {
    branch = branch.parentNode;
  }
  if (branch.parentNode !== wrapper) return false;

  // Kinder von wrapper in [before][branch][after] aufteilen.
  const before: LNode[] = [];
  const after: LNode[] = [];
  let seen = false;
  const kids = Array.from(wrapper.childNodes as ArrayLike<LNode>);
  for (const child of kids) {
    if (child === branch) {
      seen = true;
      continue;
    }
    (seen ? after : before).push(child);
  }

  const ref = wrapper.nextSibling;
  const doc = wrapper.ownerDocument as unknown as LDocument & { createElement(t: string): LNode };

  if (before.length === 0 && after.length === 0) {
    // Voll-Abdeckung: Wrapper ganz auspacken.
    unwrapElement(wrapper);
    return true;
  }

  // Teilbereich: vorderer Teil bleibt in wrapper; branch kommt plain dahinter;
  // hinterer Teil in einen frischen Wrapper gleichen Tags.
  // 1. before bleibt in wrapper (nichts zu tun — sie stehen bereits drin, branch
  //    + after werden entfernt). Falls before leer ist, wrapper später entfernen.
  // 2. branch aus wrapper lösen → direkt hinter wrapper einsetzen.
  wrapper.removeChild(branch);
  parent.insertBefore(branch, ref);
  // 3. after in neuen Wrapper, hinter branch.
  if (after.length > 0) {
    const tail = doc.createElement(tagOf(wrapper).toLowerCase());
    // Style (Farbe) am Klon erhalten.
    const style = wrapper.getAttribute?.("style");
    if (style) tail.setAttribute?.("style", style);
    for (const child of after) {
      wrapper.removeChild(child);
      tail.appendChild(child);
    }
    parent.insertBefore(tail, ref);
  }
  // 4. Falls before leer war, ist wrapper jetzt leer → entfernen.
  if (before.length === 0) {
    parent.removeChild(wrapper);
  }
  parent.normalize?.();
  return true;
}

/**
 * Wendet eine Liste von Ops an. Run-Ops adressieren Text-Nodes (idx),
 * Struktur-Ops löschbare Blöcke (delIdx/afterDelIdx). Out-of-bounds/ungültige
 * Ops werden ignoriert (applied nicht hochgezählt). Liefert serialisiertes HTML.
 */
export function applyEdits(html: string, edits: Edit[]): ApplyResult {
  const { document } = parseHTML(html);

  // --- Resolve-then-mutate: alle Indizes VOR jeder Mutation auflösen. ---
  const textNodes = enumerateEditableTextNodes(document) as unknown as LNode[];
  const deletables = enumerateDeletable(document) as unknown as LNode[];
  const brs = enumerateBrs(document) as unknown as LNode[];

  // Offset-tragende Run-Ops (Range + brAt) im selben Lauf in ABSTEIGENDER
  // Offset-Reihenfolge anwenden, damit ein Split die Offsets der noch folgenden
  // Ops nicht verschiebt. Reihenfolge anderer Ops (Whole-Run, delete, insert)
  // bleibt erhalten.
  const ordered = stableOrderForOffsets(edits);

  let applied = 0;

  for (const edit of ordered) {
    if (isOp(edit)) {
      if (edit.op === "delete") {
        applied += applyDelete(deletables, edit) ? 1 : 0;
      } else if (edit.op === "insert") {
        applied += applyInsert(document as unknown as LDocument, deletables, edit) ? 1 : 0;
      } else if (edit.op === "deleteBr") {
        applied += applyDeleteBr(brs, edit) ? 1 : 0;
      }
    } else if (isBrOp(edit)) {
      applied += applyBrOp(document as unknown as LDocument, textNodes, edit) ? 1 : 0;
    } else if (isRangeOp(edit)) {
      applied += applyRangeOp(textNodes, edit) ? 1 : 0;
    } else {
      applied += applyRunOp(textNodes, edit) ? 1 : 0;
    }
  }

  return { html: document.toString(), applied };
}

/**
 * Sortiert NUR die Offset-tragenden Run-Ops (Range + brAt) desselben Laufs
 * absteigend nach Offset (stabil für alles andere). So verschieben Splits keine
 * späteren Offsets im selben Lauf.
 */
function stableOrderForOffsets(edits: Edit[]): Edit[] {
  const byIdx = new Map<number, RunOp[]>();
  for (const e of edits) {
    if (!isOp(e) && isOffsetOp(e)) {
      const list = byIdx.get(e.idx) ?? [];
      list.push(e);
      byIdx.set(e.idx, list);
    }
  }
  // Innerhalb jedes idx absteigend nach Offset ordnen (stabil bei Gleichstand).
  for (const list of byIdx.values()) {
    list.sort((a, b) => offsetOf(b) - offsetOf(a));
  }
  // Neue Sequenz: an der Position der ERSTEN Offset-Op eines idx die geordnete
  // Gruppe einsetzen, weitere Vorkommen überspringen; alles andere unverändert.
  const out: Edit[] = [];
  const consumed = new Set<number>();
  for (const e of edits) {
    if (!isOp(e) && isOffsetOp(e)) {
      if (!consumed.has(e.idx)) {
        consumed.add(e.idx);
        for (const item of byIdx.get(e.idx)!) out.push(item);
      }
    } else {
      out.push(e);
    }
  }
  return out;
}

/** Run-Op: Text setzen + bold/italic/link wrap/unwrap. Liefert true, wenn etwas wirkte. */
function applyRunOp(textNodes: LNode[], op: RunOp): boolean {
  const { idx } = op;
  if (!Number.isInteger(idx) || idx < 0 || idx >= textNodes.length) return false;
  const node = textNodes[idx]!;
  if (!node.parentNode) return false;

  let did = false;

  // 1. Text setzen (linkedom escaped automatisch). Leerer/whitespace-only Text
  //    → Lauf entfernen + leer gewordene Inline-Hüllen aufräumen (kein Block).
  if (typeof op.text === "string") {
    if (op.text.trim() === "") {
      // Wort-Löschen: Text-Node + leere Inline-Hüllen weg, dann fertig (Format-
      // Ops auf einen entfernten Knoten sind sinnlos).
      return removeEmptyRun(node);
    }
    node.nodeValue = op.text;
    did = true;
  }

  // 2. Link: string → wrappen (nur wenn valide), null/"" → entlinken.
  if (op.link !== undefined) {
    const existingLink = ancestorWithTag(node, A_TAGS);
    if (op.link === null || op.link === "") {
      if (existingLink) {
        unwrapElement(existingLink);
        did = true;
      }
      // kein Link vorhanden + Entlinken → nichts zu tun (zählt nicht als applied
      // außer es geschah schon etwas anderes)
    } else if (isValidHref(op.link)) {
      if (existingLink && existingLink.setAttribute) {
        existingLink.setAttribute("href", op.link);
      } else {
        const a = wrapNode(node, "a");
        a.setAttribute?.("href", op.link);
      }
      did = true;
    } else {
      // Ungültiger href → Op verwerfen. Wenn NUR die Link-Op gewollt war,
      // bleibt did=false → applied wird nicht hochgezählt.
    }
  }

  // 3. Bold.
  if (op.bold !== undefined) {
    const existing = ancestorWithTag(node, STRONG_TAGS);
    if (op.bold) {
      if (!existing) {
        wrapNode(node, "strong");
        did = true;
      }
    } else if (existing) {
      unwrapElement(existing);
      did = true;
    }
  }

  // 4. Italic.
  if (op.italic !== undefined) {
    const existing = ancestorWithTag(node, EM_TAGS);
    if (op.italic) {
      if (!existing) {
        wrapNode(node, "em");
        did = true;
      }
    } else if (existing) {
      unwrapElement(existing);
      did = true;
    }
  }

  // 4b. Underline (<u>) — analog bold/italic.
  if (op.underline !== undefined) {
    const existing = ancestorWithTag(node, U_TAGS);
    if (op.underline) {
      if (!existing) {
        wrapNode(node, "u");
        did = true;
      }
    } else if (existing) {
      unwrapElement(existing);
      did = true;
    }
  }

  // 5. Whole-Run-color: ganzen Lauf in <span style="color:…"> wrappen (gültige
  //    Farbe) bzw. null/"" → nächsten color-<span>-Vorfahr entfernen (analog link:null).
  if (op.color !== undefined) {
    if (op.color === null || op.color === "") {
      const existing = ancestorColorSpan(node);
      if (existing) {
        unwrapElement(existing);
        did = true;
      }
      // kein Farb-span vorhanden → no-op.
    } else {
      const norm = normalizeColor(op.color);
      if (norm !== null) {
        const span = wrapNode(node, "span");
        span.setAttribute?.("style", `color:${norm}`);
        did = true;
      }
      // ungültige Farbe → verworfen (did bleibt wie gehabt)
    }
  }

  return did;
}

/**
 * Range-Op: spaltet den Lauf-Text-Node an start/end (geklemmt) und wrappt den
 * mittleren Teil server-erzeugt (bold→<strong>, italic→<em>,
 * color→<span style="color:…">, verschachtelt bei Kombination). start>=end →
 * no-op. Ungültige Farbe → color-Teil verworfen (kein span).
 */
function applyRangeOp(textNodes: LNode[], op: RunOp): boolean {
  const { idx } = op;
  if (!Number.isInteger(idx) || idx < 0 || idx >= textNodes.length) return false;
  const node = textNodes[idx]!;
  const parent = node.parentNode;
  if (!parent) return false;

  const text = node.nodeValue ?? "";
  const len = text.length;
  // Offsets auf endliche Integer normalisieren (NaN/Inf/Floats → Default/Trunc),
  // dann auf [0, len] klemmen. So entsteht nie ein leerer Wrapper.
  let start = Number.isFinite(op.start) ? Math.trunc(op.start as number) : 0;
  let end = Number.isFinite(op.end) ? Math.trunc(op.end as number) : len;
  start = Math.max(0, Math.min(start, len));
  end = Math.max(0, Math.min(end, len));
  if (start >= end) return false; // no-op

  // Truthy = wrappen (wie v4). Falsy = aus dem Bereich entformatieren (v7).
  const wantBold = op.bold === true;
  const wantItalic = op.italic === true;
  const wantUnderline = op.underline === true;
  let normColor: string | null = null;
  if (op.color !== undefined && op.color !== null && op.color !== "") {
    normColor = normalizeColor(op.color); // ungültig → null → verworfen
  }
  const wantColor = normColor !== null;

  const dropBold = op.bold === false;
  const dropItalic = op.italic === false;
  const dropUnderline = op.underline === false;
  const dropColor = op.color === null || op.color === "";

  const anyWrap = wantBold || wantItalic || wantUnderline || wantColor;
  const anyUnwrap = dropBold || dropItalic || dropUnderline || dropColor;
  if (!anyWrap && !anyUnwrap) return false;

  // Mittleren Text-Node isolieren: erst bei start, dann (im hinteren Teil) bei
  // (end-start) spalten → genau der Bereich [start,end) als eigener Text-Node.
  const middle = splitRange(node, start, end);
  if (!middle) return false;

  let did = false;

  // --- Entformatieren (falsy): Bereich aus dem jeweiligen Wrapper herauslösen. ---
  if (dropColor) {
    if (unwrapRange(middle, closestColorSpan)) did = true;
  }
  if (dropUnderline) {
    if (unwrapRange(middle, (n) => closestAncestor(n, U_TAGS))) did = true;
  }
  if (dropItalic) {
    if (unwrapRange(middle, (n) => closestAncestor(n, EM_TAGS))) did = true;
  }
  if (dropBold) {
    if (unwrapRange(middle, (n) => closestAncestor(n, STRONG_TAGS))) did = true;
  }

  // --- Formatieren (truthy): verschachtelt wrappen (span(color) ⊂ u ⊂ em ⊂ strong). ---
  if (anyWrap) {
    let current = middle;
    if (wantColor) {
      const span = wrapNode(current, "span");
      span.setAttribute?.("style", `color:${normColor}`);
      current = span;
    }
    if (wantUnderline) current = wrapNode(current, "u");
    if (wantItalic) current = wrapNode(current, "em");
    if (wantBold) current = wrapNode(current, "strong");
    did = true;
  }

  return did;
}

/**
 * brAt-Op: fügt ein server-erzeugtes <br> am (geklemmten, endlichen) Offset im
 * Lauf-Text ein. NaN/Inf → applied 0 (kein Artefakt). Text-Node wird an offset
 * in [pre][post] geteilt, <br> dazwischen. brAt:0 → <br> vor dem Text,
 * brAt:len → <br> nach dem Text.
 */
function applyBrOp(doc: LDocument, textNodes: LNode[], op: RunOp): boolean {
  const { idx } = op;
  if (!Number.isInteger(idx) || idx < 0 || idx >= textNodes.length) return false;
  if (!Number.isFinite(op.brAt)) return false; // Finite-Guard
  const node = textNodes[idx]!;
  const parent = node.parentNode;
  if (!parent || !doc.createTextNode) return false;

  const text = node.nodeValue ?? "";
  const len = text.length;
  let offset = Math.trunc(op.brAt as number);
  offset = Math.max(0, Math.min(offset, len));

  const br = doc.createElement("br");
  const pre = text.slice(0, offset);
  const post = text.slice(offset);
  const ref = node.nextSibling;

  // node behält pre; <br> und post-Text kommen direkt danach (Dokumentreihenfolge).
  node.nodeValue = pre;
  parent.insertBefore(br, ref);
  if (post) parent.insertBefore(doc.createTextNode(post), ref);
  // Sonderfall pre="" (brAt:0): node ist jetzt leer → kosmetisch entfernen,
  // damit kein leerer Text-Node vor dem <br> bleibt.
  if (pre === "") parent.removeChild(node);

  return true;
}

/**
 * Spaltet `node` so, dass der Bereich [start,end] ein eigener Text-Node wird,
 * und liefert diesen mittleren Knoten. Nutzt Text.splitText falls vorhanden,
 * sonst manuelle Drei-Teilung.
 */
function splitRange(node: LNode, start: number, end: number): LNode | null {
  const doc = node.ownerDocument;
  const full = node.nodeValue ?? "";

  if (typeof node.splitText === "function") {
    // node enthält danach [0,start); splitText liefert den Rest ab start.
    const afterStart = start > 0 ? node.splitText(start) : node;
    // afterStart enthält [start,len). Bei (end-start) spalten → Rest ab end ab.
    const midLen = end - start;
    if (typeof afterStart.splitText === "function" &&
        midLen < (afterStart.nodeValue ?? "").length) {
      afterStart.splitText(midLen);
    }
    return afterStart; // afterStart enthält jetzt genau [start,end)
  }

  // Manueller Fallback: Text-Node zu [pre][mid][post] in Dokumentreihenfolge.
  if (!doc.createTextNode) return null;
  const parent = node.parentNode;
  if (!parent) return null;
  const pre = full.slice(0, start);
  const mid = full.slice(start, end);
  const post = full.slice(end);
  const midNode = doc.createTextNode(mid);
  const ref = node.nextSibling; // Einfügepunkt HINTER dem ursprünglichen Knoten.
  if (pre) {
    // node behält pre, mid + post kommen direkt danach.
    node.nodeValue = pre;
    parent.insertBefore(midNode, ref);
    if (post) parent.insertBefore(doc.createTextNode(post), ref);
  } else {
    // Kein pre: node wird zum mid; post kommt danach.
    parent.insertBefore(midNode, node);
    if (post) parent.insertBefore(doc.createTextNode(post), ref);
    parent.removeChild(node);
  }
  return midNode;
}

/** Delete-Op: entfernt das adressierte löschbare Block-Element. */
function applyDelete(deletables: LNode[], op: StructOp): boolean {
  const di = op.delIdx;
  if (!Number.isInteger(di as number) || (di as number) < 0 || (di as number) >= deletables.length) {
    return false;
  }
  const el = deletables[di as number]!;
  const parent = el.parentNode;
  if (!parent) return false;
  parent.removeChild(el);
  return true;
}

/** deleteBr-Op: entfernt das adressierte <br> und führt angrenzende Text-Nodes zusammen. */
function applyDeleteBr(brs: LNode[], op: StructOp): boolean {
  const bi = op.brIdx;
  if (!Number.isInteger(bi as number) || (bi as number) < 0 || (bi as number) >= brs.length) {
    return false;
  }
  const br = brs[bi as number]!;
  const parent = br.parentNode;
  if (!parent) return false;
  parent.removeChild(br);
  parent.normalize?.(); // benachbarte Text-Nodes zusammenführen
  return true;
}

/** Insert-Op: fügt <p>Neuer Absatz</p> nach dem Block (oder am Body-Ende) ein. */
function applyInsert(document: LNode["ownerDocument"], deletables: LNode[], op: StructOp): boolean {
  const doc = document as unknown as LDocument & { querySelector(s: string): LNode | null };
  const p = doc.createElement("p");
  p.appendChild(makeText(doc, "Neuer Absatz"));

  const after = op.afterDelIdx;
  if (after === null || after === undefined) {
    const body = doc.querySelector("body");
    if (!body) return false;
    body.appendChild(p);
    return true;
  }
  if (!Number.isInteger(after) || after < 0 || after >= deletables.length) return false;
  const ref = deletables[after]!;
  const parent = ref.parentNode;
  if (!parent) return false;
  // Nach ref einfügen = vor dem nächsten Geschwister (ref.nextSibling).
  const next = (ref as unknown as { nextSibling: LNode | null }).nextSibling;
  parent.insertBefore(p, next);
  return true;
}

/** Erzeugt einen Text-Node über ein Hilfs-<span> (linkedom hat kein direktes API hier nötig). */
function makeText(doc: LDocument & { createTextNode?(t: string): LNode }, text: string): LNode {
  if (doc.createTextNode) return doc.createTextNode(text);
  // Fallback: über ein Element + textContent (sollte nie nötig sein).
  const span = doc.createElement("span");
  span.nodeValue = text;
  return span;
}

/**
 * Setzt den src des <img> mit Index imgIdx (Dokumentreihenfolge). Out-of-bounds
 * → applied 0, Inhalt unverändert. Andere Attribute (alt, …) bleiben erhalten.
 */
export function setImageSrc(html: string, imgIdx: number, newSrc: string): ApplyResult {
  const { document } = parseHTML(html);
  const imgs = enumerateImages(document);
  let applied = 0;
  if (Number.isInteger(imgIdx) && imgIdx >= 0 && imgIdx < imgs.length) {
    imgs[imgIdx]!.setAttribute("src", newSrc);
    applied = 1;
  }
  return { html: document.toString(), applied };
}
