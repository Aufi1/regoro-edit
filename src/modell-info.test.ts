/**
 * `modell-info.ts` — das Kontextfenster beim Anbieter erfragen.
 *
 * KEIN TEST DIESER DATEI GEHT INS NETZ. Der „Anbieter" ist ein lokaler Server,
 * der genau die Formen ausliefert, die draußen vorkommen — die Antwortform von
 * OpenRouter ist dabei aus einer ECHTEN Abfrage abgeschrieben (424 Modelle,
 * `z-ai/glm-5.3-flash`: context_length 1.310.720, top_provider 1.048.576), nicht
 * erfunden.
 *
 * Was hier festgenagelt wird, ist vor allem das Verhalten im Fehlerfall: Diese
 * Abfrage sitzt im Startpfad eines Laufs, den ein Mensch abwartet. Sie darf
 * niemals einen Auftrag verhindern.
 */
import { afterAll, describe, expect, test } from "bun:test";

import type { KiConfig } from "./betreiber-config.ts";
import {
  CACHE_TTL_MS,
  STANDARD_CONTEXT_WINDOW,
  ermittleContextWindow,
  leereModellCache,
} from "./modell-info.ts";

const server: { stop(): void }[] = [];
afterAll(() => {
  for (const s of server) s.stop();
});

/** Ein Anbieter, der `antwort` unter `/models` ausliefert. Liefert seine baseUrl. */
function anbieter(
  antwort: unknown,
  opts: { status?: number; verzoegerungMs?: number; zaehler?: { n: number } } = {},
): string {
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/models")) return new Response("nein", { status: 404 });
      if (opts.zaehler) opts.zaehler.n++;
      if (opts.verzoegerungMs) await Bun.sleep(opts.verzoegerungMs);
      if (opts.status && opts.status !== 200) return new Response("kaputt", { status: opts.status });
      return typeof antwort === "string"
        ? new Response(antwort, { headers: { "Content-Type": "application/json" } })
        : Response.json(antwort);
    },
  });
  server.push(s);
  return `http://127.0.0.1:${s.port}/v1`;
}

function ki(baseUrl: string, model = "z-ai/glm-5.3-flash"): KiConfig {
  return {
    apiKey: "sk-attrappe-nie-benutzt-000000",
    keyFromProxy: false,
    braveKey: null,
    firecrawlKey: null,
    baseUrl,
    model,
  };
}

/** Die Form, die OpenRouter wirklich liefert — aus einer echten Abfrage. */
const OPENROUTER = {
  data: [
    { id: "anthropic/claude-sonnet-5", context_length: 200_000, top_provider: { context_length: 200_000 } },
    {
      id: "z-ai/glm-5.3-flash",
      context_length: 1_310_720,
      top_provider: { context_length: 1_048_576, max_completion_tokens: 131_072 },
    },
  ],
};

describe("das Kontextfenster kommt vom Anbieter", () => {
  test("OpenRouter: der Wert des bedienenden Anbieters gewinnt", async () => {
    // 1.048.576 (top_provider), NICHT 1.310.720 (theoretisches Maximum). Die
    // größere Zahl anzunehmen hieße, Anfragen zu bauen, die abgelehnt werden.
    leereModellCache();
    expect(await ermittleContextWindow(ki(anbieter(OPENROUTER)))).toBe(1_048_576);
  });

  test("ohne top_provider zählt context_length", async () => {
    leereModellCache();
    const url = anbieter({ data: [{ id: "irgendein/modell", context_length: 262_144 }] });
    expect(await ermittleContextWindow(ki(url, "irgendein/modell"))).toBe(262_144);
  });

  test("vLLM meldet es als max_model_len", async () => {
    leereModellCache();
    const url = anbieter({ data: [{ id: "lokal/llama", max_model_len: 32_768 }] });
    expect(await ermittleContextWindow(ki(url, "lokal/llama"))).toBe(32_768);
  });

  test("das RICHTIGE Modell aus der Liste, nicht das erste", async () => {
    leereModellCache();
    expect(await ermittleContextWindow(ki(anbieter(OPENROUTER), "anthropic/claude-sonnet-5"))).toBe(200_000);
  });
});

describe("im Zweifel der Vorgabewert — ein Lauf scheitert hieran nie", () => {
  const faelle: [string, () => string][] = [
    ["das Modell steht nicht in der Liste", () => anbieter(OPENROUTER)],
    ["der Anbieter kennt /models nicht", () => anbieter({}, { status: 404 })],
    ["der Anbieter antwortet mit 500", () => anbieter({}, { status: 500 })],
    ["die Antwort ist kein JSON", () => anbieter("<html>kaputt</html>")],
    ["`data` ist keine Liste", () => anbieter({ data: { id: "x" } })],
    ["OpenAI liefert das Feld gar nicht", () => anbieter({ data: [{ id: "gpt-9" }] })],
    ["der Wert ist unsinnig klein", () => anbieter({ data: [{ id: "m", context_length: 12 }] })],
    ["der Wert ist unsinnig groß", () => anbieter({ data: [{ id: "m", context_length: 9e12 }] })],
    ["der Wert ist gar keine Zahl", () => anbieter({ data: [{ id: "m", context_length: "viel" }] })],
    ["den Anbieter gibt es nicht", () => "http://127.0.0.1:1/v1"],
  ];

  for (const [name, mach] of faelle) {
    test(name, async () => {
      leereModellCache();
      const modell = name.includes("nicht in der Liste") ? "gibt-es/nicht" : "m";
      expect(await ermittleContextWindow(ki(mach(), modell))).toBe(STANDARD_CONTEXT_WINDOW);
    });
  }

  test("ein hängender Anbieter blockiert den Start nicht ewig", async () => {
    // Die Abfrage sitzt im Startpfad eines Laufs, den ein Mensch abwartet.
    leereModellCache();
    const url = anbieter(OPENROUTER, { verzoegerungMs: 15_000 });
    const begonnen = Date.now();
    expect(await ermittleContextWindow(ki(url))).toBe(STANDARD_CONTEXT_WINDOW);
    expect(Date.now() - begonnen).toBeLessThan(9_000);
  }, 20_000);
});

describe("gefragt wird selten", () => {
  test("die zweite Abfrage kommt aus dem Zwischenspeicher", async () => {
    leereModellCache();
    const zaehler = { n: 0 };
    const k = ki(anbieter(OPENROUTER, { zaehler }));
    expect(await ermittleContextWindow(k)).toBe(1_048_576);
    expect(await ermittleContextWindow(k)).toBe(1_048_576);
    expect(zaehler.n).toBe(1);
  });

  test("Gegenprobe: nach Ablauf der Frist wird neu gefragt", async () => {
    // Ohne sie wäre der Test darüber auch dann grün, wenn NIE wieder gefragt
    // würde — ein Modellwechsel beim Anbieter käme dann nie an.
    leereModellCache();
    const zaehler = { n: 0 };
    const k = ki(anbieter(OPENROUTER, { zaehler }));
    await ermittleContextWindow(k);
    await ermittleContextWindow(k, Date.now() + CACHE_TTL_MS + 1);
    expect(zaehler.n).toBe(2);
  });

  test("auch ein Rückfall wird gemerkt — sonst wartet jeder Lauf ins Zeitlimit", async () => {
    leereModellCache();
    const zaehler = { n: 0 };
    const k = ki(anbieter({}, { status: 404, zaehler }));
    expect(await ermittleContextWindow(k)).toBe(STANDARD_CONTEXT_WINDOW);
    expect(await ermittleContextWindow(k)).toBe(STANDARD_CONTEXT_WINDOW);
    expect(zaehler.n).toBe(1);
  });

  test("verschiedene Modelle am selben Anbieter werden getrennt gemerkt", async () => {
    leereModellCache();
    const url = anbieter(OPENROUTER);
    expect(await ermittleContextWindow(ki(url, "z-ai/glm-5.3-flash"))).toBe(1_048_576);
    expect(await ermittleContextWindow(ki(url, "anthropic/claude-sonnet-5"))).toBe(200_000);
  });
});
