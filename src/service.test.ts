/**
 * `regoro service` — Generator für systemd-Unit und Caddy-Block.
 *
 * Der Caddy-Block wird gegen ECHTES caddy validiert (falls installiert): eine
 * Vorlage, die nicht parst, ist schlimmer als keine.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  serviceSlug,
  servicePort,
  systemdUnit,
  caddyBlock,
  activationSteps,
  siteIsUnderHome,
  DOMAIN_RE,
  caddyGlobalBlock,
  CADDY_HOST_RE,
} from "./service.ts";

/**
 * Die `@editor`-Zeile eines Blocks oder einer Vorlage — über den NAMEN des
 * Matchers, nicht über seine Art. Sie steht an vier Stellen (Generator einzeln,
 * Generator Sammelbetrieb, beide Vorlagen) und muss überall dieselbe sein.
 */
const EDITOR_RE = /^\s*@editor .*$/m;
const editorZeile = (text: string): string => (text.match(EDITOR_RE)?.[0] ?? "").trim();

const base = {
  siteDir: "/srv/sites/mueller",
  execPath: "/home/aufi/.local/bin/regoro",
  slug: "mueller",
  port: 8829,
  user: "www-data",
  domain: "mueller-sanitaer.de",
};

describe("serviceSlug", () => {
  test("nimmt den Ordnernamen", () => {
    expect(serviceSlug("/srv/sites/mueller")).toBe("mueller");
  });

  test("generische Namen bekommen den Elternordner davor", () => {
    // Sonst hießen alle Dienste "regoro-site".
    expect(serviceSlug("/data/kunden/rossmeisl-7a5f/site")).toBe("rossmeisl-7a5f-site");
    expect(serviceSlug("/var/www/kunde-x/public")).toBe("kunde-x-public");
    expect(serviceSlug("/data/kunden/bergdolt/site-gold")).toBe("bergdolt-site-gold");
  });

  test("bereinigt Zeichen, die systemd nicht mag", () => {
    expect(serviceSlug("/srv/Müller & Söhne GmbH")).toBe("m-ller-s-hne-gmbh");
    expect(serviceSlug("/srv/--weird--")).toBe("weird");
  });

  test("fällt nie auf einen leeren Namen zurück", () => {
    expect(serviceSlug("/srv/___")).toBe("site");
    expect(serviceSlug("/")).toBe("site");
  });
});

describe("servicePort", () => {
  test("ist deterministisch — gleiche Site, gleicher Port", () => {
    expect(servicePort("mueller")).toBe(servicePort("mueller"));
  });

  test("liegt im reservierten Bereich und kollidiert nicht mit 8788", () => {
    for (const s of ["a", "mueller", "rossmeisl-site", "x".repeat(60)]) {
      const p = servicePort(s);
      expect(p).toBeGreaterThanOrEqual(8800);
      expect(p).toBeLessThan(9000);
      expect(p).not.toBe(8788); // der Default von `regoro run`
    }
  });

  test("verschiedene Sites bekommen meist verschiedene Ports", () => {
    const ports = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(servicePort));
    expect(ports.size).toBeGreaterThan(5);
  });
});

describe("systemdUnit", () => {
  test("ExecStart zeigt auf das Binary und den Site-Ordner", () => {
    const u = systemdUnit(base);
    expect(u).toContain('ExecStart="/home/aufi/.local/bin/regoro" run "/srv/sites/mueller"');
    expect(u).toContain("Environment=PORT=8829");
    expect(u).toContain("User=www-data");
    expect(u).toContain('ReadWritePaths="/srv/sites/mueller"');
  });

  test("außerhalb von /home: ProtectHome=yes", () => {
    expect(systemdUnit(base)).toContain("ProtectHome=yes");
  });

  // systemd macht /home unter ProtectHome=yes leer und unzugänglich; ReadWritePaths
  // hebt das nicht auf. Der Dienst käme nicht hoch.
  test("Site unter /home: ProtectHome wird NICHT gesetzt", () => {
    const u = systemdUnit({ ...base, siteDir: "/home/aufi/repos/kunde/site" });
    expect(u).not.toContain("ProtectHome=yes");
    expect(u).toContain("ProtectHome bewusst NICHT gesetzt");
    expect(u).toContain('ReadWritePaths="/home/aufi/repos/kunde/site"');
  });

  test("siteIsUnderHome erkennt /home und /root, nicht /homer", () => {
    expect(siteIsUnderHome("/home/x")).toBe(true);
    expect(siteIsUnderHome("/root/x")).toBe(true);
    expect(siteIsUnderHome("/home")).toBe(true);
    expect(siteIsUnderHome("/homer/x")).toBe(false);
    expect(siteIsUnderHome("/srv/home/x")).toBe(false);
  });
});

// ===========================================================================
// Die Unit für den Agentenbetrieb (Contract §8)
// ===========================================================================
describe("systemdUnit trägt, was ein Agentenlauf braucht", () => {
  test("der Modellschlüssel kommt über LoadCredential, nicht über die Umgebung", () => {
    // systemd liest /etc/regoro/ki.json als root und legt sie in ein tmpfs, das
    // nur dieser Dienst sieht. Damit muss sie für den Dienst-Benutzer gar nicht
    // lesbar sein, taucht in KEINEM Prozess-Environment auf und nicht in /proc.
    // Ein `Environment=OPENROUTER_KEY=…` stünde dagegen in `systemctl show` und
    // in der Umgebung jedes Kindprozesses — auch der des Agenten.
    const u = systemdUnit(base);
    expect(u).toContain("LoadCredential=ki:/etc/regoro/ki.json");
    expect(u).not.toMatch(/^Environment=.*(KEY|TOKEN|SECRET)/im);
  });

  test("RuntimeDirectory gibt der Arbeitskopie ihren Platz", () => {
    // Ohne das läge die Kopie in /tmp — geteilt mit jedem anderen Dienst des
    // Hosts. RuntimeDirectory räumt systemd beim Dienstende zudem selbst auf.
    expect(systemdUnit(base)).toMatch(/^RuntimeDirectory=regoro-mueller$/m);
  });

  test("Ressourcengrenzen: ein entgleister Lauf reißt den Host nicht mit", () => {
    const u = systemdUnit(base);
    for (const zeile of ["MemoryHigh=2G", "MemoryMax=3G", "TasksMax=512", "CPUQuota=200%"]) {
      expect(u).toContain(zeile);
    }
  });

  test("zusätzliche Härtung, die bwrap nicht stört", () => {
    const u = systemdUnit(base);
    for (const zeile of [
      "ProtectProc=invisible",
      "RestrictSUIDSGID=yes",
      "LockPersonality=yes",
      "ProtectKernelModules=yes",
      "ProtectClock=yes",
    ]) {
      expect(u).toContain(zeile);
    }
  });

  test("die zwei Schalter, die bwrap LAUTLOS brechen, stehen nicht drin", () => {
    // Beide sehen nach gutem Hardening aus. `RestrictNamespaces=yes` sperrt ALLE
    // Namespace-Typen, `bwrap` braucht user, mnt und pid. `SystemCallFilter=
    // @system-service` schließt @mount aus — genau das, was bwrap tut. Der Dienst
    // startet in beiden Fällen sauber, und erst der erste Agentenlauf scheitert;
    // dann sucht jemand tagelang im falschen Code.
    const u = systemdUnit(base);
    expect(u).not.toMatch(/^RestrictNamespaces=yes$/m);
    expect(u).not.toMatch(/^SystemCallFilter=@system-service$/m);
    if (/^RestrictNamespaces=/m.test(u)) expect(u).toMatch(/^RestrictNamespaces=~/m);
    if (/^SystemCallFilter=/m.test(u)) expect(u).toMatch(/^SystemCallFilter=.*@mount/m);
  });

  test("NoNewPrivileges bleibt — es stört bwrap nicht", () => {
    // Das Ubuntu-bwrap hat kein Setuid-Bit (nachgemessen). Auf einem System mit
    // setuid-bwrap wäre NoNewPrivileges ein Problem; hier ist es keines und
    // gehört nicht „vorsichtshalber" entfernt.
    expect(systemdUnit(base)).toContain("NoNewPrivileges=yes");
  });

  test("ProtectSystem=strict + ReadWritePaths gelten auch für den Agentenprozess", () => {
    // Über den Mount-Namespace, und ein Kind kann das nicht abstreifen. Das ist
    // die eigentliche Begründung dafür, dass die Abschottung trägt — sie gehört
    // als Kommentar in die Unit, sonst entfernt es irgendwann jemand als
    // „unnötig, wir haben ja bwrap".
    const u = systemdUnit(base);
    expect(u).toContain("ProtectSystem=strict");
    expect(u).toMatch(/Kindprozess|Kindprozesse/);
  });

  test("auch im Sammelbetrieb", () => {
    const u = systemdUnit({ ...base, siteDir: "/srv/sites", slug: "sites", multi: true, domain: undefined });
    expect(u).toContain("LoadCredential=ki:/etc/regoro/ki.json");
    expect(u).toMatch(/^RuntimeDirectory=regoro-sites$/m);
    expect(u).toContain("MemoryMax=3G");
  });
});

describe("caddyBlock", () => {
  test("enthält Domain, Editor-Proxy auf den Port und die Site-Root", () => {
    const c = caddyBlock(base);
    expect(c).toContain("mueller-sanitaer.de {");
    expect(c).toContain("reverse_proxy 127.0.0.1:8829");
    expect(c).toContain('root * "/srv/sites/mueller"');
  });

  test("blockt Dotfiles in jeder Tiefe und führt eine Extension-Allowlist", () => {
    const c = caddyBlock(base);
    expect(c).toContain("path_regexp (^|/)\\.");
    expect(c).toContain("@allowed path / */ *.html");
    expect(c).not.toContain("*.json"); // Build-Artefakte bleiben draußen
  });

  test("ohne Domain steht ein Platzhalter drin", () => {
    expect(caddyBlock({ ...base, domain: undefined })).toContain("example.com {");
  });
});

describe("activationSteps", () => {
  test("die Unit entsteht aus `--systemd`, nicht durch Abtippen", () => {
    const s = activationSteps(base);
    expect(s).toContain("regoro service '/srv/sites/mueller' --systemd | sudo tee");
    expect(s).not.toContain("< /dev/null"); // hätte die Datei geleert
    expect(s).toContain("systemctl enable --now regoro-mueller");
    expect(s).toContain("caddy validate");
  });
});

// Der Editor kennt vier Routen-Formen (isEditorPath in host.ts). `path /edit*`
// verfehlte die Suffix-Route `/impressum.html/edit` — in Produktion war der
// Editor damit für JEDE Unterseite unerreichbar (404) — und fing zugleich
// öffentliche Seiten wie `/edit-preise.html` ein.
describe("Caddy-Matcher deckt alle Editor-Routen ab", () => {
  test("Suffix-Routen und Editor-Assets sind im Matcher", () => {
    // Auf die FORMEN festgenagelt, nicht auf die ganze Zeile: Die Liste wächst
    // (zuletzt `/edit-vorschau/*` für die Vorschau), und ein Exakt-Vergleich
    // wird dann rot, ohne dass etwas kaputt ist. Was NICHT wachsen darf, steht
    // in der letzten Zeile.
    const zeile = editorZeile(caddyBlock(base));
    for (const form of ["/edit", "/edit/*", "/edit-assets/*", "*/edit"]) {
      expect(`${form}: ${zeile.split(" ").includes(form)}`).toBe(`${form}: true`);
    }
    // `/edit*` allein verfehlt die Suffix-Route und fängt `/edit-preise.html`.
    expect(zeile.split(" ")).not.toContain("/edit*");
  });

  /**
   * Und dieselbe Frage für die PREVIEW-Adressen (`/p/<slug>/…`) — die aber in
   * einem EIGENEN Block wohnen, nicht im Produktionsblock.
   *
   * GEMESSEN mit caddy 2.11.4, weil die naheliegende Lösung nicht funktioniert:
   * In einem `path`-Glob überspringt ein Stern KEINE Schrägstriche — außer in
   * den drei Sonderformen, die caddy abkürzt (Stern vorn = Endet-auf, Stern
   * hinten = Beginnt-mit, beides = Enthält). Das Präfix erzwingt einen zweiten
   * Stern, und ab dem gilt Segment-Semantik. Deshalb der Regexp.
   *
   * Der heutige Produktions-Matcher trifft unter dem Präfix genau zwei von vier
   * Formen, und die zufällig über die Endet-auf-Regel:
   *
   *   /p/kunde-a/edit                    trifft   (Endet-auf)
   *   /p/kunde-a/impressum.html/edit     trifft   (Endet-auf)
   *   /p/kunde-a/edit/agent/status       fällt durch  ← die halbe Seitenleiste
   *   /p/kunde-a/edit-assets/overlay.js  fällt durch  ← das ganze Overlay
   *
   * Was zählt, ist die Aufteilung: Der PRODUKTIONSBLOCK darf die
   * Preview-Adressen NICHT kennen (sein Prozess löst sie nicht auf — er würde
   * eine zweite Adresse öffnen, die es nirgends gibt), der STAGING-BLOCK muss.
   * Den Beweis auf der Leitung führt `csp.test.ts`.
   */
  test("der Staging-Block kennt die Preview-Adressen", () => {
    expect(editorZeile(caddyBlock(baseStaging))).toContain("/p/");
  });

  test("GEGENPROBE: die Produktionsblöcke kennen sie NICHT", () => {
    // Ein Produktionsprozess beantwortet `/p/<slug>/edit` mit 404 (siehe
    // multisite.test.ts). Stünde die Form trotzdem im Proxy, ginge die Anfrage
    // an den Bun-Host — und wer dort etwas ändert, hätte sofort zwei Adressen
    // für dieselbe Website, eine davon ohne die Extension-Allowlist.
    for (const [name, opts] of [["Einzelbetrieb", base], ["Sammelbetrieb", baseMulti]] as const) {
      expect(`${name}: ${editorZeile(caddyBlock(opts)).includes("/p/")}`).toBe(`${name}: false`);
    }
  });
});

// Die Domain landet im Caddyfile UND in angezeigten Shell-Befehlen. Statt sie
// dreifach zu quoten, wird sie validiert.
describe("DOMAIN_RE", () => {
  test("akzeptiert Hostnamen, Wildcards und :PORT", () => {
    for (const d of ["kunde.de", "www.kunde.de", "*.site.aufi.de", ":8099", "localhost:8788"]) {
      expect(DOMAIN_RE.test(d)).toBe(true);
    }
  });

  test("lehnt Shell-Metazeichen und Leerzeichen ab", () => {
    for (const d of ["kunde.de; rm -rf /", "a b", "$(whoami)", "a`id`", "a|b", "a\nb"]) {
      expect(DOMAIN_RE.test(d)).toBe(false);
    }
  });
});

describe("Pfade mit Leerzeichen", () => {
  const spaced = { ...base, siteDir: "/srv/sites/Meine Firma/site", execPath: "/opt/my tools/regoro" };

  test("systemd: ExecStart und ReadWritePaths gequotet, WorkingDirectory NICHT", () => {
    // NICHT VEREINHEITLICHEN — die drei Direktiven lesen verschieden.
    //
    // Quoting gilt in Unit-Dateien nur für Einstellungen, die eine LISTE lesen.
    // `WorkingDirectory=` nimmt den Rest der Zeile wörtlich; die Anführungs-
    // zeichen werden Teil des Pfades. Nachgemessen auf systemd 255:
    //
    //   WorkingDirectory="/tmp"  → „path is not absolute: "/tmp"",
    //                              „Unit configuration has fatal error", Exit 1
    //   WorkingDirectory=/tmp    → Exit 0
    //   WorkingDirectory=/tmp/mit leerzeichen → Exit 0 (Leerzeichen sind egal)
    //
    // Diese Datei hat das Quoting früher für alle drei verlangt. Folge: `regoro
    // service --systemd | sudo tee …` erzeugte eine Unit, die NIE startete —
    // und der Test hielt den Fehler fest, statt ihn zu finden.
    const u = systemdUnit(spaced);
    expect(u).toContain('ExecStart="/opt/my tools/regoro" run "/srv/sites/Meine Firma/site"');
    expect(u).toContain('ReadWritePaths="/srv/sites/Meine Firma/site"');
    expect(u).toContain("WorkingDirectory=/srv/sites/Meine Firma/site");
  });

  test("WorkingDirectory= beginnt nie mit einem Anführungszeichen", () => {
    // Ausdrücklich negativ formuliert, damit das Quoting bei der nächsten
    // „Vereinheitlichung" nicht zurückkommt: Ein Test, der nur den richtigen
    // Wert erwartet, ließe `WorkingDirectory="…"` in einer anderen Schreibweise
    // wieder durch.
    for (const opts of [spaced, base, baseMulti]) {
      const zeile = systemdUnit(opts).match(/^WorkingDirectory=.*$/m)![0];
      expect(zeile).not.toMatch(/^WorkingDirectory="/);
    }
  });

  test("Caddy: root-Pfad ist gequotet", () => {
    expect(caddyBlock(spaced)).toContain('root * "/srv/sites/Meine Firma/site"');
  });

  test("Shell-Befehle: siteDir ist einfach-gequotet", () => {
    const s = activationSteps(spaced);
    expect(s).toContain(`regoro service '/srv/sites/Meine Firma/site' --systemd`);
    expect(s).toContain(`regoro service '/srv/sites/Meine Firma/site' --caddy`);
  });

  test("Anführungszeichen im Pfad werden escaped", () => {
    const evil = { ...base, siteDir: '/srv/a"b' };
    expect(systemdUnit(evil)).toContain('ReadWritePaths="/srv/a\\"b"');
  });
});

/** Bun.spawnSync WIRFT, wenn die Binary fehlt (kein Exit-Code). Deshalb try/catch. */
function haveCaddy(): boolean {
  try {
    return Bun.spawnSync(["caddy", "version"]).exitCode === 0;
  } catch {
    return false;
  }
}

/** Wie `haveCaddy()`: Bun.spawnSync WIRFT, wenn die Binary fehlt. */
function haveSystemdAnalyze(): boolean {
  try {
    return Bun.spawnSync(["systemd-analyze", "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}

describe("die erzeugte Unit ist für systemd gültig", () => {
  /**
   * DAS IST DIE EIGENTLICHE ABSICHERUNG. Die Zeichenketten-Prüfungen oben
   * halten fest, was wir für richtig HALTEN — und lagen beim Quoting von
   * `WorkingDirectory=` jahrelang falsch, ohne dass es jemandem auffiel. Ein
   * Vergleich mit der eigenen Erwartung kann so einen Fehler grundsätzlich
   * nicht finden; nur systemd selbst kann das.
   *
   * `--recursive-errors=no`, weil `verify` sonst über Abhängigkeiten wie
   * network.target mitklagt, die in einem tmp-Verzeichnis nicht existieren.
   */
  function verify(unit: string): { code: number | null; ausgabe: string } {
    const dir = mkdtempSync(join(tmpdir(), "regoro-unit-"));
    const datei = join(dir, "regoro-probe.service");
    writeFileSync(datei, unit);
    const res = Bun.spawnSync(["systemd-analyze", "verify", "--recursive-errors=no", datei]);
    rmSync(dir, { recursive: true, force: true });
    const dec = new TextDecoder();
    return { code: res.exitCode, ausgabe: dec.decode(res.stderr) + dec.decode(res.stdout) };
  }

  /** Site-Ordner und Binary müssen existieren, sonst klagt verify über beides. */
  function echteOpts(extra: Partial<typeof base> = {}) {
    const site = mkdtempSync(join(tmpdir(), "regoro-unitsite-"));
    return { ...base, siteDir: site, execPath: "/bin/true", ...extra };
  }

  test.skipIf(!haveSystemdAnalyze())("Einzelbetrieb: keine fatale Konfiguration", () => {
    const { code, ausgabe } = verify(systemdUnit(echteOpts()));
    expect(`${ausgabe}`).not.toContain("fatal error");
    expect(ausgabe).not.toContain("bad unit file setting");
    expect(code).toBe(0);
  });

  test.skipIf(!haveSystemdAnalyze())("Sammelbetrieb: keine fatale Konfiguration", () => {
    const site = mkdtempSync(join(tmpdir(), "regoro-unitsites-"));
    const { code, ausgabe } = verify(systemdUnit({ ...baseMulti, siteDir: site, execPath: "/bin/true" }));
    expect(ausgabe).not.toContain("fatal error");
    expect(code).toBe(0);
  });

  test.skipIf(!haveSystemdAnalyze())("auch mit Leerzeichen im Site-Pfad", () => {
    // Der Fall, an dem das Quoting überhaupt hängt.
    const eltern = mkdtempSync(join(tmpdir(), "regoro-unitraum-"));
    const site = join(eltern, "Meine Firma");
    mkdirSync(site, { recursive: true });
    const { code, ausgabe } = verify(systemdUnit(echteOpts({ siteDir: site })));
    expect(ausgabe).not.toContain("fatal error");
    expect(code).toBe(0);
  });

  test.skipIf(!haveSystemdAnalyze())("Staging: keine fatale Konfiguration", () => {
    /**
     * Der dritte Dienst, und bisher prüfte ihn niemand. Genau so ist die
     * `WorkingDirectory=`-Falle jahrelang unbemerkt geblieben: Ein
     * Textvergleich winkt eine Unit durch, die nie startet. Hier steht deshalb
     * dieselbe Prüfung wie für die anderen beiden — mit echtem systemd.
     */
    const wurzel = mkdtempSync(join(tmpdir(), "regoro-unitstaging-"));
    const { code, ausgabe } = verify(
      systemdUnit({ ...baseStaging, siteDir: wurzel, execPath: "/bin/true" }),
    );
    expect(ausgabe).not.toContain("fatal error");
    expect(ausgabe).not.toContain("bad unit file setting");
    expect(code).toBe(0);
  });

  test.skipIf(!haveSystemdAnalyze())("GEGENPROBE: ein gequotetes WorkingDirectory würde auffallen", () => {
    // Ohne diese Zeile wüsste niemand, ob `verify` den Fehler überhaupt sieht —
    // ein Test, der nur „keine fatale Konfiguration" prüft, ist auch grün, wenn
    // das Werkzeug gar nichts prüft.
    const kaputt = systemdUnit(echteOpts()).replace(/^WorkingDirectory=(.*)$/m, 'WorkingDirectory="$1"');
    const { code, ausgabe } = verify(kaputt);
    expect(ausgabe).toContain("fatal error");
    expect(code).not.toBe(0);
  });
});

describe("der erzeugte Caddy-Block ist gültiges Caddyfile", () => {
  function validate(block: string): string {
    const dir = mkdtempSync(join(tmpdir(), "regoro-caddy-"));
    const file = join(dir, "Caddyfile");
    writeFileSync(file, `{\n auto_https off\n admin off\n}\n${block}`);
    const res = Bun.spawnSync(["caddy", "validate", "--config", file, "--adapter", "caddyfile"]);
    rmSync(dir, { recursive: true, force: true });
    return new TextDecoder().decode(res.stderr) + new TextDecoder().decode(res.stdout);
  }

  // skipIf statt eines stillen `return`: ein übersprungener Test soll sichtbar
  // übersprungen sein, nicht wie ein bestandener aussehen. Der Release-Workflow
  // installiert caddy, dort läuft die Validierung also wirklich.
  test.skipIf(!haveCaddy())("caddy validate akzeptiert ihn", () => {
    // Port statt Domain, damit caddy kein ACME versucht.
    expect(validate(caddyBlock({ ...base, domain: ":8099" }))).toContain("Valid configuration");
  });

  test.skipIf(!haveCaddy())("auch mit einem Site-Pfad voller Leerzeichen", () => {
    const block = caddyBlock({ ...base, domain: ":8099", siteDir: "/srv/Meine Firma/site" });
    expect(validate(block)).toContain("Valid configuration");
  });
});

// ===========================================================================
// Sammelbetrieb (`--multi`): ein Dienst, ein Caddy-Block, alle Kundendomains
// ===========================================================================
const baseMulti = {
  siteDir: "/srv/sites", // im Sammelbetrieb ist das das Sammelverzeichnis
  execPath: "/home/aufi/.local/bin/regoro",
  slug: "sites",
  port: 8788,
  user: "www-data",
  multi: true,
};

/**
 * Der Staging-Betrieb (`regoro serve --staging`): ein Hostname, viele Previews
 * unter `/p/<slug>/`, KEINE Anmeldung. Eigener Block, eigener Matcher.
 */
const baseStaging = {
  siteDir: "/srv/previews",
  execPath: "/home/aufi/.local/bin/regoro",
  slug: "previews",
  port: 8790,
  user: "www-data",
  staging: true,
  domain: "intern.example.com",
};

describe("systemdUnit --multi", () => {
  test("ExecStart ruft `serve` auf das Sammelverzeichnis", () => {
    const unit = systemdUnit(baseMulti);
    expect(unit).toContain('ExecStart="/home/aufi/.local/bin/regoro" serve "/srv/sites"');
    expect(unit).toContain("WorkingDirectory=/srv/sites"); // ohne Quoting, siehe oben
    expect(unit).toContain('ReadWritePaths="/srv/sites"');
    expect(unit).not.toContain(" run ");
  });

  test("ProtectHome-Regel gilt auch für das Sammelverzeichnis", () => {
    expect(systemdUnit({ ...baseMulti, siteDir: "/home/aufi/sites" })).not.toContain("ProtectHome=yes");
    expect(systemdUnit(baseMulti)).toContain("ProtectHome=yes");
  });
});

describe("systemdUnit --staging", () => {
  test("ExecStart ruft `serve --staging` — nicht `serve` und nicht `run`", () => {
    /**
     * DIE GEFÄHRLICHE VERWECHSLUNG GEHT IN BEIDE RICHTUNGEN, aber nur eine
     * davon ist still: Fehlte `--staging`, liefe hinter der Preview-Adresse ein
     * Produktionsprozess — die Previews wären schlicht 404, das fällt sofort
     * auf. Stünde `--staging` umgekehrt in der Unit einer Kundendomain, stünde
     * deren Editor OHNE ANMELDUNG offen, und niemandem fiele etwas auf.
     *
     * Deshalb wird hier nicht nur die Anwesenheit der Fahne geprüft, sondern
     * auch, dass die beiden anderen Betriebsformen sie NICHT tragen.
     */
    const unit = systemdUnit(baseStaging);
    expect(unit).toContain('ExecStart="/home/aufi/.local/bin/regoro" serve --staging "/srv/previews"');
    expect(unit).toContain("WorkingDirectory=/srv/previews"); // ohne Quoting, siehe oben
    expect(unit).toContain('ReadWritePaths="/srv/previews"');
  });

  test("GEGENPROBE: Einzel- und Sammelbetrieb tragen die Fahne NICHT", () => {
    expect(systemdUnit(base)).not.toContain("--staging");
    expect(systemdUnit(baseMulti)).not.toContain("--staging");
  });

  test("die Beschreibung sagt, dass hier keine Anmeldung nötig ist", () => {
    // Ein Betreiber, der `systemctl status` liest, soll es dort sehen — das ist
    // die Stelle, an der er es sieht, bevor er den Dienst vor eine Kundenseite
    // hängt.
    expect(systemdUnit(baseStaging)).toMatch(/Description=.*STAGING/);
  });
});

describe("caddyBlock --multi", () => {
  const block = caddyBlock(baseMulti);

  test("ein Block für alle Domains, Zertifikate on demand", () => {
    expect(block).toContain("https://");
    expect(block).toContain("on_demand");
    // Keine Domainliste, die bei jedem Neukunden gepflegt werden müsste.
    expect(block).not.toContain("example.com");
  });

  test("der Site-Root wird aus dem Host-Header gebildet", () => {
    expect(block).toContain('root * "/srv/sites/{host}"');
  });

  test("Host-Schranke VOR dem root-Platzhalter", () => {
    // Ohne sie ergibt `Host: ..` den root /srv — gemessen: Caddy liefert dann
    // Dateien eine Ebene über dem Sammelverzeichnis mit 200 aus.
    expect(block).toContain("@badhost");
    expect(block.indexOf("@badhost")).toBeLessThan(block.indexOf("root *"));
  });

  test("CADDY_HOST_RE lässt Hostnamen durch und Traversal-Formen nicht", () => {
    const re = new RegExp(CADDY_HOST_RE);
    for (const ok of ["kunde.de", "www.kunde.de", "kunde.de:8443", "a", "127.0.0.1"]) {
      expect(re.test(ok)).toBe(true);
    }
    for (const bad of [
      "..", "...", "../geheim", "/etc", ".kunde.de", "kunde.de-", "-kunde.de", "kunde de", "",
      // Gemessen: beide lieferte Caddy sonst als Ordnername aus, obwohl der
      // Editor sie ablehnt.
      "a..b", "KUNDE.DE", "kunde.de.",
    ]) {
      expect(re.test(bad)).toBe(false);
    }
  });

  test("CADDY_HOST_RE und normalizeHost ziehen dieselbe Grenze", async () => {
    // Beide Ebenen müssen sich einig sein, welcher Hostname ein Ordnername sein
    // darf — sonst liefert der Proxy etwas aus, das der Editor für inexistent hält.
    // www. und Port sind bewusst ausgenommen: die behandelt der Block separat
    // (Redirect bzw. Portgruppe), normalizeHost schneidet sie ab.
    const { normalizeHost } = await import("./sites.ts");
    const re = new RegExp(CADDY_HOST_RE);
    const kandidaten = [
      "kunde.de", "a", "a-b.c-d.example", "127.0.0.1", "localhost", "xn--knde-0ra.de",
      "a..b", "KUNDE.DE", "kunde.de.", ".kunde.de", "-kunde.de", "kunde.de-",
      "kunde de", "kunde_de", "..", "../etc", "kunde.de/../x", "",
    ];
    for (const h of kandidaten) {
      expect({ host: h, caddy: re.test(h) }).toEqual({ host: h, caddy: normalizeHost(h) === h });
    }
  });

  test("www. wird auf die Hauptdomain umgeleitet (der Ordner heißt ohne www.)", () => {
    expect(block).toContain("redir");
    expect(block).toContain("www");
  });

  test("Dotfile-Block und Extension-Allowlist bleiben (Invariante 3)", () => {
    expect(block).toContain("path_regexp (^|/)\\.");
    expect(block).toContain("*.html *.css");
    expect(block).not.toContain("*.json");
    expect(block).not.toContain("*.svg");
  });

  test("Editor-Matcher spiegelt weiterhin isEditorPath()", () => {
    const zeile = editorZeile(block);
    for (const form of ["/edit", "/edit/*", "/edit-assets/*", "*/edit"]) {
      expect(`${form}: ${zeile.split(" ").includes(form)}`).toBe(`${form}: true`);
    }
    expect(block).toContain("reverse_proxy 127.0.0.1:8788");
  });

  test("der ask-Endpunkt wird NICHT veröffentlicht", () => {
    expect(block).not.toContain("_regoro");
  });
});

describe("caddyGlobalBlock", () => {
  test("nennt den ask-Endpunkt exakt so, wie der Server ihn bedient", async () => {
    const { TLS_ASK_PATH } = await import("./server.ts");
    expect(caddyGlobalBlock(baseMulti)).toContain(`ask http://127.0.0.1:8788${TLS_ASK_PATH}`);
  });

  test("nur im Sammelbetrieb nötig — der Einzelbetrieb kennt seine Domain", () => {
    expect(caddyGlobalBlock({ ...baseMulti, multi: false })).toBe("");
  });
});

describe("der erzeugte Sammelbetrieb-Block ist gültiges Caddyfile", () => {
  test.skipIf(!haveCaddy())("caddy validate akzeptiert global + Block", () => {
    const dir = mkdtempSync(join(tmpdir(), "regoro-caddy-multi-"));
    const file = join(dir, "Caddyfile");
    // auto_https off + admin off in denselben globalen Block, sonst versucht
    // caddy beim Validieren ACME.
    const global = caddyGlobalBlock(baseMulti).replace("{\n", "{\n    auto_https off\n    admin off\n");
    writeFileSync(file, global + caddyBlock(baseMulti).replace("https://", ":8099"));
    const res = Bun.spawnSync(["caddy", "validate", "--config", file, "--adapter", "caddyfile"]);
    rmSync(dir, { recursive: true, force: true });
    const out = new TextDecoder().decode(res.stderr) + new TextDecoder().decode(res.stdout);
    expect(out).toContain("Valid configuration");
  });
});

describe("Caddyfile-Vorlagen spiegeln den Generator", () => {
  // Der historische Fehler: ein blankes file_server im Proxy unterlief die
  // Extension-Allowlist des Editors komplett (CLAUDE.md, Invariante 3). Diese
  // eine Zeile ist die Stelle, an der die beiden Pfade auseinanderlaufen.
  const ALLOWED = /^\s*@allowed path .*$/m;
  const line = (text: string) => text.match(ALLOWED)![0].trim();

  test("Einzel- und Sammelbetrieb führen dieselbe Extension-Allowlist", () => {
    expect(line(caddyBlock(baseMulti))).toBe(line(caddyBlock(base)));
  });

  test("beide Vorlagen stimmen mit dem Generator überein", () => {
    const expected = line(caddyBlock(base));
    for (const file of ["Caddyfile.example", "Caddyfile.multi.example"]) {
      const text = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect(line(text)).toBe(expected);
    }
  });

  test("die Vorlage des Sammelbetriebs enthält die Host-Schranke", () => {
    const text = readFileSync(join(import.meta.dir, "..", "Caddyfile.multi.example"), "utf8");
    expect(text).toContain(CADDY_HOST_RE);
    expect(text).toContain("on_demand_tls");
  });

  /**
   * Dieselbe Klammer wie für `@allowed`, jetzt für den Editor-Matcher — und aus
   * demselben Grund: Der dokumentierte Weg ist „Block aus der Vorlage
   * kopieren". Eine Vorlage, die die Preview-Adressen nicht kennt, liefert
   * genau dort ein 404, wo der Interessent den Editor sehen soll — und niemand
   * merkt es, weil der Generator es richtig macht.
   *
   * Absichtlich über den NAMEN des Matchers extrahiert und nicht über `path`:
   * Ob die Umsetzung bei `path` bleibt oder auf `path_regexp` wechselt, ist
   * ihre Sache. Verlangt wird, dass alle vier Stellen dasselbe sagen.
   */
  test("alle vier Stellen führen dieselbe @editor-Zeile", () => {
    const erwartet = editorZeile(caddyBlock(base));
    expect(erwartet).not.toBe("");
    expect(editorZeile(caddyBlock(baseMulti))).toBe(erwartet);
    for (const file of ["Caddyfile.example", "Caddyfile.multi.example"]) {
      const text = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect(`${file}: ${editorZeile(text)}`).toBe(`${file}: ${erwartet}`);
    }
  });

  test("und die Staging-Vorlage spiegelt den Staging-Matcher", () => {
    // Dieselbe Klammer wie oben, nur für die dritte Vorlage. Sie ist die
    // gefährlichste von allen: Hinter dem Staging-Block steht ein Editor OHNE
    // Anmeldung. Läuft sie dem Generator davon, merkt es niemand — bis eine
    // Preview stumm kaputt ist oder etwas Falsches durchreicht.
    const erwartet = editorZeile(caddyBlock(baseStaging));
    expect(erwartet).not.toBe("");
    const text = readFileSync(join(import.meta.dir, "..", "Caddyfile.staging.example"), "utf8");
    expect(`Caddyfile.staging.example: ${editorZeile(text)}`).toBe(`Caddyfile.staging.example: ${erwartet}`);
  });
});

// ===========================================================================
// Ein übersprungener Test darf nicht wie ein bestandener aussehen
// ===========================================================================
describe("die Werkzeuge dieser Datei sind da", () => {
  /**
   * `test.skipIf` wertet beim EINSAMMELN aus, vor jedem `beforeAll`. In diesem
   * Repo hat das schon vier Tests dauerhaft stillgelegt, die dabei grün
   * meldeten — die teuerste Fehlerklasse, die CLAUDE.md kennt: ein Nachweis,
   * der nicht anschlagen kann, beweist durch sein Ausbleiben nichts.
   *
   * Dieser Fall ist die Gegenmaßnahme und mit Absicht KEIN `skipIf`: Fehlt das
   * Werkzeug, wird genau eine Zeile rot und nennt es beim Namen, statt dass
   * eine Handvoll Prüfungen lautlos verschwindet. Wer hier bewusst ohne das
   * Werkzeug arbeitet, sieht die eine rote Zeile und weiß, was ihm fehlt.
   */
  test("caddy ist installiert — sonst laufen die Prüfungen auf der Leitung ins Leere", () => {
    expect(`caddy vorhanden: ${haveCaddy()}`).toBe("caddy vorhanden: true");
  });

  test("systemd-analyze ist installiert — sonst prüft die Unit niemand", () => {
    expect(`systemd-analyze vorhanden: ${haveSystemdAnalyze()}`).toBe(
      "systemd-analyze vorhanden: true",
    );
  });

});
