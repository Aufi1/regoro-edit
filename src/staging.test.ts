/**
 * Staging (Preview) — die ZWEITE Auflösungsart neben dem Host-Header.
 *
 * `regoro serve --staging <root>` bedient `…/p/<slug>/…`: die Zuordnung
 * Anfrage → Website kommt aus einem PFAD-ABSCHNITT statt aus dem Host-Header.
 * Damit steht die erste Stütze der Kundentrennung (CLAUDE.md, Invariante 10)
 * auf einem zweiten Bein — und das muss dieselbe Strenge haben wie
 * `normalizeHost`, das zugleich der Traversal-Schutz ist.
 *
 * Diese Datei ist der Nachweis dafür. Sie prüft nicht „funktioniert Staging",
 * sondern vier Zusicherungen:
 *
 *   1. `resolveStagingPath` lehnt alles ab, was kein sauberer Slug ist —
 *      **auch wenn der Zielordner wirklich existiert.** Ohne diese Gegenprobe
 *      misst die Ablehnung nur, dass der Ordner fehlt.
 *   2. Ein gültiger Slug löst auf. Sonst prüfte Punkt 1 bloß eine Funktion,
 *      die alles ablehnt.
 *   3. **Das „ohne Anmeldung" hängt am PROZESS, nicht am Kundenordner** (Plan,
 *      „Zwei Betriebsformen"). Deshalb wird DERSELBE Ordner hier zweimal
 *      gefahren: im Staging-Prozess ohne Cookie erreichbar, im
 *      Produktionsprozess weiterhin fail-closed. Eine Fahne im Kundenordner
 *      wäre eine Datei, die jemand mitkopiert — und dann stünde eine echte
 *      Kundenwebsite offen.
 *   4. Veröffentlichen gibt es in Staging nicht (C2: 403 `{"fehler":"staging"}`),
 *      und das Kontingent folgt einem ANDEREN Mechanismus (C9): einmalig, ohne
 *      Monatsreset.
 *
 * ANGENOMMENE SCHNITTSTELLE (beim Orchestrator gemeldet, die Contracts schweigen):
 * `startServer({ sitesRoot, staging: true, … })` — die Fahne am Prozess. Weicht
 * die Umsetzung davon ab, ändert sich hier die Schreibweise, nicht die Zusicherung.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SLUG_RE, resolveStagingPath } from "./sites.ts";
import { startServer } from "./server.ts";
import { createAuthFile, checkCookie, loadAuthFile, AUTH_DIR_NAME } from "./auth.ts";
import { stelleEntwurfBereit } from "./entwurf.ts";
import {
  STAGING_KONTINGENT,
  TOKEN_KONTINGENT,
  kontingentPfad,
  leereRueckstaende,
  pruefeKontingent,
  verbucheTokens,
} from "./kontingent.ts";
import { attrappenVersand, type Attrappe } from "./versand.ts";
import { meldeAn } from "./anmeldung.testhelfer.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");
const KENNUNG = "+4915120464812";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

// ===========================================================================
// 1. resolveStagingPath — die Zuordnung
// ===========================================================================
describe("resolveStagingPath", () => {
  /**
   * Alle Ordner existieren WIRKLICH — auch die mit unzulässigem Namen. Sonst
   * wäre jede Ablehnung unten trivial („den Ordner gibt es ja nicht") und der
   * Test bewiese nichts über die Prüfung des Slugs.
   */
  function fixture() {
    const root = tmp("regoro-staging-slug-");
    for (const name of [
      "kunde-a",
      "kunde-b",
      "bergdolt-3432",
      "Kunde-Gross",
      "a.b",
      "kunde.de",
      "-vorne",
      "hinten-",
      "unter_strich",
    ]) {
      mkdirSync(join(root, name));
    }
    writeFileSync(join(root, "datei"), "kein Verzeichnis");
    const extern = tmp("regoro-staging-extern-");
    symlinkSync(extern, join(root, "verlinkt"));
    return { root, extern };
  }

  test("GEGENPROBE ZUERST: ein gültiger Slug löst auf", () => {
    // Ohne diesen Fall misst die Ablehnungstabelle unten nur, dass die
    // Funktion alles ablehnt — auch eine, die immer `null` liefert, wäre grün.
    const { root } = fixture();
    const treffer = resolveStagingPath(root, "/p/kunde-a/edit");
    expect(treffer).not.toBe(null);
    expect(treffer!.slug).toBe("kunde-a");
    expect(treffer!.siteDir).toBe(join(root, "kunde-a"));
    expect(treffer!.rest).toBe("/edit");
    expect(treffer!.basis).toBe("/p/kunde-a");
  });

  test("Ziffern und Bindestriche sind erlaubt — echte Slugs sehen so aus", () => {
    const { root } = fixture();
    expect(resolveStagingPath(root, "/p/bergdolt-3432/")?.slug).toBe("bergdolt-3432");
  });

  test("`basis` trägt NIE einen Schrägstrich am Ende (Cross-Cutting-Konvention)", () => {
    const { root } = fixture();
    for (const pfad of ["/p/kunde-a", "/p/kunde-a/", "/p/kunde-a/edit", "/p/kunde-a/edit/save"]) {
      expect(`${pfad} → ${resolveStagingPath(root, pfad)?.basis}`).toBe(`${pfad} → /p/kunde-a`);
    }
  });

  test("`rest` ist der Pfad ohne Präfix und beginnt immer mit «/»", () => {
    const { root } = fixture();
    const rest = (pfad: string) => resolveStagingPath(root, pfad)?.rest;
    expect(rest("/p/kunde-a/edit/save")).toBe("/edit/save");
    expect(rest("/p/kunde-a/impressum.html/edit")).toBe("/impressum.html/edit");
    expect(rest("/p/kunde-a/assets/hero.png")).toBe("/assets/hero.png");
    expect(rest("/p/kunde-a/")).toBe("/");
    // Ohne Schrägstrich ist es dieselbe Website — nicht 404. Sonst hinge die
    // Erreichbarkeit einer Preview daran, ob jemand den Link mit oder ohne
    // Schrägstrich weitergibt.
    expect(rest("/p/kunde-a")).toBe("/");
  });

  /**
   * DIE TABELLE. Jede Zeile ist ein Slug, den `normalizeHost` an derselben
   * Stelle ebenfalls abweisen würde — plus die Punkte, die hier ZUSÄTZLICH
   * verboten sind (C7: `SLUG_RE` kennt keinen Punkt). Ein Punkt im Slug wäre
   * der Hebel für `..`; ihn gar nicht erst zuzulassen ist die einzige Fassung,
   * die man nicht falsch schreiben kann.
   */
  const abgelehnt: Array<[string, string]> = [
    ["Traversal als Slug", "/p/../etc/passwd"],
    ["Traversal, prozentkodiert", "/p/%2e%2e/etc/passwd"],
    ["ein Punkt als Slug", "/p/./kunde-a/edit"],
    ["Punkt im Slug", "/p/a.b/edit"],
    ["Punkt im Slug, obwohl der Ordner existiert", "/p/kunde.de/edit"],
    ["Großbuchstaben", "/p/Kunde-Gross/edit"],
    ["führender Bindestrich", "/p/-vorne/edit"],
    ["abschließender Bindestrich", "/p/hinten-/edit"],
    ["Unterstrich", "/p/unter_strich/edit"],
    ["leerer Slug", "/p//edit"],
    ["nur das Präfix", "/p/"],
    ["nur das Präfix, ohne Schrägstrich", "/p"],
    ["Wurzel", "/"],
    ["gar kein Präfix", "/edit"],
    ["fremdes Präfix", "/preview/kunde-a/edit"],
    ["Präfix nicht am Anfang", "/x/p/kunde-a/edit"],
    ["Null-Byte", "/p/kunde-a\0/edit"],
    ["Datei statt Verzeichnis", "/p/datei/edit"],
    ["unbekannter Slug", "/p/gibt-es-nicht/edit"],
  ];
  for (const [name, pfad] of abgelehnt) {
    test(`${name} → null`, () => {
      const { root } = fixture();
      expect(`${pfad} → ${resolveStagingPath(root, pfad)?.slug ?? "null"}`).toBe(`${pfad} → null`);
    });
  }

  test("nicht existierendes Sammelverzeichnis → null statt Absturz", () => {
    expect(resolveStagingPath("/gibt/es/nicht", "/p/kunde-a/edit")).toBe(null);
  });

  test("Symlink nach außen: erlaubt, aber auf den realen Pfad aufgelöst", () => {
    // Bewusst wie `resolveSite` (C7: „Strenge wie resolveSite"): Betreiber
    // mounten Sites per Symlink, und der zurückgegebene Pfad muss der REALE
    // sein — `pathInsideSite` prüft später gegen dasselbe Ziel. Der
    // Traversal-Schutz sitzt DAVOR und ist lexikalisch (direktes Kind), nicht
    // hier.
    const { root, extern } = fixture();
    const treffer = resolveStagingPath(root, "/p/verlinkt/edit");
    expect(treffer).not.toBe(null);
    expect(treffer!.siteDir).toBe(extern);
  });

  test("SLUG_RE zieht dieselbe Grenze wie die Auflösung", () => {
    // Zwei Fassungen derselben Regel laufen sonst auseinander: die Auflösung
    // nähme etwas an, das der Rest des Systems für unzulässig hält.
    const { root } = fixture();
    for (const slug of ["kunde-a", "bergdolt-3432", "a", "9", "a-b-c"]) {
      expect({ slug, re: SLUG_RE.test(slug) }).toEqual({ slug, re: true });
    }
    for (const slug of ["Kunde-Gross", "a.b", "kunde.de", "-vorne", "hinten-", "unter_strich", "..", "", "a b", "a/b"]) {
      expect({ slug, re: SLUG_RE.test(slug) }).toEqual({ slug, re: false });
    }
    // Und die Auflösung benutzt sie wirklich: derselbe Ordner, einmal erlaubt,
    // einmal nicht — ausschließlich wegen des Namens.
    expect(resolveStagingPath(root, "/p/kunde-a/edit")).not.toBe(null);
    expect(resolveStagingPath(root, "/p/Kunde-Gross/edit")).toBe(null);
  });
});

// ===========================================================================
// 2. Der Staging-Betrieb auf der Leitung
// ===========================================================================
interface Aufbau {
  root: string;
  siteA: string;
  siteB: string;
  siteOhneAuth: string;
  base: string;
  versand: Attrappe;
}

/**
 * Ein Sammelverzeichnis, dessen Ordnernamen zugleich gültige SLUGS und gültige
 * HOSTNAMEN sind. Genau das macht die Gegenprobe unten möglich: derselbe
 * Ordner, zweimal gefahren, einmal je Betriebsform.
 */
async function baueWurzel(): Promise<Omit<Aufbau, "base" | "versand">> {
  const root = tmp("regoro-staging-");
  const siteA = join(root, "kunde-a");
  const siteB = join(root, "kunde-b");
  const siteOhneAuth = join(root, "kunde-c");
  for (const [dir, marke] of [
    [siteA, "SEITE A"],
    [siteB, "SEITE B"],
    [siteOhneAuth, "SEITE C"],
  ] as const) {
    cpSync(REAL_SITE, dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), `<html><body><h1>${marke}</h1></body></html>`);
    // Was ein echter Site-Ordner sonst noch trägt und was niemand sehen darf.
    writeFileSync(join(dir, "design.json"), '{"pfad":"/srv/regoro/intern"}');
  }
  writeFileSync(join(siteA, "nur-bei-a.html"), "<html><body><h1>NUR A</h1></body></html>");
  // ERST der fertige Stand, DANN das Entwurfs-Repo: „erst deployen, dann
  // initialisieren" (Plan). Der Baseline-Commit entsteht auf dem fertigen
  // Stand, und die Seitenliste des Editors kennt `nur-bei-a.html`.
  for (const dir of [siteA, siteB, siteOhneAuth]) stelleEntwurfBereit(dir);
  // A und B sind eingerichtete Kunden, C ist ein Interessent ohne Kennung.
  await createAuthFile(siteA, [KENNUNG]);
  await createAuthFile(siteB, ["+4917012345678"]);
  return { root, siteA, siteB, siteOhneAuth };
}

async function bootStaging(): Promise<Aufbau> {
  const wurzel = await baueWurzel();
  const versand = attrappenVersand();
  const { port } = startServer({ sitesRoot: wurzel.root, staging: true, port: 0, versand });
  return { ...wurzel, base: `http://127.0.0.1:${port}`, versand };
}

function hol(base: string, pfad: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return fetch(base + pfad, { headers, redirect: "manual" });
}

const stat = (base: string, pfad: string, cookie?: string) =>
  hol(base, pfad, cookie).then((r) => r.status);

describe("Staging — Zuordnung über den Pfad", () => {
  test("der Slug entscheidet, wessen Website ausgeliefert wird", async () => {
    const { base } = await bootStaging();
    expect(await (await hol(base, "/p/kunde-a/index.html")).text()).toContain("SEITE A");
    expect(await (await hol(base, "/p/kunde-b/index.html")).text()).toContain("SEITE B");
    expect(await (await hol(base, "/p/kunde-a/")).text()).toContain("SEITE A");
  });

  test("unbekannter Slug → 404 auf ALLEN Routen", async () => {
    const { base } = await bootStaging();
    for (const pfad of [
      "/p/gibt-es-nicht/",
      "/p/gibt-es-nicht/index.html",
      "/p/gibt-es-nicht/edit",
      "/p/gibt-es-nicht/edit/save",
      "/p/gibt-es-nicht/edit-assets/overlay.js",
    ]) {
      expect(`${pfad} → ${await stat(base, pfad)}`).toBe(`${pfad} → 404`);
    }
  });

  test("die Wurzel und das nackte Präfix liefern nichts", async () => {
    // Nachgeprüft im Plan: `intern.sites.aufi.de/` und `/p/` geben beide 404,
    // es gibt kein Verzeichnislisting. Wer hier etwas ausliefert, veröffentlicht
    // die Liste aller Interessenten.
    const { base } = await bootStaging();
    for (const pfad of ["/", "/p", "/p/", "/index.html"]) {
      expect(`${pfad} → ${await stat(base, pfad)}`).toBe(`${pfad} → 404`);
    }
  });

  test("Kundentrennung: A kommt über seinen Pfad nicht an die Dateien von B", async () => {
    const { base } = await bootStaging();
    // Was es nur bei A gibt, gibt es unter B nicht — und umgekehrt bleibt es bei A erreichbar.
    expect(await stat(base, "/p/kunde-a/nur-bei-a.html")).toBe(200);
    expect(await stat(base, "/p/kunde-b/nur-bei-a.html")).toBe(404);
  });

  test("kein Ausbruch aus dem Sammelverzeichnis, auch prozentkodiert nicht", async () => {
    /**
     * GEMESSEN, und die naheliegende Erwartung war FALSCH — hier stand zuerst,
     * `/p/kunde-a/%2e%2e/kunde-b/index.html` müsse 404 geben. Es gibt 200 mit
     * der Startseite von B, und das ist richtig so: `new URL()` entfernt
     * Punkt-Segmente nach WHATWG-Regel, und dazu zählt ausdrücklich auch die
     * prozentkodierte Form. Beim Server kommt schlicht `/p/kunde-b/index.html`
     * an — dieselbe öffentliche Seite, die jeder direkt abrufen kann. Da ist
     * nichts gewonnen und nichts verraten.
     *
     * Was wirklich zählt, steht deshalb unten: Ein kodierter SCHRÄGSTRICH wird
     * NICHT normalisiert (`..%2f`), und über das Sammelverzeichnis hinaus führt
     * kein Weg — beides nachgemessen, beides 404. Eine Datei direkt im
     * Sammelverzeichnis (neben den Preview-Ordnern) ist der interessante Fall:
     * dort liegen im Betrieb Listen und Notizen des Betreibers.
     */
    const { base, root } = await bootStaging();
    writeFileSync(join(root, "geheim.html"), "<html><body>AUSSERHALB</body></html>");

    for (const pfad of [
      "/p/kunde-a/%2e%2e/geheim.html",
      "/p/kunde-a/%2e%2e/%2e%2e/etc/passwd",
      "/p/kunde-a/..%2fkunde-b/index.html",
      "/p/%2e%2e/etc/passwd",
    ]) {
      const r = await hol(base, pfad);
      const koerper = await r.text();
      expect(`${pfad} → ${r.status}`).toBe(`${pfad} → 404`);
      expect(koerper).not.toContain("AUSSERHALB");
    }
    // Gegenprobe: Die Datei GIBT es, sie ist nur nicht auslieferbar. Ohne diese
    // Zeile wäre der Fall auch grün, wenn niemand sie je angelegt hätte.
    expect(existsSync(join(root, "geheim.html"))).toBe(true);
  });

  test("die Schranken der Invariante 3 gelten im Staging unverändert", async () => {
    const { base, siteA } = await bootStaging();
    // Dotfile-Block …
    for (const pfad of ["/p/kunde-a/.regoro/auth.json", "/p/kunde-a/.regoro/entwurf/HEAD"]) {
      expect(`${pfad} → ${await stat(base, pfad)}`).toBe(`${pfad} → 404`);
    }
    /**
     * … und die Extension-Allowlist. IM STAGING TRÄGT SIE ALLEIN `ASSET_TYPES`
     * im Bun-Host: Der Caddy-Block hat dort kein `@allowed` und kein
     * `file_server`, weil die öffentliche Sicht der Entwurf ist. Fiele die
     * Prüfung im Host aus, gäbe es im Staging überhaupt keine mehr.
     */
    writeFileSync(join(siteA, "dump.sql"), "-- Kundendaten");
    for (const pfad of ["/p/kunde-a/design.json", "/p/kunde-a/dump.sql"]) {
      expect(`${pfad} → ${await stat(base, pfad)}`).toBe(`${pfad} → 404`);
    }
    // GEGENPROBE: Die Dateien liegen wirklich da — sonst prüfte der Fall nur,
    // dass ein nicht existierender Pfad 404 gibt.
    expect(existsSync(join(siteA, "design.json"))).toBe(true);
    expect(existsSync(join(siteA, "dump.sql"))).toBe(true);
    // Und eine erlaubte Endung wird ausgeliefert: Die Ablehnung liegt am TYP
    // und nicht daran, dass unter dem Präfix gar nichts funktioniert.
    expect(await stat(base, "/p/kunde-a/styles.css")).toBe(200);
    expect(await stat(base, "/p/kunde-a/assets/hero.png")).toBe(200);
  });

  test("jede Editor-Route ist unter dem Präfix erreichbar, nicht nur `/edit`", async () => {
    // Die Suffix-Route und die Editor-Assets sind die beiden Formen, die ein
    // naiv gebautes Präfix verfehlt (Plan: „greift nur die Suffix-Regel, und
    // die zufällig").
    const { base } = await bootStaging();
    for (const pfad of [
      "/p/kunde-a/edit",
      "/p/kunde-a/impressum.html/edit",
      "/p/kunde-a/edit-assets/overlay.js",
      "/p/kunde-a/edit/zustand",
    ]) {
      expect(`${pfad} → ${await stat(base, pfad)}`).toBe(`${pfad} → 200`);
    }
  });

  test("die Editor-Sicht zeigt nur die Seiten der eigenen Website", async () => {
    const { base } = await bootStaging();
    const sichtA = await (await hol(base, "/p/kunde-a/edit")).text();
    const sichtB = await (await hol(base, "/p/kunde-b/edit")).text();
    expect(sichtA).toContain("nur-bei-a.html");
    expect(sichtB).not.toContain("nur-bei-a.html");
  });

  test("der Client bekommt sein Präfix mit — sonst rufen alle Previews dieselbe API", async () => {
    // C3: `CFG.basis`. Ohne diesen Wert schickt das Overlay seine 13 absoluten
    // Pfade an `/edit/…` — im Staging-Prozess ist das nirgends eine Website.
    const { base } = await bootStaging();
    const sicht = await (await hol(base, "/p/kunde-a/edit")).text();
    expect(sicht).toMatch(/"basis"\s*:\s*"\/p\/kunde-a"/);
    expect(sicht).toMatch(/"staging"\s*:\s*true/);
    // Auch das Overlay selbst wird unter dem Präfix geladen — ohne das ist die
    // Seitenleiste im Staging gar nicht erst da.
    expect(sicht).toContain('src="/p/kunde-a/edit-assets/overlay.js"');
  });
});

// ===========================================================================
// 3. Der Kern: die Fahne hängt am PROZESS, nicht am Ordner
// ===========================================================================
describe("Staging kennt keine Anmeldung — der Produktionsbetrieb weiterhin schon", () => {
  test("im Staging öffnet der Editor ohne Cookie", async () => {
    const { base } = await bootStaging();
    for (const pfad of ["/p/kunde-a/edit", "/p/kunde-a/impressum.html/edit"]) {
      expect(`${pfad} → ${await stat(base, pfad)}`).toBe(`${pfad} → 200`);
    }
  });

  test("auch ein Ordner ganz OHNE auth.json ist im Staging bedienbar", async () => {
    // Der Regelfall für einen Interessenten: es gibt keine hinterlegte Kennung,
    // weil es noch keinen Kunden gibt. Im Produktionsbetrieb ist genau das der
    // Fail-closed-Fall (404) — hier darf es keiner sein.
    const { base } = await bootStaging();
    expect(await stat(base, "/p/kunde-c/edit")).toBe(200);
    expect(await stat(base, "/p/kunde-c/edit/zustand")).toBe(200);
  });

  test("GEGENPROBE — DERSELBE Ordner verlangt im Produktionsprozess weiterhin eine Anmeldung", async () => {
    /**
     * DAS IST DER KERN DER ENTSCHEIDUNG „PROZESS STATT ORDNER-FAHNE".
     *
     * Ein Schalter je Website wäre eine Datei, die jemand versehentlich
     * mitkopiert — und dann stünde eine echte Kundenwebsite ohne Anmeldung
     * offen. Als Prozess-Eigenschaft kann das nicht passieren. Bewiesen wird
     * das nur, wenn DASSELBE Verzeichnis beide Male gefahren wird: Ein Test mit
     * zwei verschiedenen Ordnern zeigte bloß, dass zwei Ordner verschieden sind.
     */
    const wurzel = await baueWurzel();
    const versand = attrappenVersand();

    const staging = startServer({ sitesRoot: wurzel.root, staging: true, port: 0, versand });
    const produktion = startServer({ sitesRoot: wurzel.root, port: 0, versand });
    const sBase = `http://127.0.0.1:${staging.port}`;
    const pBase = `http://127.0.0.1:${produktion.port}`;

    // Staging: offen.
    expect(await stat(sBase, "/p/kunde-a/edit")).toBe(200);

    // Produktion, derselbe Ordner: View-Route → 302 auf die Anmeldung,
    // API-Route → 404 (Invariante 4).
    const mitHost = (pfad: string) =>
      fetch(pBase + pfad, { headers: { Host: "kunde-a" }, redirect: "manual" }).then((r) => r.status);
    expect(await mitHost("/edit")).toBe(302);
    expect(await mitHost("/impressum.html/edit")).toBe(302);
    expect(await mitHost("/edit/save")).toBe(404);
    expect(await mitHost("/edit/zustand")).toBe(404);
    // Und der Ordner ohne auth.json bleibt in Produktion vollständig zu.
    const ohneAuth = (pfad: string) =>
      fetch(pBase + pfad, { headers: { Host: "kunde-c" }, redirect: "manual" }).then((r) => r.status);
    expect(await ohneAuth("/edit")).toBe(404);
    expect(await ohneAuth("/edit/login")).toBe(404);
    // Die Anmeldung funktioniert dort weiterhin — fail-closed heißt nicht kaputt.
    const cookie = await meldeAn(pBase, KENNUNG, versand, { host: "kunde-a" });
    expect(await stat(pBase, "/edit", cookie)).toBe(404); // ohne Host-Header keine Website
    expect(
      await fetch(`${pBase}/edit`, { headers: { Host: "kunde-a", cookie }, redirect: "manual" }).then((r) => r.status),
    ).toBe(200);
  });

  test("der Staging-Prozess bedient KEINE hostbasierten Adressen", async () => {
    // Sonst wäre jede Website des Staging-Verzeichnisses zusätzlich unter ihrem
    // Ordnernamen als Host erreichbar — ohne Anmeldung.
    const { base } = await bootStaging();
    const mitHost = (pfad: string) =>
      fetch(base + pfad, { headers: { Host: "kunde-a" }, redirect: "manual" }).then((r) => r.status);
    expect(await mitHost("/edit")).toBe(404);
    expect(await mitHost("/index.html")).toBe(404);
    expect(await mitHost("/edit/login")).toBe(404);
  });

  test("der Produktionsprozess kennt keine Preview-Adresse", async () => {
    // Die Gegenrichtung: das Pfad-Präfix darf im Produktionsprozess nichts
    // aufschließen, auch nicht mit gültigem Cookie.
    const wurzel = await baueWurzel();
    const versand = attrappenVersand();
    const { port } = startServer({ sitesRoot: wurzel.root, port: 0, versand });
    const base = `http://127.0.0.1:${port}`;
    const cookie = await meldeAn(base, KENNUNG, versand, { host: "kunde-a" });
    for (const pfad of ["/p/kunde-a/edit", "/p/kunde-a/index.html", "/p/kunde-b/edit"]) {
      const s = await fetch(base + pfad, {
        headers: { Host: "kunde-a", cookie },
        redirect: "manual",
      }).then((r) => r.status);
      expect(`${pfad} → ${s}`).toBe(`${pfad} → 404`);
    }
  });
});

// ===========================================================================
// 4. Veröffentlichen gibt es in Staging nicht (C2)
// ===========================================================================
describe("veröffentlichen in Staging", () => {
  const post = (base: string, pfad: string, cookie?: string, koerper?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cookie) headers.cookie = cookie;
    return fetch(base + pfad, {
      method: "POST",
      headers,
      body: koerper === undefined ? "{}" : JSON.stringify(koerper),
      redirect: "manual",
    });
  };

  test("403 mit `{\"fehler\":\"staging\"}` — nicht 404, nicht 500", async () => {
    const { base } = await bootStaging();
    const r = await post(base, "/p/kunde-a/edit/veroeffentlichen");
    expect(r.status).toBe(403);
    // Auf die KENNUNG festgenagelt, nicht auf das ganze Objekt: Die Kennung
    // ist der Vertrag (C2), ein zusätzlicher Klartext für den Kunden ist der
    // Oberfläche überlassen.
    expect(((await r.json()) as { fehler: string }).fehler).toBe("staging");
  });

  test("GEGENPROBE: in Produktion ist dieselbe Route KEIN 403", async () => {
    // Ohne sie wäre der Test darüber auch grün, wenn die Route grundsätzlich
    // 403 lieferte — oder gar nicht existierte und irgendetwas anderes 403
    // beantwortete. Was sie in Produktion antwortet, entscheidet Test-Kern;
    // hier zählt nur: es ist nicht die Staging-Absage.
    const wurzel = await baueWurzel();
    const versand = attrappenVersand();
    const { port } = startServer({ sitesRoot: wurzel.root, port: 0, versand });
    const base = `http://127.0.0.1:${port}`;
    const cookie = await meldeAn(base, KENNUNG, versand, { host: "kunde-a" });
    const r = await fetch(`${base}/edit/veroeffentlichen`, {
      method: "POST",
      headers: { Host: "kunde-a", cookie, "content-type": "application/json" },
      body: "{}",
      redirect: "manual",
    });
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(404); // die Route MUSS verdrahtet sein
  });

  test("`/edit/zustand` sagt es auch von sich aus", async () => {
    // Die Seitenleiste soll den Knopf gar nicht erst anbieten. Stünde die
    // Absage nur im 403, sähe der Interessent einen Knopf, der nie geht.
    const { base } = await bootStaging();
    const zustand = (await (await hol(base, "/p/kunde-a/edit/zustand")).json()) as Record<string, unknown>;
    expect(zustand.staging).toBe(true);
    expect(zustand.veroeffentlichenMoeglich).toBe(false);
  });

  test("GEGENPROBE: in Produktion meldet `/edit/zustand` das Gegenteil", async () => {
    const wurzel = await baueWurzel();
    const versand = attrappenVersand();
    const { port } = startServer({ sitesRoot: wurzel.root, port: 0, versand });
    const base = `http://127.0.0.1:${port}`;
    const cookie = await meldeAn(base, KENNUNG, versand, { host: "kunde-a" });
    const r = await fetch(`${base}/edit/zustand`, {
      headers: { Host: "kunde-a", cookie },
      redirect: "manual",
    });
    expect(r.status).toBe(200);
    const zustand = (await r.json()) as Record<string, unknown>;
    expect(zustand.staging).toBe(false);
    /**
     * GEMESSEN und die Erwartung korrigiert: Hier stand `toBe(true)`. In
     * Produktion hängt `veroeffentlichenMoeglich` aber am INHALT — gibt es
     * etwas Unveröffentlichtes? —, nicht an der Betriebsform. Auf einer frischen
     * Site ist deshalb auch dort `false` richtig, und ein Test, der `true`
     * verlangt, hätte die Umsetzung gezwungen, einen Knopf anzubieten, der
     * nichts tut.
     *
     * Die Aussage dieses Falls ist die Betriebsform, und die steht in der Zeile
     * darüber. Dass in Staging KEIN Inhalt das Veröffentlichen je möglich macht,
     * steht im 403 nebenan. Der inhaltliche Fall („es gibt etwas, also true")
     * gehört zu `veroeffentlichen.test.ts`.
     */
    expect(typeof zustand.veroeffentlichenMoeglich).toBe("boolean");
  });
});

// ===========================================================================
// 5. Kontingent (C9) — wohnt in kontingent.test.ts
// ===========================================================================
// Der Unterschied zwischen den Betriebsformen ist nicht die Zahl, sondern die
// VERFALLSREGEL: `"einmalig"` gegen `"monatlich"`. Das ist eine Eigenschaft von
// `kontingent.ts` und wird dort geprüft (Monatswechsel gibt bei „einmalig"
// nichts zurück, bei „monatlich" schon) — hier stünde nur eine zweite Fassung
// derselben Zusicherung, die beim nächsten Umbau auseinanderliefe.

// ===========================================================================
// 6. Woher die Identität im Staging kommt (C12)
// ===========================================================================
describe("Staging — das flüchtige Geheimnis greift NUR bei fehlender auth.json", () => {
  /**
   * Staging kennt keine Anmeldung, prägt aber trotzdem ein Cookie — sonst
   * scheiterte jede API-Route an der Auth-Wand, die `host.ts` unverändert führt
   * (C12). Woher das Geheimnis dafür kommt, ist der heikle Teil:
   *
   *   auth.json DA    → dieses Geheimnis, keins erfinden.
   *   auth.json FEHLT → ein flüchtiges, nur im Arbeitsspeicher.
   *
   * Würde der Rückfall auch bei VORHANDENER Datei greifen, bekäme eine Preview
   * eine zweite, erfundene Identität neben der echten — und ein Ordner, der
   * später produktiv geht, trüge zwei gültige Cookie-Welten.
   */
  test("mit auth.json wird deren Geheimnis benutzt, kein erfundenes", async () => {
    const { base, siteA } = await bootStaging();
    const r = await hol(base, "/p/kunde-a/edit");
    expect(r.status).toBe(200);

    const gesetzt = r.headers.get("set-cookie");
    expect(gesetzt).not.toBeNull();
    const token = gesetzt!.split(";")[0]!.split("=").slice(1).join("=");

    // DER PUNKT: Das ausgestellte Cookie ist gegen die Datei auf Platte
    // verifizierbar. Ein erfundenes Geheimnis fiele hier durch.
    const auf_platte = loadAuthFile(siteA);
    expect(auf_platte).not.toBeNull();
    expect(checkCookie(auf_platte, token)).toBe(true);
  });

  test("ohne auth.json wird nichts auf die Platte geschrieben", async () => {
    // Eine Preview soll keinen Zustand hinterlassen, den später jemand für eine
    // eingerichtete Website hält.
    const { base, siteOhneAuth } = await bootStaging();
    expect(await stat(base, "/p/kunde-c/edit")).toBe(200);
    expect(existsSync(join(siteOhneAuth, AUTH_DIR_NAME, "auth.json"))).toBe(false);
  });

  test("GEGENPROBE: in Produktion bleibt die SecretWache scharf", async () => {
    /**
     * Im Staging ist ein geteiltes Geheimnis harmlos — dort gibt es keine
     * Anmeldung, und um eine fremde Preview zu erreichen, braucht man ihren
     * Slug, der ohnehin ein Cookie ausstellt. In PRODUKTION ersetzt ein Cookie
     * dagegen einen Einmalcode, und zwei Ordner mit demselben Geheimnis heben
     * Stütze 2 der Kundentrennung auf (Invariante 10).
     *
     * Dieser Fall hält fest, dass die Lockerung im Staging die Wache in
     * Produktion NICHT mit aushebelt — sie laufen durch verschiedene Handler,
     * und genau das muss messbar bleiben.
     */
    const wurzel = await baueWurzel();
    // `cp -r` einer eingerichteten Site: `.regoro/` fährt mit, das Geheimnis auch.
    const kopie = join(wurzel.root, "kunde-kopie");
    cpSync(wurzel.siteA, kopie, { recursive: true });

    const versand = attrappenVersand();
    const { port } = startServer({ sitesRoot: wurzel.root, port: 0, versand });
    const base = `http://127.0.0.1:${port}`;
    const mitHost = (host: string, pfad: string) =>
      fetch(base + pfad, { headers: { Host: host }, redirect: "manual" }).then((r) => r.status);

    // Beide Editoren sind zu — auch der des unbeteiligten Originals.
    expect(await mitHost("kunde-a", "/edit/login")).toBe(404);
    expect(await mitHost("kunde-kopie", "/edit/login")).toBe(404);
    // Die Websites laufen weiter; ein Betriebsfehler nimmt keine Seite vom Netz.
    expect(await mitHost("kunde-a", "/")).toBe(200);
    // Und der Kunde ohne geteiltes Geheimnis ist unberührt.
    expect(await mitHost("kunde-b", "/edit/login")).toBe(200);
  });
});

// ===========================================================================
// 7. Die Präfix-Reparatur über den Referer
// ===========================================================================
describe("Staging — wurzel-absolute Links der Kundenseite", () => {
  /**
   * Eine Fabrik-Seite verlinkt `href="/impressum.html"`. Unter `/p/<slug>/`
   * fragt der Browser diesen Pfad OHNE Präfix an — in der Vorschau wäre damit
   * die gesamte Navigation tot. Trägt die Anfrage einen gleich-originen
   * `Referer` unter einer gültigen Preview, wird sie dorthin umgeleitet.
   *
   * Die Reparatur NIMMT NICHTS WEG: Ohne Referer bleibt es beim 404 von vorher.
   * Genau das prüfen die Gegenproben — sonst wäre aus einer Hilfestellung eine
   * zweite, unbeaufsichtigte Auflösungsart geworden.
   */
  const mitReferer = (base: string, pfad: string, referer: string) =>
    fetch(base + pfad, { headers: { referer }, redirect: "manual" });

  test("mit Referer unter einer Preview → 302 auf den präfixten Pfad", async () => {
    const { base } = await bootStaging();
    const r = await mitReferer(base, "/impressum.html", `${base}/p/kunde-a/index.html`);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/p/kunde-a/impressum.html");
    // Die Umleitung gilt NUR zusammen mit dem Referer, der sie begründet.
    expect((r.headers.get("cache-control") ?? "").toLowerCase()).toContain("no-store");
  });

  test("die Suchanfrage bleibt erhalten", async () => {
    const { base } = await bootStaging();
    const r = await mitReferer(base, "/impressum.html?a=1", `${base}/p/kunde-a/`);
    expect(r.headers.get("location")).toBe("/p/kunde-a/impressum.html?a=1");
  });

  test("GEGENPROBE: ohne Referer bleibt es beim 404", async () => {
    const { base } = await bootStaging();
    const r = await hol(base, "/impressum.html");
    expect(r.status).toBe(404);
    expect(r.headers.get("location")).toBeNull();
  });

  test("GEGENPROBE: ein fremder Origin leitet nicht um", async () => {
    // Sonst bestimmte eine fremde Seite, wohin unsere Anfragen gehen.
    const { base } = await bootStaging();
    for (const referer of [
      "https://angreifer.example/p/kunde-a/",
      "http://angreifer.example:8080/p/kunde-a/index.html",
    ]) {
      const r = await mitReferer(base, "/impressum.html", referer);
      expect(`${referer} → ${r.status}`).toBe(`${referer} → 404`);
    }
  });

  test("GEGENPROBE: ein ungültiger Slug im Referer leitet nicht um", async () => {
    const { base } = await bootStaging();
    for (const pfad of ["/p/KUNDE-A/", "/p/kunde.de/", "/p/gibt-es-nicht/", "/etwas/anderes"]) {
      const r = await mitReferer(base, "/impressum.html", base + pfad);
      expect(`${pfad} → ${r.status}`).toBe(`${pfad} → 404`);
    }
  });

  test("GEGENPROBE: was schon unter /p/ liegt, wird nie umgeleitet", async () => {
    // Ein unzulässiger Slug ist keine falsch adressierte Anfrage, sondern eine
    // unzulässige. Eine Umleitung machte daraus eine zweite Chance.
    const { base } = await bootStaging();
    const r = await mitReferer(base, "/p/KUNDE-A/index.html", `${base}/p/kunde-a/`);
    expect(r.status).toBe(404);
    expect(r.headers.get("location")).toBeNull();
  });

  test("GEGENPROBE: der Produktionsprozess leitet NICHT um", async () => {
    // Dort gibt es keine Previews. Eine Umleitung nach `/p/…` wäre eine
    // Adresse, die dieser Prozess selbst mit 404 beantwortet — und ein
    // Verhaltensunterschied, den niemand erwartet.
    const wurzel = await baueWurzel();
    const versand = attrappenVersand();
    const { port } = startServer({ sitesRoot: wurzel.root, port: 0, versand });
    const base = `http://127.0.0.1:${port}`;
    const r = await fetch(`${base}/impressum.html`, {
      headers: { Host: "kunde-a", referer: `http://kunde-a/p/kunde-a/index.html` },
      redirect: "manual",
    });
    // 200, weil `/impressum.html` bei diesem Host schlicht existiert — aber
    // keinesfalls eine Umleitung ins Preview-Präfix.
    expect(r.headers.get("location")).toBeNull();
    expect(r.status).not.toBe(302);
  });
});

// ===========================================================================
// 8. Proxy und Anwendung müssen sich über den Slug einig sein
// ===========================================================================
describe("Staging — Slug und rest folgen dem NORMALISIERTEN Pfad", () => {
  /**
   * GEMESSEN UND DER GRUND FÜR DIESEN ABSCHNITT: Caddy prüft den
   * NORMALISIERTEN Pfad, leitet aber den ROHEN weiter. Bei
   * `/p/kunde-a/%2e%2e/kunde-b/edit` gibt der Proxy `kunde-b` frei und reicht
   * einen Pfad weiter, dessen erstes Segment `kunde-a` lautet.
   *
   * Nähme die Anwendung ihren Slug aus der Zeichenkette VOR dem URL-Parser,
   * wären Proxy und Anwendung uneins, um wessen Website es geht — Stütze 1 der
   * Kundentrennung (Invariante 10), an genau der Naht, die im Staging neu
   * gezogen wird.
   *
   * Deshalb ist die Zusicherung hier eine EIGENSCHAFT und keine Liste
   * abgelehnter Einzelfälle: Der aufgelöste Slug ist immer das zweite Segment
   * des normalisierten Pfades, und `rest` ist zeichengleich der Überrest. Eine
   * Ablehnungsliste prüfte nur die Fälle, an die jemand gedacht hat.
   *
   * `rest` gehört mit hinein, und zwar wegen `/p/kunde-a//edit`: Der Slug ist
   * dort `kunde-a` — also einig mit dem Proxy —, aber der Überrest ist `//edit`
   * und nicht `/edit`. Eine Zusicherung, die nur den Slug vergleicht, ginge
   * grün durch, während die leeren Segmente unbemerkt bleiben.
   *
   * Die andere Hälfte — dass der PROXY dieselbe Entscheidung trifft — steht in
   * `csp.test.ts`, weil sie echtes caddy braucht.
   */
  const FEINDSELIG = [
    "/p/kunde-a/%2e%2e/kunde-b/edit",
    "/p/kunde-a/../kunde-b/edit",
    "/p/kunde-a/edit/%2e%2e/%2e%2e/kunde-b/edit",
    "/p/%2e%2e/etc/edit",
    "/p/kunde%2eb/edit",
    "/p/kunde-a//edit",
    "/p/kunde-a/edit/x%2fy",
    "/p/kunde-a/edit/%00",
    // Die harmlose Gegenprobe: ohne sie misst der Satz nur, dass alles
    // abgelehnt wird.
    "/p/kunde-a/edit",
  ];

  test("der Slug ist immer das zweite Segment des normalisierten Pfades", async () => {
    const { root } = await baueWurzel();
    let aufgeloest = 0;
    for (const roh of FEINDSELIG) {
      // Denselben Weg wie der Server: erst durch den URL-Parser, dann auflösen.
      const normalisiert = new URL(`http://intern.example${roh}`).pathname;
      const treffer = resolveStagingPath(root, normalisiert);
      if (treffer === null) continue;
      aufgeloest++;
      const praefix = `/p/${treffer.slug}`;
      expect(`${roh}: ${normalisiert.startsWith(praefix + "/") || normalisiert === praefix}`).toBe(
        `${roh}: true`,
      );
      // `rest` ist der Überrest, Zeichen für Zeichen — kein Aufräumen, kein
      // Zusammenfassen leerer Segmente.
      const ueberrest = normalisiert.slice(praefix.length) || "/";
      expect(`${roh}: ${treffer.rest}`).toBe(`${roh}: ${ueberrest}`);
    }
    // GEGENPROBE ZUM MESSAPPARAT: Mindestens ein Fall MUSS aufgelöst haben,
    // sonst hat die Schleife oben nie eine Zusicherung ausgeführt.
    expect(aufgeloest).toBeGreaterThan(0);
  });

  test("der Slug wird NICHT prozent-dekodiert, bevor SLUG_RE greift", async () => {
    /**
     * DER FALL, DER DIE BEIDEN LESARTEN AUSEINANDERHÄLT — und der einzige im
     * Satz, der das tut. `%2d` ist ein Bindestrich: Wer vor der Prüfung
     * dekodiert, hält `/p/kunde%2db/edit` für `kunde-b` und löst auf. Wer nicht
     * dekodiert, lehnt ab.
     *
     * Caddys Regexp arbeitet auf dem nicht dekodierten Pfad und lehnt ebenfalls
     * ab. Dekodierte die Anwendung, wäre sie LAXER als der Proxy: Die Anfrage
     * käme über den Catch-all-Zweig (also mit CSP) herein und würde dennoch als
     * Editor-Adresse einer fremden Preview behandelt. Genau die Uneinigkeit
     * über „wessen Website ist das", gegen die dieser Abschnitt steht.
     *
     * Ein Test mit `%2e` (Punkt) hätte das NICHT gezeigt: Ein Punkt ist im Slug
     * ohnehin verboten, beide Lesarten lehnen ab. Nur ein Zeichen, das der Slug
     * erlaubt, trennt sie.
     */
    const { root } = await baueWurzel();
    // Gegenprobe: unkodiert löst derselbe Slug auf — der Ordner existiert also.
    expect(resolveStagingPath(root, "/p/kunde-b/edit")?.slug).toBe("kunde-b");
    for (const roh of ["/p/kunde%2db/edit", "/p/kunde%2Db/edit"]) {
      const norm = new URL(`http://x${roh}`).pathname;
      expect(`${roh} → ${resolveStagingPath(root, norm)?.slug ?? "null"}`).toBe(`${roh} → null`);
    }
  });

  test("und die Entscheidung hängt nie an der rohen Zeichenkette", async () => {
    // Zwei Schreibweisen desselben normalisierten Pfades müssen dieselbe
    // Antwort bekommen. Wer vor dem Parser schneidet, bekommt hier zwei
    // verschiedene Slugs für dieselbe Adresse.
    const { root } = await baueWurzel();
    const paare: [string, string][] = [
      ["/p/kunde-a/%2e%2e/kunde-b/edit", "/p/kunde-b/edit"],
      ["/p/kunde-a/../kunde-b/edit", "/p/kunde-b/edit"],
      ["/p/kunde-b/./edit", "/p/kunde-b/edit"],
    ];
    for (const [roh, erwartet] of paare) {
      const a = resolveStagingPath(root, new URL(`http://x${roh}`).pathname);
      const b = resolveStagingPath(root, new URL(`http://x${erwartet}`).pathname);
      expect(`${roh}: ${a?.slug}|${a?.rest}`).toBe(`${roh}: ${b?.slug}|${b?.rest}`);
    }
  });
});
