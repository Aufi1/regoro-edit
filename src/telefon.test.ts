import { describe, expect, test } from "bun:test";
import { normalizeNummer, maskiereNummer, STANDARD_LAENDERVORWAHL } from "./telefon.ts";

describe("normalizeNummer", () => {
  const gleich = [
    "+4915120464812",
    "015120464812",
    "0049 151 20464812",
    "+49 151 20464812",
    "+49 (151) 20464812",
    "0151/20464812",
    "0151-2046-4812",
    "  +4915120464812  ",
  ];
  for (const raw of gleich) {
    test(`"${raw}" → +4915120464812`, () => {
      expect(normalizeNummer(raw)).toBe("+4915120464812");
    });
  }

  test("dieselbe Nummer in jeder Schreibweise ist dieselbe Kennung", () => {
    const alle = new Set(gleich.map((r) => normalizeNummer(r)));
    expect(alle.size).toBe(1);
  });

  const abgelehnt: Array<[string, unknown]> = [
    ["leer", ""],
    ["nur Leerzeichen", "   "],
    ["null", null],
    ["Buchstaben", "0171-abcdefg"],
    ["Buchstaben mitten drin", "0151204a4812"],
    ["zweites Plus", "++4915120464812"],
    ["Plus in der Mitte", "0151+20464812"],
    ["zu kurz", "+491234"],
    ["zu lang (16 Ziffern)", "+4915120464812999"],
    ["Ländervorwahl mit führender 0", "+0151204648"],
    ["Klammern ohne Ziffern", "()"],
  ];
  for (const [name, raw] of abgelehnt) {
    test(`${name} → null`, () => {
      expect(normalizeNummer(raw as string)).toBe(null);
    });
  }

  test("österreichische Nummer nur international, national wäre stillschweigend falsch", () => {
    expect(normalizeNummer("+436641234567")).toBe("+436641234567");
    // 0664… wird als deutsche Nummer gelesen — deshalb die benannte Konstante.
    expect(normalizeNummer("06641234567")).toBe(`+${STANDARD_LAENDERVORWAHL}6641234567`);
  });
});

describe("maskiereNummer", () => {
  test("zeigt Anfang und Ende, nicht die Mitte", () => {
    const m = maskiereNummer("+4915120464812");
    expect(m).toBe("+4915…812");
    expect(m).not.toContain("2046");
  });
});
