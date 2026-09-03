/**
 * Die vier Routen der KI-Seitenleiste (Contract §7).
 *
 * ZWEI DINGE, DIE HIER FESTGENAGELT WERDEN:
 *
 * 1. **Unangemeldet ist 404, nicht 401** (Invariante 4). Ein 401 verriete, dass
 *    es diese Website und diesen Editor überhaupt gibt. Bei den Agenten-Routen
 *    kommt ein zweiter Grund dazu: Ein Fremder, der einen Lauf auslösen kann,
 *    kostet Geld und schreibt in eine fremde Website.
 * 2. **Ohne betreiberweite `ki.json` gibt es die Routen nicht** — auch mit
 *    gültigem Cookie. Fail-closed wie bei fehlender Auth-Datei: eine fehlende
 *    Konfiguration heißt „Funktion existiert nicht", nie „Funktion ohne Schutz".
 *
 * Der SSE-Teil läuft gegen einen ECHTEN Server: `handleEditorRequest` gäbe zwar
 * ein `Response`-Objekt mit Strom zurück, aber ob Bun ihn wirklich stückweise
 * ausliefert (und nicht puffert), zeigt erst der Weg über TCP.
 *
 * Kein Test dieser Datei stellt eine Modell- oder Suchanfrage: Der Worker ist
 * die Attrappe, `braveKey` ist `null`, `baseUrl` zeigt ins Leere.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as host from "./host.ts";
import { createAuthFile, issueCookie, loadAuthFile } from "./auth.ts";
import { schreibeKiConfig, type KiConfig } from "./betreiber-config.ts";
import { ensureRepo } from "./git.ts";
import { startServer } from "./server.ts";
import { attrappenVersand } from "./versand.ts";
import { meldeAn } from "./anmeldung.testhelfer.ts";
import { bwrapPfad } from "./sandbox.ts";
import { brichAb, laufAktiv, starteLauf } from "./agent.ts";
import { TOKEN_KONTINGENT, verbucheTokens } from "./kontingent.ts";

/**
 * NOTBREMSE — bitte nicht entfernen.
 *
 * `POST /edit/agent` hat keine Testnaht: Die Route ruft `starteLauf` ohne
 * `workerBefehl`, und `standardWorkerBefehl()` baut den Arbeiter dann aus
 * `Bun.main`. In Produktion ist das richtig (das kompilierte Binary bzw.
 * `src/cli.ts`). Unter `bun test` ist `Bun.main` aber DIESE DATEI — die Route
 * startet also den ganzen Testlauf noch einmal, in einer bwrap-Sandbox, im
 * Hintergrund.
 *
 * Gemessen: Diese Prozesse überlebten `bun test`, sammelten sich über mehrere
 * Läufe an und ließen danach Abbrüche in ihr Zeitlimit laufen — ein Fehlerbild,
 * das nach einem kaputten `brichAb` aussieht und keines ist.
 *
 * Der Ausstieg hier macht den gestarteten „Arbeiter" zu einem no-op. Sauberer
 * wäre eine Naht in `agent.ts` (etwa `REGORO_AGENT_WORKER`), damit auch der
 * HTTP-Weg mit der Attrappe geprüft werden kann; die ist beim Orchestrator
 * angefragt.
 */
if (process.argv.includes("agent-worker")) process.exit(0);

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");
const ATTRAPPE = join(import.meta.dir, "agent-worker.attrappe.ts");
const NUMMER = "+4915120464812";
const PAGES = ["index.html", "impressum.html", "datenschutz.html", "agb.html"];
const KI: KiConfig = {
  apiKey: "sk-attrappe-nie-benutzt-000000",
  keyFromProxy: false,
  braveKey: null,
  // Wie braveKey: Ohne Schlüssel keine Netzfähigkeit. Suchen und Abrufen sind
  // zwei Dienste — kein Test dieser Datei braucht eines von beiden.
  firecrawlKey: null,
  baseUrl: "http://127.0.0.1:1/v1",
  model: "z-ai/glm-5.3-flash",
};

/** Alle vier Routen, mit der Methode, unter der sie gemeint sind. */
const ROUTEN: [string, string][] = [
  ["POST", "/edit/agent"],
  ["GET", "/edit/agent/status"],
  ["GET", "/edit/agent/events"],
  ["POST", "/edit/agent/abort"],
];

const dirs: string[] = [];
afterAll(() => {
  // Siehe agent.test.ts: ein überlebender „warten"-Arbeiter hält sein bwrap und
  // macht jeden folgenden Testlauf langsamer, bis Abbrüche in ihr Zeitlimit
  // laufen. `brichAb` ist ohne laufenden Auftrag ein no-op.
  for (const d of dirs) {
    try {
      brichAb(d);
    } catch {
      /* egal — hier wird aufgeräumt, nicht geprüft */
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function haveBwrap(): boolean {
  try {
    return Bun.spawnSync([bwrapPfad(), "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}

let siteDir: string;
let ctx: host.HostCtx;

beforeEach(async () => {
  siteDir = tmp("regoro-routes-site-");
  cpSync(REAL_SITE, siteDir, { recursive: true });
  ensureRepo(siteDir);
  await createAuthFile(siteDir, [NUMMER]);
  process.env.RUNTIME_DIRECTORY = tmp("regoro-routes-run-");
  ctx = {
    repoRoot: siteDir,
    siteDir,
    pageWhitelist: PAGES,
    auth: loadAuthFile(siteDir),
    sitePrefix: "",
    versand: attrappenVersand(),
    ki: KI,
  };
});

function cookie(): string {
  return issueCookie(ctx.auth!).split(";")[0]!;
}

function ruf(methode: string, pfad: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Response> {
  const url = new URL("http://localhost:8788" + pfad);
  const kopf: Record<string, string> = {};
  if (opts.cookie) kopf.cookie = opts.cookie;
  if (opts.body !== undefined) kopf["content-type"] = "application/json";
  return host.handleEditorRequest(
    new Request(url, { method: methode, headers: kopf, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
    url,
    ctx,
  );
}

/** Startet einen Lauf am HTTP-Weg vorbei — für Zustände, die eine Route nur vorfindet. */
function laufImHintergrund(auftrag: string) {
  return starteLauf(ctx, auftrag, { workerBefehl: [process.execPath, "run", ATTRAPPE] });
}

// ===========================================================================
// Die Auth-Wand
// ===========================================================================
describe("unangemeldet gibt es diese Routen nicht", () => {
  test("alle vier antworten 404 — nicht 401, nicht 403", async () => {
    for (const [methode, pfad] of ROUTEN) {
      const r = await ruf(methode, pfad, { body: methode === "POST" ? { auftrag: "mach was" } : undefined });
      expect(`${methode} ${pfad} → ${r.status}`).toBe(`${methode} ${pfad} → 404`);
    }
  });

  test("ein ungültiges Cookie ist wie gar keines", async () => {
    for (const [methode, pfad] of ROUTEN) {
      const r = await ruf(methode, pfad, { cookie: "regoro_edit=gefaelscht", body: { auftrag: "x" } });
      expect(r.status).toBe(404);
    }
  });

  test("die 404 unterscheidet sich nicht von der einer erfundenen Route", async () => {
    // Sonst ist die Statusseite ein Orakel: „diese Website hat die KI-Leiste".
    const echt = await ruf("GET", "/edit/agent/status");
    const erfunden = await ruf("GET", "/edit/agent/gibtesnicht");
    expect(await echt.text()).toBe(await erfunden.text());
    expect(erfunden.status).toBe(404);
  });

  test("ohne Auth-Datei sind sie auch angemeldet zu", async () => {
    const gemerkt = cookie();
    ctx = { ...ctx, auth: null };
    for (const [methode, pfad] of ROUTEN) {
      expect((await ruf(methode, pfad, { cookie: gemerkt, body: { auftrag: "x" } })).status).toBe(404);
    }
  });
});

describe("ohne betreiberweite ki.json gibt es die Seitenleiste nicht", () => {
  test("angemeldet, aber ctx.ki fehlt → alle vier 404", async () => {
    const c = cookie();
    ctx = { ...ctx, ki: null };
    for (const [methode, pfad] of ROUTEN) {
      expect((await ruf(methode, pfad, { cookie: c, body: { auftrag: "x" } })).status).toBe(404);
    }
  });

  test("`ki` gar nicht gesetzt ist derselbe Fall wie `null`", async () => {
    // `ki` ist optional am HostCtx, damit die Ctx-Bauer schrittweise nachziehen
    // konnten. Wer auf `=== null` prüft statt `== null`, öffnet die Routen für
    // jeden Ctx, der das Feld noch nicht kennt.
    const c = cookie();
    const { ki: _weg, ...ohne } = ctx;
    ctx = ohne as host.HostCtx;
    for (const [methode, pfad] of ROUTEN) {
      expect((await ruf(methode, pfad, { cookie: c, body: { auftrag: "x" } })).status).toBe(404);
    }
  });
});

// ===========================================================================
// POST /edit/agent
// ===========================================================================
describe("POST /edit/agent", () => {
  test("ohne Auftrag: 400 mit der gemeinsamen Fehlerform", async () => {
    const r = await ruf("POST", "/edit/agent", { cookie: cookie(), body: {} });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, grund: "Auftrag fehlt." });
  });

  test("ein Auftrag aus Leerzeichen zählt als keiner", async () => {
    const r = await ruf("POST", "/edit/agent", { cookie: cookie(), body: { auftrag: "   \n\t " } });
    expect(r.status).toBe(400);
  });

  test.skipIf(!haveBwrap())("mit Auftrag: 200 und eine Lauf-Kennung", async () => {
    const r = await ruf("POST", "/edit/agent", { cookie: cookie(), body: { auftrag: "harmlos" } });
    expect(r.status).toBe(200);
    const körper = (await r.json()) as { ok: boolean; laufId: string };
    expect(körper.ok).toBe(true);
    expect(körper.laufId).toMatch(/^[0-9a-f-]{36}$/);
    brichAb(siteDir);
  }, 30_000);

  test.skipIf(!haveBwrap())("ein zweiter gleichzeitiger Lauf: 409", async () => {
    expect(laufImHintergrund("warten").ok).toBe(true);
    const r = await ruf("POST", "/edit/agent", { cookie: cookie(), body: { auftrag: "harmlos" } });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({
      ok: false,
      grund: "Es läuft bereits ein Auftrag für diese Website.",
    });
    brichAb(siteDir);
  }, 30_000);

  test("erschöpftes Kontingent: 429 mit Klartext, der den Monatsersten nennt", async () => {
    // Der Kunde soll hier nicht rätseln müssen. „429" allein ist im Browser
    // eine leere Seite; der Satz sagt ihm, dass es von selbst weitergeht.
    verbucheTokens(siteDir, TOKEN_KONTINGENT + 1);
    const r = await ruf("POST", "/edit/agent", { cookie: cookie(), body: { auftrag: "harmlos" } });
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({
      ok: false,
      grund: "Das Monatskontingent ist aufgebraucht. Es setzt sich am Monatsersten zurück.",
    });
    expect(laufAktiv(siteDir)).toBeNull();
  });

  test("fehlendes bwrap: 503, kein Lauf", async () => {
    const alt = process.env.REGORO_BWRAP;
    process.env.REGORO_BWRAP = "/nicht/vorhanden/bwrap";
    try {
      const r = await ruf("POST", "/edit/agent", { cookie: cookie(), body: { auftrag: "harmlos" } });
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({
        ok: false,
        grund: "Die Sandbox (bwrap) ist auf diesem Server nicht verfügbar.",
      });
      expect(laufAktiv(siteDir)).toBeNull();
    } finally {
      if (alt === undefined) delete process.env.REGORO_BWRAP;
      else process.env.REGORO_BWRAP = alt;
    }
  });

  test("ein normal langer Auftrag geht durch", async () => {
    // Die Gegenprobe zur Obergrenze. Sie ist nötig, weil eine zu eng gesetzte
    // Grenze denselben Schaden anrichtet wie gar keine: Der Kunde beschreibt
    // seinen Wunsch in ein paar Sätzen — „mach mir eine Unterseite über
    // Badsanierung, mit den drei häufigsten Fragen und einem Kontaktblock" —
    // und bekommt eine Fehlermeldung, deren Grund er nicht sieht.
    const auftrag = (
      "Bitte lege eine Unterseite über Badsanierung an, verlinke sie in der Navigation, " +
      "schreibe drei Abschnitte über Ablauf, Dauer und Kosten und setze darunter einen " +
      "Kontaktblock mit unserer Telefonnummer. "
    ).repeat(4);
    expect(auftrag.length).toBeGreaterThan(500); // wirklich ein realistischer Text
    const r = await ruf("POST", "/edit/agent", { cookie: cookie(), body: { auftrag } });
    expect(r.status).not.toBe(400);
    if (r.status === 200) brichAb(siteDir);
  });

  test("ein riesiger Auftrag wird abgelehnt, nicht verarbeitet", async () => {
    // Der Auftrag geht in den System-Prompt. Ohne Obergrenze ist das ein
    // bezahltes Fass ohne Boden — und `REGORO_AUFTRAG` ist eine Umgebungs-
    // variable mit harter Größengrenze des Kernels.
    const r = await ruf("POST", "/edit/agent", { cookie: cookie(), body: { auftrag: "x".repeat(100_000) } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { grund: string }).grund).toMatch(/[a-zäöüß]{4,}/i);
  });
});

// ===========================================================================
// GET /edit/agent/status
// ===========================================================================
describe("GET /edit/agent/status", () => {
  test("ohne Lauf: Kontingent und `laeuft:false`", async () => {
    const r = await ruf("GET", "/edit/agent/status", { cookie: cookie() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ok: true,
      laeuft: false,
      laufId: null,
      kontingent: {
        frei: TOKEN_KONTINGENT,
        gesamt: TOKEN_KONTINGENT,
        erschoepft: false,
        monat: new Date().toISOString().slice(0, 7),
      },
    });
  });

  test.skipIf(!haveBwrap())("während eines Laufs: `laeuft:true` mit derselben Kennung", async () => {
    const s = laufImHintergrund("warten") as { ok: true; laufId: string };
    const r = await ruf("GET", "/edit/agent/status", { cookie: cookie() });
    const körper = (await r.json()) as { laeuft: boolean; laufId: string };
    expect(körper.laeuft).toBe(true);
    expect(körper.laufId).toBe(s.laufId);
    brichAb(siteDir);
  }, 30_000);
});

// ===========================================================================
// POST /edit/agent/abort
// ===========================================================================
describe("POST /edit/agent/abort", () => {
  test("ohne laufenden Lauf: 200, idempotent", async () => {
    for (let i = 0; i < 2; i++) {
      const r = await ruf("POST", "/edit/agent/abort", { cookie: cookie() });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    }
  });

  test.skipIf(!haveBwrap())("nach dem Abbruch gibt POST /edit/agent wieder 200, nicht 409", async () => {
    // Der Weg, den der Kunde wirklich geht: abbrechen, dann neu formulieren.
    // Bliebe der Lauf in der Registratur stehen, bekäme er hier für immer 409 —
    // „Es läuft bereits ein Auftrag", obwohl nichts läuft. Eine Website, die
    // sich nur durch einen Dienst-Neustart wieder öffnen lässt.
    expect(laufImHintergrund("warten").ok).toBe(true);
    expect((await ruf("POST", "/edit/agent/abort", { cookie: cookie() })).status).toBe(200);
    for (let i = 0; i < 1200 && laufAktiv(siteDir) !== null; i++) await Bun.sleep(50);
    expect(laufAktiv(siteDir)).toBeNull();

    const r = await ruf("POST", "/edit/agent", { cookie: cookie(), body: { auftrag: "harmlos" } });
    expect(`${r.status}: ${JSON.stringify(await r.json())}`).toContain("200");
    brichAb(siteDir);
  }, 90_000);

  test.skipIf(!haveBwrap())("beendet einen laufenden Auftrag", async () => {
    expect(laufImHintergrund("warten").ok).toBe(true);
    expect((await ruf("POST", "/edit/agent/abort", { cookie: cookie() })).status).toBe(200);

    // Großzügig: Einzeln gemessen sind es 51 ms. In der VOLLEN Suite wurde
    // dieser Fall vereinzelt auch nach 60 s nicht ruhig — nachweislich nicht
    // wegen verschluckter Signale (SIGTERM auf ein bwrap-Kind wirkt in jeder
    // gemessenen Verzögerung) und nicht wegen offener Dateideskriptoren. Wer
    // das rot sieht, bekommt hier die Zahlen mit, statt raten zu müssen.
    const begonnen = Date.now();
    for (let i = 0; i < 1200 && laufAktiv(siteDir) !== null; i++) await Bun.sleep(50);
    if (laufAktiv(siteDir) !== null) {
      const bwrap = Bun.spawnSync(["pgrep", "-c", "bwrap"]).stdout.toString().trim();
      throw new Error(
        `Der Lauf war nach ${Date.now() - begonnen} ms noch aktiv. ` +
          `Laufende bwrap-Prozesse: ${bwrap}. siteDir=${siteDir}`,
      );
    }
    expect(laufAktiv(siteDir)).toBeNull();
  }, 90_000);
});

// ===========================================================================
// GET /edit/agent/events — gegen einen ECHTEN Server
// ===========================================================================
interface SseRahmen {
  event: string;
  data: string;
}

/** Zerlegt einen Puffer in fertige SSE-Rahmen und den unfertigen Rest. */
function zerlegeSse(puffer: string): { rahmen: SseRahmen[]; rest: string } {
  const teile = puffer.split(/\r?\n\r?\n/);
  const rest = teile.pop() ?? "";
  const rahmen: SseRahmen[] = [];
  for (const roh of teile) {
    if (!roh.trim()) continue;
    let event = "message";
    const daten: string[] = [];
    for (const zeile of roh.split(/\r?\n/)) {
      if (zeile.startsWith("event:")) event = zeile.slice(6).trim();
      else if (zeile.startsWith("data:")) daten.push(zeile.slice(5).trimStart());
    }
    rahmen.push({ event, data: daten.join("\n") });
  }
  return { rahmen, rest };
}

/**
 * Liest den Strom bis zum Ende. Das Zeitlimit hängt am `fetch`-Signal, nicht an
 * einem `Promise.race`: Nur so bricht ein bereits laufendes `await` auf den
 * nächsten Block wirklich ab — sonst bliebe die Verbindung offen und der
 * Testlauf hinge, statt rot zu werden.
 */
async function liesSse(url: string, kopf: Record<string, string>, msLimit = 20_000): Promise<SseRahmen[]> {
  const ac = new AbortController();
  const uhr = setTimeout(() => ac.abort(new Error("SSE-Zeitlimit")), msLimit);
  try {
    const antwort = await fetch(url, { headers: kopf, signal: ac.signal });
    expect(antwort.headers.get("content-type")).toContain("text/event-stream");
    const raus: SseRahmen[] = [];
    let puffer = "";
    const dec = new TextDecoder();
    for await (const stueck of antwort.body as ReadableStream<Uint8Array>) {
      puffer += dec.decode(stueck, { stream: true });
      const { rahmen, rest } = zerlegeSse(puffer);
      puffer = rest;
      for (const r of rahmen) {
        raus.push(r);
        if (r.event === "fertig" || r.event === "fehler") return raus;
      }
    }
    return raus;
  } finally {
    clearTimeout(uhr);
  }
}

describe("GET /edit/agent/events (echter Server)", () => {
  /** Server mit betreiberweiter ki.json über $CREDENTIALS_DIRECTORY — wie unter systemd. */
  async function bootMitKi(ki: KiConfig | null) {
    const site = tmp("regoro-sse-site-");
    cpSync(REAL_SITE, site, { recursive: true });
    ensureRepo(site);
    await createAuthFile(site, [NUMMER]);
    process.env.RUNTIME_DIRECTORY = tmp("regoro-sse-run-");

    // Leeres Verzeichnis = keine Konfiguration. Das ist zuverlässiger als sich
    // darauf zu verlassen, dass /etc/regoro/ki.json auf der Testmaschine fehlt.
    const creds = tmp("regoro-sse-creds-");
    // Über schreibeKiConfig statt von Hand: Format und Rechte kommen dann aus
    // demselben Code wie in Produktion, und ein Formatwechsel bricht hier auf.
    if (ki !== null) schreibeKiConfig(ki, join(creds, "ki"));
    process.env.CREDENTIALS_DIRECTORY = creds;

    const versand = attrappenVersand();
    const { port } = startServer({ siteDir: site, repoRoot: site, port: 0, versand });
    const base = `http://localhost:${port}`;
    return { site, base, cookie: await meldeAn(base, NUMMER, versand) };
  }

  /** Ctx für eine der gebooteten Sites — um einen Lauf am HTTP-Weg vorbei zu starten. */
  function ctxFuer(site: string): host.HostCtx {
    return { repoRoot: site, siteDir: site, pageWhitelist: PAGES, auth: loadAuthFile(site), sitePrefix: "", ki: KI };
  }

  test("ohne ki.json bleibt die Route 404, auch angemeldet", async () => {
    const { base, cookie: c } = await bootMitKi(null);
    const r = await fetch(`${base}/edit/agent/status`, { headers: { cookie: c } });
    expect(r.status).toBe(404);
    await r.text();
  });

  test("ohne laufenden Auftrag: sofort ein fehler-Ereignis, dann Ende", async () => {
    // Kein Hängenlassen: Der Browser soll den Strom nicht offen halten, wenn es
    // nichts zu senden gibt.
    const { base, cookie: c } = await bootMitKi(KI);
    const rahmen = await liesSse(`${base}/edit/agent/events`, { cookie: c }, 5_000);
    expect(rahmen).toHaveLength(1);
    expect(rahmen[0]!.event).toBe("fehler");
    expect(JSON.parse(rahmen[0]!.data)).toEqual({ grund: "Kein Lauf aktiv." });
  }, 15_000);

  test.skipIf(!haveBwrap())("ein Lauf wird als Ereignisfolge ausgeliefert und endet mit fertig", async () => {
    const { site, base, cookie: c } = await bootMitKi(KI);
    // Den Lauf über die echte Route starten — mit der Attrappe als Worker.
    const gestartet = starteLauf(ctxFuer(site), "harmlos", {
      workerBefehl: [process.execPath, "run", ATTRAPPE],
    });
    expect(gestartet.ok).toBe(true);

    const rahmen = await liesSse(`${base}/edit/agent/events`, { cookie: c });
    const namen = rahmen.map((r) => r.event);
    expect(namen).toContain("werkzeug");
    expect(namen).toContain("tokens");
    expect(namen.at(-1)).toBe("fertig");

    const fertig = JSON.parse(rahmen.at(-1)!.data) as { zusammenfassung: string; dateien: string[]; commit: string };
    expect(fertig.dateien).toEqual(["leistungen.html"]);
    expect(fertig.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(existsSync(join(site, "leistungen.html"))).toBe(true);
  }, 40_000);

  test.skipIf(!haveBwrap())("ein Lauf ohne Änderung liefert dateien:[] und commit:null im Rahmen", async () => {
    // Die Seitenleiste liest den RAHMEN, nicht das interne Ereignis. Sie kann
    // „hat etwas geändert" von „hat nichts geändert" nur an diesen zwei Feldern
    // unterscheiden — meldet sie hier grün samt „Seite neu laden", sucht der
    // Kunde eine Änderung, die es nicht gibt.
    const { site, base, cookie: c } = await bootMitKi(KI);
    starteLauf(ctxFuer(site), "nichts-tun", { workerBefehl: [process.execPath, "run", ATTRAPPE] });

    const rahmen = await liesSse(`${base}/edit/agent/events`, { cookie: c });
    expect(rahmen.at(-1)!.event).toBe("fertig");
    const fertig = JSON.parse(rahmen.at(-1)!.data) as { dateien: string[]; commit: string | null };
    expect(fertig.dateien).toEqual([]);
    expect(fertig.commit).toBeNull();
  }, 40_000);

  test.skipIf(!haveBwrap())("Kontingent reißt mitten im Lauf: erst Arbeit, dann Abbruch", async () => {
    // Der Übergang, den die Seitenleiste zeigen muss: Sie hat gerade noch
    // „schreibt leistungen.html" angezeigt und muss daraus eine Fehlerblase UND
    // eine Kontingentzeile auf „aufgebraucht" machen. Beides hängt daran, dass
    // der Strom die Arbeit VOR dem Abbruch ausliefert — käme nur der Fehler,
    // stünde die Leiste ohne Zusammenhang da.
    const { site, base, cookie: c } = await bootMitKi(KI);
    starteLauf(ctxFuer(site), "kontingent-sprengen", { workerBefehl: [process.execPath, "run", ATTRAPPE] });

    const rahmen = await liesSse(`${base}/edit/agent/events`, { cookie: c });
    const namen = rahmen.map((r) => r.event);
    expect(namen).toContain("werkzeug");
    expect(namen).toContain("tokens");
    expect(namen.at(-1)).toBe("fehler");

    // `frei` wird nie negativ. Sonst stünde in der Leiste „noch −1.799.999.999
    // Token" — der Deckel ist überschritten, nicht ins Gegenteil verkehrt.
    for (const r of rahmen.filter((x) => x.event === "tokens")) {
      expect(JSON.parse(r.data).frei).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.parse(rahmen.at(-1)!.data).grund).toMatch(/[a-zäöüß]{4,}/i);
    // Und nichts davon ist in der Website gelandet.
    expect(existsSync(join(site, "leistungen.html"))).toBe(false);
  }, 60_000);

  test.skipIf(!haveBwrap())("ein abgelehnter Lauf endet mit fehler, nicht mit fertig", async () => {
    const { site, base, cookie: c } = await bootMitKi(KI);
    starteLauf(ctxFuer(site), "inline-skript", { workerBefehl: [process.execPath, "run", ATTRAPPE] });

    const rahmen = await liesSse(`${base}/edit/agent/events`, { cookie: c });
    expect(rahmen.at(-1)!.event).toBe("fehler");
    expect(JSON.parse(rahmen.at(-1)!.data)).toHaveProperty("grund");
    expect(existsSync(join(site, "leistungen.html"))).toBe(false);
  }, 40_000);

  // =========================================================================
  // Kein Schlüsselwort darf roh im Chatfenster landen
  // =========================================================================
  /**
   * Die Vollständigkeit der Übersetzungstabelle prüft `fehlertexte.test.ts` —
   * gründlicher, als ich es hier könnte (auch Vorlagen-Gründe wie
   * `symlink:${pfad}` und tote Fälle). Hier steht deshalb nur, was dort NICHT
   * geht: was der Kunde am ENDE DER LEITUNG wirklich zu sehen bekommt, über
   * den echten Server, auf den zwei Wegen, die er tatsächlich geht.
   *
   * Beides ist nötig. Ein vollständiger Tabellen-Abgleich sagt nichts darüber,
   * ob die Antwort auch durch `sseRahmen` bis in den Browser kommt; ein
   * Leitungstest deckt nur die Gründe ab, die er auslösen kann.
   */
  /** Ein roher Schlüssel: klein, mit Bindestrich, ohne Leerzeichen und Satzzeichen. */
  const istSchluessel = (text: string): boolean => /^[a-z]+(-[a-z]+)*$/.test(text.trim());

  test.skipIf(!haveBwrap())("ein abgebrochener Lauf zeigt einen Satz, kein Schlüsselwort", async () => {
    // Der häufigste Abbruch überhaupt: Der Kunde drückt auf „Abbrechen".
    const { site, base, cookie: c } = await bootMitKi(KI);
    starteLauf(ctxFuer(site), "warten", { workerBefehl: [process.execPath, "run", ATTRAPPE] });
    await Bun.sleep(300);
    brichAb(site);

    const rahmen = await liesSse(`${base}/edit/agent/events`, { cookie: c });
    const grund = JSON.parse(rahmen.at(-1)!.data).grund as string;
    expect(`${grund}`).not.toBe("abgebrochen");
    expect(istSchluessel(grund)).toBe(false);
  }, 40_000);

  test.skipIf(!haveBwrap())("`regoro disable` mitten im Lauf zeigt ebenfalls einen Satz", async () => {
    // Der Zuhörer hängt VORHER dran — anders geht es gar nicht: `regoro disable`
    // schließt die Route sofort (Kill-Switch), eine neue Verbindung bekäme 404.
    // Genau so sieht es der Kunde: Seine Seitenleiste ist offen und läuft,
    // während der Betreiber den Zugang entzieht.
    const { site, base, cookie: c } = await bootMitKi(KI);
    starteLauf(ctxFuer(site), "warten", { workerBefehl: [process.execPath, "run", ATTRAPPE] });

    const antwort = await fetch(`${base}/edit/agent/events`, { headers: { cookie: c } });
    expect(antwort.headers.get("content-type")).toContain("text/event-stream");
    const leser = (antwort.body as ReadableStream<Uint8Array>).getReader();
    await leser.read(); // ": verbunden"

    rmSync(join(site, ".regoro"), { recursive: true, force: true });

    let puffer = "";
    const dec = new TextDecoder();
    for (let i = 0; i < 40 && !puffer.includes("event: fehler"); i++) {
      const { value, done } = await leser.read();
      if (done) break;
      puffer += dec.decode(value, { stream: true });
    }
    const { rahmen } = zerlegeSse(puffer);
    const letzter = rahmen.at(-1);
    expect(letzter?.event).toBe("fehler");
    const grund = JSON.parse(letzter!.data).grund as string;
    expect(`${grund}`).not.toBe("abgeschaltet");
    expect(istSchluessel(grund)).toBe(false);
    await leser.cancel();
  }, 40_000);

  test("unangemeldet liefert die Ereignisroute 404 und keinen Strom", async () => {
    const { base } = await bootMitKi(KI);
    const r = await fetch(`${base}/edit/agent/events`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type") ?? "").not.toContain("event-stream");
    await r.text();
  });

  // =========================================================================
  // §13.21 — der Strom muss SOFORT ein Byte senden
  // =========================================================================
  test("beim Verbinden kommt sofort `: verbunden`, nicht erst mit dem ersten Ereignis", async () => {
    // GEMESSEN (caddy 2.11.4, erstes Ereignis nach 4 s): direkt am Upstream
    // 0,0003 s bis zum ersten Byte, durch Caddy 4,00 s — und `flush_interval -1`
    // ändert daran NICHTS. Gepuffert wird nicht der Körper, sondern die
    // ANTWORT-HEADER: Go gibt sie erst mit dem ersten Körper-Byte heraus.
    //
    // Folge ohne diesen Kommentar: `onopen` feuert im Browser erst beim ersten
    // echten Ereignis. Bei einem Agentenlauf sind das Minuten, in denen die
    // Seitenleiste leer steht und jede Zwischenstation die Verbindung für tot
    // halten darf. §13.14 („erst der Puffer, dann der Live-Strom") deckt das
    // NICHT ab — ein frischer Lauf hat einen leeren Puffer, und genau dann
    // greift das Problem.
    const { site, base, cookie: c } = await bootMitKi(KI);
    // „stumm" sendet acht Sekunden lang GAR NICHTS — wie ein Modell, das erst
    // nachdenkt. Nur so ist die Frage überhaupt eine Frage: ein Szenario, das
    // gleich etwas sendet, beantwortet sie versehentlich mit ja.
    starteLauf(ctxFuer(site), "stumm", { workerBefehl: [process.execPath, "run", ATTRAPPE] });

    const ac = new AbortController();
    const uhr = setTimeout(() => ac.abort(new Error("kein erstes Byte")), 5_000);
    try {
      const antwort = await fetch(`${base}/edit/agent/events`, { headers: { cookie: c }, signal: ac.signal });
      const leser = (antwort.body as ReadableStream<Uint8Array>).getReader();
      const begonnen = Date.now();
      const { value } = await leser.read();
      const dauer = Date.now() - begonnen;

      expect(new TextDecoder().decode(value)).toContain(": verbunden");
      // Großzügig: es geht um „sofort" gegen „erst beim ersten Ereignis" (nie).
      expect(dauer).toBeLessThan(2_000);
      await leser.cancel();
    } finally {
      clearTimeout(uhr);
      brichAb(site);
    }
  }, 30_000);

  // =========================================================================
  // §13.14 — der Lauf gehört der Website, nicht der HTTP-Anfrage
  // =========================================================================
  describe.skipIf(!haveBwrap())("der Ereignisstrom ist ein Fenster, kein Besitzer", () => {
    test("ein abgebrochener Strom beendet den Lauf NICHT", async () => {
      // Ein versehentlicher Reload wäre sonst ein Abbruchknopf — und der Kunde
      // verlöre Arbeit, deren Kontingent bereits gebucht ist.
      const { site, base, cookie: c } = await bootMitKi(KI);
      starteLauf(ctxFuer(site), "warten", { workerBefehl: [process.execPath, "run", ATTRAPPE] });

      const erste = await fetch(`${base}/edit/agent/events`, { headers: { cookie: c } });
      const leser = (erste.body as ReadableStream<Uint8Array>).getReader();
      await leser.read();
      await leser.cancel(); // Tab zu

      await Bun.sleep(300);
      const status = (await (await fetch(`${base}/edit/agent/status`, { headers: { cookie: c } })).json()) as {
        laeuft: boolean;
      };
      expect(status.laeuft).toBe(true);
      expect(laufAktiv(site)).not.toBeNull();
      brichAb(site);
    }, 30_000);

    test("ein zweites /events auf denselben Lauf bekommt erst den Puffer, dann den Live-Strom", async () => {
      // Der Reload-Fall: Der Kunde lädt die Seite neu, während der Agent noch
      // arbeitet. Ohne Puffer sähe er ein leeres Chatfenster und hielte den Lauf
      // für verloren — obwohl sein Kontingent längst gebucht ist.
      const { site, base, cookie: c } = await bootMitKi(KI);
      starteLauf(ctxFuer(site), "warten", { workerBefehl: [process.execPath, "run", ATTRAPPE] });

      // Erster Zuhörer sieht das Ereignis und geht weg (Tab zu).
      const erste = await fetch(`${base}/edit/agent/events`, { headers: { cookie: c } });
      const leser = (erste.body as ReadableStream<Uint8Array>).getReader();
      let gesehen = "";
      for (let i = 0; i < 5 && !gesehen.includes("arbeite"); i++) {
        gesehen += new TextDecoder().decode((await leser.read()).value);
      }
      expect(gesehen).toContain("arbeite"); // Voraussetzung: es gab etwas zu sehen
      await leser.cancel();

      // Zweiter Zuhörer, frisch verbunden: Er muss das Verpasste nachgeliefert
      // bekommen, nicht bei null anfangen.
      const zweite = await fetch(`${base}/edit/agent/events`, { headers: { cookie: c } });
      const leser2 = (zweite.body as ReadableStream<Uint8Array>).getReader();
      let nachgeliefert = "";
      for (let i = 0; i < 5 && !nachgeliefert.includes("arbeite"); i++) {
        nachgeliefert += new TextDecoder().decode((await leser2.read()).value);
      }
      expect(nachgeliefert).toContain("arbeite");
      await leser2.cancel();
      brichAb(site);
    }, 40_000);

    test("ein beendeter Lauf liefert seine Zusammenfassung noch einmal aus", async () => {
      // §13.33. §13.14 löst den Reload-Fall nur BIS `fertig`. Verlässt der Lauf
      // die Registratur in dem Moment, in dem er fertig wird, bekommt ein danach
      // verbundenes /events „Kein Lauf aktiv." — und der Kunde verliert
      // Zusammenfassung und Dateiliste durch genau den versehentlichen Reload,
      // gegen den §13.14 antritt. Schlimmer noch: Er sieht nicht, DASS etwas
      // passiert ist, während seine Website sich längst geändert hat.
      const { site, base, cookie: c } = await bootMitKi(KI);
      starteLauf(ctxFuer(site), "harmlos", { workerBefehl: [process.execPath, "run", ATTRAPPE] });

      const zuerst = await liesSse(`${base}/edit/agent/events`, { cookie: c });
      expect(zuerst.at(-1)!.event).toBe("fertig");
      expect(laufAktiv(site)).toBeNull(); // der Lauf IST vorbei

      // Und jetzt der Reload, nachdem alles gelaufen ist.
      const danach = await liesSse(`${base}/edit/agent/events`, { cookie: c }, 5_000);
      expect(danach.map((r) => r.event)).toContain("werkzeug");
      expect(danach.at(-1)!.event).toBe("fertig");

      const fertig = JSON.parse(danach.at(-1)!.data) as { dateien: string[]; commit: string };
      expect(fertig.dateien).toEqual(["leistungen.html"]);
      expect(fertig.commit).toMatch(/^[0-9a-f]{7,40}$/);
    }, 40_000);

    test("auch ein gescheiterter Lauf bleibt nachlesbar", async () => {
      // Gerade hier zählt es: Wer nach einem Reload nichts sieht, versucht es
      // noch einmal — und bezahlt denselben misslungenen Lauf ein zweites Mal.
      const { site, base, cookie: c } = await bootMitKi(KI);
      starteLauf(ctxFuer(site), "inline-skript", { workerBefehl: [process.execPath, "run", ATTRAPPE] });

      expect((await liesSse(`${base}/edit/agent/events`, { cookie: c })).at(-1)!.event).toBe("fehler");

      const danach = await liesSse(`${base}/edit/agent/events`, { cookie: c }, 5_000);
      expect(danach.at(-1)!.event).toBe("fehler");
      // Und zwar mit dem ECHTEN Grund, nicht mit „Kein Lauf aktiv.".
      expect(JSON.parse(danach.at(-1)!.data).grund).not.toBe("Kein Lauf aktiv.");
    }, 40_000);

    test("ohne je einen Lauf bleibt es bei „Kein Lauf aktiv.“", async () => {
      // Die Gegenprobe: Das Nachreichen darf nicht dazu führen, dass eine frisch
      // geladene Seitenleiste einen fremden oder erfundenen Lauf anzeigt.
      const { base, cookie: c } = await bootMitKi(KI);
      const rahmen = await liesSse(`${base}/edit/agent/events`, { cookie: c }, 5_000);
      expect(rahmen).toHaveLength(1);
      expect(JSON.parse(rahmen[0]!.data)).toEqual({ grund: "Kein Lauf aktiv." });
    }, 15_000);

    test("zwei gleichzeitige Zuhörer sehen beide dieselbe Folge", async () => {
      const { site, base, cookie: c } = await bootMitKi(KI);
      starteLauf(ctxFuer(site), "harmlos", { workerBefehl: [process.execPath, "run", ATTRAPPE] });

      const [a, b] = await Promise.all([
        liesSse(`${base}/edit/agent/events`, { cookie: c }),
        liesSse(`${base}/edit/agent/events`, { cookie: c }),
      ]);
      expect(a.at(-1)!.event).toBe("fertig");
      expect(b.at(-1)!.event).toBe("fertig");
      expect(a.map((r) => r.event)).toEqual(b.map((r) => r.event));
    }, 40_000);

    test("abgebrochen wird ausschließlich über POST /edit/agent/abort", async () => {
      const { site, base, cookie: c } = await bootMitKi(KI);
      starteLauf(ctxFuer(site), "warten", { workerBefehl: [process.execPath, "run", ATTRAPPE] });

      const r = await fetch(`${base}/edit/agent/abort`, { method: "POST", headers: { cookie: c } });
      expect(r.status).toBe(200);
      await r.text();

      for (let i = 0; i < 1200 && laufAktiv(site) !== null; i++) await Bun.sleep(50);
      expect(laufAktiv(site)).toBeNull();
    }, 90_000);

    test("der Lauf überlebt einen Strom, der nie gelesen wird", async () => {
      // `Bun.serve` beendet jeden Strom nach `idleTimeout` (Vorgabe 10 s ohne
      // Bytes). Ein Agentenlauf schweigt minutenlang — ohne `server.timeout(req, 0)`
      // risse der SSE-Strom reproduzierbar, und der Kunde sähe einen Abbruch,
      // wo nur nachgedacht wurde.
      const { site, base, cookie: c } = await bootMitKi(KI);
      starteLauf(ctxFuer(site), "warten", { workerBefehl: [process.execPath, "run", ATTRAPPE] });

      const antwort = await fetch(`${base}/edit/agent/events`, { headers: { cookie: c } });
      const leser = (antwort.body as ReadableStream<Uint8Array>).getReader();
      await leser.read(); // ": verbunden"

      // Länger als die Bun-Vorgabe stillhalten und danach prüfen, dass der Strom
      // noch lebt: ein geschlossener Strom liefert `done: true`.
      await Bun.sleep(12_000);
      expect(laufAktiv(site)).not.toBeNull();
      const weiter = await Promise.race([
        leser.read().then((r) => (r.done ? "zu" : "offen")),
        Bun.sleep(1_500).then(() => "offen" as const),
      ]);
      expect(weiter).toBe("offen");
      await leser.cancel();
      brichAb(site);
    }, 40_000);
  });
});
