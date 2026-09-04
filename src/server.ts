/**
 * Host-Entrypoint: Bun.serve hinter einem Reverse-Proxy (TLS dort).
 *
 * Zwei Betriebsarten:
 *   Einzelbetrieb  (`siteDir`)   — ein Prozess, eine Website. Der HostCtx
 *                                  entsteht EINMAL beim Start.
 *   Sammelbetrieb  (`sitesRoot`) — ein Prozess, viele Websites. Der HostCtx
 *                                  entsteht PRO ANFRAGE aus dem Host-Header
 *                                  (siehe sites.ts, CLAUDE.md Invariante 10).
 *
 * Auth ist datei-basiert (<siteDir>/.regoro/auth.json). Ohne Auth-Datei startet
 * der Server trotzdem (fail-closed: /edit → 404), gibt aber eine Warnung aus.
 * Setup: `regoro init <dir>`.
 */
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  handleEditorRequest,
  isEditorPath,
  notFound,
  type AnfrageZeitgrenze,
  type HostCtx,
} from "./host.ts";
import {
  authFilePath,
  checkCookie,
  issueCookie,
  loadAuthFile,
  pruefeAuthDatei,
  readCookieTokens,
  type AuthConfig,
} from "./auth.ts";
import { ladeVersand, type Versand } from "./versand.ts";
import { loadKiConfig } from "./betreiber-config.ts";
import { raeumeVerwaisteAuf, schwebendPfad } from "./arbeitskopie.ts";
import { entwurfPfad } from "./entwurf.ts";
// Seiten-Ermittlung wohnt in sites.ts — sie gehört zur Website, nicht zum Server.
import {
  buildCtx,
  discoverPages,
  erstelleSecretWache,
  resolveSite,
  resolveStagingPath,
  STAGING_PREFIX,
  type SiteRef,
} from "./sites.ts";

/**
 * Endpunkt für Caddys `on_demand_tls { ask … }`: 200, wenn für diesen Namen
 * eine Website existiert, sonst 404. Ohne ihn könnte jeder fremde Hostname auf
 * den Server zeigen und Zertifikatsanfragen auslösen, bis Let's Encrypt drosselt.
 *
 * Der Endpunkt verrät, welche Namen hier bedient werden — aber nicht mehr als
 * das Host-Routing selbst: eine schlichte Anfrage mit gesetztem Host-Header ist
 * dasselbe Orakel. Deshalb keine zusätzliche Absicherung, sondern der Verzicht
 * darauf, ihn im Proxy überhaupt zu veröffentlichen (siehe caddyBlock).
 */
export const TLS_ASK_PATH = "/_regoro/tls-ask";

interface SingleSiteOptions {
  siteDir: string;
  pageWhitelist?: string[];
  port?: number;
  sitesRoot?: undefined;
  staging?: undefined;
  /** Abweichender Pfad zu versand.json (Tests, lokales Ausprobieren). */
  versandConfig?: string;
  /** Direkt gesetzter Versand — hat Vorrang vor versandConfig (Tests). */
  versand?: Versand | null;
}

interface MultiSiteOptions {
  sitesRoot: string;
  port?: number;
  siteDir?: undefined;
  pageWhitelist?: undefined;
  versandConfig?: string;
  versand?: Versand | null;
  /**
   * Staging (Preview): Zuordnung über `/p/<slug>/` statt über den Host-Header,
   * und **keine Anmeldung**.
   *
   * Die Fahne hängt am PROZESS und nicht am Kundenordner — ein Schalter je
   * Website wäre eine Datei, die jemand versehentlich mitkopiert, und dann
   * stünde eine echte Kundenwebsite ohne Anmeldung offen. Der
   * Produktionsprozess wird nie mit dieser Fahne gestartet.
   */
  staging?: boolean;
}

/** Genau eines von `siteDir` (Einzel-) und `sitesRoot` (Sammelbetrieb). */
export type ServerOptions = SingleSiteOptions | MultiSiteOptions;

type Handler = (
  req: Request,
  url: URL,
  srv?: AnfrageZeitgrenze,
) => Response | Promise<Response>;

/**
 * Lädt den Versand einmal beim Start. Eine kaputte Konfiguration bricht den
 * Server NICHT ab — die Websites sollen weiterlaufen —, aber sie steht laut im
 * Log, und ohne Versand ist keine Anmeldung möglich (fail-closed).
 */
function ladeVersandSicher(opts: ServerOptions): Versand | null {
  if (opts.versand !== undefined) return opts.versand;
  try {
    const v = ladeVersand(opts.versandConfig);
    if (v === null) {
      console.warn(
        "[regoro] Kein Versand eingerichtet — eine Anmeldung ist nicht möglich. " +
          "Einrichten: /etc/regoro/versand.json (siehe README).",
      );
    }
    return v;
  } catch (err) {
    console.error(`[regoro] Versand-Konfiguration unbrauchbar: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Wie lange eine ermittelte Seitenliste im Einzelbetrieb gilt.
 *
 * Vorbild und Begründung wie bei `SECRET_SCAN_TTL_MS` in sites.ts: Der
 * öffentliche Zweig liefert auch Assets aus, und `resolvePage` fragt die Liste
 * bei JEDER Anfrage. Ohne Deckelung löste eine Seite mit dreißig Bildern
 * dreißig zusätzliche `readdir` aus. Eine Sekunde ist kurz genug, dass niemand
 * sie bemerkt, und lang genug, dass die Deckelung wirkt.
 */
const SEITEN_SCAN_TTL_MS = 1000;

/**
 * Einzelbetrieb: HostCtx einmalig beim Start — mit zwei verzögerten Feldern.
 * Inklusive des Kill-Switches, der `regoro disable` sofort wirken lässt.
 */
function singleSiteHandler(opts: SingleSiteOptions, versand: Versand | null): Handler {
  // Eine ausdrücklich übergebene Liste bleibt fest: Der Aufrufer hat sich dann
  // bewusst festgelegt (Tests tun das), und ein heimliches Nachladen von Platte
  // wäre etwas anderes als das, wonach er gefragt hat.
  const festeListe = opts.pageWhitelist;
  const entwurfDir = entwurfPfad(opts.siteDir);
  let seiten = festeListe ?? discoverPages(entwurfDir);
  let seitenGelesen = Date.now();

  const befund = pruefeAuthDatei(opts.siteDir);
  const auth = befund.art === "ok" ? befund.auth : null;
  if (befund.art === "veraltet") {
    // Klar benennen statt „keine Auth-Datei": Die Datei ist da, sie ist nur aus
    // der Zeit vor den Einmalcodes. Ein stillschweigender Weiterbetrieb mit
    // Passwort wäre schlimmer als ein deutlicher Abbruch.
    console.error(
      `[regoro] ${authFilePath(opts.siteDir)} ist im alten Passwort-Format — der Editor bleibt aus.\n` +
        "  Es gibt kein Passwort mehr; der Nachweis ist ein Einmalcode an eine hinterlegte\n" +
        "  Telefonnummer oder E-Mail-Adresse. Neu einrichten:\n" +
        `  regoro init --force ${opts.siteDir} --nummer <nummer-oder-mail>`,
    );
  } else if (befund.art === "ungueltig") {
    console.error(
      `[regoro] ${authFilePath(opts.siteDir)} ist unbrauchbar (${befund.grund}) — der Editor bleibt aus.`,
    );
  } else if (befund.art === "fehlt") {
    console.warn(
      "[regoro] Keine Auth-Datei gefunden — /edit ist deaktiviert (fail-closed → 404). " +
        "Einrichten: regoro init <dir> --nummer <nummer-oder-mail>",
    );
  }

  const ctx: HostCtx = {
    // Die Historie lebt im Entwurfs-Repo (Invariante 9). Wohin sie zeigt, ist
    // deshalb keine Angabe des Aufrufers mehr, sondern folgt aus dem
    // Site-Ordner — es gibt genau einen richtigen Ort.
    repoRoot: entwurfDir,
    entwurfDir,
    schwebendDir: schwebendPfad(opts.siteDir),
    siteDir: opts.siteDir,
    basis: "",
    staging: false,
    auth,
    // Der Arbeitsbaum des Entwurfs-Repos IST die Website, die Seiten liegen
    // darin top-level.
    sitePrefix: "",
    /**
     * Verzögert und mit kurzer Gültigkeit, NICHT einmalig beim Start.
     *
     * Nachgemessen an einem echten Agentenlauf: Der Agent legte
     * `oeffnungszeiten.html` an und verlinkte sie in der Navigation ALLER
     * Seiten. Mit einer beim Start eingefrorenen Liste antwortete der Server
     * darauf 404 — öffentlich wie im Editor. Das Ergebnis war also nicht „hat
     * nicht geklappt", sondern eine Website mit einem toten Link auf jeder
     * Seite, bis jemand den Dienst neu startet. Genau das darf ein misslungener
     * oder auch ein geglückter Lauf nicht anrichten.
     *
     * Im Sammelbetrieb stellt sich die Frage nicht: `buildCtx` entsteht dort
     * ohnehin je Anfrage.
     */
    get pageWhitelist(): string[] {
      if (festeListe) return festeListe;
      const jetzt = Date.now();
      if (jetzt - seitenGelesen >= SEITEN_SCAN_TTL_MS) {
        seitenGelesen = jetzt;
        // Aus dem ENTWURF: eine dort neu angelegte Seite muss in der Liste des
        // Editors stehen, bevor sie je veröffentlicht wurde.
        seiten = discoverPages(entwurfDir);
      }
      return seiten;
    },
    versand,
    // Bewusst ein Getter und bewusst OHNE Gedächtnis: Dieser Ctx lebt, anders
    // als im Sammelbetrieb, über die gesamte Prozesslaufzeit. Ein gemerkter
    // Wert hieße, dass `regoro ki --off` erst nach einem Neustart wirkte —
    // der Betreiber hätte keinen sofortigen Hebel gegen einen Zugang, der
    // Geld kostet. Der Preis ist ein Dateizugriff je Zugriff auf ctx.ki, und
    // den gibt es nur auf den Editor-Routen, nicht auf der öffentlichen Site.
    get ki() {
      return loadKiConfig();
    },
  };

  return (req, url, srv) => {
    // `ctx.auth` wurde beim Start geladen. Verschwindet die Auth-Datei danach
    // (`regoro disable`), muss der Editor SOFORT aus sein — sonst editieren
    // gültige Cookies weiter, obwohl der Betreiber den Zugang entzogen hat.
    // Nur auf Editor-Routen geprüft; die öffentliche Site kostet es nichts.
    // Der Check sitzt hier statt im Router: host.ts ist eine reine HTTP-Schicht
    // über einem übergebenen ctx und soll den Plattenzustand nicht befragen.
    if (ctx.auth !== null && isEditorPath(url.pathname) && !existsSync(authFilePath(opts.siteDir))) {
      return notFound();
    }
    return handleEditorRequest(req, url, ctx, srv);
  };
}

/**
 * Sammelbetrieb: der Host-Header entscheidet bei JEDER Anfrage, um wessen
 * Website es geht. Unbekannt, fehlend oder manipuliert → 404, nie eine Vermutung.
 *
 * Einen eigenen Kill-Switch braucht dieser Zweig nicht: `buildCtx` liest
 * `auth.json` pro Anfrage, `regoro disable` wirkt dadurch von selbst sofort.
 */
function multiSiteHandler(sitesRootRaw: string, versand: Versand | null): Handler {
  const sitesRoot = resolve(sitesRootRaw);
  // Zwei Ordner mit demselben Sitzungs-Geheimnis sind ein Betriebsfehler und
  // heben die Kundentrennung auf. Die Wache sieht das Sammelverzeichnis reihum
  // durch — auch später angelegte Duplikate fliegen so auf, und eine behobene
  // Kollision heilt ohne Neustart.
  const wache = erstelleSecretWache(sitesRoot);
  return (req, url, srv) => {
    if (url.pathname === TLS_ASK_PATH) {
      return resolveSite(sitesRoot, url.searchParams.get("domain"))
        ? new Response("ok", { status: 200, headers: { "Cache-Control": "no-store" } })
        : notFound();
    }
    const site = resolveSite(sitesRoot, req.headers.get("host"));
    if (site === null) return notFound();
    return handleEditorRequest(req, url, buildCtx(site, { wache, versand }), srv);
  };
}

/**
 * Der Zutritt zum Staging-Editor — **und der einzige Ort, an dem er wohnt**.
 *
 * Eine Preview kennt keine Anmeldung: Der Interessent bekommt einen Link, und
 * dahinter steht ein bedienbarer Editor. Die Auth-Wand in `host.ts` wird dafür
 * NICHT angefasst (Contract C12); sie prüft weiter echt gegen das
 * site-eigene Geheimnis. Nur der Aussteller des Cookies ist hier ein anderer:
 * Statt Kennung und Einmalcode genügt der Aufruf der Adresse.
 *
 * **Warum das strukturell und nicht per Fahne gelöst ist:** Der
 * Produktionsprozess enthält diesen Code nicht — `multiSiteHandler` ruft ihn
 * nirgends. Es gibt dort also keinen Zustand, den jemand falsch setzen könnte,
 * damit eine Kundenwebsite ohne Anmeldung aufgeht. Dieselbe Überlegung wie beim
 * Verzicht auf eine Fahne in `auth.json`, eine Ebene tiefer.
 *
 * **Kein Redirect.** Der naheliegende Weg — Cookie setzen und auf dieselbe URL
 * umleiten — hat zwei Nachteile: Eine API-Anfrage des Overlays kann mit einer
 * Umleitung auf sich selbst nichts anfangen, und verwirft der Browser das
 * `Secure`-Cookie (HTTP unter fremdem Namen, siehe EDITOR_INSECURE_COOKIE),
 * entsteht eine Anmeldeschleife ohne jede Fehlermeldung. Stattdessen wird das
 * frische Cookie in DIESELBE Anfrage geprägt und der Antwort als `Set-Cookie`
 * beigelegt; die erste Anfrage wird also schon beantwortet.
 */
function stagingZutritt(
  req: Request,
  auth: AuthConfig,
): { setCookie: string } | null {
  // Ein gültiges Cookie ist da? Dann nichts tun — sonst bekäme jede Anfrage ein
  // neues, und zwei Tabs überschrieben einander fortlaufend.
  if (readCookieTokens(req.headers.get("cookie")).some((t) => checkCookie(auth, t))) {
    return null;
  }
  const setCookie = issueCookie(auth);
  // Aus "name=token; Path=/; …" wird der Cookie-Kopf "name=token".
  const paar = setCookie.split(";", 1)[0]!;

  /**
   * DIE HEADER DER ANFRAGE WERDEN AN ORT UND STELLE GEÄNDERT — nicht über einen
   * neu gebauten `new Request(req, { headers })`. Das ist kein Stilfrage,
   * sondern gemessen:
   *
   *   Bun 1.x, `idleTimeout: 2`, ein Strom der 4 s schweigt
   *     req.headers.set(…), danach srv.timeout(req, 0)   → spätes Byte kommt an
   *     new Request(req, {headers}), srv.timeout(r2, 0)  → Verbindung abgeschnitten
   *     gar kein timeout-Aufruf (Gegenprobe)             → Verbindung abgeschnitten
   *
   * `srv.timeout()` erkennt einen rekonstruierten Request nicht wieder und
   * ignoriert ihn STILLSCHWEIGEND — es wirft nicht. Der Ereignisstrom der
   * KI-Seitenleiste (`srv.timeout(req, 0)` in `handleAgentEvents`) wäre damit
   * ausschließlich im Staging nach zehn Sekunden Stille tot, ohne Fehler
   * irgendwo. Wer das hier "sauberer" macht, baut genau diesen Fehler ein.
   */
  req.headers.set("cookie", paar);
  return { setCookie };
}

/**
 * Das Sitzungs-Geheimnis einer Preview.
 *
 * Hat der Ordner eine `auth.json` (weil `regoro init` dort lief), gilt deren
 * Geheimnis — dasselbe wie in Produktion. Hat er keine, entsteht hier ein
 * flüchtiges, das nur im Arbeitsspeicher dieses Prozesses lebt.
 *
 * **Warum nicht einfach eine `auth.json` anlegen?** Weil das Anlegen dann an
 * einer UNAUTHENTIFIZIERTEN Anfrage hinge: Ein GET von irgendwem schriebe
 * Dateien ins Sammelverzeichnis. Dazu käme eine erfundene Kennung (ohne
 * mindestens eine wirft `createAuthFile`, und `pruefeAuthDatei` lehnt eine
 * leere Liste als ungültig ab), und `createAuthFile` überschreibt eine
 * bestehende Datei kommentarlos — in einem Anfrage-Pfad die falsche Waffe.
 *
 * Der Preis ist gering: Nach einem Neustart des Dienstes ist das Geheimnis weg
 * und die offenen Preview-Sitzungen sind ungültig. Beim nächsten Aufruf des
 * Links wird ein neues geprägt — dem Interessenten fällt nichts auf.
 *
 * Der Schlüssel ist der REALE Ordnerpfad, nicht der Slug: Zwei Slugs, die per
 * Symlink auf dasselbe Verzeichnis zeigen, sind dieselbe Preview.
 */
function fluechtigesGeheimnis(siteDir: string, speicher: Map<string, AuthConfig>): AuthConfig {
  let vorhanden = speicher.get(siteDir);
  if (vorhanden === undefined) {
    vorhanden = { nummern: [], emails: [], secret: randomBytes(32).toString("hex") };
    speicher.set(siteDir, vorhanden);
  }
  return vorhanden;
}

/**
 * Repariert eine Anfrage, der das Preview-Präfix fehlt.
 *
 * Eine Fabrik-Seite verlinkt wurzel-absolut (`href="/impressum.html"`,
 * `href="/"`). Unter `/p/<slug>/` fragt der Browser diese Pfade OHNE Präfix an,
 * und damit wäre in der Vorschau die gesamte Navigation tot — nachgesehen an
 * `examples/site`, dort steht genau diese Form.
 *
 * Trägt die Anfrage einen gleich-originen `Referer`, der unter einer gültigen
 * Preview liegt, wird sie dorthin umgeleitet. Fehlt der Referer, bleibt es beim
 * 404 von vorher — die Reparatur nimmt also nichts weg, sie gibt nur etwas
 * zurück.
 *
 * Kein Open-Redirect: Das Ziel ist immer `basis + pfad`, beginnt also mit
 * `/p/`, ist nie protokoll-relativ und zeigt nie auf einen fremden Host. Und
 * kein Rechtezuwachs: Wer den Referer setzen kann, könnte die Zieladresse auch
 * direkt aufrufen.
 *
 * `Cache-Control: no-store` ist Pflicht — die Umleitung gilt NUR zusammen mit
 * dem Referer, der sie begründet. Ein Zwischenspeicher, der sie behielte,
 * schickte später auch Anfragen ohne Referer in die falsche Preview.
 */
function praefixReparatur(req: Request, url: URL, sitesRoot: string): Response | null {
  // Was schon unter `/p/` liegt, ist nicht falsch adressiert, sondern hat einen
  // unzulässigen Slug — daran ändert ein Referer nichts.
  if (url.pathname.startsWith(STAGING_PREFIX)) return null;

  const referer = req.headers.get("referer");
  if (referer === null) return null;
  let herkunft: URL;
  try {
    herkunft = new URL(referer);
  } catch {
    return null;
  }
  // Nur der eigene Host. Verglichen wird der Name, nicht die Herkunft: hinter
  // dem Proxy spricht der Browser https, dieser Prozess hört http.
  if (herkunft.host !== url.host) return null;

  const treffer = resolveStagingPath(sitesRoot, herkunft.pathname);
  if (treffer === null) return null;

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${treffer.basis}${url.pathname}${url.search}`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Staging: der Pfad-Abschnitt `/p/<slug>/` entscheidet, um wessen Website es
 * geht. Unbekannt oder kein sauberer Slug → 404, nie eine Vermutung.
 *
 * Hostbasierte Adressen bedient dieser Zweig ABSICHTLICH nicht: Sonst wäre jede
 * Preview zusätzlich unter ihrem Ordnernamen als Host erreichbar — und zwar
 * ohne Anmeldung.
 *
 * Ohne `SecretWache`, anders als im Sammelbetrieb. Preview-Ordner entstehen aus
 * einer Vorlage, geteilte Geheimnisse sind dort also der wahrscheinliche Fall,
 * und die Wache schaltete reihenweise Editoren ab. Sie kaufte hier auch nichts:
 * Ein geteiltes Geheimnis hieße, dass das Cookie von Preview A auch bei B gilt
 * — um B zu erreichen, braucht man aber B's Slug, und wer den hat, bekommt dort
 * ohnehin ein Cookie ausgestellt (siehe `stagingZutritt`). Es geht nichts
 * verloren, was nicht schon offen wäre. **In Produktion gilt das nicht**, dort
 * bleibt die Wache scharf: Ein Cookie ersetzt dort einen Einmalcode.
 */
function stagingHandler(sitesRootRaw: string, versand: Versand | null): Handler {
  const sitesRoot = resolve(sitesRootRaw);
  const geheimnisse = new Map<string, AuthConfig>();

  return async (req, url, srv) => {
    const treffer = resolveStagingPath(sitesRoot, url.pathname);
    if (treffer === null) return praefixReparatur(req, url, sitesRoot) ?? notFound();

    const site: SiteRef = { host: treffer.slug, siteDir: treffer.siteDir };
    const auth =
      loadAuthFile(treffer.siteDir) ?? fluechtigesGeheimnis(treffer.siteDir, geheimnisse);

    // Das Präfix abstreifen, BEVOR `route()` den Pfad sieht — host.ts kennt
    // weiterhin nur `/edit/...` und benutzt `ctx.basis` allein zum ERZEUGEN von
    // URLs. Auf einer Kopie, damit das Original unberührt bleibt; gemessen:
    // der Setter erhält Prozentkodierungen unverändert.
    const innen = new URL(url);
    innen.pathname = treffer.rest;

    const ctx = buildCtx(site, {
      versand,
      basis: treffer.basis,
      staging: true,
      ersatzAuth: auth,
    });

    // Der Zutritt gilt nur den Editor-Routen. Eine öffentliche Seite oder ein
    // Bild braucht kein Cookie — und ein Suchmaschinen-Roboter, der die Vorschau
    // findet, soll keines bekommen.
    const zutritt = isEditorPath(treffer.rest) ? stagingZutritt(req, auth) : null;
    const antwort = await handleEditorRequest(req, innen, ctx, srv);
    if (zutritt === null) return antwort;

    // `Set-Cookie` nachtragen, ohne die Antwort neu zu bauen: Der Körper kann
    // ein laufender Ereignisstrom sein, und den umzupacken hieße, ihn anzufassen.
    antwort.headers.append("Set-Cookie", zutritt.setCookie);
    return antwort;
  };
}

export function startServer(opts: ServerOptions): { port: number } {
  const port = opts.port ?? Number(process.env.PORT ?? 8788);
  // Ein Agentenlauf legt seine Arbeitskopie unter RUNTIME_DIRECTORY an und
  // räumt sie im `finally` wieder weg. Stirbt der Server mittendrin — Neustart,
  // OOM, Stromausfall —, kommt dieses `finally` nie dran und das Verzeichnis
  // bleibt liegen. Über Wochen füllt das /run, bis kein Lauf mehr startet.
  // Deshalb beim Start einmal durchkehren; das ist der einzige Moment, in dem
  // sicher kein eigener Lauf aktiv ist.
  raeumeVerwaisteAuf();
  const versand = ladeVersandSicher(opts);
  const handler =
    opts.sitesRoot === undefined
      ? singleSiteHandler(opts, versand)
      : opts.staging === true
        ? stagingHandler(opts.sitesRoot, versand)
        : multiSiteHandler(opts.sitesRoot, versand);

  const server = Bun.serve({
    port,
    // Knapp über dem 5-MB-Upload-Limit: Bun kappt überlange Bodies hart, bevor der
    // Editor sie via req.formData() puffert → Schutz gegen Memory-DoS.
    maxRequestBodySize: 6 * 1024 * 1024,
    fetch(req, srv) {
      // Der Host-Header landet in req.url. Ein manipulierter Wert ("../kunde.de")
      // ergibt eine ungültige URL — new URL() würfe, Bun antwortete mit 500 und
      // verriete damit, dass der Wert überhaupt verarbeitet wurde. Fail-closed: 404.
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return notFound();
      }
      // `srv` durchreichen: Der Ereignisstrom der KI-Seitenleiste braucht
      // `srv.timeout(req, 0)`, sonst beendet Bun ihn nach 10 s Stille.
      return handler(req, url, srv);
    },
  });

  return { port: server.port ?? port };
}

if (import.meta.main) {
  // Bootstrap für den Direktstart: site/ unter cwd. Wo die Historie liegt, ist
  // keine Angabe mehr — sie folgt aus dem Site-Ordner (Invariante 9).
  const siteDir = process.env.SITE_DIR ?? join(process.cwd(), "site");
  const { port } = startServer({ siteDir });
  console.log(`Regoro Editor läuft auf http://localhost:${port}/edit/login`);
}
