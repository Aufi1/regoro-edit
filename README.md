# Regoro Edit

**Inline-WYSIWYG-Editor für bestehende statische HTML-Websites.**
Installieren, ein Passwort setzen – und danach an **jede** Seite deiner Website `/edit` anhängen, um sie direkt im Browser zu bearbeiten. Kein CMS, keine Datenbank, kein Re-Build. Jede Speicherung ist eine Git-Version.

```
deine-seite.de/                 →  deine ganz normale Website
deine-seite.de/edit             →  Editor für die Startseite (nach Login)
deine-seite.de/impressum.html/edit  →  Editor für /impressum.html
```

---

## Was es ist

Du hast bereits eine fertige statische Website (HTML/CSS/Bilder in einem Ordner). Regoro Edit ist **ein einzelner Prozess**, der

1. deine bestehende Site **unverändert ausliefert** (`/`, `/ueber-uns.html`, Assets …) und
2. auf **jeder** Seite unter `…/edit` einen WYSIWYG-Editor bereitstellt (nach Login).

Bearbeitet werden **Text, Formatierung** (fett/kursiv/unterstrichen, Farbe, Links), **Bilder** (Austausch per Upload) und **Absätze/Zeilenumbrüche** – direkt auf der gerenderten Seite. Der Editor ändert nur die HTML-Dateien im Site-Ordner; du behältst volle Kontrolle. Eine Version je Speicherung via Git.

## Voraussetzungen

- `git` (für die Versionierung — jede Speicherung ist ein Commit)
- Linux oder macOS, x86_64 oder arm64

Bun brauchst du nur zum **Entwickeln** (siehe unten), nicht zum Benutzen.

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/Aufi1/regoro-edit/main/install.sh | sh
```

Das lädt ein Standalone-Binary nach `~/.local/bin/regoro`, prüft dessen SHA256-Summe
und ist fertig. **Bun wird nicht benötigt** — die Runtime steckt im Binary. `git` schon:
jede Speicherung ist ein Commit. Fehlt es, nennt dir der Installer den passenden
Installationsbefehl für dein System (er führt ihn nicht selbst aus — kein `sudo` aus
einem `curl | sh`-Skript).

Zum Aktualisieren einfach erneut ausführen.

Der Installer versteht `REGORO_VERSION` (statt `latest`) und `REGORO_INSTALL_DIR`
(statt `~/.local/bin`). Bei der Pipe müssen die Variablen **hinter** dem `|` stehen —
davor gälten sie für `curl`, nicht für `sh`:

```bash
curl -fsSL https://raw.githubusercontent.com/Aufi1/regoro-edit/main/install.sh \
  | REGORO_INSTALL_DIR=/usr/local/bin REGORO_VERSION=v0.1.0 sh
```

## Schnellstart (2 Schritte)

```bash
cd /pfad/zu/deiner/site
regoro init      # Passwort setzen (legt <site>/.regoro/auth.json an)
regoro run       # Editor starten
```

Beide Befehle nehmen den Site-Ordner aus dem aktuellen Verzeichnis; `regoro init /pfad/zu/site`
geht genauso.

Dann im Browser `http://localhost:8788/` öffnen (deine Site) und an eine beliebige Seite `/edit` anhängen → Login → bearbeiten.

> **Ausprobieren ohne eigene Site:** In diesem Repo liegt eine Beispiel-Site unter `examples/site`:
> ```bash
> cp -r examples/site /tmp/meine-site
> regoro init /tmp/meine-site
> regoro run /tmp/meine-site
> # -> http://localhost:8788/  und  http://localhost:8788/edit
> ```

## Auf einer bestehenden Website einsetzen

Der springende Punkt: Du **änderst an deiner Website nichts**. Zeig Regoro Edit einfach auf den Ordner, in dem deine `index.html` liegt:

```
meine-website/            ← Site-Root (hier liegt index.html)
├── index.html
├── impressum.html
├── styles.css
├── assets/…
└── .regoro/auth.json     ← von `init` angelegt (gehashtes Passwort + Secret, 0600, git-ignoriert)
```

- `regoro init ./meine-website` fragt ein Passwort ab, **hasht** es (argon2id) und legt es zusammen mit einem zufälligen Cookie-Secret in `.regoro/auth.json` ab. Zusätzlich wird ein Git-Repo im Site-Ordner initialisiert (Versionen) und `.regoro/` in eine `.gitignore` eingetragen – das Secret wird also nie mitversioniert.
- `regoro run ./meine-website` startet den Server. Deine Seiten sind unter ihren normalen URLs erreichbar; `…/edit` öffnet den Editor.
- **Bearbeitbare Seiten** sind alle `*.html`-Dateien im Site-Root (Top-Level). Unterordner-Seiten sind in v1 nicht im Editor (werden aber normal ausgeliefert).

### Die „/edit anhängen"-Logik

| Öffentliche Seite | Editor-URL |
|---|---|
| `/` (Startseite) | `/edit` |
| `/impressum.html` | `/impressum.html/edit` |
| `/leistungen.html` | `/leistungen.html/edit` |

Bist du nicht angemeldet, leitet der Editor auf den **Login** um und danach zurück zur Bearbeitungsansicht der Seite.

## Auth-Modell (wichtig)

- **Genau ein Weg:** gehashte Passwort-Datei `<site>/.regoro/auth.json` (argon2id, per-Site-Cookie-Secret). **Keine** Passwort-Umgebungsvariablen.
- **Fail-closed:** fehlt/ungültig die Datei → `/edit` ist komplett aus (alle Editor-Routen → 404).
- **Pro Site ein eigenes Passwort:** Betreibst du mehrere Sites, hat jede ihre eigene `.regoro/auth.json`.
- **Die Auth-Datei ist nie über das Web erreichbar:** Anfragen auf `.regoro/` bzw. jeden Dotfile werden hart mit 404 beantwortet (zusätzlich blockt die Reverse-Proxy-Vorlage sie).
- **Das Session-Cookie heißt `__Host-regoro_edit`** (in Prod, mit TLS). Der `__Host-`-Präfix sorgt dafür, dass der Browser es nur mit `Secure`, `Path=/` und ohne `Domain`-Attribut akzeptiert. Relevant, wenn mehrere Sites unter Subdomains derselben Domain laufen (`kunde1.example.de`, `kunde2.example.de`): Ohne das Präfix könnte eine Subdomain den anderen ein gleichnamiges Cookie unterschieben und sie damit aussperren.

## Versionen

Jede Speicherung und jede Wiederherstellung ist ein Git-Commit im Site-Ordner. In der Editor-Leiste gibt es „Versionen" (Vorschau früherer Stände + Wiederherstellen).

## Produktion (TLS, öffentliche Domain)

Für lokales Dogfooding reicht der eingebaute Server. Für den Live-Betrieb stellst du einen Reverse-Proxy mit TLS davor. Die Vorlage `Caddyfile.example` liefert die statische Site aus, leitet `/edit*` an den Editor weiter und **blockt `.regoro/`/Dotfiles**:

```bash
# Beispiel: Editor lokal, Caddy als HTTPS-Proxy davor
regoro run ./meine-website               # lauscht auf :8788
caddy run --config Caddyfile.example     # TLS + Routing
```

Alternativ per Docker – siehe `Dockerfile` (Site als Volume mounten; `init` einmalig im gemounteten Ordner ausführen, damit die Auth-Datei zur Laufzeit vorliegt und **nicht** ins Image gebacken wird).

## Konfiguration

| Variable | Default | Zweck |
|---|---|---|
| `PORT` | `8788` | Port des Editor-Servers |
| `EDITOR_INSECURE_COOKIE` | *(nicht gesetzt)* | `=1` lässt das `Secure`-Cookie-Flag weg – **nur für lokales HTTP** (Dogfooding), **nie in Produktion**. |

## Editor wieder abschalten

```bash
regoro disable            # im Site-Ordner
```

Entfernt `.regoro/`. Die Website wird unverändert weiter ausgeliefert, alle `/edit*`-Routen antworten mit `404` (fail-closed). Umkehrbar mit `regoro init`.

Die Versionshistorie (`.git`) bleibt dabei erhalten — **jede Speicherung im Editor ist ein Commit, und der Editor ist die einzige Quelle dieser Änderungen.** `regoro disable --purge` löscht `.git` mit, aber nur solange nichts anderes darin steht als der Baseline-Commit von `init`. Sobald es gespeicherte Bearbeitungen gibt, bricht `--purge` ab und rührt nichts an.

## Weitere CLI-Optionen

Die CLI kennt außerdem `regoro init <site> --password-stdin` (Passwort aus stdin, für Skripte/Docker) und `--force`.

`init` bricht ab, wenn die Site bereits eine `.regoro/auth.json` hat oder der Ordner keine top-level `*.html` enthält — beides schützt davor, versehentlich den falschen Ordner zu initialisieren oder ein bestehendes Passwort zu überschreiben. `--force` hebt beide Guards auf; bei bestehender Auth-Datei setzt es das Passwort neu und macht **alle laufenden Sessions ungültig** (das Cookie-Secret wird mit erneuert).

## Sicherheit

- Client schickt nie Markup, nur **Befehle** (Offsets + Format-Flags) – der Server erzeugt jedes `<strong>/<em>/<u>/<a>/<span style=color>/<br>`. Validiert werden nur `href` und Farbwerte. Kein HTML-Sanitizer-Ratespiel.
- Uploads: Größenlimit + Magic-Byte-Prüfung, SVG blockiert (XSS), sicher generierte Dateinamen. Schreibpfade sind **symlink-sicher** (realpath-Containment, fail-closed) – auch Save/Restore.
- Optimistisches Locking (fileHash) verhindert das Überschreiben zwischenzeitlicher Änderungen.
- Alle Editor-Antworten sind `noindex`/`no-store`.

## Was v1 (noch) nicht kann

- Nur Top-Level-`*.html` sind editierbar (keine verschachtelten Pfade).
- Kein Layout-/Strukturbau, keine neuen Seiten, keine Benutzer-/Rollenverwaltung.
- Multi-Site (mehrere Domains in einem Prozess mit Host-Routing) ist als Ausbaustufe vorgesehen, in v1 aber nicht enthalten – ein Prozess bedient einen Site-Ordner.

## Entwicklung

Braucht [Bun](https://bun.sh) ≥ 1.3.

```bash
git clone https://github.com/Aufi1/regoro-edit.git && cd regoro-edit
bun install
bun link               # `regoro` zeigt auf src/cli.ts — Änderungen wirken sofort

bun test               # Testsuite
bun x tsc --noEmit     # Typecheck
bun run build:binary   # Standalone-Binary nach dist/regoro
```

`bun link` macht `regoro` global aufrufbar; das setzt `~/.bun/bin` im `PATH` voraus.
Rückgängig mit `bun unlink`. Ohne Link tut es auch `bun src/cli.ts init <site>`.

Ein Release entsteht durch einen Tag (`v*`): `.github/workflows/release.yml` baut die
vier Binaries, erzeugt `SHA256SUMS` und hängt beides ans Release — von dort lädt
`install.sh`.

Der Editor-Kern liegt unter `src/` (`contract`/`serve`/`apply`/`git` sind infrastruktur-agnostisch; `auth`/`host`/`server`/`cli` bilden die HTTP-/Setup-Schicht). Das Browser-Overlay ist `src/overlay.client.js`.

## Lizenz

[MIT](LICENSE) © 2026 aufi
