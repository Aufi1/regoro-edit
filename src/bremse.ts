/**
 * Bremse für den Codeversand — zwei Zähler in gleitenden Zeitfenstern.
 *
 * Sie schützt vor **Kosten**, nicht vor Raten. Das Raten begrenzt der Code
 * selbst (`codes.ts`: fünf Versuche, fünf Minuten). Hier geht es darum, dass
 * niemand mit einem kurzen Skript hunderte SMS auslöst und damit eine Rechnung
 * erzeugt. Deshalb greift sie **bevor** eine Nachricht rausgeht.
 *
 * Auch dieser Zähler lebt nur im Arbeitsspeicher. Ein Neustart setzt ihn zurück;
 * das ist hinnehmbar, weil ein Angreifer den Neustart nicht auslösen kann.
 */

/** Je Kennung: drei Codes pro Stunde. Wer öfter braucht, hat ein anderes Problem. */
export const MAX_PRO_KENNUNG = 3;
/**
 * Je Website: sechzig pro Stunde. Dieser Deckel ist eine **Flut-Sperre**, kein
 * Kostendeckel — Kosten entstehen nur für hinterlegte Kennungen, und die sind
 * schon durch MAX_PRO_KENNUNG begrenzt (bei zwei hinterlegten Kontaktwegen also
 * höchstens sechs Nachrichten je Stunde, unabhängig von diesem Wert).
 *
 * Er trifft ALLE Nutzer der Website, nicht nur den Störenfried. Das ist der
 * Preis dafür, dass er überhaupt wirkt: Die Herkunft einer Anfrage ist hinter
 * einem Proxy fälschbar, eine Zählung pro Absender also wirkungslos. Und er
 * MUSS unabhängig davon greifen, ob eine Kennung hinterlegt ist — sonst wäre
 * die Bremse selbst ein Orakel darüber, wer Kunde ist.
 *
 * Damit bleibt eine Rest-Möglichkeit: Wer sechzig Anfragen absetzt, sperrt die
 * Anmeldung dieser Website für eine Stunde. Dagegen hilft kein Wert, den man
 * hier einträgt — Flut-Abwehr gehört vor den Prozess, in den Reverse-Proxy
 * (siehe README). Der Wert ist so gewählt, dass echter Betrieb ihn nie erreicht
 * und ein Angriff mehr als eine Handvoll Anfragen kostet.
 */
export const MAX_PRO_SITE = 60;
/** Gleitendes Fenster von einer Stunde. Damit ist auch die längste Sperre eine Stunde. */
export const FENSTER_MS = 60 * 60 * 1000;

export type Bremsbefund =
  | { erlaubt: true }
  | { erlaubt: false; wartenMs: number; grund: "kennung" | "site" };

const proKennung = new Map<string, number[]>();
const proSite = new Map<string, number[]>();

function aktuelle(speicher: Map<string, number[]>, k: string, jetzt: number): number[] {
  const alle = speicher.get(k) ?? [];
  const frisch = alle.filter((t) => jetzt - t < FENSTER_MS);
  if (frisch.length === 0) speicher.delete(k);
  else speicher.set(k, frisch);
  return frisch;
}

/**
 * Fragt die Bremse UND verbucht den Versand in einem Zug.
 *
 * Bewusst nicht getrennt: Ein „erst fragen, dann senden, dann verbuchen" hätte
 * einen Pfad, auf dem das Verbuchen ausbleibt (Fehler beim Senden) — und genau
 * den würde ein Angreifer suchen, um beliebig oft kostenlos auszulösen. Ein
 * gescheiterter Versand zählt deshalb mit.
 */
export function pruefeBremse(
  siteDir: string,
  kennung: string,
  jetzt: number = Date.now(),
): Bremsbefund {
  const kSchluessel = `${siteDir} ${kennung}`;
  const kListe = aktuelle(proKennung, kSchluessel, jetzt);
  if (kListe.length >= MAX_PRO_KENNUNG) {
    return { erlaubt: false, wartenMs: kListe[0]! + FENSTER_MS - jetzt, grund: "kennung" };
  }
  const sListe = aktuelle(proSite, siteDir, jetzt);
  if (sListe.length >= MAX_PRO_SITE) {
    return { erlaubt: false, wartenMs: sListe[0]! + FENSTER_MS - jetzt, grund: "site" };
  }

  proKennung.set(kSchluessel, [...kListe, jetzt]);
  proSite.set(siteDir, [...sListe, jetzt]);
  return { erlaubt: true };
}

/** Wartezeit als Text für die Anmeldeseite: „4 Minuten", „1 Stunde". */
export function wartezeitText(wartenMs: number): string {
  const minuten = Math.max(1, Math.ceil(wartenMs / 60_000));
  if (minuten < 60) return `${minuten} Minute${minuten === 1 ? "" : "n"}`;
  const stunden = Math.ceil(minuten / 60);
  return `${stunden} Stunde${stunden === 1 ? "" : "n"}`;
}

/** Nur für Tests: setzt beide Zähler zurück. */
export function vergisseBremse(): void {
  proKennung.clear();
  proSite.clear();
}
