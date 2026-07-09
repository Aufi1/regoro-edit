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

/**
 * Zählt die Commits im Repo. 0 = kein Repo oder kein HEAD.
 *
 * Für `regoro disable --purge`: Ein Repo mit genau einem Commit enthält nur den
 * Baseline-Stand von `init` — dort ist nichts verloren, wenn es gelöscht wird.
 * Ab zwei Commits steckt Arbeit drin, die es sonst nirgends gibt (der Editor ist
 * die einzige Quelle; die Fabrik kennt diese Änderungen nicht).
 */
export function countCommits(repoRoot: string): number {
  if (!existsSync(join(repoRoot, ".git"))) return 0;
  const res = Bun.spawnSync(["git", "-C", repoRoot, "rev-list", "--count", "HEAD"]);
  if (res.exitCode !== 0) return 0; // kein HEAD (leeres Repo) oder git verweigert
  const n = Number(new TextDecoder().decode(res.stdout).trim());
  return Number.isFinite(n) ? n : 0;
}

/** Committet genau pagePath; no-op-tolerant (keine Änderung → kein Fehler). */
export function commitEdit(repoRoot: string, pagePath: string, msg: string): void {
  git(repoRoot, "add", "--", pagePath);
  const res = Bun.spawnSync([
    "git", "-C", repoRoot,
    "-c", "user.name=Regoro Editor",
    "-c", "user.email=editor@regoro.local",
    "commit", "-m", msg, "--", pagePath,
  ]);
  if (res.exitCode !== 0) {
    const stderr = new TextDecoder().decode(res.stderr);
    const stdout = new TextDecoder().decode(res.stdout);
    const combined = stdout + stderr;
    // No-op tolerieren (locale-robust: EN + DE-Varianten von Git).
    if (
      /nothing to commit|no changes added|nichts zu committen|nichts zum Commit vorgemerkt|keine Änderungen/i.test(
        combined,
      )
    ) {
      return;
    }
    throw new Error(`git commit fehlgeschlagen (${res.exitCode}): ${combined}`);
  }
}

/** Versionshistorie für pagePath, neueste zuerst. */
export function listVersions(repoRoot: string, pagePath: string): Version[] {
  const out = git(
    repoRoot,
    "log", "--follow", "--format=%H%x1f%aI%x1f%s", "--", pagePath,
  );
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

/** Stellt pagePath auf den Stand von commit zurück und committet das als neue Version. */
export function restoreVersion(repoRoot: string, commit: string, pagePath: string): void {
  // Hinweis: `git checkout --end-of-options <rev> -- <path>` ist NICHT möglich
  // (git verlangt genau eine Referenz, --end-of-options bricht den rev/path-Split).
  // Schutz gegen Argument-Injection erfolgt daher im Host: commit ist strikt gegen
  // ^[0-9a-f]{7,40}$ validiert → kann nie mit "-" beginnen / als Flag wirken.
  // Das explizite `--` trennt zusätzlich Revision von Pfad.
  git(repoRoot, "checkout", commit, "--", pagePath);
  const iso = new Date().toISOString();
  commitEdit(repoRoot, pagePath, `Wiederhergestellt: ${iso}`);
}
