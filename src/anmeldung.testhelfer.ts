/**
 * Nur für Tests: die zweistufige Anmeldung in einem Aufruf.
 *
 * Wird von keinem Produktivpfad importiert und landet deshalb nicht im Binary.
 * Der Code kommt aus der Versand-Attrappe — **kein Test spricht je mit einem
 * echten Anbieter.**
 */
import type { Attrappe } from "./versand.ts";

export interface AnmeldeOptionen {
  /** Host-Header, im Sammelbetrieb nötig. */
  host?: string;
  /** Reiter: "sms" (Vorgabe) oder "email". */
  weg?: "sms" | "email";
  /** Wohin nach der Anmeldung. Muss beide Stufen überleben. */
  returnTo?: string;
}

/** Führt beide Stufen durch und gibt den Cookie-Kopf zurück (`name=wert`). */
export async function meldeAn(
  base: string,
  kennung: string,
  attrappe: Attrappe,
  opts: AnmeldeOptionen = {},
): Promise<string> {
  const kopf: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (opts.host) kopf.Host = opts.host;
  const weg = opts.weg ?? "sms";

  const stufe1 = new URLSearchParams({ kennung, weg });
  if (opts.returnTo) stufe1.set("return", opts.returnTo);
  const antwort1 = await fetch(`${base}/edit/login`, {
    method: "POST",
    headers: kopf,
    body: stufe1.toString(),
    redirect: "manual",
  });
  if (antwort1.status !== 200) {
    throw new Error(`Stufe 1 lieferte ${antwort1.status} statt des Code-Formulars`);
  }

  const letzter = attrappe.gesendet.at(-1);
  if (letzter === undefined) throw new Error(`für ${kennung} wurde kein Code verschickt`);

  const stufe2 = new URLSearchParams({ kennung, weg, code: letzter.code });
  if (opts.returnTo) stufe2.set("return", opts.returnTo);
  const antwort2 = await fetch(`${base}/edit/login`, {
    method: "POST",
    headers: kopf,
    body: stufe2.toString(),
    redirect: "manual",
  });
  const setCookie = antwort2.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error(`Stufe 2 lieferte kein Cookie (Status ${antwort2.status})`);
  }
  return setCookie.split(";")[0]!;
}
