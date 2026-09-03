/**
 * Der harte Kostendeckel je Website — `<siteDir>/.regoro/kontingent.json`.
 *
 * `pi` kennt **kein** eingebautes `maxTurns` und keinen Kostendeckel. Ohne
 * diesen Zähler ist ein Lauf unbegrenzt: Ein Agent, der sich verrennt, kostet so
 * lange Geld, bis jemand hinsieht.
 *
 * Gezählt wird **pro Website**, nicht pro Sitzung — damit greift der Deckel
 * später für einen zweiten Eingangskanal (WhatsApp) von selbst mit.
 *
 * Fail-closed: Eine unlesbare oder unsinnige Abrechnung heißt „erschöpft", nie
 * „noch nichts verbraucht". Wer hier auf das volle Kontingent zurückfällt, macht
 * eine beschädigte Datei zum Freifahrtschein.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AUTH_DIR_NAME } from "./auth.ts";

/**
 * 200.000 Token je Website und Monat.
 *
 * Bewusst niedrig: Bei einem günstigen Modell sind das rund 17 Cent im Monat.
 * Die Grenze soll einen entgleisten Lauf abschneiden, nicht den Normalgebrauch
 * einrahmen — und lieber einmal zu früh greifen als eine Rechnung erzeugen, die
 * niemand erwartet hat.
 */
export const TOKEN_KONTINGENT = 200_000;

export type Kontingent = {
  frei: number;
  erschoepft: boolean;
  monat: string;
  tokens: number;
  laeufe: number;
};

const KONTINGENT_DATEI = "kontingent.json";

export function kontingentPfad(siteDir: string): string {
  return join(siteDir, AUTH_DIR_NAME, KONTINGENT_DATEI);
}

/** Der laufende Monat als "YYYY-MM". */
function dieserMonat(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function ganzeZahlAbNull(roh: unknown): number | null {
  if (typeof roh !== "number" || !Number.isFinite(roh) || roh < 0) return null;
  return Math.floor(roh);
}

/** Der Zustand auf Platte, oder null wenn er nicht zweifelsfrei lesbar ist. */
type Stand = { tokens: number; laeufe: number };

type Befund =
  | { art: "frisch" } // keine Datei, oder ein abgelaufener Monat
  | { art: "ok"; stand: Stand }
  | { art: "kaputt" };

function lies(siteDir: string): Befund {
  let roh: string;
  try {
    roh = readFileSync(kontingentPfad(siteDir), "utf8");
  } catch (fehler) {
    // Nur „nicht da" ist ein frischer Start. Alles andere — keine Rechte, ein
    // Verzeichnis an der Stelle — ist ein Zustand, über den wir nichts wissen,
    // und Nichtwissen heißt hier gesperrt.
    const code = (fehler as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? { art: "frisch" } : { art: "kaputt" };
  }
  let daten: unknown;
  try {
    daten = JSON.parse(roh);
  } catch {
    return { art: "kaputt" };
  }
  if (typeof daten !== "object" || daten === null || Array.isArray(daten)) return { art: "kaputt" };
  const obj = daten as Record<string, unknown>;
  if (obj.v !== 1) return { art: "kaputt" };
  if (typeof obj.monat !== "string") return { art: "kaputt" };

  const tokens = ganzeZahlAbNull(obj.tokens);
  const laeufe = ganzeZahlAbNull(obj.laeufe);
  if (tokens === null || laeufe === null) return { art: "kaputt" };

  // Jeder andere Monat als der laufende zählt nicht mehr — auch einer in der
  // ZUKUNFT. Sonst neutralisierte eine verstellte Uhr oder eine von Hand
  // veränderte Datei das Kontingent auf Dauer.
  if (obj.monat !== dieserMonat()) return { art: "frisch" };
  return { art: "ok", stand: { tokens, laeufe } };
}

/**
 * Wie viel dieser Website in diesem Monat noch zusteht.
 *
 * Reine Leseoperation: legt weder die Datei noch das `.regoro`-Verzeichnis an.
 * Sie läuft bei jedem Aufruf von `GET /edit/agent/status`, also auch dann, wenn
 * nie ein Auftrag gestellt wurde.
 */
export function pruefeKontingent(siteDir: string): Kontingent {
  const befund = lies(siteDir);
  const monat = dieserMonat();
  if (befund.art === "kaputt") {
    return { frei: 0, erschoepft: true, monat, tokens: TOKEN_KONTINGENT, laeufe: 0 };
  }
  const stand = befund.art === "ok" ? befund.stand : { tokens: 0, laeufe: 0 };
  // Ein Lauf reißt die Grenze mitten drin; die Anzeige in der Seitenleiste darf
  // danach trotzdem keine negative Zahl zeigen.
  const frei = Math.max(0, TOKEN_KONTINGENT - stand.tokens);
  return { frei, erschoepft: frei === 0, monat, tokens: stand.tokens, laeufe: stand.laeufe };
}

/**
 * Bucht den Verbrauch eines Laufs. **Wirft nie** — sie läuft im `finally` eines
 * Laufs, und ein Wurf dort verdeckte den eigentlichen Fehler.
 *
 * Der Aufrufer bucht auch dann, wenn der Lauf abgebrochen ist: Verbrauchte
 * Token sind verbraucht, gleich ob am Ende etwas übernommen wurde.
 */
export function verbucheTokens(siteDir: string, anzahl: number): void {
  try {
    const befund = lies(siteDir);
    // Ein NaN im Zähler machte jede spätere Prüfung unbrauchbar: `NaN < x` ist
    // immer falsch, das Kontingent wäre unbegrenzt.
    const zusatz = Number.isFinite(anzahl) && anzahl > 0 ? Math.floor(anzahl) : 0;

    let stand: Stand;
    if (befund.art === "ok") {
      stand = befund.stand;
    } else if (befund.art === "frisch") {
      stand = { tokens: 0, laeufe: 0 };
    } else {
      // Kaputte Abrechnung: nicht auf null zurücksetzen. Sonst wäre das
      // Beschädigen der Datei der Weg zu einem frischen Kontingent. Sie bleibt
      // erschöpft, bis der Monat wechselt.
      stand = { tokens: TOKEN_KONTINGENT, laeufe: 0 };
    }

    const dir = join(siteDir, AUTH_DIR_NAME);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload = {
      v: 1,
      monat: dieserMonat(),
      tokens: stand.tokens + zusatz,
      // Auch ein Lauf ohne Verbrauch wird gezählt — sonst ist Missbrauch später
      // nicht sichtbar.
      laeufe: stand.laeufe + 1,
    };
    writeFileSync(kontingentPfad(siteDir), JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch {
    // Kein Schreibrecht, Ordner weg, Platte voll: Der Lauf ist trotzdem
    // gelaufen. Das Buchen zu verlieren ist ärgerlich, den Lauf mitzureißen
    // wäre schlimmer.
  }
}
