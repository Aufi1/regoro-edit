/**
 * Contract A — Kern: rendert die Editier-Ansicht (kein Disk-Write).
 *
 * Injiziert `data-edit-idx` NUR in die ausgelieferte Antwort plus das Overlay-
 * Script und window.__REGORO_EDIT__. Die Datei auf Platte bleibt unangetastet.
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

/** Stellt einer rewritebaren relativen URL ein `/` voran; sonst unverändert. */
function rootAbsolute(url: string): string {
  return isRewritableUrl(url) ? "/" + url.trim() : url;
}

/**
 * Schreibt ein srcset um: kommagetrennte Kandidaten `<url> [deskriptor]`
 * (Deskriptor optional, z.B. `1x` / `200w`). Nur die URL jedes Kandidaten wird
 * root-absolut gemacht; der Deskriptor bleibt erhalten.
 */
function rewriteSrcset(srcset: string): string {
  return srcset
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (trimmed === "") return trimmed;
      const parts = trimmed.split(/\s+/);
      const url = parts[0]!;
      const descriptor = parts.slice(1).join(" ");
      const rewritten = rootAbsolute(url);
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
function rewriteAssetUrls(document: {
  querySelectorAll(sel: string): ArrayLike<{
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
  }>;
}): void {
  // src-Attribute auf Asset-Elementen (NICHT <a>).
  const srcEls = document.querySelectorAll("img[src], source[src], script[src]");
  for (let i = 0; i < srcEls.length; i++) {
    const el = srcEls[i]!;
    const v = el.getAttribute("src");
    if (v != null) el.setAttribute("src", rootAbsolute(v));
  }
  // <link href> (stylesheet, icon, preload …) — bewusst NICHT <a href>.
  const linkEls = document.querySelectorAll("link[href]");
  for (let i = 0; i < linkEls.length; i++) {
    const el = linkEls[i]!;
    const v = el.getAttribute("href");
    if (v != null) el.setAttribute("href", rootAbsolute(v));
  }
  // srcset auf <img>/<source>.
  const srcsetEls = document.querySelectorAll("img[srcset], source[srcset]");
  for (let i = 0; i < srcsetEls.length; i++) {
    const el = srcsetEls[i]!;
    const v = el.getAttribute("srcset");
    if (v != null) el.setAttribute("srcset", rewriteSrcset(v));
  }
}

/**
 * Read-only-Versions-Vorschau: parst HTML, macht NUR die relativen Asset-URLs
 * root-absolut (damit CSS/Bilder unter /edit/version/<commit> laden) und
 * serialisiert. KEINE data-edit-idx-Spans, KEIN Overlay/Config — reine Ansicht.
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

  // Relative Asset-URLs root-absolut machen, damit /edit/<subpage> gestylt lädt.
  // (Reine Response-Transformation; beeinflusst die idx-Nummerierung nicht und
  // ändert die Plattendatei nicht — Save parst weiterhin das Original von Platte.)
  rewriteAssetUrls(document as Parameters<typeof rewriteAssetUrls>[0]);

  // `<` escapen, damit kein `</script>`-Breakout aus dem inline-Script möglich
  // ist (linkedom escaped script-textContent NICHT). Eliminiert die Klasse dauerhaft.
  const config = JSON.stringify({
    pagePath: opts.pagePath,
    fileHash: opts.fileHash,
    pages: opts.pages ?? [],
    page: opts.page ?? "",
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
