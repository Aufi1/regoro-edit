/**
 * Der betreiberweite Modellzugang — `/etc/regoro/ki.json`.
 *
 * Diese Datei gehört **uns**, nicht dem Kunden: ein Zugang bedient alle
 * Websites, so wie `/etc/regoro/versand.json` einen Absender für alle stellt.
 * Sie liegt deshalb außerhalb jedes Site-Ordners — in einem Kundenordner wäre
 * sie für den Kunden lesbar und läge im Zugriff eines Agentenlaufs.
 *
 * Fail-closed nach dem Vorbild von `loadAuthFile` (auth.ts): fehlende, kaputte
 * oder veraltete Datei heißt „KI aus" (`ctx.ki == null` → alle `/edit/agent*`
 * antworten 404 und die Seitenleiste erscheint gar nicht erst im DOM), niemals
 * „KI ohne Schutz".
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export const STANDARD_BASE_URL = "https://openrouter.ai/api/v1";
export const STANDARD_MODELL = "z-ai/glm-5.3-flash";

/** In Produktion liegt die Datei hier, root gehörend, Mode 0600. */
export const KI_CONFIG_PFAD = "/etc/regoro/ki.json";

/**
 * Mindestlänge eines echten Modellschlüssels.
 *
 * Zweck ist nicht Kryptografie, sondern einen Tippfehler von einem Schlüssel zu
 * unterscheiden: Ein leeres oder abgeschnittenes Feld soll ein sauberes „KI ist
 * aus" ergeben statt eines rätselhaften 401 mitten im ersten Kundenlauf.
 * Ausgenommen ist der ausdrücklich erklärte Proxy-Betrieb (`keyFromProxy`).
 */
export const MIN_API_KEY_LEN = 20;

/**
 * Was ein Schlüsselfeld bedeutet — für ALLE Felder dieser Datei gleich:
 *
 *   fehlt / falscher Typ  → `null`: Funktion **aus**, fail-closed.
 *   `""`                  → Funktion **an**, der Schlüssel kommt von außen
 *                           (ausgehender Proxy, Agent Vault).
 *   Zeichenkette          → Funktion an, der Schlüssel steht in der Datei.
 *
 * Zwei benachbarte Felder derselben Datei dürfen nicht verschiedene Semantik
 * für denselben leeren String führen — das behält niemand im Kopf, und die
 * Abweichung fällt nicht auf, weil sie nicht scheitert, sondern nur nicht wirkt.
 *
 * `apiKey` ist die eine Ausnahme, und sie ist ausdrücklich gemacht: Dort
 * verlangt `""` zusätzlich das Bekenntnis `keyFromProxy: true`, weil ein
 * fehlender Modellschlüssel den ganzen Zugang betrifft und nicht nur eine
 * Zusatzfunktion.
 */
export type KiConfig = {
  /** "" ist nur zulässig, wenn `keyFromProxy` gesetzt ist. */
  apiKey: string;
  /**
   * true = ein ausgehender Proxy hängt die Anmeldung selbst an; das Relay lässt
   * den `Authorization`-Header dann weg.
   *
   * Muss im Typ stehen, damit `schreibeKiConfig` das Flag zurückschreiben kann.
   * Ohne das Feld legte `regoro ki --key-from-proxy` eine Datei ohne Flag an,
   * der nächste `loadKiConfig` gäbe wegen `apiKey: ""` null zurück — die KI wäre
   * unmittelbar nach dem Einrichten aus, ohne erkennbaren Grund.
   */
  keyFromProxy: boolean;
  /** null = keine Websuche. */
  braveKey: string | null;
  /**
   * Schlüssel für den Seitenabruf (Firecrawl). null = kein Seitenabruf.
   *
   * Eigener Schlüssel neben `braveKey`, weil Suchen und Abrufen zwei Dienste
   * sind: Ohne ihn kann der Agent weiter suchen, nur keine gefundene Seite mehr
   * öffnen — statt dass die ganze Recherche ausfällt.
   */
  firecrawlKey: string | null;
  baseUrl: string;
  model: string;
};

/**
 * Der tatsächlich benutzte Pfad, bei **jedem** Aufruf neu aus der Umgebung
 * gelesen — nicht einmalig beim Import, sonst wirkte ein Wechsel erst nach
 * einem Neustart.
 *
 * Vorrang hat `$CREDENTIALS_DIRECTORY` (systemd `LoadCredential=`): Dort hat
 * systemd die Datei bereits als root gelesen und in ein tmpfs gelegt, das nur
 * dieser Dienst sieht. `/etc/regoro/ki.json` muss für den Dienst-Benutzer dann
 * gar nicht lesbar sein — wer hier `/etc` bevorzugte, machte die Härtung
 * wirkungslos.
 *
 * `REGORO_KI_CONFIG` gibt es nur für lokales Ausprobieren, Vorbild ist
 * `REGORO_VERSAND_CONFIG` in versand.ts.
 */
export function betreiberConfigPfad(): string {
  const credentials = process.env.CREDENTIALS_DIRECTORY;
  if (credentials) return join(credentials, "ki");
  return process.env.REGORO_KI_CONFIG || KI_CONFIG_PFAD;
}

/**
 * Liest und prüft den Modellzugang. Jeder Fehler ergibt `null` — kein File,
 * kaputtes JSON, falsche Version, fehlende Rechte, ein Verzeichnis statt einer
 * Datei.
 *
 * Eine Datei mit falscher Version wird abgelehnt, nicht migriert (wie
 * `pruefeAuthDatei`): Eine stillschweigend weiterbetriebene Altfassung wäre ein
 * Zugang nach unbekannten Regeln.
 */
export function loadKiConfig(pfad: string = betreiberConfigPfad()): KiConfig | null {
  let roh: string;
  try {
    roh = readFileSync(pfad, "utf8");
  } catch {
    return null;
  }
  let daten: unknown;
  try {
    daten = JSON.parse(roh);
  } catch {
    return null;
  }
  if (typeof daten !== "object" || daten === null || Array.isArray(daten)) return null;
  const obj = daten as Record<string, unknown>;
  if (obj.v !== 1) return null;

  if (typeof obj.apiKey !== "string") return null;
  const keyFromProxy = obj.keyFromProxy === true;
  // Ohne ausdrückliches Proxy-Bekenntnis muss ein echter Schlüssel dastehen.
  // So bleibt ein vergessenes Feld ein erkennbares „KI ist aus" statt eines
  // Laufs, der erst beim ersten Modellaufruf mit 401 abbricht — nachdem das
  // Kontingent des Kunden bereits gebucht ist.
  if (!keyFromProxy && obj.apiKey.length < MIN_API_KEY_LEN) return null;

  return {
    apiKey: obj.apiKey,
    keyFromProxy,
    // Ohne Brave-Schlüssel gibt es keine Websuche — der Agent arbeitet dann
    // ohne Recherche weiter, statt dass der ganze Zugang ausfällt.
    //
    // Der leere String bleibt erhalten und wird NICHT zu null: Er heißt
    // „Funktion an, Schlüssel kommt von außen" — auf dieser Maschine setzt ein
    // ausgehender Proxy ihn ein, genau wie bei `apiKey` mit `keyFromProxy`.
    // Ihn wegzunormalisieren hieße: keine Websuche, ohne Fehler, ohne Logzeile,
    // ohne dass irgendetwas rot wird. Es scheitert nicht, es wirkt nur nicht.
    braveKey: typeof obj.braveKey === "string" ? obj.braveKey : null,
    firecrawlKey: typeof obj.firecrawlKey === "string" ? obj.firecrawlKey : null,
    baseUrl: typeof obj.baseUrl === "string" && obj.baseUrl !== "" ? obj.baseUrl : STANDARD_BASE_URL,
    model: typeof obj.model === "string" && obj.model !== "" ? obj.model : STANDARD_MODELL,
  };
}

/**
 * Schreibt den Modellzugang, Mode 0600. Ein fehlendes Verzeichnis wird mit 0700
 * angelegt — dieselben Rechte wie bei `.regoro/`.
 *
 * Überschreibt kommentarlos: `regoro ki` ist der Weg, einen Schlüssel zu
 * ersetzen, und ein Ersatz soll den alten vollständig verdrängen.
 */
export function schreibeKiConfig(cfg: KiConfig, pfad: string = betreiberConfigPfad()): void {
  mkdirSync(dirname(pfad), { recursive: true, mode: 0o700 });
  const payload = {
    v: 1,
    apiKey: cfg.apiKey,
    keyFromProxy: cfg.keyFromProxy,
    braveKey: cfg.braveKey,
    firecrawlKey: cfg.firecrawlKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
  };
  writeFileSync(pfad, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

/** Entfernt den Modellzugang — danach ist die KI aus. Wirft nicht, wenn nichts da ist. */
export function entferneKiConfig(pfad: string = betreiberConfigPfad()): void {
  rmSync(pfad, { force: true });
}
