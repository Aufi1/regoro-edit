/**
 * Red — Versions-Vorschau muss Asset-URLs root-absolut ausliefern (CSS lädt).
 *
 * Bug: GET /edit/version/<commit>?page= liefert das alte HTML aus showVersion
 * mit RELATIVEN Asset-Pfaden (href="styles.css", src="assets/…"), die unter
 * /edit/version/<commit> zu /edit/version/styles.css → 404 auflösen. Die normale
 * Edit-Ansicht (renderEditView) macht das per rewriteAssetUrls bereits — die
 * Versions-Vorschau noch nicht.
 *
 * Soll: dieselbe Asset-URL-Absolutierung wie die Edit-Ansicht; read-only bleibt
 * (kein data-edit-idx/Overlay nötig). <a href> + absolute/http(s)/#/data: bleiben.
 *
 * Phase "Red": die Vorschau hat noch relative Asset-URLs. Erwartet: rot.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
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

describe("host.ts — Versions-Vorschau liefert Asset-URLs root-absolut", () => {
  let host: typeof import("./host.ts");
  let auth: typeof import("./auth.ts");
  let git: typeof import("./git.ts");
  let ctx: import("./host.ts").HostCtx;
  const pagePath = "site/index.html";
  // Charakteristischer Text, der NUR in der alten committeten Version steht.
  const MARKER = "ALT-VERSION-MARKER-XYZ";

  beforeAll(async () => {
    host = await import("./host.ts");
    auth = await import("./auth.ts");
    git = await import("./git.ts");
  });

  beforeEach(() => {
    const repoRoot = makeTmpDir("regoro-vpreview-");
    const siteDir = join(repoRoot, "site");
    mkdirSync(siteDir, { recursive: true });
    cpSync(REAL_SITE, siteDir, { recursive: true });
    git.ensureRepo(repoRoot);

    // Eine alte Version mit Marker-Text + relativen Asset-URLs committen.
    const oldHtml =
      "<!doctype html><html lang=\"de\"><head>" +
      "<meta charset=\"utf-8\">" +
      "<link rel=\"stylesheet\" href=\"styles.css\">" +
      "</head><body>" +
      `<h1>${MARKER}</h1>` +
      "<img src=\"assets/logo.webp\" alt=\"Logo\">" +
      "<p>Mehr unter <a href=\"datenschutz.html\">Datenschutz</a> und " +
      "<a href=\"https://extern.example\">extern</a>.</p>" +
      "</body></html>";
    writeFileSync(join(repoRoot, pagePath), oldHtml, "utf8");
    git.commitEdit(repoRoot, pagePath, "Alte Version mit Marker");

    ctx = { repoRoot, siteDir, pageWhitelist: PAGE_WHITELIST, auth: TEST_AUTH };
  });

  function authCookie(): string {
    return auth.issueCookie(TEST_AUTH).split(";")[0]!;
  }
  function call(method: string, path: string, cookie?: string): Promise<Response> {
    const url = new URL("http://localhost:8788" + path);
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    const req = new Request(url, { method, headers });
    return Promise.resolve(host.handleEditorRequest(req, url, ctx));
  }
  function latestCommit(): string {
    return git.listVersions(ctx.repoRoot, pagePath)[0]!.commit;
  }

  test("Stylesheet-Link ist /styles.css (absolut), nicht relativ styles.css", async () => {
    const cookie = authCookie();
    const commit = latestCommit();
    const res = await call("GET", `/edit/version/${commit}?page=index.html`, cookie);
    expect(res.status).toBe(200);
    const body = await res.text();
    // root-absolut
    expect(body).toContain('href="/styles.css"');
    // nicht mehr relativ (kein href="styles.css" ohne führenden Slash)
    expect(body).not.toMatch(/href="styles\.css"/);
  });

  test("Bild-src ist /assets/… (absolut), nicht relativ assets/…", async () => {
    const cookie = authCookie();
    const commit = latestCommit();
    const body = await (await call("GET", `/edit/version/${commit}?page=index.html`, cookie)).text();
    expect(body).toContain('src="/assets/logo.webp"');
    expect(body).not.toMatch(/src="assets\//);
  });

  test("<a href> + externe/absolute URLs bleiben unverändert", async () => {
    const cookie = authCookie();
    const commit = latestCommit();
    const body = await (await call("GET", `/edit/version/${commit}?page=index.html`, cookie)).text();
    // Navigations-Link (relativer <a href>) bleibt relativ — NICHT absolutiert.
    expect(body).toContain('href="datenschutz.html"');
    // Externer Link bleibt exakt.
    expect(body).toContain('href="https://extern.example"');
  });

  test("Gegenprobe: Vorschau zeigt den echten alten Versions-Inhalt (Marker vorhanden)", async () => {
    const cookie = authCookie();
    const commit = latestCommit();
    const body = await (await call("GET", `/edit/version/${commit}?page=index.html`, cookie)).text();
    expect(body).toContain(MARKER); // richtige Version, nur Assets absolut
  });

  test("Header noindex/no-store bleiben gesetzt", async () => {
    const cookie = authCookie();
    const commit = latestCommit();
    const res = await call("GET", `/edit/version/${commit}?page=index.html`, cookie);
    expect((res.headers.get("x-robots-tag") ?? "").toLowerCase()).toContain("noindex");
    expect((res.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");
  });

  test("ohne Cookie → 404 (Auth-Wall unverändert)", async () => {
    const commit = latestCommit();
    const res = await call("GET", `/edit/version/${commit}?page=index.html`);
    expect(res.status).toBe(404);
  });
});
