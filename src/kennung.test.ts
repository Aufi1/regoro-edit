import { describe, expect, test } from "bun:test";
import { normalizeEmail, maskiereEmail } from "./email.ts";
import { normalisiereKennung, erkenneKanal, maskiereKennung } from "./kennung.ts";

describe("normalizeEmail", () => {
  test("trimmt und schreibt klein", () => {
    expect(normalizeEmail("  Max.Mustermann@Handwerk-Mueller.DE ")).toBe(
      "max.mustermann@handwerk-mueller.de",
    );
  });

  test("Groß- und Kleinschreibung sperrt niemanden aus", () => {
    expect(normalizeEmail("MAX@example.de")).toBe(normalizeEmail("max@example.de"));
  });

  const ok = ["a@b.de", "max+rechnung@example.co.uk", "m.mueller_1@sub.example.com"];
  for (const e of ok) test(`"${e}" ist gültig`, () => expect(normalizeEmail(e)).toBe(e));

  const abgelehnt: Array<[string, unknown]> = [
    ["leer", ""],
    ["null", null],
    ["ohne @", "max.example.de"],
    ["zwei @", "max@@example.de"],
    ["ohne Punkt in der Domain", "max@server"],
    ["Domain endet auf Ziffern", "max@example.123"],
    ["Leerzeichen", "max mueller@example.de"],
    ["spitze Klammern", "<max@example.de>"],
    ["Komma", "max@example.de,chef@example.de"],
    ["führender Punkt lokal", ".max@example.de"],
    ["zu lang", `${"a".repeat(250)}@example.de`],
  ];
  for (const [name, e] of abgelehnt) {
    test(`${name} → null`, () => expect(normalizeEmail(e as string)).toBe(null));
  }
});

describe("erkenneKanal", () => {
  test("ein @ entscheidet", () => {
    expect(erkenneKanal("max@example.de")).toBe("email");
    expect(erkenneKanal("0151 20464812")).toBe("sms");
  });
});

describe("normalisiereKennung", () => {
  test("folgt dem gewählten Reiter", () => {
    expect(normalisiereKennung("015120464812", "sms")).toEqual({
      kanal: "sms",
      wert: "+4915120464812",
    });
    expect(normalisiereKennung("Max@example.de", "email")).toEqual({
      kanal: "email",
      wert: "max@example.de",
    });
  });

  test("eine Adresse im Telefon-Reiter wird trotzdem als Adresse verstanden", () => {
    // Nachsicht statt Fehlermeldung: ein @ kommt in keiner Telefonnummer vor.
    expect(normalisiereKennung("max@example.de", "sms")).toEqual({
      kanal: "email",
      wert: "max@example.de",
    });
  });

  test("eine Nummer im E-Mail-Reiter wird abgelehnt, nicht umgedeutet", () => {
    // Umgekehrt geht es nicht: "0151…" ist keine Adresse, und stillschweigend
    // eine SMS zu schicken wäre eine Überraschung.
    expect(normalisiereKennung("015120464812", "email")).toBe(null);
  });

  test("Unbrauchbares ergibt null", () => {
    expect(normalisiereKennung("", "sms")).toBe(null);
    expect(normalisiereKennung("abc", "sms")).toBe(null);
    expect(normalisiereKennung(null)).toBe(null);
  });
});

describe("maskiereKennung", () => {
  test("verkürzt beide Arten und zeigt nie das Ganze", () => {
    expect(maskiereKennung("+4915120464812")).toBe("+4915…812");
    expect(maskiereEmail("max.mustermann@example.de")).toBe("m…n@example.de");
    expect(maskiereKennung("max.mustermann@example.de")).not.toContain("mustermann");
  });
});
