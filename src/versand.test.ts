/**
 * Versand — Aufbau der Anfrage und Auswertung der Antworten.
 *
 * **Kein Test hier spricht mit gateway.seven.io oder api.scaleway.com.** Alle
 * laufen gegen einen lokalen Attrappen-Server. Eine echte Nachricht aus der
 * Suite wäre Geld und, schlimmer, eine Nachricht an einen echten Menschen.
 */
import { describe, expect, test, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attrappenVersand,
  sevenioVersand,
  scalewayVersand,
  kombinierterVersand,
  ladeVersandKonfig,
  MAX_ABSENDER_LAENGE,
} from "./versand.ts";
import type { Kennung } from "./kennung.ts";

const NUMMER: Kennung = { kanal: "sms", wert: "+4915120464812" };
const ADRESSE: Kennung = { kanal: "email", wert: "max@example.de" };

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Nimmt jede Anfrage entgegen, merkt sie sich und antwortet, wie eingestellt. */
function attrappenServer(antwort: () => { status?: number; body: string }) {
  const empfangen: { pfad: string; kopf: Record<string, string>; koerper: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      empfangen.push({
        pfad: url.pathname,
        kopf: Object.fromEntries(req.headers.entries()),
        koerper: await req.text(),
      });
      const a = antwort();
      return new Response(a.body, { status: a.status ?? 200 });
    },
  });
  return { empfangen, basis: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe("Attrappe", () => {
  test("merkt sich, was gesendet worden waere, und sendet nichts", async () => {
    const a = attrappenVersand();
    await a.sendeCode(NUMMER, "123456");
    expect(a.gesendet).toEqual([{ kennung: NUMMER, code: "123456" }]);
  });
});

describe("SMS ueber seven.io", () => {
  test("Anfrage traegt Empfaenger, Absender und Text", async () => {
    const s = attrappenServer(() => ({ body: JSON.stringify({ success: "100" }) }));
    await sevenioVersand({ anbieter: "sevenio", absender: "REGORO", apiKey: "k" }, s.basis).sendeCode(
      NUMMER,
      "123456",
    );
    const anfrage = s.empfangen[0]!;
    expect(anfrage.pfad).toBe("/sms");
    const felder = new URLSearchParams(anfrage.koerper);
    expect(felder.get("to")).toBe("+4915120464812");
    expect(felder.get("from")).toBe("REGORO");
    expect(felder.get("text")).toContain("123456");
    expect(anfrage.kopf["x-api-key"]).toBe("k");
    s.stop();
  });

  test("ohne apiKey wird KEIN Auth-Kopf gesetzt (ein Proxy spritzt ihn ein)", async () => {
    const s = attrappenServer(() => ({ body: JSON.stringify({ success: "100" }) }));
    await sevenioVersand({ anbieter: "sevenio", absender: "REGORO" }, s.basis).sendeCode(NUMMER, "1");
    expect(s.empfangen[0]!.kopf["x-api-key"]).toBeUndefined();
    s.stop();
  });

  test("der Text enthaelt keinen Link", async () => {
    // Ein Link in einer Anmeldenachricht erzieht dazu, auf Links in
    // Anmeldenachrichten zu klicken. Genau das nutzt Phishing aus.
    const s = attrappenServer(() => ({ body: JSON.stringify({ success: "100" }) }));
    await sevenioVersand({ anbieter: "sevenio", absender: "REGORO" }, s.basis).sendeCode(NUMMER, "1");
    const text = new URLSearchParams(s.empfangen[0]!.koerper).get("text")!;
    expect(text).not.toMatch(/https?:\/\//);
    s.stop();
  });

  const fehlerfaelle: Array<[string, string, string]> = [
    ["900 als JSON", JSON.stringify({ success: "900" }), "Zugangsdaten"],
    ["900 als nackte Zahl", "900", "Zugangsdaten"],
    ["500 Guthaben", JSON.stringify({ success: "500" }), "Guthaben"],
    ["202 Empfaenger", JSON.stringify({ success: "202" }), "Empfängernummer"],
    ["201 Absender", JSON.stringify({ success: "201" }), "Absenderkennung"],
    ["903 IP", JSON.stringify({ success: "903" }), "IP"],
  ];
  for (const [name, body, erwartet] of fehlerfaelle) {
    test(`${name} wird als Fehler erkannt`, async () => {
      const s = attrappenServer(() => ({ body }));
      const v = sevenioVersand({ anbieter: "sevenio", absender: "REGORO" }, s.basis);
      expect(v.sendeCode(NUMMER, "1")).rejects.toThrow(erwartet);
      s.stop();
    });
  }

  test("eine nackte 900 gilt NICHT als Erfolg", async () => {
    // Ohne Accept-Header antwortet seven.io mit nackten Zahlen; 900 sieht dann
    // aus wie ein Guthaben. Diese Verwechslung darf nicht passieren.
    const s = attrappenServer(() => ({ body: "900" }));
    const v = sevenioVersand({ anbieter: "sevenio", absender: "REGORO" }, s.basis);
    expect(v.sendeCode(NUMMER, "1")).rejects.toThrow();
    s.stop();
  });

  test("HTTP-Fehler wird durchgereicht, nicht verschluckt", async () => {
    const s = attrappenServer(() => ({ status: 502, body: "bad gateway" }));
    const v = sevenioVersand({ anbieter: "sevenio", absender: "REGORO" }, s.basis);
    expect(v.sendeCode(NUMMER, "1")).rejects.toThrow("502");
    s.stop();
  });

  test("der Rumpf der Anbieter-Antwort landet NICHT in der Meldung", async () => {
    // Diese Meldung geht ins Betreiber-Log. Der Rumpf gehoert dem Anbieter, und
    // eine 4xx-Antwort spiegelt gern die Anfrage zurueck — die enthaelt den
    // EINMALCODE und den Empfaenger. Nur der Status darf hinein.
    const s = attrappenServer(() => ({
      status: 400,
      body: JSON.stringify({ fehler: "ungueltig", to: "+4915120464812", text: "Code: 424242" }),
    }));
    const v = sevenioVersand({ anbieter: "sevenio", absender: "REGORO" }, s.basis);
    const fehler = await v.sendeCode(NUMMER, "424242").catch((e: Error) => e.message);
    expect(fehler).toContain("400");
    expect(fehler).not.toContain("424242"); // der Code
    expect(fehler).not.toContain("4915120464812"); // der Empfaenger
    expect(fehler).not.toContain("ungueltig");
    s.stop();
  });

  test("kein Rumpf kann den Code ins Log tragen — auch kein kurzer", async () => {
    // Kuerzen genuegte NICHT: "Code: 424242" ergab nach dem Entfernen der
    // Sonderzeichen "Code424242" und trug den Code vollstaendig hinein.
    // Gemessen. Deshalb wird geprueft, nicht gekuerzt.
    const CODE = "424242";
    const rumpfe = [
      `Code: ${CODE}`,
      CODE,
      `${CODE} `,
      `an +4915120464812 Code ${CODE}`,
      `999 \n Code: ${CODE} an +4915120464812`,
      JSON.stringify({ success: "x", echo: { text: `Code ${CODE}`, to: "+4915120464812" } }),
      "<html><body>Wartung</body></html>",
    ];
    for (const body of rumpfe) {
      const s = attrappenServer(() => ({ body }));
      const v = sevenioVersand({ anbieter: "sevenio", absender: "REGORO" }, s.basis);
      const meldung = await v
        .sendeCode(NUMMER, CODE)
        .catch((e: Error) => e.message)
        .then((m) => String(m));
      expect(meldung).not.toContain(CODE);
      expect(meldung).not.toContain("4915120464812");
      s.stop();
    }
  });

  test("ein echter dreistelliger Statuscode wird genannt", async () => {
    // Die Diagnose soll nicht verschwinden: dokumentierte Codes bleiben lesbar.
    const s = attrappenServer(() => ({ body: "777" }));
    const v = sevenioVersand({ anbieter: "sevenio", absender: "REGORO" }, s.basis);
    const meldung = await v.sendeCode(NUMMER, "424242").catch((e: Error) => e.message);
    expect(meldung).toContain("777");
    s.stop();
  });

});

describe("E-Mail ueber Scaleway", () => {
  const konfig = {
    anbieter: "scaleway" as const,
    projektId: "p-1",
    absenderMail: "editor@regoro.de",
    absenderName: "Regoro",
    region: "fr-par",
  };

  test("Anfrage traegt Empfaenger, Absender, Betreff und Projekt", async () => {
    const s = attrappenServer(() => ({ body: JSON.stringify({ emails: [{ id: "m1" }] }) }));
    await scalewayVersand(konfig, s.basis).sendeCode(ADRESSE, "123456");
    const anfrage = s.empfangen[0]!;
    expect(anfrage.pfad).toBe("/emails");
    const body = JSON.parse(anfrage.koerper);
    expect(body.to).toEqual([{ email: "max@example.de" }]);
    expect(body.from).toEqual({ email: "editor@regoro.de", name: "Regoro" });
    expect(body.project_id).toBe("p-1");
    expect(body.subject).toContain("123456");
    expect(body.text).toContain("123456");
    s.stop();
  });

  test("ohne apiKey kein Auth-Kopf", async () => {
    const s = attrappenServer(() => ({ body: JSON.stringify({ emails: [{ id: "m1" }] }) }));
    await scalewayVersand(konfig, s.basis).sendeCode(ADRESSE, "1");
    expect(s.empfangen[0]!.kopf["x-auth-token"]).toBeUndefined();
    s.stop();
  });

  test("Antwort ohne Id gilt als Fehlschlag", async () => {
    const s = attrappenServer(() => ({ body: JSON.stringify({ emails: [] }) }));
    expect(scalewayVersand(konfig, s.basis).sendeCode(ADRESSE, "1")).rejects.toThrow(
      "nicht angenommen",
    );
    s.stop();
  });
});

describe("kombinierterVersand", () => {
  test("waehlt nach Kanal", async () => {
    const sms = attrappenVersand();
    const mail = attrappenVersand();
    const v = kombinierterVersand({ sms, email: mail });
    await v.sendeCode(NUMMER, "111111");
    await v.sendeCode(ADRESSE, "222222");
    expect(sms.gesendet).toHaveLength(1);
    expect(mail.gesendet).toHaveLength(1);
    expect(mail.gesendet[0]!.code).toBe("222222");
  });

  test("ein nicht eingerichteter Kanal wirft, statt still zu schlucken", async () => {
    const v = kombinierterVersand({ sms: attrappenVersand() });
    expect(v.sendeCode(ADRESSE, "1")).rejects.toThrow("E-Mail-Versand eingerichtet");
  });
});

describe("ladeVersandKonfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "regoro-versand-"));
    dirs.push(dir);
  });
  const schreibe = (inhalt: unknown): string => {
    const p = join(dir, "versand.json");
    writeFileSync(p, typeof inhalt === "string" ? inhalt : JSON.stringify(inhalt));
    return p;
  };

  test("fehlende Datei ergibt null (kein Versand eingerichtet)", () => {
    expect(ladeVersandKonfig(join(dir, "gibt-es-nicht.json"))).toBe(null);
  });

  test("nimmt beide Kanaele an", () => {
    const k = ladeVersandKonfig(
      schreibe({
        v: 2,
        sms: { anbieter: "sevenio", absender: "REGORO" },
        email: { anbieter: "scaleway", projektId: "p", absenderMail: "a@b.de" },
      }),
    );
    expect(k?.sms?.anbieter).toBe("sevenio");
    expect(k?.email?.anbieter).toBe("scaleway");
  });

  test("ein einzelner Kanal genuegt", () => {
    expect(ladeVersandKonfig(schreibe({ v: 2, sms: { anbieter: "attrappe" } }))?.email).toBeUndefined();
  });

  test("gar kein Kanal ist ein Fehler", () => {
    expect(() => ladeVersandKonfig(schreibe({ v: 2 }))).toThrow("weder");
  });

  test("zu lange Absenderkennung faellt beim Laden auf, nicht beim ersten Kunden", () => {
    expect(() =>
      ladeVersandKonfig(schreibe({ v: 2, sms: { anbieter: "sevenio", absender: "REGORO-EDITOR" } })),
    ).toThrow(String(MAX_ABSENDER_LAENGE));
  });

  test("Absenderkennung mit Sonderzeichen wird abgelehnt", () => {
    expect(() =>
      ladeVersandKonfig(schreibe({ v: 2, sms: { anbieter: "sevenio", absender: "REG ORO" } })),
    ).toThrow("Buchstaben");
  });

  test("fehlende Pflichtfelder werden benannt", () => {
    expect(() => ladeVersandKonfig(schreibe({ v: 2, email: { anbieter: "scaleway" } }))).toThrow(
      "email.projektId",
    );
  });

  test("falsche Version wird abgelehnt", () => {
    expect(() => ladeVersandKonfig(schreibe({ v: 1, sms: { anbieter: "attrappe" } }))).toThrow('"v": 2');
  });

  test("kaputtes JSON wird benannt", () => {
    expect(() => ladeVersandKonfig(schreibe("{nicht json"))).toThrow("JSON");
  });
});
