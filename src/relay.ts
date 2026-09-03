/**
 * relay.ts — der Schlüssel-Riegel zwischen Agentenprozess und fremden Diensten.
 *
 * Der Arbeiter besitzt kein Geheimnis. Er ruft eine Loopback-Adresse auf, und
 * **erst hier** wird der Schlüssel angehängt. Das ist die technische Fassung von
 * Invariante 11: „Der Agentenprozess hält keine Zugangsschlüssel und besitzt kein
 * Werkzeug für beliebige Netzverbindungen."
 *
 * Der Riegel trägt mehr, als er auf den ersten Blick scheint: Der Arbeiter läuft
 * bewusst **ohne** `--unshare-net` (er muss dieses Relay erreichen), und auf einer
 * Entwicklungsmaschine steht zusätzlich ein Vault-Proxy auf dem Loopback. Dem
 * Arbeiter Umgebungsvariablen wegzunehmen beweist deshalb nichts — der Nachweis der
 * Trennung ist, dass ein Lauf **ohne laufendes Relay scheitert**. Diese Datei ist
 * die einzige Stelle, an der die Schlüsseltrennung wirklich hängt.
 *
 * Zwei benannte Ziele, keine freie URL: `/modell/<pfad>` und `/api/<name>/<pfad>`.
 * Der Agent nennt einen **Namen**, nie eine Adresse — sonst wäre das Relay ein
 * generisches Netzwerkzeug und die Invariante gebrochen.
 */
import type { KiConfig } from "./betreiber-config.ts";
import type { Integration, Integrationen } from "./integrationen.ts";

export type Relay = { port: number; stop(): void };

/**
 * Wartezeit auf die **Antwortkopfzeilen** der fremden API — nicht auf den ganzen
 * Körper. Ein `AbortSignal.timeout` über den gesamten Aufruf würde eine lange
 * Streaming-Antwort mitten im Satz abschneiden; genau das erzeugt ein Modell.
 * Deshalb ein Timer, der nach den Kopfzeilen gelöscht wird.
 */
export const RELAY_KOPF_TIMEOUT_MS = 60_000;

/**
 * Obergrenze für den Anfragekörper. Er wird gepuffert (die Datenschutz-Ergänzung
 * braucht ihn ohnehin als Ganzes), und ein Prompt mit eingebetteten Dateien wird
 * groß — aber nicht beliebig groß. Ohne Deckel wäre ein durchgedrehter Arbeiter
 * ein Speicherleck im Elternprozess, der alle Kunden bedient.
 */
export const MAX_ANFRAGE_BYTES = 16 * 1024 * 1024;

/**
 * `Bun.serve` beendet einen Strom nach dieser Zeit ohne Bytes; 255 s ist das
 * erlaubte Maximum. Ein Modell, das lange nachdenkt, bevor das erste Wort kommt,
 * risse sonst reproduzierbar die Verbindung zum Arbeiter.
 */
const RELAY_IDLE_TIMEOUT_S = 255;

/**
 * Anfrage-Kopfzeilen, die vom Arbeiter durchgereicht werden. Eine **Allowlist**,
 * keine Denylist: Sonst schmuggelte der Arbeiter sein eigenes `Authorization`
 * durch (fremdes Kostenkonto) oder setzte `X-Forwarded-*`, mit denen manche APIs
 * ihre Zugriffsregeln auswerten.
 */
const ERLAUBTE_ANFRAGE_KOPFE = new Set(["content-type", "accept"]);

/**
 * Antwort-Kopfzeilen, die NICHT zurückgehen. `content-encoding` und
 * `content-length` sind die wichtigen: `fetch` hat den Körper bereits
 * ausgepackt — bliebe `content-encoding: gzip` stehen, versuchte der Arbeiter
 * Klartext zu entpacken und bekäme Müll. `set-cookie` hat in einem
 * Maschine-zu-Maschine-Aufruf nichts verloren.
 */
const UNTERDRUECKTE_ANTWORT_KOPFE = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "strict-transport-security",
]);

/**
 * Kürzere Zeichenketten werden nicht als Geheimnis gesucht und ersetzt. Ein
 * Schlüssel mit fünf Zeichen käme in fast jeder Antwort zufällig vor; das
 * Ersetzen zerstörte den Inhalt, statt etwas zu schützen.
 */
const MIN_GEHEIMNIS_LAENGE = 8;

const ENTFERNT = "«Schlüssel entfernt»";

// ===========================================================================
// Pfade
// ===========================================================================

/**
 * Prozentkodierungen, die eine Pfadprüfung und den Empfänger auseinanderlaufen
 * lassen. `new URL()` normalisiert `%2e%2e` von sich aus zu `..`, `%2f` aber
 * **nicht**: `..%2f..%2fgeheim` bliebe wörtlich stehen, käme durch die
 * Allowlist und würde von manchen Servern doch als `../../geheim` gelesen.
 * Fail-closed ablehnen; eine echte API braucht das nicht.
 */
const HEIKLE_KODIERUNG = /%(?:2e|2f|5c|00)/i;

/** true = der Rest-Pfad ist harmlos und darf so weitergereicht werden. */
function pfadIstSauber(pfad: string): boolean {
  if (HEIKLE_KODIERUNG.test(pfad)) return false;
  if (pfad.includes("\\")) return false;
  return !pfad.split("/").some((seg) => seg === "." || seg === "..");
}

/**
 * Übersetzt einen Eintrag aus `erlaubtePfade` in einen Vergleich. `*` deckt eine
 * beliebige Fortsetzung — `GET /v1/*` erlaubt `/v1/products/prod_1`, aber nicht
 * `/v2/geheim`. Alles andere wird wörtlich verglichen; ein Punkt im Muster ist
 * ein Punkt, kein Regex-Platzhalter.
 */
function musterPasst(muster: string, pfad: string): boolean {
  const teile = muster.split("*").map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${teile.join(".*")}$`).test(pfad);
}

/** null = keine Einschränkung. Leere Liste heißt NICHTS, nicht alles. */
function pfadFreigeschaltet(erlaubt: string[] | null, methode: string, pfad: string): boolean {
  if (erlaubt === null) return true;
  return erlaubt.some((eintrag) => {
    const trenner = eintrag.indexOf(" ");
    if (trenner < 0) return false;
    const mMethode = eintrag.slice(0, trenner).trim().toUpperCase();
    const mPfad = eintrag.slice(trenner + 1).trim();
    if (mMethode !== "*" && mMethode !== methode.toUpperCase()) return false;
    return musterPasst(mPfad, pfad);
  });
}

// ===========================================================================
// Geheimnisse
// ===========================================================================

function sammleGeheimnisse(ki: KiConfig, integrationen: Integrationen): string[] {
  const alle = [ki.apiKey, ...[...integrationen.values()].map((i) => i.auth.key)];
  // Absteigend nach Länge: Enthielte ein Schlüssel einen anderen als Teilstück,
  // muss der längere zuerst ersetzt werden, sonst bliebe ein Rest stehen.
  return [...new Set(alle.filter((s) => typeof s === "string" && s.length >= MIN_GEHEIMNIS_LAENGE))].sort(
    (a, b) => b.length - a.length,
  );
}

/**
 * Manche APIs spiegeln die Anfrage-Kopfzeilen in ihre Fehlermeldung. Der Agent
 * liest diese Antwort — und hätte damit genau den Schlüssel, den ihm die ganze
 * Bauart vorenthalten soll.
 */
function entferneGeheimnisse(text: string, geheimnisse: string[]): string {
  let raus = text;
  for (const g of geheimnisse) raus = raus.split(g).join(ENTFERNT);
  return raus;
}

// ===========================================================================
// Datenschutz-Routing
// ===========================================================================

/**
 * **Exakter Vergleich auf Host und echte Unterdomäne, nie `includes`.** Sonst
 * genügte `openrouter.ai.angreifer.de` — dieselbe Falle wie
 * `js.stripe.com.angreifer.de` im Validator. Der Schaden wäre hier besonders
 * still: Wir schickten das Datenschutz-Routing an einen Fremden und meldeten dem
 * Betreiber ZDR, wo keines ist.
 *
 * Der abschließende Punkt (`openrouter.ai.`) wird abgeschnitten: Er bezeichnet
 * denselben Rechner, ließe den Vergleich aber scheitern — und ZDR fiele
 * kommentarlos aus.
 */
export function istOpenRouter(baseUrl: string): boolean {
  let wirt: string;
  try {
    wirt = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return wirt === "openrouter.ai" || wirt.endsWith(".openrouter.ai");
}

/**
 * Setzt bei OpenRouter das Datenschutz-Routing im Anfragekörper.
 *
 * **Die Felder gehören in `provider`, nicht auf die oberste Ebene.** Am
 * 2026-09-02 gegen OpenRouters OpenAPI geprüft: `ProviderPreferences` führt
 * `zdr` und `data_collection`, das äußere Anfrageobjekt verbietet zusätzliche
 * Felder nicht. Ein `{"zdr":true}` obenauf wäre deshalb **kein Fehler, sondern
 * ein stiller Ausfall** — wir hielten uns für ZDR-geschützt und wären es nicht.
 *
 * Ein vom Arbeiter mitgeschicktes `provider` wird in genau diesen zwei Feldern
 * überschrieben: Die Betreiberentscheidung schlägt das, was das Modell sich
 * selbst ausdenkt.
 */
export function ergaenzeDatenschutz(koerper: string): string {
  try {
    const daten: unknown = JSON.parse(koerper);
    if (typeof daten !== "object" || daten === null || Array.isArray(daten)) return koerper;
    const objekt = daten as Record<string, unknown>;
    const vorhanden =
      typeof objekt.provider === "object" && objekt.provider !== null && !Array.isArray(objekt.provider)
        ? (objekt.provider as Record<string, unknown>)
        : {};
    // Reihenfolge zählt: Unsere zwei Felder stehen HINTER den mitgeschickten und
    // überschreiben sie damit. Alles andere (`order`, `allow_fallbacks`) bleibt.
    objekt.provider = { ...vorhanden, zdr: true, data_collection: "deny" };
    return JSON.stringify(objekt);
  } catch {
    // Kein JSON, kaputtes JSON, irgendetwas Unerwartetes: unverändert
    // weiterreichen. Ein Wurf risse hier mitten im Lauf den Modellaufruf mit,
    // und das Schlimmste, was ohne Ergänzung passiert, ist eine Anfrage ohne
    // Datenschutz-Routing — für einen Körper, den OpenRouter ohnehin ablehnt.
    return koerper;
  }
}

/**
 * Was das Relay tatsächlich aufruft: Erkennung und Ergänzung in einem Stück.
 *
 * Bewusst diese Zusammensetzung und nicht zwei Aufrufe an der Aufrufstelle —
 * sonst prüfte ein Test die eine Verdrahtung und das Relay benutzte die andere.
 */
export function datenschutzZusatz(baseUrl: string, koerper: string): string {
  return istOpenRouter(baseUrl) ? ergaenzeDatenschutz(koerper) : koerper;
}

// ===========================================================================
// Antworten des Relays selbst
// ===========================================================================

/**
 * Deutscher Klartext statt eines nackten Statuscodes: Der Agent soll verstehen,
 * was fehlt, statt blind weiterzuprobieren. Die Meldungen nennen **nie** eine
 * Adresse eines Ziels — der Agent soll Namen benutzen, nicht Adressen lernen.
 */
function klartext(text: string, status = 404): Response {
  return new Response(`${text}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

const WEGWEISER =
  "Unbekannter Pfad. Es gibt genau zwei Ziele: /modell/<pfad> für den Modellzugang " +
  "und /api/<name>/<pfad> für eine benannte Integration.";

// ===========================================================================
// Start
// ===========================================================================

/**
 * Startet die Loopback-Weiterleitung für **einen** Lauf. Der Port ist zufällig
 * und lebt nur so lange wie der Lauf; er geht über die Umgebung an den Arbeiter,
 * nie über `argv` — argv liest jeder Prozess des Hosts.
 */
export function starteRelay(ki: KiConfig, integrationen: Integrationen): Relay {
  const geheimnisse = sammleGeheimnisse(ki, integrationen);
  const modellBasis = ki.baseUrl.replace(/\/+$/, "");

  const server = Bun.serve({
    // NIE 0.0.0.0: Auf einem Host mit mehreren Kundendiensten wäre das ein
    // offener Schlüssel-Dienst für die Nachbarn.
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: RELAY_IDLE_TIMEOUT_S,
    maxRequestBodySize: MAX_ANFRAGE_BYTES,
    async fetch(req) {
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return klartext(WEGWEISER);
      }

      const modell = /^\/modell\/(.*)$/.exec(url.pathname);
      if (modell) {
        const rest = modell[1]!;
        if (!pfadIstSauber(rest)) {
          return klartext(`Der Pfad "${rest}" enthält unzulässige Zeichen und wurde nicht weitergereicht.`);
        }
        return leiteWeiter(req, `${modellBasis}/${rest}${url.search}`, (kopf, koerper) => {
          // Nur wenn ein Schlüssel da ist: Auf dieser Maschine setzt ein
          // ausgehender Proxy die Anmeldung ein, und ein leerer Bearer-Header
          // machte den Aufruf kaputt, statt ihn zu ermöglichen.
          if (ki.apiKey !== "") kopf.set("authorization", `Bearer ${ki.apiKey}`);
          // Genau die exportierte Zusammensetzung, damit Test und Betrieb
          // denselben Weg gehen. Die Hostnamen-Prüfung je Anfrage statt einmal
          // beim Start ist die paar Mikrosekunden wert.
          return koerper === null ? null : datenschutzZusatz(ki.baseUrl, koerper);
        });
      }

      const api = /^\/api\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (api) {
        // Eine kaputte Prozentkodierung (`/api/%zz/x`) lässt decodeURIComponent
        // werfen; ungefangen antwortete Bun mit 500 statt mit dem Klartext, an
        // dem der Agent erkennt, was er falsch gemacht hat.
        let name: string;
        try {
          name = decodeURIComponent(api[1]!);
        } catch {
          return klartext("Der Name der Integration ist nicht lesbar.");
        }
        const rest = api[2] ?? "";
        const integration = integrationen.get(name);
        if (integration === undefined) {
          const namen = [...integrationen.keys()].sort();
          return klartext(
            `Unbekannte Integration "${name}". Verfügbar: ${namen.length ? namen.join(", ") : "keine"}.`,
          );
        }
        if (!pfadIstSauber(rest)) {
          return klartext(`Der Pfad "/${rest}" enthält unzulässige Zeichen und wurde nicht weitergereicht.`);
        }
        const pfad = `/${rest}`;
        if (!pfadFreigeschaltet(integration.erlaubtePfade, req.method, pfad)) {
          const erlaubt = integration.erlaubtePfade?.length
            ? integration.erlaubtePfade.join(", ")
            : "nichts";
          return klartext(
            `${req.method} ${pfad} ist für "${name}" nicht freigeschaltet. Erlaubt: ${erlaubt}.`,
          );
        }
        const basis = integration.baseUrl.replace(/\/+$/, "");
        return leiteWeiter(req, `${basis}${pfad}${url.search}`, (kopf, koerper) => {
          setzeAuth(kopf, integration);
          return koerper;
        });
      }

      return klartext(WEGWEISER);
    },
  });

  /**
   * Der eigentliche Weiterleiter. Der Anfragekörper wird gepuffert (er ist klein,
   * und die Datenschutz-Ergänzung braucht ihn ohnehin), die **Antwort** dagegen
   * unverändert durchgereicht — gepuffert hinge die Seitenleiste, bis das Modell
   * fertig ist.
   */
  async function leiteWeiter(
    req: Request,
    ziel: string,
    veredle: (kopf: Headers, koerper: string | null) => string | null,
  ): Promise<Response> {
    const kopf = new Headers();
    for (const [name, wert] of req.headers) {
      if (ERLAUBTE_ANFRAGE_KOPFE.has(name.toLowerCase())) kopf.set(name, wert);
    }

    const hatKoerper = req.method !== "GET" && req.method !== "HEAD";
    let koerper: string | null = hatKoerper ? await req.text() : null;
    koerper = veredle(kopf, koerper);

    // Zeitgrenze nur bis zu den Kopfzeilen — danach darf der Strom laufen.
    const abbruch = new AbortController();
    const uhr = setTimeout(() => abbruch.abort(), RELAY_KOPF_TIMEOUT_MS);

    let antwort: Response;
    try {
      antwort = await fetch(ziel, {
        method: req.method,
        headers: kopf,
        body: koerper,
        // Eine Weiterleitung der fremden API wird NICHT verfolgt und auch nicht
        // durchgereicht: Der Arbeiter hat Netz, ein weitergereichtes `Location`
        // wäre ein von der Gegenseite gesteuerter Ausgang aus der Sandbox.
        redirect: "manual",
        signal: abbruch.signal,
      });
    } catch (err) {
      const zeit = err instanceof Error && err.name === "TimeoutError";
      return klartext(
        zeit || abbruch.signal.aborted
          ? "Der fremde Dienst hat nicht rechtzeitig geantwortet."
          : "Der fremde Dienst ist nicht erreichbar.",
        502,
      );
    } finally {
      clearTimeout(uhr);
    }

    if (antwort.status >= 300 && antwort.status < 400) {
      await antwort.body?.cancel().catch(() => {});
      return klartext(
        "Der fremde Dienst wollte auf eine andere Adresse umleiten. Weiterleitungen werden nicht gefolgt.",
        502,
      );
    }

    const antwortKopf = new Headers();
    for (const [name, wert] of antwort.headers) {
      if (UNTERDRUECKTE_ANTWORT_KOPFE.has(name.toLowerCase())) continue;
      antwortKopf.set(name, entferneGeheimnisse(wert, geheimnisse));
    }

    // Nur Fehlerantworten werden gelesen und gesäubert. Sie sind klein, und
    // genau dort echoen APIs die Anfrage-Kopfzeilen zurück. Einen Erfolgskörper
    // zu durchsuchen hieße, ihn zu puffern — und damit das Streaming zu brechen.
    if (antwort.status >= 400) {
      const roh = await antwort.text();
      return new Response(entferneGeheimnisse(roh, geheimnisse), {
        status: antwort.status,
        headers: antwortKopf,
      });
    }

    const ohneKoerper = antwort.status === 204 || antwort.status === 304;
    return new Response(ohneKoerper ? null : antwort.body, {
      status: antwort.status,
      headers: antwortKopf,
    });
  }

  let zu = false;
  return {
    port: server.port ?? 0,
    stop() {
      if (zu) return; // zweimal aufrufen ist kein Fehler — `finally` darf doppelt laufen
      zu = true;
      server.stop(true);
    },
  };
}

function setzeAuth(kopf: Headers, integration: Integration): void {
  if (integration.auth.typ === "bearer") kopf.set("authorization", `Bearer ${integration.auth.key}`);
  else kopf.set(integration.auth.name, integration.auth.key);
}
