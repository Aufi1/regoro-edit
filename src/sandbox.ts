/**
 * Die erste der drei Grenzen (Plan, „Die drei Grenzen"): das Betriebssystem.
 *
 * Der Agent ist ein fremder Prozess, der fremden Text (abgerufene Webseiten)
 * als Eingabe verarbeitet. Weder unsere Werkzeuge noch der Validator sind
 * deshalb die eigentliche Grenze — sie sind Code, den man umgehen kann, wenn
 * man einen Fehler darin findet. Die Grenze ist `bwrap`: Der Worker sieht ein
 * nur lesbares Dateisystem, und das EINZIGE, worin er schreiben kann, ist seine
 * Arbeitskopie.
 *
 * pi sagt das über sich selbst (`docs/security.md`): „Real isolation needs to
 * come from the operating system or a virtualization/container boundary." Sein
 * `cwd` ist ausdrücklich keine Sandbox.
 *
 * Diese Datei baut nur die Kommandozeile und beantwortet „gibt es bwrap?".
 * Sie startet nichts — das tut `agent.ts`.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, sep } from "node:path";

/**
 * `REGORO_BWRAP` gibt es für zwei Zwecke: einen Host, auf dem bwrap woanders
 * liegt, und die Tests, die den Fall „bwrap fehlt" nachstellen müssen, ohne es
 * zu deinstallieren.
 */
export function bwrapPfad(): string {
  return process.env.REGORO_BWRAP || "bwrap";
}

/**
 * Fehlt bwrap, startet KEIN Lauf (Plan: „Kein stiller Rückfall auf einen
 * ungesperrten Prozess"). Diese Funktion entscheidet darüber, deshalb darf sie
 * nie werfen: `Bun.spawnSync` wirft, wenn die Binary fehlt — eine Ausnahme
 * hier ergäbe HTTP 500 („Serverfehler") statt 503 („Voraussetzung fehlt"), und
 * der Betreiber suchte den Fehler im Code statt in seiner Paketliste.
 */
export function bwrapVerfuegbar(): boolean {
  try {
    return Bun.spawnSync([bwrapPfad(), "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Verzeichnisse, die der Worker nicht einmal LESEN können soll.
 *
 * `--ro-bind / /` macht den ganzen Host lesbar — auch `/etc/regoro/ki.json`,
 * die `.regoro/auth.json` **jedes anderen Kunden** (Stütze 2 der Invariante 10)
 * und die Arbeitskopien parallel laufender Kunden. Ohne diese Liste hinge die
 * Eingrenzung allein an der Pfadnormalisierung unserer Werkzeuge: ein einziger
 * Symlink machte `read_file` zum Beliebig-Datei-Leser, und der Inhalt ließe
 * sich als harmloser Text in die eigene Live-Seite schreiben.
 *
 * `kopieEltern` ist das Elternverzeichnis der Arbeitskopie — dort liegen die
 * Läufe der anderen Kunden.
 */
export function standardVerstecke(kopieEltern: string, sitesRoot?: string | null): string[] {
  return [
    "/etc/regoro", // unser Modellschlüssel und die Skills des Betreibers
    "/home",
    "/root",
    kopieEltern, // Geschwisterläufe anderer Kunden
    ...(sitesRoot ? [sitesRoot] : []), // alle Kundenwebsites im Sammelbetrieb
  ];
}

/**
 * Baut die bwrap-Kommandozeile.
 *
 * REIHENFOLGE IST SEMANTIK, NICHT KOSMETIK. bwrap wendet die Mount-Operationen
 * in der Reihenfolge der Argumente an. Daraus folgen drei Regeln, die man nicht
 * umstellen darf:
 *
 *   1. `--ro-bind / /` ganz nach vorn. Stünde es hinter der Arbeitskopie, läge
 *      über ihr wieder das nur lesbare Wurzeldateisystem — der Agent könnte
 *      nirgends schreiben und der Lauf wäre wirkungslos statt eingesperrt.
 *   2. Die `--tmpfs`-Deckel VOR den Einhängungen, die unter ihnen liegen. Das
 *      Skill-Verzeichnis liegt in `/etc/regoro`, das wir gerade zudecken; sein
 *      `--ro-bind` muss also danach kommen, sonst ist es verschwunden.
 *   3. `--remount-ro` ganz zum Schluss. Nachgemessen: Vor den Einhängungen
 *      scheitert bwrap mit „Can't mkdir …: Read-only file system", weil es den
 *      Einhängepunkt im bereits schreibgeschützten tmpfs nicht mehr anlegen
 *      kann. Danach wirkt es und remountet ausdrücklich NICHT rekursiv — die
 *      Arbeitskopie unter dem Deckel bleibt beschreibbar.
 *
 * Warum die Deckel überhaupt read-only werden: Ein blankes `--tmpfs` ist
 * beschreibbar. Verstecken würde es zwar, aber „außerhalb der Arbeitskopie
 * schlägt jeder Schreibversuch fehl" wäre nicht mehr wahr — und genau das ist
 * die Zusicherung, auf der alles andere ruht.
 */
export function sandboxArgv(
  binary: string,
  args: string[],
  schreibbar: string,
  nurLesbar: string | null = null,
  /**
   * Was zugedeckt wird.
   *
   * Die Vorgabe SCHÜTZT: Wer den Parameter vergisst, bekommt die Standarddeckel,
   * nicht etwa keine. Eine leere Vorgabe wäre die eine Sorte Fehler, die hier
   * niemand bemerkt — die Sandbox liefe, der Lauf gelänge, und nur die
   * Nachbarkunden lägen offen. Wer ausdrücklich ohne Deckel bauen will (etwa
   * um den reinen Argumentaufbau zu prüfen), übergibt ausdrücklich `[]`.
   *
   * `agent.ts` reicht die vollständige Liste durch, weil nur dort der Ordner der
   * Website und der sitesRoot bekannt sind. Nicht existierende Ziele fliegen
   * raus — bwrap bräche sonst ab („Can't mkdir"), weil es den Einhängepunkt im
   * nur lesbaren Wurzeldateisystem nicht anlegen kann.
   */
  verstecke: string[] = standardVerstecke(dirname(schreibbar)),
): string[] {
  const vorhanden = [...new Set(verstecke)].filter((p) => {
    try {
      return existsSync(p) && statSync(p).isDirectory();
    } catch {
      return false;
    }
  });

  /**
   * Liegt ein Deckel unter einem anderen, ist er überflüssig — und schädlich:
   * Gemessen bricht bwrap mit „Can't remount readonly on …: Invalid argument"
   * ab, wenn ein tmpfs innerhalb eines anderen tmpfs read-only gesetzt werden
   * soll. Der äußere Deckel verbirgt den inneren ohnehin schon vollständig.
   */
  const deckel = vorhanden.filter((p) => !vorhanden.some((q) => q !== p && p.startsWith(q + sep)));

  /**
   * Liegt das auszuführende Programm unter einem Deckel, muss es darüber wieder
   * sichtbar werden — sonst deckt die Sandbox genau das zu, was sie starten
   * soll, und bwrap bricht mit „execvp: No such file or directory" ab.
   *
   * Gemessen auf dieser Maschine: `bun` liegt unter `/home/agent/.bun/bin`,
   * also unter dem `/home`-Deckel. In Produktion liegt das Binary in
   * `/usr/local/bin` und der Fall tritt nicht ein — genau deshalb wäre er ohne
   * diese Zeile erst beim Entwickeln aufgefallen und hätte dort zur bequemen
   * Abhilfe verführt, den `/home`-Deckel ganz wegzulassen.
   *
   * Nur die Datei selbst wird zurückgeholt, nicht ihr Verzeichnis: Der Rest des
   * Heimatverzeichnisses bleibt verdeckt.
   */
  const binaerUnterDeckel = deckel.some((p) => binary === p || binary.startsWith(p + sep));

  return [
    bwrapPfad(),
    // 1. Alles lesbar, nichts beschreibbar.
    "--ro-bind", "/", "/",
    // 2. Deckel drauf, wo der Worker nichts zu suchen hat.
    // 2. Die eigenen Dateisysteme des Sandkastens. Sie stehen VOR dem
    //    `--remount-ro`-Block, weil bwrap die Operationen in der Reihenfolge
    //    der Argumente anwendet — eine Einhängung hinter dem Festziehen wäre
    //    mindestens fragil.
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/var/tmp",
    ...deckel.flatMap((p) => ["--tmpfs", p]),
    // 3. Das Skill-Verzeichnis nur LESBAR wieder hervorholen. Beschreibbar
    //    könnte der Agent sich selbst neue Anweisungen schreiben, die beim
    //    nächsten Lauf als vertrauenswürdig gälten.
    ...(nurLesbar ? ["--ro-bind", nurLesbar, nurLesbar] : []),
    ...(binaerUnterDeckel ? ["--ro-bind", binary, binary] : []),
    // 4. Die Arbeitskopie — das einzige --bind der ganzen Zeile.
    "--bind", schreibbar, schreibbar,
    // 5. Alles festziehen, was nicht die Arbeitskopie ist (siehe Regel 3 oben).
    //    `/var/tmp` gehört ausdrücklich dazu: Ein blankes `--tmpfs` ist
    //    BESCHREIBBAR. Es versteckt zwar den Inhalt des Hosts, bräche aber die
    //    Zusicherung, auf der die ganze Isolationsaussage ruht — außerhalb der
    //    Arbeitskopie schlägt jeder Schreibversuch fehl.
    "--remount-ro", "/var/tmp",
    ...deckel.flatMap((p) => ["--remount-ro", p]),
    "--unshare-pid",
    // Ohne --die-with-parent überlebt ein Lauf den Serverneustart und schreibt
    // in eine Arbeitskopie, die niemand mehr abholt und niemand mehr aufräumt.
    "--die-with-parent",
    // --new-session gegen TIOCSTI: sonst könnte der Worker Zeichen in das
    // Terminal des Elternprozesses schieben.
    "--new-session",
    // KEIN --unshare-net. Das sieht nach fehlender Härtung aus und ist keine:
    // Der Worker muss die Loopback-Weiterleitung erreichen, sonst gibt es
    // keinen Modellzugang und der Lauf ist tot. Die Netzgrenze liegt woanders —
    // der Worker hat kein generisches Netzwerkzeug (Invariante 11).
    "--chdir", schreibbar,
    binary,
    ...args,
  ];
}
