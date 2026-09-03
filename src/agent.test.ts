/**
 * `agent.ts` — der Ablauf eines Laufs: Protokoll, Zustand, Abbruch, Aufräumen.
 *
 * Abgegrenzt gegen die Nachbardateien:
 *   - `agent-isolation.test.ts` fragt „was kommt in der Website an?"
 *   - `agent-routes.test.ts`    fragt „was antwortet HTTP?"
 *   - hier steht dazwischen: „was tut der Elternprozess mit dem Worker?"
 *
 * Auch hier ist der Worker eine Attrappe (`agent-worker.attrappe.ts`) und
 * **kein Test stellt je eine Modell-, Such- oder sonstige Netzanfrage.** Die
 * Recherche wird bewusst mit `braveKey: null` gefahren: Dann antwortet der
 * Elternprozess fail-closed, die Antwortstrecke ist trotzdem vollständig
 * durchlaufen — und es geht garantiert nichts hinaus.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_DIR_NAME, createAuthFile } from "./auth.ts";
import type { KiConfig } from "./betreiber-config.ts";
import { countCommits, ensureRepo } from "./git.ts";
import type { HostCtx } from "./host.ts";
import { bwrapPfad } from "./sandbox.ts";
import { brichAb, ereignisse, laufAktiv, starteLauf, type AgentEreignis } from "./agent.ts";
import { pruefeKontingent, verbucheTokens, TOKEN_KONTINGENT } from "./kontingent.ts";
import { startServer } from "./server.ts";
import { attrappenVersand } from "./versand.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");
const ATTRAPPE = join(import.meta.dir, "agent-worker.attrappe.ts");
const NUMMER = "+4915120464812";
const PAGES = ["index.html", "impressum.html", "datenschutz.html", "agb.html"];

/**
 * braveKey null: keine Websuche eingerichtet → fail-closed statt Netzanfrage.
 * Der Schlüssel ist offensichtlich unecht, die baseUrl zeigt ins Leere.
 */
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

const dirs: string[] = [];
afterAll(() => {
  // ERST abbrechen, DANN löschen. Ein „warten"-Arbeiter schläft zehn Minuten;
  // ohne diese Zeile überlebt er den Testlauf, hält sein bwrap samt PID- und
  // Mount-Namespace und verlangsamt jeden folgenden Lauf messbar — gemessen
  // brauchte ein Abbruch danach über 60 s statt 51 ms. `brichAb` ist auf einer
  // Site ohne Lauf ein no-op, die Schleife darf also über alle gehen.
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
let runtime: string;
let ctx: HostCtx;
let commitsVorher: number | null;

beforeEach(async () => {
  siteDir = tmp("regoro-agent-site-");
  cpSync(REAL_SITE, siteDir, { recursive: true });
  ensureRepo(siteDir);
  await createAuthFile(siteDir, [NUMMER]);
  runtime = tmp("regoro-agent-run-");
  commitsVorher = countCommits(siteDir);
  process.env.RUNTIME_DIRECTORY = runtime;
  ctx = { repoRoot: siteDir, siteDir, pageWhitelist: PAGES, auth: null, sitePrefix: "", ki: KI };
});

function start(auftrag: string) {
  return starteLauf(ctx, auftrag, { workerBefehl: [process.execPath, "run", ATTRAPPE] });
}

async function sammle(): Promise<AgentEreignis[]> {
  const raus: AgentEreignis[] = [];
  for await (const e of ereignisse(siteDir)) raus.push(e);
  return raus;
}

const text = (e: AgentEreignis[]): string =>
  e.filter((x) => x.t === "text").map((x) => (x as { inhalt: string }).inhalt).join("\n");

/**
 * Wartet, bis kein Lauf mehr registriert ist — zum Aufräumen nach `brichAb`.
 *
 * Bewusst eine Abfrage statt `await sammle()`: Wer den Ereignisstrom leerliest,
 * um „ist er weg?" zu beantworten, hängt an der Zeit, die ein bwrap-Kind zum
 * Sterben braucht. Unter Last (die volle Suite startet Dutzende) waren das
 * gemessen mehr als 30 s, und der Test sah nach einem Fehler aus, wo nur der
 * Rechner beschäftigt war. Ein flatternder Test ist schlimmer als keiner.
 */
async function warteBisRuhig(site: string, msLimit = 60_000): Promise<void> {
  const ende = Date.now() + msLimit;
  while (laufAktiv(site) !== null && Date.now() < ende) await Bun.sleep(50);
  expect(laufAktiv(site)).toBeNull();
}

// ===========================================================================
// JSONL-Protokoll (Contract §6) → Ereignisstrom (Contract §7)
// ===========================================================================
describe.skipIf(!haveBwrap())("das Worker-Protokoll", () => {
  test("Werkzeug, Token und Abschluss kommen in dieser Reihenfolge an", async () => {
    expect(start("harmlos").ok).toBe(true);
    const e = await sammle();

    const arten = e.map((x) => x.t);
    expect(arten).toContain("werkzeug");
    expect(arten).toContain("tokens");
    expect(arten.at(-1)).toBe("fertig");
    // Der Strom endet nach `fertig` — kein Nachklapp (Contract §7).
    expect(arten.filter((a) => a === "fertig" || a === "fehler")).toHaveLength(1);

    const werkzeug = e.find((x) => x.t === "werkzeug") as { name: string; kurz: string };
    expect(werkzeug.name).toBe("write_file");
    expect(werkzeug.kurz).toContain("leistungen.html");
  }, 30_000);

  test("das tokens-Ereignis trägt Verbrauch UND Restkontingent", async () => {
    // Die Seitenleiste zeigt „noch X von 200.000". Käme nur `gesamt`, müsste sie
    // selbst rechnen — und rechnete beim Monatswechsel falsch.
    expect(start("harmlos").ok).toBe(true);
    const e = await sammle();
    const tok = e.find((x) => x.t === "tokens") as { gesamt: number; frei: number };
    expect(tok.gesamt).toBe(1234);
    expect(tok.frei).toBe(TOKEN_KONTINGENT - 1234);
  }, 30_000);

  test("eine Frage des Workers wird vom ELTERNPROZESS beantwortet", async () => {
    // Invariante 11: Der Worker hat kein Netzwerkzeug. Er fragt, der Eltern-
    // prozess antwortet. Ohne eingerichtete Websuche fällt die Antwort negativ
    // aus — die Strecke ist trotzdem vollständig gelaufen, und es ging nichts
    // hinaus. Genau das ist hier gewollt: der Beweis ohne Netz.
    expect(start("frage-suche").ok).toBe(true);
    const e = await sammle();

    const antwort = JSON.parse(text(e).replace(/^antwort:/, "")) as { id: number; ok: boolean; fehler?: string };
    expect(antwort.id).toBe(1);
    expect(antwort.ok).toBe(false);
    expect(antwort.fehler).toMatch(/[a-zäöüß]{4,}/i); // deutscher Klartext
  }, 30_000);

  test("stderr des Workers geht ins Log, nie in den Ereignisstrom", async () => {
    // Die Attrappe schreibt auf stderr, was sie geschrieben hat — samt Pfaden
    // aus der Arbeitskopie. Landete das im Strom, sähe der Kunde interne
    // Serverpfade im Browser.
    expect(start("harmlos").ok).toBe(true);
    const e = await sammle();
    expect(JSON.stringify(e)).not.toContain("[attrappe]");
    expect(JSON.stringify(e)).not.toContain(runtime);
  }, 30_000);

  test("ein Lauf, der nichts ändert, ist als solcher erkennbar", async () => {
    // Das kommt in Wirklichkeit oft vor: Das Modell liest die Website, hält den
    // Wunsch für schon erfüllt und meldet fertig. Für den Elternprozess ist das
    // ein Erfolg — für den Kunden nicht, und die Seitenleiste kann die beiden
    // nur an DIESEN zwei Feldern auseinanderhalten.
    //
    // Ohne die Zusicherung meldet sie grün „fertig!" für eine Website, an der
    // sich nichts geändert hat, samt „Seite neu laden" für nichts. Das ist
    // schlimmer als eine Fehlermeldung: Der Kunde sucht die Änderung.
    expect(start("nichts-tun").ok).toBe(true);
    const e = await sammle();

    const f = e.at(-1) as { t: string; dateien: string[]; commit: string | null };
    expect(f.t).toBe("fertig");
    expect(f.dateien).toEqual([]);
    expect(f.commit).toBeNull();
    expect(countCommits(siteDir)).toBe(commitsVorher); // und wirklich kein Commit
  }, 30_000);

  test("ein `fertig` OHNE abschließenden Zeilenumbruch geht nicht verloren", async () => {
    // DER SCHADEN: Der Kunde bekommt einen GELUNGENEN Lauf als gescheitert
    // gemeldet. Seine Website ist geändert, die Seitenleiste sagt das Gegenteil
    // — er versucht es noch einmal und bezahlt denselben Lauf zweimal.
    //
    // Die Leseschleife zerteilt an "\n" und verwirft, was danach ohne Umbruch
    // im Puffer steht. Ein Prozess muss seinen letzten Umbruch nicht schreiben.
    expect(start("ohne-umbruch").ok).toBe(true);
    const e = await sammle();

    expect(e.map((x) => x.t)).toContain("werkzeug"); // die Zeile MIT Umbruch kam an
    expect(e.at(-1)?.t).toBe("fertig"); // und die ohne auch
    expect(existsSync(join(siteDir, "leistungen.html"))).toBe(true); // und wurde übernommen
  }, 30_000);

  test("unverständliche Zeilen bringen den Lauf nicht zum Absturz", async () => {
    // Der Worker ist der unsicherste Teil des Systems und sein stdout ist
    // Eingabe. Ein `JSON.parse` ohne Netz darum wäre ein Serverabsturz,
    // ausgelöst von genau diesem Teil.
    //
    // Das Szenario steckt in der ATTRAPPE, nicht in einem Skript unter /tmp:
    // `agent.ts` deckelt `dirname(ctx.siteDir)` — in Tests ist das ganz `/tmp`,
    // und ein Helferskript dort ist für den Worker unsichtbar. Ein Test, der es
    // trotzdem versucht, bekommt „Module not found", einen `fehler` — und ist
    // grün, wenn er nur „endet mit fertig ODER fehler" verlangt. Genau so stand
    // er hier, und er hat den geprüften Pfad nie betreten.
    expect(start("kaputte-zeile").ok).toBe(true);
    const e = await sammle();

    expect(e.at(-1)?.t).toBe("fertig"); // NICHT bloß „fertig oder fehler"
    expect(e.map((x) => x.t)).toContain("werkzeug"); // die guten Zeilen danach kamen an
    expect(existsSync(join(siteDir, "leistungen.html"))).toBe(true);
  }, 30_000);
});

// ===========================================================================
// Ein Lauf je Website
// ===========================================================================
describe.skipIf(!haveBwrap())("nur ein Lauf je Website", () => {
  test("während eines Laufs ist er sichtbar, danach nicht mehr", async () => {
    expect(laufAktiv(siteDir)).toBeNull();
    const s = start("harmlos");
    expect(s.ok).toBe(true);
    // Der Lauf beginnt mit `starteLauf`, nicht erst beim ersten `next()` — sonst
    // wäre zwischen POST /edit/agent und GET /edit/agent/events ein Fenster, in
    // dem ein zweiter Auftrag durchginge.
    expect(laufAktiv(siteDir)).toBe((s as { laufId: string }).laufId);
    await sammle();
    expect(laufAktiv(siteDir)).toBeNull();
  }, 30_000);

  test("ein zweiter Auftrag wird abgelehnt, der erste läuft weiter", async () => {
    expect(start("warten").ok).toBe(true);
    const zweiter = start("harmlos");
    expect(zweiter).toEqual({ ok: false, grund: "laeuft-bereits" });
    expect(laufAktiv(siteDir)).not.toBeNull();
    // Aufräumen, aber NICHT darauf warten: Gegenstand dieses Tests ist die
    // Ablehnung, nicht das Sterben eines Kindprozesses. Wer beides in einen
    // Test packt, bekommt unter Last einen roten Balken für die falsche Sache —
    // dass `brichAb` wirkt, steht im eigenen Test darunter.
    brichAb(siteDir);
  }, 30_000);

  test("zwei Websites laufen unabhängig voneinander", async () => {
    // Ein Prozess bedient alle Kunden (Invariante 10). Ein Zähler, der nicht
    // nach Site trennt, sperrte Kunde B aus, weil Kunde A gerade arbeitet.
    const zweite = tmp("regoro-agent-site2-");
    cpSync(REAL_SITE, zweite, { recursive: true });
    ensureRepo(zweite);
    await createAuthFile(zweite, [NUMMER]);
    const ctx2: HostCtx = { ...ctx, repoRoot: zweite, siteDir: zweite };

    expect(start("warten").ok).toBe(true);
    const b = starteLauf(ctx2, "harmlos", { workerBefehl: [process.execPath, "run", ATTRAPPE] });
    expect(b.ok).toBe(true);

    for await (const _ of ereignisse(zweite)) void _;
    expect(existsSync(join(zweite, "leistungen.html"))).toBe(true);
    brichAb(siteDir); // siehe oben: Aufräumen, keine Zusicherung
  }, 60_000);
});

// ===========================================================================
// Abbruch
// ===========================================================================
describe.skipIf(!haveBwrap())("Abbruch", () => {
  test("brichAb beendet den Lauf und übernimmt nichts", async () => {
    expect(start("warten").ok).toBe(true);
    await Bun.sleep(300);
    brichAb(siteDir);
    const e = await sammle();

    expect(e.at(-1)?.t).toBe("fehler");
    await warteBisRuhig(siteDir);
    expect(readdirSync(runtime).filter((n) => n.startsWith("lauf-"))).toEqual([]);
  }, 90_000);

  test("nach einem Abbruch nimmt die Website sofort wieder einen Auftrag an", async () => {
    // DER EIGENTLICHE SCHADEN eines hängenden Abbruchs — und er ist schlimmer
    // als der verschwendete Lauf: Bleibt der Eintrag in der Registratur stehen,
    // ist die Website DAUERHAFT gesperrt. Jeder weitere Auftrag prallt mit
    // "laeuft-bereits" ab, bis jemand den Dienst neu startet. Der Kunde sieht
    // eine Seitenleiste, die nie wieder etwas annimmt, und erfährt nicht warum.
    //
    // Gemessen war genau das der Fall: Der stdout-Strom endete nicht, wenn der
    // Prozess im Anlaufen getötet wurde, `for await` hing für immer, und die
    // Aufräumroutine lief nie.
    expect(start("warten").ok).toBe(true);
    await Bun.sleep(200);
    brichAb(siteDir);
    await warteBisRuhig(siteDir);

    // Und jetzt der Beweis, dass die Sperre wirklich weg ist: ein zweiter Lauf,
    // der auch durchläuft.
    const zweiter = start("harmlos");
    expect(zweiter).toEqual({ ok: true, laufId: expect.any(String) });
    const e = await sammle();
    expect(e.at(-1)?.t).toBe("fertig");
    expect(existsSync(join(siteDir, "leistungen.html"))).toBe(true);
  }, 90_000);

  test("auch ein SOFORT abgebrochener Lauf sperrt die Website nicht", async () => {
    // Der Fall, der es aufgedeckt hat: Abbruch, während der Worker noch anläuft.
    // Ohne Vorlauf trifft der Abbruch die heikelste Stelle.
    for (let i = 0; i < 3; i++) {
      expect(start("warten").ok).toBe(true);
      brichAb(siteDir);
      await warteBisRuhig(siteDir);
    }
    expect(start("harmlos").ok).toBe(true);
    expect((await sammle()).at(-1)?.t).toBe("fertig");
  }, 90_000);

  test("brichAb ohne laufenden Lauf ist folgenlos", () => {
    // Die Route ist idempotent (Contract §7). Ein Wurf hier ergäbe dort 500.
    expect(() => brichAb(siteDir)).not.toThrow();
    expect(() => brichAb(siteDir)).not.toThrow();
  });

  test("`regoro disable` während eines Laufs bricht ihn ab", async () => {
    // Der Betreiber entzieht den Zugang. Ein Lauf, der danach weiterschreibt,
    // liefe gegen genau die Entscheidung, die gerade getroffen wurde — und
    // kostete weiter Token.
    expect(start("warten").ok).toBe(true);
    await Bun.sleep(300);
    rmSync(join(siteDir, AUTH_DIR_NAME), { recursive: true, force: true });

    const e = await sammle();
    expect(e.at(-1)?.t).toBe("fehler");
    expect(laufAktiv(siteDir)).toBeNull();
  }, 30_000);
});

// ===========================================================================
// Kontingent
// ===========================================================================
describe.skipIf(!haveBwrap())("Kontingent", () => {
  test("ein gelungener Lauf wird verbucht", async () => {
    const vorher = pruefeKontingent(siteDir);
    expect(start("harmlos").ok).toBe(true);
    await sammle();
    const nachher = pruefeKontingent(siteDir);

    expect(nachher.tokens).toBe(vorher.tokens + 1234);
    expect(nachher.laeufe).toBe(vorher.laeufe + 1);
    expect(nachher.frei).toBe(vorher.frei - 1234);
  }, 30_000);

  test("auch ein gescheiterter Lauf wird verbucht — Token sind trotzdem weg", async () => {
    // Wer nur Erfolge verbucht, hat einen Freifahrtschein gebaut: Ein Lauf, der
    // absichtlich am Validator scheitert, kostet dieselben Token und zählte nie.
    const vorher = pruefeKontingent(siteDir);
    expect(start("inline-skript").ok).toBe(true);
    await sammle();
    expect(pruefeKontingent(siteDir).laeufe).toBe(vorher.laeufe + 1);
  }, 30_000);

  test("ein erschöpftes Kontingent lässt gar keinen Lauf beginnen", async () => {
    verbucheTokens(siteDir, TOKEN_KONTINGENT + 1);
    expect(pruefeKontingent(siteDir).erschoepft).toBe(true);

    expect(start("harmlos")).toEqual({ ok: false, grund: "kontingent" });
    expect(existsSync(join(siteDir, "leistungen.html"))).toBe(false);
    expect(readdirSync(runtime).filter((n) => n.startsWith("lauf-"))).toEqual([]);
  });
});

// ===========================================================================
// Serverneustart
// ===========================================================================
describe("Serverneustart während eines Laufs", () => {
  test("verwaiste Arbeitskopien räumt der Serverstart weg", async () => {
    // `--die-with-parent` beendet den Worker (siehe sandbox.test.ts) — sein
    // Verzeichnis unter RUNTIME_DIRECTORY bleibt aber liegen. Ohne diesen
    // Schritt füllt sich /run über die Wochen, bis kein Lauf mehr startet.
    const verwaist = join(runtime, "lauf-11111111-2222-3333-4444-555555555555");
    mkdirSync(join(verwaist, "assets"), { recursive: true });
    writeFileSync(join(verwaist, "index.html"), "<p>Rest eines abgestürzten Laufs</p>");
    const fremd = join(runtime, "nicht-von-uns");
    mkdirSync(fremd, { recursive: true });

    startServer({ siteDir, repoRoot: siteDir, port: 0, versand: attrappenVersand() });

    expect(existsSync(verwaist)).toBe(false);
    // Nur `lauf-*` — RUNTIME_DIRECTORY kann in Produktion noch anderes tragen.
    expect(existsSync(fremd)).toBe(true);
  });
});
