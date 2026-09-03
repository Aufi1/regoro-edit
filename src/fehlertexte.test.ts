/**
 * Kein Grund aus `agent.ts` darf unübersetzt beim Kunden ankommen.
 *
 * `agent.ts` erzeugt maschinenlesbare Gründe (`abgebrochen`,
 * `worker-abgestuerzt`, `symlink:<pfad>`), `host.ts` macht daraus deutsche
 * Sätze. Fehlt einer, fällt er durch das `default` der Übersetzung und steht
 * WÖRTLICH in der roten Sprechblase der Seitenleiste. Zweimal gemessen
 * passiert: erst `worker-abgestuerzt`, dann `abgebrochen` — letzteres auf dem
 * meistbenutzten Weg überhaupt, dem Abbrechen-Knopf.
 *
 * Dieser Test prüft deshalb keine Wortlaute, sondern eine EIGENSCHAFT: Er liest
 * die Gründe aus dem Quelltext von `agent.ts` und verlangt, dass jeder davon
 * übersetzt wird. Ein Wortlaut-Test hielte nur fest, was heute schon stimmt;
 * diese Form lässt den NÄCHSTEN neuen Grund auffallen, ohne dass jemand daran
 * denken muss.
 *
 * Der Quelltext-Scan ist Absicht und kein Notbehelf: Die Gründe sind über
 * `agent.ts` verstreut (Rückgabewerte, `??=`-Zuweisungen, Vorlagen-Strings) und
 * nirgends als Liste geführt. Eine solche Liste wäre ein zweiter Ort für
 * dieselbe Wahrheit — und würde genau dann vergessen, wenn es darauf ankommt.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentFehlerText } from "./host.ts";

const SRC = import.meta.dir;
const AGENT_TS = readFileSync(join(SRC, "agent.ts"), "utf8");
const OVERLAY_JS = readFileSync(join(SRC, "overlay.client.js"), "utf8");

/**
 * Alle Gründe, die `agent.ts` in ein `fehler`-Ereignis schreiben kann.
 *
 * Erfasst beide Bauformen:
 *   grund ??= "abgebrochen"          → schlichte Schlüsselwörter
 *   grund: `symlink:${rel}`          → Präfix plus Pfad
 * Die Gründe aus `StartErgebnis` (`laeuft-bereits`, `kontingent`,
 * `keine-sandbox`) sind NICHT dabei: Die beantwortet die POST-Route mit einem
 * eigenen Statuscode, sie erreichen den Ereignisstrom nie.
 */
function gruendeAusAgent(): string[] {
  const gefunden = new Set<string>();
  // ZEILENWEISE, nicht als ein Muster über die Zuweisung: Die Gründe stehen in
  // mindestens vier Bauformen da — `grund ??= "x"`, `grund: "x"`,
  // `grund: ergebnis.grund ?? "x"` und `` grund: `praefix:${rel}` ``. Ein
  // Muster, das die Zuweisung mitliest, verfehlt die Fallback-Form; genau die
  // trägt `lauf-gescheitert`, und der Test wäre still grün geblieben.
  for (const roh of AGENT_TS.split("\n")) {
    const start = roh.indexOf("grund");
    if (start < 0) continue;
    // NUR was hinter dem Wort `grund` steht. Sonst liest die Zeile
    // `sende(lauf, { t: "fehler", grund: … })` den EREIGNISNAMEN „fehler" als
    // Grund mit — ein falscher Treffer, der den Test gegen sich selbst richtet.
    const zeile = roh.slice(start);
    for (const m of zeile.matchAll(/"([a-z][a-z-]{3,})"/g)) gefunden.add(m[1]!);
    for (const m of zeile.matchAll(/`([a-z][a-z-]*):\$\{/g)) gefunden.add(`${m[1]!}:beispiel.html`);
  }
  return [...gefunden].sort();
}

/** Gründe, die die POST-Route beantwortet — sie gehören nicht in den Strom. */
const NUR_START = new Set(["laeuft-bereits", "kontingent", "keine-sandbox"]);

describe("jeder Grund aus agent.ts wird übersetzt", () => {
  test("der Scan findet überhaupt etwas — sonst prüft dieser Test nichts", () => {
    // Schutz gegen die stille Variante des Versagens: Ändert sich die Schreibweise
    // in agent.ts, fände die Regex nichts und alle Prüfungen unten wären trivial
    // grün. Die Zahl ist bewusst grob.
    expect(gruendeAusAgent().length).toBeGreaterThanOrEqual(8);
  });

  test.each(gruendeAusAgent().filter((g) => !NUR_START.has(g)))(
    "„%s“ kommt als deutscher Satz beim Kunden an",
    (grund) => {
      const text = agentFehlerText(grund);
      // Nicht unverändert durchgereicht. Bewusst NICHT geprüft, ob das Wort
      // selbst noch vorkommt: „Der Auftrag wurde abgebrochen." enthält
      // „abgebrochen" völlig zu Recht. Dass kein PFAD durchrutscht, prüft der
      // eigene Test darunter — das ist das Risiko, um das es geht.
      expect(text).not.toBe(grund);
      // Ein Satz, den ein Mensch liest: großer Anfangsbuchstabe, mehr als ein
      // Wort, Punkt am Ende. Bewusst keine Mindestlänge — „Kein Lauf aktiv."
      // ist kurz und trotzdem richtig.
      expect(text).toMatch(/^[A-ZÄÖÜ]/);
      expect(text).toContain(" ");
      expect(text.trimEnd()).toMatch(/\.$/);
    },
  );

  test("der Dateiname einer abgelehnten Übernahme geht NICHT an den Browser", () => {
    // Er sagt dem Kunden nichts und verrät im ungünstigen Fall die Struktur
    // eines Ausbruchsversuchs an genau den, der ihn ausgelöst hat.
    for (const grund of ["symlink:geheim.html", "ausserhalb-site:../../etc/passwd"]) {
      const text = agentFehlerText(grund);
      expect(text).not.toContain("geheim");
      expect(text).not.toContain("passwd");
      expect(text).not.toContain("..");
    }
  });

  test("frei formulierte Meldungen gehen unverändert durch", () => {
    // Validator und Recherche liefern bereits deutschen Klartext. Den hier noch
    // einmal zu übersetzen hieße, ihn zu verlieren.
    const satz = "Die Datei enthält ein neues Inline-Skript.";
    expect(agentFehlerText(satz)).toBe(satz);
  });

  test("kein toter Fall in der Übersetzung", () => {
    // Ein Fall ohne Erzeuger ist Ballast, der beim Lesen Sicherheit vortäuscht.
    // `ende` stand hier einmal und wurde von nichts erzeugt.
    const behandelt = [...(agentFehlerText.toString().matchAll(/case "([a-z-]+)"/g))].map((m) => m[1]!);
    const erzeugt = new Set(gruendeAusAgent().map((g) => g.split(":")[0]!));
    for (const fall of behandelt) {
      expect(`${fall} wird erzeugt: ${erzeugt.has(fall)}`).toBe(`${fall} wird erzeugt: true`);
    }
  });
});

describe("der Wortlaut über die Prozessgrenze", () => {
  test("overlay.client.js vergleicht genau den Satz, den host.ts sendet", () => {
    // Die Seitenleiste erkennt „es gibt hier nichts zu sehen" am Wortlaut —
    // die Fehlerform ist auf `{grund}` festgelegt, ein maschinenlesbares Feld
    // gäbe es nicht. Ohne diesen Test bricht eine Wortlautänderung in host.ts
    // die Leiste STUMM: Sie zeigte dann bei jeder frisch geöffneten Seite eine
    // Fehlermeldung, wo nur nichts passiert ist.
    const treffer = /var KEIN_LAUF = "([^"]+)";/.exec(OVERLAY_JS);
    expect(treffer).not.toBeNull();
    expect(treffer![1]).toBe(agentFehlerText("kein-lauf"));
  });
});
