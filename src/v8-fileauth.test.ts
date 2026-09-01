/**
 * v8 — Datei-basierte Auth (NEUER Contract, Env-Auth ENTFERNT).
 *
 * Testet die in editor/auth.ts + editor/host.ts fixierte API:
 *   - Hinterlegte Kontaktwege statt Passwort (kennungHinterlegt)
 *   - Auth-Datei <siteDir>/.regoro/auth.json (createAuthFile/loadAuthFile),
 *     Mode 0600, frisches Secret pro Aufruf, idempotenter .gitignore-Eintrag
 *   - Signiertes Session-Cookie (issueCookie/checkCookie), Secret-Isolation
 *   - Host fail-closed bei auth===null (alle /edit* → 404)
 *   - Host mit gültiger Auth (Login → Cookie → /edit 200)
 *   - Auth-Datei-Web-Block: .regoro/auth.json & .git/ NIE öffentlich (Secret-Leak)
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as auth from "./auth.ts";
import { attrappenVersand } from "./versand.ts";
import * as host from "./host.ts";

// Pfad zur echten site/ im Repo (Read-only Quelle für Fixtures).
const REPO_ROOT = join(import.meta.dir, "..");
const REAL_SITE = join(REPO_ROOT, "examples", "site");

// Sammelort für tmp-Dirs, am Ende aufgeräumt.
const tmpRoots: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
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

// Gemeinsame Test-Auth-Konfig (Secret ≥ MIN_SECRET_LEN).
const TEST_NUMMER = "+4915120464812";
const TEST_AUTH: auth.AuthConfig = {
  nummern: [TEST_NUMMER],
  emails: [],
  secret: "testsecret-aaaaaaaaaaaaaaaaaaaaaaaa",
};

// ===========================================================================
// 1. hashPassword / verifyPassword
// ===========================================================================
describe("auth — hinterlegte Kontaktwege", () => {
  test("kennungHinterlegt findet Nummern und Adressen", () => {
    const a: auth.AuthConfig = {
      nummern: ["+4915120464812"],
      emails: ["chef@firma.de"],
      secret: TEST_AUTH.secret,
    };
    expect(auth.kennungHinterlegt(a, "+4915120464812")).toBe(true);
    expect(auth.kennungHinterlegt(a, "chef@firma.de")).toBe(true);
    expect(auth.kennungHinterlegt(a, "+4917000000000")).toBe(false);
    expect(auth.kennungHinterlegt(a, "fremd@firma.de")).toBe(false);
    expect(auth.kennungHinterlegt(a, "")).toBe(false);
  });

  test("alleKennungen liefert beide Listen", () => {
    expect(
      auth.alleKennungen({ nummern: ["+491"], emails: ["a@b.de"], secret: "x" }),
    ).toEqual(["+491", "a@b.de"]);
  });
});

describe("auth — createAuthFile/loadAuthFile Roundtrip", () => {
  test("Datei existiert, Mode 0600, Secret ≥ 32 Hex, .gitignore-Eintrag", async () => {
    const dir = makeTmpDir("regoro-authfile-");
    const { path, secret } = await auth.createAuthFile(dir, ["+4915120464812"]);

    // Datei existiert am erwarteten Pfad.
    expect(path).toBe(auth.authFilePath(dir));
    expect(existsSync(path)).toBe(true);

    // Datei-Mode exakt 0600.
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // Secret ist ≥ 32 Hex-Zeichen.
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(/^[0-9a-f]+$/.test(secret)).toBe(true);

    // .gitignore enthält ".regoro/".
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gitignore.split("\n").map((l) => l.trim())).toContain(".regoro/");
  });

  test("zwei Aufrufe → verschiedene Secrets", async () => {
    const dirA = makeTmpDir("regoro-authfile-a-");
    const dirB = makeTmpDir("regoro-authfile-b-");
    const a = await auth.createAuthFile(dirA, ["+4915120464812"]);
    const b = await auth.createAuthFile(dirB, ["+4915120464812"]);
    expect(a.secret).not.toBe(b.secret);
  });

  test(".gitignore-Eintrag idempotent (nicht doppelt nach 2× init)", async () => {
    const dir = makeTmpDir("regoro-authfile-idem-");
    await auth.createAuthFile(dir, ["+4915120464812"]);
    await auth.createAuthFile(dir, ["+4915120464812"]);
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    const count = gitignore
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l === ".regoro/").length;
    expect(count).toBe(1);
  });

  test("loadAuthFile liefert die hinterlegten Kontaktwege zurueck", async () => {
    const dir = makeTmpDir("regoro-authfile-load-");
    const { secret } = await auth.createAuthFile(dir, ["+4915120464812"]);
    const loaded = auth.loadAuthFile(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.secret).toBe(secret);
    expect(loaded!.nummern).toEqual(["+4915120464812"]);
    expect(loaded!.emails).toEqual([]);
    expect(auth.kennungHinterlegt(loaded!, "+4915120464812")).toBe(true);
  });

  test("Nummern und Adressen werden getrennt abgelegt", async () => {
    const dir = makeTmpDir("regoro-authfile-beide-");
    await auth.createAuthFile(dir, ["+4915120464812", "chef@firma.de"]);
    const loaded = auth.loadAuthFile(dir)!;
    expect(loaded.nummern).toEqual(["+4915120464812"]);
    expect(loaded.emails).toEqual(["chef@firma.de"]);
  });

  test("ohne Kontaktweg wird gar nichts geschrieben", async () => {
    const dir = makeTmpDir("regoro-authfile-leer-");
    expect(auth.createAuthFile(dir, [])).rejects.toThrow("mindestens ein");
    expect(existsSync(auth.authFilePath(dir))).toBe(false);
  });

  test("schreibeKennungen laesst das Secret unangetastet", async () => {
    // Eine hinzugefuegte Nummer darf keine laufende Sitzung beenden.
    const dir = makeTmpDir("regoro-authfile-update-");
    const { secret } = await auth.createAuthFile(dir, ["+4915120464812"]);
    auth.schreibeKennungen(dir, ["+4915120464812", "chef@firma.de"]);
    const loaded = auth.loadAuthFile(dir)!;
    expect(loaded.secret).toBe(secret);
    expect(loaded.emails).toEqual(["chef@firma.de"]);
  });
});

// ===========================================================================
// 3. loadAuthFile fail-closed
// ===========================================================================
describe("auth — loadAuthFile fail-closed", () => {
  function writeAuthJson(content: string): string {
    const dir = makeTmpDir("regoro-failclosed-");
    const authPath = auth.authFilePath(dir);
    mkdirSync(join(dir, auth.AUTH_DIR_NAME), { recursive: true });
    writeFileSync(authPath, content);
    return dir;
  }

  test("fehlende Datei → null", () => {
    const dir = makeTmpDir("regoro-missing-");
    expect(auth.loadAuthFile(dir)).toBeNull();
  });

  test("kaputtes JSON → null", () => {
    const dir = writeAuthJson("{ not valid json ");
    expect(auth.loadAuthFile(dir)).toBeNull();
  });

  test("altes Passwort-Format (v1) wird abgelehnt und als veraltet gemeldet", () => {
    // Kein stillschweigender Weiterbetrieb mit Passwort: zwei parallele
    // Verfahren waeren teurer als ein sauberer Schnitt.
    const dir = writeAuthJson(
      JSON.stringify({ v: 1, hash: "$argon2id$abc", secret: "x".repeat(32) }),
    );
    expect(auth.loadAuthFile(dir)).toBeNull();
    expect(auth.pruefeAuthDatei(dir).art).toBe("veraltet");
  });

  test("secret zu kurz → null", () => {
    const dir = writeAuthJson(
      JSON.stringify({ v: 2, nummern: ["+491511234567"], secret: "tooshort" }),
    );
    expect(auth.loadAuthFile(dir)).toBeNull();
  });

  test("leere Kennungsliste heisst NICHT jeder darf", () => {
    const dir = writeAuthJson(
      JSON.stringify({ v: 2, nummern: [], emails: [], secret: "x".repeat(32) }),
    );
    expect(auth.loadAuthFile(dir)).toBeNull();
    const befund = auth.pruefeAuthDatei(dir);
    expect(befund.art).toBe("ungueltig");
  });

  test("Kennungen muessen Zeichenketten sein", () => {
    const dir = writeAuthJson(
      JSON.stringify({ v: 2, nummern: [42], secret: "x".repeat(32) }),
    );
    expect(auth.loadAuthFile(dir)).toBeNull();
  });

  test("fehlende Version → null", () => {
    const dir = writeAuthJson(
      JSON.stringify({ nummern: ["+491511234567"], secret: "x".repeat(32) }),
    );
    expect(auth.loadAuthFile(dir)).toBeNull();
  });
});

// ===========================================================================
// 4. Cookie — issueCookie / checkCookie (inkl. Secret-Isolation)
// ===========================================================================
describe("auth — issueCookie/checkCookie", () => {
  function tokenOf(setCookie: string): string {
    return setCookie.split(";")[0]!.split("=").slice(1).join("=");
  }

  test("issueCookie enthält HttpOnly/SameSite=Strict/Path=//Secure", () => {
    const sc = auth.issueCookie(TEST_AUTH);
    expect(sc).toContain("HttpOnly");
    expect(sc).toMatch(/SameSite=Strict/i);
    expect(sc).toContain("Path=/");
    expect(sc).toContain("Secure");
  });

  // Regression (E2E HIGH-Bug): Das Session-Cookie MUSS Path=/ tragen, NICHT
  // Path=/edit. Mit Path=/edit sendet der Browser das Cookie per RFC6265-Path-
  // Match NICHT an die neuen M3-Suffix-Edit-Views /<page>.html/edit (deren Pfad
  // nicht unter /edit liegt) → Login-Endlosschleife auf Unterseiten.
  // Der Unit-Test-Pfad reicht Cookies path-unabhängig durch und maskiert den Bug,
  // daher ist diese exakte Path=/-Assertion der eigentliche Pin.
  test("issueCookie: Path-Attribut ist exakt Path=/ (nicht Path=/edit)", () => {
    const sc = auth.issueCookie(TEST_AUTH);
    // Set-Cookie in Attribute zerlegen und das Path-Attribut exakt prüfen.
    const attrs = sc.split(";").map((a) => a.trim());
    const pathAttr = attrs.find((a) => a.toLowerCase().startsWith("path="));
    expect(pathAttr).toBe("Path=/");
    expect(sc).not.toContain("Path=/edit");
  });

  test("checkCookie akzeptiert eigenes Token", () => {
    const token = tokenOf(auth.issueCookie(TEST_AUTH));
    expect(auth.checkCookie(TEST_AUTH, token)).toBe(true);
  });

  test("abgelaufenes Token (negatives maxAge) → false", () => {
    const token = tokenOf(auth.issueCookie(TEST_AUTH, -10));
    expect(auth.checkCookie(TEST_AUTH, token)).toBe(false);
  });

  test("manipuliertes Token → false", () => {
    const token = tokenOf(auth.issueCookie(TEST_AUTH));
    expect(auth.checkCookie(TEST_AUTH, token + "x")).toBe(false);
    expect(auth.checkCookie(TEST_AUTH, "garbage")).toBe(false);
    expect(auth.checkCookie(TEST_AUTH, "")).toBe(false);
  });

  test("Secret-Isolation: Token mit Secret A gegen {secret:B} → false", () => {
    const authA: auth.AuthConfig = { ...TEST_AUTH, secret: "secret-A-aaaaaaaaaaaaaaaaaaaa" };
    const authB: auth.AuthConfig = { ...TEST_AUTH, secret: "secret-B-bbbbbbbbbbbbbbbbbbbb" };
    const token = tokenOf(auth.issueCookie(authA));
    expect(auth.checkCookie(authA, token)).toBe(true);
    expect(auth.checkCookie(authB, token)).toBe(false);
  });

  test("checkCookie(null, token) → false (fail-closed)", () => {
    const token = tokenOf(auth.issueCookie(TEST_AUTH));
    expect(auth.checkCookie(null, token)).toBe(false);
  });
});

// ===========================================================================
// Host-Integration: gemeinsame Fixture + call()-Helfer
// ===========================================================================
function makeSiteFixture(): { repoRoot: string; siteDir: string } {
  const repoRoot = makeTmpDir("regoro-v8-fixture-");
  const siteDir = join(repoRoot, "site");
  mkdirSync(siteDir, { recursive: true });
  cpSync(REAL_SITE, siteDir, { recursive: true });
  return { repoRoot, siteDir };
}

const PAGE_WHITELIST = ["index.html", "impressum.html", "datenschutz.html", "agb.html"];

function call(ctx: host.HostCtx, method: string, path: string, init?: RequestInit): Promise<Response> {
  const url = new URL("http://localhost:8788" + path);
  const req = new Request(url, { method, ...init });
  return Promise.resolve(host.handleEditorRequest(req, url, ctx));
}

function cookieFromSetCookie(res: Response): string | null {
  const sc = res.headers.get("set-cookie");
  if (!sc) return null;
  return sc.split(";")[0]!; // "regoro_edit=<token>"
}

// ===========================================================================
// 5. Host fail-closed: auth===null → alle /edit* → 404
// ===========================================================================
describe("host — fail-closed bei auth===null", () => {
  let ctx: host.HostCtx;

  beforeEach(() => {
    const fx = makeSiteFixture();
    ctx = { repoRoot: fx.repoRoot, siteDir: fx.siteDir, pageWhitelist: PAGE_WHITELIST, auth: null };
  });

  test("GET /edit/login → 404", async () => {
    const res = await call(ctx, "GET", "/edit/login");
    expect(res.status).toBe(404);
  });

  test("GET /edit → 404", async () => {
    const res = await call(ctx, "GET", "/edit");
    expect(res.status).toBe(404);
  });

  test("POST /edit/login → 404", async () => {
    const res = await call(ctx, "POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `kennung=${encodeURIComponent(TEST_NUMMER)}&weg=sms`,
    });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// 6. Host mit gültiger Auth: Login → Cookie → /edit 200
// ===========================================================================
describe("host — mit gültiger Auth", () => {
  let ctx: host.HostCtx;

  beforeEach(() => {
    const fx = makeSiteFixture();
    ctx = { repoRoot: fx.repoRoot, siteDir: fx.siteDir, pageWhitelist: PAGE_WHITELIST, auth: TEST_AUTH };
  });

  test("richtiger Code ergibt 302 + Set-Cookie", async () => {
    const versand = attrappenVersand();
    const mitVersand = { ...ctx, versand };
    const stufe1 = await call(mitVersand, "POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `kennung=${encodeURIComponent(TEST_NUMMER)}&weg=sms`,
    });
    expect(stufe1.status).toBe(200);
    const code = versand.gesendet.at(-1)!.code;

    const res = await call(mitVersand, "POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `kennung=${encodeURIComponent(TEST_NUMMER)}&weg=sms&code=${code}`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie") ?? "").toContain("regoro_edit=");
  });

  test("falscher Code ergibt 401 und kein Cookie", async () => {
    const versand = attrappenVersand();
    const mitVersand = { ...ctx, versand };
    await call(mitVersand, "POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `kennung=${encodeURIComponent(TEST_NUMMER)}&weg=sms`,
    });
    const res = await call(mitVersand, "POST", "/edit/login", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `kennung=${encodeURIComponent(TEST_NUMMER)}&weg=sms&code=000000`,
    });
    expect(res.status).toBe(401);
    expect(cookieFromSetCookie(res)).toBeNull();
  });

  test("GET /edit mit gültigem Cookie (issueCookie(TEST_AUTH)) → 200", async () => {
    // Namen NICHT hartkodieren: er trägt in Prod den __Host--Präfix (auth.cookieName()).
    const cookie = auth.issueCookie(TEST_AUTH).split(";")[0]!;
    const res = await call(ctx, "GET", "/edit", { headers: { cookie } });
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// 7. Auth-Datei-Web-Block (kritisch): das Secret darf NIE im Body landen
// ===========================================================================
describe("host — Auth-Datei-Web-Block (.regoro/auth.json, .git/)", () => {
  let ctx: host.HostCtx;
  let geheimnis: string;

  beforeEach(async () => {
    const fx = makeSiteFixture();
    // Echte .regoro/auth.json in der Fixture-Site anlegen.
    await auth.createAuthFile(fx.siteDir, ["+4915120464812"]);
    const loaded = auth.loadAuthFile(fx.siteDir)!;
    geheimnis = loaded.secret;
    // Auch eine .git/config-Fixture anlegen (Block-Test).
    mkdirSync(join(fx.siteDir, ".git"), { recursive: true });
    writeFileSync(join(fx.siteDir, ".git", "config"), "[core]\n  bare = false\n");
    ctx = { repoRoot: fx.repoRoot, siteDir: fx.siteDir, pageWhitelist: PAGE_WHITELIST, auth: loaded };
  });

  async function expectBlocked(path: string): Promise<void> {
    const res = await call(ctx, "GET", path);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain(geheimnis);
    expect(body).not.toContain(TEST_NUMMER);
  }

  test("GET /.regoro/auth.json → 404, Hash nicht im Body", async () => {
    await expectBlocked("/.regoro/auth.json");
  });

  test("GET /%2eregoro/auth.json (encoded dot) → 404", async () => {
    await expectBlocked("/%2eregoro/auth.json");
  });

  test("GET /.regoro%2Fauth.json (encoded slash) → 404", async () => {
    await expectBlocked("/.regoro%2Fauth.json");
  });

  test("GET /assets/../.regoro/auth.json (traversal) → 404", async () => {
    await expectBlocked("/assets/../.regoro/auth.json");
  });

  test("GET /.git/config → 404", async () => {
    const res = await call(ctx, "GET", "/.git/config");
    expect(res.status).toBe(404);
  });
});
