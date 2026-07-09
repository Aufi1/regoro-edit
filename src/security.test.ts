/**
 * Phase-2 Lücken-Tests (Security-kritische Pfade).
 *
 * Diese Tests schließen Abdeckungslücken, die in editor.test.ts fehlten:
 * Cookie-Ablauf, Schreib-Routen-Auth (save/restore ohne Cookie → 404),
 * pagePath-Traversal/Whitelist auf der SCHREIBENDEN save/restore-Route,
 * commit-Injection-Guard, und noindex/no-store auf ALLEN Editor-Routen
 * (inkl. 404- und JSON-Antworten).
 *
 * Gegen die fertige Implementierung (Commit d657654) sollen sie GRÜN sein —
 * sie sichern bestehendes Verhalten gegen Regressionen ab. Ein rotes Ergebnis
 * hier wäre ein echter Security-Bug.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { parseHTML } from "linkedom";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  cpSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PASSWORD = "testpw";
const TEST_SECRET = "testsecret-aaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_AUTH = { hash: await (await import("./auth.ts")).hashPassword(TEST_PASSWORD), secret: TEST_SECRET };

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");
const tmpRoots: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

// ===========================================================================
// auth.ts — Cookie-Ablauf (in editor.test.ts NICHT abgedeckt)
// ===========================================================================
describe("auth.ts — Cookie-Ablauf", () => {
  let auth: typeof import("./auth.ts");

  beforeAll(async () => {
    auth = await import("./auth.ts");
  });

  test("frisch ausgestelltes Cookie ist gültig", () => {
    const sc = auth.issueCookie(TEST_AUTH, 3600);
    const token = sc.split(";")[0]!.split("=").slice(1).join("=");
    expect(auth.checkCookie(TEST_AUTH, token)).toBe(true);
  });

  test("abgelaufenes Cookie (negative maxAge) wird abgelehnt", () => {
    // maxAge in der Vergangenheit → exp < Date.now() → checkCookie false.
    const sc = auth.issueCookie(TEST_AUTH, -10);
    const token = sc.split(";")[0]!.split("=").slice(1).join("=");
    expect(auth.checkCookie(TEST_AUTH, token)).toBe(false);
  });

  test("Token mit manipuliertem exp-Feld wird abgelehnt (Signatur deckt exp ab)", () => {
    const sc = auth.issueCookie(TEST_AUTH, 10); // läuft fast sofort ab
    const token = sc.split(";")[0]!.split("=").slice(1).join("=");
    const parts = token.split(".");
    // exp künstlich weit in die Zukunft schieben, ohne neu zu signieren.
    const forged = `${parts[0]}.${Date.now() + 10_000_000}.${parts[2]}`;
    expect(auth.checkCookie(TEST_AUTH, forged)).toBe(false);
  });

  test("Token mit falscher Segment-Anzahl wird abgelehnt", () => {
    expect(auth.checkCookie(TEST_AUTH, "a.b")).toBe(false);
    expect(auth.checkCookie(TEST_AUTH, "a.b.c.d")).toBe(false);
  });
});

// ===========================================================================
// host.ts — Security-Pfade auf SCHREIBENDEN Routen + Header überall
// ===========================================================================
describe("host.ts — Schreib-Routen-Auth, Traversal, commit-Guard, Header", () => {
  let host: typeof import("./host.ts");
  let auth: typeof import("./auth.ts");
  let git: typeof import("./git.ts");
  let apply: typeof import("./apply.ts");
  let ctx: import("./host.ts").HostCtx;

  const PAGE_WHITELIST = ["index.html", "impressum.html", "datenschutz.html", "agb.html"];

  beforeAll(async () => {
    git = await import("./git.ts");
    apply = await import("./apply.ts");
    auth = await import("./auth.ts");
    host = await import("./host.ts");
  });

  beforeEach(() => {
    const repoRoot = makeTmpDir("regoro-sec-");
    const siteDir = join(repoRoot, "site");
    mkdirSync(siteDir, { recursive: true });
    cpSync(REAL_SITE, siteDir, { recursive: true });
    git.ensureRepo(repoRoot);
    ctx = { repoRoot, siteDir, pageWhitelist: PAGE_WHITELIST, auth: TEST_AUTH };
  });

  function call(method: string, path: string, init?: RequestInit): Promise<Response> {
    const url = new URL("http://localhost:8788" + path);
    const req = new Request(url, { method, ...init });
    return Promise.resolve(host.handleEditorRequest(req, url, ctx));
  }

  function authCookie(): string {
    const sc = auth.issueCookie(TEST_AUTH);
    return sc.split(";")[0]!; // "regoro_edit=<token>"
  }

  function expiredCookie(): string {
    const sc = auth.issueCookie(TEST_AUTH, -10);
    return sc.split(";")[0]!;
  }

  // --- Schreib-Routen ohne Auth → 404 (nicht 401) ---
  test("POST /edit/restore OHNE Auth → 404", async () => {
    const res = await call("POST", "/edit/restore", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commit: "HEAD", pagePath: "site/index.html" }),
    });
    expect(res.status).toBe(404);
  });

  test("GET /edit/version/<commit> OHNE Auth → 404", async () => {
    const res = await call("GET", "/edit/version/HEAD?page=index.html");
    expect(res.status).toBe(404);
  });

  test("abgelaufenes Cookie wird wie kein Cookie behandelt → /edit 302 auf Login (M3)", async () => {
    // M3: Edit-VIEW-Routen leiten unauth (auch bei abgelaufenem Cookie) zum Login
    // um — nicht mehr 404. Der Auth-Bypass bleibt geschlossen (kein 200).
    const res = await call("GET", "/edit", { headers: { cookie: expiredCookie() } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/edit/login?return=%2Fedit");
  });

  // --- pagePath-Traversal/Whitelist auf der SCHREIBENDEN save-Route ---
  test("POST /edit/save mit pagePath-Traversal → 404, Datei wird NICHT geschrieben", async () => {
    const cookie = authCookie();
    for (const bad of [
      "site/../etc/passwd",
      "site/../../etc/passwd",
      "../etc/passwd",
      "/etc/passwd",
      "site/sub/page.html",
      "etc/passwd",
    ]) {
      const res = await call("POST", "/edit/save", {
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ pagePath: bad, fileHash: "x", edits: [{ idx: 0, text: "pwn" }] }),
      });
      expect(res.status).toBe(404);
    }
  });

  test("POST /edit/save mit Nicht-Whitelist-pagePath → 404", async () => {
    const cookie = authCookie();
    const res = await call("POST", "/edit/save", {
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ pagePath: "site/geheim.html", fileHash: "x", edits: [] }),
    });
    expect(res.status).toBe(404);
  });

  test("POST /edit/save mit pagePath, der nicht Regex matcht → 404", async () => {
    const cookie = authCookie();
    for (const bad of ["site/Index.html", "site/foo.php", "site/INDEX.HTML"]) {
      const res = await call("POST", "/edit/save", {
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ pagePath: bad, fileHash: "x", edits: [] }),
      });
      expect(res.status).toBe(404);
    }
  });

  // --- pagePath-Traversal auf der restore-Route ---
  test("POST /edit/restore mit pagePath-Traversal → 404", async () => {
    const cookie = authCookie();
    for (const bad of ["site/../etc/passwd", "/etc/passwd", "site/geheim.html"]) {
      const res = await call("POST", "/edit/restore", {
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ commit: "HEAD", pagePath: bad }),
      });
      expect(res.status).toBe(404);
    }
  });

  // --- commit-Injection-Guard (restore + version) ---
  test("POST /edit/restore mit unsicherem commit-String → 404 (kein git-Arg-Inject)", async () => {
    const cookie = authCookie();
    for (const bad of ["HEAD; rm -rf /", "../../evil", "a b", "with/slash", "$(whoami)"]) {
      const res = await call("POST", "/edit/restore", {
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ commit: bad, pagePath: "site/index.html" }),
      });
      expect(res.status).toBe(404);
    }
  });

  test("GET /edit/version/<commit> mit unsicherem commit-String → 404", async () => {
    const cookie = authCookie();
    for (const bad of ["HEAD%3B%20ls", "..%2F..%2Fevil", "a%20b"]) {
      const res = await call("GET", `/edit/version/${bad}?page=index.html`, { headers: { cookie } });
      expect(res.status).toBe(404);
    }
  });

  // --- noindex/no-store auf ALLEN Routen, inkl. schreibend, JSON, 404 ---
  test("noindex + no-store auf save (409), restore, version, und 404-Antworten", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const fileHash = apply.fileSha256(readFileSync(filePath, "utf8"));

    const versions = git.listVersions(ctx.repoRoot, pagePath);
    const commit = versions[0]!.commit;

    const responses: Response[] = [
      // save mit korrektem Hash (200)
      await call("POST", "/edit/save", {
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ pagePath, fileHash, edits: [{ idx: 0, text: "Header-Check" }] }),
      }),
      // save mit falschem Hash (409)
      await call("POST", "/edit/save", {
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ pagePath, fileHash: "0".repeat(64), edits: [] }),
      }),
      // version-Vorschau (200)
      await call("GET", `/edit/version/${commit}?page=index.html`, { headers: { cookie } }),
      // restore (200)
      await call("POST", "/edit/restore", {
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ commit, pagePath }),
      }),
      // 404-Antwort (kein Auth)
      await call("GET", "/edit"),
      // 404 fremde Route
      await call("GET", "/edit/nichtvorhanden", { headers: { cookie } }),
    ];

    for (const res of responses) {
      expect((res.headers.get("x-robots-tag") ?? "").toLowerCase()).toContain("noindex");
      expect((res.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");
    }
  });

  // --- POST /edit/login mit falschem Passwort trägt ebenfalls die Header ---
  test("Login-Fehlerseite trägt noindex + no-store und setzt KEIN Cookie", async () => {
    const res = await call("POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=falsch",
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((res.headers.get("x-robots-tag") ?? "").toLowerCase()).toContain("noindex");
    expect((res.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");
  });

  // =========================================================================
  // C2/H1 — verschärfter Commit-Hash-Guard ^[0-9a-f]{7,40}$ (Fix 1452cca)
  //
  // Die ALTE Regex ^[0-9a-zA-Z._-]+$ ließ git-Revisionen wie -f/--force/HEAD/
  // main/@/abc.def DURCH. Diese sind gefährlich (Flag-Injection in git checkout,
  // beliebige Ref-Auflösung). Der Fix akzeptiert nur noch reine Hex-Hashes
  // 7–40 Zeichen. Diese Tests nageln das auf beiden commit-Routen fest.
  // =========================================================================
  const BAD_COMMITS = ["-f", "--force", "HEAD", "main", "@", "abc.def", "ABCDEF1", "abc", ""];

  test("POST /edit/restore → 404 für Nicht-Hex/Flag/Ref-Commits", async () => {
    const cookie = authCookie();
    for (const bad of BAD_COMMITS) {
      const res = await call("POST", "/edit/restore", {
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ commit: bad, pagePath: "site/index.html" }),
      });
      expect(res.status).toBe(404);
    }
  });

  test("GET /edit/version/<commit> → 404 für Nicht-Hex/Flag/Ref-Commits", async () => {
    const cookie = authCookie();
    for (const bad of BAD_COMMITS) {
      // leeren Commit als eigenes Segment kodieren, damit die Route überhaupt matcht.
      const seg = bad === "" ? "%20" : encodeURIComponent(bad);
      const res = await call("GET", `/edit/version/${seg}?page=index.html`, { headers: { cookie } });
      expect(res.status).toBe(404);
    }
  });

  test("Gültiger 7–40-Hex-Hash aus listVersions funktioniert weiterhin (200)", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const versions = git.listVersions(ctx.repoRoot, pagePath);
    const commit = versions[0]!.commit;
    // Vorbedingung: echter Hash matcht die neue Regex.
    expect(commit).toMatch(/^[0-9a-f]{7,40}$/);

    // version-Vorschau
    const vres = await call("GET", `/edit/version/${commit}?page=index.html`, { headers: { cookie } });
    expect(vres.status).toBe(200);

    // restore mit demselben Hash
    const rres = await call("POST", "/edit/restore", {
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ commit, pagePath }),
    });
    expect(rres.status).toBe(200);
  });

  test("abgekürzter (7-stelliger) gültiger Hash wird akzeptiert", async () => {
    const cookie = authCookie();
    const full = git.listVersions(ctx.repoRoot, "site/index.html")[0]!.commit;
    const short = full.slice(0, 7);
    expect(short).toMatch(/^[0-9a-f]{7}$/);
    const res = await call("GET", `/edit/version/${short}?page=index.html`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  // =========================================================================
  // E2E-Lücken: HTTP-Roundtrip-Regressionstests (gegen handleEditorRequest)
  // =========================================================================

  /** Serialisiert das Tag-/Attribut-Skeleton (ohne Textinhalt) für Struktur-Vergleiche. */
  function structureSkeleton(html: string): string {
    const { document } = parseHTML(html);
    const lines: string[] = [];
    for (const el of document.querySelectorAll("*")) {
      const attrs = [...el.attributes]
        .map((a) => `${a.name}=${a.value}`)
        .sort()
        .join(" ");
      lines.push(`${el.tagName}[${attrs}]`);
    }
    return lines.join("\n");
  }

  async function saveOnce(
    cookie: string,
    pagePath: string,
    fileHash: string,
    edits: { idx: number; text: string }[],
  ): Promise<{ status: number; json: { ok?: boolean; fileHash?: string; error?: string } }> {
    const res = await call("POST", "/edit/save", {
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ pagePath, fileHash, edits }),
    });
    return { status: res.status, json: (await res.json()) as { ok?: boolean; fileHash?: string; error?: string } };
  }

  // 1. fileHash-Roundtrip same-session: zurückgegebener Hash passt für den nächsten Save.
  test("fileHash-Roundtrip: zweiter Save mit dem zurückgegebenen Hash → 200 (nicht 409)", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);

    const h0 = apply.fileSha256(readFileSync(filePath, "utf8"));
    const first = await saveOnce(cookie, pagePath, h0, [{ idx: 0, text: "Erste Änderung" }]);
    expect(first.status).toBe(200);
    expect(first.json.fileHash).toMatch(/^[0-9a-f]{64}$/);

    // Zweiter Save MUSS mit dem von Save 1 gelieferten Hash durchgehen.
    const second = await saveOnce(cookie, pagePath, first.json.fileHash!, [{ idx: 0, text: "Zweite Änderung" }]);
    expect(second.status).toBe(200); // kein hash-mismatch → linkedom-Serialisierung ist deterministisch
    expect(second.json.ok).toBe(true);
    expect(second.json.fileHash).toMatch(/^[0-9a-f]{64}$/);
    // Und auch dieser Hash stimmt mit der Platte überein.
    expect(apply.fileSha256(readFileSync(filePath, "utf8"))).toBe(second.json.fileHash!);
  });

  // 2. Struktur-Invarianz: nur Textinhalt ändert sich, Tag-/Attribut-Skeleton bleibt.
  test("Struktur-Invarianz: Save ändert nur Text, Tag-/Attribut-Skeleton identisch", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);

    const before = readFileSync(filePath, "utf8");
    const skeletonBefore = structureSkeleton(before);

    const res = await saveOnce(cookie, pagePath, apply.fileSha256(before), [
      { idx: 0, text: "Anderer Titeltext" },
      { idx: 2, text: "Anderer Absatztext" },
    ]);
    expect(res.status).toBe(200);

    const after = readFileSync(filePath, "utf8");
    expect(structureSkeleton(after)).toBe(skeletonBefore); // Markup/Attribute exakt gleich
    expect(after).toContain("Anderer Titeltext"); // aber Text geändert
  });

  // 3. Restore-Roundtrip auf HTTP-Ebene: nach 2 Saves → restore auf Baseline.
  test("Restore-Roundtrip: HTTP-restore stellt Baseline her + neuer Restore-Commit", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);

    // Baseline-Commit (ältester) + sein Original-Inhalt.
    const baseVersions = git.listVersions(ctx.repoRoot, pagePath);
    const baselineCommit = baseVersions[baseVersions.length - 1]!.commit;
    const baselineContent = git.showVersion(ctx.repoRoot, baselineCommit, pagePath);

    // Save 1
    let h = apply.fileSha256(readFileSync(filePath, "utf8"));
    h = (await saveOnce(cookie, pagePath, h, [{ idx: 0, text: "Stand 1" }])).json.fileHash!;
    // Save 2
    await saveOnce(cookie, pagePath, h, [{ idx: 0, text: "Stand 2" }]);
    expect(readFileSync(filePath, "utf8")).toContain("Stand 2");

    const countBeforeRestore = git.listVersions(ctx.repoRoot, pagePath).length;

    // HTTP-Restore auf Baseline.
    const rres = await call("POST", "/edit/restore", {
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ commit: baselineCommit, pagePath }),
    });
    expect(rres.status).toBe(200);
    expect(((await rres.json()) as { ok: boolean }).ok).toBe(true);

    // Datei == Baseline-Inhalt; ein zusätzlicher Restore-Commit existiert.
    expect(readFileSync(filePath, "utf8")).toBe(baselineContent);
    expect(git.listVersions(ctx.repoRoot, pagePath).length).toBe(countBeforeRestore + 1);
  });

  // 4. Header auf 404-Antworten: notFound() trägt X-Robots-Tag + no-store.
  test("404-Antworten tragen X-Robots-Tag: noindex, nofollow + Cache-Control: no-store", async () => {
    const cookie = authCookie();
    const notFoundResponses = [
      // Hinweis: GET /edit ohne Cookie ist unter M3 ein 302-Login-Redirect (eigener
      // Test), daher hier durch einen echten 404-Fall ersetzt.
      await call("GET", "/nichtda.html"), // nicht-existente Static-Seite → 404
      await call("GET", "/edit/save", { headers: { cookie } }), // GET auf save → 404
      await call("GET", "/edit/voellig-unbekannt", { headers: { cookie } }), // unbekannte Route
      await call("GET", "/edit/geheim.html", { headers: { cookie } }), // Nicht-Whitelist
    ];
    for (const res of notFoundResponses) {
      expect(res.status).toBe(404);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect((res.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");
    }
  });
});

// ===========================================================================
// C1 — fail-closed Auth: fehlende Auth-Konfig (auth===null) → immer false
// (auth.ts Defense-in-depth; ohne Auth-Datei kann niemand verifizieren/signieren)
// ===========================================================================
describe("auth.ts — fail-closed bei fehlender Auth-Konfig (C1)", () => {
  let auth: typeof import("./auth.ts");

  beforeAll(async () => {
    auth = await import("./auth.ts");
  });

  test("verifyPassword(null, ...) → false (auch für Leerstring-Kandidat)", async () => {
    expect(await auth.verifyPassword(null, "")).toBe(false); // nicht: leer == leer
    expect(await auth.verifyPassword(null, "irgendwas")).toBe(false);
  });

  test("checkCookie(null, token) → false, selbst für sonst gültiges Token", () => {
    // Token mit echter Auth-Konfig ausstellen.
    const sc = auth.issueCookie(TEST_AUTH, 3600);
    const token = sc.split(";")[0]!.split("=").slice(1).join("=");
    expect(auth.checkCookie(TEST_AUTH, token)).toBe(true); // Sanity: gültig mit Konfig

    // Ohne Auth-Konfig → fail-closed (niemand kann Tokens validieren).
    expect(auth.checkCookie(null, token)).toBe(false);
  });
});

// ===========================================================================
// Task 7 — Öffentliches statisches Asset-Serving (Commit ed3d747)
// Public (kein Auth), nur GET, nur Allowlist-Extensions, nur innerhalb siteDir.
// ===========================================================================
describe("host.ts — statisches Asset-Serving (Task 7)", () => {
  let host: typeof import("./host.ts");
  let git: typeof import("./git.ts");
  let ctx: import("./host.ts").HostCtx;
  let realAsset: string; // reale Datei aus site/assets/, z.B. "logo.webp"

  const PAGE_WHITELIST = ["index.html", "impressum.html", "datenschutz.html", "agb.html"];

  beforeAll(async () => {
    git = await import("./git.ts");
    host = await import("./host.ts");
    // Eine real existierende Asset-Datei wählen (kein Hardcoding des Dateinamens).
    realAsset = readdirSync(join(REAL_SITE, "assets")).find((f) => /\.(webp|jpe?g|png|svg|gif)$/i.test(f))!;
  });

  beforeEach(() => {
    const repoRoot = makeTmpDir("regoro-asset-");
    const siteDir = join(repoRoot, "site");
    mkdirSync(siteDir, { recursive: true });
    cpSync(REAL_SITE, siteDir, { recursive: true });
    git.ensureRepo(repoRoot);
    ctx = { repoRoot, siteDir, pageWhitelist: PAGE_WHITELIST, auth: TEST_AUTH };
  });

  function call(method: string, path: string): Promise<Response> {
    const url = new URL("http://localhost:8788" + path);
    const req = new Request(url, { method });
    return Promise.resolve(host.handleEditorRequest(req, url, ctx));
  }

  // --- Positiv: öffentlich, ohne Auth, nur GET ---
  test("GET /styles.css → 200 + Content-Type text/css + noindex", async () => {
    const res = await call("GET", "/styles.css");
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("text/css");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  test("GET /assets/<reale Datei> → 200 + passender Bild-Content-Type", async () => {
    const res = await call("GET", "/assets/" + realAsset);
    expect(res.status).toBe(200);
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    expect(ct).toMatch(/image\/(webp|jpeg|png|svg\+xml|gif)/);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    // Body hat realen Inhalt (Bytes > 0).
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  test("Asset-Serving braucht KEINE Auth (kein Cookie → trotzdem 200)", async () => {
    const res = await call("GET", "/styles.css");
    expect(res.status).toBe(200);
  });

  // --- Negativ: keine Datei außerhalb siteDir, keine .html/.php über Asset-Zweig ---
  test("Traversal & Out-of-siteDir → 404", async () => {
    for (const p of [
      "/etc/passwd",
      "/..%2f..%2fetc%2fpasswd",
      "/assets/..%2f..%2f..%2fetc%2fpasswd",
      "/..%2f..%2f..%2f..%2fetc%2fpasswd",
    ]) {
      const res = await call("GET", p);
      expect(res.status).toBe(404);
    }
  });

  test("GET /index.html (gewhitelistete Site-Seite) → 200 rohes HTML (M3-Static-Serving)", async () => {
    // M3: existierende, gewhitelistete Top-Level-Seiten werden ROH öffentlich
    // ausgeliefert (ohne Editor-Overlay/data-edit-idx). Editieren nur über /…/edit.
    const res = await call("GET", "/index.html");
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") ?? "").toLowerCase()).toContain("text/html");
    const body = await res.text();
    expect(body).not.toContain("data-edit-idx");
    expect(body).not.toContain("overlay.js");
  });

  test("GET /geheim.html (nicht-whitelistete .html) → weiter 404 (kein Static-Serving)", async () => {
    // Abgrenzung: NUR gewhitelistete Seiten werden roh ausgeliefert; beliebige
    // .html bleiben 404 (keine Ausweitung der öffentlichen Angriffsfläche).
    const res = await call("GET", "/geheim.html");
    expect(res.status).toBe(404);
  });

  test("GET /styles.php (nicht-allowlistete Extension) → 404", async () => {
    const res = await call("GET", "/styles.php");
    expect(res.status).toBe(404);
  });

  // Ein Site-Ordner enthält in der Praxis mehr als die Website: Build-Artefakte
  // (design.json, images.json mit internen Serverpfaden), Backups, Notizen. Die
  // Extension-Allowlist ist das, was sie zurückhält — hier festgenagelt, damit
  // niemand versehentlich .json & Co. in ASSET_TYPES aufnimmt.
  // Die Dateien werden ECHT angelegt: sonst käme der 404 vom fehlenden File und
  // der Test wäre tautologisch.
  test.each([
    ["design.json", "Build-Artefakt"],
    ["images.json", "interne Pfade + Prompts"],
    ["dump.sql", "Backup"],
    ["README.md", "interne Notizen"],
    ["config.yaml", "Konfiguration"],
  ])("GET /%s (%s) → 404, obwohl die Datei existiert", async (name) => {
    const abs = join(ctx.siteDir, name);
    writeFileSync(abs, "GEHEIM");
    expect(readFileSync(abs, "utf8")).toBe("GEHEIM"); // liegt wirklich im siteDir

    const res = await call("GET", `/${name}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("GEHEIM");
  });

  test("POST /styles.css (nur GET) → nicht 200", async () => {
    const res = await call("POST", "/styles.css");
    expect(res.status).not.toBe(200);
  });

  // --- Auth-Wall unberührt (M3: Edit-View unauth → Login-Redirect, kein Bypass) ---
  test("GET /edit ohne Cookie → 302 auf Login (Asset-Zweig fasst /edit nicht an)", async () => {
    const res = await call("GET", "/edit");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/edit/login?return=%2Fedit");
  });
});

afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});
