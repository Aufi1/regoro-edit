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
   * Meldet `/edit/agent/status` einen bereits LAUFENDEN Auftrag?
   *
   * Der Zustand, den die Leiste beim Öffnen vorfindet, wenn der Kunde den
   * Auftrag auf einem anderen Gerät gestartet hat — oder auf diesem, vor einem
   * Seitenwechsel.
   */
  laeuftSchon?: boolean;
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
  /**
   * Liefert die Seite einen KLEBENDEN Kopf (`position:sticky;top:0`) und genug
   * Text darunter, um wirklich scrollen zu können?
   *
   * Der Fehler, den das prüft, ist erst NACH dem Scrollen zu sehen: Ungescrollt
   * sitzt der Kopf korrekt unter der Leiste, der Messapparat stimmt. Erst wenn
   * die Seite läuft, bleibt der klebende Kopf am Viewport hängen und wandert
   * unter die Leiste. Eine kurze Seite kann das nicht zeigen — ohne Fülltext
   * wäre der Fall immer grün, ganz gleich was das Overlay tut.
   */
  klebrigerKopf?: boolean;
  /**
   * Muss die KI-Seitenleiste GESCHLOSSEN sein?
   *
   * Für die Kopf-Fälle ist das die Voraussetzung, nicht Geschmackssache: Unter
   * 900 px Breite legt sich das Panel über die ganze Seite (`flex:1 1 auto` in
   * der Media-Query). Ein Kopf hinter dem Panel sagt nichts darüber, ob die
   * EDITOR-LEISTE ihn verdeckt — die Messung liefe ins Leere.
   *
   * Geschlossen wird AKTIV, nicht durch Weglassen des Öffnen-Klicks: Die Leiste
   * merkt sich in `sessionStorage`, dass sie offen war, und geht beim nächsten
   * Seitenaufruf von selbst wieder auf. Ein Fall, der sie nur nicht öffnet,
   * hinge davon ab, welcher Fall vorher lief.
   */
  leisteZu?: boolean;
  /**
   * Fenstergröße, die VOR dem Laden gesetzt wird — etwa `"390x844"`.
   *
   * Die Überdeckung hängt an der Leistenhöhe, und die hängt am Umbruch: mobil
   * dreizeilig (gemessen 128 px), auf dem Schreibtisch einzeilig (47 px). Ein
   * Fall ohne feste Fenstergröße misst deshalb je nach Maschine etwas anderes.
   */
  viewport?: string;
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

/** Klick auf „Neu“ im Kopf der Leiste. */
const NEU_KLICK =
  "js \"Array.from(document.querySelectorAll('.__regoro-akopfbtn'))" +
  ".find(function(b){return b.textContent==='Neu'}).click()\"";

/** Klick auf „Verlauf" im Kopf der Leiste (der zweite der beiden Knöpfe). */
const LISTE_AUF =
  "js \"Array.from(document.querySelectorAll('.__regoro-akopfbtn'))" +
  ".find(function(b){return b.textContent==='Verlauf'}).click()\"";

/** Weit genug, dass der klebende Kopf sicher am oberen Rand hängt. */
const SCROLLEN = 'js "window.scrollTo(0,900)"';

/**
 * Die Kopf-Prüfung — EINMAL, für den mobilen und den Schreibtisch-Fall.
 *
 * Zwei Fälle, eine Erwartung: Der Fehler ist in beiden Fenstergrößen derselbe,
 * nur unterschiedlich auffällig. Stünde der Ausdruck zweimal da, könnten die
 * beiden Fassungen auseinanderlaufen — und dann prüfte einer der Fälle etwas
 * anderes, ohne dass es jemandem auffiele.
 *
 * `gescrollt` und `panelZu` messen nicht das Ergebnis, sondern den Messapparat:
 * Ungescrollt sitzt der Kopf auch ohne Behebung richtig, und hinter einem
 * offenen Panel (unter 900 px deckt es die ganze Seite) wäre die Rechnung
 * bedeutungslos. Ohne diese beiden wäre der Fall grün, wenn die Prüfung gar
 * nicht stattgefunden hat.
 */
const KOPF_PRUEFUNG =
  "JSON.stringify((function(){" +
  "var bar=document.querySelector('#__regoro-bar').getBoundingClientRect();" +
  "var kopf=document.querySelector('.pruefstand-kopf').getBoundingClientRect();" +
  "var ban=document.querySelector('.pruefstand-banner');" +
  "var voll=document.querySelector('.pruefstand-vollbild');" +
  "var tk=document.querySelector('.pruefstand-tabellenkopf');" +
  "return {ueberdeckung:Math.max(0,Math.round(bar.bottom-kopf.top))," +
  "kopfSichtbar:kopf.top>=0&&kopf.bottom<=innerHeight," +
  "bannerKlebtUnten:Math.round(ban.getBoundingClientRect().bottom)===innerHeight," +
  "vollbildUnberuehrt:Math.round(voll.getBoundingClientRect().top)===0," +
  "tabellenkopfUnberuehrt:getComputedStyle(tk).top==='0px'," +
  "gescrollt:scrollY>0,panelZu:!document.querySelector('#__regoro-agent')};})())";

const KOPF_SOLL =
  '{"ueberdeckung":0,"kopfSichtbar":true,"bannerKlebtUnten":true,' +
  '"vollbildUnberuehrt":true,"tabellenkopfUnberuehrt":true,' +
  '"gescrollt":true,"panelZu":true}';

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
    tun: "Leiste öffnen, oben rechts auf „Verlauf“ klicken, das ÄLTERE Gespräch anklicken.",
    erwartung:
      "Die Liste nennt beide Titel. Nach dem Klick auf das ältere " +
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
    tun: "Leiste öffnen, oben rechts auf „Verlauf“ klicken.",
    erwartung:
      "Die Liste klappt auf und zeigt die gespeicherten Gespräche mit ihrem ersten Satz " +
      "als Titel — „Neu“ ist ein eigener Knopf im Kopf, kein Listeneintrag. Der Titel ist " +
      "WÖRTLICHER Kundentext und darf nie als HTML gedeutet werden; deshalb steht hier " +
      "eines mit spitzen Klammern.",
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
    sollwert: '{"titel":["<img src=x onerror=alert(1)>Mach was"],"offen":true,"eingeschleust":0}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "verlauf-wettlauf": {
    tun:
      "Leiste öffnen und SOFORT — während das Gespräch noch lädt — „Verlauf“ " +
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

  "verlauf-neu-waehrend-laden": {
    tun:
      "Leiste öffnen und SOFORT — während das Gespräch noch lädt — auf „Neu“ klicken.",
    erwartung:
      "Das Chatfenster bleibt LEER. Der Kunde hat ein neues Gespräch verlangt; " +
      "weder die Zeilen des alten noch der AUSGANG des letzten Laufs " +
      "(„Der letzte Auftrag hat diese Dateien geändert“) dürfen darin landen. " +
      "Zwei Läufe in "  +
      "einem Verlauf sind schlimmer als ein leeres Fenster, weil nichts daran " +
      "danach aussieht.",
    ki: true,
    nachlese: true,
    verlaufVerzoegerungMs: 1500,
    sofort: true,
    gespraeche: [
      {
        id: "g-vorher",
        titel: "Das Gespräch von vorhin",
        vorMs: 60_000,
        zeilen: [
          { von: "kunde", text: "ALT: Auftrag" },
          { von: "agent", text: "ALT: Antwort" },
        ],
      },
    ],
    schritte: [NEU_KLICK, "sleep 5"],
    pruefung: `JSON.stringify({zeilen:${Q.zeilen}})`,
    sollwert: '{"zeilen":[]}',
    // Genau die Folge, die ohne Wächter in das neue Gespräch fiele.
    ereignisse: [
      rahmen("text", { inhalt: "Ich habe die Seite gebaut." }),
      rahmen("fertig", {
        zusammenfassung: "Ich habe die Seite gebaut.",
        dateien: ["alt.html"],
        commit: "a1b2c3d",
      }),
    ],
  },

  "verlauf-neu-waehrend-lauf": {
    tun:
      "Leiste öffnen und SOFORT — während das Gespräch noch lädt — auf „Neu“ klicken. " +
      "Für die Website läuft dabei bereits ein Auftrag.",
    erwartung:
      "Das Chatfenster bleibt LEER, und unter der Eingabe steht der Hinweis, dass ein " +
      "Auftrag zu einem anderen Gespräch läuft. Den Strom hier anzuhängen schriebe die " +
      "Ausgabe eines fremden Laufs in das gerade begonnene Gespräch; den Klick " +
      "rückgängig zu machen nähme dem Kunden die Auswahl aus der Hand. Also keins von " +
      "beidem — sagen, was ist.",
    ki: true,
    laeuftSchon: true,
    // Der Strom liefert auch ohne Auftrag — sonst zeigte die Gegenprobe nur
    // „Kein Lauf aktiv." statt der Ausgabe des fremden Laufs.
    nachlese: true,
    verlaufVerzoegerungMs: 1500,
    sofort: true,
    gespraeche: [
      {
        id: "g-laeuft",
        titel: "Das Gespräch, zu dem der Lauf gehört",
        vorMs: 60_000,
        zeilen: [{ von: "kunde", text: "ALT: Auftrag" }, { von: "agent", text: "ALT: Antwort" }],
      },
    ],
    schritte: [NEU_KLICK, "sleep 5"],
    pruefung:
      `JSON.stringify({zeilen:${Q.zeilen},hinweis:(document.querySelector('#__regoro-agent .__regoro-aform .__regoro-ahinweis')||{}).textContent})`,
    sollwert:
      '{"zeilen":[],"hinweis":"Für diese Website läuft gerade ein Auftrag. Er gehört zu ' +
      'einem anderen Gespräch — öffne die Leiste neu, um ihm zuzusehen."}',
    // Was der Strom liefern WÜRDE, wenn er fälschlich angehängt würde.
    ereignisse: [
      rahmen("text", { inhalt: "FREMDER LAUF schreibt hier." }),
      rahmen("fertig", { zusammenfassung: "FREMDER LAUF schreibt hier.", dateien: ["fremd.html"], commit: "a1" }),
    ],
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

  /**
   * DER KOPF DER KUNDENSEITE, NACHDEM GESCROLLT WURDE — mobil.
   *
   * Gemessen vor der Behebung (390×844): Leiste 0..128, klebender Kopf 0..55 —
   * VOLLSTÄNDIG verdeckt. Ursache ist nicht die Leistenhöhe, sondern die
   * Struktur: `padding-top` auf dem `<body>` bewegt `position:sticky|fixed`
   * nicht, weil solche Elemente sich am Viewport ausrichten und nicht am Fluss.
   *
   * `gescrollt` ist die Gegenprobe am Messapparat selbst, kein Beiwerk:
   * Ungescrollt sitzt der Kopf auch OHNE Behebung korrekt unter der Leiste.
   * Eine Seite, die sich nicht scrollen lässt, machte diesen Fall dauerhaft
   * grün — ein Nachweis, der nicht anschlagen kann, beweist durch sein
   * Ausbleiben nichts.
   */
  "kopf-frei": {
    tun: "Seite in 390×844 laden (Seitenleiste bleibt zu), auf 900 px scrollen.",
    erwartung:
      "Der klebende Kopf der Kundenseite steht VOLLSTÄNDIG UNTER der Editor-Leiste: " +
      "`bar.bottom` ist nicht größer als `kopf.top`, die Überdeckung ist 0. Der Kopf " +
      "ist dabei sichtbar (nicht aus dem Bild geschoben) und die Seite ist wirklich " +
      "gescrollt — sonst misst der Fall nichts. Der Cookie-Hinweis am UNTEREN Rand " +
      "(`position:fixed;bottom:0`) bleibt unangetastet: Er hat mit der Leiste oben " +
      "nichts zu tun, und wer ihn mitschöbe, schöbe ihn aus dem Bild. ACHTUNG, hier " +
      "liegt eine Falle: Er meldet NICHT `top:auto`, sondern seine ausgerechnete " +
      "Position (gemessen 930 px) — `getComputedStyle` liefert für positionierte " +
      "Elemente den benutzten Wert. Genau daran ist die erste Fassung gescheitert. " +
      "Dasselbe gilt für ein Vollbild-Overlay: Es beginnt oben, verliert nach unten " +
      "geschoben aber nur seinen unteren Rand samt Knöpfen.",
    ki: true,
    leisteZu: true,
    klebrigerKopf: true,
    viewport: "390x844",
    schritte: [SCROLLEN],
    pruefung: KOPF_PRUEFUNG,
    sollwert: KOPF_SOLL,
    ereignisse: [],
  },

  /**
   * DERSELBE FEHLER AUF DEM SCHREIBTISCH — er fällt nur weniger auf.
   *
   * Gemessen (1440×900): Leiste 0..47 über Kopf 0..55, also 47 von 55 px
   * verdeckt. Es bleibt ein 8-px-Streifen stehen, und daraus wurde „auf Desktop
   * passt es". Das ist eine Fehlwahrnehmung, keine Grenze des Fehlers — deshalb
   * steht der Fall hier eigenständig neben dem mobilen.
   */
  "kopf-frei-desktop": {
    tun: "Seite in 1440×900 laden (Seitenleiste bleibt zu), auf 900 px scrollen.",
    erwartung:
      "Wie `kopf-frei`, nur im Schreibtisch-Fenster. Vor der Behebung waren hier 47 von " +
      "55 px verdeckt — sichtbar blieb ein 8-px-Streifen, und genau der hat den Fehler " +
      "auf dem Schreibtisch verborgen.",
    ki: true,
    leisteZu: true,
    klebrigerKopf: true,
    viewport: "1440x900",
    schritte: [SCROLLEN],
    pruefung: KOPF_PRUEFUNG,
    sollwert: KOPF_SOLL,
    ereignisse: [],
  },

  /**
   * DER WAHRSCHEINLICHSTE UMSETZUNGSFEHLER, ALS EIGENER FALL.
   *
   * Der Versatz greift in eine fremde Seite ein. Wer den Ausgangswert nicht
   * merkt, addiert bei JEDEM Durchlauf erneut auf — und die Kundenseite wandert
   * mit jeder Fenster-Änderung weiter nach unten. Das sieht man einer einzelnen
   * Messung nicht an: Direkt nach dem Laden stimmt der Wert in beiden Fassungen.
   *
   * Gemessen wird deshalb der ABSTAND zur Leistenhöhe, nicht der `top`-Wert
   * selbst: Der Kopf startet bei `top:0`, also muss `top` nach beliebig vielen
   * Umbrüchen GENAU der aktuellen Leistenhöhe entsprechen. Ein aufaddierender
   * Fehler ergibt hier 128, 256, 384 … statt 0 — und zwar unabhängig davon, wie
   * hoch die Leiste auf der prüfenden Maschine tatsächlich umbricht.
   *
   * `barhPlausibel` sichert wieder den Messapparat: Wäre `--regoro-barh` leer,
   * käme die Differenz aus zwei Unbekannten.
   */
  "kopf-wandert-nicht": {
    tun:
      "Seite in 390×844 laden (Seitenleiste bleibt zu), das Fenster mehrfach zwischen " +
      "Schreibtisch- und Handy-Größe wechseln, dann scrollen.",
    erwartung:
      "Der Kopf sitzt weiterhin GENAU eine Leistenhöhe tief — nicht zwei, nicht vier. " +
      "Jeder Wechsel löst den ResizeObserver aus; ohne gemerkten Ausgangswert addiert " +
      "sich der Versatz auf und die Kundenseite wandert nach unten.",
    ki: true,
    leisteZu: true,
    klebrigerKopf: true,
    viewport: "390x844",
    schritte: [
      "viewport 1440x900",
      "viewport 390x844",
      "viewport 1440x900",
      "viewport 390x844",
      SCROLLEN,
    ],
    pruefung:
      "JSON.stringify((function(){" +
      "var kopf=document.querySelector('.pruefstand-kopf');" +
      "var top=parseFloat(getComputedStyle(kopf).top);" +
      "var barh=parseFloat(getComputedStyle(document.documentElement)" +
      ".getPropertyValue('--regoro-barh'));" +
      "return {versatzUeberBarh:Math.round(top-barh),barhPlausibel:barh>20};})())",
    sollwert: '{"versatzUeberBarh":0,"barhPlausibel":true}',
    ereignisse: [],
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

/**
 * Der klebende Kopf der Kundenseite — nachgebaut, nicht importiert.
 *
 * Bewusst OHNE die Klassennamen der Fabrik (`.kanon-header`): Der Editor darf
 * die Fabrik nicht kennen, und ein Prüfstand, der ihre Namen benutzt, könnte
 * eine Lösung durchwinken, die genau daran hängt. Was hier zählt, ist allein
 * `position:sticky;top:0` — dieselbe Eigenschaft, an der der Fehler hängt.
 *
 * Der Fülltext ist Teil der Messung, nicht Zierde: Ohne scrollbare Seite bleibt
 * der Kopf im Fluss stehen, das `padding-top` des Body trägt ihn, und der Fall
 * wäre auch mit unverändertem Overlay grün.
 */
const KLEBRIGER_KOPF = `<header class="pruefstand-kopf" data-edit-idx="90">Kopf der Kundenseite</header>
<div class="pruefstand-banner">Cookie-Hinweis der Kundenseite</div>
<div class="pruefstand-vollbild">Vollbild-Overlay der Kundenseite</div>
<div class="pruefstand-rollbereich">
  <div class="pruefstand-tabellenkopf">Tabellenkopf im eigenen Rollbereich</div>
  ${Array.from({ length: 20 }, (_, i) => `<p>Zeile ${i + 1}</p>`).join("\n")}
</div>
${Array.from({ length: 40 }, (_, i) => `<p data-edit-idx="${100 + i}">Fülltext ${i + 1}, damit die Seite scrollt.</p>`).join("\n")}`;

const KLEBRIGER_KOPF_CSS =
  ".pruefstand-kopf{position:sticky;top:0;background:#123;color:#fff;padding:16px;font-weight:700}" +
  // Der Gegenbeweis am unteren Rand: `bottom:0` heißt `top:auto`, und ein
  // Element, das UNTEN klebt, hat mit der Leiste am oberen Rand nichts zu tun.
  // Würde der Versatz es „der Vollständigkeit halber" mitnehmen, schöbe er es
  // aus dem Bild — der Kunde verlöre seinen Cookie-Hinweis samt Knöpfen.
  ".pruefstand-banner{position:fixed;bottom:0;left:0;right:0;background:#333;color:#fff;padding:8px}" +
  // Der zweite Grenzfall: ein Element, das den ganzen Bildschirm füllt
  // (Consent-Dialog, Bildergalerie). Es beginnt oben, wird von der Leiste aber
  // nicht im Sinne dieses Fehlers verdeckt — nach unten geschoben verlöre es
  // nur seinen unteren Rand samt Knöpfen. `pointer-events:none`, weil es hier
  // ein Messobjekt ist und die Klicks der anderen Schritte nicht abfangen soll;
  // fürs Verschieben spielt das keine Rolle.
  ".pruefstand-vollbild{position:fixed;top:0;left:0;width:100%;height:100vh;" +
  "pointer-events:none;background:rgba(0,0,0,.04)}" +
  // Der dritte Grenzfall: `position:sticky` klebt am nächsten ROLLBAREN
  // Vorfahren, nicht zwangsläufig am Fenster. Eine Tabellenkopfzeile in einem
  // eigenen Rollbereich gerät nie hinter die Editor-Leiste — sie um deren Höhe
  // zu versetzen, schöbe sie nur innerhalb ihres Kastens nach unten.
  ".pruefstand-rollbereich{height:150px;overflow:auto;border:1px solid #999;margin:12px 0}" +
  ".pruefstand-tabellenkopf{position:sticky;top:0;background:#eee;padding:4px}";

function seite(ki: boolean, klebrigerKopf = false): string {
  const cfg = {
    pagePath: "index.html",
    fileHash: "a".repeat(64),
    pages: ["index.html"],
    page: "index.html",
    ki,
  };
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<title>Prüfstand: KI-Seitenleiste</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;padding:24px;max-width:46em}
${klebrigerKopf ? KLEBRIGER_KOPF_CSS : ""}</style>
</head><body>
${klebrigerKopf ? KLEBRIGER_KOPF : ""}
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
        laeuft: !!fall.laeuftSchon,
        laufId: fall.laeuftSchon ? "00000000-0000-4000-8000-000000000000" : null,
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
      return new Response(seite(erschoepft ? true : fall.ki, fall.klebrigerKopf), {
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
/**
 * Leiste öffnen — IDEMPOTENT, und das ist nicht Kosmetik.
 *
 * Die Leiste merkt sich in `sessionStorage`, dass sie offen war, und geht beim
 * nächsten Seitenaufruf von selbst wieder auf. Ein blinder Klick TOGGELT sie
 * dann zu, und der Prüffall sieht ein leeres Fenster — was aussieht wie ein
 * Fehler im Overlay und keiner ist. Genau darauf ist der Prüfstand nach dem
 * Zusammenführen zweier Zweige hereingefallen: sechs Fälle rot, alle aus diesem
 * einen Grund.
 */
const OEFFNEN =
  "js \"if(!document.querySelector('#__regoro-agent')){" +
  "var b=Array.from(document.querySelectorAll('#__regoro-bar button'))" +
  ".find(function(x){return x.textContent==='KI-Assistent'}); if(b)b.click()}\"";
/** Gegenstück zu OEFFNEN — ebenso idempotent, aus demselben Grund. */
const SCHLIESSEN =
  "js \"if(document.querySelector('#__regoro-agent')){" +
  "var b=Array.from(document.querySelectorAll('#__regoro-bar button'))" +
  ".find(function(x){return x.textContent==='KI-Assistent'}); if(b)b.click()}\"";
const ABSCHICKEN =
  "js \"document.querySelector('.__regoro-aeingabe').value='mach was';" +
  " document.querySelector('.__regoro-asenden').click()\"";

/**
 * Die Fenstergröße, in der alle Fälle gemessen werden, wenn sie keine eigene
 * nennen.
 *
 * JEDER Fall druckt seine `viewport`-Zeile, auch der, dem sie gleichgültig ist.
 * Der Grund ist der Treiber: Er fährt die Fälle nacheinander gegen DENSELBEN
 * Browser, und `viewport` wirkt über den Fall hinaus. Ohne diese Zeile erbte
 * jeder Fall nach `kopf-frei` die 390 px des vorigen — dort bricht die Leiste
 * dreizeilig um, Knöpfe rutschen, und Fälle, die mit dem Kopf nichts zu tun
 * haben, würden je nach REIHENFOLGE etwas anderes messen. Eine Abhängigkeit von
 * der Reihenfolge ist in einem Prüfstand schlimmer als ein fehlender Fall: Sie
 * erzeugt Fehlschläge, die niemand einem Auslöser zuordnen kann.
 */
const STANDARD_VIEWPORT = "1440x900";

function anleitung(name: string, fall: Fall): void {
  console.log(`── ${name} ──`);
  console.log(`   ${basis}/${name}/edit`);
  console.log(`   Tun:       ${fall.tun}`);
  console.log(`   Erwartung: ${fall.erwartung}`);
  console.log("   Maschinell:");
  console.log(`     B=${BROWSE}`);
  console.log(`     $B viewport ${fall.viewport ?? STANDARD_VIEWPORT}`);
  console.log(`     $B goto ${basis}/${name}/edit`);
  if (fall.ki) console.log(`     $B ${fall.leisteZu ? SCHLIESSEN : OEFFNEN}`);
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
