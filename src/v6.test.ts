/**
 * v6 Red — <br> löschbar machen (befehlsbasiert).
 *
 * Contract: enumerateBrs(document) (contract.ts), data-edit-br-idx (serve.ts),
 * neue Struktur-Op {op:"deleteBr", brIdx} (apply.ts) → enumerateBrs[brIdx]
 * entfernen + parent.normalize(). Resolve-then-mutate mit den übrigen Ops.
 *
 * Phase "Red": enumerateBrs fehlt; applyEdits verarbeitet deleteBr nicht;
 * renderEditView setzt kein data-edit-br-idx. Erwartet: rot, bis Implementierung.
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
// contract.ts — enumerateBrs
// ===========================================================================
describe("contract.ts — enumerateBrs (alle <br> in Doku-Reihenfolge)", () => {
  test("<p>A<br>B<br>C</p> → 2 <br> in Reihenfolge", async () => {
    const { enumerateBrs } = await import("./contract.ts");
    const { document } = parseHTML("<!doctype html><html><body><p>A<br>B<br>C</p></body></html>");
    const brs = enumerateBrs(document);
    expect(brs.length).toBe(2);
    for (const br of brs) expect(br.tagName).toBe("BR");
  });

  test("<br> in <head>/<script>/<template> werden ignoriert; nur body-<br> zählen", async () => {
    const { enumerateBrs } = await import("./contract.ts");
    const { document } = parseHTML(
      "<!doctype html><html><head><br></head><body>" +
        "<script>var x='<br>';</script>" +
        "<template><br></template>" +
        "<p>echt<br>weiter</p>" +
        "</body></html>",
    );
    const brs = enumerateBrs(document);
    expect(brs.length).toBe(1); // nur das <br> im sichtbaren <p>
  });

  test("Determinismus: zweimal parsen → identische Anzahl", async () => {
    const { enumerateBrs } = await import("./contract.ts");
    const html = "<!doctype html><html><body><p>1<br>2</p><div>3<br>4<br>5</div></body></html>";
    const a = enumerateBrs(parseHTML(html).document).length;
    const b = enumerateBrs(parseHTML(html).document).length;
    expect(a).toBe(b);
    expect(a).toBe(3);
  });

  test("keine <br> → leeres Array", async () => {
    const { enumerateBrs } = await import("./contract.ts");
    const { document } = parseHTML("<!doctype html><html><body><p>ohne</p></body></html>");
    expect(enumerateBrs(document).length).toBe(0);
  });
});

// ===========================================================================
// serve.ts — renderEditView setzt data-edit-br-idx
// ===========================================================================
describe("serve.ts — renderEditView markiert <br> mit data-edit-br-idx", () => {
  const opts = { pagePath: "site/index.html", fileHash: "x", scriptUrl: "/edit-assets/overlay.js" };

  test("jedes <br> trägt fortlaufendes data-edit-br-idx", async () => {
    const { renderEditView } = await import("./serve.ts");
    const { enumerateBrs } = await import("./contract.ts");
    const html = "<!doctype html><html><body><p>A<br>B<br>C</p></body></html>";
    const n = enumerateBrs(parseHTML(html).document).length;

    const out = renderEditView(html, opts);
    const idxs = [...out.matchAll(/data-edit-br-idx="(\d+)"/g)].map((m) => Number(m[1]));
    expect(idxs.length).toBe(n);
    expect(idxs).toEqual([0, 1]);
  });

  test("ohne <br> → kein data-edit-br-idx im Output", async () => {
    const { renderEditView } = await import("./serve.ts");
    const out = renderEditView("<!doctype html><html><body><p>ohne</p></body></html>", opts);
    expect(out).not.toContain("data-edit-br-idx");
  });
});

// ===========================================================================
// apply.ts — applyEdits {op:"deleteBr", brIdx}
// ===========================================================================
describe("apply.ts — applyEdits deleteBr-Op", () => {
  let apply: typeof import("./apply.ts");
  beforeAll(async () => {
    apply = await import("./apply.ts");
  });

  test("{op:'deleteBr', brIdx:0} auf Zeile1<br>Zeile2 → <br> weg, Text zusammengeführt (normalize)", async () => {
    const DOC = "<!doctype html><html><body><p>Zeile1<br>Zeile2</p></body></html>";
    const { html: out, applied } = apply.applyEdits(DOC, [{ op: "deleteBr", brIdx: 0 }]);
    expect(applied).toBe(1);
    const { document } = parseHTML(out);
    const p = document.querySelector("p")!;
    expect(p.querySelectorAll("br").length).toBe(0);
    expect(p.textContent).toBe("Zeile1Zeile2");
    // normalize: benachbarte Text-Nodes zusammengeführt → ein Kind.
    expect(p.childNodes.length).toBe(1);
  });

  test("bei zwei <br> wird nur das adressierte entfernt", async () => {
    const DOC = "<!doctype html><html><body><p>A<br>B<br>C</p></body></html>";
    const { html: out, applied } = apply.applyEdits(DOC, [{ op: "deleteBr", brIdx: 1 }]);
    expect(applied).toBe(1);
    const p = parseHTML(out).document.querySelector("p")!;
    expect(p.querySelectorAll("br").length).toBe(1); // eines bleibt
    expect(p.textContent).toBe("ABC");
  });

  test("brIdx:0 entfernt das ERSTE <br> (Reihenfolge)", async () => {
    const DOC = "<!doctype html><html><body><p>A<br>B<br>C</p></body></html>";
    const { html: out } = apply.applyEdits(DOC, [{ op: "deleteBr", brIdx: 0 }]);
    const p = parseHTML(out).document.querySelector("p")!;
    expect(p.querySelectorAll("br").length).toBe(1);
    // Nach Entfernen des ersten <br>: "AB" + <br> + "C".
    const marked = (p.innerHTML ?? "").replace(/<br\s*\/?>/i, "|");
    expect(marked).toContain("AB|C");
  });

  test("out-of-range brIdx → no-op (applied 0, kein Crash)", async () => {
    const DOC = "<!doctype html><html><body><p>A<br>B</p></body></html>";
    for (const brIdx of [5, -1, 99]) {
      const { html: out, applied } = apply.applyEdits(DOC, [{ op: "deleteBr", brIdx }]);
      expect(applied).toBe(0);
      expect(parseHTML(out).document.querySelectorAll("br").length).toBe(1); // unverändert
    }
  });

  test("kombiniert: deleteBr + Text-Op im selben Save → beide korrekt (resolve-then-mutate)", async () => {
    const DOC = "<!doctype html><html><body><p>Erster<br>Zweiter</p><p>Anderer</p></body></html>";
    // Text-Op trifft den "Anderer"-Lauf; deleteBr trifft das <br> im ersten <p>.
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const nodes = enumerateEditableTextNodes(parseHTML(DOC).document);
    const idxAnderer = nodes.findIndex((n) => (n.textContent ?? "") === "Anderer");
    expect(idxAnderer).toBeGreaterThanOrEqual(0);

    const { html: out, applied } = apply.applyEdits(DOC, [
      { op: "deleteBr", brIdx: 0 },
      { idx: idxAnderer, text: "Geändert" },
    ]);
    expect(applied).toBe(2);
    const { document } = parseHTML(out);
    expect(document.querySelectorAll("br").length).toBe(0); // <br> weg
    const ps = [...document.querySelectorAll("p")].map((p) => p.textContent);
    expect(ps).toContain("ErsterZweiter"); // zusammengeführt
    expect(ps).toContain("Geändert"); // Text-Op korrekt getroffen
  });

  test("kombiniert: deleteBr + Range-bold im selben Lauf → beide korrekt", async () => {
    const DOC = "<!doctype html><html><body><p>Das ist<br>wichtig</p></body></html>";
    const { enumerateEditableTextNodes } = await import("./contract.ts");
    const nodes = enumerateEditableTextNodes(parseHTML(DOC).document);
    const idxDas = nodes.findIndex((n) => (n.textContent ?? "").includes("Das ist"));

    const { html: out, applied } = apply.applyEdits(DOC, [
      { op: "deleteBr", brIdx: 0 },
      { idx: idxDas, start: 0, end: 3, bold: true },
    ]);
    expect(applied).toBe(2);
    const { document } = parseHTML(out);
    expect(document.querySelectorAll("br").length).toBe(0);
    expect(document.querySelector("strong")!.textContent).toBe("Das");
  });
});

// ===========================================================================
// host.ts — POST /edit/save mit deleteBr
// ===========================================================================
describe("host.ts — /edit/save {op:'deleteBr', brIdx} (v6)", () => {
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
    const repoRoot = makeTmpDir("regoro-v6-");
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

  test("Save {op:'deleteBr', brIdx} → <br>-Anzahl in Datei -1, 200, Commit +1", async () => {
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);

    // 1. Erst ein <br> einfügen (brAt), damit es eines zu löschen gibt.
    const original = readFileSync(filePath, "utf8");
    const idx = longRunIdx(original);
    const r1 = await save(pagePath, apply.fileSha256(original), [{ idx, brAt: 3 }]);
    expect(r1.status).toBe(200);
    const mid = readFileSync(filePath, "utf8");
    const brMid = parseHTML(mid).document.querySelectorAll("br").length;
    expect(brMid).toBeGreaterThanOrEqual(1);
    const versionsMid = git.listVersions(ctx.repoRoot, pagePath).length;

    // 2. Das soeben eingefügte <br> wieder löschen.
    const brs = contract.enumerateBrs(parseHTML(mid).document);
    const brIdx = brs.length - 1; // das zuletzt eingefügte
    const r2 = await save(pagePath, apply.fileSha256(mid), [{ op: "deleteBr", brIdx }]);
    expect(r2.status).toBe(200);

    const after = readFileSync(filePath, "utf8");
    expect(parseHTML(after).document.querySelectorAll("br").length).toBe(brMid - 1);
    expect(git.listVersions(ctx.repoRoot, pagePath).length).toBe(versionsMid + 1);
    expect((r2.headers.get("x-robots-tag") ?? "").toLowerCase()).toContain("noindex");
    expect((r2.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");
  });

  test("Save deleteBr ohne Auth → 404, Datei unverändert", async () => {
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);
    const original = readFileSync(filePath, "utf8");
    const url = new URL("http://localhost:8788/edit/save");
    const req = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pagePath, fileHash: apply.fileSha256(original), edits: [{ op: "deleteBr", brIdx: 0 }] }),
    });
    const res = await Promise.resolve(host.handleEditorRequest(req, url, ctx));
    expect(res.status).toBe(404);
    expect(readFileSync(filePath, "utf8")).toBe(original);
  });
});

// ===========================================================================
// v6 Validation: deleteBr-Lücken-Tests (alle gegen die Implementierung GRÜN)
// ===========================================================================
describe("apply.ts — v6 deleteBr Positionen + Kombinationen + Inline-Wrapper", () => {
  let apply: typeof import("./apply.ts");
  let contract: typeof import("./contract.ts");
  beforeAll(async () => {
    apply = await import("./apply.ts");
    contract = await import("./contract.ts");
  });

  // "A<br>B<br>C<br>D" → 3 <br>: erstes/mittleres/letztes adressierbar.
  const THREE = "<!doctype html><html><body><p>A<br>B<br>C<br>D</p></body></html>";

  test("deleteBr erstes (brIdx:0) von 3 → AB|C|D", async () => {
    const { html: out } = apply.applyEdits(THREE, [{ op: "deleteBr", brIdx: 0 }]);
    const p = parseHTML(out).document.querySelector("p")!;
    expect(p.querySelectorAll("br").length).toBe(2);
    expect((p.innerHTML ?? "").replace(/<br\s*\/?>/gi, "|")).toContain("AB|C|D");
  });

  test("deleteBr mittleres (brIdx:1) von 3 → A|BC|D", async () => {
    const { html: out } = apply.applyEdits(THREE, [{ op: "deleteBr", brIdx: 1 }]);
    const p = parseHTML(out).document.querySelector("p")!;
    expect(p.querySelectorAll("br").length).toBe(2);
    expect((p.innerHTML ?? "").replace(/<br\s*\/?>/gi, "|")).toContain("A|BC|D");
  });

  test("deleteBr letztes (brIdx:2) von 3 → A|B|CD", async () => {
    const { html: out } = apply.applyEdits(THREE, [{ op: "deleteBr", brIdx: 2 }]);
    const p = parseHTML(out).document.querySelector("p")!;
    expect(p.querySelectorAll("br").length).toBe(2);
    expect((p.innerHTML ?? "").replace(/<br\s*\/?>/gi, "|")).toContain("A|B|CD");
  });

  test("<br> innerhalb eines Inline-Wrappers (<strong>A<br>B</strong>) wird gefunden + entfernt + normalize", async () => {
    const W = "<!doctype html><html><body><p><strong>A<br>B</strong></p></body></html>";
    expect(contract.enumerateBrs(parseHTML(W).document).length).toBe(1);

    const { html: out, applied } = apply.applyEdits(W, [{ op: "deleteBr", brIdx: 0 }]);
    expect(applied).toBe(1);
    const strong = parseHTML(out).document.querySelector("strong")!;
    expect(strong.querySelectorAll("br").length).toBe(0);
    expect(strong.textContent).toBe("AB");
    expect(strong.childNodes.length).toBe(1); // normalize führte A + B zusammen
  });

  test("deleteBr + brAt in EINEM Save (br löschen UND neues einfügen) → resolve-then-mutate", async () => {
    const M = "<!doctype html><html><body><p>X<br>Y</p></body></html>";
    const nodes = contract.enumerateEditableTextNodes(parseHTML(M).document);
    const idxX = nodes.findIndex((n) => (n.textContent ?? "") === "X");

    const { html: out, applied } = apply.applyEdits(M, [
      { op: "deleteBr", brIdx: 0 }, // bestehendes <br> weg
      { idx: idxX, brAt: 1 }, // neues <br> nach "X" einfügen
    ]);
    expect(applied).toBe(2);
    // netto: ein <br> (das alte weg, ein neues da).
    expect(parseHTML(out).document.querySelectorAll("br").length).toBe(1);
  });

  test("deleteBr + Range-bold im selben Save → beide korrekt", async () => {
    const DOC = "<!doctype html><html><body><p>Das ist<br>wichtig</p></body></html>";
    const nodes = contract.enumerateEditableTextNodes(parseHTML(DOC).document);
    const idxDas = nodes.findIndex((n) => (n.textContent ?? "").includes("Das ist"));
    const { html: out, applied } = apply.applyEdits(DOC, [
      { op: "deleteBr", brIdx: 0 },
      { idx: idxDas, start: 0, end: 3, bold: true },
    ]);
    expect(applied).toBe(2);
    const { document } = parseHTML(out);
    expect(document.querySelectorAll("br").length).toBe(0);
    expect(document.querySelector("strong")!.textContent).toBe("Das");
  });

  test("out-of-range/negativ brIdx → no-op (applied 0), Dokument unverändert", async () => {
    const DOC = "<!doctype html><html><body><p>A<br>B</p></body></html>";
    const before = parseHTML(DOC).document.querySelectorAll("br").length;
    for (const brIdx of [-1, 5, 1.5]) {
      const { html: out, applied } = apply.applyEdits(DOC, [{ op: "deleteBr", brIdx }]);
      expect(applied).toBe(0);
      expect(parseHTML(out).document.querySelectorAll("br").length).toBe(before);
    }
  });
});

describe("serve.ts vs apply.ts — data-edit-br-idx-Nummerierung deterministisch identisch", () => {
  test("serve-Walk (data-edit-br-idx) == apply-Walk (enumerateBrs) über mehrere Container", async () => {
    const { renderEditView } = await import("./serve.ts");
    const { enumerateBrs } = await import("./contract.ts");
    // <br> verteilt über <p>, <strong>, <div> — beide Walks müssen identisch zählen/ordnen.
    const html =
      "<!doctype html><html><body><p>1<br>2</p><strong>3<br>4</strong><div>5<br>6<br>7</div></body></html>";

    const applyCount = enumerateBrs(parseHTML(html).document).length;
    const out = renderEditView(html, { pagePath: "p", fileHash: "x", scriptUrl: "/o.js" });
    const serveIdxs = [...out.matchAll(/data-edit-br-idx="(\d+)"/g)].map((m) => Number(m[1]));

    expect(serveIdxs.length).toBe(applyCount); // gleiche Anzahl
    expect(serveIdxs).toEqual([...Array(applyCount).keys()]); // fortlaufend 0..n-1, in Doku-Reihenfolge
  });
});
