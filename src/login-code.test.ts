/**
 * Die zweistufige Anmeldung, Ende zu Ende gegen `handleEditorRequest`.
 *
 * Der Versand ist immer die Attrappe — **kein Test hier schickt eine echte
 * Nachricht.** Geprüft wird das Verhalten, auf das sich der Kunde verlässt, und
 * das, was ein Angreifer nicht erfahren darf.
 */
import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as host from "./host.ts";
import { createAuthFile, loadAuthFile, cookieName } from "./auth.ts";
import { attrappenVersand, type Attrappe } from "./versand.ts";
import { vergisseAlleCodes, CODE_GUELTIG_MS, MAX_VERSUCHE } from "./codes.ts";
import { vergisseBremse, MAX_PRO_KENNUNG } from "./bremse.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");
const NUMMER = "+4915120464812";
const ADRESSE = "chef@handwerk-mueller.de";
const PAGES = ["index.html", "impressum.html", "datenschutz.html", "agb.html"];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let ctx: host.HostCtx;
let versand: Attrappe;

beforeEach(async () => {
  vergisseAlleCodes();
  vergisseBremse();
  const siteDir = mkdtempSync(join(tmpdir(), "regoro-login-"));
  dirs.push(siteDir);
  cpSync(REAL_SITE, siteDir, { recursive: true });
  await createAuthFile(siteDir, [NUMMER, ADRESSE]);
  versand = attrappenVersand();
  ctx = {
    repoRoot: siteDir,
    siteDir,
    pageWhitelist: PAGES,
    auth: loadAuthFile(siteDir),
    sitePrefix: "",
    versand,
  };
});

function post(felder: Record<string, string>): Promise<Response> {
  const url = new URL("http://localhost:8788/edit/login");
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(felder).toString(),
  });
  return host.handleEditorRequest(req, url, ctx);
}

function get(pfad: string, cookie?: string): Promise<Response> {
  const url = new URL("http://localhost:8788" + pfad);
  const req = new Request(url, { headers: cookie ? { cookie } : {} });
  return host.handleEditorRequest(req, url, ctx);
}

/** Stufe 1 + Stufe 2 in einem Zug. Gibt die Antwort der zweiten Stufe. */
async function melde(kennung: string, weg: "sms" | "email" = "sms", returnTo?: string) {
  const basis: Record<string, string> = { kennung, weg };
  if (returnTo) basis.return = returnTo;
  const stufe1 = await post(basis);
  const code = versand.gesendet.at(-1)?.code;
  const stufe2 = await post({ ...basis, code: code ?? "000000" });
  return { stufe1, stufe2, code };
}

describe("Der Weg hinein", () => {
  test("Nummer eintragen, Code eintragen, drin", async () => {
    const { stufe1, stufe2 } = await melde(NUMMER);
    expect(stufe1.status).toBe(200);
    expect(await stufe1.clone().text()).toContain("Code eingeben");
    expect(versand.gesendet).toHaveLength(1);
    expect(versand.gesendet[0]!.kennung.kanal).toBe("sms");

    expect(stufe2.status).toBe(302);
    expect(stufe2.headers.get("location")).toBe("/edit");
    const cookie = stufe2.headers.get("set-cookie")!.split(";")[0]!;
    expect(await get("/edit", cookie).then((r) => r.status)).toBe(200);
  });

  test("dasselbe mit der E-Mail-Adresse", async () => {
    const { stufe2 } = await melde(ADRESSE, "email");
    expect(versand.gesendet[0]!.kennung.kanal).toBe("email");
    expect(stufe2.status).toBe(302);
  });

  test("die Schreibweise der Nummer ist egal", async () => {
    const { stufe2 } = await melde("0151 20464812");
    expect(stufe2.status).toBe(302);
  });

  test("eine Adresse im Telefon-Reiter geht als Mail raus", async () => {
    await post({ kennung: ADRESSE, weg: "sms" });
    expect(versand.gesendet[0]!.kennung.kanal).toBe("email");
  });

  test("das Cookie gilt 30 Tage und behaelt seine Schutzattribute", async () => {
    const { stufe2 } = await melde(NUMMER);
    const sc = stufe2.headers.get("set-cookie")!;
    expect(sc).toContain(`${cookieName()}=`);
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Strict");
    expect(sc).toContain("Path=/");
    const maxAge = Number(/Max-Age=(\d+)/.exec(sc)![1]);
    expect(maxAge).toBe(30 * 24 * 3600);
  });

  test("?return= ueberlebt BEIDE Stufen", async () => {
    const { stufe2 } = await melde(NUMMER, "sms", "/impressum.html/edit");
    expect(stufe2.headers.get("location")).toBe("/impressum.html/edit");
  });

  test("ein fremdes ?return= wird auch an der zweiten Stufe abgewiesen", async () => {
    // Der Open-Redirect-Schutz muss dort greifen, wo weitergeleitet wird.
    for (const ziel of ["https://evil.example", "//evil.example", "/etc/passwd"]) {
      vergisseBremse();
      const { stufe2 } = await melde(NUMMER, "sms", ziel);
      expect(stufe2.headers.get("location")).toBe("/edit");
    }
  });
});

describe("Was ein Angreifer nicht erfaehrt", () => {
  test("eine nicht hinterlegte Nummer loest KEINE Nachricht aus", async () => {
    const antwort = await post({ kennung: "+4917099999999", weg: "sms" });
    expect(versand.gesendet).toHaveLength(0);
    // …aber die Antwort ist dieselbe wie bei einer hinterlegten.
    expect(antwort.status).toBe(200);
    expect(await antwort.text()).toContain("Code eingeben");
  });

  test("die Antwort ist Byte fuer Byte dieselbe wie bei einer hinterlegten Nummer", async () => {
    const fremd = await post({ kennung: "+4917099999999", weg: "sms" });
    const fremdText = await fremd.text();
    vergisseBremse();
    const bekannt = await post({ kennung: NUMMER, weg: "sms" });
    // Nur die Kennung selbst steht im Formular; sonst darf nichts abweichen.
    expect(
      (await bekannt.text()).replace(NUMMER, "X").replace(/\+4917099999999/g, "X"),
    ).toBe(fremdText.replace(/\+4917099999999/g, "X").replace(NUMMER, "X"));
  });

  test("falscher Code, abgelaufener Code und unbekannte Kennung sehen gleich aus", async () => {
    await post({ kennung: NUMMER, weg: "sms" });
    const falsch = await post({ kennung: NUMMER, weg: "sms", code: "000000" });
    const unbekannt = await post({ kennung: "+4917099999999", weg: "sms", code: "000000" });
    expect(falsch.status).toBe(401);
    expect(unbekannt.status).toBe(401);
    // Bis auf die eingetippte Kennung, die im Formular mitreist, identisch.
    const ohneKennung = (t: string) => t.replace(NUMMER, "X").replace("+4917099999999", "X");
    expect(ohneKennung(await falsch.text())).toBe(ohneKennung(await unbekannt.text()));
  });

  test("der Code steht nirgends in einer Antwort", async () => {
    const stufe1 = await post({ kennung: NUMMER, weg: "sms" });
    const code = versand.gesendet[0]!.code;
    expect(await stufe1.text()).not.toContain(code);
  });
});

describe("Der Code selbst", () => {
  test("ein falscher Code laesst den richtigen gelten", async () => {
    await post({ kennung: NUMMER, weg: "sms" });
    const code = versand.gesendet[0]!.code;
    expect((await post({ kennung: NUMMER, weg: "sms", code: "000000" })).status).toBe(401);
    expect((await post({ kennung: NUMMER, weg: "sms", code })).status).toBe(302);
  });

  test("nach fuenf Fehlversuchen ist der Code verbraucht", async () => {
    await post({ kennung: NUMMER, weg: "sms" });
    const code = versand.gesendet[0]!.code;
    for (let i = 0; i < MAX_VERSUCHE; i++) {
      expect((await post({ kennung: NUMMER, weg: "sms", code: "000000" })).status).toBe(401);
    }
    expect((await post({ kennung: NUMMER, weg: "sms", code })).status).toBe(401);
  });

  test("ein zweiter angeforderter Code entwertet den ersten", async () => {
    await post({ kennung: NUMMER, weg: "sms" });
    const ersterCode = versand.gesendet[0]!.code;
    await post({ kennung: NUMMER, weg: "sms" });
    expect((await post({ kennung: NUMMER, weg: "sms", code: ersterCode })).status).toBe(401);
  });

  test("ein Code ist nur eine einzige Anmeldung wert", async () => {
    const { code } = await melde(NUMMER);
    expect((await post({ kennung: NUMMER, weg: "sms", code: code! })).status).toBe(401);
  });

  test("nach fuenf Minuten ist er weg", async () => {
    // Die Gueltigkeit selbst ist in codes.test.ts mit einer gestellten Uhr
    // geprueft; hier zaehlt nur, dass die Anmeldeseite die Zeit auch benutzt.
    expect(CODE_GUELTIG_MS).toBe(5 * 60 * 1000);
  });
});

describe("Die Bremse", () => {
  test("der vierte Code fuer dieselbe Nummer wird abgelehnt, BEVOR etwas rausgeht", async () => {
    for (let i = 0; i < MAX_PRO_KENNUNG; i++) {
      expect((await post({ kennung: NUMMER, weg: "sms" })).status).toBe(200);
    }
    const gesendetVorher = versand.gesendet.length;
    const antwort = await post({ kennung: NUMMER, weg: "sms" });
    expect(antwort.status).toBe(429);
    expect(versand.gesendet.length).toBe(gesendetVorher);
    const text = await antwort.text();
    expect(text).toContain("Zu viele Codes");
    // Die Wartezeit wird genannt, damit niemand blind neu lädt.
    expect(text).toMatch(/in \d+ (Minute|Stunde)/);
  });

  test("sie greift auch fuer eine NICHT hinterlegte Nummer — sonst waere sie umgehbar", async () => {
    for (let i = 0; i < MAX_PRO_KENNUNG; i++) await post({ kennung: "+4917099999999", weg: "sms" });
    expect((await post({ kennung: "+4917099999999", weg: "sms" })).status).toBe(429);
  });

  test("eine geflutete Nummer sperrt die hinterlegte ADRESSE nicht mit", async () => {
    // Wer die Geschaeftsnummer aus dem Impressum kennt, kann mit drei Anfragen
    // je Stunde ihre Codes aufbrauchen. Der zweite Kontaktweg hat einen eigenen
    // Zaehler und bleibt offen — das ist der Grund, beide zu hinterlegen.
    for (let i = 0; i <= MAX_PRO_KENNUNG; i++) await post({ kennung: NUMMER, weg: "sms" });
    expect((await post({ kennung: NUMMER, weg: "sms" })).status).toBe(429);

    const ueberMail = await melde(ADRESSE, "email");
    expect(ueberMail.stufe2.status).toBe(302);
  });

  test("die Codes des Angreifers landen beim KUNDEN und funktionieren dort", async () => {
    // Das entschaerft den Lockout: Wer eine fremde Nummer flutet, schickt dem
    // Inhaber gueltige Codes. Der kann sich damit anmelden, ohne selbst einen
    // anzufordern.
    await post({ kennung: NUMMER, weg: "sms" }); // "Angreifer"
    const code = versand.gesendet.at(-1)!.code;
    expect(versand.gesendet.at(-1)!.kennung.wert).toBe(NUMMER);
    const antwort = await post({ kennung: NUMMER, weg: "sms", code });
    expect(antwort.status).toBe(302);
  });
});

describe("Wenn etwas fehlt", () => {
  test("ohne Versand sagt die Seite das — und zwar JEDEM gleich", async () => {
    // Die Meldung darf nur vom gewaehlten Kanal abhaengen, nie davon, ob die
    // Kennung hinterlegt ist. Sonst waere sie ein Orakel darueber, wer Kunde ist.
    ctx = { ...ctx, versand: null };
    const bekannt = await post({ kennung: NUMMER, weg: "sms" });
    vergisseBremse();
    const fremd = await post({ kennung: "+4917099999999", weg: "sms" });
    expect(bekannt.status).toBe(503);
    expect(fremd.status).toBe(503);
    expect(await bekannt.text()).toContain("nicht eingerichtet");
  });

  test("ein nur halb eingerichteter Versand verraet nichts", async () => {
    const { kombinierterVersand, attrappenVersand: att } = await import("./versand.ts");
    ctx = { ...ctx, versand: kombinierterVersand({ sms: att() }) };
    const bekannteMail = await post({ kennung: ADRESSE, weg: "email" });
    vergisseBremse();
    const fremdeMail = await post({ kennung: "fremd@example.de", weg: "email" });
    expect(bekannteMail.status).toBe(503);
    expect(fremdeMail.status).toBe(503);
    // Die Nummer geht weiterhin, fuer beide gleich.
    vergisseBremse();
    expect((await post({ kennung: NUMMER, weg: "sms" })).status).toBe(200);
    vergisseBremse();
    expect((await post({ kennung: "+4917099999999", weg: "sms" })).status).toBe(200);
  });

  test("der Fehlertext nennt den tatsaechlichen Kanal, nicht den Reiter", async () => {
    // Adresse im SMS-Reiter, aber nur SMS eingerichtet: Es fehlt der E-MAIL-Versand.
    const { kombinierterVersand, attrappenVersand: att } = await import("./versand.ts");
    ctx = { ...ctx, versand: kombinierterVersand({ sms: att() }) };
    const antwort = await post({ kennung: ADRESSE, weg: "sms" });
    expect(antwort.status).toBe(503);
    expect(await antwort.text()).toContain("per E-Mail");
  });

  test("ein gescheiterter Versand aendert die Antwort nicht", async () => {
    // Frueher stand hier 502 — das war ein rauschfreies Orakel: nur eine
    // HINTERLEGTE Kennung kann einen Versandfehler ausloesen. Der Fehler geht
    // jetzt ins Log des Betreibers, nicht an den Browser.
    ctx = {
      ...ctx,
      versand: { sendeCode: () => Promise.reject(new Error("Guthaben aufgebraucht")) },
    };
    const bekannt = await post({ kennung: NUMMER, weg: "sms" });
    vergisseBremse();
    const fremd = await post({ kennung: "+4917099999999", weg: "sms" });
    expect(bekannt.status).toBe(200);
    expect(fremd.status).toBe(200);
    expect(await bekannt.text()).not.toContain("Guthaben");
  });

  test("die Antwort wartet NICHT auf den Anbieter", async () => {
    // Sonst haengt die Laufzeit daran, ob die Kennung hinterlegt ist —
    // gemessen 152 ms gegen 0,2 ms, fuer jede Nummer nachpruefbar.
    let angestossen = false;
    ctx = {
      ...ctx,
      versand: {
        sendeCode: () => {
          angestossen = true;
          return new Promise<void>(() => {}); // loest sich NIE auf
        },
      },
    };
    const antwort = await Promise.race([
      post({ kennung: NUMMER, weg: "sms" }),
      Bun.sleep(2000).then(() => "haengt" as const),
    ]);
    expect(antwort).not.toBe("haengt");
    expect(angestossen).toBe(true);
    expect((antwort as Response).status).toBe(200);
  });

  test("Unsinn im Feld wird beim Namen genannt", async () => {
    const antwort = await post({ kennung: "abc", weg: "sms" });
    expect(antwort.status).toBe(400);
    expect(await antwort.text()).toContain("Telefonnummer");
    expect(versand.gesendet).toHaveLength(0);
  });

  test("ohne Auth-Datei bleibt die Anmeldung 404 (fail-closed)", async () => {
    ctx = { ...ctx, auth: null };
    expect((await get("/edit/login")).status).toBe(404);
    expect((await post({ kennung: NUMMER, weg: "sms" })).status).toBe(404);
  });
});

describe("Die Anmeldeseite", () => {
  test("bietet beide Reiter an, und der gewaehlte ist markiert", async () => {
    const sms = await (await get("/edit/login?weg=sms")).text();
    expect(sms).toContain('href="/edit/login?weg=email"');
    expect(sms).toContain('class="tab active"');
    const mail = await (await get("/edit/login?weg=email")).text();
    expect(mail).toContain("E-Mail-Adresse");
    expect(mail).toContain('href="/edit/login?weg=sms"');
  });

  test("kommt ohne JavaScript aus", async () => {
    // Die einzige Route ohne Auth-Wall soll kein Skript ausfuehren.
    const seite = await (await get("/edit/login")).text();
    expect(seite).not.toContain("<script");
    expect(seite).not.toContain("onclick");
  });

  test("die Reiter tragen ein ?return= mit", async () => {
    const seite = await (await get("/edit/login?return=%2Fimpressum.html%2Fedit")).text();
    expect(seite).toContain("return=%2Fimpressum.html%2Fedit");
  });
});
