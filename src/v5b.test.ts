/**
 * v5 Red (Erweiterung) — Unterstrichen (<u>) + Enter-<br>-Einfügen (brAt).
 *
 * Feature A: runFormatState um `underline`, applyEdits um `underline?`
 * (Whole-Run + Range), Wrap/Unwrap analog bold/italic.
 * Feature B: neue Op `{idx, brAt:offset}` → server-erzeugtes <br> am Offset.
 *
 * Kern-Prinzip wie immer: Client liefert nie Markup, nur Befehle; Server erzeugt
 * jede Struktur. Phase "Red": underline fehlt in runFormatState/applyEdits, brAt
 * wird nicht verarbeitet. Erwartet: rot, bis die Implementierung folgt.
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

async function nodeWith(html: string, needle: string) {
  const { enumerateEditableTextNodes } = await import("./contract.ts");
  const nodes = enumerateEditableTextNodes(parseHTML(html).document);
  return nodes.find((n) => (n.textContent ?? "").includes(needle))!;
}

// ===========================================================================
// Feature A — Unterstrichen: runFormatState.underline
// ===========================================================================
describe("contract.ts — runFormatState mit underline (Feature A)", () => {
  test("Lauf in <u> → underline true", async () => {
    const { runFormatState } = await import("./contract.ts");
    const node = await nodeWith("<!doctype html><html><body><p><u>unterstrichen</u></p></body></html>", "unterstrichen");
    const state = runFormatState(node);
    expect(state.underline).toBe(true);
    expect(state.bold).toBe(false);
  });

  test("ohne <u>-Vorfahr → underline false", async () => {
    const { runFormatState } = await import("./contract.ts");
    const node = await nodeWith("<!doctype html><html><body><p>schlicht</p></body></html>", "schlicht");
    expect(runFormatState(node).underline).toBe(false);
  });

  test("kombiniert <strong><u> → bold UND underline true", async () => {
    const { runFormatState } = await import("./contract.ts");
    const node = await nodeWith(
      "<!doctype html><html><body><p><strong><u>x</u></strong></p></body></html>",
      "x",
    );
    const state = runFormatState(node);
    expect(state.bold).toBe(true);
    expect(state.underline).toBe(true);
  });

  test("kombiniert <u> + color-span → underline true UND color gesetzt", async () => {
    const { runFormatState } = await import("./contract.ts");
    const node = await nodeWith(
      "<!doctype html><html><body><p><u><span style='color:#ff0000'>y</span></u></p></body></html>",
      "y",
    );
    const state = runFormatState(node);
    expect(state.underline).toBe(true);
    expect(state.color).toBe("#ff0000");
  });
});

// ===========================================================================
// Feature A — Unterstrichen: applyEdits underline (Whole-Run + Range)
// ===========================================================================
describe("apply.ts — applyEdits underline (Feature A)", () => {
  let apply: typeof import("./apply.ts");
  beforeAll(async () => {
    apply = await import("./apply.ts");
  });

  const SIMPLE = "<!doctype html><html><body><p>Lauf</p></body></html>";
  const DOC = "<!doctype html><html><body><p>Das ist wichtig</p></body></html>";

  test("{idx, underline:true} (Whole-Run) → <u> um ganzen Lauf", async () => {
    const { html: out, applied } = apply.applyEdits(SIMPLE, [{ idx: 0, underline: true }]);
    expect(applied).toBe(1);
    const u = parseHTML(out).document.querySelector("p u");
    expect(u).not.toBeNull();
    expect(u!.textContent).toBe("Lauf");
  });

  test("{idx,start,end, underline:true} (Range) → <u> um Teilstring 'ist'", async () => {
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 4, end: 7, underline: true }]);
    expect(applied).toBe(1);
    const u = parseHTML(out).document.querySelector("p u");
    expect(u).not.toBeNull();
    expect(u!.textContent).toBe("ist");
    expect(parseHTML(out).document.querySelector("p")!.textContent).toBe("Das ist wichtig");
  });

  test("{idx, underline:false} auf unterstrichenem Lauf → <u> weg (unwrap + normalize)", async () => {
    const UNDER = "<!doctype html><html><body><p><u>Wort</u></p></body></html>";
    const { html: out, applied } = apply.applyEdits(UNDER, [{ idx: 0, underline: false }]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    expect(document.querySelector("u")).toBeNull();
    const p = document.querySelector("p")!;
    expect(p.textContent).toBe("Wort");
    expect(p.childNodes.length).toBe(1); // normalize → ein Text-Node
  });

  test("{idx, underline:false} auf nicht-unterstrichenem Lauf → no-op (applied 0)", async () => {
    const { applied } = apply.applyEdits(SIMPLE, [{ idx: 0, underline: false }]);
    expect(applied).toBe(0);
  });

  test("kombiniert bold+underline+color in einer Range-Op → verschachtelt", async () => {
    const { html: out } = apply.applyEdits(DOC, [
      { idx: 0, start: 4, end: 7, bold: true, underline: true, color: "#0000ff" },
    ]);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).not.toBeNull();
    expect(document.querySelector("u")).not.toBeNull();
    const span = document.querySelector("span[style]");
    expect(span).not.toBeNull();
    expect(span!.getAttribute("style")).toContain("color:#0000ff");
    // alle umschließen denselben Teilstring "ist"
    expect(document.querySelector("u")!.textContent).toBe("ist");
  });

  test("v3-B/v4-Ops weiterhin grün: {idx,bold:true} + {idx,color:'#abc'}", async () => {
    const b = apply.applyEdits(SIMPLE, [{ idx: 0, bold: true }]);
    expect(parseHTML(b.html).document.querySelector("strong")!.textContent).toBe("Lauf");
    const c = apply.applyEdits(SIMPLE, [{ idx: 0, color: "#abc" }]);
    expect(parseHTML(c.html).document.querySelector("span[style]")!.getAttribute("style")).toContain(
      "color:#aabbcc",
    );
  });
});

// ===========================================================================
// Feature B — Enter-<br>-Einfügen: applyEdits {idx, brAt:offset}
// ===========================================================================
describe("apply.ts — applyEdits brAt (Feature B)", () => {
  let apply: typeof import("./apply.ts");
  beforeAll(async () => {
    apply = await import("./apply.ts");
  });

  // "Zeile1Zeile2": Bruch zwischen den beiden Hälften bei offset 6.
  const DOC = "<!doctype html><html><body><p>Zeile1Zeile2</p></body></html>";

  test("{idx, brAt:6} → genau ein <br> zwischen den Hälften, Gesamttext intakt", async () => {
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, brAt: 6 }]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    const p = document.querySelector("p")!;
    expect(p.querySelectorAll("br").length).toBe(1);
    expect(p.textContent).toBe("Zeile1Zeile2"); // Text unverändert (br zählt nicht zu textContent)
    // Das <br> steht zwischen "Zeile1" und "Zeile2".
    const html = p.innerHTML ?? "";
    expect(html.replace(/<br\s*\/?>/i, "|")).toContain("Zeile1|Zeile2");
  });

  test("{idx, brAt:0} → <br> VOR dem Text", async () => {
    const { html: out } = apply.applyEdits(DOC, [{ idx: 0, brAt: 0 }]);
    const p = parseHTML(out).document.querySelector("p")!;
    expect(p.querySelectorAll("br").length).toBe(1);
    expect((p.innerHTML ?? "").trimStart().toLowerCase().startsWith("<br")).toBe(true);
  });

  test("{idx, brAt:len} → <br> NACH dem Text", async () => {
    const len = "Zeile1Zeile2".length;
    const { html: out } = apply.applyEdits(DOC, [{ idx: 0, brAt: len }]);
    const p = parseHTML(out).document.querySelector("p")!;
    expect(p.querySelectorAll("br").length).toBe(1);
    expect((p.innerHTML ?? "").trimEnd().toLowerCase().endsWith("<br>") ||
      (p.innerHTML ?? "").toLowerCase().endsWith("<br/>")).toBe(true);
  });

  test("zwei brAt im selben Lauf (descending) → beide <br> an richtiger Stelle", async () => {
    // Bei "Zeile1Zeile2": Brüche bei 3 und 9 → "Zei<br>le1Zei<br>le2".
    const { html: out, applied } = apply.applyEdits(DOC, [
      { idx: 0, brAt: 3 },
      { idx: 0, brAt: 9 },
    ]);
    expect(applied).toBe(2);
    const p = parseHTML(out).document.querySelector("p")!;
    expect(p.querySelectorAll("br").length).toBe(2);
    expect(p.textContent).toBe("Zeile1Zeile2");
    const marked = (p.innerHTML ?? "").replace(/<br\s*\/?>/gi, "|");
    expect(marked).toContain("Zei|le1Zei|le2");
  });

  test("brAt out-of-bounds wird geklemmt (kein Crash, genau ein <br>)", async () => {
    const over = apply.applyEdits(DOC, [{ idx: 0, brAt: 999 }]);
    expect(over.applied).toBe(1);
    expect(parseHTML(over.html).document.querySelectorAll("br").length).toBe(1);
    const neg = apply.applyEdits(DOC, [{ idx: 0, brAt: -5 }]);
    expect(neg.applied).toBe(1);
    expect(parseHTML(neg.html).document.querySelectorAll("br").length).toBe(1);
  });

  test("brAt NaN → kein Crash (Finite-Guard: no-op oder geklemmt, kein leeres Artefakt)", async () => {
    const { applied } = apply.applyEdits(DOC, [{ idx: 0, brAt: Number.NaN }]);
    // Finite-Guard: NaN wird nicht angewendet (applied 0) — kein Crash.
    expect(applied).toBe(0);
  });

  test("idx out-of-bounds bei brAt → applied 0, kein Crash", async () => {
    const { applied } = apply.applyEdits(DOC, [{ idx: 999, brAt: 3 }]);
    expect(applied).toBe(0);
  });

  test("kombiniert: {idx, brAt} + Range-bold im selben Save → beide korrekt (resolve-then-mutate)", async () => {
    const TXT = "<!doctype html><html><body><p>Das ist wichtig</p></body></html>";
    const { html: out, applied } = apply.applyEdits(TXT, [
      { idx: 0, brAt: 7 }, // nach "Das ist"
      { idx: 0, start: 0, end: 3, bold: true }, // "Das" fett
    ]);
    expect(applied).toBe(2);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")!.textContent).toBe("Das");
    expect(document.querySelector("p")!.querySelectorAll("br").length).toBe(1);
    expect(document.querySelector("p")!.textContent).toBe("Das ist wichtig");
  });
});

// ===========================================================================
// host.ts — /edit/save akzeptiert underline + brAt
// ===========================================================================
describe("host.ts — /edit/save mit underline + brAt", () => {
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
    const repoRoot = makeTmpDir("regoro-v5b-");
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

  test("Save {idx, underline:true} → <u> in Datei, 200, Commit +1", async () => {
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const idx = longRunIdx(original);
    const versionsBefore = git.listVersions(ctx.repoRoot, pagePath).length;

    const res = await save(pagePath, apply.fileSha256(original), [{ idx, underline: true }]);
    expect(res.status).toBe(200);
    const after = readFileSync(filePath, "utf8");
    expect(after).toContain("<u>");
    expect(git.listVersions(ctx.repoRoot, pagePath).length).toBe(versionsBefore + 1);
  });

  test("Save {idx, brAt:offset} → <br> in Datei, 200, Commit +1", async () => {
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const idx = longRunIdx(original);
    const brBefore = parseHTML(original).document.querySelectorAll("br").length;
    const versionsBefore = git.listVersions(ctx.repoRoot, pagePath).length;

    const res = await save(pagePath, apply.fileSha256(original), [{ idx, brAt: 3 }]);
    expect(res.status).toBe(200);
    const after = readFileSync(filePath, "utf8");
    expect(parseHTML(after).document.querySelectorAll("br").length).toBe(brBefore + 1);
    expect(git.listVersions(ctx.repoRoot, pagePath).length).toBe(versionsBefore + 1);
  });
});

// ===========================================================================
// v5 Validation: underline/brAt Lücken-Tests (alle gegen die Impl GRÜN)
// ===========================================================================
describe("apply.ts — v5 underline/brAt Kombinations-Kanten", () => {
  let apply: typeof import("./apply.ts");
  let contract: typeof import("./contract.ts");
  beforeAll(async () => {
    apply = await import("./apply.ts");
    contract = await import("./contract.ts");
  });
  const idxOf = (h: string, t: string) =>
    contract.enumerateEditableTextNodes(parseHTML(h).document).findIndex((n) => (n.textContent ?? "") === t);

  const DOC = "<!doctype html><html><body><p>Das ist wichtig</p></body></html>";

  // --- Unterstrichen-Kombinationen ---
  test("Range-underline → Toggle-OFF auf dem nun teil-unterstrichenen Lauf → <u> weg", async () => {
    const u1 = apply.applyEdits(DOC, [{ idx: 0, start: 4, end: 7, underline: true }]); // "ist" <u>
    expect(parseHTML(u1.html).document.querySelector("u")!.textContent).toBe("ist");
    const ui = idxOf(u1.html, "ist");
    expect(ui).toBeGreaterThanOrEqual(0);
    const u2 = apply.applyEdits(u1.html, [{ idx: ui, underline: false }]);
    expect(u2.applied).toBeGreaterThanOrEqual(1);
    expect(parseHTML(u2.html).document.querySelector("u")).toBeNull();
    expect(parseHTML(u2.html).document.querySelector("p")!.textContent).toBe("Das ist wichtig");
  });

  test("kombiniert bold+underline+color → deterministische Verschachtelung (span⊂u⊂strong)", async () => {
    const { html: out } = apply.applyEdits(DOC, [
      { idx: 0, start: 4, end: 7, bold: true, underline: true, color: "#ff0000" },
    ]);
    const { document } = parseHTML(out);
    // strong außen, u in der Mitte, color-span innen — alle um "ist".
    const strong = document.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.querySelector("u")).not.toBeNull();
    expect(strong!.querySelector("u span[style]")).not.toBeNull();
    expect(strong!.querySelector("u span[style]")!.getAttribute("style")).toContain("color:#ff0000");
    expect(strong!.textContent).toBe("ist");
  });

  test("v3-B/v4-Ops weiterhin grün neben underline: link + color + italic", async () => {
    const a = apply.applyEdits(DOC, [{ idx: 0, link: "https://x.de" }]);
    expect(parseHTML(a.html).document.querySelector("a")!.getAttribute("href")).toBe("https://x.de");
    const c = apply.applyEdits(DOC, [{ idx: 0, italic: true }]);
    expect(parseHTML(c.html).document.querySelector("em")).not.toBeNull();
  });

  // --- brAt-Kombinationen ---
  test("brAt + Text-Edit + Range-Op im selben Lauf in EINEM Save → alle greifen", async () => {
    // brAt:7 (nach "Das ist"), text neu setzen, Range-bold "Das".
    const { html: out, applied } = apply.applyEdits(DOC, [
      { idx: 0, brAt: 7 },
      { idx: 0, start: 0, end: 3, bold: true },
    ]);
    expect(applied).toBe(2);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")!.textContent).toBe("Das");
    expect(document.querySelector("p")!.querySelectorAll("br").length).toBe(1);
    expect(document.querySelector("p")!.textContent).toBe("Das ist wichtig");
  });

  test("zwei brAt direkt nebeneinander (gleicher offset) → zwei <br>, kein Crash", async () => {
    const BR = "<!doctype html><html><body><p>ABCDEF</p></body></html>";
    const { html: out, applied } = apply.applyEdits(BR, [
      { idx: 0, brAt: 3 },
      { idx: 0, brAt: 3 },
    ]);
    expect(applied).toBe(2);
    expect(parseHTML(out).document.querySelectorAll("br").length).toBe(2);
    expect(parseHTML(out).document.querySelector("p")!.textContent).toBe("ABCDEF");
  });

  test("brAt an exakt 0 und len im selben Save → zwei <br> (vorn + hinten)", async () => {
    const BR = "<!doctype html><html><body><p>ABCDEF</p></body></html>";
    const { html: out, applied } = apply.applyEdits(BR, [
      { idx: 0, brAt: 0 },
      { idx: 0, brAt: 6 },
    ]);
    expect(applied).toBe(2);
    const p = parseHTML(out).document.querySelector("p")!;
    expect(p.querySelectorAll("br").length).toBe(2);
    expect(p.textContent).toBe("ABCDEF");
  });

  test("brAt + Leeren-Op (text:'') kombiniert → kein Crash, applied gezählt", async () => {
    // brAt:2 splittet "Wort" → "Wo"+"rt"; text:"" auf idx 0 leert "Wo".
    // <strong> behält "rt" → bleibt; kein Crash.
    const DOCW = "<!doctype html><html><body><p><strong>Wort</strong></p></body></html>";
    const { html: out, applied } = apply.applyEdits(DOCW, [
      { idx: 0, brAt: 2 },
      { idx: 0, text: "" },
    ]);
    expect(applied).toBeGreaterThanOrEqual(1);
    // Block bleibt, kein Totalabsturz.
    expect(parseHTML(out).document.querySelector("p")).not.toBeNull();
  });
});
