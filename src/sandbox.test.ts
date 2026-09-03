/**
 * `sandbox.ts` — die erste der drei Grenzen (Plan, „Die drei Grenzen").
 *
 * Zwei Hälften, beide nötig:
 *   1. Der Argumentaufbau. Er ist reiner Text und lässt sich überall prüfen —
 *      auch dort, wo kein bwrap installiert ist (CI, macOS).
 *   2. Das Verhalten des echten bwrap. Ein Argumentaufbau, der stimmt, aber
 *      nichts bewirkt, wäre die schlimmste Sorte grüner Test. Diese Hälfte
 *      läuft nur mit bwrap und ist sonst sichtbar übersprungen.
 *
 * Was hier NICHT geprüft wird: ob der Agent sinnvoll arbeitet. Die Sandbox ist
 * eine Schranke, kein Urteil.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bwrapPfad, bwrapVerfuegbar, sandboxArgv, standardVerstecke } from "./sandbox.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/**
 * Bun.spawnSync WIRFT, wenn die Binary fehlt (kein Exit-Code). Deshalb try/catch
 * — dasselbe Muster wie `haveCaddy()` in service.test.ts.
 */
function haveBwrap(): boolean {
  try {
    return Bun.spawnSync([bwrapPfad(), "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}

/** Index eines Argument-PAARES, z. B. ["--bind", dir]. -1, wenn es fehlt. */
function paarIndex(argv: string[], flagge: string, wert: string): number {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flagge && argv[i + 1] === wert) return i;
  }
  return -1;
}

// ===========================================================================
// 1. Argumentaufbau — überall prüfbar
// ===========================================================================
describe("sandboxArgv", () => {
  const SCHREIBBAR = "/run/regoro/lauf-abc";
  const SKILLS = "/etc/regoro/skills";
  const argv = sandboxArgv("/usr/local/bin/regoro", ["agent-worker"], SCHREIBBAR, SKILLS);

  test("ruft bwrap auf und hängt Binary samt Argumenten hinten an", () => {
    expect(argv[0]).toBe(bwrapPfad());
    expect(argv.slice(-2)).toEqual(["/usr/local/bin/regoro", "agent-worker"]);
  });

  test("bindet das Wurzelverzeichnis nur lesbar ein", () => {
    expect(paarIndex(argv, "--ro-bind", "/")).toBeGreaterThanOrEqual(0);
    // Ein --bind auf / würde die ganze Übung aufheben.
    expect(paarIndex(argv, "--bind", "/")).toBe(-1);
  });

  test("die Arbeitskopie ist das EINZIGE beschreibbare Verzeichnis", () => {
    expect(paarIndex(argv, "--bind", SCHREIBBAR)).toBeGreaterThanOrEqual(0);
    const bindPaare = argv.filter((a, i) => a === "--bind" && i < argv.length - 1).length;
    expect(bindPaare).toBe(1);
  });

  test("die Arbeitskopie wird NACH / eingehängt — sonst überdeckt / sie wieder", () => {
    // Reihenfolge ist bei bwrap Semantik, nicht Kosmetik: Mounts wirken in der
    // Reihenfolge der Argumente. Stünde `--ro-bind / /` hinten, läge über der
    // Arbeitskopie wieder das nur lesbare Wurzel-Dateisystem und der Agent
    // könnte nirgends schreiben — der Lauf wäre wirkungslos statt eingesperrt.
    expect(paarIndex(argv, "--bind", SCHREIBBAR)).toBeGreaterThan(paarIndex(argv, "--ro-bind", "/"));
  });

  test("das Skill-Verzeichnis kommt NUR LESBAR herein", () => {
    // Wäre es beschreibbar, könnte der Agent sich selbst neue Anweisungen
    // schreiben, die beim nächsten Lauf als vertrauenswürdig gelten.
    expect(paarIndex(argv, "--ro-bind", SKILLS)).toBeGreaterThanOrEqual(0);
    expect(paarIndex(argv, "--bind", SKILLS)).toBe(-1);
  });

  test("ohne Skill-Verzeichnis entsteht kein leeres Mount-Paar", () => {
    const ohne = sandboxArgv("/usr/local/bin/regoro", ["agent-worker"], SCHREIBBAR, null);
    expect(ohne).not.toContain("");
    expect(ohne.filter((a) => a === "--ro-bind")).toHaveLength(1); // nur /
  });

  test("startet im Arbeitsverzeichnis der Kopie", () => {
    expect(paarIndex(argv, "--chdir", SCHREIBBAR)).toBeGreaterThanOrEqual(0);
  });

  test("eigene PID-, Sitzungs- und Prozessgrenzen", () => {
    expect(argv).toContain("--unshare-pid");
    // --die-with-parent: sonst überlebt ein Agentenlauf den Serverneustart und
    // schreibt in eine Arbeitskopie, die niemand mehr abholt.
    expect(argv).toContain("--die-with-parent");
    // --new-session gegen TIOCSTI aufs Eltern-Terminal.
    expect(argv).toContain("--new-session");
    expect(paarIndex(argv, "--proc", "/proc")).toBeGreaterThanOrEqual(0);
    expect(paarIndex(argv, "--dev", "/dev")).toBeGreaterThanOrEqual(0);
  });

  test("KEIN --unshare-net — der Worker muss die Weiterleitung erreichen", () => {
    // Das sieht nach fehlender Härtung aus und ist keine: ohne Netz-Namespace-
    // Teilung erreicht der Worker 127.0.0.1:<relayport>. Mit ihr erreicht er
    // gar nichts, auch nicht das Modell — der Lauf wäre tot. Die Netzgrenze
    // liegt woanders: Der Worker hat kein generisches Netzwerkzeug.
    expect(argv).not.toContain("--unshare-net");
    expect(argv).not.toContain("--unshare-all");
  });

  test("Pfade mit Leerzeichen bleiben EIN Argument", () => {
    // argv wird nicht durch eine Shell gereicht — hier darf nichts zerfallen.
    const mitLuecke = sandboxArgv("/opt/Meine Firma/regoro", ["agent-worker"], "/run/lauf 1", null);
    expect(mitLuecke).toContain("/run/lauf 1");
    expect(mitLuecke).toContain("/opt/Meine Firma/regoro");
  });
});

// ===========================================================================
// Was der Worker nicht einmal LESEN darf
// ===========================================================================
describe("die Deckel über den Nachbarn", () => {
  // `--ro-bind / /` macht den ganzen Host lesbar — auch die auth.json JEDES
  // anderen Kunden. Das ist Stütze 2 der Invariante 10: Wer ein fremdes Secret
  // liest, kann sich ein gültiges Cookie für diesen Kunden ausstellen. Ein
  // gelesenes Geheimnis lässt sich als harmloser Text in die eigene Live-Seite
  // schreiben und von dort abholen — der Weg hinaus ist trivial.
  test("standardVerstecke nennt Schlüssel, Heimatverzeichnisse und die Nachbarläufe", () => {
    const v = standardVerstecke("/run/regoro-sites", "/srv/sites");
    expect(v).toContain("/etc/regoro");
    expect(v).toContain("/home");
    expect(v).toContain("/root");
    expect(v).toContain("/run/regoro-sites"); // Geschwisterläufe anderer Kunden
    expect(v).toContain("/srv/sites"); // alle Kundenwebsites im Sammelbetrieb
  });

  test("ohne Sammelverzeichnis entsteht kein leerer Eintrag", () => {
    expect(standardVerstecke("/run/regoro-sites", null)).not.toContain("");
    expect(standardVerstecke("/run/regoro-sites")).not.toContain("");
  });

  test("die VORGABE deckelt — eine leere Liste muss man ausdrücklich verlangen", () => {
    // §13.17: Eine leere Vorgabe hieße, dass ein künftiger Aufrufer, der den
    // Parameter vergisst, stillschweigend eine UNGEDECKELTE Sandbox bekommt —
    // und damit Lesezugriff auf die auth.json jedes anderen Kunden. Fail-closed
    // heißt hier: wer keinen Deckel will, sagt es.
    const mitVorgabe = sandboxArgv("/bin/true", [], "/run/regoro-sites/lauf-1");
    expect(mitVorgabe).toContain("--tmpfs");
    expect(mitVorgabe).toContain("--remount-ro");

    // Gefragt ist die Abwesenheit der DECKEL, nicht die Abwesenheit jedes
    // `--remount-ro`: `/var/tmp` wird unabhängig davon festgezogen (siehe
    // Test darunter). Ein Zählen über die ganze Zeile prüfte das mit und
    // bräche, sobald jemand einen festen Einhängepunkt ergänzt — ein Test, der
    // an einer richtigen Änderung scheitert, wird beim nächsten Mal entfernt.
    const ohne = sandboxArgv("/bin/true", [], "/run/regoro-sites/lauf-1", null, []);
    for (const versteckt of standardVerstecke("/run/regoro-sites")) {
      expect(paarIndex(ohne, "--tmpfs", versteckt)).toBe(-1);
      expect(paarIndex(ohne, "--remount-ro", versteckt)).toBe(-1);
    }
  });

  test("auch das Kritzelverzeichnis /var/tmp ist nur lesbar", () => {
    // Ein beschreibbares Verzeichnis irgendwo in der Sandbox bräche die
    // Zusicherung, auf der alles andere ruht: „außerhalb der Arbeitskopie
    // schlägt jeder Schreibversuch fehl". Ein blankes `--tmpfs` ist
    // beschreibbar — es versteckt nur.
    const argv = sandboxArgv("/bin/true", [], "/run/lauf-1", null, []);
    expect(paarIndex(argv, "--tmpfs", "/var/tmp")).toBeGreaterThanOrEqual(0);
    expect(paarIndex(argv, "--remount-ro", "/var/tmp")).toBeGreaterThan(
      paarIndex(argv, "--tmpfs", "/var/tmp"),
    );
  });

  test("die Deckel werden erst NACH dem Skill-Mount festgezogen", () => {
    // Das Skill-Verzeichnis liegt unter /etc/regoro, das gerade zugedeckt wird.
    // Käme sein --ro-bind vor dem Deckel, wäre es danach verschwunden — der
    // Agent sähe die Skills in der Liste und käme nie an ihren Inhalt.
    const argv = sandboxArgv("/bin/true", [], "/run/lauf-1", "/etc/regoro/skills", ["/etc/regoro"]);
    const tmpfs = paarIndex(argv, "--tmpfs", "/etc/regoro");
    const skill = paarIndex(argv, "--ro-bind", "/etc/regoro/skills");
    const fest = paarIndex(argv, "--remount-ro", "/etc/regoro");
    if (tmpfs >= 0) {
      expect(skill).toBeGreaterThan(tmpfs);
      expect(fest).toBeGreaterThan(skill);
    }
  });

  test.skipIf(!haveBwrap())("ein zugedecktes Verzeichnis ist weder lesbar noch beschreibbar", () => {
    const nachbar = tmp("regoro-sbx-nachbar-");
    writeFileSync(join(nachbar, "auth.json"), '{"secret":"GEHEIMNIS-DES-NACHBARN"}');
    const kopie = tmp("regoro-sbx-");
    const datei = join(tmp("regoro-sbx-skript-"), "probe.ts");
    writeFileSync(
      datei,
      `try { console.log("GELESEN", await Bun.file(${JSON.stringify(join(nachbar, "auth.json"))}).text()); }
       catch (e) { console.log("blockiert-lesen"); }
       try { await Bun.write(${JSON.stringify(join(nachbar, "neu.txt"))}, "x"); console.log("SCHRIEB"); }
       catch (e) { console.log("blockiert-schreiben", (e as Error).message.slice(0, 5)); }`,
    );
    const argv = sandboxArgv(process.execPath, ["run", datei], kopie, null, [nachbar]);
    const out = new TextDecoder().decode(Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" }).stdout);

    expect(out).not.toContain("GEHEIMNIS-DES-NACHBARN");
    expect(out).toContain("blockiert-lesen");
    expect(out).not.toContain("SCHRIEB");
    // Ein blankes --tmpfs würde zwar verstecken, wäre aber BESCHREIBBAR — dann
    // stimmte „außerhalb der Arbeitskopie schlägt jeder Schreibversuch fehl"
    // nicht mehr, und darauf ruht alles andere.
    expect(out).toContain("blockiert-schreiben EROFS");
    expect(existsSync(join(nachbar, "neu.txt"))).toBe(false);
  }, 20_000);
});

describe("bwrapVerfuegbar", () => {
  test("sagt die Wahrheit über diese Maschine", () => {
    expect(bwrapVerfuegbar()).toBe(haveBwrap());
  });

  test("ein Pfad, der ins Leere zeigt, heißt „nicht verfügbar“ — nicht Absturz", () => {
    // Der Rückgabewert dieser Funktion entscheidet, ob ein Lauf überhaupt
    // startet. Eine Ausnahme statt `false` hieße 500 statt 503, und der Betreiber
    // sähe einen Serverfehler, wo eine fehlende Voraussetzung steht.
    const alt = process.env.REGORO_BWRAP;
    process.env.REGORO_BWRAP = "/nicht/vorhanden/bwrap";
    try {
      expect(bwrapVerfuegbar()).toBe(false);
    } finally {
      if (alt === undefined) delete process.env.REGORO_BWRAP;
      else process.env.REGORO_BWRAP = alt;
    }
  });
});

// ===========================================================================
// 2. Das echte bwrap — die Hälfte, die wirklich etwas beweist
// ===========================================================================
describe("bwrap sperrt wirklich ein", () => {
  /**
   * Führt ein bun-Skript in der Sandbox aus und gibt Ausgabe + Exit-Code.
   *
   * Bewusst `Bun.spawn` und nicht `Bun.spawnSync`: Der Loopback-Test unten hält
   * einen `Bun.serve` IM SELBEN PROZESS. `spawnSync` blockiert die Ereignis-
   * schleife, der Server käme nie zum Antworten, und der Test liefe in sein
   * Zeitlimit — ein Fehlschlag, der wie eine kaputte Sandbox aussieht und keiner
   * ist.
   */
  async function inSandbox(skript: string, schreibbar: string, nurLesbar: string | null = null) {
    const datei = join(tmp("regoro-sbx-skript-"), "probe.ts");
    writeFileSync(datei, skript);
    // AUSDRÜCKLICH OHNE DECKEL. Die Tests dieses Blocks prüfen die Mounts
    // (`--ro-bind` / `--bind`), nicht die Verstecke — und die Vorgabe deckelt
    // seit §13.17 das Elternverzeichnis des beschreibbaren Ordners zu. Das ist
    // hier `/tmp`, und damit läge auch dieses Prüfskript unter einem tmpfs:
    // bwrap startete, bun fände seine Datei nicht, und der Test sähe aus wie
    // eine kaputte Sandbox. Die Verstecke haben ihren eigenen Block weiter oben.
    const argv = sandboxArgv(process.execPath, ["run", datei], schreibbar, nurLesbar, []);
    const kind = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(kind.stdout).text(), new Response(kind.stderr).text()]);
    const code = await kind.exited;
    // stderr in die Zusicherung ziehen, wenn das Kind gar nicht erst lief:
    // Ein blankes `expect("").toBe("ok")` sagt nichts darüber, ob bwrap sperrte,
    // ob es an einer Kernel-Grenze scheiterte oder ob das Skript einen Tippfehler
    // hat. Das kostete beim ersten Auftreten eine halbe Stunde.
    if (code !== 0 && out === "") {
      throw new Error(`Sandbox-Kind endete mit ${code} und ohne Ausgabe. stderr: ${err.slice(0, 500)}`);
    }
    return { code, out, err };
  }

  test.skipIf(!haveBwrap())("in der Arbeitskopie darf geschrieben werden", async () => {
    const kopie = tmp("regoro-sbx-");
    const r = await inSandbox(`await Bun.write("drin.txt", "hallo"); console.log("ok");`, kopie);
    expect(r.out.trim()).toBe("ok");
    expect(readFileSync(join(kopie, "drin.txt"), "utf8")).toBe("hallo");
  }, 20_000);

  test.skipIf(!haveBwrap())("außerhalb schlägt jeder Schreibversuch mit EROFS fehl", async () => {
    const kopie = tmp("regoro-sbx-");
    const fremd = tmp("regoro-sbx-fremd-");
    // `/var/tmp` und `/tmp` sind bewusst dabei: Ein Kritzelverzeichnis ist die
    // naheliegendste Stelle, an der jemand doch etwas beschreibbar lässt —
    // und ein beschreibbarer Fleck irgendwo in der Sandbox bräche die
    // Zusicherung, auf der alles andere ruht.
    const r = await inSandbox(
      `for (const p of ["/etc/regoro-probe", "/home/regoro-probe", "/var/tmp/regoro-probe",
                        "/tmp/regoro-probe", ${JSON.stringify(join(fremd, "x"))}]) {
         try { await Bun.write(p, "x"); console.log("SCHRIEB", p); }
         catch (e) { console.log("blockiert", (e as Error).message.slice(0, 6)); }
       }`,
      kopie,
    );
    expect(r.out).not.toContain("SCHRIEB");
    expect(r.out.match(/blockiert EROFS/g)).toHaveLength(5);
    // Gegenprobe auf der Platte: der Nachbarordner ist wirklich unberührt.
    expect(existsSync(join(fremd, "x"))).toBe(false);
  }, 20_000);

  test.skipIf(!haveBwrap())("das Skill-Verzeichnis ist lesbar, aber nicht beschreibbar", async () => {
    const kopie = tmp("regoro-sbx-");
    const skills = tmp("regoro-sbx-skills-");
    writeFileSync(join(skills, "SKILL.md"), "# Stripe\nSo legt man ein Produkt an.\n");
    const r = await inSandbox(
      `console.log(await Bun.file(${JSON.stringify(join(skills, "SKILL.md"))}).text());
       try { await Bun.write(${JSON.stringify(join(skills, "eigene.md"))}, "x"); console.log("SCHRIEB"); }
       catch (e) { console.log("blockiert", (e as Error).message.slice(0, 5)); }`,
      kopie,
      skills,
    );
    expect(r.out).toContain("So legt man ein Produkt an.");
    expect(r.out).toContain("blockiert EROFS");
    expect(existsSync(join(skills, "eigene.md"))).toBe(false);
  }, 20_000);

  test.skipIf(!haveBwrap())("die Loopback-Weiterleitung bleibt erreichbar", async () => {
    // Die Gegenprobe zu „kein --unshare-net": ohne diese Verbindung gäbe es
    // keinen Modellzugang, und der ganze Lauf wäre wirkungslos.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("relay-da") });
    try {
      const r = await inSandbox(
        `const a = await fetch("http://127.0.0.1:${server.port}/modell/models"); console.log(await a.text());`,
        tmp("regoro-sbx-"),
      );
      expect(r.out.trim()).toBe("relay-da");
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test.skipIf(!haveBwrap())("--die-with-parent beendet den Lauf, wenn der Server neu startet", async () => {
    // Serverneustart während eines Laufs (Plan, Edge Cases). Ohne diese Flagge
    // schriebe ein verwaister Worker weiter in eine Arbeitskopie, die niemand
    // mehr abholt und niemand mehr aufräumt.
    const kopie = tmp("regoro-sbx-");
    const takt = join(kopie, "takt.txt");
    const kindSkript = join(tmp("regoro-sbx-skript-"), "takt.ts");
    writeFileSync(
      kindSkript,
      `for (let i = 0; i < 10_000; i++) { await Bun.write("takt.txt", String(i)); await Bun.sleep(20); }`,
    );
    const argv = sandboxArgv(process.execPath, ["run", kindSkript], kopie, null, []);

    // Ein Zwischen-Elternprozess: bwrap stirbt mit SEINEM Elternteil, nicht mit
    // dem Testprozess. Ohne ihn prüfte der Test gar nichts.
    const elternSkript = join(tmp("regoro-sbx-skript-"), "eltern.ts");
    writeFileSync(
      elternSkript,
      `Bun.spawn(${JSON.stringify(argv)}, { stdout: "ignore", stderr: "ignore" }); await Bun.sleep(60_000);`,
    );
    const eltern = Bun.spawn([process.execPath, "run", elternSkript], { stdout: "ignore", stderr: "ignore" });

    for (let i = 0; i < 100 && !existsSync(takt); i++) await Bun.sleep(50);
    expect(existsSync(takt)).toBe(true); // Voraussetzung: der Lauf läuft überhaupt

    eltern.kill("SIGKILL");
    await eltern.exited;
    await Bun.sleep(300);
    const stand = statSync(takt).mtimeMs;
    await Bun.sleep(500);
    expect(statSync(takt).mtimeMs).toBe(stand); // nichts tickt mehr
  }, 20_000);

  test.skipIf(!haveBwrap())("ein Verzeichnis, das es nicht gibt, lässt bwrap scheitern statt lautlos zu öffnen", () => {
    // Fail-closed: ein falsch gebauter Aufruf darf keinen ungesperrten Lauf ergeben.
    const argv = sandboxArgv(process.execPath, ["--version"], join(tmpdir(), "regoro-gibt-es-nicht-4711"), null, []);
    expect(Bun.spawnSync(argv).exitCode).not.toBe(0);
  }, 20_000);
});

// Belegt, dass die Fixtures dieses Tests keine Spuren hinterlassen — sonst
// füllt eine Testreihe /tmp mit Arbeitskopien.
test("die Fixtures liegen alle unter tmpdir()", () => {
  for (const d of dirs) expect(d.startsWith(tmpdir())).toBe(true);
  mkdirSync(join(tmpdir(), "regoro-noop"), { recursive: true });
  rmSync(join(tmpdir(), "regoro-noop"), { recursive: true, force: true });
});
