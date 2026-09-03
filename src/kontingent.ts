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
 * 1.000.000 Token je Website und Monat. **Vorläufiger Wert.**
 *
 * Die Grenze soll einen entgleisten Lauf abschneiden, nicht den Normalgebrauch
 * einrahmen. Gemessen an echten Läufen:
 *
 *   kleiner Auftrag (Text ändern, Abschnitt ergänzen)   16.000 – 24.000
 *   „neue Unterseite" auf der Beispielseite                     8.403
 *   dieselbe Aufgabe auf einer echten Fabrik-Seite             205.120
 *
 * **Die Spannweite hängt an der Seitengröße, nicht an der Aufgabe.** Der Agent
 * liest die Seite, die er ändert; eine gebaute Kundenseite mit Inline-Styles und
 * Design-Tokens ist ein Vielfaches der Beispielseite. Deshalb war die frühere
 * Grenze von 200.000 die falsche Zahl: Sie hätte einem echten Kunden **einen**
 * Auftrag im Monat erlaubt, und der wäre knapp durchgegangen.
 *
 * Die Kosten bleiben unkritisch: Bei `z-ai/glm-5.3-flash` (0,075 / 0,250 $ je
 * Million) sind eine Million Token grob 8 bis 25 Cent je Website und Monat.
 *
 * Die endgültige Festlegung kommt, wenn mehr Läufe gemessen sind — wer sie
 * ändert, sollte die Zahlen oben mit aktualisieren, damit die nächste Änderung
 * eine Grundlage hat statt eines Bauchgefühls.
 */
export const TOKEN_KONTINGENT = 1_000_000;

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

/**
 * Verbrauch, der nicht auf die Platte kam — je Website, nur im Arbeitsspeicher.
 *
 * Ohne diesen Rückfall wäre der Kostendeckel bei einem Schreibfehler **weg**:
 * Es wird nichts geschrieben, die alte Datei bleibt stehen, die nächste Prüfung
 * liest den alten niedrigeren Stand, und der nächste Lauf startet. Bei einer
 * dauerhaft vollen Platte liefe das endlos — und dieser Zähler ist der einzige
 * Kostenschutz, den es gibt.
 *
 * Bewusst NICHT „Schreibfehler heißt gesperrt": Ein vorübergehender Fehler
 * sperrte den Kunden sonst für den Rest des Monats aus, obwohl er nichts
 * verbraucht hat — derselbe Schaden von der anderen Seite. Der Speicher deckelt
 * die Kosten für die Lebensdauer des Prozesses **und** lässt den Kunden
 * handlungsfähig; sobald wieder geschrieben werden kann, übernimmt die Datei.
 */
const nichtVerbucht = new Map<string, { monat: string; tokens: number; laeufe: number }>();

/** Der gemerkte Rückstand dieser Website, sofern er zum laufenden Monat gehört. */
function rueckstand(siteDir: string): { tokens: number; laeufe: number } {
  const eintrag = nichtVerbucht.get(siteDir);
  if (eintrag === undefined) return { tokens: 0, laeufe: 0 };
  if (eintrag.monat !== dieserMonat()) {
    // Monatswechsel setzt auch den Speicher zurück, sonst hinge ein alter
    // Rückstand dem Kunden bis zum Neustart des Prozesses nach.
    nichtVerbucht.delete(siteDir);
    return { tokens: 0, laeufe: 0 };
  }
  return { tokens: eintrag.tokens, laeufe: eintrag.laeufe };
}

/** Nur für Tests: verwirft alle gemerkten Rückstände. */
export function leereRueckstaende(): void {
  nichtVerbucht.clear();
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
  const gelesen = befund.art === "ok" ? befund.stand : { tokens: 0, laeufe: 0 };
  // Was nicht auf die Platte kam, zählt trotzdem — sonst wäre ein Schreibfehler
  // ein frisches Kontingent.
  const offen = rueckstand(siteDir);
  const tokens = gelesen.tokens + offen.tokens;
  const laeufe = gelesen.laeufe + offen.laeufe;
  // Ein Lauf reißt die Grenze mitten drin; die Anzeige in der Seitenleiste darf
  // danach trotzdem keine negative Zahl zeigen.
  const frei = Math.max(0, TOKEN_KONTINGENT - tokens);
  return { frei, erschoepft: frei === 0, monat, tokens, laeufe };
}

/**
 * Bucht den Verbrauch eines Laufs. **Wirft nie** — sie läuft im `finally` eines
 * Laufs, und ein Wurf dort verdeckte den eigentlichen Fehler.
 *
 * Der Aufrufer bucht auch dann, wenn der Lauf abgebrochen ist: Verbrauchte
 * Token sind verbraucht, gleich ob am Ende etwas übernommen wurde.
 */
export function verbucheTokens(siteDir: string, anzahl: number): void {
  // Ein NaN im Zähler machte jede spätere Prüfung unbrauchbar: `NaN < x` ist
  // immer falsch, das Kontingent wäre unbegrenzt.
  const zusatz = Number.isFinite(anzahl) && anzahl > 0 ? Math.floor(anzahl) : 0;
  // Vor dem Lesen holen: `rueckstand` verwirft dabei einen Eintrag aus einem
  // alten Monat, und genau diese Bereinigung soll auch hier gelten.
  const offen = rueckstand(siteDir);

  try {
    const befund = lies(siteDir);
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
      // Ein früher misslungener Verbrauch wird jetzt mitgeschrieben — deshalb
      // darf der Speicher danach geleert werden, ohne dass etwas verlorengeht.
      tokens: stand.tokens + offen.tokens + zusatz,
      // Auch ein Lauf ohne Verbrauch wird gezählt — sonst ist Missbrauch später
      // nicht sichtbar.
      laeufe: stand.laeufe + offen.laeufe + 1,
    };
    writeFileSync(kontingentPfad(siteDir), JSON.stringify(payload, null, 2), { mode: 0o600 });
    nichtVerbucht.delete(siteDir);
  } catch (fehler) {
    // Kein Schreibrecht, Ordner weg, Platte voll: Der Lauf ist gelaufen und hat
    // gekostet. Den Lauf mitzureißen wäre schlimmer — den Verbrauch zu
    // vergessen aber auch, denn dann fiele der Kostendeckel aus.
    nichtVerbucht.set(siteDir, {
      monat: dieserMonat(),
      tokens: offen.tokens + zusatz,
      laeufe: offen.laeufe + 1,
    });
    // Betreiberstörung, keine Kundenstörung: laut ins Log, mit dem Pfad.
    console.error(
      `[regoro] Kontingent von ${siteDir} ließ sich nicht schreiben (${
        fehler instanceof Error ? fehler.message : fehler
      }). Der Verbrauch wird nur im Arbeitsspeicher mitgeführt — nach einem Neustart des Dienstes ist er verloren. Bitte Schreibrechte und freien Platz prüfen.`,
    );
  }
}
