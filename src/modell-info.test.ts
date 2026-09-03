/**
 * `modell-info.ts` — Kontextfenster und Ausgabedeckel beim Anbieter erfragen.
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
  GEWUENSCHTE_MAX_TOKENS,
  STANDARD_CONTEXT_WINDOW,
  ermittleModellGrenzen,
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
    expect((await ermittleModellGrenzen(ki(anbieter(OPENROUTER)))).contextWindow).toBe(1_048_576);
  });

  test("ohne top_provider zählt context_length", async () => {
    leereModellCache();
    const url = anbieter({ data: [{ id: "irgendein/modell", context_length: 262_144 }] });
    expect((await ermittleModellGrenzen(ki(url, "irgendein/modell"))).contextWindow).toBe(262_144);
  });

  test("vLLM meldet es als max_model_len", async () => {
    leereModellCache();
    const url = anbieter({ data: [{ id: "lokal/llama", max_model_len: 32_768 }] });
    expect((await ermittleModellGrenzen(ki(url, "lokal/llama"))).contextWindow).toBe(32_768);
  });

  test("das RICHTIGE Modell aus der Liste, nicht das erste", async () => {
    leereModellCache();
    expect((await ermittleModellGrenzen(ki(anbieter(OPENROUTER), "anthropic/claude-sonnet-5"))).contextWindow).toBe(200_000);
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
      expect((await ermittleModellGrenzen(ki(mach(), modell))).contextWindow).toBe(STANDARD_CONTEXT_WINDOW);
    });
  }

  test("ein hängender Anbieter blockiert den Start nicht ewig", async () => {
    // Die Abfrage sitzt im Startpfad eines Laufs, den ein Mensch abwartet.
    leereModellCache();
    const url = anbieter(OPENROUTER, { verzoegerungMs: 15_000 });
    const begonnen = Date.now();
    expect((await ermittleModellGrenzen(ki(url))).contextWindow).toBe(STANDARD_CONTEXT_WINDOW);
    expect(Date.now() - begonnen).toBeLessThan(9_000);
  }, 20_000);
});

describe("der Ausgabedeckel", () => {
  test("unser Wunsch, gedeckelt durch den Anbieter", async () => {
    // OpenRouter meldet für dieses Modell 131.072 — weniger als unsere 150.000,
    // also gewinnt der Anbieter. Ein strenger Server lehnt einen zu großen Wert
    // ab; OpenRouter klemmt ihn still, gemessen. Wir verlassen uns auf keines
    // von beiden.
    leereModellCache();
    const g = await ermittleModellGrenzen(ki(anbieter(OPENROUTER)));
    expect(g.maxTokens).toBe(131_072);
    expect(g.maxTokens).toBeLessThan(GEWUENSCHTE_MAX_TOKENS);
  });

  test("erlaubt der Anbieter mehr, gewinnt unser Wunsch", async () => {
    // Der Deckel soll das Modell nicht formen, aber einen Ausreißer begrenzen:
    // Eine einzelne Antwort darf nicht das halbe Monatskontingent verbrauchen.
    leereModellCache();
    const url = anbieter({
      data: [{ id: "gross/modell", context_length: 2_000_000, top_provider: { max_completion_tokens: 900_000 } }],
    });
    const g = await ermittleModellGrenzen(ki(url, "gross/modell"));
    expect(g.maxTokens).toBe(GEWUENSCHTE_MAX_TOKENS);
  });

  test("ohne Angabe des Anbieters deckelt das Kontextfenster", async () => {
    // Die einzige Schranke, die sich aus dem Modell selbst ergibt: Eine Antwort
    // kann nie größer sein als das, was hineinpasst.
    leereModellCache();
    const url = anbieter({ data: [{ id: "knapp/modell", max_model_len: 32_768 }] });
    const g = await ermittleModellGrenzen(ki(url, "knapp/modell"));
    expect(g.contextWindow).toBe(32_768);
    expect(g.maxTokens).toBe(32_768);
  });

  test("ein kleiner Ausgabedeckel ist kein kaputter Wert", async () => {
    // Für das Kontextfenster gilt eine Untergrenze (darunter ist die Angabe
    // kaputt) — für die Ausgabe nicht: 4.096 sind ein kleines Modell, kein
    // Fehler. Beides durch dieselbe Prüfung zu schicken, verwürfe den Wert.
    leereModellCache();
    const url = anbieter({
      data: [{ id: "klein/modell", context_length: 128_000, max_completion_tokens: 4_096 }],
    });
    expect((await ermittleModellGrenzen(ki(url, "klein/modell"))).maxTokens).toBe(4_096);
  });

  test("ohne jede Auskunft gilt der Vorgabewert für beides", async () => {
    leereModellCache();
    const g = await ermittleModellGrenzen(ki("http://127.0.0.1:1/v1"));
    expect(g.contextWindow).toBe(STANDARD_CONTEXT_WINDOW);
    expect(g.maxTokens).toBe(STANDARD_CONTEXT_WINDOW);
  });
});

describe("gefragt wird selten", () => {
  test("die zweite Abfrage kommt aus dem Zwischenspeicher", async () => {
    leereModellCache();
    const zaehler = { n: 0 };
    const k = ki(anbieter(OPENROUTER, { zaehler }));
    expect((await ermittleModellGrenzen(k)).contextWindow).toBe(1_048_576);
    expect((await ermittleModellGrenzen(k)).contextWindow).toBe(1_048_576);
    expect(zaehler.n).toBe(1);
  });

  test("Gegenprobe: nach Ablauf der Frist wird neu gefragt", async () => {
    // Ohne sie wäre der Test darüber auch dann grün, wenn NIE wieder gefragt
    // würde — ein Modellwechsel beim Anbieter käme dann nie an.
    leereModellCache();
    const zaehler = { n: 0 };
    const k = ki(anbieter(OPENROUTER, { zaehler }));
    await ermittleModellGrenzen(k);
    await ermittleModellGrenzen(k, Date.now() + CACHE_TTL_MS + 1);
    expect(zaehler.n).toBe(2);
  });

  test("auch ein Rückfall wird gemerkt — sonst wartet jeder Lauf ins Zeitlimit", async () => {
    leereModellCache();
    const zaehler = { n: 0 };
    const k = ki(anbieter({}, { status: 404, zaehler }));
    expect((await ermittleModellGrenzen(k)).contextWindow).toBe(STANDARD_CONTEXT_WINDOW);
    expect((await ermittleModellGrenzen(k)).contextWindow).toBe(STANDARD_CONTEXT_WINDOW);
    expect(zaehler.n).toBe(1);
  });

  test("verschiedene Modelle am selben Anbieter werden getrennt gemerkt", async () => {
    leereModellCache();
    const url = anbieter(OPENROUTER);
    expect((await ermittleModellGrenzen(ki(url, "z-ai/glm-5.3-flash"))).contextWindow).toBe(1_048_576);
    expect((await ermittleModellGrenzen(ki(url, "anthropic/claude-sonnet-5"))).contextWindow).toBe(200_000);
  });
});
