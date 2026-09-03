/**
 * THIRD-PARTY-NOTICES.txt — eine Rechtspflicht, keine Fleißaufgabe.
 *
 * Der Abhängigkeitsbaum ist durchweg permissiv lizenziert (MIT, Apache-2.0,
 * BSD, ISC, BlueOak, 0BSD) — kein Copyleft. **Alle** diese Lizenzen verlangen
 * aber die Weitergabe ihrer Copyright-Hinweise, und ein
 * `bun build --compile`-Binary trägt keine einzige der Lizenzdateien mit sich.
 * `regoro licenses` schließt diese Lücke; diese Tests halten sie geschlossen.
 *
 * Zwei Fallen, die der Generator kennen muss:
 *   - `private: true`-Pakete unterhalb von `examples/` sind pi's Beispiele, keine
 *     Abhängigkeiten. Sie werden nicht ausgeliefert und gehören nicht hinein.
 *   - Kommt irgendwann eine `NOTICE`-Datei in den Baum, greift zusätzlich
 *     Apache §4(d). Der letzte Test hier ist genau dafür der Melder.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const NOTICES = join(REPO_ROOT, "THIRD-PARTY-NOTICES.txt");
const GENERATOR = join(REPO_ROOT, "scripts", "gen-notices.ts");
const LOCK = join(REPO_ROOT, "bun.lock");

/**
 * Alle Paketnamen aus bun.lock. Der Schlüssel eines Eintrags kann verschachtelt
 * sein ("dom-serializer/entities"); der echte Name steht im ersten Element des
 * Arrays, vor dem Versions-@.
 */
function paketeAusLock(): string[] {
  const roh = readFileSync(LOCK, "utf8");
  const namen = new Set<string>();
  for (const m of roh.matchAll(/^\s{4}"[^"]+":\s*\[\s*"((?:@[^"@]+\/)?[^"@]+)@/gm)) {
    namen.add(m[1]!);
  }
  return [...namen].sort();
}

/** Die Beispiel-Pakete in pi's examples/-Ordner — private, nicht ausgeliefert. */
const BEISPIEL_PAKETE = [
  "pi-extension-sandbox",
  "pi-extension-gondolin",
  "pi-extension-with-deps",
  "pi-extension-custom-provider-anthropic",
  "pi-extension-custom-provider-gitlab-duo",
];

/**
 * ZURÜCKGESTELLT (Entscheid des Orchestrators): Dev-Betrieb baut den Generator
 * zuerst und schickt danach das Ausgabeformat. Bis dahin würden diese Tests der
 * ganzen Runde als roter Lärm im Weg stehen.
 *
 * Sie schalten sich **von selbst** ein, sobald beide Artefakte da sind — kein
 * Nachtragen nötig, kein Vergessen möglich. Ändert sich das Format, ist der
 * Namensabgleich gegen bun.lock die einzige Stelle, die nachzuziehen ist.
 */
const bereit = existsSync(NOTICES) && existsSync(GENERATOR);

describe.skipIf(!bereit)("Lizenzhinweise — die Artefakte existieren", () => {
  test("scripts/gen-notices.ts ist da", () => {
    expect(existsSync(GENERATOR)).toBe(true);
  });

  test("THIRD-PARTY-NOTICES.txt ist da", () => {
    expect(existsSync(NOTICES)).toBe(true);
  });

  test("die Datei enthält Lizenz-VOLLTEXTE, nicht nur eine Namensliste", () => {
    const txt = readFileSync(NOTICES, "utf8");
    expect(txt.length).toBeGreaterThan(50_000);
    expect(txt).toContain("Permission is hereby granted, free of charge");
    expect(txt).toContain("Apache License");
  });
});

describe.skipIf(!bereit)("Lizenzhinweise — Vollständigkeit gegen bun.lock", () => {
  test("bun.lock ist überhaupt lesbar und nennt mehr als hundert Pakete", () => {
    // Wäre die Ableitung kaputt, ginge der Vollständigkeitstest still durch.
    expect(paketeAusLock().length).toBeGreaterThan(100);
    expect(paketeAusLock()).toContain("linkedom");
    expect(paketeAusLock()).toContain("@earendil-works/pi-coding-agent");
  });

  test("jedes Paket aus bun.lock kommt namentlich vor", () => {
    const txt = readFileSync(NOTICES, "utf8");
    const fehlend = paketeAusLock().filter((n) => !txt.includes(n));
    expect(fehlend).toEqual([]);
  });

  test("die tragenden Pakete stehen mit Lizenzkennung drin", () => {
    const txt = readFileSync(NOTICES, "utf8");
    for (const paket of ["@earendil-works/pi-coding-agent", "linkedom"]) {
      expect(txt).toContain(paket);
    }
    expect(txt).toContain("MIT");
  });
});

describe.skipIf(!bereit)("Lizenzhinweise — was NICHT hineingehört", () => {
  test.each(BEISPIEL_PAKETE)("%s ist ein private:true-Beispiel und steht nicht drin", (name) => {
    // Sonst erzeugt der Generator Einträge für Pakete, die gar nicht
    // ausgeliefert werden — und für die es folgerichtig keine Lizenzdatei gibt.
    expect(readFileSync(NOTICES, "utf8")).not.toContain(name);
  });

  test("kein Pfad aus dem Bauverzeichnis dieser Maschine steht drin", () => {
    // Ein Generator, der Pfade mitschreibt, verrät die Verzeichnisstruktur des
    // Bauhosts an jeden Kunden, der `regoro licenses` aufruft.
    const txt = readFileSync(NOTICES, "utf8");
    expect(txt).not.toContain("/srv/work/repos");
    expect(txt).not.toContain("node_modules/");
  });
});

describe("Lizenzhinweise — Apache §4(d) ist derzeit nicht ausgelöst", () => {
  test("im Abhängigkeitsbaum liegt keine NOTICE-Datei", () => {
    // Solange das stimmt, entfällt die zusätzliche Pflicht, NOTICE-Inhalte
    // weiterzugeben. Wird dieser Test rot, ist eine dazugekommen — dann muss
    // gen-notices.ts sie mitnehmen. Der Test ist der Melder dafür.
    const treffer: string[] = [];
    const suche = (dir: string, tiefe: number) => {
      if (tiefe > 4 || treffer.length > 0) return;
      let eintraege;
      try {
        eintraege = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of eintraege) {
        if (e.isDirectory()) suche(join(dir, e.name), tiefe + 1);
        else if (/^NOTICE(\.|$)/i.test(e.name)) treffer.push(join(dir, e.name));
      }
    };
    const nm = join(REPO_ROOT, "node_modules");
    if (existsSync(nm) && statSync(nm).isDirectory()) suche(nm, 0);
    expect(treffer).toEqual([]);
  });
});

// Der byte-genaue Abgleich („Datei ist nicht veraltet") gehört in den
// Release-Workflow: dort läuft `bun scripts/gen-notices.ts` und danach
// `git diff --exit-code`. In der Suite ginge das nur, indem der Test die Datei im
// Arbeitsverzeichnis überschreibt — das darf ein Test nicht. Der Namensabgleich
// oben fängt die häufigste Veralterung (ein neues Paket fehlt) trotzdem ab.
