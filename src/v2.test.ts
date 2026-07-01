/**
 * v2 Red — neue Contracts: Text-Node-Adressierung (Feature A) + Bild-Upload (Feature B).
 *
 * Diese Tests sind in Phase "Red" geschrieben: die referenzierten Funktionen/Routen
 * existieren teils noch nicht (enumerateEditableTextNodes, enumerateImages,
 * setImageSrc, POST /edit/upload) bzw. renderEditView/applyEdits müssen auf das
 * Text-Node-Modell umgestellt werden. Erwartet: rot, bis die Implementierung folgt.
 *
 * Auth-Env VOR den Host/Auth-Imports setzen (dynamische Imports im Body).
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { parseHTML } from "linkedom";
import {
  mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, existsSync, readdirSync, symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PASSWORD = "testpw";
const TEST_SECRET = "testsecret-aaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_AUTH = { hash: await (await import("./auth.ts")).hashPassword(TEST_PASSWORD), secret: TEST_SECRET };

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");
const PAGE_WHITELIST = ["index.html", "impressum.html", "datenschutz.html", "agb.html"];
const tmpRoots: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// --- gültige Magic-Byte-Header für Bild-Formate (für Upload-Tests) ---------
// Minimal, aber mit ECHTER Signatur, damit ein Magic-Byte-Sniff sie erkennt.
function pngBytes(): Uint8Array {
  // PNG-Signatur + ein (unvollständiger, aber signatur-korrekter) IHDR-Anfang.
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const rest = new Array(64).fill(0x00);
  return new Uint8Array([...sig, ...rest]);
}
function jpegBytes(): Uint8Array {
  // JPEG SOI + APP0 "JFIF".
  const sig = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00];
  const rest = new Array(32).fill(0x00);
  return new Uint8Array([...sig, ...rest, 0xff, 0xd9]);
}
function gifBytes(): Uint8Array {
  // "GIF89a"
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...new Array(32).fill(0)]);
}
function webpBytes(): Uint8Array {
  // RIFF<4 byte size>WEBP — Bytes 0-3 "RIFF", 8-11 "WEBP".
  const riff = [0x52, 0x49, 0x46, 0x46]; // RIFF
  const size = [0x20, 0x00, 0x00, 0x00]; // beliebige Größe
  const webp = [0x57, 0x45, 0x42, 0x50]; // WEBP
  return new Uint8Array([...riff, ...size, ...webp, ...new Array(32).fill(0)]);
}
/** Polyglot: gültige PNG-Signatur + angehängtes HTML/Script (XSS-Vektor-Probe). */
function pngPolyglotBytes(): Uint8Array {
  const png = pngBytes();
  const trailer = new TextEncoder().encode("<script>alert('xss')</script><html>evil</html>");
  return new Uint8Array([...png, ...trailer]);
}
function fakeImageTextBytes(): Uint8Array {
  // Plaintext, der KEINE Bild-Signatur trägt (Magic-Byte-Sniff muss das ablehnen,
  // selbst wenn Dateiname/Content-Type "image/png" behaupten).
  return new TextEncoder().encode("This is not an image, just text.\n");
}

// ===========================================================================
// Feature A — Text-Node-Adressierung (Kern)
// ===========================================================================
describe("contract.ts — enumerateEditableTextNodes (Feature A)", () => {
  test("Determinismus: zweimal parsen → identische Anzahl + Werte", async () => {
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const html = readFileSync(join(REAL_SITE, "index.html"), "utf8");
    const a = enumerateEditableTextNodes(parseHTML(html).document).map((n) => n.textContent);
    const b = enumerateEditableTextNodes(parseHTML(html).document).map((n) => n.textContent);
    expect(a.length).toBe(b.length);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  test("Mixed-Content: <p>Mehr dazu <a>hier</a>.</p> → 3 Text-Nodes", async () => {
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const { document } = parseHTML(
      "<!doctype html><html><body><p>Mehr dazu <a href='#'>hier</a>.</p></body></html>",
    );
    const nodes = enumerateEditableTextNodes(document);
    const texts = nodes.map((n) => n.textContent);
    expect(texts).toEqual(["Mehr dazu ", "hier", "."]);
  });

  test("reine <p>Text</p> → genau 1 Text-Node", async () => {
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const { document } = parseHTML("<!doctype html><html><body><p>Nur Text</p></body></html>");
    const nodes = enumerateEditableTextNodes(document);
    expect(nodes.length).toBe(1);
    expect(nodes[0]!.textContent).toBe("Nur Text");
  });

  test("whitespace-only Text-Nodes werden ausgeschlossen", async () => {
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const { document } = parseHTML(
      "<!doctype html><html><body>\n  <div>\n   </div>\n  <p>echt</p>\n</body></html>",
    );
    const nodes = enumerateEditableTextNodes(document);
    const texts = nodes.map((n) => n.textContent);
    expect(texts).toEqual(["echt"]);
  });

  test("Text in <script>/<style>/<noscript>/<template> wird ausgeschlossen", async () => {
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const { document } = parseHTML(
      "<!doctype html><html><head><style>.x{color:red}</style></head><body>" +
        "<script>var a=1;</script>" +
        "<noscript>kein JS</noscript>" +
        "<template><p>tpl</p></template>" +
        "<p>sichtbar</p>" +
        "</body></html>",
    );
    const texts = enumerateEditableTextNodes(document).map((n) => n.textContent);
    expect(texts).toContain("sichtbar");
    expect(texts).not.toContain("var a=1;");
    expect(texts.join("|")).not.toContain(".x{color:red}");
    expect(texts).not.toContain("kein JS");
    expect(texts).not.toContain("tpl");
  });

  test("Text aus <head> (außerhalb body) wird ausgeschlossen, <title> nicht editierbar", async () => {
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const { document } = parseHTML(
      "<!doctype html><html><head><title>Seitentitel</title></head><body><p>body-text</p></body></html>",
    );
    const texts = enumerateEditableTextNodes(document).map((n) => n.textContent);
    expect(texts).toContain("body-text");
    expect(texts).not.toContain("Seitentitel");
  });
});

describe("serve.ts — renderEditView wrappt Text-Nodes (Feature A)", () => {
  const opts = { pagePath: "site/index.html", fileHash: "deadbeef", scriptUrl: "/edit-assets/overlay.js" };

  test("Output wrappt Text-Nodes in <span data-edit-idx=N>, fortlaufend ab 0", async () => {
    const { renderEditView } = await import("./serve.ts");
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const html = readFileSync(join(REAL_SITE, "index.html"), "utf8");
    const n = enumerateEditableTextNodes(parseHTML(html).document).length;

    const out = renderEditView(html, opts);
    expect(out).toContain('<span data-edit-idx="0"');
    const idxs = [...out.matchAll(/data-edit-idx="(\d+)"/g)].map((m) => Number(m[1]));
    expect(idxs.length).toBe(n);
    expect(idxs[0]).toBe(0);
    expect(idxs[idxs.length - 1]).toBe(n - 1);
  });

  test("sichtbarer Text + Markup (<a>) bleiben erhalten", async () => {
    const { renderEditView } = await import("./serve.ts");
    const out = renderEditView(
      "<!doctype html><html><body><p>Mehr dazu <a href='#'>hier</a>.</p></body></html>",
      opts,
    );
    // Das <a>-Element bleibt; nur die Text-Nodes werden zusätzlich gewrappt.
    const { document } = parseHTML(out);
    expect(document.querySelectorAll("a").length).toBe(1);
    expect(document.querySelector("a")!.textContent).toBe("hier");
    // Gesamttext (Spans rausgerechnet) unverändert lesbar.
    expect(document.querySelector("p")!.textContent).toBe("Mehr dazu hier.");
  });

  test("Overlay-Script + window.__REGORO_EDIT__ weiterhin injiziert", async () => {
    const { renderEditView } = await import("./serve.ts");
    const out = renderEditView("<!doctype html><html><body><p>hi</p></body></html>", opts);
    expect(out).toContain(opts.scriptUrl);
    expect(out).toContain("window.__REGORO_EDIT__");
    expect(out).toContain(opts.pagePath);
  });
});

describe("apply.ts — applyEdits per Text-Node-idx (Feature A)", () => {
  const MIXED =
    "<!doctype html><html><body><p>Mehr dazu <a href='#'>hier</a>.</p></body></html>";

  test("ändert genau den Ziel-Text-Node, Geschwister-<a> + Struktur identisch", async () => {
    const { applyEdits } = await import("./apply.ts");
    const { enumerateEditableTextNodes } = await import("./contract.ts");

    // idx 0 = "Mehr dazu ", idx 1 = "hier", idx 2 = "."
    const { html: out, applied } = applyEdits(MIXED, [{ idx: 0, text: "Lies mehr " }]);
    expect(applied).toBe(1);

    const { document } = parseHTML(out);
    // <a> unverändert
    expect(document.querySelector("a")!.textContent).toBe("hier");
    expect(document.querySelectorAll("a").length).toBe(1);
    // Text-Nodes neu: erster geändert, Rest gleich
    const texts = enumerateEditableTextNodes(document).map((n) => n.textContent);
    expect(texts).toEqual(["Lies mehr ", "hier", "."]);
  });

  test("Mixed-Content: Link-Text ändern lässt umgebende Text-Nodes unangetastet", async () => {
    const { applyEdits } = await import("./apply.ts");
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const { html: out } = applyEdits(MIXED, [{ idx: 1, text: "dort" }]);
    const texts = enumerateEditableTextNodes(parseHTML(out).document).map((n) => n.textContent);
    expect(texts).toEqual(["Mehr dazu ", "dort", "."]);
  });

  test("out-of-bounds idx wird ignoriert (applied 0, Inhalt unverändert)", async () => {
    const { applyEdits } = await import("./apply.ts");
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const before = enumerateEditableTextNodes(parseHTML(MIXED).document).map((n) => n.textContent);
    const res = applyEdits(MIXED, [{ idx: 999, text: "x" }]);
    expect(res.applied).toBe(0);
    const after = enumerateEditableTextNodes(parseHTML(res.html).document).map((n) => n.textContent);
    expect(after).toEqual(before);
  });

  test("HTML in Edit-Text wird escaped (kein Markup-Injection)", async () => {
    const { applyEdits } = await import("./apply.ts");
    const { html: out } = applyEdits(MIXED, [{ idx: 0, text: "<b>x</b> " }]);
    const { document } = parseHTML(out);
    expect(document.querySelectorAll("b").length).toBe(0); // kein echtes <b> entstanden
    expect(out).toContain("&lt;b&gt;");
  });
});

// ===========================================================================
// Feature B — Bild-Upload (Kern: enumerateImages / setImageSrc)
// ===========================================================================
describe("contract.ts — enumerateImages + data-edit-img-idx (Feature B)", () => {
  test("enumerateImages liefert alle <img> in Dokumentreihenfolge", async () => {
    const { enumerateImages } = await import("./contract.ts");
    const html = readFileSync(join(REAL_SITE, "index.html"), "utf8");
    const imgs = enumerateImages(parseHTML(html).document);
    const directCount = parseHTML(html).document.querySelectorAll("img").length;
    expect(imgs.length).toBe(directCount);
    expect(imgs.length).toBeGreaterThan(0);
  });

  test("renderEditView setzt data-edit-img-idx auf jedes <img> (response-only)", async () => {
    const { renderEditView } = await import("./serve.ts");
    const { enumerateImages } = await import("./contract.ts");
    const html = readFileSync(join(REAL_SITE, "index.html"), "utf8");
    const n = enumerateImages(parseHTML(html).document).length;

    const out = renderEditView(html, {
      pagePath: "site/index.html", fileHash: "x", scriptUrl: "/edit-assets/overlay.js",
    });
    const idxs = [...out.matchAll(/data-edit-img-idx="(\d+)"/g)].map((m) => Number(m[1]));
    expect(idxs.length).toBe(n);
    expect(new Set(idxs).size).toBe(n); // eindeutig
    expect(Math.min(...idxs)).toBe(0);
  });
});

describe("apply.ts — setImageSrc (Feature B)", () => {
  const TWO_IMGS =
    "<!doctype html><html><body>" +
    "<img src='assets/a.webp' alt='A'><img src='assets/b.jpg' alt='B'>" +
    "</body></html>";

  test("setImageSrc ändert nur den Ziel-<img>-src, Rest identisch", async () => {
    const { setImageSrc } = await import("./apply.ts");
    const { html: out, applied } = setImageSrc(TWO_IMGS, 1, "/assets/upload-abc123.png");
    expect(applied).toBe(1);

    const { document } = parseHTML(out);
    const imgs = document.querySelectorAll("img");
    expect(imgs[0]!.getAttribute("src")).toBe("assets/a.webp"); // unverändert
    expect(imgs[1]!.getAttribute("src")).toBe("/assets/upload-abc123.png"); // geändert
    expect(imgs[0]!.getAttribute("alt")).toBe("A"); // andere Attribute bleiben
    expect(imgs[1]!.getAttribute("alt")).toBe("B");
  });

  test("setImageSrc mit out-of-bounds idx → applied 0, unverändert", async () => {
    const { setImageSrc } = await import("./apply.ts");
    const { html: out, applied } = setImageSrc(TWO_IMGS, 99, "/assets/x.png");
    expect(applied).toBe(0);
    const imgs = parseHTML(out).document.querySelectorAll("img");
    expect(imgs[0]!.getAttribute("src")).toBe("assets/a.webp");
    expect(imgs[1]!.getAttribute("src")).toBe("assets/b.jpg");
  });
});

// ===========================================================================
// Feature B — Host-Route POST /edit/upload (Integration)
// ===========================================================================
describe("host.ts — POST /edit/upload (Feature B)", () => {
  let host: typeof import("./host.ts");
  let auth: typeof import("./auth.ts");
  let git: typeof import("./git.ts");
  let ctx: import("./host.ts").HostCtx;

  beforeAll(async () => {
    host = await import("./host.ts");
    auth = await import("./auth.ts");
    git = await import("./git.ts");
  });

  beforeEach(() => {
    const repoRoot = makeTmpDir("regoro-upload-");
    const siteDir = join(repoRoot, "site");
    mkdirSync(siteDir, { recursive: true });
    cpSync(REAL_SITE, siteDir, { recursive: true });
    git.ensureRepo(repoRoot);
    ctx = { repoRoot, siteDir, pageWhitelist: PAGE_WHITELIST, auth: TEST_AUTH };
  });

  function authCookie(): string {
    return auth.issueCookie(TEST_AUTH).split(";")[0]!;
  }

  function uploadRequest(opts: {
    cookie?: string;
    pagePath?: string;
    imgIdx?: number | string;
    bytes?: Uint8Array;
    filename?: string;
    contentType?: string;
  }): Promise<Response> {
    const fd = new FormData();
    if (opts.pagePath !== undefined) fd.set("pagePath", opts.pagePath);
    if (opts.imgIdx !== undefined) fd.set("imgIdx", String(opts.imgIdx));
    if (opts.bytes) {
      // Über einen exakt passenden ArrayBuffer-Slice → typkorrekter BlobPart.
      const ab = opts.bytes.buffer.slice(
        opts.bytes.byteOffset,
        opts.bytes.byteOffset + opts.bytes.byteLength,
      ) as ArrayBuffer;
      const blob = new Blob([ab], { type: opts.contentType ?? "application/octet-stream" });
      fd.set("image", blob, opts.filename ?? "upload.bin");
    }
    const url = new URL("http://localhost:8788/edit/upload");
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    const req = new Request(url, { method: "POST", headers, body: fd });
    return Promise.resolve(host.handleEditorRequest(req, url, ctx));
  }

  function assetFiles(): string[] {
    return readdirSync(join(ctx.siteDir, "assets"));
  }

  function call(method: string, path: string): Promise<Response> {
    const url = new URL("http://localhost:8788" + path);
    const req = new Request(url, { method });
    return Promise.resolve(host.handleEditorRequest(req, url, ctx));
  }

  test("gültiges PNG → 200, Datei unter site/assets/upload-*.png, <img src> aktualisiert, Git +1", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const before = assetFiles().length;
    const versionsBefore = git.listVersions(ctx.repoRoot, pagePath).length;

    const res = await uploadRequest({
      cookie, pagePath, imgIdx: 0, bytes: pngBytes(), filename: "foto.png", contentType: "image/png",
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; src: string; fileHash: string };
    expect(json.ok).toBe(true);
    expect(json.src).toMatch(/^\/assets\/upload-[0-9a-f]+\.png$/);
    expect(json.fileHash).toMatch(/^[0-9a-f]{64}$/);

    // Neue Datei liegt INNERHALB site/assets/.
    const after = assetFiles();
    expect(after.length).toBe(before + 1);
    const newFile = after.find((f) => /^upload-[0-9a-f]+\.png$/.test(f));
    expect(newFile).toBeDefined();

    // Seiten-<img idx 0> trägt jetzt den neuen src.
    const pageHtml = readFileSync(join(ctx.repoRoot, pagePath), "utf8");
    const firstImgSrc = parseHTML(pageHtml).document.querySelector("img")!.getAttribute("src");
    expect(firstImgSrc).toBe(json.src);

    // Git-Historie ist gewachsen.
    const versionsAfter = git.listVersions(ctx.repoRoot, pagePath).length;
    expect(versionsAfter).toBeGreaterThan(versionsBefore);

    // Header-Pflicht.
    expect((res.headers.get("x-robots-tag") ?? "").toLowerCase()).toContain("noindex");
    expect((res.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");
  });

  test("gültiges JPEG und GIF werden ebenfalls akzeptiert (200)", async () => {
    const cookie = authCookie();
    const jpg = await uploadRequest({
      cookie, pagePath: "site/index.html", imgIdx: 0, bytes: jpegBytes(),
      filename: "f.jpg", contentType: "image/jpeg",
    });
    expect(jpg.status).toBe(200);
    const gif = await uploadRequest({
      cookie, pagePath: "site/index.html", imgIdx: 1, bytes: gifBytes(),
      filename: "f.gif", contentType: "image/gif",
    });
    expect(gif.status).toBe(200);
  });

  // LÜCKE v2-Validation: WEBP (RIFF/WEBP-Magic-Bytes) war nicht explizit getestet.
  test("gültiges WEBP (RIFF/WEBP-Signatur) → 200, Datei als .webp, <img src> aktualisiert", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const before = assetFiles().length;

    const res = await uploadRequest({
      cookie, pagePath, imgIdx: 0, bytes: webpBytes(),
      filename: "bild.webp", contentType: "image/webp",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; src: string };
    expect(json.ok).toBe(true);
    expect(json.src).toMatch(/^\/assets\/upload-[0-9a-f]+\.webp$/);

    const after = assetFiles();
    expect(after.length).toBe(before + 1);
    expect(after.some((f) => /^upload-[0-9a-f]+\.webp$/.test(f))).toBe(true);

    // Seiten-<img idx 0> trägt den neuen .webp-src.
    const firstImgSrc = parseHTML(readFileSync(join(ctx.repoRoot, pagePath), "utf8"))
      .document.querySelector("img")!.getAttribute("src");
    expect(firstImgSrc).toBe(json.src);
  });

  // LÜCKE v2-Validation: Polyglot (gültige Bild-Magic-Bytes + angehängtes HTML/Script).
  // Der Magic-Byte-Sniff prüft nur die führende Signatur → der Polyglot wird als
  // gültiges Bild akzeptiert. ABER: sicher gespeichert mit .png-Extension und als
  // Bild referenziert; das angehängte Script wird NIE als HTML/JS ausgeliefert
  // (kein .html-Asset, Content-Type bleibt image/png). Dieser Test nagelt das fest.
  test("PNG-Polyglot mit angehängtem <script> → als Bild gespeichert (.png), nicht als HTML", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const res = await uploadRequest({
      cookie, pagePath, imgIdx: 0, bytes: pngPolyglotBytes(),
      filename: "poly.png", contentType: "image/png",
    });
    // Wird wegen gültiger PNG-Signatur akzeptiert.
    expect(res.status).toBe(200);
    const json = (await res.json()) as { src: string };
    // Sichere, server-generierte .png-Extension — KEIN .html, KEIN .svg.
    expect(json.src).toMatch(/^\/assets\/upload-[0-9a-f]+\.png$/);
    expect(json.src).not.toMatch(/\.(html?|svg|js)$/i);

    // Das Asset wird über den statischen Asset-Zweig als image/png ausgeliefert,
    // niemals als text/html → kein XSS über den Bild-Pfad.
    const assetRes = await call("GET", json.src);
    expect(assetRes.status).toBe(200);
    expect((assetRes.headers.get("content-type") ?? "").toLowerCase()).toContain("image/png");
    expect((assetRes.headers.get("content-type") ?? "").toLowerCase()).not.toContain("text/html");
  });

  test("falsche Magic-Bytes (Text als image/png deklariert) → 400, KEINE Datei geschrieben", async () => {
    const cookie = authCookie();
    const before = assetFiles().length;
    const res = await uploadRequest({
      cookie, pagePath: "site/index.html", imgIdx: 0,
      bytes: fakeImageTextBytes(), filename: "evil.png", contentType: "image/png",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBeDefined();
    expect(assetFiles().length).toBe(before); // nichts geschrieben
  });

  test("SVG wird in v1 abgelehnt (XSS-Risiko) → 400", async () => {
    const cookie = authCookie();
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    const res = await uploadRequest({
      cookie, pagePath: "site/index.html", imgIdx: 0,
      bytes: svg, filename: "x.svg", contentType: "image/svg+xml",
    });
    expect(res.status).toBe(400);
  });

  test("zu große Datei (> 5 MB) → 400, KEINE Datei geschrieben", async () => {
    const cookie = authCookie();
    const before = assetFiles().length;
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(pngBytes(), 0); // gültige Signatur, aber zu groß
    const res = await uploadRequest({
      cookie, pagePath: "site/index.html", imgIdx: 0, bytes: big,
      filename: "huge.png", contentType: "image/png",
    });
    expect(res.status).toBe(400);
    expect(assetFiles().length).toBe(before);
  });

  test("ohne Auth → 404, KEINE Datei geschrieben", async () => {
    const before = assetFiles().length;
    const res = await uploadRequest({
      pagePath: "site/index.html", imgIdx: 0, bytes: pngBytes(),
      filename: "f.png", contentType: "image/png",
    });
    expect(res.status).toBe(404);
    expect(assetFiles().length).toBe(before);
  });

  test("pagePath-Traversal → 404, KEINE Datei außerhalb site/assets/", async () => {
    const cookie = authCookie();
    for (const bad of ["site/../etc/passwd", "/etc/passwd", "site/geheim.html"]) {
      const res = await uploadRequest({
        cookie, pagePath: bad, imgIdx: 0, bytes: pngBytes(),
        filename: "f.png", contentType: "image/png",
      });
      expect(res.status).toBe(404);
    }
    // Kein Asset außerhalb site/assets/ gelandet (z.B. kein /etc/passwd-Overwrite).
    expect(existsSync(join(ctx.repoRoot, "etc"))).toBe(false);
  });

  test("symlinked assets escape → 400, KEINE Datei außerhalb siteDir (Greptile-Fix)", async () => {
    // site/assets ist ein Symlink auf ein Verzeichnis AUSSERHALB von siteDir.
    // Der lexikalische Pfad-Check würde passieren; nur die realpath-Prüfung fängt
    // den Escape. Erwartung: fail-closed (400), nichts wird außerhalb geschrieben.
    const outside = makeTmpDir("regoro-outside-");
    const assetsPath = join(ctx.siteDir, "assets");
    rmSync(assetsPath, { recursive: true, force: true });
    symlinkSync(outside, assetsPath, "dir");

    const res = await uploadRequest({
      cookie: authCookie(), pagePath: "site/index.html", imgIdx: 0,
      bytes: pngBytes(), filename: "f.png", contentType: "image/png",
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBeDefined();
    // Nichts durch den Symlink hindurch nach außerhalb geschrieben.
    expect(readdirSync(outside).length).toBe(0);
  });

  test("assets als echtes Verzeichnis → Upload weiterhin 200 (Gegenprobe)", async () => {
    const res = await uploadRequest({
      cookie: authCookie(), pagePath: "site/index.html", imgIdx: 0,
      bytes: pngBytes(), filename: "f.png", contentType: "image/png",
    });
    expect(res.status).toBe(200);
    expect(assetFiles().some((f) => /^upload-[0-9a-f]+\.png$/.test(f))).toBe(true);
  });

  test("ungültiger imgIdx (out of range) → 400, KEINE Datei geschrieben", async () => {
    const cookie = authCookie();
    const before = assetFiles().length;
    const res = await uploadRequest({
      cookie, pagePath: "site/index.html", imgIdx: 9999, bytes: pngBytes(),
      filename: "f.png", contentType: "image/png",
    });
    expect(res.status).toBe(400);
    expect(assetFiles().length).toBe(before);
  });

  test("generierter Dateiname ignoriert User-Pfad (kein Traversal über filename)", async () => {
    const cookie = authCookie();
    const res = await uploadRequest({
      cookie, pagePath: "site/index.html", imgIdx: 0, bytes: pngBytes(),
      filename: "../../../../etc/passwd.png", contentType: "image/png",
    });
    // Entweder akzeptiert mit SICHER generiertem Namen (200, upload-<sha8>) ODER 400 —
    // aber NIEMALS außerhalb site/assets/ schreiben.
    expect([200, 400]).toContain(res.status);
    expect(existsSync(join(ctx.repoRoot, "etc"))).toBe(false);
    if (res.status === 200) {
      const json = (await res.json()) as { src: string };
      expect(json.src).toMatch(/^\/assets\/upload-[0-9a-f]+\.png$/);
    }
  });
});

// ===========================================================================
// LÜCKE v2-Validation: EDITOR_INSECURE_COOKIE-Toggle (auth.ts issueCookie)
// Default → Secure im Cookie; Env=1 → KEIN Secure (lokales HTTP-Dogfooding).
// ===========================================================================
// In einem ISOLIERTEN Subprozess ausgewertet, damit die env-Mutation
// (EDITOR_INSECURE_COOKIE) NICHT mit parallel laufenden Test-Dateien
// interferiert (Bun teilt process.env über parallele Dateien).
describe("auth.ts — EDITOR_INSECURE_COOKIE-Toggle (Secure-Flag)", () => {
  /** Ruft issueCookie() in einem frischen bun-Prozess mit gesetztem Env auf. */
  function cookieInSubprocess(insecureEnv: string | null): string {
    const authPath = join(import.meta.dir, "auth.ts");
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
    };
    if (insecureEnv === null) delete env.EDITOR_INSECURE_COOKIE;
    else env.EDITOR_INSECURE_COOKIE = insecureEnv;
    // issueCookie nimmt eine AuthConfig (nutzt nur das Secret); literal übergeben.
    // Das EDITOR_INSECURE_COOKIE-Env steuert das Secure-Flag.
    const script =
      `import {issueCookie} from ${JSON.stringify(authPath)}; ` +
      `process.stdout.write(issueCookie({ hash: "x", secret: "sub-secret-aaaaaaaaaaaa" }));`;
    const res = Bun.spawnSync({
      cmd: [process.execPath, "-e", script],
      env,
    });
    if (res.exitCode !== 0) {
      throw new Error("Subprozess fehlgeschlagen: " + new TextDecoder().decode(res.stderr));
    }
    return new TextDecoder().decode(res.stdout);
  }

  test("Default (Env ungesetzt) → Cookie enthält Secure", () => {
    const sc = cookieInSubprocess(null);
    expect(sc).toContain("Secure");
    expect(sc).toContain("HttpOnly");
    expect(sc).toMatch(/SameSite=Strict/i);
  });

  test("EDITOR_INSECURE_COOKIE=1 → Cookie OHNE Secure (HttpOnly/SameSite bleiben)", () => {
    const sc = cookieInSubprocess("1");
    expect(sc).not.toContain("Secure");
    expect(sc).toContain("HttpOnly"); // andere Schutz-Flags unverändert
    expect(sc).toMatch(/SameSite=Strict/i);
  });

  test("EDITOR_INSECURE_COOKIE=0 (nicht '1') → Secure bleibt gesetzt", () => {
    expect(cookieInSubprocess("0")).toContain("Secure");
  });
});

// ===========================================================================
// LÜCKE v2-Validation: Mixed-Content-Save-Roundtrip same-session über HTTP.
// Ein direkter <p>-Text-Node UND ein Geschwister-<a>-Text-Node werden in EINEM
// Save geändert; der zurückgegebene fileHash passt für den nächsten Save (200,
// nicht 409) → Text-Node-Walk ist deterministisch über die Serialisierung.
// ===========================================================================
describe("host.ts — Mixed-Content-Save-Roundtrip same-session (Feature A)", () => {
  let host: typeof import("./host.ts");
  let auth: typeof import("./auth.ts");
  let git: typeof import("./git.ts");
  let apply: typeof import("./apply.ts");
  let contract: typeof import("./contract.ts");
  let ctx: import("./host.ts").HostCtx;

  beforeAll(async () => {
    host = await import("./host.ts");
    auth = await import("./auth.ts");
    git = await import("./git.ts");
    apply = await import("./apply.ts");
    contract = await import("./contract.ts");
  });

  beforeEach(() => {
    const repoRoot = makeTmpDir("regoro-mixed-");
    const siteDir = join(repoRoot, "site");
    mkdirSync(siteDir, { recursive: true });
    cpSync(REAL_SITE, siteDir, { recursive: true });
    git.ensureRepo(repoRoot);
    ctx = { repoRoot, siteDir, pageWhitelist: PAGE_WHITELIST, auth: TEST_AUTH };
  });

  function authCookie(): string {
    return auth.issueCookie(TEST_AUTH).split(";")[0]!;
  }

  async function save(cookie: string, pagePath: string, fileHash: string, edits: { idx: number; text: string }[]) {
    const url = new URL("http://localhost:8788/edit/save");
    const req = new Request(url, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ pagePath, fileHash, edits }),
    });
    const res = await Promise.resolve(host.handleEditorRequest(req, url, ctx));
    return { status: res.status, json: (await res.json()) as { ok?: boolean; fileHash?: string; error?: string } };
  }

  test("Mixed-Content: direkter <p>-Text UND Link-Text in EINEM Save → nur Text geändert, <a> bleibt", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);

    const original = readFileSync(filePath, "utf8");
    // idx 81 = direkter <p>-Text "…Mehr dazu in der ", idx 82 = Link-Text "Datenschutzerklärung".
    const nodes0 = contract.enumerateEditableTextNodes(parseHTML(original).document);
    const iPara = nodes0.findIndex((n) => /Mehr dazu in der/.test(n.textContent ?? ""));
    const iLink = nodes0.findIndex((n) => (n.textContent ?? "").trim() === "Datenschutzerklärung");
    expect(iPara).toBeGreaterThanOrEqual(0);
    expect(iLink).toBe(iPara + 1); // unmittelbar aufeinanderfolgend (Geschwister)

    // Element-Skelett VOR dem Save (für Struktur-Invarianz).
    const skeleton = (h: string) =>
      [...parseHTML(h).document.querySelectorAll("*")].map((el) => el.tagName).join(",");
    const skelBefore = skeleton(original);

    const r1 = await save(cookie, pagePath, apply.fileSha256(original), [
      { idx: iPara, text: "Mehr Infos in unserer " },
      { idx: iLink, text: "Datenschutz-Info" },
    ]);
    expect(r1.status).toBe(200);
    expect(r1.json.ok).toBe(true);
    expect(r1.json.fileHash).toMatch(/^[0-9a-f]{64}$/);

    const after = readFileSync(filePath, "utf8");
    // Struktur identisch — das <a>-Element bleibt erhalten.
    expect(skeleton(after)).toBe(skelBefore);
    const adoc = parseHTML(after).document;
    const dsLink = [...adoc.querySelectorAll("a")].find((a) => a.getAttribute("href") === "datenschutz.html");
    expect(dsLink).toBeDefined();
    expect(dsLink!.textContent).toBe("Datenschutz-Info"); // Link-Text geändert, Element + href intakt
    expect(adoc.body.textContent).toContain("Mehr Infos in unserer ");
  });

  test("fileHash-Roundtrip nach Mixed-Content-Edit: zweiter Save mit zurückgegebenem Hash → 200", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);

    const original = readFileSync(filePath, "utf8");
    const nodes0 = contract.enumerateEditableTextNodes(parseHTML(original).document);
    const iLink = nodes0.findIndex((n) => (n.textContent ?? "").trim() === "Datenschutzerklärung");

    const r1 = await save(cookie, pagePath, apply.fileSha256(original), [{ idx: iLink, text: "Datenschutz A" }]);
    expect(r1.status).toBe(200);

    // Der von Save 1 gelieferte Hash MUSS Save 2 durchgehen lassen (kein 409).
    const r2 = await save(cookie, pagePath, r1.json.fileHash!, [{ idx: iLink, text: "Datenschutz B" }]);
    expect(r2.status).toBe(200);
    expect(r2.json.ok).toBe(true);
    expect(r2.json.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(apply.fileSha256(readFileSync(filePath, "utf8"))).toBe(r2.json.fileHash!);
  });
});
