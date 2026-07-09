/**
 * CLI-Ebene (`regoro-edit init`) — bewusst als Subprozess, weil hier genau die
 * Verdrahtung geprüft wird, die reine Unit-Tests von createAuthFile/ensureRepo
 * nicht abdecken: Argument-Defaults (cwd), Guards und vor allem die Reihenfolge
 * ensureGitignore → ensureRepo → createAuthFile. Sie hält das HMAC-Secret aus dem
 * Baseline-Commit (auth.json existiert beim Commit noch nicht) UND sorgt dafür,
 * dass ein fehlschlagendes git kein nutzloses Passwort hinterlässt.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, statSync } from "node:fs";
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

/** Führt `bun cli.ts <args>` mit cwd aus und füttert das Passwort über stdin. */
function runInit(args: string[], opts: { cwd?: string; password?: string } = {}) {
  const proc = Bun.spawnSync(["bun", CLI, "init", ...args, "--password-stdin"], {
    cwd: opts.cwd ?? dir,
    stdin: new TextEncoder().encode(opts.password ?? "geheim123"),
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

describe("regoro init", () => {
  test("ohne siteDir-Argument: initialisiert das aktuelle Verzeichnis", () => {
    makeSite(dir);
    const r = runInit([], { cwd: dir });

    expect(r.code).toBe(0);
    expect(existsSync(join(dir, ".regoro", "auth.json"))).toBe(true);
    // Der Zielpfad muss sichtbar sein — sonst tippt man ein Passwort ins Blinde.
    expect(r.stdout).toContain("Site-Verzeichnis:");
    expect(r.stdout).toContain(dir);
  });

  test("nennt die gefundenen Seiten vor der Passwortabfrage", () => {
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

    const r = runInit([], { cwd: dir, password: "anderes-passwort" });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("bereits initialisiert");
    const after = Bun.spawnSync(["cat", join(dir, ".regoro", "auth.json")]).stdout.toString();
    expect(after).toBe(firstHash); // Hash + Secret unverändert
    expect(Bun.file(join(dir, ".regoro", "auth.json")).size).toBe(before);
  });

  test("--force überschreibt die Auth-Datei (Passwort neu setzen)", () => {
    makeSite(dir);
    expect(runInit([], { cwd: dir }).code).toBe(0);
    const before = Bun.spawnSync(["cat", join(dir, ".regoro", "auth.json")]).stdout.toString();

    const r = runInit(["--force"], { cwd: dir, password: "neues-passwort" });

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
  // nutzloses Passwort liegen, und der "bereits initialisiert"-Guard blockierte
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
      const proc = Bun.spawnSync(["bun", CLI, "init", "--password-stdin"], {
        cwd: dir,
        stdin: new TextEncoder().encode("geheim123"),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      return {
        code: proc.exitCode,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
      };
    }

    test("hinterlässt KEINE auth.json (Passwort nicht verloren, init wiederholbar)", () => {
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

  test("leeres Passwort über stdin wird abgelehnt", () => {
    makeSite(dir);
    const r = runInit([], { cwd: dir, password: "   " });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("leeres Passwort");
    expect(existsSync(join(dir, ".regoro"))).toBe(false);
  });
});
