/**
 * Typdeklaration für Buns `with { type: "file" }`-Importe.
 *
 * `import x from "./foo.client.js" with { type: "file" }` liefert zur Laufzeit
 * einen Pfad-String: in der Entwicklung den echten Plattenpfad, in einem
 * `bun build --compile`-Binary den eingebetteten `/$bunfs/…`-Pfad. tsc kennt
 * diese Bun-Semantik nicht und würde sonst TS7016 melden.
 *
 * Absichtlich eng auf `*.client.js` beschränkt — ein `*.js`-Wildcard würde jeden
 * künftigen JS-Import stillschweigend zu `string` erklären.
 */
declare module "*.client.js" {
  const path: string;
  export default path;
}

/**
 * Dasselbe für THIRD-PARTY-NOTICES.txt (`regoro licenses`). Ebenso eng gefasst:
 * ein `*.txt`-Wildcard erklärte jede künftige Textdatei stillschweigend zu einem
 * Pfad-String — auch dort, wo jemand den INHALT erwartet.
 */
declare module "*-NOTICES.txt" {
  const path: string;
  export default path;
}
