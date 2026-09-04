/**
 * v9 — Regressionstest: `init` MUSS einen pristine-Baseline-Commit anlegen.
 *
 * BUG (Phase-5/E2E): `cli.ts init` macht nur `git init`, KEINEN Baseline-Commit
 * der unberührten Site. Beim allerersten Save überschreibt host.ts handleSave
 * zuerst die Datei und ruft DANN ensureRepo → der "Baseline"-Commit erfasst
 * bereits den editierten Stand → der pristine Originalstand landet in keinem
 * Commit, und der erste Edit bekommt keine eigene Version.
 *
 * Dieser Test führt die ECHTE CLI als Subprozess aus (faithful, kein Mock von
 * ensureRepo VOR dem Edit — genau das maskiert den Bug in den anderen Tests).
 *
 * SEIT DEM ENTWURFS-UMBAU zeigt die Zusicherung auf ein anderes Repo: Der
 * repoRoot ist `<siteDir>/.regoro/entwurf`, nicht mehr der Site-Ordner
 * (Invariante 9). Das ist nicht bloß eine Pfadanpassung — der Test war vorher
 * an einer Stelle grün, WEIL es dort kein Repo mehr gab: `git ls-files` liefert
 * auf einem Nicht-Repo eine leere Liste, und „keine getrackte Datei enthält
 * .regoro" ist dann trivial erfüllt. Deshalb steht jetzt neben jeder
 * Abwesenheits-Prüfung eine Gegenprobe, die zeigt, dass überhaupt gemessen wird.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as git from "./git.ts";
import { entwurfPfad } from "./entwurf.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const CLI_PATH = join(import.meta.dir, "cli.ts");

// Pristine-Inhalt P der index.html — markant, damit wir ihn exakt wiederfinden.
const PRISTINE = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Pristine</title></head>
<body><h1 data-edit-idx="0">ORIGINAL-PRISTINE-MARKER</h1></body></html>\n`;

const EDITED = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Pristine</title></head>
<body><h1 data-edit-idx="0">GEAENDERTER-INHALT</h1></body></html>\n`;

const tmpRoots: string[] = [];

function makeTmpSite(): string {
  const dir = mkdtempSync(join(tmpdir(), "regoro-v9-init-"));
  tmpRoots.push(dir);
  writeFileSync(join(dir, "index.html"), PRISTINE, "utf8");
  return dir;
}

/** Führt die echte CLI `init <site> --password-stdin` aus (Passwort via stdin). */
function runInit(siteDir: string): { exitCode: number; stderr: string } {
  const res = Bun.spawnSync({
    // process.execPath = die laufende bun-Binary (robust gegen PATH-Unterschiede,
    // gleiches Muster wie der Subprozess-Test in v2.test.ts).
    cmd: [process.execPath, CLI_PATH, "init", siteDir, "--stdin"],
    cwd: REPO_ROOT,
    stdin: Buffer.from("+4915120464812\n"),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: res.exitCode,
    stderr: new TextDecoder().decode(res.stderr),
  };
}

/** git ls-files im siteDir (welche Pfade sind getrackt?). */
function lsFiles(siteDir: string): string[] {
  const res = Bun.spawnSync(["git", "-C", siteDir, "ls-files"]);
  return new TextDecoder()
    .decode(res.stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("cli init — pristine Baseline-Commit (Regression)", () => {
  let siteDir: string;
  /**
   * Der repoRoot ist seit dem Entwurfs-Umbau NICHT mehr der Site-Ordner,
   * sondern `<siteDir>/.regoro/entwurf` (Invariante 9). Die Zusicherung dieses
   * Tests ist unverändert — sie gilt nur für ein anderes Repo.
   */
  let repo: string;

  beforeAll(() => {
    siteDir = makeTmpSite();
    const r = runInit(siteDir);
    expect(r.exitCode).toBe(0);
    repo = entwurfPfad(siteDir);
  });

  test("init legt überhaupt ein Entwurfs-Repo an", () => {
    // GEGENPROBE ZU ALLEM UNTEN: Ohne sie prüften die folgenden Tests ein Repo,
    // das es nicht gibt — und `lsFiles` auf einem Nicht-Repo liefert eine leere
    // Liste, was den auth.json-Test unten grün machte, ohne irgendetwas zu
    // messen. Genau so war er vor diesem Umbau grün.
    expect(existsSync(join(repo, ".git"))).toBe(true);
    expect(existsSync(join(repo, "index.html"))).toBe(true);
  });

  test("im Site-Ordner selbst entsteht KEIN Repo", () => {
    // Ein `.git` dort ist seit dem Umbau das Kennzeichen einer alten,
    // nicht migrierten Installation — `istNichtMigriert()` schaltet den Editor
    // dafür auf 404. Legte `init` es selbst an, wäre der Editor nach jeder
    // frischen Einrichtung tot, und zwar stumm.
    expect(existsSync(join(siteDir, ".git"))).toBe(false);
  });

  test("nach init existiert ein Baseline-Commit mit pristine index.html", () => {
    const versions = git.listVersions(repo, "index.html");
    // Es MUSS mindestens ein Commit existieren, der index.html enthält.
    expect(versions.length).toBeGreaterThanOrEqual(1);
    // Der älteste Commit (Baseline) MUSS den pristine Inhalt P halten.
    const baseline = versions[versions.length - 1]!;
    expect(git.showVersion(repo, baseline.commit, "index.html")).toBe(PRISTINE);
  });

  test("erster Save bekommt eigene Version; pristine bleibt erhalten", () => {
    // Baseline (ältester Commit, hält P) vor dem Save festhalten.
    const before = git.listVersions(repo, "index.html");
    expect(before.length).toBeGreaterThanOrEqual(1);
    const baseline = before[before.length - 1]!;
    expect(git.showVersion(repo, baseline.commit, "index.html")).toBe(PRISTINE);

    // Ersten Save faithful nachstellen: Datei überschreiben + commitEdit
    // (genau die git-Sequenz, die host.ts handleSave nach dem Schreiben nutzt).
    // Geschrieben wird in den ARBEITSBAUM DES ENTWURFS, denn dorthin schreibt
    // der Editor jetzt.
    writeFileSync(join(repo, "index.html"), EDITED, "utf8");
    git.commitEdit(repo, "index.html", "Inline-Edit");

    // Jetzt MUSS es >= 2 Versionen geben (Baseline + erster Edit).
    const after = git.listVersions(repo, "index.html");
    expect(after.length).toBeGreaterThanOrEqual(2);

    // Und der Baseline-Commit hält weiterhin den pristine Original-Inhalt P.
    expect(git.showVersion(repo, baseline.commit, "index.html")).toBe(PRISTINE);
  });

  test(".regoro/auth.json wird NICHT von git getrackt", () => {
    const tracked = lsFiles(repo);
    // Gegenprobe, dass hier überhaupt gemessen wird: Das Repo trackt etwas.
    expect(tracked).toContain("index.html");
    expect(tracked.some((p) => p.includes(".regoro"))).toBe(false);
  });

  test("DAS SITZUNGS-GEHEIMNIS STEHT IN KEINEM COMMIT DES ENTWURFS-REPOS", () => {
    /**
     * Die eigentliche Zusicherung der Invariante 2 zur `init`-Reihenfolge:
     * Der Baseline-Commit entsteht, bevor `auth.json` existiert, also kann das
     * Geheimnis gar nicht hineingeraten.
     *
     * Sie wird hier nicht angenommen, sondern gemessen — und zwar über die
     * GESAMTE Historie, nicht nur über die Dateiliste. Eine Datei kann
     * untracked sein und ihr Inhalt trotzdem in einem früheren Commit stehen.
     *
     * Nach dem Umbau trägt die Reihenfolge sogar besser als vorher: Der
     * Arbeitsbaum des Entwurfs-Repos enthält `.regoro/` gar nicht, weil
     * `siteDateien()` Punkt-Segmente überspringt.
     */
    const auth = JSON.parse(readFileSync(join(siteDir, ".regoro", "auth.json"), "utf8")) as {
      secret: string;
    };
    expect(auth.secret.length).toBeGreaterThanOrEqual(32); // Gegenprobe: es GIBT ein Geheimnis

    const alleInhalte = new TextDecoder().decode(
      Bun.spawnSync(["git", "-C", repo, "log", "-p", "--all"]).stdout,
    );
    expect(alleInhalte).toContain("index.html"); // Gegenprobe: das Log ist nicht leer
    expect(alleInhalte).not.toContain(auth.secret);
  });
});
