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
import { loadAuthFile } from "./auth.ts";
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
 */
export function buildCtx(site: SiteRef, wache?: SecretWache, versand?: Versand | null): HostCtx {
  let pages: string[] | undefined;
  let auth: ReturnType<typeof loadAuthFile> | undefined;
  return {
    repoRoot: site.siteDir,
    siteDir: site.siteDir,
    sitePrefix: "",
    versand: versand ?? null,
    get pageWhitelist(): string[] {
      return (pages ??= discoverPages(site.siteDir));
    },
    get auth() {
      if (auth === undefined) {
        const geladen = loadAuthFile(site.siteDir);
        // Geteiltes Geheimnis = kein Editor (siehe SecretWache).
        auth =
          geladen !== null && wache !== undefined && !wache.istEindeutig(site.siteDir)
            ? null
            : geladen;
      }
      return auth;
    },
  };
}
