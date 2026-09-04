/**
 * Contract A — Kern: rendert die Editier-Ansicht (kein Disk-Write).
 *
 * Injiziert `data-edit-idx` NUR in die ausgelieferte Antwort plus das Overlay-
 * Script und window.__REGORO_EDIT__. Die Datei auf Platte bleibt unangetastet.
 *
 * **Und sie schreibt die Asset-URLs um** — in der Editier-Ansicht auf
 * `opts.assetBasis` (`/edit-vorschau`), nicht auf `/`. Das ist keine
 * Kosmetik: Ohne den Präfix holt der Browser CSS und Bilder aus der
 * VERÖFFENTLICHTEN Website, in Produktion sogar direkt von Caddy, ohne dass
 * dieser Prozess je gefragt wird — und der Kunde begutachtet neues HTML über
 * altem Stylesheet. `renderVersionPreview` verzichtet bewusst darauf
 * (Begründung dort).
 */
import { parseHTML } from "linkedom";
import {
  enumerateEditableTextNodes,
  enumerateImages,
  enumerateDeletable,
  enumerateBrs,
} from "./contract.ts";

export interface RenderOpts {
  pagePath: string;
  fileHash: string;
  scriptUrl: string;
  /** Editierbare Seiten-Basenames (Page-Whitelist) für den Seiten-Umschalter. */
  pages?: string[];
  /** Basename der aktuell editierten Seite (z.B. "datenschutz.html"). */
  page?: string;
  /**
   * Ist der betreiberweite Modellzugang eingerichtet? Nur dann baut das
   * Overlay die KI-Seitenleiste überhaupt. Vorgabe false: Wer diese Option
   * vergisst, bekommt keine Leiste — nicht eine, die ins Leere greift.
   */
  ki?: boolean;
  /**
   * Wohin die root-absoluten Asset-URLs dieser Ansicht zeigen — ohne
   * Schrägstrich am Ende, z.B. `/edit-vorschau` (Contract C11).
   *
   * **Fehlt sie, bleibt es beim bisherigen `/`**, und das ist für die
   * Versions-Vorschau auch richtig. Für die EDITIER-Ansicht ist es falsch: Dort
   * landeten die Anfragen im öffentlichen Zweig und lieferten das zuletzt
   * VERÖFFENTLICHTE Stylesheet unter neuem HTML. Wer diese Option beim
   * Aufrufen vergisst, sieht das nicht am Fehler, sondern am falschen Aussehen
   * — deshalb steht der Grund hier und nicht nur im Contract.
   */
  assetBasis?: string;
  /** URL-Präfix dieser Website: "" in Produktion, "/p/<slug>" in Staging. */
  basis?: string;
  /** Staging-Betrieb: kein Veröffentlichen. */
  staging?: boolean;
  /**
   * Der Zustand aus `GET /edit/zustand`, damit die Leiste beim ersten Bild
   * schon weiß, ob etwas offen ist.
   *
   * Auf JEDER Antwort, auch ohne Modellzugang: Der Veröffentlichen-Knopf und
   * der unveröffentlichte Stand hängen nicht an der KI (Contract C3).
   */
  zustand?: unknown;
}

/** Schmale Sicht auf einen Text-Node mit Eltern-Referenz (zum Ersetzen). */
interface TextNodeLike {
  nodeValue: string | null;
  textContent: string | null;
  parentNode: { replaceChild(newNode: object, oldNode: object): unknown } | null;
}

/**
 * True, wenn eine URL relativ ist und root-absolut umgeschrieben werden soll.
 * Unverändert bleiben: absolute Pfade (`/…`), protokoll-relativ (`//…`),
 * `http(s)://`, `data:`/`mailto:`/sonstige Schemata, Anchor (`#…`), leer.
 */
function isRewritableUrl(url: string): boolean {
  const u = url.trim();
  if (u === "") return false;
  if (u.startsWith("/")) return false; // schon root-absolut oder protokoll-relativ
  if (u.startsWith("#")) return false; // reiner Anchor
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return false; // http:, https:, data:, mailto: …
  return true;
}

/**
 * Stellt einer Asset-URL die Basis voran; sonst unverändert.
 *
 * `basis` ist "" (dann entsteht wie bisher `/styles.css`) oder ein Präfix ohne
 * Schrägstrich am Ende (dann `/edit-vorschau/styles.css`).
 *
 * **Auch eine SCHON root-absolute URL bekommt die Basis** — das ist der zweite
 * Weg in dieselbe Falle, und er war zunächst offen. Gemessen an einer Seite, die
 * ihre Dateien so einbindet, wie eine gebaute Fabrik-Seite es oft tut:
 *
 *     <link rel="stylesheet" href="/styles.css">
 *     → geliefert wurde `/styles.css`, und dahinter lag `body{color:LIVE}`
 *
 * Der Kunde begutachtete also wieder neues HTML über dem VERÖFFENTLICHTEN
 * Stylesheet, obwohl der Vorschau-Präfix längst existierte — nur griff er
 * ausgerechnet bei den Seiten nicht, die keine relativen Pfade benutzen. Wer
 * diese Zeile entfernt, macht genau diese Seiten wieder blind.
 *
 * **Protokoll-relativ (`//host/…`) bleibt unangetastet**: Das ist eine fremde
 * Herkunft, keine Datei dieser Website — ihr einen lokalen Präfix voranzustellen
 * ergäbe eine URL, die es nirgends gibt.
 */
function rootAbsolute(url: string, basis: string): string {
  const u = url.trim();
  if (isRewritableUrl(u)) return basis + "/" + u;
  if (basis !== "" && u.startsWith("/") && !u.startsWith("//")) return basis + u;
  return url;
}

/**
 * Schreibt ein srcset um: kommagetrennte Kandidaten `<url> [deskriptor]`
 * (Deskriptor optional, z.B. `1x` / `200w`). Nur die URL jedes Kandidaten wird
 * root-absolut gemacht; der Deskriptor bleibt erhalten.
 */
function rewriteSrcset(srcset: string, basis: string): string {
  return srcset
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (trimmed === "") return trimmed;
      const parts = trimmed.split(/\s+/);
      const url = parts[0]!;
      const descriptor = parts.slice(1).join(" ");
      const rewritten = rootAbsolute(url, basis);
      return descriptor ? `${rewritten} ${descriptor}` : rewritten;
    })
    .filter((c) => c !== "")
    .join(", ");
}

/**
 * Macht relative Asset-URLs root-absolut, damit die Edit-Ansicht unabhängig von
 * der `/edit/<page>`-Tiefe lädt. NUR Asset-Attribute — `<a href>` (Navigation)
 * bleibt unangetastet. Reine Response-Transformation; die Plattendatei ändert sich nicht.
 */
function rewriteAssetUrls(
  document: {
    querySelectorAll(sel: string): ArrayLike<{
      getAttribute(name: string): string | null;
      setAttribute(name: string, value: string): void;
    }>;
  },
  basis = "",
): void {
  // src-Attribute auf Asset-Elementen (NICHT <a>).
  const srcEls = document.querySelectorAll("img[src], source[src], script[src]");
  for (let i = 0; i < srcEls.length; i++) {
    const el = srcEls[i]!;
    const v = el.getAttribute("src");
    if (v != null) el.setAttribute("src", rootAbsolute(v, basis));
  }
  // <link href> (stylesheet, icon, preload …) — bewusst NICHT <a href>.
  const linkEls = document.querySelectorAll("link[href]");
  for (let i = 0; i < linkEls.length; i++) {
    const el = linkEls[i]!;
    const v = el.getAttribute("href");
    if (v != null) el.setAttribute("href", rootAbsolute(v, basis));
  }
  // srcset auf <img>/<source>.
  const srcsetEls = document.querySelectorAll("img[srcset], source[srcset]");
  for (let i = 0; i < srcsetEls.length; i++) {
    const el = srcsetEls[i]!;
    const v = el.getAttribute("srcset");
    if (v != null) el.setAttribute("srcset", rewriteSrcset(v, basis));
  }
}

/**
 * Read-only-Versions-Vorschau: parst HTML, macht NUR die relativen Asset-URLs
 * root-absolut (damit CSS/Bilder unter /edit/version/<commit> laden) und
 * serialisiert. KEINE data-edit-idx-Spans, KEIN Overlay/Config — reine Ansicht.
 *
 * **Bewusst OHNE `assetBasis`, anders als die Editier-Ansicht.** Hier steht eine
 * alte Fassung einer Seite; ihr die HEUTIGEN Entwurfs-Dateien unterzulegen wäre
 * genauso willkürlich wie die veröffentlichten — die damals passenden gibt es
 * ohne einen zweiten Checkout gar nicht. Bei einer read-only-Ansicht ist
 * unverändertes Verhalten die konservative Wahl. Das ist keine Inkonsistenz zu
 * C11, sondern die Stelle, an der C11 nichts zu entscheiden hat.
 */
export function renderVersionPreview(html: string): string {
  const { document } = parseHTML(html);
  rewriteAssetUrls(document as Parameters<typeof rewriteAssetUrls>[0]);
  return document.toString();
}

/**
 * Parst HTML, wrappt jeden editierbaren Text-Node in <span data-edit-idx="N">,
 * markiert jedes <img> mit data-edit-img-idx, macht Asset-URLs root-absolut und
 * hängt vor </body> Overlay- + Config-Script an. Reine Response-Transformation
 * (kein Disk-Write); die idx vergibt der Walk auf dem Original.
 */
export function renderEditView(html: string, opts: RenderOpts): string {
  const { document } = parseHTML(html);

  // Löschbare Block-Elemente markieren (response-only). VOR dem Text-Node-Wrap,
  // damit die del-idx-Nummerierung exakt dem apply.ts-Walk auf dem Original
  // entspricht (Span-Wrapping fügt nur <span> ein, die nicht löschbar sind).
  enumerateDeletable(document).forEach((el, i) => {
    el.setAttribute("data-edit-del-idx", String(i));
  });

  // <br> durchnummerieren (response-only, für deleteBr). VOR dem Text-Wrap, damit
  // die br-idx-Nummerierung exakt dem apply.ts-Walk auf dem Original entspricht.
  enumerateBrs(document).forEach((br, i) => {
    br.setAttribute("data-edit-br-idx", String(i));
  });

  // Text-Nodes ZUERST einsammeln (Original-Reihenfolge), DANN wrappen — das
  // spätere Ersetzen ändert den Baum, die Referenzen + Reihenfolge bleiben gültig.
  const textNodes = enumerateEditableTextNodes(document) as unknown as TextNodeLike[];
  textNodes.forEach((node, i) => {
    const span = document.createElement("span");
    span.setAttribute("data-edit-idx", String(i));
    span.textContent = node.nodeValue ?? node.textContent ?? "";
    node.parentNode?.replaceChild(span, node as unknown as object);
  });

  // Bilder durchnummerieren (response-only).
  enumerateImages(document).forEach((img, i) => {
    img.setAttribute("data-edit-img-idx", String(i));
  });

  /**
   * Relative Asset-URLs root-absolut machen, damit /edit/<subpage> gestylt lädt
   * — und zwar auf `assetBasis`, nicht auf `/`.
   *
   * Das ist die Stelle, an der die Vorschau ehrlich wird: Unter `/` holte der
   * Browser CSS und Bilder aus der VERÖFFENTLICHTEN Website (in Produktion
   * sogar direkt von Caddy, ohne dass dieser Prozess je gefragt wird), während
   * das HTML darüber aus dem Entwurf kommt. Ändert der Agent ein Stylesheet,
   * begutachtete der Kunde damit eine Mischung, die es nirgends gibt.
   *
   * Reine Response-Transformation; beeinflusst die idx-Nummerierung nicht und
   * ändert die Plattendatei nicht — Save parst weiterhin das Original.
   */
  rewriteAssetUrls(document as Parameters<typeof rewriteAssetUrls>[0], opts.assetBasis ?? "");

  // `<` escapen, damit kein `</script>`-Breakout aus dem inline-Script möglich
  // ist (linkedom escaped script-textContent NICHT). Eliminiert die Klasse dauerhaft.
  const config = JSON.stringify({
    pagePath: opts.pagePath,
    fileHash: opts.fileHash,
    pages: opts.pages ?? [],
    page: opts.page ?? "",
    ki: opts.ki === true,
    // Alle absoluten Pfade des Overlays entstehen aus dieser Basis. "" ist
    // Produktion und damit der Normalfall; "/p/<slug>" ist Staging.
    basis: opts.basis ?? "",
    staging: opts.staging === true,
    // `null` heißt „diese Antwort weiß es nicht" — das Overlay holt dann
    // `GET /edit/zustand` nach. Ein leeres Objekt wäre die schlechtere Vorgabe:
    // Es sähe aus wie „nichts offen" und blendete den Veröffentlichen-Knopf aus,
    // obwohl Änderungen anstehen.
    zustand: opts.zustand ?? null,
  }).replace(/</g, "\\u003c");
  const overlayScript = document.createElement("script");
  overlayScript.setAttribute("src", opts.scriptUrl);
  const configScript = document.createElement("script");
  configScript.textContent = `window.__REGORO_EDIT__ = ${config};`;

  const body = document.querySelector("body");
  if (body) {
    body.appendChild(configScript);
    body.appendChild(overlayScript);
  } else {
    document.documentElement.appendChild(configScript);
    document.documentElement.appendChild(overlayScript);
  }

  return document.toString();
}
