/**
 * Contract B — Host-Router: dünne HTTP-Schicht über dem Kern.
 *
 * Kennt Auth + Routing, delegiert die eigentliche Logik an contract/serve/apply/git.
 * Auth-Fehler → 404 (nicht 401), außer /edit/login. Alle Antworten noindex/no-store.
 */
import { join, resolve, dirname, basename, extname, sep, posix } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, realpathSync } from "node:fs";
import { parseHTML } from "linkedom";
// Bun-"file"-Import: liefert einen Pfad, den bun build --compile mit einbettet.
import overlayAsset from "./overlay.client.js" with { type: "file" };
import {
  verifyPassword,
  issueCookie,
  checkCookie,
  readCookieToken,
  type AuthConfig,
} from "./auth.ts";
import { renderEditView, renderVersionPreview } from "./serve.ts";
import { applyEdits, setImageSrc, fileSha256, type Edit } from "./apply.ts";
import { enumerateImages } from "./contract.ts";
import {
  ensureRepo,
  commitEdit,
  listVersions,
  showVersion,
  restoreVersion,
} from "./git.ts";

export interface HostCtx {
  repoRoot: string;
  siteDir: string;
  pageWhitelist: string[];
  auth: AuthConfig | null;
  sitePrefix?: string;
}

/**
 * Liefert den git-Pfad einer Seite relativ zum repoRoot, gebaut aus sitePrefix
 * (default "site") + page. Bei sitePrefix==="" liegt die Seite top-level (kein
 * "/"-Präfix). Immer posix-Slashes (git-Pfade).
 */
function pagePathFor(ctx: HostCtx, page: string): string {
  const sitePrefix = ctx.sitePrefix ?? "site";
  return sitePrefix ? posix.join(sitePrefix, page) : page;
}

/**
 * Lehnt jeden Pfad ab, dessen dekodiertes Pfad-Segment mit "." beginnt
 * (.regoro/, .git/, .env, alle Dotfiles). rel ist der bereits dekodierte
 * rel-Pfad ohne führenden Slash. true = blockieren.
 */
function hasDotSegment(rel: string): boolean {
  for (const seg of rel.split("/")) {
    if (seg.startsWith(".")) return true;
  }
  return false;
}

const PAGE_RE = /^[a-z0-9-]+\.html$/;
// Nur abgekürzte/volle SHA-Hex-Hashes als git-Ref. Schließt führende "-"
// (Argument-Injection wie `-f`), symbolische Refs (HEAD/main/Tags → Lesen
// fremder Branches) und `..`/`@` aus.
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
// Overlay-Pfad: In der Entwicklung ist das der echte Plattenpfad (jeder Request
// liest frisch — Invariante bleibt), in einem `bun build --compile`-Binary der
// eingebettete /$bunfs/-Pfad. Früher aus import.meta.url gebaut; das zeigte im
// Binary ins Leere → /edit-assets/overlay.js gab 404 und der Editor war stumm
// funktionslos. readFileSync/existsSync können beide Pfade.
const OVERLAY_PATH: string = overlayAsset;

// Allowlist statischer Asset-Extensions → Content-Type. KEIN .html hier
// (Seiten laufen über den /edit-Pfad; Asset-Serving darf keine beliebigen
// .html ausliefern). Nur diese Extensions werden öffentlich ausgeliefert.
const ASSET_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  // KEIN .svg: image/svg+xml ist script-fähig (latenter Stored-XSS). regoro.de
  // nutzt nur webp/jpg. Upload blockt SVG ohnehin per Sniff — das schließt auch
  // den Static-Serving-Pfad.
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

// Bild-Upload: Größenlimit + Magic-Byte-Sniff. SVG bewusst NICHT zugelassen
// (XSS-Risiko durch eingebettetes Script). Liefert die kanonische Extension
// anhand der ECHTEN Signatur (nicht anhand Dateiname/Content-Type).
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

function sniffImageExt(buf: Uint8Array): "png" | "jpg" | "gif" | "webp" | null {
  if (buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  // GIF: 47 49 46 38 ("GIF8")
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "gif";
  // WEBP: "RIFF"...."WEBP" (Bytes 0-3 RIFF, 8-11 WEBP)
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  // nosniff klassenweit: verhindert MIME-Sniffing (Polyglot-Asset mit gültiger
  // Bild-Signatur + eingebettetem HTML/JS wird nicht als HTML interpretiert).
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

function withHeaders(extra: Record<string, string> = {}): Headers {
  const h = new Headers(SECURITY_HEADERS);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: withHeaders({ "Content-Type": "text/html; charset=utf-8", ...extra }),
  });
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: withHeaders({ "Content-Type": "application/json; charset=utf-8", ...extra }),
  });
}

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: withHeaders() });
}

/**
 * Validiert eine Seite gegen Whitelist + Regex und löst auf einen sicheren,
 * innerhalb von siteDir liegenden absoluten Pfad auf. null = abgelehnt (→ 404).
 */
function resolvePage(ctx: HostCtx, page: string): { page: string; abs: string } | null {
  if (!page || !PAGE_RE.test(page)) return null;
  if (!ctx.pageWhitelist.includes(page)) return null;
  const abs = resolve(ctx.siteDir, page);
  // Traversal-Guard: aufgelöster Pfad muss innerhalb siteDir liegen.
  const base = resolve(ctx.siteDir);
  if (abs !== join(base, page) || !abs.startsWith(base + "/")) return null;
  return { page, abs };
}

/**
 * Liefert ein öffentliches statisches Site-Asset (CSS/Bilder/Fonts/...) aus
 * ctx.siteDir aus — OHNE Auth (es ist die public site), nur lesend (GET).
 * Traversal-Guard + Extension-Allowlist; nie etwas außerhalb siteDir oder
 * unter editor/. Liefert null, wenn der Pfad kein gültiges Asset ist (→ 404).
 *
 * urlPath ist der dekodierte Request-Pfad ohne führenden "/" (z.B. "styles.css"
 * oder "assets/logo.webp").
 */
function serveStaticAsset(ctx: HostCtx, urlPath: string): Response | null {
  if (!urlPath || urlPath.includes("\0")) return null;
  // Dotfile-Block (Defense-in-depth): kein Segment darf mit "." beginnen
  // (.regoro/auth.json, .git/, .env …). Der argon2-Hash darf nie ausgeliefert
  // werden. urlPath ist bereits dekodiert.
  if (hasDotSegment(urlPath)) return null;
  // Extension-Allowlist (case-insensitive); .html ist bewusst NICHT erlaubt.
  const ext = extname(urlPath).toLowerCase();
  const contentType = ASSET_TYPES[ext];
  if (!contentType) return null;

  const base = resolve(ctx.siteDir);
  const abs = resolve(base, urlPath);
  // Traversal-Guard: aufgelöster Pfad muss strikt innerhalb siteDir liegen.
  if (abs !== base && !abs.startsWith(base + sep)) return null;

  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const data = readFileSync(abs);
  return new Response(data, {
    status: 200,
    // X-Robots-Tag bleibt (noindex bis Live-Gang); Cache-Control wie restlicher
    // Host (no-store) — für die Edit-Ansicht/Dogfood unkritisch.
    headers: withHeaders({ "Content-Type": contentType }),
  });
}

function isAuthed(req: Request, ctx: HostCtx): boolean {
  if (!ctx.auth) return false;
  const token = readCookieToken(req.headers.get("cookie"));
  return token != null && checkCookie(ctx.auth, token);
}

// Erlaubte return-Ziele nach Login: entweder /edit (Root) oder /<page>.html/edit.
// Streng validiert → verhindert Open-Redirect (kein //host, kein http://…, kein
// beliebiger Pfad). Liefert das validierte Ziel oder null.
const RETURN_RE = /^\/(?:edit|[a-z0-9-]+\.html\/edit)$/;
function validateReturn(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  return RETURN_RE.test(raw) ? raw : null;
}

// Minimales HTML-Attribut-Escaping für den hidden return-Wert (defensiv; der Wert
// ist bereits gegen RETURN_RE validiert, enthält also keine Sonderzeichen — dies
// ist Defense-in-depth gegen künftige Regex-Lockerung).
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function loginForm(error?: string, returnTo?: string | null): string {
  const returnInput = returnTo
    ? `<input type="hidden" name="return" value="${escapeAttr(returnTo)}">`
    : "";
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Regoro Editor — Login</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
background:#14324f;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#fff;color:#16222e;padding:28px;border-radius:10px;width:300px;box-shadow:0 8px 28px rgba(0,0,0,.3)}
h1{font-size:18px;margin:0 0 16px}label{display:block;font-size:13px;margin-bottom:6px}
input{width:100%;padding:9px;border:1px solid #cbd5dc;border-radius:6px;box-sizing:border-box;font:inherit}
button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:6px;background:#e2571e;color:#fff;
font:inherit;font-weight:600;cursor:pointer}.err{color:#c0392b;font-size:13px;margin-top:10px}</style></head>
<body><form method="POST" action="/edit/login">
<h1>Regoro Editor</h1>
<label for="password">Passwort</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus>
${returnInput}
<button type="submit">Anmelden</button>
${error ? `<div class="err">${error}</div>` : ""}
</form></body></html>`;
}

/** 302-Redirect auf die Login-Seite mit (bereits validiertem) return-Ziel. */
function loginRedirect(currentPath: string): Response {
  const location = `/edit/login?return=${encodeURIComponent(currentPath)}`;
  return new Response(null, {
    status: 302,
    headers: withHeaders({ Location: location }),
  });
}

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const text = await req.text();
  const params = new URLSearchParams(text);
  const obj: Record<string, unknown> = {};
  for (const [k, v] of params) obj[k] = v;
  return obj;
}

/** Haupt-Router. Synchron oder als Promise<Response>. */
export function handleEditorRequest(req: Request, url: URL, ctx: HostCtx): Promise<Response> {
  return route(req, url, ctx);
}

async function route(req: Request, url: URL, ctx: HostCtx): Promise<Response> {
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // === Präzedenz (1): /edit/login (exakt) — einzige Route ohne Auth-Wall. ===
  if (path === "/edit/login") {
    // Fail-closed: ohne Auth-Datei ist kein Login möglich → 404 (auch GET/POST).
    if (ctx.auth === null) return notFound();
    if (method === "GET") {
      // return-Query validieren (Open-Redirect-Schutz); nur gültige Ziele in die Form.
      const returnTo = validateReturn(url.searchParams.get("return"));
      return html(loginForm(undefined, returnTo));
    }
    if (method === "POST") {
      const body = await parseBody(req);
      const pw = typeof body.password === "string" ? body.password : "";
      // return kann aus dem Body ODER der Query kommen (Body hat Vorrang). Beide
      // laufen durch dieselbe strenge Validierung → Open-Redirect-sicher.
      const returnRaw =
        typeof body.return === "string" ? body.return : url.searchParams.get("return");
      const returnTo = validateReturn(returnRaw);
      if (await verifyPassword(ctx.auth, pw)) {
        // Bei Erfolg: auf validiertes return-Ziel, sonst Default /edit.
        return new Response(null, {
          status: 302,
          headers: withHeaders({
            "Set-Cookie": issueCookie(ctx.auth),
            Location: returnTo ?? "/edit",
          }),
        });
      }
      return html(loginForm("Falsches Passwort.", returnTo), 401);
    }
    return notFound();
  }

  // === Präzedenz (2): /edit-assets/* (öffentlich; nutzlos ohne Config). ===
  if (path === "/edit-assets/overlay.js") {
    if (!existsSync(OVERLAY_PATH)) return notFound();
    const js = readFileSync(OVERLAY_PATH, "utf8");
    return new Response(js, {
      status: 200,
      headers: withHeaders({ "Content-Type": "application/javascript; charset=utf-8" }),
    });
  }

  // === Präzedenz (3): API-Routen unter /edit/* ===
  // Unauth (kein/ungültiges Cookie ODER ctx.auth===null) → 404 (versteckt).
  const isApiRoute =
    path === "/edit/save" ||
    path === "/edit/upload" ||
    path === "/edit/restore" ||
    path === "/edit/versions" ||
    /^\/edit\/version\/[^/]+$/.test(path);
  if (isApiRoute) {
    if (!isAuthed(req, ctx)) return notFound();

    if (path === "/edit/save" && method === "POST") return handleSave(req, ctx);
    if (path === "/edit/upload" && method === "POST") return handleUpload(req, ctx);
    if (path === "/edit/restore" && method === "POST") return handleRestore(req, ctx);

    if (path === "/edit/versions" && method === "GET") {
      const target = resolvePage(ctx, url.searchParams.get("page") ?? "");
      if (!target) return notFound();
      const pagePath = pagePathFor(ctx, target.page);
      const versions = listVersions(ctx.repoRoot, pagePath);
      return json(versions);
    }

    const versionMatch = path.match(/^\/edit\/version\/([^/]+)$/);
    if (versionMatch && method === "GET") {
      const commitRaw = decodeURIComponent(versionMatch[1]!);
      if (!COMMIT_RE.test(commitRaw)) return notFound();
      const target = resolvePage(ctx, url.searchParams.get("page") ?? "");
      if (!target) return notFound();
      const pagePath = pagePathFor(ctx, target.page);
      try {
        const content = showVersion(ctx.repoRoot, commitRaw, pagePath);
        // Read-only-Vorschau: Asset-URLs absolutieren (CSS/Bilder laden unter
        // /edit/version/<commit>), aber kein Overlay/idx injizieren.
        return html(renderVersionPreview(content));
      } catch {
        return notFound();
      }
    }

    return notFound();
  }

  // === Präzedenz (4): Edit-VIEW-Routen. ===
  // /edit (+ trailing slash) → index.html; /<page>.html/edit → diese Seite.
  // ctx.auth===null → 404 (fail-closed). Unauth → Login-Redirect (302).
  let viewPage: string | null = null;
  if (path === "/edit" || path === "/edit/") {
    viewPage = "index.html";
  } else {
    const suffixMatch = path.match(/^\/([a-z0-9-]+\.html)\/edit$/);
    if (suffixMatch) viewPage = suffixMatch[1]!;
  }
  if (viewPage !== null && method === "GET") {
    if (ctx.auth === null) return notFound();
    const target = resolvePage(ctx, viewPage);
    if (!target) return notFound();
    if (!isAuthed(req, ctx)) return loginRedirect(path);
    if (!existsSync(target.abs)) return notFound();

    const fileContent = readFileSync(target.abs, "utf8");
    const pagePath = pagePathFor(ctx, target.page);
    const out = renderEditView(fileContent, {
      pagePath,
      fileHash: fileSha256(fileContent),
      scriptUrl: "/edit-assets/overlay.js",
      pages: ctx.pageWhitelist,
      page: target.page,
    });
    return html(out);
  }

  // === Präzedenz (5): Öffentliches Static-Serving (Site-HTML + Assets). ===
  // Kein Auth (public site), nur GET, nur innerhalb siteDir. Dotfile-Block +
  // Traversal-Guards greifen. Rohes HTML (KEIN Overlay, KEIN data-edit-idx).
  if (method === "GET") {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return notFound();
    }
    const rel = decoded.replace(/^\/+/, ""); // führende Slashes weg
    // Dotfile-Block (höchste Priorität): dekodierte Segmente mit "."-Präfix
    // (.regoro/, .git/, .env …) werden NIE öffentlich ausgeliefert.
    if (hasDotSegment(rel)) return notFound();

    // Rohes Seiten-HTML: "/" → index.html; "/<name>.html" → diese Seite. Nur
    // Whitelist-Seiten, die existieren; exakte Dateibytes ohne Transformation.
    const pageName = rel === "" ? "index.html" : rel;
    const pageTarget = resolvePage(ctx, pageName);
    if (pageTarget && existsSync(pageTarget.abs)) {
      const raw = readFileSync(pageTarget.abs);
      return new Response(raw, {
        status: 200,
        headers: withHeaders({ "Content-Type": "text/html; charset=utf-8" }),
      });
    }

    // Sonst: statisches Asset (CSS/Bilder/Fonts …).
    const asset = serveStaticAsset(ctx, rel);
    if (asset) return asset;
    return notFound();
  }

  return notFound();
}

/**
 * Symlink-sichere Containment-Prüfung: true, wenn der REALE (aufgelöste) Pfad
 * innerhalb von siteDir liegt. Verhindert, dass Schreib-/Restore-Vorgänge einem
 * Symlink (z.B. eine als Symlink angelegte Seite/`assets` in einer mounted-/
 * restored-site) nach außerhalb des Site-Baums folgen. Der lexikalische
 * resolve()-Check erkennt Symlinks nicht — realpath schon. Fail-closed.
 */
function pathInsideSite(ctx: HostCtx, absPath: string): boolean {
  try {
    const realSite = realpathSync(ctx.siteDir);
    // Existierende Datei/Verzeichnis: real auflösen; sonst realen Parent + Basename.
    const real = existsSync(absPath)
      ? realpathSync(absPath)
      : join(realpathSync(dirname(absPath)), basename(absPath));
    return real === realSite || real.startsWith(realSite + sep);
  } catch {
    return false;
  }
}

async function handleSave(req: Request, ctx: HostCtx): Promise<Response> {
  const body = await parseBody(req);
  const pagePath = typeof body.pagePath === "string" ? body.pagePath : "";
  const fileHash = typeof body.fileHash === "string" ? body.fileHash : "";
  const edits = Array.isArray(body.edits) ? (body.edits as Edit[]) : [];

  // pagePath validieren: muss "<sitePrefix>/<whitelisted>.html" sein.
  const base = pagePathBasename(ctx, pagePath);
  const target = base ? resolvePage(ctx, base) : null;
  if (!target || pagePath !== pagePathFor(ctx, target.page)) return notFound();
  if (!existsSync(target.abs)) return notFound();

  const current = readFileSync(target.abs, "utf8");
  if (fileSha256(current) !== fileHash) {
    return json({ error: "hash-mismatch" }, 409);
  }

  const { html: nextHtml } = applyEdits(current, edits);
  // Symlink-sicher: nie einer als Symlink angelegten Seite nach außerhalb folgen.
  if (!pathInsideSite(ctx, target.abs)) return json({ error: "bad-path" }, 400);
  writeFileSync(target.abs, nextHtml, "utf8");

  ensureRepo(ctx.repoRoot);
  commitEdit(ctx.repoRoot, pagePath, "Inline-Edit");

  return json({ ok: true, fileHash: fileSha256(nextHtml) });
}

async function handleUpload(req: Request, ctx: HostCtx): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "bad-form" }, 400);
  }

  const pagePath = String(form.get("pagePath") ?? "");
  const imgIdxRaw = form.get("imgIdx");
  const file = form.get("image");

  // 1. pagePath validieren (Traversal/Whitelist) → 404.
  const base = pagePathBasename(ctx, pagePath);
  const target = base ? resolvePage(ctx, base) : null;
  if (!target || pagePath !== pagePathFor(ctx, target.page)) return notFound();
  if (!existsSync(target.abs)) return notFound();

  // 2. Datei vorhanden? → 400.
  if (!(file instanceof Blob)) return json({ error: "no-file" }, 400);

  // 3. Größenlimit → 400 (vor dem Lesen via Blob.size grob, nach dem Lesen exakt).
  if (file.size > MAX_UPLOAD_BYTES) return json({ error: "too-large" }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return json({ error: "too-large" }, 400);

  // 4. Magic-Byte-Sniff der ECHTEN Signatur (SVG/Text → null → 400).
  const ext = sniffImageExt(bytes);
  if (!ext) return json({ error: "unsupported-type" }, 400);

  // 5. imgIdx gegen die echte Bildanzahl der Seite prüfen → 400.
  const pageHtml = readFileSync(target.abs, "utf8");
  const imgCount = enumerateImages(parseHTML(pageHtml).document).length;
  const imgIdx = Number(imgIdxRaw);
  if (!Number.isInteger(imgIdx) || imgIdx < 0 || imgIdx >= imgCount) {
    return json({ error: "bad-img-idx" }, 400);
  }

  // 6. Sicher generierter Name (Hash über Inhalt; KEINE User-Pfade/Originalnamen).
  const sha8 = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const filename = `upload-${sha8}.${ext}`;
  const assetsBase = resolve(ctx.siteDir, "assets");
  const assetsAbs = resolve(assetsBase, filename);
  // Traversal-Guard (filename ist generiert, aber defensiv prüfen).
  if (!assetsAbs.startsWith(assetsBase + sep)) return json({ error: "bad-path" }, 400);

  // 7. Asset schreiben — SYMLINK-SICHER (fail-closed): wäre `assets` (oder ein
  // Elternsegment) ein Symlink nach außerhalb (mounted-/restored-site), würde
  // writeFileSync dem Symlink folgen. Daher das ECHTE Ziel gegen siteDir prüfen.
  mkdirSync(assetsBase, { recursive: true });
  if (!pathInsideSite(ctx, assetsAbs)) return json({ error: "bad-path" }, 400);
  writeFileSync(assetsAbs, bytes);

  // 8. src auf der Seite aktualisieren + schreiben.
  const newSrc = `/assets/${filename}`;
  const { html: nextHtml, applied } = setImageSrc(pageHtml, imgIdx, newSrc);
  if (applied !== 1) return json({ error: "img-not-applied" }, 400);
  if (!pathInsideSite(ctx, target.abs)) return json({ error: "bad-path" }, 400);
  writeFileSync(target.abs, nextHtml, "utf8");

  // 9. Beide (Asset + Seite) committen.
  const sitePrefix = ctx.sitePrefix ?? "site";
  const assetPagePath = sitePrefix
    ? posix.join(sitePrefix, "assets", filename)
    : posix.join("assets", filename);
  ensureRepo(ctx.repoRoot);
  commitEdit(ctx.repoRoot, assetPagePath, `Bild-Upload: ${filename}`);
  commitEdit(ctx.repoRoot, pagePath, `Bild ausgetauscht: idx ${imgIdx}`);

  return json({ ok: true, src: newSrc, fileHash: fileSha256(nextHtml) });
}

async function handleRestore(req: Request, ctx: HostCtx): Promise<Response> {
  const body = await parseBody(req);
  const pagePath = typeof body.pagePath === "string" ? body.pagePath : "";
  const commit = typeof body.commit === "string" ? body.commit : "";

  const base = pagePathBasename(ctx, pagePath);
  const target = base ? resolvePage(ctx, base) : null;
  if (!target || pagePath !== pagePathFor(ctx, target.page)) return notFound();
  if (!COMMIT_RE.test(commit)) return notFound();
  // Symlink-sicher: Restore würde sonst einem als Symlink angelegten Seitenpfad folgen.
  if (existsSync(target.abs) && !pathInsideSite(ctx, target.abs)) {
    return json({ ok: false, error: "bad-path" }, 400);
  }

  try {
    ensureRepo(ctx.repoRoot);
    restoreVersion(ctx.repoRoot, commit, pagePath);
  } catch {
    return json({ ok: false, error: "restore-failed" }, 400);
  }
  return json({ ok: true });
}

/**
 * Extrahiert das Basename-Segment aus einem "<sitePrefix>/<page>"-Pfad
 * (ohne Traversal). Bei sitePrefix==="" ist der pagePath einfach "<page>"
 * top-level (kein Slash → kein Unterordner erlaubt).
 */
function pagePathBasename(ctx: HostCtx, pagePath: string): string | null {
  const sitePrefix = ctx.sitePrefix ?? "site";
  if (sitePrefix === "") {
    // Top-level: pagePath ist der reine Seitenname, keine Unterordner.
    if (pagePath.includes("/")) return null;
    return pagePath;
  }
  const prefix = `${sitePrefix}/`;
  if (!pagePath.startsWith(prefix)) return null;
  const rest = pagePath.slice(prefix.length);
  if (rest.includes("/")) return null; // keine Unterordner / Traversal
  return rest;
}
