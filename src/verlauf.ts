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
): Promise<VerlaufInfo | null> {
  const alle = await listeVerlaeufe(siteDir);
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
 * Über die Datei-mtime und nicht über `listAll`: Das Aufräumen soll auch dann
 * greifen, wenn eine Datei so beschädigt ist, dass pi sie nicht mehr einlesen
 * kann — sonst bliebe genau der Müll liegen, den man am ehesten loswerden will.
 */
export function raeumeAlteVerlaeufe(siteDir: string, jetzt: number = Date.now()): number {
  const dir = verlaufDir(siteDir);
  let eintraege;
  try {
    eintraege = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let weg = 0;
  for (const e of eintraege) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const pfad = join(dir, e.name);
    try {
      if (jetzt - statSync(pfad).mtimeMs <= AUFBEWAHRUNG_MS) continue;
      rmSync(pfad, { force: true });
      weg++;
    } catch {
      // Nicht löschbar heißt nicht abbrechen — der nächste Lauf versucht es wieder.
    }
  }
  return weg;
}
