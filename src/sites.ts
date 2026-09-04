/**
 * Sammelbetrieb: ein Prozess bedient viele Kundenwebsites.
 *
 * Der ORDNERNAME ist die Zuordnung — `/srv/sites/kunde.de/` gehört zu
 * `kunde.de`. Keine Zuordnungsdatei: die wäre ein zweiter Ort für dieselbe
 * Wahrheit, könnte fehlen, veralten oder auf einen Ordner zeigen, den es nicht
 * mehr gibt. Ein Ordnername kann das nicht.
 *
 * Zwei Stufen, beide fail-closed:
 *   normalizeHost — der Host-Header ist NUTZEREINGABE und wird hier zum
 *                   Pfadsegment. Die Normalisierung ist deshalb zugleich der
 *                   Traversal-Schutz.
 *   resolveSite   — Nachschlagen im Sammelverzeichnis; nur ein DIREKTES Kind zählt.
 *
 * Siehe CLAUDE.md, Invariante 10 (Kundentrennung).
 */
import { dirname, resolve } from "node:path";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadAuthFile, type AuthConfig } from "./auth.ts";
import { loadKiConfig, type KiConfig } from "./betreiber-config.ts";
import { schwebendPfad } from "./arbeitskopie.ts";
import { entwurfPfad } from "./entwurf.ts";
import type { HostCtx } from "./host.ts";
import type { Versand } from "./versand.ts";

/**
 * Editierbare Seiten: top-level, kleingeschrieben, `.html`. EINE Definition für
 * beide Seiten der Medaille — `listPageFiles` entscheidet, was in die Whitelist
 * kommt, `resolvePage` in host.ts, was aufgelöst werden darf. Liefen die
 * auseinander, stünde eine Seite in der Liste des Kunden und gäbe beim Anklicken 404.
 */
export const PAGE_RE = /^[a-z0-9-]+\.html$/;

/**
 * Allowlist statischer Asset-Endungen → Content-Type. Sie entscheidet, was aus
 * einem Site-Ordner überhaupt öffentlich wird — und damit, was NICHT: Ein
 * Kundenordner enthält real auch Build-Artefakte (`design.json`, `images.json`
 * mit internen Serverpfaden), Backups und Notizen. KEIN `.html` (Seiten laufen
 * über resolvePage), KEIN `.json`/`.yaml`/`.md`, und `.svg` bleibt draußen:
 * `image/svg+xml` ist script-fähig, ein hochgeladenes SVG wäre latenter
 * Stored-XSS. Siehe CLAUDE.md, Invariante 3.
 *
 * **Warum hier und nicht in host.ts**, wo sie bis v0.2 stand: Der Prüfschritt
 * des KI-Laufs (`validate.ts`) muss dieselbe Liste führen — eine zweite Kopie
 * dort risse genau die Schranke auf, die Invariante 3 trägt. Ein Import aus
 * host.ts hätte aber einen Zyklus gebaut (host → agent → validate → host), und
 * in einem Zyklus ist eine Konstante beim Import des Partners noch nicht
 * initialisiert: `Object.keys(ASSET_TYPES)` auf Modulebene wirft dann, je nach
 * Importreihenfolge. sites.ts hat zur Laufzeit KEINE Kante zu host.ts (von dort
 * kommt nur `type HostCtx`, und Typ-Importe werden wegkompiliert), deshalb
 * wohnt sie hier.
 *
 * Ein vollständiges Blatt ist sites.ts seit dem Entwurfs-Umbau nicht mehr —
 * `buildCtx` braucht `entwurfPfad`/`schwebendPfad` für die Pfade des Ctx. Beide
 * Ketten (entwurf → arbeitskopie/git/veroeffentlichen → apply → contract) enden
 * ohne Rückweg hierher; nachgesehen. **Die Bedingung ist nicht „Blatt", sondern
 * „kein Weg zurück nach host.ts oder sites.ts".** Wer hier importiert, prüft
 * das — sonst kehrt der Zyklus über die Hintertür zurück.
 *
 * **Daraus folgt eine Regel:** Neue Leser importieren `ASSET_TYPES` und
 * `PAGE_RE` aus DIESER Datei. host.ts re-exportiert beide nur der Bequemlichkeit
 * halber; ein `from "./host.ts"` stellt den Zyklus wieder her, egal wo die
 * Konstante wohnt — entscheidend ist die Import-Kante, nicht der Ort.
 *
 * Ändert sich diese Liste, ändern sich `caddyBlock()` in service.ts und BEIDE
 * Caddyfile-Vorlagen mit: Im Sammelbetrieb liefert Caddy die statischen Dateien
 * selbst aus, der Bun-Host ist dafür nicht im Pfad. Ein Test nagelt die
 * `@allowed`-Zeile in allen vieren aneinander fest.
 */
export const ASSET_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  // KEIN .svg: image/svg+xml ist script-fähig (latenter Stored-XSS). regoro.de
  // nutzt nur webp/jpg. Upload blockt SVG ohnehin per Sniff — das schließt auch
  // den Static-Serving-Pfad.
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

/**
 * Ein Hostname nach RFC-1123-Zeichensatz: Labels aus [a-z0-9-], die weder mit
 * "-" beginnen noch enden, getrennt durch genau einen Punkt. Bewusst streng —
 * alles, was hier durchfällt, wird nie zu einem Pfadsegment.
 */
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const MAX_HOST_LEN = 253;

/**
 * Trennt einen optionalen Port ab. IPv6-Literale (`[::1]`, `[::1]:80`) werden
 * als Klammerform erkannt und bleiben mitsamt Klammern stehen — HOST_RE lehnt
 * sie danach ab, was gewollt ist: eine Website heißt nicht `[::1]`.
 */
const HOSTPORT_RE = /^(\[[^\]]*\]|[^:]*)(?::\d{1,5})?$/;

/**
 * Normalisiert einen Host-Header auf den Ordnernamen einer Website.
 * null = abgelehnt (→ 404). Reihenfolge: Port, Kleinschreibung, Wurzelpunkt,
 * `www.`, dann die Zeichenprüfung.
 *
 * Bewusst NICHT getrimmt: Leerzeichen im Host-Header sind kein Tippfehler eines
 * Kunden, sondern ein Angriffsversuch.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "") return null;

  const m = HOSTPORT_RE.exec(raw);
  if (!m) return null;
  let host = m[1]!.toLowerCase();

  // Abschließender Wurzelpunkt: "kunde.de." und "kunde.de" sind derselbe Name.
  if (host.endsWith(".")) host = host.slice(0, -1);
  // www. gehört derselben Website. Der Proxy leitet zusätzlich um (siehe
  // caddyBlock), aber der Editor darf sich darauf nicht verlassen.
  if (host.startsWith("www.")) host = host.slice(4);

  if (host.length === 0 || host.length > MAX_HOST_LEN) return null;
  if (!HOST_RE.test(host)) return null;
  return host;
}

export interface SiteRef {
  /** Normalisierter Hostname = Ordnername. */
  host: string;
  /** Absoluter, REALER Pfad des Site-Ordners (Symlinks aufgelöst). */
  siteDir: string;
}

/**
 * Löst einen Host-Header gegen das Sammelverzeichnis auf. null = unbekannt,
 * abgelehnt oder kein Verzeichnis (→ 404, nie eine Vermutung).
 *
 * Ein Unterordner darf ein Symlink nach außen sein — Betreiber mounten Sites so.
 * Zurückgegeben wird dann der AUFGELÖSTE Pfad, damit `pathInsideSite` später
 * gegen dasselbe Ziel prüft wie die Auflösung hier. Der Traversal-Schutz sitzt
 * davor und ist lexikalisch: nur ein direktes Kind des Sammelverzeichnisses.
 */
export function resolveSite(sitesRoot: string, host: string | null | undefined): SiteRef | null {
  const normalized = normalizeHost(host);
  if (normalized === null) return null;

  let root: string;
  try {
    root = realpathSync(resolve(sitesRoot));
  } catch {
    return null;
  }

  const abs = resolve(root, normalized);
  // resolve() allein genügt nicht: resolve("/srv/sites", "..") ergibt "/srv".
  // normalizeHost schließt "/" und ".." bereits aus; diese Prüfung ist die
  // zweite, von der Textform unabhängige Schranke.
  if (dirname(abs) !== root) return null;

  let real: string;
  try {
    real = realpathSync(abs);
    if (!statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  return { host: normalized, siteDir: real };
}

/**
 * Das Präfix des Staging-Betriebs. Eine Preview wohnt unter
 * `https://intern.sites.aufi.de/p/<slug>/` — der Kundenname steht im PFAD und
 * nicht im Hostnamen, damit er nicht in den öffentlichen
 * Certificate-Transparency-Logs landet (dort steht nur `intern.sites.aufi.de`,
 * einmal).
 */
export const STAGING_PREFIX = "/p/";

/**
 * Ein Preview-Slug: EIN Pfadsegment, kleingeschrieben, Ziffern und
 * Bindestriche, weder vorn noch hinten ein Bindestrich.
 *
 * **Punkte sind vollständig verboten — strenger als `HOST_RE`.** Der Slug wird
 * zum Verzeichnisnamen, genau wie der normalisierte Host; anders als dort gibt
 * es hier aber keinen legitimen Grund für einen Punkt (ein Ordnername unter dem
 * Preview-Verzeichnis ist `bergdolt-c89a`, kein Domainname). Und ein Punkt ist
 * der einzige Hebel für `..`. Ihn gar nicht erst zuzulassen ist die Fassung,
 * die man nicht falsch schreiben kann.
 */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Wie `MAX_HOST_LEN`, nur für ein einzelnes Label: 63 Zeichen. Der Wert stammt
 * aus der DNS-Label-Grenze und ist hier keine fachliche Notwendigkeit, sondern
 * dieselbe Vorsichtsmaßnahme wie oben — was in einen Pfad eingesetzt wird,
 * bekommt vorher einen Deckel.
 */
const MAX_SLUG_LEN = 63;

export interface StagingRef {
  /** Der geprüfte Slug — zugleich der Ordnername. */
  slug: string;
  /** Absoluter, REALER Pfad des Site-Ordners (Symlinks aufgelöst). */
  siteDir: string;
  /** Der Pfad OHNE Präfix, beginnt immer mit "/". Das sieht `route()`. */
  rest: string;
  /** `"/p/" + slug`, NIE mit Schrägstrich am Ende (siehe HostCtx.basis). */
  basis: string;
}

/**
 * Die ZWEITE Auflösungsart neben `resolveSite`: Anfrage → Website über einen
 * Pfad-Abschnitt statt über den Host-Header.
 *
 * Damit steht die **erste Stütze** der Kundentrennung (CLAUDE.md, Invariante 10)
 * auf einem zweiten Bein, und das muss dieselbe Strenge haben wie
 * `normalizeHost` — das ja zugleich der Traversal-Schutz ist. Dieselben drei
 * Schranken wie in `resolveSite`: Zeichenprüfung, lexikalisches „direktes Kind",
 * realpath + `isDirectory()`.
 *
 * **Bewusst wird hier NICHTS normalisiert** — kein `toLowerCase`, kein
 * abgeschnittenes `www.`, kein Wurzelpunkt. Das ist der eine Punkt, an dem
 * diese Funktion von `normalizeHost` abweicht, und er ist Absicht: Ein
 * Host-Header schwankt legitim in der Schreibweise, weil ihn Browser und
 * Zwischenstationen setzen; ein Pfadsegment ist das, was der Betreiber in den
 * Link geschrieben hat. `/p/KUNDE/` wird deshalb abgelehnt und nicht
 * kleingeschrieben. Sonst gäbe es zwei URLs für dieselbe Website — und auf
 * einem case-insensitiven Dateisystem wäre die Faltung ein Weg, an der
 * Zeichenprüfung vorbei denselben Ordner unter einem anderen Namen zu treffen.
 *
 * `path` ist der ROHE `url.pathname`, nicht dekodiert. Das ist wichtig:
 * `%2e%2e` oder `%00` im Slug fallen so an `SLUG_RE` (das Prozentzeichen ist
 * darin nicht enthalten), statt vorher zu etwas anderem zu werden. Dass der
 * WHATWG-Parser Punkt-Segmente ohnehin wegnormalisiert, bevor eine echte
 * Anfrage hier ankommt, wird NICHT vorausgesetzt — die Schranke darf nicht an
 * der Normalisierung eines Parsers hängen. Dieselbe Überlegung wie bei der
 * `dirname`-Prüfung in `resolveSite`.
 *
 * Ein Unterordner darf ein Symlink nach außen sein, genau wie im Sammelbetrieb
 * (Betreiber mounten Sites so); zurückgegeben wird dann der AUFGELÖSTE Pfad,
 * damit `pathInsideSite` später gegen dasselbe Ziel prüft. Der Traversal-Schutz
 * sitzt davor und ist lexikalisch.
 */
/**
 * Prüft die Segmente des Restpfades auf das, was Proxy und Editor VERSCHIEDEN
 * lesen könnten — und lehnt ab, statt zu normalisieren.
 *
 * Der Hintergrund ist eine gemessene Kante: **Caddy prüft den normalisierten
 * Pfad, reicht aber den rohen weiter.** Für `/p/kunde-a/%2e%2e/kunde-b/edit`
 * hat der Matcher gegen `/p/kunde-b/edit` entschieden und `kunde-b`
 * freigegeben, während auf der Leitung ein Pfad ankommt, dessen erstes Segment
 * nach `/p/` `kunde-a` lautet.
 *
 * Einig sind beide Seiten trotzdem — aber nicht zufällig: Die WHATWG-URL-Norm
 * zählt `..`, `%2e%2e`, `.%2e` und `%2e.` ausdrücklich als Doppelpunkt-Segment
 * und entfernt sie, und genau dieselbe Regel wendet Caddy an. Deshalb MUSS der
 * Slug aus `new URL(req.url).pathname` kommen und nicht aus der Zeichenkette
 * davor: Beide Auslegungen zitieren an derselben Stelle dieselbe Norm.
 * „Roh" heißt hier **nicht prozent-dekodiert**, nicht „nicht normalisiert".
 *
 * Was der Parser NICHT wegräumt, bleibt gefährlich und wird deshalb hier
 * abgewiesen:
 *   - leere Segmente (`/p/kunde-a//edit`) — der Slug stimmt mit Caddy überein,
 *     der Rest läuft ins Leere. Fail-closed, aber unbemerkt.
 *   - `%2f` — wird später zu einem Schrägstrich und wäre damit eine DRITTE
 *     Lesart desselben Pfades.
 *   - `.`/`..` in jeder Kodierung, falls diese Funktion je ohne URL-Parser
 *     aufgerufen wird. Die Schranke darf nicht an der Normalisierung eines
 *     Parsers hängen — dieselbe Überlegung wie bei der `dirname`-Prüfung.
 *
 * Abweisen und nicht selbst normalisieren: Drei Auslegungen desselben Pfades
 * wären schlimmer als zwei.
 */
function restSauber(rest: string): boolean {
  const segmente = rest.split("/");
  // segmente[0] ist immer "" — `rest` beginnt per Konstruktion mit "/".
  for (let i = 1; i < segmente.length; i++) {
    const segment = segmente[i]!;
    if (segment === "") {
      // Leer ist nur ganz am Ende zulässig: der abschließende Schrägstrich.
      if (i !== segmente.length - 1) return false;
      continue;
    }
    if (/%2f/i.test(segment)) return false;
    let entschluesselt: string;
    try {
      entschluesselt = decodeURIComponent(segment);
    } catch {
      // Kaputte Prozent-Kodierung: hier kein Urteil. Sie ist keine zweite
      // Lesart des Pfades, und wer sie auflösen will, scheitert später ohnehin.
      continue;
    }
    if (entschluesselt === "." || entschluesselt === "..") return false;
  }
  return true;
}

export function resolveStagingPath(sitesRoot: string, path: string): StagingRef | null {
  if (typeof path !== "string" || !path.startsWith(STAGING_PREFIX)) return null;

  const nachPraefix = path.slice(STAGING_PREFIX.length);
  const schnitt = nachPraefix.indexOf("/");
  const slug = schnitt === -1 ? nachPraefix : nachPraefix.slice(0, schnitt);
  // Ohne Schrägstrich ist es dieselbe Website, nicht 404: sonst hinge die
  // Erreichbarkeit einer Preview daran, ob jemand den Link mit oder ohne
  // Schrägstrich weitergibt.
  const rest = schnitt === -1 ? "/" : nachPraefix.slice(schnitt);

  if (slug.length === 0 || slug.length > MAX_SLUG_LEN) return null;
  if (!SLUG_RE.test(slug)) return null;
  if (!restSauber(rest)) return null;

  let root: string;
  try {
    root = realpathSync(resolve(sitesRoot));
  } catch {
    return null;
  }

  const abs = resolve(root, slug);
  // Wie in resolveSite: SLUG_RE schließt "/" und ".." bereits aus, diese
  // Prüfung ist die zweite, von der Textform unabhängige Schranke.
  if (dirname(abs) !== root) return null;

  let real: string;
  try {
    real = realpathSync(abs);
    if (!statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  return { slug, siteDir: real, rest, basis: STAGING_PREFIX + slug };
}

export interface SiteEntry {
  /** Ordnername, so wie er im Sammelverzeichnis steht. */
  name: string;
  /**
   * Der Hostname, unter dem dieser Ordner erreichbar ist — oder null, wenn er
   * es nicht ist. Ein Ordner ist nur unter seinem EIGENEN Namen erreichbar:
   * "www.kunde.de" und "Kunde.DE" normalisieren sich auf etwas anderes und
   * werden von keiner Anfrage je getroffen.
   */
  host: string | null;
  siteDir: string;
}

/**
 * Listet die Unterordner des Sammelverzeichnisses — für die Übersicht beim
 * Start. Nicht für das Routing: dort entscheidet allein `resolveSite`, damit
 * eine Liste nicht veralten kann.
 */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function listSites(sitesRoot: string): SiteEntry[] {
  const root = resolve(sitesRoot);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => {
      if (e.isDirectory()) return true;
      if (!e.isSymbolicLink()) return false;
      try {
        return statSync(resolve(root, e.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((e) => ({
      name: e.name,
      host: normalizeHost(e.name) === e.name ? e.name : null,
      // REALER Pfad, wie ihn auch resolveSite liefert. Sonst gälte ein
      // Alias-Symlink als eigener Ordner — und die SecretWache hielte ihn
      // fälschlich für eine Kopie mit geteiltem Geheimnis.
      siteDir: realpathOrSelf(resolve(root, e.name)),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

/**
 * Wacht darüber, dass zwei verschiedene Site-Ordner nicht dasselbe
 * Sitzungs-Geheimnis führen.
 *
 * Der Betriebsfehler, um den es geht: Ein Ordner wird als Vorlage kopiert
 * (`cp -r kunde-a.de kunde-b.de`), und das versteckte `.regoro/` fährt mit.
 * Dann teilen sich zwei Kunden Secret UND hinterlegte Kontaktwege. Stütze 2 der
 * Kundentrennung (Invariante 10) ist damit weg — und zwar doppelt: das Cookie
 * des einen ist beim anderen gültig, und derselbe Kontaktweg öffnet beide Anmeldungen.
 * Ein an den Hostnamen gebundenes Cookie schlösse nur die erste Hälfte; das
 * Passwort käme weiterhin durch. Deshalb wird die Kollision erkannt und der
 * Editor **beider** Seiten abgeschaltet — fail-closed, wie überall sonst auch.
 * Die Websites selbst bleiben online; ein Betriebsfehler darf keine Seite
 * vom Netz nehmen.
 *
 * **Der Befund wird aus dem IST-Zustand abgeleitet, nicht aus der Geschichte.**
 * Eine Wache, die sich gesehene Geheimnisse bloß merkt, hat zwei Löcher: Sie
 * bemerkt zwei gleichzeitig angelegte Duplikate nie, wenn nur eines davon je
 * eine Editor-Anfrage bekommt — und sie heilt nicht, wenn der Betreiber die
 * Kollision behebt, weil der Eintrag im Gedächtnis bleibt. Beides gemessen.
 * Stattdessen wird das Sammelverzeichnis reihum neu durchgesehen.
 *
 * Zugeordnet wird über den ORDNER (realpath), nicht den Hostnamen: zwei Namen,
 * die per Symlink auf dasselbe Verzeichnis zeigen, sind ein legitimer Alias und
 * keine Kollision.
 *
 * Die Durchsicht kostet je Website einen kleinen Dateizugriff und passiert
 * höchstens einmal pro `SECRET_SCAN_TTL_MS`. Diese Deckelung ist nicht
 * Bequemlichkeit, sondern Notwehr: `/edit/login` ist unauthentifiziert, eine
 * Durchsicht pro Anfrage wäre ein Verstärker (eine Anfrage → N Dateizugriffe).
 */
export interface SecretWache {
  /** false = dieser Ordner teilt sein Geheimnis mit einem anderen → kein Editor. */
  istEindeutig(siteDir: string): boolean;
}

/** Höchstens einmal pro Sekunde durchsehen — deckelt Kosten und Verstärkung. */
export const SECRET_SCAN_TTL_MS = 1000;

export function erstelleSecretWache(
  sitesRoot: string,
  ttlMs: number = SECRET_SCAN_TTL_MS,
): SecretWache {
  let kollidierend = new Set<string>();
  let zuletzt = 0;

  function durchsehen(): void {
    const proGeheimnis = new Map<string, Set<string>>();
    for (const eintrag of listSites(sitesRoot)) {
      if (eintrag.host === null) continue; // unter keinem Hostnamen erreichbar
      const auth = loadAuthFile(eintrag.siteDir);
      if (auth === null) continue;
      const id = createHash("sha256").update(auth.secret).digest("hex");
      let ordner = proGeheimnis.get(id);
      if (ordner === undefined) proGeheimnis.set(id, (ordner = new Set()));
      ordner.add(eintrag.siteDir);
    }

    const jetztKollidierend = new Set<string>();
    for (const ordner of proGeheimnis.values()) {
      if (ordner.size < 2) continue;
      for (const dir of ordner) jetztKollidierend.add(dir);
      console.error(
        `[regoro] FEHLER: ${[...ordner].join(" und ")} führen dasselbe Sitzungs-Geheimnis.\n` +
          "  Vermutlich wurde ein Site-Ordner samt .regoro/ kopiert. Damit gilt das Cookie\n" +
          "  des einen Kunden beim anderen, und derselbe Kontaktweg öffnet beide Anmeldungen.\n" +
          "  Der Editor ist für ALLE beteiligten Ordner abgeschaltet, die Websites laufen weiter.\n" +
          "  Beheben: `regoro init --force <ordner>` auf allen bis auf einen (setzt dort ein\n" +
          "  neues Geheimnis) oder den kopierten Ordner entfernen. Wirkt ohne Neustart.",
      );
    }
    for (const dir of kollidierend) {
      if (!jetztKollidierend.has(dir)) {
        console.log(`[regoro] ${dir} führt wieder ein eigenes Geheimnis — Editor ist zurück.`);
      }
    }
    kollidierend = jetztKollidierend;
  }

  durchsehen(); // einmal beim Start: eine Kollision soll sofort im Log stehen
  zuletzt = Date.now();

  return {
    istEindeutig(siteDir: string): boolean {
      const jetzt = Date.now();
      if (jetzt - zuletzt >= ttlMs) {
        zuletzt = jetzt;
        durchsehen();
      }
      return !kollidierend.has(siteDir);
    },
  };
}

/**
 * Baut den HostCtx einer Website — im Sammelbetrieb bei JEDER Anfrage neu.
 * `repoRoot === siteDir` (Versionen pro Site, sitePrefix leer), genau wie
 * `regoro run <siteDir>`.
 *
 * `auth` und `pageWhitelist` werden VERZÖGERT gelesen und dann gemerkt:
 *   - Der öffentliche Zweig liefert auch Assets aus; eine Seite mit dreißig
 *     Bildern soll keine dreißig zusätzlichen readdir/read auslösen.
 *   - Die Lazyness ändert nichts an der Semantik: der Wert entsteht innerhalb
 *     derselben Anfrage. Dass `auth` pro Anfrage frisch gelesen wird, IST der
 *     Kill-Switch — `regoro disable` wirkt dadurch sofort (siehe server.ts).
 *
 * `ki` folgt demselben Muster und aus demselben Grund: Weil der Ctx pro
 * Anfrage entsteht, wirkt `regoro ki --off` ohne Neustart. Betreiberweit
 * gelesen, nicht aus dem Kundenordner — ein Modellzugang bedient alle Kunden.
 */
export interface CtxOptionen {
  wache?: SecretWache;
  versand?: Versand | null;
  /** URL-Präfix dieser Website (siehe `HostCtx.basis`). Ohne Angabe: `""`. */
  basis?: string;
  /** Staging-Betrieb. Ohne Angabe: `false` — der Produktionsfall. */
  staging?: boolean;
  /**
   * Ersetzt die aus dem Ordner gelesene Auth-Konfiguration.
   *
   * **Nur der Staging-Aussteller in `server.ts` setzt das.** Eine Preview hat
   * in aller Regel gar keine `auth.json` (es gibt noch keinen Kunden, also auch
   * keine hinterlegte Kennung), und ohne eine Auth-Konfiguration wäre der
   * Editor dort fail-closed aus. Der Staging-Handler reicht deshalb ein
   * flüchtiges, prozesseigenes Geheimnis herein.
   *
   * Im Produktionsbetrieb bleibt das Feld unbesetzt, und es gibt dort keinen
   * Aufrufer, der es besetzen könnte — dieselbe Bauweise wie bei `staging`
   * selbst (Contract C12).
   */
  ersatzAuth?: AuthConfig | null;
}

export function buildCtx(site: SiteRef, opts: CtxOptionen = {}): HostCtx {
  const { wache, versand, basis = "", staging = false, ersatzAuth } = opts;
  const entwurfDir = entwurfPfad(site.siteDir);
  let pages: string[] | undefined;
  let auth: AuthConfig | null | undefined;
  let ki: KiConfig | null | undefined;
  return {
    // Die Historie lebt im Entwurfs-Repo, nicht mehr im Site-Ordner
    // (Invariante 9). Der Site-Ordner ist der ausgelieferte Abzug.
    repoRoot: entwurfDir,
    entwurfDir,
    schwebendDir: schwebendPfad(site.siteDir),
    siteDir: site.siteDir,
    basis,
    staging,
    sitePrefix: "",
    versand: versand ?? null,
    get pageWhitelist(): string[] {
      // Aus dem ENTWURF, nicht aus dem Site-Ordner: Der Editor bearbeitet den
      // Entwurf, und eine dort neu angelegte Seite muss in seiner Liste stehen,
      // bevor sie je veröffentlicht wurde.
      return (pages ??= discoverPages(entwurfDir));
    },
    get auth() {
      if (auth === undefined) {
        if (ersatzAuth !== undefined) {
          auth = ersatzAuth;
        } else {
          const geladen = loadAuthFile(site.siteDir);
          // Geteiltes Geheimnis = kein Editor (siehe SecretWache).
          auth =
            geladen !== null && wache !== undefined && !wache.istEindeutig(site.siteDir)
              ? null
              : geladen;
        }
      }
      return auth;
    },
    get ki(): KiConfig | null {
      // Gemerkt für die Dauer DIESER Anfrage: Der Edit-View liest ihn einmal,
      // die Agenten-Routen mehrfach. Über die Anfrage hinaus wird nichts
      // gemerkt — sonst wirkte `regoro ki --off` erst nach einem Neustart.
      return (ki ??= loadKiConfig());
    },
  };
}
