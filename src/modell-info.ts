/**
 * Wie groß ist das Kontextfenster des eingestellten Modells?
 *
 * WARUM DAS EIN EIGENER SCHRITT IM ELTERNPROZESS IST. Der Arbeiter läuft mit
 * `allowModelNetwork: false` und registriert sein Modell selbst — er darf pi
 * gar nicht beim Anbieter nachfragen lassen, denn er hat kein Netz (Invariante
 * 11). Also stand dort eine feste Zahl.
 *
 * GEMESSEN, was diese feste Zahl kostete: `agent-worker.ts` meldete pi
 * `contextWindow: 128_000`, während OpenRouter für `z-ai/glm-5.3-flash`
 * 1.310.720 ausweist (`top_provider.context_length`: 1.048.576). pi verdichtet
 * bei `contextTokens > contextWindow − reserveTokens`, also ab 111.616 Token —
 * unser größter gemessener Lauf hatte 207.371. Jede Verdichtung ist ein
 * zusätzlicher, abrechenbarer Modellaufruf, und `keepRecentTokens` (20.000)
 * wirft dabei fast das ganze Gespräch weg. Wir haben also mitten in großen
 * Aufträgen Geld ausgegeben, um Gedächtnis wegzuwerfen, das das Modell mühelos
 * hätte halten können.
 *
 * Der Elternprozess darf ins Netz. Er fragt einmal je Modell nach und gibt die
 * Zahl per Umgebungsvariable an den Arbeiter — die Sandbox bleibt unberührt.
 *
 * FAIL-SOFT, AUSNAHMSLOS. Ein Anbieter ohne `/models`, eine kaputte Antwort,
 * ein Zeitlimit: Es gilt wieder der Vorgabewert, der Lauf startet. Diese
 * Abfrage darf einen Auftrag niemals verhindern — sie stellt eine Stellschraube
 * besser ein, sie ist keine Voraussetzung.
 */
import type { KiConfig } from "./betreiber-config.ts";

/**
 * Der Rückfallwert — die Zahl, die vorher fest im Arbeiter stand.
 *
 * Bewusst konservativ: Zu klein heißt „verdichtet früher als nötig", zu groß
 * heißt „der Anbieter lehnt die Anfrage ab". Von den beiden Fehlern ist der
 * erste der harmlosere, und ein Rückfall greift genau dann, wenn wir nichts
 * Verlässliches wissen.
 */
export const STANDARD_CONTEXT_WINDOW = 128_000;

/** Unter dieser Grenze ist eine gemeldete Zahl nicht plausibel, sondern kaputt. */
const MIN_PLAUSIBEL = 8_000;
/** Und darüber auch nicht — kein heutiges Modell hat zehn Millionen Token. */
const MAX_PLAUSIBEL = 10_000_000;

/** Wie lange die Antwort gilt. Modelle wechseln ihr Fenster nicht im Minutentakt. */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Zeitlimit der Abfrage.
 *
 * Sie sitzt im Startpfad eines Laufs, den ein Mensch abwartet. Lieber der
 * Vorgabewert als eine Seitenleiste, die zehn Sekunden schweigt.
 */
const ABFRAGE_TIMEOUT_MS = 4_000;

type Eintrag = { wert: number; bis: number };
const cache = new Map<string, Eintrag>();

/** Nur für Tests: den Zwischenspeicher leeren. */
export function leereModellCache(): void {
  cache.clear();
}

/**
 * Das Kontextfenster für `ki.model`, oder der Vorgabewert.
 *
 * Der Schlüssel wird angehängt wie im Relay: nur, wenn einer da ist. Ist
 * `apiKey` leer (`keyFromProxy`), setzt ihn der ausgehende Proxy ein — ein
 * leerer `Bearer`-Header machte den Aufruf stattdessen kaputt.
 */
export async function ermittleContextWindow(
  ki: KiConfig,
  jetzt: number = Date.now(),
): Promise<number> {
  const schluessel = `${ki.baseUrl}\n${ki.model}`;
  const gemerkt = cache.get(schluessel);
  if (gemerkt && gemerkt.bis > jetzt) return gemerkt.wert;

  let wert = STANDARD_CONTEXT_WINDOW;
  try {
    const basis = ki.baseUrl.replace(/\/+$/, "");
    const kopf: Record<string, string> = { accept: "application/json" };
    if (ki.apiKey !== "") kopf.authorization = `Bearer ${ki.apiKey}`;
    const antwort = await fetch(`${basis}/models`, {
      headers: kopf,
      signal: AbortSignal.timeout(ABFRAGE_TIMEOUT_MS),
    });
    if (antwort.ok) {
      const gefunden = ausAntwort(await antwort.json(), ki.model);
      if (gefunden !== null) wert = gefunden;
    }
  } catch {
    // Kein Netz, kein `/models`, Zeitlimit, kaputtes JSON — alles derselbe
    // Fall: Wir wissen es nicht, also gilt der Vorgabewert.
  }

  // Auch der Rückfall wird gemerkt. Sonst fragte jeder Lauf eines Anbieters
  // ohne `/models` erneut und wartete jedes Mal das Zeitlimit ab.
  cache.set(schluessel, { wert, bis: jetzt + CACHE_TTL_MS });
  return wert;
}

/**
 * Die Zahl aus einer OpenAI-kompatiblen `/models`-Antwort fischen.
 *
 * VIER FELDNAMEN, weil „OpenAI-kompatibel" für dieses Feld nichts festlegt:
 * OpenRouter führt `context_length` **und** `top_provider.context_length`,
 * vLLM meldet `max_model_len`, manche Server `context_window`. OpenAI selbst
 * liefert gar keines — dort greift der Rückfall.
 *
 * `top_provider.context_length` hat VORRANG vor `context_length`: Das erste ist,
 * was der tatsächlich bedienende Anbieter kann, das zweite das theoretische
 * Maximum des Modells. Bei `glm-5.3-flash` liegen dazwischen 1.310.720 gegen
 * 1.048.576 — die größere Zahl anzunehmen hieße, Anfragen zu bauen, die der
 * Anbieter ablehnt.
 */
function ausAntwort(daten: unknown, modell: string): number | null {
  const liste = (daten as { data?: unknown })?.data;
  if (!Array.isArray(liste)) return null;
  for (const roh of liste) {
    const m = roh as Record<string, unknown>;
    if (m?.id !== modell) continue;
    const tp = m.top_provider as Record<string, unknown> | undefined;
    for (const kandidat of [tp?.context_length, m.context_length, m.max_model_len, m.context_window]) {
      const n = Number(kandidat);
      if (Number.isFinite(n) && n >= MIN_PLAUSIBEL && n <= MAX_PLAUSIBEL) return Math.trunc(n);
    }
    return null; // Modell gefunden, aber ohne brauchbare Angabe.
  }
  return null;
}
