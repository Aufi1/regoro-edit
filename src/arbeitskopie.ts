/**
 * Drei Dinge wohnen hier, und sie hängen zusammen:
 *
 *   1. **die Arbeitskopie** — wohin der Agent schreiben darf,
 *   2. **die schwebende Änderung** — wohin sein geprüftes Ergebnis kommt,
 *   3. **`siteDateien()`** — die eine Antwort darauf, was zur Website gehört.
 *
 * Das ist Invariante 1b: Der Agent erzeugt Markup, aber er erzeugt es in einer
 * Kopie, in die sonst niemand schreibt. Danach vergleicht der Server Kopie und
 * Original und übernimmt nur, was `validateAgentOutput` bestanden hat.
 *
 * **Kopiert wird aus dem ENTWURF, nicht aus dem Site-Ordner** — der Agent
 * arbeitet auf dem Stand, den der Kunde gerade bearbeitet, nicht auf dem zuletzt
 * veröffentlichten. Die Funktionen hier nehmen deshalb einen beliebigen Ordner
 * entgegen und heißen bewusst nicht nach dem Site-Ordner; wer `siteDir` liest,
 * lese „die Wurzel, um die es gerade geht". Ausgenommen sind die
 * `schwebend*`-Funktionen: Die Ablage hängt an der WEBSITE (sie liegt unter
 * `<siteDir>/.regoro/`), damit sie Neustarts überlebt und zwei Geräte dieselbe
 * offene Änderung sehen.
 *
 * Zwei Eigenschaften trägt diese Datei durchgehend:
 *   1. In der Kopie liegt **kein** Segment mit führendem Punkt — kein `.git`,
 *      kein `.regoro`, kein `.pi`. Sonst läge das Sitzungsgeheimnis in einem
 *      Verzeichnis, in das der Agent schreiben darf, und `pi` lüde beim nächsten
 *      Lauf ungefragt eine Extension, die der Agent selbst hinterlegt hat. Weil
 *      das Entwurfs-Repo sein `.git` ebenfalls hinter einem Punkt führt, sieht
 *      der Agent auch nie ein Repo.
 *   2. Die Quelle bleibt beim Kopieren und beim Vergleichen byteidentisch.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { AUTH_DIR_NAME } from "./auth.ts";

/**
 * Wohin die Arbeitskopien kommen.
 *
 * `$RUNTIME_DIRECTORY` setzt systemd über `RuntimeDirectory=`; es liegt unter
 * `/run`, gehört dem Dienst allein und wird beim Dienstende von systemd selbst
 * geräumt. Ohne systemd bleibt das Temp-Verzeichnis.
 *
 * Bei **jedem** Aufruf neu gelesen, nicht beim Import eingefroren — sonst
 * arbeitete ein Test oder ein Betreiber gegen einen Pfad, den er längst
 * umgestellt hat.
 */
export function runtimeWurzel(): string {
  return process.env.RUNTIME_DIRECTORY || tmpdir();
}

const LAUF_PRAEFIX = "lauf-";

/**
 * Gehört dieser Symlink zur Website?
 *
 * In der Kopie darf **nie** ein Symlink entstehen: Er wäre ein Schreibweg an
 * `bwrap --bind` vorbei — der Agent schriebe durch ihn hindurch an eine Stelle,
 * die die Sandbox gerade verbietet. Ein Symlink, dessen Ziel INNERHALB der
 * Website liegt, ist dagegen ein legitimer Alias; sein Inhalt wird als normale
 * Datei kopiert.
 *
 * Zeigt er nach draußen (oder ins Leere), gehört die Datei nicht zur Website —
 * `pathInsideSite` weigerte sich ohnehin, sie auszuliefern oder zu beschreiben.
 */
function zeigtInDieSite(realeWurzel: string, pfad: string): boolean {
  try {
    const real = realpathSync(pfad);
    return real === realeWurzel || real.startsWith(realeWurzel + sep);
  } catch {
    // Hängender Symlink oder keine Rechte: im Zweifel gehört er nicht dazu.
    return false;
  }
}

/**
 * Alle Dateien, die zur Website gehören — relative Pfade mit "/", unsortiert.
 *
 * **Eine Quelle für Kopieren und Vergleichen.** Beide müssen exakt dieselbe
 * Menge sehen: Was `legeArbeitskopieAn` auslässt, muss `ermittleAenderungen`
 * ebenso auslassen, sonst meldete der Vergleich es als gelöscht — und eine
 * Löschung lässt den ganzen Lauf scheitern (Contract §13.5). Statt eine
 * Ausschlussliste zwischen beiden herumzureichen, leiten beide sie aus dem
 * IST-Zustand ab; dieselbe Haltung wie bei `erstelleSecretWache` in sites.ts.
 */
function* geheDurchSite(
  wurzel: string,
  realeWurzel: string,
  rel = "",
  gesehen: Set<string> = new Set(),
): Generator<string> {
  const hier = rel === "" ? wurzel : join(wurzel, rel);
  let eintraege;
  try {
    eintraege = readdirSync(hier, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of eintraege) {
    // Jedes Segment mit führendem Punkt bleibt draußen — auf jeder Ebene, nicht
    // nur der obersten. `assets/.versteckt/notiz.txt` ist genauso wenig Website
    // wie `.regoro/auth.json`.
    if (e.name.startsWith(".")) continue;
    const kindRel = rel === "" ? e.name : `${rel}/${e.name}`;
    const kindAbs = join(wurzel, kindRel);

    if (e.isSymbolicLink()) {
      if (!zeigtInDieSite(realeWurzel, kindAbs)) continue;
      let istOrdner: boolean;
      try {
        istOrdner = statSync(kindAbs).isDirectory();
      } catch {
        continue;
      }
      if (!istOrdner) {
        yield kindRel;
        continue;
      }
      // Ein Symlink auf ein Verzeichnis der Website ist erlaubt, kann aber im
      // Kreis zeigen — im Extremfall auf die Website selbst. Ohne dieses
      // Gedächtnis liefe der Lauf endlos und füllte die Platte.
      let real: string;
      try {
        real = realpathSync(kindAbs);
      } catch {
        continue;
      }
      if (gesehen.has(real)) continue;
      gesehen.add(real);
      yield* geheDurchSite(wurzel, realeWurzel, kindRel, gesehen);
      continue;
    }

    if (e.isDirectory()) {
      yield* geheDurchSite(wurzel, realeWurzel, kindRel, gesehen);
    } else if (e.isFile()) {
      yield kindRel;
    }
    // Alles andere (Sockets, Gerätedateien) ist keine Website.
  }
}

/**
 * Welche Dateien gehören zu einem Website-Ordner? Relative Pfade mit "/",
 * sortiert.
 *
 * **Die eine Definition, und sie muss eine bleiben.** Vier Stellen fragen
 * inzwischen danach: die Arbeitskopie des Agenten, der Vergleich am Laufende,
 * das Bestücken des Entwurfs-Repos und das Veröffentlichen. Sähe auch nur eine
 * davon eine andere Menge, wäre der Schaden sofort sichtbar — eine Datei, die
 * das Bestücken auslässt und das Veröffentlichen kennt, sieht beim ersten
 * Ausrollen wie eine Massenänderung aus, und eine, die der Vergleich kennt und
 * die Kopie auslässt, meldet sich als gelöscht und lässt den ganzen Lauf
 * scheitern.
 *
 * Sortiert, weil die Aufrufer Listen vergleichen und in Meldungen ausgeben:
 * Eine Verzeichnisreihenfolge ist dateisystemabhängig und macht aus demselben
 * Zustand zwei verschiedene Ausgaben.
 *
 * Ist der Ordner nicht auflösbar (gibt es nicht, keine Rechte), ist das
 * Ergebnis leer — dieselbe fail-soft-Haltung wie im Generator darunter.
 */
export function siteDateien(dir: string): string[] {
  let realeWurzel: string;
  try {
    realeWurzel = realpathSync(dir);
  } catch {
    return [];
  }
  return [...geheDurchSite(dir, realeWurzel)].sort();
}

/**
 * Legt eine Arbeitskopie der Website an und gibt ihren Pfad zurück.
 *
 * Mode 0700: Auf einem Host, der mehrere Kunden bedient, soll kein anderer
 * Benutzer den Zwischenstand eines fremden Laufs lesen.
 */
/**
 * Der Ausgangsstand, gegen den am Ende verglichen wird.
 *
 * WARUM DAS NICHT AM ENDE NEU GELESEN WERDEN DARF: `ermittleAenderungen` verglich
 * die Arbeitskopie ursprünglich mit dem JETZIGEN Stand der Website. Speichert
 * der Kunde während eines Laufs eine Seite, die der Agent nie angefasst hat,
 * sieht dieser Vergleich einen Unterschied — und schreibt die frische Änderung
 * mit dem alten Stand aus der Kopie zu. Reiner Verlust der Kundenarbeit, ohne
 * Meldung, an einer Datei, mit der der Auftrag nichts zu tun hatte.
 *
 * Mit dem festgehaltenen Ausgangsstand lassen sich die beiden Fragen trennen,
 * die vorher zu einer verschmolzen waren: „hat der AGENT das geändert?"
 * (Kopie ≠ Ausgang) und „hat jemand ANDERES das geändert?" (live ≠ Ausgang).
 */
export function legeArbeitskopieAn(siteDir: string): string {
  const wurzel = runtimeWurzel();
  mkdirSync(wurzel, { recursive: true });
  const kopie = join(wurzel, `${LAUF_PRAEFIX}${randomUUID()}`);
  mkdirSync(kopie, { recursive: true, mode: 0o700 });

  const realeWurzel = realpathSync(siteDir);
  for (const rel of geheDurchSite(siteDir, realeWurzel)) {
    const ziel = join(kopie, rel);
    mkdirSync(dirname(ziel), { recursive: true });
    // copyFileSync folgt Symlinks und schreibt eine echte Datei — in der Kopie
    // entsteht dadurch nie einer.
    copyFileSync(join(siteDir, rel), ziel);
  }
  return kopie;
}

export type Aenderungen = {
  geaendert: string[];
  neu: string[];
  geloescht: string[];
  /**
   * Dateien, die sich WÄHREND des Laufs auf der Website geändert haben — von
   * fremder Hand, nicht vom Agenten. Leer im Normalfall.
   */
  fremdGeaendert: string[];
};

/** Der Zustand der Website beim Anlegen der Kopie: relativer Pfad → Byte-Hash. */
export type Ausgangsstand = Map<string, string>;

/**
 * Alle Einträge der Arbeitskopie — Symlinks ausdrücklich MITGEMELDET.
 *
 * Auf der Site-Seite gilt die Regel aus §13.6 (nach innen zeigende Symlinks
 * dereferenzieren, nach außen zeigende auslassen), denn dort ist der Bestand
 * des Kunden zu deuten. Auf der Kopie-Seite gilt das Gegenteil: Dort hat jeder
 * Symlink nur eine mögliche Herkunft — den Agenten —, und er gehört gemeldet,
 * damit `agent.ts` ihn sieht und den Lauf daran scheitern lässt.
 */
function* kopieDateien(
  kopie: string,
  rel = "",
): Generator<{ rel: string; istSymlink: boolean }> {
  const hier = rel === "" ? kopie : join(kopie, rel);
  let eintraege;
  try {
    eintraege = readdirSync(hier, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of eintraege) {
    if (e.name.startsWith(".")) continue;
    const kindRel = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isSymbolicLink()) yield { rel: kindRel, istSymlink: true };
    else if (e.isDirectory()) yield* kopieDateien(kopie, kindRel);
    else if (e.isFile()) yield { rel: kindRel, istSymlink: false };
  }
}

/**
 * Byte-Hash einer Datei.
 *
 * Bewusst **nicht** `fileSha256` aus apply.ts: die nimmt einen String und hasht
 * utf8. Eine `.webp` oder `.woff2` würde dabei zu einer Folge von U+FFFD, und
 * zwei verschiedene Bilder bekämen denselben Hash — ein getauschtes Bild fiele
 * nicht auf. `fileSha256` zu ändern ist keine Option: sie trägt an rund 57
 * Stellen das Optimistic Locking, eine andere Ausgabe bräche laufende
 * Editor-Sitzungen mit 409.
 */
/**
 * Byte-Hash einer Datei — exportiert, weil `agent.ts` unmittelbar vor dem
 * Schreiben noch einmal prüfen muss, ob die Datei sich seit dem Vergleich
 * geändert hat. Diesselbe Funktion, damit beide Seiten nie verschiedene Hashes
 * über dieselbe Datei bilden.
 */
export function byteHashDatei(pfad: string): string {
  return byteHash(pfad);
}

function byteHash(pfad: string): string {
  return createHash("sha256").update(readFileSync(pfad)).digest("hex");
}

/**
 * Was der Lauf in der Kopie angestellt hat, verglichen mit dem Original.
 *
 * Reine Vergleichsfunktion ohne Sicherheitssemantik (Contract §13.15) — der
 * Riegel gegen untergeschobene Pfade sitzt beim Übernehmen in `agent.ts`, dort
 * wo der Schaden entstünde.
 *
 * Verglichen wird über den Inhalt, nicht über die Änderungszeit: Sonst entstünde
 * bei jedem Lauf ein Commit über die ganze Website.
 */
/** Liest den Ist-Zustand der Website als Pfad→Hash. */
export function leseStand(siteDir: string): Ausgangsstand {
  const stand: Ausgangsstand = new Map();
  try {
    const realeWurzel = realpathSync(siteDir);
    for (const rel of geheDurchSite(siteDir, realeWurzel)) {
      try {
        stand.set(rel, byteHash(join(siteDir, rel)));
      } catch {
        // Unlesbar heißt „nicht vergleichbar" — die Datei taucht dann weder als
        // geändert noch als gelöscht auf und bleibt, wie sie ist.
      }
    }
  } catch {
    // Site nicht auflösbar: nichts zu vergleichen.
  }
  return stand;
}

/**
 * Was der Agent geändert hat — und was sich unterdessen von fremder Hand
 * geändert hat.
 *
 * `ausgang` ist der beim Anlegen der Kopie festgehaltene Stand. Fehlt er, wird
 * der Ist-Zustand genommen; dann gilt wieder das alte Verhalten, und fremde
 * Änderungen sind nicht erkennbar. Der Parameter ist deshalb an der einzigen
 * produktiven Aufrufstelle Pflicht — optional ist er nur für ältere Tests.
 */
export function ermittleAenderungen(
  kopie: string,
  siteDir: string,
  ausgang?: Ausgangsstand,
): Aenderungen {
  const original = ausgang ?? leseStand(siteDir);
  const jetzt = leseStand(siteDir);

  const geaendert: string[] = [];
  const neu: string[] = [];
  const gesehen = new Set<string>();

  for (const { rel, istSymlink } of kopieDateien(kopie)) {
    gesehen.add(rel);
    if (istSymlink) {
      // Beim Anlegen der Kopie entsteht NIE ein Symlink — dieser hier hat also
      // der Agent zur Laufzeit gelegt. Er wird gemeldet, nicht ausgelassen:
      // `agent.ts` prüft jede zu übernehmende Quelle per `lstat` und lässt den
      // Lauf daran scheitern (§13.15). Wer ihn hier verschwiegen hätte, nähme
      // dieser Prüfung ihren Gegenstand — der Lauf liefe durch, als wäre nichts
      // gewesen, und `kopie/kontakt.html -> /etc/passwd` fiele niemandem auf.
      //
      // Bewusst OHNE zu lesen: Der Hash würde dem Symlink folgen und genau die
      // Datei einlesen, die wir nicht anfassen wollen.
      (original.has(rel) ? geaendert : neu).push(rel);
      continue;
    }
    let hash: string;
    try {
      hash = byteHash(join(kopie, rel));
    } catch {
      continue;
    }
    const vorher = original.get(rel);
    if (vorher === undefined) neu.push(rel);
    else if (vorher !== hash) geaendert.push(rel);
  }

  const geloescht = [...original.keys()].filter((rel) => !gesehen.has(rel));

  // Fremde Änderung = die Website weicht vom Ausgangsstand ab. Betrachtet
  // werden nur Dateien, die der Agent auch anfassen will — an allen anderen
  // ändert die Übernahme ohnehin nichts.
  const betroffen = new Set([...geaendert, ...neu]);
  const fremdGeaendert = [...betroffen]
    .filter((rel) => {
      const vorher = original.get(rel);
      if (vorher === undefined) return jetzt.has(rel); // neu angelegt, existiert jetzt
      return jetzt.get(rel) !== vorher;
    })
    .sort();

  return {
    geaendert: geaendert.sort(),
    neu: neu.sort(),
    geloescht: geloescht.sort(),
    fremdGeaendert,
  };
}

/** Entfernt eine Arbeitskopie. Wirft nicht, wenn sie schon weg ist. */
export function raeumeAuf(kopie: string): void {
  try {
    rmSync(kopie, { recursive: true, force: true });
  } catch {
    // Best effort — ein misslungenes Aufräumen darf keinen Lauf mitreißen.
  }
}

/**
 * Räumt beim Serverstart liegengebliebene Arbeitskopien weg.
 *
 * Ein Serverneustart mitten im Lauf lässt eine Kopie zurück (`--die-with-parent`
 * beendet den Worker, das Verzeichnis bleibt); ohne diesen Schritt füllt sich
 * `/run` über Wochen.
 *
 * **Die Altersgrenze gilt nur im Temp-Verzeichnis.** Mit `RuntimeDirectory=`
 * gehört die Wurzel diesem Dienst allein: Was dort liegt, ist unsere eigene
 * Hinterlassenschaft, und nach einem Neustart läuft nichts davon mehr. Das
 * Temp-Verzeichnis teilen wir dagegen mit allem anderen auf dem Rechner — dort
 * könnte eine zweite regoro-Instanz gerade einen Lauf fahren, und ihr Verzeichnis
 * unter den Füßen wegzuräumen bräche einen fremden, laufenden Auftrag ab.
 */
const VERWAIST_AB_MS = 6 * 60 * 60 * 1000;

export function raeumeVerwaisteAuf(): void {
  const wurzel = runtimeWurzel();
  const eigeneWurzel = Boolean(process.env.RUNTIME_DIRECTORY);
  let eintraege;
  try {
    eintraege = readdirSync(wurzel, { withFileTypes: true });
  } catch {
    return; // Wurzel gibt es (noch) nicht — nichts zu tun.
  }
  const jetzt = Date.now();
  for (const e of eintraege) {
    // Nur unsere eigenen Verzeichnisse. Im Temp-Verzeichnis liegt alles
    // Mögliche, und in einem RuntimeDirectory eine Socket-Datei.
    if (!e.isDirectory() || !e.name.startsWith(LAUF_PRAEFIX)) continue;
    const pfad = join(wurzel, e.name);
    if (!eigeneWurzel) {
      try {
        if (jetzt - statSync(pfad).mtimeMs < VERWAIST_AB_MS) continue;
      } catch {
        continue;
      }
    }
    raeumeAuf(pfad);
  }
}

// ===========================================================================
// Die schwebende Änderung — ein fertiger Agentenlauf, der auf den Kunden wartet
//
// Sie liegt in `<siteDir>/.regoro/schwebend/` und NICHT unter `runtimeWurzel()`:
// Der Plan verlangt „in drei Tagen noch da" und „zwei Geräte sehen dieselbe
// offene Änderung". Eine tmpfs-Kopie stirbt mit dem Dienst, und ein Neustart
// mitten in der Nacht hätte die Arbeit eines Laufs verschluckt, für den der
// Kunde bezahlt hat.
//
// Gespeichert werden nur die BERÜHRTEN Dateien, nicht die ganze Website. Eine
// vollständige zweite Kopie je Kunde wäre teuer und sagte nichts aus: Was der
// Lauf nicht angefasst hat, steht unverändert im Entwurf.
//
// **Der Agent schreibt hier NICHT hinein** (Invariante 11: die Sandbox hat genau
// einen beschreibbaren Pfad, und das ist die Wegwerf-Kopie). Der Elternprozess
// trägt das geprüfte Ergebnis herüber — derselbe Weg wie beim Gesprächsverlauf.
// ===========================================================================

const SCHWEBEND_DIR_NAME = "schwebend";
/** Der Bau-Ordner, aus dem am Ende umbenannt wird. Punkt-Präfix: nie Website. */
const SCHWEBEND_BAU_NAME = ".schwebend-neu";
/**
 * Der Begleitzettel. Punkt-Präfix, damit ihn `siteDateien` von selbst übergeht —
 * sonst zählte er als berührte Datei und der Kunde bekäme beim Übernehmen eine
 * `.stand.json` in seine Website geschrieben.
 */
const STAND_DATEI = ".stand.json";

/**
 * Was der Begleitzettel festhält.
 *
 * `basis` ist der Stand des ENTWURFS in dem Moment, in dem die Änderung abgelegt
 * wurde: relativer Pfad → Byte-Hash, `null` für „gab es damals nicht" (der Agent
 * legt die Datei an). Ohne diese Aufzeichnung ließe sich beim Übernehmen nicht
 * mehr feststellen, ob der Boden unter der schwebenden Änderung inzwischen ein
 * anderer ist — und `409 fremd-geaendert` wäre eine Zusicherung, die nie
 * anschlagen kann. Dieselbe Idee wie `ersteKollision`, nur über Tage statt über
 * Millisekunden.
 */
type SchwebendStand = {
  v: 1;
  zeit: string;
  basis: Record<string, string | null>;
};

export function schwebendPfad(siteDir: string): string {
  return join(siteDir, AUTH_DIR_NAME, SCHWEBEND_DIR_NAME);
}

/**
 * Liegt eine offene KI-Änderung vor?
 *
 * Geprüft wird auf einen Eintrag OHNE führenden Punkt, nicht bloß auf das
 * Verzeichnis: Ein leerer Ordner ist keine Änderung, und ein Ordner, in dem nur
 * der Begleitzettel steht, auch nicht. Ein Lauf, der nichts geändert hat, legt
 * gar nichts erst an — bliebe hier trotzdem ein leeres Verzeichnis stehen,
 * sperrte es Speichern und Aufträge, ohne dass der Kunde etwas zum Übernehmen
 * hätte. Die oberste Ebene genügt: Zu jeder tiefer liegenden Datei gehört ein
 * Ordner-Eintrag oben.
 */
export function schwebendVorhanden(siteDir: string): boolean {
  try {
    return readdirSync(schwebendPfad(siteDir)).some((n) => !n.startsWith("."));
  } catch {
    return false;
  }
}

/**
 * Die berührten Dateien, sortiert. Abgeleitet aus dem Verzeichnis, nicht aus
 * einer mitgeführten Liste: Zwei Buchführungen über denselben Sachverhalt laufen
 * früher oder später auseinander, und dann zeigte die Seitenleiste eine Datei
 * an, die es nicht gibt (oder verschwiege eine, die übernommen wird).
 */
export function schwebendDateien(siteDir: string): string[] {
  return siteDateien(schwebendPfad(siteDir));
}

function leseStandZettel(siteDir: string): SchwebendStand | null {
  try {
    const roh = JSON.parse(readFileSync(join(schwebendPfad(siteDir), STAND_DATEI), "utf8")) as unknown;
    if (typeof roh !== "object" || roh === null) return null;
    const s = roh as Partial<SchwebendStand>;
    if (s.v !== 1 || typeof s.zeit !== "string") return null;
    return { v: 1, zeit: s.zeit, basis: typeof s.basis === "object" && s.basis !== null ? s.basis : {} };
  } catch {
    return null;
  }
}

/**
 * Seit wann die Änderung schwebt (ISO), oder null.
 *
 * Rückfall auf die mtime des Verzeichnisses, wenn der Begleitzettel fehlt oder
 * unlesbar ist: Die Zeitangabe steht in einer Anzeige („seit gestern offen"),
 * sie darf das Übernehmen nicht verhindern. Fail-soft, nicht fail-closed — hier
 * hängt keine Sicherheitsaussage dran.
 */
export function schwebendSeit(siteDir: string): string | null {
  const zettel = leseStandZettel(siteDir);
  if (zettel) return zettel.zeit;
  try {
    return statSync(schwebendPfad(siteDir)).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * Hat sich der Entwurf verändert, seit die Änderung abgelegt wurde?
 *
 * Liefert die betroffenen Pfade (sortiert) — leer heißt „der Boden liegt noch
 * so da". Ohne Begleitzettel ist die Antwort leer: Wir wissen dann nichts, und
 * aus Nichtwissen einen Konflikt zu behaupten hieße, dem Kunden seine Arbeit zu
 * verweigern, weil eine Datei fehlt, die nur wir schreiben.
 */
export function schwebendFremdGeaendert(siteDir: string, entwurfDir: string): string[] {
  const zettel = leseStandZettel(siteDir);
  if (!zettel) return [];
  const betroffen: string[] = [];
  for (const [rel, damals] of Object.entries(zettel.basis)) {
    const abs = join(entwurfDir, rel);
    let jetzt: string | null;
    try {
      jetzt = existsSync(abs) ? byteHash(abs) : null;
    } catch {
      betroffen.push(rel);
      continue;
    }
    if (jetzt !== damals) betroffen.push(rel);
  }
  return betroffen.sort();
}

/**
 * Legt die schwebende Änderung ab — erst vollständig bauen, dann umbenennen.
 *
 * Die Reihenfolge ist der Punkt: Ein Absturz mitten im Schreiben darf keine HALB
 * abgelegte Änderung hinterlassen, denn die sähe von außen aus wie eine
 * vollständige. Der Kunde übernähme dann drei von fünf Dateien — genau der
 * Zustand, gegen den `uebernehmen()` seit jeher „alles oder nichts" hält.
 * Gebaut wird deshalb in einem Punkt-Ordner daneben (den kein Walker sieht),
 * und erst der Umbenennen-Schritt macht die Änderung sichtbar.
 *
 * `basis` ist der Stand des Entwurfs zu diesem Zeitpunkt — Begründung am
 * Typ `SchwebendStand`.
 */
export function legeSchwebendAn(
  siteDir: string,
  dateien: Map<string, Buffer>,
  basis: Map<string, string | null>,
): void {
  const ziel = schwebendPfad(siteDir);
  const bau = join(siteDir, AUTH_DIR_NAME, SCHWEBEND_BAU_NAME);
  rmSync(bau, { recursive: true, force: true });
  mkdirSync(bau, { recursive: true, mode: 0o700 });

  const bauWurzel = resolve(bau);
  for (const [rel, inhalt] of dateien) {
    /**
     * TIEFENVERTEIDIGUNG, kein erwarteter Fall. Die Namen kommen aus
     * `ermittleAenderungen` und haben dort bereits `lstat` und `pathInsideSite`
     * gesehen. Sie kostet nichts und fängt den Tag, an dem jemand die Liste aus
     * einer anderen Quelle nimmt — dann schriebe `join(bau, "../../index.html")`
     * mitten in die ausgelieferte Website, und zwar an allen Prüfungen vorbei,
     * die es dafür gibt.
     *
     * Beide Hälften sind nötig: Der Punkt-Filter schlägt bei `..` und bei jedem
     * versteckten Namen zu, die Wurzelprüfung bei allem, was `join` sonst noch
     * nach draußen auflöst.
     */
    if (rel === "" || rel.split("/").some((s) => s === "" || s.startsWith("."))) {
      throw new Error(`Pfad gehört nicht zur Website: ${rel}`);
    }
    const abs = resolve(bau, rel);
    if (abs !== join(bauWurzel, rel) || !abs.startsWith(bauWurzel + sep)) {
      throw new Error(`Pfad zeigt aus der Ablage heraus: ${rel}`);
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, inhalt);
  }

  const zettel: SchwebendStand = {
    v: 1,
    zeit: new Date().toISOString(),
    /**
     * PFLICHTANGABE, kein optionaler Zusatz.
     *
     * Ein optionaler Parameter, dessen Fehlen eine Sicherheitsprüfung stilllegt,
     * erhält einen Weg, genau den Zustand herzustellen, gegen den er schützt:
     * Ohne Bezugspunkt kann `409 fremd-geaendert` nicht anschlagen, und beim
     * Übernehmen würde die parallele Handarbeit des Kunden stillschweigend
     * überschrieben. Wer die Angabe vergisst, soll am Übersetzer scheitern und
     * nicht Monate später an einer verlorenen Kundenänderung. Dieselbe
     * Entscheidung wie bei `Kontingentart`.
     */
    basis: Object.fromEntries([...basis.entries()]),
  };
  writeFileSync(join(bau, STAND_DATEI), JSON.stringify(zettel), "utf8");

  // Erst jetzt die alte Ablage räumen. Ein Absturz zwischen diesen beiden Zeilen
  // kostet die schwebende Änderung — das ist die harmlose Richtung: Der Kunde
  // sieht keine offene Änderung mehr und kann den Auftrag wiederholen. Umgekehrt
  // (erst umbenennen, dann räumen) gäbe es keinen sicheren Ablauf.
  rmSync(ziel, { recursive: true, force: true });
  renameSync(bau, ziel);
}

/** Wirft die schwebende Änderung weg. Idempotent; wirft nicht. */
export function verwirfSchwebend(siteDir: string): void {
  try {
    rmSync(schwebendPfad(siteDir), { recursive: true, force: true });
    // Ein liegengebliebener Bau-Ordner (Absturz mitten im Ablegen) gehört mit
    // weg — sonst wüchse er mit jedem misslungenen Versuch.
    rmSync(join(siteDir, AUTH_DIR_NAME, SCHWEBEND_BAU_NAME), { recursive: true, force: true });
  } catch {
    // Best effort — ein misslungenes Aufräumen darf keine Anfrage kippen.
  }
}
