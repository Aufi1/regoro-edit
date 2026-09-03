/**
 * Erzeugt die Betriebs-Dateien für eine Site: eine systemd-Unit und den
 * Caddy-Block. Reine Textgenerierung, kein Dateisystem-Zugriff — `cmdService`
 * druckt das Ergebnis, der Mensch leitet es dorthin um, wo es hingehört.
 *
 * Annahme (vom Betreiber bestätigt): Die Website unter <siteDir> ist bereits
 * über ihre Domain erreichbar, idealerweise per HTTPS. Der Editor kommt daneben
 * — ein lokaler Prozess, an den der Proxy die Editor-Routen weiterreicht.
 */
import { createHash } from "node:crypto";

/**
 * Erlaubte Zeichen für `--domain`. Der Wert landet im Caddyfile UND in
 * angezeigten Shell-Befehlen; statt ihn dreifach zu quoten, wird er validiert.
 * Deckt Hostnamen, Wildcards (*.example.com) und `:8099` für lokale Tests ab.
 */
export const DOMAIN_RE = /^[a-zA-Z0-9.*-]*(:\d{1,5})?$/;

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
  /** Site-Ordner — im Sammelbetrieb (`multi`) das SAMMELVERZEICHNIS. */
  siteDir: string;
  execPath: string;
  slug: string;
  port: number;
  user: string;
  domain?: string;
  /**
   * Sammelbetrieb: ein Dienst für alle Kundenwebsites unter `siteDir`, ein
   * Caddy-Block für alle Domains. Ohne das Flag bleibt alles wie bisher.
   */
  multi?: boolean;
}

/**
 * Grammatik, die ein Host-Header erfüllen MUSS, bevor er im Sammelbetrieb in den
 * root-Pfad eingesetzt wird. Spiegelt HOST_RE in sites.ts Zeichen für Zeichen
 * (plus optionalem Port) — per Test aneinander gebunden.
 *
 * Warum so streng, und warum ausdrücklich nur Kleinbuchstaben: Caddys `{host}`
 * ist der Host-Header WÖRTLICH, ohne jede Normalisierung. Was hier durchkommt,
 * wird unverändert zum Verzeichnisnamen. Zwei gemessene Fälle (caddy 2.11):
 *   - `Host: ..` ergibt den root `<sitesRoot>/..` und liefert Dateien EINE EBENE
 *     ÜBER dem Sammelverzeichnis mit 200 aus. (Go weist einen Host mit "/" selbst
 *     ab (400), reine Punkte nicht.)
 *   - Eine laxere Fassung ließ `a..b` und `KUNDE.DE` durch. Beide lehnt der
 *     Editor ab, Caddy lieferte den gleichnamigen Ordner trotzdem öffentlich aus
 *     — ein Publikationsweg, den der Betreiber in keinem Editor-Werkzeug sieht.
 * Beide Ebenen müssen dieselbe Grenze ziehen, sonst ist die Grenze keine.
 */
export const CADDY_HOST_RE =
  "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]+)?$";

/**
 * Liegt der Site-Ordner unter /home oder /root? Dann darf `ProtectHome=yes` NICHT
 * gesetzt werden: systemd macht diese Verzeichnisse dann leer und unzugänglich,
 * und `ReadWritePaths` hebt das nicht auf — der Dienst startet nicht.
 */
export function siteIsUnderHome(siteDir: string): boolean {
  return siteDir === "/home" || siteDir === "/root" ||
    siteDir.startsWith("/home/") || siteDir.startsWith("/root/");
}

/**
 * Quotet einen Pfad für systemd-Unit-Dateien.
 *
 * systemd zerlegt `ExecStart=` und `ReadWritePaths=` an Leerzeichen. Ein Ordner
 * „/srv/sites/Meine Firma/site" startete sonst `regoro run /srv/sites/Meine` —
 * der Dienst liefe auf dem falschen Pfad oder gar nicht. systemd akzeptiert
 * dort doppelte Anführungszeichen, \\ und " werden darin escaped.
 *
 * NICHT für `WorkingDirectory=` benutzen — siehe sdPfad().
 */
export function sdQuote(s: string): string {
  return `"${s.replace(/(["\\])/g, "\\$1")}"`;
}

/**
 * Pfad für Direktiven, die GENAU EINEN Pfad nehmen (`WorkingDirectory=`) —
 * also unverändert, ohne Anführungszeichen.
 *
 * Gemessen auf systemd 255, beide Wege:
 *   WorkingDirectory="/tmp"  → systemd-analyze verify: „path is not absolute",
 *                              systemd-run: „Failed to start transient service
 *                              unit: WorkingDirectory= expects an absolute path".
 *                              Die Unit startet NICHT.
 *   WorkingDirectory=/tmp/mit raum → läuft, Leerzeichen und alles.
 *
 * Der Grund: Quoting gilt in Unit-Dateien für Einstellungen, die eine LISTE
 * lesen. `WorkingDirectory=` nimmt den Rest der Zeile wörtlich — die
 * Anführungszeichen werden Teil des Pfades, und der beginnt dann mit `"`
 * statt mit `/`. Leerzeichen sind hier gerade deshalb unproblematisch.
 *
 * Nicht „vereinheitlichen": Für `ExecStart=` sind die Anführungszeichen
 * umgekehrt zwingend (dort nachgemessen: ungequotet bricht ein Pfad mit
 * Leerzeichen mit „Command /tmp/claude-1002/mit is not executable").
 */
export function sdPfad(s: string): string {
  return s;
}

/**
 * Quotet einen Pfad für ein Caddyfile-Argument (`root * <pfad>`).
 * Caddy trennt Argumente an Leerzeichen und kennt doppelte Anführungszeichen.
 */
export function caddyQuote(s: string): string {
  return `"${s.replace(/(["\\])/g, "\\$1")}"`;
}

/**
 * Aktivierung im Sammelbetrieb. Unterschied zum Einzelbetrieb: der globale
 * on_demand_tls-Block muss GANZ OBEN in der Caddyfile stehen — `tee -a` würde
 * ihn ans Ende hängen, wo Caddy ihn nicht akzeptiert.
 */
function activationStepsMulti(o: ServiceOpts, unit: string): string {
  return `# 1. Unit schreiben und starten
regoro service ${shQuote(o.siteDir)} --multi --systemd | sudo tee /etc/systemd/system/${unit}.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now ${unit}

# 2. Caddy: den globalen Block GANZ OBEN einfügen (nicht anhängen!), den
#    Site-Block darunter. Beides gibt \`regoro service ${shQuote(o.siteDir)} --multi --caddy\` aus.
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy

# 3. Prüfen — je Kundenwebsite ein Ordner unter ${o.siteDir}
systemctl status ${unit}
ls ${shQuote(o.siteDir)}
curl -sI https://<eine-kundendomain>/edit/login | head -1`;
}

/** Quotet einen Pfad für POSIX-sh (angezeigte Copy-Paste-Befehle). */
export function shQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`;
}

/** systemd-Unit. Bewusst schmal: kein Netzwerkzugriff nötig, nur der Site-Ordner. */
export function systemdUnit(o: ServiceOpts): string {
  const command = o.multi ? "serve" : "run";
  const protectHome = siteIsUnderHome(o.siteDir)
    ? `# ProtectHome bewusst NICHT gesetzt: die Site liegt unter /home bzw. /root,
# systemd würde das Verzeichnis leeren und der Dienst käme nicht hoch.`
    : "ProtectHome=yes";
  return `[Unit]
Description=Regoro Editor — ${o.slug}${o.multi ? " (Sammelbetrieb)" : ""}
Documentation=https://github.com/Aufi1/regoro-edit
After=network.target

[Service]
Type=simple
User=${o.user}
WorkingDirectory=${sdPfad(o.siteDir)}
Environment=PORT=${o.port}
ExecStart=${sdQuote(o.execPath)} ${command} ${sdQuote(o.siteDir)}
Restart=on-failure
RestartSec=2

# Der Editor braucht nur seinen Site-Ordner und das git-Binary. Alles andere zu.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
${protectHome}
ReadWritePaths=${sdQuote(o.siteDir)}
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
  if (o.multi) return caddyBlockMulti(o);
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
    # Muss isEditorPath() in host.ts spiegeln. \`/edit*\` allein reicht NICHT: es
    # verfehlt die Suffix-Routen \`/impressum.html/edit\` und fängt zugleich
    # öffentliche Seiten wie \`/edit-preise.html\` ein.
    @editor path /edit /edit/* /edit-assets/* */edit
    handle @editor {
        reverse_proxy 127.0.0.1:${o.port}
    }

    # Statische Site: NUR bekannte Dateitypen. Ein Site-Ordner enthält oft mehr
    # als die Website (Build-Artefakte, Backups, Notizen); der Editor verweigert
    # die per Extension-Allowlist, ein blankes file_server hier nicht.
    @allowed path / */ *.html *.css *.js *.png *.jpg *.jpeg *.webp *.gif *.ico *.woff *.woff2 *.txt *.xml
    handle @allowed {
        root * ${caddyQuote(o.siteDir)}
        file_server
    }

    handle {
        respond 404
    }
}
`;
}

/**
 * Globale Caddy-Optionen für den Sammelbetrieb. MUSS ganz oben in der Caddyfile
 * stehen (Caddy erlaubt genau einen globalen Block, und nur als erstes).
 *
 * `on_demand_tls` ohne `ask` wäre grob fahrlässig: dann kann jeder fremde
 * Hostname auf diesen Server zeigen und Zertifikatsanfragen auslösen, bis Let's
 * Encrypt drosselt. regoro antwortet dort nur für Ordner, die es wirklich gibt.
 * Der Pfad muss TLS_ASK_PATH in server.ts entsprechen (per Test festgenagelt).
 */
export function caddyGlobalBlock(o: ServiceOpts): string {
  if (!o.multi) return "";
  return `{
    on_demand_tls {
        ask http://127.0.0.1:${o.port}/_regoro/tls-ask
    }
}
`;
}

/**
 * Caddy-Block für den Sammelbetrieb: EIN Block für alle Kundendomains, keine
 * Domainliste, die bei jedem Neukunden gepflegt werden müsste.
 *
 * Der Editor-Matcher spiegelt weiterhin isEditorPath(), die Extension-Allowlist
 * weiterhin ASSET_TYPES (Invariante 3) — beide ändern sich nicht dadurch, dass
 * der root-Pfad jetzt aus dem Host-Header entsteht.
 */
function caddyBlockMulti(o: ServiceOpts): string {
  return `# Sammelbetrieb: ein Block für ALLE Kundendomains. Welcher Ordner gemeint
# ist, entscheidet der Host-Header — hier über {host}, im Editor über
# normalizeHost() in sites.ts. Der Ordnername IST die Domain.
#
# Voraussetzung: der globale on_demand_tls-Block steht GANZ OBEN in der Caddyfile
# (regoro service --multi --caddy gibt ihn mit aus).
https:// {
    encode gzip

    tls {
        on_demand
    }

    # Der Host-Header ist Nutzereingabe und landet unten im root-Pfad. Gemessen:
    # ohne diese Schranke liefert \`Host: ..\` Dateien EINE EBENE ÜBER dem
    # Sammelverzeichnis aus (200). Go lehnt "/" im Host selbst ab, reine Punkte nicht.
    @badhost {
        not header_regexp Host ${CADDY_HOST_RE}
    }
    handle @badhost {
        respond 404
    }

    # www.kunde.de → kunde.de. Der Ordner heißt ohne www.; normalizeHost() im
    # Editor schneidet es ebenfalls ab, aber file_server hier tut das nicht.
    @www header_regexp www Host ^[Ww][Ww][Ww]\\.(.+)$
    redir @www https://{re.www.1}{uri} permanent

    # Auth-Datei + alle Dotfiles, in jeder Tiefe. Regexp, kein Glob:
    # \`path /.*\` deckt nur führende Punkte, /assets/.geheim.html käme durch.
    @hidden path_regexp (^|/)\\.
    handle @hidden {
        respond 404
    }

    # Editor-Routen an den Bun-Prozess. Auth + Sessions laufen dort, die
    # Zuordnung zur Website ebenfalls (Host-Header).
    # Muss isEditorPath() in host.ts spiegeln. \`/edit*\` allein reicht NICHT: es
    # verfehlt die Suffix-Routen \`/impressum.html/edit\` und fängt zugleich
    # öffentliche Seiten wie \`/edit-preise.html\` ein.
    @editor path /edit /edit/* /edit-assets/* */edit
    handle @editor {
        reverse_proxy 127.0.0.1:${o.port}
    }

    # Statische Site: NUR bekannte Dateitypen, aus dem Ordner DIESER Domain.
    # {host} ist der Host-Header WÖRTLICH — Caddy normalisiert ihn nicht. Deshalb
    # lässt @badhost oben nur Kleinbuchstaben und echte Label durch: sonst läge
    # \`Host: KUNDE.DE\` oder \`a..b\` als Ordnername im Pfad, während der Editor
    # denselben Host ablehnt. Ordner IMMER kleingeschrieben und ohne www. anlegen.
    @allowed path / */ *.html *.css *.js *.png *.jpg *.jpeg *.webp *.gif *.ico *.woff *.woff2 *.txt *.xml
    handle @allowed {
        root * ${caddyQuote(`${o.siteDir}/{host}`)}
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
  if (o.multi) return activationStepsMulti(o, unit);
  const domainFlag = o.domain ? ` --domain ${o.domain}` : "";
  return `# 1. Unit schreiben und starten
regoro service ${shQuote(o.siteDir)} --systemd | sudo tee /etc/systemd/system/${unit}.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now ${unit}

# 2. Caddy-Block anhängen (ersetzt einen bestehenden Block für die Domain!)
regoro service ${shQuote(o.siteDir)} --caddy${domainFlag} | sudo tee -a /etc/caddy/Caddyfile > /dev/null
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy

# 3. Prüfen
systemctl status ${unit}
curl -sI https://${o.domain ?? "deine-domain.de"}/edit/login | head -1`;
}
