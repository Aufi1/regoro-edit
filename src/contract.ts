/**
 * Contract A/B/v3-B — Kern: deterministische Enumeration + Format-/Link-/Lösch-Logik.
 *
 * v2-Modell: Text-Node-Adressierung. Jeder sichtbare Text-Node im <body> ist
 * adressierbar — auch in Mixed-Content (<p>Text <a>x</a>.</p> → 3 Nodes). Single
 * source of truth: Serve (renderEditView) UND Apply (applyEdits) laufen exakt
 * diesen Walk auf der UNVERÄNDERTEN Datei → identische Nummerierung.
 *
 * v3-B: runFormatState (Format-Zustand eines Laufs), enumerateDeletable
 * (löschbare Block-Elemente), isValidHref (Schema-Whitelist).
 *
 * Infra-agnostisch: kennt weder Host, Auth noch regoro.de. Wiederverwendbar.
 */

/** Container, deren Textinhalt NICHT editierbar ist (Code/Meta, kein Fließtext). */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE"]);

// DOM-Node-Typkonstanten (Standard; linkedom hält sich daran).
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Minimaler Text-Node, wie linkedom ihn liefert (für nodeValue-Edits in apply.ts). */
export interface EditableTextNode {
  nodeType: number;
  textContent: string | null;
  nodeValue: string | null;
}

interface DomNode {
  nodeType: number;
  nodeName?: string;
  tagName?: string;
  textContent: string | null;
  nodeValue: string | null;
  childNodes: ArrayLike<DomNode>;
}

interface WalkableDocument {
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): ArrayLike<unknown>;
  body?: DomNode | null;
}

function tagOf(node: DomNode): string {
  return (node.tagName ?? node.nodeName ?? "").toUpperCase();
}

function walk<T>(node: DomNode, out: T[]): void {
  const children = node.childNodes;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child.nodeType === TEXT_NODE) {
      if ((child.nodeValue ?? "").trim() !== "") out.push(child as unknown as T);
    } else if (child.nodeType === ELEMENT_NODE) {
      if (SKIP_TAGS.has(tagOf(child))) continue;
      walk(child, out);
    }
  }
}

/**
 * Alle editierbaren Text-Nodes in Dokumentreihenfolge: innerhalb <body>, nicht
 * unter script/style/noscript/template/head, mit nicht-leerem Text
 * (textContent.trim() !== ""). Array-Index == data-edit-idx.
 */
export function enumerateEditableTextNodes<T extends EditableTextNode>(
  document: WalkableDocument,
): T[] {
  const body = document.body ?? (document.querySelector("body") as DomNode | null);
  if (!body) return [];
  // Benachbarte Text-Nodes zusammenführen: linkedom zerlegt beim Parsen Text mit
  // dekodierten Entities (z.B. `&lt;` → `<`) in mehrere Fragmente. normalize()
  // macht daraus wieder einen logischen Text-Node → deterministische idx.
  (body as DomNode & { normalize?: () => void }).normalize?.();
  const out: T[] = [];
  walk(body, out);
  return out;
}

/** Minimale Element-Sicht für Bild-Adressierung. */
export interface EditableImage {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

/** Alle <img>-Elemente in Dokumentreihenfolge. Array-Index == data-edit-img-idx. */
export function enumerateImages<T extends EditableImage>(document: WalkableDocument): T[] {
  return Array.from(document.querySelectorAll("img") as ArrayLike<T>);
}

// ===========================================================================
// v4: Farb-Validierung + Kanonisierung (isValidColor / normalizeColor)
// ===========================================================================

const HEX3 = /^#([0-9a-f]{3})$/i;
const HEX4 = /^#([0-9a-f]{4})$/i;
const HEX6 = /^#([0-9a-f]{6})$/i;
const HEX8 = /^#([0-9a-f]{8})$/i;
// rgb()/rgba(): nur Ziffern, Kommas, optionaler Dezimal-Alpha. Kein url()/expression(),
// keine Semikolons, kein <"> — die strikte Form schließt CSS-Injection aus.
const RGB_RE = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;
const RGBA_RE = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d*\.?\d+)\s*\)$/i;

function inByteRange(...vals: number[]): boolean {
  return vals.every((v) => Number.isFinite(v) && v >= 0 && v <= 255);
}

function toHex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/**
 * Kanonischer lowercase-#rrggbb (Alpha wird verworfen — nur RGB im style) bzw.
 * null bei ungültiger Farbe. Akzeptiert dieselben Formen wie isValidColor.
 */
export function normalizeColor(color: string): string | null {
  if (typeof color !== "string") return null;
  const c = color.trim();
  if (c === "") return null;

  let m: RegExpMatchArray | null;
  if ((m = c.match(HEX3))) {
    const h = m[1]!.toLowerCase();
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  }
  if ((m = c.match(HEX4))) {
    const h = m[1]!.toLowerCase(); // #rgba → RGB-Anteil (Alpha verworfen)
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  }
  if ((m = c.match(HEX6))) {
    return `#${m[1]!.toLowerCase()}`;
  }
  if ((m = c.match(HEX8))) {
    return `#${m[1]!.slice(0, 6).toLowerCase()}`; // Alpha verworfen
  }
  if ((m = c.match(RGB_RE))) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!inByteRange(r, g, b)) return null;
    return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
  }
  if ((m = c.match(RGBA_RE))) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const a = Number(m[4]);
    if (!inByteRange(r, g, b)) return null;
    if (!Number.isFinite(a) || a < 0 || a > 1) return null; // Alpha 0–1
    return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
  }
  return null;
}

/**
 * True, wenn `color` ein sicherer Farbwert ist: Hex (#rgb/#rrggbb/#rgba/#rrggbbaa,
 * case-insensitiv) oder rgb()/rgba() mit numerischen Komponenten (0–255, Alpha
 * 0–1). False für alles andere — CSS-Injection (`red; background:url(x)`),
 * `url(…)`, `expression(…)`, Trailing-Semikolon, `"`/`<`-Breakout, Einheiten,
 * out-of-range, leer.
 */
export function isValidColor(color: string): boolean {
  return normalizeColor(color) !== null;
}

// ===========================================================================
// v3-B: Format-Zustand eines Laufs (runFormatState)
// ===========================================================================

/** Knoten mit Eltern-Referenz + Attribut-Zugriff (zum Hochlaufen der Vorfahren). */
interface AncestralNode {
  parentNode?: AncestralNode | null;
  nodeType?: number;
  tagName?: string;
  nodeName?: string;
  getAttribute?: (name: string) => string | null;
}

export interface FormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  href: string | null;
  color: string | null;
}

/** Liest `color:<wert>` aus einem style-Attribut und normalisiert ihn (oder null). */
function colorFromStyle(style: string | null): string | null {
  if (!style) return null;
  const m = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
  if (!m) return null;
  return normalizeColor(m[1]!.trim());
}

/**
 * Format-Zustand eines Text-Laufs: läuft die Vorfahren hoch und prüft auf
 * <strong>/<b> (bold), <em>/<i> (italic), <a href> (href) und den nächsten
 * <span style="color:…">-Vorfahren (color, als normalisierter Hex). Erster
 * gefundener Treffer gewinnt je Feld.
 */
export function runFormatState(node: AncestralNode): FormatState {
  let bold = false;
  let italic = false;
  let underline = false;
  let href: string | null = null;
  let color: string | null = null;
  let cur: AncestralNode | null | undefined = node.parentNode;
  while (cur && cur.nodeType === ELEMENT_NODE) {
    const tag = (cur.tagName ?? cur.nodeName ?? "").toUpperCase();
    if (tag === "STRONG" || tag === "B") bold = true;
    else if (tag === "EM" || tag === "I") italic = true;
    else if (tag === "U") underline = true;
    else if (tag === "A" && href === null && cur.getAttribute) {
      href = cur.getAttribute("href");
    }
    if (color === null && cur.getAttribute) {
      color = colorFromStyle(cur.getAttribute("style"));
    }
    cur = cur.parentNode;
  }
  return { bold, italic, underline, href, color };
}

// ===========================================================================
// v3-B: löschbare Block-Elemente (enumerateDeletable)
// ===========================================================================

/** Block-Container, die als Ganzes löschbar/Einfüge-Anker sind. NIE Landmarks. */
const DELETABLE_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6",
  "UL", "OL", "LI", "DL", "DT", "DD",
  "BLOCKQUOTE", "PRE", "FIGURE", "FIGCAPTION",
  "TABLE", "THEAD", "TBODY", "TR", "TD", "TH",
  "SECTION", "ARTICLE", "ASIDE", "NAV", "HEADER", "FOOTER",
  "DIV", "DETAILS", "SUMMARY", "HR",
]);

/** Landmarks/Struktur-Wurzeln, die NIE löschbar sind. */
const NEVER_DELETABLE = new Set(["HTML", "HEAD", "BODY", "MAIN"]);

/** Minimale Element-Sicht für Lösch-/Einfüge-Adressierung. */
export interface DeletableElement {
  tagName: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
}

/**
 * Löschbare Block-Elemente in Dokumentreihenfolge (innerhalb <body>).
 * Array-Index == data-edit-del-idx. Landmarks (html/head/body/main) nie dabei.
 */
export function enumerateDeletable<T extends DeletableElement>(document: WalkableDocument): T[] {
  const body = document.body ?? (document.querySelector("body") as DomNode | null);
  if (!body) return [];
  const out: T[] = [];
  walkDeletable(body, out);
  return out;
}

function walkDeletable<T>(node: DomNode, out: T[]): void {
  const children = node.childNodes;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child.nodeType !== ELEMENT_NODE) continue;
    const tag = tagOf(child);
    if (SKIP_TAGS.has(tag)) continue;
    if (DELETABLE_TAGS.has(tag) && !NEVER_DELETABLE.has(tag)) {
      out.push(child as unknown as T);
    }
    walkDeletable(child, out); // verschachtelte Blöcke ebenfalls erfassen
  }
}

/** Minimale Element-Sicht für <br>-Adressierung. */
export interface BrElement {
  tagName: string;
  setAttribute(name: string, value: string): void;
}

/**
 * Alle <br>-Elemente in Dokumentreihenfolge (innerhalb <body>, nicht unter
 * script/style/noscript/template/head). Array-Index == data-edit-br-idx.
 */
export function enumerateBrs<T extends BrElement>(document: WalkableDocument): T[] {
  const body = document.body ?? (document.querySelector("body") as DomNode | null);
  if (!body) return [];
  const out: T[] = [];
  walkBrs(body, out);
  return out;
}

function walkBrs<T>(node: DomNode, out: T[]): void {
  const children = node.childNodes;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child.nodeType !== ELEMENT_NODE) continue;
    const tag = tagOf(child);
    if (SKIP_TAGS.has(tag)) continue;
    if (tag === "BR") out.push(child as unknown as T);
    walkBrs(child, out);
  }
}

// ===========================================================================
// v3-B: href-Schema-Whitelist (isValidHref)
// ===========================================================================

/** Dekodiert einen einzelnen HTML-Numeric-Entity-Codepoint; null bei ungültig. */
function decodeCodePoint(raw: number): string | null {
  if (!Number.isFinite(raw) || raw < 0 || raw > 0x10ffff) return null;
  // Surrogate-Hälften sind keine gültigen Codepoints.
  if (raw >= 0xd800 && raw <= 0xdfff) return null;
  try {
    return String.fromCodePoint(raw);
  } catch {
    return null;
  }
}

/**
 * True für sichere href-Werte: http(s):, mailto:, schemalos/seiten-relativ,
 * #anker. Blockt javascript:/data:/vbscript:/file:, sonstige Schemata UND
 * protokoll-relative `//host`-URLs (Phishing/Open-Redirect).
 *
 * C1-Härtung: HTML-Entities (numerisch dezimal/hex + benannte Kern-Entities)
 * werden VOR der Schema-Prüfung dekodiert — sonst umgeht z.B.
 * `&#106;avascript:` die Whitelist und der Browser dekodiert beim Reparse zu
 * `javascript:` → Stored-XSS. Danach Steuerzeichen/Whitespace entfernen.
 */
export function isValidHref(href: string): boolean {
  if (typeof href !== "string") return false;

  const decoded = href
    // Hex-Numeric: &#x6a; / &#x6A
    .replace(/&#x([0-9a-f]+);?/gi, (m, h: string) => decodeCodePoint(parseInt(h, 16)) ?? m)
    // Dezimal-Numeric: &#106; / &#0000106
    .replace(/&#(\d+);?/g, (m, d: string) => decodeCodePoint(parseInt(d, 10)) ?? m)
    // Benannte Kern-Entities, die für Schema-Bypass missbraucht werden können.
    .replace(/&(amp|colon|tab|newline|NewLine);/gi, (m) => {
      const map: Record<string, string> = {
        "&amp;": "&", "&colon;": ":", "&tab;": "\t", "&newline;": "\n",
      };
      return map[m.toLowerCase()] ?? m;
    });

  // Steuerzeichen + Whitespace (0x00-0x20) entfernen → robust gegen
  // "java\tscript:"-Tricks und führenden Whitespace.
  const stripped = decoded.replace(/[\x00-\x20]/g, "");
  if (stripped === "") return false;
  // L2: Backslashes auf "/" normalisieren — manche Browser behandeln `\` wie `/`,
  // sonst umginge `/\evil.com` (oder `\\`, `\/`) die protokoll-relativ-Sperre.
  const cleaned = stripped.replace(/\\/g, "/");

  // Schema = Buchstabe, dann [a-z0-9+.-]*, dann ":". Fehlt das → relativ/anker.
  const schemeMatch = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) {
    // L1+L2: protokoll-relative URLs (//host, auch via Backslash) ablehnen;
    // seiten-relativ + #anker bleiben erlaubt.
    return !cleaned.startsWith("//");
  }
  const scheme = schemeMatch[1]!.toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto";
}
