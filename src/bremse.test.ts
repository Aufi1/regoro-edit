import { describe, expect, test, beforeEach } from "bun:test";
import {
  pruefeBremse,
  vergisseBremse,
  wartezeitText,
  MAX_PRO_KENNUNG,
  MAX_PRO_SITE,
  FENSTER_MS,
} from "./bremse.ts";

const SITE = "/srv/sites/kunde-a.de";
const A = "+4915120464812";
const B = "+4917000000000";
const T0 = 1_700_000_000_000;

beforeEach(() => vergisseBremse());

describe("Zaehler pro Kennung", () => {
  test("drei Codes gehen, der vierte nicht", () => {
    for (let i = 0; i < MAX_PRO_KENNUNG; i++) {
      expect(pruefeBremse(SITE, A, T0 + i).erlaubt).toBe(true);
    }
    const befund = pruefeBremse(SITE, A, T0 + 100);
    expect(befund.erlaubt).toBe(false);
    if (!befund.erlaubt) expect(befund.grund).toBe("kennung");
  });

  test("eine andere Kennung ist davon unberuehrt", () => {
    for (let i = 0; i < MAX_PRO_KENNUNG; i++) pruefeBremse(SITE, A, T0 + i);
    expect(pruefeBremse(SITE, B, T0 + 100).erlaubt).toBe(true);
  });

  test("nach einer Stunde ist wieder frei", () => {
    for (let i = 0; i < MAX_PRO_KENNUNG; i++) pruefeBremse(SITE, A, T0 + i);
    expect(pruefeBremse(SITE, A, T0 + FENSTER_MS - 1).erlaubt).toBe(false);
    expect(pruefeBremse(SITE, A, T0 + FENSTER_MS).erlaubt).toBe(true);
  });

  test("das Fenster gleitet, es faellt nicht als Block", () => {
    pruefeBremse(SITE, A, T0);
    pruefeBremse(SITE, A, T0 + 10 * 60_000);
    pruefeBremse(SITE, A, T0 + 20 * 60_000);
    // Gesperrt, solange der erste Eintrag im Fenster liegt.
    expect(pruefeBremse(SITE, A, T0 + 30 * 60_000).erlaubt).toBe(false);
    // Sobald er herausfaellt, ist genau ein Platz frei.
    expect(pruefeBremse(SITE, A, T0 + FENSTER_MS + 1).erlaubt).toBe(true);
    expect(pruefeBremse(SITE, A, T0 + FENSTER_MS + 2).erlaubt).toBe(false);
  });

  test("die Website-Bremse ist eine Flut-Sperre, kein Kostendeckel", () => {
    // Kosten entstehen nur fuer hinterlegte Kennungen, und die deckelt schon
    // MAX_PRO_KENNUNG. Der Website-Wert muss deshalb hoch genug sein, dass eine
    // Handvoll erfundener Nummern nicht die Anmeldung aller Kunden sperrt.
    expect(MAX_PRO_SITE).toBeGreaterThanOrEqual(MAX_PRO_KENNUNG * 10);
  });

  test("die genannte Wartezeit ist die bis zum Freiwerden", () => {
    for (let i = 0; i < MAX_PRO_KENNUNG; i++) pruefeBremse(SITE, A, T0);
    const befund = pruefeBremse(SITE, A, T0 + 10 * 60_000);
    expect(befund.erlaubt).toBe(false);
    if (!befund.erlaubt) expect(befund.wartenMs).toBe(FENSTER_MS - 10 * 60_000);
  });
});

describe("Zaehler pro Website", () => {
  test("MAX_PRO_SITE pro Stunde, danach ist zu — auch fuer eine frische Kennung", () => {
    let gesendet = 0;
    for (let i = 0; i < MAX_PRO_SITE * 2; i++) {
      // Jede Kennung darf nur drei, deshalb reihum durch viele Kennungen.
      if (pruefeBremse(SITE, `+4917000000${i.toString().padStart(3, "0")}`, T0 + i).erlaubt) {
        gesendet++;
      }
    }
    expect(gesendet).toBe(MAX_PRO_SITE);
    const befund = pruefeBremse(SITE, "+4915199999999", T0 + 100);
    expect(befund.erlaubt).toBe(false);
    if (!befund.erlaubt) expect(befund.grund).toBe("site");
  });

  test("eine andere Website ist unberuehrt", () => {
    for (let i = 0; i < MAX_PRO_SITE; i++) {
      pruefeBremse(SITE, `+4917000000${i.toString().padStart(3, "0")}`, T0 + i);
    }
    expect(pruefeBremse("/srv/sites/kunde-b.de", A, T0 + 100).erlaubt).toBe(true);
  });

  test("laenger als eine Stunde sperrt die Bremse nie", () => {
    for (let i = 0; i < MAX_PRO_SITE; i++) {
      pruefeBremse(SITE, `+4917000000${i.toString().padStart(3, "0")}`, T0);
    }
    const befund = pruefeBremse(SITE, A, T0);
    expect(befund.erlaubt).toBe(false);
    if (!befund.erlaubt) expect(befund.wartenMs).toBeLessThanOrEqual(FENSTER_MS);
  });
});

describe("E-Mail-Kennungen zaehlen genauso", () => {
  test("Adresse und Nummer sind getrennte Zaehler", () => {
    for (let i = 0; i < MAX_PRO_KENNUNG; i++) pruefeBremse(SITE, "max@example.de", T0 + i);
    expect(pruefeBremse(SITE, "max@example.de", T0 + 100).erlaubt).toBe(false);
    expect(pruefeBremse(SITE, A, T0 + 100).erlaubt).toBe(true);
  });
});

describe("wartezeitText", () => {
  test("rundet auf und nennt eine ganze Einheit", () => {
    expect(wartezeitText(1)).toBe("1 Minute");
    expect(wartezeitText(60_000)).toBe("1 Minute");
    expect(wartezeitText(3 * 60_000 + 1)).toBe("4 Minuten");
    expect(wartezeitText(FENSTER_MS)).toBe("1 Stunde");
    expect(wartezeitText(59 * 60_000)).toBe("59 Minuten");
  });
});
