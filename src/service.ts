/**
 * Erzeugt die Betriebs-Dateien für eine Site: eine systemd-Unit und den
 * Caddy-Block. Reine Textgenerierung, kein Dateisystem-Zugriff — `cmdService`
 * druckt das Ergebnis, der Mensch leitet es dorthin um, wo es hingehört.
 *
 * Annahme (vom Betreiber bestätigt): Die Website unter <siteDir> ist bereits
 * über ihre Domain erreichbar, idealerweise per HTTPS. Der Editor kommt daneben
 * — ein lokaler Prozess, an den der Proxy nur `/edit*` weiterreicht.
 */
import { basename } from "node:path";
import { createHash } from "node:crypto";

/** Ports, aus denen der Default gewählt wird. 8788 bleibt für `regoro run` frei. */
const PORT_BASE = 8800;
const PORT_RANGE = 200;

/**
 * Kürzt einen Site-Pfad auf einen systemd-tauglichen Namen: [a-z0-9-].
 * "…/nuernberg-haustechnik-rossmeisl-7a5f8c87/site" → "site" wäre nutzlos,
 * deshalb wird bei generischen Namen der Elternordner mitgenommen.
 */
export function serviceSlug(siteDir: string): string {
  const generic = new Set(["site", "public", "www", "html", "dist", "build", "site-gold"]);
  const parts = siteDir.split("/").filter(Boolean);
  const last = parts.at(-1) ?? "site";
  const name = generic.has(last) && parts.length > 1 ? `${parts.at(-2)}-${last}` : last;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "site";
}

/**
 * Deterministischer Port aus dem Slug. Gleiche Site → gleicher Port, auch nach
 * einem Neustart oder auf einer zweiten Maschine. Bei mehreren Sites auf einem
 * Host kollidieren zwei Slugs mit ~0,5 % Wahrscheinlichkeit — dann `--port`.
 */
export function servicePort(slug: string): number {
  const h = createHash("sha256").update(slug).digest();
  return PORT_BASE + ((h[0]! << 8) | h[1]!) % PORT_RANGE;
}

export interface ServiceOpts {
  siteDir: string;
  execPath: string;
  slug: string;
  port: number;
  user: string;
  domain?: string;
}

/**
 * Liegt der Site-Ordner unter /home oder /root? Dann darf `ProtectHome=yes` NICHT
 * gesetzt werden: systemd macht diese Verzeichnisse dann leer und unzugänglich,
 * und `ReadWritePaths` hebt das nicht auf — der Dienst startet nicht.
 */
export function siteIsUnderHome(siteDir: string): boolean {
  return siteDir === "/home" || siteDir === "/root" ||
    siteDir.startsWith("/home/") || siteDir.startsWith("/root/");
}

/** systemd-Unit. Bewusst schmal: kein Netzwerkzugriff nötig, nur der Site-Ordner. */
export function systemdUnit(o: ServiceOpts): string {
  const protectHome = siteIsUnderHome(o.siteDir)
    ? `# ProtectHome bewusst NICHT gesetzt: die Site liegt unter /home bzw. /root,
# systemd würde das Verzeichnis leeren und der Dienst käme nicht hoch.`
    : "ProtectHome=yes";
  return `[Unit]
Description=Regoro Editor — ${o.slug}
Documentation=https://github.com/Aufi1/regoro-edit
After=network.target

[Service]
Type=simple
User=${o.user}
WorkingDirectory=${o.siteDir}
Environment=PORT=${o.port}
ExecStart=${o.execPath} run ${o.siteDir}
Restart=on-failure
RestartSec=2

# Der Editor braucht nur seinen Site-Ordner und das git-Binary. Alles andere zu.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
${protectHome}
ReadWritePaths=${o.siteDir}
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Caddy-Block. Ersetzt den bestehenden Block der Domain, statt ihn zu ergänzen:
 * Die Allowlist muss VOR dem `file_server` greifen, sonst liefert der Proxy
 * Build-Artefakte aus, die der Editor selbst verweigert (siehe Caddyfile.example).
 */
export function caddyBlock(o: ServiceOpts): string {
  const domain = o.domain ?? "example.com";
  return `${domain} {
    encode gzip

    # Auth-Datei + alle Dotfiles, in jeder Tiefe. Regexp, kein Glob:
    # \`path /.*\` deckt nur führende Punkte, /assets/.geheim.html käme durch.
    @hidden path_regexp (^|/)\\.
    handle @hidden {
        respond 404
    }

    # Editor-Routen an den Bun-Prozess. Auth + Sessions laufen dort.
    @editor path /edit*
    handle @editor {
        reverse_proxy 127.0.0.1:${o.port}
    }

    # Statische Site: NUR bekannte Dateitypen. Ein Site-Ordner enthält oft mehr
    # als die Website (Build-Artefakte, Backups, Notizen); der Editor verweigert
    # die per Extension-Allowlist, ein blankes file_server hier nicht.
    @allowed path / */ *.html *.css *.js *.png *.jpg *.jpeg *.webp *.gif *.ico *.woff *.woff2 *.txt *.xml
    handle @allowed {
        root * ${o.siteDir}
        file_server
    }

    handle {
        respond 404
    }
}
`;
}

/**
 * Die Befehle, die den Dienst tatsächlich starten — copy-paste-fähig.
 * Die Unit-Datei entsteht durch `regoro service --systemd`, nicht durch Abtippen.
 */
export function activationSteps(o: ServiceOpts): string {
  const unit = `regoro-${o.slug}`;
  const domainFlag = o.domain ? ` --domain ${o.domain}` : "";
  return `# 1. Unit schreiben und starten
regoro service ${o.siteDir} --systemd | sudo tee /etc/systemd/system/${unit}.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now ${unit}

# 2. Caddy-Block anhängen (ersetzt einen bestehenden Block für die Domain!)
regoro service ${o.siteDir} --caddy${domainFlag} | sudo tee -a /etc/caddy/Caddyfile > /dev/null
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy

# 3. Prüfen
systemctl status ${unit}
curl -sI https://${o.domain ?? "deine-domain.de"}/edit/login | head -1`;
}
