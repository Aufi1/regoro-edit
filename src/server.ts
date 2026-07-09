/**
 * Host-Entrypoint: Bun.serve hinter einem Reverse-Proxy (TLS dort).
 *
 * Auth ist datei-basiert (<siteDir>/.regoro/auth.json). Ohne Auth-Datei startet
 * der Server trotzdem (fail-closed: /edit → 404), gibt aber eine Warnung aus.
 * Setup: `regoro-edit init <dir>`.
 */
import { join, relative, sep } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { handleEditorRequest, isEditorPath, type HostCtx } from "./host.ts";
import { authFilePath, loadAuthFile } from "./auth.ts";

const PAGE_RE = /^[a-z0-9-]+\.html$/;

export interface ServerOptions {
  siteDir: string;
  repoRoot: string;
  pageWhitelist?: string[];
  port?: number;
}

/**
 * Listet die top-level .html-Seiten in siteDir (Allowlist-Regex), sortiert.
 * Leeres Array, wenn keine passende Datei existiert — im Gegensatz zu
 * discoverPages ohne Fallback, damit Aufrufer "keine Seiten" erkennen können.
 */
export function listPageFiles(siteDir: string): string[] {
  try {
    return readdirSync(siteDir, { withFileTypes: true })
      .filter((e) => e.isFile() && PAGE_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Findet die top-level .html-Seiten in siteDir (Allowlist-Regex). Fällt auf
 * ["index.html"] zurück, wenn keine passende Datei gefunden wird.
 */
export function discoverPages(siteDir: string): string[] {
  const entries = listPageFiles(siteDir);
  return entries.length > 0 ? entries : ["index.html"];
}

export function startServer(opts: ServerOptions): { port: number } {
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

  const port = opts.port ?? Number(process.env.PORT ?? 8788);

  const server = Bun.serve({
    port,
    // Knapp über dem 5-MB-Upload-Limit: Bun kappt überlange Bodies hart, bevor der
    // Editor sie via req.formData() puffert → Schutz gegen Memory-DoS.
    maxRequestBodySize: 6 * 1024 * 1024,
    fetch(req) {
      const url = new URL(req.url);
      // `ctx.auth` wurde beim Start geladen. Verschwindet die Auth-Datei danach
      // (`regoro disable`), muss der Editor SOFORT aus sein — sonst editieren
      // gültige Cookies weiter, obwohl der Betreiber den Zugang entzogen hat.
      // Nur auf Editor-Routen geprüft; die öffentliche Site kostet es nichts.
      // Der Check sitzt hier statt im Router: host.ts ist eine reine HTTP-Schicht
      // über einem übergebenen ctx und soll den Plattenzustand nicht befragen.
      if (ctx.auth !== null && isEditorPath(url.pathname) && !existsSync(authFilePath(opts.siteDir))) {
        return new Response("Not Found", {
          status: 404,
          headers: { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" },
        });
      }
      return handleEditorRequest(req, url, ctx);
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
