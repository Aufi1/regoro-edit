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
 * Single-Site-Modus: repoRoot === siteDir, sitePrefix==="" → pagePath="index.html".
 *
 * Erwartung (nach dem Fix): ROT bis cli.ts init einen Baseline-Commit anlegt.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as git from "./git.ts";

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
    cmd: [process.execPath, CLI_PATH, "init", siteDir, "--password-stdin"],
    cwd: REPO_ROOT,
    stdin: Buffer.from("testpw123456\n"),
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

  beforeAll(() => {
    siteDir = makeTmpSite();
    const r = runInit(siteDir);
    expect(r.exitCode).toBe(0);
  });

  test("nach init existiert ein Baseline-Commit mit pristine index.html", () => {
    // Single-Site-Modus: repoRoot === siteDir, pagePath === "index.html".
    const versions = git.listVersions(siteDir, "index.html");
    // Es MUSS mindestens ein Commit existieren, der index.html enthält.
    expect(versions.length).toBeGreaterThanOrEqual(1);
    // Der älteste Commit (Baseline) MUSS den pristine Inhalt P halten.
    const baseline = versions[versions.length - 1]!;
    expect(git.showVersion(siteDir, baseline.commit, "index.html")).toBe(PRISTINE);
  });

  test("erster Save bekommt eigene Version; pristine bleibt erhalten", () => {
    // Baseline (ältester Commit, hält P) vor dem Save festhalten.
    const before = git.listVersions(siteDir, "index.html");
    expect(before.length).toBeGreaterThanOrEqual(1);
    const baseline = before[before.length - 1]!;
    expect(git.showVersion(siteDir, baseline.commit, "index.html")).toBe(PRISTINE);

    // Ersten Save faithful nachstellen: Datei überschreiben + commitEdit
    // (genau die git-Sequenz, die host.ts handleSave nach dem Schreiben nutzt).
    writeFileSync(join(siteDir, "index.html"), EDITED, "utf8");
    git.commitEdit(siteDir, "index.html", "Inline-Edit");

    // Jetzt MUSS es >= 2 Versionen geben (Baseline + erster Edit).
    const after = git.listVersions(siteDir, "index.html");
    expect(after.length).toBeGreaterThanOrEqual(2);

    // Und der Baseline-Commit hält weiterhin den pristine Original-Inhalt P.
    expect(git.showVersion(siteDir, baseline.commit, "index.html")).toBe(PRISTINE);
  });

  test(".regoro/auth.json wird NICHT von git getrackt", () => {
    const tracked = lsFiles(siteDir);
    expect(tracked.some((p) => p.includes(".regoro"))).toBe(false);
  });
});
