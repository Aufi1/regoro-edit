/**
 * CLI-Ebene (`regoro-edit init`) — bewusst als Subprozess, weil hier genau die
 * Verdrahtung geprüft wird, die reine Unit-Tests von createAuthFile/ensureRepo
 * nicht abdecken: Argument-Defaults (cwd), Guards und vor allem die Reihenfolge
 * ensureGitignore → ensureRepo → createAuthFile. Sie hält das HMAC-Secret aus dem
 * Baseline-Commit (auth.json existiert beim Commit noch nicht) UND sorgt dafür,
 * dass ein fehlschlagendes git keine nutzlose Auth-Datei hinterlässt.
 */
import { describe, expect, test, beforeEach, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("./cli.ts", import.meta.url).pathname;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "regoro-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TEST_NUMMER = "+4915120464812";

/** Führt `bun cli.ts init <args>` mit cwd aus; die Kennung kommt über stdin. */
function runInit(args: string[], opts: { cwd?: string; kennung?: string } = {}) {
  const proc = Bun.spawnSync(["bun", CLI, "init", ...args, "--stdin"], {
    cwd: opts.cwd ?? dir,
    stdin: new TextEncoder().encode(`${opts.kennung ?? TEST_NUMMER}\n`),
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** Legt eine minimale Site an (eine top-level Seite). */
function makeSite(at: string): void {
  writeFileSync(join(at, "index.html"), "<html><body><p>Hallo</p></body></html>");
}

function gitTracked(repo: string): string[] {
  const p = Bun.spawnSync(["git", "-C", repo, "ls-files"]);
  return p.stdout.toString().trim().split("\n").filter(Boolean);
}

/** Führt `bun cli.ts <args>` ohne stdin aus. */
function runCli(args: string[]) {
  const proc = Bun.spawnSync(["bun", CLI, ...args], { cwd: dir });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("regoro — CLI-Grundgerüst", () => {
  test("VERSION stimmt mit package.json überein", async () => {
    const pkgPath = new URL("../package.json", import.meta.url).pathname;
    const pkg = await Bun.file(pkgPath).json();
    const { VERSION } = await import("./cli.ts");

    expect(VERSION).toBe(pkg.version);
    // Der installierte Befehl heißt `regoro` — install.sh und README hängen daran.
    expect(Object.keys(pkg.bin)).toEqual(["regoro"]);
  });

  test("--version druckt nur die Version (von install.sh geparst)", () => {
    const r = runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("--help druckt die Usage mit Exit 0", () => {
    const r = runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("regoro init");
  });

  test("ohne Argumente: Usage auf stderr, Exit 1", () => {
    const r = runCli([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Verwendung:");
  });
});

describe("Flag-Prüfung (vor jeder Wirkung)", () => {
  test("`disable --help` druckt Usage und löscht NICHTS", () => {
    makeSite(dir);
    expect(runInit([], { cwd: dir }).code).toBe(0);

    const proc = Bun.spawnSync(["bun", CLI, "disable", "--help"], { cwd: dir });

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("Verwendung:");
    expect(existsSync(join(dir, ".regoro", "auth.json"))).toBe(true); // unangetastet
  });

  test("`init --help` druckt Usage und initialisiert NICHT", () => {
    makeSite(dir);

    const proc = Bun.spawnSync(["bun", CLI, "init", "--help"], { cwd: dir });

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("Verwendung:");
    expect(existsSync(join(dir, ".regoro"))).toBe(false);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  test("unbekannte Option wird abgelehnt statt still ignoriert", () => {
    makeSite(dir);
    expect(runInit([], { cwd: dir }).code).toBe(0);

    const proc = Bun.spawnSync(["bun", CLI, "disable", "--purgee"], { cwd: dir });

    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("unbekannte Option");
    expect(existsSync(join(dir, ".regoro", "auth.json"))).toBe(true); // nichts passiert
  });

  test("unbekannte Option bei init wird abgelehnt", () => {
    makeSite(dir);

    const proc = Bun.spawnSync(["bun", CLI, "init", "--forse"], { cwd: dir });

    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("unbekannte Option");
    expect(existsSync(join(dir, ".regoro"))).toBe(false);
  });
});

describe("regoro disable", () => {
  function runDisable(args: string[] = [], cwd = dir) {
    const proc = Bun.spawnSync(["bun", CLI, "disable", ...args], { cwd });
    return {
      code: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  }

  /** Simuliert eine gespeicherte Bearbeitung: zweiter Commit im Site-Repo. */
  function makeEdit(at: string): void {
    writeFileSync(join(at, "index.html"), "<html><body><p>Geändert</p></body></html>");
    Bun.spawnSync(["git", "-C", at, "add", "-A"]);
    Bun.spawnSync([
      "git", "-C", at,
      "-c", "user.name=T", "-c", "user.email=t@t.local",
      "commit", "-m", "Edit",
    ]);
  }

  test("entfernt .regoro/, lässt Website und Historie stehen", () => {
    makeSite(dir);
    expect(runInit([], { cwd: dir }).code).toBe(0);

    const r = runDisable();

    expect(r.code).toBe(0);
    expect(existsSync(join(dir, ".regoro"))).toBe(false);
    expect(existsSync(join(dir, "index.html"))).toBe(true); // Website unangetastet
    expect(existsSync(join(dir, ".git"))).toBe(true); // Historie bleibt
    expect(r.stdout).toContain("Editor ist für diese Site aus");
  });

  test("gelöschte Gesprächsverläufe werden GENANNT, nicht stillschweigend entfernt", () => {
    /**
     * `disable` löscht das ganze `.regoro/` — seit der KI-Seitenleiste liegen
     * dort auch die Gespräche, und die enthalten wörtlich, was der Kunde
     * geschrieben hat. Die Meldung sprach nur von der Auth-Datei und davon,
     * dass die Website weiterläuft; wer sie las, hatte keinen Anlass zu
     * vermuten, dass er gerade Kundentext löscht.
     *
     * Der Test hält die MELDUNG fest, nicht die Löschregel. Ob Verläufe ein
     * Abschalten überdauern sollen, ist eine offene Frage der Aufbewahrung.
     */
    makeSite(dir);
    expect(runInit([], { cwd: dir }).code).toBe(0);
    const vdir = join(dir, ".regoro", "verlauf");
    mkdirSync(vdir, { recursive: true });
    writeFileSync(join(vdir, "a.jsonl"), '{"type":"session"}\n');
    writeFileSync(join(vdir, "b.jsonl"), '{"type":"session"}\n');

    const r = runDisable();

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("2 gespeicherte Gespräche");
    expect(r.stdout).toContain(".regoro/verlauf/");
    expect(existsSync(vdir)).toBe(false);
  });

  test("Gegenprobe: ohne Verläufe steht der Satz NICHT da", () => {
    // Sonst wäre die Prüfung darüber auch dann grün, wenn der Satz IMMER
    // erschiene — und jedes Abschalten meldete gelöschte Gespräche, die es nie
    // gab. Eine Warnung, die immer kommt, liest bald niemand mehr.
    makeSite(dir);
    expect(runInit([], { cwd: dir }).code).toBe(0);

    const r = runDisable();

    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Gespräch");
  });

  test("ohne .regoro/ → Exit 1, nichts zu tun", () => {
    makeSite(dir);
    const r = runDisable();

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("nicht initialisiert");
  });

  test("danach lässt sich die Site wieder initialisieren", () => {
    makeSite(dir);
    expect(runInit([], { cwd: dir }).code).toBe(0);
    expect(runDisable().code).toBe(0);

    const r = runInit([], { cwd: dir }); // kein Guard blockiert
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, ".regoro", "auth.json"))).toBe(true);
  });

  test("--purge entfernt .git, wenn nur der Baseline-Commit existiert", () => {
    makeSite(dir);
    expect(runInit([], { cwd: dir }).code).toBe(0);

    const r = runDisable(["--purge"]);

    expect(r.code).toBe(0);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(existsSync(join(dir, "index.html"))).toBe(true);
  });

  test("--purge VERWEIGERT, sobald gespeicherte Bearbeitungen existieren", () => {
    makeSite(dir);
    expect(runInit([], { cwd: dir }).code).toBe(0);
    makeEdit(dir); // zweiter Commit = Kundenarbeit

    const r = runDisable(["--purge"]);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("gespeicherte Bearbeitungen");
    // NICHTS wurde gelöscht — auch die Auth-Datei nicht.
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(existsSync(join(dir, ".regoro", "auth.json"))).toBe(true);
  });

  test("ohne --purge geht das Abschalten auch mit Bearbeitungen", () => {
    makeSite(dir);
    expect(runInit([], { cwd: dir }).code).toBe(0);
    makeEdit(dir);

    const r = runDisable();

    expect(r.code).toBe(0);
    expect(existsSync(join(dir, ".regoro"))).toBe(false);
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(r.stdout).toContain("2 Versionen");
  });

  test("mit explizitem siteDir statt cwd", () => {
    const site = join(dir, "site");
    mkdirSync(site);
    makeSite(site);
    expect(runInit([site], { cwd: dir }).code).toBe(0);

    const proc = Bun.spawnSync(["bun", CLI, "disable", site], { cwd: dir });

    expect(proc.exitCode).toBe(0);
    expect(existsSync(join(site, ".regoro"))).toBe(false);
  });

  // Fail-closed: Kann git die Historie nicht lesen (z.B. "dubious ownership"),
  // ist UNBEKANNT, ob Kundenarbeit darin steckt. countCommits() gibt dann null.
  // Ein früheres `return 0` hätte ein volles Repo für leer gehalten und --purge
  // hätte es gelöscht.
  describe("git verweigert die Auskunft", () => {
    function withFakeGit(args: string[]) {
      const bin = mkdtempSync(join(tmpdir(), "regoro-fg-"));
      writeFileSync(
        join(bin, "git"),
        '#!/bin/sh\n>&2 echo "fatal: detected dubious ownership"\nexit 128\n',
        { mode: 0o755 },
      );
      const proc = Bun.spawnSync(["bun", CLI, "disable", ...args], {
        cwd: dir,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      rmSync(bin, { recursive: true, force: true });
      return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    }

    test("--purge bricht ab und löscht NICHTS", () => {
      makeSite(dir);
      expect(runInit([], { cwd: dir }).code).toBe(0);
      makeEdit(dir); // echte Kundenarbeit im Repo

      const r = withFakeGit(["--purge"]);

      expect(r.code).toBe(1);
      expect(r.stderr).toContain("lässt sich nicht lesen");
      expect(existsSync(join(dir, ".git"))).toBe(true); // Historie gerettet
      expect(existsSync(join(dir, ".regoro", "auth.json"))).toBe(true);
    });

    test("ohne --purge funktioniert das Abschalten trotzdem", () => {
      makeSite(dir);
      expect(runInit([], { cwd: dir }).code).toBe(0);

      const r = withFakeGit([]);

      expect(r.code).toBe(0);
      expect(existsSync(join(dir, ".regoro"))).toBe(false);
      expect(existsSync(join(dir, ".git"))).toBe(true); // unangetastet
      expect(r.stdout).toContain("nicht lesbar");
    });
  });
});

describe("regoro init", () => {
  test("ohne siteDir-Argument: initialisiert das aktuelle Verzeichnis", () => {
    makeSite(dir);
    const r = runInit([], { cwd: dir });

    expect(r.code).toBe(0);
    expect(existsSync(join(dir, ".regoro", "auth.json"))).toBe(true);
    // Der Zielpfad muss sichtbar sein — sonst richtet man den falschen Ordner ein.
    expect(r.stdout).toContain("Site-Verzeichnis:");
    expect(r.stdout).toContain(dir);
  });

  test("nennt die gefundenen Seiten und die hinterlegten Kontaktwege", () => {
    makeSite(dir);
    writeFileSync(join(dir, "impressum.html"), "<html><body><p>Impressum</p></body></html>");
    const r = runInit([], { cwd: dir });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("impressum.html");
    expect(r.stdout).toContain("index.html");
  });

  test("mit explizitem siteDir: initialisiert diesen Ordner, nicht die cwd", () => {
    const site = join(dir, "site");
    mkdirSync(site);
    makeSite(site);
    const other = mkdtempSync(join(tmpdir(), "regoro-cwd-"));

    const r = runInit([site], { cwd: other });

    expect(r.code).toBe(0);
    expect(existsSync(join(site, ".regoro", "auth.json"))).toBe(true);
    expect(existsSync(join(other, ".regoro"))).toBe(false);
    rmSync(other, { recursive: true, force: true });
  });

  test("Guard: bricht ab, wenn keine top-level *.html existiert", () => {
    const r = runInit([], { cwd: dir }); // leerer Ordner

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("keine editierbaren Seiten");
    expect(existsSync(join(dir, ".regoro"))).toBe(false); // nichts angefasst
  });

  test("Guard: --force initialisiert auch ohne Seiten", () => {
    const r = runInit(["--force"], { cwd: dir });

    expect(r.code).toBe(0);
    expect(existsSync(join(dir, ".regoro", "auth.json"))).toBe(true);
  });

  test("Guard: zweites init bricht ab und lässt die Auth-Datei unberührt", () => {
    makeSite(dir);
    expect(runInit([], { cwd: dir }).code).toBe(0);
    const before = Bun.file(join(dir, ".regoro", "auth.json")).size;
    const firstHash = Bun.spawnSync(["cat", join(dir, ".regoro", "auth.json")]).stdout.toString();

    const r = runInit([], { cwd: dir, kennung: "+4917000000000" });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("bereits initialisiert");
    const after = Bun.spawnSync(["cat", join(dir, ".regoro", "auth.json")]).stdout.toString();
    expect(after).toBe(firstHash); // Hash + Secret unverändert
    expect(Bun.file(join(dir, ".regoro", "auth.json")).size).toBe(before);
  });

  test("--force überschreibt die Auth-Datei (neues Secret, Sitzungen ungültig)", () => {
    makeSite(dir);
    expect(runInit([], { cwd: dir }).code).toBe(0);
    const before = Bun.spawnSync(["cat", join(dir, ".regoro", "auth.json")]).stdout.toString();

    const r = runInit(["--force"], { cwd: dir, kennung: "+4917000000000" });

    expect(r.code).toBe(0);
    const after = Bun.spawnSync(["cat", join(dir, ".regoro", "auth.json")]).stdout.toString();
    expect(after).not.toBe(before); // neuer Hash + neues Secret
  });

  test("Auth-Datei ist 0600 und landet NICHT im Baseline-Commit", () => {
    makeSite(dir);
    expect(runInit([], { cwd: dir }).code).toBe(0);

    expect(statSync(join(dir, ".regoro", "auth.json")).mode & 0o777).toBe(0o600);

    const tracked = gitTracked(dir);
    expect(tracked).toContain("index.html");
    expect(tracked.some((f) => f.includes(".regoro"))).toBe(false);
    expect(tracked).toContain(".gitignore");
  });

  // Regression: `git` schlug fehl (z.B. "dubious ownership", wenn der Site-Ordner
  // einem anderen User gehört). Früher lief createAuthFile ZUERST — es blieb ein
  // eine nutzlose Auth-Datei liegen, und der "bereits initialisiert"-Guard blockierte
  // den zweiten Anlauf. Jetzt scheitert init, bevor der Nutzer tippt.
  describe("git schlägt fehl", () => {
    /** Legt ein fake `git` an, das immer mit der echten Meldung fehlschlägt. */
    function fakeGitDir(stderr: string, code = 128): string {
      const bin = mkdtempSync(join(tmpdir(), "regoro-fakegit-"));
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\n>&2 printf '%s\\n' ${JSON.stringify(stderr)}\nexit ${code}\n`,
        { mode: 0o755 },
      );
      return bin;
    }

    function runInitWithFakeGit(bin: string) {
      const proc = Bun.spawnSync(["bun", CLI, "init", "--stdin"], {
        cwd: dir,
        stdin: new TextEncoder().encode(`${TEST_NUMMER}\n`),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      return {
        code: proc.exitCode,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
      };
    }

    test("hinterlässt KEINE auth.json (Einrichtung nicht halb, init wiederholbar)", () => {
      makeSite(dir);
      const bin = fakeGitDir("fatal: not a git repository");

      const r = runInitWithFakeGit(bin);

      expect(r.code).toBe(1);
      expect(existsSync(join(dir, ".regoro", "auth.json"))).toBe(false);
      rmSync(bin, { recursive: true, force: true });
    });

    test("'dubious ownership' wird übersetzt und nennt beide Auswege", () => {
      makeSite(dir);
      const bin = fakeGitDir(`fatal: detected dubious ownership in repository at '${dir}'`);

      const r = runInitWithFakeGit(bin);

      expect(r.code).toBe(1);
      expect(r.stderr).toContain("gehört einem anderen Benutzer");
      expect(r.stderr).toContain("safe.directory");
      expect(r.stderr).toContain("chown");
      expect(existsSync(join(dir, ".regoro", "auth.json"))).toBe(false);
      rmSync(bin, { recursive: true, force: true });
    });

    test("Pfad in der Reparatur-Anweisung ist shell-gequotet", async () => {
      // Der Nutzer kopiert diese Befehle in seine Shell. Ein Pfad mit Leerzeichen
      // oder Metazeichen darf dort nicht zerfallen oder Fremdes ausführen.
      const { shellQuote } = await import("./git.ts");

      expect(shellQuote("/tmp/mein ordner")).toBe("'/tmp/mein ordner'");
      expect(shellQuote("/tmp/a;rm -rf b")).toBe("'/tmp/a;rm -rf b'");
      expect(shellQuote("/tmp/$(whoami)")).toBe("'/tmp/$(whoami)'");
      expect(shellQuote("/tmp/it's")).toBe(`'/tmp/it'\\''s'`);
    });

    test("dubious-ownership-Meldung quotet einen Pfad mit Leerzeichen", () => {
      const spaced = mkdtempSync(join(tmpdir(), "regoro cli space-"));
      makeSite(spaced);
      const bin = fakeGitDir("fatal: detected dubious ownership in repository at '/x'");

      const proc = Bun.spawnSync(["bun", CLI, "init", "--stdin"], {
        cwd: spaced,
        stdin: new TextEncoder().encode(`${TEST_NUMMER}\n`),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      const stderr = proc.stderr.toString();

      expect(proc.exitCode).toBe(1);
      expect(stderr).toContain(`safe.directory '${spaced}'`);
      expect(stderr).toContain(`chown -R "$(id -un)" '${spaced}'`);

      rmSync(bin, { recursive: true, force: true });
      rmSync(spaced, { recursive: true, force: true });
    });

    test("nach behobenem git-Problem läuft init durch (kein Guard blockiert)", () => {
      makeSite(dir);
      const bin = fakeGitDir("fatal: irgendwas");
      expect(runInitWithFakeGit(bin).code).toBe(1);
      rmSync(bin, { recursive: true, force: true });

      // Zweiter Anlauf mit echtem git — darf NICHT an "bereits initialisiert" scheitern.
      const r = runInit([], { cwd: dir });

      expect(r.code).toBe(0);
      expect(existsSync(join(dir, ".regoro", "auth.json"))).toBe(true);
      expect(gitTracked(dir)).toContain("index.html");
    });
  });

  test("ohne Kontaktweg bricht init ab und legt nichts an", () => {
    makeSite(dir);
    const r = runInit([], { cwd: dir, kennung: "   " });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("kein Kontaktweg");
    expect(existsSync(join(dir, ".regoro"))).toBe(false);
  });

  test("eine unbrauchbare Kennung bricht ab, statt sie zu verschlucken", () => {
    makeSite(dir);
    const r = runInit([], { cwd: dir, kennung: "keine-nummer" });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unbrauchbarer Kontaktweg");
    expect(existsSync(join(dir, ".regoro"))).toBe(false);
  });

  test("Nummer und Adresse zusammen werden beide hinterlegt", () => {
    makeSite(dir);
    const r = runInit(["--nummer", "0151 20464812", "--email", "Chef@Firma.de"], { cwd: dir, kennung: "" });
    expect(r.code).toBe(0);
    const gespeichert = JSON.parse(readFileSync(join(dir, ".regoro", "auth.json"), "utf8"));
    expect(gespeichert.nummern).toEqual(["+4915120464812"]);
    expect(gespeichert.emails).toEqual(["chef@firma.de"]);
  });
});

// ===========================================================================
// `regoro serve <sitesRoot>` — Sammelbetrieb
// ===========================================================================
describe("regoro serve", () => {
  /** Startet `serve`, liest die Startausgabe und beendet den Prozess wieder. */
  async function runServeBriefly(args: string[], cwd: string): Promise<string> {
    const proc = Bun.spawn(["bun", CLI, "serve", ...args], {
      cwd,
      env: { ...process.env, PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const dec = new TextDecoder();
    const reader = proc.stdout.getReader();
    let out = "";
    const collect = (async () => {
      while (!out.includes("läuft auf")) {
        const { value, done } = await reader.read();
        if (done) break;
        out += dec.decode(value);
      }
    })();
    await Promise.race([collect, Bun.sleep(8000)]);
    proc.kill();
    await proc.exited;
    return out;
  }

  test("ohne Sammelverzeichnis: Fehler statt cwd zu raten", () => {
    const r = runCli(["serve"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Sammelverzeichnis");
  });

  test("nicht existierendes Verzeichnis → Fehler", () => {
    const r = runCli(["serve", join(dir, "gibt-es-nicht")]);
    expect(r.code).toBe(1);
  });

  test("leeres Sammelverzeichnis → Startfehler, kein Server der alles 404t", () => {
    const r = runCli(["serve", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("keine Website-Ordner");
  });

  test("ungültiger Port → Fehler", () => {
    mkdirSync(join(dir, "kunde-a.test"));
    makeSite(join(dir, "kunde-a.test"));
    const r = runCli(["serve", dir, "--port", "abc"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Port");
  });

  test("Übersicht nennt Seitenzahl, Editor-Zustand und unerreichbare Ordner", async () => {
    mkdirSync(join(dir, "kunde-a.test"));
    makeSite(join(dir, "kunde-a.test"));
    writeFileSync(join(dir, "kunde-a.test", "impressum.html"), "<html><body><p>x</p></body></html>");
    mkdirSync(join(dir, "kunde-b.test"));
    makeSite(join(dir, "kunde-b.test"));
    mkdirSync(join(dir, "backup_alt"));

    const out = await runServeBriefly([dir], dir);
    expect(out).toContain("kunde-a.test");
    expect(out).toContain("2 Seiten");
    expect(out).toContain("kunde-b.test");
    // Ohne init: Editor aus, aber kein Fehler.
    expect(out).toContain("Editor aus");
    // Unerreichbarer Ordnername wird genannt, nicht verschwiegen.
    expect(out).toContain("backup_alt");
    expect(out).toContain("läuft auf");
  }, 20000);
});

describe("regoro serve — Argument-Zerlegung", () => {
  test("ein Verzeichnis, das wie der Portwert heißt, wird nicht verschluckt", () => {
    // `--port` paarweise herausschneiden, nicht nach Textgleichheit filtern:
    // sonst fielen hier BEIDE "8080" weg und das Verzeichnis wäre verloren.
    mkdirSync(join(dir, "8080"));
    const r = runCli(["serve", "8080", "--port", "8080"]);
    expect(r.code).toBe(1);
    // Der Fehler muss der INHALTLICHE sein (leeres Sammelverzeichnis),
    // nicht "serve braucht das Sammelverzeichnis".
    expect(r.stderr).toContain("keine Website-Ordner");
  });

  test("doppeltes --port wird abgelehnt statt still verworfen", () => {
    const r = runCli(["serve", ".", "--port", "8811", "--port", "8822"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--port");
  });

  test("--port ohne Wert wird abgelehnt", () => {
    const r = runCli(["serve", ".", "--port"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--port");
  });

  test("zwei Verzeichnisse sind ein Fehler, kein stilles Ignorieren", () => {
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    const r = runCli(["serve", "a", "b"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("zu viele");
  });
});

// ===========================================================================
// `regoro kennung` — Kontaktwege pflegen
// ===========================================================================
describe("regoro kennung", () => {
  function initSite(): void {
    makeSite(dir);
    expect(runInit([], { cwd: dir }).code).toBe(0);
  }
  const auth = () => JSON.parse(readFileSync(join(dir, ".regoro", "auth.json"), "utf8"));

  test("--list zeigt die Kontaktwege verkuerzt, nie vollstaendig", () => {
    initSite();
    const r = runCli(["kennung", "--list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("+4915…812");
    // Eine Betreiber-Ausgabe landet in Logs und Screenshots.
    expect(r.stdout).not.toContain(TEST_NUMMER);
  });

  test("--add nimmt eine Adresse dazu und laesst das Secret unangetastet", () => {
    initSite();
    const vorher = auth().secret;
    const r = runCli(["kennung", "--add", "Chef@Firma.de"]);
    expect(r.code).toBe(0);
    expect(auth().emails).toEqual(["chef@firma.de"]);
    // Eine hinzugefuegte Kennung darf keine laufende Sitzung beenden.
    expect(auth().secret).toBe(vorher);
  });

  test("--add derselben Kennung in anderer Schreibweise legt keinen zweiten Eintrag an", () => {
    initSite();
    expect(runCli(["kennung", "--add", "0151 20464812"]).code).toBe(0);
    expect(auth().nummern).toEqual([TEST_NUMMER]);
  });

  test("--remove entfernt und laesst das Secret unangetastet", () => {
    initSite();
    runCli(["kennung", "--add", "chef@firma.de"]);
    const vorher = auth().secret;
    const r = runCli(["kennung", "--remove", "0151 20464812"]);
    expect(r.code).toBe(0);
    expect(auth().nummern).toEqual([]);
    expect(auth().emails).toEqual(["chef@firma.de"]);
    expect(auth().secret).toBe(vorher);
  });

  test("--remove der LETZTEN Kennung wird verweigert", () => {
    initSite();
    const r = runCli(["kennung", "--remove", TEST_NUMMER]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("regoro disable");
    // Und die Datei bleibt unberuehrt.
    expect(auth().nummern).toEqual([TEST_NUMMER]);
  });

  test("--remove einer nicht hinterlegten Kennung bricht ab", () => {
    initSite();
    const r = runCli(["kennung", "--remove", "+4917099999999"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("nicht hinterlegt");
  });

  test("unbrauchbare Kennung bricht ab, statt sie zu schlucken", () => {
    initSite();
    const r = runCli(["kennung", "--add", "keine-kennung"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unbrauchbarer Kontaktweg");
  });

  test("ohne Auth-Datei nennt es den Weg dorthin", () => {
    makeSite(dir);
    const r = runCli(["kennung", "--list"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("regoro init");
  });

  test("altes Passwort-Format wird benannt, nicht stillschweigend weiterbetrieben", () => {
    makeSite(dir);
    mkdirSync(join(dir, ".regoro"), { recursive: true });
    writeFileSync(
      join(dir, ".regoro", "auth.json"),
      JSON.stringify({ v: 1, hash: "$argon2id$abc", secret: "x".repeat(32) }),
    );
    const r = runCli(["kennung", "--list"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("alten Passwort-Format");
    expect(r.stderr).toContain("--force");
  });

  test("ein Verzeichnis, das wie eine Kennung heisst, wird nicht verschluckt", () => {
    // Dieselbe Falle wie bei `serve --port`: Positional und Flag-Wert duerfen
    // nicht ueber Textgleichheit unterschieden werden.
    const site = join(dir, "12345678");
    mkdirSync(site);
    makeSite(site);
    expect(runInit([site], { cwd: dir }).code).toBe(0);
    expect(existsSync(join(site, ".regoro", "auth.json"))).toBe(true);
    expect(existsSync(join(dir, ".regoro"))).toBe(false);
  });
});

// ===========================================================================
// `regoro ki` — der BETREIBERWEITE Modellzugang (Contract §0.3, §1)
// ===========================================================================
describe("regoro ki", () => {
  /**
   * Kein Site-Argument, und in den Tests auch nicht /etc/regoro: Der Pfad wird
   * über $CREDENTIALS_DIRECTORY umgelenkt — genau der Weg, den systemd im
   * Betrieb nimmt. Ein Test, der nach /etc schreiben müsste, wäre entweder rot
   * oder gefährlich.
   *
   * `zeilen` sind die Schlüssel-Zeilen für die Standardeingabe, je eine mit
   * Präfix (`modell=…`, `brave=…`, `firecrawl=…`). Nie über argv: Auf diesem
   * Host ist `/proc/<pid>/cmdline` für jeden Prozess lesbar, und die Shell
   * schreibt das Kommando zusätzlich in ihre History.
   */
  function runKi(args: string[], opts: { zeilen?: string[]; creds?: string } = {}) {
    const proc = Bun.spawnSync(["bun", CLI, "ki", ...args], {
      cwd: dir,
      env: { ...process.env, CREDENTIALS_DIRECTORY: opts.creds ?? dir },
      stdin: opts.zeilen === undefined ? undefined : new TextEncoder().encode(`${opts.zeilen.join("\n")}\n`),
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  }

  const gelesen = () => JSON.parse(readFileSync(join(dir, "ki"), "utf8"));

  test("nimmt KEIN Site-Argument — der Modellzugang gilt für alle Kunden", () => {
    // Der Plan widerspricht sich hier; verbindlich ist „betreiberweit". Ein
    // Site-Argument hieße: ein Schlüssel je Kunde, und beim zweiten Kunden
    // fragt sich jemand, warum er ihn nochmal eintragen soll.
    const site = join(dir, "site");
    mkdirSync(site);
    makeSite(site);
    const r = runKi([site, "--stdin"], { zeilen: ["modell=sk-test-0000000000000000"] });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/betreiberweit/i);
    // Und vor allem: kein Schlüssel landet im Kundenordner.
    expect(existsSync(join(site, ".regoro", "ki.json"))).toBe(false);
  });

  test("schreibt die Datei mit 0600 und dem Schlüssel aus stdin", () => {
    const r = runKi(["--stdin"], { zeilen: ["modell=sk-geheim-1234567890123456"] });
    expect(r.code).toBe(0);
    const datei = join(dir, "ki");
    expect(existsSync(datei)).toBe(true);
    expect(statSync(datei).mode & 0o777).toBe(0o600);
    expect(gelesen().apiKey).toBe("sk-geheim-1234567890123456");
  });

  test("der Schlüssel steht nie in argv — nur auf stdin", () => {
    // argv liest jeder Prozess dieses Hosts über /proc, und die Shell-History
    // schreibt ihn auf die Platte.
    const r = runKi(["--key", "sk-in-argv"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--stdin|Verwendung/);
  });

  test("alle drei Schlüssel in einem Zug", () => {
    const r = runKi(["--stdin"], {
      zeilen: ["modell=sk-modell-000000000000000", "brave=brv-000000", "firecrawl=fc-000000"],
    });
    expect(r.code).toBe(0);
    const cfg = gelesen();
    expect(cfg.apiKey).toBe("sk-modell-000000000000000");
    expect(cfg.braveKey).toBe("brv-000000");
    expect(cfg.firecrawlKey).toBe("fc-000000");
  });

  test("die Reihenfolge ist egal — dafür sind die Präfixe da", () => {
    // DER ZWECK DER PRÄFIXE. Bei fester Reihenfolge trägt, wer zwei Zeilen
    // vertauscht, den Brave-Schlüssel als Modellschlüssel ein — und merkt es
    // nie: Die Datei entsteht, der Dienst startet, und erst der erste
    // Kundenlauf scheitert mit einem 401, das niemand zuordnet.
    runKi(["--stdin"], { zeilen: ["modell=sk-modell-000000000000000", "brave=brv-1", "firecrawl=fc-1"] });
    const vorwaerts = gelesen();
    runKi(["--stdin"], { zeilen: ["firecrawl=fc-1", "brave=brv-1", "modell=sk-modell-000000000000000"] });
    expect(gelesen()).toEqual(vorwaerts);
  });

  test("ein Tippfehler im Namen ist ein Fehler, kein stiller fehlender Schlüssel", () => {
    // `model=` statt `modell=`. Würde die Zeile überlesen, entstünde eine Datei
    // ohne Modellschlüssel — und die KI wäre nach dem Einrichten wortlos aus.
    const r = runKi(["--stdin"], { zeilen: ["model=sk-vertippt-00000000000000"] });
    expect(r.code).toBe(1);
    // Die gültigen Namen müssen in der Meldung stehen, sonst rät der Betreiber.
    for (const name of ["modell", "brave", "firecrawl"]) expect(r.stderr).toContain(name);
    expect(existsSync(join(dir, "ki"))).toBe(false);
  });

  test("ein doppeltes Präfix ist ein Fehler — nicht „der letzte gewinnt“", () => {
    // Den letzten gewinnen zu lassen wäre genau die Falle, gegen die die
    // Präfixe angetreten sind: Wer zwei Schlüssel einfügt und einen davon
    // vergisst zu ändern, bekäme lautlos den falschen.
    const r = runKi(["--stdin"], {
      zeilen: ["modell=sk-erster-0000000000000", "modell=sk-zweiter-000000000000"],
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("mehrfach");
    expect(existsSync(join(dir, "ki"))).toBe(false);
  });

  test("`brave=` ohne Wert heißt „kommt von außen“, nicht „nicht eingerichtet“", () => {
    // DIE UNTERSCHEIDUNG, DIE EINMAL VERLOREN GING: Ein leerer Wert wurde zu
    // null, und die Websuche war in der Entwicklung tot — ohne Fehler, ohne
    // Logzeile. Fehlendes Präfix heißt „nicht eingerichtet"; ein leerer Wert
    // heißt „eingerichtet, Schlüssel hängt ein Proxy an".
    const r = runKi(["--stdin"], { zeilen: ["modell=sk-modell-000000000000000", "brave="] });
    expect(r.code).toBe(0);
    expect(gelesen().braveKey).toBe("");
    expect(gelesen().firecrawlKey).toBeNull(); // Präfix fehlte ganz
    // Und der Betreiber sieht den Unterschied auch in der Ausgabe.
    expect(r.stdout).toMatch(/Websuche:.*von außen/);
    expect(r.stdout).toMatch(/Seitenabruf:.*nicht eingerichtet/);
  });

  test("`modell=` ohne Wert wird abgewiesen — dafür gibt es --key-from-proxy", () => {
    // Anders als bei brave/firecrawl: Eine Datei mit leerem apiKey verwirft
    // loadKiConfig wegen zu kurzem Schlüssel, und die KI wäre nach dem
    // Einrichten wortlos aus.
    const r = runKi(["--stdin"], { zeilen: ["modell="] });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--key-from-proxy");
    expect(existsSync(join(dir, "ki"))).toBe(false);
  });

  test("kein Fehlerlauf hinterlässt eine halbe Datei", () => {
    // Alle Prüfungen müssen zuschlagen, BEVOR geschrieben wird. Eine Datei aus
    // einem abgebrochenen Lauf wäre schlimmer als keine: Sie sieht eingerichtet
    // aus und ist es nicht.
    const fehlerlaeufe: string[][] = [
      ["ohne-praefix"],
      ["model=sk-vertippt-00000000000000"],
      ["modell=a", "modell=b"],
      ["modell="],
    ];
    for (const zeilen of fehlerlaeufe) {
      expect(runKi(["--stdin"], { zeilen }).code).toBe(1);
      expect(`${zeilen.join("|")}: ${existsSync(join(dir, "ki"))}`).toBe(`${zeilen.join("|")}: false`);
    }
  });

  test("Vorgaben für Modell und baseUrl, überschreibbar", () => {
    runKi(["--stdin"], { zeilen: ["modell=sk-a-00000000000000000000"] });
    expect(gelesen().baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(gelesen().model).toBe("z-ai/glm-5.3-flash");

    runKi(["--stdin", "--model", "z-ai/glm-4.6", "--base-url", "https://cortecs.ai/v1"], {
      zeilen: ["modell=sk-b-00000000000000000000"],
    });
    expect(gelesen().model).toBe("z-ai/glm-4.6");
    expect(gelesen().baseUrl).toBe("https://cortecs.ai/v1");
  });

  test("eine Schlüsselrotation lässt Endpunkt, Modell und die anderen Schlüssel stehen", () => {
    // DER CORTECS-FALL, und der Grund, warum dieser Test wichtiger ist als er
    // aussieht. Vorher ersetzte jeder Aufruf die ganze Datei: Eine
    // Routine-Rotation des Modellschlüssels löschte Brave und Firecrawl UND
    // setzte baseUrl und model auf die Vorgaben zurück.
    //
    // Die zwei fehlenden Schlüssel merkt man beim nächsten Lauf. Den stillen
    // Rückfall von Cortecs auf OpenRouter merkt NIEMAND — und damit hat sich
    // der Verarbeitungsort geändert, bei einem Betreiber, der ihn bewusst in
    // die EU gelegt hatte. Sichtbar nur in `--list`, wo nach einer Rotation
    // niemand hinsieht.
    runKi(["--stdin", "--base-url", "https://cortecs.ai/v1", "--model", "z-ai/glm-4.6"], {
      zeilen: ["modell=sk-alt-0000000000000000000", "brave=brv-bleibt", "firecrawl=fc-bleibt"],
    });
    const vorher = gelesen();

    // Die Rotation: nur der Modellschlüssel, sonst nichts.
    const r = runKi(["--stdin"], { zeilen: ["modell=sk-neu-0000000000000000000"] });
    expect(r.code).toBe(0);

    const nachher = gelesen();
    expect(nachher.apiKey).toBe("sk-neu-0000000000000000000"); // geändert
    expect(nachher.baseUrl).toBe(vorher.baseUrl); // und sonst NICHTS
    expect(nachher.model).toBe(vorher.model);
    expect(nachher.braveKey).toBe("brv-bleibt");
    expect(nachher.firecrawlKey).toBe("fc-bleibt");
  });

  test("nur den Endpunkt ändern geht ohne Modellschlüssel", () => {
    // Beim ÄNDERN eines bestehenden Zugangs ist ein Aufruf ohne `modell=` in
    // Ordnung — sonst müsste der Betreiber den Schlüssel jedes Mal wieder
    // durch die Standardeingabe schicken, nur um den Endpunkt zu wechseln.
    runKi(["--stdin"], { zeilen: ["modell=sk-alt-0000000000000000000"] });
    const r = runKi(["--base-url", "https://cortecs.ai/v1"]);
    expect(r.code).toBe(0);
    expect(gelesen().baseUrl).toBe("https://cortecs.ai/v1");
    expect(gelesen().apiKey).toBe("sk-alt-0000000000000000000");
  });

  test("`--ohne brave` schaltet ab, ein leeres `brave=` schaltet wieder an", () => {
    // Die drei Zustände eines Nebendienstes, in der Reihenfolge, in der ein
    // Betreiber sie durchläuft. Ohne `--ohne` gäbe es keinen Weg zurück nach
    // `null`: Ein einmal gesetzter Schlüssel bliebe für immer stehen, weil ein
    // fehlendes Präfix „unverändert" heißt und nicht „weg".
    runKi(["--stdin"], { zeilen: ["modell=sk-a-00000000000000000000", "brave=brv-1"] });
    expect(gelesen().braveKey).toBe("brv-1");

    expect(runKi(["--ohne", "brave"]).code).toBe(0);
    expect(gelesen().braveKey).toBeNull(); // nicht eingerichtet

    expect(runKi(["--stdin"], { zeilen: ["brave="] }).code).toBe(0);
    expect(gelesen().braveKey).toBe(""); // eingerichtet, Schlüssel von außen
  });

  test("`--ohne modell` wird abgewiesen und nennt die zwei richtigen Wege", () => {
    // Ohne Modellzugang gibt es keine KI — das ist kein Nebendienst, den man
    // einzeln abschaltet. Wer es versucht, meint eines von zwei anderen Dingen,
    // und beide müssen in der Meldung stehen, sonst rät er.
    runKi(["--stdin"], { zeilen: ["modell=sk-a-00000000000000000000"] });
    const r = runKi(["--ohne", "modell"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--off");
    expect(r.stderr).toContain("--key-from-proxy");
    expect(gelesen().apiKey).toBe("sk-a-00000000000000000000"); // unangetastet
  });

  test("derselbe Name auf stdin UND in --ohne ist ein Fehler", () => {
    // Eine der beiden Angaben stillschweigend gewinnen zu lassen wäre dieselbe
    // Falle wie „der letzte gewinnt" beim doppelten Präfix.
    runKi(["--stdin"], { zeilen: ["modell=sk-a-00000000000000000000"] });
    const r = runKi(["--stdin", "--ohne", "brave"], { zeilen: ["brave=brv-1"] });
    expect(r.code).toBe(1);
  });

  test("--off entfernt die Datei — und damit die Seitenleiste bei allen Kunden", () => {
    runKi(["--stdin"], { zeilen: ["modell=sk-a-00000000000000000000"] });
    expect(runKi(["--off"]).code).toBe(0);
    expect(existsSync(join(dir, "ki"))).toBe(false);
  });

  test("`regoro disable` rührt die betreiberweite Datei NICHT an", () => {
    // Sonst schaltete das Abschalten eines einzelnen Kunden die KI für alle ab.
    makeSite(dir);
    runInit([], { cwd: dir });
    runKi(["--stdin"], { zeilen: ["modell=sk-a-00000000000000000000"] });
    const proc = Bun.spawnSync(["bun", CLI, "disable", dir], {
      cwd: dir,
      env: { ...process.env, CREDENTIALS_DIRECTORY: dir },
      stdin: new TextEncoder().encode("ja\n"),
    });
    expect(proc.exitCode).toBe(0);
    expect(existsSync(join(dir, "ki"))).toBe(true);
  });
});

// ===========================================================================
// `regoro integration` — die Schlüssel des KUNDEN, pro Site
// ===========================================================================
describe("regoro integration", () => {
  function runInteg(args: string[], key?: string) {
    const proc = Bun.spawnSync(["bun", CLI, "integration", ...args], {
      cwd: dir,
      stdin: key === undefined ? undefined : new TextEncoder().encode(`${key}\n`),
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  }

  beforeEach(() => {
    makeSite(dir);
    runInit([], { cwd: dir });
  });

  test("legt eine benannte Integration an, Datei 0600", () => {
    const r = runInteg([dir, "stripe", "--base-url", "https://api.stripe.com", "--key-stdin"], "rk_live_geheim");
    expect(r.code).toBe(0);
    const datei = join(dir, ".regoro", "integrationen.json");
    expect(statSync(datei).mode & 0o777).toBe(0o600);
    const inhalt = JSON.parse(readFileSync(datei, "utf8"));
    expect(inhalt.integrationen.stripe.baseUrl).toBe("https://api.stripe.com");
  });

  test("--list zeigt den Schlüssel NIE, auch nicht gekürzt", () => {
    // Bei kurzen Schlüsseln sind schon die letzten vier Zeichen zu viel. Nur
    // „gesetzt/nicht gesetzt" plus Anlagedatum.
    runInteg([dir, "stripe", "--base-url", "https://api.stripe.com", "--key-stdin"], "rk_live_geheim");
    const r = runInteg([dir, "--list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("stripe");
    expect(r.stdout).not.toContain("rk_live_geheim");
    expect(r.stdout).not.toContain("geheim");
    expect(r.stdout).not.toContain("live");
  });

  test("--off entfernt genau eine Integration, die andere bleibt", () => {
    runInteg([dir, "stripe", "--base-url", "https://api.stripe.com", "--key-stdin"], "rk_a");
    runInteg([dir, "brevo", "--base-url", "https://api.brevo.com", "--key-stdin"], "rk_b");
    expect(runInteg([dir, "stripe", "--off"]).code).toBe(0);
    const inhalt = JSON.parse(readFileSync(join(dir, ".regoro", "integrationen.json"), "utf8"));
    expect(Object.keys(inhalt.integrationen)).toEqual(["brevo"]);
  });

  test("eine baseUrl ohne https wird abgelehnt", () => {
    const r = runInteg([dir, "unsicher", "--base-url", "http://api.example.de", "--key-stdin"], "k");
    expect(r.code).toBe(1);
    expect(existsSync(join(dir, ".regoro", "integrationen.json"))).toBe(false);
  });

  test("--browser-herkunft nimmt nur absolute https-Origins", () => {
    const gut = runInteg(
      [dir, "stripe", "--base-url", "https://api.stripe.com", "--browser-herkunft", "https://js.stripe.com", "--key-stdin"],
      "k",
    );
    expect(gut.code).toBe(0);
    const schlecht = runInteg(
      [dir, "boese", "--base-url", "https://api.example.de", "--browser-herkunft", "js.stripe.com", "--key-stdin"],
      "k",
    );
    expect(schlecht.code).toBe(1);
  });

  test("integrationen.json ist gitignored wie auth.json", () => {
    runInteg([dir, "stripe", "--base-url", "https://api.stripe.com", "--key-stdin"], "k");
    expect(gitTracked(dir)).not.toContain(".regoro/integrationen.json");
  });
});

// ===========================================================================
// Lizenzen und der versteckte Worker-Unterbefehl
// ===========================================================================
describe("regoro licenses / agent-worker", () => {
  test("licenses druckt die mitgelieferte Hinweisdatei", () => {
    // Rechtspflicht, keine Fleißaufgabe: Ein --compile-Binary trägt von sich aus
    // keine einzige der Lizenzdateien seiner Abhängigkeiten.
    const r = runCli(["licenses"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("MIT");
    expect(r.stdout.length).toBeGreaterThan(1000);
  });

  test("agent-worker steht nicht in --help", () => {
    // Er ist eine interne Wiedereinsprungstelle des eigenen Binaries, kein
    // Bedienbefehl. In der Hilfe zu stehen lädt nur zum Herumprobieren ein.
    expect(runCli(["--help"]).stdout).not.toContain("agent-worker");
  });

  test("agent-worker ohne die nötige Umgebung bricht ab, statt irgendetwas zu tun", () => {
    const r = runCli(["agent-worker"]);
    expect(r.code).not.toBe(0);
  });
});

// ===========================================================================
// Das KOMPILIERTE Binary — die Lücke, die `bun test` sonst offen lässt
// ===========================================================================
describe("das kompilierte Binary", () => {
  /**
   * WARUM DAS EIN EIGENER TEST SEIN MUSS. Die ganze übrige Suite fährt den
   * dev-Pfad: dort liest `host.ts` das Overlay aus einer echten Datei. Im
   * `--compile`-Binary liegt es unter `/$bunfs`, und ein Rückbau auf
   * `import.meta.url` zeigt dort ins Leere. Der Editor wäre dann **stumm
   * funktionslos** — die Seite lädt, die Leiste erscheint nie, und keine
   * einzige Zusicherung dieser Suite bricht.
   *
   * CLAUDE.md verlangt diese Prüfung seit Langem von Hand („Binary bauen,
   * PATH=/usr/bin:/bin, init + run, /edit-assets/overlay.js muss 200 liefern").
   * Von Hand heißt: irgendwann macht es niemand mehr.
   *
   * `env -i` ist kein Beiwerk: Der Kundenhost hat weder bun noch node noch ein
   * HOME. Ein Binary, das sich still auf eines davon stützt, fiele erst dort auf.
   */
  const BIN = join(tmpdir(), `regoro-bintest-${process.pid}`);

  /**
   * GEBAUT WIRD AUF MODULEBENE, nicht in `beforeAll`.
   *
   * `test.skipIf(bedingung)` wertet die Bedingung beim EINSAMMELN der Tests aus
   * — also bevor irgendein `beforeAll` gelaufen ist. Mit einem dort gesetzten
   * Flag sind alle Fälle dauerhaft übersprungen, und `bun test` meldet fröhlich
   * grün. Genau die Klasse Fehler, gegen die dieser Block angetreten ist: Der
   * Test existiert, läuft nie, und niemand merkt es.
   */
  const gebaut: boolean = (() => {
    const res = Bun.spawnSync(
      ["bun", "build", "--compile", new URL("./cli.ts", import.meta.url).pathname, "--outfile", BIN],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    if (res.exitCode !== 0 || !existsSync(BIN)) {
      console.warn(`[test] Binary-Bau fehlgeschlagen: ${new TextDecoder().decode(res.stderr).slice(0, 400)}`);
      return false;
    }
    return true;
  })();

  afterAll(() => {
    rmSync(BIN, { force: true });
  });

  /** Ohne bun/node im PATH und ohne HOME — wie auf dem Kundenhost. */
  function nackt(args: string[], opts: { cwd?: string; stdin?: string } = {}) {
    const proc = Bun.spawnSync([BIN, ...args], {
      cwd: opts.cwd ?? dir,
      env: { PATH: "/usr/bin:/bin" },
      stdin: opts.stdin === undefined ? undefined : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: proc.exitCode,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    };
  }

  test("es baut überhaupt", () => {
    expect(gebaut).toBe(true);
    expect(statSync(BIN).size).toBeGreaterThan(50 * 1024 * 1024);
  });

  test.skipIf(!gebaut)("läuft ohne bun, ohne node, ohne HOME", () => {
    const r = nackt(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test.skipIf(!gebaut)("liefert /edit-assets/overlay.js aus dem eingebetteten Asset", async () => {
    // DER KERN DIESES TESTS. 404 hier heißt: der Editor ist in Produktion tot.
    const site = join(dir, "site");
    mkdirSync(site);
    makeSite(site);
    expect(nackt(["init", site, "--nummer", TEST_NUMMER]).code).toBe(0);

    const port = 18_900 + (process.pid % 500);
    const server = Bun.spawn([BIN, "run", site], {
      env: { PATH: "/usr/bin:/bin", PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      let antwort: Response | null = null;
      for (let i = 0; i < 100 && antwort === null; i++) {
        try {
          antwort = await fetch(`http://127.0.0.1:${port}/edit-assets/overlay.js`);
        } catch {
          await Bun.sleep(100);
        }
      }
      expect(antwort).not.toBeNull();
      expect(antwort!.status).toBe(200);
      const js = await antwort!.text();
      // Nicht nur 200: eine leere Antwort mit 200 wäre derselbe stumme Ausfall.
      expect(js.length).toBeGreaterThan(50_000);
      expect(js).toContain("__regoro");

      // Und die öffentliche Seite steht auch.
      const seite = await fetch(`http://127.0.0.1:${port}/index.html`);
      expect(seite.status).toBe(200);
      await seite.text();
    } finally {
      server.kill();
      await server.exited;
    }
  }, 60_000);

  test.skipIf(!gebaut)("`licenses` findet die eingebettete Hinweisdatei", () => {
    // Zweites Asset nach demselben Muster (`with { type: "file" }`). Es bricht
    // genauso lautlos und ist zugleich eine Rechtspflicht.
    const r = nackt(["licenses"]);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(1000);
    // Keine Bau-Pfade in der ausgelieferten Datei.
    expect(r.stdout).not.toContain("node_modules/");
    expect(r.stdout).not.toContain("/srv/work/repos");
  });

  test.skipIf(!gebaut)("der versteckte agent-worker existiert im Binary", () => {
    // Der Worker ist DASSELBE Binary mit einem anderen ersten Argument. Fehlt
    // der Unterbefehl dort, scheitert jeder Agentenlauf erst in Produktion.
    const r = nackt(["agent-worker"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).not.toContain("Unbekannter Befehl");
  });
});
