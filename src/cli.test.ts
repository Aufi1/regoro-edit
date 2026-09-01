/**
 * CLI-Ebene (`regoro-edit init`) — bewusst als Subprozess, weil hier genau die
 * Verdrahtung geprüft wird, die reine Unit-Tests von createAuthFile/ensureRepo
 * nicht abdecken: Argument-Defaults (cwd), Guards und vor allem die Reihenfolge
 * ensureGitignore → ensureRepo → createAuthFile. Sie hält das HMAC-Secret aus dem
 * Baseline-Commit (auth.json existiert beim Commit noch nicht) UND sorgt dafür,
 * dass ein fehlschlagendes git keine nutzlose Auth-Datei hinterlässt.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
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
