/**
 * Die vier Routen der EINEN Bearbeitung (C2): Übernehmen, Verwerfen,
 * Veröffentlichen, Zustand.
 *
 * WARUM SIE EINE EIGENE DATEI HABEN UND NICHT IN `agent-routes.test.ts` STEHEN.
 *
 * Dort steuert EINE Liste zwei Prüfungen: „unangemeldet → 404" und „ohne
 * betreiberweite `ki.json` → 404". Für die Routen der KI-Seitenleiste ist das
 * richtig — ohne Modellzugang gibt es sie nicht. Für diese vier wäre es ein
 * schwerer Fehler:
 *
 *   - **Veröffentlichen muss ohne Modellzugang funktionieren.** Die allermeisten
 *     Websites haben keine `ki.json`; sie werden von Hand bearbeitet.
 *   - **Wer eine schwebende Änderung hat, während die KI abgeschaltet wird, muss
 *     sie noch übernehmen oder verwerfen können.** Sonst sperrt `regoro ki --off`
 *     den Kunden aus seinem eigenen Editor aus, und die einzige offene Änderung
 *     liegt für immer fest.
 *
 * Wer die vier trotzdem in die Agenten-Liste schiebt, zementiert genau diese
 * Kopplung — und der Test wäre grün, weil die Erwartung mit dem Fehler
 * mitgewandert ist. Deshalb steht die Gegenprobe „ohne ki.json trotzdem
 * erreichbar" hier ausdrücklich als eigener Fall.
 *
 * Aufbau wie in `agent-routes.test.ts`, weil das Muster sich bewährt hat:
 * ROUTEN (Abwesenheit) und ERREICHBAR (Anwesenheit) sind DIESELBE Liste, einmal
 * unangemeldet und einmal angemeldet gefahren. Eine Route, die es gar nicht
 * gibt, antwortet unangemeldet ebenfalls 404 — ohne die zweite Hälfte misst die
 * erste nichts.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as host from "./host.ts";
import { createAuthFile, issueCookie, loadAuthFile } from "./auth.ts";
import { entwurfPfad, stelleEntwurfBereit } from "./entwurf.ts";
import { schwebendPfad } from "./arbeitskopie.ts";
import { attrappenVersand } from "./versand.ts";
import { commitEdit } from "./git.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");
const NUMMER = "+4915120464812";
const PAGES = ["index.html", "impressum.html", "datenschutz.html", "agb.html"];

/** Alle vier, mit der Methode, unter der sie gemeint sind. */
const ROUTEN: [string, string][] = [
  ["POST", "/edit/uebernehmen"],
  ["POST", "/edit/verwerfen"],
  ["POST", "/edit/veroeffentlichen"],
  ["GET", "/edit/zustand"],
];

/**
 * Was jede liefert, wenn alles stimmt — angemeldet, auf einer frischen Site
 * ohne schwebende Änderung und ohne Unveröffentlichtes.
 *
 * Der LEERE Fall ist mit Absicht gewählt: Er kommt ohne Vorbereitung zustande
 * und kann nicht aus Versehen richtig sein. 404 hier hieße „Route nicht
 * verdrahtet" — genau der Fehler, der `/edit/agent/verlaeufe` einen Commit lang
 * tot liegen ließ, weil sie in `isApiRoute` fehlte.
 */
const ERREICHBAR: [string, string, number][] = [
  ["GET", "/edit/zustand", 200],
  // Nichts liegt an → C2: 409 `{"fehler":"keine-schwebende-aenderung"}`.
  ["POST", "/edit/uebernehmen", 409],
  // Ohne `umfang` im Rumpf → C2: 400 `{"fehler":"umfang"}`. Ein 500 wäre hier
  // ein echter Fehler: Ein leerer Rumpf ist eine gewöhnliche Anfrage.
  ["POST", "/edit/verwerfen", 400],
  // In Produktion gibt es ein Ziel, also 200 — auch wenn nichts zu schreiben
  // ist. Die Absage 403 `{"fehler":"staging"}` gehört allein dem Staging.
  ["POST", "/edit/veroeffentlichen", 200],
];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

let siteDir: string;
let ctx: host.HostCtx;

beforeEach(async () => {
  siteDir = tmp("regoro-editroutes-");
  cpSync(REAL_SITE, siteDir, { recursive: true });
  // Kein Repo IM Site-Ordner: das wäre der Zustand, den `istNichtMigriert()`
  // fail-closed abschaltet (C4). Die Historie wohnt im Entwurfs-Repo.
  stelleEntwurfBereit(siteDir);
  await createAuthFile(siteDir, [NUMMER]);
  ctx = {
    repoRoot: entwurfPfad(siteDir),
    entwurfDir: entwurfPfad(siteDir),
    schwebendDir: schwebendPfad(siteDir),
    siteDir,
    basis: "",
    staging: false,
    sitePrefix: "",
    pageWhitelist: PAGES,
    auth: loadAuthFile(siteDir),
    versand: attrappenVersand(),
    // KEIN `ki` — das ist der Normalfall einer Website ohne Modellzugang, und
    // genau in dem müssen diese vier Routen arbeiten.
    ki: null,
  };
});

function cookie(): string {
  return issueCookie(ctx.auth!).split(";")[0]!;
}

function ruf(
  methode: string,
  pfad: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<Response> {
  const url = new URL("http://localhost:8788" + pfad);
  const kopf: Record<string, string> = {};
  if (opts.cookie) kopf.cookie = opts.cookie;
  if (opts.body !== undefined) kopf["content-type"] = "application/json";
  return host.handleEditorRequest(
    new Request(url, {
      method: methode,
      headers: kopf,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    url,
    ctx,
  );
}

// ===========================================================================
// Die Auth-Wand
// ===========================================================================
describe("unangemeldet gibt es diese Routen nicht", () => {
  test("alle antworten 404 — nicht 401, nicht 403", async () => {
    // Invariante 4: API-Routen verraten unangemeldet nicht einmal, dass es
    // diesen Editor gibt. Und ein 403 wäre hier besonders teuer: Er stünde
    // neben dem 403 `{"fehler":"staging"}` und wäre von ihm nicht zu trennen.
    for (const [methode, pfad] of ROUTEN) {
      const r = await ruf(methode, pfad, { body: { umfang: "schwebend" } });
      expect(`${methode} ${pfad} → ${r.status}`).toBe(`${methode} ${pfad} → 404`);
    }
  });

  test("ein ungültiges Cookie ist wie gar keines", async () => {
    for (const [methode, pfad] of ROUTEN) {
      const r = await ruf(methode, pfad, { cookie: "regoro_edit=gefaelscht" });
      expect(`${methode} ${pfad} → ${r.status}`).toBe(`${methode} ${pfad} → 404`);
    }
  });

  test("ohne Auth-Datei sind sie auch mit Cookie zu", async () => {
    const gemerkt = cookie();
    ctx = { ...ctx, auth: null };
    for (const [methode, pfad] of ROUTEN) {
      expect((await ruf(methode, pfad, { cookie: gemerkt })).status).toBe(404);
    }
  });

  test("die 404 unterscheidet sich nicht von der einer erfundenen Route", async () => {
    const echt = await ruf("GET", "/edit/zustand");
    const erfunden = await ruf("GET", "/edit/gibtesnicht");
    expect(await echt.text()).toBe(await erfunden.text());
    expect(erfunden.status).toBe(404);
  });
});

// ===========================================================================
// Die Gegenprobe: angemeldet erreichbar — sonst misst die Wand nichts
// ===========================================================================
describe("angemeldet MÜSSEN sie erreichbar sein", () => {
  test("keine Route antwortet 404, obwohl sie verdrahtet ist", async () => {
    /**
     * OHNE DIESEN TEST BEWEISEN DIE 404-PRÜFUNGEN DARÜBER NICHTS. Eine Route,
     * die gar nicht existiert, antwortet unangemeldet ebenfalls 404 — die
     * Abwesenheitsprüfung wäre auch dann grün, wenn die Route tot ist. Genau
     * dieser Fall ist in diesem Repo schon eingetreten und blieb unbemerkt.
     *
     * Eine Route steht an ZWEI Stellen in `host.ts`: in `isApiRoute` (das ist
     * die Auth-Wand) und in der Zuordnung darunter. Wer nur die zweite ergänzt,
     * baut eine Route, die auch angemeldet 404 gibt.
     */
    const c = cookie();
    for (const [methode, pfad, erwartet] of ERREICHBAR) {
      const r = await ruf(methode, pfad, { cookie: c });
      expect(`${methode} ${pfad} → ${r.status}`).toBe(`${methode} ${pfad} → ${erwartet}`);
    }
  });

  test("und sie antworten in der vereinbarten Fehlerform", async () => {
    // „Nicht 404" allein wäre auch bei einem 500 erfüllt. C2 verlangt
    // durchgängig `{"fehler":"<kennung>","grund":"<Satz>"}` — die Kennung ist
    // das, was die Seitenleiste auswertet, der Satz das, was der Kunde liest.
    const c = cookie();

    const uebernehmen = await ruf("POST", "/edit/uebernehmen", { cookie: c });
    expect(uebernehmen.status).toBe(409);
    const u = (await uebernehmen.json()) as { fehler?: string; grund?: string };
    expect(u.fehler).toBe("keine-schwebende-aenderung");
    expect(typeof u.grund).toBe("string");

    const verwerfen = await ruf("POST", "/edit/verwerfen", { cookie: c, body: { umfang: "quatsch" } });
    expect(verwerfen.status).toBe(400);
    const v = (await verwerfen.json()) as { fehler?: string; grund?: string };
    expect(v.fehler).toBe("umfang");
    expect(typeof v.grund).toBe("string");
  });

  test("`/edit/zustand` liefert die vereinbarten Felder, nicht irgendein JSON", async () => {
    const r = await ruf("GET", "/edit/zustand", { cookie: cookie() });
    expect(r.status).toBe(200);
    const z = (await r.json()) as Record<string, unknown>;
    for (const feld of [
      "schwebend",
      "schwebendDateien",
      "unveroeffentlicht",
      "staging",
      "veroeffentlichenMoeglich",
    ]) {
      expect(`${feld}: ${feld in z}`).toBe(`${feld}: true`);
    }
    // Auf der frischen Site liegt nichts an.
    expect(z.schwebend).toBe(false);
    expect(z.schwebendDateien).toEqual([]);
    expect(z.staging).toBe(false);
  });

  test("`veroeffentlichenMoeglich` folgt dem INHALT, nicht der Laune", async () => {
    /**
     * Beide Werte, und beide aus einem Grund:
     *
     *   nichts Unveröffentlichtes → false  (ein Knopf, der nichts tut, ist ein
     *                                       kaputter Knopf)
     *   ein Commit im Entwurf     → true
     *
     * Der zweite Fall ist der, den ein Test leicht vergisst — und ohne ihn wäre
     * `false` auch dann richtig, wenn das Feld schlicht immer `false` wäre. Die
     * dritte Möglichkeit, `staging: true`, hängt an der Betriebsform und steht
     * in `staging.test.ts`.
     */
    const c = cookie();
    const vorher = (await (await ruf("GET", "/edit/zustand", { cookie: c })).json()) as Record<string, unknown>;
    expect(vorher.veroeffentlichenMoeglich).toBe(false);
    expect(vorher.unveroeffentlicht).toBe(false);

    // Eine gespeicherte Bearbeitung: geschrieben UND committet — genau das tut
    // `handleSave`, und erst der Commit macht daraus eine Version.
    writeFileSync(join(ctx.entwurfDir, "index.html"), "<html><body><h1>NEU</h1></body></html>");
    commitEdit(ctx.entwurfDir, "index.html", "Inline-Edit");

    const nachher = (await (await ruf("GET", "/edit/zustand", { cookie: c })).json()) as Record<string, unknown>;
    expect(nachher.unveroeffentlicht).toBe(true);
    expect(nachher.unveroeffentlichtAnzahl).toBe(1);
    expect(nachher.veroeffentlichenMoeglich).toBe(true);

    // Und nach dem Veröffentlichen ist wieder nichts offen.
    expect((await ruf("POST", "/edit/veroeffentlichen", { cookie: c })).status).toBe(200);
    const danach = (await (await ruf("GET", "/edit/zustand", { cookie: c })).json()) as Record<string, unknown>;
    expect(danach.unveroeffentlicht).toBe(false);
    expect(danach.veroeffentlichenMoeglich).toBe(false);
  });

  test("`verwerfen` ist idempotent — auch wenn nichts da ist", async () => {
    // C2: 200, auch ohne offene Änderung. Ein Fehler wäre hier hinderlich: Der
    // Kunde drückt „Verwerfen", weil er nichts mehr will — dass gerade nichts
    // offen ist, ist kein Problem, das er lösen müsste.
    const c = cookie();
    for (const umfang of ["schwebend", "entwurf"]) {
      const r = await ruf("POST", "/edit/verwerfen", { cookie: c, body: { umfang } });
      expect(`${umfang} → ${r.status}`).toBe(`${umfang} → 200`);
    }
  });
});

// ===========================================================================
// DER KERN DIESER DATEI: keine Kopplung an den Modellzugang
// ===========================================================================
describe("ohne betreiberweite ki.json bleiben sie erreichbar", () => {
  test("`ctx.ki === null` ändert an diesen vier Routen nichts", async () => {
    /**
     * Die Fixture setzt `ki: null` — der Normalfall. Dieser Fall macht daraus
     * eine ausdrückliche Zusicherung: Wer die vier an die Agenten-Liste hängt,
     * wird hier rot, und zwar bevor ein Kunde ohne Modellzugang merkt, dass er
     * nicht mehr veröffentlichen kann.
     */
    const c = cookie();
    for (const [methode, pfad, erwartet] of ERREICHBAR) {
      const r = await ruf(methode, pfad, { cookie: c });
      expect(`${methode} ${pfad} → ${r.status}`).toBe(`${methode} ${pfad} → ${erwartet}`);
    }
  });

  test("`ki` gar nicht gesetzt ist derselbe Fall", async () => {
    const c = cookie();
    const { ki: _weg, ...ohne } = ctx;
    ctx = ohne as host.HostCtx;
    for (const [methode, pfad, erwartet] of ERREICHBAR) {
      const r = await ruf(methode, pfad, { cookie: c });
      expect(`${methode} ${pfad} → ${r.status}`).toBe(`${methode} ${pfad} → ${erwartet}`);
    }
  });

  test("GEGENPROBE: die Agenten-Routen sind ohne ki.json sehr wohl zu", async () => {
    // Sonst wäre der Test darüber auch grün, wenn `ctx.ki` überhaupt nichts
    // mehr bewirkte — dann stünde die KI-Seitenleiste ohne Konfiguration offen,
    // und niemand sähe es an dieser Datei.
    const c = cookie();
    for (const pfad of ["/edit/agent/status", "/edit/agent/verlaeufe"]) {
      expect(`${pfad} → ${(await ruf("GET", pfad, { cookie: c })).status}`).toBe(`${pfad} → 404`);
    }
  });
});

// ===========================================================================
// Der Kill-Switch muss sie mitfassen
// ===========================================================================
describe("isEditorPath fasst die vier mit", () => {
  test("sonst greift `regoro disable` für sie nicht", () => {
    // Im Einzelbetrieb wirkt der Kill-Switch über den Guard in `server.ts`, und
    // der fragt `isEditorPath()`. Eine Route, die dort durchfällt, liefe weiter,
    // nachdem der Betreiber den Zugang entzogen hat — und `veroeffentlichen`
    // schriebe dann in eine Website, die gar nicht mehr bearbeitet werden darf.
    for (const [, pfad] of ROUTEN) {
      expect(`${pfad}: ${host.isEditorPath(pfad)}`).toBe(`${pfad}: true`);
    }
  });

  test("GEGENPROBE: eine öffentliche Seite mit ähnlichem Namen bleibt öffentlich", () => {
    for (const pfad of ["/edit-zustand.html", "/zustand.html", "/edit-veroeffentlichen.html"]) {
      expect(`${pfad}: ${host.isEditorPath(pfad)}`).toBe(`${pfad}: false`);
    }
  });
});

// ===========================================================================
// Und das Ergebnis auf der Platte: Veröffentlichen schreibt wirklich
// ===========================================================================
describe("veroeffentlichen trägt den Entwurf in die Website", () => {
  test("eine Änderung im Entwurf steht danach im Site-Ordner", async () => {
    /**
     * Die Route darf nicht bloß 200 sagen. Ohne diesen Fall wäre ein
     * `return json({ok:true})` ohne jede Wirkung grün — und der Kunde drückte
     * „Veröffentlichen", ohne dass sich je etwas änderte.
     */
    const c = cookie();
    const neu = "<html><body><h1>FRISCH VEROEFFENTLICHT</h1></body></html>";
    writeFileSync(join(ctx.entwurfDir, "index.html"), neu);

    // Vorher: der Site-Ordner kennt den neuen Stand NICHT.
    expect(existsSync(join(ctx.siteDir, "index.html"))).toBe(true);
    const vorher = await ruf("GET", "/index.html");
    expect(await vorher.text()).not.toContain("FRISCH VEROEFFENTLICHT");

    const r = await ruf("POST", "/edit/veroeffentlichen", { cookie: c });
    expect(r.status).toBe(200);

    // Nachher: die öffentliche Seite trägt ihn.
    const nachher = await ruf("GET", "/index.html");
    expect(await nachher.text()).toContain("FRISCH VEROEFFENTLICHT");
  });

  test("`.regoro/` wird dabei nicht mitkopiert", async () => {
    // Sonst landete das Entwurfs-Repo mitsamt Historie im ausgelieferten
    // Ordner — und wäre nur noch durch den Dotfile-Block verdeckt.
    const c = cookie();
    mkdirSync(join(ctx.entwurfDir, "assets"), { recursive: true });
    await ruf("POST", "/edit/veroeffentlichen", { cookie: c });
    expect(existsSync(join(ctx.siteDir, ".regoro", "entwurf", ".regoro"))).toBe(false);
    expect(existsSync(join(ctx.siteDir, "entwurf"))).toBe(false);
  });
});
