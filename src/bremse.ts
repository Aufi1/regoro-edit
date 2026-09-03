/**
 * Bremse für den Codeversand — eine **wachsende Wartezeit** je Kennung und eine
 * Flut-Sperre je Website.
 *
 * Sie schützt vor **Kosten**, nicht vor Raten. Das Raten begrenzt der Code
 * selbst (`codes.ts`: fünf Versuche, fünf Minuten). Hier geht es darum, dass
 * niemand mit einem kurzen Skript hunderte SMS auslöst und damit eine Rechnung
 * erzeugt. Deshalb greift sie **bevor** eine Nachricht rausgeht.
 *
 * WARUM WACHSENDE WARTEZEIT UND KEIN FESTER DECKEL. Vorher galt „drei Codes pro
 * Stunde, dann eine Stunde zu". Das ist an einem echten Fall gescheitert: Drei
 * Anfragen sind schnell verbraucht — ein Tippfehler, ein zweites Gerät, eine
 * Mail im Spam-Ordner —, und danach steht der Kunde 54 Minuten vor einer
 * verschlossenen Tür, ohne dass er irgendetwas falsch gemacht hätte. Ein
 * Kostendeckel, der den zahlenden Kunden häufiger aussperrt als den Angreifer,
 * ist am falschen Ende scharf.
 *
 * Die Wartezeit wächst statt dessen: erst eine Minute, dann noch eine, dann
 * fünf. Wer sich vertippt, wartet eine Minute. Wer stur weitermacht, kommt auf
 * höchstens zwölf Nachrichten je Stunde statt drei — das ist der Preis, und er
 * ist bewusst bezahlt: Kosten begrenzt am Ende der Betreiber über sein
 * Guthaben beim Versanddienst, nicht diese Datei.
 *
 * Beide Zähler leben nur im Arbeitsspeicher. Ein Neustart setzt sie zurück;
 * das ist hinnehmbar, weil ein Angreifer den Neustart nicht auslösen kann.
 */

/**
 * Die Wartezeit VOR der jeweils nächsten Anfrage. Die erste Anfrage ist immer
 * frei; nach ihr gilt `STUFEN_MS[0]`, nach der zweiten `STUFEN_MS[1]` und so
 * fort. Der letzte Wert gilt danach dauerhaft — die Treppe wächst nicht ins
 * Unendliche, sonst wäre sie doch wieder eine Aussperrung, nur mit Umweg.
 */
export const STUFEN_MS = [60_000, 60_000, 300_000] as const;

/**
 * Ruhe länger als das → die Treppe fängt wieder unten an. Ohne dieses Vergessen
 * bliebe ein Kunde, der übers Jahr dreimal einen Code braucht, dauerhaft auf
 * der obersten Stufe, obwohl er nie etwas Auffälliges getan hat.
 */
export const VERGESSEN_MS = 60 * 60 * 1000;

/**
 * Je Website: sechzig pro Stunde. Dieser Deckel ist eine **Flut-Sperre**, kein
 * Kostendeckel.
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
 * (siehe README).
 */
export const MAX_PRO_SITE = 60;
/** Gleitendes Fenster der Flut-Sperre. */
export const FENSTER_MS = 60 * 60 * 1000;

export type Bremsbefund =
  | { erlaubt: true }
  | { erlaubt: false; wartenMs: number; grund: "kennung" | "site" };

type Stand = { stufe: number; zuletzt: number };

const proKennung = new Map<string, Stand>();
const proSite = new Map<string, number[]>();

function aktuelle(speicher: Map<string, number[]>, k: string, jetzt: number): number[] {
  const alle = speicher.get(k) ?? [];
  const frisch = alle.filter((t) => jetzt - t < FENSTER_MS);
  if (frisch.length === 0) speicher.delete(k);
  else speicher.set(k, frisch);
  return frisch;
}

/** Wartezeit nach der `n`-ten Anfrage. `n = 0` heißt „noch keine". */
function wartezeitNach(n: number): number {
  if (n <= 0) return 0;
  return STUFEN_MS[Math.min(n, STUFEN_MS.length) - 1]!;
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
  const alt = proKennung.get(kSchluessel);
  // Lange Ruhe wirkt wie eine erfolgreiche Anmeldung: Die Treppe fängt unten an.
  const stufe = alt && jetzt - alt.zuletzt < VERGESSEN_MS ? alt.stufe : 0;

  const warten = wartezeitNach(stufe);
  if (alt && stufe > 0 && jetzt - alt.zuletzt < warten) {
    return { erlaubt: false, wartenMs: alt.zuletzt + warten - jetzt, grund: "kennung" };
  }

  const sListe = aktuelle(proSite, siteDir, jetzt);
  if (sListe.length >= MAX_PRO_SITE) {
    return { erlaubt: false, wartenMs: sListe[0]! + FENSTER_MS - jetzt, grund: "site" };
  }

  proKennung.set(kSchluessel, { stufe: stufe + 1, zuletzt: jetzt });
  proSite.set(siteDir, [...sListe, jetzt]);
  return { erlaubt: true };
}

/**
 * Nach ERFOLGREICHER Anmeldung: Die Treppe für diese Kennung fängt wieder unten
 * an.
 *
 * Die Bremse begrenzt Kosten durch Anfragen von jemandem, der sich NICHT
 * anmelden kann. Wer gerade einen gültigen Code vorgelegt hat, hat bewiesen,
 * dass er die Nachricht bekommen hat — er ist genau der, für den die Bremse nie
 * gedacht war. Ohne diesen Schnitt zahlt der zahlende Kunde für den Schutz vor
 * dem Angreifer: Wer sich anmeldet und danach am zweiten Gerät noch einen Code
 * braucht, wartet, obwohl er sich soeben ausgewiesen hat.
 *
 * KEIN ORAKEL. Auslösen kann das nur, wer einen gültigen Code besitzt; für
 * jeden anderen ist der Aufruf unerreichbar. Und beobachten kann die Wirkung
 * nur, wer danach selbst eine Anfrage stellt — also wieder nur derselbe.
 *
 * Die Flut-Sperre der Website bleibt bewusst UNBERÜHRT: Sie zählt über alle
 * Kennungen und schützt vor einer Flut aus vielen erfundenen Adressen. Dass
 * ein einzelner Kunde sich anmeldet, sagt darüber nichts.
 */
export function entsperreKennung(siteDir: string, kennung: string): void {
  proKennung.delete(`${siteDir} ${kennung}`);
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
