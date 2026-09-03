/**
 * Der schmale Prüfschritt zwischen Arbeitskopie und Live-Site (Invariante 1b).
 *
 * **Der Validator urteilt nie darüber, ob eine Änderung gut ist.** Ob ein
 * Abschnitt gelungen ist, ob er zur Seite passt, ob er die richtigen Klassen
 * benutzt: Das gehört in den System-Prompt, nicht in eine mechanische Prüfung.
 * Hart abgelehnt wird nur, was **kein denkbarer Kundenwunsch je erfordern
 * würde**; alles Stilistische geht als weicher Hinweis zurück und blockiert nicht.
 *
 * Reihenfolge im Rumpf: Pfadregeln → Größen/Anzahl → Rohtext-Vorprüfung →
 * linkedom-Parsen → Herkunft aller geladenen Ressourcen → Inline-Skript-Differenz
 * → weiche Hinweise.
 *
 * `ASSET_TYPES`/`PAGE_RE` kommen aus `sites.ts`, **nicht** aus `host.ts`:
 * host.ts → agent.ts → validate.ts → host.ts wäre ein Importzyklus, und ein
 * `const` daraus auf Modulebene gelesen wirft je nach Importreihenfolge
 * „Cannot access before initialization" (Contract §9).
 */
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { parseHTML } from "linkedom";
import { ASSET_TYPES, PAGE_RE } from "./sites.ts";
import { isValidHref, normalizeColor } from "./contract.ts";
import { normalisiereHerkunft } from "./integrationen.ts";

/** Notbremse gegen einen entgleisten Lauf, nicht gegen einen großen Wunsch. */
export const MAX_DATEI_BYTES = 512 * 1024;
export const MAX_DATEIEN_JE_LAUF = 20;

/**
 * Höchstens drei Pfadebenen (`assets/js/app.js`).
 *
 * Tiefer wird es in einer Fabrik-Seite nicht, und jede Ebene mehr ist eine
 * Ebene, die im Editor niemand mehr wiederfindet.
 */
const MAX_TIEFE = 3;

/** `.html` steht bewusst nicht in ASSET_TYPES — Seiten gehen den /edit-Weg. */
const ERLAUBTE_ENDUNGEN = new Set([...Object.keys(ASSET_TYPES), ".html"]);

export type ValidateKontext = {
  /** Original-Site, für bekannte CSS-Klassen und Farbwerte. */
  siteDir: string;
  /** Exakte Origins aus integrationen.json; [] wenn keine. */
  browserHerkuenfte: string[];
  /** Wie viele Dateien dieser Lauf schon geschrieben hat. */
  anzahlBisher: number;
};

export type ValidateErgebnis =
  | { ok: true; hinweise: string[] }
  | { ok: false; grund: string };

function nein(grund: string): ValidateErgebnis {
  return { ok: false, grund };
}

/**
 * Ein einzelner Verstoß, mit einem Schlüssel, der ihn wiedererkennbar macht.
 *
 * Der Schlüssel trägt die ganze Last von Contract §13.26: **Der Validator
 * beurteilt, was der Agent getan hat, nicht was die Fabrik ausgeliefert hat.**
 * Geprüft werden ganze Dateien, nicht Diffs — ein absolutes Verbot bestrafte
 * den Kunden also für den Bestand seiner eigenen Website. Gemessen: In echten
 * Fabrik-Seiten stehen 23 Verweise auf google.com und je 6 auf Instagram,
 * Facebook und gesetze-im-internet.de. Was vorher schon da war, passiert;
 * abgelehnt wird nur, was neu hinzukommt oder sich verändert hat.
 */
type Verstoss = { schluessel: string; grund: string };

/**
 * Der erste Verstoß, den es vorher noch nicht gab — oder null.
 *
 * Über eine Multimenge, damit ein zweites Vorkommen desselben Verstoßes nicht
 * durch das erste gedeckt wird: Wer eine fremde Herkunft von einem auf zwei
 * Vorkommen bringt, hat eine hinzugefügt.
 */
function ersterNeuerVerstoss(neu: Verstoss[], alt: Verstoss[]): Verstoss | null {
  const uebrig = alt.map((v) => v.schluessel);
  for (const v of neu) {
    const i = uebrig.indexOf(v.schluessel);
    if (i === -1) return v;
    uebrig.splice(i, 1);
  }
  return null;
}

// ===========================================================================
// URL-Beurteilung
// ===========================================================================

/**
 * Lesarten einer Adresse, die ein Browser haben könnte.
 *
 * Steuerzeichen und Leerraum fliegen raus, weil der Browser sie beim Laden
 * ebenfalls entfernt: `src="https://fre\nmd.de/x.png"` lädt von `fremd.de`.
 * Zusätzlich die prozentdekodierte Fassung, falls das Schema darin versteckt ist.
 *
 * Anders als beim Laden der Herkunftsliste (`normalisiereHerkunft`) wird hier
 * **gesäubert statt verworfen**: Dort ist der Text die vertrauenswürdige
 * Allowlist selbst, hier ist er die zu prüfende Behauptung. Wer säubert und
 * dann vergleicht, urteilt über das, was der Browser wirklich lädt.
 */
function urlLesarten(roh: string): string[] {
  const bereinigt = roh.replace(/[\x00-\x20]/g, "");
  const raus = [bereinigt];
  try {
    const dekodiert = decodeURIComponent(bereinigt);
    if (dekodiert !== bereinigt) raus.push(dekodiert);
  } catch {
    // Kaputte Prozentfolge — die bereinigte Fassung genügt.
  }
  return raus;
}

function schemaVon(wert: string): string | null {
  // Backslash wie Schrägstrich lesen: Browser behandeln `\evil.tld/y.png` bei
  // den Special-Schemes wie `//evil.tld/y.png` — protokollrelativ und fremd.
  const c = wert.replace(/\\/g, "/");
  const m = c.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Platzhalter-Ursprung, gegen den ein Navigationsziel aufgelöst wird. `.invalid`
 * ist per RFC 2606 dauerhaft nicht auflösbar — der Wert kann nie versehentlich
 * eine echte Herkunft treffen.
 */
const NAV_BASIS = "https://x.invalid/";
const NAV_BASIS_URSPRUNG = new URL(NAV_BASIS).origin;

/**
 * Darf dieses Navigationsziel angesteuert werden?
 *
 * **Aufgelöst, nicht zeichenweise beurteilt.** Jede Regel über den Wortlaut
 * eines Literals ist nachweislich zu umgehen — gemessen mit
 * `new URL(wert, "https://kunde.de/seite.html")`:
 *
 *   `'/kontakt.html'`     → `/kontakt.html`     → kunde.de   (eigen)
 *   `'/\/fremd.tld/x'`    → `//fremd.tld/x`     → fremd.tld  (das `//` entsteht
 *                            erst durch die Escape-Verarbeitung, im Quelltext
 *                            steht ein einzelner Schrägstrich)
 *   `'/\\fremd.tld/x'`    → `/\fremd.tld/x`     → fremd.tld  (beginnt NICHT mit
 *                            `//`, der Parser liest `\` aber wie `/`)
 *
 * Also entscheidet derselbe Parser wie im Browser. `javascript:` und `data:`
 * ergeben dabei den Ursprung `"null"` und fallen von selbst durch.
 */
function navZielErlaubt(literal: string, erlaubt: Set<string>): boolean {
  const bereinigt = literal.replace(/[\x00-\x20]/g, "");
  let ziel: URL;
  try {
    ziel = new URL(bereinigt === "" ? "/" : bereinigt, NAV_BASIS);
  } catch {
    return false; // nicht auflösbar → im Zweifel nein
  }
  if (ziel.origin === NAV_BASIS_URSPRUNG) return true;
  // Eine ausdrücklich freigeschaltete Herkunft anzusteuern ist strikt harmloser,
  // als ein Skript von ihr zu laden — und das ist bereits erlaubt.
  return erlaubt.has(ziel.origin);
}

/**
 * Darf diese geladene Ressource geladen werden? Gibt einen Ablehnungsgrund
 * zurück, oder null.
 *
 * Verglichen wird **exakt** gegen die freigeschalteten Origins (Schema, Host
 * und Port), nie per `includes` — sonst genügte
 * `https://js.stripe.com.angreifer.de`, um als js.stripe.com durchzugehen.
 */
function pruefeRessource(roh: string, erlaubt: Set<string>, datenBildErlaubt: boolean): string | null {
  for (const wert of urlLesarten(roh)) {
    const c = wert.replace(/\\/g, "/").trim();
    if (c === "") continue;
    if (c.startsWith("//")) {
      return "Protokollrelative Adressen (//host/…) laden von einer fremden Herkunft. Bitte eine seiten-relative Adresse benutzen.";
    }
    const schema = schemaVon(c);
    if (schema === null) continue; // seiten-relativ oder #anker — eigene Herkunft
    if (schema === "data") {
      // Die CSP lässt data: ausschließlich für Bilder zu (img-src 'self' data:).
      // Ein data:text/html in href oder iframe wäre ein eigener Ursprung mit
      // eigenem Skript — genau das, was die CSP verhindern soll.
      if (datenBildErlaubt && /^data:image\//i.test(c)) continue;
      return "data:-Adressen sind nur als Bildquelle zulässig (img-src 'self' data: in der CSP).";
    }
    if (schema !== "http" && schema !== "https") {
      return (
        `Das Schema "${schema}:" ist in einer geladenen Ressource nicht zulässig. ` +
        "Bilder, Schriften und Stylesheets müssen im Website-Ordner liegen und relativ eingebunden werden."
      );
    }
    let url: URL;
    try {
      url = new URL(c);
    } catch {
      return "Die Adresse einer geladenen Ressource ist nicht lesbar.";
    }
    if (erlaubt.has(url.origin)) continue;
    return (
      `Die Herkunft ${url.origin} ist für diese Website nicht freigeschaltet. ` +
      "Die Website lädt grundsätzlich nichts von fremden Servern. Lade die Datei in den Website-Ordner " +
      '(etwa nach "assets/") und binde sie von dort relativ ein. Verlinken auf fremde Seiten bleibt erlaubt.'
    );
  }
  return null;
}

/**
 * Darf dieser Hyperlink so stehen? Gibt einen Ablehnungsgrund zurück, oder null.
 *
 * Ein Link **lädt nichts** — deshalb gilt hier nicht die Herkunftsprüfung,
 * sondern dieselbe Schema-Allowlist wie im Text-Editor (`isValidHref`). Ohne
 * das wäre „verlink unsere Innung" unmöglich, und `impressum.html` und
 * `datenschutz.html` echter Fabrik-Seiten (Google-Rezensionen, Instagram,
 * gesetze-im-internet.de) fielen bei **jedem** Lauf durch, auch unberührt —
 * der Validator prüft ganze Dateien, keine Diffs.
 */
function pruefeNavigation(roh: string): string | null {
  for (const wert of urlLesarten(roh)) {
    if (wert.trim() === "") continue;
    // tel: zusätzlich zu isValidHref — eine Telefonnummer zum Antippen ist der
    // Normalfall auf einer Handwerker-Seite, und sie lädt ebenso wenig wie mailto:.
    if (schemaVon(wert) === "tel") continue;
    if (!isValidHref(wert)) {
      return "Dieser Verweis benutzt ein unzulässiges Schema. Erlaubt sind http, https, mailto, tel sowie seiten-relative Ziele und Anker.";
    }
  }
  return null;
}

// ===========================================================================
// Rohtext-Vorprüfung — der zweite Riegel neben dem Parser
// ===========================================================================

/**
 * Muster, die im **Rohtext** gezählt werden, jeweils an einen Tag-Anfang
 * gebunden.
 *
 * Die Verankerung an `<tag` ist wesentlich: Ein blindes `/on\w+\s*=/` über den
 * ganzen Text trifft „Aktion_neu=gestartet" im Fließtext und damit jede zweite
 * echte Seite. `[^>]*?` kann kein `>` überspringen, also endet die Suche am
 * Ende des Tags — und greift trotzdem bei einem Tag, dem das `>` fehlt.
 */
const ROH_MUSTER: { re: RegExp; grund: string }[] = [
  {
    re: /<iframe\b/gi,
    grund:
      "Neue <iframe>-Elemente werden nicht übernommen. Fremde Seiten einzubetten ist kein Weg, den diese Website geht — bitte verlinken.",
  },
  {
    re: /<[a-z][^>]*?\bon\w+\s*=/gis,
    grund:
      "Neue Ereignis-Attribute (onclick, onerror, …) werden nicht übernommen. JavaScript gehört in eine eigene .js-Datei, die per <script src=\"…\"> eingebunden wird.",
  },
  {
    re: /<[a-z][^>]*?\b(?:href|src|action|formaction|data)\s*=\s*["']?\s*javascript:/gis,
    grund:
      "javascript:-Adressen werden nicht übernommen — sie führen Code aus dem Verweis heraus aus. " +
      'Wenn die Seite auf einen Klick reagieren soll, lege das JavaScript in eine eigene .js-Datei und binde sie mit <script src="…"> ein.',
  },
];

function zaehle(re: RegExp, text: string): number {
  // Frischer Regex je Aufruf: /g/-Regexe tragen lastIndex mit sich herum.
  return (text.match(new RegExp(re.source, re.flags)) ?? []).length;
}

// ===========================================================================
// Skriptgesteuerte Navigation in einer .js-Datei (Contract §13.28)
// ===========================================================================

/**
 * Der stille Zweig der Weiterleitungslücke.
 *
 * Der Plan nennt eine Weiterleitung „ein sichtbarer Angriff, kein stiller".
 * Das stimmt nicht für den Weg, der aus lauter erlaubten Bausteinen besteht:
 * Eine eigene `.js`-Datei ist zulässig, `<script src="/assets/app.js">` ist
 * zulässig, und `connect-src 'none'` verbietet `fetch`, `XHR` und `sendBeacon`
 * — **nicht die Navigation**. Ein Skript, das ein Formularfeld ausliest und mit
 * dem Wert in der Query-Zeichenkette wegnavigiert, fließt an allen drei Grenzen
 * vorbei. Und es sind die Daten der Website-BESUCHER, nicht die des Kunden.
 *
 * Das ist keine Geschmacksprüfung: Eine Navigation auf eine Adresse, die sich
 * im Quelltext nicht bestimmen lässt, erfordert kein denkbarer Kundenwunsch.
 *
 * **Diese Regel ist Reibung, keine Grenze.** `window["loca"+"tion"]["hr"+"ef"] = x`
 * umgeht jedes Muster, das sich hier formulieren lässt, und das wird sich nicht
 * ändern. Sie ist trotzdem richtig, weil der realistische Gegner ein umgelenktes
 * Modell ist und kein Mensch, der diesen Validator studiert hat. Wer sich auf sie
 * als Grenze verlässt, verlässt sich auf das Falsche — die Grenzen sind die
 * Arbeitskopie, die Sandbox und die CSP.
 */
const NAV_GRUND =
  "Skriptgesteuerte Navigation auf eine nicht fest angegebene Adresse ist nicht zulässig. " +
  'Verlinke stattdessen mit einem gewöhnlichen <a href="…">, oder gib das Ziel als festen Text der eigenen Website an.';

const NAV_OBJEKT = String.raw`(?:(?:window|self|top|parent|document|globalThis)\s*\.\s*)?`;

/**
 * `location.host = …` und Geschwister ändern den Ursprung, egal welcher Wert
 * zugewiesen wird — hier hilft kein Literal-Test. `location.pathname/search/hash`
 * können den Ursprung dagegen gar nicht verlassen und bleiben ungeprüft.
 */
const JS_URSPRUNG_RE = new RegExp(
  String.raw`\b${NAV_OBJEKT}location\s*\.\s*(?:host|hostname|protocol|port)\s*=(?![=>])`,
  "gi",
);

// `=(?![=>])` schließt `==`, `===` und `=>` aus — sonst gälte `if (location == x)`
// als Navigation und jede Vergleichsoperation wäre ein Ablehnungsgrund.
const JS_ZUWEISUNG_RE = new RegExp(
  String.raw`\b${NAV_OBJEKT}location\s*(?:\.\s*href\s*)?=(?![=>])\s*([^;\n]*)`,
  "gi",
);

const JS_AUFRUF_RE = new RegExp(
  String.raw`\b${NAV_OBJEKT}location\s*\.\s*(?:assign|replace)\s*\(\s*([^,)]*)`,
  "gi",
);

// Der Lookbehind hält `xhr.open("GET", …)` heraus: ein `open` hinter einem Punkt
// gehört einem anderen Objekt. Ein blankes `open(…)` ist dagegen window.open.
const JS_OPEN_RE = /(?:\b(?:window|self|top|parent|globalThis)\s*\.\s*open|(?<![.\w$])open)\s*\(\s*([^,)]*)/gi;

/**
 * `Object.assign(location, { href: … })` setzt die Adresse über einen Umweg,
 * den keine der anderen Formen trifft. Das Ziel steckt in einem Objektliteral;
 * es statisch zu zerlegen lohnt nicht — wer so navigiert, tut es nicht, um eine
 * feste eigene Seite anzusteuern.
 */
const JS_OBJECT_ASSIGN_RE = new RegExp(
  String.raw`\bObject\s*\.\s*assign\s*\(\s*${NAV_OBJEKT}location\b`,
  "gi",
);

/** Löst JavaScript-Escapes auf — der Laufzeitwert zählt, nicht der Quelltext. */
function entkommeJs(roh: string): string {
  return roh.replace(
    /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})|\\([\s\S])/g,
    (_treffer, geschweift: string, vier: string, zwei: string, rest: string) => {
      if (geschweift) return String.fromCodePoint(parseInt(geschweift, 16));
      if (vier) return String.fromCharCode(parseInt(vier, 16));
      if (zwei) return String.fromCharCode(parseInt(zwei, 16));
      const bekannt: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
      // `\/` → `/` und `\\` → `\`: genau die zwei Formen, mit denen sich ein
      // `//fremd.tld` im Quelltext verstecken lässt.
      return bekannt[rest] ?? rest;
    },
  );
}

/** Der Wert eines alleinstehenden String-Literals, oder null bei allem anderen. */
function stringLiteral(ausdruck: string): string | null {
  const t = ausdruck.trim();
  const m = t.match(/^(['"`])((?:\\[\s\S]|[^\\])*?)\1$/);
  return m ? entkommeJs(m[2] ?? "") : null;
}

function jsVerstoesse(js: string, erlaubt: Set<string>): Verstoss[] {
  const raus: Verstoss[] = [];
  // Formen, bei denen kein Wert harmlos sein kann: `location.host = …` wechselt
  // den Ursprung, egal was zugewiesen wird, und `Object.assign` versteckt das
  // Ziel in einem Objektliteral. `location.hash` und `location.search` stehen
  // bewusst NICHT dabei — sie können den Ursprung gar nicht verlassen.
  for (const re of [JS_URSPRUNG_RE, JS_OBJECT_ASSIGN_RE]) {
    for (const m of js.matchAll(re)) {
      raus.push({ schluessel: `js-ursprung:${m[0].replace(/\s+/g, "")}`, grund: NAV_GRUND });
    }
  }
  for (const re of [JS_ZUWEISUNG_RE, JS_AUFRUF_RE, JS_OPEN_RE]) {
    for (const m of js.matchAll(re)) {
      const ausdruck = (m[1] ?? "").trim();
      const literal = stringLiteral(ausdruck);
      // Nur ein fest angegebenes Ziel passiert. Bei `location.href = basis + wert`
      // ist statisch nicht entscheidbar, wohin es geht — und genau das ist der
      // Exfiltrationsweg.
      if (literal !== null && navZielErlaubt(literal, erlaubt)) continue;
      raus.push({ schluessel: `js-nav:${ausdruck.replace(/\s+/g, "")}`, grund: NAV_GRUND });
    }
  }
  return raus;
}

// ===========================================================================
// Wissen über die bestehende Website (nur für weiche Hinweise)
// ===========================================================================

type SiteWissen = { klassen: Set<string>; farben: Set<string> };

const wissenCache = new Map<string, SiteWissen>();

/** Für Tests: verwirft das gemerkte Wissen über alle Sites. */
export function leereSiteWissenCache(): void {
  wissenCache.clear();
}

const KLASSEN_SELEKTOR_RE = /\.(-?[_a-zA-Z][\w-]*)/g;
const FARB_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const CLASS_ATTR_RE = /\bclass\s*=\s*"([^"]*)"|\bclass\s*=\s*'([^']*)'/gi;

function ernteCss(css: string, wissen: SiteWissen): void {
  for (const m of css.matchAll(KLASSEN_SELEKTOR_RE)) wissen.klassen.add(m[1]!);
  for (const m of css.matchAll(FARB_RE)) {
    const farbe = normalizeColor(m[0]);
    if (farbe !== null) wissen.farben.add(farbe);
  }
}

function ernteHtml(html: string, wissen: SiteWissen): void {
  for (const m of html.matchAll(CLASS_ATTR_RE)) {
    for (const name of (m[1] ?? m[2] ?? "").split(/\s+/)) {
      if (name !== "") wissen.klassen.add(name);
    }
  }
  // Inline-<style> der Fabrik: dort steht der :root-Block mit den Design-Tokens.
  for (const m of html.matchAll(STYLE_BLOCK_RE)) ernteCss(m[1] ?? "", wissen);
}

function* dateienIn(wurzel: string, tiefe: number): Generator<string> {
  if (tiefe < 0) return;
  let eintraege;
  try {
    eintraege = readdirSync(wurzel, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of eintraege) {
    // Punkt-Segmente überspringen: .git und .regoro gehören nicht zur Website,
    // und ihr Inhalt hat im Stil-Wissen nichts verloren.
    if (e.name.startsWith(".")) continue;
    const pfad = join(wurzel, e.name);
    if (e.isDirectory()) yield* dateienIn(pfad, tiefe - 1);
    else if (e.isFile()) yield pfad;
  }
}

/**
 * Sammelt die bekannten CSS-Klassen und Farbwerte der Website.
 *
 * Beides muss aus dem **konkreten Site-Ordner** kommen, nicht aus einer festen
 * Liste: Fabrik-Seiten führen neben den seitenübergreifenden `kanon-*`-Klassen
 * ein kundeneigenes Kürzel-Präfix, das nur dort existiert. Die Design-Tokens
 * stehen doppelt — inline im `<style>` jeder Seite und im content-gehashten
 * CSS-Bundle, dessen Dateiname sich bei jedem Bau ändert. Deshalb wird gescannt
 * statt geraten.
 *
 * Ergebnis wird gemerkt: Ein Lauf prüft bis zu 20 Dateien, und die Original-Site
 * ändert sich währenddessen nicht.
 */
function siteWissen(siteDir: string): SiteWissen {
  const gemerkt = wissenCache.get(siteDir);
  if (gemerkt) return gemerkt;
  const wissen: SiteWissen = { klassen: new Set(), farben: new Set() };
  for (const datei of dateienIn(siteDir, MAX_TIEFE)) {
    const ext = extname(datei).toLowerCase();
    if (ext !== ".css" && ext !== ".html") continue;
    let inhalt: string;
    try {
      inhalt = readFileSync(datei, "utf8");
    } catch {
      continue;
    }
    if (ext === ".css") ernteCss(inhalt, wissen);
    else ernteHtml(inhalt, wissen);
  }
  wissenCache.set(siteDir, wissen);
  return wissen;
}

// ===========================================================================
// Der Prüfschritt
// ===========================================================================

export function validateAgentOutput(
  relPfad: string,
  inhaltNeu: string,
  inhaltAlt: string | null,
  ktx: ValidateKontext,
): ValidateErgebnis {
  try {
    return pruefe(relPfad, inhaltNeu, inhaltAlt, ktx);
  } catch {
    // Der Validator läuft mitten in einem Lauf. Ein Wurf risse den ganzen Lauf
    // mit, statt dem Agenten eine Runde zum Nachbessern zu geben — und ein
    // unerwarteter Fehler ist ohnehin kein Grund, eine Datei zu übernehmen.
    return nein("Diese Datei ließ sich nicht prüfen und wird deshalb nicht übernommen.");
  }
}

function pruefe(
  relPfad: string,
  inhaltNeu: string,
  inhaltAlt: string | null,
  ktx: ValidateKontext,
): ValidateErgebnis {
  // --- 1. Pfadregeln ------------------------------------------------------
  if (typeof relPfad !== "string" || relPfad.trim() === "") {
    return nein(
      "Der Dateipfad ist leer. Erwartet wird ein Pfad innerhalb der Website, etwa \"leistungen.html\" oder \"assets/bild.webp\".",
    );
  }
  if (relPfad.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relPfad)) {
    return nein(
      "Absolute Pfade sind nicht zulässig — geschrieben wird nur innerhalb des Website-Ordners. " +
        'Gib den Pfad relativ an, etwa "leistungen.html" oder "assets/bild.webp".',
    );
  }
  if (relPfad.includes("\\")) {
    return nein(
      "Rückwärtsschrägstriche sind im Dateipfad nicht zulässig. Trenne Ordner mit einem gewöhnlichen Schrägstrich, etwa \"assets/bild.webp\".",
    );
  }
  const segmente = relPfad.split("/");
  for (const seg of segmente) {
    if (seg === "") {
      return nein(
        "Der Dateipfad enthält ein leeres Segment (zwei Schrägstriche hintereinander oder einer am Ende). Bitte ohne Leerstellen schreiben, etwa \"assets/bild.webp\".",
      );
    }
    // Deckt in einem Zug `.pi/`, `.regoro/`, `.git/`, `..` und `.` ab. Der
    // wichtigste Fall ist `.pi/`: pi lädt projekt-lokale Extensions von dort und
    // fragt im nicht-interaktiven Betrieb nicht nach — was der Agent dort
    // ablegt, führt er beim nächsten Lauf als eigenen Code aus.
    if (seg.startsWith(".")) {
      return nein(
        "Pfade mit einem führenden Punkt werden nicht übernommen (.git, .regoro, .pi und alle anderen). Diese Ordner gehören nicht zur Website.",
      );
    }
  }
  if (segmente.length > MAX_TIEFE) {
    return nein(
      `Höchstens ${MAX_TIEFE} Pfadebenen sind zulässig, dieser Pfad hat ${segmente.length}. ` +
        'Lege die Datei flacher ab, etwa "assets/bild.webp" statt tieferer Ordner.',
    );
  }

  const endung = extname(relPfad).toLowerCase();
  if (!ERLAUBTE_ENDUNGEN.has(endung)) {
    return nein(
      `Die Endung "${endung || "(keine)"}" wird nicht ausgeliefert und deshalb nicht übernommen. ` +
        `Zulässig sind: ${[...ERLAUBTE_ENDUNGEN].sort().join(" ")}.`,
    );
  }

  const istHtml = endung === ".html";
  if (istHtml) {
    // Seiten liegen flach und heißen kleingeschrieben — sonst taucht die neue
    // Seite weder in der Whitelist noch im Text-Editor je auf.
    const name = segmente[segmente.length - 1]!;
    if (segmente.length !== 1 || !PAGE_RE.test(name) || extname(relPfad) !== ".html") {
      return nein(
        `"${name}" ist kein zulässiger Seitenname. Seiten liegen direkt im Website-Ordner und dürfen nur Kleinbuchstaben, Ziffern und Bindestriche enthalten, etwa "bad-sanierung.html".`,
      );
    }
  }

  // --- 2. Größen und Anzahl ----------------------------------------------
  // Bytes, nicht Zeichen: "ä" sind zwei Bytes, `.length` ließe die doppelte
  // Menge durch.
  if (Buffer.byteLength(inhaltNeu, "utf8") > MAX_DATEI_BYTES) {
    return nein(
      `Diese Datei ist größer als ${Math.floor(MAX_DATEI_BYTES / 1024)} KB und wird nicht übernommen. ` +
        "Fasse den Inhalt kürzer oder verteile ihn auf mehrere Seiten.",
    );
  }
  if (ktx.anzahlBisher >= MAX_DATEIEN_JE_LAUF) {
    return nein(
      `Ein Auftrag darf höchstens ${MAX_DATEIEN_JE_LAUF} Dateien ändern; diese Grenze ist erreicht. ` +
        "Schreibe keine weiteren Dateien mehr und fasse zusammen, was du bereits geändert hast.",
    );
  }

  const erlaubteHerkuenfte = new Set<string>();
  for (const roh of ktx.browserHerkuenfte ?? []) {
    const h = normalisiereHerkunft(roh);
    if (h !== null) erlaubteHerkuenfte.add(h);
  }

  if (endung === ".css") return pruefeCss(inhaltNeu, inhaltAlt, erlaubteHerkuenfte, ktx);
  if (endung === ".js") {
    // Die HTML-Regeln gelten hier NICHT: `el.onclick = …` ist gewöhnliches
    // JavaScript, und „JavaScript in einer eigenen Datei" ist ausdrücklich
    // erlaubt — die CSP (`script-src 'self'`) rahmt es ein. Geprüft wird allein
    // die skriptgesteuerte Navigation, die keine CSP-Direktive abdeckt.
    const neuerVerstoss = ersterNeuerVerstoss(
      jsVerstoesse(inhaltNeu, erlaubteHerkuenfte),
      inhaltAlt === null ? [] : jsVerstoesse(inhaltAlt, erlaubteHerkuenfte),
    );
    return neuerVerstoss ? nein(neuerVerstoss.grund) : { ok: true, hinweise: [] };
  }
  if (!istHtml) {
    // .txt, Bilder, Schriften: kein Inhaltsurteil.
    return { ok: true, hinweise: [] };
  }
  return pruefeHtml(inhaltNeu, inhaltAlt, erlaubteHerkuenfte, ktx);
}

// ===========================================================================
// CSS
// ===========================================================================

const URL_FUNKTION_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
const IMPORT_STRING_RE = /@import\s+(['"])([^'"]*)\1/gi;

function cssVerstoesse(css: string, erlaubt: Set<string>): Verstoss[] {
  const raus: Verstoss[] = [];
  for (const m of css.matchAll(URL_FUNKTION_RE)) {
    // In CSS geladene Ressourcen sind Schriften, Bilder und weitere
    // Stylesheets — data: ist hier nicht vorgesehen.
    const wert = (m[2] ?? "").trim();
    const grund = pruefeRessource(wert, erlaubt, false);
    if (grund) raus.push({ schluessel: `css-url:${wert}`, grund });
  }
  for (const m of css.matchAll(IMPORT_STRING_RE)) {
    const wert = (m[2] ?? "").trim();
    const grund = pruefeRessource(wert, erlaubt, false);
    if (grund) raus.push({ schluessel: `css-import:${wert}`, grund });
  }
  return raus;
}

function farbHinweise(text: string, wissen: SiteWissen): string[] {
  const hinweise: string[] = [];
  const gesehen = new Set<string>();
  for (const m of text.matchAll(FARB_RE)) {
    const roh = m[0];
    const farbe = normalizeColor(roh);
    if (farbe === null || wissen.farben.has(farbe) || gesehen.has(farbe)) continue;
    gesehen.add(farbe);
    hinweise.push(
      `Die Farbe ${roh} steht so in keiner Vorlage dieser Website. Besser einen Design-Token benutzen, etwa color: var(--accent).`,
    );
  }
  return hinweise;
}

function pruefeCss(
  css: string,
  alt: string | null,
  erlaubt: Set<string>,
  ktx: ValidateKontext,
): ValidateErgebnis {
  const neuerVerstoss = ersterNeuerVerstoss(
    cssVerstoesse(css, erlaubt),
    alt === null ? [] : cssVerstoesse(alt, erlaubt),
  );
  if (neuerVerstoss) return nein(neuerVerstoss.grund);
  return { ok: true, hinweise: farbHinweise(css, siteWissen(ktx.siteDir)) };
}

// ===========================================================================
// HTML
// ===========================================================================

/** Attribute, deren Wert der Browser LÄDT. `href` ist Sonderfall (siehe unten). */
const RESSOURCE_ATTRIBUTE = ["src", "poster", "action", "formaction", "data", "background", "xlink:href"];

// --- linkedom-Hilfstypen, schmal gehalten (Vorbild: apply.ts) --------------
type DomAttribut = { name: string; value: string };
type DomElement = {
  tagName: string;
  getAttribute(name: string): string | null;
  attributes?: ArrayLike<DomAttribut>;
};
type DomDokument = { querySelectorAll(selektor: string): Iterable<DomElement> };

/**
 * Alle Herkunfts-Verstöße eines HTML-Dokuments, mit wiedererkennbarem Schlüssel.
 */
function htmlVerstoesse(html: string, dok: DomDokument, erlaubt: Set<string>): Verstoss[] {
  const raus: Verstoss[] = [];
  const merke = (art: string, wert: string, grund: string | null): void => {
    if (grund) raus.push({ schluessel: `${art}:${wert.trim()}`, grund });
  };

  for (const el of dok.querySelectorAll("*")) {
    const tag = String(el.tagName).toLowerCase();

    // <meta http-equiv="refresh" content="0;url=…"> leitet von selbst weiter,
    // ohne Klick — deshalb gilt hier der strenge Maßstab der geladenen
    // Ressourcen und nicht der eines Hyperlinks. Gegen Weiterleitungen hat die
    // CSP keine Direktive; wenn sie niemand hier abfängt, fängt sie niemand ab.
    if (tag === "meta" && String(el.getAttribute("http-equiv") ?? "").trim().toLowerCase() === "refresh") {
      const m = String(el.getAttribute("content") ?? "").match(/url\s*=\s*(.*)$/is);
      const ziel = (m?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
      if (ziel !== "") {
        merke("meta-refresh", ziel, pruefeRessource(ziel, erlaubt, false));
      }
    }

    for (const attr of Array.from(el.attributes ?? []) as { name: string; value: string }[]) {
      // linkedom erhält die Schreibweise: ONCLICK bleibt ONCLICK.
      const name = String(attr.name).toLowerCase();
      const wert = String(attr.value ?? "");

      if (name === "srcset") {
        // "bild.webp 1x, bild2.webp 2x" — je Eintrag zählt der erste Teil.
        for (const teil of wert.split(",")) {
          const adresse = teil.trim().split(/\s+/)[0] ?? "";
          merke("srcset", adresse, pruefeRessource(adresse, erlaubt, tag === "img" || tag === "source"));
        }
        continue;
      }
      if (name === "href") {
        // Der eine Sonderfall: <a>/<area> navigieren — ein Link lädt nichts.
        // Alles andere (<link>, <base>, <use>) lädt und wird streng geprüft.
        merke(
          `href-${tag}`,
          wert,
          tag === "a" || tag === "area" ? pruefeNavigation(wert) : pruefeRessource(wert, erlaubt, false),
        );
        continue;
      }
      if (RESSOURCE_ATTRIBUTE.includes(name)) {
        merke(
          name,
          wert,
          pruefeRessource(wert, erlaubt, name === "src" && (tag === "img" || tag === "source")),
        );
        continue;
      }
      if (name === "style") {
        raus.push(...cssVerstoesse(wert, erlaubt));
      }
    }
  }

  // <style>-Blöcke im Dokument nach denselben Regeln.
  for (const m of html.matchAll(STYLE_BLOCK_RE)) raus.push(...cssVerstoesse(m[1] ?? "", erlaubt));
  return raus;
}

type SkriptStand = { inline: string[]; roh: number; geparst: number };

function skriptStand(html: string, dokument: Document): SkriptStand {
  const skripte = [...dokument.querySelectorAll("script")];
  const inline: string[] = [];
  for (const s of skripte) {
    // Ein <script src="…"> lädt eine eigene Datei; sein Ursprung wird bei den
    // Ressourcen geprüft. Nur der Inline-Rumpf ist hier gemeint.
    if (s.getAttribute("src") === null) inline.push((s.textContent ?? "").trim());
  }
  return { inline, roh: zaehle(/<script\b/gi, html), geparst: skripte.length };
}

function pruefeHtml(
  neu: string,
  alt: string | null,
  erlaubt: Set<string>,
  ktx: ValidateKontext,
): ValidateErgebnis {
  // --- 3. Rohtext-Vorprüfung ---------------------------------------------
  // Gezählt und mit dem Vorzustand verglichen, nicht pauschal verboten: Eine
  // echte Fabrik-Seite enthält bis zu acht <script>-Blöcke (Layout-Sprung,
  // JSON-LD). Ein Pauschalverbot machte sie unbearbeitbar.
  const altText = alt ?? "";
  for (const { re, grund } of ROH_MUSTER) {
    if (zaehle(re, neu) > zaehle(re, altText)) return nein(grund);
  }

  // --- 4. Parsen ----------------------------------------------------------
  const { document: docNeu } = parseHTML(neu);
  const standNeu = skriptStand(neu, docNeu as unknown as Document);
  let standAlt: SkriptStand = { inline: [], roh: 0, geparst: 0 };
  if (alt !== null) {
    const { document: docAlt } = parseHTML(alt);
    standAlt = skriptStand(alt, docAlt as unknown as Document);
  }

  // Ein `<script`, das der Parser NICHT zu einem Element macht, ist der
  // gefährlichste Fall: linkedom sieht nichts, der Browser führt es aus.
  // Gemessen: `<script src="…"` ohne `>` ergibt sehr wohl einen Knoten, ein
  // nacktes `<script` dagegen nicht. Verglichen wird die Differenz, damit eine
  // Eigenheit der Bestandsseite nicht jede Bearbeitung sperrt.
  if (standNeu.roh - standNeu.geparst > standAlt.roh - standAlt.geparst) {
    return nein(
      "Diese Datei enthält ein unvollständiges <script>-Tag. Bitte vollständig schließen oder das JavaScript in eine eigene .js-Datei legen.",
    );
  }

  // --- 5. Herkunft aller geladenen Ressourcen -----------------------------
  // Gegen den Vorzustand verglichen (§13.26), nicht absolut verboten: Eine
  // gebaute Kundenseite verweist auf Google-Rezensionen, Instagram und
  // gesetze-im-internet.de. Ein absolutes Verbot lehnte impressum.html bei
  // jedem Lauf ab, auch wenn der Agent sie nie angefasst hat.
  const neuerVerstoss = ersterNeuerVerstoss(
    htmlVerstoesse(neu, docNeu, erlaubt),
    alt === null ? [] : htmlVerstoesse(alt, parseHTML(alt).document, erlaubt),
  );
  if (neuerVerstoss) return nein(neuerVerstoss.grund);

  // --- 6. Inline-Skripte: ein Vergleich, kein Urteil ----------------------
  // Die Fabrik-Blöcke dürfen bleiben und dürfen verschwinden; neu hinzukommen
  // darf keiner. Über eine Multimenge, damit zwei gleiche Blöcke nicht als
  // einer durchgehen.
  const uebrig = [...standAlt.inline];
  for (const block of standNeu.inline) {
    const i = uebrig.indexOf(block);
    if (i === -1) {
      return nein(
        "Neue oder geänderte <script>-Blöcke im HTML werden nicht übernommen. JavaScript gehört in eine eigene .js-Datei, die per <script src=\"…\"> eingebunden wird.",
      );
    }
    uebrig.splice(i, 1);
  }

  // --- 7. Weiche Hinweise -------------------------------------------------
  const wissen = siteWissen(ktx.siteDir);
  const hinweise: string[] = [];
  const gemeldet = new Set<string>();
  for (const el of docNeu.querySelectorAll("[class]")) {
    for (const name of String(el.getAttribute("class") ?? "").split(/\s+/)) {
      if (name === "" || wissen.klassen.has(name) || gemeldet.has(name)) continue;
      gemeldet.add(name);
      hinweise.push(
        `Die CSS-Klasse "${name}" gibt es in dieser Website nicht — sie bleibt ohne Wirkung. Vorhanden sind unter anderem: ${[...wissen.klassen].slice(0, 12).join(", ")}.`,
      );
    }
  }
  // Farben aus style="…" und aus <style>-Blöcken.
  let stilText = "";
  for (const el of docNeu.querySelectorAll("[style]")) stilText += `${el.getAttribute("style") ?? ""};`;
  for (const m of neu.matchAll(STYLE_BLOCK_RE)) stilText += m[1] ?? "";
  hinweise.push(...farbHinweise(stilText, wissen));

  return { ok: true, hinweise };
}
