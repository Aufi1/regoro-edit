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
 *
 * VOR JEDEM MESSLAUF DEN BROWSER FRISCH MACHEN — `pruefstand-treiber.py
 * --neustart`. Das ist eine Vorschrift, keine Empfehlung.
 *
 * `browse` hält EINEN langlebigen Browser über alle Aufrufe hinweg. Diese Fälle
 * öffnen laufend Ereignisströme (`EventSource`) auf dieselbe Herkunft, und ein
 * Browser erlaubt pro Herkunft nur eine Handvoll gleichzeitiger Verbindungen.
 * Gemessen: Nach rund 120 Seitenaufrufen in einem Rutsch — etwa vier volle
 * Durchläufe — kommt `/edit-assets/overlay.js` nicht mehr durch. Die Seite lädt
 * mit 200, das Overlay läuft nie an, und ab da meldet jede Prüfung eine Leiste,
 * die es nicht gibt.
 *
 * DASS ES SO AUSSIEHT, HEISST NICHT, DASS ES DAS IST. Ein Fehler im Aufbau der
 * Leiste erzeugt dasselbe Bild — ebenfalls gemessen (siehe unten). Beides ist
 * von außen nicht zu unterscheiden, und genau deshalb steht hier kein
 * „Erkennungszeichen": Wer eines hätte, klärte damit früher oder später einen
 * ECHTEN Einbruch weg. Dieselbe Fehlerklasse wie ein Test, der nicht anschlagen
 * kann, nur im Kopf des Lesers statt im Code.
 *
 * Aus einem frisch gestarteten Browser heraus ist die Frage gar nicht erst zu
 * stellen: Dann kann es die Ermüdung nicht gewesen sein. Ohne Neustart ist ein
 * Einbruch nicht zuzuordnen — und ein Befund, den man nicht zuordnen kann, ist
 * keiner. `bun` muss dabei im PFAD stehen, sonst startet `browse` seinen
 * eigenen Server nicht.
 *
 * „(no console errors)" BEWEIST NICHT, DASS KEIN SKRIPTFEHLER VORLAG.
 *
 * Gemessen an dieser Datei: `browse console --errors` erfasst `console.error`,
 * aber KEINE unbehandelten Ausnahmen — weder beim Laden noch danach (Probe:
 * `setTimeout(function(){ nichtVorhandeneFunktion(); }, 0)` bei frisch
 * geleerter Konsole → „(no console errors)"). Nachgestellt mit einem
 * `buildBar()`, das eine noch nicht geschriebene Funktion anhängt: Die Leiste
 * entsteht nicht, und die Konsole schweigt.
 *
 * Für eine Datei, die `tsc` nicht ansieht, ist das die wichtigere Hälfte: Ein
 * ReferenceError im Aufbau ist genau der Fehler, den hier niemand sonst findet,
 * und das naheliegende Werkzeug meldet ihn nicht. Zum Nachsehen taugt nur das
 * Verhalten — gibt es die Leiste (`#__regoro-bar`)? —, nicht die Konsole.
 */
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8794);
const OVERLAY = join(import.meta.dir, "..", "src", "overlay.client.js");

/** Ein SSE-Rahmen, so wie host.ts ihn baut. */
function rahmen(name: string, daten: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(daten)}\n\n`;
}

/**
 * Der Zustand einer Website, wie `GET /edit/zustand` ihn liefert.
 *
 * Die Zeitpunkte stehen als „vor wie vielen Millisekunden" da und nicht als
 * ISO-Datum — aus demselben Grund wie `Gespraech.vorMs`: Ein festes Datum
 * veraltet, und der Fall „12 Tage alt" prüfte irgendwann „500 Tage alt".
 * Die Drei-Tage-Schwelle aus C8 hinge dann an der Wanduhr statt am Fall.
 */
interface Zustand {
  schwebend?: boolean;
  schwebendDateien?: string[];
  schwebendVorMs?: number;
  unveroeffentlicht?: boolean;
  unveroeffentlichtAnzahl?: number;
  unveroeffentlichtVorMs?: number;
  staging?: boolean;
  veroeffentlichenMoeglich?: boolean;
}

/** Eine erzwungene Fehlerantwort auf eine der Zustands-Routen. */
interface Fehlerantwort {
  status: number;
  rumpf: Record<string, unknown>;
}

interface Fall {
  /** Was der Prüfer tun muss. */
  tun: string;
  /** Was danach zu sehen sein MUSS. */
  erwartung: string;
  /** Ist der Modellzugang eingerichtet? false = die Leiste darf es nicht geben. */
  ki: boolean;
  /**
   * Der Zustand der Website. `undefined` heißt „nichts offen, nichts
   * unveröffentlicht" — so verhalten sich die zwölf Fälle von vor dem Umbau.
   */
  zustand?: Zustand;
  /**
   * `GET /edit/zustand` antwortet 404 — ein Server ohne die neuen Routen.
   *
   * Eigener Prüffall und kein Randfall: Die Leiste muss dann arbeiten wie
   * vorher. Dieselbe Regel wie bei `verlauf-fehlt` — was Komfort ist, darf nie
   * im Arbeitsweg stehen.
   */
  zustandFehlt?: boolean;
  /** Legt der Lauf am Ende eine schwebende Änderung ab? (Der Normalfall.) */
  schwebendNachLauf?: boolean;
  /** Vorschau-Betrieb: kein Veröffentlichen-Ziel, kein Knopf. */
  staging?: boolean;
  /**
   * URL-Präfix der Website (`CFG.basis`), z. B. „/praefix".
   *
   * MIT GEGENPROBE: Ist das gesetzt, weist der Prüfstand jeden `/edit…`-Pfad
   * OHNE dieses Präfix mit 404 ab. Ohne diese Schärfe wäre der Fall auch dann
   * grün, wenn das Overlay das Präfix vergisst — und ein vergessener Pfad ist
   * in Staging genau der stumme 404, um den es hier geht. Ein Nachweis, der
   * nicht anschlagen kann, beweist durch sein Ausbleiben nichts.
   */
  basis?: string;
  /** Erzwungene Fehlerantworten, nach Routennamen (`uebernehmen`, …). */
  antworten?: Record<string, Fehlerantwort>;
  /**
   * Versionen der WEBSITE, jüngste zuerst — schaltet `/edit/versions` und
   * `/edit/restore` frei (sonst antworten sie 501, siehe der Block dort).
   *
   * `neueDateien` sagt, was es in dieser Version noch NICHT gab. Der Prüfstand
   * rechnet damit nichts aus; die Angabe steht da, damit im Fall selbst
   * ablesbar ist, worum es geht: Wer diese Version wiederherstellt, verliert
   * jene Dateien.
   */
  versionen?: { commit: string; vorMs: number; subject: string; neueDateien?: string[] }[];
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
  // Hieß bis zum Umbau „Seite neu laden". Der Knopf tut dasselbe, heißt aber
  // jetzt nach seinem Zweck: Die Änderung ist NICHT live, sie liegt bereit und
  // will angesehen werden.
  reload:
    "!!Array.from(document.querySelectorAll('#__regoro-agent button'))" +
    ".find(b=>b.textContent==='Änderung ansehen')",
  /**
   * Die ganze obere Leiste in EINEM Ausdruck.
   *
   * Absichtlich als Bündel und nicht als sechs Einzelabfragen: Die Aussage der
   * Leiste ist ein Zusammenspiel — „Speichern hervorgehoben UND Verwerfen
   * aktiv UND Veröffentlichen gesperrt" ist der Zustand, nicht drei Zustände.
   * Ein Fall, der nur einen davon prüft, geht durch, während die Leiste als
   * Ganzes lügt.
   *
   * Gesucht wird über den ANFANG der Beschriftung, weil „Veröffentlichen" die
   * Zahl der offenen Änderungen mitträgt („Veröffentlichen (4)").
   */
  leiste:
    "(function(){" +
    "var f=function(t){return Array.from(document.querySelectorAll('#__regoro-bar button'))" +
    ".find(function(b){return b.textContent.indexOf(t)===0})};" +
    "var s=f('Speichern'),v=f('Verwerfen'),p=f('Veröffentlichen'),m=f('Manuell bearbeiten');" +
    "var z=document.querySelector('#__regoro-bar .__regoro-zustand');" +
    "return {speichern:!!s&&!s.disabled,stark:!!s&&s.className.indexOf('__regoro-primary')>-1," +
    "verwerfen:!!v&&!v.disabled,veroeff:!!p&&!p.disabled,veroeffText:p?p.textContent:null," +
    "manuellAn:!!m&&m.className.indexOf('__regoro-modus-an')>-1," +
    "zustand:z?z.textContent:null}})()",
  /** Das eigene Modal: Titel, Text und die Beschriftung seiner Knöpfe. */
  modal:
    "(function(){var m=document.querySelector('#__regoro-modal');if(!m)return null;" +
    "return {titel:(m.querySelector('h2')||{}).textContent," +
    "text:Array.from(m.querySelectorAll('p')).map(function(n){return n.textContent}).join(' ')," +
    "liste:Array.from(m.querySelectorAll('li')).map(function(n){return n.textContent})," +
    "knoepfe:Array.from(m.querySelectorAll('button')).map(function(b){return b.textContent})}})()",
  /** Die flüchtige Statuszeile der Leiste. */
  status: "(document.querySelector('#__regoro-bar .__regoro-status')||{}).textContent",
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

/** Klick auf einen Knopf der OBEREN Leiste, gesucht über den Beschriftungsanfang. */
function leistenKlick(anfang: string): string {
  return (
    "js \"Array.from(document.querySelectorAll('#__regoro-bar button'))" +
    `.find(function(b){return b.textContent.indexOf('${anfang}')===0}).click()"`
  );
}

/** Klick auf einen Knopf im Modal, über seine genaue Beschriftung. */
function modalKlick(text: string): string {
  return (
    "js \"Array.from(document.querySelectorAll('#__regoro-modal button'))" +
    `.find(function(b){return b.textContent==='${text}'}).click()"`
  );
}

/** Ein Zustand, wie ihn eine seit zwölf Tagen offene KI-Änderung erzeugt. */
const ZWOELF_TAGE = 12 * 24 * 60 * 60 * 1000;
const SCHWEBEND_ALT: Zustand = {
  schwebend: true,
  schwebendDateien: ["index.html", "leistungen.html"],
  schwebendVorMs: ZWOELF_TAGE,
  unveroeffentlicht: true,
  unveroeffentlichtAnzahl: 4,
  unveroeffentlichtVorMs: ZWOELF_TAGE,
};

const FAELLE: Record<string, Fall> = {
  "mit-dateien": {
    tun: "Leiste öffnen, irgendeinen Auftrag abschicken.",
    erwartung:
      "Grüne Abschlussblase mit der Liste „index.html“ und einem Knopf „Änderung ansehen“. " +
      "Der gestreamte Text und die Zusammenfassung stehen NUR EINMAL da, nicht zweimal. " +
      "Der Hinweis darunter sagt, dass die Änderung BEREITLIEGT und noch nicht auf der " +
      "Website ist — vor dem Umbau stand hier „Die Änderung ist live“, und genau das " +
      "stimmt seither nicht mehr.",
    ki: true,
    auftrag: true,
    schwebendNachLauf: true,
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
      "KEINE grüne Blase, KEIN Knopf „Änderung ansehen“, kein Hinweis auf eine " +
      "bereitliegende Änderung. " +
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

  // ===========================================================================
  // Eine Bearbeitung, zwei Modi — die schwebende KI-Änderung
  // ===========================================================================

  "schwebend-offen": {
    tun: "Nur die Seite laden. Die obere Leiste ansehen, nichts anklicken.",
    erwartung:
      "Die Leiste sagt von sich aus, dass etwas offen ist: „Offene KI-Änderung, 12 Tage " +
      "alt“. „Speichern“ ist HERVORGEHOBEN und anklickbar, „Verwerfen“ anklickbar — beide " +
      "wirken auf die bereitliegende Änderung. „Veröffentlichen“ ist GESPERRT, denn erst " +
      "muss die offene Änderung entschieden werden. Das Alter ist der eigentliche Inhalt: " +
      "eine Änderung von vorhin und eine von vor zwölf Tagen sehen sonst gleich aus.",
    ki: true,
    zustand: SCHWEBEND_ALT,
    pruefung: `JSON.stringify(${Q.leiste})`,
    sollwert:
      '{"speichern":true,"stark":true,"verwerfen":true,"veroeff":false,' +
      '"veroeffText":"Veröffentlichen (4)","manuellAn":false,' +
      '"zustand":"Offene KI-Änderung, 12 Tage alt"}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "uebernehmen": {
    tun: "Seite laden, in der oberen Leiste auf „Speichern“ klicken.",
    erwartung:
      "„Speichern“ übernimmt die bereitliegende KI-Änderung (POST /edit/uebernehmen) und " +
      "lädt die Seite neu. Danach ist nichts mehr offen, und aus vier unveröffentlichten " +
      "Änderungen sind FÜNF geworden — das Übernehmen ist selbst eine. „Veröffentlichen“ " +
      "ist jetzt frei.",
    ki: true,
    zustand: SCHWEBEND_ALT,
    schritte: [leistenKlick("Speichern"), "sleep 3"],
    pruefung: `JSON.stringify(${Q.leiste})`,
    sollwert:
      '{"speichern":false,"stark":false,"verwerfen":false,"veroeff":true,' +
      '"veroeffText":"Veröffentlichen (5)","manuellAn":false,' +
      '"zustand":"5 Änderungen noch nicht auf der Live-Seite, 12 Tage alt"}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "verwerfen-schwebend": {
    tun: "Seite laden, „Verwerfen“ klicken, im Fenster „Endgültig verwerfen“ bestätigen.",
    erwartung:
      "Rückfrage mit der Dateiliste, dann ist die Änderung weg und die Seite neu geladen. " +
      "Die Zahl der unveröffentlichten Änderungen bleibt bei VIER — verworfen wird die " +
      "schwebende Änderung, nicht der gespeicherte Stand. " +
      "SCHARF GEPRÜFT: Der Prüfstand beantwortet ein falsches `umfang` mit 400, der Fall " +
      "wird dann rot. So misst er die abgeschickte Anfrage und nicht bloß, dass geklickt wurde.",
    ki: true,
    zustand: SCHWEBEND_ALT,
    schritte: [leistenKlick("Verwerfen"), "sleep 1", modalKlick("Endgültig verwerfen"), "sleep 3"],
    pruefung: `JSON.stringify(${Q.leiste})`,
    sollwert:
      '{"speichern":false,"stark":false,"verwerfen":false,"veroeff":true,' +
      '"veroeffText":"Veröffentlichen (4)","manuellAn":false,' +
      '"zustand":"4 Änderungen noch nicht auf der Live-Seite, 12 Tage alt"}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "moduswechsel": {
    tun: "Seite laden, auf „Manuell bearbeiten“ klicken.",
    erwartung:
      "KEIN Editiermodus, sondern die Rückfrage: Es kann immer nur EINE Bearbeitung offen " +
      "sein. Das Fenster nennt die betroffenen Dateien und bietet beide Auswege an. Ohne " +
      "diese Rückfrage tippte der Kunde erst eine Weile und liefe dann beim Speichern in " +
      "einen 409 — die Arbeit wäre umsonst gewesen.",
    ki: true,
    zustand: SCHWEBEND_ALT,
    schritte: [leistenKlick("Manuell bearbeiten"), "sleep 1"],
    pruefung: `JSON.stringify(${Q.modal})`,
    sollwert:
      '{"titel":"Es liegt eine KI-Änderung bereit",' +
      '"text":"Der Assistent hat eine Änderung vorbereitet (12 Tage alt), die noch nicht ' +
      'übernommen ist. Es kann immer nur eine Bearbeitung offen sein. Möchtest du sie ' +
      'übernehmen oder wegwerfen?","liste":["index.html","leistungen.html"],' +
      '"knoepfe":["Abbrechen","Verwerfen","Übernehmen"]}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "uebernehmen-validierung": {
    tun: "Seite laden, „Speichern“ klicken.",
    erwartung:
      "Die Übernahme scheitert an der Prüfung (422). Der Kunde muss erfahren, WELCHE Datei " +
      "und WARUM — in ganzen Sätzen, wie `validate.ts` sie erzeugt. Nirgends darf eine " +
      "nackte Zahl stehen: „422“ ist für ihn dasselbe wie gar keine Auskunft. Und es muss " +
      "dastehen, dass die Website unverändert ist.",
    ki: true,
    zustand: SCHWEBEND_ALT,
    antworten: {
      uebernehmen: {
        status: 422,
        rumpf: {
          fehler: "validierung",
          grund: "Die Änderung hat die Prüfung nicht bestanden.",
          dateien: [
            { pfad: "leistungen.html", grund: "Die Datei enthält ein neues Inline-Skript." },
          ],
        },
      },
    },
    schritte: [leistenKlick("Speichern"), "sleep 2"],
    pruefung: `JSON.stringify(${Q.modal})`,
    sollwert:
      '{"titel":"Die Änderung wurde nicht übernommen",' +
      '"text":"Die Änderung des Assistenten hat die Prüfung nicht bestanden und wurde nicht ' +
      'übernommen. Die Website ist unverändert.",' +
      '"liste":["leistungen.html: Die Datei enthält ein neues Inline-Skript."],' +
      '"knoepfe":["Schließen","Seite neu laden"]}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  // ===========================================================================
  // Veröffentlichen
  // ===========================================================================

  "veroeffentlichen": {
    tun: "Seite laden, „Veröffentlichen (4)“ klicken, im Fenster bestätigen.",
    erwartung:
      "Der Knopf trägt die ZAHL der wartenden Änderungen — das ist der Ort, an dem sie " +
      "etwas bewirkt. Nach dem Bestätigen meldet die Leiste, was übertragen wurde, und " +
      "der Knopf ist wieder gesperrt: Es gibt nichts mehr zu veröffentlichen. KEIN Reload " +
      "— am Entwurf hat sich nichts geändert.",
    ki: true,
    zustand: { unveroeffentlicht: true, unveroeffentlichtAnzahl: 4, unveroeffentlichtVorMs: ZWOELF_TAGE },
    schritte: [leistenKlick("Veröffentlichen"), "sleep 1", modalKlick("Jetzt veröffentlichen"), "sleep 2"],
    pruefung: `JSON.stringify({leiste:${Q.leiste},status:${Q.status}})`,
    sollwert:
      '{"leiste":{"speichern":false,"stark":false,"verwerfen":false,"veroeff":false,' +
      '"veroeffText":"Veröffentlichen","manuellAn":false,"zustand":""},' +
      '"status":"Veröffentlicht — 3 Dateien übertragen, 1 entfernt."}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "veroeffentlichen-fremd": {
    tun: "Seite laden, „Veröffentlichen“ klicken, bestätigen.",
    erwartung:
      "Die Prüfsummen-Notbremse schlägt an (409). Der Satz muss sagen, WAS passiert ist — " +
      "jemand hat direkt an den Dateien gearbeitet — und dass deshalb NICHTS überschrieben " +
      "wurde. Die betroffenen Dateien stehen dabei. Das Wort „409“ darf nirgends auftauchen: " +
      "Für den Kunden ist eine Statuszahl dasselbe wie Schweigen.",
    ki: true,
    zustand: { unveroeffentlicht: true, unveroeffentlichtAnzahl: 2, unveroeffentlichtVorMs: 60_000 },
    antworten: {
      veroeffentlichen: {
        status: 409,
        rumpf: {
          fehler: "fremd-geschrieben",
          grund: "Es wurde außerhalb des Editors geschrieben.",
          dateien: ["index.html", "assets/logo.png"],
        },
      },
    },
    schritte: [leistenKlick("Veröffentlichen"), "sleep 1", modalKlick("Jetzt veröffentlichen"), "sleep 2"],
    pruefung: `JSON.stringify(${Q.modal})`,
    sollwert:
      '{"titel":"Es wurde nichts veröffentlicht",' +
      '"text":"Jemand hat direkt an den Dateien der Website gearbeitet, außerhalb des ' +
      'Editors. Damit nichts von dieser Arbeit verlorengeht, wurde nichts überschrieben.",' +
      '"liste":["index.html","assets/logo.png"],"knoepfe":["Schließen"]}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "modal-im-edit-modus": {
    tun: "„Manuell bearbeiten“ klicken, dann „Veröffentlichen“, dann bestätigen.",
    erwartung:
      "Das Modal ist AUS DEM EDITIERMODUS HERAUS bedienbar. Dort ist der Navigations-Guard " +
      "scharf, der auf der Seite jeden Klick auf Links und Knöpfe abfängt, damit der Cursor " +
      "gesetzt wird statt zu navigieren. Nachgemessen unterdrückt er nur die " +
      "Standardhandlung und nicht die eigenen Listener — die Knöpfe funktionieren also " +
      "ohnehin. Dieser Fall hält das fest: Wer künftig `stopPropagation` ergänzt oder ein " +
      "Element einbaut, das wirklich am Guard hängt, macht ihn rot.",
    ki: true,
    zustand: { unveroeffentlicht: true, unveroeffentlichtAnzahl: 1, unveroeffentlichtVorMs: 60_000 },
    schritte: [
      leistenKlick("Manuell bearbeiten"),
      "sleep 1",
      leistenKlick("Veröffentlichen"),
      "sleep 1",
      modalKlick("Jetzt veröffentlichen"),
      "sleep 2",
    ],
    pruefung: `JSON.stringify({status:${Q.status},modalWeg:!document.querySelector('#__regoro-modal'),manuellAn:${Q.leiste}.manuellAn})`,
    sollwert: '{"status":"Veröffentlicht — 3 Dateien übertragen, 1 entfernt.","modalWeg":true,"manuellAn":true}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  // ===========================================================================
  // Der Drei-Tage-Hinweis (C8)
  // ===========================================================================

  "drei-tage": {
    tun: "Leiste öffnen, irgendeinen Auftrag abschicken.",
    erwartung:
      "Vor dem Auftrag kommt der Hinweis: Es liegen Änderungen zur Live-Seite, die älter " +
      "sind als drei Tage. Der Assistent baute sonst auf einem Stand auf, den seit zwölf " +
      "Tagen niemand gesehen hat. Genau ZWEI Knöpfe, beide benannt — KEIN „Abbrechen“: " +
      "Wer hier vorbeikäme, bekäme den Auftrag, den er nicht beurteilen konnte. Und genau " +
      "das kann ein confirm() nicht, deshalb gibt es dieses Fenster überhaupt.",
    ki: true,
    auftrag: true,
    zustand: { unveroeffentlicht: true, unveroeffentlichtAnzahl: 4, unveroeffentlichtVorMs: ZWOELF_TAGE },
    pruefung: `JSON.stringify(${Q.modal})`,
    sollwert:
      '{"titel":"Achtung","text":"Es bestehen noch Änderungen zur Live-Seite, die älter ' +
      'sind als drei Tage (die älteste 12 Tage alt). Möchtest du die Änderungen verwerfen ' +
      'und die Bearbeitung von der Live-Seite aus beginnen, oder von deinen bestehenden ' +
      'Änderungen aus weitermachen?","liste":[],' +
      '"knoepfe":["Änderungen verwerfen","Änderungen behalten"]}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "drei-tage-behalten": {
    tun: "Leiste öffnen, Auftrag abschicken, im Hinweis „Änderungen behalten“ klicken.",
    erwartung:
      "Der Auftrag läuft ganz normal durch — grüne Abschlussblase mit Dateiliste. Der " +
      "Hinweis ist eine Frage, keine Sperre.",
    ki: true,
    auftrag: true,
    zustand: { unveroeffentlicht: true, unveroeffentlichtAnzahl: 4, unveroeffentlichtVorMs: ZWOELF_TAGE },
    schwebendNachLauf: true,
    schritte: [modalKlick("Änderungen behalten"), "sleep 3"],
    pruefung: `JSON.stringify({gruen:${Q.gruen},dateien:Array.from(document.querySelectorAll('.__regoro-adateien li')).map(function(l){return l.textContent}),reload:${Q.reload}})`,
    sollwert: '{"gruen":1,"dateien":["index.html"],"reload":true}',
    ereignisse: [
      rahmen("text", { inhalt: "Ich ändere den Absatz." }),
      rahmen("fertig", {
        zusammenfassung: "Ich ändere den Absatz.",
        dateien: ["index.html"],
        commit: "a1b2c3d",
      }),
    ],
  },

  "drei-tage-verwerfen": {
    tun: "Leiste öffnen, Auftrag abschicken, im Hinweis „Änderungen verwerfen“ klicken.",
    erwartung:
      "DIE GANZE KETTE AUS C8: Entwurf zurücksetzen, Seite neu laden, DANN den Auftrag " +
      "abschicken. Über den Reload hinweg gibt es keinen JS-Zustand mehr — der Auftrag " +
      "reist im sessionStorage mit und wird beim Öffnen der Leiste zu Ende geführt. " +
      "Danach steht der Auftrag als Kundenblase da, der Lauf ist durch, und die Leiste " +
      "meldet KEINE unveröffentlichten Änderungen mehr. Der Merkzettel wird beim Lesen " +
      "gelöscht: Ein zweites Laden darf den Auftrag nicht ein zweites Mal auslösen — " +
      "das kostete echtes Geld und wäre nicht erklärbar.",
    ki: true,
    auftrag: true,
    zustand: { unveroeffentlicht: true, unveroeffentlichtAnzahl: 4, unveroeffentlichtVorMs: ZWOELF_TAGE },
    schwebendNachLauf: true,
    schritte: [modalKlick("Änderungen verwerfen"), "sleep 5"],
    pruefung:
      "JSON.stringify({kunde:(document.querySelector('.__regoro-avon-kunde')||{}).textContent," +
      `gruen:${Q.gruen},reload:${Q.reload},leiste:${Q.leiste}})`,
    sollwert:
      '{"kunde":"mach was","gruen":1,"reload":true,' +
      '"leiste":{"speichern":true,"stark":true,"verwerfen":true,"veroeff":false,' +
      '"veroeffText":"Veröffentlichen","manuellAn":false,' +
      '"zustand":"Offene KI-Änderung, von heute"}}',
    ereignisse: [
      rahmen("text", { inhalt: "Ich ändere den Absatz." }),
      rahmen("fertig", {
        zusammenfassung: "Ich ändere den Absatz.",
        dateien: ["index.html"],
        commit: "a1b2c3d",
      }),
    ],
  },

  // ===========================================================================
  // Staging und Präfix-Betrieb
  // ===========================================================================

  "staging": {
    tun: "Seite laden, die obere Leiste ansehen.",
    erwartung:
      "KEIN Knopf „Veröffentlichen“ — nicht gesperrt, sondern GAR NICHT DA. Ein grauer " +
      "Knopf sagt „geht gerade nicht“; hier gibt es aber kein Ziel, und daran ändert kein " +
      "Warten etwas. Auch die Zustandszeile schweigt: Von „noch nicht auf der Live-Seite“ " +
      "zu reden, wo es keine Live-Seite gibt, wäre eine Auskunft über nichts. Der übrige " +
      "Editor arbeitet unverändert.",
    ki: true,
    staging: true,
    zustand: { unveroeffentlicht: true, unveroeffentlichtAnzahl: 7, unveroeffentlichtVorMs: ZWOELF_TAGE, staging: true },
    pruefung: `JSON.stringify(${Q.leiste})`,
    sollwert:
      '{"speichern":false,"stark":false,"verwerfen":false,"veroeff":false,' +
      '"veroeffText":null,"manuellAn":false,"zustand":""}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "praefix": {
    tun: "Leiste öffnen, irgendeinen Auftrag abschicken.",
    erwartung:
      "Dieselbe Website unter `/praefix/…`. JEDER Aufruf des Overlays muss das Präfix " +
      "tragen — Zustand, Auftrag, Ereignisstrom, Gesprächsliste, Kontingent. " +
      "MIT GEGENPROBE: Der Prüfstand beantwortet in diesem Fall jeden Pfad OHNE Präfix " +
      "mit 404. Vergisst das Overlay auch nur einen, wird der Fall rot — statt grün zu " +
      "bleiben und den stummen 404 erst in der echten Vorschau zu zeigen.",
    ki: true,
    auftrag: true,
    basis: "/praefix",
    zustand: { unveroeffentlicht: true, unveroeffentlichtAnzahl: 2, unveroeffentlichtVorMs: 60_000 },
    schwebendNachLauf: true,
    pruefung: `JSON.stringify({gruen:${Q.gruen},reload:${Q.reload},leiste:${Q.leiste}})`,
    sollwert:
      '{"gruen":1,"reload":true,"leiste":{"speichern":true,"stark":true,"verwerfen":true,' +
      '"veroeff":false,"veroeffText":"Veröffentlichen (2)","manuellAn":false,' +
      '"zustand":"Offene KI-Änderung, von heute"}}',
    ereignisse: [
      rahmen("werkzeug", { name: "write_file", kurz: "schreibt index.html" }),
      rahmen("text", { inhalt: "Ich ändere den Absatz." }),
      rahmen("fertig", {
        zusammenfassung: "Ich ändere den Absatz.",
        dateien: ["index.html"],
        commit: "a1b2c3d",
      }),
    ],
  },

  "zustand-fehlt": {
    tun: "Leiste öffnen, irgendeinen Auftrag abschicken.",
    erwartung:
      "Ein Server OHNE `/edit/zustand` (404). Die Leiste muss arbeiten wie vor dem Umbau: " +
      "Auftrag durchführbar, grüne Abschlussblase, Dateiliste. Keine Fehlermeldung über " +
      "einen Zustand, den niemand erfragt hat. Dieselbe Regel wie bei `verlauf-fehlt`: " +
      "Was Komfort ist, darf nie im Arbeitsweg stehen.",
    ki: true,
    auftrag: true,
    zustandFehlt: true,
    pruefung: `JSON.stringify({gruen:${Q.gruen},dateien:Array.from(document.querySelectorAll('.__regoro-adateien li')).map(function(l){return l.textContent}),reload:${Q.reload},zustand:${Q.leiste}.zustand})`,
    sollwert: '{"gruen":1,"dateien":["index.html"],"reload":true,"zustand":""}',
    ereignisse: [
      rahmen("werkzeug", { name: "write_file", kurz: "schreibt index.html" }),
      rahmen("fertig", {
        zusammenfassung: "Ich ändere den Absatz.",
        dateien: ["index.html"],
        commit: "a1b2c3d",
      }),
    ],
  },

  "wiederherstellen-loescht": {
    tun:
      "Seite laden, „Versionen“ öffnen, bei der ÄLTEREN Version auf " +
      "„Auf diesen Stand zurück“ klicken. NICHT bestätigen.",
    erwartung:
      "Bevor irgendetwas passiert, muss dastehen, dass es um die GANZE WEBSITE geht und " +
      "dass seither hinzugekommene Dateien dabei VERSCHWINDEN. Die jüngere Version hat " +
      "„preise.html“ angelegt; wer auf die ältere zurückgeht, verliert sie. " +
      "Der Kunde steht dabei auf EINER Seite und klickt in einer Liste, die neben dieser " +
      "Seite aufgeht — „diese Version wiederherstellen“ liest sich dort zwangsläufig als " +
      "„diese Seite“. Deshalb steht die Handlung auch AUF dem Knopf („Ganze Website " +
      "zurücksetzen“) und nicht nur im Text darüber; ein „OK“ wäre die Zustimmung zu " +
      "etwas, das man beim Klicken nicht mehr vor Augen hat. " +
      "Die Liste heißt „Versionen der Website“, nicht „Versionen“ — eine Liste, die nach " +
      "der Seite aussieht, neben einem Knopf, der den ganzen Baum zurücksetzt, wäre aktiv " +
      "irreführend.",
    ki: true,
    versionen: [
      { commit: "bbbb222", vorMs: 60_000, subject: "Preisseite angelegt", neueDateien: ["preise.html"] },
      { commit: "aaaa111", vorMs: 3 * 24 * 60 * 60 * 1000, subject: "Startseite überarbeitet" },
    ],
    schritte: [
      leistenKlick("Versionen"),
      "sleep 1",
      "js \"Array.from(document.querySelectorAll('#__regoro-versions .__regoro-vitem'))" +
        ".find(function(i){return i.textContent.indexOf('Startseite überarbeitet')>-1})" +
        ".querySelector('.__regoro-vrestore').click()\"",
      "sleep 1",
    ],
    pruefung:
      `JSON.stringify({modal:${Q.modal},` +
      "ueberschrift:(document.querySelector('#__regoro-versions h2')||{}).textContent})",
    sollwert:
      '{"modal":{"titel":"Die ganze Website auf diesen Stand zurücksetzen?",' +
      '"text":"Version: „Startseite überarbeitet“ Es geht nicht nur um diese Seite: ALLE ' +
      'Seiten und Dateien der Website gehen auf diesen Stand zurück. Was seither ' +
      'hinzugekommen ist — auch ganze neu angelegte Seiten —, verschwindet dabei. Der ' +
      'jetzige Stand geht nicht verloren: Er bleibt als Version erhalten, und du kannst ' +
      'genauso wieder zu ihm zurück.","liste":[],' +
      '"knoepfe":["Abbrechen","Ganze Website zurücksetzen"]},' +
      '"ueberschrift":"Versionen der Website"}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "wiederherstellen-ausfuehren": {
    tun:
      "Seite laden, „Versionen“ öffnen, bei der ÄLTEREN Version auf " +
      "„Auf diesen Stand zurück“ klicken und mit „Ganze Website zurücksetzen“ bestätigen.",
    erwartung:
      "Erst jetzt geht die Anfrage hinaus. Das Wiederherstellen ist selbst eine " +
      "gespeicherte Änderung (ein neuer Commit obendrauf), also zeigt die Leiste danach " +
      "eine mehr: „Veröffentlichen (3)“ statt (2). " +
      "DIESER FALL IST DER, DER DIE ANFRAGE SCHARF PRÜFT — `wiederherstellen-loescht` " +
      "hält beim Fenster an und schickt nie etwas ab. Nachgewiesen: Baut man `pagePath` " +
      "wieder in den Rumpf ein, bleibt jener Fall grün und DIESER wird rot. Ein Nachweis, " +
      "der nicht anschlagen kann, beweist durch sein Ausbleiben nichts — deshalb gibt es " +
      "beide Fälle und nicht nur den bequemeren.",
    ki: true,
    zustand: { unveroeffentlicht: true, unveroeffentlichtAnzahl: 2, unveroeffentlichtVorMs: 60_000 },
    versionen: [
      { commit: "bbbb222", vorMs: 60_000, subject: "Preisseite angelegt", neueDateien: ["preise.html"] },
      { commit: "aaaa111", vorMs: 3 * 24 * 60 * 60 * 1000, subject: "Startseite überarbeitet" },
    ],
    schritte: [
      leistenKlick("Versionen"),
      "sleep 1",
      "js \"Array.from(document.querySelectorAll('#__regoro-versions .__regoro-vitem'))" +
        ".find(function(i){return i.textContent.indexOf('Startseite überarbeitet')>-1})" +
        ".querySelector('.__regoro-vrestore').click()\"",
      "sleep 1",
      modalKlick("Ganze Website zurücksetzen"),
      "sleep 3",
    ],
    pruefung: `JSON.stringify(${Q.leiste})`,
    sollwert:
      '{"speichern":false,"stark":false,"verwerfen":false,"veroeff":true,' +
      '"veroeffText":"Veröffentlichen (3)","manuellAn":false,' +
      '"zustand":"3 Änderungen noch nicht auf der Live-Seite, von heute"}',
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
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
 * DER FEHLERFÄNGER — er macht sichtbar, was sonst KEIN Werkzeug dieses Repos
 * sieht.
 *
 * Gemessen: Ein ReferenceError im Aufbau der Leiste (`buildBar()` hängt eine
 * Funktion an, die es noch nicht gibt) bricht `init()` ab, es entsteht keine
 * Leiste — und `browse console --errors` meldet „(no console errors)". Das
 * Werkzeug erfasst `console.error`, aber keine unbehandelten Ausnahmen, auch
 * nicht lange nach dem Laden (Probe: `setTimeout(function(){ nichtDa(); }, 0)`
 * bei frisch geleerter Konsole → nichts). Zusammen mit `tsc`, das diese Datei
 * gar nicht ansieht, und dem Browser-Build, der nur parst, war diese
 * Fehlerklasse damit für JEDE unserer Prüfungen unsichtbar — bei der Datei mit
 * dem meisten Kundenkontakt.
 *
 * ER MUSS VOR DEM OVERLAY-SCRIPT STEHEN, sonst hängt er sich erst nach dem
 * Fehler an und fängt nichts.
 *
 * `true` als dritter Parameter — also CAPTURE — ist kein Detail: Ohne ihn
 * bleiben FEHLGESCHLAGENE RESSOURCEN ungesehen, denn deren `error`-Ereignis
 * steigt nicht auf. Mit ihm meldet der Fänger auch ein `overlay.js`, das gar
 * nicht erst geladen wurde, und trennt damit die beiden Lagen, die von außen
 * gleich aussehen: kaputter Aufbau (Meldung mit Text) gegen müden Browser
 * (Meldung „ressource: …/overlay.js").
 */
const FEHLERFAENGER = `<script>
window.__fehler = [];
addEventListener("error", function (e) {
  window.__fehler.push(e.message
    ? String(e.message)
    : "ressource: " + String((e.target && (e.target.src || e.target.href)) || e.type));
}, true);
addEventListener("unhandledrejection", function (e) {
  window.__fehler.push("promise: " + String(e.reason));
});
</script>`;

/**
 * Der Zustand, den `GET /edit/zustand` (und `CFG.zustand`) meldet — nachdem
 * die Mutationen dieses Laufs angewendet wurden.
 *
 * Beides aus DERSELBEN Funktion, wie in Produktion: Der Server legt den
 * Zustand in die Seite, damit die Leiste ohne Anfrage stimmt, und liefert ihn
 * auf Nachfrage noch einmal. Zwei getrennte Fassungen hier wären eine zweite
 * Wahrheit — und der erste Fall, der zwischen „beim Laden" und „nach dem
 * Klick" unterscheidet, liefe darauf herein.
 */
function zustandFuer(fall: Fall): Record<string, unknown> {
  const z = fall.zustand ?? {};
  const schwebendJetzt =
    (!!z.schwebend || (fall.schwebendNachLauf === true && laufFertig)) && !schwebendWeg;
  // Übernehmen erzeugt selbst eine gespeicherte Änderung — sonst sähe der
  // Prüfer nicht, dass etwas passiert ist.
  const grundAnzahl = Number(z.unveroeffentlichtAnzahl ?? 0);
  // Übernehmen UND Wiederherstellen erzeugen je einen Commit obendrauf —
  // beides ist eine gespeicherte Änderung mehr, die noch nicht veröffentlicht
  // ist. Ohne diese Zählung sähe der Prüfer nicht, dass etwas passiert ist.
  const obendrauf = (uebernommen ? 1 : 0) + (wiederhergestellt ? 1 : 0);
  const anzahl = entwurfWeg || veroeffentlicht ? 0 : grundAnzahl + obendrauf;
  const seit = z.unveroeffentlichtVorMs;
  return {
    schwebend: schwebendJetzt,
    schwebendDateien: z.schwebendDateien ?? (schwebendJetzt ? ["index.html"] : []),
    schwebendSeit: schwebendJetzt
      ? new Date(Date.now() - (z.schwebendVorMs ?? 0)).toISOString()
      : null,
    unveroeffentlicht: anzahl > 0,
    unveroeffentlichtAnzahl: anzahl,
    unveroeffentlichtSeit:
      anzahl > 0 && seit !== undefined ? new Date(Date.now() - seit).toISOString() : null,
    staging: fall.staging === true,
    veroeffentlichenMoeglich: fall.staging !== true,
  };
}

function seite(fall: Fall, ki: boolean): string {
  const basis = fall.basis ?? "";
  const cfg = {
    pagePath: "index.html",
    fileHash: "a".repeat(64),
    pages: ["index.html"],
    page: "index.html",
    ki,
    basis,
    staging: fall.staging === true,
    // Fehlt die Route, fehlt auch der mitgelieferte Zustand — sonst prüfte der
    // Fall „Server ohne /edit/zustand" eine Lage, die es nicht gibt.
    zustand: fall.zustandFehlt ? undefined : zustandFuer(fall),
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
${FEHLERFAENGER}
<script src="${basis}/edit-assets/overlay.js"></script>
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

/**
 * DIE WIRKUNG EINER AKTION MUSS DEN RELOAD ÜBERLEBEN — sonst kann kein Fall
 * sie sehen.
 *
 * „Übernehmen" und „Verwerfen" laden die Seite neu; erst DANACH wird geprüft.
 * Würden diese Merker wie `auftragLaeuft` bei jedem Seitenaufruf
 * zurückgesetzt, zeigte die Leiste nach dem Reload wieder die schwebende
 * Änderung, und der Fall wäre rot, obwohl das Overlay alles richtig gemacht
 * hat. Sie werden deshalb nur beim FALLWECHSEL geleert.
 *
 * Genau die andere Regel als bei `auftragLaeuft`/`kontingentWeg`: Die gehören
 * zu einem Lauf und sollen mit einer frischen Seite verschwinden. Zwei
 * verschiedene Lebensdauern, weil zwei verschiedene Dinge gemeint sind.
 */
let letzterFall = "";
let uebernommen = false;
let wiederhergestellt = false;
let schwebendWeg = false;
let entwurfWeg = false;
let veroeffentlicht = false;
/** Ist der Ereignisstrom eines Falls einmal durchgelaufen? (für schwebendNachLauf) */
let laufFertig = false;

function setzeFallZurueck(): void {
  uebernommen = false;
  wiederhergestellt = false;
  schwebendWeg = false;
  entwurfWeg = false;
  veroeffentlicht = false;
  laufFertig = false;
}

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
     * DIE GEGENPROBE ZUM PRÄFIX-BETRIEB.
     *
     * Führt der Fall ein `basis`, MUSS jeder Editor-Pfad damit beginnen. Ohne
     * diese Zeile wäre der Präfix-Fall auch dann grün, wenn das Overlay das
     * Präfix nirgends anhängt — der Prüfstand antwortete ja auf beide Formen.
     * Ein Nachweis, der nicht anschlagen kann, beweist durch sein Ausbleiben
     * nichts; genau davor warnt CLAUDE.md, und genau hier wäre es leicht
     * passiert.
     *
     * Nur `/edit…` wird geprüft: Alles andere gehört der Website und hat mit
     * der Präfix-Frage nichts zu tun.
     */
    if (fall.basis && /^\/edit/.test(pfad)) {
      return new Response(
        `Ohne Präfix gibt es diesen Pfad nicht. Erwartet: ${fall.basis}${pfad}`,
        { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }

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
    /**
     * Versionen — nur für Fälle, die welche erklärt haben. Alle anderen fallen
     * weiter in den 501-Zweig darunter und bleiben damit unverändert.
     */
    if (fall.versionen && pfad.endsWith("/edit/versions")) {
      /**
       * OHNE `?page=`, und das wird SCHARF geprüft.
       *
       * Versionen gelten seit dem Umbau für die ganze Website; der Parameter
       * ist beim Server weggefallen. Ihn hier stillschweigend zu schlucken
       * hieße, dass der Fall auch dann grün bliebe, wenn das Overlay weiter
       * eine Seite mitschickt — und niemandem fiele auf, dass die Liste etwas
       * anderes verspricht als der Knopf darunter tut.
       */
      if (url.searchParams.has("page")) {
        return Response.json(
          { fehler: "formular", grund: "`page` gibt es hier nicht mehr — Versionen gelten für die ganze Website." },
          { status: 400 },
        );
      }
      const jetzt = Date.now();
      return Response.json(
        fall.versionen.map((v) => ({
          commit: v.commit,
          date: new Date(jetzt - v.vorMs).toISOString(),
          subject: v.subject,
        })),
      );
    }
    if (fall.versionen && pfad.endsWith("/edit/restore") && req.method === "POST") {
      return req.json().then((rumpf: unknown) => {
        const b = rumpf as { commit?: unknown; pagePath?: unknown } | null;
        // Dieselbe Schärfe wie bei `umfang`: `pagePath` ist mit C10 weggefallen.
        if (b && "pagePath" in b) {
          return Response.json(
            { fehler: "formular", grund: "`pagePath` gibt es hier nicht mehr." },
            { status: 400 },
          );
        }
        if (typeof b?.commit !== "string") {
          return Response.json({ fehler: "formular", grund: "Kein Commit angegeben." }, { status: 400 });
        }
        wiederhergestellt = true;
        return Response.json({ ok: true });
      });
    }

    if (/\/edit\/(save|upload|restore|versions)$/.test(pfad) || /\/edit\/version\//.test(pfad)) {
      return new Response(
        "Der Prüfstand speichert nicht — er bildet nur die KI-Seitenleiste nach. " +
          "Text ändern ist trotzdem sinnvoll: Es prüft den Dirty-Guard, der einen " +
          "Auftrag bei ungespeicherten Änderungen ablehnt.",
        { status: 501, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }

    /**
     * Die vier Routen des Umbaus. Sie hängen NICHT am Modellzugang (C2): Wer
     * eine schwebende Änderung hat, während die KI abgeschaltet wird, muss sie
     * noch übernehmen oder verwerfen können.
     */
    if (pfad.endsWith("/edit/zustand")) {
      if (fall.zustandFehlt) return new Response("Nicht gefunden", { status: 404 });
      return Response.json(zustandFuer(fall));
    }
    if (pfad.endsWith("/edit/uebernehmen") && req.method === "POST") {
      const erzwungen = fall.antworten?.uebernehmen;
      if (erzwungen) return Response.json(erzwungen.rumpf, { status: erzwungen.status });
      uebernommen = true;
      schwebendWeg = true;
      return Response.json({ ok: true, commit: "a1b2c3d", dateien: ["index.html"] });
    }
    if (pfad.endsWith("/edit/verwerfen") && req.method === "POST") {
      const erzwungen = fall.antworten?.verwerfen;
      if (erzwungen) return Response.json(erzwungen.rumpf, { status: erzwungen.status });
      return req.json().then((rumpf: unknown) => {
        const umfang = (rumpf as { umfang?: unknown } | null)?.umfang;
        /**
         * SCHARF, und das ist der Punkt dieses Falls.
         *
         * Ein Prüfstand, der jedes `umfang` schluckt, misst nur, DASS geklickt
         * wurde — nicht, WAS abgeschickt wurde. „schwebend" und „entwurf" tun
         * grundverschiedene Dinge: das eine wirft die offene KI-Änderung weg,
         * das andere den ganzen gespeicherten Stand seit der letzten
         * Veröffentlichung. Sie zu verwechseln wäre der teuerste Fehler dieser
         * Oberfläche, und er sähe im Browser genau gleich aus.
         */
        if (umfang !== "schwebend" && umfang !== "entwurf") {
          return Response.json(
            { fehler: "umfang", grund: `Unbekannter Umfang: ${JSON.stringify(umfang)}` },
            { status: 400 },
          );
        }
        if (umfang === "schwebend") schwebendWeg = true;
        else entwurfWeg = true;
        return Response.json({ ok: true });
      });
    }
    if (pfad.endsWith("/edit/veroeffentlichen") && req.method === "POST") {
      const erzwungen = fall.antworten?.veroeffentlichen;
      if (erzwungen) return Response.json(erzwungen.rumpf, { status: erzwungen.status });
      veroeffentlicht = true;
      return Response.json({ ok: true, geschrieben: 3, geloescht: 1 });
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
      // Ab jetzt liegt das Ergebnis des Laufs bereit — für Fälle, die das
      // erklärt haben. Ein Lauf, der Dateien schreibt, hinterlässt seit dem
      // Umbau eine schwebende Änderung; das muss der Zustand auch sagen.
      if (fall.schwebendNachLauf) laufFertig = true;
      return strom(fall.ereignisse);
    }
    if (seitenAufruf) {
      auftragLaeuft = false; // frische Seite, frischer Zustand
      kontingentWeg = false;
      // NUR beim Fallwechsel, nicht bei jedem Seitenaufruf: siehe den Block
      // über `letzterFall`. „Übernehmen" lädt die Seite neu, und die Wirkung
      // wird erst danach geprüft.
      if (fallName !== letzterFall) {
        letzterFall = fallName;
        setzeFallZurueck();
      }
      return new Response(seite(fall, erschoepft ? true : fall.ki), {
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
