/**
 * `entwurf.ts` — ab der Initialisierung gehört die Website dem Entwurfs-Repo.
 *
 * Contract C4. Die Historie zieht aus dem Site-Ordner nach
 * `<siteDir>/.regoro/entwurf/`; der Site-Ordner wird ein reiner Abzug. Zwei
 * Eigenschaften trägt diese Datei:
 *
 *   1. Der Entwurf liegt **hinter dem Punkt-Riegel** (Invariante 3). Er enthält
 *      jeden Zwischenstand des Kunden, oft Wochen vor der Veröffentlichung —
 *      ausgeliefert würde er zur Vorabveröffentlichung, die niemand bestellt hat.
 *      Deshalb steht hier nicht nur „der Pfad enthält .regoro", sondern ein
 *      echter Server, der die vorhandene Datei mit 404 beantwortet.
 *   2. `pruefeAltRepo` erkennt die Lage, in der **niemand** schreiben darf:
 *      ein altes `<siteDir>/.git` ohne Entwurfs-Repo. Der Editor schaltet dann
 *      fail-closed ab, statt danebenzuschreiben (C4).
 *
 * PHASE 1: `entwurf.ts` gibt es noch nicht. Der Import steht deshalb in einem
 * Helfer und wird pro Test ausgeführt — so scheitert jeder Test einzeln und
 * sichtbar, statt dass die ganze Datei beim Laden wegbricht.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_DIR_NAME, createAuthFile } from "./auth.ts";
import { countCommits, git } from "./git.ts";
import { startServer } from "./server.ts";
import { attrappenVersand } from "./versand.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");
const NUMMER = "+4915120464812";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Eine Website wie nach dem Deploy: Inhalte plus `.regoro/auth.json`. */
async function macheSite(): Promise<string> {
  const siteDir = tmp("regoro-entwurf-site-");
  cpSync(REAL_SITE, siteDir, { recursive: true });
  await createAuthFile(siteDir, [NUMMER]);
  return siteDir;
}

/** Alle Dateien unter `wurzel`, relativ und mit „/" — Punkt-Segmente MITGEZÄHLT. */
function alleDateien(wurzel: string, rel = ""): string[] {
  const hier = rel === "" ? wurzel : join(wurzel, rel);
  const raus: string[] = [];
  for (const e of readdirSync(hier, { withFileTypes: true })) {
    const kind = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) raus.push(...alleDateien(wurzel, kind));
    else raus.push(kind);
  }
  return raus.sort();
}

type EntwurfApi = {
  entwurfPfad(siteDir: string): string;
  entwurfVorhanden(siteDir: string): boolean;
  stelleEntwurfBereit(siteDir: string): void;
  pruefeAltRepo(siteDir: string): boolean;
  istNichtMigriert(siteDir: string): boolean;
};

/**
 * Der Zugang zum noch nicht gebauten Modul.
 *
 * Bewusst dynamisch: Ein statischer Import scheiterte beim LADEN der Datei, und
 * dann sagt kein einzelner Fehlschlag mehr, welche Zusicherung fehlt. So steht
 * in jedem roten Test „Cannot find module ./entwurf.ts" an genau der Zeile, die
 * die Zusicherung beschreibt.
 */
async function entwurf(): Promise<EntwurfApi> {
  return (await import("./entwurf.ts")) as unknown as EntwurfApi;
}

// ===========================================================================
// Wo der Entwurf liegt
// ===========================================================================
describe("entwurfPfad", () => {
  test("zeigt nach <siteDir>/.regoro/entwurf", async () => {
    const { entwurfPfad } = await entwurf();
    const siteDir = await macheSite();
    expect(entwurfPfad(siteDir)).toBe(join(siteDir, AUTH_DIR_NAME, "entwurf"));
  });

  test("liegt hinter einem Punkt-Segment — der Riegel aus Invariante 3 greift dort", async () => {
    const { entwurfPfad } = await entwurf();
    const siteDir = await macheSite();
    // Nicht Kosmetik: Ohne führenden Punkt läge der Entwurf im öffentlichen
    // Auslieferungsraum, und `hasDotSegment` in host.ts sähe nichts.
    const relativ = entwurfPfad(siteDir).slice(siteDir.length + 1);
    expect(relativ.split("/").some((s) => s.startsWith("."))).toBe(true);
  });

  test("hängt nur vom Site-Ordner ab, nicht vom Arbeitsverzeichnis", async () => {
    const { entwurfPfad } = await entwurf();
    const a = await macheSite();
    const b = await macheSite();
    expect(entwurfPfad(a)).not.toBe(entwurfPfad(b));
    expect(entwurfPfad(a)).toBe(entwurfPfad(a));
  });
});

// ===========================================================================
// stelleEntwurfBereit
// ===========================================================================
describe("stelleEntwurfBereit", () => {
  test("legt ein echtes Repo mit Baseline-Commit an", async () => {
    const { entwurfPfad, entwurfVorhanden, stelleEntwurfBereit } = await entwurf();
    const siteDir = await macheSite();

    expect(entwurfVorhanden(siteDir)).toBe(false);
    stelleEntwurfBereit(siteDir);
    expect(entwurfVorhanden(siteDir)).toBe(true);

    // Das echte Werkzeug fragen, nicht die Zeichenkette vergleichen.
    const entwurfDir = entwurfPfad(siteDir);
    expect(existsSync(join(entwurfDir, ".git"))).toBe(true);
    expect(countCommits(entwurfDir)).toBeGreaterThanOrEqual(1);
    expect(git(entwurfDir, "status", "--porcelain").trim()).toBe("");
  });

  test("der Arbeitsbaum ist die ganze Website, nicht nur eine Seite", async () => {
    const { entwurfPfad, stelleEntwurfBereit } = await entwurf();
    const siteDir = await macheSite();
    stelleEntwurfBereit(siteDir);
    const entwurfDir = entwurfPfad(siteDir);

    // Was der Kunde ausgeliefert bekommt, muss auch im Entwurf stehen — sonst
    // löschte das erste Veröffentlichen die Hälfte der Website (C5 löscht, was
    // im Entwurf fehlt).
    for (const rel of alleDateien(siteDir).filter((p) => !p.split("/").some((s) => s.startsWith(".")))) {
      expect(`${rel}: ${existsSync(join(entwurfDir, rel))}`).toBe(`${rel}: true`);
      expect(readFileSync(join(entwurfDir, rel))).toEqual(readFileSync(join(siteDir, rel)));
    }
  });

  test("kein Punkt-Segment des Kunden wandert mit — das Geheimnis bleibt draußen", async () => {
    const { entwurfPfad, stelleEntwurfBereit } = await entwurf();
    const siteDir = await macheSite();
    mkdirSync(join(siteDir, "assets", ".versteckt"), { recursive: true });
    writeFileSync(join(siteDir, "assets", ".versteckt", "notiz.txt"), "intern");
    const secret = JSON.parse(readFileSync(join(siteDir, AUTH_DIR_NAME, "auth.json"), "utf8")).secret as string;
    expect(secret).toHaveLength(64); // Voraussetzung: es gibt überhaupt eines

    stelleEntwurfBereit(siteDir);
    const entwurfDir = entwurfPfad(siteDir);

    // Nur `.git` des Entwurfs selbst darf ein Punkt-Segment sein. Alles andere
    // wäre ein kopiertes `.regoro` — und damit das Sitzungsgeheimnis in einem
    // Repo, das der Kunde über die Versionsliste einsehen kann.
    const punktSegmente = alleDateien(entwurfDir)
      .filter((p) => p.split("/").some((s) => s.startsWith(".")))
      .filter((p) => !p.startsWith(".git/") && p !== ".git");
    expect(punktSegmente).toEqual([]);

    for (const rel of alleDateien(entwurfDir)) {
      expect(`${rel} enthält Secret: ${readFileSync(join(entwurfDir, rel)).includes(secret)}`).toBe(
        `${rel} enthält Secret: false`,
      );
    }
  });

  test("idempotent: der zweite Aufruf ändert nichts", async () => {
    const { entwurfPfad, stelleEntwurfBereit } = await entwurf();
    const siteDir = await macheSite();

    stelleEntwurfBereit(siteDir);
    const entwurfDir = entwurfPfad(siteDir);
    const kopfVorher = git(entwurfDir, "rev-parse", "HEAD").trim();
    const anzahlVorher = countCommits(entwurfDir);

    expect(() => stelleEntwurfBereit(siteDir)).not.toThrow();

    expect(git(entwurfDir, "rev-parse", "HEAD").trim()).toBe(kopfVorher);
    expect(countCommits(entwurfDir)).toBe(anzahlVorher);
  });

  test("Gegenprobe: ein echter Commit VERSCHIEBT den Kopf — der Test oben kann anschlagen", async () => {
    // Ohne diese Zeile misst „HEAD unverändert" nur, dass in diesem Repo
    // überhaupt nie etwas committet wird. Dieselbe Klasse Fehler wie die vier
    // dauerhaft übersprungenen Binary-Tests: grün, aber ohne Gegenstand.
    const { entwurfPfad, stelleEntwurfBereit } = await entwurf();
    const siteDir = await macheSite();
    stelleEntwurfBereit(siteDir);
    const entwurfDir = entwurfPfad(siteDir);
    const kopfVorher = git(entwurfDir, "rev-parse", "HEAD").trim();

    writeFileSync(join(entwurfDir, "index.html"), "<html><body><p>geändert</p></body></html>");
    git(entwurfDir, "add", "-A");
    git(entwurfDir, "commit", "-m", "Probe");

    expect(git(entwurfDir, "rev-parse", "HEAD").trim()).not.toBe(kopfVorher);
  });

  test("ein zweiter Aufruf wirft die Arbeit des Kunden nicht weg", async () => {
    // Idempotenz heißt „ändert nichts", nicht „setzt zurück". Ein
    // `stelleEntwurfBereit`, das den Entwurf neu aus dem Site-Ordner befüllt,
    // löschte beim nächsten Serverstart jede ungespeicherte Woche.
    const { entwurfPfad, stelleEntwurfBereit } = await entwurf();
    const siteDir = await macheSite();
    stelleEntwurfBereit(siteDir);
    const entwurfDir = entwurfPfad(siteDir);

    writeFileSync(join(entwurfDir, "index.html"), "<html><body><p>ARBEIT-DES-KUNDEN</p></body></html>");
    git(entwurfDir, "add", "-A");
    git(entwurfDir, "commit", "-m", "Kundenänderung");

    stelleEntwurfBereit(siteDir);

    expect(readFileSync(join(entwurfDir, "index.html"), "utf8")).toContain("ARBEIT-DES-KUNDEN");
  });
});

// ===========================================================================
// pruefeAltRepo — die Lage, in der niemand schreiben darf
// ===========================================================================
describe("pruefeAltRepo", () => {
  test("findet ein altes Repo im Site-Ordner", async () => {
    const { pruefeAltRepo } = await entwurf();
    const siteDir = await macheSite();
    expect(pruefeAltRepo(siteDir)).toBe(false); // Gegenprobe: vorher nichts da

    git(siteDir, "init");
    expect(pruefeAltRepo(siteDir)).toBe(true);
  });

  test("das ENTWURFS-Repo zählt nicht als altes Repo", async () => {
    // Es liegt unter `.regoro/entwurf/.git`, nicht unter `<siteDir>/.git`. Wer
    // hier nur „irgendwo ein .git" prüfte, schaltete den Editor genau dann ab,
    // wenn er frisch eingerichtet ist.
    const { pruefeAltRepo, stelleEntwurfBereit } = await entwurf();
    const siteDir = await macheSite();
    stelleEntwurfBereit(siteDir);
    expect(pruefeAltRepo(siteDir)).toBe(false);
  });

  test("die fail-closed-Lage ist eindeutig erkennbar: altes Repo, kein Entwurf", async () => {
    const { entwurfVorhanden, pruefeAltRepo } = await entwurf();
    const siteDir = await macheSite();
    git(siteDir, "init");
    git(siteDir, "add", "-A");
    git(siteDir, "commit", "-m", "Baseline");

    // Genau diese Kombination heißt „nicht danebenschreiben, sondern abschalten".
    expect(pruefeAltRepo(siteDir)).toBe(true);
    expect(entwurfVorhanden(siteDir)).toBe(false);
  });
});

// ===========================================================================
// istNichtMigriert — die Frage, auf die der Editor abschaltet
// ===========================================================================
describe("istNichtMigriert", () => {
  /**
   * Contract C4: Abgeschaltet wird auf `istNichtMigriert()`, NICHT auf
   * `pruefeAltRepo()`. Der Unterschied ist der ganze Punkt — `pruefeAltRepo`
   * allein wäre auch bei einer kerngesunden Site wahr, sobald jemand dort ein
   * `git init` gemacht hat, und schaltete einen funktionierenden Editor ab.
   *
   * Deshalb stehen hier alle VIER Kombinationen. Drei davon müssen `false`
   * ergeben; ein Test, der nur die eine `true`-Lage prüft, könnte eine
   * Implementierung nicht von `pruefeAltRepo` unterscheiden.
   */
  test("altes Repo UND kein Entwurf → true", async () => {
    const { istNichtMigriert } = await entwurf();
    const siteDir = await macheSite();
    git(siteDir, "init");
    expect(istNichtMigriert(siteDir)).toBe(true);
  });

  test("altes Repo UND Entwurf vorhanden → false", async () => {
    // Die Lage, die `pruefeAltRepo` allein falsch beurteilen würde.
    const { istNichtMigriert, pruefeAltRepo } = await entwurf();
    const { stelleEntwurfBereit } = await entwurf();
    const siteDir = await macheSite();
    git(siteDir, "init");
    stelleEntwurfBereit(siteDir);

    expect(pruefeAltRepo(siteDir)).toBe(true); // Messapparat: das Alt-Repo ist wirklich da
    expect(istNichtMigriert(siteDir)).toBe(false);
  });

  test("kein altes Repo, Entwurf vorhanden → false (der Normalfall)", async () => {
    const { istNichtMigriert, stelleEntwurfBereit } = await entwurf();
    const siteDir = await macheSite();
    stelleEntwurfBereit(siteDir);
    expect(istNichtMigriert(siteDir)).toBe(false);
  });

  test("weder noch → false: eine uneingerichtete Site ist nicht kaputt", async () => {
    // Direkt nach dem Deploy, vor `regoro init`. Der Editor ist dort aus, weil
    // es keine Auth-Datei und keine Seitenliste gibt — nicht, weil etwas
    // verdächtig wäre. Ein `true` hier hieße, jede frische Site als Notfall zu
    // behandeln.
    const { istNichtMigriert } = await entwurf();
    const siteDir = await macheSite();
    expect(istNichtMigriert(siteDir)).toBe(false);
  });
});

// ===========================================================================
// Der Entwurf wird nie ausgeliefert
// ===========================================================================
describe("das Entwurfs-Repo verlässt den Server nicht", () => {
  test("die Datei liegt auf Platte — HTTP gibt trotzdem 404", async () => {
    const { entwurfPfad, stelleEntwurfBereit } = await entwurf();
    const siteDir = await macheSite();
    stelleEntwurfBereit(siteDir);
    const entwurfDir = entwurfPfad(siteDir);

    // Ein Marker, den es nur im Entwurf gibt: Käme er je über HTTP zurück,
    // wäre die Vorabveröffentlichung bewiesen und nicht nur vermutet.
    const MARKER = "NUR-IM-ENTWURF-4711";
    writeFileSync(join(entwurfDir, "index.html"), `<html><body><p>${MARKER}</p></body></html>`);
    expect(existsSync(join(entwurfDir, "index.html"))).toBe(true);

    const { port } = startServer({ siteDir, port: 0, versand: attrappenVersand() });
    const base = `http://127.0.0.1:${port}`;

    // MESSAPPARAT ZUERST: Liefert dieser Server überhaupt etwas aus? Ohne diese
    // Zeile wäre der ganze Block auch dann grün, wenn er auf jede Anfrage 404
    // gäbe — und bewiese nichts über den Punkt-Riegel.
    const oeffentlich = await fetch(`${base}/`);
    expect(oeffentlich.status).toBe(200);
    expect(await oeffentlich.text()).not.toContain(MARKER);

    for (const pfad of [
      "/.regoro/entwurf/index.html",
      "/.regoro/entwurf/.git/config",
      "/.regoro/entwurf/.git/HEAD",
      "/.regoro/auth.json",
      "/%2eregoro/entwurf/index.html",
    ]) {
      const r = await fetch(base + pfad);
      expect(`${pfad} → ${r.status}`).toBe(`${pfad} → 404`);
      expect(await r.text()).not.toContain(MARKER);
    }
  }, 20_000);
});
