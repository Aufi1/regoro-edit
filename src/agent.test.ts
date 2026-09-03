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
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { verlaufDir } from "./verlauf.ts";
import { STANDARD_CONTEXT_WINDOW, leereModellCache } from "./modell-info.ts";

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

  describe("die Verbindung zur Recherche — nicht die Recherche selbst", () => {
    /**
     * WARUM DIESE TESTS EXISTIEREN. `recherche.test.ts` prüft `holeSeite` direkt,
     * mit siebzig Fällen, und war die ganze Zeit grün. Trotzdem bekam der Agent
     * bei JEDER Adresse „Der Zugang zum Seitenabruf wurde abgelehnt": Die
     * Aufrufstelle in `agent.ts` übergab nur ein Argument, `firecrawlKey` war
     * `undefined`, und weil `undefined !== ""` ist, ging `Authorization: Bearer
     * undefined` hinaus. Gegen die echte API gemessen: mit diesem Kopf 401,
     * ohne ihn 200.
     *
     * Der Prüfling war also richtig, die VERBINDUNG war ungeprüft. Deshalb
     * fahren diese Fälle den Weg, den der Agent wirklich nimmt — über das
     * Worker-Protokoll —, und nicht `holeSeite` von Hand.
     *
     * Und sie kommen ohne Netz aus: `holeSeite` prüft `firecrawlKey === null`
     * VOR der Zieladresse. Eine Loopback-Adresse trennt die beiden Fälle
     * deshalb sauber — „nicht eingerichtet" gegen „private Adresse gesperrt" —,
     * ohne dass je eine Anfrage hinausgeht.
     */
    async function frage(
      art: "frage-abruf" | "frage-suche" | "frage-suche-leer",
      kiTeil: Partial<KiConfig>,
    ): Promise<string> {
      ctx = { ...ctx, ki: { ...KI, ...kiTeil } };
      expect(start(art).ok).toBe(true);
      const e = await sammle();
      const roh = text(e).replace(/^antwort:/, "");
      return JSON.stringify(JSON.parse(roh));
    }

    test("ohne Firecrawl-Schlüssel: fail-closed, mit dem Grund „nicht eingerichtet“", async () => {
      // Der Regressionswächter für den Fehler oben: Käme hier statt dessen die
      // Adressmeldung, wäre `firecrawlKey` unterwegs zu `undefined` geworden —
      // denn `undefined === null` ist falsch, und die Prüfung fiele aus.
      const antwort = await frage("frage-abruf", { firecrawlKey: null });
      expect(antwort).toContain("nicht eingerichtet");
    }, 30_000);

    test("mit Firecrawl-Schlüssel: der Wert kommt an — es scheitert erst an der Adresse", async () => {
      // Dieselbe Anfrage, nur mit Schlüssel: Jetzt MUSS die Ablehnung von der
      // SSRF-Sperre kommen, nicht von der Einrichtungsprüfung. Das ist der
      // Beweis, dass der Wert durchgereicht wird und nicht unterwegs verloren
      // geht — ohne dass eine einzige Anfrage das Loopback verlässt.
      const antwort = await frage("frage-abruf", { firecrawlKey: "fc-attrappe-nie-benutzt" });
      expect(antwort).not.toContain("nicht eingerichtet");
      // Nur die RICHTUNG der Ablehnung, nicht ihr Wortlaut: Den besitzt
      // Dev-Netz, und ihn hier zu zitieren hieße, ihn an zwei Stellen zu führen.
      expect(antwort).toMatch(/Adresse/i);
    }, 30_000);

    test("ein LEERER Firecrawl-Schlüssel ist eingerichtet, nicht abwesend", async () => {
      // Die Unterscheidung, die schon zweimal verloren ging: "" heißt „ein
      // ausgehender Proxy hängt die Anmeldung an", nicht „aus". Wer sie hier
      // einebnet, schaltet den Seitenabruf in der Entwicklung wortlos ab.
      const antwort = await frage("frage-abruf", { firecrawlKey: "" });
      expect(antwort).not.toContain("nicht eingerichtet");
      expect(antwort).toMatch(/Adresse/i);
    }, 30_000);

    test("ohne Brave-Schlüssel wird gar nicht erst gesucht", async () => {
      // Derselbe Schnitt für den anderen Weg. Fail-closed heißt hier: nicht
      // suchen, statt ersatzweise irgendetwas anderes zu tun.
      //
      // NUR AUF „eingerichtet" GEPRÜFT, nicht auf den ganzen Satz: Dieser Test
      // stand vorher auf „nicht eingerichtet" und nagelte damit den Wortlaut
      // aus `agent.ts` fest — also genau die Prüfung, die dort nie hingehörte.
      // Als sie fiel, wurde er rot, obwohl das Verhalten richtig blieb: Jetzt
      // antwortet `recherche.ts`, und das sagt „keine Websuche eingerichtet".
      // Ein Test, der beim Entfernen eines Fehlers rot wird, hat den Fehler
      // festgehalten und nicht die Absicht.
      const antwort = await frage("frage-suche", { braveKey: null });
      expect(antwort).toMatch(/eingerichtet/i);
    }, 30_000);

    test("ein LEERER Brave-Schlüssel ist eingerichtet, nicht abwesend", async () => {
      /**
       * DER FALL, DER IN DIESER LISTE FEHLTE — und genau deshalb fehlte er:
       * Für Firecrawl standen drei Fälle da (`null`, Schlüssel, `""`), für
       * Brave einer. Die Lücke war in der Datei sichtbar und ist trotzdem
       * niemandem aufgefallen, bis ein Durchlauf mit echtem Modell die
       * Websuche stumm fand. `agent.ts` hatte `if (!ki.braveKey) throw` —
       * und `!""` ist wahr. Damit war die Websuche für JEDEN Proxy-Betrieb
       * tot, während `sucheImNetz("…", "")` von Hand aufgerufen einwandfrei
       * Treffer lieferte. Zwei Zeilen unter der kaputten Prüfung stand der
       * Kommentar, der erklärt, warum man hier nicht prüfen darf.
       *
       * Ohne Netz geprüft: `sucheImNetz` weist die LEERE Suchanfrage ab,
       * bevor es Brave anspricht. Diese Meldung beweist, dass der Aufruf
       * ankam. Käme statt dessen „nicht eingerichtet", hätte der Aufrufer
       * ihn wieder abgefangen.
       */
      const antwort = await frage("frage-suche-leer", { braveKey: "" });
      expect(antwort).not.toMatch(/eingerichtet/i);
      // Nur die RICHTUNG: Der Wortlaut gehört `recherche.ts`.
      expect(antwort).toMatch(/leer/i);
    }, 30_000);

    test("Gegenprobe: die Leer-Anfrage trennt wirklich, statt immer zu passen", async () => {
      // Ohne diesen Fall wäre der Test darüber auch dann grün, wenn die
      // Leer-Meldung IMMER käme — also auch bei `null`, wo „nicht
      // eingerichtet" kommen muss. Er prüft den Messapparat, nicht den Code.
      const antwort = await frage("frage-suche-leer", { braveKey: null });
      expect(antwort).toMatch(/eingerichtet/i);
      expect(antwort).not.toMatch(/leer/i);
    }, 30_000);
  });

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


// ===========================================================================
// Welches Gespräch fortgesetzt wird — bis zum Arbeiter durchgereicht
//
// GEPRÜFT WIRD DIE KETTE, NICHT DIE REGEL. Dass `waehleFortsetzung` richtig
// wählt, steht in `verlauf.test.ts`. Hier geht es um die Verdrahtung dahinter:
// `StartOptionen.verlauf` → `bereiteSitzungVor` → `REGORO_SITZUNG_DATEI` in der
// Umgebung des Arbeiters. Genau dieses Stück fehlte einmal ganz — die Option
// war angelegt und im Lauf benutzt, aber `handleAgentStart` las das Feld nie
// aus dem Rumpf. Alle Einzelteile waren grün.
//
// Die Attrappe `umgebung-melden` schickt ihre volle Umgebung als Text zurück;
// daran lässt sich die Kette am Ende ablesen, statt sie zu vermuten.
// ===========================================================================
describe("die Gesprächswahl erreicht den Arbeiter", () => {
  /** Legt einen echten Verlauf im Kundenordner an und liefert Kennung + Datei. */
  function legeVerlaufAn(auftrag: string): { id: string; datei: string } {
    const sm = SessionManager.create(tmp("regoro-agent-cwd-"), verlaufDir(siteDir));
    sm.appendMessage({ role: "user", content: auftrag } as never);
    sm.appendMessage({ role: "assistant", content: "erledigt" } as never);
    return { id: sm.getSessionId(), datei: sm.getSessionFile() ?? "" };
  }

  /** Fährt einen Lauf mit `umgebung-melden` und liefert die gemeldete Umgebung. */
  async function umgebungAus(verlauf?: string): Promise<Record<string, string>> {
    starteLauf(ctx, "umgebung-melden", {
      workerBefehl: [process.execPath, "run", ATTRAPPE],
      ...(verlauf === undefined ? {} : { verlauf }),
    });
    const alle = await sammle();
    const text = alle
      .filter((e): e is Extract<AgentEreignis, { t: "text" }> => e.t === "text")
      .map((e) => e.inhalt)
      .join("");
    return (JSON.parse(text) as { env: Record<string, string> }).env;
  }

  test.skipIf(!haveBwrap())("eine gewählte Kennung landet als Sitzungsdatei beim Arbeiter", async () => {
    const alt = legeVerlaufAn("das alte Gespräch");
    await Bun.sleep(5);
    legeVerlaufAn("das jüngere Gespräch");

    const env = await umgebungAus(alt.id);
    const datei = env.REGORO_SITZUNG_DATEI ?? "";
    // Der Name der Sitzungsdatei trägt die Kennung — sie ist der Beweis, dass
    // der ALTE Verlauf mitgegeben wurde und nicht der jüngere.
    expect(datei).toContain(alt.id);
    // Und sie liegt in der Arbeitskopie, nicht im Kundenordner: Die Sandbox hat
    // genau EINEN beschreibbaren Pfad (Invariante 11).
    expect(datei.startsWith(siteDir)).toBe(false);
  }, 30_000);

  test.skipIf(!haveBwrap())('"neu" gibt dem Arbeiter KEINE Sitzungsdatei mit', async () => {
    legeVerlaufAn("ein frisches Gespräch");
    const env = await umgebungAus("neu");
    expect(env.REGORO_SITZUNG_DATEI ?? "").toBe("");
  }, 30_000);

  test.skipIf(!haveBwrap())("Gegenprobe: ohne Angabe wird der frische Verlauf fortgesetzt", async () => {
    // OHNE DIESE GEGENPROBE beweist der Test darüber nichts: Eine Verdrahtung,
    // die NIE eine Sitzungsdatei mitgibt, wäre dort ebenfalls grün — und das
    // Gedächtnis des Agenten still verloren.
    const frisch = legeVerlaufAn("ein frisches Gespräch");
    const env = await umgebungAus();
    expect(env.REGORO_SITZUNG_DATEI ?? "").toContain(frisch.id);
  }, 30_000);
});


// ===========================================================================
// Das Kontextfenster erreicht den Arbeiter
//
// Dass `modell-info.ts` die richtige Zahl aus einer Anbieterantwort fischt,
// steht in `modell-info.test.ts`. Hier geht es um das Stück dahinter: dass sie
// bis in die Umgebung des Arbeiters durchkommt. Genau dieses Stück fehlte bei
// der Gesprächswahl schon einmal ganz, während alle Einzelteile grün waren.
// ===========================================================================
describe("das Kontextfenster erreicht den Arbeiter", () => {
  /** Ein Anbieter, der für `modell` ein Kontextfenster meldet. */
  function anbieter(modell: string, fenster: number): string {
    const s = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (!new URL(req.url).pathname.endsWith("/models")) return new Response("nein", { status: 404 });
        return Response.json({
          data: [{ id: modell, top_provider: { context_length: fenster, max_completion_tokens: 131_072 } }],
        });
      },
    });
    anbieterServer.push(s);
    return `http://127.0.0.1:${s.port}/v1`;
  }
  const anbieterServer: { stop(): void }[] = [];

  afterAll(() => {
    for (const s of anbieterServer) s.stop();
  });

  async function umgebungMit(kiConfig: HostCtx["ki"]): Promise<Record<string, string>> {
    leereModellCache();
    const eigenerCtx = { ...ctx, ki: kiConfig };
    starteLauf(eigenerCtx as HostCtx, "umgebung-melden", {
      workerBefehl: [process.execPath, "run", ATTRAPPE],
    });
    const alle = await sammle();
    const text = alle
      .filter((e): e is Extract<AgentEreignis, { t: "text" }> => e.t === "text")
      .map((e) => e.inhalt)
      .join("");
    return (JSON.parse(text) as { env: Record<string, string> }).env;
  }

  test.skipIf(!haveBwrap())("die gemeldeten Zahlen landen in der Umgebung", async () => {
    const modell = "test/grosses-modell";
    const env = await umgebungMit({ ...KI, baseUrl: anbieter(modell, 1_048_576), model: modell });
    expect(env.REGORO_CONTEXT_WINDOW).toBe("1048576");
    // Der Anbieter meldet 131.072 als Ausgabemaximum — weniger als unser
    // Wunsch, also gewinnt er.
    expect(env.REGORO_MAX_TOKENS).toBe("131072");
  }, 30_000);

  test.skipIf(!haveBwrap())("ein toter Anbieter gibt den Vorgabewert — der Lauf startet trotzdem", async () => {
    // Die Abfrage ist eine Stellschraube, keine Voraussetzung. Ein Anbieter
    // ohne `/models` darf keinen Auftrag verhindern.
    const env = await umgebungMit({ ...KI, baseUrl: "http://127.0.0.1:1/v1" });
    expect(env.REGORO_CONTEXT_WINDOW).toBe(String(STANDARD_CONTEXT_WINDOW));
  }, 30_000);

  test.skipIf(!haveBwrap())("Gegenprobe: die beiden Werte sind wirklich verschieden", () => {
    // Ohne sie wären beide Prüfungen oben auch dann grün, wenn die Umgebung
    // IMMER denselben Wert trüge und die Abfrage gar nichts bewirkte.
    expect(String(STANDARD_CONTEXT_WINDOW)).not.toBe("1048576");
  });
});
