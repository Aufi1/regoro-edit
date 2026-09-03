/**
 * `regoro disable` bei LAUFENDEM Server.
 *
 * startServer lädt auth.json im Einzelbetrieb einmalig in den ctx. Verschwindet die Datei danach,
 * muss der Editor sofort aus sein — sonst editieren gültige Cookies weiter,
 * obwohl der Betreiber den Zugang entzogen hat. Der Guard sitzt in server.ts
 * (nicht im Router), deshalb wird hier gegen einen echten Server getestet.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.ts";
import { createAuthFile, AUTH_DIR_NAME } from "./auth.ts";
import { attrappenVersand } from "./versand.ts";
import { meldeAn } from "./anmeldung.testhelfer.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");
const KENNUNG_PASSWORD = "+4915120464812";
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function bootSite() {
  const siteDir = mkdtempSync(join(tmpdir(), "regoro-live-"));
  dirs.push(siteDir);
  cpSync(REAL_SITE, siteDir, { recursive: true });
  // Öffentliche Seite, deren Name mit "edit" beginnt — darf keine Editor-Route sein.
  writeFileSync(join(siteDir, "edit-preise.html"), "<html><body><p>Preise</p></body></html>");
  await createAuthFile(siteDir, [KENNUNG_PASSWORD]);

  const versand = attrappenVersand();
  const { port } = startServer({ siteDir, repoRoot: siteDir, port: 0, versand });
  const base = `http://localhost:${port}`;
  const cookie = await meldeAn(base, KENNUNG_PASSWORD, versand);

  return { siteDir, base, cookie };
}

const status = (base: string, path: string, cookie?: string) =>
  fetch(base + path, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  }).then((r) => r.status);

describe("disable bei laufendem Server", () => {
  test("entfernte auth.json schaltet /edit* sofort ab — ohne Neustart", async () => {
    const { siteDir, base, cookie } = await bootSite();

    expect(await status(base, "/edit", cookie)).toBe(200);
    expect(await status(base, "/edit/login")).toBe(200);
    expect(await status(base, "/edit-assets/overlay.js")).toBe(200);

    // == was `regoro disable` tut ==
    rmSync(join(siteDir, AUTH_DIR_NAME), { recursive: true, force: true });

    expect(await status(base, "/edit", cookie)).toBe(404); // gültiges Cookie reicht nicht mehr
    expect(await status(base, "/edit/login")).toBe(404);
    expect(await status(base, "/edit-assets/overlay.js")).toBe(404);
    expect(await status(base, "/index.html/edit", cookie)).toBe(404);
  });

  test("die öffentliche Website läuft danach weiter", async () => {
    const { siteDir, base } = await bootSite();
    rmSync(join(siteDir, AUTH_DIR_NAME), { recursive: true, force: true });

    expect(await status(base, "/")).toBe(200);
    expect(await status(base, "/index.html")).toBe(200);
    expect(await status(base, "/styles.css")).toBe(200);
  });

  test("eine Seite namens edit-*.html ist keine Editor-Route", async () => {
    const { siteDir, base } = await bootSite();

    expect(await status(base, "/edit-preise.html")).toBe(200);
    rmSync(join(siteDir, AUTH_DIR_NAME), { recursive: true, force: true });

    // Trotz abgeschaltetem Editor bleibt sie eine normale Seite.
    expect(await status(base, "/edit-preise.html")).toBe(200);
  });

  test("ohne auth.json von Anfang an: Editor aus, Site an (unverändert)", async () => {
    const siteDir = mkdtempSync(join(tmpdir(), "regoro-noauth-"));
    dirs.push(siteDir);
    cpSync(REAL_SITE, siteDir, { recursive: true });

    const { port } = startServer({ siteDir, repoRoot: siteDir, port: 0, versand: attrappenVersand() });
    const base = `http://localhost:${port}`;

    expect(await status(base, "/edit")).toBe(404);
    expect(await status(base, "/")).toBe(200);
  });
});
