/**
 * Die Content-Security-Policy — die dritte der drei Grenzen (Plan).
 *
 * SIE STEHT IM CADDY-BLOCK, NICHT IM HTML. Das ist der ganze Witz: Der Agent
 * schreibt HTML, also darf die Grenze nicht im HTML liegen, sonst schreibt er
 * sie um. Sie liegt eine Ebene darüber, wo er nicht hinkommt.
 *
 * ZWEI FEHLER, BEIDE TEUER, BEIDE HIER FESTGENAGELT:
 *
 * 1. **Die CSP auf dem Editor-Zweig.** `connect-src 'none'` verbietet jedes
 *    `fetch` — und das Overlay speichert per `fetch`. Der Editor wäre stumm
 *    kaputt: Knöpfe reagieren, nichts wird gespeichert, keine Fehlermeldung.
 * 2. **Die CSP nur im Generator, nicht in den Vorlagen.** Wer den Block aus
 *    `Caddyfile.example` kopiert (das ist der dokumentierte Weg), bekäme eine
 *    Website ohne die Grenze und merkte nie etwas davon.
 *
 * Die dritte Hälfte läuft gegen ECHTES caddy: Ein Block, der die richtigen
 * Zeichen enthält, ist noch kein Header auf der Leitung. Genau dort ist der
 * Vorgänger-Fehler passiert — ein blankes `file_server` unterlief die
 * Extension-Allowlist komplett, und alle Textprüfungen waren grün.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caddyBlock, type ServiceOpts } from "./service.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/** Der Wortlaut aus Contract §8. Ändert er sich, ändert er sich an EINER Stelle. */
const CSP_OHNE_INTEGRATIONEN =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'self'; " +
  "frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

const base: ServiceOpts = {
  siteDir: "/srv/sites/mueller",
  execPath: "/home/aufi/.local/bin/regoro",
  slug: "mueller",
  port: 8829,
  user: "www-data",
  domain: "mueller-sanitaer.de",
  browserHerkuenfte: [],
};
const baseMulti: ServiceOpts = { ...base, siteDir: "/srv/sites", slug: "sites", port: 8788, multi: true, domain: undefined };

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/**
 * Schneidet einen `handle @name { … }`-Block heraus. Über Klammerzählung, nicht
 * über eine Regex: Der Block enthält selbst Klammern (`reverse_proxy { … }`),
 * und eine nicht-gierige Regex schnitte an der ersten inneren zu.
 */
function handleBlock(text: string, matcher: string): string {
  const start = text.indexOf(`handle ${matcher} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  let tiefe = 0;
  for (let i = text.indexOf("{", start); i < text.length; i++) {
    if (text[i] === "{") tiefe++;
    else if (text[i] === "}" && --tiefe === 0) return text.slice(start, i + 1);
  }
  throw new Error(`Block "handle ${matcher}" ist nicht geschlossen`);
}

/** Die CSP-Zeile eines Blocks oder einer Vorlage. */
const CSP_RE = /^\s*header Content-Security-Policy .*$/m;
const cspZeile = (text: string): string => (text.match(CSP_RE)?.[0] ?? "").trim();

// ===========================================================================
// Wo die CSP steht — und wo nicht
// ===========================================================================
describe("die CSP sitzt ausschließlich im statischen Zweig", () => {
  for (const [name, opts] of [["Einzelbetrieb", base], ["Sammelbetrieb", baseMulti]] as const) {
    describe(name, () => {
      const block = caddyBlock(opts);

      test("der file_server-Zweig trägt sie", () => {
        const statisch = handleBlock(block, "@allowed");
        expect(statisch).toContain("file_server");
        expect(statisch).toContain(CSP_OHNE_INTEGRATIONEN);
      });

      test("der Editor-Zweig trägt sie NICHT", () => {
        // `connect-src 'none'` würde jedes fetch des Overlays blockieren. Der
        // Editor wäre stumm kaputt — Knöpfe reagieren, nichts wird gespeichert.
        const editor = handleBlock(block, "@editor");
        expect(editor).toContain("reverse_proxy");
        expect(editor).not.toContain("Content-Security-Policy");
        expect(editor).not.toContain("connect-src");
      });

      test("sie steht genau EINMAL im Block", () => {
        expect(block.match(/Content-Security-Policy/g)).toHaveLength(1);
      });

      test("der file_server-Zweig setzt nosniff", () => {
        // Caddy liefert die statische Site DIREKT aus; der Bun-Host ist dort
        // nicht im Pfad, seine SECURITY_HEADERS greifen also nicht. Ohne diese
        // Zeile fehlt nosniff genau auf den Dateien, die der Agent schreibt.
        //
        // Wogegen es steht: ein Polyglot — eine Datei mit gültiger Bild-Signatur
        // und eingebettetem HTML. Der Validator lässt sie als Bild durch, der
        // Browser interpretiert sie ohne nosniff als HTML, und das eingebettete
        // Skript läuft im Ursprung der Kundenwebsite.
        expect(handleBlock(block, "@allowed")).toContain('header X-Content-Type-Options "nosniff"');
      });

      test("der Editor-Zweig braucht ihn nicht — der Bun-Host setzt ihn selbst", () => {
        // Gegenprobe zur Vollständigkeit: Hier ist die Abwesenheit richtig, und
        // zwar aus einem Grund, nicht aus Vergesslichkeit. Wer sie „der
        // Einheitlichkeit halber" nachträgt, verdoppelt eine Zusicherung an
        // einen Ort, der sie nicht kontrolliert.
        expect(handleBlock(block, "@editor")).toContain("reverse_proxy");
      });

      test("der Editor-Zweig schaltet die Pufferung ab", () => {
        // ACHTUNG, die naheliegende Begründung ist FALSCH und wurde gemessen
        // (caddy 2.11.4): `flush_interval -1` ändert an der Zeit bis zum ersten
        // Byte NICHTS — 4,00 s mit wie ohne. Der KÖRPER wird gar nicht gepuffert,
        // die Ereignisse kamen einzeln und pünktlich. Gepuffert werden die
        // ANTWORT-HEADER, und dagegen hilft nur, dass der Server sofort ein Byte
        // sendet (§13.21, geprüft in agent-routes.test.ts).
        //
        // Die Zeile bleibt trotzdem: Sie ist harmlos, dokumentiert die Absicht
        // gegenüber künftigen Caddy-Fassungen, und ohne sie hinge das Verhalten
        // an einer Vorgabe, die sich ändern darf. Wer sie streicht, soll das
        // bewusst tun.
        expect(handleBlock(block, "@editor")).toContain("flush_interval -1");
      });
    });
  }
});

describe("Integrationen erweitern die CSP — und nur sie", () => {
  test("ohne Integrationen bleibt es bei connect-src 'none'", () => {
    expect(caddyBlock(base)).toContain("connect-src 'none'");
  });

  test("eine freigeschaltete Herkunft erscheint in script-src UND connect-src", () => {
    const mit = caddyBlock({ ...base, browserHerkuenfte: ["https://js.stripe.com"] });
    const zeile = cspZeile(mit);
    expect(zeile).toContain("script-src 'self' 'unsafe-inline' https://js.stripe.com");
    expect(zeile).toContain("connect-src https://js.stripe.com");
    // 'none' und eine Quelle nebeneinander ist laut CSP-Spezifikation ungültig;
    // Browser verwerfen die ganze Direktive und lassen dann ALLES durch.
    expect(zeile).not.toContain("connect-src 'none'");
  });

  test("mehrere Herkünfte stehen nebeneinander, nicht verschmolzen", () => {
    const zeile = cspZeile(caddyBlock({ ...base, browserHerkuenfte: ["https://js.stripe.com", "https://api.example.de"] }));
    expect(zeile).toContain("https://js.stripe.com");
    expect(zeile).toContain("https://api.example.de");
  });

  test("die übrigen Direktiven bleiben unverändert eng", () => {
    // Eine Integration ist eine Erlaubnis für zwei Direktiven, nicht für alle.
    const zeile = cspZeile(caddyBlock({ ...base, browserHerkuenfte: ["https://js.stripe.com"] }));
    expect(zeile).toContain("frame-ancestors 'none'");
    expect(zeile).toContain("object-src 'none'");
    expect(zeile).toContain("base-uri 'none'");
    expect(zeile).toContain("form-action 'self'");
    expect(zeile).toContain("img-src 'self' data:");
  });

  test("im Sammelbetrieb bekommt jeder Host seine eigene CSP, keine Vereinigung", () => {
    // Contract §13.9/§13.24. Eine Vereinigungsmenge machte eine für Kunde A
    // freigeschaltete Herkunft auch auf Kundenseite B ladbar — genau die
    // Quervermischung, gegen die Invariante 10 steht. Und sie wäre unsichtbar:
    // Kunde B hat nie eine Integration eingerichtet und sähe im Editor nichts
    // davon.
    const block = caddyBlock({
      ...baseMulti,
      herkuenfteJeHost: {
        "kunde-a.de": ["https://js.stripe.com"],
        "kunde-b.de": ["https://api.brevo.com"],
      },
    });

    // Der Host-Regexp ist VOLLSTÄNDIG VERANKERT. Ohne `^…$` träfe `kunde-a.de`
    // auch `boese-kunde-a.de.angreifer.tld` — und dessen Seiten bekämen die
    // aufgeweichte CSP eines fremden Kunden.
    expect(block).toContain("header_regexp Host ^kunde-a\\.de$");
    expect(block).toContain("header_regexp Host ^kunde-b\\.de$");

    // Die Herkunft des einen darf nicht in der Regel des anderen stehen.
    const teilA = block.slice(block.indexOf("^kunde-a"), block.indexOf("^kunde-b"));
    expect(teilA).toContain("https://js.stripe.com");
    expect(teilA).not.toContain("https://api.brevo.com");

    // Und wer keine Integration hat, behält die enge Vorgabe.
    expect(block).toContain("connect-src 'none'");
  });

  test("ohne herkuenfteJeHost ist der Sammelbetrieb zeichengleich mit heute", () => {
    // Die Komplexität entsteht erst, wenn jemand die Funktion benutzt. Solange
    // niemand Integrationen hat, darf sich am erzeugten Text nichts ändern —
    // sonst müsste jeder Betreiber seinen Caddy-Block grundlos neu erzeugen.
    expect(caddyBlock({ ...baseMulti, herkuenfteJeHost: {} })).toBe(caddyBlock(baseMulti));
    expect(caddyBlock(baseMulti).match(/Content-Security-Policy/g)).toHaveLength(1);
  });

  test("script-src behält 'unsafe-inline' — die Fabrik liefert Inline-Skripte aus", () => {
    // Gemessen an einer echten Kundenseite: acht <script>-Tags, sieben davon
    // inline (SiteHeader gegen Layout-Sprung, JSON-LD). Ohne 'unsafe-inline'
    // wären bestehende Kundenseiten kaputt — die Kopfzeile springt auf
    // Mobilgeräten. Das ist ein bewusster Kompromiss, kein Versehen.
    expect(cspZeile(caddyBlock(base))).toContain("script-src 'self' 'unsafe-inline'");
  });
});

// ===========================================================================
// Generator und Vorlagen dürfen nicht auseinanderlaufen
// ===========================================================================
describe("die Caddyfile-Vorlagen spiegeln die CSP des Generators", () => {
  test("Einzel- und Sammelbetrieb führen dieselbe CSP", () => {
    // Der Nicht-leer-Anspruch steht zuerst: sonst wäre dieser Test auch grün,
    // wenn es überhaupt keine CSP gäbe — zwei leere Zeichenketten sind gleich.
    expect(cspZeile(caddyBlock(base))).not.toBe("");
    expect(cspZeile(caddyBlock(baseMulti))).toBe(cspZeile(caddyBlock(base)));
  });

  test("beide Vorlagen stimmen mit dem Generator überein", () => {
    // Der dokumentierte Weg ist „Block aus der Vorlage kopieren". Eine Vorlage
    // ohne CSP heißt: eine Kundenwebsite ohne die dritte Grenze, und niemand
    // sieht es.
    const erwartet = cspZeile(caddyBlock(base));
    expect(erwartet).not.toBe("");
    for (const datei of ["Caddyfile.example", "Caddyfile.multi.example"]) {
      const text = readFileSync(join(REPO_ROOT, datei), "utf8");
      expect(`${datei}: ${cspZeile(text)}`).toBe(`${datei}: ${erwartet}`);
    }
  });

  test("beide Vorlagen setzen nosniff im statischen Zweig", () => {
    // Dieselbe Begründung wie bei der CSP: Der dokumentierte Weg ist „Block aus
    // der Vorlage kopieren". Eine Vorlage ohne die Zeile heißt eine
    // Kundenwebsite ohne den Riegel, und niemand sieht es.
    for (const datei of ["Caddyfile.example", "Caddyfile.multi.example"]) {
      const statisch = handleBlock(readFileSync(join(REPO_ROOT, datei), "utf8"), "@allowed");
      expect(`${datei}: ${statisch.includes('header X-Content-Type-Options "nosniff"')}`).toBe(`${datei}: true`);
    }
  });

  test("beide Vorlagen schalten die Pufferung im Editor-Zweig ab", () => {
    for (const datei of ["Caddyfile.example", "Caddyfile.multi.example"]) {
      const text = readFileSync(join(REPO_ROOT, datei), "utf8");
      expect(`${datei}: ${handleBlock(text, "@editor").includes("flush_interval -1")}`).toBe(`${datei}: true`);
    }
  });

  test("in keiner Vorlage steht die CSP im Editor-Zweig", () => {
    for (const datei of ["Caddyfile.example", "Caddyfile.multi.example"]) {
      const editor = handleBlock(readFileSync(join(REPO_ROOT, datei), "utf8"), "@editor");
      expect(`${datei}: ${editor}`).not.toContain("Content-Security-Policy");
    }
  });
});

// ===========================================================================
// Und jetzt mit echtem caddy: der Header auf der Leitung
// ===========================================================================
/** Bun.spawnSync WIRFT, wenn die Binary fehlt (kein Exit-Code). Deshalb try/catch. */
function haveCaddy(): boolean {
  try {
    return Bun.spawnSync(["caddy", "version"]).exitCode === 0;
  } catch {
    return false;
  }
}

/** Öffnet kurz einen Port, um ihn wieder freizugeben — caddy braucht eine Nummer. */
function freierPort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const p = s.port ?? 0;
  s.stop(true);
  expect(p).toBeGreaterThan(0);
  return p;
}

describe.skipIf(!haveCaddy())("der erzeugte Block auf der Leitung", () => {
  /**
   * Fährt caddy mit dem erzeugten Block hoch, gegen einen Bun-Stub als
   * „Editor". Domain → :Port und `auto_https off`, damit kein ACME anläuft.
   */
  async function mitCaddy<T>(
    opts: Partial<ServiceOpts>,
    fn: (basis: string) => Promise<T>,
  ): Promise<T> {
    const siteDir = tmp("regoro-csp-site-");
    mkdirSync(join(siteDir, "assets"), { recursive: true });
    writeFileSync(join(siteDir, "index.html"), "<!doctype html><html><body><h1>Start</h1></body></html>");
    writeFileSync(join(siteDir, "styles.css"), "body{margin:0}");
    // Was ein echter Site-Ordner sonst noch trägt und was niemand sehen darf.
    writeFileSync(join(siteDir, "design.json"), '{"pfad":"/srv/regoro/intern"}');
    writeFileSync(join(siteDir, "assets", ".private.html"), "<p>geheim</p>");

    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => new Response(`editor:${new URL(req.url).pathname}`),
    });
    const httpPort = freierPort();
    const block = caddyBlock({ ...base, ...opts, siteDir, domain: `:${httpPort}`, port: stub.port ?? 0 });

    const dir = tmp("regoro-csp-caddy-");
    const conf = join(dir, "Caddyfile");
    writeFileSync(conf, `{\n    auto_https off\n    admin off\n}\n${block}`);

    const caddy = Bun.spawn(["caddy", "run", "--config", conf, "--adapter", "caddyfile"], {
      // Eigenes HOME: caddy legt sonst Zustand im echten Benutzerverzeichnis an.
      env: { ...process.env, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const basis = `http://127.0.0.1:${httpPort}`;
    try {
      for (let i = 0; i < 100; i++) {
        try {
          await fetch(`${basis}/`);
          break;
        } catch {
          await Bun.sleep(100);
        }
      }
      return await fn(basis);
    } finally {
      caddy.kill();
      await caddy.exited;
      stub.stop(true);
    }
  }

  test("statische Seiten tragen die CSP, der Editor nicht", async () => {
    await mitCaddy({}, async (basis) => {
      for (const pfad of ["/", "/index.html", "/styles.css"]) {
        const r = await fetch(basis + pfad);
        expect(`${pfad} → ${r.status}`).toBe(`${pfad} → 200`);
        expect(`${pfad}: ${r.headers.get("content-security-policy")}`).toBe(`${pfad}: ${CSP_OHNE_INTEGRATIONEN}`);
        // Auf der Leitung, nicht nur im Text: Ein `header`, das im Block steht
        // und nicht ankommt, wäre derselbe Ausfall wie eine fehlende Zeile.
        expect(`${pfad}: ${r.headers.get("x-content-type-options")}`).toBe(`${pfad}: nosniff`);
        await r.text();
      }

      for (const pfad of ["/edit", "/edit/login", "/edit-assets/overlay.js", "/impressum.html/edit"]) {
        const r = await fetch(basis + pfad);
        expect(`${pfad} → ${r.status}`).toBe(`${pfad} → 200`); // der Stub antwortet
        expect(`${pfad}: ${r.headers.get("content-security-policy")}`).toBe(`${pfad}: null`);
        await r.text();
      }
    });
  }, 60_000);

  test("die Extension-Allowlist und der Dotfile-Riegel gelten auch im Proxy", async () => {
    // Invariante 3: Caddy liefert die statische Site direkt aus, der Bun-Host ist
    // dafür nicht im Pfad. Ein blankes file_server unterliefe ASSET_TYPES
    // komplett — das war schon einmal so.
    await mitCaddy({}, async (basis) => {
      for (const pfad of ["/design.json", "/assets/.private.html"]) {
        const r = await fetch(basis + pfad);
        expect(`${pfad} → ${r.status}`).toBe(`${pfad} → 404`);
        await r.text();
      }
    });
  }, 60_000);

  test("mit einer freigeschalteten Herkunft steht sie im ausgelieferten Header", async () => {
    await mitCaddy({ browserHerkuenfte: ["https://js.stripe.com"] }, async (basis) => {
      const r = await fetch(`${basis}/`);
      const csp = r.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("https://js.stripe.com");
      expect(csp).not.toContain("connect-src 'none'");
      await r.text();
    });
  }, 60_000);
});
