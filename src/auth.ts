/**
 * Contract B — Host: signierte Session ohne DB, datei-basierte Auth.
 *
 * Auth-Konfig liegt in <siteDir>/.regoro/auth.json: die hinterlegten
 * Kontaktwege (Telefonnummern und E-Mail-Adressen) plus das HMAC-Secret der
 * Website. Token = `v1.<exp>.<hmac>`. Kein Server-State: Signatur + Ablauf
 * werden timing-safe geprüft.
 *
 * **Es gibt kein Passwort mehr.** Der Nachweis ist ein Einmalcode an einen
 * hinterlegten Kontaktweg (`codes.ts`, `versand.ts`). Damit entfällt auch
 * argon2id — und mit ihm ein Überlastungshebel: Jeder Anmeldeversuch kostete
 * rund 64 MB Arbeitsspeicher, ungebremst und von außen auslösbar.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const COOKIE_BASE = "regoro_edit";
/**
 * 30 Tage. Der Normalfall soll „gar keine Nachricht" sein: Ein Betrieb, der
 * seine Seite viermal im Jahr anfasst, bekommt sonst jedes Mal eine SMS, die
 * Geld kostet und Zeit. Der Ausgleich dafür ist, dass der Betreiber eine
 * Sitzung sofort beenden kann, indem er das Secret erneuert (`init --force`).
 */
const DEFAULT_MAX_AGE_SEC = 60 * 60 * 24 * 30;

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
  /** Hinterlegte Telefonnummern, normalisiert (E.164). */
  nummern: string[];
  /** Hinterlegte E-Mail-Adressen, normalisiert (kleingeschrieben). */
  emails: string[];
  secret: string;
}

/** Alle hinterlegten Kontaktwege einer Website, in einer Liste. */
export function alleKennungen(auth: AuthConfig): string[] {
  return [...auth.nummern, ...auth.emails];
}

/**
 * Ist dieser Kontaktweg für diese Website hinterlegt?
 *
 * Konstantzeit-Vergleich gegen jeden Eintrag, ohne früh abzubrechen: Über die
 * Laufzeit soll nicht abzulesen sein, wie viele Kennungen hinterlegt sind oder
 * wie weit eine geratene übereinstimmt.
 */
export function kennungHinterlegt(auth: AuthConfig, wert: string): boolean {
  let treffer = false;
  for (const eintrag of alleKennungen(auth)) {
    if (safeEqual(eintrag, wert)) treffer = true;
  }
  return treffer;
}

export const MIN_SECRET_LEN = 16;
export const AUTH_DIR_NAME = ".regoro";

/** Pfad zur auth.json innerhalb von siteDir/.regoro. */
export function authFilePath(siteDir: string): string {
  return join(siteDir, AUTH_DIR_NAME, "auth.json");
}

/**
 * Konstantzeit-Vergleich zweier Strings (länge-tolerant durch Hash-Wrapping).
 * Exportiert, weil der Einmalcode denselben Vergleich braucht (`codes.ts`) —
 * ein `===` dort verriete über die Laufzeit, wie viele Stellen stimmen.
 */
export function safeEqual(a: string, b: string): boolean {
  // Über SHA-256 wrappen, damit timingSafeEqual gleichlange Buffer bekommt
  // (Längenunterschiede sollen nicht über die Laufzeit leaken).
  const ha = createHmac("sha256", "len").update(a).digest();
  const hb = createHmac("sha256", "len").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Was in <siteDir>/.regoro/auth.json steht — unterschieden, damit der Betreiber
 * beim Start eine brauchbare Meldung bekommt. Der Anfrage-Pfad braucht das
 * nicht und benutzt `loadAuthFile`.
 */
export type AuthBefund =
  | { art: "ok"; auth: AuthConfig }
  | { art: "fehlt" }
  /** Altes Passwort-Format (v1). Wird NICHT stillschweigend weiterbetrieben. */
  | { art: "veraltet" }
  | { art: "ungueltig"; grund: string };

/**
 * Liest + prüft die Auth-Datei. Fail-closed: Alles, was nicht eindeutig gültig
 * ist, sperrt den Editor.
 *
 * Eine `v: 1`-Datei (Passwort-Hash) wird abgelehnt statt migriert. Zwei
 * parallele Anmeldeverfahren wären teurer als ein sauberer Schnitt, und der
 * Weg heraus ist ein Befehl: `regoro kennung <site> --add <nummer-oder-mail>`.
 */
export function pruefeAuthDatei(siteDir: string): AuthBefund {
  let raw: string;
  try {
    raw = readFileSync(authFilePath(siteDir), "utf8");
  } catch {
    return { art: "fehlt" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { art: "ungueltig", grund: "kein gültiges JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { art: "ungueltig", grund: "erwartet wird ein Objekt" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v === 1 || typeof obj.hash === "string") return { art: "veraltet" };
  if (obj.v !== 2) return { art: "ungueltig", grund: 'erwartet wird "v": 2' };

  const nummern = stringListe(obj.nummern);
  const emails = stringListe(obj.emails);
  if (nummern === null || emails === null) {
    return { art: "ungueltig", grund: "nummern/emails müssen Listen von Zeichenketten sein" };
  }
  // Leere Liste heißt NICHT „jeder darf", sondern „niemand kommt hinein".
  if (nummern.length + emails.length === 0) {
    return { art: "ungueltig", grund: "kein Kontaktweg hinterlegt" };
  }
  const { secret } = obj;
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LEN) {
    return { art: "ungueltig", grund: "secret fehlt oder ist zu kurz" };
  }
  return { art: "ok", auth: { nummern, emails, secret } };
}

function stringListe(roh: unknown): string[] | null {
  if (roh === undefined) return [];
  if (!Array.isArray(roh)) return null;
  if (!roh.every((e) => typeof e === "string" && e.length > 0)) return null;
  return roh as string[];
}

/** Die Auth-Konfig, oder null bei fehlend/ungültig/veraltet. */
export function loadAuthFile(siteDir: string): AuthConfig | null {
  const befund = pruefeAuthDatei(siteDir);
  return befund.art === "ok" ? befund.auth : null;
}

/**
 * Erzeugt <siteDir>/.regoro/auth.json mit den hinterlegten Kontaktwegen und
 * einem frischen 32-Byte-Secret. Dir-Mode 0700, Datei-Mode 0600. Hängt
 * ".regoro/" idempotent an siteDir/.gitignore. KEIN git-init.
 *
 * Überschreibt eine bestehende Datei kommentarlos — deshalb guardet `cmdInit`
 * dagegen und verlangt `--force`. Ein neues Secret beendet alle laufenden
 * Sitzungen; genau das ist der Weg, jemanden sofort auszusperren.
 */
export async function createAuthFile(
  siteDir: string,
  kennungen: string[],
): Promise<{ path: string; secret: string }> {
  const nummern = kennungen.filter((k) => !k.includes("@"));
  const emails = kennungen.filter((k) => k.includes("@"));
  if (nummern.length + emails.length === 0) {
    throw new Error("mindestens ein Kontaktweg (Telefonnummer oder E-Mail-Adresse) nötig");
  }
  const secret = randomBytes(32).toString("hex"); // 64 Hex-Zeichen

  const dir = join(siteDir, AUTH_DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const path = authFilePath(siteDir);
  const payload = {
    v: 2,
    nummern,
    emails,
    secret,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), { mode: 0o600 });

  appendGitignore(siteDir);

  return { path, secret };
}

/**
 * Schreibt die Kontaktwege einer bestehenden Website neu — **ohne** das Secret
 * anzufassen. Genau das unterscheidet `kennung --add/--remove` von `init
 * --force`: Eine hinzugefügte Nummer soll nicht alle laufenden Sitzungen beenden.
 */
export function schreibeKennungen(siteDir: string, kennungen: string[]): void {
  const befund = pruefeAuthDatei(siteDir);
  if (befund.art !== "ok") {
    throw new Error("keine gültige Auth-Datei vorhanden — zuerst `regoro init` ausführen");
  }
  if (kennungen.length === 0) {
    throw new Error("die letzte Kennung lässt sich nicht entfernen — nutze `regoro disable`");
  }
  const payload = {
    v: 2,
    nummern: kennungen.filter((k) => !k.includes("@")),
    emails: kennungen.filter((k) => k.includes("@")),
    secret: befund.auth.secret,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(authFilePath(siteDir), JSON.stringify(payload, null, 2), { mode: 0o600 });
}

/**
 * Hängt ".regoro/" idempotent an <siteDir>/.gitignore an (mit trailing newline).
 *
 * Exportiert, weil `regoro init` es aufrufen muss, BEVOR der Baseline-Commit
 * entsteht — und der Baseline-Commit entsteht, bevor auth.json geschrieben wird
 * (siehe cmdInit). Dadurch scheitert ein kaputtes git, ohne eine Auth-Datei zu
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
