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
import { join, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import {
  handleEditorRequest,
  isEditorPath,
  notFound,
  type AnfrageZeitgrenze,
  type HostCtx,
} from "./host.ts";
import { authFilePath, loadAuthFile, pruefeAuthDatei } from "./auth.ts";
import { ladeVersand, type Versand } from "./versand.ts";
import { loadKiConfig } from "./betreiber-config.ts";
import { raeumeVerwaisteAuf } from "./arbeitskopie.ts";
// Seiten-Ermittlung wohnt in sites.ts — sie gehört zur Website, nicht zum Server.
import { buildCtx, discoverPages, erstelleSecretWache, resolveSite } from "./sites.ts";

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
  repoRoot: string;
  pageWhitelist?: string[];
  port?: number;
  sitesRoot?: undefined;
  /** Abweichender Pfad zu versand.json (Tests, lokales Ausprobieren). */
  versandConfig?: string;
  /** Direkt gesetzter Versand — hat Vorrang vor versandConfig (Tests). */
  versand?: Versand | null;
}

interface MultiSiteOptions {
  sitesRoot: string;
  port?: number;
  siteDir?: undefined;
  repoRoot?: undefined;
  pageWhitelist?: undefined;
  versandConfig?: string;
  versand?: Versand | null;
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
  let seiten = festeListe ?? discoverPages(opts.siteDir);
  let seitenGelesen = Date.now();

  // git-Pfad-Präfix der Seiten relativ zum repoRoot (posix-normalisiert).
  // Gleicher Pfad (siteDir === repoRoot) → "" (Seiten liegen top-level).
  const rawPrefix = relative(opts.repoRoot, opts.siteDir);
  const sitePrefix = rawPrefix === "" ? "" : rawPrefix.split(sep).join("/");

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
    repoRoot: opts.repoRoot,
    siteDir: opts.siteDir,
    auth,
    sitePrefix,
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
        seiten = discoverPages(opts.siteDir);
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
    return handleEditorRequest(req, url, buildCtx(site, wache, versand), srv);
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
    opts.sitesRoot !== undefined
      ? multiSiteHandler(opts.sitesRoot, versand)
      : singleSiteHandler(opts, versand);

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
  // Rückwärts-kompatibler Bootstrap für regoro: site/ unter cwd.
  const repoRoot = process.cwd();
  const siteDir = process.env.SITE_DIR ?? join(repoRoot, "site");
  const { port } = startServer({ siteDir, repoRoot });
  console.log(`Regoro Editor läuft auf http://localhost:${port}/edit/login`);
}
