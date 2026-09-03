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
import { handleEditorRequest, isEditorPath, notFound, type HostCtx } from "./host.ts";
import { authFilePath, loadAuthFile } from "./auth.ts";
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
}

interface MultiSiteOptions {
  sitesRoot: string;
  port?: number;
  siteDir?: undefined;
  repoRoot?: undefined;
  pageWhitelist?: undefined;
}

/** Genau eines von `siteDir` (Einzel-) und `sitesRoot` (Sammelbetrieb). */
export type ServerOptions = SingleSiteOptions | MultiSiteOptions;

type Handler = (req: Request, url: URL) => Response | Promise<Response>;

/**
 * Einzelbetrieb: HostCtx einmalig beim Start. Unverändertes Verhalten —
 * inklusive des Kill-Switches, der `regoro disable` sofort wirken lässt.
 */
function singleSiteHandler(opts: SingleSiteOptions): Handler {
  const pageWhitelist = opts.pageWhitelist ?? discoverPages(opts.siteDir);

  // git-Pfad-Präfix der Seiten relativ zum repoRoot (posix-normalisiert).
  // Gleicher Pfad (siteDir === repoRoot) → "" (Seiten liegen top-level).
  const rawPrefix = relative(opts.repoRoot, opts.siteDir);
  const sitePrefix = rawPrefix === "" ? "" : rawPrefix.split(sep).join("/");

  const auth = loadAuthFile(opts.siteDir);
  if (auth === null) {
    console.warn(
      "[regoro-edit] Keine Auth-Datei gefunden — /edit ist deaktiviert (fail-closed → 404). " +
        "Setup: regoro-edit init <dir>",
    );
  }

  const ctx: HostCtx = {
    repoRoot: opts.repoRoot,
    siteDir: opts.siteDir,
    pageWhitelist,
    auth,
    sitePrefix,
  };

  return (req, url) => {
    // `ctx.auth` wurde beim Start geladen. Verschwindet die Auth-Datei danach
    // (`regoro disable`), muss der Editor SOFORT aus sein — sonst editieren
    // gültige Cookies weiter, obwohl der Betreiber den Zugang entzogen hat.
    // Nur auf Editor-Routen geprüft; die öffentliche Site kostet es nichts.
    // Der Check sitzt hier statt im Router: host.ts ist eine reine HTTP-Schicht
    // über einem übergebenen ctx und soll den Plattenzustand nicht befragen.
    if (ctx.auth !== null && isEditorPath(url.pathname) && !existsSync(authFilePath(opts.siteDir))) {
      return notFound();
    }
    return handleEditorRequest(req, url, ctx);
  };
}

/**
 * Sammelbetrieb: der Host-Header entscheidet bei JEDER Anfrage, um wessen
 * Website es geht. Unbekannt, fehlend oder manipuliert → 404, nie eine Vermutung.
 *
 * Einen eigenen Kill-Switch braucht dieser Zweig nicht: `buildCtx` liest
 * `auth.json` pro Anfrage, `regoro disable` wirkt dadurch von selbst sofort.
 */
function multiSiteHandler(sitesRootRaw: string): Handler {
  const sitesRoot = resolve(sitesRootRaw);
  // Zwei Ordner mit demselben Sitzungs-Geheimnis sind ein Betriebsfehler und
  // heben die Kundentrennung auf. Die Wache sieht das Sammelverzeichnis reihum
  // durch — auch später angelegte Duplikate fliegen so auf, und eine behobene
  // Kollision heilt ohne Neustart.
  const wache = erstelleSecretWache(sitesRoot);
  return (req, url) => {
    if (url.pathname === TLS_ASK_PATH) {
      return resolveSite(sitesRoot, url.searchParams.get("domain"))
        ? new Response("ok", { status: 200, headers: { "Cache-Control": "no-store" } })
        : notFound();
    }
    const site = resolveSite(sitesRoot, req.headers.get("host"));
    if (site === null) return notFound();
    return handleEditorRequest(req, url, buildCtx(site, wache));
  };
}

export function startServer(opts: ServerOptions): { port: number } {
  const port = opts.port ?? Number(process.env.PORT ?? 8788);
  const handler =
    opts.sitesRoot !== undefined ? multiSiteHandler(opts.sitesRoot) : singleSiteHandler(opts);

  const server = Bun.serve({
    port,
    // Knapp über dem 5-MB-Upload-Limit: Bun kappt überlange Bodies hart, bevor der
    // Editor sie via req.formData() puffert → Schutz gegen Memory-DoS.
    maxRequestBodySize: 6 * 1024 * 1024,
    fetch(req) {
      // Der Host-Header landet in req.url. Ein manipulierter Wert ("../kunde.de")
      // ergibt eine ungültige URL — new URL() würfe, Bun antwortete mit 500 und
      // verriete damit, dass der Wert überhaupt verarbeitet wurde. Fail-closed: 404.
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return notFound();
      }
      return handler(req, url);
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
