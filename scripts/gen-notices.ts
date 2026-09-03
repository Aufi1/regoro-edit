#!/usr/bin/env bun
/**
 * Erzeugt THIRD-PARTY-NOTICES.txt aus dem Abhängigkeitsbaum.
 *
 * Warum das kein Beiwerk ist: `regoro` wird als EINE ausführbare Datei
 * ausgeliefert (`bun build --compile`). Darin steckt der gesamte
 * Abhängigkeitsbaum — aber **keine einzige** der Lizenzdateien aus
 * node_modules. Alle Lizenzen im Baum sind permissiv (MIT, Apache-2.0, BSD,
 * ISC, BlueOak, 0BSD), kein Copyleft; jede einzelne verlangt jedoch, die
 * Copyright- und Lizenzhinweise mitzuliefern. Diese Datei ist die Erfüllung
 * dieser Pflicht, `regoro licenses` ihre Ausgabe.
 *
 * Aufruf:  bun scripts/gen-notices.ts        (schreibt THIRD-PARTY-NOTICES.txt)
 *          bun scripts/gen-notices.ts --check (nur prüfen, schreibt nicht)
 *
 * Der Release-Workflow ruft `--check` auf: eine veraltete Datei ist ein roter
 * Build, kein stiller Rechtsverstoß.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const LOCK = join(REPO_ROOT, "bun.lock");
const NODE_MODULES = join(REPO_ROOT, "node_modules");
const ZIEL = join(REPO_ROOT, "THIRD-PARTY-NOTICES.txt");
const SPDX_DIR = join(import.meta.dir, "spdx");

/**
 * Dateinamen, unter denen ein Paket seinen Lizenztext ablegt. Bewusst breit und
 * case-insensitiv: im Baum liegen `LICENSE`, `license`, `LICENSE.md`,
 * `LICENSE.txt`, `LICENCE.md`, `License` und `LICENSE-MIT` nebeneinander. Eine
 * Suche nur nach "LICENSE" verlöre gemessen 15 Pakete — und jedes fehlende ist
 * ein Copyright-Hinweis, den wir schulden.
 */
const LIZENZ_DATEI = /^(LICEN[CS]E|COPYING)([.\-].*)?$/i;

type Paket = {
  name: string;
  version: string;
  /** SPDX-Kennung aus package.json, oder null wenn nicht ermittelbar. */
  spdx: string | null;
  /** Volltext aus der Lizenzdatei des Pakets, oder null wenn keine mitgeliefert wird. */
  text: string | null;
  /** Gesetzt, wenn das Paket auf diesem Bauhost gar nicht installiert ist. */
  hinweis: string | null;
};

/**
 * Liest bun.lock. Die Datei ist **JSONC, nicht JSON** — bun schreibt bewusst
 * Trailing Commas hinein (bessere Diffs). `JSON.parse` scheitert daran
 * nachweislich an Zeile 10. Deshalb erst die Kommas vor `}`/`]` entfernen.
 *
 * Bewusst KEIN Rückfall auf eine Regex-Notlösung: Ein Generator, der bei
 * kaputtem Lockfile stillschweigend eine kürzere Liste erzeugt, produziert
 * genau den Rechtsfehler, den er verhindern soll. Lieber laut scheitern.
 */
function lesePakete(): Map<string, { name: string; version: string }> {
  const roh = readFileSync(LOCK, "utf8");
  let daten: { packages?: Record<string, unknown[]> };
  try {
    daten = JSON.parse(roh.replace(/,(\s*[}\]])/g, "$1"));
  } catch (err) {
    throw new Error(
      `bun.lock lässt sich nicht lesen: ${err instanceof Error ? err.message : String(err)}\n` +
        "  Ohne die Paketliste wäre die Lizenzdatei unvollständig. Abgebrochen.",
    );
  }
  const pakete = new Map<string, { name: string; version: string }>();
  for (const [schluessel, eintrag] of Object.entries(daten.packages ?? {})) {
    // Format: "<key>": ["<name>@<version>", "<hint>", {…}, "<integrity>"]
    // Name und Version kommen aus eintrag[0], NICHT aus dem Schlüssel: bei
    // verschachtelten Auflösungen ist der Schlüssel ein Pfad
    // ("dom-serializer/entities"), der Name steht nur im ersten Element.
    const kennung = eintrag[0];
    if (typeof kennung !== "string") continue;
    const trenner = kennung.lastIndexOf("@");
    if (trenner <= 0) continue;
    pakete.set(schluessel, {
      name: kennung.slice(0, trenner),
      version: kennung.slice(trenner + 1),
    });
  }
  return pakete;
}

/**
 * Findet das Verzeichnis eines Pakets auf der Platte. Erst der Normalfall
 * (direkt unter node_modules), dann die verschachtelten Auflösungen
 * (node_modules/<eltern>/node_modules/<name>), die bun bei Versionskonflikten
 * anlegt. Die Version wird gegengeprüft — sonst nähme man bei einem Konflikt
 * den Lizenztext der falschen Fassung.
 */
function findeVerzeichnis(name: string, version: string): string | null {
  const passt = (dir: string): boolean => {
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) return false;
    try {
      return JSON.parse(readFileSync(pj, "utf8")).version === version;
    } catch {
      return false;
    }
  };

  const direkt = join(NODE_MODULES, name);
  if (passt(direkt)) return direkt;

  // Verschachtelt: jedes Top-Level-Paket kann ein eigenes node_modules haben.
  for (const eintrag of readdirSync(NODE_MODULES, { withFileTypes: true })) {
    if (!eintrag.isDirectory() || eintrag.name === ".bin") continue;
    const basis = join(NODE_MODULES, eintrag.name);
    const kandidaten = eintrag.name.startsWith("@")
      ? readdirSync(basis, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => join(basis, e.name, "node_modules", name))
      : [join(basis, "node_modules", name)];
    for (const k of kandidaten) if (passt(k)) return k;
  }
  return null;
}

/** Der mitgelieferte Lizenztext eines Pakets, oder null. */
function leseLizenztext(dir: string): string | null {
  const datei = readdirSync(dir).filter((f) => LIZENZ_DATEI.test(f)).sort()[0];
  if (!datei) return null;
  const text = readFileSync(join(dir, datei), "utf8").trim();
  return text.length > 0 ? text : null;
}

/**
 * Normalisiert das `license`-Feld. npm kannte historisch auch ein `licenses`-
 * Array und ein Objekt statt eines Strings; im aktuellen Baum kommt beides
 * nicht vor, aber ein Update kann es jederzeit hereintragen — und dann soll
 * die Kennung nicht stillschweigend zu "[object Object]" werden.
 */
function spdxAus(pj: Record<string, unknown>): string | null {
  const lic = pj.license;
  if (typeof lic === "string" && lic.trim()) return lic.trim();
  if (lic && typeof lic === "object" && typeof (lic as { type?: unknown }).type === "string") {
    return (lic as { type: string }).type;
  }
  const alt = pj.licenses;
  if (Array.isArray(alt)) {
    const kennungen = alt
      .map((e) => (typeof e === "string" ? e : (e as { type?: string })?.type))
      .filter((e): e is string => typeof e === "string");
    if (kennungen.length > 0) return kennungen.join(" OR ");
  }
  return null;
}

/**
 * Die acht Plattform-Varianten von @mariozechner/clipboard (darwin, win32,
 * andere Architekturen) stehen im Lockfile, sind auf diesem Bauhost aber nicht
 * installiert — für andere Release-Ziele werden sie sehr wohl ausgeliefert.
 * Sie deshalb wegzulassen wäre falsch; ihre Lizenz zu erfinden ebenfalls.
 * Was wir belegen können, steht hier: Elternpaket und die installierten
 * Geschwistervarianten führen alle MIT.
 */
function nichtInstalliert(name: string): { spdx: string | null; hinweis: string } {
  const eltern = name.replace(/-(darwin|linux|win32)-.*$/, "");
  const elternPj = join(NODE_MODULES, eltern, "package.json");
  if (eltern !== name && existsSync(elternPj)) {
    try {
      const spdx = spdxAus(JSON.parse(readFileSync(elternPj, "utf8")));
      if (spdx) {
        return {
          spdx,
          hinweis:
            `Plattform-Variante von ${eltern}; auf dem Bauhost dieser Fassung nicht ` +
            `installiert. Die Lizenzkennung stammt aus ${eltern} derselben Version, ` +
            "nicht aus dem Paket selbst. Ein Lizenztext lag nicht vor.",
        };
      }
    } catch {
      // Fällt unten auf den ehrlichen Nicht-weiß-Fall zurück.
    }
  }
  return {
    spdx: null,
    hinweis:
      "Auf dem Bauhost dieser Fassung nicht installiert; weder Lizenzkennung " +
      "noch Lizenztext lagen vor.",
  };
}

/** Sammelt alle Pakete des Lockfiles samt Lizenzangaben. */
function sammle(): Paket[] {
  const pakete: Paket[] = [];
  const gesehen = new Set<string>();

  for (const [, { name, version }] of lesePakete()) {
    // Dieselbe Version eines Pakets kann mehrfach im Lockfile stehen
    // (verschachtelte Auflösung). Ein Eintrag genügt.
    const schluessel = `${name}@${version}`;
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);

    const dir = findeVerzeichnis(name, version);
    if (dir === null) {
      const { spdx, hinweis } = nichtInstalliert(name);
      pakete.push({ name, version, spdx, text: null, hinweis });
      continue;
    }

    const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    // private:true-Pakete werden nicht veröffentlicht und nicht ausgeliefert.
    // Im Baum sind das pi's Beispiel-Erweiterungen unter examples/ — für sie
    // gibt es folgerichtig auch keine Lizenzdatei. Ein Eintrag dafür wäre
    // schlicht falsch. Der Pfad-Test fängt zusätzlich Beispiele ohne das Flag.
    if (pj.private === true || dir.includes(`${"/"}examples${"/"}`)) continue;

    pakete.push({
      name,
      version,
      spdx: spdxAus(pj),
      text: leseLizenztext(dir),
      hinweis: null,
    });
  }

  pakete.sort((a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version));
  return pakete;
}

/** Standardtext einer SPDX-Kennung aus scripts/spdx/. */
function standardtext(spdx: string): string | null {
  const datei = join(SPDX_DIR, `${spdx}.txt`);
  return existsSync(datei) ? readFileSync(datei, "utf8").trim() : null;
}

const TRENNER = "=".repeat(78);
const UNTERSTRICH = "-".repeat(78);

function baueDatei(pakete: Paket[]): string {
  const ohneText = pakete.filter((p) => p.text === null);
  // Anhang nur für die Kennungen, die ihn wirklich brauchen — ein Standardtext
  // für eine Lizenz, deren Pakete alle ihren eigenen mitbringen, wäre Ballast.
  const brauchtStandard = [...new Set(ohneText.map((p) => p.spdx).filter((s): s is string => !!s))].sort();

  const fehlend = brauchtStandard.filter((s) => standardtext(s) === null);
  if (fehlend.length > 0) {
    throw new Error(
      `Kein Standardtext hinterlegt für: ${fehlend.join(", ")}\n` +
        `  Diese Pakete liefern keinen eigenen Lizenztext mit, und ohne Standardtext\n` +
        `  bliebe ihre Lizenz unbelegt. Text anlegen unter scripts/spdx/<Kennung>.txt.`,
    );
  }

  const verteilung = new Map<string, number>();
  for (const p of pakete) verteilung.set(p.spdx ?? "ohne Angabe", (verteilung.get(p.spdx ?? "ohne Angabe") ?? 0) + 1);

  const teile: string[] = [];

  teile.push(
    `Lizenzhinweise zu Software von Dritten
${TRENNER}

regoro wird als eine einzelne ausführbare Datei ausgeliefert. Die unten
aufgeführten Pakete sind darin enthalten. Alle verwendeten Lizenzen sind
permissiv — kein Copyleft —, verlangen aber ausnahmslos, ihre Copyright- und
Lizenzhinweise mitzuliefern. Genau dazu dient diese Datei; anzeigen lässt sie
sich mit \`regoro licenses\`.

Erzeugt von scripts/gen-notices.ts aus bun.lock und dem installierten
Abhängigkeitsbaum. NICHT von Hand bearbeiten — Änderungen gehen beim nächsten
Lauf verloren.

Pakete: ${pakete.length}
Lizenzen: ${[...verteilung].sort().map(([k, n]) => `${k} (${n})`).join(", ")}

Ohne mitgelieferten Lizenztext: ${ohneText.length} Pakete. Sie sind unten
einzeln aufgeführt, der Standardtext ihrer Lizenz steht im Anhang. Eine
Copyright-Zeile wird für sie NICHT erfunden — eine erfundene wäre schlechter
als eine fehlende.`,
  );

  for (const p of pakete) {
    const kopf = [`${TRENNER}\n${p.name}  ${p.version}`, `Lizenz: ${p.spdx ?? "ohne Angabe in package.json"}`];
    if (p.hinweis) kopf.push(p.hinweis);
    if (p.text === null && !p.hinweis) {
      kopf.push(
        "Das Paket liefert keinen Lizenztext mit. Der Standardtext dieser Lizenz " +
          "steht im Anhang.",
      );
    }
    teile.push(`${kopf.join("\n")}\n${UNTERSTRICH}\n${p.text ?? "(kein Lizenztext im Paket enthalten)"}`);
  }

  if (brauchtStandard.length > 0) {
    teile.push(
      `${TRENNER}\nANHANG: Standardtexte der Lizenzen ohne mitgelieferten Text\n${TRENNER}\n\n` +
        "Die folgenden Texte sind die unveränderten Standardfassungen. Sie gelten\n" +
        "für die oben genannten Pakete, die keinen eigenen Text mitliefern. Die\n" +
        "Platzhalter für Jahr und Rechteinhaber bleiben stehen: Wer die Rechte hält,\n" +
        "geht aus diesen Paketen nicht hervor, und Geratenes gehört nicht in eine\n" +
        "Rechtsauskunft.",
    );
    for (const spdx of brauchtStandard) {
      teile.push(`${TRENNER}\nStandardtext: ${spdx}\n${UNTERSTRICH}\n${standardtext(spdx)}`);
    }
  }

  return `${teile.join("\n\n")}\n`;
}

const pakete = sammle();
const inhalt = baueDatei(pakete);

// Der Bauhost darf sich nicht in die Ausgabe schmuggeln: `regoro licenses`
// bekommt jeder Kunde zu sehen, und ein Absolutpfad verriete ihm die
// Verzeichnisstruktur unseres Rechners.
for (const verboten of [REPO_ROOT, "node_modules/"]) {
  if (inhalt.includes(verboten)) {
    throw new Error(`Die Ausgabe enthält einen Pfad des Bauhosts (${verboten}). Abgebrochen.`);
  }
}

const pruefen = process.argv.includes("--check");
const alt = existsSync(ZIEL) ? readFileSync(ZIEL, "utf8") : null;

if (pruefen) {
  if (alt !== inhalt) {
    console.error(
      "THIRD-PARTY-NOTICES.txt ist nicht auf dem Stand des Abhängigkeitsbaums.\n" +
        "  Erzeugen mit: bun scripts/gen-notices.ts",
    );
    process.exit(1);
  }
  console.log(`THIRD-PARTY-NOTICES.txt ist aktuell (${pakete.length} Pakete).`);
} else {
  writeFileSync(ZIEL, inhalt);
  const ohneText = pakete.filter((p) => p.text === null).length;
  console.log(
    `THIRD-PARTY-NOTICES.txt geschrieben: ${pakete.length} Pakete, ` +
      `${(inhalt.length / 1024).toFixed(0)} KB, davon ${ohneText} ohne mitgelieferten Lizenztext.`,
  );
}
