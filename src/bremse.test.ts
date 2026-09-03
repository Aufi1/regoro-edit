import { describe, expect, test, beforeEach } from "bun:test";
import {
  pruefeBremse,
  entsperreKennung,
  vergisseBremse,
  wartezeitText,
  STUFEN_MS,
  VERGESSEN_MS,
  MAX_PRO_SITE,
  FENSTER_MS,
} from "./bremse.ts";

const SITE = "/srv/sites/kunde-a.de";
const A = "+4915120464812";
const B = "+4917000000000";
const T0 = 1_700_000_000_000;

beforeEach(() => vergisseBremse());

describe("Wartezeit je Kennung — sie waechst, sie sperrt nicht aus", () => {
  test("die erste Anfrage ist frei, die zweite braucht eine Minute", () => {
    expect(pruefeBremse(SITE, A, T0).erlaubt).toBe(true);
    // Sofort danach: gebremst, aber nur kurz.
    const gleich = pruefeBremse(SITE, A, T0 + 1);
    expect(gleich.erlaubt).toBe(false);
    if (!gleich.erlaubt) {
      expect(gleich.grund).toBe("kennung");
      expect(gleich.wartenMs).toBeLessThanOrEqual(STUFEN_MS[0]!);
    }
    expect(pruefeBremse(SITE, A, T0 + STUFEN_MS[0]!).erlaubt).toBe(true);
  });

  test("die Treppe: eine Minute, eine Minute, dann fuenf", () => {
    let t = T0;
    expect(pruefeBremse(SITE, A, t).erlaubt).toBe(true); // 1. frei
    t += STUFEN_MS[0]!;
    expect(pruefeBremse(SITE, A, t).erlaubt).toBe(true); // 2. nach 1 min
    t += STUFEN_MS[1]!;
    expect(pruefeBremse(SITE, A, t).erlaubt).toBe(true); // 3. nach 1 min
    // Jetzt gilt die dritte Stufe: kurz davor zu, genau darauf offen.
    expect(pruefeBremse(SITE, A, t + STUFEN_MS[2]! - 1).erlaubt).toBe(false);
    expect(pruefeBremse(SITE, A, t + STUFEN_MS[2]!).erlaubt).toBe(true);
  });

  test("die Treppe waechst nicht ins Unendliche — die letzte Stufe gilt weiter", () => {
    // Sonst waere sie doch wieder eine Aussperrung, nur mit Umweg.
    let t = T0;
    for (let i = 0; i < 8; i++) {
      expect(pruefeBremse(SITE, A, t).erlaubt).toBe(true);
      t += STUFEN_MS[STUFEN_MS.length - 1]!;
    }
  });

  test("NIE laenger als die groesste Stufe gesperrt", () => {
    // Der Kern der Aenderung: Wer sich vertippt, wartet Minuten statt einer
    // knappen Stunde. Genau daran ist die alte Fassung gescheitert.
    let t = T0;
    for (let i = 0; i < 10; i++) {
      const b = pruefeBremse(SITE, A, t);
      if (!b.erlaubt) expect(b.wartenMs).toBeLessThanOrEqual(STUFEN_MS[STUFEN_MS.length - 1]!);
      t += 1000;
    }
  });

  test("nach ERFOLGREICHER Anmeldung faengt die Treppe wieder unten an", () => {
    /**
     * Die Regel, um die es geht: Die Bremse begrenzt Kosten durch Anfragen von
     * jemandem, der sich NICHT anmelden kann. Wer gerade einen gueltigen Code
     * vorgelegt hat, ist genau der, fuer den sie nie gedacht war — er darf am
     * zweiten Geraet nicht warten muessen.
     */
    let t = T0;
    pruefeBremse(SITE, A, t);
    t += STUFEN_MS[0]!;
    pruefeBremse(SITE, A, t);
    t += STUFEN_MS[1]!;
    pruefeBremse(SITE, A, t); // jetzt auf der teuersten Stufe
    expect(pruefeBremse(SITE, A, t + 1).erlaubt).toBe(false);

    entsperreKennung(SITE, A);

    // Sofort frei — und die naechste Bremsung ist wieder die kleinste Stufe.
    expect(pruefeBremse(SITE, A, t + 2).erlaubt).toBe(true);
    const danach = pruefeBremse(SITE, A, t + 3);
    expect(danach.erlaubt).toBe(false);
    if (!danach.erlaubt) expect(danach.wartenMs).toBeLessThanOrEqual(STUFEN_MS[0]!);
  });

  test("Gegenprobe: das Entsperren wirkt nur auf DIESE Kennung", () => {
    // Ohne diesen Fall waere der Test darueber auch dann gruen, wenn
    // `entsperreKennung` schlicht alles loeschte.
    pruefeBremse(SITE, A, T0);
    pruefeBremse(SITE, B, T0);
    entsperreKennung(SITE, A);
    expect(pruefeBremse(SITE, A, T0 + 1).erlaubt).toBe(true);
    expect(pruefeBremse(SITE, B, T0 + 1).erlaubt).toBe(false);
  });

  test("Gegenprobe: das Entsperren ruehrt die Flut-Sperre der Website nicht an", () => {
    // Sie zaehlt ueber alle Kennungen und schuetzt vor vielen erfundenen
    // Adressen. Dass ein einzelner Kunde sich anmeldet, sagt darueber nichts.
    for (let i = 0; i < MAX_PRO_SITE; i++) {
      pruefeBremse(SITE, `+4917000000${i.toString().padStart(3, "0")}`, T0 + i);
    }
    entsperreKennung(SITE, A);
    const b = pruefeBremse(SITE, A, T0 + 1000);
    expect(b.erlaubt).toBe(false);
    if (!b.erlaubt) expect(b.grund).toBe("site");
  });

  test("lange Ruhe wirkt wie eine Anmeldung", () => {
    // Sonst bliebe ein Kunde, der uebers Jahr dreimal einen Code braucht,
    // dauerhaft auf der obersten Stufe, ohne je etwas Auffaelliges zu tun.
    let t = T0;
    for (let i = 0; i < 3; i++) {
      pruefeBremse(SITE, A, t);
      t += STUFEN_MS[Math.min(i, STUFEN_MS.length - 1)]!;
    }
    const spaeter = t + VERGESSEN_MS;
    expect(pruefeBremse(SITE, A, spaeter).erlaubt).toBe(true);
    const danach = pruefeBremse(SITE, A, spaeter + 1);
    expect(danach.erlaubt).toBe(false);
    if (!danach.erlaubt) expect(danach.wartenMs).toBeLessThanOrEqual(STUFEN_MS[0]!);
  });

  test("eine andere Kennung ist davon unberuehrt", () => {
    pruefeBremse(SITE, A, T0);
    expect(pruefeBremse(SITE, A, T0 + 1).erlaubt).toBe(false);
    expect(pruefeBremse(SITE, B, T0 + 1).erlaubt).toBe(true);
  });

  test("die Website-Bremse bleibt hoch genug fuer echten Betrieb", () => {
    // Sie trifft ALLE Nutzer der Website. Eine Handvoll erfundener Nummern darf
    // nicht die Anmeldung aller Kunden sperren.
    expect(MAX_PRO_SITE).toBeGreaterThanOrEqual(30);
  });
});

describe("Zaehler pro Website", () => {
  test("MAX_PRO_SITE pro Stunde, danach ist zu — auch fuer eine frische Kennung", () => {
    let gesendet = 0;
    for (let i = 0; i < MAX_PRO_SITE * 2; i++) {
      // Je Kennung ist nur die erste Anfrage sofort frei, deshalb reihum.
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
    // Der zweite Kontaktweg bleibt offen, wenn der erste gebremst ist — das ist
    // die Entschaerfung gegen einen gezielten Lockout ueber die Nummer aus dem
    // Impressum, und sie gilt unveraendert auch mit der wachsenden Wartezeit.
    pruefeBremse(SITE, "max@example.de", T0);
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
