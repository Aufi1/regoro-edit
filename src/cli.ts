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
 *   regoro disable [siteDir] [--purge]
 *       Entfernt .regoro/ → Editor aus (fail-closed). Site bleibt. --purge löscht
 *       zusätzlich .git, aber nur ohne gespeicherte Bearbeitungen.
 *
 * Auth-Modell: gehashte Datei im Site-Root (fail-closed). KEIN Env-Passwort.
 */
import { existsSync, statSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { AUTH_DIR_NAME, authFilePath, createAuthFile, ensureGitignore } from "./auth.ts";
import { countCommits, ensureRepo, shellQuote } from "./git.ts";
import { listPageFiles, startServer } from "./server.ts";
import {
  activationSteps,
  caddyBlock,
  DOMAIN_RE,
  servicePort,
  serviceSlug,
  systemdUnit,
} from "./service.ts";

/**
 * Muss der `version` in package.json entsprechen — festgehalten durch einen Test
 * in cli.test.ts. Bewusst dupliziert statt package.json zu importieren: der
 * Import würde `resolveJsonModule` erzwingen und im --compile-Binary die
 * package.json mitbündeln.
 */
export const VERSION = "0.2.0";

const USAGE = `regoro — Inline-Editor

Verwendung:
  regoro init [siteDir] [--password-stdin] [--force]
                                  Auth-Datei + git-Repo anlegen
  regoro <siteDir>                Editor für <siteDir> starten
  regoro run [siteDir]            (identisch zu obigem)
  regoro disable [siteDir] [--purge]
                                  Editor abschalten (entfernt .regoro/)
  regoro service [siteDir] [--domain d] [--port n] [--systemd|--caddy]
                                  systemd-Unit + Caddy-Block ausgeben
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
  EDITOR_INSECURE_COOKIE =1 lässt das Cookie-Secure-Flag weg. NUR nötig, wenn du
                         den Editor über HTTP unter einem anderen Namen als
                         localhost erreichst (LAN-IP, Hostname). Über
                         http://localhost und über HTTPS braucht es das nicht.
                         Nie in Produktion.`;

function fail(msg: string): never {
  console.error(`Fehler: ${msg}`);
  process.exit(1);
}

function usageExit(): never {
  console.error(USAGE);
  process.exit(1);
}

/**
 * Prüft die Optionen eines Unterbefehls, BEVOR er irgendetwas tut.
 *
 * Zwei Fallen, die das schließt:
 *   - `regoro disable --help` filterte "--help" als unbekanntes Flag heraus,
 *     siteDirArg fiel auf "." zurück — eine Hilfe-Anfrage löschte die Auth-Datei
 *     der aktuellen Site. Dasselbe Muster ließ `regoro init --help` durchlaufen.
 *   - Ein Tippfehler (`--purgee`) wurde stillschweigend ignoriert, der Befehl lief
 *     mit anderem Verhalten als beabsichtigt.
 */
function checkFlags(cmd: string, args: string[], allowed: readonly string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const unknown = args.filter((a) => a.startsWith("-") && !allowed.includes(a));
  if (unknown.length > 0) {
    fail(
      `unbekannte Option für \`${cmd}\`: ${unknown.join(", ")}\n` +
        `  Erlaubt: ${allowed.join(", ") || "(keine)"}\n` +
        "  Hilfe: regoro --help",
    );
  }
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
  checkFlags("init", args, ["--password-stdin", "--force"]);
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

/**
 * `regoro disable [siteDir] [--purge]` — schaltet den Editor für eine Site ab.
 *
 * Entfernt NUR <siteDir>/.regoro/. Die Website bleibt unangetastet und wird
 * weiter ausgeliefert; alle /edit*-Routen antworten danach mit 404 (fail-closed).
 * Umkehrbar mit `regoro init`.
 *
 * `--purge` entfernt zusätzlich .git — aber nur, wenn dort höchstens der
 * Baseline-Commit steht. Ab dem ersten echten Edit steckt im Repo Arbeit, die es
 * nirgends sonst gibt: der Editor schreibt direkt in die ausgelieferten Dateien,
 * die Website-Pipeline kennt diese Commits nicht. Die würde --purge vernichten,
 * deshalb bricht es dann ab. Wer es trotzdem will, löscht .git von Hand.
 */
function cmdDisable(args: string[]): void {
  checkFlags("disable", args, ["--purge"]);
  const positional = args.filter((a) => !a.startsWith("--"));
  const purge = args.includes("--purge");
  const siteDirArg = positional[0] ?? ".";
  const siteDir = requireDir(siteDirArg);

  console.log(`Site-Verzeichnis: ${siteDir}`);

  const authDir = join(siteDir, AUTH_DIR_NAME);
  if (!existsSync(authDir)) {
    fail(`nicht initialisiert: ${authDir} existiert nicht.\n  Es gibt nichts abzuschalten.`);
  }

  // null = git konnte die Historie nicht lesen. Dann NIEMALS löschen (fail-closed):
  // ein Repo voller Kundenarbeit sähe sonst aus wie ein leeres.
  const commits = countCommits(siteDir);
  const disableCmd = siteDirArg === "." ? "regoro disable" : `regoro disable ${siteDirArg}`;

  if (purge && commits === null) {
    fail(
      "die Versionshistorie lässt sich nicht lesen — git verweigert die Auskunft.\n" +
        "  Ob darin gespeicherte Bearbeitungen stecken, ist damit unbekannt, und\n" +
        "  --purge würde sie unwiederbringlich löschen. Abgebrochen.\n\n" +
        "  Nachsehen, woran es liegt:\n" +
        `    git -C ${shellQuote(siteDir)} log --oneline\n\n` +
        "  Nur den Editor abschalten (rührt .git nicht an):\n" +
        `    ${disableCmd}`,
    );
  }

  if (purge && commits !== null && commits > 1) {
    fail(
      `${commits} Commits im Site-Repo — darin stecken gespeicherte Bearbeitungen.\n` +
        "  Der Editor ist die einzige Quelle dieser Änderungen; --purge würde sie\n" +
        "  unwiederbringlich löschen. Abgebrochen.\n\n" +
        "  Nur den Editor abschalten (Historie bleibt):\n" +
        `    ${disableCmd}\n\n` +
        "  Historie ansehen:\n" +
        `    git -C ${shellQuote(siteDir)} log --oneline`,
    );
  }

  rmSync(authDir, { recursive: true, force: true });
  console.log("");
  console.log("Auth-Datei entfernt — der Editor ist für diese Site aus.");
  console.log("  Die Website wird weiter ausgeliefert; /edit* antwortet mit 404.");

  if (purge) {
    rmSync(join(siteDir, ".git"), { recursive: true, force: true });
    console.log("  git-Repo entfernt (enthielt keine gespeicherten Bearbeitungen).");
  } else if (commits === null) {
    console.log("  git-Repo bleibt erhalten (Historie nicht lesbar — unangetastet).");
  } else if (commits > 0) {
    console.log(`  git-Repo bleibt erhalten (${commits} Version${commits === 1 ? "" : "en"}).`);
  }

  console.log("");
  console.log("Wieder einschalten:");
  console.log(siteDirArg === "." ? "  regoro init" : `  regoro init ${siteDirArg}`);
}

/**
 * `regoro service [siteDir] [--domain d] [--port n] [--user u] [--systemd|--caddy]`
 *
 * Druckt die Betriebs-Dateien. Schreibt nichts — der Mensch leitet um, wohin er will.
 * Ohne --systemd/--caddy kommt beides plus die Aktivierungsschritte.
 *
 * Annahme: Die Website ist bereits unter ihrer Domain erreichbar (Caddy + TLS).
 * Der Editor kommt daneben; der Proxy reicht nur /edit* an ihn weiter.
 */
function cmdService(args: string[]): void {
  checkFlags("service", args, ["--domain", "--port", "--user", "--systemd", "--caddy"]);
  const flagValue = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // Werte von Flags sind keine Positionals.
  const flagValues = new Set(
    ["--domain", "--port", "--user"].map((f) => flagValue(f)).filter((v): v is string => !!v),
  );
  const positional = args.filter((a) => !a.startsWith("--") && !flagValues.has(a));

  const siteDir = requireDir(positional[0] ?? ".");
  const slug = serviceSlug(siteDir);
  const portRaw = flagValue("--port");
  const port = portRaw ? Number(portRaw) : servicePort(slug);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`ungültiger Port: ${portRaw}`);
  }

  // process.execPath ist im --compile-Binary der Pfad zum Binary selbst. Startet
  // man über `bun src/cli.ts`, zeigt er auf bun — ExecStart würde dann `bun run …`
  // heißen und die Unit wäre unbrauchbar. Der Name des Binaries ist egal (jemand
  // darf es umbenennen), die Laufzeit nicht.
  const execPath = process.execPath;
  const runtime = basename(execPath).replace(/\.exe$/, "");
  if (["bun", "bun-debug", "node", "deno"].includes(runtime)) {
    fail(
      `service braucht das kompilierte regoro-Binary, läuft aber gerade unter \`${runtime}\`.\n` +
        "  ExecStart in der Unit zeigte sonst auf den Interpreter statt auf regoro.\n\n" +
        "  Binary bauen:      bun run build:binary   → dist/regoro\n" +
        "  Oder installieren: curl -fsSL https://raw.githubusercontent.com/Aufi1/regoro-edit/main/install.sh | sh",
    );
  }

  const domain = flagValue("--domain");
  if (domain !== undefined && !DOMAIN_RE.test(domain)) {
    fail(
      `ungültige Domain: ${domain}\n` +
        "  Erlaubt sind Hostnamen, Wildcards (*.example.com) und :PORT.\n" +
        "  Der Wert landet im Caddyfile und in angezeigten Shell-Befehlen.",
    );
  }

  const opts = {
    siteDir,
    execPath,
    slug,
    port,
    user: flagValue("--user") ?? (process.env.SUDO_USER || process.env.USER || "www-data"),
    domain,
  };

  const onlySystemd = args.includes("--systemd");
  const onlyCaddy = args.includes("--caddy");

  if (onlySystemd && !onlyCaddy) {
    process.stdout.write(systemdUnit(opts));
    return;
  }
  if (onlyCaddy && !onlySystemd) {
    process.stdout.write(caddyBlock(opts));
    return;
  }

  if (!opts.domain) {
    console.log("# Hinweis: ohne --domain steht example.com im Caddy-Block.\n");
  }
  console.log(`# Site:   ${siteDir}`);
  console.log(`# Dienst: regoro-${slug}   Port: ${port}${portRaw ? "" : " (aus dem Ordnernamen abgeleitet)"}`);
  console.log(`# Nutzer: ${opts.user}\n`);
  console.log("# ── /etc/systemd/system/regoro-" + slug + ".service ──");
  console.log(systemdUnit(opts));
  console.log("# ── /etc/caddy/Caddyfile ──");
  console.log(caddyBlock(opts));
  console.log("# ── Aktivieren ──");
  console.log(activationSteps(opts));
  console.log("");
  console.log("# Einzeln abgreifen:");
  console.log(`#   regoro service --systemd | sudo tee /etc/systemd/system/regoro-${slug}.service`);
  console.log(`#   regoro service --caddy --domain ${opts.domain ?? "deine-domain.de"} | sudo tee -a /etc/caddy/Caddyfile`);
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
  if (cmd === "disable") {
    cmdDisable(rest);
    return;
  }
  if (cmd === "service") {
    cmdService(rest);
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
