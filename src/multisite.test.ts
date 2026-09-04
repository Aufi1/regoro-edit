/**
 * Sammelbetrieb: EIN Prozess, viele Kundenwebsites, unterschieden am Host-Header.
 *
 * Bisher war die Trennung zwischen Kunden eine Eigenschaft des Betriebssystems —
 * ein Prozess kannte einen Ordner, mehr ging nicht. Jetzt ist sie eine Eigenschaft
 * dieses Codes. Diese Datei ist der Nachweis, dass sie hält. Sie prüft nicht
 * primär "funktioniert Multi-Site", sondern "trennt es zuverlässig".
 *
 * Drei unabhängige Stützen (CLAUDE.md, Invariante 10):
 *   1. Host-Auflösung (sites.ts) — Zuordnung, fail-closed.
 *   2. Site-eigenes HMAC-Secret in auth.json — Identität: ein fremdes Cookie ist
 *      hier nicht verifizierbar.
 *   3. resolvePage/pathInsideSite — Containment: ein fremder Pfad ist nicht auflösbar.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.ts";
import { createAuthFile, AUTH_DIR_NAME } from "./auth.ts";
import { SECRET_SCAN_TTL_MS } from "./sites.ts";
import { entwurfPfad, stelleEntwurfBereit } from "./entwurf.ts";
import { attrappenVersand, type Attrappe } from "./versand.ts";
import { meldeAn } from "./anmeldung.testhelfer.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");
const KENNUNG_PW_A = "+4915120464812";
const KENNUNG_PW_B = "+4917012345678";
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Multi {
  root: string;
  siteA: string;
  siteB: string;
  base: string;
  versand: Attrappe;
  cookieA: string;
  cookieB: string;
}

async function bootMulti(): Promise<Multi> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "regoro-multi-")));
  dirs.push(root);
  const siteA = join(root, "kunde-a.test");
  const siteB = join(root, "kunde-b.test");
  cpSync(REAL_SITE, siteA, { recursive: true });
  cpSync(REAL_SITE, siteB, { recursive: true });
  // Unterscheidbarer Inhalt: eine Verwechslung muss im Test SICHTBAR sein.
  writeFileSync(join(siteA, "index.html"), "<html><body><h1>SEITE A</h1></body></html>");
  writeFileSync(join(siteB, "index.html"), "<html><body><h1>SEITE B</h1></body></html>");
  // Seite, die es nur bei A gibt.
  writeFileSync(join(siteA, "nur-bei-a.html"), "<html><body><h1>NUR A</h1></body></html>");
  // Erst der fertige Stand, dann das Entwurfs-Repo — der Editor liest seine
  // Sicht seit C1 von dort, der öffentliche Zweig weiterhin aus dem Site-Ordner.
  stelleEntwurfBereit(siteA);
  stelleEntwurfBereit(siteB);
  await createAuthFile(siteA, [KENNUNG_PW_A]);
  await createAuthFile(siteB, [KENNUNG_PW_B]);

  const versand = attrappenVersand();
  const { port } = startServer({ sitesRoot: root, port: 0, versand });
  const base = `http://127.0.0.1:${port}`;
  return {
    root,
    siteA,
    siteB,
    base,
    versand,
    cookieA: await meldeAn(base, KENNUNG_PW_A, versand, { host: "kunde-a.test" }),
    cookieB: await meldeAn(base, KENNUNG_PW_B, versand, { host: "kunde-b.test" }),
  };
}

function req(base: string, host: string, path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { Host: host };
  if (cookie) headers.cookie = cookie;
  return fetch(base + path, { headers, redirect: "manual" });
}

const status = (base: string, host: string, path: string, cookie?: string) =>
  req(base, host, path, cookie).then((r) => r.status);

/** Rohe Anfrage — für Kopfzeilen, die fetch nicht senden kann. */
function rawStatus(base: string, request: string): Promise<number> {
  const port = Number(new URL(base).port);
  return new Promise((resolve, reject) => {
    let buf = "";
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(sock) {
          sock.write(request);
        },
        data(sock, chunk) {
          buf += chunk.toString();
          const m = buf.match(/^HTTP\/1\.[01] (\d{3})/);
          if (m) {
            sock.end();
            resolve(Number(m[1]));
          }
        },
        error(_s, err) {
          reject(err);
        },
      },
    }).catch(reject);
  });
}

describe("Sammelbetrieb — Zuordnung", () => {
  test("der Host-Header entscheidet, wessen Seite ausgeliefert wird", async () => {
    const { base } = await bootMulti();
    expect(await (await req(base, "kunde-a.test", "/")).text()).toContain("SEITE A");
    expect(await (await req(base, "kunde-b.test", "/")).text()).toContain("SEITE B");
    expect(await (await req(base, "kunde-a.test", "/index.html")).text()).toContain("SEITE A");
    expect(await (await req(base, "kunde-b.test", "/index.html")).text()).toContain("SEITE B");
  });

  test("unbekannter Host → 404 auf ALLEN Routen", async () => {
    const { base, cookieA } = await bootMulti();
    for (const path of ["/", "/index.html", "/styles.css", "/edit", "/edit/login", "/edit-assets/overlay.js", "/edit/save"]) {
      expect(await status(base, "gibt-es-nicht.test", path, cookieA)).toBe(404);
    }
  });

  test("fehlender Host-Header (HTTP/1.0) → 404", async () => {
    const { base } = await bootMulti();
    expect(await rawStatus(base, "GET /edit/login HTTP/1.0\r\n\r\n")).toBe(404);
  });

  test("zwei Host-Header → 404 (kein Request-Smuggling)", async () => {
    // Bun lehnt die Anfrage nicht ab, sondern fügt beide Werte zu
    // "kunde-a.test, kunde-b.test" zusammen. Nähme normalizeHost den ersten,
    // routete der Proxy nach dem einen und wir nach dem anderen Wert.
    const { base } = await bootMulti();
    expect(
      await rawStatus(base, "GET / HTTP/1.1\r\nHost: kunde-a.test\r\nHost: kunde-b.test\r\n\r\n"),
    ).toBe(404);
  });

  test("manipulierter Host → 404, auch wenn der Zielordner existiert", async () => {
    const { base } = await bootMulti();
    for (const host of ["../kunde-a.test", "kunde-a.test/../kunde-b.test", "kunde a.test", ".."]) {
      expect(await status(base, host, "/")).toBe(404);
      expect(await status(base, host, "/edit/login")).toBe(404);
    }
  });

  test("www. und Port am Host treffen dieselbe Website", async () => {
    const { base } = await bootMulti();
    expect(await (await req(base, "www.kunde-a.test", "/")).text()).toContain("SEITE A");
    expect(await (await req(base, "KUNDE-B.test:8788", "/")).text()).toContain("SEITE B");
  });
});

describe("Sammelbetrieb — Trennung", () => {
  test("Stütze 2 (Site-Secret): A's Cookie verschafft bei B keinen Zugang", async () => {
    const { base, cookieA } = await bootMulti();
    // Kontrolle: bei A wirkt es.
    expect(await status(base, "kunde-a.test", "/edit", cookieA)).toBe(200);
    // Bei B nicht — B's auth.json trägt ein anderes HMAC-Secret, checkCookie scheitert.
    expect(await status(base, "kunde-b.test", "/edit", cookieA)).toBe(302);
    expect(await status(base, "kunde-b.test", "/impressum.html/edit", cookieA)).toBe(302);
  });

  test("Stütze 2 auf API-Routen: A's Cookie gegen B → 404 (nicht 401)", async () => {
    const { base, cookieA } = await bootMulti();
    const save = await fetch(`${base}/edit/save`, {
      method: "POST",
      headers: { Host: "kunde-b.test", cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ pagePath: "index.html", edits: [], fileHash: "x" }),
      redirect: "manual",
    });
    expect(save.status).toBe(404);
    expect(await status(base, "kunde-b.test", "/edit/versions?page=index.html", cookieA)).toBe(404);
  });

  test("Stütze 3 (Containment): A's Seite ist bei B nicht auflösbar, auch angemeldet nicht", async () => {
    const { base, cookieA, cookieB } = await bootMulti();
    // Bei A: die Seite gibt es und sie ist editierbar.
    expect(await status(base, "kunde-a.test", "/nur-bei-a.html", cookieA)).toBe(200);
    expect(await status(base, "kunde-a.test", "/nur-bei-a.html/edit", cookieA)).toBe(200);
    // Bei B: existiert nicht → 404, trotz gültiger B-Anmeldung.
    expect(await status(base, "kunde-b.test", "/nur-bei-a.html", cookieB)).toBe(404);
    expect(await status(base, "kunde-b.test", "/nur-bei-a.html/edit", cookieB)).toBe(404);
  });

  test("jeder Kunde sieht in der Edit-Ansicht nur seine eigenen Seiten", async () => {
    const { base, cookieA, cookieB } = await bootMulti();
    const viewA = await (await req(base, "kunde-a.test", "/edit", cookieA)).text();
    const viewB = await (await req(base, "kunde-b.test", "/edit", cookieB)).text();
    expect(viewA).toContain("nur-bei-a.html");
    expect(viewB).not.toContain("nur-bei-a.html");
  });

  test("die Kennung des einen loest beim anderen keinen Code aus", async () => {
    const { base, versand } = await bootMulti();
    const vorher = versand.gesendet.length;
    const res = await fetch(`${base}/edit/login`, {
      method: "POST",
      headers: { Host: "kunde-b.test", "content-type": "application/x-www-form-urlencoded" },
      body: `kennung=${encodeURIComponent(KENNUNG_PW_A)}&weg=sms`,
      redirect: "manual",
    });
    // Gleiche Antwort wie bei einer hinterlegten Kennung — die Anmeldeseite
    // darf nicht verraten, welche Kontaktwege es gibt.
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBe(null);
    // Aber es geht nichts raus.
    expect(versand.gesendet.length).toBe(vorher);
  });
});

describe("Sammelbetrieb — die Pfad-Auflösung des Staging bleibt draußen", () => {
  /**
   * Mit „Eine Bearbeitung, zwei Modi" bekommt der Editor eine ZWEITE
   * Auflösungsart: `…/p/<slug>/…` löst über einen Pfadabschnitt auf statt über
   * den Host-Header (C7). Sie gehört zum Staging-Prozess und zu keinem anderen.
   *
   * Diese beiden Fälle sind die Gegenrichtung zu `staging.test.ts`: Wer das
   * Abstreifen des Präfixes versehentlich vor JEDEN Router hängt, öffnet im
   * Produktionsbetrieb eine zweite Adresse für jede Website — und die käme,
   * weil Staging keine Anmeldung kennt, womöglich gleich ohne Cookie.
   *
   * Die Zuordnung Anfrage → Website ist die erste Stütze der Kundentrennung
   * (Invariante 10). Sie darf im Produktionsprozess nur EINE Quelle haben.
   */
  test("kein Präfix-Pfad ist im Produktionsprozess eine Website", async () => {
    const { base, cookieA } = await bootMulti();
    for (const path of [
      "/p/kunde-a.test/edit",
      "/p/kunde-a.test/index.html",
      "/p/kunde-b.test/edit",
      "/p/kunde-b.test/edit/save",
      "/p/kunde-a.test/edit-assets/overlay.js",
    ]) {
      // Ohne Cookie …
      expect(`${path} → ${await status(base, "kunde-a.test", path)}`).toBe(`${path} → 404`);
      // … und mit gültigem Cookie derselben Website erst recht nicht.
      expect(`${path} (angemeldet) → ${await status(base, "kunde-a.test", path, cookieA)}`).toBe(
        `${path} (angemeldet) → 404`,
      );
    }
  });

  test("die hostbasierte Auflösung bleibt daneben unverändert erreichbar", async () => {
    // Gegenprobe: Der Test darüber wäre auch grün, wenn dieser Server gar
    // nichts mehr ausliefert.
    const { base, cookieA } = await bootMulti();
    expect(await status(base, "kunde-a.test", "/")).toBe(200);
    expect(await status(base, "kunde-a.test", "/edit", cookieA)).toBe(200);
  });
});

describe("Sammelbetrieb — Zustand ohne Neustart", () => {
  test("disable bei A wirkt sofort und lässt B unberührt", async () => {
    const { base, siteA, cookieA, cookieB } = await bootMulti();
    expect(await status(base, "kunde-a.test", "/edit", cookieA)).toBe(200);

    rmSync(join(siteA, AUTH_DIR_NAME), { recursive: true, force: true });

    expect(await status(base, "kunde-a.test", "/edit", cookieA)).toBe(404);
    expect(await status(base, "kunde-a.test", "/edit/login")).toBe(404);
    // Die öffentliche Website von A läuft weiter.
    expect(await status(base, "kunde-a.test", "/")).toBe(200);
    // B ist unberührt.
    expect(await status(base, "kunde-b.test", "/edit", cookieB)).toBe(200);
    expect(await status(base, "kunde-b.test", "/edit/login")).toBe(200);
  });

  test("eine neu angelegte Seite ist ohne Neustart bearbeitbar", async () => {
    const { base, siteA, cookieA } = await bootMulti();
    expect(await status(base, "kunde-a.test", "/frisch.html/edit", cookieA)).toBe(404);

    /**
     * GEÄNDERT MIT DEN DREI ZUSTÄNDEN. Vorher lag hier EIN Schreibvorgang in den
     * Site-Ordner und die Erwartung „öffentlich UND bearbeitbar, beides sofort".
     * Beides zugleich gibt es nicht mehr, und das ist der Sinn des Umbaus:
     *
     *   im ENTWURF angelegt   → sofort bearbeitbar, aber NICHT öffentlich
     *   im SITE-Ordner        → sofort öffentlich (so schreibt Veröffentlichen)
     *
     * Der Test prüft weiterhin dasselbe wie zuvor — „ohne Neustart" —, jetzt
     * aber für beide Sichten getrennt. Die erste Zeile ist zugleich die
     * Zusicherung, dass ein Entwurf nicht heimlich öffentlich ist.
     */
    writeFileSync(join(entwurfPfad(siteA), "frisch.html"), "<html><body><p>frisch</p></body></html>");
    expect(await status(base, "kunde-a.test", "/frisch.html/edit", cookieA)).toBe(200);
    expect(await status(base, "kunde-a.test", "/frisch.html")).toBe(404);

    // Und was im Site-Ordner landet, ist ohne Neustart öffentlich.
    writeFileSync(join(siteA, "frisch.html"), "<html><body><p>frisch</p></body></html>");
    expect(await status(base, "kunde-a.test", "/frisch.html")).toBe(200);
  });

  test("eine neu angelegte Website ist ohne Neustart erreichbar", async () => {
    const { base, root } = await bootMulti();
    expect(await status(base, "kunde-c.test", "/")).toBe(404);

    const siteC = join(root, "kunde-c.test");
    cpSync(REAL_SITE, siteC, { recursive: true });
    writeFileSync(join(siteC, "index.html"), "<html><body><h1>SEITE C</h1></body></html>");
    stelleEntwurfBereit(siteC);

    expect(await (await req(base, "kunde-c.test", "/")).text()).toContain("SEITE C");
    // Ohne init keine Auth-Datei → Editor fail-closed.
    expect(await status(base, "kunde-c.test", "/edit/login")).toBe(404);
  });

  test("ein Ordner ohne Seiten liefert 404 statt eines Absturzes", async () => {
    const { base, root } = await bootMulti();
    const leer = join(root, "kunde-leer.test");
    rmSync(leer, { recursive: true, force: true });
    cpSync(join(root, "kunde-a.test"), leer, { recursive: true });
    for (const f of ["index.html", "impressum.html", "agb.html", "datenschutz.html", "nur-bei-a.html"]) {
      rmSync(join(leer, f), { force: true });
    }
    expect(await status(base, "kunde-leer.test", "/")).toBe(404);
    expect(await status(base, "kunde-leer.test", "/index.html")).toBe(404);
    // Assets liefert der Ordner weiterhin aus — er ist ja eine gültige Site.
    expect(await status(base, "kunde-leer.test", "/styles.css")).toBe(200);
  });
});

describe("on-demand-TLS: ask-Endpunkt", () => {
  test("bestätigt nur bekannte Hostnamen", async () => {
    const { base } = await bootMulti();
    const ask = (domain: string) =>
      fetch(`${base}/_regoro/tls-ask?domain=${encodeURIComponent(domain)}`, { redirect: "manual" })
        .then((r) => r.status);

    expect(await ask("kunde-a.test")).toBe(200);
    expect(await ask("www.kunde-a.test")).toBe(200);
    expect(await ask("gibt-es-nicht.test")).toBe(404);
    expect(await ask("../kunde-a.test")).toBe(404);
    expect(await ask("")).toBe(404);
  });

  test("liegt vor der Auth-Wall und ist keine Editor-Route", async () => {
    const { base } = await bootMulti();
    // Ohne Cookie, ohne Host-Zuordnung — der ask-Endpunkt braucht beides nicht.
    const res = await fetch(`${base}/_regoro/tls-ask?domain=kunde-b.test`, { redirect: "manual" });
    expect(res.status).toBe(200);
  });
});

describe("Sammelbetrieb — kopiertes Sitzungs-Geheimnis", () => {
  /**
   * Der Betriebsfehler: ein Site-Ordner wird als Vorlage kopiert, `.regoro/`
   * fährt mit. Dann tragen zwei Websites dasselbe HMAC-Secret UND denselben
   * Kontaktwege — Stütze 2 (Identität) ist damit weg: das Cookie des einen
   * gilt beim anderen, und schlimmer noch, derselbe Kontaktweg öffnet beide.
   * Ein an den Host gebundenes Cookie würde nur die erste Hälfte schließen.
   * Deshalb: Kollision erkennen und BEIDE Editoren fail-closed abschalten.
   */
  async function bootMitKopie() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "regoro-dup-")));
    dirs.push(root);
    const siteA = join(root, "kunde-a.test");
    const siteB = join(root, "kunde-b.test");
    cpSync(REAL_SITE, siteA, { recursive: true });
    cpSync(REAL_SITE, siteB, { recursive: true });
    writeFileSync(join(siteA, "index.html"), "<html><body><h1>SEITE A</h1></body></html>");
    writeFileSync(join(siteB, "index.html"), "<html><body><h1>SEITE B</h1></body></html>");
    stelleEntwurfBereit(siteA);
    stelleEntwurfBereit(siteB);
    await createAuthFile(siteA, [KENNUNG_PW_A]);
    await createAuthFile(siteB, [KENNUNG_PW_B]);
    return { root, siteA, siteB };
  }

  const startAuf = (root: string) => {
    const versand = attrappenVersand();
    const { port } = startServer({ sitesRoot: root, port: 0, versand });
    return { base: `http://127.0.0.1:${port}`, versand };
  };

  test("Kopie vor dem Start: beide Editoren aus, beide Websites bleiben online", async () => {
    const { root, siteA } = await bootMitKopie();
    const kopie = join(root, "kunde-c.test");
    cpSync(siteA, kopie, { recursive: true }); // .regoro/ fährt mit
    const { base } = startAuf(root);

    // Der Login ist zu — auf BEIDEN Seiten, nicht nur auf der Kopie.
    expect(await status(base, "kunde-a.test", "/edit/login")).toBe(404);
    expect(await status(base, "kunde-c.test", "/edit/login")).toBe(404);
    // Auch der gemeinsame Kontaktweg oeffnet nichts mehr.
    const versuch = await fetch(`${base}/edit/login`, {
      method: "POST",
      headers: { Host: "kunde-c.test", "content-type": "application/x-www-form-urlencoded" },
      body: `kennung=${encodeURIComponent(KENNUNG_PW_A)}&weg=sms`,
      redirect: "manual",
    });
    expect(versuch.status).toBe(404);
    expect(versuch.headers.get("set-cookie")).toBe(null);

    // Die Websites selbst laufen weiter — der Betriebsfehler darf keine Seite abschalten.
    expect(await status(base, "kunde-a.test", "/")).toBe(200);
    expect(await status(base, "kunde-c.test", "/")).toBe(200);
    // Und der unbeteiligte Kunde bleibt völlig unberührt.
    expect(await status(base, "kunde-b.test", "/edit/login")).toBe(200);
  });

  test("Kopie im laufenden Betrieb wird ebenfalls erkannt", async () => {
    const { root, siteA } = await bootMitKopie();
    const { base, versand } = startAuf(root);
    const cookieA = await meldeAn(base, KENNUNG_PW_A, versand, { host: "kunde-a.test" });
    expect(await status(base, "kunde-a.test", "/edit", cookieA)).toBe(200);

    cpSync(siteA, join(root, "kunde-c.test"), { recursive: true });
    await Bun.sleep(SECRET_SCAN_TTL_MS + 200);

    expect(await status(base, "kunde-c.test", "/edit", cookieA)).toBe(404);
    expect(await status(base, "kunde-a.test", "/edit", cookieA)).toBe(404);
    expect(await status(base, "kunde-a.test", "/")).toBe(200);
  });

  test("erkannt auch dann, wenn nur EINE der beiden Seiten je angefragt wird", async () => {
    // Eine Wache, die sich nur gesehene Geheimnisse merkt, ist hier dauerhaft
    // blind: Das Geheimnis der nie angefragten Seite wird nie ein zweites Mal
    // vorgelegt, also nie verglichen. Deshalb Durchsicht statt Gedächtnis.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "regoro-einseitig-")));
    dirs.push(root);
    const { base } = startAuf(root); // Sammelverzeichnis ist beim Start LEER

    const siteA = join(root, "kunde-a.test");
    cpSync(REAL_SITE, siteA, { recursive: true });
    await createAuthFile(siteA, [KENNUNG_PW_A]);
    cpSync(siteA, join(root, "kunde-b.test"), { recursive: true });
    await Bun.sleep(SECRET_SCAN_TTL_MS + 200);

    // Nur B wird je angefragt — A kein einziges Mal.
    const versuch = await fetch(`${base}/edit/login`, {
      method: "POST",
      headers: { Host: "kunde-b.test", "content-type": "application/x-www-form-urlencoded" },
      body: `kennung=${encodeURIComponent(KENNUNG_PW_A)}&weg=sms`,
      redirect: "manual",
    });
    expect(versuch.status).toBe(404);
    expect(versuch.headers.get("set-cookie")).toBe(null);
    expect(await status(base, "kunde-b.test", "/edit/login")).toBe(404);
    expect(await status(base, "kunde-b.test", "/")).toBe(200);
  });

  test("behobene Kollision heilt ohne Neustart — auch für die unveränderte Seite", async () => {
    // Die Fehlermeldung verspricht `regoro init --force` auf EINER Seite. Wenn
    // der Kollisionsvermerk im Gedächtnis bliebe, bliebe die andere, unschuldige
    // Seite bis zum Neustart gesperrt — obwohl der Betreiber alles richtig machte.
    const { root, siteA } = await bootMitKopie();
    const kopie = join(root, "kunde-c.test");
    cpSync(siteA, kopie, { recursive: true });
    const { base, versand } = startAuf(root);
    expect(await status(base, "kunde-a.test", "/edit/login")).toBe(404);
    expect(await status(base, "kunde-c.test", "/edit/login")).toBe(404);

    // Das tut `regoro init --force`: frisches Secret, frische Kontaktwege.
    // createAuthFile überschreibt kommentarlos — genau das tut `init --force`.
    await createAuthFile(kopie, ["+4930111222333"]);
    await Bun.sleep(SECRET_SCAN_TTL_MS + 200);

    expect(await status(base, "kunde-a.test", "/edit/login")).toBe(200);
    expect(await status(base, "kunde-c.test", "/edit/login")).toBe(200);
    // Und die Anmeldung funktioniert auf beiden Seiten wieder, mit je eigenem Secret.
    const cookie = await meldeAn(base, KENNUNG_PW_A, versand, { host: "kunde-a.test" });
    expect(await status(base, "kunde-a.test", "/edit", cookie)).toBe(200);
  });

  test("ein Alias-Symlink auf DENSELBEN Ordner ist keine Kollision", async () => {
    const { root, siteA } = await bootMitKopie();
    symlinkSync(siteA, join(root, "kunde-alt.test"));
    const { base, versand } = startAuf(root);

    // Zwei Hostnamen, ein Ordner — legitim, beide müssen funktionieren.
    expect(await status(base, "kunde-a.test", "/edit/login")).toBe(200);
    expect(await status(base, "kunde-alt.test", "/edit/login")).toBe(200);
    const cookie = await meldeAn(base, KENNUNG_PW_A, versand, { host: "kunde-alt.test" });
    expect(await status(base, "kunde-alt.test", "/edit", cookie)).toBe(200);
  });
});
