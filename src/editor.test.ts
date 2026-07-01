/**
 * Phase-1 Tests (Red) für den Inline-Editor von regoro.de.
 *
 * Diese Tests prüfen die in den CONTRACTS festgelegten Interfaces. Die
 * Implementierungs-Module (contract.ts, serve.ts, apply.ts, git.ts, host.ts,
 * auth.ts) existieren in Phase 1 NOCH NICHT — die Tests schlagen also beim
 * Import ("Cannot find module ...") fehl. Das ist das erwartete Red.
 *
 * Setup-Env MUSS vor den (dynamischen) Imports von host/auth gesetzt werden.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { parseHTML } from "linkedom";
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Auth-Env VOR allen Host/Auth-Imports setzen ---------------------------
const TEST_PASSWORD = "testpw";
const TEST_SECRET = "testsecret-aaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_AUTH = { hash: await (await import("./auth.ts")).hashPassword(TEST_PASSWORD), secret: TEST_SECRET };

// Pfad zur echten site/ im Repo (Read-only Quelle für Fixtures).
const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");

// Sammelort für tmp-Repos, am Ende aufgeräumt.
const tmpRoots: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/**
 * Legt ein frisches tmp-Git-Repo mit einer Kopie von site/ an und committet
 * eine Baseline. Liefert { repoRoot, siteDir }.
 */
function makeSiteRepoFixture(gitMod: typeof import("./git.ts")): { repoRoot: string; siteDir: string } {
  const repoRoot = makeTmpDir("regoro-fixture-");
  const siteDir = join(repoRoot, "site");
  mkdirSync(siteDir, { recursive: true });
  cpSync(REAL_SITE, siteDir, { recursive: true });
  gitMod.ensureRepo(repoRoot);
  return { repoRoot, siteDir };
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
// Contract A — Kern: enumerateEditableTextNodes (v2)
// ===========================================================================
// HINWEIS v2: Das Leaf-ELEMENT-Modell (enumerateEditable + EDITABLE_TAGS,
// childElementCount===0, Tag-Whitelist) wurde durch Text-Node-Adressierung
// ersetzt. Die alten Tests dieses Blocks (EDITABLE_TAGS-Whitelist, "Leaf-Regel
// <p> aus / <a> drin", "Nicht-Whitelist-Tags (div)", "agb H2 editierbar/MAIN
// nicht") sind OBSOLET und wurden entfernt. Die generischen Eigenschaften
// (Determinismus, whitespace-Ausschluss, Mixed-Content) leben jetzt gegen
// enumerateEditableTextNodes weiter (Detail-Tests in editor/v2.test.ts).
describe("contract.ts — enumerateEditableTextNodes (v2 Text-Node-Modell)", () => {
  test("Determinismus: zweimal parsen → identische Anzahl + Reihenfolge", async () => {
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const html = readFileSync(join(REAL_SITE, "index.html"), "utf8");

    const a = enumerateEditableTextNodes(parseHTML(html).document).map((n) => n.textContent);
    const b = enumerateEditableTextNodes(parseHTML(html).document).map((n) => n.textContent);

    expect(a.length).toBe(b.length);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  test("Mixed-Content: <p>Text <a>x</a></p> → direkter Text UND Link-Text editierbar", async () => {
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const { document } = parseHTML(
      "<!doctype html><html><body><p>Text <a href='#'>x</a></p></body></html>",
    );
    const texts = enumerateEditableTextNodes(document).map((n) => n.textContent);
    expect(texts).toContain("Text "); // direkter <p>-Text
    expect(texts).toContain("x"); // Link-Text
  });

  test("whitespace-only Text-Nodes sind nicht editierbar", async () => {
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const { document } = parseHTML(
      "<!doctype html><html><body><p></p><p>   </p><p>\n\t</p><p>echt</p></body></html>",
    );
    const texts = enumerateEditableTextNodes(document).map((n) => n.textContent);
    expect(texts).toEqual(["echt"]);
  });

  test("agb.html: §-Überschriften-Text editierbar (Text-Node statt Leaf-Element)", async () => {
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const html = readFileSync(join(REAL_SITE, "agb.html"), "utf8");
    const texts = enumerateEditableTextNodes(parseHTML(html).document).map((n) => n.textContent?.trim());
    expect(texts).toContain("Allgemeine Geschäftsbedingungen (AGB)");
  });
});

// ===========================================================================
// Contract A — Kern: renderEditView
// ===========================================================================
describe("serve.ts — renderEditView", () => {
  const opts = { pagePath: "site/index.html", fileHash: "deadbeef", scriptUrl: "/edit-assets/overlay.js" };

  test("injiziert data-edit-idx, scriptUrl-Tag und window.__REGORO_EDIT__", async () => {
    const { renderEditView } = await import("./serve.ts");
    const html = readFileSync(join(REAL_SITE, "index.html"), "utf8");
    const out = renderEditView(html, opts);

    expect(out).toContain('data-edit-idx="0"');
    expect(out).toContain(opts.scriptUrl);
    expect(out).toContain("window.__REGORO_EDIT__");
    expect(out).toContain(opts.pagePath);
    expect(out).toContain(opts.fileHash);
  });

  test("data-edit-idx ist fortlaufend ab 0 und so viele wie editierbare Text-Nodes", async () => {
    const { renderEditView } = await import("./serve.ts");
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const html = readFileSync(join(REAL_SITE, "index.html"), "utf8");
    const n = enumerateEditableTextNodes(parseHTML(html).document).length;

    const out = renderEditView(html, opts);
    const idxs = [...out.matchAll(/data-edit-idx="(\d+)"/g)].map((m) => Number(m[1]));
    expect(idxs.length).toBe(n);
    expect(idxs[0]).toBe(0);
    expect(idxs[idxs.length - 1]).toBe(n - 1);
  });

  test("sichtbarer Text bleibt unverändert", async () => {
    const { renderEditView } = await import("./serve.ts");
    const html = readFileSync(join(REAL_SITE, "index.html"), "utf8");
    const out = renderEditView(html, opts);
    // Charakteristischer Seitentext muss erhalten bleiben (auch durch Span-Wrapping).
    expect(out).toContain("direkt im Browser bearbeitest");
    expect(out).toContain("Über uns");

    // Re-Parse: derselbe editierbare Text wie im Original (Text-Node-Walk).
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const before = enumerateEditableTextNodes(parseHTML(html).document).map((n) => n.textContent);
    const after = enumerateEditableTextNodes(parseHTML(out).document).map((n) => n.textContent);
    expect(after).toEqual(before);
  });

  test("kein Disk-Write: liefert nur einen String zurück", async () => {
    const { renderEditView } = await import("./serve.ts");
    const out = renderEditView("<!doctype html><html><body><p>hi</p></body></html>", opts);
    expect(typeof out).toBe("string");
    expect(out).toContain('data-edit-idx="0"');
  });
});

// ===========================================================================
// Contract A — Kern: applyEdits / fileSha256
// ===========================================================================
describe("apply.ts — applyEdits / fileSha256", () => {
  const HTML =
    "<!doctype html><html><body><h1>Alt-Titel</h1><p>Erster Absatz</p><p>Zweiter Absatz</p></body></html>";

  test("ändert genau den Ziel-Text-Node per idx, alle anderen identisch", async () => {
    const { applyEdits } = await import("./apply.ts");
    const { enumerateEditableTextNodes } = await import("./contract.ts");

    const before = enumerateEditableTextNodes(parseHTML(HTML).document).map((n) => n.textContent);
    const { html: out, applied } = applyEdits(HTML, [{ idx: 1, text: "Neuer erster Absatz" }]);
    expect(applied).toBe(1);

    const after = enumerateEditableTextNodes(parseHTML(out).document).map((n) => n.textContent);
    expect(after[0]).toBe(before[0]); // H1-Text unverändert
    expect(after[1]).toBe("Neuer erster Absatz"); // Ziel geändert
    expect(after[2]).toBe(before[2]); // zweiter Absatz unverändert
  });

  test("applied zählt mehrere gültige Edits", async () => {
    const { applyEdits } = await import("./apply.ts");
    const { applied } = applyEdits(HTML, [
      { idx: 0, text: "A" },
      { idx: 2, text: "B" },
    ]);
    expect(applied).toBe(2);
  });

  test("out-of-bounds idx wird sicher ignoriert (kein Crash)", async () => {
    const { applyEdits } = await import("./apply.ts");
    const res = applyEdits(HTML, [{ idx: 999, text: "ins Leere" }]);
    expect(res.applied).toBe(0);
    // Inhalt unverändert (re-parse-vergleichbar).
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const before = enumerateEditableTextNodes(parseHTML(HTML).document).map((n) => n.textContent);
    const after = enumerateEditableTextNodes(parseHTML(res.html).document).map((n) => n.textContent);
    expect(after).toEqual(before);
  });

  test("HTML wird escaped — text mit < landet als Text, nicht als Markup", async () => {
    const { applyEdits } = await import("./apply.ts");
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const { html: out } = applyEdits(HTML, [{ idx: 0, text: "<script>alert(1)</script>" }]);

    // Kein echtes <script>-Element im Body durch den Edit entstanden.
    const { document } = parseHTML(out);
    // idx 0 ist der erste editierbare Text-Node (H1-Text).
    const firstText = enumerateEditableTextNodes(document)[0];
    expect(firstText?.textContent).toBe("<script>alert(1)</script>");
    expect(document.querySelectorAll("script").length).toBe(0);
    // Serialisierung enthält die escaped-Form, nicht rohes <script>.
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>alert(1)</script>");
  });

  test("kein doppeltes Escaping: & wird einmal escaped", async () => {
    const { applyEdits } = await import("./apply.ts");
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const { html: out } = applyEdits(HTML, [{ idx: 0, text: "Tür & Tor" }]);
    const firstText = enumerateEditableTextNodes(parseHTML(out).document)[0];
    expect(firstText?.textContent).toBe("Tür & Tor"); // re-parse ergibt wieder genau ein &
    expect(out).not.toContain("&amp;amp;");
  });

  test("fileSha256 ist stabil für gleichen Input und hex", async () => {
    const { fileSha256 } = await import("./apply.ts");
    const a = fileSha256(HTML);
    const b = fileSha256(HTML);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fileSha256 ändert sich nach einem Edit", async () => {
    const { fileSha256, applyEdits } = await import("./apply.ts");
    const before = fileSha256(HTML);
    const { html: out } = applyEdits(HTML, [{ idx: 0, text: "Komplett anders" }]);
    expect(fileSha256(out)).not.toBe(before);
  });
});

// ===========================================================================
// Contract A — Kern: git.ts (gegen tmp-Repo)
// ===========================================================================
describe("git.ts — Versionierung gegen tmp-Repo", () => {
  let git: typeof import("./git.ts");
  let repoRoot: string;
  const pagePath = "site/index.html";

  beforeAll(async () => {
    git = await import("./git.ts");
  });

  beforeEach(() => {
    repoRoot = makeTmpDir("regoro-git-");
    const siteDir = join(repoRoot, "site");
    mkdirSync(siteDir, { recursive: true });
    cpSync(REAL_SITE, siteDir, { recursive: true });
  });

  test("ensureRepo ist idempotent und erzeugt Baseline-Commit", () => {
    git.ensureRepo(repoRoot);
    git.ensureRepo(repoRoot); // zweimal → kein Fehler
    expect(existsSync(join(repoRoot, ".git"))).toBe(true);
    const versions = git.listVersions(repoRoot, pagePath);
    expect(versions.length).toBeGreaterThanOrEqual(1); // Baseline existiert
  });

  test("2× commitEdit → Historie wächst, neueste zuerst", () => {
    git.ensureRepo(repoRoot);
    const base = git.listVersions(repoRoot, pagePath).length;

    writeFileSync(join(repoRoot, pagePath), "<html><body><p>V1</p></body></html>");
    git.commitEdit(repoRoot, pagePath, "Edit 1");
    writeFileSync(join(repoRoot, pagePath), "<html><body><p>V2</p></body></html>");
    git.commitEdit(repoRoot, pagePath, "Edit 2");

    const versions = git.listVersions(repoRoot, pagePath);
    expect(versions.length).toBe(base + 2);
    // neueste zuerst
    expect(versions[0]!.subject).toBe("Edit 2");
    expect(versions[1]!.subject).toBe("Edit 1");
    // Form jedes Eintrags
    expect(versions[0]!.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(typeof versions[0]!.date).toBe("string");
  });

  test("commitEdit ist no-op-tolerant (kein Fehler ohne Änderung)", () => {
    git.ensureRepo(repoRoot);
    expect(() => git.commitEdit(repoRoot, pagePath, "kein Change")).not.toThrow();
  });

  test("showVersion liefert den Dateiinhalt @ Commit", () => {
    git.ensureRepo(repoRoot);
    writeFileSync(join(repoRoot, pagePath), "<html><body><p>Original-Inhalt-XYZ</p></body></html>");
    git.commitEdit(repoRoot, pagePath, "Setze XYZ");
    const commit = git.listVersions(repoRoot, pagePath)[0]!.commit;

    const content = git.showVersion(repoRoot, commit, pagePath);
    expect(content).toContain("Original-Inhalt-XYZ");
  });

  test("restoreVersion stellt alten Stand her UND erzeugt neuen Commit", () => {
    git.ensureRepo(repoRoot);

    writeFileSync(join(repoRoot, pagePath), "<html><body><p>STAND-A</p></body></html>");
    git.commitEdit(repoRoot, pagePath, "Stand A");
    const commitA = git.listVersions(repoRoot, pagePath)[0]!.commit;

    writeFileSync(join(repoRoot, pagePath), "<html><body><p>STAND-B</p></body></html>");
    git.commitEdit(repoRoot, pagePath, "Stand B");
    const countBefore = git.listVersions(repoRoot, pagePath).length;

    git.restoreVersion(repoRoot, commitA, pagePath);

    // Datei trägt wieder Stand A
    expect(readFileSync(join(repoRoot, pagePath), "utf8")).toContain("STAND-A");
    // und es gibt einen zusätzlichen (Restore-)Commit
    const countAfter = git.listVersions(repoRoot, pagePath).length;
    expect(countAfter).toBe(countBefore + 1);
  });
});

// ===========================================================================
// Contract B — Host-Integration (handleEditorRequest)
// ===========================================================================
describe("host.ts — handleEditorRequest Integration", () => {
  let host: typeof import("./host.ts");
  let git: typeof import("./git.ts");
  let apply: typeof import("./apply.ts");
  let ctx: import("./host.ts").HostCtx;

  const PAGE_WHITELIST = ["index.html", "impressum.html", "datenschutz.html", "agb.html"];

  beforeAll(async () => {
    // Env steht bereits oben; dynamische Imports stellen sicher, dass auth es liest.
    git = await import("./git.ts");
    apply = await import("./apply.ts");
    host = await import("./host.ts");
  });

  beforeEach(() => {
    const fx = makeSiteRepoFixture(git);
    ctx = { repoRoot: fx.repoRoot, siteDir: fx.siteDir, pageWhitelist: PAGE_WHITELIST, auth: TEST_AUTH };
  });

  // --- kleine HTTP-Helfer ---
  function call(method: string, path: string, init?: RequestInit): Promise<Response> {
    const url = new URL("http://localhost:8788" + path);
    const req = new Request(url, { method, ...init });
    return Promise.resolve(host.handleEditorRequest(req, url, ctx));
  }

  function cookieFromSetCookie(res: Response): string | null {
    const sc = res.headers.get("set-cookie");
    if (!sc) return null;
    return sc.split(";")[0]!; // "regoro_edit=<token>"
  }

  async function login(): Promise<string> {
    const res = await call("POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=" + encodeURIComponent(TEST_PASSWORD),
    });
    const cookie = cookieFromSetCookie(res);
    if (!cookie) throw new Error("Login lieferte kein Cookie");
    return cookie;
  }

  // --- Login ---
  test("GET /edit/login → 200 HTML-Formular", async () => {
    const res = await call("GET", "/edit/login");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.toLowerCase()).toContain("password");
  });

  test("POST /edit/login korrektes Passwort → Set-Cookie regoro_edit + 302", async () => {
    const res = await call("POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=" + encodeURIComponent(TEST_PASSWORD),
    });
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toContain("regoro_edit=");
    expect(sc).toContain("HttpOnly");
    expect(res.status).toBe(302);
  });

  test("POST /edit/login falsches Passwort → KEIN Cookie", async () => {
    const res = await call("POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "password=" + encodeURIComponent("falsch"),
    });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.status).not.toBe(302);
  });

  // --- /edit Ansicht ---
  test("GET /edit mit Cookie → 200 + data-edit-idx + overlay.js + __REGORO_EDIT__", async () => {
    const cookie = await login();
    const res = await call("GET", "/edit", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("data-edit-idx");
    expect(body).toContain("overlay.js");
    expect(body).toContain("window.__REGORO_EDIT__");
  });

  test("GET /edit OHNE Cookie → 302 auf Login mit return (M3: Edit-View leitet zum Login)", async () => {
    const res = await call("GET", "/edit");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/edit/login?return=%2Fedit");
  });

  test("GET /agb.html/edit mit Cookie → 200 + editierbarer Rechtstext (M3-Suffix-Form)", async () => {
    const cookie = await login();
    const res = await call("GET", "/agb.html/edit", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("data-edit-idx");
    expect(body).toContain("Allgemeine Geschäftsbedingungen");
  });

  test("GET /impressum.html/edit und /datenschutz.html/edit editierbar (M3-Suffix-Form)", async () => {
    const cookie = await login();
    for (const page of ["impressum.html", "datenschutz.html"]) {
      const res = await call("GET", "/" + page + "/edit", { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("data-edit-idx");
    }
  });

  // --- overlay.js Asset ---
  test("GET /edit-assets/overlay.js → 200 JavaScript", async () => {
    const res = await call("GET", "/edit-assets/overlay.js");
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct.toLowerCase()).toContain("javascript");
  });

  // --- Save ---
  test("POST /edit/save korrekter fileHash → Text geändert + Git wächst + neuer fileHash", async () => {
    const cookie = await login();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);

    const original = readFileSync(filePath, "utf8");
    const fileHash = apply.fileSha256(original);

    const versionsBefore = git.listVersions(ctx.repoRoot, pagePath).length;

    const res = await call("POST", "/edit/save", {
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        pagePath,
        fileHash,
        edits: [{ idx: 0, text: "Komplett neuer Leaf-Text" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; fileHash: string };
    expect(json.ok).toBe(true);
    expect(json.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.fileHash).not.toBe(fileHash); // Hash hat sich geändert

    // Datei auf Platte enthält neuen Text und stimmt mit neuem Hash überein.
    const after = readFileSync(filePath, "utf8");
    expect(after).toContain("Komplett neuer Leaf-Text");
    expect(apply.fileSha256(after)).toBe(json.fileHash);

    // Git-Historie ist gewachsen.
    const versionsAfter = git.listVersions(ctx.repoRoot, pagePath).length;
    expect(versionsAfter).toBe(versionsBefore + 1);
  });

  test("POST /edit/save auf symlinked Seite → 400, Datei außerhalb siteDir unverändert (Greptile-Fix)", async () => {
    const cookie = await login();
    const outsideDir = mkdtempSync(join(tmpdir(), "regoro-out-"));
    const outsideFile = join(outsideDir, "secret.html");
    writeFileSync(outsideFile, "<html><body><p>OUTSIDE</p></body></html>");

    // site/index.html durch einen Symlink nach AUSSERHALB ersetzen.
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    rmSync(filePath);
    symlinkSync(outsideFile, filePath);

    const fileHash = apply.fileSha256(readFileSync(filePath, "utf8")); // liest durch den Symlink
    const res = await call("POST", "/edit/save", {
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ pagePath, fileHash, edits: [{ idx: 0, text: "HACKED" }] }),
    });

    expect(res.status).toBe(400); // fail-closed, kein Schreiben durch den Symlink
    const outside = readFileSync(outsideFile, "utf8");
    expect(outside).toContain("OUTSIDE");
    expect(outside).not.toContain("HACKED");
  });

  test("POST /edit/save ändert NUR Textinhalt, Element-Skelett bleibt identisch", async () => {
    const cookie = await login();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);

    const original = readFileSync(filePath, "utf8");
    // Vollständiges Element-Skelett (alle Tags, Dokumentreihenfolge). Die Platten-
    // datei enthält KEINE data-edit-idx-Spans (die existieren nur in der Edit-
    // Antwort), daher muss das Skelett nach einem Text-Save exakt gleich bleiben.
    const skeleton = (h: string) =>
      [...parseHTML(h).document.querySelectorAll("*")].map((el) => el.tagName).join(",");
    const before = skeleton(original);

    await call("POST", "/edit/save", {
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        pagePath,
        fileHash: apply.fileSha256(original),
        edits: [{ idx: 0, text: "Geänderter Titel" }],
      }),
    });

    const after = readFileSync(filePath, "utf8");
    expect(skeleton(after)).toBe(before); // Struktur/Markup identisch
  });

  test("POST /edit/save falscher fileHash → 409 hash-mismatch", async () => {
    const cookie = await login();
    const res = await call("POST", "/edit/save", {
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        pagePath: "site/index.html",
        fileHash: "0".repeat(64), // garantiert falsch
        edits: [{ idx: 0, text: "egal" }],
      }),
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("hash-mismatch");
  });

  test("POST /edit/save ohne Auth → 404", async () => {
    const res = await call("POST", "/edit/save", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pagePath: "site/index.html", fileHash: "x", edits: [] }),
    });
    expect(res.status).toBe(404);
  });

  // --- Versionen + Restore end-to-end ---
  test("Versionen + Restore: speichern → versions listet → restore stellt her", async () => {
    const cookie = await login();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);

    // 1. Speichern (erzeugt eine neue Version mit neuem Text).
    const original = readFileSync(filePath, "utf8");
    await call("POST", "/edit/save", {
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        pagePath,
        fileHash: apply.fileSha256(original),
        edits: [{ idx: 0, text: "ZWISCHENSTAND" }],
      }),
    });
    expect(readFileSync(filePath, "utf8")).toContain("ZWISCHENSTAND");

    // 2. Versionen listen.
    const vres = await call("GET", "/edit/versions?page=index.html", { headers: { cookie } });
    expect(vres.status).toBe(200);
    const versions = (await vres.json()) as { commit: string; date: string; subject: string }[];
    expect(Array.isArray(versions)).toBe(true);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions[0]!.commit).toMatch(/^[0-9a-f]{7,40}$/);

    // 3. Älteste (Baseline) Version wiederherstellen.
    const baseline = versions[versions.length - 1]!;
    const rres = await call("POST", "/edit/restore", {
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ commit: baseline.commit, pagePath }),
    });
    expect(rres.status).toBe(200);
    const rjson = (await rres.json()) as { ok: boolean };
    expect(rjson.ok).toBe(true);

    // Datei trägt nicht mehr ZWISCHENSTAND (Baseline-Original wiederhergestellt).
    expect(readFileSync(filePath, "utf8")).not.toContain("ZWISCHENSTAND");
  });

  test("GET /edit/version/<commit>?page= → 200 read-only Vorschau (kein data-edit-idx nötig)", async () => {
    const cookie = await login();
    const pagePath = "site/index.html";
    const versions = git.listVersions(ctx.repoRoot, pagePath);
    const commit = versions[0]!.commit;

    const res = await call("GET", `/edit/version/${commit}?page=index.html`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Regoro"); // echter Seiteninhalt
  });

  test("GET /edit/versions ohne Auth → 404", async () => {
    const res = await call("GET", "/edit/versions?page=index.html");
    expect(res.status).toBe(404);
  });

  // --- Whitelist & Traversal ---
  test("Nicht-Whitelist-Seite → 404", async () => {
    const cookie = await login();
    const res = await call("GET", "/edit/geheim.html", { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  test("Pfad-Traversal via Page → 404", async () => {
    const cookie = await login();
    for (const p of [
      "/edit/..%2f..%2fetc%2fpasswd",
      "/edit/version/HEAD?page=../../etc/passwd",
      "/edit/versions?page=../../../etc/passwd",
    ]) {
      const res = await call("GET", p, { headers: { cookie } });
      expect(res.status).toBe(404);
    }
  });

  test("Seite, die nicht ^[a-z0-9-]+\\.html$ matcht → 404", async () => {
    const cookie = await login();
    for (const p of ["/edit/Index.html", "/edit/foo.php", "/edit/sub/page.html"]) {
      const res = await call("GET", p, { headers: { cookie } });
      expect(res.status).toBe(404);
    }
  });

  // --- Header auf allen Editor-Responses ---
  test("alle Editor-Responses tragen X-Robots-Tag + Cache-Control: no-store", async () => {
    const cookie = await login();
    const responses = [
      await call("GET", "/edit/login"),
      await call("GET", "/edit", { headers: { cookie } }),
      await call("GET", "/edit-assets/overlay.js"),
      await call("GET", "/edit/versions?page=index.html", { headers: { cookie } }),
    ];
    for (const res of responses) {
      expect((res.headers.get("x-robots-tag") ?? "").toLowerCase()).toContain("noindex");
      expect((res.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");
    }
  });
});

// ===========================================================================
// Contract B — auth.ts (Cookie-Signatur)
// ===========================================================================
describe("auth.ts — Passwort + signiertes Cookie", () => {
  let auth: typeof import("./auth.ts");

  beforeAll(async () => {
    auth = await import("./auth.ts");
  });

  test("verifyPassword: korrekt true, falsch false", async () => {
    expect(await auth.verifyPassword(TEST_AUTH, TEST_PASSWORD)).toBe(true);
    expect(await auth.verifyPassword(TEST_AUTH, "falsch")).toBe(false);
  });

  test("issueCookie erzeugt Set-Cookie mit regoro_edit/HttpOnly/SameSite", () => {
    const sc = auth.issueCookie(TEST_AUTH);
    expect(sc).toContain("regoro_edit=");
    expect(sc).toContain("HttpOnly");
    expect(sc).toMatch(/SameSite=Strict/i);
  });

  test("checkCookie akzeptiert eigenes Token, lehnt manipuliertes ab", () => {
    const sc = auth.issueCookie(TEST_AUTH);
    const token = sc.split(";")[0]!.split("=").slice(1).join("="); // Wert nach regoro_edit=
    expect(auth.checkCookie(TEST_AUTH, token)).toBe(true);
    expect(auth.checkCookie(TEST_AUTH, token + "x")).toBe(false);
    expect(auth.checkCookie(TEST_AUTH, "garbage")).toBe(false);
    expect(auth.checkCookie(TEST_AUTH, "")).toBe(false);
  });
});
