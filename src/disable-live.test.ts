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

// ===========================================================================
// Eine zur Laufzeit angelegte Seite — ohne Neustart erreichbar
// ===========================================================================
/**
 * Dieselbe Bauart wie oben (echter Server, Zustand ändert sich unter ihm), nur
 * die andere Richtung: nicht „etwas verschwindet", sondern „etwas kommt dazu".
 *
 * DAS SCHADENSBILD, gemessen in einem echten Agentenlauf: Der Agent legte
 * `oeffnungszeiten.html` an und verlinkte sie — richtigerweise — in der
 * Navigation ALLER Seiten. Weil `pageWhitelist` im Einzelbetrieb nur beim Start
 * ermittelt wurde, gab die neue Seite 404. Ergebnis war nicht „hat nicht
 * geklappt", sondern ein toter Link auf jeder Unterseite der Kundenwebsite —
 * schlimmer als gar keine Änderung, und für den Kunden ohne erkennbare Ursache.
 *
 * Im Sammelbetrieb entsteht der Ctx ohnehin pro Anfrage; geprüft wird hier
 * deshalb der Einzelbetrieb, wo der Ctx den Prozess überlebt.
 */
describe("neue Seite bei laufendem Server", () => {
  const NEUE_SEITE = "<!doctype html><html lang=de><body><h1>Öffnungszeiten</h1><p>Mo–Fr 8–17 Uhr.</p></body></html>";

  /**
   * Die Seitenliste wird im Einzelbetrieb höchstens einmal je Sekunde neu
   * ermittelt (`SEITEN_SCAN_TTL_MS` in server.ts). Das ist Absicht, nicht
   * Bequemlichkeit: `resolvePage` fragt sie bei JEDER Anfrage, auch für Bilder —
   * ohne Deckelung löste eine Seite mit dreißig Bildern dreißig zusätzliche
   * `readdir` aus, auf einem unauthentifizierten Pfad.
   *
   * Die Tests warten diese Spanne deshalb ausdrücklich ab, statt sie
   * wegzudefinieren. Wie kurz sie sein muss, prüft der letzte Test.
   */
  const NACH_DEM_SCAN = 1200;

  test("öffentlich UND im Editor erreichbar, ohne Neustart", async () => {
    const { siteDir, base, cookie } = await bootSite();

    // Voraussetzung: Vorher gibt es sie wirklich nicht.
    expect(await status(base, "/oeffnungszeiten.html")).toBe(404);

    writeFileSync(join(siteDir, "oeffnungszeiten.html"), NEUE_SEITE);
    await Bun.sleep(NACH_DEM_SCAN);

    expect(await status(base, "/oeffnungszeiten.html")).toBe(200);
    // Und bearbeitbar — „neue Seite ist über /<seite>.html/edit erreichbar" ist
    // ein Acceptance Criterion des KI-Laufs. Eine Seite, die der Kunde danach
    // nicht mehr anfassen kann, ist eine Falle, kein Feature.
    expect(await status(base, "/oeffnungszeiten.html/edit", cookie)).toBe(200);
  }, 15_000);

  test("sie taucht auch in der Seitenliste des Editors auf", async () => {
    // Sonst legt der Agent eine Seite an, die im Editor unsichtbar bleibt: Der
    // Kunde sieht sie im Netz, findet sie aber in keiner Auswahl wieder.
    const { siteDir, base, cookie } = await bootSite();
    writeFileSync(join(siteDir, "oeffnungszeiten.html"), NEUE_SEITE);
    await Bun.sleep(NACH_DEM_SCAN);

    const antwort = await fetch(base + "/edit", { headers: { cookie } });
    expect(antwort.status).toBe(200);
    expect(await antwort.text()).toContain("oeffnungszeiten.html");
  }, 15_000);

  test("eine entfernte Seite ist sofort wieder 404", async () => {
    // Die Gegenrichtung. Eine Liste, die nur wächst, lieferte eine gelöschte
    // Seite weiter aus — aus dem Dateisystem gelesen wäre das ein 500.
    const { siteDir, base, cookie } = await bootSite();
    writeFileSync(join(siteDir, "oeffnungszeiten.html"), NEUE_SEITE);
    await Bun.sleep(NACH_DEM_SCAN);
    expect(await status(base, "/oeffnungszeiten.html")).toBe(200);

    rmSync(join(siteDir, "oeffnungszeiten.html"));
    await Bun.sleep(NACH_DEM_SCAN);

    expect(await status(base, "/oeffnungszeiten.html")).toBe(404);
    expect(await status(base, "/oeffnungszeiten.html/edit", cookie)).toBe(404);
  }, 15_000);

  test("die Wartezeit ist kurz genug, dass sie niemand bemerkt", async () => {
    // Die Deckelung ist richtig, ihre LÄNGE ist die eigentliche Zusage an den
    // Kunden: Nach einem Agentenlauf drückt er F5. Wären es dreißig Sekunden,
    // sähe er seine neue Seite nicht und hielte den Lauf für misslungen —
    // derselbe Schaden wie mit eingefrorener Liste, nur langsamer.
    const { siteDir, base } = await bootSite();
    writeFileSync(join(siteDir, "oeffnungszeiten.html"), NEUE_SEITE);

    const begonnen = Date.now();
    let code = 404;
    while (code !== 200 && Date.now() - begonnen < 10_000) {
      code = await status(base, "/oeffnungszeiten.html");
      if (code !== 200) await Bun.sleep(100);
    }
    expect(code).toBe(200);
    expect(Date.now() - begonnen).toBeLessThan(3_000);
  }, 20_000);

  test("eine Datei, die nicht als Seite zählt, wird dadurch nicht editierbar", async () => {
    // Der Zuwachs darf die Regeln nicht aufweichen: PAGE_RE und die
    // Extension-Allowlist gelten für neu angelegte Dateien genauso.
    const { siteDir, base, cookie } = await bootSite();
    writeFileSync(join(siteDir, "design.json"), '{"pfad":"/srv/regoro/intern"}');
    writeFileSync(join(siteDir, "Grossbuchstaben.html"), NEUE_SEITE);
    await Bun.sleep(NACH_DEM_SCAN);

    expect(await status(base, "/design.json")).toBe(404);
    expect(await status(base, "/Grossbuchstaben.html/edit", cookie)).toBe(404);
  }, 15_000);
});
