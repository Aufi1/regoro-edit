/**
 * Einmalcodes für die Anmeldung — ausschließlich im Arbeitsspeicher.
 *
 * Ein Code hat auf der Platte nichts zu suchen: Er ist Minuten gültig, und was
 * nicht geschrieben wird, kann nicht ausgelesen werden. Ein Serverneustart macht
 * offene Codes ungültig; der Kunde fordert dann einen neuen an. Das ist der
 * richtige Tausch.
 *
 * **Der Code darf nirgends ins Log** — auch nicht gekürzt, auch nicht im Fehlerfall.
 */
import { randomInt } from "node:crypto";
import { safeEqual } from "./auth.ts";

/** Fünf Minuten: lang genug für eine SMS, kurz genug, um wertlos zu altern. */
export const CODE_GUELTIG_MS = 5 * 60 * 1000;
/** Nach fünf Fehleingaben ist der Code verbraucht — die Million Möglichkeiten bleibt unerreichbar. */
export const MAX_VERSUCHE = 5;

export type Pruefergebnis = "ok" | "falsch" | "abgelaufen" | "zu-viele-versuche" | "keiner";

interface Eintrag {
  code: string;
  gueltigBis: number;
  versuche: number;
}

/** Schlüssel: Site-Ordner + Kennung. Zwei Websites teilen sich nie einen Code. */
const offen = new Map<string, Eintrag>();

function schluessel(siteDir: string, kennung: string): string {
  return `${siteDir} ${kennung}`;
}

/** Sechsstellig, führende Nullen erlaubt, aus dem Zufallsgenerator des Systems. */
export function erzeugeCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Merkt einen Code vor. Ein neuer Code für dieselbe Kennung **ersetzt** den
 * alten — sonst sammelten sich gültige Codes an, und jeder weitere wäre ein
 * zusätzlicher Rateversuch für einen Angreifer.
 */
export function merkeCode(
  siteDir: string,
  kennung: string,
  code: string,
  jetzt: number = Date.now(),
): void {
  raeumeAuf(jetzt);
  offen.set(schluessel(siteDir, kennung), {
    code,
    gueltigBis: jetzt + CODE_GUELTIG_MS,
    versuche: 0,
  });
}

/**
 * Prüft einen eingegebenen Code. Jeder Aufruf zählt einen Versuch; ein Treffer
 * verbraucht den Code ebenfalls (es ist ein EINmalcode).
 */
export function pruefeCode(
  siteDir: string,
  kennung: string,
  eingabe: string,
  jetzt: number = Date.now(),
): Pruefergebnis {
  const k = schluessel(siteDir, kennung);
  const eintrag = offen.get(k);
  if (eintrag === undefined) return "keiner";
  if (jetzt >= eintrag.gueltigBis) {
    offen.delete(k);
    return "abgelaufen";
  }
  eintrag.versuche += 1;
  if (eintrag.versuche > MAX_VERSUCHE) {
    offen.delete(k);
    return "zu-viele-versuche";
  }
  // Konstantzeit: ein `===` verriete über die Laufzeit, wie weit die Eingabe stimmt.
  if (!safeEqual(eintrag.code, eingabe)) return "falsch";
  offen.delete(k);
  return "ok";
}

/** Entfernt abgelaufene Einträge. Läuft bei jedem Merken mit, kostet nichts. */
function raeumeAuf(jetzt: number): void {
  for (const [k, e] of offen) {
    if (jetzt >= e.gueltigBis) offen.delete(k);
  }
}

/** Nur für Tests: setzt den Speicher zurück. */
export function vergisseAlleCodes(): void {
  offen.clear();
}
