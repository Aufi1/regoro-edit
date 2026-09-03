/**
 * verlauf.ts — Gesprächsverläufe der KI-Seitenleiste.
 *
 * Geprüft wird, was UNS gehört: Auswahl (24 h), Aufbewahrung (30 Tage), das
 * Hin- und Herkopieren zwischen Kundenordner und Arbeitskopie samt Deckel.
 * Format, Fortsetzen und Compaction gehören pi und werden hier nicht
 * nachgebaut — wohl aber die eine gemessene Eigenschaft, auf der alles ruht:
 * `listAll` statt `list`, weil `list` nach `cwd` filtert und unsere
 * Arbeitskopie bei jedem Lauf anders heißt.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  AUFBEWAHRUNG_MS,
  MAX_VERLAUF_BYTES,
  NEUER_VERLAUF_NACH_MS,
  bereiteSitzungVor,
  listeVerlaeufe,
  raeumeAlteVerlaeufe,
  sitzungDirInKopie,
  uebernimmSitzung,
  verlaufDir,
  waehleFortsetzung,
} from "./verlauf.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function frischeSite(): string {
  const d = mkdtempSync(join(tmpdir(), "verlauf-site-"));
  dirs.push(d);
  mkdirSync(verlaufDir(d), { recursive: true });
  return d;
}

/**
 * Legt einen echten Verlauf an — über pi, nicht von Hand.
 *
 * Von Hand geschriebene JSONL würde unsere Erwartung an pi's Format festhalten
 * statt pi's Format. Und die eine Eigenschaft, die man dabei übersieht, steht
 * hier drin: **pi schreibt die Datei erst, wenn eine Antwort des Modells
 * vorliegt** (`_persist`, „hasAssistant"). Ohne die zweite Zeile entsteht gar
 * keine Datei, und der Test prüfte ins Leere.
 */
function legeVerlaufAn(siteDir: string, text: string): void {
  const sm = SessionManager.create(mkdtempSync(join(tmpdir(), "verlauf-cwd-")), verlaufDir(siteDir));
  sm.appendMessage({ role: "user", content: text } as never);
  sm.appendMessage({ role: "assistant", content: "erledigt" } as never);
}

function alter(pfad: string, msAlt: number): void {
  const t = (Date.now() - msAlt) / 1000;
  utimesSync(pfad, t, t);
}

describe("die Liste der Verläufe", () => {
  test("leer, solange es keine gibt — und ohne Verzeichnis kein Fehler", async () => {
    const d = mkdtempSync(join(tmpdir(), "verlauf-leer-"));
    dirs.push(d);
    expect(await listeVerlaeufe(d)).toEqual([]);
  });

  test("Titel, Zeit und Nachrichtenzahl kommen aus der echten Sitzung", async () => {
    const site = frischeSite();
    legeVerlaufAn(site, "Lege eine Seite über Wärmepumpen an.");
    const liste = await listeVerlaeufe(site);
    expect(liste.length).toBe(1);
    expect(liste[0]!.titel).toBe("Lege eine Seite über Wärmepumpen an.");
    expect(liste[0]!.nachrichten).toBeGreaterThanOrEqual(2);
    expect(liste[0]!.geaendert).toBeGreaterThan(0);
  });

  test("jüngster zuerst", async () => {
    const site = frischeSite();
    legeVerlaufAn(site, "der ältere");
    legeVerlaufAn(site, "der neuere");
    const liste = await listeVerlaeufe(site);
    expect(liste.length).toBe(2);
    expect(liste[0]!.geaendert).toBeGreaterThanOrEqual(liste[1]!.geaendert);
  });

  test("ein langer erster Satz wird gekürzt, nicht roh übernommen", async () => {
    const site = frischeSite();
    legeVerlaufAn(site, "A".repeat(300));
    const liste = await listeVerlaeufe(site);
    expect(liste[0]!.titel.length).toBeLessThanOrEqual(80);
    expect(liste[0]!.titel.endsWith("…")).toBe(true);
  });
});

describe("die 24-Stunden-Regel", () => {
  test("ein frischer Verlauf wird fortgesetzt", async () => {
    const site = frischeSite();
    legeVerlaufAn(site, "frisch");
    expect(await waehleFortsetzung(site)).not.toBeNull();
  });

  test("ein alter wird NICHT fortgesetzt — es beginnt ein neuer", async () => {
    const site = frischeSite();
    legeVerlaufAn(site, "gestern");
    const jetzt = Date.now() + NEUER_VERLAUF_NACH_MS + 1000;
    expect(await waehleFortsetzung(site, jetzt)).toBeNull();
  });

  test("Gegenprobe: knapp INNERHALB der Frist wird fortgesetzt", () => {
    // Ohne diesen Fall wäre der Test darüber auch dann grün, wenn NIE
    // fortgesetzt würde — und das Gedächtnis wäre still verloren.
    const site = frischeSite();
    legeVerlaufAn(site, "gerade eben");
    const jetzt = Date.now() + NEUER_VERLAUF_NACH_MS - 60_000;
    return waehleFortsetzung(site, jetzt).then((w) => expect(w).not.toBeNull());
  });

  test("der ALTE bleibt erhalten, er wird nur nicht automatisch aufgenommen", async () => {
    // Genau das ist der Unterschied zwischen „neuer Chat" und „Verlauf weg".
    const site = frischeSite();
    legeVerlaufAn(site, "gestern");
    const jetzt = Date.now() + NEUER_VERLAUF_NACH_MS + 1000;
    expect(await waehleFortsetzung(site, jetzt)).toBeNull();
    expect((await listeVerlaeufe(site)).length).toBe(1);
  });
});

describe("die Aufbewahrung von 30 Tagen", () => {
  test("was jünger ist, bleibt", () => {
    const site = frischeSite();
    legeVerlaufAn(site, "neulich");
    expect(raeumeAlteVerlaeufe(site)).toBe(0);
    expect(readdirSync(verlaufDir(site)).length).toBe(1);
  });

  test("was älter ist, geht", () => {
    const site = frischeSite();
    legeVerlaufAn(site, "uralt");
    const datei = join(verlaufDir(site), readdirSync(verlaufDir(site))[0]!);
    alter(datei, AUFBEWAHRUNG_MS + 60_000);
    expect(raeumeAlteVerlaeufe(site)).toBe(1);
    expect(readdirSync(verlaufDir(site)).length).toBe(0);
  });

  test("gerechnet ab LETZTER Änderung, nicht ab Anlage", () => {
    // Ein Gespräch, das seit Wochen läuft, darf nicht verschwinden, nur weil es
    // vor langer Zeit begonnen hat.
    const site = frischeSite();
    legeVerlaufAn(site, "lange gepflegt");
    const datei = join(verlaufDir(site), readdirSync(verlaufDir(site))[0]!);
    alter(datei, 1000); // gerade eben angefasst
    expect(raeumeAlteVerlaeufe(site, Date.now() + AUFBEWAHRUNG_MS - 60_000)).toBe(0);
  });

  test("eine kaputte Datei wird trotzdem aufgeräumt", () => {
    // Über die mtime und nicht über `listAll`: Sonst bliebe genau der Müll
    // liegen, den man am ehesten loswerden will.
    const site = frischeSite();
    const kaputt = join(verlaufDir(site), "2020-01-01T00-00-00-000Z_kaputt.jsonl");
    writeFileSync(kaputt, "{kein json\n");
    alter(kaputt, AUFBEWAHRUNG_MS + 60_000);
    expect(raeumeAlteVerlaeufe(site)).toBe(1);
  });

  test("fremde Dateien im Verzeichnis bleibt es fern", () => {
    const site = frischeSite();
    const fremd = join(verlaufDir(site), "notizen.txt");
    writeFileSync(fremd, "x");
    alter(fremd, AUFBEWAHRUNG_MS + 60_000);
    expect(raeumeAlteVerlaeufe(site)).toBe(0);
    expect(existsSync(fremd)).toBe(true);
  });
});

describe("der Weg in die Arbeitskopie und zurück", () => {
  function frischeKopie(): string {
    const d = mkdtempSync(join(tmpdir(), "verlauf-kopie-"));
    dirs.push(d);
    return d;
  }

  test("ohne Fortsetzung entsteht nur das Verzeichnis", () => {
    const kopie = frischeKopie();
    expect(bereiteSitzungVor(kopie, null)).toBeNull();
    expect(existsSync(sitzungDirInKopie(kopie))).toBe(true);
  });

  test("mit Fortsetzung liegt die Datei in der Arbeitskopie", async () => {
    const site = frischeSite();
    legeVerlaufAn(site, "weitermachen");
    const kopie = frischeKopie();
    const ziel = bereiteSitzungVor(kopie, (await listeVerlaeufe(site))[0]!);
    expect(ziel).not.toBeNull();
    expect(existsSync(ziel!)).toBe(true);
    expect(ziel!.startsWith(sitzungDirInKopie(kopie))).toBe(true);
  });

  test("das Verzeichnis trägt ein Punkt-Präfix — sonst würde es übernommen", () => {
    // `arbeitskopie.ts` überspringt Punkt-Einträge beim Übernahme-Scan. Ohne
    // das Präfix landete der Gesprächsverlauf auf der Website.
    expect(sitzungDirInKopie("/x").split("/").pop()!.startsWith(".")).toBe(true);
  });

  test("nach dem Lauf ist der Verlauf im Kundenordner", () => {
    const site = frischeSite();
    const kopie = frischeKopie();
    mkdirSync(sitzungDirInKopie(kopie), { recursive: true });
    writeFileSync(join(sitzungDirInKopie(kopie), "2026-01-01T00-00-00-000Z_abc.jsonl"), '{"x":1}\n');
    const erg = uebernimmSitzung(kopie, site);
    expect(erg.kopiert).toBe(1);
    expect(readdirSync(verlaufDir(site))).toContain("2026-01-01T00-00-00-000Z_abc.jsonl");
  });

  test("eine zu große Datei wird gemeldet, nicht stillschweigend abgeschnitten", () => {
    const site = frischeSite();
    const kopie = frischeKopie();
    mkdirSync(sitzungDirInKopie(kopie), { recursive: true });
    const gross = join(sitzungDirInKopie(kopie), "2026-01-01T00-00-00-000Z_gross.jsonl");
    writeFileSync(gross, "x".repeat(MAX_VERLAUF_BYTES + 1));
    const erg = uebernimmSitzung(kopie, site);
    expect(erg.kopiert).toBe(0);
    expect(erg.uebersprungen.length).toBe(1);
    expect(readdirSync(verlaufDir(site)).length).toBe(0);
  });

  test("nur .jsonl wird zurückgeholt", () => {
    // Die Arbeitskopie gehört während des Laufs dem Agenten. Was er sonst in
    // das Verzeichnis legt, hat im Kundenordner nichts zu suchen.
    const site = frischeSite();
    const kopie = frischeKopie();
    mkdirSync(sitzungDirInKopie(kopie), { recursive: true });
    writeFileSync(join(sitzungDirInKopie(kopie), "heimlich.sh"), "rm -rf /");
    expect(uebernimmSitzung(kopie, site).kopiert).toBe(0);
    expect(existsSync(join(verlaufDir(site), "heimlich.sh"))).toBe(false);
  });

  test("ein Lauf ohne Sitzungsverzeichnis ist kein Fehler", () => {
    // Ein Lauf, der vor der ersten Modellantwort scheitert, hinterlässt nichts
    // — pi schreibt die Datei erst mit der Antwort.
    const site = frischeSite();
    expect(uebernimmSitzung(frischeKopie(), site).kopiert).toBe(0);
  });

  test("Runde: anlegen, zurückholen, wieder auflisten", async () => {
    // Der Weg, den ein echter Lauf nimmt — ohne ihn beweisen die Einzelteile
    // nicht, dass sie zusammenpassen.
    const site = frischeSite();
    const kopie = frischeKopie();
    mkdirSync(sitzungDirInKopie(kopie), { recursive: true });
    const sm = SessionManager.create(kopie, sitzungDirInKopie(kopie));
    sm.appendMessage({ role: "user", content: "Wärmepumpen-Seite" } as never);
    sm.appendMessage({ role: "assistant", content: "fertig" } as never);
    expect(uebernimmSitzung(kopie, site).kopiert).toBe(1);
    const liste = await listeVerlaeufe(site);
    expect(liste.length).toBe(1);
    expect(liste[0]!.titel).toBe("Wärmepumpen-Seite");
  });
});
