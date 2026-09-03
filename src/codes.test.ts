import { describe, expect, test, beforeEach } from "bun:test";
import {
  erzeugeCode,
  merkeCode,
  pruefeCode,
  vergisseAlleCodes,
  CODE_GUELTIG_MS,
  MAX_VERSUCHE,
} from "./codes.ts";

const SITE = "/srv/sites/kunde-a.de";
const NUMMER = "+4915120464812";
const T0 = 1_700_000_000_000;

beforeEach(() => vergisseAlleCodes());

describe("erzeugeCode", () => {
  test("immer sechsstellig, auch mit führenden Nullen", () => {
    for (let i = 0; i < 300; i++) expect(erzeugeCode()).toMatch(/^\d{6}$/);
  });

  test("streut über den Wertebereich (kein konstanter Code)", () => {
    const gesehen = new Set(Array.from({ length: 200 }, () => erzeugeCode()));
    expect(gesehen.size).toBeGreaterThan(150);
  });
});

describe("pruefeCode", () => {
  test("richtiger Code ergibt ok und ist danach verbraucht", () => {
    merkeCode(SITE, NUMMER, "123456", T0);
    expect(pruefeCode(SITE, NUMMER, "123456", T0 + 1000)).toBe("ok");
    expect(pruefeCode(SITE, NUMMER, "123456", T0 + 2000)).toBe("keiner");
  });

  test("falscher Code laesst den richtigen gueltig", () => {
    merkeCode(SITE, NUMMER, "123456", T0);
    expect(pruefeCode(SITE, NUMMER, "000000", T0 + 1000)).toBe("falsch");
    expect(pruefeCode(SITE, NUMMER, "123456", T0 + 2000)).toBe("ok");
  });

  test("ohne vorherigen Code kommt keiner", () => {
    expect(pruefeCode(SITE, NUMMER, "123456", T0)).toBe("keiner");
  });

  test("nach fuenf Minuten abgelaufen", () => {
    merkeCode(SITE, NUMMER, "123456", T0);
    expect(pruefeCode(SITE, NUMMER, "123456", T0 + CODE_GUELTIG_MS - 1)).toBe("ok");
    merkeCode(SITE, NUMMER, "123456", T0);
    expect(pruefeCode(SITE, NUMMER, "123456", T0 + CODE_GUELTIG_MS)).toBe("abgelaufen");
  });

  test("nach fuenf Fehlversuchen ist der Code verbraucht", () => {
    merkeCode(SITE, NUMMER, "123456", T0);
    for (let i = 0; i < MAX_VERSUCHE; i++) {
      expect(pruefeCode(SITE, NUMMER, "000000", T0 + 1000)).toBe("falsch");
    }
    // Der sechste Versuch verbraucht ihn, auch der richtige Code hilft nicht mehr.
    expect(pruefeCode(SITE, NUMMER, "123456", T0 + 1000)).toBe("zu-viele-versuche");
    expect(pruefeCode(SITE, NUMMER, "123456", T0 + 1000)).toBe("keiner");
  });

  test("ein neuer Code ersetzt den alten", () => {
    merkeCode(SITE, NUMMER, "111111", T0);
    merkeCode(SITE, NUMMER, "222222", T0 + 1000);
    expect(pruefeCode(SITE, NUMMER, "111111", T0 + 2000)).toBe("falsch");
    expect(pruefeCode(SITE, NUMMER, "222222", T0 + 2000)).toBe("ok");
  });

  test("Codes sind an Website UND Kennung gebunden", () => {
    merkeCode(SITE, NUMMER, "123456", T0);
    expect(pruefeCode("/srv/sites/kunde-b.de", NUMMER, "123456", T0)).toBe("keiner");
    expect(pruefeCode(SITE, "+4917000000000", "123456", T0)).toBe("keiner");
    expect(pruefeCode(SITE, "max@example.de", "123456", T0)).toBe("keiner");
  });

  test("eine E-Mail-Kennung funktioniert genauso", () => {
    merkeCode(SITE, "max@example.de", "654321", T0);
    expect(pruefeCode(SITE, "max@example.de", "654321", T0 + 1000)).toBe("ok");
  });

  test("abgelaufene Eintraege werden beim Merken aufgeraeumt", () => {
    merkeCode(SITE, NUMMER, "111111", T0);
    // Weit spaeter ein Code fuer eine ANDERE Kennung raeumt den alten mit weg.
    merkeCode(SITE, "max@example.de", "222222", T0 + CODE_GUELTIG_MS + 1);
    expect(pruefeCode(SITE, NUMMER, "111111", T0 + CODE_GUELTIG_MS + 2)).toBe("keiner");
  });
});
