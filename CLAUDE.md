# CLAUDE.md — Regoro Edit

Kontext für Agenten, die in **diesem** Repo arbeiten. **Nutzung/Installation/Deployment stehen in der [README](README.md)** — hier nicht wiederholen. Diese Datei erklärt Architektur, Invarianten und wie man sicher Änderungen macht.

## Was das ist (1 Satz)
Ein einzelner Bun-Prozess, der eine **bestehende statische Website** ausliefert und auf jeder Seite unter `…/edit` einen Inline-WYSIWYG-Editor bereitstellt. Ausgegründet aus `regoro-de` (dortiges `editor/`); dieses Repo ist jetzt die Quelle der Wahrheit.

## Layout
- `src/` — Code **und** Tests (`*.test.ts`). Kern infra-agnostisch: `contract.ts` (HTML-Enumeration/Validierung), `serve.ts` (renderEditView), `apply.ts` (Edits anwenden), `git.ts` (Versionen). HTTP-/Setup-Schicht: `auth.ts`, `host.ts` (Router), `server.ts` (startServer), `cli.ts` (bin, heißt installiert **`regoro`**).
- `src/overlay.client.js` — Browser-Overlay (Vanilla-JS-IIFE). `host.ts` importiert es als `with { type: "file" }` und liest den Pfad je Request: in dev die echte Datei (Live-Reload), im `--compile`-Binary die eingebettete Kopie. **Nicht** auf `import.meta.url` zurückbauen — im Binary zeigt das ins Leere, `/edit-assets/overlay.js` gäbe 404 und der Editor wäre stumm funktionslos. Deklaration dafür: `src/assets.d.ts`.
- `src/service.ts` — reine Textgenerierung für `regoro service` (systemd-Unit + Caddy-Block). Kein Dateisystem-Zugriff; `cmdService` druckt nur. **Ändert sich `ASSET_TYPES` in `host.ts`, muss `caddyBlock()` mit** — und `Caddyfile.example` ebenso. `ProtectHome=yes` wird weggelassen, wenn die Site unter `/home`/`/root` liegt (systemd leert das Verzeichnis sonst, der Dienst käme nicht hoch).
- `install.sh` — Installer (POSIX sh): lädt Binary + `SHA256SUMS` vom GitHub-Release, verifiziert, legt nach `~/.local/bin/regoro`. Bricht ohne `git` oder ohne Prüfsumme ab.
- `.github/workflows/release.yml` — baut auf Tag `v*` vier Binaries (`bun build --compile --target=bun-{linux,darwin}-{x64,arm64}`), erzeugt `SHA256SUMS`, hängt beides ans Release. **Asset-Namen müssen zu `install.sh` passen** (`regoro-<os>-<arch>`).
- `examples/site/` — Beispiel-Website, die die Tests als Fixture nutzen (`REAL_SITE`).

`VERSION` in `cli.ts` ist gegen `package.json` per Test festgenagelt — beide zusammen bumpen.
`cli.ts` führt `main()` nur unter `import.meta.main` aus; ohne den Guard startet ein Import die CLI.

## Nicht-verhandelbare Invarianten (bei Änderungen erhalten!)
1. **Command-based editing:** Der Client schickt **nie Markup**, nur Befehle (Text, Offsets, Format-Flags). Der Server erzeugt **jedes** `<strong>/<em>/<u>/<a>/<span style=color>/<br>`. Deshalb kein HTML-Sanitizer nötig — validiert werden ausschließlich **`href`** (`isValidHref`) und **Farbe** (`isValidColor`/`normalizeColor`). Führe keine client-gelieferten HTML-Strings ein.
2. **Auth ausschließlich datei-basiert:** `<siteDir>/.regoro/auth.json` (argon2id-Hash + per-Site HMAC-Secret). **Keine** Passwort-Env-Vars. **Fail-closed:** kein/ungültiges File → alle `/edit*` inkl. Login → 404. `createAuthFile` überschreibt eine bestehende Datei kommentarlos (Hash **und** Secret) — deshalb guardet `cmdInit` dagegen und verlangt `--force`. Guard nicht entfernen: `init` ohne Pfad meint die cwd, ein Tippfehler wäre sonst teuer.
   - **`init`-Reihenfolge nicht umstellen:** `ensureGitignore` → `ensureRepo` → `createAuthFile`. Der Baseline-Commit entsteht, wenn `auth.json` noch **nicht existiert** — das Secret kann gar nicht hineingeraten. Und ein fehlschlagendes `git` (z.B. „dubious ownership", wenn der Site-Ordner einem anderen User gehört) hinterlässt kein nutzloses Passwort, das der „bereits initialisiert"-Guard dann blockieren würde. Tests: `cli.test.ts` → „git schlägt fehl".
   - **Cookie-Name nie hartkodieren** — `cookieName()` benutzen. In Prod ist er `__Host-regoro_edit`; das Präfix verbietet dem Browser `Domain=`-Cookies gleichen Namens, sonst könnte bei Subdomain-Betrieb (`kunde.site.example.de`) eine Geschwister-Subdomain die Session aller anderen verdecken. Ohne `Secure` (EDITOR_INSECURE_COOKIE=1) fällt das Präfix weg, sonst verwirft der Browser das Cookie.
   - **`readCookieTokens` liest ALLE gleichnamigen Cookies**, nicht den ersten. `isAuthed` prüft jeden gegen `checkCookie`. Nicht auf „erster Treffer" zurückbauen — das ist die zweite Verteidigungslinie gegen Cookie-Tossing.
3. **Nur die Website ausliefern, nichts sonst.** Zwei Schranken, beide nötig:
   - **Dotfile-Block** in `host.ts` (public-GET-Zweig + `serveStaticAsset`) → jeder Pfad mit `.`-Segment → 404. `.regoro/` ist zudem gitignored — **niemals committen**.
   - **Extension-Allowlist** `ASSET_TYPES` (`host.ts`) → alles ohne bekannte Endung → 404. Ein Site-Ordner enthält real auch Build-Artefakte (`design.json`, `images.json` mit internen Serverpfaden), Backups, Notizen. Nimm **nie** `.json`/`.yaml`/`.md` in `ASSET_TYPES` auf; `.svg` bleibt draußen (script-fähig).
   - **Der Reverse-Proxy muss dieselbe Allowlist führen.** In `Caddyfile.example` liefert Caddy die statische Site direkt aus, der Bun-Host ist dafür nicht im Pfad — ein blankes `file_server` unterläuft `ASSET_TYPES` komplett (war so, gefixt). Ändert sich `ASSET_TYPES`, ändere das Caddyfile mit. Tests dazu in `security.test.ts` („404, obwohl die Datei existiert").
4. **Routing:** Präzedenz `/edit/login` → `/edit-assets/*` → API-Routen (`save/upload/versions/restore/version`) → View-Routen (`/edit`, `/<page>.html/edit`) → public static. View unauth → **302 Login** (`?return=`, streng validiert gegen Open-Redirect). API unauth → **404**.
   - **Der Proxy-Matcher muss `isEditorPath()` spiegeln.** `path /edit*` reicht **nicht**: es verfehlt die Suffix-Route `/<page>.html/edit` (der Editor war in Prod für jede Unterseite 404) und fängt zugleich öffentliche Seiten wie `/edit-preise.html` ein. Korrekt: `path /edit /edit/* /edit-assets/* */edit`. Gilt für `Caddyfile.example` **und** `caddyBlock()` in `service.ts` — beide gemeinsam ändern.
5. **Symlink-sicheres Schreiben:** `pathInsideSite()` (realpath-Containment, fail-closed) vor jedem Write in `handleUpload`/`handleSave`/`handleRestore`. Nicht entfernen.
6. **Range-Format-Ops werden beim Speichern aus dem Live-DOM abgeleitet** (`collectRangeOpsFromDom` in overlay.client.js) — additive Formatierung über `.__regoro-range-fmt`-Spans, Entfernung über `.__regoro-range-unfmt`-Marker. Grund: robust gegen zwischenzeitliche Textedits. Nicht auf fixe gespeicherte Offsets zurückbauen.
7. **Ephemer:** `data-edit-idx`/`data-edit-img-idx`/`data-edit-del-idx`/`data-edit-br-idx` werden nur in der `/edit`-Response injiziert, **nie auf Platte**. Roh-HTML ist die einzige Quelle, bei jedem `/edit`-Load neu abgeleitet.
8. **Optimistic Locking:** `fileHash` → Mismatch = 409. Versionen = Git **pro Site** (`repoRoot === siteDir`); `init` legt einen pristine Baseline-Commit an.
9. **Das Site-Repo ist die einzige Quelle der Kundenänderungen.** Der Editor schreibt direkt in die ausgelieferten Dateien; die Website-Pipeline kennt diese Commits nicht. Kein Befehl darf `.git` löschen, solange mehr als der Baseline-Commit darin steht — `cmdDisable` prüft das über `countCommits()` und bricht bei `--purge` ab. `disable` ohne `--purge` entfernt nur `.regoro/` (Editor aus, fail-closed) und lässt Website wie Historie unberührt.

## Testen / Checks
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test                 # 375 Tests (Fixtures kopieren examples/site in tmp-Dirs)
bun x tsc --noEmit       # Typecheck (tsconfig include: src/**/*.ts)
bun build src/overlay.client.js --target=browser >/dev/null   # Syntax-Check des Client-JS (tsc erfasst es NICHT)
caddy validate --config Caddyfile.example --adapter caddyfile  # Proxy-Vorlage (bun test erfasst sie NICHT)
bun build --compile src/cli.ts --outfile /tmp/regoro           # Binary — bricht bei Asset-Fehlern NICHT, erst zur Laufzeit
```
- **Das Binary muss nach jeder Änderung an Asset-Laden/Pfaden echt geprüft werden**, `bun test` deckt nur den dev-Pfad ab. Minimal: Binary bauen, `PATH=/usr/bin:/bin` (kein bun), `regoro init` + `run` auf einer tmp-Kopie, dann `/edit-assets/overlay.js` → muss 200 + ~91 KB liefern, nicht 404.
- **install.sh ist ungetestet durch die Suite.** Prüfen gegen einen lokalen „Release": Binary + `sha256sum regoro-* > SHA256SUMS` in einen Ordner, `python3 -m http.server`, dann `HOME=/tmp/x REGORO_BASE_URL=http://localhost:PORT sh install.sh`. Auch die Abbruchpfade fahren (manipuliertes Binary → Prüfsummen-Fehler, fehlendes SHA256SUMS, fehlendes git).
- **overlay.client.js ist nicht durch die Unit-Tests abgedeckt** (Client-Verhalten). Für Overlay-Änderungen echt im Browser prüfen (z. B. gstack `/browse`, headless): init+run auf einer temp-Kopie, Selektion/Formatierung/Speichern skripten, gespeichertes HTML prüfen.
- **Caddyfile.example ist ebenfalls ungetestet.** Zum Prüfen lokal nachbauen: Domain → `:PORT`, `auto_https off`, `reverse_proxy` → `respond`, dann per curl gegen einen Ordner mit Fremd-Datei (`design.json`, `dump.sql`) fahren — die müssen 404 geben, `/`, `*.html`, `*.css`, Unterordner-Assets weiterhin 200. **Auch verschachtelte Dotfiles testen** (`/assets/.private.html`, `/a/.hidden/notes.txt`): Caddys `path`-Matcher ist Glob, kein Segment-Matcher — `path /.*` deckt nur führende Punkte, daher `path_regexp (^|/)\.`.

## Fallstricke
- **Server nicht mit `repoRoot` = diesem Repo starten** für Dogfooding: der Save committet dann in genau dieses Repo. Immer auf einen **separaten Site-Ordner** zeigen (`cli.ts <site>` setzt `repoRoot = siteDir`).
- `EDITOR_INSECURE_COOKIE=1` (Cookie ohne `Secure`) wird **nicht** für `http://localhost` gebraucht — Browser akzeptieren dort `Secure`/`__Host-`-Cookies (in Chromium verifiziert). Nötig nur bei HTTP unter fremdem Hostnamen/LAN-IP; dort verwirft der Browser das Cookie sonst **stumm** (Login-Schleife ohne Fehlermeldung). `insecureOriginWarning()` in `host.ts` warnt auf der Login-Seite vor. Nie in Prod.
- Beim Ausprobieren `examples/site` nicht direkt bespielen (sonst nested `.git`/`.regoro` im Repo) — auf eine Kopie in `/tmp` arbeiten.
- Änderungen werden **nicht** automatisch mit dem alten `regoro-de/editor/` synchronisiert — dieses Repo pflegen.

## Sprache
Deutsch in Kommentaren/Status-Strings (bestehende Konvention); Code-Bezeichner Englisch.
