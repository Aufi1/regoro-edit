/**
 * `regoro service` — Generator für systemd-Unit und Caddy-Block.
 *
 * Der Caddy-Block wird gegen ECHTES caddy validiert (falls installiert): eine
 * Vorlage, die nicht parst, ist schlimmer als keine.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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

describe("systemdUnit --multi", () => {
  test("ExecStart ruft `serve` auf das Sammelverzeichnis", () => {
    const unit = systemdUnit(baseMulti);
    expect(unit).toContain('ExecStart="/home/aufi/.local/bin/regoro" serve "/srv/sites"');
    expect(unit).toContain('WorkingDirectory="/srv/sites"');
    expect(unit).toContain('ReadWritePaths="/srv/sites"');
    expect(unit).not.toContain(" run ");
  });

  test("ProtectHome-Regel gilt auch für das Sammelverzeichnis", () => {
    expect(systemdUnit({ ...baseMulti, siteDir: "/home/aufi/sites" })).not.toContain("ProtectHome=yes");
    expect(systemdUnit(baseMulti)).toContain("ProtectHome=yes");
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
    expect(block).toContain("path /edit /edit/* /edit-assets/* */edit");
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
});
