/**
 * Ein Agentenlauf im Elternprozess: starten, begleiten, übernehmen, aufräumen.
 *
 * Die Reihenfolge ist die aus dem Architektur-Bild des Plans und keine davon
 * ist verschiebbar:
 *   1. Kontingent prüfen        — vor jeder Ausgabe, sonst ist der Deckel keiner
 *   2. Arbeitskopie anlegen     — der Agent sieht den Site-Ordner nie
 *   3. Weiterleitung starten    — sie hält die Schlüssel, der Worker nicht
 *   4. Worker in bwrap starten
 *   5. JSONL begleiten, Fragen im ELTERNPROZESS beantworten
 *   6. Worker beenden           — VOR dem Vergleichen (§13.15, TOCTOU)
 *   7. Änderungen ermitteln
 *   8. jede Datei validieren    — eine Ablehnung lässt den ganzen Lauf scheitern
 *   9. Realpath-Prüfung, schreiben, EIN Commit
 *  10. Kontingent buchen, Kopie löschen
 *
 * Was dieser Datei anvertraut ist und sonst nirgends steht: Ein Lauf gehört der
 * WEBSITE, nicht der HTTP-Anfrage (§13.14). Schließt der Kunde den Tab, läuft er
 * weiter — sonst wäre ein versehentlicher Reload ein Abbruchknopf für Arbeit,
 * deren Kontingent schon gebucht ist.
 */
import { lstatSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HostCtx } from "./host.ts";
import { pathInsideSite } from "./apply.ts";
import { commitEdit, git } from "./git.ts";
import { AUTH_DIR_NAME } from "./auth.ts";
import { bwrapVerfuegbar, sandboxArgv, standardVerstecke } from "./sandbox.ts";
import {
  byteHashDatei,
  ermittleAenderungen,
  legeArbeitskopieAn,
  leseStand,
  raeumeAuf,
  type Ausgangsstand,
} from "./arbeitskopie.ts";
import {
  bereiteSitzungVor,
  raeumeAlteVerlaeufe,
  sitzungDirInKopie,
  uebernimmSitzung,
  waehleFortsetzung,
} from "./verlauf.ts";
import { pruefeKontingent, verbucheTokens } from "./kontingent.ts";
import { validateAgentOutput } from "./validate.ts";
import { alleBrowserHerkuenfte, loadIntegrationen } from "./integrationen.ts";
import { starteRelay } from "./relay.ts";
import { holeSeite, sucheImNetz } from "./recherche.ts";

// ===========================================================================
// Ereignisse (Contract §7 — die `data`-Form gehört Dev-Agent)
// ===========================================================================
export type AgentEreignis =
  | { t: "text"; inhalt: string }
  | { t: "werkzeug"; name: string; kurz: string }
  | { t: "tokens"; gesamt: number; frei: number }
  | { t: "fertig"; zusammenfassung: string; dateien: string[]; commit: string | null }
  | { t: "fehler"; grund: string };

export type StartErgebnis =
  | { ok: true; laufId: string }
  // Maschinenlesbar, nicht der deutsche Satz: den Wortlaut für den Browser
  // besitzt Dev-Web (Contract §10). Stünde er hier auch, driftete er auseinander.
  | { ok: false; grund: "laeuft-bereits" | "kontingent" | "keine-sandbox" };

export type StartOptionen = {
  /** Ersetzt den Worker — ausschließlich für Tests (Attrappe). */
  workerBefehl?: string[];
  /** Sammelverzeichnis, damit die Sandbox die anderen Kunden zudecken kann. */
  sitesRoot?: string | null;
};

/** Höchstens so viele Ereignisse werden für einen Neuverbinder aufgehoben (§13.14). */
const PUFFER_GRENZE = 500;

/**
 * Wie lange nach dem Ende des Workers noch auf Nachzügler aus seinem stdout
 * gewartet wird, bevor die Leseschleife aufgibt. Kurz genug, dass ein Abbruch
 * sofort wirkt; lang genug, dass ein regulär beendeter Lauf sein `fertig` noch
 * loswird.
 */
const EXIT_GNADENFRIST_MS = 200;

/**
 * Wie lange nach dem Ende des Workers höchstens auf `done` gewartet wird, bevor
 * der Leser abgebrochen wird.
 *
 * Das ist ein NOTAUSGANG und kein Normalweg: Ist der Worker beendet, ist das
 * Schreibende der Pipe zu und `read()` liefert von selbst zügig `done`. Gebraucht
 * wird der Abbruch nur, wenn ein ENKELPROZESS das Schreibende offen hält — und
 * dafür sind Sekunden angemessen. Mit einer kurzen Frist wäre er der Normalweg
 * und würfe unter Last genau die letzten Bytes weg, um die es hier geht.
 */
const LESER_ABBRUCH_MS = 2_000;

/** So viel vom stderr des Workers wird für den Fehlerfall aufgehoben. */
const STDERR_MITSCHNITT_BYTES = 8192;

type Lauf = {
  laufId: string;
  puffer: AgentEreignis[];
  zuhoerer: Set<(e: AgentEreignis) => void>;
  /**
   * Getrennt von `zuhoerer`: Endet ein Lauf ohne Abschlussereignis, müssen
   * wartende Ströme aufwachen — aber sie dürfen dafür kein Ereignis untergeschoben
   * bekommen. Ein „fehler" zum Aufwecken wäre nach einem `fertig` ein zweites
   * Abschlussereignis im selben Strom.
   */
  wecker: Set<() => void>;
  fertig: boolean;
  /**
   * Der Abbruchwunsch als ZUSTAND, nicht nur als Aufruf.
   *
   * `abbrechen` wird erst eingehängt, wenn der Worker läuft. Ein `brichAb` davor
   * träfe sonst die Attrappe und verpuffte — der Kunde bekäme HTTP 200, und der
   * Lauf liefe weiter, bis sein Monatskontingent aufgebraucht ist. Ein Abbruch,
   * der 200 meldet und nichts tut, ist schlimmer als einer, der 409 meldet.
   * Deshalb merkt sich der Lauf den Wunsch, und der Rumpf prüft ihn beim Anlaufen.
   */
  abbruchGewuenscht: boolean;
  abbrechen: () => void;
};

/** Ein Lauf je Website. Schlüssel ist der Site-Ordner, nicht der Hostname. */
const laeufe = new Map<string, Lauf>();

export function laufAktiv(siteDir: string): string | null {
  const l = laeufe.get(siteDir);
  return l && !l.fertig ? l.laufId : null;
}

/**
 * Bricht den Lauf dieser Website ab. Idempotent und wurffrei — die Route ist
 * es auch (Contract §7); ein Wurf hier ergäbe dort HTTP 500.
 */
export function brichAb(siteDir: string): void {
  const lauf = laeufe.get(siteDir);
  if (!lauf) return;
  // Erst merken, dann ausführen: Der Wunsch muss auch dann bestehen bleiben,
  // wenn der Worker gerade erst anläuft und `abbrechen` noch die Attrappe ist.
  lauf.abbruchGewuenscht = true;
  try {
    lauf.abbrechen();
  } catch {
    /* ein Abbruch, der nicht mehr nötig war, ist kein Fehler */
  }
}

/**
 * Der Ereignisstrom eines Laufs. Erst der Puffer, dann live — ohne das sähe der
 * Kunde nach einem Reload ein leeres Chatfenster, obwohl der Lauf arbeitet.
 * Mehrere gleichzeitige Zuhörer sind zulässig (zweiter Tab).
 */
export async function* ereignisse(siteDir: string): AsyncGenerator<AgentEreignis> {
  const lauf = laeufe.get(siteDir);
  if (!lauf) {
    yield { t: "fehler", grund: "kein-lauf" };
    return;
  }

  const warteschlange: AgentEreignis[] = [...lauf.puffer];
  let wecke: (() => void) | null = null;
  const aufwecken = (): void => wecke?.();
  const zuhoerer = (e: AgentEreignis): void => {
    warteschlange.push(e);
    aufwecken();
  };
  lauf.zuhoerer.add(zuhoerer);
  lauf.wecker.add(aufwecken);

  try {
    while (true) {
      while (warteschlange.length) {
        const e = warteschlange.shift()!;
        yield e;
        // Der Strom endet nach `fertig` oder `fehler` — kein Nachklapp.
        if (e.t === "fertig" || e.t === "fehler") return;
      }
      if (lauf.fertig) return;
      await new Promise<void>((auf) => (wecke = auf));
      wecke = null;
    }
  } finally {
    // `cancel()` des Streams hängt NUR den Zuhörer ab und beendet nichts
    // (§13.14). Abgebrochen wird ausschließlich über `brichAb`.
    lauf.zuhoerer.delete(zuhoerer);
    lauf.wecker.delete(aufwecken);
  }
}

// ===========================================================================
// Start
// ===========================================================================
export function starteLauf(ctx: HostCtx, auftrag: string, opts: StartOptionen = {}): StartErgebnis {
  if (laufAktiv(ctx.siteDir)) return { ok: false, grund: "laeuft-bereits" };

  const kontingent = pruefeKontingent(ctx.siteDir);
  if (kontingent.erschoepft) return { ok: false, grund: "kontingent" };

  // Fehlt bwrap, startet KEIN Lauf. Kein stiller Rückfall auf einen
  // ungesperrten Prozess — lieber gar keine Seitenleiste als eine ohne die
  // erste der drei Grenzen. Die Prüfung steht VOR der Arbeitskopie, damit ein
  // abgelehnter Start keine Spuren unter RUNTIME_DIRECTORY hinterlässt.
  if (!bwrapVerfuegbar()) return { ok: false, grund: "keine-sandbox" };

  const laufId = randomUUID();
  const lauf: Lauf = {
    laufId,
    puffer: [],
    zuhoerer: new Set(),
    wecker: new Set(),
    fertig: false,
    abbruchGewuenscht: false,
    abbrechen: () => {},
  };
  laeufe.set(ctx.siteDir, lauf);

  // Bewusst NICHT erwartet: Der Lauf beginnt hier und lebt unabhängig von der
  // Anfrage weiter, die ihn gestartet hat.
  void fuehreAus(ctx, auftrag, opts, lauf).catch((err) => {
    sende(lauf, { t: "fehler", grund: err instanceof Error ? err.message : String(err) });
    beende(lauf);
  });

  return { ok: true, laufId };
}

function sende(lauf: Lauf, e: AgentEreignis): void {
  lauf.puffer.push(e);
  if (lauf.puffer.length > PUFFER_GRENZE) lauf.puffer.splice(0, lauf.puffer.length - PUFFER_GRENZE);
  for (const z of lauf.zuhoerer) z(e);
}

function beende(lauf: Lauf): void {
  lauf.fertig = true;
  // Nur aufwecken, kein Ereignis: Wer schon ein Abschlussereignis gesehen hat,
  // ist längst fertig; wer noch wartet, soll den Strom sauber beenden.
  for (const w of lauf.wecker) w();

  // Der beendete Lauf bleibt in der Registratur stehen (§13.33) — er wird NICHT
  // gelöscht. Sonst bekäme ein `/events`, das sich nach dem Ende verbindet,
  // „kein Lauf aktiv", und der Kunde verlöre Zusammenfassung und Dateiliste
  // durch genau den versehentlichen Reload, gegen den §13.14 antritt. Er sähe
  // nicht einmal, DASS etwas geschehen ist, obwohl seine Website sich geändert
  // hat.
  //
  // `laufAktiv` meldet ihn trotzdem als beendet (es prüft `fertig`), ein neuer
  // Auftrag ist also sofort möglich und ersetzt den Eintrag. Es bleibt damit
  // höchstens ein abgeschlossener Lauf je Website liegen, gedeckelt durch
  // PUFFER_GRENZE.
}

// ===========================================================================
// Der Lauf selbst
// ===========================================================================
async function fuehreAus(ctx: HostCtx, auftrag: string, opts: StartOptionen, lauf: Lauf): Promise<void> {
  const ki = ctx.ki;
  if (ki == null) {
    // `== null`, nicht `=== null`: `ki` ist optional deklariert, und `undefined`
    // ist derselbe Fall — „kein Modellzugang" (Contract §7).
    sende(lauf, { t: "fehler", grund: "kein-modellzugang" });
    beende(lauf);
    return;
  }

  const integrationen = loadIntegrationen(ctx.siteDir);
  const kontingent = pruefeKontingent(ctx.siteDir);
  let kopie: string | null = null;
  let relay: { port: number; stop(): void } | null = null;
  let geseheneTokens = 0;

  let sitzungDatei: string | null = null;
  let ausgang: Ausgangsstand | null = null;

  try {
    kopie = legeArbeitskopieAn(ctx.siteDir);
    /**
     * Der Stand der Website zum Zeitpunkt der Kopie.
     *
     * Ohne ihn verglich die Übernahme die Arbeitskopie mit dem JETZIGEN Stand —
     * und schrieb damit eine Datei, die der Kunde während des Laufs von Hand
     * gespeichert hatte, mit dem alten Inhalt aus der Kopie zu. An einer Datei,
     * die der Agent nie angefasst hat. Reiner Verlust, ohne Meldung.
     *
     * Direkt NACH dem Kopieren gelesen, nicht davor: Was zwischen beiden Zeilen
     * geschieht, gehört noch zum Ausgangszustand.
     */
    ausgang = leseStand(ctx.siteDir);

    /**
     * Verlauf: aufräumen, auswählen, in die Arbeitskopie legen.
     *
     * Das Aufräumen hängt am Laufstart und nicht an einem Zeitgeber — derselbe
     * Aufhänger wie beim Kontingent. Ein Prozess ohne Läufe erzeugt keine
     * Verläufe, die aufzuräumen wären.
     *
     * Alles hier ist bewusst folgenlos im Fehlerfall: Ein kaputter Verlauf darf
     * einen Auftrag nicht verhindern, er beginnt dann eben neu.
     */
    try {
      raeumeAlteVerlaeufe(ctx.siteDir);
      sitzungDatei = bereiteSitzungVor(kopie, await waehleFortsetzung(ctx.siteDir));
    } catch (err) {
      process.stderr.write(`[agent] Verlauf nicht vorbereitet: ${String(err)}\n`);
    }

    relay = starteRelay(ki, integrationen);

    const ergebnis = await begleiteWorker(ctx, auftrag, opts, lauf, kopie, relay.port, ki, integrationen, kontingent.frei, sitzungDatei);
    geseheneTokens = ergebnis.tokens;

    if (!ergebnis.sauberFertig) {
      sende(lauf, { t: "fehler", grund: ergebnis.grund ?? "lauf-gescheitert" });
      return;
    }

    // Ab hier ist der Worker beendet (§13.15): zwischen `lstat` und Lesen darf
    // er kein Fenster mehr haben, das er selbst aufmacht.
    const uebernahme = uebernehmen(ctx, kopie, integrationen, ausgang);
    if (!uebernahme.ok) {
      sende(lauf, { t: "fehler", grund: uebernahme.grund });
      return;
    }
    sende(lauf, {
      t: "fertig",
      zusammenfassung: ergebnis.zusammenfassung,
      dateien: uebernahme.dateien,
      commit: uebernahme.commit,
    });
  } catch (err) {
    sende(lauf, { t: "fehler", grund: err instanceof Error ? err.message : String(err) });
  } finally {
    // Gekapselt, weil ALLES danach daran hängt: Wirft `stop()`, blieben
    // Aufräumen, Verbuchen und vor allem `beende` aus — der Lauf stünde für
    // immer als „aktiv" und sperrte die Website für weitere Aufträge. Genau
    // der Zustand, der oben schon einmal auf anderem Weg entstanden ist.
    try {
      relay?.stop();
    } catch (err) {
      process.stderr.write(`[agent] Weiterleitung ließ sich nicht schließen: ${String(err)}\n`);
    }
    /**
     * Den Verlauf ZURÜCKHOLEN, bevor die Arbeitskopie verschwindet — und auch
     * nach einem gescheiterten Lauf.
     *
     * Ein Auftrag, der an der Übernahme scheitert (Validator lehnt ab), hat
     * trotzdem stattgefunden: Das Modell hat geantwortet, Token sind
     * ausgegeben, und der Kunde will beim nächsten Mal daran anknüpfen können
     * („das eben hat nicht geklappt, mach es anders"). Nur Erfolge zu sichern
     * hieße, ausgerechnet die Gespräche zu verlieren, in denen nachgehakt wird.
     */
    if (kopie) {
      try {
        const zurueck = uebernimmSitzung(kopie, ctx.siteDir);
        if (zurueck.uebersprungen.length > 0) {
          process.stderr.write(
            `[agent] Verlauf zu groß, nicht gesichert: ${zurueck.uebersprungen.join(", ")}\n`,
          );
        }
      } catch (err) {
        process.stderr.write(`[agent] Verlauf nicht gesichert: ${String(err)}\n`);
      }
    }
    // Aufräumen gehört ins finally, auch bei Abbruch — sonst füllt sich /run,
    // bis kein Lauf mehr startet.
    if (kopie) raeumeAuf(kopie);
    // Verbucht wird IMMER, auch nach einem gescheiterten Lauf: Die Token sind
    // trotzdem ausgegeben. Wer nur Erfolge verbucht, hat einen Freifahrtschein
    // gebaut — ein Lauf, der absichtlich am Validator scheitert, zählte nie.
    verbucheTokens(ctx.siteDir, geseheneTokens);
    beende(lauf);
  }
}

type WorkerErgebnis = {
  sauberFertig: boolean;
  zusammenfassung: string;
  tokens: number;
  grund?: string;
};

/**
 * Startet den Worker in der Sandbox und übersetzt sein JSONL in Ereignisse.
 * Beantwortet seine Fragen — die Recherche läuft HIER, im Elternprozess, weil
 * der Worker kein Netzwerkzeug hat (Invariante 11).
 */
async function begleiteWorker(
  ctx: HostCtx,
  auftrag: string,
  opts: StartOptionen,
  lauf: Lauf,
  kopie: string,
  relayPort: number,
  ki: NonNullable<HostCtx["ki"]>,
  integrationen: ReturnType<typeof loadIntegrationen>,
  freiesKontingent: number,
  sitzungDatei: string | null,
): Promise<WorkerErgebnis> {
  const skills = process.env.REGORO_SKILLS || null;
  const befehl = opts.workerBefehl ?? standardWorkerBefehl();
  const argv = sandboxArgv(
    befehl[0]!,
    befehl.slice(1),
    kopie,
    skills,
    // Das Elternverzeichnis der SITE deckt die Nachbarkunden zu: Im
    // Sammelbetrieb ist das der sitesRoot, im Einzelbetrieb der Ordner, in dem
    // die Website liegt. Der Worker braucht das Original nie — er arbeitet
    // ausschließlich auf der Kopie. Ohne diesen Deckel läge die `.regoro/auth.json`
    // JEDES anderen Kunden offen (Stütze 2 der Invariante 10), lesbar über
    // `--ro-bind / /`.
    standardVerstecke(dirname(kopie), opts.sitesRoot ?? dirname(ctx.siteDir)),
  );

  const proc = Bun.spawn(argv, {
    // ALLOWLIST, nicht `process.env` minus ein paar Namen (Contract §6/§12).
    // Auf dieser Maschine setzt ein Vault-Proxy für JEDEN Prozess den echten
    // OpenRouter-Schlüssel ein: Erbte der Worker HTTP_PROXY, gelänge ein
    // Modellaufruf AM RELAY VORBEI — und ein kaputtes Relay fiele niemandem auf,
    // weil weiterhin alles funktionierte.
    env: workerUmgebung(auftrag, kopie, skills, relayPort, ki, integrationen, freiesKontingent, sitzungDatei),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let tokens = 0;
  let zusammenfassung = "";
  let sauberFertig = false;
  let grund: string | undefined;
  let beendet = false;

  const schliesse = (): void => {
    if (beendet) return;
    beendet = true;
    try {
      proc.kill();
    } catch {
      /* schon tot */
    }
  };

  lauf.abbrechen = () => {
    grund ??= "abgebrochen";
    schliesse();
  };
  // Der Wunsch kann VOR dieser Zeile eingetroffen sein — zwischen `starteLauf`
  // und hier liegt der Start des Workers. Ohne diese Prüfung liefe genau der
  // Lauf weiter, dessen Abbruch der Kunde schon quittiert bekommen hat.
  if (lauf.abbruchGewuenscht) lauf.abbrechen();

  // `regoro disable` während eines Laufs: Der Betreiber entzieht den Zugang.
  // Ein Lauf, der danach weiterschreibt, liefe gegen genau die Entscheidung,
  // die gerade getroffen wurde — und kostete weiter Token.
  const wache = setInterval(() => {
    if (!existsSync(join(ctx.siteDir, AUTH_DIR_NAME))) {
      grund ??= "abgeschaltet";
      schliesse();
    }
  }, 250);

  // stderr ist Log für uns und geht NIE in den Ereignisstrom: Die Zeilen tragen
  // Pfade aus der Arbeitskopie, der Kunde sähe interne Serverpfade im Browser.
  //
  // Mitgeschrieben wird zusätzlich, weil ein Worker, der beim Start stirbt,
  // sonst SPURLOS verschwindet: Der Elternprozess ist dann in Millisekunden
  // fertig, der stderr-Leser kommt gar nicht mehr zum Zug, und im Log steht nur
  // „worker-abgestuerzt" ohne Grund. Genau dieser Fall ist im E2E-Lauf
  // aufgetreten und war ohne den Mitschnitt nicht aufzuklären.
  let stderrEnde = "";
  const stderrGelesen = (async () => {
    for await (const stueck of proc.stderr as ReadableStream<Uint8Array>) {
      const text = new TextDecoder().decode(stueck);
      process.stderr.write(text);
      stderrEnde = (stderrEnde + text).slice(-STDERR_MITSCHNITT_BYTES);
    }
  })().catch(() => {});

  const schreiber = proc.stdin;
  const antworte = (n: Record<string, unknown>): void => {
    try {
      schreiber.write(JSON.stringify(n) + "\n");
      schreiber.flush();
    } catch {
      /* Worker schon weg */
    }
  };

  try {
    let puffer = "";
    const dec = new TextDecoder();
    const leser = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    /**
     * Ein toter Prozess ist ein gleichberechtigter Ausgang aus dieser Schleife.
     *
     * Gemessen: Wird der Worker abgebrochen, während er gerade erst anläuft,
     * endet sein stdout-Strom nicht zuverlässig — `for await` hing dann für
     * immer, der Lauf blieb als „aktiv" stehen, und `POST /edit/agent/abort`
     * meldete 200, ohne dass je etwas endete. Die Website war für weitere
     * Aufträge gesperrt, bis der Server neu startete.
     *
     * WARUM NICHT gegen jeden `read()` gerennt wird: Ein einmal erzeugter
     * Timer ist nach Ablauf DAUERHAFT erfüllt und gewinnt danach jedes Rennen.
     * Liegen die letzten Bytes noch in der OS-Pipe statt im Puffer des Stroms,
     * bleibt `read()` hängen, der Timer gewinnt — und die letzte Zeile ist weg.
     * Stattdessen wird bis `done` LEERGELESEN; die Gesamtfrist (`LESER_ABBRUCH_MS`)
     * wirkt nur als Notausgang, indem sie den Leser abbricht — und ist deshalb
     * bewusst um eine Größenordnung länger als die Gnadenfrist für stderr. Eine
     * kurze Frist hätte das Rennen nur verschoben statt beseitigt: Sind die
     * letzten Bytes noch nicht beim Leser, wirft `cancel()` sie weg.
     */
    const wachhund = proc.exited.then(async () => {
      await Bun.sleep(LESER_ABBRUCH_MS);
      // Bricht ein hängendes `read()` auf — sonst stünde die Schleife still.
      await leser.cancel().catch(() => {});
    });
    void wachhund;

    /** Eine JSONL-Zeile des Workers verarbeiten. */
    const verarbeite = (zeile: string): void => {
        if (!zeile.trim()) return;

        let n: Record<string, unknown>;
        try {
          n = JSON.parse(zeile);
        } catch {
          // Der Worker ist der unsicherste Teil des Systems und sein stdout ist
          // Eingabe. Ein JSON.parse ohne Netz darum wäre ein Serverabsturz,
          // ausgelöst von genau diesem Teil.
          process.stderr.write(`[agent] unverständliche Zeile vom Worker\n`);
          return;
        }

        switch (n.t) {
          case "text":
            sende(lauf, { t: "text", inhalt: String(n.inhalt ?? "") });
            break;
          case "werkzeug":
            sende(lauf, { t: "werkzeug", name: String(n.name ?? ""), kurz: String(n.kurz ?? "") });
            break;
          case "tokens": {
            tokens = Number(n.gesamt ?? 0);
            sende(lauf, { t: "tokens", gesamt: tokens, frei: Math.max(0, freiesKontingent - tokens) });
            // Der Deckel greift auch dann, wenn der Worker ihn ignoriert — er
            // ist ein fremder Prozess, seine Selbstbeschränkung ist keine.
            if (tokens > freiesKontingent) {
              grund ??= "kontingent-erschoepft";
              schliesse();
            }
            break;
          }
          case "frage": {
            const id = Number(n.id ?? 0);
            void beantworte(n, ki).then(
              (inhalt) => antworte({ t: "antwort", id, ok: true, inhalt }),
              (err: unknown) => antworte({ t: "antwort", id, ok: false, fehler: fehlertext(err) }),
            );
            break;
          }
          case "fertig":
            zusammenfassung = String(n.zusammenfassung ?? "");
            sauberFertig = true;
            break;
          case "fehler":
            grund ??= String(n.meldung ?? "lauf-gescheitert");
            break;
        }
    };

    while (true) {
      const gelesen = await leser.read();
      if (gelesen.done) break;
      puffer += dec.decode(gelesen.value, { stream: true });
      let bruch: number;
      while ((bruch = puffer.indexOf("\n")) >= 0) {
        verarbeite(puffer.slice(0, bruch));
        puffer = puffer.slice(bruch + 1);
      }
    }

    // Was ohne abschließenden Umbruch im Puffer bleibt, ist trotzdem eine Zeile.
    // Kein Prozess ist verpflichtet, seinen letzten Umbruch zu schreiben — und
    // verloren ginge ausgerechnet das Abschlussereignis. Der Schaden wäre ein
    // GELUNGENER Lauf, der als gescheitert gemeldet wird: Die Website ist
    // geändert, die Seitenleiste sagt das Gegenteil, der Kunde versucht es
    // erneut und bezahlt denselben Lauf zweimal.
    verarbeite(puffer + dec.decode());

    const code = await proc.exited;
    // Ein Absturz mitten im Lauf zählt nicht als Erfolg, auch wenn vorher eine
    // gültige Datei entstand: Halbfertiges wird nie übernommen.
    if (code !== 0 && !grund) {
      grund = "worker-abgestuerzt";
      // Dem stderr-Leser Zeit geben, bevor wir urteilen — bei einem Tod
      // während des Starts liegt die Begründung noch ungelesen im Rohr.
      await Promise.race([stderrGelesen, Bun.sleep(EXIT_GNADENFRIST_MS)]);
      process.stderr.write(
        `[agent] Worker beendet mit Code ${code}. Letzte Ausgabe:\n${stderrEnde || "(nichts auf stderr)"}\n`,
      );
    }
    if (grund) sauberFertig = false;
  } finally {
    clearInterval(wache);
    schliesse();
    // Erst wenn der Prozess wirklich weg ist, darf verglichen werden (§13.15).
    await proc.exited.catch(() => {});
    lauf.abbrechen = () => {};
  }

  return { sauberFertig, zusammenfassung, tokens, grund };
}

/** Fragen des Workers — beantwortet im Elternprozess, nie im Worker. */
async function beantworte(n: Record<string, unknown>, ki: NonNullable<HostCtx["ki"]>): Promise<string> {
  // WEDER `braveKey` NOCH `firecrawlKey` werden hier geprüft, sondern
  // durchgereicht: `null` heißt „nicht eingerichtet", `""` heißt „ein
  // ausgehender Proxy hängt die Anmeldung an". Diesen Unterschied kennen
  // `sucheImNetz` und `holeSeite`; eine zweite Prüfung hier legt ihn früher
  // oder später anders aus.
  //
  // GENAU DAS WAR HIER DER FALL: `if (!ki.braveKey) throw` warf für den leeren
  // String, also für die Einrichtung, die `regoro ki --key-from-proxy` selbst
  // anlegt und die `regoro ki --list` als „eingerichtet" anzeigt. Der
  // Seitenabruf daneben machte es richtig; die Websuche war für jeden
  // Proxy-Betrieb tot, während die Suchfunktion selbst nachweislich lief.
  // Nicht wieder einführen — fail-closed entsteht in `recherche.ts` aus
  // `typeof key !== "string"`, nicht aus Wahrheitswert-Prüfungen beim Aufrufer.
  if (n.art === "web_search") return await sucheImNetz(String(n.q ?? ""), ki.braveKey);
  if (n.art === "fetch_page") return await holeSeite(String(n.url ?? ""), ki.firecrawlKey);
  throw new Error("Diese Anfrage kennt der Server nicht.");
}

function fehlertext(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.trim() || "Die Anfrage war nicht möglich.";
}

/**
 * Der Worker ist DASSELBE Binary mit einem anderen ersten Argument. Im
 * `--compile`-Binary ist `process.execPath` das regoro-Binary selbst; im
 * Entwicklungsbetrieb ist es `bun`, dann muss das Einstiegsskript mit.
 */
function standardWorkerBefehl(): string[] {
  /**
   * Testnaht, analog zu `REGORO_BWRAP` — und hier mehr als Bequemlichkeit.
   *
   * `POST /edit/agent` ruft `starteLauf` ohne `workerBefehl`, der Arbeiter wird
   * also aus `Bun.main` gebaut. Unter `bun test` ist das die TESTDATEI SELBST:
   * Die Route startete damit den kompletten Testlauf noch einmal in einer
   * bwrap-Sandbox, im Hintergrund und rekursiv. Daher stammten die verwaisten
   * bwrap-Prozesse — nicht aus einem Versagen von `--die-with-parent`, sondern
   * aus Testläufen, deren Eltern völlig regulär endeten.
   *
   * Ein Pfad, kein Kommandostring: So bleiben Verzeichnisse mit Leerzeichen
   * heil, und es gibt keinen Weg, über diese Variable zusätzliche Argumente
   * einzuschleusen.
   */
  const naht = process.env.REGORO_AGENT_WORKER;
  if (naht) return [process.execPath, "run", naht];

  const istBinary = !/(^|\/)bun(-\w+)?$/.test(process.execPath);
  return istBinary
    ? [process.execPath, "agent-worker"]
    : [process.execPath, "run", Bun.main, "agent-worker"];
}

/**
 * Die Umgebung des Workers — eine ALLOWLIST. Was hier nicht steht, kommt nicht
 * an: kein Proxy, kein `*_API_KEY`, kein `*_TOKEN`, nichts aus `process.env`.
 *
 * Nichts davon steht in `argv`: Das liest jeder Prozess dieses Hosts über /proc
 * mit — auch den Port der Weiterleitung, an dem ein Dienst hängt, der fremde
 * Schlüssel anhängt, und den Auftrag, der Geschäftsinterna enthalten kann.
 */
function workerUmgebung(
  auftrag: string,
  kopie: string,
  skills: string | null,
  relayPort: number,
  ki: NonNullable<HostCtx["ki"]>,
  integrationen: ReturnType<typeof loadIntegrationen>,
  freiesKontingent: number,
  sitzungDatei: string | null,
): Record<string, string> {
  // pi schriebe sonst nach ~/.pi/agent/: Sitzungen samt vollem Kundenauftrag
  // und einen Auth-Speicher. Beides zeigt in die Arbeitskopie, die mit dem Lauf
  // verschwindet; `.pi` beginnt mit einem Punkt und wird nie übernommen.
  const piHeim = join(kopie, ".pi-home");
  mkdirSync(piHeim, { recursive: true });

  return {
    PATH: "/usr/bin:/bin",
    HOME: piHeim,
    PI_CODING_AGENT_DIR: join(piHeim, "agent"),
    // Ohne diese beiden lädt pi Hilfsbinaries (fd, rg) von GitHub nach und
    // fragt nach neuen Versionen — ausgehende Verbindungen, die wir nicht wollen.
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    REGORO_AUFTRAG: auftrag,
    REGORO_ARBEITSKOPIE: kopie,
    REGORO_SKILLS: skills ?? "",
    REGORO_RELAY: `http://127.0.0.1:${relayPort}/modell`,
    REGORO_RELAY_API: `http://127.0.0.1:${relayPort}/api`,
    REGORO_MODELL: ki.model,
    REGORO_TOKEN_LIMIT: String(freiesKontingent),
    // NUR Name und Zweck — niemals Schlüssel oder baseUrl (Contract §6).
    REGORO_INTEGRATIONEN: JSON.stringify(
      [...integrationen.entries()].map(([name]) => ({ name, zweck: `Dienst „${name}“` })),
    ),
    REGORO_BROWSER_HERKUENFTE: JSON.stringify(alleBrowserHerkuenfte(integrationen)),
    // Der Gesprächsverlauf. Beides zeigt IN die Arbeitskopie — der Worker
    // bekommt keinen Schreibzugriff auf den Kundenordner (Invariante 11,
    // Begründung in `verlauf.ts`). Leerer Dateiname heißt „neuer Verlauf".
    REGORO_SITZUNG_DIR: sitzungDirInKopie(kopie),
    REGORO_SITZUNG_DATEI: sitzungDatei ?? "",
  };
}

// ===========================================================================
// Übernehmen
// ===========================================================================
type Uebernahme = { ok: true; dateien: string[]; commit: string | null } | { ok: false; grund: string };

/**
 * Sucht den ersten Symlink in der Arbeitskopie und liefert seinen relativen
 * Pfad. Punkt-Segmente bleiben außen vor: `.pi-home` gehört dem Worker, und was
 * darin an Symlinks entsteht (bun legt einen Paket-Cache an), ist keine Aussage
 * über die Website.
 */
function findeSymlink(kopie: string, rel = ""): string | null {
  let eintraege;
  try {
    eintraege = readdirSync(rel ? join(kopie, rel) : kopie, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of eintraege) {
    if (e.name.startsWith(".")) continue;
    const kindRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) return kindRel;
    if (e.isDirectory()) {
      const tiefer = findeSymlink(kopie, kindRel);
      if (tiefer) return tiefer;
    }
  }
  return null;
}

/**
 * Vergleicht Kopie und Original und übernimmt, was durchkommt — alles oder
 * nichts. Eine einzige Ablehnung lässt den ganzen Lauf scheitern: Eine halb
 * übernommene Änderung wäre eine Website in einem Zustand, den niemand gewollt
 * und niemand geprüft hat.
 */
function uebernehmen(
  ctx: HostCtx,
  kopie: string,
  integrationen: ReturnType<typeof loadIntegrationen>,
  ausgang: Ausgangsstand | null,
): Uebernahme {
  // ZUERST: Hat der Lauf irgendwo einen Symlink hinterlassen?
  //
  // `ermittleAenderungen` überspringt Symlinks, die aus der Kopie hinauszeigen —
  // als reine Vergleichsfunktion völlig richtig (§13.15). Die Folge wäre aber,
  // dass ein Ausbruchsversuch UNSICHTBAR bliebe: Der Lauf endete mit „fertig,
  // null Dateien", und niemand erführe, dass der Agent versucht hat, sich
  // `/etc/regoro/ki.json` oder die `auth.json` eines fremden Kunden unter einem
  // harmlosen Seitennamen zu holen. Ein Symlink entsteht bei ehrlicher Arbeit
  // nie — es gibt kein Werkzeug dafür. Also: Lauf gescheitert.
  const symlink = findeSymlink(kopie);
  if (symlink) return { ok: false, grund: `symlink:${symlink}` };

  const aenderungen = ermittleAenderungen(kopie, ctx.siteDir, ausgang ?? undefined);

  /**
   * HAT WÄHREND DES LAUFS JEMAND ANDERES GESCHRIEBEN? Dann NICHT übernehmen.
   *
   * Der Fall ist real und heute erreichbar: Der Kunde speichert im Text-Editor,
   * während ein Auftrag läuft — im zweiten Tab, auf dem Telefon, oder einfach
   * weil ihn die Wartezeit langweilt. Ohne diese Prüfung schriebe die Übernahme
   * seine frische Änderung mit dem Stand von vor dem Lauf zu, und zwar auch an
   * Dateien, die der Agent nie angefasst hat.
   *
   * Abgebrochen wird der GANZE Lauf, nicht die einzelne Datei: Ein Lauf ist
   * eine Einheit (dieselbe Regel wie bei der Rücknahme). Teilweise zu
   * übernehmen hieße, eine Website in einem Zustand zu hinterlassen, den weder
   * der Agent noch der Kunde je so gewollt hat.
   *
   * Die Arbeit ist damit verloren — der Verlauf bleibt aber erhalten, der Kunde
   * kann den Auftrag also wiederholen. Das ist der bessere Tausch: lieber ein
   * Lauf umsonst als eine stillschweigend überschriebene Kundenänderung.
   */
  if (aenderungen.fremdGeaendert.length > 0) {
    return { ok: false, grund: `fremd-geaendert:${aenderungen.fremdGeaendert.join(",")}` };
  }

  // Punkt-Segmente gehören nie zur Website: `.pi-home` legt der Worker selbst
  // an, und `.git`/`.regoro` werden gar nicht erst kopiert. Sie hier
  // auszusortieren ist kein Aufweichen — der Validator lehnt sie ohnehin ab,
  // und ohne diesen Schritt scheiterte JEDER Lauf an unserem eigenen Ablauf.
  const istSichtbar = (p: string): boolean => !p.split("/").some((s) => s.startsWith("."));
  const geaendert = [...aenderungen.geaendert, ...aenderungen.neu].filter(istSichtbar);
  const geloescht = aenderungen.geloescht.filter(istSichtbar);

  // Es gibt kein `delete_file`-Werkzeug und keine Prüfregel für Löschungen —
  // eine fehlende Datei ist Fehler oder Ausbruchsversuch, nicht Absicht (§13.5).
  if (geloescht.length) return { ok: false, grund: `geloescht:${geloescht[0]}` };
  if (!geaendert.length) return { ok: true, dateien: [], commit: null };

  const browserHerkuenfte = alleBrowserHerkuenfte(integrationen);
  const zuSchreiben: { rel: string; ziel: string; inhalt: string }[] = [];

  for (const [i, rel] of geaendert.sort().entries()) {
    const quelle = join(kopie, rel);
    const ziel = join(ctx.siteDir, rel);

    // BEIDE Seiten prüfen (§13.15). `pathInsideSite(siteDir, ziel)` allein sähe
    // bei einem Symlink `kopie/kontakt.html -> /etc/passwd` nichts Falsches:
    // Das ZIEL `kontakt.html` liegt ja sauber in der Website. Gelesen würde
    // aber `/etc/passwd` — und am Validator käme es vorbei, der nur harmlosen
    // Text ohne Skript sieht.
    let stat;
    try {
      stat = lstatSync(quelle);
    } catch {
      return { ok: false, grund: `unlesbar:${rel}` };
    }
    if (stat.isSymbolicLink()) return { ok: false, grund: `symlink:${rel}` };
    if (!pathInsideSite(kopie, quelle)) return { ok: false, grund: `ausserhalb-kopie:${rel}` };
    if (!pathInsideSite(ctx.siteDir, ziel)) return { ok: false, grund: `ausserhalb-site:${rel}` };

    const inhalt = readFileSync(quelle, "utf8");
    const alt = existsSync(ziel) ? readFileSync(ziel, "utf8") : null;
    const erg = validateAgentOutput(rel, inhalt, alt, {
      siteDir: ctx.siteDir,
      browserHerkuenfte,
      anzahlBisher: i,
      // Nur für die weichen Hinweise. Hier werden sie zwar verworfen — der Lauf
      // ist vorbei, es hört niemand mehr zu —, aber der Wert gehört trotzdem
      // dazu: Sonst urteilt diese Stelle über eine andere Wissensbasis als die
      // Werkzeugprüfung während des Laufs, und ein solcher Unterschied fällt
      // erst auf, wenn jemand die Hinweise hier eines Tages doch benutzt.
      arbeitskopie: kopie,
    });
    if (!erg.ok) return { ok: false, grund: erg.grund };

    zuSchreiben.push({ rel, ziel, inhalt });
  }

  /**
   * LETZTE PRÜFUNG UNMITTELBAR VOR DEM SCHREIBEN.
   *
   * Die Fremdänderungs-Prüfung oben liest den Stand der Website EINMAL — und
   * danach läuft die gesamte Validierung: Dateien lesen, HTML parsen, Regeln
   * anwenden. Bei mehreren Dateien sind das leicht einige hundert Millisekunden.
   * Speichert der Kunde in genau diesem Fenster, ist die Prüfung längst durch
   * und der Schreibvorgang überschreibt trotzdem.
   *
   * Deshalb hier noch einmal, Datei für Datei, direkt vor dem Schreiben. Das
   * Fenster schrumpft damit von „die ganze Validierung" auf „zwischen Hash und
   * Write" — echte Atomarität gäbe es nur mit einer Sperre über den ganzen
   * Schreibweg, und die brächte einen Zustand mit sich, den ein abgestürzter
   * Lauf hinterlassen könnte.
   *
   * Abgebrochen wird VOR dem ersten Schreiben, nicht mittendrin: Sonst bliebe
   * die Website halb übernommen — der schlechteste aller Ausgänge.
   */
  const kollision = ersteKollision(zuSchreiben, ausgang);
  if (kollision) return { ok: false, grund: kollision };

  for (const { ziel, inhalt } of zuSchreiben) {
    mkdirSync(dirname(ziel), { recursive: true });
    writeFileSync(ziel, inhalt);
  }

  const dateien = zuSchreiben.map((z) => z.rel);
  const pfade = dateien.map((rel) => (ctx.sitePrefix ? `${ctx.sitePrefix}/${rel}` : rel));
  commitEdit(ctx.repoRoot, pfade, "KI-Seitenleiste: Auftrag umgesetzt");

  let commit: string | null = null;
  try {
    commit = git(ctx.repoRoot, "rev-parse", "--short", "HEAD").trim() || null;
  } catch {
    /* ohne Hash ist der Lauf trotzdem gelungen */
  }
  return { ok: true, dateien, commit };
}


/**
 * Prüft unmittelbar vor dem Schreiben, ob eine Zieldatei noch dem Ausgangsstand
 * entspricht. Liefert den Ablehnungsgrund oder `null`.
 *
 * WARUM ALS EIGENE FUNKTION: Das Zeitfenster, das sie schließt, lässt sich nicht
 * ehrlich end-to-end testen — man müsste zwischen zwei Anweisungen treffen.
 * Ein Test, der das versucht, wäre entweder flatterhaft oder er könnte gar nicht
 * anschlagen, und ein Nachweis, der nicht anschlagen kann, beweist durch sein
 * Ausbleiben nichts. Prüfbar ist dagegen die LOGIK: gleicher Hash → durch,
 * anderer oder verschwundener → Kollision. Das steht als Test da.
 *
 * `undefined` auf beiden Seiten ist ein gültiger Gleichstand: Die Datei gab es
 * beim Kopieren nicht und gibt es jetzt nicht — genau der Fall „der Agent legt
 * eine neue Datei an".
 */
export function ersteKollision(
  zuSchreiben: { rel: string; ziel: string }[],
  ausgang: Ausgangsstand | null,
): string | null {
  for (const { rel, ziel } of zuSchreiben) {
    const erwartet = ausgang?.get(rel);
    let jetzt: string | undefined;
    try {
      jetzt = existsSync(ziel) ? byteHashDatei(ziel) : undefined;
    } catch {
      return `unlesbar:${rel}`;
    }
    if (jetzt !== erwartet) return `fremd-geaendert:${rel}`;
  }
  return null;
}
