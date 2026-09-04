#!/usr/bin/env python3
"""Fährt die Fälle von `seitenleiste-pruefstand.ts` maschinell und vergleicht.

WAS ER TUT: Der Prüfstand druckt beim Start je Fall einen fertigen Aufruf für den
headless-Browser samt Sollwert. Dieser Treiber liest genau diese Ausgabe, führt die
Schritte aus und vergleicht das Ergebnis des letzten `js`-Aufrufs mit dem Sollwert.

AUFRUF:
    bun scripts/seitenleiste-pruefstand.ts > /tmp/pruefstand.log &
    python3 scripts/pruefstand-treiber.py /tmp/pruefstand.log            # alle Fälle
    python3 scripts/pruefstand-treiber.py /tmp/pruefstand.log praefix    # nur diese
    python3 scripts/pruefstand-treiber.py --neustart /tmp/pruefstand.log # Browser vorher frisch
Rückgabewert 0, wenn alle gefahrenen Fälle grün sind, sonst 1.

WARUM ER KEINE EIGENEN SOLLWERTE FÜHRT — die wichtigste Regel dieser Datei:
Die Erwartung steht ausschließlich im Prüfstand, neben dem Fall, zu dem sie gehört.
Eine zweite Liste hier wäre eine zweite Wahrheit: Sie kann zum Fall passen oder nicht,
und wenn sie es nicht tut, ist unklar, welche von beiden recht hat. Genauso wenig darf
hier ein Fall stehen, den der Prüfstand nicht kennt. Dieser Treiber ist ein
Ausführungswerkzeug, kein Prüfling — er weiß nichts über den Editor und soll nichts
über ihn wissen.

JEDER MESSLAUF MIT `--neustart` — Vorschrift, nicht Empfehlung. `browse` hält einen
langlebigen Browser, und die Fälle öffnen laufend Ereignisströme auf dieselbe
Herkunft. Gemessen: Nach etwa 120 Seitenaufrufen kommt `/edit-assets/overlay.js`
nicht mehr durch; die Seite lädt mit 200, das Overlay läuft nie an, und ab da meldet
jede Prüfung eine Leiste, die es nicht gibt.

Ein Fehler im Aufbau der Leiste sieht GENAUSO aus (ebenfalls gemessen). Beides ist
von außen nicht zu unterscheiden, deshalb steht hier kein Erkennungszeichen: Wer
eines hätte, klärte damit früher oder später einen echten Einbruch weg. Aus einem
frisch gestarteten Browser heraus stellt sich die Frage nicht — dann kann es die
Ermüdung nicht gewesen sein. Ohne Neustart ist ein Einbruch nicht zuzuordnen.
`browse` braucht dafür `bun` im PFAD, sonst startet es seinen Server nicht.
"""
import json
import os
import re
import subprocess
import sys
import time

# Wo der Browser liegt, sagt der Prüfstand selbst (Zeile `B=…`) — auch das keine
# zweite Quelle. Der Wert hier greift nur, wenn die Zeile fehlt.
BROWSE_VORGABE = "~/.claude/skills/gstack/browse/dist/browse"


def browse_pfad(text: str) -> str:
    treffer = re.search(r"^\s*B=(\S+)\s*$", text, flags=re.M)
    return os.path.expanduser(treffer.group(1) if treffer else BROWSE_VORGABE)


def faelle(text: str):
    """Liefert (name, schritte, sollwert) je Fall aus der Prüfstand-Ausgabe."""
    bloecke = re.split(r"^── (.+?) ──$", text, flags=re.M)
    for i in range(1, len(bloecke) - 1, 2):
        name = bloecke[i].strip()
        schritte, soll = [], None
        for zeile in bloecke[i + 1].splitlines():
            z = zeile.strip()
            if z.startswith("Sollwert:"):
                soll = z[len("Sollwert:"):].strip()
            elif z.startswith("$B ") or z.startswith("sleep "):
                schritte.append(z)
        if soll is not None and schritte:
            yield name, schritte, soll


def zerlege(schritt: str):
    """'$B js "code"' -> ['js', code];  '$B goto URL' -> ['goto', URL]."""
    rest = schritt[3:].strip()
    m = re.match(r'^(\w+)\s+"(.*)"$', rest, flags=re.S)
    if m:
        return [m.group(1), m.group(2).replace('\\"', '"')]
    return rest.split(None, 1)


def skriptfehler(browse: str):
    """Was der Fehlerfänger der Fixture aufgesammelt hat (siehe FEHLERFAENGER).

    KEINE fallabhängige Erwartung, sondern eine allgemeine: In keinem Fall darf
    eine unbehandelte Ausnahme fliegen. Das ist keine zweite Wahrheit über den
    Editor, sondern die Gesundheitsprüfung des Laufs — und die einzige, die
    diese Fehlerklasse überhaupt sieht.

    Grenze, die man kennen muss: `window.__fehler` lebt im Dokument. Lädt ein
    Fall die Seite neu (Übernehmen, Verwerfen, Wiederherstellen), fängt die
    Liste bei null an — Fehler VOR dem Reload sind dann weg.
    """
    p = subprocess.run([browse, "js", "JSON.stringify(window.__fehler||[])"],
                       capture_output=True, text=True, timeout=60)
    try:
        return json.loads((p.stdout or "").strip()) or []
    except Exception:
        return []


def fahre(browse: str, schritte, soll: str):
    letzte = None
    for schritt in schritte:
        if schritt.startswith("sleep "):
            time.sleep(float(schritt.split()[1]))
            continue
        p = subprocess.run([browse] + zerlege(schritt), capture_output=True,
                           text=True, timeout=180)
        letzte = (p.stdout or "").strip()
        if p.returncode != 0:
            return False, "browse-Fehler: " + (p.stderr or "")[:300]

    fehler = skriptfehler(browse)
    nachsatz = ("\n   SKRIPTFEHLER: " + "; ".join(str(f) for f in fehler)) if fehler else ""

    try:
        ist, erwartet = json.loads(letzte), json.loads(soll)
    except Exception:
        # Kein JSON (z.B. leere Ausgabe, weil ein Schritt nichts gefunden hat) —
        # dann roh vergleichen und den Istwert zeigen.
        return (letzte == soll and not fehler), "IST: %r%s" % (letzte, nachsatz)
    kurz = lambda o: json.dumps(o, ensure_ascii=False, sort_keys=True)
    if ist == erwartet and fehler:
        # Sollwert getroffen UND trotzdem etwas geflogen: Das ist der Fall, den
        # es ohne den Fänger gar nicht gäbe — grün mit einem Fehler darunter.
        return False, "Sollwert stimmt, aber:%s" % nachsatz
    return ist == erwartet, "IST:  %s\n   SOLL: %s%s" % (kurz(ist), kurz(erwartet), nachsatz)


def main() -> int:
    argv = sys.argv[1:]
    neustart = "--neustart" in argv
    argv = [a for a in argv if a != "--neustart"]
    if not argv:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        print("Aufruf: pruefstand-treiber.py [--neustart] <pruefstand.log> [Fallname …]",
              file=sys.stderr)
        return 2

    text = open(argv[0], encoding="utf-8").read()
    nur = set(argv[1:])
    browse = browse_pfad(text)

    if neustart:
        # `stop` und DANN ein Probeaufruf, nicht `restart`.
        #
        # Gemessen: `browse restart` meldet „Server crashed twice in a row —
        # aborting" und gibt einen Fehler zurück, obwohl alles in Ordnung ist;
        # der nächste Aufruf startet den Server von selbst und arbeitet normal.
        # Auf `restart` zu hören hieße, einen gesunden Lauf abzubrechen. `stop`
        # räumt zuverlässig ab, der Probeaufruf zeigt, ob es wirklich geht.
        subprocess.run([browse, "stop"], capture_output=True, text=True, timeout=120)
        time.sleep(2)
        # Als Probe die erste Adresse aus dem Log — `about:blank` lässt `browse`
        # nicht zu („scheme not allowed"), und eine erfundene Adresse hier wäre
        # wieder eine zweite Quelle. Nebenwirkung, die passt: Der Prüfstand wird
        # gleich mitgeprüft, bevor 31 Fälle gegen einen toten Server laufen.
        erste = re.search(r"^\s*\$B goto (\S+)\s*$", text, flags=re.M)
        if not erste:
            print("Im Log steht kein `goto` — ist das die Ausgabe des Prüfstands?",
                  file=sys.stderr)
            return 2
        p = subprocess.run([browse, "goto", erste.group(1)], capture_output=True,
                           text=True, timeout=120)
        if p.returncode != 0 or "Navigated" not in (p.stdout or ""):
            print("Browser oder Prüfstand nicht erreichbar. Steht `bun` im PFAD, "
                  "und läuft der Prüfstand?\n" +
                  ((p.stderr or "") + (p.stdout or ""))[:300], file=sys.stderr)
            return 2

    gruen, rot = 0, []
    for name, schritte, soll in faelle(text):
        if nur and name not in nur:
            continue
        ok, info = fahre(browse, schritte, soll)
        if ok:
            gruen += 1
            print("  ok   %s" % name, flush=True)
        else:
            rot.append(name)
            print("  ROT  %s\n   %s" % (name, info), flush=True)
    print("\n%d grün, %d rot%s" % (gruen, len(rot), (": " + ", ".join(rot)) if rot else ""))
    return 1 if rot else 0


if __name__ == "__main__":
    sys.exit(main())
