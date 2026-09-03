/**
 * Gesprächsverläufe der KI-Seitenleiste — Persistenz, Auswahl, Aufräumen.
 *
 * WARUM DER ELTERNPROZESS DAS BESITZT UND NICHT DER WORKER. Die Sandbox hat
 * genau **einen** beschreibbaren Pfad: die Arbeitskopie (`sandbox.ts`, ein
 * einziges `--bind`). Ein Sitzungsverzeichnis unter `<siteDir>/.regoro/` würde
 * einen zweiten schreibbaren Pfad in den Kundenordner öffnen — direkt neben
 * `auth.json`. Das wäre eine echte Aufweichung von Invariante 11 für eine reine
 * Bequemlichkeit.
 *
 * Deshalb der Umweg: Der Elternprozess legt die fortzusetzende Sitzung **in**
 * die Arbeitskopie, der Worker liest und schreibt sie dort, und nach dem Lauf
 * holt der Elternprozess sie zurück. Die Sandbox bleibt unverändert.
 *
 * WAS PI SELBST MACHT (nachgemessen, nicht angenommen):
 *   - Format, Baum, Fortsetzen, Auto-Compaction: alles pi.
 *   - `SessionManager.listAll(dir)` liefert Titel, Datum und Nachrichtenzahl.
 *   - **`list(cwd, dir)` filtert nach `cwd` und ist für uns unbrauchbar** —
 *     unsere Arbeitskopie heißt bei jedem Lauf anders. Gemessen: `list()` mit
 *     fremdem cwd liefert 0, `listAll()` liefert alles.
 *   - **Eine Sitzung wird erst auf Platte geschrieben, wenn eine Antwort des
 *     Modells vorliegt** (`session-manager.js:_persist`, „hasAssistant"). Ein
 *     Lauf, der vorher scheitert, hinterlässt gar nichts. Das ist erwünscht —
 *     kein leerer Eintrag für einen Fehlversuch —, aber man darf sich nicht
 *     darauf verlassen, dass nach jedem Lauf eine Datei existiert.
 *
 * WAS PI NICHT MACHT: Aufbewahrungsfristen. Der einzige Löschweg im Paket ist
 * die interaktive Oberfläche. Die 30 Tage bauen wir selbst.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from "node:fs";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { kurzfassung } from "./agent-tools.ts";

/** `<siteDir>/.regoro/verlauf/` — nicht ausgeliefert (Dotfile-Sperre), gitignored. */
export function verlaufDir(siteDir: string): string {
  return join(siteDir, ".regoro", "verlauf");
}

/** Das Verzeichnis, das der Worker in der Arbeitskopie sieht. Punkt-Präfix: nie übernommen. */
export function sitzungDirInKopie(kopie: string): string {
  return join(kopie, ".pi-sitzung");
}

/**
 * Nach so langer Ruhe beginnt ein neuer Verlauf.
 *
 * Gerechnet ab der letzten Änderung, nicht ab dem Anlegen: Ein Gespräch, das
 * über den Tag verteilt geführt wird, bleibt eines.
 */
export const NEUER_VERLAUF_NACH_MS = 24 * 60 * 60 * 1000;

/** Aufbewahrung ab letzter Änderung. */
export const AUFBEWAHRUNG_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Obergrenze beim Zurückholen einer Sitzungsdatei.
 *
 * Die Datei liegt während des Laufs in der Arbeitskopie und ist damit für den
 * Agenten beschreibbar. Er kann dort nichts anrichten, was er nicht ohnehin
 * könnte — der Verlauf wird nie ausgeliefert und nie als Website übernommen —,
 * aber er könnte die Platte des Betreibers vollschreiben. Deshalb ein Deckel.
 */
export const MAX_VERLAUF_BYTES = 8 * 1024 * 1024;

export type VerlaufInfo = {
  id: string;
  datei: string;
  titel: string;
  geaendert: number;
  nachrichten: number;
};

/**
 * Alle Verläufe einer Website, jüngster zuerst.
 *
 * `listAll` und nicht `list`: siehe Kopf dieser Datei.
 */
export async function listeVerlaeufe(siteDir: string): Promise<VerlaufInfo[]> {
  const dir = verlaufDir(siteDir);
  if (!existsSync(dir)) return [];
  let roh;
  try {
    roh = await SessionManager.listAll(dir);
  } catch {
    // Ein unlesbarer oder halb geschriebener Verlauf darf die Seitenleiste
    // nicht lahmlegen — dann eben keine Liste.
    return [];
  }
  return roh
    .map((s) => ({
      id: String(s.id),
      datei: String(s.path),
      titel: titelAus(String(s.name ?? "") || String(s.firstMessage ?? "")),
      geaendert: s.modified instanceof Date ? s.modified.getTime() : 0,
      nachrichten: Number(s.messageCount ?? 0),
    }))
    .sort((a, b) => b.geaendert - a.geaendert);
}

/** Erste Zeile, auf Listenlänge gekürzt. Der Titel ist Kundentext — nie roh ins HTML. */
function titelAus(text: string): string {
  const erste = text.split("\n").find((z) => z.trim() !== "")?.trim() ?? "";
  if (erste === "") return "Ohne Titel";
  return erste.length > 80 ? `${erste.slice(0, 79)}…` : erste;
}

/**
 * Welcher Verlauf wird fortgesetzt? `null` heißt „neuer Verlauf".
 *
 * Nur der jüngste kommt in Frage, und nur wenn er frisch genug ist. Ältere
 * bleiben erhalten und lassen sich in der Liste ausdrücklich wieder aufnehmen —
 * automatisch fortgesetzt wird aber nie ein alter.
 */
export async function waehleFortsetzung(
  siteDir: string,
  jetzt: number = Date.now(),
  wunsch: string = "auto",
): Promise<VerlaufInfo | null> {
  if (wunsch === "neu") return null;          // ohne die Liste zu lesen
  return waehleAus(await listeVerlaeufe(siteDir), jetzt, wunsch);
}

/**
 * Dieselbe Wahl auf einer BEREITS GELESENEN Liste.
 *
 * Existiert, weil `listeVerlaeufe` nicht billig ist: pi liest dafür jede
 * Sitzungsdatei ganz ein (für Titel, Nachrichtenzahl und Volltext). Beim
 * Laufstart brauchen Aufräumen und Auswahl dieselbe Liste — sie zweimal zu
 * holen hieße, bei einem Kunden mit vielen Gesprächen zweimal alles zu lesen,
 * bevor der erste Ton an das Modell geht.
 */
export function waehleAus(
  alle: VerlaufInfo[],
  jetzt: number = Date.now(),
  wunsch: string = "auto",
): VerlaufInfo | null {
  if (wunsch === "neu") return null;
  if (wunsch !== "auto") {
    /**
     * Ein ausdrücklich gewähltes Gespräch wird fortgesetzt, EGAL WIE ALT es ist.
     * Die 24-Stunden-Regel beantwortet die Frage „was meint der Kunde wohl?" —
     * hat er selbst geantwortet, gibt es nichts mehr zu raten.
     *
     * Eine unbekannte Kennung beginnt ein NEUES Gespräch, statt den Auftrag
     * abzulehnen: Sie entsteht im Alltag nur durch das Aufräumen nach 30 Tagen
     * oder eine veraltete Liste im zweiten Tab. Beides ist kein Fehler des
     * Kunden, und ein 400 für einen sonst gültigen Auftrag wäre die härtere
     * Antwort. Auf den jüngsten Verlauf auszuweichen wäre dagegen falsch — das
     * setzte ein anderes Gespräch fort als das gewählte, ohne es zu sagen.
     */
    return alle.find((v) => v.id === wunsch) ?? null;
  }
  const juengster = alle[0];
  if (!juengster) return null;
  return jetzt - juengster.geaendert < NEUER_VERLAUF_NACH_MS ? juengster : null;
}

/**
 * Legt das Sitzungsverzeichnis in der Arbeitskopie an und kopiert den
 * fortzusetzenden Verlauf hinein. Liefert den Dateinamen dort, oder `null` für
 * einen neuen Verlauf.
 */
export function bereiteSitzungVor(kopie: string, fortsetzen: VerlaufInfo | null): string | null {
  const ziel = sitzungDirInKopie(kopie);
  mkdirSync(ziel, { recursive: true });
  if (!fortsetzen) return null;
  const name = fortsetzen.datei.split("/").pop();
  if (!name) return null;
  const zielDatei = join(ziel, name);
  try {
    copyFileSync(fortsetzen.datei, zielDatei);
  } catch {
    // Verlorener Verlauf ist ärgerlich, aber kein Grund, den Lauf zu verweigern.
    return null;
  }
  return zielDatei;
}

/**
 * Holt nach dem Lauf zurück, was der Worker geschrieben hat.
 *
 * Kopiert **jede** JSONL aus dem Sitzungsverzeichnis der Arbeitskopie, nicht nur
 * die erwartete: Bei einem neuen Verlauf kennt der Elternprozess den Namen
 * nicht, den pi vergeben hat. Dateien über der Grenze werden übersprungen und
 * gemeldet, nicht stillschweigend abgeschnitten.
 */
export function uebernimmSitzung(kopie: string, siteDir: string): { kopiert: number; uebersprungen: string[] } {
  const quelle = sitzungDirInKopie(kopie);
  const ziel = verlaufDir(siteDir);
  const uebersprungen: string[] = [];
  let kopiert = 0;
  let eintraege;
  try {
    eintraege = readdirSync(quelle, { withFileTypes: true });
  } catch {
    return { kopiert: 0, uebersprungen };
  }
  for (const e of eintraege) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const von = join(quelle, e.name);
    let groesse: number;
    try {
      groesse = statSync(von).size;
    } catch {
      continue;
    }
    if (groesse > MAX_VERLAUF_BYTES) {
      uebersprungen.push(e.name);
      continue;
    }
    try {
      mkdirSync(ziel, { recursive: true });
      copyFileSync(von, join(ziel, e.name));
      kopiert++;
    } catch {
      uebersprungen.push(e.name);
    }
  }
  return { kopiert, uebersprungen };
}

/**
 * Löscht Verläufe, deren letzte Änderung länger als `AUFBEWAHRUNG_MS` her ist.
 *
 * EINE UHR, UND ZWAR DIE AUS DER DATEI. Gemeint ist überall dasselbe: „wann hat
 * hier zuletzt jemand etwas gesagt". Diese Frage beantwortet `listeVerlaeufe`
 * über pi's `SessionInfo.modified` — den Zeitstempel der letzten Nachricht IM
 * GESPRÄCH (`getMessageActivityTime`, nachgesehen, nicht angenommen). Die Liste,
 * die 24-Stunden-Regel und die Aufbewahrung rechnen damit alle mit demselben
 * Wert.
 *
 * HIER STAND EINMAL DIE DATEI-MTIME, mit einem nachvollziehbaren Grund: So
 * verschwand auch eine Datei, die pi gar nicht mehr einlesen kann. Der Grund
 * trug nicht. Was er kaufte, war das Löschen von ein paar Kilobyte Müll — was
 * er riskierte, war Kundentext: Sollte pi unsere Dateien eines Tages nicht mehr
 * lesen (Formatwechsel, Bibliotheks-Bug), hätte die mtime-Regel nach 30 Tagen
 * die Gespräche ALLER Kunden gelöscht, still und unwiederbringlich, während die
 * Dateien selbst völlig in Ordnung waren. Ein Aufräumer, der bei einer Störung
 * die Daten wegwirft, statt sie liegen zu lassen, ist am falschen Ende scharf.
 *
 * Der Preis, bewusst bezahlt: Eine wirklich kaputte Datei bleibt jetzt liegen.
 * Sie kostet nichts weiter — sie wird nie ausgeliefert (Dotfile-Sperre), nie
 * gelistet (pi überspringt sie) und ist durch `MAX_VERLAUF_BYTES` gedeckelt.
 *
 * Ein Verlauf ohne brauchbares Alter wird NIE gelöscht. „Alter unbekannt" ist
 * nicht dasselbe wie „alt": Bei 0 wäre die Differenz größer als jede Frist, bei
 * `NaN` wäre der Vergleich `<=` immer falsch — beide Male verschwände ein
 * Gespräch genau dann, wenn wir am wenigsten über es wissen.
 *
 * Der Riegel ist VORSORGE und über pi heute nicht auslösbar: `SessionInfo`
 * trägt immer ein Datum (Nachricht → Header → mtime). Deshalb steht dafür auch
 * kein Test — einer müsste einen Zustand herstellen, den es nicht gibt, und
 * sähe wie Abdeckung aus, ohne welche zu sein.
 */
export async function raeumeAlteVerlaeufe(
  siteDir: string,
  jetzt: number = Date.now(),
): Promise<{ geloescht: number; uebrig: VerlaufInfo[] }> {
  const uebrig: VerlaufInfo[] = [];
  let geloescht = 0;
  for (const v of await listeVerlaeufe(siteDir)) {
    if (!Number.isFinite(v.geaendert) || v.geaendert <= 0) {
      uebrig.push(v);
      continue;
    }
    if (jetzt - v.geaendert <= AUFBEWAHRUNG_MS) {
      uebrig.push(v);
      continue;
    }
    try {
      rmSync(v.datei, { force: true });
      geloescht++;
    } catch {
      // Nicht löschbar heißt nicht abbrechen — der nächste Lauf versucht es
      // wieder. Bis dahin gehört der Verlauf weiter dazu.
      uebrig.push(v);
    }
  }
  // Die Überlebenden kommen mit heraus, damit der Aufrufer die teure Liste
  // nicht ein zweites Mal holen muss. Reihenfolge bleibt: jüngster zuerst.
  return { geloescht, uebrig };
}


// ===========================================================================
// Ein Gespräch zum Nachlesen
// ===========================================================================

/**
 * Eine Zeile im angezeigten Gespräch.
 *
 * Bewusst NICHT pi's Nachrichtenformat: Der Kunde soll lesen, was er gesagt hat
 * und was der Assistent geantwortet hat — nicht Werkzeugergebnisse, nicht
 * Denkschritte, nicht Rollen, die er nicht kennt. Was hier nicht vorkommt,
 * kommt in der Seitenleiste nicht an.
 */
export type VerlaufNachricht = {
  von: "kunde" | "agent" | "werkzeug";
  text: string;
  /** Unix-ms, 0 wenn die Sitzung keinen Zeitstempel führt. */
  zeit: number;
};

/** Wie viele Zeilen eine Seite liefert, wenn der Aufrufer nichts sagt. */
export const NACHRICHTEN_JE_SEITE = 20;

/**
 * Obergrenze je Anfrage.
 *
 * Die Seitenleiste lädt beim Hochscrollen nach; ohne Deckel könnte ein Aufrufer
 * mit `anzahl=1000000` ein ganzes Gespräch in einer Antwort verlangen und den
 * Prozess an der Serialisierung beschäftigen.
 */
export const MAX_NACHRICHTEN_JE_SEITE = 100;

/**
 * Obergrenze je Zeile.
 *
 * Aufträge sind serverseitig begrenzt und Modellantworten von Natur aus kurz —
 * das hier ist Notwehr gegen den Fall, den wir nicht vorhersehen: eine einzelne
 * Nachricht, die die Seitenleiste unbrauchbar macht. Gekürzt wird sichtbar.
 */
export const MAX_NACHRICHT_ZEICHEN = 20_000;

export type VerlaufSeite = {
  id: string;
  titel: string;
  geaendert: number;
  /** Die Zeilen dieser Seite, älteste zuerst. */
  nachrichten: VerlaufNachricht[];
  /** Index der ersten gelieferten Zeile im ganzen Gespräch. `> 0` heißt: es geht weiter nach oben. */
  ab: number;
  /** Wie viele Zeilen das Gespräch insgesamt hat. */
  gesamt: number;
};

/**
 * Ein Gespräch zum Nachlesen, seitenweise von hinten.
 *
 * `null` heißt: Diesen Verlauf gibt es (nicht mehr). Der Aufrufer kennt die
 * Kennung aus `listeVerlaeufe`, also ist das der Aufräum- oder Wettlauf-Fall,
 * kein Angriff.
 *
 * **Die Kennung wird NIE zu einem Pfad.** Gesucht wird in der Liste, die
 * `listeVerlaeufe` aus dem Verzeichnis dieser Website aufbaut; der Dateiname
 * kommt von dort. Eine Kennung aus dem Browser kann damit auf nichts zeigen,
 * was nicht ohnehin zu dieser Website gehört — es gibt keinen Weg von einer
 * erfundenen Kennung zu einer fremden Datei.
 *
 * Geblättert wird von HINTEN: Ohne Angabe kommen die jüngsten Zeilen, mit
 * `vor` alles davor. Das ist die Reihenfolge, in der ein Gespräch gelesen wird
 * — und der Grund, warum `ab` mitgeliefert wird: Es ist der Cursor für den
 * nächsten Griff nach oben.
 */
export async function leseNachrichten(
  siteDir: string,
  id: string,
  opts: { vor?: number | null; anzahl?: number | null } = {},
): Promise<VerlaufSeite | null> {
  const info = (await listeVerlaeufe(siteDir)).find((v) => v.id === id);
  if (!info) return null;

  const flach = leseFlach(info.datei);
  const gesamt = flach.length;

  /**
   * `Number.isFinite` ZUERST, sonst hält der Deckel nicht.
   *
   * Gemessen an einem Gespräch mit 600 Zeilen: `?anzahl=abc` kommt als `NaN`
   * an, rechnet sich durch `min`/`max`/`trunc` unverändert zu `NaN` durch, und
   * `slice(NaN, gesamt)` behandelt `NaN` wie 0 — heraus kamen ALLE 600 Zeilen
   * statt höchstens 100. Der Deckel war umgangen, ohne dass etwas nach einem
   * Fehler aussah.
   *
   * Der Test dazu prüfte mit `anzahl: 1_000_000` und war grün: eine gültige
   * Zahl kann diesen Weg gar nicht auslösen. Ein Nachweis, der nicht anschlagen
   * kann, beweist durch sein Ausbleiben nichts.
   */
  const anzahlRoh = opts.anzahl;
  const anzahl =
    typeof anzahlRoh === "number" && Number.isFinite(anzahlRoh)
      ? Math.min(MAX_NACHRICHTEN_JE_SEITE, Math.max(1, Math.trunc(anzahlRoh)))
      : NACHRICHTEN_JE_SEITE;
  // `vor` ist der Index, VOR dem gelesen wird — der `ab`-Wert der vorigen
  // Antwort. Alles Unsinnige (negativ, zu groß, keine Zahl) fällt auf „ganz
  // hinten" zurück, statt eine leere Seite zu liefern.
  const roh = opts.vor;
  const bis =
    typeof roh === "number" && Number.isFinite(roh) && roh >= 0 && roh <= gesamt
      ? Math.trunc(roh)
      : gesamt;
  const ab = Math.max(0, bis - anzahl);

  return {
    id: info.id,
    titel: info.titel,
    geaendert: info.geaendert,
    nachrichten: flach.slice(ab, bis),
    ab,
    gesamt,
  };
}

/**
 * Die Sitzungsdatei zu einer flachen Folge von Zeilen.
 *
 * Über `SessionManager.open`, nicht über eigenes JSONL-Lesen: pi wandert seine
 * Fassungen (v1 → v3) beim Laden um. Wer hier selbst parst, liest eine ältere
 * Sitzung entweder falsch oder gar nicht — und merkt es nie, weil frisch
 * angelegte Sitzungen immer die neueste Fassung haben.
 *
 * Gelesen wird `getEntries()` und nicht der Zweig zum Blatt: Wir verzweigen
 * nirgends, und der Kunde soll sein ganzes Gespräch sehen — auch die Teile vor
 * einer Verdichtung, die im Modellkontext längst nicht mehr stehen.
 */
function leseFlach(datei: string): VerlaufNachricht[] {
  let eintraege;
  try {
    eintraege = SessionManager.open(datei).getEntries();
  } catch {
    // Wie in `listeVerlaeufe`: ein unlesbarer Verlauf lähmt die Seitenleiste
    // nicht, er ist dann eben leer.
    return [];
  }

  const zeilen: VerlaufNachricht[] = [];
  for (const e of eintraege as unknown as RohEintrag[]) {
    const zeit = Date.parse(String(e?.timestamp ?? "")) || 0;

    /**
     * Eine Verdichtung ist für den Kunden keine Nachricht, aber ihr Fehlen wäre
     * ein Rätsel: Ohne diesen Hinweis sähe er, dass der Assistent auf etwas
     * antwortet, das nicht mehr dasteht.
     *
     * HINAUS GEHT NUR DIESER SATZ, nie die Zusammenfassung selbst. Sie ist vom
     * Modell geschrieben und führt regelmäßig Dateipfade des Servers mit —
     * pi legt sie unter `summary` ab, wir sehen sie nicht einmal an.
     */
    if (e?.type === "compaction") {
      zeilen.push({ von: "werkzeug", text: "fasst das bisherige Gespräch zusammen", zeit });
      continue;
    }
    if (e?.type !== "message") continue;

    const m = e.message;
    if (!m || typeof m !== "object") continue;

    if (m.role === "user") {
      const t = textAus(m.content);
      if (t) zeilen.push({ von: "kunde", text: kuerze(t), zeit });
      continue;
    }
    if (m.role === "assistant") {
      // Reihenfolge erhalten: Text und Werkzeugaufrufe stehen in einer
      // Nachricht nebeneinander und sollen so erscheinen, wie sie fielen.
      const bloecke = Array.isArray(m.content) ? m.content : null;
      if (!bloecke) {
        const t = textAus(m.content);
        if (t) zeilen.push({ von: "agent", text: kuerze(t), zeit });
        continue;
      }
      let text = "";
      const schiebeText = () => {
        const t = text.trim();
        if (t) zeilen.push({ von: "agent", text: kuerze(t), zeit });
        text = "";
      };
      for (const b of bloecke) {
        if (b?.type === "text" && typeof b.text === "string") text += b.text;
        else if (b?.type === "toolCall") {
          schiebeText();
          // AUCH hier `kuerze`: Die Zeile entsteht aus Argumenten des Modells
          // (`web_search`-Anfrage, `fetch_page`-URL). Ohne den Deckel macht eine
          // einzige halluzinierte Riesen-URL die Seitenleiste unbrauchbar — genau
          // wofür `MAX_NACHRICHT_ZEICHEN` da ist. Stand hier zuerst nicht.
          zeilen.push({
            von: "werkzeug",
            text: kuerze(kurzfassung(String(b.name ?? ""), b.arguments)),
            zeit,
          });
        }
        // `thinking` fällt hier heraus: Denkschritte sind kein Gespräch.
      }
      schiebeText();
      continue;
    }
    // toolResult, bashExecution, custom, branchSummary: nicht das Gespräch.
  }
  return zeilen;
}

/** Nur, was pi uns aus einer Sitzung reicht — absichtlich lose typisiert. */
type RohEintrag = {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

/** Text aus `string | Block[]`; Bilder und Unbekanntes fallen weg. */
function textAus(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const c = b as { type?: string; text?: unknown };
      return c?.type === "text" && typeof c.text === "string" ? c.text : "";
    })
    .join("")
    .trim();
}

function kuerze(t: string): string {
  return t.length > MAX_NACHRICHT_ZEICHEN ? `${t.slice(0, MAX_NACHRICHT_ZEICHEN)}…` : t;
}
