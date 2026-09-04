/**
 * kontingent.ts — der harte Kostendeckel je Website (`.regoro/kontingent.json`).
 *
 * `pi` kennt kein eingebautes maxTurns und keinen Kostendeckel. Ohne diesen
 * Zähler ist ein Lauf unbegrenzt — ein Agent, der sich verrennt, kostet dann
 * so lange Geld, bis jemand hinsieht.
 *
 * Das Kontingent zählt **pro Website**, nicht pro Sitzung. Damit greift es
 * später für einen zweiten Eingangskanal (WhatsApp) automatisch mit.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_DIR_NAME } from "./auth.ts";

import { TOKEN_KONTINGENT, pruefeKontingent, verbucheTokens, type Kontingent } from "./kontingent.ts";

const tmpRoots: string[] = [];

function makeSite(mitRegoroDir = true): string {
  const dir = mkdtempSync(join(tmpdir(), "regoro-kont-"));
  tmpRoots.push(dir);
  if (mitRegoroDir) mkdirSync(join(dir, AUTH_DIR_NAME), { recursive: true, mode: 0o700 });
  return dir;
}

function kontingentPfad(siteDir: string): string {
  return join(siteDir, AUTH_DIR_NAME, "kontingent.json");
}

function schreibeRoh(siteDir: string, inhalt: string): void {
  mkdirSync(join(siteDir, AUTH_DIR_NAME), { recursive: true, mode: 0o700 });
  writeFileSync(kontingentPfad(siteDir), inhalt);
}

/** Der laufende Monat als "YYYY-MM" — dieselbe Form, die die Datei trägt. */
function dieserMonat(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      chmodSync(join(dir, AUTH_DIR_NAME), 0o700);
    } catch {
      /* egal */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/**
 * Der teuerste gemessene Einzellauf: „neue Unterseite" auf einer echten
 * Fabrik-Seite (205.120 Token). Die Messreihe steht am Typ in `kontingent.ts`.
 */
const TEUERSTER_GEMESSENER_LAUF = 205_120;

/**
 * Ein gescheiterter Lauf kostet dieselben Token wie ein gelungener. Ein Monat
 * muss deshalb mindestens einen Fehlversuch, den zweiten Anlauf und einen
 * weiteren Auftrag tragen — sonst ist der Kunde nach einem Missgriff bis zum
 * Monatsersten ausgesperrt.
 */
const MINDESTENS_LAEUFE = 3;

describe("kontingent.ts — die Konstante", () => {
  test("TOKEN_KONTINGENT liegt bei 10.000.000 — Zwischenlösung, Messwerte stehen am Typ", () => {
    // Die Zahl ist eine Messfolge, keine Haltung: Der Verbrauch hängt an der
    // SEITENGRÖSSE, nicht an der Aufgabe. Dieselbe Aufgabe kostete 8.403 Token
    // auf der Beispielseite und 205.120 auf einer echten Fabrik-Seite.
    //
    // ZWISCHENLÖSUNG: Die Einheit selbst steht zur Ablösung an — künftig wird
    // nicht in Token, sondern in Credits abgerechnet (`usage.cost` des
    // Anbieters statt einer vorab gerechneten Zahl). Wer diesen Test anfasst,
    // sollte zuerst nachsehen, ob die Umstellung inzwischen da ist; dann fällt
    // die Konstante ganz weg, statt eine neue Zahl zu bekommen.
    expect(TOKEN_KONTINGENT).toBe(10_000_000);
  });

  test("das Kontingent trägt mehr als einen echten Lauf — daran ist die alte Grenze gescheitert", () => {
    // Genau hier lag der Fehler der 200.000: Sie erlaubte einem echten Kunden
    // EINEN Auftrag im Monat, und der wäre knapp durchgegangen. Wer die Konstante
    // das nächste Mal senkt, muss an dieser Zusicherung vorbei — und damit an der
    // Messung statt am Bauchgefühl.
    expect(TOKEN_KONTINGENT).toBeGreaterThan(TEUERSTER_GEMESSENER_LAUF * MINDESTENS_LAEUFE);
  });
});

describe("kontingent.ts — pruefeKontingent() ohne vorhandene Datei", () => {
  test("frisch angelegte Website hat das volle Kontingent", () => {
    const k: Kontingent = pruefeKontingent(makeSite());
    expect(k.frei).toBe(TOKEN_KONTINGENT);
    expect(k.erschoepft).toBe(false);
    expect(k.tokens).toBe(0);
    expect(k.laeufe).toBe(0);
    expect(k.monat).toBe(dieserMonat());
  });

  test("auch ohne .regoro-Verzeichnis — und ohne es anzulegen", () => {
    const siteDir = makeSite(false);
    const k = pruefeKontingent(siteDir);
    expect(k.frei).toBe(TOKEN_KONTINGENT);
    expect(k.erschoepft).toBe(false);
  });

  test("Prüfen allein legt keine Datei an — es ist eine Leseoperation", () => {
    const siteDir = makeSite();
    pruefeKontingent(siteDir);
    expect(existsSync(kontingentPfad(siteDir))).toBe(false);
  });
});

describe("kontingent.ts — verbucheTokens() und pruefeKontingent() zusammen", () => {
  test("Verbrauch wird abgezogen", () => {
    const siteDir = makeSite();
    verbucheTokens(siteDir, 12_345);
    const k = pruefeKontingent(siteDir);
    expect(k.tokens).toBe(12_345);
    expect(k.frei).toBe(TOKEN_KONTINGENT - 12_345);
    expect(k.erschoepft).toBe(false);
  });

  test("mehrere Buchungen summieren sich", () => {
    const siteDir = makeSite();
    verbucheTokens(siteDir, 1000);
    verbucheTokens(siteDir, 2000);
    verbucheTokens(siteDir, 3000);
    expect(pruefeKontingent(siteDir).tokens).toBe(6000);
  });

  test("jede Buchung zählt einen Lauf mit — sonst ist Missbrauch später nicht sichtbar", () => {
    const siteDir = makeSite();
    verbucheTokens(siteDir, 10);
    verbucheTokens(siteDir, 10);
    expect(pruefeKontingent(siteDir).laeufe).toBe(2);
  });

  test("die Datei wird mit 0600 angelegt und liegt in .regoro", () => {
    const siteDir = makeSite();
    verbucheTokens(siteDir, 1);
    expect(statSync(kontingentPfad(siteDir)).mode & 0o777).toBe(0o600);
  });

  test("fehlendes .regoro-Verzeichnis wird angelegt, statt still zu scheitern", () => {
    const siteDir = makeSite(false);
    verbucheTokens(siteDir, 500);
    expect(pruefeKontingent(siteDir).tokens).toBe(500);
  });

  test("die geschriebene Datei trägt v:1 und den Monat", () => {
    const siteDir = makeSite();
    verbucheTokens(siteDir, 7);
    const j = JSON.parse(readFileSync(kontingentPfad(siteDir), "utf8"));
    expect(j.v).toBe(1);
    expect(j.monat).toBe(dieserMonat());
    expect(j.tokens).toBe(7);
  });
});

describe("kontingent.ts — Erschöpfung", () => {
  test("genau aufgebraucht heißt erschöpft", () => {
    const siteDir = makeSite();
    verbucheTokens(siteDir, TOKEN_KONTINGENT);
    const k = pruefeKontingent(siteDir);
    expect(k.frei).toBe(0);
    expect(k.erschoepft).toBe(true);
  });

  test("überzogen heißt erschöpft — frei wird nie negativ", () => {
    // Ein Lauf reißt die Grenze mitten drin; die Anzeige in der Seitenleiste
    // darf danach keine negative Zahl zeigen.
    const siteDir = makeSite();
    verbucheTokens(siteDir, TOKEN_KONTINGENT + 50_000);
    const k = pruefeKontingent(siteDir);
    expect(k.frei).toBe(0);
    expect(k.erschoepft).toBe(true);
  });

  test("ein Token unter der Grenze ist noch nicht erschöpft", () => {
    const siteDir = makeSite();
    verbucheTokens(siteDir, TOKEN_KONTINGENT - 1);
    const k = pruefeKontingent(siteDir);
    expect(k.frei).toBe(1);
    expect(k.erschoepft).toBe(false);
  });
});

describe("kontingent.ts — Monatswechsel setzt zurück", () => {
  test("ein alter Monat in der Datei zählt nicht mehr", () => {
    const siteDir = makeSite();
    schreibeRoh(siteDir, JSON.stringify({ v: 1, monat: "2020-01", tokens: TOKEN_KONTINGENT, laeufe: 99 }));
    const k = pruefeKontingent(siteDir);
    expect(k.monat).toBe(dieserMonat());
    expect(k.tokens).toBe(0);
    expect(k.laeufe).toBe(0);
    expect(k.frei).toBe(TOKEN_KONTINGENT);
    expect(k.erschoepft).toBe(false);
  });

  test("die erste Buchung im neuen Monat beginnt bei null", () => {
    const siteDir = makeSite();
    schreibeRoh(siteDir, JSON.stringify({ v: 1, monat: "2020-01", tokens: 150_000, laeufe: 5 }));
    verbucheTokens(siteDir, 100);
    const k = pruefeKontingent(siteDir);
    expect(k.tokens).toBe(100);
    expect(k.laeufe).toBe(1);
    expect(k.monat).toBe(dieserMonat());
  });

  test("ein Monat in der ZUKUNFT wird nicht als laufender Monat übernommen", () => {
    // Sonst könnte eine verstellte Uhr oder eine manipulierte Datei das
    // Kontingent auf Dauer neutralisieren.
    const siteDir = makeSite();
    schreibeRoh(siteDir, JSON.stringify({ v: 1, monat: "2099-12", tokens: 0, laeufe: 0 }));
    expect(pruefeKontingent(siteDir).monat).toBe(dieserMonat());
  });
});

describe("kontingent.ts — kaputte Datei ist fail-closed", () => {
  test("kaputtes JSON heißt erschöpft, nicht „volles Kontingent\"", () => {
    // Fail-closed wie überall: kaputte Konfiguration heißt „Funktion aus", nie
    // „Funktion ohne Schutz". Wer hier auf das volle Kontingent zurückfällt,
    // macht eine beschädigte Datei zum Freifahrtschein.
    const siteDir = makeSite();
    schreibeRoh(siteDir, "{ kaputt");
    const k = pruefeKontingent(siteDir);
    expect(k.erschoepft).toBe(true);
    expect(k.frei).toBe(0);
  });

  test("falsche Version heißt erschöpft", () => {
    const siteDir = makeSite();
    schreibeRoh(siteDir, JSON.stringify({ v: 2, monat: dieserMonat(), tokens: 0, laeufe: 0 }));
    expect(pruefeKontingent(siteDir).erschoepft).toBe(true);
  });

  test("negative oder unsinnige Werte heißen erschöpft", () => {
    const siteDir = makeSite();
    schreibeRoh(siteDir, JSON.stringify({ v: 1, monat: dieserMonat(), tokens: -5_000_000, laeufe: 0 }));
    expect(pruefeKontingent(siteDir).erschoepft).toBe(true);
  });

  test("tokens als String heißt erschöpft", () => {
    const siteDir = makeSite();
    schreibeRoh(siteDir, JSON.stringify({ v: 1, monat: dieserMonat(), tokens: "0", laeufe: 0 }));
    expect(pruefeKontingent(siteDir).erschoepft).toBe(true);
  });
});

describe("kontingent.ts — verbucheTokens() wirft nie", () => {
  // Als root greifen Dateirechte nicht — der Test wäre dort ein stiller Blindgänger.
  test.skipIf(process.getuid?.() === 0)("ein nicht beschreibbares .regoro-Verzeichnis reißt den Lauf nicht mit", () => {
    const siteDir = makeSite();
    chmodSync(join(siteDir, AUTH_DIR_NAME), 0o500);
    try {
      expect(() => verbucheTokens(siteDir, 1000)).not.toThrow();
    } finally {
      chmodSync(join(siteDir, AUTH_DIR_NAME), 0o700);
    }
  });

  test("ein gar nicht vorhandener Site-Ordner wirft nicht", () => {
    expect(() => verbucheTokens("/gibt/es/nicht/kunde.de", 10)).not.toThrow();
  });

  test("0 oder eine unsinnige Zahl wirft nicht", () => {
    const siteDir = makeSite();
    expect(() => verbucheTokens(siteDir, 0)).not.toThrow();
    expect(() => verbucheTokens(siteDir, Number.NaN)).not.toThrow();
    expect(() => verbucheTokens(siteDir, -1)).not.toThrow();
  });

  test("NaN darf den Zähler nicht vergiften", () => {
    // Ein NaN in tokens macht jede spätere Prüfung unbrauchbar: NaN < x ist
    // immer falsch, das Kontingent wäre unbegrenzt.
    const siteDir = makeSite();
    verbucheTokens(siteDir, 1000);
    verbucheTokens(siteDir, Number.NaN);
    const k = pruefeKontingent(siteDir);
    expect(Number.isFinite(k.tokens)).toBe(true);
    expect(Number.isFinite(k.frei)).toBe(true);
  });
});

describe("kontingent.ts — Trennung zwischen Websites", () => {
  test("zwei Websites teilen sich kein Kontingent", () => {
    const a = makeSite();
    const b = makeSite();
    verbucheTokens(a, 100_000);
    expect(pruefeKontingent(a).tokens).toBe(100_000);
    expect(pruefeKontingent(b).tokens).toBe(0);
  });
});
