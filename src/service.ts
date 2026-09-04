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
 *
 * `http://` ist ausdrücklich erlaubt, weil Caddy die Site sonst als HTTPS führt:
 * Gemessen antwortet `--domain localhost:18081` beim lokalen Ausprobieren mit
 * „Client sent an HTTP request to an HTTPS server", selbst bei `auto_https off`.
 * Mehr als dieses eine Schema nicht — der Wert landet ungeprüft im Caddyfile.
 */
export const DOMAIN_RE = /^(http:\/\/)?[a-zA-Z0-9.*-]*(:\d{1,5})?$/;

/**
 * Die URL, unter der der Editor nach der Einrichtung erreichbar ist — für die
 * `curl`-Zeile der Aktivierungsschritte.
 *
 * Bringt die Domain schon ein Schema mit (`http://localhost:18081` beim lokalen
 * Ausprobieren), darf kein zweites davor: `https://http://…` wäre Unsinn.
 * Sonst gilt https, denn das Auth-Cookie ist `Secure`.
 */
function editorUrl(domain: string): string {
  return /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
}

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
  /**
   * Staging: ein Dienst für alle Previews unter `siteDir`, EIN Hostname, die
   * Zuordnung über `/p/<slug>/`. Schließt `multi` aus.
   */
  staging?: boolean;
  /**
   * Browser-Herkünfte, die die CSP zusätzlich zulässt — aus
   * `alleBrowserHerkuenfte()` der Integrationen DIESER Website. Leer oder
   * fehlend heißt `connect-src 'none'`, also der geschlossene Normalfall.
   */
  browserHerkuenfte?: string[];
  /**
   * Nur Sammelbetrieb: Herkünfte je Domain. Der Block ist EINER für alle
   * Kunden, die Freischaltungen sind es nicht — eine Vereinigungsmenge machte
   * eine für Kunde A freigeschaltete Herkunft auch auf Kundenseite B ladbar
   * und höhlte damit Invariante 10 aus. Deshalb je betroffener Domain ein
   * eigener Zweig; wer keine Integration nutzt, bekommt die Standard-CSP und
   * eine Ausgabe, die zeichengleich mit der von früher ist.
   */
  herkuenfteJeHost?: Record<string, string[]>;
}

/**
 * Die Content-Security-Policy der ausgelieferten Website — die dritte der drei
 * Grenzen des KI-Editors, und die einzige, die im Browser des BESUCHERS wirkt.
 *
 * Sie steht bewusst hier und nicht im HTML: Der Agent schreibt HTML, also wäre
 * eine Grenze im HTML eine, die er umschreiben kann. Der Caddy-Block liegt
 * außerhalb seiner Reichweite.
 *
 * `'unsafe-inline'` bei `script-src` ist Absicht und ein bekannter Kompromiss:
 * Die Fabrik liefert Inline-Skripte aus — Kopfzeile gegen Layout-Sprung,
 * JSON-LD. An echten Kundenseiten dreimal unabhängig nachgezählt, mit
 * unterschiedlichen Zahlen (8, 12, 13 Blöcke) und einem gleichbleibenden
 * Befund: **keiner davon hat ein `src`**. Die genaue Zahl schwankt je
 * Fabrik-Seite und ist nicht die Aussage; die Aussage ist „alle inline".
 * Ohne `'unsafe-inline'` wäre jeder einzelne davon tot.
 *
 * `connect-src 'none'` ist der Kern: kein fetch, kein XHR, kein sendBeacon,
 * kein WebSocket. Zusammen mit `img-src 'self' data:` (kein Bild-Beacon) und
 * `form-action 'self'` sind die stillen Abflüsse zu. Was CSP NICHT verhindert,
 * ist eine Weiterleitung — dafür gibt es keine Direktive. Das ist ein
 * sichtbarer Angriff und über die Versionsliste in einem Klick zurückgenommen.
 */
export function cspWert(browserHerkuenfte: string[] = []): string {
  const frei = browserHerkuenfte.join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${frei ? ` ${frei}` : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // 'none' neben einer Quelle ist laut Spezifikation ungültig; Browser
    // verwerfen dann die GANZE Direktive und lassen anschließend alles durch.
    // Entweder 'none' oder Quellen — nie beides.
    `connect-src ${frei || "'none'"}`,
    "form-action 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** Die fertige Caddy-Direktive. Eine Stelle, damit Generator und Vorlagen nicht driften. */
function cspZeile(browserHerkuenfte: string[] = []): string {
  return `header Content-Security-Policy "${cspWert(browserHerkuenfte)}"`;
}

/**
 * Spiegelt `X-Content-Type-Options` aus SECURITY_HEADERS (host.ts) in den
 * statischen Zweig. In Produktion liefert Caddy die Website direkt aus, der
 * Bun-Host ist dafür gar nicht im Pfad — ohne diese Zeile gilt die Zusicherung
 * nur für Editor-Antworten und nicht für das, was der Besucher sieht.
 *
 * Wogegen: ein Polyglot-Asset mit gültiger Bild-Signatur und eingebettetem
 * HTML/JS. Für `.txt`, `.xml`, Bilder und Schriften fällt der Validator
 * ausdrücklich kein Inhaltsurteil, der Agent darf sie also frei befüllen.
 *
 * DIE BEIDEN ANDEREN HEADER AUS SECURITY_HEADERS GEHÖREN HIER NICHT HER — sie
 * gelten dem Editor, nicht der Website, und wären hier ein echter Schaden:
 *   - `X-Robots-Tag: noindex, nofollow` nähme jede Kundenwebsite aus dem Index.
 *   - `Cache-Control: no-store` verböte jedes Zwischenspeichern der Seite.
 * „Header-Parität" ist deshalb das falsche Ziel; gespiegelt wird, was den
 * ausgelieferten INHALT absichert, nicht was den Editor privat hält.
 */
const NOSNIFF_ZEILE = 'header X-Content-Type-Options "nosniff"';

/**
 * Begründung für `flush_interval -1`, wörtlich gleich in beiden Blöcken und in
 * beiden Vorlagen.
 *
 * Ehrlich gemessen (caddy 2.11.4, Upstream schweigt 4 s): Der KÖRPER wird auch
 * ohne diese Zeile nicht gepuffert, die Ereignisse kommen einzeln an. Was Caddy
 * zurückhält, sind die ANTWORT-HEADER — es gibt sie erst mit dem ersten
 * Körper-Byte heraus, und daran ändert `flush_interval` nichts (4,00 s mit wie
 * ohne). Die Abhilfe dafür liegt im Editor selbst: Er schickt beim Verbinden
 * sofort einen SSE-Kommentar. Die Zeile bleibt trotzdem stehen — sie kostet
 * nichts, schaltet jede spätere Pufferung sicher ab und hält die Absicht fest.
 */
const SSE_KOMMENTAR = `            # Der Agentenlauf meldet sich über Server-Sent Events; diese Zeile
            # schaltet jede Pufferung des Antwortkörpers ab.
            #
            # Sie ist NICHT der Grund, warum die Seitenleiste sofort aufgeht.
            # Gemessen (caddy 2.11.4, Upstream schweigt 4 s): Caddy gibt die
            # Antwort-HEADER erst mit dem ersten Körper-Byte heraus — 4,00 s,
            # mit dieser Zeile wie ohne. Dagegen hilft kein Proxy-Schalter.
            # Der Editor schickt deshalb beim Verbinden sofort einen
            # SSE-Kommentar (": verbunden\\n", ohne Leerzeile — ein
            # vollständiger Rahmen erzeugte einen Phantom-Rahmen im Client);
            # damit sind es 0,002 s.
            # Wer hier eine Verzögerung sucht, sucht an der falschen Stelle.`;

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
 * Die Zeile, die Editor-Routen an den Bun-Prozess reicht — EINE Definition für
 * Einzel- und Sammelbetrieb, damit die beiden nicht auseinanderlaufen.
 *
 * Muss `isEditorPath()` in host.ts spiegeln. `/edit*` allein reicht NICHT: es
 * verfehlt die Suffix-Route `/impressum.html/edit` (in Produktion war der Editor
 * damit für JEDE Unterseite 404) und fängt zugleich öffentliche Seiten wie
 * `/edit-preise.html` ein.
 *
 * **Warum jedes dieser Muster genau EINEN Stern trägt** — das ist keine
 * Schönheit, sondern die Bedingung, unter der es überhaupt funktioniert.
 * Gemessen mit caddy 2.11.4 auf der Leitung: Caddys `path`-Matcher hat zwei
 * Semantiken. Ein EINZELNER Stern am Anfang oder Ende ist ein Suffix- bzw.
 * Präfix-Vergleich und überquert Schrägstriche; ab dem ZWEITEN Stern gilt
 * Go-`path.Match`, und dort steht ein Stern für GENAU EIN Segment.
 *
 *   "/edit/" + Stern                  ein Stern, am Ende → `/edit/agent/events` trifft ✓
 *   "/p/" + Stern + "/edit/" + Stern  zwei Sterne        → dasselbe fällt DURCH ✗
 *
 * (In Sternen ausgeschrieben, weil die zweite Zeile sonst diesen
 * Kommentarblock beendete — der Stern-Schrägstrich schließt ihn.)
 *
 * Deshalb kann diese Glob-Form das Staging-Präfix nicht ausdrücken (das Präfix
 * erzwänge den zweiten Stern) — der Staging-Block benutzt `path_regexp`.
 */
const EDITOR_MATCHER = "@editor path /edit /edit/* /edit-assets/* /edit-vorschau/* */edit";

/**
 * Der Slug-Anteil des Staging-Matchers. Spiegelt `SLUG_RE` in sites.ts Zeichen
 * für Zeichen — per Test aneinander gebunden, genau wie `CADDY_HOST_RE` und
 * `HOST_RE`.
 *
 * Anders als dort ist das hier KEINE Traversal-Schranke: Im Staging setzt Caddy
 * nichts aus der Anfrage in einen Dateipfad ein (es gibt kein `root`, kein
 * `file_server` — alles geht an den Bun-Prozess). Die Zeichenprüfung sorgt
 * allein dafür, dass Caddy nicht LAXER urteilt als der Editor: Alles, was hier
 * fälschlich als Editor-Pfad durchginge, verlöre die Content-Security-Policy,
 * die der öffentliche Zweig setzt.
 */
export const CADDY_SLUG_RE = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";

/**
 * Der Editor-Matcher des Staging-Betriebs, als Regexp statt als Glob.
 *
 * Spiegelt `isEditorPath()` Alternative für Alternative, unter dem Präfix:
 *   `edit`              ← path === "/edit"
 *   `edit/.*`           ← path.startsWith("/edit/")
 *   `edit-assets/.*`    ← path.startsWith("/edit-assets/")
 *   `edit-vorschau/.*`  ← path.startsWith("/edit-vorschau/")   (C11)
 *   `[a-z0-9-]+\.html/edit` ← die Suffix-Route
 *
 * Die letzte Alternative ist bewusst enger als `isEditorPath()` (das jedes
 * `*.html/edit` in jeder Tiefe nimmt) und deckt genau die Route ab, die
 * `route()` wirklich auflöst. Strenger darf der Proxy sein, laxer nie.
 *
 * Gemessen mit echtem caddy über 82 Pfade, 0 Abweichungen — darunter die
 * Gegenproben, die NICHT treffen dürfen: `/p/k/edit-preise.html`,
 * `/p/k/edit-vorschau-preise.html`, `/p/k/blog/edit/beitrag.html`,
 * `/p/KUNDE/edit`, `/p/kun.de/edit`, `/p/../edit`.
 */
export function editorMatcherStaging(): string {
  return (
    `@editor path_regexp ^/p/${CADDY_SLUG_RE}/` +
    String.raw`(edit|edit/.*|edit-assets/.*|edit-vorschau/.*|[a-z0-9-]+\.html/edit)$`
  );
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
curl -sI https://<eine-kundendomain>/edit/login | head -1

${KI_SCHRITTE}`;
}

/**
 * Aktivierung im Staging. Wie der Einzelbetrieb, aber mit zwei Unterschieden,
 * die man beim Einrichten sehen muss: die Fahne in der Unit und die Adresse,
 * die man dem Interessenten schickt.
 */
function activationStepsStaging(o: ServiceOpts, unit: string): string {
  const domainFlag = o.domain ? ` --domain ${o.domain}` : "";
  return `# 1. Unit schreiben und starten
regoro service ${shQuote(o.siteDir)} --staging --systemd | sudo tee /etc/systemd/system/${unit}.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now ${unit}

# 2. Caddy-Block anhängen (ersetzt einen bestehenden Block für die Domain!)
regoro service ${shQuote(o.siteDir)} --staging --caddy${domainFlag} | sudo tee -a /etc/caddy/Caddyfile > /dev/null
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy

# 3. Eine Preview anlegen: Website hineinlegen, DANN initialisieren
#    ("erst deployen, dann initialisieren" — der Baseline-Commit entsteht auf
#    dem fertigen Stand). Der Ordnername ist der Slug: nur a-z, 0-9, Bindestrich,
#    KEIN Punkt.
mkdir ${shQuote(`${o.siteDir}/beispiel-a1b2`)}
# … Website hineinkopieren …
regoro init ${shQuote(`${o.siteDir}/beispiel-a1b2`)} --nummer <deine-nummer>

# 4. Prüfen — und das ist zugleich die Adresse für den Interessenten
curl -sI ${editorUrl(o.domain ?? "intern.deine-domain.de")}/p/beispiel-a1b2/edit | head -1

# ACHTUNG: Hinter dieser Adresse ist der Editor OHNE ANMELDUNG erreichbar.
# Wer den Link hat, kann bearbeiten. Der Kostendeckel je Preview ist einmalig
# und liegt bei einer Million Token (STAGING_KONTINGENT), ohne Monatsreset.

${KI_SCHRITTE}`;
}

/**
 * Die Schritte, die nur für die KI-Seitenleiste nötig sind — gleich in beiden
 * Betriebsarten. Ohne bwrap startet kein Agentenlauf; ohne das AppArmor-Profil
 * startet bwrap auf Ubuntu nicht.
 */
const KI_SCHRITTE = `# 4. Nur für die KI-Seitenleiste: Sandbox einrichten
sudo apt install bubblewrap
regoro service --apparmor | sudo tee /etc/apparmor.d/bwrap > /dev/null
sudo apparmor_parser -r /etc/apparmor.d/bwrap
# Prüfen, dass unprivilegierte Namespaces jetzt gehen (muss "ok" ausgeben):
bwrap --ro-bind / / --unshare-pid --die-with-parent echo ok

# 5. Modellzugang (BETREIBERWEIT, einmal je Server — nicht je Kunde):
printf '%s\\n' "$OPENROUTER_SCHLUESSEL" | sudo regoro ki --key-stdin

# HINWEIS: Der Caddy-Block trägt die Content-Security-Policy der Kundenwebsites.
# Nach jedem \`regoro integration … --browser-herkunft …\` muss er NEU ERZEUGT
# und Caddy nachgeladen werden — sonst lädt der eingebaute Knopf beim Kunden
# nicht, und niemand sieht warum.`;

/** Quotet einen Pfad für POSIX-sh (angezeigte Copy-Paste-Befehle). */
export function shQuote(s: string): string {
  return `'${s.split("'").join(`'\\''`)}'`;
}

/** systemd-Unit. Bewusst schmal: kein Netzwerkzugriff nötig, nur der Site-Ordner. */
export function systemdUnit(o: ServiceOpts): string {
  // Staging ist `serve` mit einer Fahne — dieselbe Betriebsart wie der
  // Sammelbetrieb, nur mit der Zuordnung über den Pfad. Die Fahne steht in
  // ExecStart und damit im Prozess, nicht in einer Datei, die jemand mitkopiert.
  const command = o.staging ? "serve --staging" : o.multi ? "serve" : "run";
  const protectHome = siteIsUnderHome(o.siteDir)
    ? `# ProtectHome bewusst NICHT gesetzt: die Site liegt unter /home bzw. /root,
# systemd würde das Verzeichnis leeren und der Dienst käme nicht hoch.`
    : "ProtectHome=yes";
  return `[Unit]
Description=Regoro Editor — ${o.slug}${o.multi ? " (Sammelbetrieb)" : o.staging ? " (STAGING, ohne Anmeldung)" : ""}
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

# Arbeitsverzeichnis für Agentenläufe: /run/regoro-${o.slug}, von systemd
# angelegt und beim Stop geräumt. Unter ProtectSystem=strict ist es automatisch
# beschreibbar, es gehört NICHT zusätzlich in ReadWritePaths.
RuntimeDirectory=regoro-${o.slug}
RuntimeDirectoryMode=0700

# Der Modellzugang. systemd liest die Datei als root und legt sie in ein tmpfs,
# das nur dieser Dienst sieht ($CREDENTIALS_DIRECTORY). Sie muss für ${o.user}
# also gar nicht lesbar sein, steht in keinem Prozess-Environment und in keinem
# /proc-Eintrag.
#
# SetCredential ist KEIN Beiwerk: Gemessen auf systemd 255 — fehlt die Datei,
# bricht LoadCredential den Start mit status=243 ab, das Programm läuft nie an.
# Ohne die Fallback-Zeile nähme ein Update jedem Betreiber, der die KI nicht
# eingerichtet hat, den laufenden Editor weg. "{}" ist gültiges JSON ohne "v",
# loadKiConfig gibt dafür null zurück: KI aus, Dienst läuft. Fail-closed.
LoadCredential=ki:/etc/regoro/ki.json
SetCredential=ki:{}

# Der Editor braucht nur seinen Site-Ordner und das git-Binary. Alles andere zu.
#
# ProtectSystem=strict wirkt über den Mount-Namespace und damit AUCH FÜR
# KINDPROZESSE — der Agentenprozess kann es nicht abstreifen. Die Read-only-
# Flags werden beim Vererben in einen weniger privilegierten Namespace vom
# Kernel gesperrt (mount_namespaces(7)); selbst mit CAP_SYS_ADMIN im eigenen
# User-Namespace, den bwrap anlegt, scheitert ein Remount auf rw mit EPERM.
# Das ist die eigentliche Begründung, warum die Abschottung trägt. Nicht als
# "unnötig" entfernen.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
${protectHome}
ReadWritePaths=${sdQuote(o.siteDir)}
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectProc=invisible
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# Notbremse gegen einen entgleisten Agentenlauf. TasksMax gilt für den ganzen
# Cgroup einschließlich aller Kindprozesse.
MemoryHigh=2G
MemoryMax=3G
TasksMax=512
CPUQuota=200%

# ZWEI SCHALTER FEHLEN HIER MIT ABSICHT. Beide sehen nach gutem Hardening aus
# und brechen den Agentenlauf LAUTLOS — der Dienst startet, nur jeder Lauf
# scheitert, und die Ursache steht nirgends:
#
#   RestrictNamespaces=yes   sperrt ALLE Namespace-Typen. bwrap braucht
#                            mindestens user und mnt (pid je nach --unshare).
#                            Maximal vertretbar wäre RestrictNamespaces=~cgroup time
#                            — das ist eine Sperrliste, verbietet also NUR diese
#                            beiden und lässt den Rest zu.
#   SystemCallFilter=@system-service
#                            schließt @mount aus (nachgezählt mit
#                            "systemd-analyze syscall-filter @system-service":
#                            kein einziger mount-Syscall darin), und genau die
#                            braucht bwrap. Wenn überhaupt, dann
#                            SystemCallFilter=@system-service @mount
#                            plus SystemCallErrorNumber=EPERM.
#
# NoNewPrivileges=yes ist dagegen unbedenklich, solange bwrap nicht setuid ist
# (Ubuntu 24.04: -rwxr-xr-x, keine File-Capabilities — nachgesehen). Auf einem
# System mit setuid-bwrap wäre es eines.

[Install]
WantedBy=multi-user.target
`;
}

/**
 * AppArmor-Profil, ohne das bwrap auf Ubuntu ≥ 23.10 nicht startet.
 *
 * Auslieferungszustand dort ist `kernel.apparmor_restrict_unprivileged_userns=1`,
 * und das Ubuntu-bwrap hat weder Setuid-Bit noch File-Capabilities — es hängt
 * vollständig an unprivilegierten User-Namespaces. Ohne Profil scheitert jeder
 * Agentenlauf mit „Creating new namespace failed".
 *
 * Der naheliegende Ausweg `sysctl kernel.apparmor_restrict_unprivileged_userns=0`
 * ist der falsche Handel: Er hebt die Schranke für JEDEN Prozess des Hosts auf,
 * und auf diesem Host stehen öffentlich erreichbare Kundenwebsites. Ein
 * gezieltes Profil für genau eine Binärdatei ist das mildere Mittel.
 */
export function apparmorProfil(): string {
  return `# /etc/apparmor.d/bwrap
abi <abi/4.0>,
include <tunables/global>
profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
`;
}

/**
 * Caddy-Block. Ersetzt den bestehenden Block der Domain, statt ihn zu ergänzen:
 * Die Allowlist muss VOR dem `file_server` greifen, sonst liefert der Proxy
 * Build-Artefakte aus, die der Editor selbst verweigert (siehe Caddyfile.example).
 */
export function caddyBlock(o: ServiceOpts): string {
  if (o.multi) return caddyBlockMulti(o);
  if (o.staging) return caddyBlockStaging(o);
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
    #
    # HIER KEINE CSP: \`connect-src 'none'\` blockierte jedes fetch des Overlays.
    # Der Editor wäre stumm kaputt — Knöpfe reagieren, nichts wird gespeichert,
    # keine Fehlermeldung.
    # Jedes Muster trägt genau EINEN Stern. Mit zweien gälte Go-path.Match, und
    # ein Stern stünde für EIN Segment — \`/edit/agent/events\` fiele dann durch
    # (mit caddy 2.11.4 nachgemessen).
    ${EDITOR_MATCHER}
    handle @editor {
        reverse_proxy 127.0.0.1:${o.port} {
${SSE_KOMMENTAR}
            flush_interval -1
        }
    }

    # Statische Site: NUR bekannte Dateitypen. Ein Site-Ordner enthält oft mehr
    # als die Website (Build-Artefakte, Backups, Notizen); der Editor verweigert
    # die per Extension-Allowlist, ein blankes file_server hier nicht.
    @allowed path / */ *.html *.css *.js *.png *.jpg *.jpeg *.webp *.gif *.ico *.woff *.woff2 *.txt *.xml
    handle @allowed {
        root * ${caddyQuote(o.siteDir)}
        ${cspZeile(o.browserHerkuenfte)}
        ${NOSNIFF_ZEILE}
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
    #
    # HIER KEINE CSP: \`connect-src 'none'\` blockierte jedes fetch des Overlays.
    # Der Editor wäre stumm kaputt — Knöpfe reagieren, nichts wird gespeichert.
    # Jedes Muster trägt genau EINEN Stern. Mit zweien gälte Go-path.Match, und
    # ein Stern stünde für EIN Segment — \`/edit/agent/events\` fiele dann durch
    # (mit caddy 2.11.4 nachgemessen).
    ${EDITOR_MATCHER}
    handle @editor {
        reverse_proxy 127.0.0.1:${o.port} {
${SSE_KOMMENTAR}
            flush_interval -1
        }
    }

    # Statische Site: NUR bekannte Dateitypen, aus dem Ordner DIESER Domain.
    # {host} ist der Host-Header WÖRTLICH — Caddy normalisiert ihn nicht. Deshalb
    # lässt @badhost oben nur Kleinbuchstaben und echte Label durch: sonst läge
    # \`Host: KUNDE.DE\` oder \`a..b\` als Ordnername im Pfad, während der Editor
    # denselben Host ablehnt. Ordner IMMER kleingeschrieben und ohne www. anlegen.
    @allowed path / */ *.html *.css *.js *.png *.jpg *.jpeg *.webp *.gif *.ico *.woff *.woff2 *.txt *.xml
    handle @allowed {
        root * ${caddyQuote(`${o.siteDir}/{host}`)}
${cspZweigeMulti(o)}
    }

    handle {
        respond 404
    }
}
`;
}

/**
 * Caddy-Block für den Staging-Betrieb: EIN Hostname, viele Previews unter
 * `/p/<slug>/`.
 *
 * **Der Unterschied zu beiden Produktionsblöcken ist, was hier FEHLT: `root`
 * und `file_server`.** Im Staging liefert Caddy keine einzige Datei selbst aus,
 * alles geht an den Bun-Prozess. Zwei Gründe, beide zwingend:
 *
 *   1. Die öffentliche Sicht einer Preview IST der Entwurf
 *      (`<siteDir>/.regoro/entwurf`), nicht der Site-Ordner — es wird ja nie
 *      veröffentlicht. Ein `file_server` auf den Site-Ordner zeigte dem
 *      Interessenten den Ausgangsstand und nicht seine eigenen Änderungen.
 *   2. Damit gibt es hier **keinen Pfad, auf dem ein Name aus der ANFRAGE in
 *      einen Dateipfad gerät**. Die ganze `@badhost`/`CADDY_HOST_RE`-Familie des
 *      Sammelbetriebs entfällt konstruktiv statt per Regel — dort ist sie nötig,
 *      weil `{host}` im `root` steht.
 *
 * Der Preis ist ein Prozesssprung je Bild. Für eine Handvoll Interessenten auf
 * einem internen Hostnamen ist das nichts; die Extension-Allowlist und der
 * Dotfile-Block des Editors sind dafür die einzige Wahrheit statt einer zweiten
 * Kopie, die driften kann (Invariante 3).
 *
 * Kein `on_demand_tls`: Es gibt genau einen Hostnamen, also ein gewöhnliches
 * Zertifikat. `caddyGlobalBlock()` gibt für Staging deshalb nichts aus, und der
 * `tls-ask`-Endpunkt wird nicht gebraucht.
 */
function caddyBlockStaging(o: ServiceOpts): string {
  const domain = o.domain ?? "intern.example.com";
  return `# Staging: EIN Hostname, viele Previews unter /p/<slug>/. Der Ordnername unter
# ${o.siteDir} ist der Slug — dieselbe Zuordnung wie im Sammelbetrieb, nur über
# den Pfad statt über den Host-Header (SLUG_RE in sites.ts).
#
# ACHTUNG: Hinter diesem Block ist der Editor OHNE ANMELDUNG erreichbar. Er
# gehört auf einen internen Hostnamen und niemals vor Kundenwebsites.
${domain} {
    encode gzip

    # Auth-Datei + alle Dotfiles, in jeder Tiefe. Regexp, kein Glob:
    # \`path /.*\` deckt nur führende Punkte, /assets/.geheim.html käme durch.
    #
    # STEHT VOR @editor UND GEWINNT DAMIT: gemessen sind \`.regoro/entwurf/\` und
    # \`.regoro/schwebend/\` so in jeder Tiefe unerreichbar, auch prozentkodiert
    # (\`%2eregoro\`, \`%2E\`) und auch mit \`/edit\`-Suffix. Diese Reihenfolge nicht
    # umstellen.
    @hidden path_regexp (^|/)\\.
    handle @hidden {
        respond 404
    }

    # Editor-Routen an den Bun-Prozess. Als REGEXP und nicht als Glob wie in
    # Produktion: Caddys \`path\`-Glob überquert Schrägstriche nur bei einem
    # EINZELNEN Stern am Anfang oder Ende — ab dem zweiten gilt Go-path.Match und
    # ein Stern steht für genau ein Segment. Das Präfix \`/p/<slug>/\` erzwingt
    # aber einen zweiten Stern. Gemessen mit caddy 2.11.4: \`/p/*/edit/*\` verfehlt
    # \`/edit/agent/events\`, \`/edit/agent/verlaeufe\` und \`/edit/version/<id>\` —
    # also genau die Routen der KI-Seitenleiste, und zwar lautlos.
    #
    # HIER KEINE CSP: \`connect-src 'none'\` blockierte jedes fetch des Overlays.
    ${editorMatcherStaging()}
    handle @editor {
        reverse_proxy 127.0.0.1:${o.port} {
${SSE_KOMMENTAR}
            flush_interval -1
        }
    }

    # Alles andere ist die Vorschau selbst — auch sie kommt aus dem Bun-Prozess,
    # denn nur der kennt den Entwurf. Kein \`root\`, kein \`file_server\`: siehe
    # caddyBlockStaging() in src/service.ts.
    handle {
        ${cspZeile(o.browserHerkuenfte)}
        ${NOSNIFF_ZEILE}
        reverse_proxy 127.0.0.1:${o.port} {
${SSE_KOMMENTAR}
            flush_interval -1
        }
    }
}
`;
}

/**
 * Der Inhalt des statischen Zweigs im Sammelbetrieb: CSP und `file_server`.
 *
 * Ohne Integrationen ist das eine Standard-CSP für alle Domains — zeichengleich
 * mit dem Einzelbetrieb. Hat eine Domain eigene Browser-Herkünfte, bekommt sie
 * einen eigenen `handle`-Zweig davor. Bewusst geschachtelte `handle`-Blöcke und
 * nicht zwei `header`-Zeilen mit Matcher: `handle` ist eine sich gegenseitig
 * ausschließende Gruppe, damit ist per Konstruktion ausgeschlossen, dass eine
 * Domain zwei CSPs bekommt oder die falsche gewinnt.
 *
 * Die Freischaltung gilt so NUR für die Domain, für die sie eingerichtet wurde.
 * Eine Vereinigungsmenge über alle Kunden wäre bequemer und genau die
 * Quervermischung, gegen die Invariante 10 steht.
 */
function cspZweigeMulti(o: ServiceOpts): string {
  const jeHost = Object.entries(o.herkuenfteJeHost ?? {})
    .filter(([, h]) => h.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  if (jeHost.length === 0) {
    return `        ${cspZeile(o.browserHerkuenfte)}\n        ${NOSNIFF_ZEILE}\n        file_server`;
  }

  const zweige = jeHost.map(([host, herkuenfte]) => {
    // Der Matcher-Name muss ein Caddy-Bezeichner sein; der Host-Regexp wird
    // vollständig verankert, damit "kunde.de" nicht auch "boese-kunde.de.tld"
    // trifft und deren CSP mit aufweicht.
    const name = `@csp_${host.replace(/[^a-z0-9]+/g, "_")}`;
    return `        ${name} header_regexp Host ^${host.replace(/[.]/g, "\\.")}$
        handle ${name} {
            ${cspZeile(herkuenfte)}
            file_server
        }`;
  });

  return `        ${NOSNIFF_ZEILE}
        # Domains mit eigenen Browser-Herkünften (regoro integration).
        # Nach jeder Änderung an den Integrationen neu erzeugen und Caddy
        # nachladen — sonst lädt der eingebaute Knopf beim Kunden nicht.
${zweige.join("\n")}
        handle {
            ${cspZeile(o.browserHerkuenfte)}
            file_server
        }`;
}

/**
 * Die Befehle, die den Dienst tatsächlich starten — copy-paste-fähig.
 * Die Unit-Datei entsteht durch `regoro service --systemd`, nicht durch Abtippen.
 */
export function activationSteps(o: ServiceOpts): string {
  const unit = `regoro-${o.slug}`;
  if (o.multi) return activationStepsMulti(o, unit);
  if (o.staging) return activationStepsStaging(o, unit);
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
curl -sI ${editorUrl(o.domain ?? "deine-domain.de")}/edit/login | head -1

${KI_SCHRITTE}`;
}
