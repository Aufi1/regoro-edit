/**
 * Contract B — Host: signierte Session ohne DB, datei-basierte Auth.
 *
 * Auth-Konfig (Passwort-Hash + HMAC-Secret) liegt in <siteDir>/.regoro/auth.json.
 * Token = `v1.<exp>.<hmac>`. Kein Server-State: Signatur + Ablauf werden
 * timing-safe geprüft. Passwort via argon2id (Bun.password). KEINE Env-Auth mehr.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const COOKIE_BASE = "regoro_edit";
const DEFAULT_MAX_AGE_SEC = 60 * 60 * 8; // 8 Stunden

/** true = Cookie bekommt das Secure-Flag (Prod). Nur EDITOR_INSECURE_COOKIE=1 schaltet es ab. */
export function useSecureCookie(): boolean {
  return process.env.EDITOR_INSECURE_COOKIE !== "1";
}

/**
 * Akzeptiert der Browser hier ein `Secure`-Cookie?
 *
 * Nur „potentially trustworthy origins" (HTML-Spec): HTTPS, sowie localhost/
 * 127.0.0.1/[::1] auch über HTTP. Alles andere — LAN-IP, Hostname, kunde.test —
 * bekommt das Cookie zwar geschickt, aber der Browser verwirft es **stumm**:
 * der Nutzer landet nach dem Login wieder auf der Login-Seite, ohne Fehlermeldung.
 *
 * Empirisch geprüft (Chromium): `http://localhost` akzeptiert `__Host-`-Cookies,
 * `http://kunde.test` verwirft sie.
 *
 * `proto` kommt aus `X-Forwarded-Proto` (setzt jeder Reverse-Proxy), sonst aus
 * der Request-URL.
 */
export function isTrustworthyOrigin(hostname: string, proto: string): boolean {
  if (proto === "https") return true;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Cookie-Name. In Prod mit `__Host-`-Präfix.
 *
 * Grund: Läuft der Editor unter einer Subdomain (kunde.site.example.de), kann jede
 * Geschwister-Subdomain ein Cookie `regoro_edit=…; Domain=.site.example.de` setzen.
 * Der Browser sendet dann ZWEI gleichnamige Cookies, und der Server liest womöglich
 * das untergeschobene — die echte Session wird nie gültig, der Kunde ist dauerhaft
 * ausgesperrt (kein Auth-Bypass, die Signatur schlägt fehl; aber ein persistenter DoS,
 * den ein Kunde gegen alle anderen fahren kann).
 *
 * `__Host-` verbietet dem Browser genau das: Cookies mit diesem Präfix werden nur
 * akzeptiert, wenn sie `Secure` sind, `Path=/` haben und KEIN `Domain`-Attribut tragen.
 * Damit ist Cookie-Tossing zwischen Subdomains unmöglich.
 *
 * Ohne Secure (lokales HTTP-Dogfooding) würde der Browser das Präfix-Cookie verwerfen —
 * dort also der nackte Name.
 */
export function cookieName(): string {
  return useSecureCookie() ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;
}

export interface AuthConfig {
  hash: string;
  secret: string;
}

export const MIN_SECRET_LEN = 16;
export const AUTH_DIR_NAME = ".regoro";

/** Pfad zur auth.json innerhalb von siteDir/.regoro. */
export function authFilePath(siteDir: string): string {
  return join(siteDir, AUTH_DIR_NAME, "auth.json");
}

/** Konstantzeit-Vergleich zweier Strings (länge-tolerant durch Hash-Wrapping). */
function safeEqual(a: string, b: string): boolean {
  // Über SHA-256 wrappen, damit timingSafeEqual gleichlange Buffer bekommt
  // (Längenunterschiede sollen nicht über die Laufzeit leaken).
  const ha = createHmac("sha256", "len").update(a).digest();
  const hb = createHmac("sha256", "len").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Hasht ein Klartext-Passwort mit argon2id (für auth.json). */
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/**
 * Liest + validiert <siteDir>/.regoro/auth.json. null bei fehlend/ungültig.
 * Validierung: Objekt, hash String mit "$argon2"-Präfix, secret String ≥ MIN_SECRET_LEN.
 */
export function loadAuthFile(siteDir: string): AuthConfig | null {
  let raw: string;
  try {
    raw = readFileSync(authFilePath(siteDir), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const { hash, secret } = obj;
  if (typeof hash !== "string" || !hash.startsWith("$argon2")) return null;
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LEN) return null;
  return { hash, secret };
}

/**
 * Erzeugt <siteDir>/.regoro/auth.json mit argon2id-Hash + frischem 32-Byte-Secret.
 * Dir-Mode 0700, Datei-Mode 0600. Hängt ".regoro/" idempotent an siteDir/.gitignore.
 * Gibt { path, secret }. KEIN git-init.
 */
export async function createAuthFile(
  siteDir: string,
  password: string,
): Promise<{ path: string; secret: string }> {
  const hash = await hashPassword(password);
  const secret = randomBytes(32).toString("hex"); // 64 Hex-Zeichen

  const dir = join(siteDir, AUTH_DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const path = authFilePath(siteDir);
  const payload = {
    v: 1,
    hash,
    secret,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), { mode: 0o600 });

  appendGitignore(siteDir);

  return { path, secret };
}

/**
 * Hängt ".regoro/" idempotent an <siteDir>/.gitignore an (mit trailing newline).
 *
 * Exportiert, weil `regoro init` es aufrufen muss, BEVOR der Baseline-Commit
 * entsteht — und der Baseline-Commit entsteht, bevor auth.json geschrieben wird
 * (siehe cmdInit). Dadurch scheitert ein kaputtes git, ohne ein Passwort zu
 * hinterlassen, und das Secret kann gar nicht erst in den Commit geraten.
 */
export function ensureGitignore(siteDir: string): void {
  appendGitignore(siteDir);
}

function appendGitignore(siteDir: string): void {
  const gitignorePath = join(siteDir, ".gitignore");
  const entry = ".regoro/";
  let existing = "";
  try {
    existing = readFileSync(gitignorePath, "utf8");
  } catch {
    existing = "";
  }
  // Zeilen-genauer Check: ist die Ignore-Zeile bereits vorhanden?
  const lines = existing.split("\n").map((l) => l.trim());
  if (lines.includes(entry)) return;
  let next = existing;
  if (next.length > 0 && !next.endsWith("\n")) next += "\n";
  next += `${entry}\n`;
  writeFileSync(gitignorePath, next);
}

/** Prüft ein Klartext-Passwort gegen den argon2id-Hash der Auth-Konfig. */
export async function verifyPassword(
  auth: AuthConfig | null,
  candidate: string,
): Promise<boolean> {
  // Fail-closed: ohne Auth-Konfig/Hash oder ohne Kandidat NIE akzeptieren.
  if (!auth || !auth.hash) return false;
  if (!candidate) return false;
  try {
    return await Bun.password.verify(candidate, auth.hash);
  } catch {
    return false;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Erzeugt einen vollständigen Set-Cookie-Header-String mit signiertem Token. */
export function issueCookie(auth: AuthConfig, maxAgeSec: number = DEFAULT_MAX_AGE_SEC): string {
  const exp = Date.now() + maxAgeSec * 1000;
  const payload = `v1.${exp}`;
  const token = `${payload}.${sign(payload, auth.secret)}`;
  return [
    `${cookieName()}=${token}`,
    "HttpOnly",
    // Secure standardmäßig gesetzt (Prod hinter TLS-Proxy). Nur für lokales
    // HTTP-Dogfooding via EDITOR_INSECURE_COOKIE=1 weglassen — NIE in Produktion.
    // Hängt mit cookieName() zusammen: ohne Secure kein __Host--Präfix.
    ...(useSecureCookie() ? ["Secure"] : []),
    "SameSite=Strict",
    // Path=/ (nicht /edit): M3-Suffix-Edit-Views liegen unter /<page>.html/edit,
    // was ein Cookie mit Path=/edit per RFC6265-Path-Match NICHT abdeckt (kein
    // Präfix /edit) → Cookie würde dort nicht gesendet → Auth-Redirect-Schleife.
    // Das Cookie bleibt HMAC-signiert, HttpOnly, SameSite=Strict (+Secure in Prod)
    // und wird serverseitig nur auf den Edit-/API-Routen ausgewertet.
    "Path=/",
    `Max-Age=${maxAgeSec}`,
  ].join("; ");
}

/** Validiert ein Token: korrekte HMAC-Signatur UND nicht abgelaufen. Timing-safe. */
export function checkCookie(auth: AuthConfig | null, token: string): boolean {
  if (!token) return false;
  // Fail-closed: ohne Auth-Konfig/Secret NIE validieren (sonst kann jeder Tokens
  // selbst signieren → Auth-Bypass). Defense-in-depth.
  if (!auth || !auth.secret) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [v, expStr, sig] = parts as [string, string, string];
  const payload = `${v}.${expStr}`;
  const expected = sign(payload, auth.secret);
  // Signatur timing-safe prüfen.
  if (!safeEqual(sig, expected)) return false;
  // Ablauf prüfen.
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  return true;
}

/**
 * Obergrenze für gleichnamige Session-Cookies, die wir überhaupt prüfen.
 *
 * Legitim gibt es höchstens eines (`__Host-` verbietet dem Browser Duplikate).
 * Selbst ohne Präfix wären es die Host-Cookies plus je eines pro Ancestor-Domain,
 * also eine Handvoll. 8 wird im Normalbetrieb nie erreicht.
 *
 * Zweck: Ohne Grenze bestimmt der Angreifer, wie oft wir HMAC rechnen. Gemessen
 * kostet ein 16-KB-Header voller Kandidaten ~1,6 ms (202 × ~7,8 µs) — weniger als
 * ein /edit-Render, aber angreifergesteuerte, unbegrenzte Arbeit gehört begrenzt.
 */
const MAX_SESSION_COOKIES = 8;

/**
 * Liest die Token-Werte mit unserem Cookie-Namen aus einem Cookie-Header,
 * höchstens MAX_SESSION_COOKIES viele.
 *
 * Bewusst eine Liste, nicht der erste Treffer: Ein Header kann denselben Namen
 * mehrfach enthalten (Host-Cookie + untergeschobenes Domain-Cookie einer
 * Geschwister-Subdomain). Wer nur den ersten nimmt, lässt sich damit aussperren.
 * Der Aufrufer prüft jeden Kandidaten gegen checkCookie — nur einer muss stimmen,
 * und fälschen kann ihn ohne das Site-Secret niemand. `__Host-` (siehe cookieName)
 * verhindert den Fall bereits im Browser; das hier ist die zweite Verteidigungslinie.
 */
export function readCookieTokens(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  const wanted = cookieName();
  const out: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === wanted) {
      out.push(rest.join("="));
      if (out.length >= MAX_SESSION_COOKIES) break;
    }
  }
  return out;
}

export { MAX_SESSION_COOKIES };

export { COOKIE_BASE };
