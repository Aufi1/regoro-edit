/**
 * Versand der Einmalcodes — SMS über seven.io, E-Mail über Scaleway.
 *
 * Die Konfiguration liegt **betreiberseitig**, nicht je Website:
 * `/etc/regoro/versand.json`, Mode 0600. Ein Absender für alle Kunden heißt eine
 * Konfiguration für alle. Der Schlüssel gehört nie in einen Kundenordner — dort
 * stünde er in einem Verzeichnis, das der Editor selbst beschreibt.
 *
 * Jeder Anbieter ist eine Ausprägung derselben Schnittstelle. Ein dritter Kanal
 * (WhatsApp) wäre eine weitere Ausprägung, kein Umbau.
 */
import { readFileSync } from "node:fs";
import type { Kanal, Kennung } from "./kennung.ts";

/**
 * Harte Zeitgrenze für einen Aufruf beim Dienst. `fetch` wartet von sich aus
 * unbegrenzt — und ein Kunde, der auf einen Code wartet, der nie kommt, ruft an.
 * Lieber nach zehn Sekunden eine klare Fehlermeldung.
 */
export const VERSAND_TIMEOUT_MS = 10_000;

/** seven.io lehnt längere Absenderkennungen mit Statuscode 201 ab. */
export const MAX_ABSENDER_LAENGE = 11;

export const VERSAND_CONFIG_PFAD = "/etc/regoro/versand.json";

/**
 * Der tatsächlich benutzte Pfad. `REGORO_VERSAND_CONFIG` gibt es für lokales
 * Ausprobieren — in Produktion liegt die Datei dort, wo sie hingehört, und
 * gehört root (Mode 0600).
 */
export function versandConfigPfad(): string {
  return process.env.REGORO_VERSAND_CONFIG || VERSAND_CONFIG_PFAD;
}

export interface Versand {
  /** Wirft mit sprechender Meldung, wenn der Code nicht rausging. */
  sendeCode(kennung: Kennung, code: string): Promise<void>;
  /**
   * Welche Kanäle eingerichtet sind. Fehlt die Angabe, gilt jeder als möglich
   * (Attrappen in Tests). Die Anmeldeseite fragt das, BEVOR sie prüft, ob eine
   * Kennung hinterlegt ist — sonst wäre die Antwort „Kanal nicht eingerichtet"
   * ein Orakel darüber, wer Kunde ist.
   */
  readonly kanaele?: ReadonlySet<Kanal>;
}

// ===========================================================================
// Attrappe — für Tests und lokales Ausprobieren
// ===========================================================================

export interface Attrappe extends Versand {
  /** Was gesendet worden wäre, in der Reihenfolge des Sendens. */
  readonly gesendet: { kennung: Kennung; code: string }[];
}

/**
 * Sendet nichts, merkt sich alles. In der Suite die einzige zugelassene
 * Ausprägung; im Betrieb nur zum Ausprobieren, und dann laut angekündigt
 * (siehe `ladeVersand`) — sie schreibt den Code im Klartext ins Terminal.
 */
export function attrappenVersand(schreibeIntoLog = false): Attrappe {
  const gesendet: { kennung: Kennung; code: string }[] = [];
  return {
    gesendet,
    async sendeCode(kennung, code) {
      gesendet.push({ kennung, code });
      if (schreibeIntoLog) {
        console.log(`[regoro] ATTRAPPE — Code für ${kennung.wert}: ${code}`);
      }
    },
  };
}

// ===========================================================================
// SMS: seven.io
// ===========================================================================

export interface SmsKonfig {
  anbieter: "sevenio";
  apiKey?: string;
  absender: string;
}

/** Die dokumentierten Statuscodes, übersetzt in etwas, das ein Mensch lesen kann. */
const SEVENIO_FEHLER: Record<string, string> = {
  "101": "Zustellung an den Empfänger fehlgeschlagen",
  "201": `Absenderkennung ungültig (höchstens ${MAX_ABSENDER_LAENGE} Zeichen)`,
  "202": "Empfängernummer ungültig",
  "300": "Absender nicht freigeschaltet",
  "400": "Nachricht konnte nicht zugestellt werden",
  "500": "Guthaben für den SMS-Versand aufgebraucht",
  "600": "Fehler beim Senden",
  "900": "Zugangsdaten für den SMS-Versand sind ungültig",
  "902": "Dem Zugang fehlen die Rechte zum Senden",
  "903": "Die IP dieses Servers ist beim SMS-Anbieter nicht freigegeben",
};

export function sevenioVersand(konfig: SmsKonfig, basis = "https://gateway.seven.io/api"): Versand {
  return {
    async sendeCode(kennung, code) {
      const koerper = new URLSearchParams({
        to: kennung.wert,
        from: konfig.absender,
        text: nachrichtentext(code),
      });
      const kopf: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      };
      // Ohne Schlüssel in der Konfiguration: auf einen Proxy setzen, der ihn
      // einsetzt (Agent Vault auf der Entwicklungsmaschine). Ein Platzhalter
      // wäre schlimmer als nichts — er sähe im Diff aus wie ein Geheimnis.
      if (konfig.apiKey) kopf["X-Api-Key"] = konfig.apiKey;

      const antwort = await ruf("SMS-Versand", `${basis}/sms`, {
        method: "POST",
        headers: kopf,
        body: koerper,
      });

      // Mit `Accept: application/json` ein Objekt, ohne Header eine nackte Zahl.
      // Beide Formen auswerten: `900` sieht sonst aus wie ein Erfolg.
      const erfolg =
        typeof antwort === "object" && antwort !== null
          ? String((antwort as { success?: unknown }).success ?? "")
          : String(antwort).trim();
      if (erfolg !== "100") {
        throw new Error(
          `SMS-Versand fehlgeschlagen: ${SEVENIO_FEHLER[erfolg] ?? `Statuscode ${nurCode(erfolg)}`}`,
        );
      }
    },
  };
}

// ===========================================================================
// E-Mail: Scaleway Transactional Email
// ===========================================================================

export interface EmailKonfig {
  anbieter: "scaleway";
  apiKey?: string;
  projektId: string;
  absenderMail: string;
  absenderName: string;
  region: string;
}

export function scalewayVersand(konfig: EmailKonfig, basisRoh?: string): Versand {
  const basis =
    basisRoh ?? `https://api.scaleway.com/transactional-email/v1alpha1/regions/${konfig.region}`;
  return {
    async sendeCode(kennung, code) {
      const kopf: Record<string, string> = { "Content-Type": "application/json" };
      if (konfig.apiKey) kopf["X-Auth-Token"] = konfig.apiKey;

      const antwort = await ruf("E-Mail-Versand", `${basis}/emails`, {
        method: "POST",
        headers: kopf,
        body: JSON.stringify({
          from: { email: konfig.absenderMail, name: konfig.absenderName },
          to: [{ email: kennung.wert }],
          subject: `Ihr Anmeldecode: ${code}`,
          text: nachrichtentext(code),
          project_id: konfig.projektId,
        }),
      });

      const mail = (antwort as { emails?: { id?: string }[] } | null)?.emails?.[0];
      if (!mail?.id) {
        throw new Error("E-Mail-Versand fehlgeschlagen: der Dienst hat die Nachricht nicht angenommen");
      }
    },
  };
}

// ===========================================================================
// Gemeinsames
// ===========================================================================

/**
 * Der Text, den der Kunde bekommt. Bewusst kurz, ohne Link und ohne Anrede:
 * Ein Link in einer Anmeldenachricht erzieht dazu, auf Links in Anmelde-
 * nachrichten zu klicken — und genau das tun Phishing-Mails.
 */
function nachrichtentext(code: string): string {
  return `Ihr Anmeldecode für den Website-Editor: ${code}\n\nEr gilt 5 Minuten. Wenn Sie sich nicht anmelden wollten, ignorieren Sie diese Nachricht.`;
}

/**
 * Ein Statuscode des Anbieters, so weit gekürzt, dass er ein Statuscode bleiben
 * kann und nichts anderes: höchstens zwölf Zeichen, nur Buchstaben und Ziffern.
 *
 * Ohne diese Klammer stünde bei einer unerwarteten Antwort deren **ganzer Rumpf**
 * in der Meldung — siehe die Begründung an `ruf()`.
 */
function nurCode(roh: string): string {
  const geputzt = roh.replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return geputzt || "unbekannt";
}

async function ruf(was: string, url: string, init: RequestInit): Promise<unknown> {
  let antwort: Response;
  try {
    antwort = await fetch(url, { ...init, signal: AbortSignal.timeout(VERSAND_TIMEOUT_MS) });
  } catch (err) {
    const abbruch = err instanceof Error && err.name === "TimeoutError";
    throw new Error(
      abbruch
        ? `${was} fehlgeschlagen: keine Antwort binnen ${VERSAND_TIMEOUT_MS / 1000} Sekunden`
        : `${was} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const roh = await antwort.text();
  if (!antwort.ok) {
    // **Nur der Status, nie der Rumpf.** Diese Meldung landet im Betreiber-Log,
    // und der Rumpf gehört dem Anbieter: Eine 4xx-Antwort spiegelt gern die
    // gesendete Anfrage zurück — und die enthält den EINMALCODE und den
    // Empfänger. Ein Filter über Steuerzeichen genügt dafür nicht; er verhindert
    // gefälschte Log-Zeilen, aber nicht, dass der Code im Log steht. Und
    // "der Code darf nirgends ins Log" ist eine Invariante ohne Ausnahme
    // (CLAUDE.md, Invariante 2). Wer die volle Antwort braucht, findet sie im
    // Dashboard des Anbieters — dort steht sie ohnehin.
    throw new Error(`${was} fehlgeschlagen: HTTP ${antwort.status}`);
  }
  try {
    return JSON.parse(roh);
  } catch {
    return roh; // seven.io antwortet ohne Accept-Header mit einer nackten Zahl
  }
}

/** Wählt nach Kanal aus. Ein nicht eingerichteter Kanal wirft, statt still zu schlucken. */
export function kombinierterVersand(teile: Partial<Record<Kanal, Versand>>): Versand {
  return {
    kanaele: new Set(Object.keys(teile) as Kanal[]),
    async sendeCode(kennung, code) {
      const teil = teile[kennung.kanal];
      if (teil === undefined) {
        throw new Error(
          kennung.kanal === "sms"
            ? "Für diese Website ist kein SMS-Versand eingerichtet (siehe /etc/regoro/versand.json)"
            : "Für diese Website ist kein E-Mail-Versand eingerichtet (siehe /etc/regoro/versand.json)",
        );
      }
      await teil.sendeCode(kennung, code);
    },
  };
}

export interface VersandKonfig {
  v: 2;
  sms?: SmsKonfig | { anbieter: "attrappe" };
  email?: EmailKonfig | { anbieter: "attrappe" };
}

/**
 * Liest und prüft `/etc/regoro/versand.json`. Fehlt die Datei, gibt es keinen
 * Versand — dann kommt niemand hinein, und das ist die richtige Antwort auf eine
 * halbe Einrichtung. Wirft mit Namen der fehlenden Felder.
 */
export function ladeVersandKonfig(pfad: string = versandConfigPfad()): VersandKonfig | null {
  let roh: string;
  try {
    roh = readFileSync(pfad, "utf8");
  } catch {
    return null;
  }
  let daten: unknown;
  try {
    daten = JSON.parse(roh);
  } catch {
    throw new Error(`${pfad} ist kein gültiges JSON`);
  }
  if (typeof daten !== "object" || daten === null) throw new Error(`${pfad}: erwartet wird ein Objekt`);
  const konfig = daten as Record<string, unknown>;
  if (konfig.v !== 2) throw new Error(`${pfad}: erwartet wird "v": 2`);

  const sms = pruefeSms(pfad, konfig.sms);
  const email = pruefeEmail(pfad, konfig.email);
  if (sms === undefined && email === undefined) {
    throw new Error(`${pfad}: weder "sms" noch "email" eingerichtet — so kommt niemand hinein`);
  }
  return { v: 2, sms, email };
}

function pruefeSms(pfad: string, roh: unknown): VersandKonfig["sms"] {
  if (roh === undefined || roh === null) return undefined;
  const o = roh as Record<string, unknown>;
  if (o.anbieter === "attrappe") return { anbieter: "attrappe" };
  if (o.anbieter !== "sevenio") throw new Error(`${pfad}: sms.anbieter muss "sevenio" oder "attrappe" sein`);
  const absender = typeof o.absender === "string" ? o.absender : "";
  if (!absender) throw new Error(`${pfad}: sms.absender fehlt`);
  // Früh prüfen: sonst fällt es erst beim ersten Kunden auf, als Statuscode 201.
  if (absender.length > MAX_ABSENDER_LAENGE) {
    throw new Error(
      `${pfad}: sms.absender "${absender}" hat ${absender.length} Zeichen, erlaubt sind ${MAX_ABSENDER_LAENGE}`,
    );
  }
  if (!/^[A-Za-z0-9]+$/.test(absender)) {
    throw new Error(`${pfad}: sms.absender darf nur Buchstaben und Ziffern enthalten`);
  }
  return {
    anbieter: "sevenio",
    absender,
    apiKey: typeof o.apiKey === "string" && o.apiKey ? o.apiKey : undefined,
  };
}

function pruefeEmail(pfad: string, roh: unknown): VersandKonfig["email"] {
  if (roh === undefined || roh === null) return undefined;
  const o = roh as Record<string, unknown>;
  if (o.anbieter === "attrappe") return { anbieter: "attrappe" };
  if (o.anbieter !== "scaleway") throw new Error(`${pfad}: email.anbieter muss "scaleway" oder "attrappe" sein`);
  const fehlt: string[] = [];
  const projektId = typeof o.projektId === "string" ? o.projektId : "";
  const absenderMail = typeof o.absenderMail === "string" ? o.absenderMail : "";
  if (!projektId) fehlt.push("email.projektId");
  if (!absenderMail) fehlt.push("email.absenderMail");
  if (fehlt.length) throw new Error(`${pfad}: es fehlt ${fehlt.join(", ")}`);
  return {
    anbieter: "scaleway",
    projektId,
    absenderMail,
    absenderName: typeof o.absenderName === "string" && o.absenderName ? o.absenderName : "Website-Editor",
    region: typeof o.region === "string" && o.region ? o.region : "fr-par",
    apiKey: typeof o.apiKey === "string" && o.apiKey ? o.apiKey : undefined,
  };
}

/** Baut aus der Konfiguration den Versand. null = nichts eingerichtet. */
export function ladeVersand(pfad: string = versandConfigPfad()): Versand | null {
  const konfig = ladeVersandKonfig(pfad);
  if (konfig === null) return null;
  const teile: Partial<Record<Kanal, Versand>> = {};
  if (konfig.sms) {
    teile.sms =
      konfig.sms.anbieter === "attrappe" ? attrappe("SMS") : sevenioVersand(konfig.sms as SmsKonfig);
  }
  if (konfig.email) {
    teile.email =
      konfig.email.anbieter === "attrappe"
        ? attrappe("E-Mail")
        : scalewayVersand(konfig.email as EmailKonfig);
  }
  return kombinierterVersand(teile);
}

function attrappe(was: string): Versand {
  console.warn(
    `[regoro] ACHTUNG: ${was}-Versand ist eine ATTRAPPE. Es geht nichts raus, und die Codes ` +
      "stehen im Klartext im Terminal. Nur zum Ausprobieren, niemals in Produktion.",
  );
  return attrappenVersand(true);
}
