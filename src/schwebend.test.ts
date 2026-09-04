/**
 * Die schwebende Änderung — was der Kunde noch nicht übernommen hat.
 *
 * Contract C6 (`schwebendPfad`/`schwebendVorhanden`/`schwebendDateien`/
 * `schwebendSeit`/`legeSchwebendAn`/`verwirfSchwebend`, alle in
 * `arbeitskopie.ts`).
 *
 * Der Zustand hängt an der WEBSITE, nicht am Browser und nicht am Prozess
 * (Plan §2): Zwei Geräte sehen dieselbe offene Änderung, und sie ist in drei
 * Tagen noch da. Deshalb steht hier nicht „eine Variable ist gesetzt", sondern
 * ein **zweiter Prozess**, der die Lage vorfindet — ein Neustart, wie er
 * echter nicht zu haben ist.
 *
 * Und `verwirfSchwebend` ist der Grund für den ganzen Umbau: Es räumt auch
 * NEU ANGELEGTE Dateien weg. Genau das konnte `restoreVersion` nie
 * (`git checkout` löscht nicht), und daran ist das alte Sicherheitsnetz
 * gescheitert.
 *
 * PHASE 1: `arbeitskopie.ts` gibt es, die sechs Funktionen noch nicht. Der
 * Zugriff läuft deshalb über einen dynamischen Import — ein statischer Import
 * eines fehlenden Namens ließe die ganze Datei beim Laden wegbrechen, und
 * kein einzelner Fehlschlag sagte mehr, welche Zusicherung fehlt.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_DIR_NAME, createAuthFile } from "./auth.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");
const ARBEITSKOPIE_TS = join(import.meta.dir, "arbeitskopie.ts");
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

async function macheSite(): Promise<string> {
  const siteDir = tmp("regoro-schwebend-site-");
  cpSync(REAL_SITE, siteDir, { recursive: true });
  await createAuthFile(siteDir, [NUMMER]);
  return siteDir;
}

type SchwebendApi = {
  schwebendPfad(siteDir: string): string;
  schwebendVorhanden(siteDir: string): boolean;
  schwebendDateien(siteDir: string): string[];
  schwebendSeit(siteDir: string): string | null;
  legeSchwebendAn(
    siteDir: string,
    dateien: Map<string, Buffer>,
    basis: Map<string, string | null>,
  ): void;
  verwirfSchwebend(siteDir: string): void;
};

async function api(): Promise<SchwebendApi> {
  return (await import("./arbeitskopie.ts")) as unknown as SchwebendApi;
}

/**
 * Legt eine schwebende Änderung ab — mit dem **Pflicht-Bezugspunkt** aus C6.
 *
 * `basis` sagt, welchen Stand jede Datei hatte, als die Änderung entstand
 * (`null` = gab es noch nicht). Der Parameter ist mit Absicht keine Option:
 * Ohne ihn könnte `409 fremd-geaendert` beim Übernehmen gar nicht anschlagen —
 * eine schwebende Änderung ohne Bezugspunkt überschriebe die parallele
 * Handarbeit des Kunden stillschweigend. Ein optionaler Parameter, dessen
 * Fehlen eine Sicherheitsprüfung stilllegt, wäre selbst der Weg in den
 * Zustand, gegen den er schützt.
 *
 * Die Tests dieser Datei prüfen die ABLAGE, nicht die Übernahme. Sie geben den
 * Stand deshalb trotzdem ehrlich an (gemessen am Ordner, gegen den die Änderung
 * entstanden ist), statt ihn zu erfinden — sonst stünde hier ein Muster, das
 * jemand später aus Bequemlichkeit in den Produktivpfad überträgt.
 */
async function legeAb(
  siteDir: string,
  dateien: Map<string, Buffer>,
  quelle: string = siteDir,
): Promise<void> {
  const { legeSchwebendAn } = await api();
  const { byteHashDatei } = await import("./arbeitskopie.ts");
  const basis = new Map<string, string | null>();
  for (const rel of dateien.keys()) {
    const pfad = join(quelle, rel);
    basis.set(rel, existsSync(pfad) ? byteHashDatei(pfad) : null);
  }
  legeSchwebendAn(siteDir, dateien, basis);
}

/** Alle Dateien unter `wurzel`, relativ mit „/", sortiert. */
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

/**
 * Ein Schnappschuss der AUSGELIEFERTEN Website: relativer Pfad → Inhalt.
 *
 * Punkt-Segmente bleiben draußen — `.regoro/schwebend/` ist gerade das, was
 * sich ändern SOLL. Wer sie mitzählte, bekäme einen Schnappschuss, der sich bei
 * jeder offenen Änderung unterscheidet, und müsste den Vergleich aufgeben.
 */
function schnappschuss(wurzel: string): Record<string, string> {
  const raus: Record<string, string> = {};
  for (const rel of alleDateien(wurzel)) {
    if (rel.split("/").some((s) => s.startsWith("."))) continue;
    raus[rel] = readFileSync(join(wurzel, rel), "base64");
  }
  return raus;
}

const b = (s: string): Buffer => Buffer.from(s, "utf8");

// ===========================================================================
// Wo der schwebende Stand liegt
// ===========================================================================
describe("schwebendPfad", () => {
  test("zeigt nach <siteDir>/.regoro/schwebend", async () => {
    const { schwebendPfad } = await api();
    const siteDir = await macheSite();
    expect(schwebendPfad(siteDir)).toBe(join(siteDir, AUTH_DIR_NAME, "schwebend"));
  });

  test("liegt IM Kundenordner — nicht unter der Runtime-Wurzel", async () => {
    // Das ist die ganze Haltbarkeitsaussage: Was unter `runtimeWurzel()` liegt,
    // räumt systemd beim Dienstende weg (siehe arbeitskopie.test.ts). Eine
    // offene Änderung, die den Neustart nicht überlebt, wäre kein Zustand der
    // Website, sondern einer des Prozesses.
    //
    // Die Runtime-Wurzel wird dafür AUSDRÜCKLICH umgebogen: Ohne
    // `RUNTIME_DIRECTORY` ist sie das Temp-Verzeichnis — und darin liegt auch
    // der Test-Site-Ordner. Der Vergleich wäre dann immer wahr und der Test
    // ohne Gegenstand.
    const { schwebendPfad } = await api();
    const { runtimeWurzel } = await import("./arbeitskopie.ts");
    const vorher = process.env.RUNTIME_DIRECTORY;
    try {
      process.env.RUNTIME_DIRECTORY = tmp("regoro-schwebend-run-");
      const siteDir = await macheSite();
      expect(schwebendPfad(siteDir).startsWith(siteDir)).toBe(true);
      expect(schwebendPfad(siteDir).startsWith(runtimeWurzel())).toBe(false);
    } finally {
      if (vorher === undefined) delete process.env.RUNTIME_DIRECTORY;
      else process.env.RUNTIME_DIRECTORY = vorher;
    }
  });
});

// ===========================================================================
// Anlegen
// ===========================================================================
describe("legeSchwebendAn", () => {
  test("legt genau die berührten Dateien ab — nicht die ganze Website", async () => {
    const { legeSchwebendAn, schwebendDateien, schwebendPfad, schwebendVorhanden } = await api();
    const siteDir = await macheSite();

    expect(schwebendVorhanden(siteDir)).toBe(false); // Messapparat: vorher nichts
    await legeAb(siteDir, new Map([["impressum.html", b("<html><body><p>neu</p></body></html>")]]));

    expect(schwebendVorhanden(siteDir)).toBe(true);
    expect(schwebendDateien(siteDir)).toEqual(["impressum.html"]);
    // Und wirklich nur die eine: `index.html` gibt es in der Website, aber der
    // Lauf hat sie nicht angefasst. Buchhaltung der Ablage selbst (Punkt-Datei)
    // zählt nicht mit — sie gehört nicht zur Website und wird beim Übernehmen
    // nie geschrieben.
    const abgelegt = alleDateien(schwebendPfad(siteDir)).filter(
      (p) => !p.split("/").some((s) => s.startsWith(".")),
    );
    expect(abgelegt).toEqual(["impressum.html"]);
  });

  test("Unterordner kommen mit, Pfade sind relativ, mit Schrägstrich und sortiert", async () => {
    const { legeSchwebendAn, schwebendDateien, schwebendPfad } = await api();
    const siteDir = await macheSite();

    await legeAb(
      siteDir,
      new Map([
        ["index.html", b("<html><body><p>zwei</p></body></html>")],
        ["assets/neu.css", b("body{color:#111}")],
      ]),
    );

    expect(schwebendDateien(siteDir)).toEqual(["assets/neu.css", "index.html"]);
    expect(readFileSync(join(schwebendPfad(siteDir), "assets", "neu.css"), "utf8")).toBe("body{color:#111}");
  });

  test("Binärdaten kommen byteidentisch an", async () => {
    const { legeSchwebendAn, schwebendPfad } = await api();
    const siteDir = await macheSite();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x00]);

    await legeAb(siteDir, new Map([["assets/bild.png", bytes]]));

    expect(readFileSync(join(schwebendPfad(siteDir), "assets", "bild.png"))).toEqual(bytes);
  });

  test("die Website bleibt dabei byteidentisch", async () => {
    const { legeSchwebendAn } = await api();
    const siteDir = await macheSite();
    const vorher = schnappschuss(siteDir);

    expect(Object.keys(vorher).length).toBeGreaterThan(0); // Messapparat: es gibt etwas zu vergleichen
    await legeAb(siteDir, new Map([["index.html", b("<html><body><p>NUR-SCHWEBEND</p></body></html>")]]));

    // Der Punkt der ganzen Übung: Der Besucher sieht davon nichts.
    expect(schnappschuss(siteDir)).toEqual(vorher);
    expect(readFileSync(join(siteDir, "index.html"), "utf8")).not.toContain("NUR-SCHWEBEND");
  });

  test("ein zweiter Aufruf ERSETZT den alten Stand, er ergänzt ihn nicht", async () => {
    // Sonst lägen die Dateien zweier Läufe übereinander, und „Übernehmen"
    // schriebe etwas auf die Website, das der Kunde nie zu sehen bekam.
    const { legeSchwebendAn, schwebendDateien } = await api();
    const siteDir = await macheSite();

    await legeAb(siteDir, new Map([["alt.html", b("<html><body><p>erster Lauf</p></body></html>")]]));
    await legeAb(siteDir, new Map([["neu.html", b("<html><body><p>zweiter Lauf</p></body></html>")]]));

    expect(schwebendDateien(siteDir)).toEqual(["neu.html"]);
  });

  test("eine leere Map legt keine schwebende Änderung an", async () => {
    // Ein Lauf, der nichts geändert hat, darf den Editor nicht sperren
    // (`/edit/save` gibt 409, solange etwas offen ist).
    const { legeSchwebendAn, schwebendVorhanden } = await api();
    const siteDir = await macheSite();

    await legeAb(siteDir, new Map());

    expect(schwebendVorhanden(siteDir)).toBe(false);
  });

  test("ein Pfad, der nach draußen zeigt, schreibt nichts nach draußen", async () => {
    // Der Aufrufer ist der Elternprozess, die Namen kommen aus
    // `ermittleAenderungen` — hier steht Tiefenverteidigung, kein erwarteter
    // Fall. Sie kostet nichts und fängt den Tag, an dem jemand die Namen aus
    // einer anderen Quelle nimmt.
    const { legeSchwebendAn } = await api();
    const siteDir = await macheSite();
    const indexVorher = readFileSync(join(siteDir, "index.html"));
    const authVorher = readFileSync(join(siteDir, AUTH_DIR_NAME, "auth.json"));

    try {
      await legeAb(
        siteDir,
        new Map([
          ["../../index.html", b("<html><body><p>DURCHGERUTSCHT</p></body></html>")],
          ["../auth.json", b("{}")],
        ]),
      );
    } catch {
      // Werfen ist ein gültiger Ausgang; stillschweigend auslassen auch.
    }

    expect(readFileSync(join(siteDir, "index.html"))).toEqual(indexVorher);
    expect(readFileSync(join(siteDir, AUTH_DIR_NAME, "auth.json"))).toEqual(authVorher);
  });
});

// ===========================================================================
// Der Neustart
// ===========================================================================
describe("die offene Änderung überlebt den Neustart", () => {
  /**
   * Fragt einen ZWEITEN Prozess, was er auf Platte vorfindet.
   *
   * Ein neuer Prozess ist der einzige ehrliche Neustart: Er hat kein Modul im
   * Speicher, keine Variable, keinen Cache. Ein `await import(... + "?neu")`
   * wäre nur ein zweites Modul im selben Prozess — und wenn der Zustand doch
   * irgendwo global hinge, sähe der Test es nicht.
   */
  function fremderProzess(siteDir: string): { vorhanden: boolean; dateien: string[]; seit: string | null } {
    const skript = join(tmp("regoro-schwebend-probe-"), "probe.ts");
    writeFileSync(
      skript,
      `import { schwebendVorhanden, schwebendDateien, schwebendSeit } from ${JSON.stringify(ARBEITSKOPIE_TS)};\n` +
        `const s = process.argv[2]!;\n` +
        `console.log(JSON.stringify({ vorhanden: schwebendVorhanden(s), dateien: schwebendDateien(s), seit: schwebendSeit(s) }));\n`,
    );
    const r = Bun.spawnSync([process.execPath, "run", skript, siteDir], { stdout: "pipe", stderr: "pipe" });
    const aus = new TextDecoder().decode(r.stdout).trim();
    if (r.exitCode !== 0 || aus === "") {
      throw new Error(
        `Der zweite Prozess endete mit ${r.exitCode} und ohne Ausgabe. stderr: ` +
          new TextDecoder().decode(r.stderr).slice(0, 500),
      );
    }
    return JSON.parse(aus.split("\n").at(-1)!);
  }

  test("ein frisch gestarteter Prozess findet sie vor", async () => {
    const { legeSchwebendAn } = await api();
    const siteDir = await macheSite();

    await legeAb(siteDir, new Map([["leistungen.html", b("<html><body><p>Badsanierung</p></body></html>")]]));

    const nachNeustart = fremderProzess(siteDir);
    expect(nachNeustart.vorhanden).toBe(true);
    expect(nachNeustart.dateien).toEqual(["leistungen.html"]);
    expect(nachNeustart.seit).not.toBeNull();
  }, 20_000);

  test("GEGENPROBE: ohne offene Änderung meldet derselbe Prozess `false`", async () => {
    // Ohne sie misst der Test oben nur, dass ein Skript „true" druckt.
    await api();
    const siteDir = await macheSite();

    const nachNeustart = fremderProzess(siteDir);
    expect(nachNeustart.vorhanden).toBe(false);
    expect(nachNeustart.dateien).toEqual([]);
    expect(nachNeustart.seit).toBeNull();
  }, 20_000);

  test("und nach dem Verwerfen ist sie auch dort weg", async () => {
    const { legeSchwebendAn, verwirfSchwebend } = await api();
    const siteDir = await macheSite();

    await legeAb(siteDir, new Map([["leistungen.html", b("<p>x</p>")]]));
    verwirfSchwebend(siteDir);

    expect(fremderProzess(siteDir).vorhanden).toBe(false);
  }, 20_000);
});

// ===========================================================================
// schwebendSeit
// ===========================================================================
describe("schwebendSeit", () => {
  test("liefert eine ISO-Zeit, die um das Anlegen herum liegt", async () => {
    const { legeSchwebendAn, schwebendSeit } = await api();
    const siteDir = await macheSite();

    const vorher = Date.now();
    await legeAb(siteDir, new Map([["index.html", b("<p>x</p>")]]));
    const nachher = Date.now();

    const seit = schwebendSeit(siteDir);
    expect(seit).not.toBeNull();
    // ISO heißt ISO: die Rundreise durch Date muss dieselbe Zeichenkette geben.
    expect(new Date(seit!).toISOString()).toBe(seit!);
    const ms = new Date(seit!).getTime();
    // Sekundengenau reicht: manche Dateisysteme runden mtime auf Sekunden ab.
    expect(ms).toBeGreaterThanOrEqual(vorher - 1000);
    expect(ms).toBeLessThanOrEqual(nachher + 1000);
  });

  test("ohne offene Änderung: null", async () => {
    const { schwebendSeit } = await api();
    const siteDir = await macheSite();
    expect(schwebendSeit(siteDir)).toBeNull();
  });
});

// ===========================================================================
// verwirfSchwebend — der Grund für den ganzen Umbau
// ===========================================================================
describe("verwirfSchwebend", () => {
  test("räumt restlos ab, auch NEU angelegte Dateien", async () => {
    // Das ist die Lücke, die `restoreVersion` nie schließen konnte: Ein Lauf,
    // der Dateien anlegt, ließ sich nicht als Ganzes zurücknehmen
    // (`git checkout` löscht nicht). Hier verschwindet die neue Datei mit dem
    // Verzeichnis — es braucht gar keinen Löschweg.
    const { legeSchwebendAn, schwebendDateien, schwebendPfad, schwebendVorhanden, verwirfSchwebend } = await api();
    const siteDir = await macheSite();

    await legeAb(
      siteDir,
      new Map([
        ["index.html", b("<html><body><p>geändert</p></body></html>")],
        ["ganz-neu.html", b("<html><body><p>gibt es in der Website nicht</p></body></html>")],
        ["assets/neu.css", b("p{}")],
      ]),
    );
    expect(schwebendDateien(siteDir)).toHaveLength(3); // Messapparat: es war etwas da

    verwirfSchwebend(siteDir);

    expect(schwebendVorhanden(siteDir)).toBe(false);
    expect(schwebendDateien(siteDir)).toEqual([]);
    // Kein Rest auf Platte — weder Verzeichnis noch leere Ordner darin.
    const pfad = schwebendPfad(siteDir);
    expect(!existsSync(pfad) || alleDateien(pfad).length === 0).toBe(true);
  });

  test("die neue Datei entsteht dabei nie in der Website", async () => {
    const { legeSchwebendAn, verwirfSchwebend } = await api();
    const siteDir = await macheSite();
    const vorher = schnappschuss(siteDir);

    await legeAb(siteDir, new Map([["ganz-neu.html", b("<p>x</p>")]]));
    verwirfSchwebend(siteDir);

    expect(existsSync(join(siteDir, "ganz-neu.html"))).toBe(false);
    expect(schnappschuss(siteDir)).toEqual(vorher);
  });

  test("ist idempotent und wirft nicht, wenn nichts offen ist", async () => {
    const { verwirfSchwebend, schwebendVorhanden } = await api();
    const siteDir = await macheSite();

    expect(() => verwirfSchwebend(siteDir)).not.toThrow();
    expect(() => verwirfSchwebend(siteDir)).not.toThrow();
    expect(schwebendVorhanden(siteDir)).toBe(false);
  });

  test("lässt .regoro und die Website in Ruhe", async () => {
    const { legeSchwebendAn, verwirfSchwebend } = await api();
    const siteDir = await macheSite();
    const authVorher = readFileSync(join(siteDir, AUTH_DIR_NAME, "auth.json"));

    await legeAb(siteDir, new Map([["index.html", b("<p>x</p>")]]));
    verwirfSchwebend(siteDir);

    expect(existsSync(join(siteDir, AUTH_DIR_NAME))).toBe(true);
    expect(readFileSync(join(siteDir, AUTH_DIR_NAME, "auth.json"))).toEqual(authVorher);
    expect(existsSync(join(siteDir, "index.html"))).toBe(true);
    expect(statSync(join(siteDir, "index.html")).isFile()).toBe(true);
  });
});
