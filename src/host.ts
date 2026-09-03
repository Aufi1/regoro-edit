/**
 * Contract B — Host-Router: dünne HTTP-Schicht über dem Kern.
 *
 * Kennt Auth + Routing, delegiert die eigentliche Logik an contract/serve/apply/git.
 * Auth-Fehler → 404 (nicht 401), außer /edit/login. Alle Antworten noindex/no-store.
 */
import { join, resolve, extname, sep, posix } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { parseHTML } from "linkedom";
// Bun-"file"-Import: liefert einen Pfad, den bun build --compile mit einbettet.
import overlayAsset from "./overlay.client.js" with { type: "file" };
import {
  useSecureCookie,
  isTrustworthyOrigin,
  issueCookie,
  checkCookie,
  readCookieTokens,
  kennungHinterlegt,
  type AuthConfig,
} from "./auth.ts";
import { maskiereKennung, normalisiereKennung, type Kanal } from "./kennung.ts";
import { erzeugeCode, merkeCode, pruefeCode } from "./codes.ts";
import { entsperreKennung, pruefeBremse, wartezeitText } from "./bremse.ts";
import { listeVerlaeufe } from "./verlauf.ts";
import type { Versand } from "./versand.ts";
import type { KiConfig } from "./betreiber-config.ts";
import { renderEditView, renderVersionPreview } from "./serve.ts";
// PAGE_RE und ASSET_TYPES wohnen in sites.ts — sie beschreiben die WEBSITE
// (welche Seiten es gibt, was ausgeliefert wird), nicht den Router. PAGE_RE
// braucht dort ohnehin die Whitelist-Erzeugung; ASSET_TYPES ist mitgezogen,
// damit validate.ts sie ohne Importzyklus lesen kann (Begründung dort).
import { ASSET_TYPES, PAGE_RE } from "./sites.ts";
// Re-Export für Bestandsleser. NEUE Leser importieren aus sites.ts: Ein
// `from "./host.ts"` baut den Zyklus host → agent → validate → host wieder auf,
// und in dem ist die Konstante beim Import des Partners noch nicht initialisiert.
export { ASSET_TYPES, PAGE_RE };
import { applyEdits, setImageSrc, fileSha256, pathInsideSite, type Edit } from "./apply.ts";
import { enumerateImages } from "./contract.ts";
import { brichAb, ereignisse, laufAktiv, starteLauf, type AgentEreignis } from "./agent.ts";
import { pruefeKontingent, TOKEN_KONTINGENT } from "./kontingent.ts";
import {
  ensureRepo,
  commitEdit,
  listVersions,
  showVersion,
  restoreVersion,
} from "./git.ts";

export interface HostCtx {
  repoRoot: string;
  siteDir: string;
  pageWhitelist: string[];
  auth: AuthConfig | null;
  sitePrefix?: string;
  /**
   * Womit der Einmalcode verschickt wird. Fehlt er, ist keine Anmeldung
   * möglich — fail-closed, wie bei fehlender Auth-Datei. Betreiberweit
   * eingerichtet (`/etc/regoro/versand.json`), nicht je Website.
   */
  versand?: Versand | null;
  /**
   * Der betreiberweite Modellzugang (`/etc/regoro/ki.json`). Fehlt er, gibt es
   * die KI-Seitenleiste nicht: alle `/edit/agent*`-Routen antworten 404 und
   * `serve.ts` blendet die Leiste gar nicht erst ins DOM — fail-closed wie bei
   * `auth`.
   *
   * Wird VERZÖGERT gelesen (Getter in `buildCtx`/`singleSiteHandler`), nicht
   * einmal beim Start: sonst wirkte `regoro ki --off` erst nach einem Neustart,
   * und der Betreiber hätte keinen sofortigen Hebel gegen einen Lauf, der Geld
   * kostet.
   *
   * Optional wie `versand`, damit die Ctx-Bauer ihn erst ergänzen müssen, wenn
   * der Lader existiert. Deshalb überall `== null` prüfen, nie `=== null`:
   * `undefined` ist derselbe Fall — „kein Modellzugang".
   */
  ki?: KiConfig | null;
}

/**
 * Der Teil von `Bun.Server`, den der Router braucht — mehr nicht.
 *
 * Gebraucht wird er allein für `server.timeout(req, 0)` auf dem Ereignisstrom:
 * Bun beendet jede Antwort, die `idleTimeout` lang (Vorgabe 10 s) kein Byte
 * geliefert hat. Ein Agentenlauf schweigt minutenlang, während das Modell
 * nachdenkt — ohne diese Abschaltung risse die Seitenleiste reproduzierbar
 * nach zehn Sekunden ab, und zwar erst in Produktion, weil im Test niemand so
 * lange wartet. Ein globales `idleTimeout: 0` wäre der falsche Handel: Es
 * nähme JEDER Anfrage den Schutz vor Stillstand, um ein Problem zu lösen, das
 * eine einzige Route hat.
 *
 * Als schmale Form statt `Bun.Server`, damit ein Test eine Attrappe übergeben
 * und nachweisen kann, dass die Abschaltung wirklich passiert.
 */
export interface AnfrageZeitgrenze {
  timeout(request: Request, seconds: number): void;
}

/**
 * Liefert den git-Pfad einer Seite relativ zum repoRoot, gebaut aus sitePrefix
 * (default "site") + page. Bei sitePrefix==="" liegt die Seite top-level (kein
 * "/"-Präfix). Immer posix-Slashes (git-Pfade).
 */
function pagePathFor(ctx: HostCtx, page: string): string {
  const sitePrefix = ctx.sitePrefix ?? "site";
  return sitePrefix ? posix.join(sitePrefix, page) : page;
}

/**
 * Ist der Pfad eine Editor-Route? Exakt matchen, nicht startsWith("/edit"):
 * eine öffentliche Seite darf "edit-preise.html" heißen.
 *
 * Die Routen der KI-Seitenleiste (`/edit/agent`, `/edit/agent/events|abort|status`)
 * fallen unter `startsWith("/edit/")` und sind damit gedeckt — der Kill-Switch in
 * server.ts (`regoro disable` wirkt sofort) greift für sie ohne Zusatzregel. Nicht
 * auf eine engere Liste umbauen: Eine vergessene Agenten-Route liefe sonst weiter,
 * nachdem der Betreiber den Zugang entzogen hat.
 */
export function isEditorPath(path: string): boolean {
  return (
    path === "/edit" ||
    path.startsWith("/edit/") ||
    path.startsWith("/edit-assets/") ||
    path.endsWith(".html/edit")
  );
}

/**
 * Lehnt jeden Pfad ab, dessen dekodiertes Pfad-Segment mit "." beginnt
 * (.regoro/, .git/, .env, alle Dotfiles). rel ist der bereits dekodierte
 * rel-Pfad ohne führenden Slash. true = blockieren.
 */
function hasDotSegment(rel: string): boolean {
  for (const seg of rel.split("/")) {
    if (seg.startsWith(".")) return true;
  }
  return false;
}

// Nur abgekürzte/volle SHA-Hex-Hashes als git-Ref. Schließt führende "-"
// (Argument-Injection wie `-f`), symbolische Refs (HEAD/main/Tags → Lesen
// fremder Branches) und `..`/`@` aus.
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
// Overlay-Pfad: In der Entwicklung ist das der echte Plattenpfad (jeder Request
// liest frisch — Invariante bleibt), in einem `bun build --compile`-Binary der
// eingebettete /$bunfs/-Pfad. Früher aus import.meta.url gebaut; das zeigte im
// Binary ins Leere → /edit-assets/overlay.js gab 404 und der Editor war stumm
// funktionslos. readFileSync/existsSync können beide Pfade.
const OVERLAY_PATH: string = overlayAsset;

// Bild-Upload: Größenlimit + Magic-Byte-Sniff. SVG bewusst NICHT zugelassen
// (XSS-Risiko durch eingebettetes Script). Liefert die kanonische Extension
// anhand der ECHTEN Signatur (nicht anhand Dateiname/Content-Type).
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

function sniffImageExt(buf: Uint8Array): "png" | "jpg" | "gif" | "webp" | null {
  if (buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  // GIF: 47 49 46 38 ("GIF8")
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "gif";
  // WEBP: "RIFF"...."WEBP" (Bytes 0-3 RIFF, 8-11 WEBP)
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  // nosniff klassenweit: verhindert MIME-Sniffing (Polyglot-Asset mit gültiger
  // Bild-Signatur + eingebettetem HTML/JS wird nicht als HTML interpretiert).
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

function withHeaders(extra: Record<string, string> = {}): Headers {
  const h = new Headers(SECURITY_HEADERS);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: withHeaders({ "Content-Type": "text/html; charset=utf-8", ...extra }),
  });
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: withHeaders({ "Content-Type": "application/json; charset=utf-8", ...extra }),
  });
}

/**
 * 404 mit den Sicherheits-Headern. Exportiert, weil server.ts denselben
 * Abschluss braucht (Kill-Switch, unbekannter Host) und die Header-Menge nicht
 * an zwei Stellen auseinanderlaufen darf.
 */
export function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: withHeaders() });
}

/**
 * Validiert eine Seite gegen Whitelist + Regex und löst auf einen sicheren,
 * innerhalb von siteDir liegenden absoluten Pfad auf. null = abgelehnt (→ 404).
 */
function resolvePage(ctx: HostCtx, page: string): { page: string; abs: string } | null {
  if (!page || !PAGE_RE.test(page)) return null;
  if (!ctx.pageWhitelist.includes(page)) return null;
  const abs = resolve(ctx.siteDir, page);
  // Traversal-Guard: aufgelöster Pfad muss innerhalb siteDir liegen.
  const base = resolve(ctx.siteDir);
  if (abs !== join(base, page) || !abs.startsWith(base + "/")) return null;
  return { page, abs };
}

/**
 * Liefert ein öffentliches statisches Site-Asset (CSS/Bilder/Fonts/...) aus
 * ctx.siteDir aus — OHNE Auth (es ist die public site), nur lesend (GET).
 * Traversal-Guard + Extension-Allowlist; nie etwas außerhalb siteDir oder
 * unter editor/. Liefert null, wenn der Pfad kein gültiges Asset ist (→ 404).
 *
 * urlPath ist der dekodierte Request-Pfad ohne führenden "/" (z.B. "styles.css"
 * oder "assets/logo.webp").
 */
function serveStaticAsset(ctx: HostCtx, urlPath: string): Response | null {
  if (!urlPath || urlPath.includes("\0")) return null;
  // Dotfile-Block (Defense-in-depth): kein Segment darf mit "." beginnen
  // (.regoro/auth.json, .git/, .env …). Weder das Sitzungs-Geheimnis noch die
  // hinterlegten Kontaktwege dürfen je ausgeliefert werden. urlPath ist bereits dekodiert.
  if (hasDotSegment(urlPath)) return null;
  // Extension-Allowlist (case-insensitive); .html ist bewusst NICHT erlaubt.
  const ext = extname(urlPath).toLowerCase();
  const contentType = ASSET_TYPES[ext];
  if (!contentType) return null;

  const base = resolve(ctx.siteDir);
  const abs = resolve(base, urlPath);
  // Traversal-Guard: aufgelöster Pfad muss strikt innerhalb siteDir liegen.
  if (abs !== base && !abs.startsWith(base + sep)) return null;

  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const data = readFileSync(abs);
  return new Response(data, {
    status: 200,
    // X-Robots-Tag bleibt (noindex bis Live-Gang); Cache-Control wie restlicher
    // Host (no-store) — für die Edit-Ansicht/Dogfood unkritisch.
    headers: withHeaders({ "Content-Type": contentType }),
  });
}

function isAuthed(req: Request, ctx: HostCtx): boolean {
  if (!ctx.auth) return false;
  // Jeden gleichnamigen Cookie prüfen, nicht nur den ersten: ein untergeschobenes
  // Domain-Cookie einer Geschwister-Subdomain darf die echte Session nicht
  // verdecken. Ohne das Site-Secret ist keiner der Kandidaten fälschbar.
  const auth = ctx.auth;
  return readCookieTokens(req.headers.get("cookie")).some((t) => checkCookie(auth, t));
}

// Erlaubte return-Ziele nach Login: entweder /edit (Root) oder /<page>.html/edit.
// Streng validiert → verhindert Open-Redirect (kein //host, kein http://…, kein
// beliebiger Pfad). Liefert das validierte Ziel oder null.
const RETURN_RE = /^\/(?:edit|[a-z0-9-]+\.html\/edit)$/;
function validateReturn(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  return RETURN_RE.test(raw) ? raw : null;
}

// Minimales HTML-Attribut-Escaping für den hidden return-Wert (defensiv; der Wert
// ist bereits gegen RETURN_RE validiert, enthält also keine Sonderzeichen — dies
// ist Defense-in-depth gegen künftige Regex-Lockerung).
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Warnt, wenn der Browser das Session-Cookie garantiert verwerfen wird: `Secure`
 * ist gesetzt, aber der Origin ist nicht vertrauenswürdig (HTTP auf einer LAN-IP
 * oder einem Hostnamen). Ohne diesen Hinweis landet man nach dem Login wieder auf
 * der Login-Seite — stumm, ohne Fehler, und hält das Passwort für falsch.
 */
function insecureOriginWarning(req: Request, url: URL): string {
  if (!useSecureCookie()) return "";
  const proto = (req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")).toLowerCase();
  if (isTrustworthyOrigin(url.hostname, proto)) return "";
  return `<div class="warn"><strong>Anmeldung wird fehlschlagen.</strong>
Diese Seite läuft über <code>http://${escapeAttr(url.host)}</code>. Das Sitzungs-Cookie ist
als <code>Secure</code> markiert, und dein Browser verwirft es über eine unverschlüsselte
Verbindung — du landest nach dem Anmelden wieder hier.<br><br>
Nutze <strong>HTTPS</strong> (Reverse-Proxy davor), oder für einen kurzen Test:
<code>EDITOR_INSECURE_COOKIE=1 regoro run</code>.<br>
Über <code>http://localhost</code> funktioniert es ohne Zutun.</div>`;
}

/** Der gewählte Reiter. Alles Unbekannte fällt auf SMS zurück. */
function validWeg(roh: unknown): Kanal {
  return roh === "email" ? "email" : "sms";
}

const SEITE_CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
background:#14324f;color:#16222e;display:flex;min-height:100vh;align-items:center;
justify-content:center;margin:0;padding:24px}
main{background:#fff;padding:36px 32px 32px;border-radius:18px;width:100%;max-width:380px;
box-shadow:0 10px 40px rgba(0,0,0,.28)}
h1{font-size:21px;line-height:1.3;margin:0 0 6px;letter-spacing:-.01em}
p.lead{margin:0 0 22px;color:#5b6b7a;font-size:14px;line-height:1.5}
.tabs{display:flex;gap:4px;background:#eef1f4;padding:4px;border-radius:11px;margin-bottom:20px}
.tab{flex:1;text-align:center;padding:9px 8px;border-radius:8px;font-size:14px;
text-decoration:none;color:#5b6b7a;font-weight:500}
.tab.active{background:#fff;color:#16222e;box-shadow:0 1px 3px rgba(0,0,0,.12)}
label{display:block;font-size:13px;font-weight:500;margin-bottom:7px}
input{width:100%;padding:12px 13px;border:1px solid #d3dae0;border-radius:10px;
font:inherit;background:#fff}
input:focus{outline:2px solid #e2571e;outline-offset:-1px;border-color:#e2571e}
input.code{letter-spacing:.4em;font-size:19px;text-align:center;font-variant-numeric:tabular-nums}
button{margin-top:18px;width:100%;padding:13px;border:0;border-radius:999px;background:#e2571e;
color:#fff;font:inherit;font-weight:600;font-size:15px;cursor:pointer}
button:hover{background:#c94a13}
.err{color:#b3261e;font-size:13.5px;margin-top:14px;line-height:1.45}
.hint{color:#5b6b7a;font-size:13px;margin-top:16px;line-height:1.5}
.hint a{color:#e2571e}
.warn{background:#fff4e5;border:1px solid #f0b37e;color:#663c00;font-size:12.5px;line-height:1.45;
padding:11px 13px;border-radius:10px;margin-bottom:18px}
.warn code{background:#00000010;padding:1px 4px;border-radius:3px;font-size:12px}`;

function seite(titel: string, inhalt: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titel}</title>
<style>${SEITE_CSS}</style></head>
<body><main>${inhalt}</main></body></html>`;
}

function verstecktesReturn(returnTo?: string | null): string {
  return returnTo ? `<input type="hidden" name="return" value="${escapeAttr(returnTo)}">` : "";
}

/**
 * Stufe 1 — Kontaktweg eingeben.
 *
 * Die Reiter sind LINKS, kein JavaScript: Die Anmeldeseite ist die einzige
 * Route ohne Auth-Wall und soll ohne ein einziges Skript auskommen.
 */
function loginFormKennung(
  weg: Kanal,
  opts: { error?: string; returnTo?: string | null; warning?: string } = {},
): string {
  const q = opts.returnTo ? `&return=${encodeURIComponent(opts.returnTo)}` : "";
  const tab = (k: Kanal, beschriftung: string) =>
    `<a class="tab${weg === k ? " active" : ""}" href="/edit/login?weg=${k}${q}">${beschriftung}</a>`;
  const istSms = weg === "sms";
  return seite(
    "Anmelden",
    `<h1>Website bearbeiten</h1>
<p class="lead">Wir schicken dir einen Code. Ein Passwort brauchst du nicht.</p>
${opts.warning ?? ""}
<div class="tabs">${tab("sms", "Telefonnummer")}${tab("email", "E-Mail")}</div>
<form method="POST" action="/edit/login">
<label for="kennung">${istSms ? "Telefonnummer" : "E-Mail-Adresse"}</label>
<input id="kennung" name="kennung" type="${istSms ? "tel" : "email"}"
 inputmode="${istSms ? "tel" : "email"}"
 autocomplete="${istSms ? "tel" : "email"}"
 placeholder="${istSms ? "0151 20464812" : "name@firma.de"}" autofocus>
<input type="hidden" name="weg" value="${weg}">
${verstecktesReturn(opts.returnTo)}
<button type="submit">Code anfordern</button>
${opts.error ? `<div class="err">${opts.error}</div>` : ""}
</form>`,
  );
}

/** Stufe 2 — Code eintragen. Kennung und Reiter reisen im Formular mit. */
function loginFormCode(
  weg: Kanal,
  kennungRoh: string,
  opts: { error?: string; returnTo?: string | null } = {},
): string {
  const q = opts.returnTo ? `&return=${encodeURIComponent(opts.returnTo)}` : "";
  return seite(
    "Code eingeben",
    `<h1>Code eingeben</h1>
<p class="lead">Wir haben dir einen sechsstelligen Code geschickt, falls dieser Kontaktweg
hinterlegt ist. Er gilt 5 Minuten.</p>
<form method="POST" action="/edit/login">
<label for="code">Code</label>
<input id="code" name="code" class="code" type="text" inputmode="numeric" autocomplete="one-time-code"
 maxlength="6" pattern="[0-9]*" placeholder="000000" autofocus>
<input type="hidden" name="kennung" value="${escapeAttr(kennungRoh)}">
<input type="hidden" name="weg" value="${weg}">
${verstecktesReturn(opts.returnTo)}
<button type="submit">Anmelden</button>
${opts.error ? `<div class="err">${opts.error}</div>` : ""}
</form>
<p class="hint">Nichts bekommen? <a href="/edit/login?weg=${weg}${q}">Neuen Code anfordern</a></p>`,
  );
}

/** 302-Redirect auf die Login-Seite mit (bereits validiertem) return-Ziel. */
function loginRedirect(currentPath: string): Response {
  const location = `/edit/login?return=${encodeURIComponent(currentPath)}`;
  return new Response(null, {
    status: 302,
    headers: withHeaders({ Location: location }),
  });
}

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const text = await req.text();
  const params = new URLSearchParams(text);
  const obj: Record<string, unknown> = {};
  for (const [k, v] of params) obj[k] = v;
  return obj;
}

/**
 * Haupt-Router. Synchron oder als Promise<Response>.
 *
 * `srv` ist optional, damit die bestehenden Aufrufer und Tests unverändert
 * bleiben; nur der Ereignisstrom braucht es (siehe AnfrageZeitgrenze). Fehlt
 * es, funktioniert alles außer der Zeitgrenze — der Strom risse dann nach
 * zehn Sekunden ab, statt gar nicht erst zu entstehen.
 */
export function handleEditorRequest(
  req: Request,
  url: URL,
  ctx: HostCtx,
  srv?: AnfrageZeitgrenze,
): Promise<Response> {
  return route(req, url, ctx, srv);
}

async function route(
  req: Request,
  url: URL,
  ctx: HostCtx,
  srv?: AnfrageZeitgrenze,
): Promise<Response> {
  const path = url.pathname;
  const method = req.method.toUpperCase();


  // === Präzedenz (1): /edit/login (exakt) — einzige Route ohne Auth-Wall. ===
  //
  // Zweistufig: Kontaktweg eingeben → Code eingeben. Unterschieden wird an der
  // Anwesenheit des Feldes `code`, nicht an einer serverseitigen Sitzung — die
  // gäbe es sonst vor der Anmeldung, und sie wäre selbst wieder Angriffsfläche.
  if (path === "/edit/login") {
    // Fail-closed: ohne Auth-Datei ist kein Login möglich → 404 (auch GET/POST).
    if (ctx.auth === null) return notFound();
    const auth = ctx.auth;

    if (method === "GET") {
      // return-Query validieren (Open-Redirect-Schutz); nur gültige Ziele in die Form.
      const returnTo = validateReturn(url.searchParams.get("return"));
      return html(
        loginFormKennung(validWeg(url.searchParams.get("weg")), {
          returnTo,
          warning: insecureOriginWarning(req, url),
        }),
      );
    }

    if (method === "POST") {
      const body = await parseBody(req);
      // return kann aus dem Body ODER der Query kommen (Body hat Vorrang). Beide
      // laufen durch dieselbe strenge Validierung → Open-Redirect-sicher, und
      // zwar über BEIDE Stufen: an der zweiten wäre der Schutz sonst wirkungslos.
      const returnRaw =
        typeof body.return === "string" ? body.return : url.searchParams.get("return");
      const returnTo = validateReturn(returnRaw);
      const weg = validWeg(typeof body.weg === "string" ? body.weg : url.searchParams.get("weg"));
      const kennungRoh = typeof body.kennung === "string" ? body.kennung : "";
      // Die Stufe entscheidet sich an der ANWESENHEIT des Feldes, nicht an
      // seinem Inhalt. Ein leeres Feld hieße sonst „neuen Code anfordern": Wer
      // im Code-Formular versehentlich ohne Eingabe abschickt, bekäme eine
      // zweite Nachricht — kostenpflichtig — und der Code aus der ersten wäre
      // tot, weil `merkeCode` ihn ersetzt. Nachgestellt und behoben.
      const codeFeld = typeof body.code === "string" ? body.code : null;
      const codeRoh = codeFeld === null ? "" : codeFeld.trim();

      // --- Stufe 2: Code prüfen ---
      if (codeFeld !== null) {
        const kennung = normalisiereKennung(kennungRoh, weg);
        // Eine Fehlermeldung darf NICHT unterscheiden zwischen „Kennung nicht
        // hinterlegt", „Code falsch" und „Code abgelaufen" — sonst verrät die
        // Anmeldeseite, welche Kontaktwege es gibt.
        const abweisen = () =>
          html(
            loginFormCode(weg, kennungRoh, {
              returnTo,
              error: "Der Code stimmt nicht oder ist abgelaufen. Fordere einen neuen an.",
            }),
            401,
          );
        // Leeres Feld ist kein Fehlversuch, sondern ein Vertipper: erneut fragen,
        // ohne einen der fünf Versuche zu verbrauchen und ohne den Code zu entwerten.
        if (codeRoh === "") {
          return html(
            loginFormCode(weg, kennungRoh, {
              returnTo,
              error: "Bitte den sechsstelligen Code aus der Nachricht eintragen.",
            }),
            400,
          );
        }
        if (kennung === null) return abweisen();
        // Zweite Schranke: Ein Code kann für eine nicht hinterlegte Kennung gar
        // nicht entstanden sein — die Prüfung ist trotzdem da, weil sie billig ist.
        if (!kennungHinterlegt(auth, kennung.wert)) return abweisen();
        if (pruefeCode(ctx.siteDir, kennung.wert, codeRoh) !== "ok") return abweisen();

        // Ab hier ist die Anmeldung nachgewiesen. Die Bremse begrenzt Kosten
        // durch Anfragen von jemandem, der sich NICHT anmelden kann — wer einen
        // gültigen Code vorgelegt hat, gehört nicht dazu. Ohne diesen Schnitt
        // wartet der Kunde, der sich soeben ausgewiesen hat, am zweiten Gerät.
        entsperreKennung(ctx.siteDir, kennung.wert);

        return new Response(null, {
          status: 302,
          headers: withHeaders({
            "Set-Cookie": issueCookie(auth),
            Location: returnTo ?? "/edit",
          }),
        });
      }

      // --- Stufe 1: Code anfordern ---
      const kennung = normalisiereKennung(kennungRoh, weg);
      if (kennung === null) {
        // Formfehler nennen wir beim Namen — das verrät nichts darüber, WELCHE
        // Kontaktwege hinterlegt sind, und erspart eine ratlose Wartezeit.
        return html(
          loginFormKennung(weg, {
            returnTo,
            error:
              weg === "email"
                ? "Das sieht nicht nach einer E-Mail-Adresse aus."
                : "Das sieht nicht nach einer Telefonnummer aus.",
            warning: insecureOriginWarning(req, url),
          }),
          400,
        );
      }

      // Ist dieser Kanal überhaupt eingerichtet? Diese Frage MUSS vor der
      // Hinterlegt-Prüfung stehen und darf nur vom gewählten Kanal abhängen.
      // Stünde sie danach, bekäme eine hinterlegte Kennung bei fehlendem
      // Versand einen anderen Statuscode als eine unbekannte — ein rauschfreies
      // Orakel darüber, wer Kunde dieser Website ist. Genau das war der Zustand
      // direkt nach `regoro init`, solange versand.json noch fehlte.
      if (ctx.versand == null || (ctx.versand.kanaele && !ctx.versand.kanaele.has(kennung.kanal))) {
        return html(
          loginFormKennung(weg, {
            returnTo,
            // Der Text richtet sich nach dem TATSÄCHLICHEN Kanal, nicht nach dem
            // Reiter: Wer im SMS-Reiter eine Adresse eintippt, bekommt eine Mail
            // (siehe normalisiereKennung) — und soll dann auch hören, dass der
            // E-Mail-Versand fehlt, nicht der SMS-Versand.
            error:
              kennung.kanal === "email"
                ? "Anmeldung per E-Mail ist auf diesem Server nicht eingerichtet. Bitte den Betreiber informieren."
                : "Anmeldung per SMS ist auf diesem Server nicht eingerichtet. Bitte den Betreiber informieren.",
            warning: insecureOriginWarning(req, url),
          }),
          503,
        );
      }
      const versand = ctx.versand;

      // Die Bremse greift VOR dem Versand — sie schützt vor Kosten und Fluten.
      const bremse = pruefeBremse(ctx.siteDir, kennung.wert);
      if (!bremse.erlaubt) {
        return html(
          loginFormKennung(weg, {
            returnTo,
            error:
              bremse.grund === "kennung"
                ? `Zu viele Codes angefordert. Versuche es in ${wartezeitText(bremse.wartenMs)} erneut.`
                : `Für diese Website wurden zu viele Codes angefordert. Bitte in ${wartezeitText(bremse.wartenMs)} erneut versuchen.`,
            warning: insecureOriginWarning(req, url),
          }),
          429,
        );
      }

      if (kennungHinterlegt(auth, kennung.wert)) {
        const code = erzeugeCode();
        merkeCode(ctx.siteDir, kennung.wert, code);
        // **Bewusst NICHT abgewartet.** Würde die Antwort auf den Anbieter
        // warten, hinge ihre Laufzeit daran, ob die Kennung hinterlegt ist —
        // gemessen 152 ms gegen 0,2 ms. Damit ließe sich für jede beliebige
        // Nummer prüfen, ob sie zu dieser Website gehört. Ein gescheiterter
        // Versand geht deshalb ins Log des Betreibers, nicht an den Browser;
        // der Kunde sieht auf der Code-Seite ohnehin „Neuen Code anfordern".
        void versand.sendeCode(kennung, code).catch((err: unknown) => {
          console.error(
            `[regoro] Code für ${maskiereKennung(kennung.wert)} ging nicht raus: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }

      // Hinterlegt oder nicht: dieselbe Antwort. Sonst verrät die Anmeldeseite,
      // welche Nummern und Adressen es gibt.
      return html(loginFormCode(weg, kennungRoh, { returnTo }));
    }
    return notFound();
  }

  // === Präzedenz (2): /edit-assets/* (öffentlich; nutzlos ohne Config). ===
  if (path === "/edit-assets/overlay.js") {
    if (!existsSync(OVERLAY_PATH)) return notFound();
    const js = readFileSync(OVERLAY_PATH, "utf8");
    return new Response(js, {
      status: 200,
      headers: withHeaders({ "Content-Type": "application/javascript; charset=utf-8" }),
    });
  }

  // === Präzedenz (3): API-Routen unter /edit/* ===
  // Unauth (kein/ungültiges Cookie ODER ctx.auth===null) → 404 (versteckt).
  const isApiRoute =
    path === "/edit/save" ||
    path === "/edit/upload" ||
    path === "/edit/restore" ||
    path === "/edit/versions" ||
    // KI-Seitenleiste: Auftrag, Ereignisstrom, Abbruch, Zustand. Gehören HIER
    // hin und nicht zu den View-Routen: Ohne den Auth-Gate könnte ein Fremder
    // einen Agentenlauf auslösen — der kostet Token und schreibt in die Website.
    // Unangemeldet also 404 (nicht 401), wie bei jeder anderen API-Route.
    /^\/edit\/agent(\/(events|abort|status))?$/.test(path) ||
    /^\/edit\/version\/[^/]+$/.test(path);
  if (isApiRoute) {
    if (!isAuthed(req, ctx)) return notFound();

    // --- KI-Seitenleiste ---
    // Ohne betreiberweiten Modellzugang gibt es diese Routen NICHT — auch mit
    // gültigem Cookie. Fail-closed wie bei fehlender Auth-Datei: 404, kein 503,
    // keine Fehlermeldung. Sonst wäre die Antwort ein Orakel darüber, welche
    // Websites dieser Server bedient und wie er eingerichtet ist.
    //
    // `== null` und nicht `=== null`: `ki` ist optional am HostCtx, und ein Ctx,
    // der das Feld gar nicht kennt, ist derselbe Fall — kein Modellzugang.
    if (path.startsWith("/edit/agent")) {
      if (ctx.ki == null) return notFound();
      if (path === "/edit/agent" && method === "POST") return handleAgentStart(req, ctx);
      if (path === "/edit/agent/status" && method === "GET") return handleAgentStatus(ctx);
      if (path === "/edit/agent/verlaeufe" && method === "GET") return handleAgentVerlaeufe(ctx);
      if (path === "/edit/agent/abort" && method === "POST") return handleAgentAbort(ctx);
      if (path === "/edit/agent/events" && method === "GET") return handleAgentEvents(req, ctx, srv);
      return notFound();
    }

    if (path === "/edit/save" && method === "POST") return handleSave(req, ctx);
    if (path === "/edit/upload" && method === "POST") return handleUpload(req, ctx);
    if (path === "/edit/restore" && method === "POST") return handleRestore(req, ctx);

    if (path === "/edit/versions" && method === "GET") {
      const target = resolvePage(ctx, url.searchParams.get("page") ?? "");
      if (!target) return notFound();
      const pagePath = pagePathFor(ctx, target.page);
      const versions = listVersions(ctx.repoRoot, pagePath);
      return json(versions);
    }

    const versionMatch = path.match(/^\/edit\/version\/([^/]+)$/);
    if (versionMatch && method === "GET") {
      const commitRaw = decodeURIComponent(versionMatch[1]!);
      if (!COMMIT_RE.test(commitRaw)) return notFound();
      const target = resolvePage(ctx, url.searchParams.get("page") ?? "");
      if (!target) return notFound();
      const pagePath = pagePathFor(ctx, target.page);
      try {
        const content = showVersion(ctx.repoRoot, commitRaw, pagePath);
        // Read-only-Vorschau: Asset-URLs absolutieren (CSS/Bilder laden unter
        // /edit/version/<commit>), aber kein Overlay/idx injizieren.
        return html(renderVersionPreview(content));
      } catch {
        return notFound();
      }
    }

    return notFound();
  }

  // === Präzedenz (4): Edit-VIEW-Routen. ===
  // /edit (+ trailing slash) → index.html; /<page>.html/edit → diese Seite.
  // ctx.auth===null → 404 (fail-closed). Unauth → Login-Redirect (302).
  let viewPage: string | null = null;
  if (path === "/edit" || path === "/edit/") {
    viewPage = "index.html";
  } else {
    const suffixMatch = path.match(/^\/([a-z0-9-]+\.html)\/edit$/);
    if (suffixMatch) viewPage = suffixMatch[1]!;
  }
  if (viewPage !== null && method === "GET") {
    if (ctx.auth === null) return notFound();
    const target = resolvePage(ctx, viewPage);
    if (!target) return notFound();
    if (!isAuthed(req, ctx)) return loginRedirect(path);
    if (!existsSync(target.abs)) return notFound();

    const fileContent = readFileSync(target.abs, "utf8");
    const pagePath = pagePathFor(ctx, target.page);
    const out = renderEditView(fileContent, {
      pagePath,
      fileHash: fileSha256(fileContent),
      scriptUrl: "/edit-assets/overlay.js",
      pages: ctx.pageWhitelist,
      page: target.page,
      // Ohne Modellzugang erscheint die Seitenleiste gar nicht erst im DOM —
      // ein Knopf, der nur 404 erntet, ist schlimmer als kein Knopf.
      ki: ctx.ki != null,
    });
    return html(out);
  }

  // === Präzedenz (5): Öffentliches Static-Serving (Site-HTML + Assets). ===
  // Kein Auth (public site), nur GET, nur innerhalb siteDir. Dotfile-Block +
  // Traversal-Guards greifen. Rohes HTML (KEIN Overlay, KEIN data-edit-idx).
  if (method === "GET") {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return notFound();
    }
    const rel = decoded.replace(/^\/+/, ""); // führende Slashes weg
    // Dotfile-Block (höchste Priorität): dekodierte Segmente mit "."-Präfix
    // (.regoro/, .git/, .env …) werden NIE öffentlich ausgeliefert.
    if (hasDotSegment(rel)) return notFound();

    // Rohes Seiten-HTML: "/" → index.html; "/<name>.html" → diese Seite. Nur
    // Whitelist-Seiten, die existieren; exakte Dateibytes ohne Transformation.
    const pageName = rel === "" ? "index.html" : rel;
    const pageTarget = resolvePage(ctx, pageName);
    if (pageTarget && existsSync(pageTarget.abs)) {
      const raw = readFileSync(pageTarget.abs);
      return new Response(raw, {
        status: 200,
        headers: withHeaders({ "Content-Type": "text/html; charset=utf-8" }),
      });
    }

    // Sonst: statisches Asset (CSS/Bilder/Fonts …).
    const asset = serveStaticAsset(ctx, rel);
    if (asset) return asset;
    return notFound();
  }

  return notFound();
}

async function handleSave(req: Request, ctx: HostCtx): Promise<Response> {
  const body = await parseBody(req);
  const pagePath = typeof body.pagePath === "string" ? body.pagePath : "";
  const fileHash = typeof body.fileHash === "string" ? body.fileHash : "";
  const edits = Array.isArray(body.edits) ? (body.edits as Edit[]) : [];

  // pagePath validieren: muss "<sitePrefix>/<whitelisted>.html" sein.
  const base = pagePathBasename(ctx, pagePath);
  const target = base ? resolvePage(ctx, base) : null;
  if (!target || pagePath !== pagePathFor(ctx, target.page)) return notFound();
  if (!existsSync(target.abs)) return notFound();

  const current = readFileSync(target.abs, "utf8");
  if (fileSha256(current) !== fileHash) {
    return json({ error: "hash-mismatch" }, 409);
  }

  const { html: nextHtml } = applyEdits(current, edits);
  // Symlink-sicher: nie einer als Symlink angelegten Seite nach außerhalb folgen.
  if (!pathInsideSite(ctx.siteDir, target.abs)) return json({ error: "bad-path" }, 400);
  writeFileSync(target.abs, nextHtml, "utf8");

  ensureRepo(ctx.repoRoot);
  commitEdit(ctx.repoRoot, pagePath, "Inline-Edit");

  return json({ ok: true, fileHash: fileSha256(nextHtml) });
}

async function handleUpload(req: Request, ctx: HostCtx): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "bad-form" }, 400);
  }

  const pagePath = String(form.get("pagePath") ?? "");
  const imgIdxRaw = form.get("imgIdx");
  const file = form.get("image");

  // 1. pagePath validieren (Traversal/Whitelist) → 404.
  const base = pagePathBasename(ctx, pagePath);
  const target = base ? resolvePage(ctx, base) : null;
  if (!target || pagePath !== pagePathFor(ctx, target.page)) return notFound();
  if (!existsSync(target.abs)) return notFound();

  // 2. Datei vorhanden? → 400.
  if (!(file instanceof Blob)) return json({ error: "no-file" }, 400);

  // 3. Größenlimit → 400 (vor dem Lesen via Blob.size grob, nach dem Lesen exakt).
  if (file.size > MAX_UPLOAD_BYTES) return json({ error: "too-large" }, 400);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return json({ error: "too-large" }, 400);

  // 4. Magic-Byte-Sniff der ECHTEN Signatur (SVG/Text → null → 400).
  const ext = sniffImageExt(bytes);
  if (!ext) return json({ error: "unsupported-type" }, 400);

  // 5. imgIdx gegen die echte Bildanzahl der Seite prüfen → 400.
  const pageHtml = readFileSync(target.abs, "utf8");
  const imgCount = enumerateImages(parseHTML(pageHtml).document).length;
  const imgIdx = Number(imgIdxRaw);
  if (!Number.isInteger(imgIdx) || imgIdx < 0 || imgIdx >= imgCount) {
    return json({ error: "bad-img-idx" }, 400);
  }

  // 6. Sicher generierter Name (Hash über Inhalt; KEINE User-Pfade/Originalnamen).
  const sha8 = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const filename = `upload-${sha8}.${ext}`;
  const assetsBase = resolve(ctx.siteDir, "assets");
  const assetsAbs = resolve(assetsBase, filename);
  // Traversal-Guard (filename ist generiert, aber defensiv prüfen).
  if (!assetsAbs.startsWith(assetsBase + sep)) return json({ error: "bad-path" }, 400);

  // 7. Asset schreiben — SYMLINK-SICHER (fail-closed): wäre `assets` (oder ein
  // Elternsegment) ein Symlink nach außerhalb (mounted-/restored-site), würde
  // writeFileSync dem Symlink folgen. Daher das ECHTE Ziel gegen siteDir prüfen.
  mkdirSync(assetsBase, { recursive: true });
  if (!pathInsideSite(ctx.siteDir, assetsAbs)) return json({ error: "bad-path" }, 400);
  writeFileSync(assetsAbs, bytes);

  // 8. src auf der Seite aktualisieren + schreiben.
  const newSrc = `/assets/${filename}`;
  const { html: nextHtml, applied } = setImageSrc(pageHtml, imgIdx, newSrc);
  if (applied !== 1) return json({ error: "img-not-applied" }, 400);
  if (!pathInsideSite(ctx.siteDir, target.abs)) return json({ error: "bad-path" }, 400);
  writeFileSync(target.abs, nextHtml, "utf8");

  // 9. Beide (Asset + Seite) committen.
  const sitePrefix = ctx.sitePrefix ?? "site";
  const assetPagePath = sitePrefix
    ? posix.join(sitePrefix, "assets", filename)
    : posix.join("assets", filename);
  ensureRepo(ctx.repoRoot);
  commitEdit(ctx.repoRoot, assetPagePath, `Bild-Upload: ${filename}`);
  commitEdit(ctx.repoRoot, pagePath, `Bild ausgetauscht: idx ${imgIdx}`);

  return json({ ok: true, src: newSrc, fileHash: fileSha256(nextHtml) });
}

async function handleRestore(req: Request, ctx: HostCtx): Promise<Response> {
  const body = await parseBody(req);
  const pagePath = typeof body.pagePath === "string" ? body.pagePath : "";
  const commit = typeof body.commit === "string" ? body.commit : "";

  const base = pagePathBasename(ctx, pagePath);
  const target = base ? resolvePage(ctx, base) : null;
  if (!target || pagePath !== pagePathFor(ctx, target.page)) return notFound();
  if (!COMMIT_RE.test(commit)) return notFound();
  // Symlink-sicher: Restore würde sonst einem als Symlink angelegten Seitenpfad folgen.
  if (existsSync(target.abs) && !pathInsideSite(ctx.siteDir, target.abs)) {
    return json({ ok: false, error: "bad-path" }, 400);
  }

  try {
    ensureRepo(ctx.repoRoot);
    restoreVersion(ctx.repoRoot, commit, pagePath);
  } catch {
    return json({ ok: false, error: "restore-failed" }, 400);
  }
  return json({ ok: true });
}

// ===========================================================================
// KI-Seitenleiste — vier Routen (Contract §7)
//
// Der Wortlaut jeder Fehlermeldung und jeder Statuscode gehören hierher
// (Contract §10). `agent.ts` liefert maschinenlesbare Gründe; erst hier werden
// daraus deutsche Sätze. Stünde der Wortlaut an beiden Stellen, driftete er.
// ===========================================================================

/**
 * Obergrenze für einen Auftrag.
 *
 * Der Auftrag geht in den System-Prompt des Modells und als Umgebungsvariable
 * an den Worker. Ohne Grenze ist beides ein bezahltes Fass ohne Boden, und der
 * Kernel hat für Umgebungsvariablen eine eigene, deutlich unfreundlichere
 * Grenze — die schlüge als unverständlicher Startfehler durch statt als klarer
 * Satz im Browser. 4000 Zeichen sind rund 600 Wörter; ein Kundenauftrag in
 * normalen Sätzen bleibt weit darunter.
 */
const MAX_AUFTRAG_ZEICHEN = 4000;

/**
 * Die technischen Ablehnungen beim Übernehmen. `agent.ts` baut sie als
 * `<grund>:<pfad>`; der Pfad ist für den Betreiber gedacht, nicht für den Kunden.
 */
const UEBERNAHME_ABLEHNUNGEN = new Set([
  "symlink",
  "geloescht",
  "unlesbar",
  "ausserhalb-kopie",
  "ausserhalb-site",
]);

/**
 * Maschinenlesbare Gründe aus `agent.ts` in Sätze übersetzen, die ein
 * Handwerksbetrieb versteht.
 *
 * JEDER Grund, den `agent.ts` erzeugen kann, muss hier ankommen — sonst steht
 * das Schlüsselwort wörtlich in der roten Sprechblase. Nachgemessen ist das
 * zweimal passiert (`worker-abgestuerzt`, und beim Abbrechen-Knopf las der
 * Kunde schlicht „abgebrochen"). `src/fehlertexte.test.ts` liest die Gründe
 * aus `agent.ts` und bricht, sobald einer dazukommt, der hier fehlt.
 *
 * Nur frei formulierte Meldungen gehen unverändert durch: Validator und
 * Recherche liefern bereits deutschen Klartext, und den hier noch einmal zu
 * übersetzen hieße, ihn zu verlieren.
 */
export function agentFehlerText(grund: string): string {
  // `<grund>:<pfad>` — der Pfad gehört ins Betreiber-Log, nicht in den Browser.
  // Dem Kunden sagt er nichts, und im ungünstigen Fall verrät er die Struktur
  // eines Ausbruchsversuchs an genau den, der ihn ausgelöst hat. `agent.ts`
  // schreibt selbst nichts ins Log (kein einziges console.*), also passiert es
  // hier — sonst ginge die einzige Spur verloren, die eine Störung erklärt.
  const trenner = grund.indexOf(":");
  if (trenner > 0 && UEBERNAHME_ABLEHNUNGEN.has(grund.slice(0, trenner))) {
    console.error(`[regoro] Übernahme abgelehnt: ${grund}`);
    return (
      "Der Assistent hat etwas erzeugt, das die Sicherheitsprüfung nicht übernimmt. " +
      "An der Website wurde nichts geändert."
    );
  }

  switch (grund) {
    case "kein-lauf":
      return "Kein Lauf aktiv.";
    case "kein-modellzugang":
      return "Der KI-Assistent ist auf diesem Server nicht eingerichtet.";
    case "lauf-gescheitert":
      return "Der Auftrag konnte nicht ausgeführt werden. Es wurde nichts geändert.";
    case "worker-abgestuerzt":
      // Nachgemessen: Ohne diesen Fall stand wörtlich „worker-abgestuerzt" im
      // Chatfenster des Kunden. Was schiefging, gehört ins Log des Betreibers;
      // der Kunde braucht zu wissen, dass seine Website unberührt ist.
      return "Der Assistent hat sich unerwartet beendet. An der Website wurde nichts geändert.";
    case "kontingent-erschoepft":
      return "Das Monatskontingent ist mitten im Auftrag aufgebraucht. Es wurde nichts geändert; am Monatsersten geht es weiter.";
    case "abgebrochen":
      // Der meistbenutzte Weg überhaupt — der Abbrechen-Knopf. Ohne diesen Fall
      // stand dort ein rotes Feld mit dem Wort „abgebrochen".
      return "Der Auftrag wurde abgebrochen. An der Website wurde nichts geändert.";
    case "abgeschaltet":
      return "Der Zugang wurde vom Betreiber beendet.";
    default:
      /**
       * NICHTS UNBEKANNTES GEHT AN DEN BROWSER. Hier stand `return grund;`, und
       * das ist dreimal schiefgegangen: erst „worker-abgestuerzt", dann
       * „abgebrochen", zuletzt — bei leerem Guthaben — die komplette
       * OpenRouter-Antwort als englischer JSON-Rohtext, mitsamt dem Namen
       * unseres Modellanbieters und einem Link auf UNSERE Abrechnungsseite.
       * Ein Handwerksbetrieb bekam das wörtlich in der Seitenleiste zu sehen.
       *
       * Zweimal wurde daraufhin der Einzelfall ergänzt. Das war die falsche
       * Ebene: Die Menge der Gründe ist offen — jede Anbieter-Antwort, jeder
       * neue Zustand landet hier. Deshalb ist der Vorgabezweig jetzt der
       * SICHERE, und ein neuer Grund kostet eine Log-Zeile statt eines Lecks.
       *
       * Die Trennlinie dahinter: Ein leeres Guthaben ist ein BETREIBER-Problem.
       * Der Kunde kann daran nichts ändern, also erfährt er nur, dass seine
       * Website unberührt ist; der Betreiber findet den Grund im Log.
       */
      if (istEigenerKlartext(grund)) return grund;
      console.error(`[regoro] Agentenlauf gescheitert: ${grund}`);
      return "Der Assistent ist gerade nicht verfügbar. An der Website wurde nichts geändert.";
  }
}

/**
 * Trennt EIGENEN deutschen Klartext von FREMDEM Maschinentext.
 *
 * Beide erreichen den Vorgabezweig oben, und beide müssen unterschiedlich
 * behandelt werden — das ist der Grund, warum dort kein einfacher Deckel steht:
 *
 *   durchlassen  „Die Datei enthält ein neues Inline-Skript."   (Validator)
 *                „Interne Adressen werden nicht abgerufen."      (Recherche)
 *   schlucken    `402: {"message":"This request requires more credits …`
 *
 * Beide Sorten sind frei formuliert, eine Liste hilft also nicht. Geprüft wird
 * deshalb die FORM eines Satzes, den wir selbst geschrieben haben. Die Regel
 * ist bewusst streng: Wer sich irrt, schluckt einen brauchbaren Hinweis und
 * schreibt ihn ins Log — wer zu lax ist, stellt dem Kunden fremde Rohdaten in
 * die Seitenleiste. Der erste Fehler kostet Bequemlichkeit, der zweite Vertrauen.
 */
function istEigenerKlartext(s: string): boolean {
  // Anbieter-Antworten sind JSON, tragen Anführungszeichen und verlinken auf
  // fremde Abrechnungsseiten. Nichts davon steht je in einem unserer Sätze.
  if (/[{}"<>]|https?:\/\//.test(s)) return false;
  // Ein Satz, kein Datenfeld: beginnt groß, endet mit Satzzeichen, hat Wörter.
  if (!/^[A-ZÄÖÜ]/.test(s)) return false;
  if (!/[.!?]$/.test(s.trimEnd())) return false;
  if (!s.includes(" ")) return false;
  // Deutlich länger als jeder unserer Sätze heißt: da hängt etwas dran.
  return s.length <= 200;
}

/**
 * Die Liste vergangener Gespräche dieser Website.
 *
 * Titel sind KUNDENTEXT — der erste Satz eines Auftrags. Sie gehen als JSON
 * hinaus und werden im Overlay per `textContent` gesetzt, nie als HTML. Wer das
 * hier je zu einer gerenderten Liste umbaut, muss maskieren.
 *
 * Kein Kontingent-Verbrauch, kein Lauf: reines Lesen. Trotzdem hinter der
 * Auth-Wall wie alle `/edit/agent*`-Routen — der Verlauf enthält wörtlich, was
 * der Kunde geschrieben hat.
 */
async function handleAgentVerlaeufe(ctx: HostCtx): Promise<Response> {
  const alle = await listeVerlaeufe(ctx.siteDir);
  return Response.json({
    ok: true,
    verlaeufe: alle.map((v) => ({
      id: v.id,
      titel: v.titel,
      geaendert: v.geaendert,
      nachrichten: v.nachrichten,
    })),
  });
}

async function handleAgentStart(req: Request, ctx: HostCtx): Promise<Response> {
  const body = await parseBody(req);
  const auftrag = typeof body.auftrag === "string" ? body.auftrag.trim() : "";
  // Leer und „nur Leerzeichen" sind derselbe Fall: Ein Lauf ohne Auftrag würde
  // Kontingent verbrauchen, um nichts zu tun.
  if (auftrag === "") {
    return json({ ok: false, grund: "Auftrag fehlt." }, 400);
  }
  if (auftrag.length > MAX_AUFTRAG_ZEICHEN) {
    return json(
      {
        ok: false,
        grund: `Der Auftrag ist zu lang (${auftrag.length} Zeichen, erlaubt sind ${MAX_AUFTRAG_ZEICHEN}). Beschreibe in ein paar Sätzen, was sich ändern soll.`,
      },
      400,
    );
  }

  const start = starteLauf(ctx, auftrag);
  if (start.ok) return json({ ok: true, laufId: start.laufId });

  switch (start.grund) {
    case "laeuft-bereits":
      return json({ ok: false, grund: "Es läuft bereits ein Auftrag für diese Website." }, 409);
    case "kontingent":
      return json(
        {
          ok: false,
          grund: "Das Monatskontingent ist aufgebraucht. Es setzt sich am Monatsersten zurück.",
        },
        429,
      );
    case "keine-sandbox":
      // 503 und nicht 500: Es ist eine fehlende Voraussetzung des Servers, kein
      // Fehler des Kunden und nichts, was ein zweiter Versuch behebt.
      return json(
        { ok: false, grund: "Die Sandbox (bwrap) ist auf diesem Server nicht verfügbar." },
        503,
      );
  }
}

function handleAgentStatus(ctx: HostCtx): Response {
  const k = pruefeKontingent(ctx.siteDir);
  return json({
    ok: true,
    laeuft: laufAktiv(ctx.siteDir) !== null,
    laufId: laufAktiv(ctx.siteDir),
    // Bewusst nur diese vier Felder: `tokens` und `laeufe` aus dem Kontingent
    // sind Betreiber-Buchhaltung und gehen den Browser nichts an. `gesamt`
    // kommt dazu, damit die Seitenleiste „noch X von Y" anzeigen kann, ohne
    // die Obergrenze selbst zu kennen — sonst rechnete sie beim Monatswechsel
    // falsch.
    kontingent: {
      frei: k.frei,
      gesamt: TOKEN_KONTINGENT,
      erschoepft: k.erschoepft,
      monat: k.monat,
    },
  });
}

function handleAgentAbort(ctx: HostCtx): Response {
  // Idempotent: Auch ohne laufenden Auftrag 200. Ein 404 wäre hier irreführend
  // (die Route gibt es ja) und ein 409 zwänge die Seitenleiste zu einer
  // Fallunterscheidung, die niemandem hilft — abgebrochen ist abgebrochen.
  brichAb(ctx.siteDir);
  return json({ ok: true });
}

/** Ein Ereignis als SSE-Rahmen. Der Ereignisname ist `t`, der Rest die Daten. */
function sseRahmen(e: AgentEreignis): string {
  const { t, ...daten } = e;
  const nutzlast = t === "fehler" ? { grund: agentFehlerText(e.grund) } : daten;
  // EINE `data:`-Zeile je Ereignis: `JSON.stringify` maskiert Zeilenumbrüche
  // selbst und kann ein Ereignis daher nie zerschneiden. Ein roher Umbruch im
  // Text des Agenten würde den Rahmen sonst mitten im Satz beenden.
  return `event: ${t}\ndata: ${JSON.stringify(nutzlast)}\n\n`;
}

function handleAgentEvents(req: Request, ctx: HostCtx, srv?: AnfrageZeitgrenze): Response {
  // Bun beendet jede Antwort, die `idleTimeout` lang (Vorgabe 10 s) kein Byte
  // geliefert hat. Ein Agentenlauf schweigt minutenlang, während das Modell
  // nachdenkt — ohne diese Abschaltung risse der Strom reproduzierbar ab, und
  // zwar erst in Produktion.
  srv?.timeout(req, 0);

  const quelle = ereignisse(ctx.siteDir);
  const enc = new TextEncoder();
  let offen = true;

  // Klassischer ReadableStream, NICHT `type: "direct"`: dort feuert `cancel()`
  // unzuverlässig (oven-sh/bun#18315), und ein nicht feuerndes `cancel` hieße
  // hier, dass der Zuhörer bis zum Prozessende registriert bleibt.
  const strom = new ReadableStream<Uint8Array>({
    async start(controller) {
      // SOFORT ein Byte senden, bevor irgendetwas passiert.
      //
      // Gemessen an Caddy 2.11.4: direkt am Bun-Host liegen 0,0003 s zwischen
      // Anfrage und erstem Byte, durch den Proxy 4 s — genau so lange, bis das
      // erste echte Ereignis kam. `flush_interval -1` ändert daran nichts,
      // denn gepuffert wird nicht der Körper, sondern die ANTWORT-HEADER: Go
      // gibt sie erst mit dem ersten Körper-Byte heraus. Im Browser feuert
      // `onopen` deshalb erst mit dem ersten Ereignis — bei einem Agentenlauf
      // sind das Minuten, in denen die Seitenleiste leer steht und jede
      // Zwischenstation die Verbindung für tot halten darf.
      //
      // Eine SSE-Kommentarzeile OHNE abschließende Leerzeile: Sie schiebt
      // Bytes auf die Leitung, löst aber kein Ereignis aus. Mit Leerzeile wäre
      // es ein leerer `message`-Rahmen — der Browser ignoriert den zwar, aber
      // jeder mitlesende Parser zählte ihn als Ereignis.
      controller.enqueue(enc.encode(": verbunden\n"));
      try {
        for await (const e of quelle) {
          if (!offen) break;
          controller.enqueue(enc.encode(sseRahmen(e)));
        }
      } catch (err) {
        // Der Lauf ist ein fremder Prozess; ein Fehler hier darf den Server
        // nicht mitreißen. Ins Log, nicht in den Browser — die Meldung könnte
        // interne Pfade enthalten.
        console.error(
          `[regoro] Ereignisstrom abgebrochen: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (offen) {
        offen = false;
        try {
          controller.close();
        } catch {
          /* der Client war schneller weg */
        }
      }
    },
    cancel() {
      // Der Kunde hat den Tab geschlossen oder neu geladen. Das hängt NUR den
      // Zuhörer ab und beendet den Lauf nicht (§13.14): Ein versehentlicher
      // Reload wäre sonst ein Abbruchknopf für Arbeit, deren Kontingent schon
      // gebucht ist. Abgebrochen wird ausschließlich über /edit/agent/abort.
      offen = false;
      void quelle.return(undefined as never);
    },
  });

  return new Response(strom, {
    status: 200,
    headers: withHeaders({ "Content-Type": "text/event-stream; charset=utf-8" }),
  });
}

/**
 * Extrahiert das Basename-Segment aus einem "<sitePrefix>/<page>"-Pfad
 * (ohne Traversal). Bei sitePrefix==="" ist der pagePath einfach "<page>"
 * top-level (kein Slash → kein Unterordner erlaubt).
 */
function pagePathBasename(ctx: HostCtx, pagePath: string): string | null {
  const sitePrefix = ctx.sitePrefix ?? "site";
  if (sitePrefix === "") {
    // Top-level: pagePath ist der reine Seitenname, keine Unterordner.
    if (pagePath.includes("/")) return null;
    return pagePath;
  }
  const prefix = `${sitePrefix}/`;
  if (!pagePath.startsWith(prefix)) return null;
  const rest = pagePath.slice(prefix.length);
  if (rest.includes("/")) return null; // keine Unterordner / Traversal
  return rest;
}
