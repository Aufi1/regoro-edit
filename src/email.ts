/**
 * E-Mail-Adressen normalisieren und prüfen.
 *
 * Bewusst pragmatisch: Die Adresse muss zustellbar aussehen, nicht RFC-5322
 * vollständig sein. Der eigentliche Beweis ist ohnehin der Code, der ankommt.
 */

/** RFC-Grenze für die gesamte Adresse. */
const MAX_LAENGE = 254;

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const roh = raw.trim();
  if (roh === "" || roh.length > MAX_LAENGE) return null;
  if (/[\s<>",;\\]/.test(roh)) return null;

  const teile = roh.split("@");
  if (teile.length !== 2) return null;
  const [lokal, domain] = teile as [string, string];
  if (lokal.length === 0 || lokal.length > 64) return null;
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._%+-]*[a-zA-Z0-9])?$/.test(lokal)) return null;
  // Domain: mindestens zwei Label, letztes rein alphabetisch (kein "kunde@server").
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(domain)) {
    return null;
  }

  // Kleinschreiben, auch den lokalen Teil. Formal ist er zwar
  // groß-/kleinschreibungsempfindlich, praktisch behandelt ihn kein
  // ernstzunehmender Anbieter so — und wer sich mit "Max@" statt "max@"
  // anmeldet, soll nicht ausgesperrt sein.
  return roh.toLowerCase();
}

/** `max.mustermann@handwerk-mueller.de` → `m…n@handwerk-mueller.de`. */
export function maskiereEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const lokal = email.slice(0, at);
  const rest = email.slice(at);
  if (lokal.length <= 2) return `${lokal[0]}…${rest}`;
  return `${lokal[0]}…${lokal[lokal.length - 1]}${rest}`;
}
