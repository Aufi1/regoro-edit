/**
 * Benannte fremde APIs je Website — `<siteDir>/.regoro/integrationen.json`.
 *
 * Hier stehen Schlüssel, die dem **Kunden** gehören (sein Stripe-Konto, sein
 * Wetterdienst). Bewusst eine andere Datei als der betreiberweite Modellzugang
 * in `betreiber-config.ts`: zwei Eigentümer, zwei Lebensdauern, zwei Anzeigen.
 * In einer gemeinsamen Datei gäbe die eine Anzeige irgendwann die andere mit aus.
 *
 * Der Agent bekommt aus dieser Datei **nie** einen Schlüssel zu sehen, nur den
 * Namen. Er ruft `call_api({ integration: "stripe", … })`; das Relay löst den
 * Namen auf, prüft Methode und Pfad und hängt die Anmeldung an.
 *
 * Fail-closed wie `loadAuthFile` (auth.ts): kaputte Datei heißt **keine
 * Integrationen**, nie „alles erlauben".
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AUTH_DIR_NAME } from "./auth.ts";

export type IntegrationAuth =
  | { typ: "bearer"; key: string }
  | { typ: "header"; name: string; key: string };

export type Integration = {
  /** Absolute https-URL, ohne Schrägstrich am Ende. */
  baseUrl: string;
  auth: IntegrationAuth;
  /** `["POST /v1/products", "GET /v1/*"]`; null = alles unterhalb von baseUrl. */
  erlaubtePfade: string[] | null;
  /** Normalisierte Origins (`https://js.stripe.com`); [] = keine. */
  browserHerkuenfte: string[];
  /** ISO-8601-Datum, nur für `regoro integration --list`. */
  angelegt: string;
};

export type Integrationen = Map<string, Integration>;

const INTEGRATIONEN_DATEI = "integrationen.json";

/** `<siteDir>/.regoro/integrationen.json` — derselbe Ordner wie auth.json. */
export function integrationenPfad(siteDir: string): string {
  return join(siteDir, AUTH_DIR_NAME, INTEGRATIONEN_DATEI);
}

/**
 * Zulässige Integrationsnamen.
 *
 * Der Name wird im Relay zu EINEM Pfadsegment (`/api/<name>/<rest>`). Ein "/"
 * darin verschöbe die Grenze zwischen Name und Rest-Pfad — der Agent könnte
 * eine Integration adressieren, die niemand freigeschaltet hat. Der erzwungene
 * erste Buchstabe schließt zugleich `..` und versteckte Namen aus.
 */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Macht aus einer rohen Angabe eine vergleichbare Herkunft (`schema://host[:port]`),
 * oder null.
 *
 * Wird an ZWEI Stellen gebraucht und deshalb exportiert: hier beim Laden, und im
 * Validator, der das neue Markup exakt gegen diese Liste vergleicht. Zwei Kopien
 * dieser Funktion wären genau die Lücke — was der Lader durchlässt und der
 * Validator anders normalisiert, wird zur stillen Freigabe.
 */
export function normalisiereHerkunft(roh: unknown): string | null {
  if (typeof roh !== "string") return null;
  const wert = roh.trim();
  if (wert === "") return null;
  // Steuerzeichen und Leerraum INNERHALB der Herkunft werden verworfen, nicht
  // weggeputzt: `https://js.stripe.com\n.angreifer.de` würde beim Säubern zu
  // einer GÜLTIGEN FREMDEN HERKUNFT, die anschließend in der CSP des Kunden
  // steht — der Reinigungsschritt hätte den Angriff also erst erzeugt.
  // Umschließender Leerraum ist dagegen ein harmloser Tippfehler und wird oben
  // getrimmt.
  //
  // Im Validator gilt bewusst die umgekehrte Regel: dort wird gesäubert und
  // dann verglichen, weil der Text die zu prüfende Behauptung ist und nicht
  // die Allowlist — geurteilt wird über das, was der Browser wirklich lädt.
  if (/[\x00-\x20]/.test(wert)) return null;
  let url: URL;
  try {
    url = new URL(wert);
  } catch {
    // Kein absoluter URL: "js.stripe.com", "/assets", "//js.stripe.com".
    // Protokollrelativ ist ausdrücklich KEINE Herkunft — welches Schema
    // gemeint ist, entschiede die aufrufende Seite.
    return null;
  }
  // Nur https. Über http ginge der Schlüssel des Kunden mitlesbar raus, und
  // javascript:/data:/file: sind überhaupt keine Herkünfte.
  if (url.protocol !== "https:") return null;
  // .origin ist genau schema://host[:port] — Pfad, Query und Fragment fallen
  // weg, der Standardport ebenso. Bliebe der Pfad stehen, verglichen wir später
  // Origin gegen URL und ließen alles oder nichts durch.
  return url.origin;
}

/**
 * baseUrl: absolute https-URL ohne Schrägstrich am Ende.
 *
 * Der Rest-Pfad wird im Relay **wörtlich** angehängt (Contract §4, keine
 * /v1-Sonderlogik). Bliebe der Schrägstrich stehen, entstünde `…/v1//products`.
 */
function pruefeBaseUrl(roh: unknown): string | null {
  if (typeof roh !== "string") return null;
  const wert = roh.trim();
  if (wert === "" || /[\x00-\x20]/.test(wert)) return null;
  let url: URL;
  try {
    url = new URL(wert);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // Query und Fragment fallen weg — sie hätten am Ziel keine Bedeutung mehr,
  // sobald der Rest-Pfad angehängt ist.
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

function pruefeAuth(roh: unknown): IntegrationAuth | null {
  if (typeof roh !== "object" || roh === null) return null;
  const o = roh as Record<string, unknown>;
  if (o.typ === "bearer") {
    if (typeof o.key !== "string" || o.key === "") return null;
    return { typ: "bearer", key: o.key };
  }
  if (o.typ === "header") {
    if (typeof o.name !== "string" || o.name === "") return null;
    if (typeof o.key !== "string" || o.key === "") return null;
    return { typ: "header", name: o.name, key: o.key };
  }
  // Unbekannter Typ heißt „keine Anmeldung", und ohne Anmeldung ist der
  // Eintrag nicht nur nutzlos, sondern ein Weg an der Absicht vorbei.
  return null;
}

/** `"kaputt"` verwirft den ganzen Eintrag, `null` heißt „alles unterhalb baseUrl". */
function pruefeErlaubtePfade(roh: unknown): string[] | null | "kaputt" {
  if (roh === undefined || roh === null) return null;
  if (!Array.isArray(roh)) return "kaputt";
  if (!roh.every((e) => typeof e === "string" && e !== "")) return "kaputt";
  return roh as string[];
}

function pruefeHerkuenfte(roh: unknown): string[] {
  // Fehlend ODER keine Liste heißt „keine Herkünfte" — nie „alle".
  if (!Array.isArray(roh)) return [];
  const raus: string[] = [];
  for (const eintrag of roh) {
    const herkunft = normalisiereHerkunft(eintrag);
    if (herkunft !== null && !raus.includes(herkunft)) raus.push(herkunft);
  }
  return raus;
}

function pruefeIntegration(roh: unknown): Integration | null {
  if (typeof roh !== "object" || roh === null || Array.isArray(roh)) return null;
  const o = roh as Record<string, unknown>;

  const baseUrl = pruefeBaseUrl(o.baseUrl);
  if (baseUrl === null) return null;

  const auth = pruefeAuth(o.auth);
  if (auth === null) return null;

  const erlaubtePfade = pruefeErlaubtePfade(o.erlaubtePfade);
  // Eine halb übernommene Pfadliste wäre die gefährliche Auslegung: aus einer
  // kaputten Liste darf nie „alles erlaubt" werden. Also den Eintrag verwerfen.
  if (erlaubtePfade === "kaputt") return null;

  return {
    baseUrl,
    auth,
    erlaubtePfade,
    browserHerkuenfte: pruefeHerkuenfte(o.browserHerkuenfte),
    angelegt: typeof o.angelegt === "string" ? o.angelegt : "",
  };
}

/**
 * Liest die Integrationen einer Website. Jeder Fehler ergibt eine **leere Map**,
 * nie null — der Aufrufer soll nicht zwischen „keine Datei" und „kaputte Datei"
 * unterscheiden müssen, beides heißt „diese Website hat keine Integrationen".
 *
 * Einzelne kaputte Einträge fliegen einzeln raus, damit ein Tippfehler bei einem
 * Dienst nicht die übrigen mitnimmt.
 */
export function loadIntegrationen(siteDir: string): Integrationen {
  let roh: string;
  try {
    roh = readFileSync(integrationenPfad(siteDir), "utf8");
  } catch {
    return new Map();
  }
  let daten: unknown;
  try {
    daten = JSON.parse(roh);
  } catch {
    return new Map();
  }
  if (typeof daten !== "object" || daten === null || Array.isArray(daten)) return new Map();
  const obj = daten as Record<string, unknown>;
  // Version wie bei auth.json: nicht migrieren, ablehnen. Eine stillschweigend
  // weiterbetriebene Altfassung wäre eine Freigabe nach unbekannten Regeln.
  if (obj.v !== 1) return new Map();

  const eintraege = obj.integrationen;
  if (typeof eintraege !== "object" || eintraege === null || Array.isArray(eintraege)) {
    return new Map();
  }

  const raus: Integrationen = new Map();
  for (const [name, wert] of Object.entries(eintraege as Record<string, unknown>)) {
    if (!NAME_RE.test(name)) continue;
    const integration = pruefeIntegration(wert);
    if (integration !== null) raus.set(name, integration);
  }
  return raus;
}

/**
 * Schreibt die Integrationen einer Website. Verzeichnis 0700, Datei 0600 —
 * dieselben Rechte wie auth.json, denn hier stehen Schlüssel des Kunden.
 */
export function schreibeIntegrationen(siteDir: string, integrationen: Integrationen): void {
  const dir = join(siteDir, AUTH_DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Sortiert schreiben, damit zwei Läufe mit demselben Inhalt dieselbe Datei
  // ergeben — sonst rauscht jede Änderung durch `git diff` des Betreibers.
  const sortiert: Record<string, Integration> = {};
  for (const [name, eintrag] of [...integrationen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    sortiert[name] = eintrag;
  }

  writeFileSync(integrationenPfad(siteDir), JSON.stringify({ v: 1, integrationen: sortiert }, null, 2), {
    mode: 0o600,
  });
}

/**
 * Alle Browser-Herkünfte aller Integrationen einer Website, dedupliziert und
 * sortiert.
 *
 * Geht in die CSP des Caddy-Blocks. Die feste Sortierung ist kein Schönheits-
 * wunsch: Ohne sie sähe der erzeugte Block bei jedem Aufruf anders aus, und der
 * Betreiber könnte nicht erkennen, ob sich wirklich etwas geändert hat.
 */
export function alleBrowserHerkuenfte(integrationen: Integrationen): string[] {
  const menge = new Set<string>();
  for (const eintrag of integrationen.values()) {
    for (const herkunft of eintrag.browserHerkuenfte) menge.add(herkunft);
  }
  return [...menge].sort();
}
