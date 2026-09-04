/**
 * Veröffentlichen — Entwurf → Website (Contract C5).
 *
 * Der Site-Ordner ist seit „Eine Bearbeitung, zwei Modi" ein **reiner Abzug** des
 * Entwurfs-Arbeitsbaums. Diese Datei stellt ihn her: Was im Entwurf steht, steht
 * danach auf der Website; was im Entwurf fehlt, verschwindet dort auch. Die
 * Historie bleibt vollständig im Entwurfs-Repo — der Site-Ordner trägt keine.
 *
 * DIE EIGENTUMS-REGEL, DIE HIER GILT: Vor der Initialisierung gehört die Website
 * der Fabrik, danach dem Entwurfs-Repo. Es gibt zu jedem Zeitpunkt genau einen
 * Schreiber. Die Prüfsummen in `veroeffentlicht.json` prüfen das nach — als
 * **Notbremse, nicht als Sicherheitsnetz**: Sie fragen, statt zu überschreiben,
 * wenn jemand danebengeschrieben hat. Sie können einen zweiten Schreiber weder
 * verhindern noch seine Arbeit retten; sie sorgen nur dafür, dass wir sie nicht
 * wortlos zerstören.
 *
 * ZWEIPHASIG, MIT ABSICHT. Erst wird der ganze Vorgang geplant (fremd geprüft,
 * Schreib- und Löschliste gebaut, jeder Zielpfad geprüft), dann ausgeführt. Ein
 * Abbruch mitten im Kopieren hinterließe eine halb veröffentlichte Website —
 * einzelne Seiten neu, andere alt, Verweise zwischen ihnen ins Leere.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";

import { pathInsideSite } from "./apply.ts";
import { byteHashDatei, siteDateien } from "./arbeitskopie.ts";
import { git } from "./git.ts";

/** `<siteDir>/.regoro/veroeffentlicht.json` — nie ausgeliefert (Dotfile-Sperre). */
export function veroeffentlichtPfad(siteDir: string): string {
  return join(siteDir, ".regoro", "veroeffentlicht.json");
}

export type Abgleich = {
  geschrieben: string[];
  geloescht: string[];
  fremd: string[];
};

/** Was in `veroeffentlicht.json` steht. */
type Veroeffentlicht = {
  v: 1;
  /**
   * Der Entwurfs-Commit, der zuletzt ausgerollt wurde.
   *
   * Ohne ihn wüsste niemand, welcher Commit der veröffentlichte Stand IST — und
   * zwei Dinge hingen in der Luft: „Entwurf verwerfen" (zurück auf genau diesen
   * Stand) und die Anzeige, wie viel Unveröffentlichtes sich angesammelt hat.
   */
  commit: string;
  /** relativer Pfad → sha256 der Bytes, wie WIR sie geschrieben haben */
  stand: Record<string, string>;
  zeit: string;
};

/**
 * Jemand hat neben dem Entwurfs-Repo in den Site-Ordner geschrieben.
 *
 * Trägt die betroffenen Pfade, damit `host.ts` daraus
 * `409 {"fehler":"fremd-geschrieben","dateien":[…]}` bauen kann, ohne die
 * Meldung zu zerlegen.
 */
export class FremdgeschriebenFehler extends Error {
  constructor(public readonly dateien: string[]) {
    super(
      `Im Site-Ordner wurde neben dem Entwurfs-Repo geschrieben: ${dateien.join(", ")}`,
    );
    this.name = "FremdgeschriebenFehler";
  }
}

/**
 * Ein Zielpfad lässt sich nicht sicher beschreiben (zeigt aus der Website heraus).
 *
 * Getrennt von `FremdgeschriebenFehler`, weil es etwas anderes bedeutet: nicht
 * „jemand hat danebengeschrieben", sondern „so wie dieser Ordner aufgebaut ist,
 * können wir nicht veröffentlichen, ohne die Website zu verlassen".
 */
export class ZielPfadFehler extends Error {
  constructor(public readonly dateien: string[]) {
    super(
      `Zielpfade zeigen aus der Website heraus: ${dateien.join(", ")}`,
    );
    this.name = "ZielPfadFehler";
  }
}

/**
 * Enthält der relative Pfad ein Segment mit führendem Punkt?
 *
 * DIE WICHTIGSTE ZEILE DIESER DATEI. Punkt-Segmente werden nie kopiert und nie
 * gelöscht (Invariante 3). Fiele dieser Filter weg, nähme die erste
 * Veröffentlichung `.regoro/` mit — Sitzungsgeheimnis, Entwurfs-Repo und
 * schwebende Änderung —, weil im Entwurfs-Arbeitsbaum kein `.regoro` steht und
 * die Löschliste alles erfasst, was auf der Website steht und im Entwurf fehlt.
 *
 * Ein leeres Segment (`a//b`) zählt mit: Es kann aus keiner Verzeichnisliste
 * stammen und wäre ein Zeichen dafür, dass der Pfad woanders herkommt.
 */
export function hatPunktSegment(rel: string): boolean {
  return rel.split("/").some((seg) => seg === "" || seg.startsWith("."));
}

/**
 * Die Zusicherung, um die der Filter herum gebaut ist.
 *
 * Sie prüft unmittelbar vor dem Schreiben und Löschen noch einmal, was die
 * Auswahl weiter oben längst hätte aussortieren müssen — und bricht ab, statt zu
 * löschen. Bewusst redundant: Der Filter steht an mehreren Stellen, und wer eine
 * davon entfernt (oder `siteDateien` später lockert), bekommt hier einen lauten
 * Fehler statt eines stillen Datenverlusts.
 */
function sicherOhnePunkt(pfade: string[], was: string): void {
  const treffer = pfade.filter(hatPunktSegment);
  if (treffer.length > 0) {
    throw new Error(
      `Punkt-Segment beim ${was}: ${treffer.join(", ")} — ` +
        "Punkt-Segmente werden nie kopiert und nie gelöscht (Invariante 3). " +
        "Hier wurde ein Filter entfernt; der Vorgang bricht ab, bevor .regoro/ Schaden nimmt.",
    );
  }
}

/** Liest `veroeffentlicht.json`, oder null, wenn es fehlt/unlesbar/unbrauchbar ist. */
function leseVeroeffentlicht(siteDir: string): Veroeffentlicht | null {
  try {
    const roh = JSON.parse(readFileSync(veroeffentlichtPfad(siteDir), "utf8")) as unknown;
    if (!roh || typeof roh !== "object") return null;
    const o = roh as Record<string, unknown>;
    if (o.v !== 1) return null;
    if (typeof o.stand !== "object" || o.stand === null) return null;
    const stand: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.stand as Record<string, unknown>)) {
      if (typeof v === "string") stand[k] = v;
    }
    return {
      v: 1,
      commit: typeof o.commit === "string" ? o.commit : "",
      stand,
      zeit: typeof o.zeit === "string" ? o.zeit : "",
    };
  } catch {
    // Fehlt, ist kaputt, oder gehört einem anderen Benutzer: Wir wissen dann
    // nichts über den letzten Stand — siehe pruefeFremdaenderung.
    return null;
  }
}

/** Schreibt den Aufzeichnungsstand. Legt `.regoro/` an, falls nötig. */
export function schreibeStand(
  siteDir: string,
  stand: Record<string, string>,
  commit: string,
): void {
  const ziel = veroeffentlichtPfad(siteDir);
  mkdirSync(dirname(ziel), { recursive: true, mode: 0o700 });
  const inhalt: Veroeffentlicht = {
    v: 1,
    commit,
    stand,
    zeit: new Date().toISOString(),
  };
  // 0600 wie die übrigen Dateien in .regoro/. Geheim ist hier nichts, aber die
  // Datei entscheidet mit darüber, ob veröffentlicht wird — wer sie ändern kann,
  // kann die Notbremse lösen.
  writeFileSync(ziel, JSON.stringify(inhalt, null, 2) + "\n", { mode: 0o600 });
}

/** Der Entwurfs-Commit, der zuletzt ausgerollt wurde — oder null. */
export function letzterVeroeffentlichterCommit(siteDir: string): string | null {
  const v = leseVeroeffentlicht(siteDir);
  if (!v) return null;
  return /^[0-9a-f]{7,40}$/.test(v.commit) ? v.commit : null;
}

/**
 * Hat jemand neben dem Entwurfs-Repo in den Site-Ordner geschrieben?
 *
 * Zwei Arten von Befund, beide bedeuten „hier war ein zweiter Schreiber":
 *   - eine aufgezeichnete Datei hat jetzt einen anderen Inhalt
 *   - eine Datei steht auf der Website, die wir nie geschrieben haben
 *
 * NICHT dazu zählt eine aufgezeichnete Datei, die **fehlt**. Sie ist zwar
 * derselbe Regelverstoß, aber sie trägt keine fremde Arbeit: Wir schreiben sie
 * beim nächsten Veröffentlichen einfach korrekt zurück, und niemand verliert
 * etwas. Die Notbremse ist dafür da, fremde Arbeit nicht zu zerstören — nicht
 * dafür, Regelverstöße zu ahnden.
 *
 * FEHLT ODER BRICHT `veroeffentlicht.json`, ist das Ergebnis `[]`. Fail-closed
 * wäre hier falsch: Eine fehlende Aufzeichnung ist der Normalzustand vor der
 * ersten Veröffentlichung, und eine kaputte Datei würde das Veröffentlichen
 * dauerhaft blockieren — für eine Notbremse, die ausdrücklich kein
 * Sicherheitsnetz ist, ein zu hoher Preis.
 */
export function pruefeFremdaenderung(siteDir: string): string[] {
  const aufzeichnung = leseVeroeffentlicht(siteDir);
  if (!aufzeichnung) return [];

  const jetzt = siteDateien(siteDir).filter((rel) => !hatPunktSegment(rel));
  const jetztSet = new Set(jetzt);
  const fremd = new Set<string>();

  for (const [rel, hash] of Object.entries(aufzeichnung.stand)) {
    // Punkt-Segmente gelten NIE als fremd — sonst meldete `.regoro/` sich selbst
    // und blockierte jede Veröffentlichung.
    if (hatPunktSegment(rel)) continue;
    if (!jetztSet.has(rel)) continue; // fehlt: kein Verlust, siehe oben
    let ist: string;
    try {
      ist = byteHashDatei(join(siteDir, rel));
    } catch {
      continue; // unlesbar heißt „nicht vergleichbar", nicht „fremd"
    }
    if (ist !== hash) fremd.add(rel);
  }

  for (const rel of jetzt) {
    if (!(rel in aufzeichnung.stand)) fremd.add(rel);
  }

  return [...fremd].sort();
}

/**
 * Wie viel Unveröffentlichtes liegt im Entwurf?
 *
 * `seit` ist der Zeitpunkt des ÄLTESTEN unveröffentlichten Commits — die Zahl,
 * an der die Oberfläche den 3-Tage-Hinweis festmacht.
 *
 * Ohne bekannten Bezugspunkt wird der **Wurzel-Commit** genommen, also die
 * Baseline des Entwurfs-Repos. Das ist im Normalfall exakt richtig (die Baseline
 * entsteht auf dem fertig ausgerollten Stand) und im Ausnahmefall — verlorene
 * `veroeffentlicht.json` — die ehrlichere Antwort als „nichts offen": Lieber
 * einmal zu viel auf offene Änderungen hinweisen als den Kunden glauben lassen,
 * die Website sei aktuell.
 *
 * Fail-soft: Wo git nicht antwortet, ist das Ergebnis `{0, null}`. Diese Zahl
 * steht in einer Anzeige, sie darf keinen Editor lahmlegen.
 */
export function unveroeffentlichteCommits(
  entwurfDir: string,
  seitCommit: string | null,
): { anzahl: number; seit: string | null } {
  try {
    let basis = seitCommit && commitExistiert(entwurfDir, seitCommit) ? seitCommit : null;
    if (!basis) basis = wurzelCommit(entwurfDir);
    if (!basis) return { anzahl: 0, seit: null };

    const out = git(entwurfDir, "log", "--format=%aI", `${basis}..HEAD`);
    const zeilen = out.split("\n").map((z) => z.trim()).filter(Boolean);
    if (zeilen.length === 0) return { anzahl: 0, seit: null };
    // `git log` liefert neueste zuerst — der älteste steht am Ende.
    const aeltester = zeilen[zeilen.length - 1];
    return { anzahl: zeilen.length, seit: aeltester ? aufZulu(aeltester) : null };
  } catch {
    return { anzahl: 0, seit: null };
  }
}

/**
 * Git-Zeitstempel auf die Zulu-Form bringen (`…Z`), in der der Rest des Editors
 * ISO schreibt.
 *
 * `git log --format=%aI` liefert den ZONENVERSATZ des Commit-Autors
 * (`2026-09-04T14:09:19+02:00`), `schwebendSeit()` dagegen `…Z`. Beide landen im
 * selben Objekt (`GET /edit/zustand`), und die Contract-Vorlage zeigt für beide
 * die Z-Form. Für `new Date()` sind sie gleichwertig — aber genau darauf soll
 * sich niemand verlassen müssen: Zwei Felder derselben Antwort in zwei Formaten
 * laden zu einem Zeichenketten-Vergleich ein, und der ginge schief, ohne dass
 * die Zeitpunkte verschieden wären. Im Sommer verglichen ergäbe `+02:00` gegen
 * `Z` bei GLEICHEM Zeitpunkt zwei verschiedene Zeichenketten.
 *
 * Verloren geht dabei nur der Versatz, den niemand liest; der Zeitpunkt bleibt.
 */
function aufZulu(stempel: string): string | null {
  const ms = Date.parse(stempel);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function commitExistiert(repoRoot: string, commit: string): boolean {
  if (!/^[0-9a-f]{7,40}$/.test(commit)) return false;
  const res = Bun.spawnSync([
    "git", "-C", repoRoot, "cat-file", "-e", `${commit}^{commit}`,
  ]);
  return res.exitCode === 0;
}

/** Der älteste Commit (die Baseline). Null, wenn es keinen gibt. */
function wurzelCommit(repoRoot: string): string | null {
  const res = Bun.spawnSync([
    "git", "-C", repoRoot, "rev-list", "--max-parents=0", "HEAD",
  ]);
  if (res.exitCode !== 0) return null;
  const zeilen = new TextDecoder().decode(res.stdout).split("\n").map((z) => z.trim()).filter(Boolean);
  // Bei mehreren Wurzeln (zusammengeführte Historien) die älteste, also die letzte.
  return zeilen.length > 0 ? (zeilen[zeilen.length - 1] ?? null) : null;
}

/**
 * Der absolute Zielpfad für `rel` — oder null, wenn er nicht sicher beschreibbar ist.
 *
 * Muss ohne Seiteneffekte urteilen können, also **bevor** irgendein Verzeichnis
 * angelegt wurde: `pathInsideSite` löst für eine noch nicht existierende Datei
 * `realpath(Elternverzeichnis)` auf, und das schlägt fehl, solange die Kette noch
 * gar nicht da ist. Deshalb hier der Weg Segment für Segment, bis zum ersten
 * Namen, den es noch nicht gibt — ab dort kann nichts mehr ausbrechen, weil der
 * Rest neu angelegt wird und weder `..` noch Symlinks enthält.
 *
 * Symlinks, zwei Fälle, unterschiedlich behandelt:
 *   - **im Verzeichnisteil**: erlaubt, solange er in die Website zeigt. Genau so
 *     sieht `arbeitskopie.ts` es auch — ein Alias innerhalb der Website ist
 *     legitim, und `resolveSite` übergibt den Site-Ordner ohnehin aufgelöst.
 *   - **am Ende (die Datei selbst)**: erlaubt, wird beim Schreiben aber entfernt
 *     und durch eine echte Datei ersetzt. Der Site-Ordner ist ein reiner Abzug;
 *     ein Alias darin überlebt das Veröffentlichen nicht. Verloren geht dabei
 *     nichts — das Ziel des Links ist eine eigene Datei der Website und wird
 *     getrennt veröffentlicht.
 */
function zielPfad(siteDir: string, rel: string): string | null {
  if (hatPunktSegment(rel)) return null;
  let real: string;
  try {
    real = realpathSync(siteDir);
  } catch {
    return null;
  }
  const segmente = rel.split("/");
  let abs = real;
  for (let i = 0; i < segmente.length; i++) {
    const seg = segmente[i]!;
    if (seg === "." || seg === "..") return null;
    const kandidat = join(abs, seg);
    let st;
    try {
      st = lstatSync(kandidat);
    } catch {
      // Ab hier existiert nichts mehr: der Rest wird angelegt.
      return join(abs, ...segmente.slice(i));
    }
    if (st.isSymbolicLink()) {
      if (i === segmente.length - 1) return kandidat; // Blatt: wird ersetzt
      let ziel: string;
      try {
        ziel = realpathSync(kandidat);
      } catch {
        return null; // hängender Symlink im Verzeichnisteil
      }
      if (ziel !== real && !ziel.startsWith(real + sep)) return null;
      abs = ziel;
      continue;
    }
    abs = kandidat;
  }
  return abs;
}

/**
 * Rollt den Entwurfs-Arbeitsbaum in den Site-Ordner aus — Änderungen UND Löschungen.
 *
 * Wirft `FremdgeschriebenFehler`, wenn jemand danebengeschrieben hat, und
 * `ZielPfadFehler`, wenn ein Zielpfad aus der Website herausführt. Beide Male
 * ist zu diesem Zeitpunkt noch **nichts** geschrieben worden.
 */
export function veroeffentliche(siteDir: string, entwurfDir: string): Abgleich {
  // ---- Phase A: Darf überhaupt veröffentlicht werden? --------------------
  const fremd = pruefeFremdaenderung(siteDir);
  if (fremd.length > 0) throw new FremdgeschriebenFehler(fremd);

  // ---- Phase B: Planen, nichts anfassen ----------------------------------
  const quelle = siteDateien(entwurfDir).filter((rel) => !hatPunktSegment(rel));
  const ziel = siteDateien(siteDir).filter((rel) => !hatPunktSegment(rel));
  const quelleSet = new Set(quelle);

  const geschrieben: string[] = [];
  const neuerStand: Record<string, string> = {};
  for (const rel of quelle) {
    let hash: string;
    try {
      hash = byteHashDatei(join(entwurfDir, rel));
    } catch {
      continue; // unlesbare Quelle: auslassen statt den ganzen Vorgang zu kippen
    }
    neuerStand[rel] = hash;
    let gleich = false;
    try {
      gleich = byteHashDatei(join(siteDir, rel)) === hash;
    } catch {
      gleich = false; // gibt es dort noch nicht
    }
    if (!gleich) geschrieben.push(rel);
  }

  const geloescht = ziel.filter((rel) => !quelleSet.has(rel));

  // Die Zusicherung: Was jetzt folgt, fasst Dateien an. Kein Punkt-Segment darf
  // es bis hierher geschafft haben.
  sicherOhnePunkt(geschrieben, "Schreiben");
  sicherOhnePunkt(geloescht, "Löschen");

  // Jeden Zielpfad prüfen, bevor der erste geschrieben wird.
  const zielPfade = new Map<string, string>();
  const unsicher: string[] = [];
  for (const rel of [...geschrieben, ...geloescht]) {
    const abs = zielPfad(siteDir, rel);
    if (abs === null) unsicher.push(rel);
    else zielPfade.set(rel, abs);
  }
  if (unsicher.length > 0) throw new ZielPfadFehler(unsicher.sort());

  // ---- Phase C: Ausführen -------------------------------------------------
  for (const rel of geschrieben) {
    const abs = zielPfade.get(rel)!;
    mkdirSync(dirname(abs), { recursive: true });
    // Ein Blatt-Symlink wird ersetzt, nicht durchgeschrieben: Sonst schriebe der
    // Vorgang durch den Link hindurch an dessen Ziel — und `pathInsideSite` (das
    // jeden Symlink ablehnt) ließe uns ohnehin nicht.
    try {
      if (lstatSync(abs).isSymbolicLink()) rmSync(abs, { force: true });
    } catch {
      // Gibt es nicht — der Normalfall für eine neue Datei.
    }
    // Invariante 5: symlink-sicheres Schreiben, unmittelbar vor dem Write.
    if (!pathInsideSite(siteDir, abs)) {
      throw new ZielPfadFehler([rel]);
    }
    copyFileSync(join(entwurfDir, rel), abs);
  }

  for (const rel of geloescht) {
    const abs = zielPfade.get(rel)!;
    // Beim Löschen prüft die Zugehörigkeit das ELTERNVERZEICHNIS: `pathInsideSite`
    // lehnt einen Symlink grundsätzlich ab, und ein Blatt-Symlink soll hier gerade
    // entfernt werden (er zählt zur Website — `siteDateien` meldet ihn). `rmSync`
    // entfernt den Link selbst, nie sein Ziel.
    if (!pathInsideSite(siteDir, dirname(abs))) continue;
    try {
      rmSync(abs, { force: true });
    } catch {
      // Schon weg oder nicht entfernbar: kein Grund, den Rest abzubrechen.
    }
  }

  raeumeLeereOrdner(siteDir);

  // ---- Phase D: Den neuen Stand aufzeichnen ------------------------------
  let commit = "";
  try {
    commit = git(entwurfDir, "rev-parse", "HEAD").trim();
  } catch {
    // Ohne Commit-Angabe bleibt die Prüfsummen-Notbremse voll wirksam; nur der
    // Bezugspunkt für „unveröffentlicht" fällt auf den Wurzel-Commit zurück.
  }
  schreibeStand(siteDir, neuerStand, commit);

  return { geschrieben: geschrieben.sort(), geloescht: geloescht.sort(), fremd: [] };
}

/**
 * Entfernt Ordner, die durch das Löschen leer geworden sind.
 *
 * Ohne diesen Schritt bliebe von einer gelöschten Unterseite ein leerer Ordner
 * stehen. Punkt-Ordner werden dabei nie betreten — `.regoro/` ist per Definition
 * nicht Teil der Website, und ob es leer aussieht, geht das Veröffentlichen
 * nichts an.
 */
function raeumeLeereOrdner(wurzel: string): void {
  const rekursiv = (dir: string): boolean => {
    let eintraege;
    try {
      eintraege = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let leer = true;
    for (const e of eintraege) {
      if (e.name.startsWith(".")) {
        leer = false; // Punkt-Eintrag: nicht anfassen, aber der Ordner ist belegt
        continue;
      }
      if (e.isDirectory() && !e.isSymbolicLink()) {
        const kindLeer = rekursiv(join(dir, e.name));
        if (!kindLeer) leer = false;
      } else {
        leer = false;
      }
    }
    if (leer && dir !== wurzel) {
      try {
        // rmdirSync, NICHT rmSync: `rmSync` ohne `recursive` wirft auf einem
        // Verzeichnis (EISDIR) — und weil der Fehler hier gefangen wird, blieb
        // der leere Ordner wortlos stehen. Im Nachweis aufgefallen.
        // `recursive: true` wäre hier falsch: Der Ordner ist leer, oder er
        // bleibt; ein rekursives Löschen könnte einen Punkt-Eintrag mitnehmen.
        rmdirSync(dir);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };
  if (existsSync(wurzel)) rekursiv(wurzel);
}
