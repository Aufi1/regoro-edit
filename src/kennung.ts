/**
 * Eine Kennung ist das, womit sich ein Kunde ausweist: eine Telefonnummer oder
 * eine E-Mail-Adresse. Alles hinter der Anmeldung (Codes, Bremse, Versand)
 * arbeitet mit der normalisierten Kennung und muss den Kanal nur kennen, um zu
 * wissen, wohin der Code geht.
 */
import { normalizeNummer, maskiereNummer } from "./telefon.ts";
import { normalizeEmail, maskiereEmail } from "./email.ts";

export type Kanal = "sms" | "email";

export interface Kennung {
  kanal: Kanal;
  /** Normalisiert: `+4915120464812` bzw. `max@handwerk-mueller.de`. */
  wert: string;
}

/**
 * Erkennt am Eingegebenen, welcher Kanal gemeint ist.
 *
 * Der Reiter auf der Anmeldeseite sagt es zwar schon — aber wer im Reiter
 * „Telefonnummer" seine Adresse eintippt, soll nicht auf einen Fehler laufen,
 * sondern eine Mail bekommen. Ein `@` ist in keiner Telefonnummer erlaubt, die
 * Unterscheidung ist also eindeutig.
 */
export function erkenneKanal(raw: string): Kanal {
  return raw.includes("@") ? "email" : "sms";
}

/** null = unbrauchbare Eingabe (→ dieselbe Antwort wie eine unbekannte Kennung). */
export function normalisiereKennung(raw: string | null | undefined, kanal?: Kanal): Kennung | null {
  if (typeof raw !== "string") return null;
  // Nachsicht nur in eine Richtung: Wer im Telefon-Reiter eine Adresse eintippt,
  // bekommt eine Mail (ein `@` ist eindeutig). Wer im E-Mail-Reiter Ziffern
  // eintippt, bekommt KEINE SMS — das wäre eine Überraschung statt einer Hilfe.
  const gewaehlt = kanal === "email" ? "email" : erkenneKanal(raw);
  if (gewaehlt === "email") {
    const wert = normalizeEmail(raw);
    return wert === null ? null : { kanal: "email", wert };
  }
  const wert = normalizeNummer(raw);
  return wert === null ? null : { kanal: "sms", wert };
}

/** Verkürzte Anzeige für Betreiber-Ausgaben — nie die vollständige Kennung. */
export function maskiereKennung(wert: string): string {
  return wert.includes("@") ? maskiereEmail(wert) : maskiereNummer(wert);
}
