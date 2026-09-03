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
  MAX_NACHRICHTEN_JE_SEITE,
  MAX_NACHRICHT_ZEICHEN,
  NACHRICHTEN_JE_SEITE,
  MAX_VERLAUF_BYTES,
  NEUER_VERLAUF_NACH_MS,
  bereiteSitzungVor,
  leseNachrichten,
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


// ===========================================================================
// Die ausdrückliche Wahl eines Gesprächs
// ===========================================================================
describe("welches Gespräch fortgesetzt wird", () => {
  test('"neu" setzt nichts fort, auch wenn ein frischer Verlauf dasteht', async () => {
    const site = frischeSite();
    legeVerlaufAn(site, "der frische");
    expect(await waehleFortsetzung(site, Date.now(), "neu")).toBeNull();
    // Gegenprobe: Ohne den Wunsch WÜRDE fortgesetzt. Ohne sie wäre der Test
    // auch dann grün, wenn `waehleFortsetzung` grundsätzlich null lieferte.
    expect(await waehleFortsetzung(site, Date.now(), "auto")).not.toBeNull();
  });

  test("eine gewählte Kennung wird fortgesetzt, EGAL wie alt sie ist", async () => {
    const site = frischeSite();
    legeVerlaufAn(site, "das alte Gespräch");
    const [vorhanden] = await listeVerlaeufe(site);
    const spaeter = Date.now() + NEUER_VERLAUF_NACH_MS + 1000;

    // Die 24-Stunden-Regel würde hier ein neues beginnen …
    expect(await waehleFortsetzung(site, spaeter)).toBeNull();
    // … die ausdrückliche Wahl schlägt sie.
    expect((await waehleFortsetzung(site, spaeter, vorhanden!.id))?.id).toBe(vorhanden!.id);
  });

  test("eine gewählte Kennung schlägt den JÜNGEREN Verlauf", async () => {
    // Der Fall, den ein Rückfall auf „den jüngsten" stillschweigend falsch
    // machen würde: Der Kunde liest ein altes Gespräch und schriebe in ein
    // ganz anderes.
    const site = frischeSite();
    legeVerlaufAn(site, "das alte");
    const [nurAlt] = await listeVerlaeufe(site);
    await Bun.sleep(5);
    legeVerlaufAn(site, "das junge");
    const alle = await listeVerlaeufe(site);
    expect(alle.length).toBe(2);
    expect(alle[0]!.titel).toBe("das junge");           // jüngstes zuerst

    const gewaehlt = await waehleFortsetzung(site, Date.now(), nurAlt!.id);
    expect(gewaehlt?.titel).toBe("das alte");
  });

  test("eine unbekannte Kennung beginnt neu — sie weicht NICHT aus", async () => {
    // Nach dem Aufräumen (30 Tage) oder mit einer veralteten Liste im zweiten
    // Tab ist genau das der Normalfall. Auf den jüngsten auszuweichen setzte
    // ein anderes Gespräch fort als das gewählte, ohne es zu sagen.
    const site = frischeSite();
    legeVerlaufAn(site, "der jüngste");
    expect(await waehleFortsetzung(site, Date.now(), "gibt-es-nicht")).toBeNull();
  });
});

// ===========================================================================
// Ein Gespräch zum Nachlesen
// ===========================================================================
describe("leseNachrichten", () => {
  /** Ein Gespräch mit `n` Runden — je ein Auftrag und eine Antwort. */
  function legeRundenAn(siteDir: string, n: number): void {
    const sm = SessionManager.create(mkdtempSync(join(tmpdir(), "verlauf-cwd-")), verlaufDir(siteDir));
    for (let i = 1; i <= n; i++) {
      sm.appendMessage({ role: "user", content: `Auftrag ${i}` } as never);
      sm.appendMessage({ role: "assistant", content: [{ type: "text", text: `Antwort ${i}` }] } as never);
    }
  }

  test("eine unbekannte Kennung ist null, kein Fehler", async () => {
    const site = frischeSite();
    legeVerlaufAn(site, "egal");
    expect(await leseNachrichten(site, "gibt-es-nicht")).toBeNull();
  });

  test("die Kennung wird nie zu einem Pfad", async () => {
    // Der Traversal-Versuch findet keine Datei, weil gar nicht im Dateisystem
    // gesucht wird: Gesucht wird in der Liste dieser Website.
    const site = frischeSite();
    legeVerlaufAn(site, "egal");
    for (const boese of ["../../etc/passwd", "/etc/passwd", "..", "./"]) {
      expect(await leseNachrichten(site, boese)).toBeNull();
    }
  });

  test("eine Kennung von Website A findet auf Website B nichts", async () => {
    /**
     * Aus der parallelen Arbeit am selben Feature übernommen — der Fall fehlte
     * mir. Er ist nicht dasselbe wie der Traversal-Versuch darüber: Die Kennung
     * ist hier ECHT, nur gehört sie einem anderen Kunden. Im Sammelbetrieb
     * ruht die Trennung zwischen Kunden auf genau solchen Stellen
     * (Invariante 10), und sie hält hier, weil `leseNachrichten` die Kennung
     * ausschließlich in `verlaufDir(siteDir)` sucht.
     */
    const a = frischeSite();
    const b = frischeSite();
    legeVerlaufAn(a, "gehört Kunde A");
    const vonA = (await listeVerlaeufe(a))[0]!;

    expect(await leseNachrichten(b, vonA.id)).toBeNull();
    // Gegenprobe: Bei A selbst ist dieselbe Kennung sehr wohl lesbar — sonst
    // wäre der Test auch dann grün, wenn `leseNachrichten` nie etwas fände.
    expect((await leseNachrichten(a, vonA.id))!.nachrichten.length).toBeGreaterThan(0);
  });

  test("Auftrag und Antwort kommen als Zeilen heraus, Werkzeugergebnisse nicht", async () => {
    const site = frischeSite();
    const sm = SessionManager.create(mkdtempSync(join(tmpdir(), "verlauf-cwd-")), verlaufDir(site));
    sm.appendMessage({ role: "user", content: "Leg eine Seite an." } as never);
    sm.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "erst nachdenken" },
        { type: "text", text: "Mache ich." },
        { type: "toolCall", id: "t1", name: "write_file", arguments: { path: "waerme.html" } },
      ],
    } as never);
    sm.appendMessage({
      role: "toolResult", toolCallId: "t1", toolName: "write_file",
      content: [{ type: "text", text: "GEHEIMES WERKZEUGERGEBNIS" }], isError: false,
    } as never);
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fertig." }] } as never);

    const [info] = await listeVerlaeufe(site);
    const seite = (await leseNachrichten(site, info!.id))!;
    expect(seite.nachrichten.map((n) => [n.von, n.text])).toEqual([
      ["kunde", "Leg eine Seite an."],
      ["agent", "Mache ich."],
      // Dieselben Worte wie der Live-Strom — beide über `kurzfassung`.
      ["werkzeug", "schreibt waerme.html"],
      ["agent", "Fertig."],
    ]);
    // Denkschritte und Werkzeugergebnisse sind kein Gespräch.
    expect(JSON.stringify(seite.nachrichten)).not.toContain("GEHEIMES");
    expect(JSON.stringify(seite.nachrichten)).not.toContain("nachdenken");
  });

  test("ohne Angabe kommen die JÜNGSTEN Zeilen, nicht die ältesten", async () => {
    const site = frischeSite();
    legeRundenAn(site, 30);                              // 60 Zeilen
    const [info] = await listeVerlaeufe(site);
    const seite = (await leseNachrichten(site, info!.id, { anzahl: 4 }))!;
    expect(seite.gesamt).toBe(60);
    expect(seite.ab).toBe(56);
    expect(seite.nachrichten.map((n) => n.text)).toEqual([
      "Auftrag 29", "Antwort 29", "Auftrag 30", "Antwort 30",
    ]);
  });

  test("`vor` blättert nach oben und lässt keine Zeile aus", async () => {
    const site = frischeSite();
    legeRundenAn(site, 5);                               // 10 Zeilen
    const [info] = await listeVerlaeufe(site);

    const gesehen: string[] = [];
    let vor: number | null = null;
    for (let griff = 0; griff < 10; griff++) {
      const seite = await leseNachrichten(site, info!.id, { anzahl: 3, vor });
      if (!seite) throw new Error("Verlauf verschwunden");
      gesehen.unshift(...seite.nachrichten.map((n) => n.text));
      if (seite.ab === 0) break;
      vor = seite.ab;
    }
    expect(gesehen).toEqual([
      "Auftrag 1", "Antwort 1", "Auftrag 2", "Antwort 2", "Auftrag 3",
      "Antwort 3", "Auftrag 4", "Antwort 4", "Auftrag 5", "Antwort 5",
    ]);
  });

  test("`ab === 0` heißt oben angekommen — und ist der einzige Halt", async () => {
    const site = frischeSite();
    legeRundenAn(site, 2);                               // 4 Zeilen
    const [info] = await listeVerlaeufe(site);
    const seite = (await leseNachrichten(site, info!.id, { anzahl: 50 }))!;
    expect(seite.ab).toBe(0);
    expect(seite.nachrichten.length).toBe(4);
  });

  test("Unsinnige Angaben liefern die jüngste Seite statt einer leeren", async () => {
    const site = frischeSite();
    legeRundenAn(site, 3);                               // 6 Zeilen
    const [info] = await listeVerlaeufe(site);
    for (const vor of [-5, 999, Number.NaN, Number.POSITIVE_INFINITY]) {
      const seite = (await leseNachrichten(site, info!.id, { anzahl: 2, vor }))!;
      expect(`vor=${vor} → ${seite.nachrichten.length}`).toBe(`vor=${vor} → 2`);
      expect(seite.nachrichten[1]!.text).toBe("Antwort 3");
    }
  });

  test("die Seitengröße ist gedeckelt", async () => {
    const site = frischeSite();
    legeRundenAn(site, 80);                              // 160 Zeilen
    const [info] = await listeVerlaeufe(site);
    const seite = (await leseNachrichten(site, info!.id, { anzahl: 1_000_000 }))!;
    expect(seite.nachrichten.length).toBe(MAX_NACHRICHTEN_JE_SEITE);
  });

  test("der Deckel hält auch gegen eine ZAHL, die keine ist", async () => {
    /**
     * DER TEST DARÜBER KONNTE DIESEN FALL NICHT FINDEN, und das ist der Punkt:
     * `1_000_000` ist eine gültige Zahl und läuft sauber durch `min`/`max`.
     * `?anzahl=abc` kommt dagegen als `NaN` an, rechnet sich unverändert durch
     * — und `slice(NaN, gesamt)` behandelt `NaN` wie 0.
     *
     * Gemessen, bevor es behoben war, an einem Gespräch mit 600 Zeilen: heraus
     * kamen ALLE 600 statt höchstens 100. Der Deckel war umgangen, und nichts
     * daran sah nach einem Fehler aus.
     */
    const site = frischeSite();
    legeRundenAn(site, 80);                              // 160 Zeilen
    const [info] = await listeVerlaeufe(site);
    for (const anzahl of [Number.NaN, Number("abc"), Number(undefined)]) {
      const seite = (await leseNachrichten(site, info!.id, { anzahl }))!;
      expect(`${anzahl} → ${seite.nachrichten.length}`).toBe(`${anzahl} → ${NACHRICHTEN_JE_SEITE}`);
      expect(Number.isFinite(seite.ab)).toBe(true);
    }
  });

  test("auch eine Werkzeugzeile wird gekürzt", async () => {
    // `MAX_NACHRICHT_ZEICHEN` galt zuerst nur für Kunden- und Agententext. Die
    // Werkzeugzeile entsteht aber aus Argumenten des MODELLS — eine einzige
    // halluzinierte Riesen-URL machte die Seitenleiste unbrauchbar, also genau
    // das, wogegen die Konstante gebaut ist.
    const site = frischeSite();
    const sm = SessionManager.create(mkdtempSync(join(tmpdir(), "verlauf-cwd-")), verlaufDir(site));
    sm.appendMessage({ role: "user", content: "such was" } as never);
    sm.appendMessage({
      role: "assistant",
      content: [{
        type: "toolCall", id: "t1", name: "fetch_page",
        arguments: { url: `https://beispiel.de/${"x".repeat(MAX_NACHRICHT_ZEICHEN * 2)}` },
      }],
    } as never);

    const [info] = await listeVerlaeufe(site);
    const seite = (await leseNachrichten(site, info!.id))!;
    const werkzeug = seite.nachrichten.find((n) => n.von === "werkzeug")!;
    expect(werkzeug.text.length).toBe(MAX_NACHRICHT_ZEICHEN + 1);
    expect(werkzeug.text.endsWith("…")).toBe(true);
  });

  test("eine überlange Zeile wird sichtbar gekürzt", async () => {
    const site = frischeSite();
    const sm = SessionManager.create(mkdtempSync(join(tmpdir(), "verlauf-cwd-")), verlaufDir(site));
    sm.appendMessage({ role: "user", content: "x".repeat(MAX_NACHRICHT_ZEICHEN + 500) } as never);
    sm.appendMessage({ role: "assistant", content: "ok" } as never);
    const [info] = await listeVerlaeufe(site);
    const seite = (await leseNachrichten(site, info!.id))!;
    expect(seite.nachrichten[0]!.text.length).toBe(MAX_NACHRICHT_ZEICHEN + 1);
    expect(seite.nachrichten[0]!.text.endsWith("…")).toBe(true);
  });

  test("ein gemerkter Cursor überlebt einen Lauf, der ans Ende anhängt", async () => {
    /**
     * DER ALLTAGSFALL, an dem eine falsche Blätter-Rechnung auffliegt: Der Kunde
     * liest nach oben, und dazwischen endet ein Auftrag und schreibt zwei
     * Nachrichten an das Ende desselben Gesprächs.
     *
     * Es hält, weil `ab` von VORNE zählt und Anhängen nur hinten passiert. Eine
     * Rechnung von hinten („die letzten n überspringen") wäre hier verrutscht
     * und hätte dem Kunden beim Hochscrollen zwei Zeilen doppelt gezeigt und
     * zwei verschluckt — und zwar nur manchmal, was die Suche danach teuer
     * macht. Deshalb steht der Fall hier fest.
     */
    const site = frischeSite();
    legeRundenAn(site, 10);                              // 20 Zeilen
    const [info] = await listeVerlaeufe(site);

    const erste = (await leseNachrichten(site, info!.id, { anzahl: 5 }))!;
    expect(erste.ab).toBe(15);
    expect(erste.gesamt).toBe(20);

    // Ein weiterer Lauf hängt an — genau wie `uebernimmSitzung` es zurückholt.
    const auf = SessionManager.open(info!.datei);
    auf.appendMessage({ role: "user", content: "Auftrag 11" } as never);
    auf.appendMessage({ role: "assistant", content: [{ type: "text", text: "Antwort 11" }] } as never);

    const zweite = (await leseNachrichten(site, info!.id, { anzahl: 5, vor: erste.ab }))!;
    expect(zweite.gesamt).toBe(22);                      // das Gespräch ist gewachsen
    expect(zweite.nachrichten.map((n) => n.text)).toEqual([
      "Auftrag 6", "Antwort 6", "Auftrag 7", "Antwort 7", "Auftrag 8",
    ]);
    // Der Übergang ist lückenlos: Die letzte Zeile hier und die erste von
    // vorhin liegen direkt nebeneinander.
    expect(zweite.ab + zweite.nachrichten.length).toBe(erste.ab);
  });

  test("eine unlesbare Datei ist ein leeres Gespräch, kein Absturz", async () => {
    const site = frischeSite();
    legeVerlaufAn(site, "egal");
    const [info] = await listeVerlaeufe(site);
    writeFileSync(info!.datei, "{kein JSON\nnoch weniger JSON\n");
    const seite = await leseNachrichten(site, info!.id);
    // Entweder die Liste sieht sie schon nicht mehr (null) oder sie ist leer —
    // beides ist in Ordnung, ein geworfener Fehler nicht.
    if (seite) expect(seite.nachrichten).toEqual([]);
  });
});
