/**
 * relay.ts — der Schlüssel-Riegel.
 *
 * Der Arbeiterprozess besitzt kein Geheimnis. Er ruft eine Loopback-Adresse auf,
 * und erst dort wird der Schlüssel angehängt. Das ist die technische Fassung von
 * Invariante 11: „Der Agentenprozess hält keine Zugangsschlüssel und besitzt
 * kein Werkzeug für beliebige Netzverbindungen."
 *
 * **Kein Test hier spricht mit openrouter.ai oder api.stripe.com.** Alle laufen
 * gegen einen lokalen Attrappen-Endpunkt, dessen Adresse als `baseUrl`
 * hineingereicht wird — dasselbe Muster wie in `versand.test.ts`.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { networkInterfaces } from "node:os";

import { starteRelay, datenschutzZusatz, istOpenRouter, ergaenzeDatenschutz, type Relay } from "./relay.ts";
import type { KiConfig } from "./betreiber-config.ts";
import type { Integration, Integrationen } from "./integrationen.ts";

// ---------------------------------------------------------------------------
// Attrappen-Endpunkt: nimmt alles an, merkt es sich, antwortet wie eingestellt.
// ---------------------------------------------------------------------------

type Empfangen = { pfad: string; suche: string; methode: string; kopf: Record<string, string>; koerper: string };

function attrappenZiel(
  antwort: (e: Empfangen) => { status?: number; body: string | ReadableStream; typ?: string } = () => ({
    body: '{"ok":true}',
  }),
) {
  const empfangen: Empfangen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const e: Empfangen = {
        pfad: url.pathname,
        suche: url.search,
        methode: req.method,
        kopf: Object.fromEntries(req.headers.entries()),
        koerper: await req.text(),
      };
      empfangen.push(e);
      const a = antwort(e);
      return new Response(a.body, {
        status: a.status ?? 200,
        headers: { "content-type": a.typ ?? "application/json" },
      });
    },
  });
  return { empfangen, basis: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const MODELL_SCHLUESSEL = "sk-or-v1-geheim-0123456789abcdef";

function ki(basis: string, over: Partial<KiConfig> = {}): KiConfig {
  return {
    apiKey: MODELL_SCHLUESSEL,
    keyFromProxy: false,
    braveKey: null,
    baseUrl: `${basis}/api/v1`,
    model: "z-ai/glm-5.3-flash",
    ...over,
  };
}

function integration(basis: string, over: Partial<Integration> = {}): Integration {
  return {
    baseUrl: basis,
    auth: { typ: "bearer", key: "rk_live_geheim_9876543210" },
    erlaubtePfade: null,
    browserHerkuenfte: [],
    angelegt: "2026-09-02",
    ...over,
  };
}

/** Alles, was ein Test gestartet hat, wird nach dem Test wieder geschlossen. */
const offen: { stop: () => void }[] = [];

function merke<T extends { stop: () => void }>(x: T): T {
  offen.push(x);
  return x;
}

afterEach(() => {
  while (offen.length) {
    try {
      offen.pop()!.stop();
    } catch {
      /* schon zu */
    }
  }
});

function ruf(r: Relay, pfad: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${r.port}${pfad}`, init);
}

// ===========================================================================
// Modellzugang
// ===========================================================================

describe("relay.ts — /modell reicht an die baseUrl weiter", () => {
  test("der Rest-Pfad wird WÖRTLICH angehängt — keine /v1-Sonderlogik", () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map()));
    return ruf(r, "/modell/chat/completions", { method: "POST", body: "{}" }).then(() => {
      // baseUrl endet auf /api/v1, der Rest ist chat/completions.
      expect(ziel.empfangen[0]!.pfad).toBe("/api/v1/chat/completions");
    });
  });

  test("Methode, Körper und Query kommen unverändert an", async () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map()));
    await ruf(r, "/modell/chat/completions?stream=true", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "z-ai/glm-5.3-flash", messages: [] }),
    });
    const e = ziel.empfangen[0]!;
    expect(e.methode).toBe("POST");
    expect(e.suche).toBe("?stream=true");
    expect(JSON.parse(e.koerper).model).toBe("z-ai/glm-5.3-flash");
  });

  test("der Schlüssel wird erst hier angehängt", async () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map()));
    await ruf(r, "/modell/models");
    expect(ziel.empfangen[0]!.kopf["authorization"]).toBe(`Bearer ${MODELL_SCHLUESSEL}`);
  });

  test("keyFromProxy hängt KEINEN Authorization-Header an", async () => {
    // Auf dieser Maschine setzt der Agent-Vault-Proxy den echten Schlüssel ein.
    // Ein leerer Bearer-Header würde den Aufruf stattdessen kaputtmachen.
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis, { apiKey: "", keyFromProxy: true }), new Map()));
    await ruf(r, "/modell/models");
    expect(ziel.empfangen[0]!.kopf["authorization"]).toBeUndefined();
  });

  test("Statuscode und Körper der Antwort kommen zurück", async () => {
    const ziel = merke(attrappenZiel(() => ({ status: 429, body: '{"error":"rate limited"}' })));
    const r = merke(starteRelay(ki(ziel.basis), new Map()));
    const res = await ruf(r, "/modell/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("rate limited");
  });

  test("ein vom Arbeiter mitgeschickter Authorization-Header überschreibt den echten nicht", async () => {
    // Sonst könnte der Arbeiter den Schlüssel gegen einen eigenen tauschen und
    // das Kostenkonto eines Dritten benutzen — oder den echten erzwingen.
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map()));
    await ruf(r, "/modell/models", { headers: { authorization: "Bearer erfunden" } });
    expect(ziel.empfangen[0]!.kopf["authorization"]).toBe(`Bearer ${MODELL_SCHLUESSEL}`);
  });

  test("bei einem NICHT-OpenRouter-Ziel bleibt der Körper unangetastet", async () => {
    // Das Datenschutz-Routing ist anbieterspezifisch. Ein `provider`-Feld bei
    // einem Anbieter, der es nicht kennt, wäre im besten Fall wirkungslos und im
    // schlechtesten ein 400 mitten im Kundenlauf.
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map()));
    const gesendet = { model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hallo" }] };
    await ruf(r, "/modell/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(gesendet),
    });
    expect(JSON.parse(ziel.empfangen[0]!.koerper)).toEqual(gesendet);
  });

  test("ein Körper, der kein JSON ist, wird unverändert weitergereicht", async () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map()));
    await ruf(r, "/modell/irgendwas", { method: "POST", body: "kein json" });
    expect(ziel.empfangen[0]!.koerper).toBe("kein json");
  });

});

// ===========================================================================
// Benannte Integrationen
// ===========================================================================

describe("relay.ts — /api/<name> löst einen NAMEN auf, nie eine URL", () => {
  test("der Rest-Pfad geht an die baseUrl der Integration", async () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map([["stripe", integration(ziel.basis)]])));
    await ruf(r, "/api/stripe/v1/products", { method: "POST", body: "{}" });
    expect(ziel.empfangen[0]!.pfad).toBe("/v1/products");
  });

  test("bearer-Auth hängt den Kundenschlüssel an", async () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map([["stripe", integration(ziel.basis)]])));
    await ruf(r, "/api/stripe/v1/products", { method: "POST", body: "{}" });
    expect(ziel.empfangen[0]!.kopf["authorization"]).toBe("Bearer rk_live_geheim_9876543210");
  });

  test("header-Auth setzt den benannten Kopf", async () => {
    const ziel = merke(attrappenZiel());
    const i = integration(ziel.basis, { auth: { typ: "header", name: "X-Api-Key", key: "kundenschluessel-123" } });
    const r = merke(starteRelay(ki(ziel.basis), new Map([["wetter", i]])));
    await ruf(r, "/api/wetter/v1/heute");
    expect(ziel.empfangen[0]!.kopf["x-api-key"]).toBe("kundenschluessel-123");
    expect(ziel.empfangen[0]!.kopf["authorization"]).toBeUndefined();
  });

  test("mehrere Integrationen nebeneinander gehen an verschiedene Ziele", async () => {
    const a = merke(attrappenZiel());
    const b = merke(attrappenZiel());
    const r = merke(
      starteRelay(
        ki(a.basis),
        new Map([
          ["stripe", integration(a.basis)],
          ["wetter", integration(b.basis, { auth: { typ: "header", name: "X-Key", key: "w" } })],
        ]),
      ),
    );
    await ruf(r, "/api/stripe/v1/products", { method: "POST", body: "{}" });
    await ruf(r, "/api/wetter/v1/heute");
    expect(a.empfangen.at(-1)!.pfad).toBe("/v1/products");
    expect(b.empfangen.at(-1)!.pfad).toBe("/v1/heute");
  });
});

describe("relay.ts — Fehlerantworten sind deutscher Klartext, damit der Agent versteht was fehlt", () => {
  test("unbekannte Integration → 404 mit Klartext und Liste der verfügbaren", async () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map()));
    const res = await ruf(r, "/api/stripe/v1/products", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("stripe");
    expect(text.toLowerCase()).toContain("verfügbar");
    expect(ziel.empfangen.length).toBe(0);
  });

  test("die Liste nennt die tatsächlich vorhandenen Namen", async () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map([["wetter", integration(ziel.basis)]])));
    const text = await (await ruf(r, "/api/stripe/x")).text();
    expect(text).toContain("wetter");
  });

  test("nicht freigeschalteter Pfad → 404 mit Klartext und der Liste der erlaubten", async () => {
    const ziel = merke(attrappenZiel());
    const i = integration(ziel.basis, { erlaubtePfade: ["POST /v1/products", "GET /v1/*"] });
    const r = merke(starteRelay(ki(ziel.basis), new Map([["stripe", i]])));
    const res = await ruf(r, "/api/stripe/v1/charges", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("/v1/charges");
    expect(text).toContain("POST /v1/products");
    expect(ziel.empfangen.length).toBe(0);
  });

  test("erlaubtePfade unterscheidet die Methode", async () => {
    const ziel = merke(attrappenZiel());
    const i = integration(ziel.basis, { erlaubtePfade: ["GET /v1/*"] });
    const r = merke(starteRelay(ki(ziel.basis), new Map([["stripe", i]])));
    expect((await ruf(r, "/api/stripe/v1/products")).status).toBe(200);
    expect((await ruf(r, "/api/stripe/v1/products", { method: "POST", body: "{}" })).status).toBe(404);
  });

  test("der Stern deckt genau eine Pfadfortsetzung, nicht die ganze API", async () => {
    const ziel = merke(attrappenZiel());
    const i = integration(ziel.basis, { erlaubtePfade: ["GET /v1/*"] });
    const r = merke(starteRelay(ki(ziel.basis), new Map([["stripe", i]])));
    expect((await ruf(r, "/api/stripe/v1/products/prod_1")).status).toBe(200);
    expect((await ruf(r, "/api/stripe/v2/geheim")).status).toBe(404);
  });

  test("erlaubtePfade null heißt alles unterhalb der baseUrl", async () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map([["stripe", integration(ziel.basis)]])));
    expect((await ruf(r, "/api/stripe/v1/irgendwas")).status).toBe(200);
  });

  test("erlaubtePfade [] heißt NICHTS, nicht alles", async () => {
    const ziel = merke(attrappenZiel());
    const i = integration(ziel.basis, { erlaubtePfade: [] });
    const r = merke(starteRelay(ki(ziel.basis), new Map([["stripe", i]])));
    expect((await ruf(r, "/api/stripe/v1/products")).status).toBe(404);
    expect(ziel.empfangen.length).toBe(0);
  });

  test("ein unbekanntes Präfix ist 404, kein offener Weiterleiter", async () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map()));
    for (const pfad of ["/", "/v1/chat/completions", "/http://fremd.de/x", "/api", "/modell"]) {
      expect((await ruf(r, pfad)).status).toBe(404);
    }
    expect(ziel.empfangen.length).toBe(0);
  });

  test("kodierte Punkte im Integrationspfad führen nicht aus der baseUrl heraus", async () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map([["stripe", integration(`${ziel.basis}/v1`)]])));
    const res = await ruf(r, "/api/stripe/%2e%2e/%2e%2e/geheim");
    // Entweder abgelehnt oder unterhalb der baseUrl gelandet — nie darüber.
    if (res.status === 200) expect(ziel.empfangen.at(-1)!.pfad.startsWith("/v1/")).toBe(true);
    else expect(res.status).toBe(404);
  });
});

// ===========================================================================
// Der Schlüssel darf nirgends zurückkommen
// ===========================================================================

describe("relay.ts — kein Schlüssel fließt zum Agenten zurück", () => {
  test("eine Fehlermeldung, die den Authorization-Header echot, wird entschärft", async () => {
    // Manche APIs spiegeln die Anfrage-Header in ihre Fehlermeldung. Der Agent
    // liest diese Antwort — und hätte damit den Schlüssel, den ihm die ganze
    // Bauart vorenthalten soll.
    const ziel = merke(
      attrappenZiel((e) => ({
        status: 401,
        body: JSON.stringify({ error: "bad key", received: e.kopf["authorization"] }),
      })),
    );
    const r = merke(starteRelay(ki(ziel.basis), new Map()));
    const text = await (await ruf(r, "/modell/models")).text();
    expect(text).not.toContain(MODELL_SCHLUESSEL);
  });

  test("dasselbe für einen Integrationsschlüssel", async () => {
    const ziel = merke(
      attrappenZiel((e) => ({ status: 400, body: `key war: ${e.kopf["authorization"]}`, typ: "text/plain" })),
    );
    const r = merke(starteRelay(ki(ziel.basis), new Map([["stripe", integration(ziel.basis)]])));
    const text = await (await ruf(r, "/api/stripe/v1/products", { method: "POST", body: "{}" })).text();
    expect(text).not.toContain("rk_live_geheim_9876543210");
  });

  test("die Fehlerantworten des Relays selbst nennen keinen Schlüssel", async () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map([["stripe", integration(ziel.basis)]])));
    const text = await (await ruf(r, "/api/unbekannt/x")).text();
    expect(text).not.toContain("rk_live_geheim_9876543210");
    expect(text).not.toContain(MODELL_SCHLUESSEL);
    expect(text).not.toContain(ziel.basis); // auch keine internen Adressen
  });

  test("starteRelay legt den Schlüssel NICHT in die Umgebung — Kindprozesse erben sie", async () => {
    const ziel = merke(attrappenZiel());
    merke(starteRelay(ki(ziel.basis), new Map([["stripe", integration(ziel.basis)]])));
    for (const [name, wert] of Object.entries(process.env)) {
      expect(`${name}=${wert}`).not.toContain(MODELL_SCHLUESSEL);
      expect(`${name}=${wert}`).not.toContain("rk_live_geheim_9876543210");
    }
  });

  test("das zurückgegebene Relay trägt nur Port und stop()", () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map()));
    expect(Object.keys(r).sort()).toEqual(["port", "stop"]);
    expect(typeof r.port).toBe("number");
  });
});

// ===========================================================================
// Bindung, Streaming, Lebensdauer
// ===========================================================================

describe("relay.ts — hört nur auf dem Loopback", () => {
  test("auf 127.0.0.1 erreichbar", async () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map()));
    expect((await ruf(r, "/modell/models")).status).toBe(200);
  });

  const externeIp = Object.values(networkInterfaces())
    .flat()
    .find((n) => n && n.family === "IPv4" && !n.internal)?.address;

  test.skipIf(!externeIp)("auf der LAN-Adresse NICHT erreichbar — sonst ein offener Schlüssel-Dienst", async () => {
    const ziel = merke(attrappenZiel());
    const r = merke(starteRelay(ki(ziel.basis), new Map()));
    let erreichbar = false;
    try {
      const res = await fetch(`http://${externeIp}:${r.port}/modell/models`, {
        signal: AbortSignal.timeout(2000),
      });
      erreichbar = res.status < 500;
    } catch {
      erreichbar = false;
    }
    expect(erreichbar).toBe(false);
  });
});

describe("relay.ts — Streaming wird durchgereicht, nicht gepuffert", () => {
  test("das erste Stück kommt an, bevor das Ziel fertig ist", async () => {
    const VERZOEGERUNG = 400;
    const ziel = merke(
      attrappenZiel(() => ({
        typ: "text/event-stream",
        body: new ReadableStream({
          async start(c) {
            c.enqueue(new TextEncoder().encode("data: erst\n\n"));
            await Bun.sleep(VERZOEGERUNG);
            c.enqueue(new TextEncoder().encode("data: zweit\n\n"));
            c.close();
          },
        }),
      })),
    );
    const r = merke(starteRelay(ki(ziel.basis), new Map()));

    const start = Date.now();
    const res = await ruf(r, "/modell/chat/completions", { method: "POST", body: '{"stream":true}' });
    const leser = res.body!.getReader();
    const erstes = await leser.read();
    const bisErstesStueck = Date.now() - start;

    expect(new TextDecoder().decode(erstes.value)).toContain("erst");
    // Gepuffert wäre hier mindestens VERZOEGERUNG vergangen.
    expect(bisErstesStueck).toBeLessThan(VERZOEGERUNG - 100);

    await leser.cancel();
  });
});

describe("relay.ts — Lebensdauer", () => {
  test("der Port ist zufällig, nicht fest", () => {
    const ziel = merke(attrappenZiel());
    const a = merke(starteRelay(ki(ziel.basis), new Map()));
    const b = merke(starteRelay(ki(ziel.basis), new Map()));
    expect(a.port).not.toBe(b.port);
    expect(a.port).toBeGreaterThan(0);
  });

  test("nach stop() ist der Port zu — ein Lauf hinterlässt keinen offenen Dienst", async () => {
    const ziel = merke(attrappenZiel());
    const r = starteRelay(ki(ziel.basis), new Map());
    const port = r.port;
    r.stop();
    let erreichbar = true;
    try {
      await fetch(`http://127.0.0.1:${port}/modell/models`, { signal: AbortSignal.timeout(2000) });
    } catch {
      erreichbar = false;
    }
    expect(erreichbar).toBe(false);
  });

  test("stop() zweimal wirft nicht", () => {
    const ziel = merke(attrappenZiel());
    const r = starteRelay(ki(ziel.basis), new Map());
    r.stop();
    expect(() => r.stop()).not.toThrow();
  });
});

// ===========================================================================
// Datenschutz-Routing (§13.27) — die Felder gehören in `provider`
// ===========================================================================

describe("relay.ts — datenschutzZusatz() setzt zdr und data_collection", () => {
  const ORIGINAL = { model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hallo" }] };
  const OR = "https://openrouter.ai/api/v1";

  function zusatz(baseUrl: string, koerper: unknown): Record<string, unknown> {
    return JSON.parse(datenschutzZusatz(baseUrl, typeof koerper === "string" ? koerper : JSON.stringify(koerper)));
  }

  test("die Felder landen in `provider`", () => {
    const raus = zusatz(OR, ORIGINAL);
    expect(raus.provider).toEqual({ zdr: true, data_collection: "deny" });
  });

  test("und NICHT auf der obersten Ebene — dort werden sie stillschweigend verschluckt", () => {
    // Gemessen gegen die echte API: ein erfundenes Feld obenauf ergibt HTTP 200,
    // dasselbe Feld in `provider` ergibt HTTP 400. Ein Top-Level-`zdr` wäre
    // deshalb kein Fehler, sondern ein stiller Ausfall — wir hielten uns für
    // ZDR-geschützt und wären es nicht.
    const raus = zusatz(OR, ORIGINAL);
    expect(raus.zdr).toBeUndefined();
    expect(raus.data_collection).toBeUndefined();
  });

  test("der übrige Körper bleibt unangetastet", () => {
    const raus = zusatz(OR, ORIGINAL);
    expect(raus.model).toBe(ORIGINAL.model);
    expect(raus.messages).toEqual(ORIGINAL.messages);
  });

  test("ein vom Arbeiter mitgeschicktes `provider` behält seine übrigen Felder", () => {
    const raus = zusatz(OR, { ...ORIGINAL, provider: { order: ["deepinfra"], allow_fallbacks: false } });
    expect(raus.provider).toEqual({ order: ["deepinfra"], allow_fallbacks: false, zdr: true, data_collection: "deny" });
  });

  test("aber genau diese zwei Felder werden überschrieben — die Betreiberentscheidung schlägt das Modell", () => {
    const raus = zusatz(OR, { ...ORIGINAL, provider: { zdr: false, data_collection: "allow" } });
    expect(raus.provider).toEqual({ zdr: true, data_collection: "deny" });
  });

  test("ein `provider`, das kein Objekt ist, wird ersetzt statt verschmolzen", () => {
    for (const kaputt of ["deepinfra", 42, ["a"], null]) {
      expect(zusatz(OR, { ...ORIGINAL, provider: kaputt }).provider).toEqual({ zdr: true, data_collection: "deny" });
    }
  });
});

describe("relay.ts — datenschutzZusatz() erkennt OpenRouter EXAKT", () => {
  const KOERPER = JSON.stringify({ model: "x", messages: [] });

  test.each([
    "https://openrouter.ai/api/v1",
    "https://OpenRouter.AI/api/v1",
    "https://sub.openrouter.ai/api/v1",
    "https://openrouter.ai:443/api/v1",
    // Der abschließende Punkt bezeichnet denselben Rechner (absolute DNS-Notation).
    // Ohne das Abschneiden bestünde er den exakten Vergleich NICHT — Ergebnis wäre
    // ein Modellaufruf ganz ohne ZDR gewesen: ohne Fehler, ohne Log, ohne Spur.
    "https://openrouter.ai./api/v1",
    "https://sub.openrouter.ai./api/v1",
  ])("%s ist OpenRouter", (baseUrl) => {
    expect(JSON.parse(datenschutzZusatz(baseUrl, KOERPER)).provider).toBeDefined();
  });

  test.each([
    "https://openrouter.ai.angreifer.de/api/v1",
    "https://notopenrouter.ai/api/v1",
    "https://api.cortecs.ai/v1",
    "http://127.0.0.1:8080/api/v1",
    "kaputt",
    "",
  ])("%s ist NICHT OpenRouter — der Körper bleibt unverändert", (baseUrl) => {
    // Dieselbe Falle wie `js.stripe.com.angreifer.de` im Validator: Wer mit
    // includes() vergleicht, schickt das Datenschutz-Routing an einen Fremden —
    // und meldet dem Betreiber ZDR, wo keines ist.
    expect(datenschutzZusatz(baseUrl, KOERPER)).toBe(KOERPER);
  });
});

describe("relay.ts — datenschutzZusatz() lässt alles durch, was kein JSON-Objekt ist", () => {
  const OR = "https://openrouter.ai/api/v1";

  test.each(["kein json", "", "   ", "[1,2,3]", '"nur ein string"', "null", "42"])(
    "%s bleibt unverändert",
    (koerper) => {
      expect(datenschutzZusatz(OR, koerper)).toBe(koerper);
    },
  );

  test("wirft nie — ein Wurf hier risse mitten im Lauf den Modellaufruf mit", () => {
    for (const koerper of ["{", "\u0000", "{}"]) {
      expect(() => datenschutzZusatz(OR, koerper)).not.toThrow();
    }
  });
});

describe("relay.ts — istOpenRouter() und ergaenzeDatenschutz() einzeln", () => {
  test("istOpenRouter erkennt den Rechner, nicht die Zeichenkette", () => {
    expect(istOpenRouter("https://openrouter.ai/api/v1")).toBe(true);
    expect(istOpenRouter("https://openrouter.ai./api/v1")).toBe(true);
    expect(istOpenRouter("https://openrouter.ai.angreifer.de/api/v1")).toBe(false);
    expect(istOpenRouter("https://angreifer.de/?ziel=openrouter.ai")).toBe(false);
    expect(istOpenRouter("kaputt")).toBe(false);
  });

  test("ergaenzeDatenschutz setzt die Felder unabhängig vom Anbieter", () => {
    // Die Anbieterfrage stellt datenschutzZusatz; diese Funktion tut nur das Setzen.
    const raus = JSON.parse(ergaenzeDatenschutz(JSON.stringify({ model: "x" })));
    expect(raus.provider).toEqual({ zdr: true, data_collection: "deny" });
  });

  test("datenschutzZusatz ist genau die Verdrahtung aus beiden", () => {
    // Ohne diese Bindung könnte der Test die eine Verdrahtung prüfen und das
    // Relay die andere benutzen — genau der Fall, den Dev-Netz gerade gefunden hat.
    const koerper = JSON.stringify({ model: "x", messages: [] });
    for (const baseUrl of ["https://openrouter.ai/api/v1", "https://api.cortecs.ai/v1", "kaputt"]) {
      const erwartet = istOpenRouter(baseUrl) ? ergaenzeDatenschutz(koerper) : koerper;
      expect(datenschutzZusatz(baseUrl, koerper)).toBe(erwartet);
    }
  });
});
