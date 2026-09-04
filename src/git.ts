/**
 * Contract A — Kern: git-basierte Versionierung im Repo.
 *
 * Jede Speicherung + jeder Restore = ein Commit. Synchrone git-Aufrufe via
 * Bun.spawnSync. Kein Auto-Push (regoro.de: manuell). pagePath relativ + whitelisted.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface Version {
  commit: string;
  date: string;
  subject: string;
}

/** Führt git im repoRoot aus (mit fixer Editor-Identität). Wirft bei non-zero. */
/**
 * Quotet einen Pfad für POSIX-sh, sodass er als EIN Argument ankommt.
 *
 * Nur für Befehle gedacht, die wir dem Nutzer zum Kopieren anzeigen — regoro
 * selbst startet Prozesse ohne Shell (Bun.spawnSync mit argv-Array), dort ist
 * nichts zu quoten. Einfache Anführungszeichen schützen alles außer sich selbst;
 * ein enthaltenes ' wird als '\'' ausgeschleust.
 */
export function shellQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`;
}

export function git(repoRoot: string, ...args: string[]): string {
  const res = Bun.spawnSync([
    "git", "-C", repoRoot,
    "-c", "user.name=Regoro Editor",
    "-c", "user.email=editor@regoro.local",
    ...args,
  ]);
  if (res.exitCode !== 0) {
    const stderr = new TextDecoder().decode(res.stderr);
    // Häufigster Stolperstein: Der Site-Ordner gehört einem anderen User als dem,
    // der regoro ausführt (z.B. von einem Build-Prozess erzeugt). git verweigert
    // dann jede Arbeit im Worktree. Die Roh-Meldung erklärt das schlecht.
    if (stderr.includes("dubious ownership")) {
      // Der Pfad geht in Befehle, die der Nutzer kopiert und ausführt. Ungequotet
      // zerfiele er bei Leerzeichen in mehrere Argumente, und Metazeichen (;, $, `)
      // würden von seiner Shell interpretiert — der kopierte Befehl träfe dann einen
      // anderen Ordner oder führte Fremdes aus. Also einfach-quoten.
      const q = shellQuote(repoRoot);
      throw new Error(
        `Der Ordner ${repoRoot} gehört einem anderen Benutzer — git verweigert die Arbeit darin.\n\n` +
          "  Entweder den Ordner übereignen:\n" +
          `    sudo chown -R "$(id -un)" ${q}\n\n` +
          "  Oder git eine Ausnahme erlauben (nur bei eigenen, vertrauenswürdigen Daten):\n" +
          `    git config --global --add safe.directory ${q}\n\n` +
          "  Danach erneut ausführen.",
      );
    }
    throw new Error(`git ${args.join(" ")} fehlgeschlagen (${res.exitCode}): ${stderr}`);
  }
  return new TextDecoder().decode(res.stdout);
}

/** Idempotent: initialisiert das Repo und garantiert mindestens einen Baseline-Commit. */
export function ensureRepo(repoRoot: string): void {
  if (!existsSync(join(repoRoot, ".git"))) {
    git(repoRoot, "init");
  }
  // Gibt es bereits einen Commit (HEAD auflösbar)?
  const head = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "--verify", "HEAD"]);
  if (head.exitCode !== 0) {
    git(repoRoot, "add", "-A");
    git(repoRoot, "commit", "-m", "Baseline", "--allow-empty");
  }
}

/** git meldet ein Repo ohne jeden Commit so (Wortlaut variiert nach Version/Locale). */
const EMPTY_REPO_RE = /unknown revision|ambiguous argument|Needed a single revision|bad revision/i;

/**
 * „Es gab nichts zu committen" — locale-robust (EN + DE-Varianten von Git).
 *
 * Eine Konstante, weil zwei Stellen sie brauchen (`commitEdit` mit Pfadangabe,
 * `commitAlles` ohne). Getrennt gepflegt drifteten sie auseinander, und ein
 * no-op wäre auf einem der beiden Wege plötzlich ein Fehler.
 */
const NO_OP_COMMIT_RE =
  /nothing to commit|no changes added|nichts zu committen|nichts zum Commit vorgemerkt|keine Änderungen/i;

/**
 * Zählt die Commits im Repo.
 *   0    = kein Repo, oder ein Repo ganz ohne Commit
 *   n>0  = so viele Commits
 *   null = LÄSST SICH NICHT BESTIMMEN (git verweigert, z.B. "dubious ownership")
 *
 * Für `regoro disable --purge`: Ein Repo mit genau einem Commit enthält nur den
 * Baseline-Stand von `init` — dort ist nichts verloren, wenn es gelöscht wird.
 * Ab zwei Commits steckt Arbeit drin, die es sonst nirgends gibt (der Editor ist
 * die einzige Quelle; die Fabrik kennt diese Änderungen nicht).
 *
 * Deshalb `null` statt `0` im Fehlerfall — fail-closed. Ein pauschales `return 0`
 * hätte ein Repo voller Kundenarbeit für leer gehalten, sobald git es nicht lesen
 * kann, und `--purge` hätte es gelöscht. Aufrufer MÜSSEN null als "nicht löschen"
 * behandeln.
 */
export function countCommits(repoRoot: string): number | null {
  if (!existsSync(join(repoRoot, ".git"))) return 0;
  // --all statt HEAD: zählt jeden Commit, der von IRGENDEINER Ref erreichbar ist.
  // Sonst bliebe Arbeit auf einem anderen Branch unsichtbar und --purge löschte sie.
  // In einem Repo ganz ohne Commit liefert --all sauber "0" mit Exit 0.
  const res = Bun.spawnSync(["git", "-C", repoRoot, "rev-list", "--count", "--all"]);
  if (res.exitCode === 0) {
    const n = Number(new TextDecoder().decode(res.stdout).trim());
    return Number.isFinite(n) ? n : null;
  }
  // Repo ohne Commit ist ein legitimer Zustand (git init, nichts committet).
  const stderr = new TextDecoder().decode(res.stderr);
  if (EMPTY_REPO_RE.test(stderr)) return 0;
  return null; // alles andere: git verweigert die Auskunft
}

/**
 * Committet genau die angegebenen Pfade; no-op-tolerant (keine Änderung → kein
 * Fehler).
 *
 * Nimmt einen Pfad oder mehrere: Ein Agentenlauf ändert eine neue Unterseite,
 * die Navigation der Startseite und vielleicht eine CSS-Datei — das ist EINE
 * Änderung des Kunden und gehört in EINEN Commit. Sonst zeigte die Versionsliste
 * drei Einträge, von denen das Zurücknehmen eines einzelnen die Website in einem
 * halben Zustand zurückließe.
 */
export function commitEdit(repoRoot: string, pagePath: string | string[], msg: string): void {
  const pfade = typeof pagePath === "string" ? [pagePath] : pagePath;
  // Ohne Pfadangabe committet `git commit -m … --` den GESAMTEN Index. Aus einem
  // Randfall heraus — ein Lauf, der am Ende nichts Übernehmbares hatte — wäre
  // das ein Commit über fremde, zufällig vorgemerkte Dateien.
  if (pfade.length === 0) return;

  git(repoRoot, "add", "--", ...pfade);
  const res = Bun.spawnSync([
    "git", "-C", repoRoot,
    "-c", "user.name=Regoro Editor",
    "-c", "user.email=editor@regoro.local",
    // Das explizite `--` bleibt: ohne es würde ein Pfad wie `-f.html` als Flag
    // gelesen.
    "commit", "-m", msg, "--", ...pfade,
  ]);
  if (res.exitCode !== 0) {
    const stderr = new TextDecoder().decode(res.stderr);
    const stdout = new TextDecoder().decode(res.stdout);
    const combined = stdout + stderr;
    // No-op tolerieren (locale-robust: EN + DE-Varianten von Git).
    if (NO_OP_COMMIT_RE.test(combined)) {
      return;
    }
    throw new Error(`git commit fehlgeschlagen (${res.exitCode}): ${combined}`);
  }
}

/**
 * Committet den INDEX, wie er gerade ist — ohne Pfadangabe; no-op-tolerant.
 *
 * Das Gegenstück zu `commitEdit`: die committet einzelne Pfade aus dem
 * Arbeitsbaum, diese hier den bereits gesetzten Index. Genau das braucht
 * `restoreVersion`, denn `read-tree` schreibt sein Ergebnis in den Index, und
 * eine Pfadliste gäbe es dafür gar nicht — die Wiederherstellung besteht ja
 * auch aus Löschungen, und `git commit -- <pfad>` bräuchte jeden einzelnen
 * davon namentlich.
 *
 * Gemessen: Deckt sich Zieltree und HEAD-Tree, meldet git „nichts zu committen,
 * Arbeitsverzeichnis unverändert" mit rc=1 — das Wiederherstellen auf den Stand,
 * auf dem man schon steht, ist kein Fehler und erzeugt keine Leer-Version.
 */
function commitAlles(repoRoot: string, msg: string): void {
  const res = Bun.spawnSync([
    "git", "-C", repoRoot,
    "-c", "user.name=Regoro Editor",
    "-c", "user.email=editor@regoro.local",
    "commit", "-m", msg,
  ]);
  if (res.exitCode !== 0) {
    const combined =
      new TextDecoder().decode(res.stdout) + new TextDecoder().decode(res.stderr);
    if (NO_OP_COMMIT_RE.test(combined)) return;
    throw new Error(`git commit fehlgeschlagen (${res.exitCode}): ${combined}`);
  }
}

/**
 * Versionshistorie, neueste zuerst — für `pagePath`, oder für die GANZE Website,
 * wenn kein Pfad angegeben ist.
 *
 * Seit „Eine Bearbeitung, zwei Modi" gilt eine Version für die ganze Website:
 * `restoreVersion` stellt den ganzen Baum her, also muss die Liste, aus der man
 * auswählt, dieselbe Einheit zeigen. Die Fassung mit Pfad bleibt, weil die
 * Vorschau einer einzelnen Seite (`showVersion`) sie weiterhin braucht.
 *
 * Ohne Pfad **kein `--follow`** — das verlangt genau einen Pfad und bräche sonst
 * mit „fatal: option '--follow' requires exactly one pathspec".
 */
export function listVersions(repoRoot: string, pagePath?: string): Version[] {
  const out =
    pagePath === undefined
      ? git(repoRoot, "log", "--format=%H%x1f%aI%x1f%s")
      : git(repoRoot, "log", "--follow", "--format=%H%x1f%aI%x1f%s", "--", pagePath);
  const versions: Version[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [commit, date, subject] = line.split("\x1f");
    if (!commit) continue;
    versions.push({ commit, date: date ?? "", subject: subject ?? "" });
  }
  return versions;
}

/** Dateiinhalt @ Commit (read-only). */
export function showVersion(repoRoot: string, commit: string, pagePath: string): string {
  // --end-of-options: commit-Argument nie als Option interpretieren (Defense-in-depth;
  // der Host validiert commit bereits gegen ^[0-9a-f]{7,40}$).
  return git(repoRoot, "show", "--end-of-options", `${commit}:${pagePath}`);
}

/**
 * Stellt die GANZE Website auf den Stand von `commit` zurück und committet das
 * als neue Version.
 *
 * WARUM NICHT `checkout`. Der frühere Weg (`git checkout <commit> -- <pagePath>`)
 * stellte genau einen Pfad her und **löschte nie**: Was ein Agentenlauf angelegt
 * hatte, überlebte jede Wiederherstellung. Der naheliegende Ausbau auf den ganzen
 * Baum hilft nicht — nachgemessen an einem Wegwerf-Repo (v1: `index.html`;
 * v2: `index.html` geändert + `zusatz.js` neu):
 *
 *   git checkout <v1> -- index.html   → zusatz.js bleibt
 *   git checkout <v1> -- .            → zusatz.js bleibt
 *   git read-tree -um <v1>            → zusatz.js weg
 *
 * Nur `read-tree` gleicht den Index gegen einen Zielbaum ab und entfernt dabei,
 * was dort nicht vorkommt.
 *
 * WARUM `--reset -u` UND NICHT `-um`. Ebenfalls gemessen, und im Plan nicht
 * erwähnt: `read-tree -um` bricht bei schmutzigem Arbeitsbaum hart ab
 * („Entry 'index.html' not uptodate. Cannot merge.", rc=128). Eine einzige nicht
 * committete Datei im Entwurfs-Repo machte das Wiederherstellen damit dauerhaft
 * unmöglich — das Sicherheitsnetz wäre tot, genau wenn man es braucht.
 * `--reset -u` verwirft lokale Änderungen und tut sonst dasselbe. Das ist hier
 * richtig: „auf Version X zurück" ist eine ausdrückliche Ansage des Kunden, und
 * jeder gespeicherte Stand ist ohnehin ein Commit.
 *
 * WARUM `clean` DANEBEN. `read-tree` fasst **unversionierte** Dateien in keiner
 * Variante an (gemessen). Ohne diesen Schritt überlebte eine unversionierte Datei
 * die Wiederherstellung und würde vom Arbeitsbaum-Abzug mitveröffentlicht — also
 * genau das Loch, das dieser Umbau schließen soll, nur eine Ebene versetzt.
 *
 * `-e '.*'` IST TRAGEND, NICHT KOSMETIK. Gemessen: `git clean -fd` ohne diesen
 * Filter löscht `.regoro/` mitsamt `auth.json` — Sitzungsgeheimnis, Entwurfs-Repo
 * und schwebende Änderung in einem Zug. Der Filter hält jedes Punkt-Segment
 * heraus (auch legitime Website-Ordner wie `.well-known/`, ebenfalls gemessen).
 * Wer ihn entfernt, baut einen Datenverlust ein, den kein Aufrufer abfangen kann.
 *
 * Die Historie wächst nur nach vorn: Der wiederhergestellte Stand wird ein NEUER
 * Commit obendrauf, nichts wird umgeschrieben.
 */
export function restoreVersion(repoRoot: string, commit: string): void {
  // --end-of-options: das commit-Argument nie als Option lesen (Defense-in-depth;
  // der Host validiert commit bereits gegen ^[0-9a-f]{7,40}$). Anders als bei
  // `checkout` verträgt `read-tree` das Flag — nachgeprüft.
  git(repoRoot, "read-tree", "--reset", "-u", "--end-of-options", commit);
  git(repoRoot, "clean", "-fd", "-e", ".*");
  const iso = new Date().toISOString();
  commitAlles(repoRoot, `Wiederhergestellt: ${iso}`);
}
