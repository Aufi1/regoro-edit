/**
 * Prüfstand für die KI-Seitenleiste in `src/overlay.client.js`.
 *
 * WARUM ES DAS GIBT: `overlay.client.js` ist die einzige Datei dieses Repos mit
 * echtem Kundenkontakt — und die einzige, die von keiner Prüfung erfasst wird.
 * `tsc` sieht sie nicht an (kein TypeScript), und `bun build --target=browser`
 * prüft nur, ob sie sich parsen lässt. Ob die Leiste das Richtige ANZEIGT,
 * stand bis hierher nirgends fest. Zwei echte Fehler kamen genau dort heraus:
 * Sie meldete einen Erfolg für einen Lauf, der nichts geändert hat, und sie
 * hätte einen nachgereichten Lauf nie angezeigt.
 *
 * Ein echter Lauf taugt dafür schlecht: Er kostet Geld, braucht `bwrap` und
 * einen Modellzugang, dauert Minuten und liefert jedes Mal etwas anderes. Der
 * interessante Teil — was die Leiste aus einer Ereignisfolge macht — hängt von
 * alldem gar nicht ab. Dieser Prüfstand liefert deshalb die ECHTE
 * `overlay.client.js` aus und dazu erfundene Ereignisfolgen: kein Modell, kein
 * Kontingent, keine Sandbox, kein Netz, immer dasselbe Ergebnis.
 *
 * Aufruf:
 *   bun scripts/seitenleiste-pruefstand.ts            # Port 8794
 *   PORT=9000 bun scripts/seitenleiste-pruefstand.ts
 *
 * VORHER NACHSEHEN, WAS SCHON LÄUFT:
 *   ss -lptnH "sport = :8794"      # wer hält den Port?
 *   pgrep -af "cli.ts run"         # laufende Editor-Server
 * Ein zweiter Prozess auf demselben Port startet NICHT, und ein Browser, der
 * trotzdem antwortet, wird von der alten Fassung bedient. Zweimal passiert:
 * Beide Male hielt ich einen behobenen Fehler für ungelöst, weil ich gegen
 * einen Zombie von vorhin gemessen habe. Dieses Skript bricht deshalb mit
 * einer Erklärung ab statt mit einem Stapelabzug (siehe unten).
 *
 * NICHT blind `pkill` fahren, aus zwei Gründen: Auf dieser Maschine laufen
 * parallel E2E-Läufe anderer Beteiligter, und ein `pkill -f <muster>` trifft
 * die eigene Kommandozeile mit, wenn das Muster darin vorkommt — dann beendet
 * der Aufruf die Shell, die ihn abgesetzt hat. `ss` nennt die PID direkt und
 * kann sich nicht selbst treffen; danach gezielt `kill <PID>`.
 *
 * Danach die ausgegebenen Adressen im Browser öffnen und gegen die genannte
 * Erwartung prüfen. Die Leiste öffnet sich über den Knopf „KI-Assistent“; wo
 * ein Auftrag nötig ist, steht es beim jeweiligen Fall.
 *
 * MASCHINELL statt von Hand: Das Skript druckt je Fall einen fertigen Aufruf
 * für den headless-Browser aus gstack (`~/.claude/skills/gstack/browse`, in
 * CLAUDE.md im Testabschnitt genannt) samt Sollwert. Der Treiber liegt
 * AUSSERHALB des Repos und ist bewusst KEINE Abhängigkeit — er ist auf den
 * Entwicklungsmaschinen da, nicht in der CI. Genau deshalb ist das hier ein
 * Werkzeug und keine `*.test.ts`: Ein Test, der überall außer auf einer
 * Maschine übersprungen wird, sieht wie Abdeckung aus und ist keine.
 */
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8794);
const OVERLAY = join(import.meta.dir, "..", "src", "overlay.client.js");

/** Ein SSE-Rahmen, so wie host.ts ihn baut. */
function rahmen(name: string, daten: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(daten)}\n\n`;
}

interface Fall {
  /** Was der Prüfer tun muss. */
  tun: string;
  /** Was danach zu sehen sein MUSS. */
  erwartung: string;
  /** Ist der Modellzugang eingerichtet? false = die Leiste darf es nicht geben. */
  ki: boolean;
  /** Die Ereignisfolge, die `/edit/agent/events` ausliefert. */
  ereignisse: string[];
  /** Muss vor der Prüfung ein Auftrag abgeschickt werden? */
  auftrag?: boolean;
  /**
   * Liefert der Ereignisstrom seine Folge AUCH OHNE Auftrag aus?
   *
   * Das ist die Nachlese des echten Servers: ein beendeter Lauf, den er beim
   * Öffnen noch einmal ausreicht. Stand einmal als `fallName === "…"` fest im
   * Server dieses Prüfstands — dann bekommt ein neuer Nachlese-Fall
   * stillschweigend „Kein Lauf aktiv." und sieht aus wie ein Fehler im Overlay.
   * Genau so ist es beim Bauen der Verlaufs-Fälle passiert.
   */
  nachlese?: boolean;
  /**
   * Gespeicherte Gespräche dieser Website, jüngstes zuerst.
   *
   * `undefined` heißt: Die Routen `/edit/agent/verlaeufe` und `.../verlauf`
   * antworten 404 — ein Server auf älterem Stand. Auch DAS ist ein Prüffall:
   * Die Leiste muss dann arbeiten wie vor der Gesprächsliste.
   */
  gespraeche?: Gespraech[];
  /** Weitere Schritte im Browser, nach Öffnen/Abschicken. */
  schritte?: string[];
  /**
   * Verzögert NUR `/edit/agent/verlauf`, nicht die Liste.
   *
   * Damit wird ein Wettlauf reproduzierbar, der sonst nur auf einer langsamen
   * Leitung auftritt und sich deshalb nicht prüfen ließe: Der Kunde klickt,
   * während die erste Antwort noch unterwegs ist. Ohne diese Schraube wäre der
   * Fall entweder immer grün (schnelles Loopback) oder gar nicht zu stellen.
   */
  verlaufVerzoegerungMs?: number;
  /**
   * Kein Warten zwischen Öffnen und den Zusatzschritten.
   *
   * Normalerweise steht dort `sleep 2`, damit das Gespräch geladen ist, bevor
   * geklickt wird. Für einen Wettlauf-Fall ist genau das tödlich: Er MUSS in
   * das offene Zeitfenster klicken. Beim ersten Versuch war der Fall deshalb
   * auch mit absichtlich entferntem Wächter grün — ein Nachweis, der nicht
   * anschlagen kann, beweist durch sein Ausbleiben nichts.
   */
  sofort?: boolean;
  /** JS-Ausdruck, im Browser ausgewertet — liefert das Prüfergebnis als JSON. */
  pruefung: string;
  /** Was dieser Ausdruck liefern MUSS. */
  sollwert: string;
}

/** Ein gespeichertes Gespräch, wie `leseNachrichten` es liefert. */
interface Gespraech {
  id: string;
  titel: string;
  /** ms vor jetzt — damit die Fälle nicht mit der Uhr veralten. */
  vorMs: number;
  zeilen: { von: "kunde" | "agent" | "werkzeug"; text: string }[];
}

/** Kurzform für die immer gleichen Abfragen im Prüfausdruck. */
const Q = {
  gruen: "document.querySelectorAll('.__regoro-afertig').length",
  blasen: "document.querySelectorAll('#__regoro-agent .__regoro-anachricht').length",
  werkzeuge: "document.querySelectorAll('.__regoro-awerkzeug').length",
  reload:
    "!!Array.from(document.querySelectorAll('#__regoro-agent button'))" +
    ".find(b=>b.textContent==='Seite neu laden')",
  gesperrt: "document.querySelector('.__regoro-asenden').disabled",
  /** Der Verlauf als Text, in Reihenfolge — so sieht der Kunde ihn. */
  zeilen:
    "Array.from(document.querySelectorAll('#__regoro-agent .__regoro-averlauf > *'))" +
    ".map(function(n){return n.textContent})",
  listeOffen: "!document.querySelector('.__regoro-aliste').hidden",
  listenTitel:
    "Array.from(document.querySelectorAll('.__regoro-aetitel')).map(function(n){return n.textContent})",
};

/** Klick auf „Gespräche" im Kopf der Leiste. */
const LISTE_AUF = "js \"document.querySelector('.__regoro-agespraeche').click()\"";

const FAELLE: Record<string, Fall> = {
  "mit-dateien": {
    tun: "Leiste öffnen, irgendeinen Auftrag abschicken.",
    erwartung:
      "Grüne Abschlussblase mit der Liste „index.html“ und einem Knopf „Seite neu laden“. " +
      "Der gestreamte Text und die Zusammenfassung stehen NUR EINMAL da, nicht zweimal.",
    ki: true,
    auftrag: true,
    pruefung: `JSON.stringify({gruen:${Q.gruen},dateien:Array.from(document.querySelectorAll('.__regoro-adateien li')).map(l=>l.textContent),reload:${Q.reload},blasen:${Q.blasen}})`,
    sollwert: '{"gruen":1,"dateien":["index.html"],"reload":true,"blasen":2}',
    ereignisse: [
      rahmen("werkzeug", { name: "write_file", kurz: "schreibt index.html" }),
      // Absichtlich in Stücke zerlegt: Das Modell streamt Token für Token —
      // an einem echten Lauf gemessen über sechzig Ereignisse für zwei Sätze.
      // Daraus darf EINE Sprechblase werden, nicht sechzig.
      rahmen("text", { inhalt: "Ich ändere " }),
      rahmen("text", { inhalt: "den Absatz " }),
      rahmen("text", { inhalt: "auf der Startseite." }),
      rahmen("tokens", { gesamt: 1234, frei: 198_766 }),
      rahmen("fertig", {
        zusammenfassung: "Ich ändere den Absatz auf der Startseite.",
        dateien: ["index.html"],
        commit: "a1b2c3d",
      }),
    ],
  },

  "ohne-dateien": {
    tun: "Leiste öffnen, irgendeinen Auftrag abschicken.",
    erwartung:
      "KEINE grüne Blase, KEIN Knopf „Seite neu laden“, KEIN Hinweis „Die Änderung ist live“. " +
      "Stattdessen rot „An der Website wurde nichts geändert.“ und die Einladung, es erneut " +
      "zu versuchen. (Ein Abschluss ohne geänderte Dateien ist kein Erfolg — genau hier " +
      "meldete die Leiste einmal „Der Auftrag wurde bearbeitet.“, während nichts passiert war.)",
    ki: true,
    auftrag: true,
    pruefung: `JSON.stringify({gruen:${Q.gruen},reload:${Q.reload},warnung:(document.querySelector('#__regoro-agent .__regoro-anachricht .__regoro-awarn')||{}).textContent})`,
    sollwert: '{"gruen":0,"reload":false,"warnung":"An der Website wurde nichts geändert."}',
    // Entspricht dem Attrappen-Szenario `nichts-tun`: Der Agent hält den Wunsch
    // für erfüllt und meldet fertig, ohne etwas zu schreiben. Der häufige Fall,
    // nicht der konstruierte.
    ereignisse: [
      rahmen("fertig", { zusammenfassung: "Der Auftrag wurde bearbeitet.", dateien: [], commit: null }),
    ],
  },

  "nie-ein-lauf": {
    tun: "Nur die Leiste öffnen, nichts abschicken.",
    erwartung:
      "Das Chatfenster bleibt LEER und die Eingabe ist frei. Keine Fehlerblase. " +
      "„Kein Lauf aktiv.“ ist die Abwesenheit einer Nachricht, kein Fehler — wer die " +
      "Leiste zum ersten Mal öffnet, hat nichts falsch gemacht.",
    ki: true,
    pruefung: `JSON.stringify({blasen:${Q.blasen},fehler:document.querySelectorAll('.__regoro-afehler').length,gesperrt:${Q.gesperrt}})`,
    sollwert: '{"blasen":0,"fehler":0,"gesperrt":false}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "nachlese-fehler": {
    tun: "Nur die Leiste öffnen, nichts abschicken.",
    erwartung:
      "Der zuletzt GESCHEITERTE Lauf wird nachgereicht: die Werkzeugzeile und der echte " +
      "Grund. (Ohne das versucht es der Kunde nach einem Reload noch einmal und bezahlt " +
      "denselben Fehlschlag zweimal.)",
    ki: true,
    nachlese: true,
    pruefung: `JSON.stringify({werkzeuge:${Q.werkzeuge},fehler:(document.querySelector('.__regoro-afehler')||{}).textContent})`,
    sollwert: '{"werkzeuge":1,"fehler":"Die Datei enthält ein neues Inline-Skript."}',
    ereignisse: [
      rahmen("werkzeug", { name: "write_file", kurz: "schreibt leistungen.html" }),
      rahmen("fehler", { grund: "Die Datei enthält ein neues Inline-Skript." }),
    ],
  },

  "kontingent-sprengen": {
    tun: "Leiste öffnen, irgendeinen Auftrag abschicken.",
    erwartung:
      "Der Lauf arbeitet erst (Werkzeugzeile), dann reißt das Kontingent. Danach MUSS " +
      "dreierlei zugleich stimmen: eine Fehlerblase mit dem Grund, die Kontingentzeile " +
      "auf „aufgebraucht“ EINGEFÄRBT, und „Auftrag geben“ GESPERRT. Ein Kunde, der hier " +
      "noch einmal klicken kann, läuft in eine 429.",
    ki: true,
    auftrag: true,
    pruefung: `JSON.stringify({werkzeuge:${Q.werkzeuge},fehler:document.querySelectorAll('.__regoro-afehler').length,eingefaerbt:document.querySelector('.__regoro-aquota').className.indexOf('aleer')>-1,gesperrt:${Q.gesperrt}})`,
    sollwert: '{"werkzeuge":1,"fehler":1,"eingefaerbt":true,"gesperrt":true}',
    // Entspricht dem Attrappen-Szenario `kontingent-sprengen`. Die Reihenfolge
    // ist der Punkt: ohne vorangegangene Arbeit gäbe es keinen Übergang zu sehen.
    // `frei: 0` und nicht negativ — der Server klammert mit Math.max(0, …).
    ereignisse: [
      rahmen("werkzeug", { name: "write_file", kurz: "schreibt leistungen.html" }),
      rahmen("tokens", { gesamt: 999_999_999, frei: 0 }),
      rahmen("fehler", {
        grund: "Das Monatskontingent ist mitten im Auftrag aufgebraucht. Es wurde nichts geändert; am Monatsersten geht es weiter.",
      }),
    ],
  },

  "verlauf-nachlesen": {
    tun: "Nur die Leiste öffnen, nichts abschicken.",
    erwartung:
      "Das Gespräch von vorhin steht da — Auftrag, Werkzeugzeile, Antwort. Der letzte " +
      "Lauf wird aus dem Puffer NUR mit seinem Ausgang ergänzt (Dateiliste), NICHT " +
      "noch einmal mit seinem Wortlaut. Genau hier stünde sonst jeder Satz doppelt: " +
      "einmal aus dem gespeicherten Verlauf, einmal aus der Nachlese.",
    ki: true,
    nachlese: true,
    gespraeche: [
      {
        id: "g-heute",
        titel: "Leg eine Seite über Wärmepumpen an.",
        vorMs: 60_000,
        zeilen: [
          { von: "kunde", text: "Leg eine Seite über Wärmepumpen an." },
          { von: "werkzeug", text: "schreibt waermepumpen.html" },
          { von: "agent", text: "Die Seite steht und ist verlinkt." },
        ],
      },
    ],
    pruefung: `JSON.stringify({zeilen:${Q.zeilen},dateien:Array.from(document.querySelectorAll('.__regoro-adateien li')).map(function(l){return l.textContent}),reload:${Q.reload}})`,
    sollwert:
      '{"zeilen":["Leg eine Seite über Wärmepumpen an.","schreibt waermepumpen.html",' +
      '"Die Seite steht und ist verlinkt.","Der letzte Auftrag hat diese Dateien geändert:' +
      'waermepumpen.html"],"dateien":["waermepumpen.html"],"reload":false}',
    // Dieselbe Folge wie ein echter Nachlese-Lauf: Text UND Abschluss. Der Text
    // muss unterdrückt werden, der Abschluss nicht.
    ereignisse: [
      rahmen("text", { inhalt: "Die Seite steht " }),
      rahmen("text", { inhalt: "und ist verlinkt." }),
      rahmen("fertig", {
        zusammenfassung: "Die Seite steht und ist verlinkt.",
        dateien: ["waermepumpen.html"],
        commit: "a1b2c3d",
      }),
    ],
  },

  "verlauf-blaettern": {
    tun: "Leiste öffnen, dann im Chatfenster ganz nach oben scrollen.",
    erwartung:
      "Zuerst stehen nur die JÜNGSTEN Zeilen da, darüber „↑ Ältere Beiträge“. Nach dem " +
      "Hochscrollen sind die älteren davor eingehängt — vollständig, in richtiger " +
      "Reihenfolge und OHNE Dublette. Ist alles geladen, verschwindet der Hinweis.",
    ki: true,
    gespraeche: [
      {
        id: "g-lang",
        titel: "Auftrag 1",
        vorMs: 60_000,
        zeilen: Array.from({ length: 46 }, (_, i) => ({
          von: (i % 2 === 0 ? "kunde" : "agent") as "kunde" | "agent",
          text: `Zeile ${i + 1}`,
        })),
      },
    ],
    schritte: [
      // Zweimal greifen: 46 Zeilen bei 20 je Seite sind drei Seiten.
      "js \"document.querySelector('.__regoro-averlauf').scrollTop=0\"",
      "sleep 1",
      "js \"document.querySelector('.__regoro-averlauf').scrollTop=0\"",
    ],
    pruefung:
      `JSON.stringify({anzahl:${Q.zeilen}.length,erste:${Q.zeilen}[0],letzte:${Q.zeilen}.slice(-1)[0],` +
      `dubletten:${Q.zeilen}.length-new Set(${Q.zeilen}).size,hinweis:!!document.querySelector('.__regoro-amehr')})`,
    sollwert: '{"anzahl":46,"erste":"Zeile 1","letzte":"Zeile 46","dubletten":0,"hinweis":false}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "verlauf-waehlen": {
    tun: "Leiste öffnen, oben rechts auf „Gespräche“ klicken, das ÄLTERE Gespräch anklicken.",
    erwartung:
      "Die Liste nennt „Neues Gespräch“ und beide Titel. Nach dem Klick auf das ältere " +
      "steht dessen Inhalt im Chatfenster und der des jüngeren ist WEG — nicht darunter " +
      "gehängt. Zwei Gespräche zu vermischen wäre schlimmer als keines zu zeigen.",
    ki: true,
    gespraeche: [
      {
        id: "g-jung",
        titel: "Das jüngere Gespräch",
        vorMs: 60_000,
        zeilen: [{ von: "kunde", text: "jung: Auftrag" }, { von: "agent", text: "jung: Antwort" }],
      },
      {
        id: "g-alt",
        titel: "Das ältere Gespräch",
        vorMs: 5 * 24 * 60 * 60 * 1000,
        zeilen: [{ von: "kunde", text: "alt: Auftrag" }, { von: "agent", text: "alt: Antwort" }],
      },
    ],
    schritte: [
      LISTE_AUF,
      "sleep 1",
      "js \"Array.from(document.querySelectorAll('.__regoro-aetitel'))" +
        ".find(function(n){return n.textContent==='Das ältere Gespräch'}).click()\"",
    ],
    pruefung: `JSON.stringify({zeilen:${Q.zeilen},listeOffen:${Q.listeOffen}})`,
    sollwert: '{"zeilen":["alt: Auftrag","alt: Antwort"],"listeOffen":false}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "verlauf-liste": {
    tun: "Leiste öffnen, oben rechts auf „Gespräche“ klicken.",
    erwartung:
      "Die Liste klappt auf und beginnt mit „Neues Gespräch“, darunter die gespeicherten " +
      "Gespräche mit ihrem ersten Satz als Titel. Der Titel ist WÖRTLICHER Kundentext — " +
      "er darf nie als HTML gedeutet werden. Deshalb steht hier eines mit spitzen Klammern.",
    ki: true,
    gespraeche: [
      {
        id: "g-xss",
        titel: "<img src=x onerror=alert(1)>Mach was",
        vorMs: 60_000,
        zeilen: [{ von: "kunde", text: "<img src=x onerror=alert(1)>Mach was" }],
      },
    ],
    schritte: [LISTE_AUF],
    pruefung:
      `JSON.stringify({titel:${Q.listenTitel},offen:${Q.listeOffen},` +
      "eingeschleust:document.querySelectorAll('#__regoro-agent img').length})",
    sollwert:
      '{"titel":["Neues Gespräch","<img src=x onerror=alert(1)>Mach was"],"offen":true,' +
      '"eingeschleust":0}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "verlauf-wettlauf": {
    tun:
      "Leiste öffnen und SOFORT — während das Gespräch noch lädt — „Gespräche“ " +
      "aufklappen und denselben (obersten) Eintrag anklicken.",
    erwartung:
      "Jede Zeile steht GENAU EINMAL da. Zwei Ladevorgänge sind unterwegs, beide " +
      "für dasselbe Gespräch; der überholte muss seine Antwort wegwerfen. Ein " +
      "Wächter, der nur „gehört die Antwort zum aktuell gewählten Gespräch?“ " +
      "fragt, lässt hier beide durch — und die jüngsten Zeilen stünden doppelt.",
    ki: true,
    verlaufVerzoegerungMs: 1500,
    sofort: true,
    gespraeche: [
      {
        id: "g-renn",
        titel: "Das Gespräch von vorhin",
        vorMs: 60_000,
        zeilen: [
          { von: "kunde", text: "Renn-Zeile 1" },
          { von: "agent", text: "Renn-Zeile 2" },
          { von: "kunde", text: "Renn-Zeile 3" },
        ],
      },
    ],
    schritte: [
      // KEIN sleep davor: Der Klick MUSS in das offene Zeitfenster fallen.
      LISTE_AUF,
      "js \"Array.from(document.querySelectorAll('.__regoro-aetitel'))" +
        ".find(function(n){return n.textContent==='Das Gespräch von vorhin'}).click()\"",
      "sleep 5",
    ],
    pruefung: `JSON.stringify({zeilen:${Q.zeilen},dubletten:${Q.zeilen}.length-new Set(${Q.zeilen}).size})`,
    sollwert:
      '{"zeilen":["Renn-Zeile 1","Renn-Zeile 2","Renn-Zeile 3"],"dubletten":0}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "verlauf-fehlt": {
    tun: "Leiste öffnen, irgendeinen Auftrag abschicken.",
    erwartung:
      "Ein Server OHNE die Verlaufsrouten (404). Die Leiste muss arbeiten wie vorher: " +
      "grüne Abschlussblase, Dateiliste, Reload-Knopf. Die Gesprächsliste ist Komfort — " +
      "sie darf den Auftragsweg nie blockieren.",
    ki: true,
    auftrag: true,
    gespraeche: undefined,
    pruefung: `JSON.stringify({gruen:${Q.gruen},dateien:Array.from(document.querySelectorAll('.__regoro-adateien li')).map(function(l){return l.textContent}),reload:${Q.reload},blasen:${Q.blasen}})`,
    sollwert: '{"gruen":1,"dateien":["index.html"],"reload":true,"blasen":2}',
    ereignisse: [
      rahmen("werkzeug", { name: "write_file", kurz: "schreibt index.html" }),
      rahmen("text", { inhalt: "Ich ändere " }),
      rahmen("text", { inhalt: "den Absatz." }),
      rahmen("fertig", {
        zusammenfassung: "Ich ändere den Absatz.",
        dateien: ["index.html"],
        commit: "a1b2c3d",
      }),
    ],
  },

  "ohne-ki": {
    tun: "Seite laden, die obere Leiste ansehen.",
    erwartung:
      "KEIN Knopf „KI-Assistent“ und kein `#__regoro-agent` im DOM — die Seitenleiste " +
      "existiert ohne Modellzugang gar nicht. Der übrige Editor funktioniert unverändert.",
    ki: false,
    pruefung:
      "JSON.stringify({knopf:!!Array.from(document.querySelectorAll('#__regoro-bar button'))" +
      ".find(b=>b.textContent==='KI-Assistent'),panel:!!document.querySelector('#__regoro-agent')," +
      "leiste:!!document.querySelector('#__regoro-bar')})",
    sollwert: '{"knopf":false,"panel":false,"leiste":true}',
    ereignisse: [],
  },
};

/** Erschöpftes Kontingent — eigener Schalter, weil es am Status hängt, nicht am Strom. */
const ERSCHOEPFT = "erschoepft";

function seite(ki: boolean): string {
  const cfg = {
    pagePath: "index.html",
    fileHash: "a".repeat(64),
    pages: ["index.html"],
    page: "index.html",
    ki,
  };
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<title>Prüfstand: KI-Seitenleiste</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;padding:24px;max-width:46em}</style>
</head><body>
<h1 data-edit-idx="0">Prüfstand</h1>
<p data-edit-idx="1">Dieser Absatz ist editierbar — damit der Dirty-Guard der Leiste
prüfbar ist: Text ändern, dann einen Auftrag abschicken. Die Leiste muss ihn ablehnen
und sagen, warum. <strong>Speichern kann dieser Prüfstand nicht</strong> — er bildet
die KI-Seitenleiste nach, nicht den Text-Editor; „Speichern" antwortet deshalb mit
einer Erklärung statt mit einem nackten Fehler.</p>
<script>window.__REGORO_EDIT__ = ${JSON.stringify(cfg).replace(/</g, "\\u003c")};</script>
<script src="/edit-assets/overlay.js"></script>
</body></html>`;
}

function strom(ereignisse: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(c) {
        // Wie host.ts: sofort ein Byte, damit `onopen` nicht auf das erste
        // Ereignis warten muss (siehe Contract §13.21).
        c.enqueue(enc.encode(": verbunden\n"));
        for (const r of ereignisse) {
          await Bun.sleep(120); // sichtbar nacheinander, nicht in einem Rutsch
          c.enqueue(enc.encode(r));
        }
        c.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

/**
 * Welcher Fall gilt?
 *
 * Der Fall steckt im PFAD der Seite (`/ohne-dateien/edit`), aber das Overlay
 * ruft seine API unter festen, absoluten Pfaden auf (`/edit/agent/status`) —
 * dort ist vom Präfix nichts mehr übrig. Beim Ausliefern der Seite wird der
 * Fall deshalb in ein Cookie geschrieben, und die API-Routen lesen ihn von
 * dort. Ohne das bekam jeder API-Aufruf den Standardfall, und der Prüfstand
 * zeigte für JEDES Szenario dasselbe an — nachgemessen, bevor es jemand
 * geglaubt hätte.
 */
function fallAusPfad(pfad: string): string {
  const teil = pfad.split("/")[1] ?? "";
  return teil in FAELLE || teil === ERSCHOEPFT ? teil : "mit-dateien";
}

function fallAusCookie(req: Request): string {
  const roh = req.headers.get("cookie") ?? "";
  const treffer = /(?:^|;\s*)pruefstand=([a-z-]+)/.exec(roh);
  const name = treffer?.[1] ?? "";
  return name in FAELLE || name === ERSCHOEPFT ? name : "mit-dateien";
}

/**
 * Läuft gerade ein Auftrag? Der Prüfstand muss zwei Verbindungen zum
 * Ereignisstrom unterscheiden, weil die Seitenleiste beide aufbaut:
 *   - beim ÖFFNEN (Nachlese) — hier gibt es normalerweise nichts zu sehen,
 *   - nach dem ABSCHICKEN — hier kommt die Ereignisfolge des Falls.
 * Ohne diese Unterscheidung bekäme schon das Öffnen die volle Folge, und der
 * Fall „nie ein Lauf" wäre nicht prüfbar.
 */
let auftragLaeuft = false;
/** Hat der Lauf sein Kontingent gesprengt? Dann meldet der Status danach „leer". */
let kontingentWeg = false;

function starte(): void {
  Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    const pfad = url.pathname;
    // Die Seite bestimmt den Fall über den Pfad, alles andere über das Cookie.
    const seitenAufruf = pfad.endsWith("/edit") && !pfad.includes("/edit/");
    const fallName = seitenAufruf ? fallAusPfad(pfad) : fallAusCookie(req);
    const erschoepft = fallName === ERSCHOEPFT;
    const fall = FAELLE[fallName] ?? FAELLE["mit-dateien"]!;

    /**
     * Die Routen des TEXT-Editors gibt es hier nicht — und das muss man lesen
     * können.
     *
     * Der Prüfstand bildet die KI-Seitenleiste nach, nicht den Editor: kein
     * Site-Verzeichnis, kein git, nichts zu speichern. Vorher fiel ein Klick auf
     * „Speichern" in den 404-Zweig ganz unten, und der Browser meldete nur
     * „Speichern fehlgeschlagen (404)". Das liest sich wie ein Fehler im Editor
     * und ist keiner — der Prüfer sucht dann an der falschen Stelle. Passiert,
     * gemeldet, hier behoben.
     *
     * 501 statt 404, mit einem Satz im Rumpf: Das Overlay hängt den Rumpf an
     * seine Meldung an, damit steht die Erklärung im Dialog.
     */
    if (/\/edit\/(save|upload|restore|versions)$/.test(pfad) || /\/edit\/version\//.test(pfad)) {
      return new Response(
        "Der Prüfstand speichert nicht — er bildet nur die KI-Seitenleiste nach. " +
          "Text ändern ist trotzdem sinnvoll: Es prüft den Dirty-Guard, der einen " +
          "Auftrag bei ungespeicherten Änderungen ablehnt.",
        { status: 501, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }

    if (pfad.endsWith("/edit-assets/overlay.js")) {
      // BEI JEDER ANFRAGE frisch von Platte, nicht einmal beim Start. Sonst
      // prüft man nach einer Änderung an overlay.client.js weiter die alte
      // Fassung und hält einen behobenen Fehler für ungelöst — genau das ist
      // beim Bauen dieses Prüfstands passiert. `host.ts` macht es aus dem
      // gleichen Grund so.
      return new Response(Bun.file(OVERLAY), {
        headers: { "Content-Type": "application/javascript; charset=utf-8" },
      });
    }
    /**
     * Die Gesprächsliste. `gespraeche: undefined` heißt 404 — ein Server auf
     * älterem Stand, und ein eigener Prüffall.
     *
     * `fortsetzbar` bildet die 24-Stunden-Regel des echten Servers nach: Nur
     * ein Gespräch, dessen letzte Änderung weniger als 24 h her ist, wird
     * fortgesetzt. Wer das hier fest auf „das erste" setzte, prüfte den Fall
     * „alles alt, also neues Gespräch" nie.
     */
    if (pfad.endsWith("/edit/agent/verlaeufe")) {
      if (!fall.gespraeche) return new Response("Nicht gefunden", { status: 404 });
      const jetzt = Date.now();
      const alle = fall.gespraeche.map((g) => ({
        id: g.id,
        titel: g.titel,
        geaendert: jetzt - g.vorMs,
        nachrichten: g.zeilen.length,
      }));
      const juengster = alle[0];
      const fortsetzbar =
        juengster && jetzt - juengster.geaendert < 24 * 60 * 60 * 1000 ? juengster.id : null;
      return Response.json({ ok: true, fortsetzbar, verlaeufe: alle });
    }
    if (pfad.endsWith("/edit/agent/verlauf")) {
      if (!fall.gespraeche) return new Response("Nicht gefunden", { status: 404 });
      const g = fall.gespraeche.find((x) => x.id === url.searchParams.get("id"));
      if (!g) return Response.json({ ok: false, grund: "Dieses Gespräch gibt es nicht mehr." }, { status: 404 });
      // Dieselbe Rechnung wie `leseNachrichten`: von hinten, `ab` ist der
      // Cursor nach oben. Eine eigene Rechnung hier wäre eine zweite Wahrheit.
      const gesamt = g.zeilen.length;
      const anzahl = Math.min(100, Math.max(1, Number(url.searchParams.get("anzahl") ?? 20)));
      // `Number(null)` ist 0, nicht NaN — ohne diese Fallunterscheidung liefert
      // die erste Anfrage (ohne `vor`) eine LEERE Seite, und der Prüfstand
      // meldete einen Fehler im Overlay, der keiner ist. Genau hier
      // hineingelaufen; `host.ts` klammert aus demselben Grund.
      const vorTxt = url.searchParams.get("vor");
      const vorRoh = vorTxt === null || vorTxt === "" ? Number.NaN : Number(vorTxt);
      const bis = Number.isFinite(vorRoh) && vorRoh >= 0 && vorRoh <= gesamt ? vorRoh : gesamt;
      const ab = Math.max(0, bis - anzahl);
      const antwort = {
        ok: true,
        id: g.id,
        titel: g.titel,
        geaendert: Date.now() - g.vorMs,
        nachrichten: g.zeilen.slice(ab, bis).map((z) => ({ ...z, zeit: Date.now() - g.vorMs })),
        ab,
        gesamt,
      };
      const warte = fall.verlaufVerzoegerungMs ?? 0;
      if (warte > 0) return Bun.sleep(warte).then(() => Response.json(antwort));
      return Response.json(antwort);
    }
    if (pfad.endsWith("/edit/agent/status")) {
      // Nach einem gesprengten Kontingent meldet der echte Server „erschöpft" —
      // der Prüfstand muss das nachbilden, sonst prüft der Fall eine Lüge.
      const leer = erschoepft || (fallName === "kontingent-sprengen" && kontingentWeg);
      return Response.json({
        ok: true,
        laeuft: false,
        laufId: null,
        kontingent: leer
          ? { frei: 0, gesamt: 200_000, erschoepft: true, monat: "2026-09" }
          : { frei: 198_766, gesamt: 200_000, erschoepft: false, monat: "2026-09" },
      });
    }
    if (pfad.endsWith("/edit/agent") && req.method === "POST") {
      auftragLaeuft = true;
      return Response.json({ ok: true, laufId: "00000000-0000-4000-8000-000000000000" });
    }
    if (pfad.endsWith("/edit/agent/abort") && req.method === "POST") {
      auftragLaeuft = false;
      return Response.json({ ok: true });
    }
    if (pfad.endsWith("/edit/agent/events")) {
      // Nachlese-Fälle liefern ihre Folge auch ohne Auftrag aus — das IST der
      // Fall, den sie prüfen: ein beendeter Lauf, den der Server nachreicht.
      // Am Fall selbst hinterlegt, nicht am Namen: siehe `Fall.nachlese`.
      if (!auftragLaeuft && !fall.nachlese) {
        return strom([rahmen("fehler", { grund: "Kein Lauf aktiv." })]);
      }
      auftragLaeuft = false;
      if (fallName === "kontingent-sprengen") kontingentWeg = true;
      return strom(fall.ereignisse);
    }
    if (seitenAufruf) {
      auftragLaeuft = false; // frische Seite, frischer Zustand
      kontingentWeg = false;
      return new Response(seite(erschoepft ? true : fall.ki), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // Der Fall muss die absoluten API-Pfade des Overlays erreichen.
          "Set-Cookie": `pruefstand=${fallName}; Path=/; SameSite=Lax`,
        },
      });
    }
    return new Response("Nicht gefunden", { status: 404 });
  },
  });
}

try {
  starte();
} catch (err) {
  // Der Abbruch, der zweimal Zeit gekostet hat: Ein alter Prozess hält den
  // Port, der neue stirbt — und wer danach im Browser prüft, bekommt die ALTE
  // Fassung des Overlays und hält einen behobenen Fehler für ungelöst. Bun
  // wirft dabei nur `EADDRINUSE` samt Stapelabzug; das liest sich wie ein
  // Fehler im Skript und nicht wie das, was es ist.
  const code = (err as { code?: string } | null)?.code;
  if (code !== "EADDRINUSE") throw err;
  console.error(
    `Port ${PORT} ist belegt — dieser Prüfstand startet NICHT.\n\n` +
      "  Achtung: Ein Browser, der jetzt trotzdem antwortet, wird von der\n" +
      "  ALTEN Fassung bedient. Was du dann misst, ist nicht dein Stand.\n\n" +
      `  Wer hält ihn:  ss -lptnH "sport = :${PORT}"\n` +
      "  Gezielt beenden:  kill <PID>   (NICHT pkill — auf dieser Maschine\n" +
      "  laufen parallel E2E-Läufe anderer Beteiligter.)\n" +
      `  Oder ausweichen:  PORT=8795 bun ${"scripts/seitenleiste-pruefstand.ts"}`,
  );
  process.exit(1);
}

const basis = `http://localhost:${PORT}`;
console.log(`Prüfstand für die KI-Seitenleiste läuft auf ${basis}\n`);
const BROWSE = "~/.claude/skills/gstack/browse/dist/browse";
const OEFFNEN =
  "js \"var b=Array.from(document.querySelectorAll('#__regoro-bar button'))" +
  ".find(x=>x.textContent==='KI-Assistent'); if(b)b.click()\"";
const ABSCHICKEN =
  "js \"document.querySelector('.__regoro-aeingabe').value='mach was';" +
  " document.querySelector('.__regoro-asenden').click()\"";

function anleitung(name: string, fall: Fall): void {
  console.log(`── ${name} ──`);
  console.log(`   ${basis}/${name}/edit`);
  console.log(`   Tun:       ${fall.tun}`);
  console.log(`   Erwartung: ${fall.erwartung}`);
  console.log("   Maschinell:");
  console.log(`     B=${BROWSE}`);
  console.log(`     $B goto ${basis}/${name}/edit`);
  if (fall.ki) console.log(`     $B ${OEFFNEN}`);
  if (fall.auftrag) console.log(`     $B ${ABSCHICKEN}`);
  if ((fall.gespraeche || fall.schritte) && !fall.sofort) console.log("     sleep 2");
  for (const schritt of fall.schritte ?? []) {
    if (schritt.startsWith("sleep ")) console.log(`     ${schritt}`);
    else console.log(`     $B ${schritt}`);
  }
  console.log("     sleep 3");
  console.log(`     $B js "${fall.pruefung.replace(/"/g, '\\"')}"`);
  console.log(`   Sollwert:  ${fall.sollwert}\n`);
}

for (const [name, fall] of Object.entries(FAELLE)) anleitung(name, fall);
anleitung(ERSCHOEPFT, {
  tun: "Nur die Leiste öffnen.",
  erwartung:
    "Die Kontingentzeile ist eingefärbt und nennt den Monatsersten, und „Auftrag geben“ " +
    "ist GESPERRT — der Kunde läuft gar nicht erst hinein. Die Sperre muss das Ende des " +
    "Ereignisstroms ÜBERLEBEN: Genau dort gab sie einmal wieder frei.",
  ki: true,
  pruefung: `JSON.stringify({eingefaerbt:document.querySelector('.__regoro-aquota').className.indexOf('aleer')>-1,gesperrt:${Q.gesperrt}})`,
  sollwert: '{"eingefaerbt":true,"gesperrt":true}',
  ereignisse: [],
});
console.log("Beenden mit Strg+C.");
