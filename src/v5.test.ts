/**
 * v5 Red — leere Bausteine/Hüllen beim Wort-Löschen aufräumen.
 *
 * Ein fettes/kursives/gefärbtes Wort ist ein eigener Lauf in einer Inline-Hülle
 * (<strong>/<em>/<a>/<span style="color:…">). Löscht man es (Client schickt
 * {idx, text:""}), soll der Server NICHT nur den Text leeren, sondern den leer
 * gewordenen Text-Node UND die leer gewordenen Inline-Hüllen rekursiv entfernen —
 * aber NIEMALS das umgebende Block-Element.
 *
 * Phase "Red": aktuelles applyEdits setzt nur nodeValue="" → die leere Hülle
 * (<strong></strong>) bleibt stehen. Erwartet: rot, bis das Aufräumen folgt.
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

/** Findet den idx des editierbaren Text-Nodes mit exakt diesem Text. */
async function idxOf(html: string, text: string): Promise<number> {
  const { enumerateEditableTextNodes } = await import("./contract.ts");
  const nodes = enumerateEditableTextNodes(parseHTML(html).document);
  return nodes.findIndex((n) => (n.textContent ?? "") === text);
}

// ===========================================================================
// apply.ts — leere Hüllen beim Wort-Löschen aufräumen
// ===========================================================================
describe("apply.ts — {idx,text:''} räumt leere Inline-Hüllen auf (v5)", () => {
  let apply: typeof import("./apply.ts");

  beforeAll(async () => {
    apply = await import("./apply.ts");
  });

  test("fettes Wort geleert → <strong> weg, Geschwister-Text intakt", async () => {
    const DOC = "<!doctype html><html><body><p>Das ist <strong>Wort</strong> und</p></body></html>";
    const idx = await idxOf(DOC, "Wort");
    expect(idx).toBeGreaterThanOrEqual(0);

    const { html: out, applied } = apply.applyEdits(DOC, [{ idx, text: "" }]);
    expect(applied).toBeGreaterThanOrEqual(1);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).toBeNull(); // leere Hülle entfernt
    // Geschwister-Text bleibt — kein leerer Rest.
    expect(document.querySelector("p")!.textContent).toBe("Das ist  und");
  });

  test("verschachtelt <strong><em>Wort</em></strong> voll geleert → BEIDE Hüllen weg", async () => {
    const DOC =
      "<!doctype html><html><body><p>A <strong><em>Wort</em></strong> B</p></body></html>";
    const idx = await idxOf(DOC, "Wort");
    const { html: out } = apply.applyEdits(DOC, [{ idx, text: "" }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).toBeNull();
    expect(document.querySelector("em")).toBeNull();
    expect(document.querySelector("p")!.textContent).toBe("A  B");
  });

  test("Farb-<span style='color:#ff0000'>Wort</span> geleert → span weg", async () => {
    const DOC =
      "<!doctype html><html><body><p>X <span style=\"color:#ff0000\">Wort</span> Y</p></body></html>";
    const idx = await idxOf(DOC, "Wort");
    const { html: out } = apply.applyEdits(DOC, [{ idx, text: "" }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("span[style]")).toBeNull();
    expect(document.querySelector("p")!.textContent).toBe("X  Y");
  });

  test("Link-<a href>Wort</a> geleert → <a> weg", async () => {
    const DOC =
      "<!doctype html><html><body><p>Vor <a href=\"https://x.de\">Wort</a> nach</p></body></html>";
    const idx = await idxOf(DOC, "Wort");
    const { html: out } = apply.applyEdits(DOC, [{ idx, text: "" }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("a")).toBeNull();
    expect(document.querySelector("p")!.textContent).toBe("Vor  nach");
  });

  test("plain Text-Node mit Geschwister-Elementen geleert → Text weg, <a> + Resttext bleiben", async () => {
    const DOC = "<!doctype html><html><body><p>A <a href=\"#\">x</a> B</p></body></html>";
    // idx von "A " (direkter Text vor dem Link).
    const idx = await idxOf(DOC, "A ");
    expect(idx).toBeGreaterThanOrEqual(0);

    const { html: out } = apply.applyEdits(DOC, [{ idx, text: "" }]);
    const { document } = parseHTML(out);
    // Der Link + sein Text + " B" bleiben erhalten.
    expect(document.querySelector("a")).not.toBeNull();
    expect(document.querySelector("a")!.textContent).toBe("x");
    expect(document.querySelector("p")!.textContent).toContain("x");
    expect(document.querySelector("p")!.textContent).toContain(" B");
    // "A " ist weg.
    expect(document.querySelector("p")!.textContent!.startsWith("A ")).toBe(false);
  });

  test("Block-Element wird NICHT entfernt, auch wenn der Lauf der einzige Inhalt war", async () => {
    const DOC = "<!doctype html><html><body><p><strong>Wort</strong></p></body></html>";
    const idx = await idxOf(DOC, "Wort");
    const { html: out } = apply.applyEdits(DOC, [{ idx, text: "" }]);
    const { document } = parseHTML(out);
    // <strong> weg, aber das <p> bleibt (Block-Löschen ist separat).
    expect(document.querySelector("strong")).toBeNull();
    expect(document.querySelector("p")).not.toBeNull();
  });

  test("whitespace-only text ('   ') zählt als leer → Hülle ebenfalls entfernt", async () => {
    const DOC = "<!doctype html><html><body><p>A <strong>Wort</strong> B</p></body></html>";
    const idx = await idxOf(DOC, "Wort");
    const { html: out } = apply.applyEdits(DOC, [{ idx, text: "   " }]);
    expect(parseHTML(out).document.querySelector("strong")).toBeNull();
  });

  test("Gegenprobe: nicht-leerer text → nur nodeValue gesetzt, KEINE Hülle entfernt", async () => {
    const DOC = "<!doctype html><html><body><p>A <strong>Wort</strong> B</p></body></html>";
    const idx = await idxOf(DOC, "Wort");
    const { html: out } = apply.applyEdits(DOC, [{ idx, text: "Neu" }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).not.toBeNull(); // Hülle bleibt
    expect(document.querySelector("strong")!.textContent).toBe("Neu");
    expect(document.querySelector("p")!.textContent).toBe("A Neu B");
  });

  test("nur die leere Hülle des Ziel-Laufs wird entfernt, andere Hüllen bleiben", async () => {
    const DOC =
      "<!doctype html><html><body><p><strong>Eins</strong> <strong>Zwei</strong></p></body></html>";
    const idx = await idxOf(DOC, "Eins");
    const { html: out } = apply.applyEdits(DOC, [{ idx, text: "" }]);
    const { document } = parseHTML(out);
    const strongs = [...document.querySelectorAll("strong")];
    expect(strongs.length).toBe(1); // nur "Zwei" bleibt
    expect(strongs[0]!.textContent).toBe("Zwei");
  });
});

// ===========================================================================
// host.ts — POST /edit/save mit Wort-Löschung
// ===========================================================================
describe("host.ts — /edit/save {idx,text:''} entfernt leere Hülle (v5)", () => {
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
    const repoRoot = makeTmpDir("regoro-v5-");
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

  test("fettes Wort über /edit/save geleert → Datei ohne <strong>/Wort, 200, Commit, Geschwister intakt", async () => {
    const cookie = authCookie();
    const pagePath = "site/index.html";
    const filePath = join(ctx.repoRoot, pagePath);

    // 1. Ein Wort in einem Lauf fett machen (Range-Op) + speichern.
    const original = readFileSync(filePath, "utf8");
    const nodes0 = contract.enumerateEditableTextNodes(parseHTML(original).document);
    const idxLong = nodes0.findIndex((n) => (n.textContent ?? "").trim().length >= 6);
    const runText = (nodes0[idxLong]!.textContent ?? "");

    const r1 = await save(pagePath, apply.fileSha256(original), [
      { idx: idxLong, start: 0, end: 4, bold: true },
    ]);
    expect(r1.status).toBe(200);
    const mid = readFileSync(filePath, "utf8");
    expect(mid).toContain("<strong>");
    const versionsAfterBold = git.listVersions(ctx.repoRoot, pagePath).length;

    // 2. Das jetzt-fette Fragment-Wort leeren. Sein idx im neuen Dokument finden.
    const fragText = runText.slice(0, 4);
    const midNodes = contract.enumerateEditableTextNodes(parseHTML(mid).document);
    const idxFrag = midNodes.findIndex((n) => (n.textContent ?? "") === fragText);
    expect(idxFrag).toBeGreaterThanOrEqual(0);

    const r2 = await save(pagePath, apply.fileSha256(mid), [{ idx: idxFrag, text: "" }]);
    expect(r2.status).toBe(200);
    const after = readFileSync(filePath, "utf8");

    // Die fette Hülle um das geleerte Fragment ist VOLLSTÄNDIG weg — nicht nur
    // der Text geleert. Vergleich der <strong>-Zahl (mid hatte +1 durch den Bold-
    // Save) und Garantie, dass KEIN leeres <strong></strong> zurückbleibt.
    const strongCountMid = parseHTML(mid).document.querySelectorAll("strong").length;
    const strongsAfter = [...parseHTML(after).document.querySelectorAll("strong")];
    expect(strongsAfter.length).toBe(strongCountMid - 1); // genau die eine Hülle entfernt
    expect(strongsAfter.some((s) => (s.textContent ?? "").trim() === "")).toBe(false); // kein leeres <strong>
    expect(after).not.toContain("<strong></strong>");
    // Commit ist gewachsen (gegenüber dem Stand nach dem Fett-Save).
    expect(git.listVersions(ctx.repoRoot, pagePath).length).toBe(versionsAfterBold + 1);
    // Header-Pflicht.
    expect((r2.headers.get("x-robots-tag") ?? "").toLowerCase()).toContain("noindex");
    expect((r2.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");
  });
});

// ===========================================================================
// v5 Validation: Hüllen-Aufräum-Lücken (alle gegen die Implementierung GRÜN)
// ===========================================================================
describe("apply.ts — v5 Hüllen-Aufräum-Kanten", () => {
  let apply: typeof import("./apply.ts");
  beforeAll(async () => {
    apply = await import("./apply.ts");
  });

  test("Hülle mit nicht-leerem Geschwister-KIND bleibt erhalten (nur Ziel-Text weg)", async () => {
    // <strong>Wort <em>bleibt</em></strong> — "Wort " leeren. <strong> behält
    // das nicht-leere <em> → darf NICHT entfernt werden.
    const DOC = "<!doctype html><html><body><p><strong>Wort <em>bleibt</em></strong></p></body></html>";
    const idx = await idxOf(DOC, "Wort ");
    expect(idx).toBeGreaterThanOrEqual(0);

    const { html: out, applied } = apply.applyEdits(DOC, [{ idx, text: "" }]);
    expect(applied).toBeGreaterThanOrEqual(1);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).not.toBeNull(); // Hülle bleibt (hat <em>)
    expect(document.querySelector("em")).not.toBeNull();
    expect(document.querySelector("em")!.textContent).toBe("bleibt");
    expect(document.querySelector("p")!.textContent).toBe("bleibt");
  });

  test("mehrfach verschachtelte Hüllen + Geschwister-Inhalt: alle Ziel-Hüllen weg, Geschwister intakt", async () => {
    const DOC = "<!doctype html><html><body><p>A <strong><em><u>X</u></em></strong> B</p></body></html>";
    const idx = await idxOf(DOC, "X");
    const { html: out } = apply.applyEdits(DOC, [{ idx, text: "" }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).toBeNull();
    expect(document.querySelector("em")).toBeNull();
    expect(document.querySelector("u")).toBeNull();
    expect(document.querySelector("p")!.textContent).toBe("A  B"); // Geschwister intakt
  });

  test("whitespace-only text leert ebenfalls + räumt mehrfach-Hülle auf", async () => {
    const DOC = "<!doctype html><html><body><p>A <strong><em>X</em></strong> B</p></body></html>";
    const idx = await idxOf(DOC, "X");
    const { html: out } = apply.applyEdits(DOC, [{ idx, text: "  \t " }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).toBeNull();
    expect(document.querySelector("em")).toBeNull();
    expect(document.querySelector("p")).not.toBeNull(); // Block bleibt immer
  });

  test("Block bleibt selbst wenn der geleerte Lauf der einzige Inhalt verschachtelter Hüllen war", async () => {
    const DOC = "<!doctype html><html><body><p><strong><u>Nur</u></strong></p></body></html>";
    const idx = await idxOf(DOC, "Nur");
    const { html: out } = apply.applyEdits(DOC, [{ idx, text: "" }]);
    const { document } = parseHTML(out);
    expect(document.querySelector("strong")).toBeNull();
    expect(document.querySelector("u")).toBeNull();
    expect(document.querySelector("p")).not.toBeNull(); // p NIE entfernt
  });
});
