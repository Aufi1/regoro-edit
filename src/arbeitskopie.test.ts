/**
 * arbeitskopie.ts — der Agent arbeitet auf einer Kopie, nie auf der Website.
 *
 * Das ist Invariante 1b: Der Agent erzeugt Markup, schreibt es aber nie in die
 * ausgelieferte Website. Er schreibt in eine Arbeitskopie außerhalb des
 * Site-Ordners; der Server übernimmt daraus nur, was der Validator bestanden hat.
 *
 * Zwei Eigenschaften trägt diese Datei:
 *   1. Die Kopie enthält **keine** Segmente mit führendem Punkt — kein `.git`,
 *      kein `.regoro`, kein `.pi`. Sonst läge das Sitzungsgeheimnis in einem
 *      Verzeichnis, in das der Agent schreiben darf.
 *   2. Der Site-Ordner bleibt beim Kopieren und Vergleichen **byteidentisch**.
 */
import { describe, expect, test, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync, mkdirSync, statSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";

import {
  runtimeWurzel,
  legeArbeitskopieAn,
  ermittleAenderungen,
  leseStand,
  raeumeAuf,
  raeumeVerwaisteAuf,
  type Aenderungen,
} from "./arbeitskopie.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");

const tmpRoots: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/** Eine Website wie im Betrieb: Inhalte plus .git, .regoro und (böswillig) .pi. */
function makeSite(): string {
  const siteDir = makeTmpDir("regoro-ak-site-");
  cpSync(REAL_SITE, siteDir, { recursive: true });
  mkdirSync(join(siteDir, ".regoro"), { recursive: true, mode: 0o700 });
  writeFileSync(join(siteDir, ".regoro", "auth.json"), JSON.stringify({ v: 2, secret: "geheim-geheim-geheim" }));
  mkdirSync(join(siteDir, ".git"), { recursive: true });
  writeFileSync(join(siteDir, ".git", "config"), "[core]\n");
  mkdirSync(join(siteDir, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(siteDir, ".pi", "extensions", "alt.ts"), "export default {}");
  mkdirSync(join(siteDir, "assets", ".versteckt"), { recursive: true });
  writeFileSync(join(siteDir, "assets", ".versteckt", "notiz.txt"), "intern");
  return siteDir;
}

/** Jede Datei unterhalb von dir, relativ, sortiert — Dotfiles ausdrücklich mit. */
function alleDateien(dir: string, wurzel = dir): string[] {
  const raus: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) raus.push(...alleDateien(p, wurzel));
    else raus.push(relative(wurzel, p).split(sep).join("/"));
  }
  return raus.sort();
}

/** Byte-Schnappschuss: relativer Pfad → sha256. */
function schnappschuss(dir: string): Record<string, string> {
  const raus: Record<string, string> = {};
  for (const rel of alleDateien(dir)) {
    raus[rel] = createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex");
  }
  return raus;
}

/** RUNTIME_DIRECTORY auf einen eigenen tmp-Ordner umbiegen. */
function mitRuntimeWurzel(): string {
  const wurzel = makeTmpDir("regoro-ak-run-");
  process.env.RUNTIME_DIRECTORY = wurzel;
  return wurzel;
}

const runtimeVorher = process.env.RUNTIME_DIRECTORY;

afterEach(() => {
  if (runtimeVorher === undefined) delete process.env.RUNTIME_DIRECTORY;
  else process.env.RUNTIME_DIRECTORY = runtimeVorher;
});

afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("arbeitskopie.ts — runtimeWurzel()", () => {
  test("$RUNTIME_DIRECTORY hat Vorrang — systemd räumt es beim Dienstende selbst auf", () => {
    process.env.RUNTIME_DIRECTORY = "/run/regoro-edit";
    expect(runtimeWurzel()).toBe("/run/regoro-edit");
  });

  test("ohne $RUNTIME_DIRECTORY das Temp-Verzeichnis", () => {
    delete process.env.RUNTIME_DIRECTORY;
    expect(runtimeWurzel()).toBe(tmpdir());
  });

  test("wird bei jedem Aufruf neu gelesen, nicht beim Import eingefroren", () => {
    delete process.env.RUNTIME_DIRECTORY;
    const a = runtimeWurzel();
    process.env.RUNTIME_DIRECTORY = "/run/anders";
    expect(runtimeWurzel()).not.toBe(a);
  });
});

describe("arbeitskopie.ts — legeArbeitskopieAn()", () => {
  test("liegt unter der Runtime-Wurzel und heißt lauf-<uuid>", () => {
    const wurzel = mitRuntimeWurzel();
    const kopie = legeArbeitskopieAn(makeSite());
    expect(kopie.startsWith(wurzel + sep)).toBe(true);
    expect(relative(wurzel, kopie)).toMatch(/^lauf-[0-9a-f-]{36}$/);
  });

  test("liegt AUSSERHALB des Site-Ordners — das ist der ganze Punkt", () => {
    mitRuntimeWurzel();
    const siteDir = makeSite();
    const kopie = legeArbeitskopieAn(siteDir);
    expect(kopie.startsWith(siteDir + sep)).toBe(false);
  });

  test("bekommt 0700 — kein anderer Benutzer des Hosts liest mit", () => {
    mitRuntimeWurzel();
    expect(statSync(legeArbeitskopieAn(makeSite())).mode & 0o777).toBe(0o700);
  });

  test("zwei Läufe bekommen verschiedene Verzeichnisse", () => {
    mitRuntimeWurzel();
    const siteDir = makeSite();
    expect(legeArbeitskopieAn(siteDir)).not.toBe(legeArbeitskopieAn(siteDir));
  });

  test("die Inhalte der Website sind da, inklusive Unterordner", () => {
    mitRuntimeWurzel();
    const kopie = legeArbeitskopieAn(makeSite());
    expect(alleDateien(kopie)).toEqual([
      "agb.html",
      "assets/hero.png",
      "assets/team.png",
      "datenschutz.html",
      "impressum.html",
      "index.html",
      "robots.txt",
      "styles.css",
    ]);
  });

  test("Binärdateien kommen unbeschädigt an", () => {
    mitRuntimeWurzel();
    const siteDir = makeSite();
    const kopie = legeArbeitskopieAn(siteDir);
    expect(readFileSync(join(kopie, "assets", "hero.png"))).toEqual(readFileSync(join(siteDir, "assets", "hero.png")));
  });
});

describe("arbeitskopie.ts — nichts mit führendem Punkt wird kopiert", () => {
  test(".regoro, .git und .pi bleiben draußen", () => {
    mitRuntimeWurzel();
    const kopie = legeArbeitskopieAn(makeSite());
    expect(existsSync(join(kopie, ".regoro"))).toBe(false);
    expect(existsSync(join(kopie, ".git"))).toBe(false);
    expect(existsSync(join(kopie, ".pi"))).toBe(false);
  });

  test("das Sitzungsgeheimnis taucht in der Kopie nirgends auf", () => {
    mitRuntimeWurzel();
    const kopie = legeArbeitskopieAn(makeSite());
    for (const rel of alleDateien(kopie)) {
      expect(readFileSync(join(kopie, rel), "utf8")).not.toContain("geheim-geheim-geheim");
    }
  });

  test("auch verschachtelte Punkt-Verzeichnisse bleiben draußen", () => {
    mitRuntimeWurzel();
    const kopie = legeArbeitskopieAn(makeSite());
    expect(existsSync(join(kopie, "assets", ".versteckt"))).toBe(false);
    expect(alleDateien(kopie).some((rel: string) => rel.split("/").some((seg: string) => seg.startsWith(".")))).toBe(false);
  });
});

describe("arbeitskopie.ts — der Site-Ordner bleibt byteidentisch", () => {
  test("Anlegen der Kopie verändert die Website nicht", () => {
    mitRuntimeWurzel();
    const siteDir = makeSite();
    const vorher = schnappschuss(siteDir);
    legeArbeitskopieAn(siteDir);
    expect(schnappschuss(siteDir)).toEqual(vorher);
  });

  test("Schreiben in der Kopie verändert die Website nicht", () => {
    mitRuntimeWurzel();
    const siteDir = makeSite();
    const vorher = schnappschuss(siteDir);
    const kopie = legeArbeitskopieAn(siteDir);
    writeFileSync(join(kopie, "index.html"), "<html>komplett anders</html>");
    writeFileSync(join(kopie, "neu.html"), "<html>neu</html>");
    rmSync(join(kopie, "agb.html"));
    expect(schnappschuss(siteDir)).toEqual(vorher);
  });

  test("Ermitteln der Änderungen verändert die Website nicht", () => {
    mitRuntimeWurzel();
    const siteDir = makeSite();
    const kopie = legeArbeitskopieAn(siteDir);
    writeFileSync(join(kopie, "index.html"), "<html>anders</html>");
    const vorher = schnappschuss(siteDir);
    ermittleAenderungen(kopie, siteDir);
    expect(schnappschuss(siteDir)).toEqual(vorher);
  });
});

describe("arbeitskopie.ts — ermittleAenderungen()", () => {
  function laufMit(tu: (kopie: string) => void): { aend: Aenderungen; siteDir: string; kopie: string } {
    mitRuntimeWurzel();
    const siteDir = makeSite();
    const kopie = legeArbeitskopieAn(siteDir);
    tu(kopie);
    return { aend: ermittleAenderungen(kopie, siteDir), siteDir, kopie };
  }

  /**
   * DER DATENVERLUST, DEN GREPTILE GEFUNDEN HAT.
   *
   * `ermittleAenderungen` verglich die Arbeitskopie mit dem JETZIGEN Stand der
   * Website. Speichert der Kunde während eines Laufs eine Seite von Hand, sieht
   * dieser Vergleich einen Unterschied — und meldet die Datei als „vom Agenten
   * geändert", obwohl der Agent sie nie angefasst hat. Die Übernahme schrieb
   * die frische Kundenänderung daraufhin mit dem alten Stand aus der Kopie zu.
   * Ohne Meldung, an einer Datei, mit der der Auftrag nichts zu tun hatte.
   *
   * Der Fall ist heute erreichbar: zweiter Tab, Telefon, oder schlicht
   * Langeweile während der vier Minuten, die ein Lauf dauert.
   */
  function laufMitFremdaenderung(
    tuInKopie: (kopie: string) => void,
    tuAufSite: (siteDir: string) => void,
  ): Aenderungen {
    mitRuntimeWurzel();
    const siteDir = makeSite();
    const kopie = legeArbeitskopieAn(siteDir);
    const ausgang = leseStand(siteDir);   // wie in agent.ts: direkt nach dem Kopieren
    tuInKopie(kopie);
    tuAufSite(siteDir);                    // der Kunde speichert währenddessen
    return ermittleAenderungen(kopie, siteDir, ausgang);
  }

  test("eine Seite, die der Kunde WÄHREND des Laufs speichert, wird als fremd erkannt", () => {
    const aend = laufMitFremdaenderung(
      (k) => writeFileSync(join(k, "index.html"), "<html>vom Agenten</html>"),
      (s) => writeFileSync(join(s, "index.html"), "<html>vom Kunden</html>"),
    );
    expect(aend.fremdGeaendert).toEqual(["index.html"]);
  });

  test("eine Datei, die der Agent NIE angefasst hat, gilt nicht als geändert", () => {
    // Der eigentliche Verlust: Vorher landete sie in `geaendert` — allein weil
    // die Website inzwischen anders aussah als die Kopie — und wurde
    // zurückgeschrieben.
    const aend = laufMitFremdaenderung(
      () => {},
      (s) => writeFileSync(join(s, "index.html"), "<html>vom Kunden</html>"),
    );
    expect(aend.geaendert).toEqual([]);
    expect(aend.fremdGeaendert).toEqual([]);
  });

  test("Gegenprobe: ohne Fremdänderung bleibt fremdGeaendert leer", () => {
    // Ohne diesen Fall wäre der Test darüber auch dann grün, wenn JEDE
    // Änderung als fremd gälte — dann käme nie ein Auftrag durch.
    const aend = laufMitFremdaenderung(
      (k) => writeFileSync(join(k, "index.html"), "<html>vom Agenten</html>"),
      () => {},
    );
    expect(aend.geaendert).toEqual(["index.html"]);
    expect(aend.fremdGeaendert).toEqual([]);
  });

  test("unveränderte Kopie → alles leer", () => {
    const { aend } = laufMit(() => {});
    expect(aend).toEqual({ geaendert: [], neu: [], geloescht: [], fremdGeaendert: [] });
  });

  test("geänderte Datei landet in geaendert", () => {
    const { aend } = laufMit((k) => writeFileSync(join(k, "index.html"), "<html>anders</html>"));
    expect(aend.geaendert).toEqual(["index.html"]);
    expect(aend.neu).toEqual([]);
    expect(aend.geloescht).toEqual([]);
  });

  test("neue Datei landet in neu, auch im Unterordner", () => {
    const { aend } = laufMit((k) => {
      writeFileSync(join(k, "leistungen.html"), "<html>neu</html>");
      mkdirSync(join(k, "assets", "js"), { recursive: true });
      writeFileSync(join(k, "assets", "js", "app.js"), "1");
    });
    expect(aend.neu).toEqual(["assets/js/app.js", "leistungen.html"]);
  });

  test("gelöschte Datei landet in geloescht", () => {
    const { aend } = laufMit((k) => rmSync(join(k, "agb.html")));
    expect(aend.geloescht).toEqual(["agb.html"]);
  });

  test("gleicher Inhalt mit neuem Zeitstempel gilt NICHT als geändert", () => {
    // Verglichen wird über fileSha256, nicht über mtime — sonst entstünde bei
    // jedem Lauf ein Commit über die ganze Website.
    const { aend } = laufMit((k) => {
      const p = join(k, "index.html");
      writeFileSync(p, readFileSync(p));
    });
    expect(aend.geaendert).toEqual([]);
  });

  test("Binärdateien werden byteweise verglichen", () => {
    const { aend } = laufMit((k) => writeFileSync(join(k, "assets", "hero.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    expect(aend.geaendert).toEqual(["assets/hero.png"]);
  });

  test(".regoro und .git der Website erscheinen NIE als gelöscht", () => {
    // Sie sind nie kopiert worden. Wer den Vergleich naiv führt, hält sie für
    // gelöscht — und der Übernahmeschritt entfernt das Sitzungsgeheimnis
    // und die ganze Versionsgeschichte.
    const { aend } = laufMit(() => {});
    const alles = [...aend.geaendert, ...aend.neu, ...aend.geloescht];
    expect(alles.filter((rel: string) => rel.split("/").some((seg: string) => seg.startsWith(".")))).toEqual([]);
  });

  test("Pfade sind relativ, mit Schrägstrich, und sortiert", () => {
    const { aend } = laufMit((k) => {
      writeFileSync(join(k, "zzz.html"), "z");
      writeFileSync(join(k, "aaa.html"), "a");
      mkdirSync(join(k, "unter"), { recursive: true });
      writeFileSync(join(k, "unter", "mmm.html"), "m");
    });
    expect(aend.neu).toEqual(["aaa.html", "unter/mmm.html", "zzz.html"]);
    expect(aend.neu.every((rel: string) => !rel.startsWith("/"))).toBe(true);
  });

  test("mehrere Änderungsarten gleichzeitig", () => {
    const { aend } = laufMit((k) => {
      writeFileSync(join(k, "index.html"), "<html>anders</html>");
      writeFileSync(join(k, "leistungen.html"), "<html>neu</html>");
      rmSync(join(k, "agb.html"));
    });
    expect(aend).toEqual({
      geaendert: ["index.html"],
      neu: ["leistungen.html"],
      geloescht: ["agb.html"],
      fremdGeaendert: [],
    });
  });
});

describe("arbeitskopie.ts — Aufräumen", () => {
  test("raeumeAuf entfernt die Kopie vollständig", () => {
    mitRuntimeWurzel();
    const kopie = legeArbeitskopieAn(makeSite());
    raeumeAuf(kopie);
    expect(existsSync(kopie)).toBe(false);
  });

  test("raeumeAuf wirft nicht, wenn die Kopie schon weg ist", () => {
    mitRuntimeWurzel();
    const kopie = legeArbeitskopieAn(makeSite());
    raeumeAuf(kopie);
    expect(() => raeumeAuf(kopie)).not.toThrow();
  });

  test("raeumeAuf lässt den Site-Ordner unberührt", () => {
    mitRuntimeWurzel();
    const siteDir = makeSite();
    const vorher = schnappschuss(siteDir);
    raeumeAuf(legeArbeitskopieAn(siteDir));
    expect(schnappschuss(siteDir)).toEqual(vorher);
  });

  test("raeumeVerwaisteAuf entfernt alte lauf-* beim Serverstart", () => {
    // Ein Serverneustart mitten im Lauf lässt eine Kopie zurück; ohne diesen
    // Schritt füllt sich /run über Wochen.
    const wurzel = mitRuntimeWurzel();
    const siteDir = makeSite();
    const a = legeArbeitskopieAn(siteDir);
    const b = legeArbeitskopieAn(siteDir);
    raeumeVerwaisteAuf();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(wurzel)).toBe(true);
  });

  test("raeumeVerwaisteAuf fasst nur lauf-* an, nichts anderes im Runtime-Verzeichnis", () => {
    const wurzel = mitRuntimeWurzel();
    writeFileSync(join(wurzel, "regoro.sock"), "");
    mkdirSync(join(wurzel, "sonstiges"), { recursive: true });
    writeFileSync(join(wurzel, "sonstiges", "wichtig.txt"), "bleibt");
    legeArbeitskopieAn(makeSite());
    raeumeVerwaisteAuf();
    expect(existsSync(join(wurzel, "regoro.sock"))).toBe(true);
    expect(existsSync(join(wurzel, "sonstiges", "wichtig.txt"))).toBe(true);
  });

  test("raeumeVerwaisteAuf wirft nicht, wenn es die Wurzel nicht gibt", () => {
    process.env.RUNTIME_DIRECTORY = join(tmpdir(), "regoro-gibt-es-nicht-" + Date.now());
    expect(() => raeumeVerwaisteAuf()).not.toThrow();
  });
});
