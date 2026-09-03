/**
 * integrationen.ts — benannte fremde APIs pro Website (`.regoro/integrationen.json`).
 *
 * Hier stehen Schlüssel, die dem **Kunden** gehören — bewusst eine andere Datei
 * als der betreiberweite Modellzugang (`betreiber-config.ts`). Zwei Eigentümer,
 * zwei Lebensdauern, zwei Anzeigen; in einer gemeinsamen Datei gäbe die eine
 * Anzeige irgendwann die andere mit aus.
 *
 * Der kritische Teil ist `browserHerkuenfte`: Was hier beim Laden durchrutscht,
 * wird im Validator zur Lücke und landet in der CSP des Caddy-Blocks. Deshalb
 * prüft der Lader die Herkünfte selbst und wirft alles Ungültige weg.
 *
 * Fail-closed: kaputte Datei heißt **keine Integrationen**, nie „alles erlauben".
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_DIR_NAME } from "./auth.ts";

import {
  integrationenPfad,
  loadIntegrationen,
  schreibeIntegrationen,
  alleBrowserHerkuenfte,
  normalisiereHerkunft,
  type Integration,
  type Integrationen,
} from "./integrationen.ts";

const tmpRoots: string[] = [];

function makeSite(): string {
  const dir = mkdtempSync(join(tmpdir(), "regoro-integ-"));
  tmpRoots.push(dir);
  mkdirSync(join(dir, AUTH_DIR_NAME), { recursive: true, mode: 0o700 });
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

/** Schreibt beliebigen Rohtext nach .regoro/integrationen.json. */
function mitDatei(inhalt: string): string {
  const siteDir = makeSite();
  writeFileSync(integrationenPfad(siteDir), inhalt);
  return siteDir;
}

/** Schreibt eine v:1-Datei mit den gegebenen Einträgen. */
function mitEintraegen(eintraege: Record<string, unknown>): string {
  return mitDatei(JSON.stringify({ v: 1, integrationen: eintraege }));
}

const STRIPE = {
  baseUrl: "https://api.stripe.com",
  auth: { typ: "bearer", key: "rk_live_0123456789" },
  erlaubtePfade: ["POST /v1/products", "GET /v1/*"],
  browserHerkuenfte: ["https://js.stripe.com"],
  angelegt: "2026-09-02",
};

describe("integrationen.ts — integrationenPfad()", () => {
  test("liegt neben auth.json im .regoro-Ordner der Website", () => {
    expect(integrationenPfad("/srv/sites/kunde.de")).toBe("/srv/sites/kunde.de/.regoro/integrationen.json");
  });

  test("benutzt dieselbe Verzeichniskonstante wie auth.ts — kein zweiter Ordnername", () => {
    expect(integrationenPfad("/x")).toContain(`/${AUTH_DIR_NAME}/`);
  });
});

describe("integrationen.ts — loadIntegrationen() ist fail-closed", () => {
  test("fehlende Datei → leere Map (kein Fehler)", () => {
    expect(loadIntegrationen(makeSite()).size).toBe(0);
  });

  test("fehlendes .regoro-Verzeichnis → leere Map", () => {
    const dir = mkdtempSync(join(tmpdir(), "regoro-integ-leer-"));
    tmpRoots.push(dir);
    expect(loadIntegrationen(dir).size).toBe(0);
  });

  test("kaputtes JSON → leere Map, NICHT alles erlauben", () => {
    expect(loadIntegrationen(mitDatei("{ kaputt")).size).toBe(0);
  });

  test("falsche Version → leere Map", () => {
    expect(loadIntegrationen(mitDatei(JSON.stringify({ v: 2, integrationen: { stripe: STRIPE } }))).size).toBe(0);
  });

  test("integrationen ist kein Objekt → leere Map", () => {
    expect(loadIntegrationen(mitDatei(JSON.stringify({ v: 1, integrationen: [STRIPE] }))).size).toBe(0);
    expect(loadIntegrationen(mitDatei(JSON.stringify({ v: 1 }))).size).toBe(0);
  });

  test("liefert immer eine Map, nie null oder undefined", () => {
    expect(loadIntegrationen(mitDatei("kaputt"))).toBeInstanceOf(Map);
  });
});

describe("integrationen.ts — loadIntegrationen() liest gültige Einträge", () => {
  test("vollständiger Eintrag kommt vollständig an", () => {
    const i = loadIntegrationen(mitEintraegen({ stripe: STRIPE }));
    const s = i.get("stripe")!;
    expect(s.baseUrl).toBe("https://api.stripe.com");
    expect(s.auth).toEqual({ typ: "bearer", key: "rk_live_0123456789" });
    expect(s.erlaubtePfade).toEqual(["POST /v1/products", "GET /v1/*"]);
    expect(s.browserHerkuenfte).toEqual(["https://js.stripe.com"]);
    expect(typeof s.angelegt).toBe("string");
  });

  test("mehrere benannte Einträge nebeneinander — von Anfang an, nicht ein einzelner Schlüssel", () => {
    const i = loadIntegrationen(
      mitEintraegen({
        stripe: STRIPE,
        wetter: { ...STRIPE, baseUrl: "https://api.wetter.example", auth: { typ: "header", name: "X-Key", key: "abc" } },
      }),
    );
    expect([...i.keys()].sort()).toEqual(["stripe", "wetter"]);
    expect(i.get("wetter")!.auth).toEqual({ typ: "header", name: "X-Key", key: "abc" });
  });

  test("fehlende erlaubtePfade → null (alles unterhalb baseUrl), nicht []", () => {
    const { erlaubtePfade: _weg, ...ohne } = STRIPE;
    expect(loadIntegrationen(mitEintraegen({ stripe: ohne })).get("stripe")!.erlaubtePfade).toBeNull();
  });

  test("fehlende browserHerkuenfte → [] (keine), nicht null", () => {
    const { browserHerkuenfte: _weg, ...ohne } = STRIPE;
    expect(loadIntegrationen(mitEintraegen({ stripe: ohne })).get("stripe")!.browserHerkuenfte).toEqual([]);
  });

  test("Schrägstrich am Ende der baseUrl wird entfernt — sonst entsteht beim Anhängen ein //", () => {
    const i = loadIntegrationen(mitEintraegen({ stripe: { ...STRIPE, baseUrl: "https://api.stripe.com/" } }));
    expect(i.get("stripe")!.baseUrl).toBe("https://api.stripe.com");
  });
});

describe("integrationen.ts — kaputte Einträge fliegen einzeln raus", () => {
  test("Eintrag ohne baseUrl wird verworfen, gültige Nachbarn bleiben", () => {
    const { baseUrl: _weg, ...ohneBase } = STRIPE;
    const i = loadIntegrationen(mitEintraegen({ kaputt: ohneBase, stripe: STRIPE }));
    expect(i.has("kaputt")).toBe(false);
    expect(i.has("stripe")).toBe(true);
  });

  test("baseUrl ohne https → verworfen (der Schlüssel ginge sonst im Klartext raus)", () => {
    const i = loadIntegrationen(
      mitEintraegen({
        a: { ...STRIPE, baseUrl: "http://api.stripe.com" },
        b: { ...STRIPE, baseUrl: "api.stripe.com" },
        c: { ...STRIPE, baseUrl: "file:///etc/passwd" },
      }),
    );
    expect(i.size).toBe(0);
  });

  test("Eintrag ohne auth wird verworfen — ohne Schlüssel ist er nutzlos, aber nie „ohne Schutz\"", () => {
    const { auth: _weg, ...ohneAuth } = STRIPE;
    expect(loadIntegrationen(mitEintraegen({ stripe: ohneAuth })).size).toBe(0);
  });

  test("unbekannter auth-Typ wird verworfen", () => {
    const i = loadIntegrationen(
      mitEintraegen({
        a: { ...STRIPE, auth: { typ: "basic", key: "x" } },
        b: { ...STRIPE, auth: { typ: "header", key: "x" } }, // name fehlt
        c: { ...STRIPE, auth: { typ: "bearer" } }, // key fehlt
        d: { ...STRIPE, auth: "rk_live_x" },
      }),
    );
    expect(i.size).toBe(0);
  });

  test("erlaubtePfade mit Nicht-Strings wird verworfen, nicht halb übernommen", () => {
    const i = loadIntegrationen(mitEintraegen({ stripe: { ...STRIPE, erlaubtePfade: ["GET /v1/*", 42] } }));
    // Halb übernommen wäre die gefährliche Auslegung: aus einer kaputten Liste
    // darf nie „alles erlaubt" werden.
    expect(i.get("stripe")?.erlaubtePfade ?? []).not.toContain(42 as unknown as string);
  });

  test("leerer Integrationsname wird verworfen — er wäre im Relay-Pfad nicht adressierbar", () => {
    expect(loadIntegrationen(mitEintraegen({ "": STRIPE })).has("")).toBe(false);
  });

  test("Name mit Schrägstrich wird verworfen — er würde den Relay-Pfad aufspalten", () => {
    // /api/<name>/<rest>: ein Name mit "/" verschöbe die Grenze zwischen Name und Rest.
    const i = loadIntegrationen(mitEintraegen({ "stripe/v1": STRIPE, "../etc": STRIPE }));
    expect(i.size).toBe(0);
  });
});

describe("integrationen.ts — browserHerkuenfte werden BEIM LADEN geprüft", () => {
  function herkuenfte(liste: unknown): string[] {
    const i = loadIntegrationen(mitEintraegen({ stripe: { ...STRIPE, browserHerkuenfte: liste } }));
    return i.get("stripe")?.browserHerkuenfte ?? [];
  }

  test("https-Origin bleibt unverändert", () => {
    expect(herkuenfte(["https://js.stripe.com"])).toEqual(["https://js.stripe.com"]);
  });

  test("Pfad, Query und Fragment werden auf schema://host[:port] eingedampft", () => {
    // Der Validator vergleicht später exakt gegen diese Liste. Bliebe der Pfad
    // stehen, verglichen wir Origin gegen URL und ließen alles oder nichts durch.
    expect(herkuenfte(["https://js.stripe.com/v3/?a=1#x"])).toEqual(["https://js.stripe.com"]);
  });

  test("Standardport verschwindet, abweichender Port bleibt stehen", () => {
    expect(herkuenfte(["https://js.stripe.com:443"])).toEqual(["https://js.stripe.com"]);
    expect(herkuenfte(["https://intern.example:8443"])).toEqual(["https://intern.example:8443"]);
  });

  test("Großschreibung wird normalisiert — sonst schlägt der exakte Vergleich fehl", () => {
    expect(herkuenfte(["HTTPS://JS.Stripe.COM"])).toEqual(["https://js.stripe.com"]);
  });

  test("http, protokollrelativ, relativ und Nicht-URLs fliegen raus", () => {
    expect(herkuenfte(["http://js.stripe.com"])).toEqual([]);
    expect(herkuenfte(["//js.stripe.com"])).toEqual([]);
    expect(herkuenfte(["js.stripe.com"])).toEqual([]);
    expect(herkuenfte(["/assets"])).toEqual([]);
    expect(herkuenfte([""])).toEqual([]);
  });

  test("javascript:, data: und file: fliegen raus", () => {
    expect(herkuenfte(["javascript:alert(1)"])).toEqual([]);
    expect(herkuenfte(["data:text/html,<script>"])).toEqual([]);
    expect(herkuenfte(["file:///etc/passwd"])).toEqual([]);
  });

  test("Nicht-Strings und eine Nicht-Liste fliegen raus, ohne den Eintrag zu töten", () => {
    expect(herkuenfte([42, null, { host: "x" }, "https://js.stripe.com"])).toEqual(["https://js.stripe.com"]);
    expect(herkuenfte("https://js.stripe.com")).toEqual([]);
  });

  test("Whitespace und Steuerzeichen führen nicht zu einer stillen Herkunft", () => {
    // "https://js.stripe.com\n.angreifer.de" darf nicht als js.stripe.com enden.
    const raus = herkuenfte(["https://js.stripe.com\n.angreifer.de", " https://js.stripe.com "]);
    expect(raus.every((h) => h === "https://js.stripe.com")).toBe(true);
    expect(raus).not.toContain("https://js.stripe.com.angreifer.de");
  });

  test("Doppelte Herkünfte im selben Eintrag werden zusammengefasst", () => {
    expect(herkuenfte(["https://js.stripe.com", "https://js.stripe.com/v3"])).toEqual(["https://js.stripe.com"]);
  });
});

describe("integrationen.ts — normalisiereHerkunft() ist die EINE Normalisierung", () => {
  // Sie wird an zwei Stellen gebraucht: hier beim Laden und im Validator, der das
  // neue Markup exakt gegen diese Liste vergleicht. Zwei Kopien wären genau die
  // Lücke — was der Lader durchlässt und der Validator anders normalisiert, wird
  // zur stillen Freigabe. Deshalb ist sie exportiert und hat eigene Tests.

  test("aus einer https-URL wird schema://host[:port]", () => {
    expect(normalisiereHerkunft("https://js.stripe.com/v3/?a=1#x")).toBe("https://js.stripe.com");
    expect(normalisiereHerkunft("https://intern.example:8443/pfad")).toBe("https://intern.example:8443");
    expect(normalisiereHerkunft("https://js.stripe.com:443/")).toBe("https://js.stripe.com");
  });

  test("Großschreibung wird normalisiert, umschließender Leerraum getrimmt", () => {
    expect(normalisiereHerkunft("HTTPS://JS.Stripe.COM")).toBe("https://js.stripe.com");
    expect(normalisiereHerkunft("  https://js.stripe.com  ")).toBe("https://js.stripe.com");
  });

  test("Steuerzeichen INNERHALB führen zum Verwerfen, nicht zum Säubern", () => {
    // Das ist der Kern: Aus "https://js.stripe.com\n.angreifer.de" würde beim
    // Wegputzen eine gültige, aber FREMDE Herkunft — und die stünde danach in der
    // CSP des Kunden und gälte dem Validator als erlaubt.
    expect(normalisiereHerkunft("https://js.stripe.com\n.angreifer.de")).toBeNull();
    expect(normalisiereHerkunft("https://js.stripe.com\t.angreifer.de")).toBeNull();
    expect(normalisiereHerkunft("https://js.stripe\u0000.com")).toBeNull();
    expect(normalisiereHerkunft("https://js.stripe.com .angreifer.de")).toBeNull();
  });

  test("nur https — http, protokollrelativ, relativ und Nicht-URLs sind keine Herkunft", () => {
    for (const roh of ["http://js.stripe.com", "//js.stripe.com", "js.stripe.com", "/assets", "", "   "]) {
      expect(normalisiereHerkunft(roh)).toBeNull();
    }
  });

  test("javascript:, data: und file: sind überhaupt keine Herkünfte", () => {
    for (const roh of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd"]) {
      expect(normalisiereHerkunft(roh)).toBeNull();
    }
  });

  test("Nicht-Strings ergeben null, statt zu werfen", () => {
    for (const roh of [42, null, undefined, {}, ["https://js.stripe.com"], true]) {
      expect(normalisiereHerkunft(roh)).toBeNull();
    }
  });

  test("die Funktion ist idempotent — zweimal angewandt ändert sich nichts", () => {
    // Sonst driften Lader und Validator schon dadurch auseinander, dass der eine
    // eine bereits normalisierte Herkunft ein zweites Mal durchschickt.
    for (const roh of ["https://js.stripe.com/v3/", "https://intern.example:8443/x", "HTTPS://A.example"]) {
      const einmal = normalisiereHerkunft(roh)!;
      expect(normalisiereHerkunft(einmal)).toBe(einmal);
    }
  });

  test("loadIntegrationen benutzt genau diese Funktion", () => {
    // Ein Test, der die beiden aneinander bindet: Was der Lader ablegt, muss dem
    // entsprechen, was normalisiereHerkunft aus derselben Eingabe macht.
    const roh = ["https://js.stripe.com/v3/?a=1", "HTTPS://M.Stripe.Network:443/x", "http://fremd.de", "kaputt"];
    const i = loadIntegrationen(mitEintraegen({ stripe: { ...STRIPE, browserHerkuenfte: roh } }));
    const erwartet = [...new Set(roh.map(normalisiereHerkunft).filter((h): h is string => h !== null))];
    expect(i.get("stripe")!.browserHerkuenfte.slice().sort()).toEqual(erwartet.slice().sort());
  });
});

describe("integrationen.ts — alleBrowserHerkuenfte()", () => {
  function map(eintraege: Record<string, Integration>): Integrationen {
    return new Map(Object.entries(eintraege));
  }

  const basis: Integration = {
    baseUrl: "https://api.stripe.com",
    auth: { typ: "bearer", key: "rk_live_x" },
    erlaubtePfade: null,
    browserHerkuenfte: [],
    angelegt: "2026-09-02",
  };

  test("leere Map → leere Liste (die CSP bleibt bei connect-src 'none')", () => {
    expect(alleBrowserHerkuenfte(new Map())).toEqual([]);
  });

  test("sammelt über alle Integrationen, dedupliziert und sortiert", () => {
    const raus = alleBrowserHerkuenfte(
      map({
        stripe: { ...basis, browserHerkuenfte: ["https://js.stripe.com", "https://m.stripe.network"] },
        anderer: { ...basis, browserHerkuenfte: ["https://js.stripe.com"] },
      }),
    );
    expect(raus).toEqual(["https://js.stripe.com", "https://m.stripe.network"]);
  });

  test("die Reihenfolge ist stabil — der Caddy-Block darf nicht bei jedem Aufruf anders aussehen", () => {
    const a = map({ a: { ...basis, browserHerkuenfte: ["https://b.example", "https://a.example"] } });
    expect(alleBrowserHerkuenfte(a)).toEqual(alleBrowserHerkuenfte(a));
    expect(alleBrowserHerkuenfte(a)).toEqual(["https://a.example", "https://b.example"]);
  });
});

describe("integrationen.ts — schreibeIntegrationen()", () => {
  const eintrag: Integration = {
    baseUrl: "https://api.stripe.com",
    auth: { typ: "bearer", key: "rk_live_0123456789" },
    erlaubtePfade: ["POST /v1/products"],
    browserHerkuenfte: ["https://js.stripe.com"],
    angelegt: "2026-09-02",
  };

  test("Schreiben und Lesen ergibt dasselbe zurück", () => {
    const siteDir = makeSite();
    schreibeIntegrationen(siteDir, new Map([["stripe", eintrag]]));
    expect(loadIntegrationen(siteDir).get("stripe")).toEqual(eintrag);
  });

  test("die Datei bekommt 0600 — hier stehen Schlüssel des Kunden", () => {
    const siteDir = makeSite();
    schreibeIntegrationen(siteDir, new Map([["stripe", eintrag]]));
    expect(statSync(integrationenPfad(siteDir)).mode & 0o777).toBe(0o600);
  });

  test("fehlendes .regoro-Verzeichnis wird mit 0700 angelegt", () => {
    const siteDir = mkdtempSync(join(tmpdir(), "regoro-integ-neu-"));
    tmpRoots.push(siteDir);
    schreibeIntegrationen(siteDir, new Map([["stripe", eintrag]]));
    expect(statSync(join(siteDir, AUTH_DIR_NAME)).mode & 0o777).toBe(0o700);
  });

  test("die geschriebene Datei trägt v:1", () => {
    const siteDir = makeSite();
    schreibeIntegrationen(siteDir, new Map([["stripe", eintrag]]));
    expect(JSON.parse(readFileSync(integrationenPfad(siteDir), "utf8")).v).toBe(1);
  });

  test("leere Map schreibt eine leere Liste, keine kaputte Datei", () => {
    const siteDir = makeSite();
    schreibeIntegrationen(siteDir, new Map());
    expect(loadIntegrationen(siteDir).size).toBe(0);
  });
});
