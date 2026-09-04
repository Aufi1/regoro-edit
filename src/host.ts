/**
 * Contract B — Host-Router: dünne HTTP-Schicht über dem Kern.
 *
 * Kennt Auth + Routing, delegiert die eigentliche Logik an contract/serve/apply/
 * git sowie an entwurf/veroeffentlichen/arbeitskopie/agent. Auth-Fehler → 404
 * (nicht 401), außer /edit/login. Alle Antworten noindex/no-store.
 *
 * **Das Wichtigste an dieser Datei ist, aus WELCHEM Ordner sie liest.** Es gibt
 * drei, und die Wahl hängt an der Anfrageklasse, nicht am Pfad:
 *
 *   Editor-Ansicht   `schwebend/` über `entwurf/`   was der Kunde begutachtet
 *   Schreiben        `entwurf/`                     wohin gespeichert wird
 *   öffentlich       `siteDir`                      was die Besucher sehen
 *
 * Dafür stehen `seiteFuerAnsicht`, `seiteImEntwurf` und `seiteOeffentlich`
 * nebeneinander (Invariante 12). Sie zu einer Funktion zusammenzufassen und die
 * Wurzel aus dem Pfad zu raten wäre der sichere Weg, sie eines Tages zu
 * verwechseln — und eine Verwechslung heißt entweder „der Kunde prüft den
 * falschen Stand" oder „ein Entwurf steht öffentlich".
 *
 * `ctx.repoRoot` zeigt seit dem Entwurfs-Umbau auf `entwurfDir`, nicht mehr auf
 * den Site-Ordner: Die Historie lebt im Entwurf, der Site-Ordner ist ein Abzug
 * (Invariante 9).
 */
import { join, resolve, extname, sep, posix } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, lstatSync, statSync, mkdirSync } from "node:fs";
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
import { leseNachrichten, listeVerlaeufe, waehleFortsetzung, NACHRICHTEN_JE_SEITE } from "./verlauf.ts";
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
import {
  brichAb,
  ereignisse,
  kontingentArt,
  laufAktiv,
  starteLauf,
  uebernimmSchwebend,
  type AgentEreignis,
} from "./agent.ts";
import { pruefeKontingent } from "./kontingent.ts";
import {
  schwebendDateien,
  schwebendPfad,
  schwebendSeit,
  schwebendVorhanden,
  verwirfSchwebend,
} from "./arbeitskopie.ts";
import { istNichtMigriert } from "./entwurf.ts";
import {
  letzterVeroeffentlichterCommit,
  unveroeffentlichteCommits,
  veroeffentliche,
  FremdgeschriebenFehler,
  ZielPfadFehler,
} from "./veroeffentlichen.ts";
import {
  ensureRepo,
  commitEdit,
  git,
  listVersions,
  showVersion,
  restoreVersion,
} from "./git.ts";

export interface HostCtx {
  /**
   * Das Entwurfs-Repo — **identisch mit `entwurfDir`**, nicht mehr der
   * Site-Ordner. Die Historie der Kundenänderungen lebt dort; der Site-Ordner
   * ist seit dem Umbau ein reiner Abzug ohne eigenes `.git` (Invariante 9).
   */
  repoRoot: string;
  /** `<siteDir>/.regoro/entwurf` — git-Repo, Arbeitsbaum = ganze Website. */
  entwurfDir: string;
  /** `<siteDir>/.regoro/schwebend` — die offene KI-Änderung, falls eine da ist. */
  schwebendDir: string;
  /** Der ausgelieferte Abzug. Was hier steht, sehen die Besucher. */
  siteDir: string;
  /**
   * Das URL-Präfix dieser Website: `""` in Produktion, `"/p/<slug>"` in
   * Staging. **Nie mit Schrägstrich am Ende.**
   *
   * `route()` sieht die Pfade bereits OHNE Präfix — `server.ts` streift es ab.
   * Gebraucht wird es hier allein zum ERZEUGEN von URLs (Weiterleitungen,
   * Formularziele, `scriptUrl`); wer es beim Vergleichen benutzt, hat es
   * missverstanden.
   */
  basis: string;
  /**
   * Staging-Betrieb: keine Anmeldung mit Einmalcode, kein Veröffentlichen.
   *
   * Die Auth-Wand fasst das NICHT an (Contract C12) — Staging unterscheidet sich
   * allein im Aussteller des Cookies, und der lebt in `server.ts`. Hier hängen
   * nur zwei Dinge daran: `POST /edit/veroeffentlichen` (403, es gibt kein Ziel)
   * und welches Kontingent gilt.
   */
  staging: boolean;
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
    // Die Entwurfs-Sicht auf die statischen Dateien (Contract C11). Gehört
    // hierher, nicht zum öffentlichen Zweig: Sie zeigt ungeprüfte, noch nicht
    // veröffentlichte Arbeit und steht hinter derselben Auth-Wand wie /edit.
    path.startsWith("/edit-vorschau/") ||
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
 * Die EINE Fehlerform aller Editor-Routen: `{"fehler":…,"grund":…}`.
 *
 * `fehler` ist für die Maschine, `grund` für den Kunden — **beides, nicht eins
 * von beiden**. Vorher gab es zwei Formen nebeneinander (`{error:"…"}` bei den
 * alten Routen, `{ok:false,grund:"…"}` bei den Agenten-Routen), und der Browser
 * musste raten, welche er vor sich hat. Der teuerste Fall dabei war der
 * `fileHash`-Konflikt: Er trug gar keine Kennung und war vom neuen
 * „schwebende Änderung" nur am FEHLEN eines Feldes zu unterscheiden — eine
 * Prüfung auf Abwesenheit, und die misst in diesem Repo erfahrungsgemäß nichts.
 *
 * `extra` trägt die Felder, die eine einzelne Antwort zusätzlich braucht
 * (`dateien` bei Konflikten und Validierungsfehlern).
 */
function fehler(
  kennung: string,
  grund: string,
  status: number,
  extra: Record<string, unknown> = {},
): Response {
  return json({ fehler: kennung, grund, ...extra }, status);
}

/**
 * DREI SICHTEN AUF DIESELBE SEITE — die Wurzel entscheidet, nicht der Name.
 *
 * Seit dem Umbau gibt es drei Orte, an denen dieselbe `leistungen.html` liegen
 * kann, und welcher gemeint ist, hängt an der ANFRAGE-KLASSE:
 *
 *   Editor-Ansicht   schwebend/ → entwurf/   was der Kunde gerade bearbeitet
 *   Schreiben        entwurf/                wohin gespeichert wird
 *   öffentlich       siteDir                 was die Besucher sehen
 *
 * Sie an einer Stelle zusammenzufassen und die Wurzel nach dem Pfad zu raten
 * wäre der sichere Weg, sie eines Tages zu verwechseln — und eine Verwechslung
 * heißt hier entweder „der Kunde prüft den falschen Stand" oder „ein Entwurf
 * steht öffentlich".
 */

/**
 * Regex- und Traversal-Prüfung gegen eine gegebene Wurzel. Kennt keine
 * Whitelist — die Frage „gibt es diese Seite" beantwortet jede Sicht selbst.
 */
function seiteIn(wurzel: string, page: string): { page: string; abs: string } | null {
  if (!page || !PAGE_RE.test(page)) return null;
  const base = resolve(wurzel);
  const abs = resolve(base, page);
  if (abs !== join(base, page) || !abs.startsWith(base + "/")) return null;
  return { page, abs };
}

/** Eine reguläre Datei — kein Symlink, kein Verzeichnis, kein Gerät. */
function istEchteDatei(abs: string): boolean {
  try {
    return lstatSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Die Seite, wie sie GESCHRIEBEN wird: im Entwurfs-Repo.
 *
 * `pageWhitelist` kommt aus `entwurfDir` (Contract C1) — der Entwurf ist der
 * maßgebliche Bestand, seit er die Historie trägt.
 */
function seiteImEntwurf(ctx: HostCtx, page: string): { page: string; abs: string } | null {
  if (!ctx.pageWhitelist.includes(page)) return null;
  return seiteIn(ctx.entwurfDir, page);
}

/**
 * Die Seite, wie sie der Kunde im Editor SIEHT: die schwebende Änderung
 * überlagert den Entwurf.
 *
 * Liegt die Datei in `schwebend/`, ist sie das, was der Kunde begutachten soll —
 * genau dafür schwebt sie. Sonst gilt der Entwurf.
 */
function seiteFuerAnsicht(
  ctx: HostCtx,
  page: string,
): { page: string; abs: string; schwebend: boolean } | null {
  const imEntwurf = seiteImEntwurf(ctx, page);
  if (!imEntwurf) return null;
  const offen = seiteIn(schwebendPfad(ctx.siteDir), page);
  if (offen && istEchteDatei(offen.abs)) return { ...offen, schwebend: true };
  return { ...imEntwurf, schwebend: false };
}

/**
 * Die Seite, wie die BESUCHER sie bekommen: aus dem Site-Ordner.
 *
 * **Ohne Whitelist, und das ist keine Lockerung.** Die Whitelist entsteht aus
 * `discoverPages` → `readdirSync(withFileTypes).isFile()`; „steht auf der
 * Liste" hieß also immer schon „ist eine reguläre top-level-Datei mit
 * erlaubtem Namen". Genau das prüft `istEchteDatei` hier direkt — nur eben am
 * richtigen Ordner. Die Liste des ENTWURFS hierfür zu benutzen wäre falsch
 * herum: Eine veröffentlichte Seite, die im Entwurf gelöscht wurde, verschwände
 * für die Besucher, obwohl die Datei ausgeliefert dasteht.
 *
 * Gegenüber dem Vorzustand ist das sogar strenger: Wo früher `existsSync` stand,
 * folgte die Prüfung einem Symlink — `lstat` tut das nicht. Ein als Symlink
 * angelegter Seitenpfad war über die Whitelist ohnehin nie erreichbar; jetzt ist
 * er es auf keinem Weg.
 */
function seiteOeffentlich(ctx: HostCtx, page: string): { page: string; abs: string } | null {
  const treffer = seiteIn(ctx.siteDir, page);
  if (!treffer || !istEchteDatei(treffer.abs)) return null;
  return treffer;
}

/**
 * Liefert ein öffentliches statisches Site-Asset (CSS/Bilder/Fonts/...) aus
 * `ctx.siteDir` — OHNE Auth (es ist die public site), nur lesend (GET).
 *
 * **Nur der Site-Ordner, nie der Entwurf.** Was hier hinausgeht, sehen die
 * Besucher; unveröffentlichte Arbeit hat auf diesem Weg nichts zu suchen. Die
 * Entwurfs-Sicht auf dieselben Dateien ist `serveVorschauAsset` darunter, und
 * sie steht hinter der Auth-Wand.
 */
function serveStaticAsset(ctx: HostCtx, urlPath: string): Response | null {
  return serveAssetAus([ctx.siteDir], urlPath);
}

/**
 * Dasselbe Asset aus der ENTWURFS-Sicht: erst die schwebende Änderung, dann der
 * Entwurf. Für `/edit-vorschau/<pfad>` (Contract C11).
 *
 * **Warum es diesen Präfix überhaupt gibt.** `renderEditView` macht relative
 * Asset-URLs root-absolut. Ohne eigenen Präfix landeten sie im öffentlichen
 * Zweig — und in Produktion sogar direkt bei Caddy, das die statischen Dateien
 * ohne den Bun-Prozess ausliefert. Die „Vorschau" zeigte damit Entwurfs-HTML
 * über VERÖFFENTLICHTEM CSS: Ändert der Agent das Stylesheet, prüft der Kunde
 * das Falsche, und „erst ansehen, dann übernehmen" ist genau dort gebrochen, wo
 * es gebraucht wird.
 *
 * Angenehm nebenbei: Relative URLs INNERHALB eines Stylesheets
 * (`url(images/bg.png)`) lösen von selbst auf den Präfix auf — der Browser
 * rechnet sie gegen die URL des Stylesheets, und die trägt ihn bereits.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ZWEI QUELLEN, UND ES BLEIBEN ZWEI — die Arbeitskopie gehört NICHT dazu.
 *
 * Es wird naheliegen, hier eine dritte Wurzel zu ergänzen, etwa für „der Agent
 * sieht sich sein eigenes Ergebnis im Browser an". Dafür bräuchte er den Blick
 * WÄHREND des Laufs, und dann existiert nur die Wegwerf-Kopie unter
 * `runtimeWurzel()`. Nicht tun.
 *
 * Der Unterschied zwischen Arbeitskopie und `schwebend/` ist nicht die
 * Lebensdauer, sondern der PRÜFSTAND: In der Arbeitskopie steht die
 * UNGEPRÜFTE Ausgabe des Agenten, in `schwebend/` nur, was
 * `validateAgentOutput()` bestanden hat. Wer die Arbeitskopie über HTTP
 * ausliefert, führt ungeprüftes Markup in einem Browser aus, der das
 * Editor-Cookie trägt, auf der Herkunft des Kunden — und umgeht Invariante 1b
 * damit für JEDEN Lauf, nicht nur für den einen, den jemand im Sinn hatte. Ein
 * Agent, der ein Skript schreibt, das der Validator ablehnen würde, bekäme es
 * trotzdem ausgeführt; der Validator greift erst beim Übernehmen.
 *
 * UND DIESE ANTWORTEN TRAGEN KEINE CSP. Der Caddy-Block führt
 * `/edit-vorschau/*` im `@editor`-Zweig (Reverse-Proxy), die
 * `Content-Security-Policy` steht im statischen Zweig daneben — nachgesehen,
 * nicht angenommen. Für geprüften Inhalt ist das richtig und Absicht; für
 * ungeprüften fiele damit die dritte der drei Grenzen aus Invariante 11 weg,
 * ausgerechnet die, die außerhalb dessen liegt, was der Agent schreiben kann.
 *
 * Der richtige Weg ist, die REIHENFOLGE zu drehen, nicht die Quelle zu
 * ergänzen: erst validieren und ablegen, dann ansehen. Dann ist die Quelle
 * wieder `schwebend/`, und diese Funktion braucht keine Änderung.
 * ─────────────────────────────────────────────────────────────────────────
 */
function serveVorschauAsset(ctx: HostCtx, urlPath: string): Response | null {
  return serveAssetAus([schwebendPfad(ctx.siteDir), ctx.entwurfDir], urlPath);
}

/**
 * Liefert ein statisches Asset aus der ERSTEN Wurzel, in der es liegt.
 *
 * Traversal-Guard + Dotfile-Block + Extension-Allowlist gelten für jede Wurzel
 * gleich — die Schranken hängen am Pfad, nicht daran, wer fragt (Invariante 3).
 * Liefert null, wenn der Pfad kein gültiges Asset ist (→ 404).
 *
 * `urlPath` ist der dekodierte Request-Pfad ohne führenden "/" (z.B.
 * "styles.css" oder "assets/logo.webp").
 */
function serveAssetAus(wurzeln: string[], urlPath: string): Response | null {
  if (!urlPath || urlPath.includes("\0")) return null;
  // Dotfile-Block (Defense-in-depth): kein Segment darf mit "." beginnen
  // (.regoro/auth.json, .git/, .env …). Weder das Sitzungs-Geheimnis noch die
  // hinterlegten Kontaktwege dürfen je ausgeliefert werden. urlPath ist bereits dekodiert.
  if (hasDotSegment(urlPath)) return null;
  // Extension-Allowlist (case-insensitive); .html ist bewusst NICHT erlaubt.
  const ext = extname(urlPath).toLowerCase();
  const contentType = ASSET_TYPES[ext];
  if (!contentType) return null;

  for (const wurzel of wurzeln) {
    const base = resolve(wurzel);
    const abs = resolve(base, urlPath);
    // Traversal-Guard: aufgelöster Pfad muss strikt innerhalb der Wurzel liegen.
    if (abs !== base && !abs.startsWith(base + sep)) continue;

    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const data = readFileSync(abs);
    return new Response(data, {
      status: 200,
      // X-Robots-Tag bleibt (noindex bis Live-Gang); Cache-Control wie restlicher
      // Host (no-store) — für die Edit-Ansicht/Dogfood unkritisch.
      headers: withHeaders({ "Content-Type": contentType }),
    });
  }
  return null;
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
  basis: string,
  weg: Kanal,
  opts: { error?: string; returnTo?: string | null; warning?: string } = {},
): string {
  const q = opts.returnTo ? `&return=${encodeURIComponent(opts.returnTo)}` : "";
  const tab = (k: Kanal, beschriftung: string) =>
    `<a class="tab${weg === k ? " active" : ""}" href="${basis}/edit/login?weg=${k}${q}">${beschriftung}</a>`;
  const istSms = weg === "sms";
  return seite(
    "Anmelden",
    `<h1>Website bearbeiten</h1>
<p class="lead">Wir schicken dir einen Code. Ein Passwort brauchst du nicht.</p>
${opts.warning ?? ""}
<div class="tabs">${tab("sms", "Telefonnummer")}${tab("email", "E-Mail")}</div>
<form method="POST" action="${basis}/edit/login">
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
  basis: string,
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
<form method="POST" action="${basis}/edit/login">
<label for="code">Code</label>
<input id="code" name="code" class="code" type="text" inputmode="numeric" autocomplete="one-time-code"
 maxlength="6" pattern="[0-9]*" placeholder="000000" autofocus>
<input type="hidden" name="kennung" value="${escapeAttr(kennungRoh)}">
<input type="hidden" name="weg" value="${weg}">
${verstecktesReturn(opts.returnTo)}
<button type="submit">Anmelden</button>
${opts.error ? `<div class="err">${opts.error}</div>` : ""}
</form>
<p class="hint">Nichts bekommen? <a href="${basis}/edit/login?weg=${weg}${q}">Neuen Code anfordern</a></p>`,
  );
}

/**
 * 302-Redirect auf die Login-Seite mit (bereits validiertem) return-Ziel.
 *
 * `currentPath` ist der Pfad OHNE Basis — `server.ts` hat sie abgestreift, und
 * `RETURN_RE` prüft genau diese Form. Die Basis kommt beim Erzeugen der URL
 * wieder davor, einmal für die Weiterleitung und einmal für das `return`-Ziel.
 */
function loginRedirect(basis: string, currentPath: string): Response {
  const location = `${basis}/edit/login?return=${encodeURIComponent(currentPath)}`;
  return new Response(null, {
    status: 302,
    headers: withHeaders({ Location: location }),
  });
}

/**
 * Welche Site-Ordner schon gemeldet wurden.
 *
 * **Einmal je Ordner, nicht je Anfrage.** Die Meldung steht im 404-Pfad, und
 * ein Browser, der alle zwei Sekunden `/edit` neu lädt, schriebe sonst ein
 * Journal voll — genau in dem Moment, in dem der Betreiber darin die eine
 * erklärende Zeile suchen muss. Der Prozess lebt lange; ein Neustart meldet
 * erneut, und das ist die richtige Frequenz für einen Zustand, der nur von
 * Hand behoben werden kann.
 */
const altRepoGemeldet = new Set<string>();

function meldeAltRepo(siteDir: string): void {
  if (altRepoGemeldet.has(siteDir)) return;
  altRepoGemeldet.add(siteDir);
  console.error(
    `[regoro] FEHLER: ${siteDir} führt ein eigenes .git, aber kein Entwurfs-Repo — der Editor bleibt aus.\n` +
      `  Diese Website stammt aus der Zeit, als der Editor direkt in den Site-Ordner schrieb.\n` +
      `  Seit dem Umbau liegt die Historie in <siteDir>/.regoro/entwurf; würde der Editor hier\n` +
      `  weiterarbeiten, entstünden ZWEI Historien und das erste Veröffentlichen rollte einen\n` +
      `  leeren Entwurf über die echte Website.\n` +
      `  Die Website selbst läuft unverändert weiter — nur /edit ist aus.\n` +
      `  Beheben: den Site-Ordner auf den gewünschten Stand bringen, das alte .git entfernen\n` +
      `  und "regoro init" neu laufen lassen (erst deployen, dann initialisieren).`,
  );
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

  /**
   * === Präzedenz (0): Alt-Installation → Editor komplett aus. ===
   *
   * Ein `<siteDir>/.git` OHNE Entwurfs-Repo heißt: Diese Website stammt aus der
   * Zeit, als der Editor direkt in den Site-Ordner schrieb und die Historie dort
   * lag. Für sie gibt es keine Migration (es gibt keine Bestandsseiten) — aber
   * der Editor darf auf keinen Fall einfach danebenschreiben: Er legte ein
   * zweites Repo an, führte zwei Historien, und der erste
   * „Veröffentlichen"-Klick rollte einen leeren Entwurf über die echte Website.
   *
   * Fail-closed wie bei fehlender Auth-Datei: **404 für alles unter `/edit`**,
   * die Website selbst läuft weiter. Ein Betriebsfehler darf keine Seite vom
   * Netz nehmen.
   */
  if (isEditorPath(path) && istNichtMigriert(ctx.siteDir)) {
    meldeAltRepo(ctx.siteDir);
    return notFound();
  }

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
        loginFormKennung(ctx.basis, validWeg(url.searchParams.get("weg")), {
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
            loginFormCode(ctx.basis, weg, kennungRoh, {
              returnTo,
              error: "Der Code stimmt nicht oder ist abgelaufen. Fordere einen neuen an.",
            }),
            401,
          );
        // Leeres Feld ist kein Fehlversuch, sondern ein Vertipper: erneut fragen,
        // ohne einen der fünf Versuche zu verbrauchen und ohne den Code zu entwerten.
        if (codeRoh === "") {
          return html(
            loginFormCode(ctx.basis, weg, kennungRoh, {
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
            Location: `${ctx.basis}${returnTo ?? "/edit"}`,
          }),
        });
      }

      // --- Stufe 1: Code anfordern ---
      const kennung = normalisiereKennung(kennungRoh, weg);
      if (kennung === null) {
        // Formfehler nennen wir beim Namen — das verrät nichts darüber, WELCHE
        // Kontaktwege hinterlegt sind, und erspart eine ratlose Wartezeit.
        return html(
          loginFormKennung(ctx.basis, weg, {
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
          loginFormKennung(ctx.basis, weg, {
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
          loginFormKennung(ctx.basis, weg, {
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
      return html(loginFormCode(ctx.basis, weg, kennungRoh, { returnTo }));
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
    // ACHTUNG beim Ergänzen: Diese Liste ist die Auth-Wand. Eine Route, die
    // unten in `handleEditorRequest` steht, hier aber fehlt, wird NIE erreicht —
    // sie fällt durch bis zum statischen Ausliefern und antwortet 404, auch
    // angemeldet. Genau so lagen `/edit/agent/verlaeufe` und `/edit/agent/verlauf`
    // tot da, der Gesprächsverlauf war wirkungslos, und nichts wurde rot.
    //
    // Kein Test schlug an, weil nur „unangemeldet → 404" geprüft wurde: Das
    // stimmte, aber aus dem falschen Grund — eine Route, die es gar nicht gibt,
    // antwortet genauso. Auch die Handprüfung bestätigte den Fehler aus
    // demselben falschen Grund. Jede Route hier gehört deshalb AUCH in eine
    // Prüfung, die sie ANGEMELDET mit ihrem echten Statuscode sieht
    // (`ERREICHBAR` in `agent-routes.test.ts`).
    //
    // Zwei Zweige haben diesen Fehler unabhängig gefunden und gleich behoben;
    // hier stehen beide Begründungen zusammengeführt.
    /^\/edit\/agent(\/(events|abort|status|verlauf|verlaeufe))?$/.test(path) ||
    /^\/edit\/version\/[^/]+$/.test(path) ||
    // Die drei Zustände und die Übergänge dazwischen (Contract C2). Sie stehen
    // hier UND unten im Dispatch — wer nur eines von beidem ergänzt, baut eine
    // Route, die auch angemeldet 404 gibt.
    path === "/edit/uebernehmen" ||
    path === "/edit/verwerfen" ||
    path === "/edit/veroeffentlichen" ||
    path === "/edit/zustand" ||
    // Die Entwurfs-Sicht auf die statischen Dateien (Contract C11). Auth-bewacht
    // wie alles andere: Sie zeigt ungeprüfte, unveröffentlichte Arbeit.
    path.startsWith("/edit-vorschau/");
  if (isApiRoute) {
    if (!isAuthed(req, ctx)) return notFound();

    if (path.startsWith("/edit-vorschau/") && method === "GET") {
      let entpackt: string;
      try {
        entpackt = decodeURIComponent(path.slice("/edit-vorschau/".length));
      } catch {
        return notFound();
      }
      const asset = serveVorschauAsset(ctx, entpackt);
      return asset ?? notFound();
    }

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
      if (path === "/edit/agent/verlauf" && method === "GET") return handleAgentVerlauf(url, ctx);
      if (path === "/edit/agent/abort" && method === "POST") return handleAgentAbort(ctx);
      if (path === "/edit/agent/events" && method === "GET") return handleAgentEvents(req, ctx, srv);
      return notFound();
    }

    if (path === "/edit/save" && method === "POST") return handleSave(req, ctx);
    if (path === "/edit/upload" && method === "POST") return handleUpload(req, ctx);
    if (path === "/edit/restore" && method === "POST") return handleRestore(req, ctx);
    if (path === "/edit/uebernehmen" && method === "POST") return handleUebernehmen(ctx);
    if (path === "/edit/verwerfen" && method === "POST") return handleVerwerfen(req, ctx);
    if (path === "/edit/veroeffentlichen" && method === "POST") return handleVeroeffentlichen(ctx);
    if (path === "/edit/zustand" && method === "GET") return json(zustand(ctx));

    if (path === "/edit/versions" && method === "GET") {
      /**
       * DIE GANZE WEBSITE, nicht die einzelne Seite.
       *
       * `?page=` wird bewusst ignoriert (der Browser schickt es noch). Seit
       * `restoreVersion` mit `read-tree` über den ganzen Baum geht, wäre eine
       * Liste „Versionen dieser Seite" neben einem Knopf, der die GANZE Website
       * zurücksetzt, aktiv irreführend: Der Kunde wählte einen Eintrag, weil
       * dort seine Seite drinsteht, und bekäme alles andere gleich mit
       * zurückgedreht. Ein Commit ist eine gespeicherte Änderung des Kunden,
       * und die kann mehrere Seiten umfassen — genau deshalb committet
       * `commitEdit` einen Lauf als EINEN Commit.
       */
      return json(listVersions(ctx.repoRoot));
    }

    const versionMatch = path.match(/^\/edit\/version\/([^/]+)$/);
    if (versionMatch && method === "GET") {
      const commitRaw = decodeURIComponent(versionMatch[1]!);
      if (!COMMIT_RE.test(commitRaw)) return notFound();
      // Die EINZELNE Seite bleibt hier nötig: `showVersion` liest genau einen
      // Pfad aus einem Commit — eine Vorschau ohne Seitenangabe gäbe es nicht.
      const target = seiteImEntwurf(ctx, url.searchParams.get("page") ?? "");
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
    const target = seiteFuerAnsicht(ctx, viewPage);
    if (!target) return notFound();
    if (!isAuthed(req, ctx)) return loginRedirect(ctx.basis, path);
    if (!existsSync(target.abs)) return notFound();

    /**
     * Der Kunde sieht die ENTWURFS-Sicht, überlagert von der schwebenden
     * Änderung — nicht das, was ausgeliefert wird. Das ist der ganze Sinn des
     * Umbaus: erst ansehen, dann veröffentlichen.
     *
     * Der `fileHash` wird über GENAU DIE Fassung gebildet, die hier hinausgeht.
     * Speichert der Kunde danach, prüft `handleSave` gegen den ENTWURF — steht
     * eine schwebende Änderung darüber, weichen beide ab und das Speichern
     * scheitert mit 409. Ein Widerspruch ist das nicht: Speichern ist ohnehin
     * gesperrt, solange etwas schwebt (Plan §3), und der 409 mit eigener
     * Kennung sagt genau das.
     */
    const fileContent = readFileSync(target.abs, "utf8");
    const pagePath = pagePathFor(ctx, target.page);
    const out = renderEditView(fileContent, {
      pagePath,
      fileHash: fileSha256(fileContent),
      scriptUrl: `${ctx.basis}/edit-assets/overlay.js`,
      // Statische Dateien der Editor-Ansicht kommen aus dem Entwurf, nicht aus
      // der veröffentlichten Website (Contract C11) — sonst zeigte die Vorschau
      // neues HTML über altem CSS.
      assetBasis: `${ctx.basis}/edit-vorschau`,
      basis: ctx.basis,
      staging: ctx.staging,
      // Auf JEDER Antwort, auch ohne Modellzugang: Veröffentlichen-Knopf und
      // unveröffentlichter Stand hängen nicht an der KI (Contract C3).
      zustand: zustand(ctx),
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
    // reguläre Dateien aus dem SITE-Ordner; exakte Dateibytes ohne
    // Transformation. Der Entwurf hat hier nichts zu suchen — was der Besucher
    // sieht, ist ausschließlich das Veröffentlichte.
    const pageName = rel === "" ? "index.html" : rel;
    const pageTarget = seiteOeffentlich(ctx, pageName);
    if (pageTarget) {
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

/**
 * Der Riegel aus Plan §3: **immer nur EINE Bearbeitung offen.**
 *
 * Liefert die 409-Antwort, solange eine KI-Änderung schwebt — oder `null`, wenn
 * der Weg frei ist. Gilt für JEDEN Schreibweg in den Entwurf, nicht nur für die
 * beiden, die der Contract namentlich nennt:
 *
 *   save         eine manuelle Änderung neben einer ungeprüften KI-Änderung
 *   upload       dasselbe, nur mit einem Bild dazu
 *   restore      setzte den Boden zurück, auf dem die Änderung liegt
 *   agent        (in `starteLauf`) ein zweiter Lauf über dem ersten
 *
 * Ohne den Riegel bei `restore` bliebe die schwebende Änderung auf einem Stand
 * liegen, den es nicht mehr gibt; sie scheiterte beim Übernehmen an
 * `fremd-geaendert`, und der Kunde hätte einen bezahlten Lauf verloren, ohne je
 * eine Wahl gehabt zu haben.
 */
function schwebendRiegel(ctx: HostCtx): Response | null {
  if (!schwebendVorhanden(ctx.siteDir)) return null;
  return fehler(
    "schwebende-aenderung",
    "Es liegt eine Änderung des Assistenten vor. Übernimm sie oder verwirf sie zuerst.",
    409,
  );
}

async function handleSave(req: Request, ctx: HostCtx): Promise<Response> {
  const gesperrt = schwebendRiegel(ctx);
  if (gesperrt) return gesperrt;

  const body = await parseBody(req);
  const pagePath = typeof body.pagePath === "string" ? body.pagePath : "";
  const fileHash = typeof body.fileHash === "string" ? body.fileHash : "";
  const edits = Array.isArray(body.edits) ? (body.edits as Edit[]) : [];

  // pagePath validieren: muss "<sitePrefix>/<whitelisted>.html" sein.
  const base = pagePathBasename(ctx, pagePath);
  const target = base ? seiteImEntwurf(ctx, base) : null;
  if (!target || pagePath !== pagePathFor(ctx, target.page)) return notFound();
  if (!existsSync(target.abs)) return notFound();

  const current = readFileSync(target.abs, "utf8");
  if (fileSha256(current) !== fileHash) {
    return fehler(
      "konflikt",
      "Die Seite wurde inzwischen an anderer Stelle geändert. Lade die Seite neu.",
      409,
    );
  }

  const { html: nextHtml } = applyEdits(current, edits);
  // Symlink-sicher: nie einer als Symlink angelegten Seite nach außerhalb folgen.
  if (!pathInsideSite(ctx.entwurfDir, target.abs)) {
    return fehler("pfad", "Dieser Pfad lässt sich nicht sicher beschreiben.", 400);
  }
  writeFileSync(target.abs, nextHtml, "utf8");

  /**
   * Geschrieben wird in den ENTWURF, und der Commit ist Pflicht.
   *
   * Zwei Dinge hängen daran. Erstens: Die Website ändert sich dadurch NICHT —
   * „Speichern" veröffentlicht seit dem Umbau nicht mehr (Plan, „Drei Zustände
   * statt zwei"). Zweitens: `git read-tree --reset -u` bricht bei schmutzigem
   * Arbeitsbaum ab; bliebe hier eine nicht committete Datei liegen, wäre das
   * Wiederherstellen dauerhaft blockiert — das Sicherheitsnetz tot, genau dann,
   * wenn man es braucht.
   */
  ensureRepo(ctx.repoRoot);
  commitEdit(ctx.repoRoot, pagePath, "Inline-Edit");

  return json({ ok: true, fileHash: fileSha256(nextHtml) });
}

async function handleUpload(req: Request, ctx: HostCtx): Promise<Response> {
  const gesperrt = schwebendRiegel(ctx);
  if (gesperrt) return gesperrt;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fehler("formular", "Der Upload war unvollständig. Versuche es noch einmal.", 400);
  }

  const pagePath = String(form.get("pagePath") ?? "");
  const imgIdxRaw = form.get("imgIdx");
  const file = form.get("image");

  // 1. pagePath validieren (Traversal/Whitelist) → 404.
  const base = pagePathBasename(ctx, pagePath);
  const target = base ? seiteImEntwurf(ctx, base) : null;
  if (!target || pagePath !== pagePathFor(ctx, target.page)) return notFound();
  if (!existsSync(target.abs)) return notFound();

  // 2. Datei vorhanden? → 400.
  if (!(file instanceof Blob)) return fehler("keine-datei", "Es wurde kein Bild ausgewählt.", 400);

  // 3. Größenlimit → 400 (vor dem Lesen via Blob.size grob, nach dem Lesen exakt).
  const zuGross = () =>
    fehler("zu-gross", "Das Bild ist zu groß. Erlaubt sind 5 MB.", 400);
  if (file.size > MAX_UPLOAD_BYTES) return zuGross();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return zuGross();

  // 4. Magic-Byte-Sniff der ECHTEN Signatur (SVG/Text → null → 400).
  const ext = sniffImageExt(bytes);
  if (!ext) {
    return fehler(
      "dateityp",
      "Dieses Format wird nicht unterstützt. Erlaubt sind PNG, JPEG, GIF und WebP.",
      400,
    );
  }

  // 5. imgIdx gegen die echte Bildanzahl der Seite prüfen → 400.
  const pageHtml = readFileSync(target.abs, "utf8");
  const imgCount = enumerateImages(parseHTML(pageHtml).document).length;
  const imgIdx = Number(imgIdxRaw);
  if (!Number.isInteger(imgIdx) || imgIdx < 0 || imgIdx >= imgCount) {
    return fehler("bild-index", "Dieses Bild gibt es auf der Seite nicht (mehr).", 400);
  }

  // 6. Sicher generierter Name (Hash über Inhalt; KEINE User-Pfade/Originalnamen).
  const sha8 = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const filename = `upload-${sha8}.${ext}`;
  // Das Bild geht in den ENTWURF, wie die Seite auch. Erst das Veröffentlichen
  // trägt beides zusammen in den Site-Ordner.
  const assetsBase = resolve(ctx.entwurfDir, "assets");
  const assetsAbs = resolve(assetsBase, filename);
  const schlechterPfad = () =>
    fehler("pfad", "Dieser Pfad lässt sich nicht sicher beschreiben.", 400);
  // Traversal-Guard (filename ist generiert, aber defensiv prüfen).
  if (!assetsAbs.startsWith(assetsBase + sep)) return schlechterPfad();

  // 7. Asset schreiben — SYMLINK-SICHER (fail-closed): wäre `assets` (oder ein
  // Elternsegment) ein Symlink nach außerhalb (mounted-/restored-site), würde
  // writeFileSync dem Symlink folgen. Daher das ECHTE Ziel gegen siteDir prüfen.
  mkdirSync(assetsBase, { recursive: true });
  if (!pathInsideSite(ctx.entwurfDir, assetsAbs)) return schlechterPfad();
  writeFileSync(assetsAbs, bytes);

  /**
   * 8. src auf der Seite aktualisieren + schreiben.
   *
   * **Ein Pfad, zwei Zwecke — und seit C11 fallen sie auseinander.** Ins HTML
   * gehört der veröffentlichte Pfad `/assets/<datei>`: Die gespeicherte Seite
   * wird eines Tages ausgerollt, und ein `edit-vorschau`-Präfix im Markup wäre
   * derselbe Fehler in die andere Richtung — er überlebte das Veröffentlichen
   * und zeigte den Besuchern auf eine auth-bewachte Adresse.
   *
   * An den Browser zurück muss dagegen die VORSCHAU-Adresse: Die Datei liegt
   * nach dem Upload unter `entwurfDir/assets/` und im ausgelieferten Ordner
   * noch gar nicht. Gäbe es nur einen Wert, wäre nach jedem Bildtausch genau
   * dieses eine Bild kaputt, während alle anderen der Seite funktionieren —
   * die hat `rewriteAssetUrls` längst auf den Präfix umgeschrieben. Diese
   * Asymmetrie innerhalb einer Seite wäre zugleich das Erkennungszeichen.
   */
  const newSrc = `/assets/${filename}`;
  const { html: nextHtml, applied } = setImageSrc(pageHtml, imgIdx, newSrc);
  if (applied !== 1) {
    return fehler("bild-nicht-ersetzt", "Das Bild ließ sich auf der Seite nicht austauschen.", 400);
  }
  if (!pathInsideSite(ctx.entwurfDir, target.abs)) return schlechterPfad();
  writeFileSync(target.abs, nextHtml, "utf8");

  // 9. Beide (Asset + Seite) committen.
  const sitePrefix = ctx.sitePrefix ?? "site";
  const assetPagePath = sitePrefix
    ? posix.join(sitePrefix, "assets", filename)
    : posix.join("assets", filename);
  ensureRepo(ctx.repoRoot);
  commitEdit(ctx.repoRoot, assetPagePath, `Bild-Upload: ${filename}`);
  commitEdit(ctx.repoRoot, pagePath, `Bild ausgetauscht: idx ${imgIdx}`);

  return json({
    ok: true,
    // Die Vorschau-Adresse, nicht der veröffentlichte Pfad. Der Browser
    // übernimmt sie UNVERÄNDERT und stellt nichts davor — die Konvention
    // gehört dem Server, und zwei Quellen dafür wären schlimmer als der Fehler,
    // den sie beheben sollen.
    src: `${ctx.basis}/edit-vorschau${newSrc}`,
    fileHash: fileSha256(nextHtml),
  });
}

/**
 * Stellt eine frühere Version wieder her — **die ganze Website, nicht eine
 * Seite** (Plan §1).
 *
 * Der alte Weg (`git checkout <commit> -- <pfad>`) konnte grundsätzlich nichts
 * löschen: Ein Lauf, der Dateien ANGELEGT hat, ließ sich damit nicht
 * zurücknehmen — die neuen Dateien blieben liegen. Für tote Dateien war das
 * folgenlos, für einen Service Worker nicht; deshalb steht die
 * Wiederherstellung jetzt auf `read-tree` über dem ganzen Baum.
 *
 * `pagePath` schickt der Browser noch mit; er wird **nicht mehr gebraucht** und
 * bewusst nicht geprüft. Ihn als Pflichtfeld zu behalten hieße, eine Angabe zu
 * verlangen, die das Ergebnis nicht beeinflusst — und der nächste Leser hielte
 * die Wiederherstellung wieder für seitenweise.
 */
async function handleRestore(req: Request, ctx: HostCtx): Promise<Response> {
  const gesperrt = schwebendRiegel(ctx);
  if (gesperrt) return gesperrt;

  const body = await parseBody(req);
  const commit = typeof body.commit === "string" ? body.commit : "";
  if (!COMMIT_RE.test(commit)) return notFound();

  try {
    ensureRepo(ctx.repoRoot);
    restoreVersion(ctx.repoRoot, commit);
  } catch {
    return fehler("wiederherstellen", "Diese Version ließ sich nicht wiederherstellen.", 400);
  }
  return json({ ok: true });
}

// ===========================================================================
// Die drei Zustände — Übernehmen, Verwerfen, Veröffentlichen, Zustand
//
// Entwurf (schwebend) → Gespeichert (Entwurfs-Repo) → Veröffentlicht (siteDir).
// Jeder Übergang ist genau eine Route, und jede davon steht in ZWEI Listen
// weiter oben: in der Auth-Wand (`isApiRoute`) und im Dispatch.
// ===========================================================================

/** Was gerade offen ist und was möglich ist (Contract C2). */
function zustand(ctx: HostCtx): Record<string, unknown> {
  const dateien = schwebendDateien(ctx.siteDir);
  const seitCommit = letzterVeroeffentlichterCommit(ctx.siteDir);
  const offen = unveroeffentlichteCommits(ctx.entwurfDir, seitCommit);
  return {
    schwebend: dateien.length > 0,
    schwebendDateien: dateien,
    schwebendSeit: dateien.length > 0 ? alsZeitpunkt(schwebendSeit(ctx.siteDir)) : null,
    unveroeffentlicht: offen.anzahl > 0,
    // ZÄHLT COMMITS, nicht Dateien: Ein Commit ist eine gespeicherte Änderung
    // des Kunden und kann mehrere Seiten umfassen.
    unveroeffentlichtAnzahl: offen.anzahl,
    unveroeffentlichtSeit: alsZeitpunkt(offen.seit),
    staging: ctx.staging,
    // In Staging gibt es kein Ziel, in das veröffentlicht würde — das ergibt
    // sich aus dem Betrieb, nicht aus einer Prüfung. Und solange etwas
    // schwebt, ist erst die eine Entscheidung dran.
    veroeffentlichenMoeglich: !ctx.staging && dateien.length === 0 && offen.anzahl > 0,
  };
}

/**
 * Eine ISO-Zeitangabe auf die `Z`-Form bringen. Unbrauchbares wird `null` —
 * eine Zeitangabe steht in einer Anzeige und darf nichts lahmlegen.
 *
 * **JEDE Zeitangabe dieser Route geht hier durch, auch die, die schon richtig
 * aussieht.** Die Werte kommen aus zwei Quellen — die eine bildet ihre Zeit
 * selbst, die andere reicht `git log --format=%aI` durch, und das ist Ortszeit
 * mit Zonenversatz (`…+02:00`). Beide Formen sind gültiges ISO 8601 und ergeben
 * denselben Moment; aber zwei Formen für denselben Feldtyp im selben Objekt
 * sind eine Einladung: Irgendwann vergleicht, sortiert oder schneidet jemand
 * Zeichenketten statt zu parsen, und dann liegt der Fehler nicht bei ihm,
 * sondern hier.
 *
 * Deshalb an der SCHNITTSTELLE und nicht nur an der auffälligen Quelle: C2
 * beschreibt die Form dieser Antwort, also gehört die Zusicherung dorthin, wo
 * die Antwort entsteht. Dass `veroeffentlichen.ts` inzwischen ebenfalls
 * normalisiert, macht das hier nicht überflüssig — normalisieren ist
 * idempotent, und die Route bleibt so von der internen Wahl eines
 * Nachbarmoduls unabhängig.
 */
function alsZeitpunkt(roh: string | null): string | null {
  if (roh === null) return null;
  const ms = Date.parse(roh);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Die schwebende KI-Änderung in den Entwurf übernehmen. */
function handleUebernehmen(ctx: HostCtx): Response {
  const erg = uebernimmSchwebend(ctx);
  if (erg.ok) return json({ ok: true, commit: erg.commit, dateien: erg.dateien });

  switch (erg.grund) {
    case "keine-schwebende-aenderung":
      return fehler(
        "keine-schwebende-aenderung",
        "Es liegt keine Änderung des Assistenten vor.",
        409,
      );
    case "fremd-geaendert":
      return fehler(
        "fremd-geaendert",
        "Die Website wurde inzwischen an anderer Stelle geändert. Die Änderung des Assistenten passt nicht mehr dazu.",
        409,
        { dateien: erg.dateien },
      );
    case "validierung":
      /**
       * Der deutsche Satz kommt aus `validate.ts` und geht UNVERÄNDERT hinaus.
       * Eine Kennung daraus zu machen und sie hier zurückzuübersetzen hieße,
       * eine Liste zu pflegen, die bei jedem neuen Prüffall veraltet — und der
       * Validator schreibt bereits Klartext, den ein Handwerksbetrieb versteht.
       */
      return fehler(
        "validierung",
        "Die Sicherheitsprüfung hat die Änderung nicht übernommen.",
        422,
        { dateien: erg.dateien },
      );
    case "abgelehnt":
      // Die Kennung trägt einen Pfad und gehört ins Betreiber-Log, nicht in
      // den Browser — dieselbe Trennung wie bei `agentFehlerText`.
      console.error(`[regoro] Übernahme abgelehnt: ${erg.kennung}`);
      return fehler(
        "abgelehnt",
        "Die Sicherheitsprüfung hat die Änderung nicht übernommen.",
        422,
      );
  }
}

/** Schwebende Änderung wegwerfen — oder den Entwurf auf die Live-Seite zurück. */
async function handleVerwerfen(req: Request, ctx: HostCtx): Promise<Response> {
  const body = await parseBody(req);
  const umfang = typeof body.umfang === "string" ? body.umfang : "";

  if (umfang === "schwebend") {
    // Idempotent: auch ohne offene Änderung 200. Ein 409 zwänge die
    // Seitenleiste zu einer Fallunterscheidung, die niemandem hilft —
    // weggeworfen ist weggeworfen (dieselbe Haltung wie beim Abbrechen).
    verwirfSchwebend(ctx.siteDir);
    return json({ ok: true });
  }

  if (umfang === "entwurf") {
    /**
     * Zurück auf den zuletzt veröffentlichten Stand — als NEUER Commit
     * obendrauf, die Historie wächst nur nach vorn.
     *
     * Fehlt der veröffentlichte Commit (noch nie veröffentlicht, und in
     * Staging dauerhaft), ist der Baseline-Commit das richtige Ziel: Er hält
     * den Stand, mit dem die Website initialisiert wurde, und das ist dort
     * dasselbe wie „die Live-Seite". Ohne diesen Rückfall täte „Änderungen
     * verwerfen" in Staging gar nichts — und der Hinweis aus C8 böte einen
     * Knopf an, der folgenlos bleibt.
     */
    const ziel = letzterVeroeffentlichterCommit(ctx.siteDir) ?? baselineCommit(ctx.repoRoot);
    if (ziel === null) return json({ ok: true });
    try {
      ensureRepo(ctx.repoRoot);
      restoreVersion(ctx.repoRoot, ziel);
    } catch {
      return fehler("verwerfen", "Der Entwurf ließ sich nicht zurücksetzen.", 400);
    }
    // Was schwebt, gehört zu einem Stand, den es nicht mehr gibt.
    verwirfSchwebend(ctx.siteDir);
    return json({ ok: true });
  }

  return fehler("umfang", "Unbekannter Umfang.", 400);
}

/**
 * Der erste Commit des Entwurfs-Repos — der Stand, mit dem die Website
 * initialisiert wurde.
 *
 * Fail-soft: Antwortet git nicht, ist das Ergebnis `null` und der Aufrufer
 * entscheidet. Keine Wiederherstellung ist besser als eine auf einen geratenen
 * Commit.
 */
function baselineCommit(repoRoot: string): string | null {
  try {
    const zeilen = git(repoRoot, "rev-list", "--max-parents=0", "HEAD")
      .split("\n")
      .map((z) => z.trim())
      .filter(Boolean);
    // Bei mehreren wurzellosen Strängen ist der ÄLTESTE gemeint; `rev-list`
    // liefert neueste zuerst.
    return zeilen[zeilen.length - 1] ?? null;
  } catch {
    return null;
  }
}

/** Den Entwurf in den Site-Ordner ausrollen. */
function handleVeroeffentlichen(ctx: HostCtx): Response {
  /**
   * In Staging gibt es kein Ziel — die Preview IST nur ein Entwurf.
   *
   * Die Prüfung steht trotzdem hier und nicht nur in der Oberfläche: Ein
   * Knopf, den das Overlay ausblendet, ist keine Zusicherung; ein Aufruf per
   * curl käme sonst durch.
   */
  if (ctx.staging) {
    return fehler("staging", "In der Vorschau gibt es kein Veröffentlichen.", 403);
  }

  const gesperrt = schwebendRiegel(ctx);
  if (gesperrt) return gesperrt;

  try {
    const abgleich = veroeffentliche(ctx.siteDir, ctx.entwurfDir);
    return json({
      ok: true,
      geschrieben: abgleich.geschrieben.length,
      geloescht: abgleich.geloescht.length,
    });
  } catch (err) {
    if (err instanceof FremdgeschriebenFehler) {
      /**
       * NOTBREMSE, kein Sicherheitsnetz. Jemand hat neben dem Entwurfs-Repo in
       * den Site-Ordner geschrieben — ein Neubau der Fabrik, ein Skript, eine
       * Hand am Server. Überschreiben hieße, diese Arbeit stillschweigend zu
       * verlieren; deshalb wird gefragt statt gehandelt.
       */
      console.error(`[regoro] Veröffentlichen abgebrochen: ${err.message}`);
      return fehler(
        "fremd-geschrieben",
        "Auf der Live-Seite wurde außerhalb des Editors geschrieben. Bitte den Betreiber informieren.",
        409,
        { dateien: err.dateien },
      );
    }
    if (err instanceof ZielPfadFehler) {
      console.error(`[regoro] Veröffentlichen abgebrochen: ${err.message}`);
      return fehler(
        "zielpfad",
        "Die Website lässt sich so nicht veröffentlichen. Bitte den Betreiber informieren.",
        409,
      );
    }
    // Alles Übrige geht ins Log, nie an den Browser: Die Meldung könnte
    // interne Pfade tragen (dieselbe Regel wie im Ereignisstrom).
    console.error(
      `[regoro] Veröffentlichen gescheitert: ${err instanceof Error ? err.message : String(err)}`,
    );
    return fehler("veroeffentlichen", "Das Veröffentlichen ist fehlgeschlagen.", 500);
  }
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

/** Obergrenze für die Gesprächskennung im Auftrag. Eine UUID ist 36 Zeichen. */
const MAX_VERLAUF_KENNUNG = 200;

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
  /**
   * Kein Sicherheitsbefund, sondern ein Zusammenstoß — deshalb ein eigener Satz.
   *
   * Der Kunde hat während des Laufs selbst gespeichert. Er MUSS erfahren, dass
   * seine eigene Änderung erhalten ist: Sonst sieht er nur, dass der Auftrag
   * nichts bewirkt hat, und startet ihn erneut — was dasselbe noch einmal
   * kostet. Die Dateinamen bleiben im Log, sie sagen ihm nichts.
   */
  if (grund.startsWith("fremd-geaendert:")) {
    console.error(`[regoro] Übernahme verworfen, fremde Änderung: ${grund}`);
    return "Die Website wurde während des Auftrags von Hand geändert. Der Auftrag wurde verworfen, deine eigene Änderung ist erhalten.";
  }

  const trenner = grund.indexOf(":");
  if (trenner > 0 && UEBERNAHME_ABLEHNUNGEN.has(grund.slice(0, trenner))) {
    console.error(`[regoro] Übernahme abgelehnt: ${grund}`);
    return (
      "Die Sicherheitsprüfung hat die Änderung nicht übernommen."
    );
  }

  switch (grund) {
    case "kein-lauf":
      return "Kein Lauf aktiv.";
    case "kein-modellzugang":
      return "Der KI-Assistent ist nicht eingerichtet.";
    case "lauf-gescheitert":
      return "Auftrag fehlgeschlagen.";
    case "worker-abgestuerzt":
      // Nachgemessen: Ohne diesen Fall stand wörtlich „worker-abgestuerzt" im
      // Chatfenster des Kunden. Was schiefging, gehört ins Log des Betreibers;
      // der Kunde braucht zu wissen, dass seine Website unberührt ist.
      return "Der Assistent hat sich unerwartet beendet.";
    case "kontingent-erschoepft":
      /**
       * ZWEI WÖRTER, UND DAS IST ABSICHT. Die Kontingentleiste steht direkt
       * über dem Verlauf und sagt dauerhaft „Das Monatskontingent ist
       * aufgebraucht. Es setzt sich am Monatsersten zurück." Das Datum hier zu
       * wiederholen hieße, dieselbe Aussage zweimal zu führen — und zwei
       * Quellen für eine Aussage laufen früher oder später auseinander.
       *
       * Die Entwarnung („nichts geändert") fehlt hier wie überall sonst — so
       * vom Betreiber entschieden, nachdem der Einwand vorlag. Sie stand in
       * fast jeder Meldung und machte alle lang; ein abgebrochener Lauf ändert
       * ohnehin nichts, weil die Übernahme erst nach sauberem Abschluss läuft.
       * Wer sie zurückholt, holt sie an EINER Stelle zurück, nicht in sieben.
       */
      return "Kontingent aufgebraucht.";
    case "abgebrochen":
      // Der meistbenutzte Weg überhaupt — der Abbrechen-Knopf. Ohne diesen Fall
      // stand dort ein rotes Feld mit dem Wort „abgebrochen".
      return "Auftrag abgebrochen.";
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
      return "Der Assistent ist gerade nicht verfügbar.";
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
  // Welches Gespräch ein Auftrag OHNE Angabe fortsetzen würde. Der Browser
  // rechnet die 24-Stunden-Regel nicht nach — täte er es, gäbe es sie zweimal,
  // und die Leiste zeigte irgendwann ein anderes Gespräch an als das, in das
  // der nächste Auftrag liefe.
  const fortsetzung = await waehleFortsetzung(ctx.siteDir);
  return Response.json({
    ok: true,
    fortsetzbar: fortsetzung ? fortsetzung.id : null,
    verlaeufe: alle.map((v) => ({
      id: v.id,
      titel: v.titel,
      geaendert: v.geaendert,
      nachrichten: v.nachrichten,
    })),
  });
}

/**
 * Ein Gespräch zum Nachlesen, seitenweise von hinten.
 *
 * `id` ist eine Kennung aus der Liste, KEIN Pfad — `leseNachrichten` sucht sie
 * im Verzeichnis dieser Website und kommt nie auf eine Datei, die nicht ohnehin
 * dazugehört. Eine unbekannte Kennung ist 404, nicht 400: Nach dem Aufräumen
 * (30 Tage) ist genau das der Normalfall, und für den Browser ist beides
 * dasselbe — er beginnt ein neues Gespräch.
 *
 * Der Text ist wörtlich, was der Kunde geschrieben und das Modell geantwortet
 * hat. Er geht als JSON hinaus und wird im Overlay per `textContent` gesetzt,
 * nie als HTML — wie die Titel in der Liste.
 */
async function handleAgentVerlauf(url: URL, ctx: HostCtx): Promise<Response> {
  const id = url.searchParams.get("id") ?? "";
  if (id === "") return agentFehler("verlauf-kennung", "Kennung fehlt.", 400);
  // Dieselbe Grenze wie beim Auftrag. Nicht ausnutzbar (es folgt nur ein
  // Zeichenkettenvergleich), aber zwei Wege in dieselbe Funktion sollen nicht
  // verschieden streng sein — sonst rät beim nächsten Mal jemand, welcher gilt.
  if (id.length > MAX_VERLAUF_KENNUNG) {
    return agentFehler("verlauf-kennung", "Ungültige Gesprächskennung.", 400);
  }

  const vorRoh = url.searchParams.get("vor");
  const anzahlRoh = url.searchParams.get("anzahl");
  const seite = await leseNachrichten(ctx.siteDir, id, {
    // `Number("")` ist 0 und wäre eine leere Seite — deshalb erst prüfen, dann
    // umwandeln. Unsinnige Werte klammert `leseNachrichten` selbst.
    vor: vorRoh === null || vorRoh === "" ? null : Number(vorRoh),
    anzahl: anzahlRoh === null || anzahlRoh === "" ? NACHRICHTEN_JE_SEITE : Number(anzahlRoh),
  });
  if (!seite) return agentFehler("verlauf-weg", "Dieses Gespräch gibt es nicht mehr.", 404);
  return Response.json({ ok: true, ...seite });
}

async function handleAgentStart(req: Request, ctx: HostCtx): Promise<Response> {
  const body = await parseBody(req);
  const auftrag = typeof body.auftrag === "string" ? body.auftrag.trim() : "";
  // Leer und „nur Leerzeichen" sind derselbe Fall: Ein Lauf ohne Auftrag würde
  // Kontingent verbrauchen, um nichts zu tun.
  if (auftrag === "") {
    return agentFehler("auftrag-fehlt", "Auftrag fehlt.", 400);
  }
  if (auftrag.length > MAX_AUFTRAG_ZEICHEN) {
    return agentFehler(
      "auftrag-zu-lang",
      `Der Auftrag ist zu lang (${auftrag.length} Zeichen, erlaubt sind ${MAX_AUFTRAG_ZEICHEN}). Beschreibe in ein paar Sätzen, was sich ändern soll.`,
      400,
    );
  }

  /**
   * Welches Gespräch fortgesetzt wird. Drei Werte: `"auto"` (Vorgabe, der
   * Server wendet die 24-Stunden-Regel an), `"neu"`, oder eine Kennung aus
   * `GET /edit/agent/verlaeufe`.
   *
   * Eine unbekannte Kennung ist KEIN Fehler — sie beginnt ein neues Gespräch
   * (Begründung in `verlauf.ts`). Geprüft wird nur die Länge: Kennungen sind
   * UUIDs, alles darüber ist niemals eine und hat im Vergleich nichts zu
   * suchen.
   */
  const verlaufRoh = typeof body.verlauf === "string" ? body.verlauf.trim() : "auto";
  if (verlaufRoh.length > MAX_VERLAUF_KENNUNG) {
    return agentFehler("verlauf-kennung", "Ungültige Gesprächskennung.", 400);
  }
  const verlauf = verlaufRoh === "" ? "auto" : verlaufRoh;

  const start = starteLauf(ctx, auftrag, { verlauf });
  if (start.ok) return json({ ok: true, laufId: start.laufId });

  switch (start.grund) {
    case "laeuft-bereits":
      return agentFehler(
        "laeuft-bereits",
        "Es läuft bereits ein Auftrag für diese Website.",
        409,
      );
    case "schwebende-aenderung":
      // Plan §3: immer nur EINE Bearbeitung offen. Ein zweiter Lauf über einer
      // noch nicht angesehenen Änderung verschöbe deren Grundlage.
      return agentFehler(
        "schwebende-aenderung",
        "Es liegt eine Änderung des Assistenten vor. Übernimm sie oder verwirf sie zuerst.",
        409,
      );
    case "kontingent":
      return agentFehler(
        "kontingent",
        ctx.staging
          ? "Das Kontingent dieser Vorschau ist aufgebraucht."
          : "Das Monatskontingent ist aufgebraucht. Es setzt sich am Monatsersten zurück.",
        429,
      );
    case "keine-sandbox":
      // 503 und nicht 500: Es ist eine fehlende Voraussetzung des Servers, kein
      // Fehler des Kunden und nichts, was ein zweiter Versuch behebt.
      return agentFehler(
        "keine-sandbox",
        "Die Sandbox (bwrap) ist auf diesem Server nicht verfügbar.",
        503,
      );
  }
}

/**
 * Die Fehlerform der Agenten-Routen: `{ok:false, fehler, grund}`.
 *
 * `ok:false` und `grund` bleiben, wie sie waren — das Overlay liest beide, und
 * die Sätze sind seit Monaten erprobt. `fehler` kommt DAZU (Contract C2), damit
 * der Browser einen Fall nicht mehr am Wortlaut erkennen muss.
 */
function agentFehler(kennung: string, grund: string, status: number): Response {
  return json({ ok: false, fehler: kennung, grund }, status);
}

function handleAgentStatus(ctx: HostCtx): Response {
  const k = pruefeKontingent(ctx.siteDir, kontingentArt(ctx));
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
      // Die Obergrenze kommt aus dem ERGEBNIS, nicht aus einer Konstante hier:
      // Es gibt zwei Zahlen, und eine Vorschau, die „noch X von 3.000.000"
      // anzeigt, während 1.000.000 gelten, hätte eine Leiste, die bei zwei
      // Dritteln stehenbleibt und dann ohne Vorwarnung sperrt.
      gesamt: k.gesamt,
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
