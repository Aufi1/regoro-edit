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
    expect(u).toContain("ExecStart=/home/aufi/.local/bin/regoro run /srv/sites/mueller");
    expect(u).toContain("Environment=PORT=8829");
    expect(u).toContain("User=www-data");
    expect(u).toContain("ReadWritePaths=/srv/sites/mueller");
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
    expect(u).toContain("ReadWritePaths=/home/aufi/repos/kunde/site");
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
    expect(c).toContain("root * /srv/sites/mueller");
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
    expect(s).toContain("regoro service /srv/sites/mueller --systemd | sudo tee");
    expect(s).not.toContain("< /dev/null"); // hätte die Datei geleert
    expect(s).toContain("systemctl enable --now regoro-mueller");
    expect(s).toContain("caddy validate");
  });
});

describe("der erzeugte Caddy-Block ist gültiges Caddyfile", () => {
  test("caddy validate akzeptiert ihn", () => {
    const probe = Bun.spawnSync(["caddy", "version"]);
    if (probe.exitCode !== 0) {
      console.log("  (caddy nicht installiert — Validierung übersprungen)");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "regoro-caddy-"));
    const file = join(dir, "Caddyfile");
    // auto_https off + Port statt Domain, damit caddy kein ACME versucht.
    const block = caddyBlock({ ...base, domain: ":8099" });
    writeFileSync(file, `{\n auto_https off\n admin off\n}\n${block}`);

    const res = Bun.spawnSync(["caddy", "validate", "--config", file, "--adapter", "caddyfile"]);
    const out = new TextDecoder().decode(res.stderr) + new TextDecoder().decode(res.stdout);

    rmSync(dir, { recursive: true, force: true });
    expect(out).toContain("Valid configuration");
    expect(res.exitCode).toBe(0);
  });
});
