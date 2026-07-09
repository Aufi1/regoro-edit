#!/usr/bin/env bun
/**
 * regoro — CLI-Entrypoint für den Inline-Editor.
 *
 * Befehle:
 *   regoro init [siteDir] [--password-stdin] [--force]
 *       Legt <siteDir>/.regoro/auth.json (argon2id-Hash + HMAC-Secret, Mode 0600,
 *       git-ignoriert) an und initialisiert ein git-Repo im siteDir (Versionen pro Site).
 *       Ohne siteDir: aktuelles Verzeichnis.
 *   regoro <siteDir>   bzw.   regoro run [siteDir]
 *       Startet den Editor-Host für <siteDir> (Auth aus <siteDir>/.regoro/auth.json).
 *
 * Auth-Modell: gehashte Datei im Site-Root (fail-closed). KEIN Env-Passwort.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { authFilePath, createAuthFile, ensureGitignore } from "./auth.ts";
import { ensureRepo } from "./git.ts";
import { listPageFiles, startServer } from "./server.ts";

/**
 * Muss der `version` in package.json entsprechen — festgehalten durch einen Test
 * in cli.test.ts. Bewusst dupliziert statt package.json zu importieren: der
 * Import würde `resolveJsonModule` erzwingen und im --compile-Binary die
 * package.json mitbündeln.
 */
export const VERSION = "0.1.1";

const USAGE = `regoro — Inline-Editor

Verwendung:
  regoro init [siteDir] [--password-stdin] [--force]
                                  Auth-Datei + git-Repo anlegen
  regoro <siteDir>                Editor für <siteDir> starten
  regoro run [siteDir]            (identisch zu obigem)
  regoro --version                Version ausgeben

siteDir ist optional und meint ohne Angabe das aktuelle Verzeichnis.
--force überschreibt eine bestehende Auth-Datei (= Passwort neu setzen; alle
laufenden Sessions werden ungültig).

Beispiel:
  cd ./site && regoro init      # im Site-Ordner
  regoro init ./site            # oder mit Pfad
  regoro ./site                 # → http://localhost:8788/edit/login

Umgebung:
  PORT                   Editor-Port (default 8788)
  EDITOR_INSECURE_COOKIE =1 nur für lokales HTTP-Dogfooding (lässt Cookie-Secure-Flag weg)`;

function fail(msg: string): never {
  console.error(`Fehler: ${msg}`);
  process.exit(1);
}

function usageExit(): never {
  console.error(USAGE);
  process.exit(1);
}

/**
 * Prüft, dass siteDir existiert und ein Verzeichnis ist; gibt den absoluten Pfad.
 * Ohne Argument gilt das aktuelle Verzeichnis.
 */
function requireDir(siteDir = "."): string {
  const abs = resolve(siteDir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    fail(`siteDir existiert nicht oder ist kein Verzeichnis: ${abs}`);
  }
  return abs;
}

/**
 * Liest ein Passwort versteckt vom TTY (kein Echo) — verlangt Eingabe + Bestätigung.
 * Lehnt leere Passwörter ab. Ohne TTY → Hinweis auf --password-stdin.
 */
async function promptPasswordHidden(): Promise<string> {
  if (!process.stdin.isTTY) {
    fail("kein TTY für interaktive Eingabe — nutze --password-stdin");
  }
  const readHidden = (label: string): Promise<string> =>
    new Promise<string>((resolvePw, reject) => {
      const stdin = process.stdin;
      process.stdout.write(label);
      let buf = "";
      const onData = (chunk: Buffer) => {
        const s = chunk.toString("utf8");
        for (const ch of s) {
          if (ch === "\n" || ch === "\r") {
            cleanup();
            process.stdout.write("\n");
            resolvePw(buf);
            return;
          }
          if (ch === "") {
            // Ctrl-C
            cleanup();
            process.stdout.write("\n");
            reject(new Error("abgebrochen"));
            return;
          }
          if (ch === "" || ch === "\b") {
            // Backspace
            buf = buf.slice(0, -1);
            continue;
          }
          buf += ch;
        }
      };
      const cleanup = () => {
        stdin.removeListener("data", onData);
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
      };
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
    });

  const pw = (await readHidden("Passwort: ")).trim();
  if (!pw) fail("leeres Passwort ist nicht zulässig");
  const confirm = (await readHidden("Passwort bestätigen: ")).trim();
  if (pw !== confirm) fail("Passwörter stimmen nicht überein");
  return pw;
}

/** Beschafft das Passwort: --password-stdin (stdin) oder interaktiver TTY-Prompt. */
async function obtainPassword(passwordStdin: boolean): Promise<string> {
  if (passwordStdin) {
    const pw = (await Bun.stdin.text()).trim();
    if (!pw) fail("leeres Passwort über stdin (--password-stdin)");
    return pw;
  }
  return promptPasswordHidden();
}

async function cmdInit(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const passwordStdin = args.includes("--password-stdin");
  const force = args.includes("--force");
  const siteDirArg = positional[0] ?? ".";
  const siteDir = requireDir(siteDirArg);

  // Zielordner nennen, BEVOR nach dem Passwort gefragt wird — bei `init` ohne
  // Argument (= cwd) ist der Pfad sonst nirgends sichtbar.
  console.log(`Site-Verzeichnis: ${siteDir}`);

  // Guard 1: nicht versehentlich eine bestehende Site neu initialisieren.
  // createAuthFile überschreibt sonst Hash UND Secret — Passwort weg, Sessions tot.
  if (existsSync(authFilePath(siteDir)) && !force) {
    fail(
      `bereits initialisiert: ${authFilePath(siteDir)}\n` +
        "  Zum Neusetzen des Passworts: regoro init --force " +
        `${siteDirArg}\n  (macht alle laufenden Sessions ungültig)`,
    );
  }

  // Guard 2: ohne top-level *.html gibt es nichts zu editieren — nahezu sicher
  // der falsche Ordner (z.B. versehentlich $HOME oder das Eltern-Verzeichnis).
  const pages = listPageFiles(siteDir);
  if (pages.length === 0 && !force) {
    fail(
      "keine editierbaren Seiten gefunden (top-level *.html).\n" +
        `  Ist ${siteDir} wirklich der Site-Ordner?\n` +
        "  Trotzdem initialisieren: --force",
    );
  }
  if (pages.length > 0) {
    console.log(`Editierbare Seiten (${pages.length}): ${pages.join(", ")}`);
  }
  // Reihenfolge (in dieser Folge, nicht umstellen):
  //
  //   1. .gitignore  — ".regoro/" muss drinstehen, BEVOR irgendetwas committet wird.
  //   2. ensureRepo  — git init + pristine Baseline-Commit. Hält den UNBERÜHRTEN
  //      Stand als erste Version fest; sonst würde host.ts' lazy ensureRepo erst
  //      beim ersten Save committen und den bereits editierten Stand als
  //      "Baseline" ausgeben. Zu diesem Zeitpunkt existiert auth.json noch NICHT,
  //      das Secret kann also gar nicht in den Commit geraten.
  //   3. Passwort abfragen und auth.json schreiben — als LETZTES.
  //
  // Der Grund für 3 zuletzt: git kann fehlschlagen (z.B. "dubious ownership",
  // wenn der Site-Ordner einem anderen User gehört). Früher lief createAuthFile
  // zuerst — dann lag ein nutzloses Passwort im Ordner, und der "bereits
  // initialisiert"-Guard blockierte den Wiederholungsversuch. Jetzt scheitert
  // init, bevor der Nutzer überhaupt tippt, und ein zweiter Anlauf funktioniert.
  ensureGitignore(siteDir);
  ensureRepo(siteDir);

  if (!passwordStdin) console.log(""); // Abstand vor dem interaktiven Prompt
  const password = await obtainPassword(passwordStdin);
  const { path } = await createAuthFile(siteDir, password);

  console.log("");
  console.log("Auth-Datei angelegt:");
  console.log(`  ${path}`);
  console.log("  (Mode 0600, git-ignoriert über .regoro/ — niemals committen/ausliefern)");
  console.log("");
  console.log("git-Repo im Site-Verzeichnis bereit (jede Speicherung = eine Version).");
  console.log("");
  console.log("Editor starten:");
  console.log(siteDirArg === "." ? "  regoro run" : `  regoro run ${siteDirArg}`);
  console.log("Dann im Browser /edit (bzw. /edit/login) öffnen.");
}

function cmdRun(siteDirArg?: string): void {
  const siteDir = requireDir(siteDirArg);
  const port = Number(process.env.PORT ?? 8788);
  const { port: actual } = startServer({
    siteDir,
    repoRoot: siteDir, // repoRoot = siteDir → pages top-level (sitePrefix="")
    port,
  });
  console.log(`Regoro Editor läuft auf http://localhost:${actual}/edit/login`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;

  if (!cmd) usageExit();

  // Vor allem anderen: --version/-v würde sonst als siteDir interpretiert.
  // install.sh nutzt es, um die Installation zu verifizieren.
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }

  if (cmd === "init") {
    await cmdInit(rest);
    return;
  }
  if (cmd === "run") {
    cmdRun(rest[0]); // ohne Pfad: cwd
    return;
  }
  // Bare-Form: `regoro <siteDir>` (kein bekannter Sub-Befehl).
  // Ein nacktes `regoro` bleibt bewusst die Usage-Ausgabe (siehe Guard oben)
  // statt still die cwd zu starten — sonst gäbe es keinen Weg mehr zur Hilfe.
  if (cmd.startsWith("--")) usageExit();
  cmdRun(cmd);
}

// Nur ausführen, wenn direkt gestartet (`regoro …`), nicht beim Import. Ohne
// diesen Guard startete `import { VERSION } from "./cli.ts"` die CLI mit den
// argv des Aufrufers — im Test hieß das process.exit(1) mitten im Testlauf.
// Im --compile-Binary ist der Entrypoint main, der Guard greift also dort auch.
if (import.meta.main) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
  });
}
