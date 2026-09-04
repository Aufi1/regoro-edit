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
const TEST_SECRET = "testsecret-aaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_NUMMER = "+4915120464812";
const TEST_AUTH = { nummern: [TEST_NUMMER], emails: [], secret: TEST_SECRET };

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

  test("restoreVersion stellt den GANZEN Baum her UND erzeugt neuen Commit", () => {
    /**
     * GEÄNDERT mit Contract C10 — und zwar mitsamt der Zusicherung, nicht nur
     * der Stelligkeit. Diese Fassung übergab bis zuletzt einen Seitenpfad und
     * behauptete damit „eine Seite zurück"; sie lief trotzdem durch, weil bun
     * TypeScript ungeprüft ausführt und das dritte Argument still verschluckte.
     * Sie prüfte also längst den ganzen Baum, unter falschem Namen. Genau
     * deshalb steht `tsc` vor `bun test`.
     */
    git.ensureRepo(repoRoot);

    writeFileSync(join(repoRoot, pagePath), "<html><body><p>STAND-A</p></body></html>");
    git.commitEdit(repoRoot, pagePath, "Stand A");
    const commitA = git.listVersions(repoRoot, pagePath)[0]!.commit;

    writeFileSync(join(repoRoot, pagePath), "<html><body><p>STAND-B</p></body></html>");
    // Eine ZWEITE Seite, die es in Stand A noch gar nicht gab.
    writeFileSync(join(repoRoot, "site", "spaeter.html"), "<html><body><p>SPÄTER</p></body></html>");
    git.commitEdit(repoRoot, [pagePath, "site/spaeter.html"], "Stand B");
    const countBefore = git.listVersions(repoRoot).length;

    git.restoreVersion(repoRoot, commitA);

    expect(readFileSync(join(repoRoot, pagePath), "utf8")).toContain("STAND-A");
    // Der ganze Baum: die seither hinzugekommene Seite ist weg.
    expect(existsSync(join(repoRoot, "site", "spaeter.html"))).toBe(false);
    // Und ein zusätzlicher (Restore-)Commit obendrauf — ohne Pfad gezählt, denn
    // eine Version gilt jetzt für die ganze Website.
    expect(git.listVersions(repoRoot).length).toBe(countBefore + 1);
  });

  test("listVersions ohne Pfad zählt die ganze Website, mit Pfad nur diese Seite", () => {
    // Contract C10. Die Unterscheidung ist nicht kosmetisch: Die Auswahlliste
    // muss dieselbe Einheit zeigen wie der Knopf, der sie wiederherstellt.
    git.ensureRepo(repoRoot);
    writeFileSync(join(repoRoot, "site", "nur-hier.html"), "<html><body><p>X</p></body></html>");
    git.commitEdit(repoRoot, "site/nur-hier.html", "Nur die neue Seite");

    const ganzeWebsite = git.listVersions(repoRoot);
    const nurIndex = git.listVersions(repoRoot, pagePath);

    expect(ganzeWebsite.length).toBe(nurIndex.length + 1);
    expect(ganzeWebsite[0]!.subject).toBe("Nur die neue Seite");
    expect(nurIndex.map((v) => v.subject)).not.toContain("Nur die neue Seite");
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

  let versand: import("./versand.ts").Attrappe;

  beforeEach(async () => {
    const fx = makeSiteRepoFixture(git);
    versand = (await import("./versand.ts")).attrappenVersand();
    const { AUTH_DIR_NAME } = await import("./auth.ts");
    ctx = {
      repoRoot: fx.repoRoot,
      // Seit „Eine Bearbeitung, zwei Modi" hat der Ctx drei Orte statt einem.
      // Diese Vorrichtung stammt von davor: Sie legt Entwurf und Abzug auf
      // denselben Ordner, damit die Zusicherungen dieses Blocks weiterhin das
      // messen, wofür sie geschrieben wurden — den Router, nicht die Ablage.
      entwurfDir: fx.siteDir,
      schwebendDir: join(fx.siteDir, AUTH_DIR_NAME, "schwebend"),
      siteDir: fx.siteDir,
      basis: "",
      staging: false,
      pageWhitelist: PAGE_WHITELIST,
      auth: TEST_AUTH,
      versand,
    };
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

  /** Zweistufige Anmeldung: Kennung eintragen, Code aus der Attrappe abtippen. */
  async function login(returnTo?: string): Promise<string> {
    const feld = (extra = "") =>
      `kennung=${encodeURIComponent(TEST_NUMMER)}&weg=sms${returnTo ? `&return=${encodeURIComponent(returnTo)}` : ""}${extra}`;
    await call("POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: feld(),
    });
    const code = versand.gesendet.at(-1)?.code;
    if (!code) throw new Error("kein Code verschickt");
    const res = await call("POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: feld(`&code=${code}`),
    });
    const cookie = cookieFromSetCookie(res);
    if (!cookie) throw new Error(`Login lieferte kein Cookie (Status ${res.status})`);
    return cookie;
  }

  /** Nur die zweite Stufe, für Tests, die die Weiterleitung prüfen. */
  async function loginAntwort(returnTo?: string): Promise<Response> {
    const feld = (extra = "") =>
      `kennung=${encodeURIComponent(TEST_NUMMER)}&weg=sms${returnTo ? `&return=${encodeURIComponent(returnTo)}` : ""}${extra}`;
    await call("POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: feld(),
    });
    const code = versand.gesendet.at(-1)!.code;
    return call("POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: feld(`&code=${code}`),
    });
  }

  // --- Login ---
  test("GET /edit/login → 200 mit beiden Reitern und ohne Passwortfeld", async () => {
    const res = await call("GET", "/edit/login");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Telefonnummer");
    expect(body).toContain("E-Mail");
    // Der Satz "Ein Passwort brauchst du nicht" darf stehen — ein FELD nicht.
    expect(body).not.toContain('type="password"');
    expect(body).not.toContain('name="password"');
  });

  test("richtiger Code → Set-Cookie regoro_edit + 302", async () => {
    const res = await loginAntwort();
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toContain("regoro_edit=");
    expect(sc).toContain("HttpOnly");
    expect(res.status).toBe(302);
  });

  test("falscher Code → KEIN Cookie", async () => {
    await call("POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `kennung=${encodeURIComponent(TEST_NUMMER)}&weg=sms`,
    });
    const res = await call("POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `kennung=${encodeURIComponent(TEST_NUMMER)}&weg=sms&code=000000`,
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

  test("CFG.zustand steht auf JEDER Edit-Antwort — auch ohne Modellzugang", async () => {
    /**
     * Contract C3. Der Veröffentlichen-Knopf und der unveröffentlichte Stand
     * hängen nicht am Modellzugang: Wer eine schwebende Änderung hat, während
     * der Betreiber die KI abschaltet, muss sie noch übernehmen oder verwerfen
     * können — sonst sperrt das Abschalten der KI den Kunden aus seinem eigenen
     * Editor aus.
     *
     * Dieser Block fährt ohne `ctx.ki`, ist also GENAU der Fall „KI aus". Die
     * `ki:false`-Zusicherung steht ausdrücklich daneben: Ohne sie wäre der Test
     * auch dann grün, wenn hier zufällig doch ein Modellzugang gesetzt wäre —
     * und dann prüfte er den Normalfall statt des Ausnahmefalls.
     */
    const cookie = await login();
    const res = await call("GET", "/edit", { headers: { cookie } });
    expect(res.status).toBe(200);

    const { document } = parseHTML(await res.text());
    const skript = [...document.querySelectorAll("script")].find((s) =>
      (s.textContent ?? "").startsWith("window.__REGORO_EDIT__"),
    );
    expect(skript).toBeDefined();
    const roh = (skript!.textContent ?? "").replace(/^window\.__REGORO_EDIT__ = /, "").replace(/;$/, "");
    const cfg = JSON.parse(roh) as { ki: boolean; zustand: Record<string, unknown> | null; basis: string; staging: boolean };

    expect(cfg.ki).toBe(false); // Voraussetzung: Modellzugang ist wirklich aus
    expect(cfg.zustand).not.toBeNull();
    // Die Felder, an denen die Leiste den Veröffentlichen-Knopf festmacht.
    expect(cfg.zustand).toHaveProperty("schwebend");
    expect(cfg.zustand).toHaveProperty("unveroeffentlicht");
    expect(cfg.zustand).toHaveProperty("veroeffentlichenMoeglich");
    expect(cfg.basis).toBe("");
    expect(cfg.staging).toBe(false);
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

  test("POST /edit/save falscher fileHash → 409 mit der Kennung `konflikt`", async () => {
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
    // Fehlerform seit Contract C2: `fehler` für die Maschine, `grund` für den
    // Kunden — beide. Der Hash-Konflikt hat eine EIGENE Kennung, weil derselbe
    // Statuscode inzwischen zwei Bedeutungen trägt: Auch der Riegel gegen eine
    // offene KI-Änderung antwortet 409. Ihn nur am FEHLEN von
    // `schwebende-aenderung` zu erkennen, wäre ein Schluss aus einer
    // Abwesenheit — und der misst nichts.
    const json = (await res.json()) as { fehler?: string; grund?: string };
    expect(json.fehler).toBe("konflikt");
    expect(typeof json.grund).toBe("string");
    expect(json.grund!.length).toBeGreaterThan(10); // ein Satz, keine Kennung
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
    ]) {
      const res = await call("GET", p, { headers: { cookie } });
      // Der Pfad steht in der Zusicherung: Ein blankes `toBe(404)` sagt bei
      // mehreren Schleifendurchläufen nicht, WELCHER durchgerutscht ist.
      expect(`${p} → ${res.status}`).toBe(`${p} → 404`);
    }
  });

  test("/edit/versions ignoriert `?page=` — und lässt sich damit nicht nach draußen lenken", async () => {
    // Diese Route stand bis zum Umbau in der Traversal-Schleife darüber und gab
    // 404. Seit eine Version für die GANZE Website gilt (Plan §1), wird `page`
    // gar nicht mehr gelesen — der Browser schickt es nur noch mit. „200" allein
    // wäre damit aber kein Nachweis: Geprüft wird, dass wirklich DIESELBE Liste
    // herauskommt wie ohne Parameter, der Wert also nirgends einfließt.
    const cookie = await login();
    const ohne = await (await call("GET", "/edit/versions", { headers: { cookie } })).json();
    const mit = await (
      await call("GET", "/edit/versions?page=../../../etc/passwd", { headers: { cookie } })
    ).json();

    expect(mit).toEqual(ohne);
    expect(JSON.stringify(mit)).not.toContain("passwd");
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
describe("auth.ts — hinterlegte Kennungen + signiertes Cookie", () => {
  let auth: typeof import("./auth.ts");

  beforeAll(async () => {
    auth = await import("./auth.ts");
  });

  test("kennungHinterlegt: hinterlegt true, fremd false", () => {
    expect(auth.kennungHinterlegt(TEST_AUTH, TEST_NUMMER)).toBe(true);
    expect(auth.kennungHinterlegt(TEST_AUTH, "+4917000000000")).toBe(false);
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

// ===========================================================================
// Versionen gelten für die ganze Website, nicht je Seite (Plan §1)
// ===========================================================================
/**
 * Der Plan hat es an einem Wegwerf-Repo nachgemessen (v1: `index.html`;
 * v2: `index.html` geändert + `zusatz.js` neu):
 *
 *   git checkout <v1> -- index.html   → `zusatz.js` bleibt
 *   git checkout <v1> -- .            → `zusatz.js` bleibt
 *   git read-tree -um <v1>            → `zusatz.js` ist weg
 *
 * Das ist die zentrale Falle: Wer „Versionen für die ganze Website" mit
 * `checkout` baut, hat das Loch weiterhin, nur weniger sichtbar. Deshalb steht
 * hier neben der Zusicherung die MESSUNG selbst — der Nachweis, dass die
 * Anordnung das Problem wirklich stellt. Ohne ihn wäre „zusatz.js ist weg" auch
 * dann grün, wenn die Datei aus einem ganz anderen Grund nie angekommen wäre.
 */
describe("restoreVersion — hinzugefügte Dateien verschwinden wirklich", () => {
  let gitMod: typeof import("./git.ts");

  beforeAll(async () => {
    gitMod = await import("./git.ts");
  });

  /**
   * `restoreVersion` nimmt keinen Seitenpfad mehr entgegen — sie stellt den
   * ganzen Baum her. Der Helfer bleibt trotzdem stehen: Er benennt, worum es
   * geht, und hält die Tests darunter von der Signatur frei.
   */
  function stelleWiederHer(repoRoot: string, commit: string): void {
    gitMod.restoreVersion(repoRoot, commit);
  }

  /** v1: nur `index.html`. v2: `index.html` geändert + `zusatz.js` neu. */
  function zweiStaende(): { repoRoot: string; v1: string } {
    const repoRoot = makeTmpDir("regoro-restore-");
    writeFileSync(join(repoRoot, "index.html"), "<html><body><p>STAND-1</p></body></html>");
    gitMod.ensureRepo(repoRoot);
    const v1 = gitMod.listVersions(repoRoot, "index.html")[0]!.commit;

    writeFileSync(join(repoRoot, "index.html"), "<html><body><p>STAND-2</p></body></html>");
    writeFileSync(join(repoRoot, "zusatz.js"), "console.log('vom Agenten angelegt')");
    gitMod.commitEdit(repoRoot, ["index.html", "zusatz.js"], "Lauf: Seite plus Skript");
    return { repoRoot, v1 };
  }

  test("MESSUNG: der ganze Baum per checkout lässt die neue Datei stehen", () => {
    // Der Messapparat selbst. Bliebe `zusatz.js` hier NICHT stehen, stellte die
    // Anordnung das Problem gar nicht, und die Tests darunter bewiesen nichts.
    const { repoRoot, v1 } = zweiStaende();
    expect(existsSync(join(repoRoot, "zusatz.js"))).toBe(true);

    gitMod.git(repoRoot, "checkout", v1, "--", ".");

    expect(readFileSync(join(repoRoot, "index.html"), "utf8")).toContain("STAND-1");
    expect(existsSync(join(repoRoot, "zusatz.js"))).toBe(true); // genau das Loch
  });

  test("MESSUNG: der einzelne Seitenpfad erst recht nicht", () => {
    const { repoRoot, v1 } = zweiStaende();
    gitMod.git(repoRoot, "checkout", v1, "--", "index.html");
    expect(existsSync(join(repoRoot, "zusatz.js"))).toBe(true);
  });

  test("restoreVersion entfernt die hinzugefügte Datei", () => {
    const { repoRoot, v1 } = zweiStaende();
    expect(existsSync(join(repoRoot, "zusatz.js"))).toBe(true); // Messapparat

    stelleWiederHer(repoRoot, v1);

    expect(readFileSync(join(repoRoot, "index.html"), "utf8")).toContain("STAND-1");
    expect(existsSync(join(repoRoot, "zusatz.js"))).toBe(false);
  });

  test("und zwar auch im Unterordner", () => {
    const { repoRoot, v1 } = zweiStaende();
    mkdirSync(join(repoRoot, "assets"), { recursive: true });
    writeFileSync(join(repoRoot, "assets", "neu.css"), "p{}");
    gitMod.commitEdit(repoRoot, ["assets/neu.css"], "noch eine Datei");

    stelleWiederHer(repoRoot, v1);

    expect(existsSync(join(repoRoot, "assets", "neu.css"))).toBe(false);
  });

  test("eine in der neuen Version GELÖSCHTE Datei kommt zurück", () => {
    // Die andere Richtung derselben Aussage: der Baum wird hergestellt, nicht
    // nur überschrieben.
    const repoRoot = makeTmpDir("regoro-restore-");
    writeFileSync(join(repoRoot, "index.html"), "<html><body><p>STAND-1</p></body></html>");
    writeFileSync(join(repoRoot, "alt.html"), "<html><body><p>ALTE-SEITE</p></body></html>");
    gitMod.ensureRepo(repoRoot);
    const v1 = gitMod.listVersions(repoRoot, "index.html")[0]!.commit;

    rmSync(join(repoRoot, "alt.html"));
    gitMod.git(repoRoot, "add", "-A");
    gitMod.git(repoRoot, "commit", "-m", "Seite entfernt");
    expect(existsSync(join(repoRoot, "alt.html"))).toBe(false); // Messapparat

    stelleWiederHer(repoRoot, v1);

    expect(existsSync(join(repoRoot, "alt.html"))).toBe(true);
    expect(readFileSync(join(repoRoot, "alt.html"), "utf8")).toContain("ALTE-SEITE");
  });

  test("die Historie wächst nur nach vorn: neuer Commit obendrauf, alte bleiben", () => {
    const { repoRoot, v1 } = zweiStaende();
    const vorher = gitMod.countCommits(repoRoot);
    const kopfVorher = gitMod.git(repoRoot, "rev-parse", "HEAD").trim();

    stelleWiederHer(repoRoot, v1);

    expect(gitMod.countCommits(repoRoot)).toBe((vorher ?? 0) + 1);
    const kopfNachher = gitMod.git(repoRoot, "rev-parse", "HEAD").trim();
    expect(kopfNachher).not.toBe(kopfVorher);
    expect(kopfNachher).not.toBe(v1); // NICHT auf die alte Version zurückgesetzt

    // Beide alten Stände bleiben erreichbar — nichts wurde umgeschrieben.
    const erreichbar = gitMod.git(repoRoot, "rev-list", "HEAD").trim().split("\n");
    expect(erreichbar).toContain(v1);
    expect(erreichbar).toContain(kopfVorher);
  });

  test("der wiederhergestellte Stand ist committet, nicht nur im Arbeitsbaum", () => {
    /**
     * Die Zusicherung lautet: **es entsteht eine Version.**
     *
     * Nicht (wie eine frühere Fassung dieser Begründung behauptete) „sonst
     * bleibt der Baum schmutzig und das nächste Wiederherstellen ist blockiert"
     * — das ist nachgemessen falsch (Contract C10, „Zwei GETRENNTE Fallen"):
     * Nach einem Commit, der nichts committet, weicht der INDEX von HEAD ab,
     * der Arbeitsbaum stimmt mit dem Index aber überein, und `read-tree` läuft
     * durch. Der Schaden ist ein anderer und schlimm genug: Das
     * Wiederherstellen hinterließe keine Spur in der Historie — bei einer
     * Funktion, deren einziger Zweck das Sicherheitsnetz ist.
     */
    const { repoRoot, v1 } = zweiStaende();
    const vorher = gitMod.listVersions(repoRoot).length;

    stelleWiederHer(repoRoot, v1);

    expect(gitMod.listVersions(repoRoot).length).toBe(vorher + 1);
    expect(gitMod.listVersions(repoRoot)[0]!.subject).toContain("Wiederhergestellt");
    expect(gitMod.git(repoRoot, "status", "--porcelain").trim()).toBe("");
  });

  test("ein SCHMUTZIGER Arbeitsbaum blockiert das Wiederherstellen nicht", () => {
    /**
     * Gemessen von Repo-Dev, im Plan nicht erwähnt (Contract C10):
     * `git read-tree -um` bricht bei schmutzigem Arbeitsbaum hart ab
     * („Entry 'index.html' not uptodate. Cannot merge.", rc=128). Eine einzige
     * nicht committete Datei machte das Wiederherstellen damit **dauerhaft**
     * unmöglich — das Sicherheitsnetz wäre tot, genau wenn man es braucht.
     * Deshalb `--reset -u`.
     *
     * Und genau so tritt der Fall auf: Der Kunde tippt im Editor herum, klickt
     * nicht auf Speichern und will dann „zurück auf gestern".
     */
    const { repoRoot, v1 } = zweiStaende();
    writeFileSync(join(repoRoot, "index.html"), "<html><body><p>NICHT COMMITTET</p></body></html>");
    // Messapparat: Der Baum ist wirklich schmutzig — sonst prüft der Test nichts.
    expect(gitMod.git(repoRoot, "status", "--porcelain").trim()).not.toBe("");

    expect(() => stelleWiederHer(repoRoot, v1)).not.toThrow();

    expect(readFileSync(join(repoRoot, "index.html"), "utf8")).toContain("STAND-1");
    expect(gitMod.git(repoRoot, "status", "--porcelain").trim()).toBe("");
  });

  test("Punkt-Segmente überleben — und die Gegenprobe, dass überhaupt geräumt wird", () => {
    /**
     * `git clean -fd -e '.*'` räumt auf, was `read-tree` nie anfasst:
     * unversionierte Dateien. Das `-e '.*'` ist das EINZIGE, was `.regoro/`
     * schützt — Repo-Dev hat nachgemessen, dass ein `clean -fd` ohne den Filter
     * `.regoro/auth.json` wirklich löscht. Fällt er weg (oder wird jemand
     * `-fdx` daraus), kostet ein Wiederherstellen dem Kunden Auth-Secret,
     * Entwurfs-Repo und schwebende Änderung auf einmal — ein stiller
     * Totalverlust, den kein Aufrufer abfangen kann.
     *
     * `.well-known/` steht als zweiter Fall daneben: ein Punkt-Ordner, der
     * echter Website-Inhalt ist.
     */
    const { repoRoot, v1 } = zweiStaende();
    mkdirSync(join(repoRoot, ".regoro"), { recursive: true });
    writeFileSync(join(repoRoot, ".regoro", "auth.json"), '{"v":2,"secret":"GEHEIM"}');
    mkdirSync(join(repoRoot, ".well-known"), { recursive: true });
    writeFileSync(join(repoRoot, ".well-known", "security.txt"), "Contact: mailto:x@y");
    writeFileSync(join(repoRoot, "streuner.js"), "nie committet");

    stelleWiederHer(repoRoot, v1);

    // Inhaltlich, nicht nur `existsSync`: eine leere Hülle wäre derselbe Verlust.
    expect(readFileSync(join(repoRoot, ".regoro", "auth.json"), "utf8")).toContain("GEHEIM");
    expect(readFileSync(join(repoRoot, ".well-known", "security.txt"), "utf8")).toContain("mailto");
    // GEGENPROBE: Ohne sie wäre das oben auch grün, wenn `clean` nie liefe —
    // und dann bliebe genau das Loch offen, das dieser Umbau schließen soll.
    expect(existsSync(join(repoRoot, "streuner.js"))).toBe(false);
  });
});
