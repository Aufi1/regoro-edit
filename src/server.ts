/**
 * Host-Entrypoint: Bun.serve hinter einem Reverse-Proxy (TLS dort).
 *
 * Auth ist datei-basiert (<siteDir>/.regoro/auth.json). Ohne Auth-Datei startet
 * der Server trotzdem (fail-closed: /edit → 404), gibt aber eine Warnung aus.
 * Setup: `regoro-edit init <dir>`.
 */
import { join, relative, sep } from "node:path";
import { readdirSync } from "node:fs";
import { handleEditorRequest, type HostCtx } from "./host.ts";
import { loadAuthFile } from "./auth.ts";

const PAGE_RE = /^[a-z0-9-]+\.html$/;

export interface ServerOptions {
  siteDir: string;
  repoRoot: string;
  pageWhitelist?: string[];
  port?: number;
}

/**
 * Findet die top-level .html-Seiten in siteDir (Allowlist-Regex). Fällt auf
 * ["index.html"] zurück, wenn keine passende Datei gefunden wird.
 */
export function discoverPages(siteDir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(siteDir, { withFileTypes: true })
      .filter((e) => e.isFile() && PAGE_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    entries = [];
  }
  return entries.length > 0 ? entries.sort() : ["index.html"];
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
      return handleEditorRequest(req, new URL(req.url), ctx);
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
