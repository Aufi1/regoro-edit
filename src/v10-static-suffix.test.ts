/**
 * v10 — M3: Öffentliches Static-Serving + Suffix-Edit-Routing (/…/edit) +
 * Login-return mit Open-Redirect-Schutz.
 *
 * Getestet über handleEditorRequest gegen eine Fixture-Site (Single-Site-Modus:
 * sitePrefix="" → Seiten liegen top-level in siteDir). ctx mit gültiger
 * auth: TEST_AUTH; Cookie via issueCookie(TEST_AUTH).
 *
 * Contract (M3):
 *  1. GET /            → 200 rohes index.html (KEIN data-edit-idx / Overlay).
 *     GET /<page>.html → 200 roh; /styles.css → 200; /nichtda.html → 404;
 *     / ohne index → 404.
 *  2. Authed Suffix-Edit: GET /edit, GET /<page>.html/edit → 200 Edit-Ansicht.
 *  3. Unauth Suffix-Edit: → 302 nach /edit/login?return=<encoded original path>.
 *  4. API-Routen unauth → 404 (nicht 302): save/upload/versions/restore/version.
 *  5. fail-closed (auth=null): /edit, /<page>/edit, /edit/login → 404.
 *  6. Login-return Open-Redirect-Schutz: nur interne Pfade akzeptiert.
 *  7. Sicherheit bleibt: .regoro/auth.json, .git/config, encoded/traversal → 404,
 *     Hash nie im Body.
 *
 * Solange Auth-Dev host.ts/serve.ts noch implementiert, dürfen diese Tests rot
 * sein — sie sind gegen den FIXIERTEN Contract geschrieben.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as auth from "./auth.ts";
import * as host from "./host.ts";

// Kontrollierte pristine Seiten-Inhalte (markant, für rohen-Body-Vergleich).
const INDEX_HTML = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Home</title>
<link rel="stylesheet" href="/styles.css"></head>
<body><h1>WILLKOMMEN-ROH</h1><p>Statischer Index ohne Editor.</p></body></html>\n`;

const DATENSCHUTZ_HTML = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Datenschutz</title></head>
<body><h1>DATENSCHUTZ-ROH</h1></body></html>\n`;

const STYLES_CSS = `body { color: #14324f; }\n`;

const PAGE_WHITELIST = ["index.html", "datenschutz.html"];

const tmpRoots: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/**
 * Fixture-Site (Single-Site): index.html + datenschutz.html + styles.css direkt
 * in siteDir. Optional ohne index (für 404-Fall). Liefert HostCtx (sitePrefix="").
 */
function makeCtx(opts: { withIndex?: boolean; authValue?: auth.AuthConfig | null } = {}): host.HostCtx {
  const withIndex = opts.withIndex ?? true;
  const siteDir = makeTmpDir("regoro-v10-");
  if (withIndex) writeFileSync(join(siteDir, "index.html"), INDEX_HTML, "utf8");
  writeFileSync(join(siteDir, "datenschutz.html"), DATENSCHUTZ_HTML, "utf8");
  writeFileSync(join(siteDir, "styles.css"), STYLES_CSS, "utf8");
  return {
    repoRoot: siteDir,
    siteDir,
    pageWhitelist: PAGE_WHITELIST,
    auth: "authValue" in opts ? opts.authValue! : TEST_AUTH,
    sitePrefix: "",
  };
}

const TEST_PASSWORD = "testpw";
const TEST_AUTH: auth.AuthConfig = {
  hash: await auth.hashPassword(TEST_PASSWORD),
  secret: "testsecret-aaaaaaaaaaaaaaaaaaaaaaaa",
};

function call(ctx: host.HostCtx, method: string, path: string, init?: RequestInit): Promise<Response> {
  const url = new URL("http://localhost:8788" + path);
  const req = new Request(url, { method, ...init });
  return Promise.resolve(host.handleEditorRequest(req, url, ctx));
}

/** Gültiges Session-Cookie (Cookie-Header-Wert "regoro_edit=<token>"). */
function authCookie(): string {
  return auth.issueCookie(TEST_AUTH).split(";")[0]!;
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

// ===========================================================================
// 1. Öffentliches Static-Serving (ohne Auth-Cookie)
// ===========================================================================
describe("M3 — öffentliches Static-Serving (roh, ohne Auth)", () => {
  let ctx: host.HostCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  test("GET / → 200 rohes index.html, kein data-edit-idx / Overlay", async () => {
    const res = await call(ctx, "GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const body = await res.text();
    expect(body).toBe(INDEX_HTML);
    expect(body).not.toContain("data-edit-idx");
    expect(body).not.toContain("overlay.js");
    expect(body).not.toContain("__REGORO_EDIT__");
  });

  test("GET /datenschutz.html → 200 roh", async () => {
    const res = await call(ctx, "GET", "/datenschutz.html");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(DATENSCHUTZ_HTML);
    expect(body).not.toContain("data-edit-idx");
  });

  test("GET /styles.css → 200 (Asset)", async () => {
    const res = await call(ctx, "GET", "/styles.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/css");
  });

  test("GET /nichtda.html → 404", async () => {
    const res = await call(ctx, "GET", "/nichtda.html");
    expect(res.status).toBe(404);
  });

  test("GET / ohne index.html → 404", async () => {
    const noIndex = makeCtx({ withIndex: false });
    const res = await call(noIndex, "GET", "/");
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// 2. Suffix-Edit authed (mit Cookie)
// ===========================================================================
describe("M3 — Suffix-Edit authed", () => {
  let ctx: host.HostCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  test("GET /edit mit Cookie → 200 Edit-Ansicht (data-edit-idx + Overlay)", async () => {
    const res = await call(ctx, "GET", "/edit", { headers: { cookie: authCookie() } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("data-edit-idx");
    expect(body).toContain("overlay.js");
  });

  test("GET /datenschutz.html/edit mit Cookie → 200 Edit-Ansicht dieser Seite", async () => {
    const res = await call(ctx, "GET", "/datenschutz.html/edit", { headers: { cookie: authCookie() } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("data-edit-idx");
    // Inhalt der Datenschutz-Seite, nicht des Index.
    expect(body).toContain("DATENSCHUTZ-ROH");
  });
});

// ===========================================================================
// 3. Suffix-Edit UNAUTH → 302 nach /edit/login?return=<encoded path>
// ===========================================================================
describe("M3 — Suffix-Edit unauth → 302 auf Login mit return", () => {
  let ctx: host.HostCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  test("GET /edit ohne Cookie → 302, Location /edit/login?return=%2Fedit", async () => {
    const res = await call(ctx, "GET", "/edit");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/edit/login?return=%2Fedit");
  });

  test("GET /datenschutz.html/edit ohne Cookie → 302, return=%2Fdatenschutz.html%2Fedit", async () => {
    const res = await call(ctx, "GET", "/datenschutz.html/edit");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("/edit/login?return=")).toBe(true);
    expect(loc).toContain("return=%2Fdatenschutz.html%2Fedit");
  });
});

// ===========================================================================
// 4. API bleibt versteckt (unauth) → 404, NICHT 302
// ===========================================================================
describe("M3 — API-Routen unauth → 404 (nicht 302)", () => {
  let ctx: host.HostCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  const hex40 = "a".repeat(40);
  const apiRoutes: Array<[string, string]> = [
    ["POST", "/edit/save"],
    ["POST", "/edit/upload"],
    ["GET", "/edit/versions"],
    ["POST", "/edit/restore"],
    ["GET", `/edit/version/${hex40}`],
  ];

  for (const [method, path] of apiRoutes) {
    test(`${method} ${path} unauth → 404`, async () => {
      const res = await call(ctx, method, path);
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(302);
    });
  }
});

// ===========================================================================
// 5. fail-closed (ctx.auth = null) → alles 404
// ===========================================================================
describe("M3 — fail-closed bei auth=null", () => {
  let ctx: host.HostCtx;
  beforeEach(() => {
    ctx = makeCtx({ authValue: null });
  });

  test("GET /edit → 404", async () => {
    expect((await call(ctx, "GET", "/edit")).status).toBe(404);
  });

  test("GET /datenschutz.html/edit → 404", async () => {
    expect((await call(ctx, "GET", "/datenschutz.html/edit")).status).toBe(404);
  });

  test("GET /edit/login → 404", async () => {
    expect((await call(ctx, "GET", "/edit/login")).status).toBe(404);
  });
});

// ===========================================================================
// 6. Login-return Open-Redirect-Schutz
// ===========================================================================
describe("M3 — Login-return Open-Redirect-Schutz", () => {
  let ctx: host.HostCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  function loginWithReturn(returnVal: string): Promise<Response> {
    return call(ctx, "POST", "/edit/login?return=" + encodeURIComponent(returnVal), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=" + encodeURIComponent(TEST_PASSWORD),
    });
  }

  test("richtiges PW + return=/datenschutz.html/edit → 302 dorthin", async () => {
    const res = await loginWithReturn("/datenschutz.html/edit");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/datenschutz.html/edit");
  });

  test("return=https://evil.com → 302 auf Default /edit (kein extern)", async () => {
    const res = await loginWithReturn("https://evil.com");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/edit");
  });

  test("return=//evil.com → 302 auf Default /edit", async () => {
    const res = await loginWithReturn("//evil.com");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/edit");
  });

  test("return=/etc/passwd (nicht /edit-Whitelist) → 302 auf Default /edit", async () => {
    const res = await loginWithReturn("/etc/passwd");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/edit");
  });
});

// ===========================================================================
// 7. Sicherheit bleibt: Auth-Datei/.git nie öffentlich, Hash nie im Body
// ===========================================================================
describe("M3 — Sicherheit: Auth-Datei-/Dotfile-Web-Block", () => {
  let ctx: host.HostCtx;
  let argonHash: string;

  beforeEach(async () => {
    const siteDir = makeTmpDir("regoro-v10-sec-");
    writeFileSync(join(siteDir, "index.html"), INDEX_HTML, "utf8");
    writeFileSync(join(siteDir, "styles.css"), STYLES_CSS, "utf8");
    // Echte .regoro/auth.json anlegen.
    await auth.createAuthFile(siteDir, "site-pw");
    const loaded = auth.loadAuthFile(siteDir)!;
    argonHash = loaded.hash;
    // .git/config-Fixture.
    mkdirSync(join(siteDir, ".git"), { recursive: true });
    writeFileSync(join(siteDir, ".git", "config"), "[core]\n  bare = false\n");
    ctx = { repoRoot: siteDir, siteDir, pageWhitelist: PAGE_WHITELIST, auth: loaded, sitePrefix: "" };
  });

  async function expectBlocked(path: string): Promise<void> {
    const res = await call(ctx, "GET", path);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain(argonHash);
    expect(body).not.toContain("$argon2");
  }

  test("GET /.regoro/auth.json → 404, Hash nicht im Body", async () => {
    await expectBlocked("/.regoro/auth.json");
  });

  test("GET /%2eregoro/auth.json (encoded dot) → 404", async () => {
    await expectBlocked("/%2eregoro/auth.json");
  });

  test("GET /.regoro%2Fauth.json (encoded slash) → 404", async () => {
    await expectBlocked("/.regoro%2Fauth.json");
  });

  test("GET /assets/../.regoro/auth.json (traversal) → 404", async () => {
    await expectBlocked("/assets/../.regoro/auth.json");
  });

  test("GET /.git/config → 404", async () => {
    const res = await call(ctx, "GET", "/.git/config");
    expect(res.status).toBe(404);
  });
});
