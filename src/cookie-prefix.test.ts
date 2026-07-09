/**
 * Cookie-Härtung für Subdomain-Betrieb (kunde.site.example.de).
 *
 * Zwei Zusicherungen:
 *   1. In Prod trägt das Cookie den `__Host-`-Präfix. Der Browser akzeptiert es
 *      dann nur mit Secure + Path=/ und OHNE Domain-Attribut — eine
 *      Geschwister-Subdomain kann kein gleichnamiges Cookie unterschieben.
 *   2. Falls doch zwei gleichnamige Cookies ankommen, gewinnt das gültige.
 *      Wer nur den ersten Treffer liest, lässt sich durch ein untergeschobenes
 *      Cookie dauerhaft aussperren (kein Bypass — die Signatur schlägt fehl —,
 *      aber ein persistenter DoS gegen andere Kunden derselben Domain).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cookieName,
  readCookieTokens,
  MAX_SESSION_COOKIES,
  issueCookie,
  checkCookie,
  hashPassword,
  type AuthConfig,
} from "./auth.ts";
import { handleEditorRequest, type HostCtx } from "./host.ts";

const TEST_SECRET = "test-secret-aaaaaaaaaaaaaaaaaaaa";
const TEST_PASSWORD = "geheim123";
const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");

/** Ruft eine auth.ts-Funktion in einem frischen Prozess mit gesetztem Env auf. */
function inSubprocess(insecure: string | null, expr: string): string {
  const authPath = join(import.meta.dir, "auth.ts");
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (insecure === null) delete env.EDITOR_INSECURE_COOKIE;
  else env.EDITOR_INSECURE_COOKIE = insecure;
  const script = `import * as a from ${JSON.stringify(authPath)}; process.stdout.write(String(${expr}));`;
  const res = Bun.spawnSync({ cmd: [process.execPath, "-e", script], env });
  if (res.exitCode !== 0) throw new Error(new TextDecoder().decode(res.stderr));
  return new TextDecoder().decode(res.stdout);
}

describe("auth.ts — __Host--Cookie-Präfix", () => {
  test("mit Secure (Prod): Name trägt __Host--Präfix", () => {
    expect(inSubprocess(null, "a.cookieName()")).toBe("__Host-regoro_edit");
  });

  test("ohne Secure (lokales HTTP): nackter Name, sonst verwirft der Browser das Cookie", () => {
    expect(inSubprocess("1", "a.cookieName()")).toBe("regoro_edit");
  });

  test("Set-Cookie erfüllt die __Host--Bedingungen: Secure, Path=/, kein Domain", () => {
    const sc = inSubprocess(null, 'a.issueCookie({hash:"x",secret:"sub-secret-aaaaaaaaaaaa"})');
    expect(sc).toStartWith("__Host-regoro_edit=");
    expect(sc).toContain("Secure");
    expect(sc).toContain("Path=/");
    expect(sc).not.toContain("Domain=");
  });

  test("ohne Secure kein Präfix und kein Secure-Flag", () => {
    const sc = inSubprocess("1", 'a.issueCookie({hash:"x",secret:"sub-secret-aaaaaaaaaaaa"})');
    expect(sc).toStartWith("regoro_edit=");
    expect(sc).not.toContain("Secure");
  });
});

describe("auth.ts — readCookieTokens liest ALLE gleichnamigen Cookies", () => {
  const name = cookieName();

  test("leerer/fehlender Header → []", () => {
    expect(readCookieTokens(null)).toEqual([]);
    expect(readCookieTokens("")).toEqual([]);
  });

  test("ein Cookie → ein Token", () => {
    expect(readCookieTokens(`${name}=abc`)).toEqual(["abc"]);
  });

  test("zwei gleichnamige Cookies → beide, in Reihenfolge", () => {
    expect(readCookieTokens(`${name}=untergeschoben; ${name}=echt`)).toEqual([
      "untergeschoben",
      "echt",
    ]);
  });

  test("fremde Cookies werden ignoriert", () => {
    expect(readCookieTokens(`foo=1; ${name}=abc; bar=2`)).toEqual(["abc"]);
  });

  test("Token mit '=' im Wert bleibt intakt", () => {
    expect(readCookieTokens(`${name}=v1.123.sig==`)).toEqual(["v1.123.sig=="]);
  });

  test("mehr als MAX_SESSION_COOKIES Kandidaten werden gekappt", () => {
    // Ohne Grenze bestimmt der Angreifer, wie oft der Server HMAC rechnet:
    // ein 16-KB-Header fasst ~200 Kandidaten (~1,6 ms CPU pro Request).
    const header = Array.from({ length: 50 }, (_, i) => `${name}=t${i}`).join("; ");
    const tokens = readCookieTokens(header);

    expect(tokens).toHaveLength(MAX_SESSION_COOKIES);
    expect(tokens[0]).toBe("t0");
    expect(tokens.at(-1)).toBe(`t${MAX_SESSION_COOKIES - 1}`);
  });

  test("genau MAX_SESSION_COOKIES Kandidaten kommen vollständig durch", () => {
    const header = Array.from({ length: MAX_SESSION_COOKIES }, (_, i) => `${name}=t${i}`).join("; ");
    expect(readCookieTokens(header)).toHaveLength(MAX_SESSION_COOKIES);
  });
});

/**
 * Über einen nicht vertrauenswürdigen Origin (HTTP + kein localhost) verwirft der
 * Browser das Secure-Cookie STUMM: man meldet sich an und landet wieder auf der
 * Login-Seite. Empirisch in Chromium bestätigt. Die Login-Seite warnt deshalb vor,
 * statt den Nutzer raten zu lassen.
 */
describe("host.ts — Warnung vor unsicherem Origin auf der Login-Seite", () => {
  async function loginPage(host: string, headers: Record<string, string> = {}) {
    const auth: AuthConfig = { hash: await hashPassword(TEST_PASSWORD), secret: TEST_SECRET };
    const ctx: HostCtx = {
      repoRoot: REPO_ROOT,
      siteDir: REAL_SITE,
      pageWhitelist: ["index.html"],
      auth,
    };
    const url = new URL(`http://${host}/edit/login`);
    const req = new Request(url, { headers });
    const res = await handleEditorRequest(req, url, ctx);
    return res.text();
  }

  test("localhost: keine Warnung — Browser akzeptiert Secure-Cookies dort", async () => {
    expect(await loginPage("localhost:8788")).not.toContain("Anmeldung wird fehlschlagen");
  });

  test("127.0.0.1: ebenfalls keine Warnung", async () => {
    expect(await loginPage("127.0.0.1:8788")).not.toContain("Anmeldung wird fehlschlagen");
  });

  test("fremder Hostname über HTTP: Warnung samt Auswegen", async () => {
    const html = await loginPage("kunde.test:8788");
    expect(html).toContain("Anmeldung wird fehlschlagen");
    expect(html).toContain("EDITOR_INSECURE_COOKIE=1");
    expect(html).toContain("HTTPS");
  });

  test("hinter TLS-Proxy (X-Forwarded-Proto: https): keine Warnung", async () => {
    const html = await loginPage("kunde.de", { "x-forwarded-proto": "https" });
    expect(html).not.toContain("Anmeldung wird fehlschlagen");
  });

  // Der Host landet im HTML. `new URL()` lässt zwar kein `<` im Hostnamen zu, der
  // Wert läuft trotzdem durch escapeAttr — hier festgenagelt, damit das so bleibt.
  test("der Host erscheint in der Warnung und läuft durch escapeAttr", async () => {
    const html = await loginPage("kunde.test:8788");
    expect(html).toContain("http://kunde.test:8788");
    expect(html).not.toContain("<script");
  });
});

describe("host.ts — untergeschobenes Cookie sperrt die echte Session nicht aus", () => {
  let auth: AuthConfig;
  let ctx: HostCtx;

  async function setup() {
    auth = { hash: await hashPassword(TEST_PASSWORD), secret: TEST_SECRET };
    ctx = {
      repoRoot: REPO_ROOT,
      siteDir: REAL_SITE,
      pageWhitelist: ["index.html"],
      auth,
    };
  }

  /** Gültiger Token für unsere Site. */
  function validToken(): string {
    return issueCookie(auth).split(";")[0]!.split("=").slice(1).join("=");
  }

  function get(path: string, cookieHeader: string): Promise<Response> {
    const url = new URL("http://localhost:8788" + path);
    return Promise.resolve(
      handleEditorRequest(new Request(url, { headers: { cookie: cookieHeader } }), url, ctx),
    );
  }

  test("Cookie-Tossing: fremdes Cookie ZUERST, echtes danach → weiterhin eingeloggt", async () => {
    await setup();
    const name = cookieName();
    // So sähe es aus, wenn eine Geschwister-Subdomain ein Domain-Cookie gesetzt hat:
    // der Browser sendet beide, das untergeschobene kann zuerst kommen.
    const header = `${name}=v1.9999999999999.gefaelscht; ${name}=${validToken()}`;

    const res = await get("/edit", header);
    expect(res.status).toBe(200); // NICHT 302 auf den Login
  });

  test("echtes Cookie zuerst, fremdes danach → ebenfalls eingeloggt", async () => {
    await setup();
    const name = cookieName();
    const header = `${name}=${validToken()}; ${name}=v1.9999999999999.gefaelscht`;

    expect((await get("/edit", header)).status).toBe(200);
  });

  test("nur fremde Cookies → nicht eingeloggt (302 auf Login)", async () => {
    await setup();
    const name = cookieName();
    const header = `${name}=v1.9999999999999.gefaelscht; ${name}=voellig-kaputt`;

    expect((await get("/edit", header)).status).toBe(302);
  });

  test("ein Token mit fremdem Secret wird abgelehnt (kein Bypass durch Tossing)", async () => {
    await setup();
    const fremd: AuthConfig = { hash: auth.hash, secret: "ein-voellig-anderes-secret-xxxx" };
    const fremdToken = issueCookie(fremd).split(";")[0]!.split("=").slice(1).join("=");
    expect(checkCookie(auth, fremdToken)).toBe(false);

    const header = `${cookieName()}=${fremdToken}`;
    expect((await get("/edit", header)).status).toBe(302);
  });
});
