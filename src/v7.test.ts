/**
 * v7 Red — Bereichs-Entformatierung (Range-Unwrap).
 *
 * Range-Op {idx,start,end, bold?/italic?/underline?/color?} mit FALSY Format
 * (bold:false / italic:false / underline:false / color:null) entfernt das
 * jeweilige Format aus dem Bereich [start,end):
 *  - Voll-Abdeckung (Bereich == ganzer Wrapper-Inhalt) → Wrapper auspacken + normalize.
 *  - Teilbereich → Wrapper aufspalten, nur der Bereich wird entformatiert.
 * Truthy-Format (bold:true …) bleibt Wrap wie v4. Whole-Run-Ops unverändert.
 *
 * Phase "Red": applyRangeOp hat nur den Wrap-Pfad → falsy-Range ist no-op
 * (applied 0, Wrapper bleibt). Erwartet: rot, bis der Unwrap-Pfad folgt.
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
// apply.ts — Range-Unwrap: Voll-Abdeckung
// ===========================================================================
describe("apply.ts — Range-Unwrap Voll-Abdeckung (Wrapper auspacken)", () => {
  let apply: typeof import("./apply.ts");
  beforeAll(async () => {
    apply = await import("./apply.ts");
  });

  test("{start:0,end:len,bold:false} auf <strong>Wort</strong> → <strong> weg, 'Wort' plain", async () => {
    const DOC = "<!doctype html><html><body><p><strong>Wort</strong></p></body></html>";
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 0, end: 4, bold: false }]);
    expect(applied).toBeGreaterThanOrEqual(1);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).toBeNull();
    const p = document.querySelector("p")!;
    expect(p.textContent).toBe("Wort");
    expect(p.childNodes.length).toBe(1); // normalize → ein Text-Node
  });

  test("{start:0,end:len,italic:false} auf <em>Wort</em> → <em> weg", async () => {
    const DOC = "<!doctype html><html><body><p><em>Wort</em></p></body></html>";
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 0, end: 4, italic: false }]);
    expect(applied).toBeGreaterThanOrEqual(1);
    expect(parseHTML(out).document.querySelector("em")).toBeNull();
  });

  test("{start:0,end:len,underline:false} auf <u>Wort</u> → <u> weg", async () => {
    const DOC = "<!doctype html><html><body><p><u>Wort</u></p></body></html>";
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 0, end: 4, underline: false }]);
    expect(applied).toBeGreaterThanOrEqual(1);
    expect(parseHTML(out).document.querySelector("u")).toBeNull();
  });

  test("{start:0,end:len,color:null} auf Farb-<span> → span weg", async () => {
    const DOC =
      "<!doctype html><html><body><p><span style=\"color:#ff0000\">Wort</span></p></body></html>";
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 0, end: 4, color: null }]);
    expect(applied).toBeGreaterThanOrEqual(1);
    expect(parseHTML(out).document.querySelector("span[style]")).toBeNull();
    expect(parseHTML(out).document.querySelector("p")!.textContent).toBe("Wort");
  });

  test("strong-Count sinkt um 1 nach Voll-Unwrap", async () => {
    const DOC = "<!doctype html><html><body><p><strong>Eins</strong> <strong>Zwei</strong></p></body></html>";
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const idx = enumerateEditableTextNodes(parseHTML(DOC).document).findIndex((n) => (n.textContent ?? "") === "Eins");
    const before = parseHTML(DOC).document.querySelectorAll("strong").length;

    const { html: out } = apply.applyEdits(DOC, [{ idx, start: 0, end: 4, bold: false }]);
    const after = parseHTML(out).document.querySelectorAll("strong").length;
    expect(after).toBe(before - 1); // nur "Eins" entfettet
    expect(parseHTML(out).document.querySelector("strong")!.textContent).toBe("Zwei");
  });
});

// ===========================================================================
// apply.ts — Range-Unwrap: Teilbereich (Wrapper aufspalten)
// ===========================================================================
describe("apply.ts — Range-Unwrap Teilbereich (Wrapper aufspalten)", () => {
  let apply: typeof import("./apply.ts");
  beforeAll(async () => {
    apply = await import("./apply.ts");
  });

  test("<strong>ABCDE</strong> + {start:2,end:4,bold:false} → 'CD' nicht fett, 'AB'+'E' fett", async () => {
    const DOC = "<!doctype html><html><body><p><strong>ABCDE</strong></p></body></html>";
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 2, end: 4, bold: false }]);
    expect(applied).toBeGreaterThanOrEqual(1);
    const { document } = parseHTML(out);
    const p = document.querySelector("p")!;
    // Gesamttext bleibt erhalten.
    expect(p.textContent).toBe("ABCDE");
    // "CD" ist NICHT mehr in einem <strong>.
    const strongTexts = [...document.querySelectorAll("strong")].map((s) => s.textContent).join("|");
    expect(strongTexts).not.toContain("CD");
    // "AB" und "E" bleiben fett (in irgendeinem <strong>).
    const allStrong = [...document.querySelectorAll("strong")].map((s) => s.textContent ?? "").join("");
    expect(allStrong).toContain("AB");
    expect(allStrong).toContain("E");
    // "CD" als plain Text vorhanden (nicht in strong).
    const strongTextConcat = [...document.querySelectorAll("strong")].map((s) => s.textContent ?? "").join("");
    expect(strongTextConcat).not.toContain("C");
    expect(strongTextConcat).not.toContain("D");
  });

  test("Teilbereich italic:false: <em>ABCDE</em> + {2,4} → 'CD' nicht kursiv, Rest kursiv", async () => {
    const DOC = "<!doctype html><html><body><p><em>ABCDE</em></p></body></html>";
    const { html: out } = apply.applyEdits(DOC, [{ idx: 0, start: 2, end: 4, italic: false }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("p")!.textContent).toBe("ABCDE");
    const emConcat = [...document.querySelectorAll("em")].map((e) => e.textContent ?? "").join("");
    expect(emConcat).not.toContain("C");
    expect(emConcat).not.toContain("D");
    expect(emConcat).toContain("A");
    expect(emConcat).toContain("E");
  });

  test("Teilbereich color:null: <span style>ABCDE</span> + {2,4} → mittlerer Teil ohne Farbe", async () => {
    const DOC =
      "<!doctype html><html><body><p><span style=\"color:#ff0000\">ABCDE</span></p></body></html>";
    const { html: out } = apply.applyEdits(DOC, [{ idx: 0, start: 2, end: 4, color: null }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("p")!.textContent).toBe("ABCDE");
    const spanConcat = [...document.querySelectorAll("span[style]")].map((s) => s.textContent ?? "").join("");
    // "CD" ist nicht mehr im color-span.
    expect(spanConcat).not.toContain("C");
    expect(spanConcat).not.toContain("D");
  });
});

// ===========================================================================
// apply.ts — kombiniert + no-op + Gegenprobe
// ===========================================================================
describe("apply.ts — Range-Unwrap kombiniert / no-op / Gegenprobe", () => {
  let apply: typeof import("./apply.ts");
  beforeAll(async () => {
    apply = await import("./apply.ts");
  });

  test("{bold:false, italic:false} auf Bereich, der beides ist → beide Wrapper aus dem Bereich weg", async () => {
    const DOC = "<!doctype html><html><body><p><strong><em>Wort</em></strong></p></body></html>";
    const { html: out, applied } = apply.applyEdits(DOC, [
      { idx: 0, start: 0, end: 4, bold: false, italic: false },
    ]);
    expect(applied).toBeGreaterThanOrEqual(1);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).toBeNull();
    expect(document.querySelector("em")).toBeNull();
    expect(document.querySelector("p")!.textContent).toBe("Wort");
  });

  test("bold:false auf Bereich, der NICHT fett ist → no-op (applied 0, kein Schaden)", async () => {
    const DOC = "<!doctype html><html><body><p>schlicht</p></body></html>";
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 0, end: 4, bold: false }]);
    expect(applied).toBe(0);
    expect(parseHTML(out).document.querySelector("strong")).toBeNull();
    expect(parseHTML(out).document.querySelector("p")!.textContent).toBe("schlicht");
  });

  test("Gegenprobe: {start,end,bold:true} (wrappen) bleibt wie v4", async () => {
    const DOC = "<!doctype html><html><body><p>Das ist wichtig</p></body></html>";
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, start: 4, end: 7, bold: true }]);
    expect(applied).toBe(1);
    expect(parseHTML(out).document.querySelector("strong")!.textContent).toBe("ist");
    expect(parseHTML(out).document.querySelector("p")!.textContent).toBe("Das ist wichtig");
  });

  test("Whole-Run-{idx,bold:false} (ohne start/end) bleibt unverändert korrekt", async () => {
    const DOC = "<!doctype html><html><body><p><strong>Wort</strong></p></body></html>";
    const { html: out, applied } = apply.applyEdits(DOC, [{ idx: 0, bold: false }]);
    expect(applied).toBe(1);
    expect(parseHTML(out).document.querySelector("strong")).toBeNull();
  });
});

// ===========================================================================
// host.ts — POST /edit/save mit Range-Entformatierung
// ===========================================================================
describe("host.ts — /edit/save {idx,start,end,bold:false} (v7)", () => {
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
    const repoRoot = makeTmpDir("regoro-v7-");
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
  function longRunIdx(html: string): { idx: number; len: number } {
    const nodes = contract.enumerateEditableTextNodes(parseHTML(html).document);
    const i = nodes.findIndex((n) => (n.textContent ?? "").trim().length >= 6);
    return { idx: i, len: (nodes[i]!.textContent ?? "").length };
  }

  test("Range-bold:false auf voll-fettem Wort über /edit/save → <strong>-Count in Datei -1, 200, Commit +1", async () => {
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);

    // 1. Einen ganzen Lauf fett machen (Whole-Run bold) + speichern.
    const original = readFileSync(filePath, "utf8");
    const { idx } = longRunIdx(original);
    const r1 = await save(pagePath, apply.fileSha256(original), [{ idx, bold: true }]);
    expect(r1.status).toBe(200);
    const mid = readFileSync(filePath, "utf8");
    const strongMid = parseHTML(mid).document.querySelectorAll("strong").length;
    expect(strongMid).toBeGreaterThanOrEqual(1);
    const versionsMid = git.listVersions(ctx.repoRoot, pagePath).length;

    // 2. Denselben (nun fetten) Lauf per Range-bold:false über den ganzen Text entfetten.
    const midNodes = contract.enumerateEditableTextNodes(parseHTML(mid).document);
    // Den Lauf finden, der jetzt in <strong> steckt.
    const fi = midNodes.findIndex((n) => contract.runFormatState(n).bold === true);
    expect(fi).toBeGreaterThanOrEqual(0);
    const flen = (midNodes[fi]!.textContent ?? "").length;

    const r2 = await save(pagePath, apply.fileSha256(mid), [{ idx: fi, start: 0, end: flen, bold: false }]);
    expect(r2.status).toBe(200);

    const after = readFileSync(filePath, "utf8");
    expect(parseHTML(after).document.querySelectorAll("strong").length).toBe(strongMid - 1);
    expect(git.listVersions(ctx.repoRoot, pagePath).length).toBe(versionsMid + 1);
    expect((r2.headers.get("x-robots-tag") ?? "").toLowerCase()).toContain("noindex");
    expect((r2.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");
  });
});

// ===========================================================================
// v7 Validation: Range-Unwrap Lücken-Tests (alle gegen die Implementierung GRÜN)
// ===========================================================================
describe("apply.ts — v7 Range-Unwrap Grenzen/Verschachtelung/Split-Klon/Roundtrip", () => {
  let apply: typeof import("./apply.ts");
  let contract: typeof import("./contract.ts");
  beforeAll(async () => {
    apply = await import("./apply.ts");
    contract = await import("./contract.ts");
  });

  const FIVE = "<!doctype html><html><body><p><strong>ABCDE</strong></p></body></html>";

  // --- Teilbereich an Wrapper-Grenzen ---
  test("start==0 (linker Rand): {0,2,bold:false} → 'AB' plain, 'CDE' bleibt fett", async () => {
    const { html: out } = apply.applyEdits(FIVE, [{ idx: 0, start: 0, end: 2, bold: false }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("p")!.textContent).toBe("ABCDE");
    const strongTxt = [...document.querySelectorAll("strong")].map((s) => s.textContent ?? "").join("");
    expect(strongTxt).toBe("CDE"); // nur CDE bleibt fett
  });

  test("end==len (rechter Rand): {3,5,bold:false} → 'DE' plain, 'ABC' bleibt fett", async () => {
    const { html: out } = apply.applyEdits(FIVE, [{ idx: 0, start: 3, end: 5, bold: false }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("p")!.textContent).toBe("ABCDE");
    const strongTxt = [...document.querySelectorAll("strong")].map((s) => s.textContent ?? "").join("");
    expect(strongTxt).toBe("ABC");
  });

  // --- Bereich über das Wrapper-Ende hinaus ---
  test("Bereich über formatierten Teil hinaus → nur der formatierte Teil entformatiert", async () => {
    // <strong>AB</strong>CDE: "AB" fett, "CDE" plain. Range auf den "AB"-Lauf mit
    // end > Lauf-Länge wird auf [0,len] geklemmt → ganzer Wrapper weg, Text intakt.
    const DOC = "<!doctype html><html><body><p><strong>AB</strong>CDE</p></body></html>";
    const nodes = contract.enumerateEditableTextNodes(parseHTML(DOC).document);
    const iAB = nodes.findIndex((n) => (n.textContent ?? "") === "AB");
    const { html: out } = apply.applyEdits(DOC, [{ idx: iAB, start: 0, end: 5, bold: false }]);
    const { document } = parseHTML(out);
    expect(document.querySelectorAll("strong").length).toBe(0);
    expect(document.querySelector("p")!.textContent).toBe("ABCDE");
  });

  // --- Verschachtelte Wrapper: selektiv ---
  test("verschachtelt <strong><em>Wort</em></strong>: nur {bold:false} → <strong> weg, <em> bleibt", async () => {
    const N = "<!doctype html><html><body><p><strong><em>Wort</em></strong></p></body></html>";
    const { html: out } = apply.applyEdits(N, [{ idx: 0, start: 0, end: 4, bold: false }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).toBeNull();
    expect(document.querySelector("em")).not.toBeNull();
    expect(document.querySelector("em")!.textContent).toBe("Wort");
  });

  test("verschachtelt: nur {italic:false} → <em> weg, <strong> bleibt", async () => {
    const N = "<!doctype html><html><body><p><strong><em>Wort</em></strong></p></body></html>";
    const { html: out } = apply.applyEdits(N, [{ idx: 0, start: 0, end: 4, italic: false }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("em")).toBeNull();
    expect(document.querySelector("strong")).not.toBeNull();
    expect(document.querySelector("strong")!.textContent).toBe("Wort");
  });

  // --- Split-Klon style-Sauberkeit ---
  test("Farb-Split-Klon trägt NUR color:#hex (nichts anderes) auf 'AB' und 'E'", async () => {
    const C = "<!doctype html><html><body><p><span style=\"color:#ff0000\">ABCDE</span></p></body></html>";
    const { html: out } = apply.applyEdits(C, [{ idx: 0, start: 2, end: 4, color: null }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("p")!.textContent).toBe("ABCDE");
    const spans = [...document.querySelectorAll("span[style]")];
    // "AB" und "E" behalten die Farbe; "CD" ist plain.
    const spanTexts = spans.map((s) => s.textContent ?? "").sort();
    expect(spanTexts).toEqual(["AB", "E"]);
    for (const s of spans) {
      // Klon-style ist EXAKT color:#ff0000 — kein Semikolon-Anhang, kein anderes Property.
      expect(s.getAttribute("style")).toBe("color:#ff0000");
    }
    // "CD" liegt außerhalb jedes color-spans.
    const inSpan = spans.map((s) => s.textContent ?? "").join("");
    expect(inSpan).not.toContain("C");
    expect(inSpan).not.toContain("D");
  });

  // --- Roundtrip ---
  test("Roundtrip: Range-bold setzen → Range-bold:false → Ausgangszustand (kein Rest-<strong>)", async () => {
    const DOC = "<!doctype html><html><body><p>Das ist wichtig</p></body></html>";
    // "ist" (4..7) fett.
    const wrapped = apply.applyEdits(DOC, [{ idx: 0, start: 4, end: 7, bold: true }]);
    expect(parseHTML(wrapped.html).document.querySelector("strong")!.textContent).toBe("ist");

    // Denselben Bereich entfetten — den nun-fetten "ist"-Lauf finden.
    const wNodes = contract.enumerateEditableTextNodes(parseHTML(wrapped.html).document);
    const iIst = wNodes.findIndex((n) => (n.textContent ?? "") === "ist");
    const ilen = (wNodes[iIst]!.textContent ?? "").length;
    const unwrapped = apply.applyEdits(wrapped.html, [{ idx: iIst, start: 0, end: ilen, bold: false }]);

    const { document } = parseHTML(unwrapped.html);
    expect(document.querySelector("strong")).toBeNull(); // kein Rest
    expect(document.querySelector("p")!.textContent).toBe("Das ist wichtig"); // Text gleich
  });

  test("Roundtrip kombiniert: Range-bold:false + brAt + Text-Op im selben Save → alle korrekt", async () => {
    const DOC = "<!doctype html><html><body><p><strong>Wort</strong></p><p>Anderer</p></body></html>";
    const nodes = contract.enumerateEditableTextNodes(parseHTML(DOC).document);
    const iWort = nodes.findIndex((n) => (n.textContent ?? "") === "Wort");
    const iAnderer = nodes.findIndex((n) => (n.textContent ?? "") === "Anderer");

    const { html: out, applied } = apply.applyEdits(DOC, [
      { idx: iWort, start: 0, end: 4, bold: false }, // entfetten
      { idx: iAnderer, brAt: 3 }, // <br> einfügen
      { idx: iAnderer, text: "Geändert" }, // Text setzen
    ]);
    expect(applied).toBe(3);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).toBeNull(); // entfettet
    expect(document.querySelectorAll("br").length).toBe(1); // br eingefügt
    expect(document.body.textContent).toContain("Geändert"); // Text gesetzt
  });
});
