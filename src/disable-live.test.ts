/**
 * `regoro disable` bei LAUFENDEM Server.
 *
 * startServer lädt auth.json im Einzelbetrieb einmalig in den ctx. Verschwindet die Datei danach,
 * muss der Editor sofort aus sein — sonst editieren gültige Cookies weiter,
 * obwohl der Betreiber den Zugang entzogen hat. Der Guard sitzt in server.ts
 * (nicht im Router), deshalb wird hier gegen einen echten Server getestet.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.ts";
import { createAuthFile, AUTH_DIR_NAME } from "./auth.ts";
import { entwurfPfad, stelleEntwurfBereit } from "./entwurf.ts";
import { commitEdit, countCommits } from "./git.ts";
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
  // Ohne Entwurfs-Repo gibt es keine Seitenliste und damit keinen Editor
  // (`discoverPages(entwurfDir)` in server.ts) — das ist der Zustand direkt
  // nach dem Deploy, vor `regoro init`, und dort gehört der Editor auch aus.
  stelleEntwurfBereit(siteDir);

  const versand = attrappenVersand();
  const { port } = startServer({ siteDir, port: 0, versand });
  const base = `http://localhost:${port}`;
  const cookie = await meldeAn(base, KENNUNG_PASSWORD, versand);

  return { siteDir, entwurfDir: entwurfPfad(siteDir), base, cookie };
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

  /**
   * DAS ECHTE `regoro disable`, nicht seine Nachbildung.
   *
   * Die Tests darüber löschen `.regoro/` von Hand — als Modell für „die
   * Auth-Datei verschwindet", und dafür sind sie richtig. Als Modell für den
   * BEFEHL sind sie es seit dem Entwurfs-Umbau nicht mehr: Die Historie liegt
   * jetzt INNERHALB von `.regoro/`, ein pauschales Löschen nähme sie mit — und
   * genau dieser Fehler war im Befehl, gemessen und behoben. Ein Test, der den
   * Befehl nachbaut, statt ihn zu rufen, hätte ihn nicht gefunden.
   */
  function disable(siteDir: string, ...flags: string[]): { code: number; aus: string } {
    const cli = join(import.meta.dir, "cli.ts");
    const r = Bun.spawnSync([process.execPath, "run", cli, "disable", siteDir, ...flags], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: r.exitCode,
      aus: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr),
    };
  }

  test("`regoro disable` schaltet den Editor ab und lässt die Historie stehen", async () => {
    /**
     * Die Zusicherung, an der ein stiller Totalverlust hängt: Der Befehl sagt
     * „die Website läuft weiter" — er darf dabei nicht die einzige Quelle der
     * Kundenänderungen mitnehmen. Beide Hälften stehen hier, denn eine allein
     * beweist nichts: Ein `disable`, das gar nichts täte, ließe die Historie
     * ebenfalls stehen.
     */
    const { siteDir, entwurfDir, base, cookie } = await bootSite();

    // Echte Arbeit im Entwurf, die etwas zu verlieren hat.
    writeFileSync(join(entwurfDir, "index.html"), "<html><body><p>ARBEIT-DES-KUNDEN</p></body></html>");
    commitEdit(entwurfDir, "index.html", "Inline-Edit");
    const commitsVorher = countCommits(entwurfDir);
    expect(commitsVorher).toBeGreaterThan(1); // Messapparat: mehr als die Baseline
    expect(await status(base, "/edit", cookie)).toBe(200); // Messapparat: Editor ist an

    const r = disable(siteDir);
    // Die Ausgabe steht in der Zusicherung, nicht daneben: Ein blankes
    // `toBe(0)` meldet im Fehlerfall nur „1 statt 0" und verschweigt, woran
    // der Befehl gescheitert ist.
    expect(`disable → ${r.code}: ${r.aus.slice(0, 300)}`).toContain("disable → 0:");

    // Der Editor ist aus — auch mit gültigem Cookie …
    expect(await status(base, "/edit", cookie)).toBe(404);
    expect(await status(base, "/edit/login")).toBe(404);
    expect(existsSync(join(siteDir, AUTH_DIR_NAME, "auth.json"))).toBe(false);
    // … die Website läuft weiter …
    expect(await status(base, "/")).toBe(200);
    // … und die Historie steht unversehrt da.
    expect(existsSync(join(entwurfDir, ".git"))).toBe(true);
    expect(countCommits(entwurfDir)).toBe(commitsVorher);
    expect(readFileSync(join(entwurfDir, "index.html"), "utf8")).toContain("ARBEIT-DES-KUNDEN");
  }, 30_000);

  test("die schwebende Änderung überlebt `disable` — sie ist bezahlte Arbeit", async () => {
    /**
     * Entschieden nach einer Messung, die das Gegenteil zeigte.
     *
     * In `.regoro/schwebend/` liegt ein Lauf, der **Kontingent verbraucht hat**
     * und den der Kunde noch übernehmen oder verwerfen wollte. Ihn beim
     * Abschalten des Zugangs mitzunehmen wäre stiller Verlust von etwas, das
     * Geld gekostet hat — und die Meldung des Befehls liest sich ohnehin, als
     * sei er mitgemeint. Ein Text, der weniger verspricht als er tut, ist
     * harmlos; einer, der mehr verspricht, ist der Fehler.
     *
     * Die Trennlinie im Befehl ist deshalb „gewährt Zugang?", nicht „gehört zum
     * Editor?": Entfernt werden `auth.json` und `integrationen.json`, alles
     * andere bleibt. Kundendaten und Abrechnung sind kein Zugang.
     */
    const { legeSchwebendAn } = await import("./arbeitskopie.ts");
    const { integrationenPfad } = await import("./integrationen.ts");
    const { siteDir, entwurfDir, base, cookie } = await bootSite();

    legeSchwebendAn(
      siteDir,
      new Map([["leistungen.html", Buffer.from("<html><body><p>NOCH NICHT ÜBERNOMMEN</p></body></html>")]]),
      new Map([["leistungen.html", null]]), // die Seite gibt es im Entwurf noch nicht
    );
    // Ein Kundenschlüssel — er MUSS verschwinden, er gewährt Zugang.
    writeFileSync(integrationenPfad(siteDir), '{"v":1,"browser":[]}');
    // Kundentext und Abrechnung — sie bleiben, sie gewähren keinen.
    mkdirSync(join(siteDir, AUTH_DIR_NAME, "verlauf"), { recursive: true });
    writeFileSync(join(siteDir, AUTH_DIR_NAME, "verlauf", "a.jsonl"), '{"role":"user"}\n');

    expect(await status(base, "/edit", cookie)).toBe(200); // Messapparat: Editor ist an

    const r = disable(siteDir);
    expect(`disable → ${r.code}: ${r.aus.slice(0, 300)}`).toContain("disable → 0:");

    // GEGENPROBE ZUERST: Der Befehl hat wirklich etwas getan. Ohne sie wäre
    // „schwebend/ ist noch da" auch für ein `disable` erfüllt, das gar nichts
    // löscht — und der Test bewiese nichts.
    expect(existsSync(join(siteDir, AUTH_DIR_NAME, "auth.json"))).toBe(false);
    expect(existsSync(integrationenPfad(siteDir))).toBe(false);
    expect(await status(base, "/edit", cookie)).toBe(404);

    // Und die bezahlte Arbeit steht unversehrt da — inhaltlich geprüft, nicht
    // nur als Ordner: eine leere Hülle wäre derselbe Verlust.
    const offen = join(siteDir, AUTH_DIR_NAME, "schwebend", "leistungen.html");
    expect(existsSync(offen)).toBe(true);
    expect(readFileSync(offen, "utf8")).toContain("NOCH NICHT ÜBERNOMMEN");
    // Ebenso alles andere, was kein Zugang ist.
    expect(existsSync(join(entwurfDir, ".git"))).toBe(true);
    expect(existsSync(join(siteDir, AUTH_DIR_NAME, "veroeffentlicht.json"))).toBe(true);
    expect(existsSync(join(siteDir, AUTH_DIR_NAME, "verlauf", "a.jsonl"))).toBe(true);
    // Und die Website läuft weiter.
    expect(await status(base, "/")).toBe(200);
  }, 30_000);

  test("`--purge` über gespeicherter Arbeit bricht ab und löscht nichts", async () => {
    // Invariante 9 in neuer Fassung: Ab dem zweiten Commit steckt Arbeit im
    // Entwurfs-Repo, die es sonst nirgends gibt. Der Guard muss am Entwurf
    // zählen — täte er es weiter am Site-Ordner, fände er dort gar kein Repo
    // mehr, hielte die Site für leer und löschte alles.
    const { siteDir, entwurfDir, base, cookie } = await bootSite();
    writeFileSync(join(entwurfDir, "index.html"), "<html><body><p>ARBEIT-DES-KUNDEN</p></body></html>");
    commitEdit(entwurfDir, "index.html", "Inline-Edit");
    const commitsVorher = countCommits(entwurfDir);

    const r = disable(siteDir, "--purge");

    expect(r.code).not.toBe(0);
    expect(existsSync(join(entwurfDir, ".git"))).toBe(true);
    expect(countCommits(entwurfDir)).toBe(commitsVorher);
    // Abgebrochen heißt abgebrochen: Auch der Zugang bleibt, der Editor läuft.
    expect(existsSync(join(siteDir, AUTH_DIR_NAME, "auth.json"))).toBe(true);
    expect(await status(base, "/edit", cookie)).toBe(200);
  }, 30_000);

  test("ohne auth.json von Anfang an: Editor aus, Site an (unverändert)", async () => {
    const siteDir = mkdtempSync(join(tmpdir(), "regoro-noauth-"));
    dirs.push(siteDir);
    cpSync(REAL_SITE, siteDir, { recursive: true });

    const { port } = startServer({ siteDir, port: 0, versand: attrappenVersand() });
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

  /**
   * Legt eine Seite an BEIDEN Orten an.
   *
   * Seit „Eine Bearbeitung, zwei Modi" haben öffentlich und Editor zwei
   * verschiedene Quellen: `/<seite>.html` kommt aus dem Abzug,
   * `/<seite>.html/edit` aus dem Entwurf. Wer nur einen der beiden bestückt,
   * prüft nicht mehr „die Seitenliste wächst", sondern nur noch, welchen Ordner
   * er vergessen hat. Dass die Trennung wirklich besteht, steht als eigener
   * Test darunter — sonst verstiege sich dieser Helfer zur Behauptung, es gäbe
   * sie nicht.
   */
  function legeSeiteAn(siteDir: string, entwurfDir: string, name: string, html: string): void {
    writeFileSync(join(siteDir, name), html);
    writeFileSync(join(entwurfDir, name), html);
  }

  test("öffentlich UND im Editor erreichbar, ohne Neustart", async () => {
    const { siteDir, entwurfDir, base, cookie } = await bootSite();

    // Voraussetzung: Vorher gibt es sie wirklich nicht.
    expect(await status(base, "/oeffnungszeiten.html")).toBe(404);

    legeSeiteAn(siteDir, entwurfDir, "oeffnungszeiten.html", NEUE_SEITE);
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
    const { siteDir, entwurfDir, base, cookie } = await bootSite();
    legeSeiteAn(siteDir, entwurfDir, "oeffnungszeiten.html", NEUE_SEITE);
    await Bun.sleep(NACH_DEM_SCAN);

    const antwort = await fetch(base + "/edit", { headers: { cookie } });
    expect(antwort.status).toBe(200);
    expect(await antwort.text()).toContain("oeffnungszeiten.html");
  }, 15_000);

  test("die beiden Quellen sind wirklich getrennt — Entwurf ist nicht Abzug", async () => {
    // Der Kern des Umbaus, an der Seitenliste gemessen: Eine gespeicherte, noch
    // nicht veröffentlichte Seite ist bearbeitbar und für Besucher unsichtbar.
    // Zugleich die Gegenprobe zum Helfer oben: Er schreibt an zwei Orte, weil es
    // wirklich zwei sind — nicht aus Bequemlichkeit.
    const { siteDir, entwurfDir, base, cookie } = await bootSite();
    writeFileSync(join(entwurfDir, "nur-entwurf.html"), NEUE_SEITE);
    writeFileSync(join(siteDir, "nur-abzug.html"), NEUE_SEITE);
    await Bun.sleep(NACH_DEM_SCAN);

    // Gespeichert, nicht veröffentlicht: im Editor da, im Netz nicht.
    expect(await status(base, "/nur-entwurf.html/edit", cookie)).toBe(200);
    expect(await status(base, "/nur-entwurf.html")).toBe(404);

    // Nur im Abzug: Besucher sehen sie, der Editor kennt sie nicht — sie gehört
    // keinem Entwurf an, und der Editor bearbeitet nur, was er versionieren kann.
    expect(await status(base, "/nur-abzug.html")).toBe(200);
    expect(await status(base, "/nur-abzug.html/edit", cookie)).toBe(404);
  }, 15_000);

  test("eine entfernte Seite ist sofort wieder 404", async () => {
    // Die Gegenrichtung. Eine Liste, die nur wächst, lieferte eine gelöschte
    // Seite weiter aus — aus dem Dateisystem gelesen wäre das ein 500.
    const { siteDir, entwurfDir, base, cookie } = await bootSite();
    legeSeiteAn(siteDir, entwurfDir, "oeffnungszeiten.html", NEUE_SEITE);
    await Bun.sleep(NACH_DEM_SCAN);
    expect(await status(base, "/oeffnungszeiten.html")).toBe(200);

    rmSync(join(siteDir, "oeffnungszeiten.html"));
    rmSync(join(entwurfDir, "oeffnungszeiten.html"));
    await Bun.sleep(NACH_DEM_SCAN);

    expect(await status(base, "/oeffnungszeiten.html")).toBe(404);
    expect(await status(base, "/oeffnungszeiten.html/edit", cookie)).toBe(404);
  }, 15_000);

  test("die Wartezeit ist kurz genug, dass sie niemand bemerkt", async () => {
    // Die Deckelung ist richtig, ihre LÄNGE ist die eigentliche Zusage an den
    // Kunden: Nach einem Agentenlauf drückt er F5. Wären es dreißig Sekunden,
    // sähe er seine neue Seite nicht und hielte den Lauf für misslungen —
    // derselbe Schaden wie mit eingefrorener Liste, nur langsamer.
    const { siteDir, entwurfDir, base } = await bootSite();
    legeSeiteAn(siteDir, entwurfDir, "oeffnungszeiten.html", NEUE_SEITE);

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
    const { siteDir, entwurfDir, base, cookie } = await bootSite();
    writeFileSync(join(siteDir, "design.json"), '{"pfad":"/srv/regoro/intern"}');
    legeSeiteAn(siteDir, entwurfDir, "Grossbuchstaben.html", NEUE_SEITE);
    await Bun.sleep(NACH_DEM_SCAN);

    expect(await status(base, "/design.json")).toBe(404);
    expect(await status(base, "/Grossbuchstaben.html/edit", cookie)).toBe(404);
  }, 15_000);
});
