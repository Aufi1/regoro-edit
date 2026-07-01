/**
 * v3-B Red — befehlsbasierte Formatierung/Links/Löschen/Einfügen.
 *
 * Kern-Prinzip: Der Client schickt NIE Markup, nur Daten + Befehle (Ops). Der
 * Server erzeugt jede Struktur. Einzige user-Eingabe in Markup = href → validiert.
 * KEIN HTML-Sanitizer.
 *
 * Phase "Red": runFormatState/enumerateDeletable/isValidHref existieren noch
 * nicht; applyEdits kennt bold/italic/link/delete/insert noch nicht. Erwartet:
 * rot, bis die Implementierung folgt.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { parseHTML } from "linkedom";
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync } from "node:fs";
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

// ===========================================================================
// contract.ts — runFormatState
// ===========================================================================
describe("contract.ts — runFormatState (Format-Zustand eines Laufs)", () => {
  /** Liefert den ersten editierbaren Text-Node, dessen Inhalt `needle` enthält. */
  async function nodeWith(html: string, needle: string) {
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const { document } = parseHTML(html);
    const nodes = enumerateEditableTextNodes(document);
    return nodes.find((n) => (n.textContent ?? "").includes(needle))!;
  }

  test("nackter Lauf → bold/italic false, href null", async () => {
    const { runFormatState } = await import("./contract.ts");
    const node = await nodeWith("<!doctype html><html><body><p>schlicht</p></body></html>", "schlicht");
    // v4: FormatState um color; v5: um underline → nackter Lauf hat beide leer.
    expect(runFormatState(node)).toEqual({ bold: false, italic: false, href: null, color: null, underline: false });
  });

  test("Lauf in <strong> → bold true", async () => {
    const { runFormatState } = await import("./contract.ts");
    const node = await nodeWith("<!doctype html><html><body><p><strong>fett</strong></p></body></html>", "fett");
    const state = runFormatState(node);
    expect(state.bold).toBe(true);
    expect(state.italic).toBe(false);
    expect(state.href).toBeNull();
  });

  test("Lauf in <em> → italic true", async () => {
    const { runFormatState } = await import("./contract.ts");
    const node = await nodeWith("<!doctype html><html><body><p><em>kursiv</em></p></body></html>", "kursiv");
    const state = runFormatState(node);
    expect(state.italic).toBe(true);
    expect(state.bold).toBe(false);
  });

  test("Lauf in <a href> → href gesetzt", async () => {
    const { runFormatState } = await import("./contract.ts");
    const node = await nodeWith(
      "<!doctype html><html><body><p><a href='https://x.de'>link</a></p></body></html>",
      "link",
    );
    expect(runFormatState(node).href).toBe("https://x.de");
  });

  test("verschachtelt <strong><em> → bold UND italic true", async () => {
    const { runFormatState } = await import("./contract.ts");
    const node = await nodeWith(
      "<!doctype html><html><body><p><strong><em>beides</em></strong></p></body></html>",
      "beides",
    );
    const state = runFormatState(node);
    expect(state.bold).toBe(true);
    expect(state.italic).toBe(true);
  });
});

// ===========================================================================
// contract.ts — enumerateDeletable
// ===========================================================================
describe("contract.ts — enumerateDeletable (löschbare Block-Elemente)", () => {
  test("liefert Block-Container in Dokumentreihenfolge", async () => {
    const { enumerateDeletable } = await import("./contract.ts");
    const { document } = parseHTML(
      "<!doctype html><html><body><main><h2>A</h2><p>B</p><ul><li>C</li></ul></main></body></html>",
    );
    const els = enumerateDeletable(document);
    const tags = els.map((el) => el.tagName);
    // typische Block-Container müssen erfasst sein, in Doku-Reihenfolge
    expect(tags).toContain("H2");
    expect(tags).toContain("P");
    expect(tags.indexOf("H2")).toBeLessThan(tags.indexOf("P"));
  });

  test("Landmarks html/head/body/main sind NIE löschbar", async () => {
    const { enumerateDeletable } = await import("./contract.ts");
    const { document } = parseHTML(
      "<!doctype html><html><head><title>t</title></head><body><main><p>x</p></main></body></html>",
    );
    const tags = enumerateDeletable(document).map((el) => el.tagName);
    for (const landmark of ["HTML", "HEAD", "BODY", "MAIN"]) {
      expect(tags).not.toContain(landmark);
    }
  });

  test("Determinismus: zweimal parsen → identische Anzahl + Reihenfolge", async () => {
    const { enumerateDeletable } = await import("./contract.ts");
    const html = readFileSync(join(REAL_SITE, "index.html"), "utf8");
    const a = enumerateDeletable(parseHTML(html).document).map((el) => el.tagName);
    const b = enumerateDeletable(parseHTML(html).document).map((el) => el.tagName);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// contract.ts — isValidHref (Schema-Whitelist)
// ===========================================================================
describe("contract.ts — isValidHref (Schema-Whitelist)", () => {
  test("erlaubt http(s), mailto, seiten-relativ, #anker", async () => {
    const { isValidHref } = await import("./contract.ts");
    for (const ok of [
      "https://example.com",
      "http://example.com/pfad?q=1",
      "mailto:a@b.de",
      "kontakt.html",
      "datenschutz.html#cookies",
      "#top",
    ]) {
      expect(isValidHref(ok)).toBe(true);
    }
  });

  test("blockt javascript:, data:, vbscript:, sonstige Schemata", async () => {
    const { isValidHref } = await import("./contract.ts");
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)", // case-insensitive
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      " javascript:alert(1)", // führender Whitespace
    ]) {
      expect(isValidHref(bad)).toBe(false);
    }
  });

  // C1-Regression (Fix 9de1997): HTML-Entity-kodierte Schema-Bypässe. Diese
  // kamen vor dem Fix DURCH die Whitelist (Browser dekodiert beim Reparse zu
  // javascript:) → Stored-XSS. Jetzt werden Entities VOR der Schema-Prüfung
  // dekodiert; zusätzlich werden protokoll-relative //host-URLs abgelehnt.
  test("C1: Entity-kodierte javascript:-Bypässe + //host → false", async () => {
    const { isValidHref } = await import("./contract.ts");
    for (const bad of [
      "&#106;avascript:alert(1)",     // dezimal &#106; = "j"
      "&#x6a;avascript:alert(1)",     // hex &#x6a; = "j"
      "&#0000106;avascript:",         // dezimal mit Null-Polsterung
      "jav&#x09;ascript:",            // Tab-Entity mitten im Schema
      "//evil.com",                   // protokoll-relativ (Open-Redirect/Phishing)
    ]) {
      expect(isValidHref(bad)).toBe(false);
    }
  });

  test("C1-Gegenprobe: legitime hrefs bleiben nach Entity-Härtung erlaubt", async () => {
    const { isValidHref } = await import("./contract.ts");
    for (const ok of [
      "https://x.de",
      "mailto:a@b.de",
      "kontakt.html",
      "datenschutz.html#cookies",
      "#top",
    ]) {
      expect(isValidHref(ok)).toBe(true);
    }
  });

  // L2-Regression (Fix 4bde0b4): Manche Browser behandeln `\` wie `/`, daher
  // umging `/\evil.com` (bzw. `\\`, `\/`) vor dem Fix die //host-Sperre →
  // Open-Redirect. isValidHref normalisiert jetzt Backslashes → `/` vorab.
  test("L2: Backslash-protokoll-relative URLs → false", async () => {
    const { isValidHref } = await import("./contract.ts");
    for (const bad of ["/\\evil.com", "\\\\evil.com", "\\/evil.com", "/\\/\\evil.com"]) {
      expect(isValidHref(bad)).toBe(false);
    }
  });

  test("L2-Gegenprobe: legitime hrefs bleiben trotz Backslash-Normalisierung erlaubt", async () => {
    const { isValidHref } = await import("./contract.ts");
    for (const ok of ["kontakt.html", "#top", "https://x.de", "mailto:a@b.de", "datenschutz.html#cookies"]) {
      expect(isValidHref(ok)).toBe(true);
    }
  });
});

// ===========================================================================
// apply.ts — applyEdits Run-Ops (bold/italic/link)
// ===========================================================================
describe("apply.ts — applyEdits Run-Ops: bold/italic/link", () => {
  let apply: typeof import("./apply.ts");
  let contract: typeof import("./contract.ts");

  beforeAll(async () => {
    apply = await import("./apply.ts");
    contract = await import("./contract.ts");
  });

  const SIMPLE = "<!doctype html><html><body><p>Absatztext</p></body></html>";

  test("{idx, bold:true} → Lauf in <strong>, Text bleibt, applied 1", async () => {
    const { html: out, applied } = apply.applyEdits(SIMPLE, [{ idx: 0, bold: true }]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    const strong = document.querySelector("p strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("Absatztext");
    expect(document.querySelector("p")!.textContent).toBe("Absatztext");
  });

  test("{idx, bold:false} auf bereits-fettem Lauf → <strong> weg, Text via normalize zusammengeführt", async () => {
    const FETT = "<!doctype html><html><body><p><strong>Fett</strong></p></body></html>";
    // idx 0 ist der Text-Node innerhalb <strong>.
    const { html: out, applied } = apply.applyEdits(FETT, [{ idx: 0, bold: false }]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).toBeNull(); // unwrap
    const p = document.querySelector("p")!;
    expect(p.textContent).toBe("Fett");
    // normalize: genau ein Kind-Text-Node, kein zersplitterter Text.
    expect(p.childNodes.length).toBe(1);
  });

  test("{idx, italic:true} → Lauf in <em>", async () => {
    const { html: out } = apply.applyEdits(SIMPLE, [{ idx: 0, italic: true }]);
    const em = parseHTML(out).document.querySelector("p em");
    expect(em).not.toBeNull();
    expect(em!.textContent).toBe("Absatztext");
  });

  test("{idx, link:'https://x.de'} → <a href='https://x.de'>-Wrap", async () => {
    const { html: out, applied } = apply.applyEdits(SIMPLE, [{ idx: 0, link: "https://x.de" }]);
    expect(applied).toBe(1);
    const a = parseHTML(out).document.querySelector("p a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://x.de");
    expect(a!.textContent).toBe("Absatztext");
  });

  test("{idx, link:'javascript:alert(1)'} → KEIN Wrap (verworfen), kein <a>, applied 0", async () => {
    const { html: out, applied } = apply.applyEdits(SIMPLE, [{ idx: 0, link: "javascript:alert(1)" }]);
    expect(applied).toBe(0);
    expect(parseHTML(out).document.querySelector("a")).toBeNull();
  });

  test("{idx, link:null} auf verlinktem Lauf → entlinkt (<a> weg, Text bleibt)", async () => {
    const LINKED = "<!doctype html><html><body><p><a href='https://x.de'>Linktext</a></p></body></html>";
    const { html: out, applied } = apply.applyEdits(LINKED, [{ idx: 0, link: null }]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    expect(document.querySelector("a")).toBeNull();
    expect(document.querySelector("p")!.textContent).toBe("Linktext");
  });

  test("{idx, text:'neu', bold:true} kombiniert: Text gesetzt UND in <strong>", async () => {
    const { html: out } = apply.applyEdits(SIMPLE, [{ idx: 0, text: "neu", bold: true }]);
    const strong = parseHTML(out).document.querySelector("p strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("neu");
  });

  test("bestehende Geschwister <span>/<br> bleiben unangetastet", async () => {
    const MIXED =
      "<!doctype html><html><body><p>Anfang <span class='todo'>marker</span><br>Ende</p></body></html>";
    // idx 0 = "Anfang ", fett machen → <span>/<br> dürfen nicht verschwinden.
    const { html: out, applied } = apply.applyEdits(MIXED, [{ idx: 0, bold: true }]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    // Das neue <strong> umschließt GENAU den Ziel-Lauf "Anfang ".
    const strong = document.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("Anfang ");
    // Bestehende Geschwister bleiben unangetastet.
    expect(document.querySelector("span.todo")).not.toBeNull();
    expect(document.querySelector("span.todo")!.textContent).toBe("marker");
    expect(document.querySelectorAll("br").length).toBe(1);
  });

  test("v2-Kompat: {idx, text} ohne Format-Flags ändert weiterhin nur den Text", async () => {
    const { html: out, applied } = apply.applyEdits(SIMPLE, [{ idx: 0, text: "Ersetzt" }]);
    expect(applied).toBe(1);
    const p = parseHTML(out).document.querySelector("p")!;
    expect(p.textContent).toBe("Ersetzt");
    expect(p.querySelector("strong")).toBeNull(); // keine ungewollte Formatierung
  });
});

// ===========================================================================
// apply.ts — applyEdits delete / insert + resolve-then-mutate
// ===========================================================================
describe("apply.ts — applyEdits delete/insert (strukturell)", () => {
  let apply: typeof import("./apply.ts");
  let contract: typeof import("./contract.ts");

  beforeAll(async () => {
    apply = await import("./apply.ts");
    contract = await import("./contract.ts");
  });

  const DOC =
    "<!doctype html><html><body><main>" +
    "<h2>Titel</h2><p>Erster</p><p>Zweiter</p><p>Dritter</p>" +
    "</main></body></html>";

  test("{op:'delete', delIdx} entfernt genau das adressierte Block-Element", async () => {
    const delTags = contract.enumerateDeletable(parseHTML(DOC).document).map((e) => e.tagName);
    // Finde den Index des zweiten <p> ("Zweiter").
    const dels = contract.enumerateDeletable(parseHTML(DOC).document);
    const delIdx = dels.findIndex((e) => e.tagName === "P" && e.textContent === "Zweiter");
    expect(delIdx).toBeGreaterThanOrEqual(0);

    const { html: out, applied } = apply.applyEdits(DOC, [{ op: "delete", delIdx }]);
    expect(applied).toBe(1);
    const ps = [...parseHTML(out).document.querySelectorAll("p")].map((p) => p.textContent);
    expect(ps).toEqual(["Erster", "Dritter"]); // "Zweiter" weg
    expect(delTags.length).toBeGreaterThan(0);
  });

  test("{op:'insert', afterDelIdx} fügt <p>Neuer Absatz</p> nach dem Block ein", async () => {
    const dels = contract.enumerateDeletable(parseHTML(DOC).document);
    const afterDelIdx = dels.findIndex((e) => e.tagName === "P" && e.textContent === "Erster");

    const { html: out, applied } = apply.applyEdits(DOC, [{ op: "insert", afterDelIdx }]);
    expect(applied).toBe(1);
    const ps = [...parseHTML(out).document.querySelectorAll("p")].map((p) => p.textContent);
    // Direkt nach "Erster" steht der neue Absatz.
    const i = ps.indexOf("Erster");
    expect(ps[i + 1]).toBe("Neuer Absatz");
  });

  test("{op:'insert', afterDelIdx:null} fügt am Body-Ende ein", async () => {
    const { html: out } = apply.applyEdits(DOC, [{ op: "insert", afterDelIdx: null }]);
    const ps = [...parseHTML(out).document.querySelectorAll("p")].map((p) => p.textContent);
    expect(ps[ps.length - 1]).toBe("Neuer Absatz");
  });

  test("resolve-then-mutate: delete + Run-Edit in EINEM Save treffen beide die richtigen Knoten", async () => {
    // Run-Op idx referenziert einen Text-Node, der NACH dem gelöschten Block
    // liegt — der Index darf durch das Delete im selben Save nicht verrutschen.
    const nodes = contract.enumerateEditableTextNodes(parseHTML(DOC).document);
    const idxDritter = nodes.findIndex((n) => n.textContent === "Dritter");
    const dels = contract.enumerateDeletable(parseHTML(DOC).document);
    const delIdxErster = dels.findIndex((e) => e.tagName === "P" && e.textContent === "Erster");

    const { html: out } = apply.applyEdits(DOC, [
      { op: "delete", delIdx: delIdxErster },
      { idx: idxDritter, text: "Dritter-geaendert" },
    ]);
    const ps = [...parseHTML(out).document.querySelectorAll("p")].map((p) => p.textContent);
    expect(ps).toContain("Zweiter");
    expect(ps).toContain("Dritter-geaendert"); // korrekt getroffen trotz Delete davor
    expect(ps).not.toContain("Erster");
  });
});

// ===========================================================================
// host.ts — POST /edit/save mit den neuen Ops (Integration)
// ===========================================================================
describe("host.ts — /edit/save akzeptiert v3-B-Ops", () => {
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
    const repoRoot = makeTmpDir("regoro-v3b-");
    const siteDir = join(repoRoot, "site");
    mkdirSync(siteDir, { recursive: true });
    cpSync(REAL_SITE, siteDir, { recursive: true });
    git.ensureRepo(repoRoot);
    ctx = { repoRoot, siteDir, pageWhitelist: PAGE_WHITELIST, auth: TEST_AUTH };
  });

  function authCookie(): string {
    return auth.issueCookie(TEST_AUTH).split(";")[0]!;
  }

  async function save(cookie: string | null, pagePath: string, fileHash: string, edits: unknown[]) {
    const url = new URL("http://localhost:8788/edit/save");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cookie) headers.cookie = cookie;
    const req = new Request(url, { method: "POST", headers, body: JSON.stringify({ pagePath, fileHash, edits }) });
    const res = await Promise.resolve(host.handleEditorRequest(req, url, ctx));
    return res;
  }

  test("Save {idx, bold:true} → Datei enthält <strong>, Commit +1, neuer fileHash", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const versionsBefore = git.listVersions(ctx.repoRoot, pagePath).length;

    const res = await save(cookie, pagePath, apply.fileSha256(original), [{ idx: 0, bold: true }]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; fileHash: string };
    expect(json.ok).toBe(true);
    expect(json.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.fileHash).not.toBe(apply.fileSha256(original));

    const after = readFileSync(filePath, "utf8");
    expect(after).toContain("<strong>");
    expect(git.listVersions(ctx.repoRoot, pagePath).length).toBe(versionsBefore + 1);
    // Header-Pflicht.
    expect((res.headers.get("x-robots-tag") ?? "").toLowerCase()).toContain("noindex");
    expect((res.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");
  });

  test("Save {idx, link:'javascript:…'} → Link NICHT gesetzt (kein <a> hinzu), serverseitig verworfen", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const aBefore = parseHTML(original).document.querySelectorAll("a").length;

    const res = await save(cookie, pagePath, apply.fileSha256(original), [
      { idx: 0, link: "javascript:alert(document.cookie)" },
    ]);
    // Verhalten festgelegt: Server akzeptiert den Save (200), verwirft aber die
    // ungültige Link-Op → KEIN zusätzliches <a> mit javascript:-href.
    expect(res.status).toBe(200);
    const after = readFileSync(filePath, "utf8");
    expect(after).not.toContain("javascript:");
    const aAfter = parseHTML(after).document.querySelectorAll("a").length;
    expect(aAfter).toBe(aBefore); // kein neues <a> entstanden
  });

  test("Save {op:'delete', delIdx} → adressiertes Block-Element verschwindet", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");

    // Lösche einen klar identifizierbaren Block (das erste <h2>).
    const dels = contract.enumerateDeletable(parseHTML(original).document);
    const delIdx = dels.findIndex((e) => e.tagName === "H2");
    expect(delIdx).toBeGreaterThanOrEqual(0);
    const h2Text = dels[delIdx]!.textContent;

    const res = await save(cookie, pagePath, apply.fileSha256(original), [{ op: "delete", delIdx }]);
    expect(res.status).toBe(200);
    const after = readFileSync(filePath, "utf8");
    // Der gelöschte H2-Text ist nicht mehr als <h2> vorhanden.
    const h2sAfter = [...parseHTML(after).document.querySelectorAll("h2")].map((h) => h.textContent);
    expect(h2sAfter).not.toContain(h2Text);
  });

  test("Save {op:'insert', afterDelIdx} → neuer <p>Neuer Absatz</p> in der Datei", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const pBefore = parseHTML(original).document.querySelectorAll("p").length;

    const dels = contract.enumerateDeletable(parseHTML(original).document);
    const afterDelIdx = dels.findIndex((e) => e.tagName === "P");

    const res = await save(cookie, pagePath, apply.fileSha256(original), [{ op: "insert", afterDelIdx }]);
    expect(res.status).toBe(200);
    const after = readFileSync(filePath, "utf8");
    const ps = [...parseHTML(after).document.querySelectorAll("p")].map((p) => p.textContent);
    expect(ps.length).toBe(pBefore + 1);
    expect(ps).toContain("Neuer Absatz");
  });

  test("Save mit v3-B-Op ohne Auth → 404, Datei unverändert", async () => {
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const res = await save(null, pagePath, apply.fileSha256(original), [{ idx: 0, bold: true }]);
    expect(res.status).toBe(404);
    expect(readFileSync(filePath, "utf8")).toBe(original); // unverändert
  });

  test("Save mit v3-B-Op + falscher fileHash → 409", async () => {
    const cookie = authCookie();
    const res = await save(cookie, "site/index.html", "0".repeat(64), [{ idx: 0, bold: true }]);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("hash-mismatch");
  });

  test("Save delete mit pagePath-Traversal → 404", async () => {
    const cookie = authCookie();
    const res = await save(cookie, "site/../etc/passwd", "x", [{ op: "delete", delIdx: 0 }]);
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// v3-B Validation: Lücken-Tests (kombinierte Ops, Unwrap-Kanten, Grenzen)
// Alle gegen die fertige Implementierung GRÜN (Regressionsschutz).
// ===========================================================================
describe("apply.ts — v3-B Lücken: kombinierte Ops + Unwrap-Kanten + Grenzen", () => {
  let apply: typeof import("./apply.ts");
  let contract: typeof import("./contract.ts");

  beforeAll(async () => {
    apply = await import("./apply.ts");
    contract = await import("./contract.ts");
  });

  const SIMPLE = "<!doctype html><html><body><p>Lauf</p></body></html>";

  // --- Kombinierte Run-Ops in einem Save ---
  test("bold+italic+link auf demselben Lauf gleichzeitig → strong, em UND a, Text erhalten", async () => {
    const { html: out, applied } = apply.applyEdits(SIMPLE, [
      { idx: 0, bold: true, italic: true, link: "https://x.de" },
    ]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).not.toBeNull();
    expect(document.querySelector("em")).not.toBeNull();
    const a = document.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://x.de");
    // Der editierbare Text bleibt vollständig vorhanden.
    expect(document.querySelector("p")!.textContent).toBe("Lauf");
  });

  test("text + bold + italic kombiniert: neuer Text in strong>em", async () => {
    const { html: out } = apply.applyEdits(SIMPLE, [{ idx: 0, text: "neu", bold: true, italic: true }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).not.toBeNull();
    expect(document.querySelector("em")).not.toBeNull();
    expect(document.querySelector("p")!.textContent).toBe("neu");
  });

  // --- Mehrere Struktur-Ops in einem Save (resolve-then-mutate) ---
  test("2× delete in EINEM Save entfernt beide adressierten Blöcke korrekt", async () => {
    const DOC =
      "<!doctype html><html><body><main>" +
      "<p>A</p><p>B</p><p>C</p><p>D</p></main></body></html>";
    const dels = contract.enumerateDeletable(parseHTML(DOC).document);
    const iB = dels.findIndex((e) => e.textContent === "B");
    const iD = dels.findIndex((e) => e.textContent === "D");
    expect(iB).toBeGreaterThanOrEqual(0);
    expect(iD).toBeGreaterThanOrEqual(0);

    const { html: out, applied } = apply.applyEdits(DOC, [
      { op: "delete", delIdx: iB },
      { op: "delete", delIdx: iD },
    ]);
    expect(applied).toBe(2);
    const ps = [...parseHTML(out).document.querySelectorAll("p")].map((p) => p.textContent);
    expect(ps).toEqual(["A", "C"]); // B und D weg, A/C unangetastet
  });

  test("delete + insert in EINEM Save: beide treffen die richtige Stelle (resolve-then-mutate)", async () => {
    const DOC =
      "<!doctype html><html><body><main>" +
      "<p>A</p><p>B</p><p>C</p></main></body></html>";
    const dels = contract.enumerateDeletable(parseHTML(DOC).document);
    const iA = dels.findIndex((e) => e.textContent === "A");
    const iC = dels.findIndex((e) => e.textContent === "C");

    // Lösche A; füge nach C einen neuen Absatz ein — beide Indizes auf dem
    // UNVERÄNDERTEN Original aufgelöst, dürfen sich nicht gegenseitig verschieben.
    const { html: out, applied } = apply.applyEdits(DOC, [
      { op: "delete", delIdx: iA },
      { op: "insert", afterDelIdx: iC },
    ]);
    expect(applied).toBe(2);
    const ps = [...parseHTML(out).document.querySelectorAll("p")].map((p) => p.textContent);
    expect(ps).toEqual(["B", "C", "Neuer Absatz"]); // A weg, neuer Absatz nach C
  });

  // --- Unwrap-Kanten ---
  test("bold:false auf NICHT-fettem Lauf → no-op (applied 0, kein strong, kein Schaden)", async () => {
    const { html: out, applied } = apply.applyEdits(SIMPLE, [{ idx: 0, bold: false }]);
    expect(applied).toBe(0);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).toBeNull();
    expect(document.querySelector("p")!.textContent).toBe("Lauf"); // unverändert
  });

  test("link auf bereits-verlinktem Lauf → href geändert, kein zweites <a>", async () => {
    const LINKED = "<!doctype html><html><body><p><a href='https://old.de'>L</a></p></body></html>";
    const { html: out, applied } = apply.applyEdits(LINKED, [{ idx: 0, link: "https://new.de" }]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    expect(document.querySelectorAll("a").length).toBe(1);
    expect(document.querySelector("a")!.getAttribute("href")).toBe("https://new.de");
  });

  test("doppeltes bold:true → idempotent (genau ein <strong>, kein verschachteltes)", async () => {
    const once = apply.applyEdits(SIMPLE, [{ idx: 0, bold: true }]);
    // Auf bereits-fettem Lauf erneut bold:true.
    const { html: out, applied } = apply.applyEdits(once.html, [{ idx: 0, bold: true }]);
    expect(applied).toBe(0); // no-op, schon fett
    expect(parseHTML(out).document.querySelectorAll("strong").length).toBe(1);
  });

  test("italic:false auf NICHT-kursivem Lauf → no-op (applied 0)", async () => {
    const { applied } = apply.applyEdits(SIMPLE, [{ idx: 0, italic: false }]);
    expect(applied).toBe(0);
  });

  test("link:null auf NICHT-verlinktem Lauf → no-op (applied 0, kein Schaden)", async () => {
    const { html: out, applied } = apply.applyEdits(SIMPLE, [{ idx: 0, link: null }]);
    expect(applied).toBe(0);
    expect(parseHTML(out).document.querySelector("p")!.textContent).toBe("Lauf");
  });

  // --- insert/delete-Grenzen ---
  test("insert afterDelIdx = letzter Block → neuer Absatz direkt danach", async () => {
    const DOC = "<!doctype html><html><body><main><p>A</p><p>B</p></main></body></html>";
    const dels = contract.enumerateDeletable(parseHTML(DOC).document);
    const last = dels.length - 1;
    const lastText = dels[last]!.textContent ?? "";
    const { html: out } = apply.applyEdits(DOC, [{ op: "insert", afterDelIdx: last }]);
    const ps = [...parseHTML(out).document.querySelectorAll("p")].map((p) => p.textContent ?? "");
    // Neuer Absatz steht direkt nach dem (Text des) letzten Blocks.
    expect(ps[ps.length - 1]).toBe("Neuer Absatz");
    expect(ps.indexOf("Neuer Absatz")).toBe(ps.indexOf(lastText) + 1);
  });

  test("delete mit out-of-range/negativem delIdx → applied 0, Dokument unverändert", async () => {
    const DOC = "<!doctype html><html><body><main><p>A</p></main></body></html>";
    const before = [...parseHTML(DOC).document.querySelectorAll("p")].map((p) => p.textContent);
    for (const delIdx of [-1, 999, 1.5]) {
      const { html: out, applied } = apply.applyEdits(DOC, [{ op: "delete", delIdx }]);
      expect(applied).toBe(0);
      const after = [...parseHTML(out).document.querySelectorAll("p")].map((p) => p.textContent);
      expect(after).toEqual(before);
    }
  });

  test("insert mit out-of-range afterDelIdx → applied 0 (kein willkürliches Einfügen)", async () => {
    const DOC = "<!doctype html><html><body><main><p>A</p></main></body></html>";
    const { html: out, applied } = apply.applyEdits(DOC, [{ op: "insert", afterDelIdx: 999 }]);
    expect(applied).toBe(0);
    expect(parseHTML(out).document.querySelectorAll("p").length).toBe(1);
  });
});

describe("host.ts — v3-B Lücken: href-Edgecases auf Save-Ebene", () => {
  let host: typeof import("./host.ts");
  let auth: typeof import("./auth.ts");
  let git: typeof import("./git.ts");
  let apply: typeof import("./apply.ts");
  let ctx: import("./host.ts").HostCtx;

  beforeAll(async () => {
    host = await import("./host.ts");
    auth = await import("./auth.ts");
    git = await import("./git.ts");
    apply = await import("./apply.ts");
  });

  beforeEach(() => {
    const repoRoot = makeTmpDir("regoro-v3b-href-");
    const siteDir = join(repoRoot, "site");
    mkdirSync(siteDir, { recursive: true });
    cpSync(REAL_SITE, siteDir, { recursive: true });
    git.ensureRepo(repoRoot);
    ctx = { repoRoot, siteDir, pageWhitelist: PAGE_WHITELIST, auth: TEST_AUTH };
  });

  function authCookie(): string {
    return auth.issueCookie(TEST_AUTH).split(";")[0]!;
  }

  async function save(pagePath: string, fileHash: string, edits: unknown[]) {
    const url = new URL("http://localhost:8788/edit/save");
    const req = new Request(url, {
      method: "POST",
      headers: { cookie: authCookie(), "content-type": "application/json" },
      body: JSON.stringify({ pagePath, fileHash, edits }),
    });
    return Promise.resolve(host.handleEditorRequest(req, url, ctx));
  }

  test("href mit Case-Mix/Whitespace serverseitig verworfen: kein gefährliches <a> geschrieben", async () => {
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);

    for (const bad of [
      "JaVaScRiPt:alert(1)",
      "\tjavascript:alert(1)",
      "  javascript:alert(document.cookie)",
      "\njavascript:x",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
    ]) {
      const original = readFileSync(filePath, "utf8");
      const aBefore = parseHTML(original).document.querySelectorAll("a").length;

      const res = await save(pagePath, apply.fileSha256(original), [{ idx: 0, link: bad }]);
      // Save wird angenommen, aber die ungültige Link-Op verworfen.
      expect(res.status).toBe(200);

      const after = readFileSync(filePath, "utf8");
      // KEIN javascript:/data:/vbscript: in der Datei, KEIN zusätzliches <a>.
      expect(after.toLowerCase()).not.toContain("javascript:");
      expect(after.toLowerCase()).not.toContain("vbscript:");
      expect(after).not.toContain("data:text/html");
      expect(parseHTML(after).document.querySelectorAll("a").length).toBe(aBefore);
    }
  });

  // C1-Regression auf Host-Ebene: Entity-kodierter Bypass über /edit/save.
  test("C1: Save mit Entity-kodiertem javascript:-href → verworfen, kein gefährliches <a>", async () => {
    const contract = await import("./contract.ts");
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);

    for (const bad of [
      "&#106;avascript:alert(1)",
      "&#x6a;avascript:alert(document.cookie)",
      "jav&#x09;ascript:alert(1)",
      "//evil.com",
    ]) {
      const original = readFileSync(filePath, "utf8");
      // Auf einen UNVERLINKTEN Lauf anwenden → kein <a> darf neu entstehen.
      const nodes = contract.enumerateEditableTextNodes(parseHTML(original).document);
      const idxUnlinked = nodes.findIndex(
        (n) => !contract.runFormatState(n).href && (n.textContent ?? "").trim().length > 3,
      );
      const aBefore = parseHTML(original).document.querySelectorAll("a").length;

      const res = await save(pagePath, apply.fileSha256(original), [{ idx: idxUnlinked, link: bad }]);
      expect(res.status).toBe(200); // Save angenommen, Link-Op verworfen

      const after = readFileSync(filePath, "utf8");
      // Weder dekodiertes noch entity-kodiertes javascript:, kein //evil, kein neues <a>.
      expect(after.toLowerCase()).not.toContain("javascript:");
      expect(after).not.toContain("&#106");
      expect(after).not.toContain("&#x6a");
      expect(after).not.toContain("//evil.com");
      expect(parseHTML(after).document.querySelectorAll("a").length).toBe(aBefore);
    }
  });

  test("gültiger href (mailto) auf UNVERLINKTEM Lauf → neues <a> serverseitig erzeugt", async () => {
    const contract = await import("./contract.ts");
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const aBefore = parseHTML(original).document.querySelectorAll("a").length;

    // Wähle einen Lauf, der NICHT schon in einem <a> liegt (idx 0 ist ein Nav-Link!).
    const nodes = contract.enumerateEditableTextNodes(parseHTML(original).document);
    const idxUnlinked = nodes.findIndex(
      (n) => !contract.runFormatState(n).href && (n.textContent ?? "").trim().length > 3,
    );
    expect(idxUnlinked).toBeGreaterThanOrEqual(0);

    const res = await save(pagePath, apply.fileSha256(original), [
      { idx: idxUnlinked, link: "mailto:hallo@regoro.de" },
    ]);
    expect(res.status).toBe(200);
    const after = readFileSync(filePath, "utf8");
    expect(after).toContain("mailto:hallo@regoro.de");
    expect(parseHTML(after).document.querySelectorAll("a").length).toBe(aBefore + 1);
  });
});
