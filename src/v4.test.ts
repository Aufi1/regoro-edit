/**
 * v4 Red — bereich-basierte Formatierung (start/end-Range) + Textfarbe.
 *
 * Kern-Prinzip wie v3-B: Der Client schickt nie Markup, nur Befehle (Offsets +
 * Format). Der Server spaltet den Text-Node und wrappt server-seitig. Validierte
 * Eingaben = href (v3) + Farbwert (neu). KEIN HTML-Sanitizer.
 *
 * Phase "Red": isValidColor/normalizeColor existieren noch nicht; applyEdits
 * kennt Range-Ops (start/end) und color noch nicht; runFormatState liefert noch
 * kein color. Erwartet: rot, bis die Implementierung folgt.
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
// contract.ts — isValidColor (Validierung)
// ===========================================================================
describe("contract.ts — isValidColor (Farb-Whitelist)", () => {
  test("erlaubt Hex #rgb/#rrggbb (case-insensitiv) + rgb()/rgba()", async () => {
    const { isValidColor } = await import("./contract.ts");
    for (const ok of [
      "#fff",
      "#FFF",
      "#ffffff",
      "#FfAa00",
      "#abc",
      "rgb(255,0,0)",
      "rgb(0, 128, 255)",
      "rgba(255,0,0,0.5)",
      "rgba(0,0,0,1)",
    ]) {
      expect(isValidColor(ok)).toBe(true);
    }
  });

  test("optionales #rgba/#rrggbbaa wird akzeptiert", async () => {
    const { isValidColor } = await import("./contract.ts");
    expect(isValidColor("#ffff")).toBe(true);
    expect(isValidColor("#ffffffff")).toBe(true);
  });

  test("blockt CSS-Injection / Breakout / out-of-range / Einheiten / leer", async () => {
    const { isValidColor } = await import("./contract.ts");
    for (const bad of [
      "red; background:url(x)",
      "url(javascript:alert(1))",
      "url(x)",
      "expression(alert(1))",
      "#fff;",
      '"><script>',
      "100px",
      "",
      "javascript:",
      "rgb(999,0,0)", // out-of-range
      "rgb(255,0)", // zu wenig Komponenten
      "rgba(0,0,0,2)", // alpha out-of-range
      "#gg0000", // keine Hex-Ziffern
      "#ff", // ungültige Länge
    ]) {
      expect(isValidColor(bad)).toBe(false);
    }
  });
});

// ===========================================================================
// contract.ts — normalizeColor (Kanonisierung)
// ===========================================================================
describe("contract.ts — normalizeColor (kanonischer Hex oder null)", () => {
  test("#abc → #aabbcc, rgb(255,0,0) → #ff0000", async () => {
    const { normalizeColor } = await import("./contract.ts");
    expect(normalizeColor("#abc")).toBe("#aabbcc");
    expect(normalizeColor("rgb(255,0,0)")).toBe("#ff0000");
  });

  test("Hex wird auf lowercase 6-stellig normalisiert", async () => {
    const { normalizeColor } = await import("./contract.ts");
    expect(normalizeColor("#FFF")).toBe("#ffffff");
    expect(normalizeColor("#FfAa00")).toBe("#ffaa00");
  });

  test("ungültige Farbe → null", async () => {
    const { normalizeColor } = await import("./contract.ts");
    for (const bad of ["url(x)", "expression(alert(1))", "#fff;", "", "100px", "rgb(999,0,0)"]) {
      expect(normalizeColor(bad)).toBeNull();
    }
  });
});

// ===========================================================================
// contract.ts — runFormatState erweitert um color
// ===========================================================================
describe("contract.ts — runFormatState mit color", () => {
  async function nodeWith(html: string, needle: string) {
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const nodes = enumerateEditableTextNodes(parseHTML(html).document);
    return nodes.find((n) => (n.textContent ?? "").includes(needle))!;
  }

  test("Lauf in <span style='color:#ff0000'> → color:'#ff0000'", async () => {
    const { runFormatState } = await import("./contract.ts");
    const node = await nodeWith(
      "<!doctype html><html><body><p><span style='color:#ff0000'>rot</span></p></body></html>",
      "rot",
    );
    expect(runFormatState(node).color).toBe("#ff0000");
  });

  test("ohne color-Vorfahr → color null", async () => {
    const { runFormatState } = await import("./contract.ts");
    const node = await nodeWith("<!doctype html><html><body><p>neutral</p></body></html>", "neutral");
    expect(runFormatState(node).color).toBeNull();
  });

  test("kombiniert: <strong> + color-span → bold true UND color gesetzt", async () => {
    const { runFormatState } = await import("./contract.ts");
    const node = await nodeWith(
      "<!doctype html><html><body><p><strong><span style='color:#00ff00'>x</span></strong></p></body></html>",
      "x",
    );
    const state = runFormatState(node);
    expect(state.bold).toBe(true);
    expect(state.color).toBe("#00ff00");
  });

  test("kombiniert mit href: color + <a> → beide gesetzt", async () => {
    const { runFormatState } = await import("./contract.ts");
    const node = await nodeWith(
      "<!doctype html><html><body><p><a href='https://x.de'><span style='color:#123456'>l</span></a></p></body></html>",
      "l",
    );
    const state = runFormatState(node);
    expect(state.href).toBe("https://x.de");
    expect(state.color).toBe("#123456");
  });
});

// ===========================================================================
// apply.ts — Range-Op (split + wrap)
// ===========================================================================
describe("apply.ts — applyEdits Range-Op (start/end split + wrap)", () => {
  let apply: typeof import("./apply.ts");

  beforeAll(async () => {
    apply = await import("./apply.ts");
  });

  // "Das ist wichtig" → idx 0; "ist" liegt bei start=4, end=7.
  const DOC = "<!doctype html><html><body><p>Das ist wichtig</p></body></html>";

  test("{idx,start,end,bold:true} → genau der Teilstring in <strong>, Rest intakt", async () => {
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 4, end: 7, bold: true }]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    const strong = document.querySelector("p strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("ist");
    // Umgebender Text bleibt vollständig lesbar.
    expect(document.querySelector("p")!.textContent).toBe("Das ist wichtig");
  });

  test("{idx,start,end,italic:true} → Teilstring in <em>", async () => {
    const { html: out } = apply.applyEdits(DOC, [{ idx: 0, start: 4, end: 7, italic: true }]);
    const em = parseHTML(out).document.querySelector("p em");
    expect(em).not.toBeNull();
    expect(em!.textContent).toBe("ist");
  });

  test("{idx,start,end,color:'#ff0000'} → <span style='color:#ff0000'> um den Teilstring", async () => {
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 4, end: 7, color: "#ff0000" }]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    const span = document.querySelector("p span[style]");
    expect(span).not.toBeNull();
    expect(span!.getAttribute("style")).toContain("color:#ff0000");
    expect(span!.textContent).toBe("ist");
  });

  test("Range-color normalisiert: '#abc' → style color:#aabbcc", async () => {
    const { html: out } = apply.applyEdits(DOC, [{ idx: 0, start: 0, end: 3, color: "#abc" }]);
    const span = parseHTML(out).document.querySelector("p span[style]");
    expect(span).not.toBeNull();
    expect(span!.getAttribute("style")).toContain("color:#aabbcc");
  });

  test("ungültige Range-Farbe (url(x)) → KEIN span, applied 0", async () => {
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 4, end: 7, color: "url(x)" }]);
    expect(applied).toBe(0);
    const { document } = parseHTML(out);
    expect(document.querySelector("p span[style]")).toBeNull();
    expect(document.querySelector("p")!.textContent).toBe("Das ist wichtig");
    expect(out).not.toContain("url(");
  });

  test("Range-Op mit gültigem bold + ungültiger Farbe → bold (Teilstring) wirkt, color verworfen", async () => {
    // Erzwingt das Range-Verhalten: <strong> umschließt NUR "ist" (nicht den
    // ganzen Lauf), und KEIN color-span trotz applied (nur bold zählte).
    const { html: out, applied } = apply.applyEdits(DOC, [
      { idx: 0, start: 4, end: 7, bold: true, color: "url(javascript:alert(1))" },
    ]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    expect(document.querySelector("p strong")!.textContent).toBe("ist"); // Teilbereich
    expect(document.querySelector("p span[style]")).toBeNull(); // color verworfen
    expect(out.toLowerCase()).not.toContain("url(");
    expect(out.toLowerCase()).not.toContain("javascript");
  });

  test("kombiniert bold+color in einer Range-Op → verschachtelt (strong + span)", async () => {
    const { html: out } = apply.applyEdits(DOC, [{ idx: 0, start: 4, end: 7, bold: true, color: "#0000ff" }]);
    const { document } = parseHTML(out);
    const strong = document.querySelector("p strong");
    expect(strong).not.toBeNull();
    const span = document.querySelector("p span[style]");
    expect(span).not.toBeNull();
    expect(span!.getAttribute("style")).toContain("color:#0000ff");
    // Beide umschließen denselben Teilstring "ist".
    expect(strong!.textContent).toBe("ist");
    expect(span!.textContent).toBe("ist");
  });

  test("zwei Range-Ops im selben Lauf (descending start) → beide korrekt angewandt", async () => {
    // "wichtig" = start 8, end 15 ; "Das" = start 0, end 3.
    // Reihenfolge im Array bewusst aufsteigend → Implementierung muss intern
    // descending sortieren, damit die Offsets nicht verrutschen.
    const { html: out, applied } = apply.applyEdits(DOC, [
      { idx: 0, start: 0, end: 3, bold: true },
      { idx: 0, start: 8, end: 15, italic: true },
    ]);
    expect(applied).toBe(2);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")!.textContent).toBe("Das");
    expect(document.querySelector("em")!.textContent).toBe("wichtig");
    // Gesamttext bleibt erhalten.
    expect(document.querySelector("p")!.textContent).toBe("Das ist wichtig");
  });

  test("Whole-Run-color {idx,color} (ohne start/end) → ganzer Lauf eingefärbt", async () => {
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, color: "#ff0000" }]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    const span = document.querySelector("p span[style]");
    expect(span).not.toBeNull();
    expect(span!.getAttribute("style")).toContain("color:#ff0000");
    expect(span!.textContent).toBe("Das ist wichtig"); // ganzer Lauf
  });

  test("start/end out-of-bounds werden geklemmt (Teilbereich bleibt Teilbereich)", async () => {
    // start negativ → 0; end 7 → "Das ist" (echter Teilbereich, NICHT der ganze
    // Lauf — erzwingt das Range-Splitting statt Whole-Run-bold).
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: -5, end: 7, bold: true }]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")!.textContent).toBe("Das ist"); // nur geklemmter Teil
    expect(document.querySelector("p")!.textContent).toBe("Das ist wichtig"); // Gesamttext intakt
  });

  test("start >= end → no-op (applied 0, kein Wrap)", async () => {
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 7, end: 4, bold: true }]);
    expect(applied).toBe(0);
    expect(parseHTML(out).document.querySelector("strong")).toBeNull();
    const eq = apply.applyEdits(DOC, [{ idx: 0, start: 5, end: 5, bold: true }]);
    expect(eq.applied).toBe(0);
  });

  test("idx out-of-bounds bei Range-Op → applied 0, kein Crash", async () => {
    const { applied } = apply.applyEdits(DOC, [{ idx: 999, start: 0, end: 3, bold: true }]);
    expect(applied).toBe(0);
  });
});

// ===========================================================================
// apply.ts — v3-B-Whole-Run-Ops bleiben gültig (Regression)
// ===========================================================================
describe("apply.ts — v3-B Whole-Run-Ops weiterhin grün", () => {
  let apply: typeof import("./apply.ts");
  beforeAll(async () => {
    apply = await import("./apply.ts");
  });
  const SIMPLE = "<!doctype html><html><body><p>Lauf</p></body></html>";

  test("{idx,bold:true} (ohne start/end) → ganzer Lauf in <strong>", async () => {
    const { html: out, applied } = apply.applyEdits(SIMPLE, [{ idx: 0, bold: true }]);
    expect(applied).toBe(1);
    expect(parseHTML(out).document.querySelector("strong")!.textContent).toBe("Lauf");
  });

  test("{idx,text} ändert weiterhin nur den Text", async () => {
    const { html: out } = apply.applyEdits(SIMPLE, [{ idx: 0, text: "Neu" }]);
    expect(parseHTML(out).document.querySelector("p")!.textContent).toBe("Neu");
  });

  test("{idx,link:'https://x.de'} → <a href>-Wrap (v3 unverändert)", async () => {
    const { html: out } = apply.applyEdits(SIMPLE, [{ idx: 0, link: "https://x.de" }]);
    const a = parseHTML(out).document.querySelector("a");
    expect(a!.getAttribute("href")).toBe("https://x.de");
  });
});

// ===========================================================================
// host.ts — /edit/save akzeptiert Range-Ops + color-Validierung
// ===========================================================================
describe("host.ts — /edit/save mit Range-Ops + Farbe", () => {
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
    const repoRoot = makeTmpDir("regoro-v4-");
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
    return Promise.resolve(host.handleEditorRequest(req, url, ctx));
  }

  /** Liefert einen Lauf-idx mit hinreichend langem Text (für start/end). */
  function longRunIdx(html: string): { idx: number; len: number } {
    const nodes = contract.enumerateEditableTextNodes(parseHTML(html).document);
    const i = nodes.findIndex((n) => (n.textContent ?? "").trim().length >= 6);
    return { idx: i, len: (nodes[i]!.textContent ?? "").length };
  }

  test("Save Range-Op {idx,start,end,bold:true} → Datei enthält <strong> um Teilstring, Commit +1, neuer fileHash", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const versionsBefore = git.listVersions(ctx.repoRoot, pagePath).length;
    const { idx } = longRunIdx(original);

    const res = await save(cookie, pagePath, apply.fileSha256(original), [
      { idx, start: 0, end: 4, bold: true },
    ]);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; fileHash: string };
    expect(json.ok).toBe(true);
    expect(json.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.fileHash).not.toBe(apply.fileSha256(original));

    const after = readFileSync(filePath, "utf8");
    expect(after).toContain("<strong>");
    expect(git.listVersions(ctx.repoRoot, pagePath).length).toBe(versionsBefore + 1);
    expect((res.headers.get("x-robots-tag") ?? "").toLowerCase()).toContain("noindex");
    expect((res.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");
  });

  test("Save Range-Op {idx,start,end,color:'#ff0000'} → <span style='color:#ff0000'> in Datei", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const { idx } = longRunIdx(original);

    const res = await save(cookie, pagePath, apply.fileSha256(original), [
      { idx, start: 0, end: 4, color: "#ff0000" },
    ]);
    expect(res.status).toBe(200);
    const after = readFileSync(filePath, "utf8");
    expect(after).toContain("color:#ff0000");
  });

  test("Save mit ungültiger Farbe (url(javascript:…)) → KEIN span/style geschrieben", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const { idx } = longRunIdx(original);

    const res = await save(cookie, pagePath, apply.fileSha256(original), [
      { idx, start: 0, end: 4, color: "url(javascript:alert(1))" },
    ]);
    // Save angenommen, color-Teil serverseitig verworfen.
    expect(res.status).toBe(200);
    const after = readFileSync(filePath, "utf8");
    expect(after.toLowerCase()).not.toContain("url(");
    expect(after.toLowerCase()).not.toContain("javascript");
  });

  test("Save Range-Op ohne Auth → 404, Datei unverändert", async () => {
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const { idx } = longRunIdx(original);
    const res = await save(null, pagePath, apply.fileSha256(original), [{ idx, start: 0, end: 4, bold: true }]);
    expect(res.status).toBe(404);
    expect(readFileSync(filePath, "utf8")).toBe(original);
  });

  test("Save Range-Op + falscher fileHash → 409", async () => {
    const cookie = authCookie();
    const res = await save(cookie, "site/index.html", "0".repeat(64), [{ idx: 0, start: 0, end: 2, bold: true }]);
    expect(res.status).toBe(409);
  });
});

// ===========================================================================
// v4 Validation: Lücken-Tests (alle gegen die Implementierung GRÜN)
// ===========================================================================
describe("contract.ts — normalizeColor/isValidColor Edgecases", () => {
  let c: typeof import("./contract.ts");
  beforeAll(async () => {
    c = await import("./contract.ts");
  });

  test("rgb() mit Whitespace → normalisiert; Grenzwerte 0/255", async () => {
    expect(c.normalizeColor("rgb( 255 , 0 , 0 )")).toBe("#ff0000");
    expect(c.normalizeColor("rgb(0,0,0)")).toBe("#000000");
    expect(c.normalizeColor("rgb(255,255,255)")).toBe("#ffffff");
  });

  test("#RGB-Großschreibung wird auf lowercase #rrggbb expandiert", async () => {
    expect(c.normalizeColor("#ABC")).toBe("#aabbcc");
    expect(c.normalizeColor("#Abc")).toBe("#aabbcc");
  });

  test("Alpha wird verworfen: rgba/#rgba/#rrggbbaa → reiner RGB-Hex", async () => {
    expect(c.normalizeColor("rgba(0,0,0,1)")).toBe("#000000");
    expect(c.normalizeColor("rgba(255,0,0,0.5)")).toBe("#ff0000");
    expect(c.normalizeColor("#ffff")).toBe("#ffffff"); // #rgba
    expect(c.normalizeColor("#ff0000ff")).toBe("#ff0000"); // #rrggbbaa
  });

  test("CSS-Injection-Versuche → null (kein normalizeColor-Bypass)", async () => {
    for (const bad of [
      "#fff;background:url(x)",
      "#fff;background:red",
      "expression(alert(1))",
      "rgb(50%,0,0)", // Prozent nicht erlaubt
      "\\3c script", // CSS-Escape-Sequenz
      "rgb(0,0,0)/**/x", // CSS-Kommentar-Anhang
      "rgb(256,0,0)", // out-of-range
      "rgba(0,0,0,2)", // alpha out-of-range
    ]) {
      expect(c.normalizeColor(bad)).toBeNull();
      expect(c.isValidColor(bad)).toBe(false);
    }
  });

  test("führender/abschließender Whitespace wird getrimmt (gültiges Hex bleibt gültig)", async () => {
    expect(c.normalizeColor("  #fff  ")).toBe("#ffffff");
    expect(c.normalizeColor("rgb(0,0,0) ")).toBe("#000000");
  });
});

describe("apply.ts — v4 Range-Split-Kanten", () => {
  let apply: typeof import("./apply.ts");
  beforeAll(async () => {
    apply = await import("./apply.ts");
  });
  const DOC = "<!doctype html><html><body><p>Das ist wichtig</p></body></html>";

  test("start==0 (Lauf-Anfang) → Wrap ab Beginn, Rest intakt", async () => {
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 0, end: 3, bold: true }]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")!.textContent).toBe("Das");
    expect(document.querySelector("p")!.textContent).toBe("Das ist wichtig");
  });

  test("end==len (Lauf-Ende) → Wrap bis Ende", async () => {
    const len = "Das ist wichtig".length;
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 8, end: len, bold: true }]);
    expect(applied).toBe(1);
    expect(parseHTML(out).document.querySelector("strong")!.textContent).toBe("wichtig");
  });

  test("benachbarte (aneinandergrenzende) Ranges im selben Lauf → beide getrennt gewrappt", async () => {
    // "Das" [0,3) bold + " ist" [3,7) italic — grenzen direkt aneinander.
    const { html: out, applied } = apply.applyEdits(DOC, [
      { idx: 0, start: 0, end: 3, bold: true },
      { idx: 0, start: 3, end: 7, italic: true },
    ]);
    expect(applied).toBe(2);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")!.textContent).toBe("Das");
    expect(document.querySelector("em")!.textContent).toBe(" ist");
    expect(document.querySelector("p")!.textContent).toBe("Das ist wichtig");
  });

  test("Range-Op auf bereits teilformatiertem Lauf → kein Crash, Gesamttext intakt", async () => {
    const first = apply.applyEdits(DOC, [{ idx: 0, start: 4, end: 7, italic: true }]); // "ist" kursiv
    // Nach dem Split ist die Lauf-Struktur anders; ein zweiter Range darf nicht crashen.
    const { html: out } = apply.applyEdits(first.html, [{ idx: 0, start: 0, end: 3, bold: true }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("em")).not.toBeNull(); // kursiv bleibt
    expect(document.body.textContent).toContain("Das");
    expect(document.body.textContent).toContain("wichtig");
  });

  test("Float-Offsets werden toleriert (truncated, kein Crash)", async () => {
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 1.5, end: 4.5, bold: true }]);
    expect(applied).toBe(1);
    expect(parseHTML(out).document.querySelector("strong")).not.toBeNull();
  });

  test("undefined start/end (fehlende Offsets) → Default = ganzer Lauf", async () => {
    // Über JSON wird ein fehlender (oder NaN→null) Offset zu undefined → Default greift.
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, color: "#ff0000" }]);
    expect(applied).toBe(1);
    expect(parseHTML(out).document.querySelector("span[style]")!.textContent).toBe("Das ist wichtig");
  });
});

describe("host.ts — v4 kombinierte Ops über HTTP (resolve-then-mutate)", () => {
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
    const repoRoot = makeTmpDir("regoro-v4c-");
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
  function longRunIdx(html: string): number {
    const nodes = contract.enumerateEditableTextNodes(parseHTML(html).document);
    return nodes.findIndex((n) => (n.textContent ?? "").trim().length >= 6);
  }

  test("Range-bold + Range-color auf dasselbe Wort in einem Save → strong + color-span verschachtelt", async () => {
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const idx = longRunIdx(original);

    const res = await save(pagePath, apply.fileSha256(original), [
      { idx, start: 0, end: 4, bold: true, color: "#ff0000" },
    ]);
    expect(res.status).toBe(200);
    const after = readFileSync(filePath, "utf8");
    expect(after).toContain("<strong>");
    expect(after).toContain("color:#ff0000");
    // span und strong sind verschachtelt (gleicher Teilstring).
    const { document } = parseHTML(after);
    const span = document.querySelector("span[style*='color:#ff0000']");
    expect(span).not.toBeNull();
    const strong = [...document.querySelectorAll("strong")].find(
      (s) => s.textContent === span!.textContent,
    );
    expect(strong).toBeDefined();
  });

  test("Range-Op + Insert + Delete in EINEM Save → alle drei greifen (resolve-then-mutate)", async () => {
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const versionsBefore = git.listVersions(ctx.repoRoot, pagePath).length;

    const idxLong = longRunIdx(original);
    const dels = contract.enumerateDeletable(parseHTML(original).document);
    const delIdx = dels.findIndex((e) => e.tagName === "H2");
    const h2Text = dels[delIdx]!.textContent;

    const res = await save(pagePath, apply.fileSha256(original), [
      { idx: idxLong, start: 0, end: 4, bold: true }, // Range-Op
      { op: "insert", afterDelIdx: delIdx }, // Struktur (insert)
      { op: "delete", delIdx }, // Struktur (delete) — Indizes auf Original aufgelöst
    ]);
    expect(res.status).toBe(200);
    const after = readFileSync(filePath, "utf8");
    expect(after).toContain("<strong>"); // Range-bold
    const h2sAfter = [...parseHTML(after).document.querySelectorAll("h2")].map((h) => h.textContent);
    expect(h2sAfter).not.toContain(h2Text); // delete
    expect([...parseHTML(after).document.querySelectorAll("p")].map((p) => p.textContent)).toContain(
      "Neuer Absatz",
    ); // insert
    expect(git.listVersions(ctx.repoRoot, pagePath).length).toBe(versionsBefore + 1);
  });

  // color:null = Farbe entfernen (Fix 50181b4): einfärben → speichern → color:null
  // → speichern → der color-span ist für diesen Lauf weg.
  test("Whole-Run-color:null auf eingefärbtem Lauf → color-span aus der Datei entfernt", async () => {
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const idx = longRunIdx(original);

    // 1. Einfärben + speichern.
    const r1 = await save(pagePath, apply.fileSha256(original), [{ idx, color: "#00ff00" }]);
    expect(r1.status).toBe(200);
    const mid = readFileSync(filePath, "utf8");
    expect(mid).toContain("color:#00ff00");

    // 2. color:null + speichern → Farbe weg.
    const r2 = await save(pagePath, apply.fileSha256(mid), [{ idx, color: null }]);
    expect(r2.status).toBe(200);
    const after = readFileSync(filePath, "utf8");
    expect(after).not.toContain("color:#00ff00");
  });
});

// ===========================================================================
// v4 Fix 50181b4: color:null = Farbe entfernen (Whole-Run-unwrap, analog link:null)
// ===========================================================================
describe("apply.ts — color:null entfernt den Farb-span", () => {
  let apply: typeof import("./apply.ts");
  let contract: typeof import("./contract.ts");
  beforeAll(async () => {
    apply = await import("./apply.ts");
    contract = await import("./contract.ts");
  });

  const COLORED =
    "<!doctype html><html><body><p>Anfang <span style=\"color:#ff0000\">rot</span> Ende</p></body></html>";

  test("{idx,color:null} auf eingefärbtem Lauf → color-span weg, Text + Geschwister intakt, applied ≥ 1", async () => {
    // idx des "rot"-Laufs ermitteln.
    const nodes = contract.enumerateEditableTextNodes(parseHTML(COLORED).document);
    const idx = nodes.findIndex((n) => (n.textContent ?? "") === "rot");
    expect(idx).toBeGreaterThanOrEqual(0);

    const { html: out, applied } = apply.applyEdits(COLORED, [{ idx, color: null }]);
    expect(applied).toBeGreaterThanOrEqual(1);
    const { document } = parseHTML(out);
    // Der color-span ist weg.
    expect(document.querySelector("span[style]")).toBeNull();
    // Text vollständig erhalten, Geschwister-Text unberührt.
    expect(document.querySelector("p")!.textContent).toBe("Anfang rot Ende");
  });

  test("{idx,color:null} auf Lauf OHNE Farbe → no-op (applied 0, kein Crash)", async () => {
    const PLAIN = "<!doctype html><html><body><p>schlicht</p></body></html>";
    const { html: out, applied } = apply.applyEdits(PLAIN, [{ idx: 0, color: null }]);
    expect(applied).toBe(0);
    expect(parseHTML(out).document.querySelector("p")!.textContent).toBe("schlicht");
  });

  test("color setzen, dann color:null → wieder beim Ausgangszustand (Text gleich, kein span)", async () => {
    const PLAIN = "<!doctype html><html><body><p>Wort</p></body></html>";
    const colored = apply.applyEdits(PLAIN, [{ idx: 0, color: "#abcdef" }]);
    expect(parseHTML(colored.html).document.querySelector("span[style]")).not.toBeNull();

    const cleared = apply.applyEdits(colored.html, [{ idx: 0, color: null }]);
    expect(cleared.applied).toBeGreaterThanOrEqual(1);
    const { document } = parseHTML(cleared.html);
    expect(document.querySelector("span[style]")).toBeNull();
    expect(document.querySelector("p")!.textContent).toBe("Wort");
  });
});
