#!/usr/bin/env bun
/**
 * regoro-edit — CLI-Entrypoint für den Inline-Editor.
 *
 * Befehle:
 *   regoro-edit init <siteDir> [--password-stdin]
 *       Legt <siteDir>/.regoro/auth.json (argon2id-Hash + HMAC-Secret, Mode 0600,
 *       git-ignoriert) an und initialisiert ein git-Repo im siteDir (Versionen pro Site).
 *   regoro-edit <siteDir>   bzw.   regoro-edit run <siteDir>
 *       Startet den Editor-Host für <siteDir> (Auth aus <siteDir>/.regoro/auth.json).
 *
 * Auth-Modell: gehashte Datei im Site-Root (fail-closed). KEIN Env-Passwort.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createAuthFile } from "./auth.ts";
import { ensureRepo } from "./git.ts";
import { startServer } from "./server.ts";

const USAGE = `regoro-edit — Inline-Editor

Verwendung:
  regoro-edit init <siteDir> [--password-stdin]   Auth-Datei + git-Repo anlegen
  regoro-edit <siteDir>                            Editor für <siteDir> starten
  regoro-edit run <siteDir>                        (identisch zu obigem)

Beispiel:
  regoro-edit init ./site
  regoro-edit ./site            # → http://localhost:8788/edit/login

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

/** Prüft, dass siteDir existiert und ein Verzeichnis ist; gibt den absoluten Pfad. */
function requireDir(siteDir: string): string {
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
  const siteDirArg = positional[0];
  if (!siteDirArg) usageExit();
  const siteDir = requireDir(siteDirArg);

  const password = await obtainPassword(passwordStdin);
  // Reihenfolge wichtig: createAuthFile ZUERST — es schreibt .regoro/ + trägt
  // ".regoro/" ins .gitignore ein, BEVOR der Baseline-Commit den Stand erfasst.
  // So bleibt das HMAC-Secret (auth.json) untracked.
  const { path } = await createAuthFile(siteDir, password);
  // ensureRepo: idempotentes git init + pristine Baseline-Commit, falls noch
  // kein HEAD existiert. Dadurch ist der UNBERÜHRTE Original-Stand der Seite als
  // erste Version festgehalten — der erste Edit bekommt seine eigene Version,
  // statt dass host.ts' lazy ensureRepo erst beim ersten Save den bereits
  // editierten Stand als "Baseline" committet.
  ensureRepo(siteDir);

  console.log("");
  console.log("Auth-Datei angelegt:");
  console.log(`  ${path}`);
  console.log("  (Mode 0600, git-ignoriert über .regoro/ — niemals committen/ausliefern)");
  console.log("");
  console.log("git-Repo im Site-Verzeichnis bereit (jede Speicherung = eine Version).");
  console.log("");
  console.log("Editor starten:");
  console.log(`  regoro-edit ${siteDirArg}`);
  console.log("Dann im Browser /edit (bzw. /edit/login) öffnen.");
}

function cmdRun(siteDirArg: string): void {
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

  if (cmd === "init") {
    await cmdInit(rest);
    return;
  }
  if (cmd === "run") {
    if (!rest[0]) usageExit();
    cmdRun(rest[0]);
    return;
  }
  // Bare-Form: `regoro-edit <siteDir>` (kein bekannter Sub-Befehl).
  if (cmd.startsWith("--")) usageExit();
  cmdRun(cmd);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
