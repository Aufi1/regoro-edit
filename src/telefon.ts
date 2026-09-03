/**
 * Telefonnummern normalisieren — auf E.164 (`+49171…`).
 *
 * Jeder Vergleich zweier Nummern läuft über die normalisierte Form. `0171…`,
 * `+49 171 …` und `0049171…` sind dieselbe Nummer; wer das an einer Stelle
 * vergisst, sperrt einen Kunden aus.
 */

/**
 * Ländervorwahl für Nummern in nationaler Schreibweise (`0171…`).
 *
 * Bewusst EINE benannte Konstante und keine verstreute Annahme: Ein
 * österreichischer Kunde, der `0664…` einträgt, wäre sonst ein stiller Fehler —
 * die Nummer würde als deutsche gelesen. Wer Kunden außerhalb Deutschlands
 * aufnimmt, lässt sie internationale Schreibweise eintragen (`+43664…`).
 */
export const STANDARD_LAENDERVORWAHL = "49";

/** E.164: bis zu 15 Ziffern insgesamt, davon mindestens 8 sinnvoll. */
const MIN_ZIFFERN = 8;
const MAX_ZIFFERN = 15;

/**
 * Normalisiert eine eingegebene Telefonnummer auf E.164 oder gibt null zurück.
 *
 * Erlaubt beim Eintippen Leerzeichen, `/`, `-`, `(`, `)` und einen führenden
 * `+` — das ist, was Menschen tatsächlich schreiben. Alles andere (Buchstaben,
 * ein zweites `+`, leer) wird abgelehnt.
 */
export function normalizeNummer(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const roh = raw.trim();
  if (roh === "") return null;

  // Nur Trennzeichen entfernen, die Menschen wirklich benutzen. Kein pauschales
  // "alle Nicht-Ziffern weg": sonst würde aus "0171-abc" klaglos "0171".
  const geputzt = roh.replace(/[ \t./()–—-]/g, "");
  if (!/^\+?\d+$/.test(geputzt)) return null;

  let ziffern: string;
  if (geputzt.startsWith("+")) {
    ziffern = geputzt.slice(1);
  } else if (geputzt.startsWith("00")) {
    ziffern = geputzt.slice(2);
  } else if (geputzt.startsWith("0")) {
    // Nationale Schreibweise: führende 0 gegen die Ländervorwahl tauschen.
    ziffern = STANDARD_LAENDERVORWAHL + geputzt.slice(1);
  } else {
    // Schon ohne führende Null und ohne +: als internationale Form lesen.
    ziffern = geputzt;
  }

  if (ziffern.startsWith("0")) return null; // Ländervorwahl beginnt nie mit 0
  if (ziffern.length < MIN_ZIFFERN || ziffern.length > MAX_ZIFFERN) return null;
  return `+${ziffern}`;
}

/**
 * Verkürzte Anzeige für Betreiber-Ausgaben: `+4915120464812` → `+4915…812`.
 * Genug, um eine Nummer wiederzuerkennen, zu wenig, um sie mitzuschreiben.
 */
export function maskiereNummer(nummer: string): string {
  if (nummer.length <= 8) return nummer;
  return `${nummer.slice(0, 5)}…${nummer.slice(-3)}`;
}
