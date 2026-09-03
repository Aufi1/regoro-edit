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
 * Danach die ausgegebenen Adressen im Browser öffnen und gegen die genannte
 * Erwartung prüfen. Die Leiste öffnet sich über den Knopf „KI-Assistent“; wo
 * ein Auftrag nötig ist, steht es beim jeweiligen Fall.
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
}

const FAELLE: Record<string, Fall> = {
  "mit-dateien": {
    tun: "Leiste öffnen, irgendeinen Auftrag abschicken.",
    erwartung:
      "Grüne Abschlussblase mit der Liste „index.html“ und einem Knopf „Seite neu laden“. " +
      "Der gestreamte Text und die Zusammenfassung stehen NUR EINMAL da, nicht zweimal.",
    ki: true,
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
    ereignisse: [rahmen("fehler", { grund: "Kein Lauf aktiv." })],
  },

  "nachlese-fehler": {
    tun: "Nur die Leiste öffnen, nichts abschicken.",
    erwartung:
      "Der zuletzt GESCHEITERTE Lauf wird nachgereicht: die Werkzeugzeile und der echte " +
      "Grund. (Ohne das versucht es der Kunde nach einem Reload noch einmal und bezahlt " +
      "denselben Fehlschlag zweimal.)",
    ki: true,
    ereignisse: [
      rahmen("werkzeug", { name: "write_file", kurz: "schreibt leistungen.html" }),
      rahmen("fehler", { grund: "Die Datei enthält ein neues Inline-Skript." }),
    ],
  },

  "ohne-ki": {
    tun: "Seite laden, die obere Leiste ansehen.",
    erwartung:
      "KEIN Knopf „KI-Assistent“ und kein `#__regoro-agent` im DOM — die Seitenleiste " +
      "existiert ohne Modellzugang gar nicht. Der übrige Editor funktioniert unverändert.",
    ki: false,
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
und sagen, warum.</p>
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
    if (pfad.endsWith("/edit/agent/status")) {
      return Response.json({
        ok: true,
        laeuft: false,
        laufId: null,
        kontingent: erschoepft
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
      const nachlese = fallName === "nachlese-fehler";
      if (!auftragLaeuft && !nachlese) {
        return strom([rahmen("fehler", { grund: "Kein Lauf aktiv." })]);
      }
      auftragLaeuft = false;
      return strom(fall.ereignisse);
    }
    if (seitenAufruf) {
      auftragLaeuft = false; // frische Seite, frischer Zustand
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

const basis = `http://localhost:${PORT}`;
console.log(`Prüfstand für die KI-Seitenleiste läuft auf ${basis}\n`);
for (const [name, fall] of Object.entries(FAELLE)) {
  console.log(`── ${name} ──`);
  console.log(`   ${basis}/${name}/edit`);
  console.log(`   Tun:       ${fall.tun}`);
  console.log(`   Erwartung: ${fall.erwartung}\n`);
}
console.log(`── ${ERSCHOEPFT} ──`);
console.log(`   ${basis}/${ERSCHOEPFT}/edit`);
console.log("   Tun:       Nur die Leiste öffnen.");
console.log(
  "   Erwartung: Die Kontingentzeile ist eingefärbt und nennt den Monatsersten, und\n" +
    "              „Auftrag geben“ ist GESPERRT — der Kunde läuft gar nicht erst hinein.\n",
);
console.log("Beenden mit Strg+C.");
