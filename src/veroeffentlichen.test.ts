/**
 * `veroeffentlichen.ts` — der Site-Ordner ist ein Abzug des Entwurfs.
 *
 * Contract C5. Veröffentlichen heißt: den Entwurfsbaum in den Site-Ordner
 * spiegeln — schreiben, was sich unterscheidet, löschen, was im Entwurf nicht
 * mehr steht — und die Prüfsummen des geschriebenen Standes festhalten.
 *
 * Die Prüfsummen sind eine **Notbremse, kein Sicherheitsnetz** (Plan, „Wer
 * schreiben darf"): Weicht eine Datei im Site-Ordner vom zuletzt
 * veröffentlichten Stand ab, hat jemand die Eigentums-Regel verletzt. Dann wird
 * gefragt, nicht überschrieben.
 *
 * ZWEI RICHTUNGEN, IMMER BEIDE. Ein Test, der nur „bei Fremdänderung bricht es
 * ab" prüft, ist auch dann grün, wenn die Funktion grundsätzlich abbricht — und
 * eine Veröffentlichung, die nie stattfindet, ist kein sicherer Zustand,
 * sondern ein kaputter. Deshalb steht neben jedem Abbruch der Durchlauf.
 *
 * PHASE 1: `veroeffentlichen.ts` gibt es noch nicht; der Import steht in einem
 * Helfer, damit jeder Test einzeln rot wird statt die ganze Datei.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_DIR_NAME, createAuthFile } from "./auth.ts";

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

function sha256(pfad: string): string {
  return createHash("sha256").update(readFileSync(pfad)).digest("hex");
}

/** Alle Dateien unter `wurzel`, relativ mit „/" — Punkt-Segmente MITGEZÄHLT. */
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

type Abgleich = { geschrieben: string[]; geloescht: string[]; fremd: string[] };
type VeroeffentlichenApi = {
  pruefeFremdaenderung(siteDir: string): string[];
  veroeffentliche(siteDir: string, entwurfDir: string): Abgleich;
  letzterVeroeffentlichterCommit(siteDir: string): string | null;
  unveroeffentlichteCommits(
    entwurfDir: string,
    seitCommit: string | null,
  ): { anzahl: number; seit: string | null };
};

async function api(): Promise<VeroeffentlichenApi> {
  return (await import("./veroeffentlichen.ts")) as unknown as VeroeffentlichenApi;
}

/**
 * Die Ausgangslage: eine ausgelieferte Website und ein Entwurfsbaum mit
 * demselben Inhalt.
 *
 * Der Entwurf wird hier von Hand gebaut und NICHT über `stelleEntwurfBereit`
 * (C4) — sonst hinge jeder Test dieser Datei an zwei ungebauten Modulen, und
 * ein Fehlschlag sagte nicht mehr, welches von beiden fehlt.
 */
async function lage(): Promise<{ siteDir: string; entwurfDir: string }> {
  const siteDir = tmp("regoro-veroeff-site-");
  cpSync(REAL_SITE, siteDir, { recursive: true });
  await createAuthFile(siteDir, [NUMMER]);
  const entwurfDir = tmp("regoro-veroeff-entwurf-");
  cpSync(REAL_SITE, entwurfDir, { recursive: true });
  return { siteDir, entwurfDir };
}

const pruefsummenDatei = (siteDir: string): string => join(siteDir, AUTH_DIR_NAME, "veroeffentlicht.json");

// ===========================================================================
// Schreiben
// ===========================================================================
describe("veroeffentliche — was auf die Website kommt", () => {
  test("eine geänderte Seite wird geschrieben und gemeldet", async () => {
    const { veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    writeFileSync(join(entwurfDir, "index.html"), "<html><body><p>NEUER-STAND</p></body></html>");
    const erg = veroeffentliche(siteDir, entwurfDir);

    expect(erg.geschrieben).toContain("index.html");
    expect(readFileSync(join(siteDir, "index.html"), "utf8")).toContain("NEUER-STAND");
    expect(readFileSync(join(siteDir, "index.html"))).toEqual(readFileSync(join(entwurfDir, "index.html")));
  });

  test("eine neue Seite im Unterordner kommt mit — Pfade relativ, mit Schrägstrich", async () => {
    const { veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    mkdirSync(join(entwurfDir, "assets"), { recursive: true });
    writeFileSync(join(entwurfDir, "assets", "neu.css"), "body{color:#111}");
    const erg = veroeffentliche(siteDir, entwurfDir);

    expect(erg.geschrieben).toContain("assets/neu.css");
    expect(readFileSync(join(siteDir, "assets", "neu.css"), "utf8")).toBe("body{color:#111}");
  });

  test("unveränderte Dateien stehen NICHT in `geschrieben`", async () => {
    // Sonst meldete jede Veröffentlichung die ganze Website als geändert, und
    // die Zahl im Bestätigungsdialog wäre wertlos.
    const { veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    writeFileSync(join(entwurfDir, "index.html"), "<html><body><p>NUR-DIESE</p></body></html>");
    const erg = veroeffentliche(siteDir, entwurfDir);

    expect(erg.geschrieben).toEqual(["index.html"]);
    expect(erg.geloescht).toEqual([]);
  });

  test("Binärdateien kommen byteidentisch an", async () => {
    const { veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
    mkdirSync(join(entwurfDir, "assets"), { recursive: true });
    writeFileSync(join(entwurfDir, "assets", "bild.png"), bytes);

    veroeffentliche(siteDir, entwurfDir);
    expect(readFileSync(join(siteDir, "assets", "bild.png"))).toEqual(bytes);
  });

  test("zweimal hintereinander: das zweite Mal gibt es nichts zu tun", async () => {
    // Die Zusicherung dahinter: Der geschriebene Stand landet wirklich in der
    // Prüfsummendatei. Täte er das nicht, sähe der zweite Lauf seine eigene
    // Arbeit als fremd an — die Notbremse ginge beim normalen Betrieb los.
    const { pruefeFremdaenderung, veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    writeFileSync(join(entwurfDir, "index.html"), "<html><body><p>EINMAL</p></body></html>");
    veroeffentliche(siteDir, entwurfDir);

    expect(pruefeFremdaenderung(siteDir)).toEqual([]);
    const zweiter = veroeffentliche(siteDir, entwurfDir);
    expect(zweiter.geschrieben).toEqual([]);
    expect(zweiter.geloescht).toEqual([]);
  });
});

// ===========================================================================
// Löschen
// ===========================================================================
describe("veroeffentliche — was von der Website verschwindet", () => {
  test("eine im Entwurf entfernte Seite wird auf der Website gelöscht", async () => {
    const { veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    // Erst veröffentlichen — damit die Datei überhaupt zum Bestand gehört.
    writeFileSync(join(entwurfDir, "zusatz.html"), "<html><body><p>Zusatz</p></body></html>");
    veroeffentliche(siteDir, entwurfDir);
    expect(existsSync(join(siteDir, "zusatz.html"))).toBe(true); // Messapparat

    rmSync(join(entwurfDir, "zusatz.html"));
    const erg = veroeffentliche(siteDir, entwurfDir);

    expect(erg.geloescht).toContain("zusatz.html");
    expect(existsSync(join(siteDir, "zusatz.html"))).toBe(false);
  });

  test("das Löschen greift auch im Unterordner", async () => {
    const { veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    mkdirSync(join(entwurfDir, "assets"), { recursive: true });
    writeFileSync(join(entwurfDir, "assets", "weg.css"), "p{}");
    veroeffentliche(siteDir, entwurfDir);
    expect(existsSync(join(siteDir, "assets", "weg.css"))).toBe(true);

    rmSync(join(entwurfDir, "assets", "weg.css"));
    const erg = veroeffentliche(siteDir, entwurfDir);

    expect(erg.geloescht).toContain("assets/weg.css");
    expect(existsSync(join(siteDir, "assets", "weg.css"))).toBe(false);
  });
});

// ===========================================================================
// Punkt-Segmente
// ===========================================================================
describe("Punkt-Segmente werden nie kopiert und nie gelöscht", () => {
  test(".regoro der Website bleibt unangetastet", async () => {
    const { veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    const authDatei = join(siteDir, AUTH_DIR_NAME, "auth.json");
    const vorher = readFileSync(authDatei);
    writeFileSync(join(entwurfDir, "index.html"), "<html><body><p>x</p></body></html>");

    veroeffentliche(siteDir, entwurfDir);

    expect(existsSync(authDatei)).toBe(true);
    expect(readFileSync(authDatei)).toEqual(vorher);
  });

  test("eine Punkt-Datei im Entwurf wird nicht ausgeliefert", async () => {
    const { veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    writeFileSync(join(entwurfDir, ".env"), "GEHEIM=1");
    mkdirSync(join(entwurfDir, "assets", ".versteckt"), { recursive: true });
    writeFileSync(join(entwurfDir, "assets", ".versteckt", "notiz.txt"), "intern");
    mkdirSync(join(entwurfDir, ".git"), { recursive: true });
    writeFileSync(join(entwurfDir, ".git", "config"), "[core]\n");

    const erg = veroeffentliche(siteDir, entwurfDir);

    expect(existsSync(join(siteDir, ".env"))).toBe(false);
    expect(existsSync(join(siteDir, "assets", ".versteckt"))).toBe(false);
    expect(existsSync(join(siteDir, ".git"))).toBe(false);
    expect(erg.geschrieben.filter((p) => p.split("/").some((s) => s.startsWith(".")))).toEqual([]);
  });

  test("eine Punkt-Datei der Website wird nicht gelöscht, obwohl sie im Entwurf fehlt", async () => {
    const { veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    writeFileSync(join(siteDir, ".htaccess"), "deny from all");
    veroeffentliche(siteDir, entwurfDir);

    expect(existsSync(join(siteDir, ".htaccess"))).toBe(true);
    expect(existsSync(join(siteDir, AUTH_DIR_NAME, "auth.json"))).toBe(true);
  });

  test("GEGENPROBE: im selben Vorgang wird sehr wohl gelöscht", async () => {
    /**
     * Der teuerste denkbare Fehler dieses Umbaus wäre eine erste
     * Veröffentlichung, die `.regoro/` abräumt: Auth-Secret, Entwurfs-Repo und
     * schwebende Änderung auf einmal, still, ohne Aufrufer, der es abfangen
     * kann.
     *
     * Nur zu zeigen, dass `.regoro/` überlebt, misst das NICHT — eine Funktion,
     * die grundsätzlich nichts löscht, bestünde diese Prüfung und wäre trotzdem
     * kaputt. Deshalb steht der Löschbeleg im selben Test: eine gewöhnliche
     * Datei verschwindet, während jedes Punkt-Segment daneben liegen bleibt.
     */
    const { veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    writeFileSync(join(entwurfDir, "preise.html"), "<html><body><p>Preise</p></body></html>");
    mkdirSync(join(entwurfDir, "assets"), { recursive: true });
    writeFileSync(join(entwurfDir, "assets", "stil.css"), "p{}");
    veroeffentliche(siteDir, entwurfDir);
    expect(existsSync(join(siteDir, "preise.html"))).toBe(true); // Messapparat

    // Ein weiteres Punkt-Segment daneben, das die Löschrunde überstehen muss.
    mkdirSync(join(siteDir, AUTH_DIR_NAME, "schwebend"), { recursive: true });
    writeFileSync(join(siteDir, AUTH_DIR_NAME, "schwebend", "index.html"), "<p>offen</p>");
    const authVorher = readFileSync(join(siteDir, AUTH_DIR_NAME, "auth.json"));

    rmSync(join(entwurfDir, "preise.html"));
    rmSync(join(entwurfDir, "assets", "stil.css"));
    const erg = veroeffentliche(siteDir, entwurfDir);

    // Es wird WIRKLICH gelöscht …
    expect(erg.geloescht).toEqual(["assets/stil.css", "preise.html"]);
    expect(existsSync(join(siteDir, "preise.html"))).toBe(false);
    expect(existsSync(join(siteDir, "assets", "stil.css"))).toBe(false);
    // … und trotzdem steht jedes Punkt-Segment unversehrt da.
    expect(readFileSync(join(siteDir, AUTH_DIR_NAME, "auth.json"))).toEqual(authVorher);
    expect(existsSync(join(siteDir, AUTH_DIR_NAME, "schwebend", "index.html"))).toBe(true);
  });
});

// ===========================================================================
// Der Bezugspunkt: welcher Commit steht draußen?
// ===========================================================================
describe("der veröffentlichte Commit", () => {
  /**
   * Ein echtes Entwurfs-Repo, denn hier geht es um Commits.
   *
   * Die übrigen Tests dieser Datei bauen den Entwurf von Hand, um nicht an zwei
   * Modulen zugleich zu hängen. Für `commit` geht das nicht: Ohne Repo gäbe es
   * nichts zu zeigen, und ein erfundener SHA wäre eine zweite Wahrheit.
   */
  async function mitRepo(): Promise<{ siteDir: string; entwurfDir: string }> {
    const { entwurfPfad, stelleEntwurfBereit } = await import("./entwurf.ts");
    const siteDir = tmp("regoro-veroeff-repo-");
    cpSync(REAL_SITE, siteDir, { recursive: true });
    await createAuthFile(siteDir, [NUMMER]);
    stelleEntwurfBereit(siteDir);
    return { siteDir, entwurfDir: entwurfPfad(siteDir) };
  }

  /** Ein Commit im Entwurf, wie ihn ein Speichern erzeugt. */
  async function committe(entwurfDir: string, datei: string, inhalt: string, nachricht: string): Promise<void> {
    const { commitEdit } = await import("./git.ts");
    writeFileSync(join(entwurfDir, datei), inhalt);
    commitEdit(entwurfDir, datei, nachricht);
  }

  test("veroeffentlicht.json trägt den Commit, der ausgerollt wurde", async () => {
    const { veroeffentliche, letzterVeroeffentlichterCommit } = await api();
    const { git } = await import("./git.ts");
    const { siteDir, entwurfDir } = await mitRepo();

    veroeffentliche(siteDir, entwurfDir);

    const kopf = git(entwurfDir, "rev-parse", "HEAD").trim();
    const gelesen = JSON.parse(readFileSync(pruefsummenDatei(siteDir), "utf8")) as { commit: string };
    expect(gelesen.commit).toBe(kopf);
    expect(letzterVeroeffentlichterCommit(siteDir)).toBe(kopf);
  });

  test("ohne Aufzeichnung gibt es keinen Bezugspunkt", async () => {
    // Der Zustand vor der Einrichtung: die Website liegt da, niemand hat je
    // etwas aufgezeichnet.
    const { letzterVeroeffentlichterCommit } = await api();
    const { siteDir } = await lage();
    expect(existsSync(pruefsummenDatei(siteDir))).toBe(false); // Messapparat
    expect(letzterVeroeffentlichterCommit(siteDir)).toBeNull();
  });

  test("die Einrichtung zeichnet den Baseline-Commit sofort auf", async () => {
    /**
     * `stelleEntwurfBereit` schreibt `veroeffentlicht.json` selbst — die
     * Eigentums-Übergabe („ab jetzt gehört die Website dem Entwurfs-Repo") wird
     * im selben Zug festgehalten. Das ist keine Beiläufigkeit: Ohne sie bliebe
     * ein Neubau der Fabrik unbemerkt, und die erste Veröffentlichung
     * überschriebe ihn wortlos, weil die Notbremse nichts zum Vergleichen hätte.
     *
     * Folge, die hier ebenfalls festgehalten wird: Direkt nach der Einrichtung
     * ist NICHTS unveröffentlicht — der Abzug ist der Baseline-Commit.
     */
    const { letzterVeroeffentlichterCommit, unveroeffentlichteCommits } = await api();
    const { git } = await import("./git.ts");
    const { siteDir, entwurfDir } = await mitRepo();

    const kopf = git(entwurfDir, "rev-parse", "HEAD").trim();
    expect(letzterVeroeffentlichterCommit(siteDir)).toBe(kopf);
    expect(unveroeffentlichteCommits(entwurfDir, kopf).anzahl).toBe(0);
  });

  test("er wandert mit: nach dem zweiten Veröffentlichen steht der neue drin", async () => {
    // Sonst zählte `unveroeffentlichteCommits` ab einem Stand, der längst
    // draußen ist — die Leiste meldete für immer „noch nicht live".
    const { veroeffentliche, letzterVeroeffentlichterCommit } = await api();
    const { siteDir, entwurfDir } = await mitRepo();

    veroeffentliche(siteDir, entwurfDir);
    const erster = letzterVeroeffentlichterCommit(siteDir);

    await committe(entwurfDir, "index.html", "<html><body><p>NEU</p></body></html>", "Inline-Edit");
    veroeffentliche(siteDir, entwurfDir);

    const zweiter = letzterVeroeffentlichterCommit(siteDir);
    expect(zweiter).not.toBe(erster);
    expect(zweiter).toMatch(/^[0-9a-f]{7,40}$/);
  });

  test("unveroeffentlichteCommits zählt COMMITS, nicht Dateien", async () => {
    /**
     * Contract C2: „4 gespeicherte Änderungen sind noch nicht auf der
     * Live-Seite" — ein Commit ist EINE gespeicherte Änderung, auch wenn ein
     * KI-Lauf dabei fünf Dateien anfasst. Der Test setzt genau das gegenüber:
     * zwei Commits über insgesamt drei Dateien.
     */
    const { veroeffentliche, letzterVeroeffentlichterCommit, unveroeffentlichteCommits } = await api();
    const { commitEdit } = await import("./git.ts");
    const { siteDir, entwurfDir } = await mitRepo();

    veroeffentliche(siteDir, entwurfDir);
    const basis = letzterVeroeffentlichterCommit(siteDir);
    expect(unveroeffentlichteCommits(entwurfDir, basis).anzahl).toBe(0); // Messapparat

    await committe(entwurfDir, "index.html", "<html><body><p>EINS</p></body></html>", "Erste Änderung");
    // Ein Lauf, der drei Dateien in EINEM Commit anfasst.
    writeFileSync(join(entwurfDir, "impressum.html"), "<html><body><p>ZWEI</p></body></html>");
    writeFileSync(join(entwurfDir, "agb.html"), "<html><body><p>DREI</p></body></html>");
    commitEdit(entwurfDir, ["impressum.html", "agb.html"], "KI-Seitenleiste: Auftrag übernommen");

    const offen = unveroeffentlichteCommits(entwurfDir, basis);
    expect(offen.anzahl).toBe(2); // zwei Commits — nicht drei Dateien
    expect(offen.seit).not.toBeNull();
  });

  test("`seit` kommt in Zulu-Form — dasselbe Format wie schwebendSeit", async () => {
    /**
     * EIGENER TEST, mit Absicht getrennt von den beiden Zusicherungen über den
     * INHALT von `seit`.
     *
     * git liefert `%aI` mit Zonenversatz (`…+02:00`), `schwebendSeit` liefert
     * `…Z`; beides ist gültiges ISO 8601 und ergibt denselben Moment. Zwei
     * Formate im selben Antwortobjekt sind trotzdem eine Falle für jeden, der
     * die Werte einmal vergleicht statt sie zu parsen — deshalb normalisiert
     * die Umsetzung.
     *
     * Wie leicht man hineinfällt, hat diese Datei selbst vorgeführt: Ich hatte
     * den Formatunterschied gemeldet und bewusst nicht festgenagelt — und
     * verglich ein paar Zeilen tiefer trotzdem gegen die rohe git-Ausgabe. Wenn
     * das im Test passiert, während der Autor die Falle gerade benennt, dann
     * passiert es in der Oberfläche erst recht.
     *
     * Getrennt steht der Test, damit eine künftige Formatentscheidung genau
     * diesen einen Test rot macht und nicht den über „der ÄLTESTE, nicht der
     * jüngste" — der über den Inhalt urteilt und von der Schreibweise nichts
     * wissen will.
     */
    const { veroeffentliche, letzterVeroeffentlichterCommit, unveroeffentlichteCommits } = await api();
    const { siteDir, entwurfDir } = await mitRepo();

    veroeffentliche(siteDir, entwurfDir);
    const basis = letzterVeroeffentlichterCommit(siteDir);
    await committe(entwurfDir, "index.html", "<html><body><p>EINS</p></body></html>", "Eine Änderung");

    const seit = unveroeffentlichteCommits(entwurfDir, basis).seit;
    expect(seit).not.toBeNull(); // Messapparat: es gibt überhaupt eine Zeit
    expect(new Date(seit!).toISOString()).toBe(seit!);
    expect(seit).toMatch(/Z$/);
  });

  test("`seit` ist der ÄLTESTE unveröffentlichte Commit, nicht der jüngste", async () => {
    // Daran hängt der 3-Tage-Hinweis (Contract C8). Nähme man den jüngsten,
    // wäre er nach jedem Speichern wieder frisch und schlüge nie an.
    const { veroeffentliche, letzterVeroeffentlichterCommit, unveroeffentlichteCommits } = await api();
    const { git } = await import("./git.ts");
    const { siteDir, entwurfDir } = await mitRepo();

    veroeffentliche(siteDir, entwurfDir);
    const basis = letzterVeroeffentlichterCommit(siteDir);

    await committe(entwurfDir, "index.html", "<html><body><p>ALT</p></body></html>", "Alt");
    const alt = git(entwurfDir, "log", "-1", "--format=%aI").trim();
    await Bun.sleep(1100); // git-Zeitstempel sind sekundengenau
    await committe(entwurfDir, "impressum.html", "<html><body><p>NEU</p></body></html>", "Neu");
    const neu = git(entwurfDir, "log", "-1", "--format=%aI").trim();
    expect(alt).not.toBe(neu); // Messapparat: die beiden Zeiten sind wirklich verschieden

    // Verglichen wird der MOMENT, nicht die Zeichenkette: git liefert `%aI` mit
    // Zonenversatz, `unveroeffentlichteCommits` normalisiert auf Z. Beides
    // derselbe Zeitpunkt — ein Zeichenketten-Vergleich prüfte hier die
    // Formatierung statt der Aussage.
    const seit = unveroeffentlichteCommits(entwurfDir, basis).seit;
    expect(Date.parse(seit!)).toBe(Date.parse(alt));
    expect(Date.parse(seit!)).not.toBe(Date.parse(neu));
  }, 15_000);

  test("ohne Bezugspunkt wird lieber zu viel gemeldet als zu wenig", async () => {
    // Verlorene `veroeffentlicht.json`: Dann ist der Wurzel-Commit die Basis.
    // „Nichts offen" wäre die gefährlichere Antwort — der Kunde glaubte, seine
    // Website sei aktuell.
    const { unveroeffentlichteCommits } = await api();
    const { entwurfDir } = await mitRepo();
    await committe(entwurfDir, "index.html", "<html><body><p>X</p></body></html>", "Eine Änderung");

    expect(unveroeffentlichteCommits(entwurfDir, null).anzahl).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// Die Prüfsummendatei
// ===========================================================================
describe("veroeffentlicht.json", () => {
  test("liegt in .regoro, trägt v:1, eine ISO-Zeit und echte sha256-Summen", async () => {
    const { veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    writeFileSync(join(entwurfDir, "index.html"), "<html><body><p>STAND</p></body></html>");
    veroeffentliche(siteDir, entwurfDir);

    expect(existsSync(pruefsummenDatei(siteDir))).toBe(true);
    const gelesen = JSON.parse(readFileSync(pruefsummenDatei(siteDir), "utf8")) as {
      v: number;
      stand: Record<string, string>;
      zeit: string;
    };

    expect(gelesen.v).toBe(1);
    expect(new Date(gelesen.zeit).toISOString()).toBe(gelesen.zeit);

    // Der Wert wird gegen die Datei auf Platte gerechnet, nicht gegen eine
    // zweite Zeichenkette aus derselben Quelle.
    expect(Object.keys(gelesen.stand).length).toBeGreaterThan(0);
    for (const [rel, hex] of Object.entries(gelesen.stand)) {
      expect(`${rel}: ${hex}`).toBe(`${rel}: ${sha256(join(siteDir, rel))}`);
    }
    expect(gelesen.stand["index.html"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("führt genau die ausgelieferten Dateien — keine Punkt-Segmente", async () => {
    const { veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();
    veroeffentliche(siteDir, entwurfDir);

    const gelesen = JSON.parse(readFileSync(pruefsummenDatei(siteDir), "utf8")) as {
      stand: Record<string, string>;
    };
    const erwartet = alleDateien(entwurfDir).filter((p) => !p.split("/").some((s) => s.startsWith(".")));
    expect(Object.keys(gelesen.stand).sort()).toEqual(erwartet);
  });

  test("eine gelöschte Datei verschwindet auch aus dem Stand", async () => {
    const { veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    writeFileSync(join(entwurfDir, "zusatz.html"), "<html><body><p>Z</p></body></html>");
    veroeffentliche(siteDir, entwurfDir);
    rmSync(join(entwurfDir, "zusatz.html"));
    veroeffentliche(siteDir, entwurfDir);

    const gelesen = JSON.parse(readFileSync(pruefsummenDatei(siteDir), "utf8")) as {
      stand: Record<string, string>;
    };
    expect(Object.keys(gelesen.stand)).not.toContain("zusatz.html");
  });
});

// ===========================================================================
// Die Notbremse
// ===========================================================================
describe("die Notbremse gegen fremde Schreiber", () => {
  test("beim ALLERERSTEN Mal gibt es keine Fremdänderung", async () => {
    // Ohne Prüfsummendatei ist jede Datei „unbekannt", nicht „verändert". Wäre
    // das eine Fremdänderung, käme niemand je zur ersten Veröffentlichung.
    const { pruefeFremdaenderung, veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    expect(existsSync(pruefsummenDatei(siteDir))).toBe(false);
    expect(pruefeFremdaenderung(siteDir)).toEqual([]);
    expect(() => veroeffentliche(siteDir, entwurfDir)).not.toThrow();
  });

  test("GEGENPROBE: ohne Fremdänderung läuft es durch und schreibt wirklich", async () => {
    // Diese Zeile trägt den ganzen Block. Ein `veroeffentliche`, das immer
    // wirft, bestünde jeden Abbruch-Test der Welt und wäre trotzdem kaputt.
    const { pruefeFremdaenderung, veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    veroeffentliche(siteDir, entwurfDir);
    writeFileSync(join(entwurfDir, "index.html"), "<html><body><p>ZWEITER-STAND</p></body></html>");

    expect(pruefeFremdaenderung(siteDir)).toEqual([]);
    const erg = veroeffentliche(siteDir, entwurfDir);
    expect(erg.geschrieben).toEqual(["index.html"]);
    expect(readFileSync(join(siteDir, "index.html"), "utf8")).toContain("ZWEITER-STAND");
  });

  test("eine von Hand geänderte Datei im Site-Ordner meldet `fremd`", async () => {
    const { pruefeFremdaenderung, veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    veroeffentliche(siteDir, entwurfDir);
    writeFileSync(join(siteDir, "index.html"), "<html><body><p>VON-FREMDER-HAND</p></body></html>");

    expect(pruefeFremdaenderung(siteDir)).toEqual(["index.html"]);
  });

  test("und dann wird NICHT überschrieben, sondern abgebrochen", async () => {
    const { veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();

    veroeffentliche(siteDir, entwurfDir);
    writeFileSync(join(siteDir, "index.html"), "<html><body><p>VON-FREMDER-HAND</p></body></html>");
    // Im Entwurf steht etwas anderes — es darf nicht durchkommen.
    writeFileSync(join(entwurfDir, "index.html"), "<html><body><p>AUS-DEM-ENTWURF</p></body></html>");
    writeFileSync(join(entwurfDir, "impressum.html"), "<html><body><p>AUCH-NEU</p></body></html>");
    const impressumVorher = readFileSync(join(siteDir, "impressum.html"));

    expect(() => veroeffentliche(siteDir, entwurfDir)).toThrow();

    // Die fremde Arbeit steht noch da …
    expect(readFileSync(join(siteDir, "index.html"), "utf8")).toContain("VON-FREMDER-HAND");
    // … und ALLES ODER NICHTS: auch die unbeteiligte zweite Datei blieb liegen.
    expect(readFileSync(join(siteDir, "impressum.html"))).toEqual(impressumVorher);
  });

  /**
   * DIE TRENNLINIE: Es geht um Verlust, nicht um Regelverstöße.
   *
   * Beide Fälle darunter sind derselbe Verstoß gegen die Eigentums-Regel — und
   * trotzdem gehören sie auf verschiedene Seiten. Maßgeblich ist allein, ob das
   * Veröffentlichen fremde Arbeit ZERSTÖREN würde:
   *
   *   verschwundene Datei → nichts zu verlieren, sie wird zurückgeschrieben
   *   unbekannte Datei    → sie steht in keinem Entwurf und würde GELÖSCHT
   *
   * Anders herum gebaut wäre beides falsch: Das Melden der verschwundenen Datei
   * blockierte eine Veröffentlichung, die sich von selbst heilt, und das
   * Durchwinken der unbekannten löschte kommentarlos etwas, das jemand
   * hingelegt hat.
   */
  test("eine im Site-Ordner GELÖSCHTE Datei blockiert nicht — sie kommt einfach zurück", async () => {
    const { pruefeFremdaenderung, veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();
    veroeffentliche(siteDir, entwurfDir);

    rmSync(join(siteDir, "impressum.html"));

    expect(pruefeFremdaenderung(siteDir)).toEqual([]);
    const erg = veroeffentliche(siteDir, entwurfDir);
    expect(erg.geschrieben).toContain("impressum.html");
    expect(existsSync(join(siteDir, "impressum.html"))).toBe(true);
  });

  test("eine Datei, die nie veröffentlicht wurde, meldet sich als fremd", async () => {
    // Sie steht in keinem Entwurf — das nächste Veröffentlichen LÖSCHT sie
    // (`geloescht` = alles im Site-Ordner, was die Quelle nicht kennt). Wer sie
    // durchwinkte, hätte genau den Fall gebaut, gegen den die Notbremse steht.
    const { pruefeFremdaenderung, veroeffentliche } = await api();
    const { siteDir, entwurfDir } = await lage();
    veroeffentliche(siteDir, entwurfDir);

    writeFileSync(join(siteDir, "fremde-datei.html"), "<html><body><p>von wem auch immer</p></body></html>");

    expect(pruefeFremdaenderung(siteDir)).toEqual(["fremde-datei.html"]);
    expect(() => veroeffentliche(siteDir, entwurfDir)).toThrow();
    expect(existsSync(join(siteDir, "fremde-datei.html"))).toBe(true);
  });
});
