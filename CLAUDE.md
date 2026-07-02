# CLAUDE.md — Regoro Edit

Kontext für Agenten, die in **diesem** Repo arbeiten. **Nutzung/Installation/Deployment stehen in der [README](README.md)** — hier nicht wiederholen. Diese Datei erklärt Architektur, Invarianten und wie man sicher Änderungen macht.

## Was das ist (1 Satz)
Ein einzelner Bun-Prozess, der eine **bestehende statische Website** ausliefert und auf jeder Seite unter `…/edit` einen Inline-WYSIWYG-Editor bereitstellt. Ausgegründet aus `regoro-de` (dortiges `editor/`); dieses Repo ist jetzt die Quelle der Wahrheit.

## Layout
- `src/` — Code **und** Tests (`*.test.ts`). Kern infra-agnostisch: `contract.ts` (HTML-Enumeration/Validierung), `serve.ts` (renderEditView), `apply.ts` (Edits anwenden), `git.ts` (Versionen). HTTP-/Setup-Schicht: `auth.ts`, `host.ts` (Router), `server.ts` (startServer), `cli.ts` (bin).
- `src/overlay.client.js` — Browser-Overlay (Vanilla-JS-IIFE). Wird von `host.ts` bei jedem Request frisch von der Platte ausgeliefert.
- `examples/site/` — Beispiel-Website, die die Tests als Fixture nutzen (`REAL_SITE`).

## Nicht-verhandelbare Invarianten (bei Änderungen erhalten!)
1. **Command-based editing:** Der Client schickt **nie Markup**, nur Befehle (Text, Offsets, Format-Flags). Der Server erzeugt **jedes** `<strong>/<em>/<u>/<a>/<span style=color>/<br>`. Deshalb kein HTML-Sanitizer nötig — validiert werden ausschließlich **`href`** (`isValidHref`) und **Farbe** (`isValidColor`/`normalizeColor`). Führe keine client-gelieferten HTML-Strings ein.
2. **Auth ausschließlich datei-basiert:** `<siteDir>/.regoro/auth.json` (argon2id-Hash + per-Site HMAC-Secret). **Keine** Passwort-Env-Vars. **Fail-closed:** kein/ungültiges File → alle `/edit*` inkl. Login → 404.
3. **Die Auth-Datei/Dotfiles nie über Web ausliefern:** Dotfile-Block in `host.ts` (public-GET-Zweig + `serveStaticAsset`) → jeder Pfad mit `.`-Segment → 404. `.regoro/` ist zudem gitignored — **niemals committen**.
4. **Routing:** Präzedenz `/edit/login` → `/edit-assets/*` → API-Routen (`save/upload/versions/restore/version`) → View-Routen (`/edit`, `/<page>.html/edit`) → public static. View unauth → **302 Login** (`?return=`, streng validiert gegen Open-Redirect). API unauth → **404**.
5. **Symlink-sicheres Schreiben:** `pathInsideSite()` (realpath-Containment, fail-closed) vor jedem Write in `handleUpload`/`handleSave`/`handleRestore`. Nicht entfernen.
6. **Range-Format-Ops werden beim Speichern aus dem Live-DOM abgeleitet** (`collectRangeOpsFromDom` in overlay.client.js) — additive Formatierung über `.__regoro-range-fmt`-Spans, Entfernung über `.__regoro-range-unfmt`-Marker. Grund: robust gegen zwischenzeitliche Textedits. Nicht auf fixe gespeicherte Offsets zurückbauen.
7. **Ephemer:** `data-edit-idx`/`data-edit-img-idx`/`data-edit-del-idx`/`data-edit-br-idx` werden nur in der `/edit`-Response injiziert, **nie auf Platte**. Roh-HTML ist die einzige Quelle, bei jedem `/edit`-Load neu abgeleitet.
8. **Optimistic Locking:** `fileHash` → Mismatch = 409. Versionen = Git **pro Site** (`repoRoot === siteDir`); `init` legt einen pristine Baseline-Commit an.

## Testen / Checks
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test                 # 357 Tests (Fixtures kopieren examples/site in tmp-Dirs)
bun x tsc --noEmit       # Typecheck (tsconfig include: src/**/*.ts)
bun build src/overlay.client.js --target=browser >/dev/null   # Syntax-Check des Client-JS (tsc erfasst es NICHT)
```
- **overlay.client.js ist nicht durch die Unit-Tests abgedeckt** (Client-Verhalten). Für Overlay-Änderungen echt im Browser prüfen (z. B. gstack `/browse`, headless): init+run auf einer temp-Kopie, Selektion/Formatierung/Speichern skripten, gespeichertes HTML prüfen.

## Fallstricke
- **Server nicht mit `repoRoot` = diesem Repo starten** für Dogfooding: der Save committet dann in genau dieses Repo. Immer auf einen **separaten Site-Ordner** zeigen (`cli.ts <site>` setzt `repoRoot = siteDir`).
- `EDITOR_INSECURE_COOKIE=1` nur für lokales HTTP (Cookie ohne `Secure`) — nie Prod.
- Beim Ausprobieren `examples/site` nicht direkt bespielen (sonst nested `.git`/`.regoro` im Repo) — auf eine Kopie in `/tmp` arbeiten.
- Änderungen werden **nicht** automatisch mit dem alten `regoro-de/editor/` synchronisiert — dieses Repo pflegen.

## Sprache
Deutsch in Kommentaren/Status-Strings (bestehende Konvention); Code-Bezeichner Englisch.
