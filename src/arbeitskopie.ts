/**
 * Die Arbeitskopie — der Agent schreibt nie in die ausgelieferte Website.
 *
 * Das ist Invariante 1b: Der Agent erzeugt Markup, aber er erzeugt es in einer
 * Kopie **außerhalb** des Site-Ordners. Danach vergleicht der Server Kopie und
 * Original und übernimmt nur, was `validateAgentOutput` bestanden hat.
 *
 * Zwei Eigenschaften trägt diese Datei:
 *   1. In der Kopie liegt **kein** Segment mit führendem Punkt — kein `.git`,
 *      kein `.regoro`, kein `.pi`. Sonst läge das Sitzungsgeheimnis in einem
 *      Verzeichnis, in das der Agent schreiben darf, und `pi` lüde beim nächsten
 *      Lauf ungefragt eine Extension, die der Agent selbst hinterlegt hat.
 *   2. Der Site-Ordner bleibt beim Kopieren und beim Vergleichen byteidentisch.
 */
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";

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
function* siteDateien(
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
      yield* siteDateien(wurzel, realeWurzel, kindRel, gesehen);
      continue;
    }

    if (e.isDirectory()) {
      yield* siteDateien(wurzel, realeWurzel, kindRel, gesehen);
    } else if (e.isFile()) {
      yield kindRel;
    }
    // Alles andere (Sockets, Gerätedateien) ist keine Website.
  }
}

/**
 * Legt eine Arbeitskopie der Website an und gibt ihren Pfad zurück.
 *
 * Mode 0700: Auf einem Host, der mehrere Kunden bedient, soll kein anderer
 * Benutzer den Zwischenstand eines fremden Laufs lesen.
 */
export function legeArbeitskopieAn(siteDir: string): string {
  const wurzel = runtimeWurzel();
  mkdirSync(wurzel, { recursive: true });
  const kopie = join(wurzel, `${LAUF_PRAEFIX}${randomUUID()}`);
  mkdirSync(kopie, { recursive: true, mode: 0o700 });

  const realeWurzel = realpathSync(siteDir);
  for (const rel of siteDateien(siteDir, realeWurzel)) {
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
};

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
export function ermittleAenderungen(kopie: string, siteDir: string): Aenderungen {
  const original = new Map<string, string>();
  try {
    const realeWurzel = realpathSync(siteDir);
    for (const rel of siteDateien(siteDir, realeWurzel)) {
      try {
        original.set(rel, byteHash(join(siteDir, rel)));
      } catch {
        // Unlesbar heißt „nicht vergleichbar" — die Datei taucht dann weder als
        // geändert noch als gelöscht auf und bleibt, wie sie ist.
      }
    }
  } catch {
    // Site nicht auflösbar: nichts zu vergleichen.
  }

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
  return {
    geaendert: geaendert.sort(),
    neu: neu.sort(),
    geloescht: geloescht.sort(),
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
