/**
 * `regoro service` — Generator für systemd-Unit und Caddy-Block.
 *
 * Der Caddy-Block wird gegen ECHTES caddy validiert (falls installiert): eine
 * Vorlage, die nicht parst, ist schlimmer als keine.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} from "./service.ts";

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
    const c = caddyBlock(base);
    expect(c).toContain("@editor path /edit /edit/* /edit-assets/* */edit");
    expect(c).not.toContain("@editor path /edit*\n");
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

  test("systemd: ExecStart, WorkingDirectory, ReadWritePaths sind gequotet", () => {
    const u = systemdUnit(spaced);
    // Ohne Quoting startete systemd `regoro run /srv/sites/Meine`.
    expect(u).toContain('ExecStart="/opt/my tools/regoro" run "/srv/sites/Meine Firma/site"');
    expect(u).toContain('WorkingDirectory="/srv/sites/Meine Firma/site"');
    expect(u).toContain('ReadWritePaths="/srv/sites/Meine Firma/site"');
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
