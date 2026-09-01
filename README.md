# Regoro Edit

**Inline-WYSIWYG-Editor für bestehende statische HTML-Websites.**
Installieren, Telefonnummer und E-Mail-Adresse hinterlegen – und danach an **jede** Seite deiner Website `/edit` anhängen, um sie direkt im Browser zu bearbeiten. Kein CMS, keine Datenbank, kein Re-Build. Jede Speicherung ist eine Git-Version.

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
  | REGORO_INSTALL_DIR=/usr/local/bin REGORO_VERSION=v0.2.0 sh
```

## Die Befehle

| Befehl | Zweck |
|---|---|
| `regoro init` | Kontaktwege hinterlegen, Git-Repo anlegen. Einmal pro Site. |
| `regoro kennung` | Telefonnummern und E-Mail-Adressen pflegen. |
| `regoro run` | Editor-Server starten. Läuft im Vordergrund, bis `Strg-C`. |
| `regoro serve` | Sammelbetrieb: **alle** Websites unter einem Sammelverzeichnis in einem Prozess. |
| `regoro service` | systemd-Unit + Caddy-Block für den Dauerbetrieb ausgeben. |
| `regoro disable` | Editor wieder abschalten. |

Alle nehmen den Site-Ordner aus dem aktuellen Verzeichnis; ein Pfad als Argument geht genauso.

## Schnellstart (2 Schritte)

```bash
cd /pfad/zu/deiner/site
regoro init --nummer "0151 20464812" --email chef@firma.de   # beide Kontaktwege
regoro run                                                    # Editor starten
```

Dann im Browser `http://localhost:8788/` öffnen (deine Site) und an eine beliebige Seite `/edit` anhängen → Anmelden → bearbeiten. Über `localhost` funktioniert das ohne weitere Einstellungen.

Damit ein Code ankommt, muss der Versand eingerichtet sein (siehe unten). Zum Ausprobieren genügt die **Attrappe**: Sie schreibt den Code ins Terminal, statt ihn zu verschicken.

> **Ausprobieren ohne eigene Site:** In diesem Repo liegt eine Beispiel-Site unter `examples/site`:
> ```bash
> cp -r examples/site /tmp/meine-site
> regoro init /tmp/meine-site --nummer "0151 20464812" --email chef@firma.de
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
└── .regoro/auth.json     ← von `init` angelegt (Kontaktwege + Secret, 0600, git-ignoriert)
```

- `regoro init ./meine-website --nummer "0151 20464812" --email chef@firma.de` legt die hinterlegten Kontaktwege zusammen mit einem zufälligen Cookie-Secret in `.regoro/auth.json` ab. Zusätzlich wird ein Git-Repo im Site-Ordner initialisiert (Versionen) und `.regoro/` in eine `.gitignore` eingetragen – das Secret wird also nie mitversioniert.
- `regoro run ./meine-website` startet den Server. Deine Seiten sind unter ihren normalen URLs erreichbar; `…/edit` öffnet den Editor.
- **Bearbeitbare Seiten** sind alle `*.html`-Dateien im Site-Root (Top-Level). Unterordner-Seiten sind in v1 nicht im Editor (werden aber normal ausgeliefert).

### Die „/edit anhängen"-Logik

| Öffentliche Seite | Editor-URL |
|---|---|
| `/` (Startseite) | `/edit` |
| `/impressum.html` | `/impressum.html/edit` |
| `/leistungen.html` | `/leistungen.html/edit` |

Bist du nicht angemeldet, leitet der Editor auf den **Login** um und danach zurück zur Bearbeitungsansicht der Seite.

## Anmeldung (wichtig)

**Es gibt kein Passwort.** Der Kunde tippt ein, wie er erreichbar ist — Telefonnummer oder E-Mail-Adresse —, bekommt einen sechsstelligen Code auf genau diesem Weg und trägt ihn ein. Danach bleibt er 30 Tage angemeldet.

Der Grund: Ein Werkzeug, das ein Handwerksbetrieb viermal im Jahr benutzt, passt nicht zu einem Passwort. Es wird vergessen, das Zurücksetzen kostet Support-Zeit, und ein Zurücksetz-Weg ist selbst wieder eine Angriffsfläche. Ein Telefon hat der Chef dagegen dabei.

```bash
regoro init ./site --nummer "0151 20464812" --email chef@firma.de
regoro kennung ./site --list          # zeigt verkürzt: +4915…812
regoro kennung ./site --add chef2@firma.de
regoro kennung ./site --remove "0151 20464812"
```

Beides lässt sich hinterlegen; welcher Weg benutzt wird, entscheidet der Kunde bei jeder Anmeldung über zwei Reiter auf der Anmeldeseite. Der Code geht immer nur an **einen** Weg — den, der eingegeben wurde.

Was daraus folgt:

- **Wer keinen hinterlegten Kontaktweg hat, kommt nicht hinein.** `.regoro/auth.json` enthält die Liste plus das Sitzungs-Geheimnis der Website. Fehlt die Datei oder ist sie leer, antworten alle `/edit*`-Routen mit 404 (fail-closed).
- **Eine nicht hinterlegte Nummer löst keine Nachricht aus** — aber die Anmeldeseite antwortet gleich. Sonst verriete sie, welche Nummern es gibt.
- **Codes leben nur im Arbeitsspeicher**, gelten 5 Minuten und vertragen 5 Fehleingaben. Ein Neustart macht offene Codes ungültig; der Kunde fordert einen neuen an.
- **Bremse:** höchstens 3 Codes je Kontaktweg pro Stunde — das ist der Kostendeckel, denn nur hinterlegte Kontaktwege lösen überhaupt eine Nachricht aus. Dazu 60 Anfragen je Website und Stunde als Flut-Sperre. Beide greifen, *bevor* etwas rausgeht, und zählen auch unbekannte Kennungen mit; täten sie das nicht, verriete die Bremse, wer Kunde ist. Gegen echte Fluten gehört eine Ratenbegrenzung in den Reverse-Proxy.
- **Beide Kontaktwege hinterlegen, wenn möglich.** Die Bremse zählt je Kontaktweg. Wer die Geschäftsnummer aus dem Impressum kennt, kann mit drei Anfragen pro Stunde deren Codes aufbrauchen — die hinterlegte Adresse hat einen eigenen Zähler und bleibt offen. Zwei Wege sind hier kein Luxus, sondern die Ausweichmöglichkeit. (Halb entschärft ist das ohnehin: Wer eine fremde Nummer flutet, schickt dem Inhaber gültige Codes, mit denen der sich anmelden kann.) Gegen gezielten Missbrauch gehört darüber hinaus eine Ratenbegrenzung in den Reverse-Proxy.
- **Ob eine Nachricht ankam, sagt die Seite nicht.** Ein Versandfehler steht im Log des Betreibers, nicht im Browser — sonst wäre er ein Hinweis darauf, dass diese Nummer hinterlegt ist. Der Kunde sieht „Nichts bekommen? Neuen Code anfordern".
- **Eine entfernte Nummer beendet keine laufende Sitzung.** Wer sofort aussperren will, erneuert das Geheimnis: `regoro init --force <site> --nummer …`.
- **Beim Kundenende die Kontaktwege entfernen.** Deutsche Rufnummern werden nach Abschaltung wieder vergeben — eine Nummer auf der Liste, die den Besitzer wechselt, ist ein Zugang, der den Besitzer wechselt. Deshalb die Geschäftsnummer hinterlegen, nicht eine private.

### Versand einrichten (einmal pro Server)

Der Versand ist **betreiberseitig**, nicht je Website: ein Absender für alle Kunden, eine Konfiguration für alle. `/etc/regoro/versand.json`, Mode 0600:

```json
{
  "v": 2,
  "sms":   { "anbieter": "sevenio",  "apiKey": "…", "absender": "REGORO" },
  "email": { "anbieter": "scaleway", "apiKey": "…", "projektId": "…",
             "absenderMail": "editor@deine-domain.de", "absenderName": "Regoro" }
}
```

Beide Abschnitte sind einzeln optional — wer nur SMS anbietet, lässt `email` weg. Ist ein Kanal nicht eingerichtet, sagt die Anmeldeseite das **jedem**, der diesen Reiter wählt; sie verrät damit nichts darüber, welche Kontaktwege hinterlegt sind.

Zwei Fallstricke, die früh auffallen sollen und deshalb schon beim Laden geprüft werden: Die **Absenderkennung darf höchstens 11 Zeichen** haben (seven.io lehnt längere ab) und nur Buchstaben und Ziffern enthalten. Auf eine alphanumerische Kennung kann man nicht antworten — für Einmalcodes genau richtig.

**Zum Ausprobieren ohne Konto und ohne Kosten** gibt es die Attrappe. Sie schickt nichts und schreibt den Code ins Terminal:

```json
{ "v": 2, "sms": { "anbieter": "attrappe" }, "email": { "anbieter": "attrappe" } }
```

Beim Start warnt der Server laut davor. Niemals in Produktion.

## Versionen

Jede Speicherung und jede Wiederherstellung ist ein Git-Commit im Site-Ordner. In der Editor-Leiste gibt es „Versionen" (Vorschau früherer Stände + Wiederherstellen).

## Produktion (TLS, öffentliche Domain)

Annahme: Deine Website ist unter ihrer Domain bereits erreichbar, per HTTPS. Der Editor kommt daneben — ein lokaler Prozess, an den der Proxy nur `/edit*` weiterreicht.

Der einzige Befehl, den du tippst:

```bash
cd /pfad/zu/deiner/site
regoro service --domain deine-domain.de
```

Er schreibt nichts. Er **druckt** drei Dinge, und du kopierst sie:

1. eine fertige **systemd-Unit** — Site-Ordner, Pfad zum `regoro`-Binary und ein aus dem Ordnernamen abgeleiteter Port sind bereits eingesetzt;
2. den passenden **Caddy-Block** — Dotfile-Sperre, `/edit*` an den Editor, Extension-Allowlist für die statische Site;
3. die **Aktivierungsbefehle**, fertig mit deinem Dienstnamen (z. B. `regoro-mueller`), nicht mit Platzhaltern.

Du musst weder die Unit noch den Caddy-Block selbst schreiben. Die Befehle aus Punkt 3 sehen so aus und stehen so in der Ausgabe, nur mit ausgefülltem Namen:

```bash
regoro service /pfad/zu/deiner/site --systemd | sudo tee /etc/systemd/system/regoro-mueller.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now regoro-mueller

regoro service /pfad/zu/deiner/site --caddy --domain deine-domain.de | sudo tee -a /etc/caddy/Caddyfile > /dev/null
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

`--systemd` und `--caddy` geben jeweils nur den reinen Inhalt aus, ohne die Überschriftenzeilen der Übersicht — deshalb lassen sie sich direkt in eine Datei leiten.

**Achtung:** Der Caddy-Block liefert die Site selbst aus (die Allowlist muss vor dem `file_server` greifen). Hast du für die Domain schon einen Block, **ersetze** ihn — nicht anhängen. Dieselbe Konfiguration steht kommentiert in `Caddyfile.example`.

Danach ist der Editor unter `https://deine-domain.de/edit` erreichbar, das `Secure`-Cookie funktioniert, und `EDITOR_INSECURE_COOKIE` brauchst du nie.

### Sammelbetrieb: viele Websites, ein Prozess

Ab einer Handvoll Kunden lohnt der umgekehrte Zuschnitt: **ein** Dienst für alle Websites. Unter einem Sammelverzeichnis liegt je ein Ordner pro Domain — **der Ordnername ist die Zuordnung**:

```
/srv/sites/
  malerbetrieb-schoenbrunn.de/     ← Ordnername = Hostname
    index.html
    .regoro/auth.json
  haustechnik-rossmeisl.de/
```

```bash
regoro serve /srv/sites
```

Beim Start listet der Befehl, was er gefunden hat: je Website die Anzahl der Seiten und ob der Editor aktiv ist. Ordner, deren Name keine Domain ist (`backup_alt`, `www.kunde.de`, `Kunde.DE`), werden genannt — sie sind unter keinem Hostnamen erreichbar.

Welche Website gemeint ist, entscheidet der `Host`-Header **pro Anfrage**. Das heißt:

- **Eine Website aufnehmen:** Ordner ablegen, darin `regoro init`. Kein Neustart, kein Eintrag in einer Konfigurationsdatei.
- **Eine Website abschalten:** `regoro disable <ordner>`. Wirkt sofort, nur für diese eine Website; Seite und Historie bleiben.
- **Eine neue Unterseite** ist sofort editierbar, ohne Neustart.
- **Unbekannter, fehlender oder manipulierter `Host` → 404.** Auf allen Routen.

Ein Login bei Kunde A verschafft bei Kunde B keinen Zugang: jede `auth.json` trägt ihr eigenes HMAC-Geheimnis, ein fremdes Cookie ist dort nicht verifizierbar.

Betriebsdateien wie im Einzelbetrieb, nur mit `--multi`:

```bash
regoro service /srv/sites --multi
```

Der Caddy-Block bedient dann **alle** Kundendomains auf einmal und holt Zertifikate on demand. Dazu gehört ein globaler Block, der **ganz oben** in der Caddyfile stehen muss (`tee -a` hängt ihn ans Ende, wo Caddy ihn nicht akzeptiert) — die Ausgabe sagt es dazu. Kommentiert steht dieselbe Konfiguration in `Caddyfile.multi.example`.

**Der Proxy muss den `Host`-Header durchreichen.** Caddys `reverse_proxy` tut das von sich aus; wer etwas anderes davorsetzt, muss es sicherstellen — sonst landen alle Kunden auf derselben Website oder auf keiner.

Zwei Dinge, die im Sammelbetrieb mehr wiegen als vorher:

- **Der Editor-Port darf nicht aus dem Internet erreichbar sein.** Der Prozess lauscht auf allen Adressen; davor gehört der Reverse-Proxy und eine Firewall. Vorher hing an einem Port eine Website, jetzt hängen alle daran.
- **Nie einen Site-Ordner samt `.regoro/` kopieren**, um eine neue Website anzulegen. Beide trügen dann dieselben Kontaktwege und dasselbe Sitzungs-Geheimnis — der eine Kunde könnte die Seite des anderen bearbeiten. `regoro serve` erkennt das und schaltet den Editor **beider** Seiten ab, mit einer Meldung im Log; die Websites bleiben online. Richtig ist: Ordner ohne `.regoro/` anlegen und `regoro init` darin ausführen.

Alternativ per Docker – siehe `Dockerfile` (Site als Volume mounten; `init` einmalig im gemounteten Ordner ausführen, damit die Auth-Datei zur Laufzeit vorliegt und **nicht** ins Image gebacken wird).

## Konfiguration

| Variable | Default | Zweck |
|---|---|---|
| `PORT` | `8788` | Port des Editor-Servers |
| `EDITOR_INSECURE_COOKIE` | *(nicht gesetzt)* | `=1` lässt das `Secure`-Cookie-Flag weg. Nur nötig, wenn du den Editor über **HTTP unter einem anderen Namen als `localhost`** erreichst (LAN-IP, Hostname). **Nie in Produktion.** |

> **`http://localhost` braucht das nicht.** Browser behandeln `localhost` als vertrauenswürdigen Kontext und akzeptieren `Secure`-Cookies auch über HTTP. `regoro run` genügt.
>
> Über einen anderen Hostnamen ohne TLS verwirft der Browser das Cookie dagegen **stumm** — man meldet sich an und landet wieder auf dem Login. Die Login-Seite warnt in diesem Fall vor und nennt beide Auswege.

## Editor wieder abschalten

```bash
regoro disable            # im Site-Ordner
```

Entfernt `.regoro/`. Die Website wird unverändert weiter ausgeliefert, alle `/edit*`-Routen antworten mit `404` (fail-closed). Umkehrbar mit `regoro init`.

Die Versionshistorie (`.git`) bleibt dabei erhalten — **jede Speicherung im Editor ist ein Commit, und der Editor ist die einzige Quelle dieser Änderungen.** `regoro disable --purge` löscht `.git` mit, aber nur solange nichts anderes darin steht als der Baseline-Commit von `init`. Sobald es gespeicherte Bearbeitungen gibt, bricht `--purge` ab und rührt nichts an.

## Weitere CLI-Optionen

Die CLI kennt außerdem `regoro init <site> --stdin` (Kontaktwege aus stdin, eine je Zeile, für Skripte/Docker) und `--force`.

`init` bricht ab, wenn die Site bereits eine `.regoro/auth.json` hat oder der Ordner keine top-level `*.html` enthält — beides schützt davor, versehentlich den falschen Ordner zu initialisieren oder eine bestehende Einrichtung zu überschreiben. `--force` hebt beide Guards auf; bei bestehender Auth-Datei erneuert es das Cookie-Secret und macht damit **alle laufenden Sitzungen ungültig**. Zum bloßen Hinzufügen oder Entfernen eines Kontaktwegs ist `regoro kennung` der richtige Befehl — es rührt das Secret nicht an.

## Sicherheit

- Client schickt nie Markup, nur **Befehle** (Offsets + Format-Flags) – der Server erzeugt jedes `<strong>/<em>/<u>/<a>/<span style=color>/<br>`. Validiert werden nur `href` und Farbwerte. Kein HTML-Sanitizer-Ratespiel.
- Uploads: Größenlimit + Magic-Byte-Prüfung, SVG blockiert (XSS), sicher generierte Dateinamen. Schreibpfade sind **symlink-sicher** (realpath-Containment, fail-closed) – auch Save/Restore.
- Optimistisches Locking (fileHash) verhindert das Überschreiben zwischenzeitlicher Änderungen.
- Alle Editor-Antworten sind `noindex`/`no-store`.
- Kein Passwort, also auch kein Passwort zum Erraten. Der Einmalcode ist sechsstellig, gilt 5 Minuten und verträgt 5 Fehleingaben — 10⁶ Möglichkeiten bleiben damit unerreichbar. Codes und Bremszähler leben nur im Arbeitsspeicher und stehen in keinem Log.

## Was v1 (noch) nicht kann

- Nur Top-Level-`*.html` sind editierbar (keine verschachtelten Pfade).
- Kein Layout-/Strukturbau, keine neuen Seiten, keine Benutzer-/Rollenverwaltung.
- Keine Benutzerverwaltung: jede Website hat ihre eigenen Kontaktwege in ihrem eigenen Ordner, und wer das Telefon oder das Postfach hat, hat den Zugang.
- Kein Selbstbedienungs-Wechsel der Nummer — die hinterlegt der Betreiber. Sonst könnte sich jemand mit einer eigenen Nummer selbst eintragen.

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

Der Editor-Kern liegt unter `src/` (`contract`/`serve`/`apply`/`git` sind infrastruktur-agnostisch; `auth`/`host`/`server`/`cli` bilden die HTTP-/Setup-Schicht; `service.ts` erzeugt nur Text für `regoro service`). Das Browser-Overlay ist `src/overlay.client.js`.

## Lizenz

[MIT](LICENSE) © 2026 aufi
