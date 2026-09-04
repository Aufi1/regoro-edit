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
import { isEditorPath } from "./host.ts";
import { resolveStagingPath } from "./sites.ts";

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

      test("die Kopfzeilen des Editors gehören NICHT pauschal in den statischen Zweig", () => {
        // WARUM DAS EIN EIGENER TEST IST: Der Bun-Host setzt drei Kopfzeilen
        // (`SECURITY_HEADERS` in host.ts). Genau eine davon gehört auch auf die
        // öffentliche Website. Der Satz „die anderen nach derselben Logik mit"
        // ist naheliegend, wurde in diesem Projekt schon einmal gesagt — und
        // wäre teuer gewesen:
        //
        //   X-Robots-Tag: noindex, nofollow  →  nimmt JEDE Kundenwebsite aus
        //       dem Suchindex. Der Schaden fällt erst nach Wochen auf, wenn die
        //       Anfragen ausbleiben, und ist bis dahin nicht mehr zuzuordnen.
        //       Für /edit* ist die Zeile richtig: Editor-Seiten gehören nicht
        //       in den Index.
        //   Cache-Control: no-store          →  nimmt Besuchern jeden Cache.
        //       Für /edit* richtig (Sitzungsinhalte), für Bilder und CSS einer
        //       Kundenwebsite falsch.
        //   X-Content-Type-Options: nosniff  →  gehört auf BEIDE Seiten.
        //
        // Die Menge ist also nicht einheitlich, und deshalb trägt „nach
        // derselben Logik" nicht. Wer eine der beiden ersten hier ergänzt, soll
        // an diesem Test scheitern und den Grund gleich mitlesen.
        const statisch = handleBlock(block, "@allowed");
        expect(statisch).not.toContain("X-Robots-Tag");
        expect(statisch).not.toContain("no-store");
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

  test("in keiner Vorlage steht noindex im statischen Zweig", () => {
    for (const datei of ["Caddyfile.example", "Caddyfile.multi.example"]) {
      const statisch = handleBlock(readFileSync(join(REPO_ROOT, datei), "utf8"), "@allowed");
      // Nur die ausgelieferte Kopfzeile, nicht der Warnkommentar daneben.
      const kopfzeilen = statisch.split("\n").filter((z) => /^\s*header /.test(z)).join("\n");
      expect(`${datei}: ${kopfzeilen}`).not.toContain("X-Robots-Tag");
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
    fn: (basis: string, siteDir: string) => Promise<T>,
  ): Promise<T> {
    const siteDir = tmp("regoro-csp-site-");
    // Im Staging ist `siteDir` das Sammelverzeichnis der Previews. Der Ordner
    // muss wirklich existieren, sonst löst `resolveStagingPath` nichts auf und
    // die Paritätsprüfung unten verglichen zwei Ablehnungen.
    mkdirSync(join(siteDir, "kunde-a"), { recursive: true });
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
      return await fn(basis, siteDir);
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
        // Und das, was NICHT ankommen darf — auf der Leitung geprüft, weil ein
        // Kommentar im Block niemanden davon abhält, die Zeile zu ergänzen.
        expect(`${pfad}: ${r.headers.get("x-robots-tag")}`).toBe(`${pfad}: null`);
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

  test("Staging: die Editor-Adressen gehen an den Bun-Prozess und tragen KEINE CSP", async () => {
    /**
     * DER NACHWEIS AUF DER LEITUNG, und er ist hier nicht schmückend.
     *
     * Im Staging-Block wird ALLES an den Bun-Prozess weitergereicht — auch die
     * Vorschau selbst, denn nur er kennt den Entwurf. Die Trennung liegt
     * deshalb nicht am Upstream, sondern an der KOPFZEILE: Editor-Adressen ohne
     * CSP (`connect-src 'none'` legte jedes fetch des Overlays lahm), alles
     * andere mit.
     *
     * Gemessen am Produktions-Matcher wäre das hier reihenweise schiefgegangen:
     * `path`-Globs überqueren Schrägstriche nur bei EINEM Stern, das Präfix
     * erzwingt einen zweiten — `/p/k/edit/agent/status` und
     * `/p/k/edit-assets/overlay.js` fielen lautlos in den anderen Zweig. Eine
     * Zeichenketten-Prüfung sieht das nicht; ob ein Muster greift, weiß nur caddy.
     */
    await mitCaddy({ staging: true }, async (basis) => {
      for (const pfad of [
        "/p/kunde-a/edit",
        "/p/kunde-a/edit/zustand",
        "/p/kunde-a/edit/agent/status",
        "/p/kunde-a/edit/agent/events",
        "/p/kunde-a/edit-assets/overlay.js",
        "/p/kunde-a/impressum.html/edit",
      ]) {
        const r = await fetch(basis + pfad);
        const koerper = await r.text();
        // Der Stub antwortet `editor:<pfad>` — daran hängt, dass die Anfrage
        // WIRKLICH am Bun-Prozess ankam und nicht bloß irgendein 200 war.
        expect(`${pfad} → ${koerper}`).toBe(`${pfad} → editor:${pfad}`);
        expect(`${pfad}: ${r.headers.get("content-security-policy")}`).toBe(`${pfad}: null`);
      }
    });
  }, 60_000);

  test("Staging: die Vorschau selbst kommt ebenfalls vom Bun-Prozess — aber MIT CSP", async () => {
    // Die Gegenprobe zur Zeile darüber. Ohne sie wäre „keine CSP" auch dann
    // erfüllt, wenn der Block überhaupt keine setzte — und dann liefe der
    // Entwurf eines Interessenten ohne die dritte Grenze.
    await mitCaddy({ staging: true }, async (basis) => {
      for (const pfad of ["/p/kunde-a/", "/p/kunde-a/index.html", "/p/kunde-a/edit-preise.html"]) {
        const r = await fetch(basis + pfad);
        const koerper = await r.text();
        expect(`${pfad} → ${koerper}`).toBe(`${pfad} → editor:${pfad}`);
        expect(`${pfad}: ${r.headers.get("content-security-policy")}`).toBe(
          `${pfad}: ${CSP_OHNE_INTEGRATIONEN}`,
        );
        expect(`${pfad}: ${r.headers.get("x-content-type-options")}`).toBe(`${pfad}: nosniff`);
      }
    });
  }, 60_000);

  test("Staging: der Dotfile-Riegel gewinnt gegen den Editor-Matcher", async () => {
    // Unter `.regoro/` liegen das Entwurfs-Repo, die schwebende Änderung und
    // die Auth-Datei. Der Riegel steht deshalb VOR @editor — und weil beide
    // Zweige denselben Upstream haben, sieht man den Unterschied nur daran,
    // dass hier NICHTS durchgereicht wird.
    await mitCaddy({ staging: true }, async (basis) => {
      for (const pfad of [
        "/p/kunde-a/.regoro/auth.json",
        "/p/kunde-a/.regoro/entwurf/HEAD",
        "/p/kunde-a/assets/.geheim.html",
        "/p/kunde-a/.regoro/entwurf/edit",
      ]) {
        const r = await fetch(basis + pfad);
        const koerper = await r.text();
        expect(`${pfad} → ${r.status}`).toBe(`${pfad} → 404`);
        expect(`${pfad}: ${koerper.startsWith("editor:") ? "durchgereicht" : "geblockt"}`).toBe(
          `${pfad}: geblockt`,
        );
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

  // ===========================================================================
  // Proxy und Editor müssen dieselbe Grenze ziehen — Caddy nie laxer
  // ===========================================================================
  describe("der Matcher und isEditorPath() ziehen dieselbe Grenze", () => {
    /**
     * WARUM DAS EINE EIGENE ZUSICHERUNG IST UND KEINE AUFZÄHLUNG.
     *
     * `CADDY_HOST_RE` ↔ `HOST_RE` und die `@allowed`-Zeile ↔ `ASSET_TYPES` sind
     * in diesem Repo schon aneinandergenagelt, weil sie sonst auseinanderlaufen.
     * Für den Editor-Matcher fehlte das — und die Lücke war real: Der Generator
     * führte `/edit-vorschau/*`, während `isEditorPath()` die Form noch nicht
     * kannte. Der Proxy war damit LAXER als der Editor.
     *
     * Diese Richtung ist die gefährliche. Caddy darf strenger sein (dann kommt
     * eine Editor-Anfrage gar nicht erst an, man merkt es sofort). Ist Caddy
     * laxer, geht eine Anfrage an den Bun-Host, die der Editor für eine
     * öffentliche Seite hält — im Produktionsblock also am `file_server`, an der
     * Extension-Allowlist UND an der CSP vorbei. Das ist ein Publikationsweg, den
     * kein Editor-Werkzeug zeigt.
     *
     * Geprüft wird deshalb die Implikation, nicht die Gleichheit — mit einer
     * Gegenprobe, dass sie nicht leer ist.
     */
    const PFADE = [
      // Editor-Formen (isEditorPath === true)
      "/edit",
      "/edit/login",
      "/edit/save",
      "/edit/agent/events",
      "/edit/version/abc1234",
      "/edit-assets/overlay.js",
      "/edit-vorschau/assets/hero.png",
      "/impressum.html/edit",
      // Öffentliche Formen, die ihnen ähnlich sehen (isEditorPath === false)
      "/edit-preise.html",
      "/edit-vorschau-preise.html",
      "/editieren.html",
      "/blog/edit/beitrag.html",
      "/index.html",
      "/assets/hero.png",
      "/styles.css",
      "/",
    ];

    /** Trifft eine Anfrage den Editor-Zweig? Am Stub gemessen, nicht am Text. */
    async function amEditor(basis: string, pfad: string): Promise<boolean> {
      const r = await fetch(basis + pfad);
      const koerper = await r.text();
      return koerper.startsWith("editor:");
    }

    test("Produktion: Caddy ist nirgends laxer als isEditorPath()", async () => {
      await mitCaddy({}, async (basis) => {
        let beideJa = 0;
        for (const pfad of PFADE) {
          const proxy = await amEditor(basis, pfad);
          const editor = isEditorPath(pfad);
          if (proxy && editor) beideJa++;
          // Verboten ist genau eine Kombination: Proxy leitet weiter, Editor
          // hält den Pfad für öffentlich.
          expect(`${pfad}: proxy=${proxy} editor=${editor}`).not.toBe(
            `${pfad}: proxy=true editor=false`,
          );
        }
        // GEGENPROBE ZUM MESSAPPARAT: Ohne sie wäre die Implikation auch dann
        // erfüllt, wenn Caddy überhaupt nichts an den Editor weiterreichte.
        expect(beideJa).toBeGreaterThan(4);
      });
    }, 60_000);

    test("Staging: dieselbe Implikation, gemessen am abgestreiften Pfad", async () => {
      // Im Staging vergleicht sich der Proxy mit dem, was die Anwendung NACH dem
      // Abstreifen des Präfixes sieht — das ist der Pfad, über den `isEditorPath`
      // dort urteilt.
      await mitCaddy({ staging: true }, async (basis, sitesRoot) => {
        let beideJa = 0;
        for (const pfad of PFADE.map((p) => `/p/kunde-a${p === "/" ? "/" : p}`)) {
          const proxy = await amEditor(basis, pfad);
          const treffer = resolveStagingPath(sitesRoot, new URL(`http://x${pfad}`).pathname);
          const editor = treffer !== null && isEditorPath(treffer.rest);
          if (proxy && editor) beideJa++;
          // Im Staging geht ALLES an den Bun-Prozess — der Unterschied liegt in
          // der CSP. „Am Editor" heißt hier deshalb: im @editor-Zweig, also ohne
          // CSP. Das prüft `cspFrei` unten.
          const r = await fetch(basis + pfad);
          const cspFrei = r.headers.get("content-security-policy") === null;
          await r.text();
          expect(`${pfad}: proxy=${cspFrei} editor=${editor}`).not.toBe(
            `${pfad}: proxy=true editor=false`,
          );
          expect(proxy).toBe(true); // im Staging kommt jede Anfrage am Prozess an
        }
        expect(beideJa).toBeGreaterThan(4);
      });
    }, 60_000);

    test("die öffentlichen Doppelgänger bleiben statisch UND tragen die CSP", async () => {
      /**
       * Die wichtigere Hälfte, weil sie eine zu gierige Regel fängt: Ein Muster
       * mit einem Stern VORN und HINTEN um „/edit/" herum wäre die naheliegende
       * Reparatur für das Staging-Präfix — caddy schaltet dann auf „Enthält" und
       * verschlingt `/blog/edit/beitrag.html`, eine ganz normale Kundenseite, die
       * damit ohne CSP an den Bun-Host ginge.
       */
      await mitCaddy({}, async (basis) => {
        for (const pfad of ["/blog/edit/beitrag.html", "/edit-vorschau-preise.html", "/edit-preise.html"]) {
          const r = await fetch(basis + pfad);
          const koerper = await r.text();
          expect(`${pfad}: ${koerper.startsWith("editor:") ? "am Editor" : "statisch"}`).toBe(
            `${pfad}: statisch`,
          );
          // 404, weil die Datei in der Fixture nicht existiert — aber MIT der CSP
          // des statischen Zweigs, und das ist hier der Punkt.
          expect(`${pfad}: ${r.headers.get("content-security-policy")}`).toBe(
            `${pfad}: ${CSP_OHNE_INTEGRATIONEN}`,
          );
        }
      });
    }, 60_000);

    test("Staging in der TIEFE — ein einstufiger Test hätte die Lücke durchgelassen", async () => {
      /**
       * Gemessen: Caddys `path`-Glob überquert Schrägstriche nur bei EINEM Stern
       * am Rand; ab dem zweiten gilt Segment-Semantik. Die naheliegende Form
       * „/p/, Stern, /edit/, Stern" trifft deshalb `/p/k/edit/login`, verfehlt aber
       * `/p/k/edit/agent/events` und `/p/k/edit/version/<id>` — genau die Routen
       * der Seitenleiste, und zwar lautlos.
       *
       * Ein Test mit nur einer Ebene wäre grün gewesen. Deshalb hier ausdrücklich
       * zwei und drei Ebenen unter dem Präfix.
       */
      await mitCaddy({ staging: true }, async (basis) => {
        for (const pfad of [
          "/p/kunde-a/edit/login",
          "/p/kunde-a/edit/agent/events",
          "/p/kunde-a/edit/agent/verlaeufe",
          "/p/kunde-a/edit/version/abc1234",
          "/p/kunde-a/edit-vorschau/assets/hero.png",
        ]) {
          const r = await fetch(basis + pfad);
          await r.text();
          expect(`${pfad}: ${r.headers.get("content-security-policy")}`).toBe(`${pfad}: null`);
        }
      });
    }, 60_000);
  });
});

// ===========================================================================
// Der Staging-Block liefert NICHTS selbst aus — und Produktion sehr wohl
// ===========================================================================
describe("Staging-Block: kein file_server, kein root", () => {
  /**
   * Im Staging ist die öffentliche Sicht der ENTWURF, und den kennt nur der
   * Bun-Prozess. Ein `root`/`file_server` im Proxy lieferte den
   * veröffentlichten Stand aus — also genau das, was der Interessent gerade
   * NICHT sehen soll.
   *
   * Beide Hälften sind nötig: Ohne die zweite wäre der Test auch grün, wenn der
   * Generator überhaupt nichts mehr erzeugte.
   */
  const staging: ServiceOpts = {
    ...base,
    siteDir: "/srv/previews",
    slug: "previews",
    port: 8790,
    staging: true,
    domain: "intern.example.com",
  };

  /**
   * Nur die WIRKSAMEN Zeilen. Ohne diesen Schnitt prüfte der Test die Prosa
   * mit: Der Staging-Block erklärt in einem Kommentar ausdrücklich „kein
   * `root`, kein `file_server`" — und ein `toContain` sähe dort genau das Wort,
   * das nicht vorkommen soll. Ein Test, der am Kommentar scheitert, ist kein
   * Befund, sondern ein Messfehler.
   */
  const nurDirektiven = (text: string): string =>
    text
      .split("\n")
      .filter((z) => !z.trim().startsWith("#"))
      .join("\n");

  test("der Staging-Block enthält weder file_server noch root", () => {
    const block = nurDirektiven(caddyBlock(staging));
    expect(block).not.toContain("file_server");
    expect(block).not.toContain("root *");
  });

  test("GEGENPROBE: der Produktionsblock enthält beide", () => {
    // Ohne diese Hälfte wäre der Test darüber auch grün, wenn der Generator
    // überhaupt nichts mehr erzeugte.
    const block = nurDirektiven(caddyBlock(base));
    expect(block).toContain("file_server");
    expect(block).toContain("root *");
  });

  test("und deshalb trägt die Staging-Vorlage KEINE @allowed-Zeile", () => {
    // Der Pinning-Test in service.test.ts vergleicht die `@allowed`-Zeile über
    // die Vorlagen. Die Staging-Vorlage darf dort nicht mitlaufen — sie hat
    // keine, und zwar aus einem Grund, nicht aus Vergesslichkeit.
    const text = nurDirektiven(readFileSync(join(REPO_ROOT, "Caddyfile.staging.example"), "utf8"));
    expect(text).not.toContain("@allowed");
    expect(text).not.toContain("file_server");
    // Gegenprobe: die beiden Produktions-Vorlagen führen beides sehr wohl.
    for (const datei of ["Caddyfile.example", "Caddyfile.multi.example"]) {
      const vorlage = nurDirektiven(readFileSync(join(REPO_ROOT, datei), "utf8"));
      expect(`${datei}: ${vorlage.includes("@allowed") && vorlage.includes("file_server")}`).toBe(
        `${datei}: true`,
      );
    }
  });
});

// ===========================================================================
// Ein übersprungener Test darf nicht wie ein bestandener aussehen
// ===========================================================================
describe("die Werkzeuge dieser Datei sind da", () => {
  /**
   * `test.skipIf` wertet beim EINSAMMELN aus, vor jedem `beforeAll`. In diesem
   * Repo hat das schon vier Tests dauerhaft stillgelegt, die dabei grün
   * meldeten — die teuerste Fehlerklasse, die CLAUDE.md kennt: ein Nachweis,
   * der nicht anschlagen kann, beweist durch sein Ausbleiben nichts.
   *
   * Dieser Fall ist die Gegenmaßnahme und mit Absicht KEIN `skipIf`: Fehlt das
   * Werkzeug, wird genau eine Zeile rot und nennt es beim Namen, statt dass
   * eine Handvoll Prüfungen lautlos verschwindet. Wer hier bewusst ohne das
   * Werkzeug arbeitet, sieht die eine rote Zeile und weiß, was ihm fehlt.
   */
  test("caddy ist installiert — sonst laufen die Prüfungen auf der Leitung ins Leere", () => {
    expect(`caddy vorhanden: ${haveCaddy()}`).toBe("caddy vorhanden: true");
  });

});
