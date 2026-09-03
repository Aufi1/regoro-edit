#!/usr/bin/env bun
/**
 * regoro — CLI-Entrypoint für den Inline-Editor.
 *
 * Befehle:
 *   regoro init [siteDir] --nummer <n> | --email <a> [...] [--stdin] [--force]
 *       Legt <siteDir>/.regoro/auth.json (hinterlegte Kontaktwege + HMAC-Secret,
 *       Mode 0600, git-ignoriert) an und initialisiert ein git-Repo im siteDir
 *       (Versionen pro Site). Ohne siteDir: aktuelles Verzeichnis.
 *   regoro kennung [siteDir] --add <k> | --remove <k> | --list
 *       Kontaktwege pflegen, ohne laufende Sitzungen zu beenden.
 *   regoro <siteDir>   bzw.   regoro run [siteDir]
 *       Startet den Editor-Host für <siteDir> (Auth aus <siteDir>/.regoro/auth.json).
 *   regoro disable [siteDir] [--purge]
 *       Entfernt .regoro/ → Editor aus (fail-closed). Site bleibt. --purge löscht
 *       zusätzlich .git, aber nur ohne gespeicherte Bearbeitungen.
 *
 * Auth-Modell: hinterlegte Kontaktwege im Site-Root (fail-closed). Kein Passwort —
 * der Nachweis ist ein Einmalcode per SMS oder E-Mail.
 */
import { existsSync, readFileSync, statSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
// Bun-"file"-Import: liefert einen Pfad, den `bun build --compile` mit einbettet.
// Exakt das Muster von overlay.client.js in host.ts — NICHT auf import.meta.url
// zurückbauen, das zeigt im Binary ins Leere und `regoro licenses` liefe leer.
import noticesAsset from "../THIRD-PARTY-NOTICES.txt" with { type: "file" };
import {
  AUTH_DIR_NAME,
  alleKennungen,
  authFilePath,
  createAuthFile,
  ensureGitignore,
  pruefeAuthDatei,
  schreibeKennungen,
} from "./auth.ts";
import { maskiereKennung, normalisiereKennung } from "./kennung.ts";
import { countCommits, ensureRepo, shellQuote } from "./git.ts";
import { startServer } from "./server.ts";
import { listPageFiles, listSites } from "./sites.ts";
import {
  activationSteps,
  caddyBlock,
  caddyGlobalBlock,
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
export const VERSION = "0.3.0";

const USAGE = `regoro — Inline-Editor

Verwendung:
  regoro init [siteDir] --nummer <n> | --email <a> [...] [--stdin] [--force]
                                  Auth-Datei + git-Repo anlegen. Mindestens ein
                                  Kontaktweg; mehrfach möglich.
  regoro kennung [siteDir] --add <k> | --remove <k> | --list
                                  Kontaktwege pflegen (ohne Sitzungen zu beenden)
  regoro <siteDir>                Editor für <siteDir> starten
  regoro run [siteDir] [--versand-config <pfad>]
                                  (identisch zu obigem)
  regoro serve <sitesRoot> [--port n] [--versand-config <pfad>]
                                  Sammelbetrieb: alle Websites unter <sitesRoot>
                                  in EINEM Prozess. Jeder Unterordner heißt wie
                                  seine Domain; der Host-Header entscheidet.
  regoro disable [siteDir] [--purge]
                                  Editor abschalten (entfernt .regoro/)
  regoro service [siteDir] [--domain d] [--port n] [--systemd|--caddy]
                                  systemd-Unit + Caddy-Block ausgeben
  regoro service <sitesRoot> --multi [--port n] [--systemd|--caddy]
                                  dasselbe für den Sammelbetrieb
  regoro licenses                 Lizenzhinweise der Abhängigkeiten ausgeben
  regoro --version                Version ausgeben

siteDir ist optional und meint ohne Angabe das aktuelle Verzeichnis.
--force überschreibt eine bestehende Auth-Datei. Dabei entsteht ein NEUES
Secret, alle laufenden Sitzungen werden ungültig — das ist der Weg, jemanden
sofort auszusperren.

Beispiel:
  regoro init ./site --nummer 0151 20464812 --email chef@firma.de
  regoro kennung ./site --list
  regoro ./site                 # → http://localhost:8788/edit/login
  regoro serve /srv/sites       # alle Kundenwebsites in einem Prozess

Umgebung:
  PORT                   Editor-Port (default 8788)
  REGORO_VERSAND_CONFIG  Pfad zur Versand-Konfiguration
                         (default /etc/regoro/versand.json)
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
 * Zerlegt die Argumente von `init` in Positionals und Kontaktwege.
 *
 * Flag und Wert werden **paarweise** herausgeschnitten. Die naheliegende
 * Abkürzung — „alles, was wie eine Telefonnummer aussieht, ist ein Wert" —
 * war ein echter Fehler: `regoro init 12345678 --nummer 0151…` hielt den
 * Ordnernamen `12345678` für eine Nummer, warf ihn weg und richtete
 * stillschweigend das aktuelle Verzeichnis ein. Nachgestellt, exit 0.
 */
function zerlegeInitArgumente(args: string[]): { positional: string[]; roh: string[] } {
  const positional: string[] = [];
  const roh: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--nummer" || arg === "--email") {
      const wert = args[++i];
      if (wert === undefined) fail(`${arg} braucht einen Wert`);
      roh.push(wert);
      continue;
    }
    if (arg.startsWith("--")) continue; // schaltende Flags, von checkFlags geprüft
    positional.push(arg);
  }
  return { positional, roh };
}

/**
 * Normalisiert und entdoppelt die Kontaktwege; mit `--stdin` zusätzlich aus der
 * Standardeingabe (eine Kennung je Zeile). Bricht bei einer unbrauchbaren
 * Eingabe ab, statt sie stillschweigend zu schlucken — eine verschluckte Nummer
 * heißt: der Kunde kommt nicht hinein.
 */
function pruefeKennungen(roh: string[], stdinLesen: boolean): string[] {
  const alle = [...roh];
  if (stdinLesen) {
    const text = readFileSync(0, "utf8");
    for (const zeile of text.split("\n")) {
      const t = zeile.trim();
      if (t) alle.push(t);
    }
  }
  const fertig: string[] = [];
  for (const r of alle) {
    const k = normalisiereKennung(r);
    if (k === null) {
      fail(
        `unbrauchbarer Kontaktweg: ${r}\n` +
          "  Erwartet: eine Telefonnummer (0151 20464812, +4915120464812)\n" +
          "  oder eine E-Mail-Adresse (name@firma.de).",
      );
    }
    if (!fertig.includes(k.wert)) fertig.push(k.wert);
  }
  return fertig;
}

async function cmdInit(args: string[]): Promise<void> {
  checkFlags("init", args, ["--nummer", "--email", "--stdin", "--force"]);
  const { positional, roh } = zerlegeInitArgumente(args);
  if (positional.length > 1) {
    fail(
      `zu viele Verzeichnisse für \`init\`: ${positional.join(", ")}\n` +
        "  init nimmt genau EINEN Site-Ordner.",
    );
  }
  const kennungen = pruefeKennungen(roh, args.includes("--stdin"));
  const force = args.includes("--force");
  const siteDirArg = positional[0] ?? ".";
  const siteDir = requireDir(siteDirArg);

  // Zielordner nennen, BEVOR irgendetwas geschrieben wird — bei `init` ohne
  // Argument (= cwd) ist der Pfad sonst nirgends sichtbar.
  console.log(`Site-Verzeichnis: ${siteDir}`);

  // Guard 1: nicht versehentlich eine bestehende Site neu initialisieren.
  // createAuthFile überschreibt sonst Kontaktwege UND Secret — Sitzungen tot.
  if (existsSync(authFilePath(siteDir)) && !force) {
    fail(
      `bereits initialisiert: ${authFilePath(siteDir)}\n` +
        "  Zum Neueinrichten: regoro init --force " +
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
  //   3. auth.json schreiben — als LETZTES.
  //
  // Der Grund für 3 zuletzt: git kann fehlschlagen (z.B. "dubious ownership",
  // wenn der Site-Ordner einem anderen User gehört). Früher lief createAuthFile
  // zuerst — dann lag eine nutzlose Auth-Datei im Ordner, und der "bereits
  // initialisiert"-Guard blockierte den Wiederholungsversuch. Jetzt scheitert
  // init, bevor der Nutzer überhaupt tippt, und ein zweiter Anlauf funktioniert.
  if (kennungen.length === 0) {
    fail(
      "kein Kontaktweg angegeben.\n" +
        "  Der Kunde meldet sich mit einem Code an, der an seine Nummer oder Adresse geht.\n" +
        "  Beispiel: regoro init --nummer 0151 20464812 --email chef@firma.de\n" +
        "  (mehrfach möglich; --stdin liest je eine Kennung pro Zeile)",
    );
  }

  ensureGitignore(siteDir);
  ensureRepo(siteDir);

  const { path } = await createAuthFile(siteDir, kennungen);

  console.log("");
  console.log("Auth-Datei angelegt:");
  console.log(`  ${path}`);
  console.log("  (Mode 0600, git-ignoriert über .regoro/ — niemals committen/ausliefern)");
  console.log("");
  console.log(`Hinterlegte Kontaktwege (${kennungen.length}):`);
  for (const k of kennungen) console.log(`  ${k}`);
  console.log("");
  console.log("git-Repo im Site-Verzeichnis bereit (jede Speicherung = eine Version).");
  console.log("");
  console.log("Editor starten:");
  console.log(siteDirArg === "." ? "  regoro run" : `  regoro run ${siteDirArg}`);
  console.log("Dann im Browser /edit (bzw. /edit/login) öffnen.");
}

/**
 * `regoro kennung [siteDir] --add <k> | --remove <k> | --list`
 *
 * Pflegt die hinterlegten Kontaktwege. Rührt das Secret NICHT an — eine
 * hinzugefügte Nummer soll nicht alle laufenden Sitzungen beenden. Wer sofort
 * aussperren will, nimmt `regoro init --force`.
 */
function cmdKennung(args: string[]): void {
  checkFlags("kennung", args, ["--add", "--remove", "--list"]);
  // Flag und Wert paarweise herausschneiden, nicht nach Textgleichheit filtern
  // — sonst verschluckt ein Ordnername, der wie eine Kennung aussieht, das Ziel.
  const aktionen: Array<{ art: "add" | "remove"; wert: string }> = [];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--add" || a === "--remove") {
      const wert = args[++i];
      if (wert === undefined) fail(`${a} braucht einen Wert`);
      aktionen.push({ art: a === "--add" ? "add" : "remove", wert });
      continue;
    }
    if (a.startsWith("--")) continue;
    positional.push(a);
  }
  if (positional.length > 1) {
    fail(`zu viele Verzeichnisse für \`kennung\`: ${positional.join(", ")}`);
  }
  const siteDir = requireDir(positional[0] ?? ".");

  const befund = pruefeAuthDatei(siteDir);
  if (befund.art === "veraltet") {
    fail(
      `${authFilePath(siteDir)} ist im alten Passwort-Format.\n` +
        "  Es gibt kein Passwort mehr. Neu einrichten:\n" +
        `  regoro init --force ${positional[0] ?? "."} --nummer <nummer-oder-mail>`,
    );
  }
  if (befund.art !== "ok") {
    fail(
      befund.art === "fehlt"
        ? `keine Auth-Datei in ${siteDir} — zuerst \`regoro init\` ausführen`
        : `${authFilePath(siteDir)} ist unbrauchbar: ${befund.grund}`,
    );
  }

  const vorher = alleKennungen(befund.auth);
  if (aktionen.length === 0 || args.includes("--list")) {
    console.log(`Hinterlegte Kontaktwege (${vorher.length}) in ${siteDir}:`);
    // Verkürzt: eine Betreiber-Ausgabe ist kein Ort für vollständige
    // Rufnummern und Adressen — sie landet in Logs und Screenshots.
    for (const k of vorher) console.log(`  ${maskiereKennung(k)}`);
    if (aktionen.length === 0) return;
  }

  let nachher = [...vorher];
  for (const aktion of aktionen) {
    const k = normalisiereKennung(aktion.wert);
    if (k === null) fail(`unbrauchbarer Kontaktweg: ${aktion.wert}`);
    if (aktion.art === "add") {
      if (!nachher.includes(k.wert)) nachher.push(k.wert);
    } else {
      if (!nachher.includes(k.wert)) fail(`nicht hinterlegt: ${maskiereKennung(k.wert)}`);
      nachher = nachher.filter((x) => x !== k.wert);
    }
  }
  if (nachher.length === 0) {
    fail(
      "das wäre der letzte Kontaktweg — danach käme niemand mehr hinein.\n" +
        "  Zum Abschalten des Editors: regoro disable",
    );
  }

  schreibeKennungen(siteDir, nachher);
  console.log(`Hinterlegte Kontaktwege (${nachher.length}):`);
  for (const k of nachher) console.log(`  ${maskiereKennung(k)}`);
  console.log("");
  console.log("Laufende Sitzungen bleiben gültig. Sofort aussperren: regoro init --force");
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
  // Deutsche Rufnummern werden nach Abschaltung wieder vergeben. Eine Nummer,
  // die auf der Liste steht und den Besitzer wechselt, ist ein Zugang, der den
  // Besitzer wechselt — deshalb gehört das Entfernen in den Ablauf beim Kundenende.
  console.log("Beim Kundenende: die hinterlegten Kontaktwege gehören mit entfernt.");
  console.log("Rufnummern werden nach Abschaltung wieder vergeben.");
  console.log("");
  console.log("Wieder einschalten:");
  console.log(siteDirArg === "." ? "  regoro init" : `  regoro init ${siteDirArg}`);
}

/**
 * `regoro licenses` — gibt THIRD-PARTY-NOTICES.txt aus.
 *
 * Rechtspflicht: Das ausgelieferte Binary enthält den gesamten
 * Abhängigkeitsbaum, aber keine seiner Lizenzdateien. Alle Lizenzen im Baum
 * sind permissiv, verlangen aber die Weitergabe ihrer Copyright-Hinweise.
 */
function cmdLicenses(args: string[]): void {
  checkFlags("licenses", args, []);
  // 600 KB Text lesen sich niemand am Stück durch — `regoro licenses | less`
  // oder `| grep … | head` ist der Normalfall. Schließt der Leser die Pipe
  // früh, schlägt der Schreibvorgang mit EPIPE fehl; ungefangen druckt Bun
  // dafür einen Stacktrace, der wie ein Programmfehler aussieht. Ist er nicht.
  const stillLegen = (err: unknown): void => {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "EPIPE") process.exit(0);
    throw err;
  };
  process.stdout.on("error", stillLegen);
  try {
    process.stdout.write(readFileSync(noticesAsset, "utf8"));
  } catch (err) {
    stillLegen(err);
  }
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
  checkFlags("service", args, ["--domain", "--port", "--user", "--systemd", "--caddy", "--multi"]);
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

  const multi = args.includes("--multi");
  const domain = flagValue("--domain");
  // Im Sammelbetrieb bestimmt der Ordnername die Domain. Eine zusätzlich
  // angegebene --domain würde stillschweigend ignoriert — lieber laut scheitern.
  if (multi && domain !== undefined) {
    fail(
      "--domain und --multi schließen sich aus.\n" +
        "  Im Sammelbetrieb entscheidet der Ordnername unter dem Sammelverzeichnis,\n" +
        "  welche Domain zu welcher Website gehört. Zertifikate holt Caddy on demand.",
    );
  }
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
    multi,
  };

  const onlySystemd = args.includes("--systemd");
  const onlyCaddy = args.includes("--caddy");

  if (onlySystemd && !onlyCaddy) {
    process.stdout.write(systemdUnit(opts));
    return;
  }
  if (onlyCaddy && !onlySystemd) {
    process.stdout.write(caddyGlobalBlock(opts));
    process.stdout.write(caddyBlock(opts));
    return;
  }

  if (!opts.domain && !multi) {
    console.log("# Hinweis: ohne --domain steht example.com im Caddy-Block.\n");
  }
  console.log(multi ? `# Sammelverzeichnis: ${siteDir}` : `# Site:   ${siteDir}`);
  console.log(`# Dienst: regoro-${slug}   Port: ${port}${portRaw ? "" : " (aus dem Ordnernamen abgeleitet)"}`);
  console.log(`# Nutzer: ${opts.user}\n`);
  console.log("# ── /etc/systemd/system/regoro-" + slug + ".service ──");
  console.log(systemdUnit(opts));
  console.log("# ── /etc/caddy/Caddyfile ──");
  if (multi) {
    console.log("# Dieser globale Block muss GANZ OBEN in der Caddyfile stehen:");
    console.log(caddyGlobalBlock(opts));
  }
  console.log(caddyBlock(opts));
  console.log("# ── Aktivieren ──");
  console.log(activationSteps(opts));
  console.log("");
  console.log("# Einzeln abgreifen:");
  console.log(`#   regoro service --systemd | sudo tee /etc/systemd/system/regoro-${slug}.service`);
  console.log(
    multi
      ? `#   regoro service ${shellQuote(siteDir)} --multi --caddy   # globalen Block oben einfügen!`
      : `#   regoro service --caddy --domain ${opts.domain ?? "deine-domain.de"} | sudo tee -a /etc/caddy/Caddyfile`,
  );
}

/**
 * `regoro serve <sitesRoot> [--port n]`
 *
 * Sammelbetrieb: EIN Prozess für alle Websites unter <sitesRoot>. Der
 * Ordnername IST die Zuordnung — `/srv/sites/kunde.de/` gehört zu `kunde.de`,
 * der Host-Header entscheidet pro Anfrage (sites.ts).
 *
 * Eine Website aufnehmen: Ordner anlegen, `regoro init` darin. Kein Neustart.
 * Eine Website abschalten: `regoro disable`. Ebenfalls kein Neustart.
 */
function cmdServe(args: string[]): void {
  checkFlags("serve", args, ["--port", "--versand-config"]);

  // Flag und Wert PAARWEISE herausschneiden, nicht nach Textgleichheit filtern.
  // Ein Filter `a !== portRaw` verschluckt sonst `serve 8080 --port 8080` — beide
  // Argumente sind derselbe String, das Verzeichnis fiele mit weg. Und ein
  // zweites `--port` landete unbemerkt in den Positionals.
  const positional: string[] = [];
  let portRaw: string | undefined;
  let versandConfig: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--port") {
      if (portRaw !== undefined) fail("--port ist doppelt angegeben.");
      const value = args[++i];
      if (value === undefined) fail("--port braucht einen Wert, z.B. --port 8788");
      portRaw = value;
      continue;
    }
    if (arg === "--versand-config") {
      const value = args[++i];
      if (value === undefined) fail("--versand-config braucht einen Pfad");
      versandConfig = value;
      continue;
    }
    positional.push(arg);
  }

  // Kein Rückfall auf die cwd wie bei `run`: ein Sammelverzeichnis ist nichts,
  // worin man zufällig steht, und ein Vertippen soll sofort auffallen.
  if (positional.length === 0) {
    fail(
      "serve braucht das Sammelverzeichnis.\n" +
        "  Beispiel: regoro serve /srv/sites\n" +
        "  Darin je ein Unterordner pro Domain: /srv/sites/kunde.de/",
    );
  }
  if (positional.length > 1) {
    fail(
      `zu viele Argumente für \`serve\`: ${positional.join(", ")}\n` +
        "  serve nimmt genau EIN Sammelverzeichnis — alle Websites darin.",
    );
  }
  const sitesRoot = requireDir(positional[0]);

  // 0 = freien Port wählen (Tests, lokale Experimente).
  const port = portRaw !== undefined ? Number(portRaw) : Number(process.env.PORT ?? 8788);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`ungültiger Port: ${portRaw ?? process.env.PORT}`);
  }

  const entries = listSites(sitesRoot);
  if (entries.length === 0) {
    fail(
      `keine Website-Ordner in ${sitesRoot}\n` +
        "  Erwartet wird je ein Unterordner pro Domain, z.B. kunde.de/\n" +
        "  Eine Website aufnehmen: Ordner anlegen und darin `regoro init` ausführen.",
    );
  }
  const reachable = entries.filter((e) => e.host !== null);
  if (reachable.length === 0) {
    fail(
      `keine erreichbaren Website-Ordner in ${sitesRoot}\n` +
        "  Der Ordnername MUSS die Domain sein (kleingeschrieben, ohne www.):\n" +
        entries.map((e) => `    ${e.name}`).join("\n"),
    );
  }

  console.log(`Sammelverzeichnis: ${sitesRoot}`);
  console.log(`Websites (${reachable.length}):`);
  const width = Math.max(...reachable.map((e) => e.name.length));
  for (const site of reachable) {
    const pages = listPageFiles(site.siteDir).length;
    const seiten = pages === 1 ? "1 Seite" : `${pages} Seiten`;
    const editor = existsSync(authFilePath(site.siteDir))
      ? "Editor aktiv"
      : `Editor aus (regoro init ${site.siteDir})`;
    console.log(`  ${site.name.padEnd(width)}  ${seiten.padStart(9)}  ${editor}`);
  }
  // Ordner ohne Seiten oder ohne Auth-Datei sind kein Fehler — eine Website kann
  // legitim gerade erst angelegt sein. Genannt werden sie trotzdem.
  const unerreichbar = entries.filter((e) => e.host === null);
  if (unerreichbar.length > 0) {
    console.log("Nicht erreichbar (Ordnername ist nicht die Domain):");
    for (const e of unerreichbar) console.log(`  ${e.name}`);
  }

  const { port: actual } = startServer({ sitesRoot, port, versandConfig });
  console.log(
    `Regoro Editor läuft auf Port ${actual} — welche Website, entscheidet der Host-Header.`,
  );
}

function cmdRun(args: string[]): void {
  checkFlags("run", args, ["--versand-config"]);
  let versandConfig: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--versand-config") {
      const value = args[++i];
      if (value === undefined) fail("--versand-config braucht einen Pfad");
      versandConfig = value;
      continue;
    }
    positional.push(args[i]!);
  }
  const siteDir = requireDir(positional[0]);
  const port = Number(process.env.PORT ?? 8788);
  const { port: actual } = startServer({
    siteDir,
    repoRoot: siteDir, // repoRoot = siteDir → pages top-level (sitePrefix="")
    port,
    versandConfig,
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
    cmdRun(rest); // ohne Pfad: cwd
    return;
  }
  if (cmd === "serve") {
    cmdServe(rest);
    return;
  }
  if (cmd === "kennung") {
    cmdKennung(rest);
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
  if (cmd === "licenses") {
    cmdLicenses(rest);
    return;
  }
  // Bare-Form: `regoro <siteDir>` (kein bekannter Sub-Befehl).
  // Ein nacktes `regoro` bleibt bewusst die Usage-Ausgabe (siehe Guard oben)
  // statt still die cwd zu starten — sonst gäbe es keinen Weg mehr zur Hilfe.
  if (cmd.startsWith("--")) usageExit();
  cmdRun(argv);
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
