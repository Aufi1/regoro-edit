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

- [Bun](https://bun.sh) ≥ 1.3
- `git` (für die Versionierung)

## Schnellstart (3 Schritte)

```bash
# 1. Holen
git clone https://github.com/<user>/regoro-edit.git && cd regoro-edit
bun install

# 2. Passwort für deine Site setzen (legt <site>/.regoro/auth.json an)
bun src/cli.ts init /pfad/zu/deiner/site

# 3. Starten
bun src/cli.ts /pfad/zu/deiner/site
```

Dann im Browser `http://localhost:8788/` öffnen (deine Site) und an eine beliebige Seite `/edit` anhängen → Login → bearbeiten.

> **Ausprobieren ohne eigene Site:** In diesem Repo liegt eine Beispiel-Site unter `examples/site`:
> ```bash
> cp -r examples/site /tmp/meine-site
> bun src/cli.ts init /tmp/meine-site
> bun src/cli.ts /tmp/meine-site
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

- `regoro-edit init ./meine-website` fragt ein Passwort ab, **hasht** es (argon2id) und legt es zusammen mit einem zufälligen Cookie-Secret in `.regoro/auth.json` ab. Zusätzlich wird ein Git-Repo im Site-Ordner initialisiert (Versionen) und `.regoro/` in eine `.gitignore` eingetragen – das Secret wird also nie mitversioniert.
- `regoro-edit ./meine-website` startet den Server. Deine Seiten sind unter ihren normalen URLs erreichbar; `…/edit` öffnet den Editor.
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

## Versionen

Jede Speicherung und jede Wiederherstellung ist ein Git-Commit im Site-Ordner. In der Editor-Leiste gibt es „Versionen" (Vorschau früherer Stände + Wiederherstellen).

## Produktion (TLS, öffentliche Domain)

Für lokales Dogfooding reicht der eingebaute Server. Für den Live-Betrieb stellst du einen Reverse-Proxy mit TLS davor. Die Vorlage `Caddyfile.example` liefert die statische Site aus, leitet `/edit*` an den Editor weiter und **blockt `.regoro/`/Dotfiles**:

```bash
# Beispiel: Editor lokal, Caddy als HTTPS-Proxy davor
bun src/cli.ts ./meine-website           # lauscht auf :8788
caddy run --config Caddyfile.example     # TLS + Routing
```

Alternativ per Docker – siehe `Dockerfile` (Site als Volume mounten; `init` einmalig im gemounteten Ordner ausführen, damit die Auth-Datei zur Laufzeit vorliegt und **nicht** ins Image gebacken wird).

## Konfiguration

| Variable | Default | Zweck |
|---|---|---|
| `PORT` | `8788` | Port des Editor-Servers |
| `EDITOR_INSECURE_COOKIE` | *(nicht gesetzt)* | `=1` lässt das `Secure`-Cookie-Flag weg – **nur für lokales HTTP** (Dogfooding), **nie in Produktion**. |

Die CLI kennt außerdem `regoro-edit init <site> --password-stdin` (Passwort aus stdin, für Skripte/Docker).

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

```bash
bun test               # Testsuite (357 Tests)
bun x tsc --noEmit     # Typecheck
```

Der Editor-Kern liegt unter `src/` (`contract`/`serve`/`apply`/`git` sind infrastruktur-agnostisch; `auth`/`host`/`server`/`cli` bilden die HTTP-/Setup-Schicht). Das Browser-Overlay ist `src/overlay.client.js`.

## Lizenz

[MIT](LICENSE) © 2026 aufi
