---
name: dev-cleanup
description: >-
  Schließt ein FERTIG GEBAUTES Feature in regoro-edit sauber ab: Prüfliste fahren,
  GitHub-PR öffnen, greploop bis grün, mergen, Plan nach done-plans/, Kundendaten-Kopien
  und streunende Dev-Server abräumen. Optional Release-Tag. Läuft autonom, bricht aber ab,
  wenn die Prüfliste nicht grün ist oder der Baum schmutzig. Nutze ihn bei „räum das Feature
  auf", „feature abschließen", „PR + merge + cleanup", „landen".
origin: project
triggers:
  - dev-cleanup
  - feature aufräumen
  - feature abschließen
  - land das feature
---

# dev-cleanup (regoro-edit) — Feature landen und wegräumen

Schwester des gleichnamigen Skills in `regoro-websites`, aber **nicht dasselbe Verfahren**.
Die Unterschiede sind der Grund, warum es ihn zweimal gibt:

| | regoro-websites | **hier** |
|---|---|---|
| Deploy | `git push forgejo main` → Fabrik | **Tag `v*`** → Workflow baut 4 Binaries + `SHA256SUMS` ans Release |
| Remotes | origin + forgejo | **nur origin** |
| E2E-Beleg | `/qa` gegen `infra/staging/` | **Prüfliste unten** |
| Handoffs | Fabrik-Postfach | gibt es nicht |
| Aufräumen | Staging-Instanz | **Kundendaten unter `/tmp`**, Dev-Server |

**Merge ≠ Release.** Ein gemergeter PR ändert für installierte Kunden **nichts** — sie
haben ein Binary aus einem Release. Ausgeliefert wird erst durch einen Tag. „Gemerged" ist
hier also ein schwächerer Zustand als drüben „deployt"; sag es im Bericht genau.

---

## 0. Abbruchbedingungen — sonst nichts anfassen

1. **Prüfliste grün** (Schritt 1). Fehlt ein Beleg in dieser Sitzung: **Abbruch**.
2. **Eigener Arbeitsbaum sauber.** `git status --porcelain` leer.
3. **Nur den EIGENEN Worktree abräumen.** `git worktree list` zeigt hier regelmäßig fremde
   (andere Sitzungen am selben Repo). Ein fremder Worktree wird nicht angefasst — ein
   sauberer Baum beweist nicht, dass niemand daran arbeitet.

## 1. Die Prüfliste (aus CLAUDE.md, in dieser Reihenfolge)

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun x tsc --noEmit                      # ZUERST — bun test prüft KEINE Typen
bun test                                # alle grün, keine übersprungenen Dateien
bun build src/overlay.client.js --target=browser >/dev/null   # tsc sieht die Datei nicht
caddy validate --config Caddyfile.example --adapter caddyfile
caddy validate --config Caddyfile.multi.example --adapter caddyfile
bun scripts/gen-notices.ts --check      # sonst roter Release-Build
```

**`tsc` vor `bun test`, immer.** `bun test` führt TypeScript aus, ohne es zu prüfen — ein
Typfehler ist für die Suite unsichtbar, und Testfehler nach gescheitertem Typecheck sind
fast immer Folgefehler.

**Wurde am Asset-Laden, an Pfaden oder an `service.ts` gearbeitet**, zusätzlich von Hand
(die Suite deckt nur den dev-Pfad ab):

```bash
bun build --compile src/cli.ts --outfile /tmp/regoro-bin
SITE=$(mktemp -d); cp -r examples/site/. "$SITE/"
PATH=/usr/bin:/bin /tmp/regoro-bin init "$SITE" --email test@example.de
PATH=/usr/bin:/bin /tmp/regoro-bin licenses | wc -c        # ~620.000, nicht 0
PORT=18899 PATH=/usr/bin:/bin /tmp/regoro-bin run "$SITE" &  # run kennt KEIN --port
curl -so /dev/null -w '%{http_code} %{size_download}\n' localhost:18899/edit-assets/overlay.js
                                                            # 200 + ~116 KB, nicht 404
regoro service "$SITE" --systemd > /tmp/x.service && systemd-analyze verify /tmp/x.service
```

## 2. PR öffnen

```bash
git push -u origin <feature-branch>
gh pr create --base main --head <feature-branch> \
  --title "<typ(scope): kurz>" --body "<was & warum>"
```

## 3. greploop — eine substanzielle Runde

Skill `greploop` gegen den PR. **P1/actionable fixen, Stil-Nitpicks nicht endlos jagen.**
Jeder Fix bekommt nach Möglichkeit einen Regressionstest, der ohne ihn rot wäre.

**Wo ein Test eine Abwesenheit behauptet** („kein Leck", „keine Datei außerhalb"), gehört
eine Gegenprobe daneben, die den Messapparat prüft. Ohne sie ist der Test auch dann grün,
wenn er gar nichts tut — in diesem Repo dreimal an einem Tag passiert.

## 4. Mergen

```bash
gh pr merge <NN> --merge
git push origin --delete <feature-branch>
git ls-remote origin "refs/heads/<feature-branch>"   # leer = weg
```

**`--delete-branch` NICHT benutzen** — scheitert im geteilten Checkout, weil `gh` lokal auf
`main` wechseln will, während `main` im Haupt-Checkout liegt. Der Merge selbst ist dann
längst durch (API-Aufruf); nur das Löschen des Remote-Branches bleibt still aus.

## 5. Release — nur wenn ausgeliefert werden soll

**Optional und eine eigene Entscheidung.** Vorher `VERSION` in `src/cli.ts` und
`package.json` gemeinsam anheben (ein Test nagelt beide aneinander).

```bash
git -C <haupt-checkout> fetch origin && git -C <haupt-checkout> merge --ff-only <merge-sha>
git tag v<x.y.z> && git push origin v<x.y.z>
gh run watch      # 4 Binaries + SHA256SUMS ans Release
```

Asset-Namen müssen zu `install.sh` passen (`regoro-<os>-<arch>`). Kein Tag → kein Release →
kein Kunde bekommt die Änderung.

## 6. Plan nach done-plans/

Workspace `~/.gstack/projects/regoro-edit/` (von hier `docs/gstack/`). **`mv`, nicht
`git mv`** — der Workspace ignoriert alles (`*`), publiziert wird über eine Allowlist.

```bash
cd ~/.gstack && git pull --rebase --autostash
HOCH=$(ls projects/regoro-edit/done-plans/ | sed -n 's/^0*\([0-9][0-9]*\)-.*/\1/p' | sort -n | tail -1)
N=$(printf "%03d" $(( ${HOCH:-0} + 1 )))
mv projects/regoro-edit/<plan>.md projects/regoro-edit/done-plans/${N}-<thema>.md
```

Höchste Nummer + 1, **nicht** `wc -l` (jede Lücke vergibt sonst eine Nummer zweimal).
Abschlussnotiz ans Dateiende, dann `git add -f`, committen, pushen.

## 7. Aufräumen — hier liegt der repo-eigene Teil

**a) Kundendaten-Kopien unter `/tmp`.** Tests und Handprüfungen kopieren echte Kundenseiten
in temporäre Ordner (DSGVO: gehören nicht dauerhaft dorthin). **Nach Inhaltsmerkmalen
suchen, nicht nach Namen** — die Ordner heißen nicht alle `regoro-*`:

```bash
find /tmp -maxdepth 3 \( -name design.json -o -name seo-report.md -o -name images.json \) 2>/dev/null
```

Gemessene Lehre: Eine Suche nach `regoro-*` fand 2,3 MB; die Inhaltssuche fand 13,8 MB.
**Vor dem Löschen fragen, wenn der Ordner nicht dir gehört** — jemand misst vielleicht noch.

**b) Streunende Dev-Server.** Prüfstände und `run`-Instanzen laufen sonst tagelang weiter:

```bash
ss -lptnH | grep -E "bun|regoro"
```

**Nie `pgrep -f`/`pkill -f`** — das Muster trifft die eigene Kommandozeile, `pkill` killt die
suchende Shell. Vor dem Beenden am `cmdline` prüfen, ob der Prozess wirklich dir gehört.

**c) Worktree** (falls einer benutzt wurde), aus dem Haupt-Checkout heraus:

```bash
cd /srv/work/repos/regoro-edit
git worktree remove <pfad>     # KEIN --force: eine Weigerung ist ein Befund
git worktree prune
git branch -d <feature-branch>  # -d, nicht -D
```

## Abschlussbericht

- PR #<NN> gemerged, lokal `main == origin/main` (`<kurz-sha>`).
- **Release: getaggt `v<x.y.z>` / NICHT getaggt** — bei „nicht": ausdrücklich sagen, dass
  installierte Kunden die Änderung noch nicht haben.
- Plan → `done-plans/${N}-<thema>.md`.
- Aufgeräumt: <Kundendaten-Ordner>, <beendete Server>, <Worktree>.

## Verbote

- **Nie mergen ohne grüne Prüfliste**, und `tsc` vor `bun test`.
- **Nie „gemerged" als „ausgeliefert" melden.** Ohne Tag hat kein Kunde die Änderung.
- **Nie `--force`/`-D`, um etwas durchzukriegen.** Jede Weigerung von git ist ein Signal.
- **Nie fremde Worktrees oder fremde Prozesse abräumen.**
- **Nie Kundendaten unter `/tmp` löschen, ohne den Eigentümer zu fragen** — und nie nur
  nach Namensmuster suchen.
