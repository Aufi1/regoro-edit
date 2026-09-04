/**
 * Host-Auflösung für den Sammelbetrieb (ein Prozess, viele Websites).
 *
 * Zwei Stufen, beide fail-closed:
 *   normalizeHost — reine Textnormalisierung des Host-Headers (Nutzereingabe!),
 *   resolveSite   — Nachschlagen im Sammelverzeichnis; nur ein DIREKTES Kind zählt.
 *
 * Der Host-Header wird zum Pfadsegment. Deshalb ist die Normalisierung zugleich
 * der Traversal-Schutz und wird hier als Tabelle festgenagelt.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, cpSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeHost, resolveSite, buildCtx, listSites } from "./sites.ts";
import { createAuthFile, AUTH_DIR_NAME } from "./auth.ts";
import { entwurfPfad, stelleEntwurfBereit } from "./entwurf.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

describe("normalizeHost", () => {
  const toKundeDe = [
    "kunde.de",
    "KUNDE.DE",
    "kunde.de:8788",
    "kunde.de.",
    "www.kunde.de",
    "WWW.Kunde.DE:443",
    "www.KUNDE.de.",
  ];
  for (const raw of toKundeDe) {
    test(`"${raw}" → kunde.de`, () => {
      expect(normalizeHost(raw)).toBe("kunde.de");
    });
  }

  const toNull: Array<[string, string | null]> = [
    ["leer", ""],
    ["fehlend (null)", null],
    ["nur Punkte", ".."],
    ["Traversal", "../etc"],
    ["Traversal mit Slash", "kunde.de/../andere.de"],
    ["Doppelpunkt im Namen", "kunde..de"],
    ["führender Punkt", ".kunde.de"],
    ["abschließender Bindestrich", "kunde.de-"],
    ["führender Bindestrich", "-kunde.de"],
    ["Leerzeichen innen", "kunde de"],
    ["Leerzeichen hinten", "kunde.de "],
    ["Label mit führendem Bindestrich", "a.-b.de"],
    ["IPv6-Literal", "[::1]"],
    ["IPv6 ohne Klammern", "::1"],
    ["nicht-numerischer Port", "kunde.de:abc"],
    ["Null-Byte", "kunde.de\0"],
    ["Unterstrich", "kunde_de.de"],
    ["Backslash", "kunde.de\\..\\andere"],
    ["Überlänge", `${"a".repeat(300)}.de`],
    // Bun fasst zwei Host-Header zu "a, b" zusammen, statt die Anfrage
    // abzulehnen. Ein Normalisierer, der hier den ERSTEN Wert nähme, wäre eine
    // Request-Smuggling-Lücke: der Proxy routete nach dem einen Wert, wir nach
    // dem anderen. Fail-closed ist die einzige richtige Antwort.
    ["zwei Host-Header (Bun fügt sie zusammen)", "kunde-a.test, kunde-b.test"],
  ];
  for (const [name, raw] of toNull) {
    test(`${name} → null`, () => {
      expect(normalizeHost(raw)).toBe(null);
    });
  }

  // localhost und IP-Adressen sind für die Entwicklung nötig und in Produktion
  // nie ein echter Ordnername. Sie passieren deshalb die NORMALISIERUNG; ob sie
  // treffen, entscheidet allein die Auflösung (Ordner da oder nicht).
  // Der Wurzelpunkt fällt VOR dem www.-Präfix weg (Reihenfolge wie im Plan).
  // "www." ist danach der einlabelige Name "www" — ungewöhnlich, aber gültig;
  // er trifft nur, wenn es einen so benannten Ordner wirklich gibt.
  test('"www." bleibt der Name "www"', () => {
    expect(normalizeHost("www.")).toBe("www");
  });

  test("localhost und IPv4 passieren die Normalisierung", () => {
    expect(normalizeHost("localhost")).toBe("localhost");
    expect(normalizeHost("localhost:8788")).toBe("localhost");
    expect(normalizeHost("127.0.0.1")).toBe("127.0.0.1");
  });

  test("253 Zeichen sind erlaubt, 254 nicht", () => {
    const label = "abcdefghij"; // 10
    const ok = Array(24).fill(label).join(".").slice(0, 253).replace(/[.-]$/, "a");
    expect(ok.length).toBe(253);
    expect(normalizeHost(ok)).toBe(ok);
    expect(normalizeHost(`a${ok}`)).toBe(null);
  });
});

describe("resolveSite", () => {
  function fixture() {
    const root = makeRoot("regoro-sites-");
    mkdirSync(join(root, "kunde-a.test"));
    mkdirSync(join(root, "kunde-b.test"));
    writeFileSync(join(root, "datei.test"), "kein Verzeichnis");
    // Symlink nach außen: legitim (Betreiber mounten Sites), aber der
    // zurückgegebene Pfad muss der AUFGELÖSTE sein.
    const extern = makeRoot("regoro-extern-");
    symlinkSync(extern, join(root, "verlinkt.test"));
    return { root, extern };
  }

  test("bekannter Host → Ordner", () => {
    const { root } = fixture();
    expect(resolveSite(root, "kunde-a.test")?.siteDir).toBe(join(root, "kunde-a.test"));
    expect(resolveSite(root, "kunde-b.test")?.siteDir).toBe(join(root, "kunde-b.test"));
  });

  test("Normalisierung greift auch hier (Port, Großschreibung, www.)", () => {
    const { root } = fixture();
    expect(resolveSite(root, "KUNDE-A.test:8788")?.siteDir).toBe(join(root, "kunde-a.test"));
    expect(resolveSite(root, "www.kunde-a.test")?.host).toBe("kunde-a.test");
  });

  test("unbekannter Host → null", () => {
    const { root } = fixture();
    expect(resolveSite(root, "gibt-es-nicht.test")).toBe(null);
  });

  test("fehlender Host → null", () => {
    const { root } = fixture();
    expect(resolveSite(root, null)).toBe(null);
    expect(resolveSite(root, "")).toBe(null);
  });

  test("Traversal → null, auch wenn das Ziel existiert", () => {
    const { root } = fixture();
    expect(resolveSite(root, "..")).toBe(null);
    expect(resolveSite(root, "../" + "kunde-a.test")).toBe(null);
    expect(resolveSite(root, "kunde-a.test/../kunde-b.test")).toBe(null);
  });

  test("Datei statt Verzeichnis → null", () => {
    const { root } = fixture();
    expect(resolveSite(root, "datei.test")).toBe(null);
  });

  test("Symlink nach außen: erlaubt, aber auf den realen Pfad aufgelöst", () => {
    const { root, extern } = fixture();
    const site = resolveSite(root, "verlinkt.test");
    expect(site).not.toBe(null);
    expect(site!.siteDir).toBe(extern);
    expect(site!.host).toBe("verlinkt.test");
  });

  test("nicht existierendes Sammelverzeichnis → null statt Absturz", () => {
    expect(resolveSite("/gibt/es/nicht", "kunde-a.test")).toBe(null);
  });

  test("localhost trifft nur, wenn es den Ordner wirklich gibt", () => {
    const { root } = fixture();
    expect(resolveSite(root, "localhost")).toBe(null);
    mkdirSync(join(root, "localhost"));
    expect(resolveSite(root, "localhost:8788")?.siteDir).toBe(join(root, "localhost"));
  });
});

describe("buildCtx", () => {
  async function siteFixture(withAuth: boolean) {
    const root = makeRoot("regoro-ctx-");
    const siteDir = join(root, "kunde-a.test");
    cpSync(REAL_SITE, siteDir, { recursive: true });
    // Seit C1 liest die Editor-Sicht aus dem Entwurfs-Repo. Ohne dieses fiele
    // `pageWhitelist` auf den Vorgabewert ["index.html"] zurück, und die Tests
    // unten prüften einen Zustand, den es im Betrieb nicht gibt.
    stelleEntwurfBereit(siteDir);
    if (withAuth) await createAuthFile(siteDir, ["+4915120464812"]);
    return { root, siteDir };
  }

  test("repoRoot === entwurfDir und sitePrefix === '' (Versionen im Entwurfs-Repo)", async () => {
    /**
     * GEÄNDERT MIT „Eine Bearbeitung, zwei Modi" (C1). Vorher war
     * `repoRoot === siteDir`: der Editor schrieb und committete direkt in die
     * ausgelieferte Website. Jetzt liegt die Historie im Entwurfs-Repo, und der
     * Site-Ordner ist ein reiner Abzug davon (Plan, „Wo die Historie liegt").
     *
     * Die erste Zusicherung ist die Beziehung, nicht der Pfad: Wer `repoRoot`
     * irgendwohin sonst zeigen lässt, committet an einem Ort, den
     * `veroeffentliche` nie ausrollt — der Kunde speicherte ins Leere.
     */
    const { root, siteDir } = await siteFixture(false);
    const ctx = buildCtx(resolveSite(root, "kunde-a.test")!);
    expect(ctx.siteDir).toBe(siteDir);
    expect(ctx.repoRoot).toBe(ctx.entwurfDir);
    expect(ctx.sitePrefix).toBe("");
    // Und der Ort selbst, aus der Tabelle der Contracts: haltbar wie die
    // Website (unter `<siteDir>/.regoro/`), nicht unter `runtimeWurzel()`.
    expect(ctx.entwurfDir).toBe(join(siteDir, AUTH_DIR_NAME, "entwurf"));
    expect(ctx.schwebendDir).toBe(join(siteDir, AUTH_DIR_NAME, "schwebend"));
  });

  test("im Sammelbetrieb ist `basis` leer und `staging` falsch", () => {
    /**
     * Die Fahne hängt am PROZESS (Plan, „Zwei Betriebsformen"). Der
     * hostbasierte Ctx ist der Produktions-Ctx — er darf `staging` nie von
     * selbst auf `true` bringen, sonst stünde eine echte Kundenwebsite ohne
     * Anmeldung offen. Und ein leeres `basis` ist die Bedingung dafür, dass
     * alle erzeugten URLs bleiben, wie sie sind.
     */
    const root = makeRoot("regoro-basis-");
    mkdirSync(join(root, "kunde-a.test"));
    const ctx = buildCtx(resolveSite(root, "kunde-a.test")!);
    expect(ctx.basis).toBe("");
    expect(ctx.staging).toBe(false);
  });

  test("pageWhitelist kommt aus dem Ordner", async () => {
    const { root } = await siteFixture(false);
    const ctx = buildCtx(resolveSite(root, "kunde-a.test")!);
    expect(ctx.pageWhitelist).toContain("index.html");
    expect(ctx.pageWhitelist).toContain("impressum.html");
  });

  test("auth ist null ohne Auth-Datei und gesetzt mit", async () => {
    const ohne = await siteFixture(false);
    expect(buildCtx(resolveSite(ohne.root, "kunde-a.test")!).auth).toBe(null);
    const mit = await siteFixture(true);
    expect(buildCtx(resolveSite(mit.root, "kunde-a.test")!).auth).not.toBe(null);
  });

  test("pageWhitelist wird erst beim Zugriff gelesen (kein readdir pro Asset)", async () => {
    const { root, siteDir } = await siteFixture(false);
    const ctx = buildCtx(resolveSite(root, "kunde-a.test")!);
    // Nach dem Bauen des Ctx angelegt — eine EAGER ermittelte Liste kennt sie
    // nicht. Angelegt wird im ENTWURF: dort entstehen neue Seiten (ein Lauf des
    // Agenten schreibt dorthin), der Site-Ordner bekommt sie erst beim
    // Veröffentlichen.
    writeFileSync(join(entwurfPfad(siteDir), "spaeter.html"), "<html><body><p>x</p></body></html>");
    expect(ctx.pageWhitelist).toContain("spaeter.html");
  });

  test("Ordner ohne Seiten stürzt nicht ab", () => {
    const root = makeRoot("regoro-leer-");
    mkdirSync(join(root, "kunde-a.test"));
    const ctx = buildCtx(resolveSite(root, "kunde-a.test")!);
    expect(Array.isArray(ctx.pageWhitelist)).toBe(true);
  });
});

describe("listSites", () => {
  test("nennt jeden Unterordner und markiert unerreichbare Namen", () => {
    const root = makeRoot("regoro-list-");
    mkdirSync(join(root, "kunde-b.test"));
    mkdirSync(join(root, "kunde-a.test"));
    // Nicht erreichbar: normalisiert sich auf einen ANDEREN Namen bzw. gar keinen.
    mkdirSync(join(root, "www.kunde-c.test"));
    mkdirSync(join(root, "Kunde-D.test"));
    mkdirSync(join(root, "backup_alt"));
    writeFileSync(join(root, "notiz.txt"), "keine Website");

    const sites = listSites(root);
    expect(sites.map((s) => s.name)).toEqual([
      "Kunde-D.test",
      "backup_alt",
      "kunde-a.test",
      "kunde-b.test",
      "www.kunde-c.test",
    ]);
    const byName = Object.fromEntries(sites.map((s) => [s.name, s.host]));
    expect(byName["kunde-a.test"]).toBe("kunde-a.test");
    expect(byName["kunde-b.test"]).toBe("kunde-b.test");
    // Ein Ordner ist nur unter seinem EIGENEN Namen erreichbar: "www.kunde-c.test"
    // normalisiert sich auf "kunde-c.test", "Kunde-D.test" auf Kleinschreibung.
    expect(byName["www.kunde-c.test"]).toBe(null);
    expect(byName["Kunde-D.test"]).toBe(null);
    expect(byName["backup_alt"]).toBe(null);
  });

  test("leeres oder fehlendes Sammelverzeichnis → leere Liste", () => {
    expect(listSites(makeRoot("regoro-leer-list-"))).toEqual([]);
    expect(listSites("/gibt/es/nicht")).toEqual([]);
  });
});
