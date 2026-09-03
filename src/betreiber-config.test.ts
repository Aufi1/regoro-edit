/**
 * betreiber-config.ts — der BETREIBERWEITE Modellzugang (`/etc/regoro/ki.json`).
 *
 * Diese Datei gehört uns, nicht dem Kunden: ein Zugang bedient alle Websites.
 * Deshalb liegt sie außerhalb jedes Site-Ordners und wird hier nur über
 * ausdrücklich übergebene Pfade in tmp-Ordnern getestet — **kein Test dieser
 * Datei schreibt oder liest je nach `/etc/regoro/`**.
 *
 * Fail-closed wie `loadAuthFile` (auth.ts:185): fehlende, kaputte oder veraltete
 * Datei heißt „KI aus" (`ctx.ki === null` → alle /edit/agent*-Routen 404),
 * niemals „KI ohne Schutz".
 */
import { describe, expect, test, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STANDARD_BASE_URL,
  STANDARD_MODELL,
  KI_CONFIG_PFAD,
  MIN_API_KEY_LEN,
  betreiberConfigPfad,
  loadKiConfig,
  schreibeKiConfig,
  entferneKiConfig,
  type KiConfig,
} from "./betreiber-config.ts";

const tmpRoots: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Legt eine ki.json mit beliebigem Inhalt an und gibt ihren Pfad zurück. */
function schreibeRoh(inhalt: string): string {
  const dir = makeTmpDir("regoro-ki-");
  const pfad = join(dir, "ki.json");
  writeFileSync(pfad, inhalt);
  return pfad;
}

const GUELTIG = {
  v: 1,
  apiKey: "sk-or-v1-0123456789abcdef0123456789abcdef",
  braveKey: "BSA-0123456789abcdef",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "z-ai/glm-5.3-flash",
};

/** Die geladene Fassung von GUELTIG. */
const GELADEN: KiConfig = {
  apiKey: GUELTIG.apiKey,
  keyFromProxy: false,
  braveKey: GUELTIG.braveKey,
  firecrawlKey: null,
  baseUrl: GUELTIG.baseUrl,
  model: GUELTIG.model,
};

describe("betreiber-config.ts — Konstanten", () => {
  test("Vorgabewerte stehen fest und sind OpenRouter-kompatibel", () => {
    expect(STANDARD_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(STANDARD_MODELL).toBe("z-ai/glm-5.3-flash");
  });

  test("die Datei liegt betreiberweit unter /etc/regoro, nicht im Kundenordner", () => {
    expect(KI_CONFIG_PFAD).toBe("/etc/regoro/ki.json");
    expect(MIN_API_KEY_LEN).toBeGreaterThan(0);
  });
});

describe("betreiber-config.ts — betreiberConfigPfad()", () => {
  const vorher = process.env.CREDENTIALS_DIRECTORY;
  const vorherEigen = process.env.REGORO_KI_CONFIG;

  afterEach(() => {
    if (vorher === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = vorher;
    if (vorherEigen === undefined) delete process.env.REGORO_KI_CONFIG;
    else process.env.REGORO_KI_CONFIG = vorherEigen;
  });

  test("ohne Umgebung → /etc/regoro/ki.json", () => {
    delete process.env.CREDENTIALS_DIRECTORY;
    delete process.env.REGORO_KI_CONFIG;
    expect(betreiberConfigPfad()).toBe(KI_CONFIG_PFAD);
  });

  test("REGORO_KI_CONFIG biegt den Pfad zum Ausprobieren um (Vorbild REGORO_VERSAND_CONFIG)", () => {
    delete process.env.CREDENTIALS_DIRECTORY;
    process.env.REGORO_KI_CONFIG = "/tmp/meine-ki.json";
    expect(betreiberConfigPfad()).toBe("/tmp/meine-ki.json");
  });

  test("$CREDENTIALS_DIRECTORY schlägt auch REGORO_KI_CONFIG", () => {
    // Läuft der Dienst unter systemd, ist die Credential-Fassung die verbindliche.
    process.env.REGORO_KI_CONFIG = "/tmp/meine-ki.json";
    process.env.CREDENTIALS_DIRECTORY = "/run/credentials/regoro.service";
    expect(betreiberConfigPfad()).toBe("/run/credentials/regoro.service/ki");
  });

  test("$CREDENTIALS_DIRECTORY hat Vorrang — systemd hat die Datei als root gelesen", () => {
    // Mit LoadCredential= liegt der Schlüssel in einem tmpfs, das nur dieser
    // Dienst sieht. /etc/regoro/ki.json muss für den Dienst-Benutzer dann gar
    // nicht lesbar sein — wer hier /etc bevorzugt, macht die Härtung wirkungslos.
    process.env.CREDENTIALS_DIRECTORY = "/run/credentials/regoro.service";
    expect(betreiberConfigPfad()).toBe("/run/credentials/regoro.service/ki");
  });

  test("liest die Umgebung bei JEDEM Aufruf, nicht einmalig beim Import", () => {
    delete process.env.CREDENTIALS_DIRECTORY;
    delete process.env.REGORO_KI_CONFIG;
    const ohne = betreiberConfigPfad();
    process.env.CREDENTIALS_DIRECTORY = "/run/credentials/x.service";
    const mit = betreiberConfigPfad();
    expect(ohne).not.toBe(mit);
  });
});

describe("betreiber-config.ts — loadKiConfig() ist fail-closed", () => {
  test("fehlende Datei → null (KI aus, nicht KI ohne Schlüssel)", () => {
    expect(loadKiConfig(join(makeTmpDir("regoro-ki-"), "gibtsnicht.json"))).toBeNull();
  });

  test("kaputtes JSON → null", () => {
    expect(loadKiConfig(schreibeRoh("{ das ist kein json"))).toBeNull();
  });

  test("leere Datei → null", () => {
    expect(loadKiConfig(schreibeRoh(""))).toBeNull();
  });

  test("JSON, aber kein Objekt → null", () => {
    expect(loadKiConfig(schreibeRoh("[1,2,3]"))).toBeNull();
    expect(loadKiConfig(schreibeRoh('"text"'))).toBeNull();
    expect(loadKiConfig(schreibeRoh("null"))).toBeNull();
  });

  test("fehlende oder falsche Version → null (nicht migrieren, wie pruefeAuthDatei)", () => {
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, v: 2 })))).toBeNull();
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, v: "1" })))).toBeNull();
    const { v: _weg, ...ohneVersion } = GUELTIG;
    expect(loadKiConfig(schreibeRoh(JSON.stringify(ohneVersion)))).toBeNull();
  });

  test("apiKey fehlt oder ist kein String → null", () => {
    const { apiKey: _weg, ...ohneKey } = GUELTIG;
    expect(loadKiConfig(schreibeRoh(JSON.stringify(ohneKey)))).toBeNull();
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, apiKey: 12345 })))).toBeNull();
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, apiKey: null })))).toBeNull();
  });

  test("ein leerer oder abgeschnittener apiKey OHNE Proxy-Bekenntnis → null", () => {
    // Ein vergessenes Feld soll ein sauberes „KI ist aus" ergeben, nicht einen
    // Lauf, der erst beim ersten Modellaufruf mit 401 abbricht — nachdem das
    // Kontingent des Kunden schon gebucht ist.
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, apiKey: "" })))).toBeNull();
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, apiKey: "sk-or-kurz" })))).toBeNull();
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, apiKey: "a".repeat(MIN_API_KEY_LEN - 1) })))).toBeNull();
  });

  test("genau MIN_API_KEY_LEN Zeichen ohne Flag werden geladen — die Grenze liegt bei ≥, nicht >", () => {
    const cfg = loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, apiKey: "a".repeat(MIN_API_KEY_LEN) })));
    expect(cfg).not.toBeNull();
    expect(cfg?.keyFromProxy).toBe(false);
  });

  test("keyFromProxy muss ausdrücklich true sein — „true\" als Text zählt nicht", () => {
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, apiKey: "", keyFromProxy: "true" })))).toBeNull();
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, apiKey: "", keyFromProxy: 1 })))).toBeNull();
  });

  test("ein Verzeichnis statt einer Datei → null, kein Wurf", () => {
    expect(loadKiConfig(makeTmpDir("regoro-ki-"))).toBeNull();
  });
});

describe("betreiber-config.ts — loadKiConfig() liest die Felder", () => {
  test("vollständige Datei → alle Felder, keyFromProxy standardmäßig false", () => {
    expect(loadKiConfig(schreibeRoh(JSON.stringify(GUELTIG)))).toEqual(GELADEN);
  });

  test("fehlender braveKey → null (keine Websuche), nicht undefined", () => {
    const { braveKey: _weg, ...ohneBrave } = GUELTIG;
    const cfg = loadKiConfig(schreibeRoh(JSON.stringify(ohneBrave)));
    expect(cfg?.braveKey).toBeNull();
  });

  test("braveKey mit falschem Typ → null (keine Websuche)", () => {
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, braveKey: 42 })))?.braveKey).toBeNull();
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, braveKey: true })))?.braveKey).toBeNull();
  });

  test("braveKey leer heißt „Schlüssel kommt von außen\", NICHT „keine Websuche\" (§16)", () => {
    // Die drei Zustände jedes Schlüsselfeldes: fehlt/falscher Typ → null
    // (Funktion aus, fail-closed); "" → Funktion an, ein ausgehender Proxy hängt
    // die Anmeldung an; Zeichenkette → Schlüssel steht in der Datei.
    //
    // Diese Zeile stand hier vorher mit `toBeNull()` — und war grün, weil der
    // Lader "" wegnormalisierte. Genau das ist der teure Fall: Die Websuche wäre
    // stumm ausgefallen. Kein Fehler, keine Logzeile, nichts wird rot; es
    // scheitert nicht, es wirkt nur nicht.
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, braveKey: "" })))?.braveKey).toBe("");
  });

  test("fehlender firecrawlKey → null (kein Seitenabruf)", () => {
    // Eigener Schlüssel neben braveKey: Ohne ihn kann der Agent weiter suchen,
    // nur keine gefundene Seite mehr öffnen — statt dass die Recherche ganz ausfällt.
    const { firecrawlKey: _weg, ...ohne } = { ...GUELTIG, firecrawlKey: "fc-x" };
    expect(loadKiConfig(schreibeRoh(JSON.stringify(ohne)))?.firecrawlKey).toBeNull();
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, firecrawlKey: 42 })))?.firecrawlKey).toBeNull();
  });

  test("firecrawlKey leer heißt ebenfalls „Schlüssel kommt von außen\" (§16)", () => {
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, firecrawlKey: "" })))?.firecrawlKey).toBe("");
  });

  test("ein gesetzter firecrawlKey kommt unverändert an", () => {
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, firecrawlKey: "fc-abc123" })))?.firecrawlKey).toBe(
      "fc-abc123",
    );
  });

  test("die drei Zustände sind für beide Schlüssel dieselben — eine Semantik, keine zwei", () => {
    for (const feld of ["braveKey", "firecrawlKey"] as const) {
      expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, [feld]: 99 })))?.[feld]).toBeNull();
      expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, [feld]: "" })))?.[feld]).toBe("");
      expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, [feld]: "echt" })))?.[feld]).toBe("echt");
    }
  });

  test("fehlende oder leere baseUrl/model → die Vorgabewerte", () => {
    expect(loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, baseUrl: "", model: "" })))?.baseUrl).toBe(
      STANDARD_BASE_URL,
    );
    const cfg = loadKiConfig(schreibeRoh(JSON.stringify({ v: 1, apiKey: GUELTIG.apiKey })));
    expect(cfg?.baseUrl).toBe(STANDARD_BASE_URL);
    expect(cfg?.model).toBe(STANDARD_MODELL);
  });

  test("eigene baseUrl/model gewinnen — das Modell ist eine Messfrage, keine Festlegung", () => {
    const cfg = loadKiConfig(
      schreibeRoh(JSON.stringify({ ...GUELTIG, baseUrl: "https://api.cortecs.ai/v1", model: "z-ai/glm-4.6" })),
    );
    expect(cfg?.baseUrl).toBe("https://api.cortecs.ai/v1");
    expect(cfg?.model).toBe("z-ai/glm-4.6");
  });

  test("keyFromProxy:true erlaubt einen leeren apiKey — der Vault-Proxy setzt ihn ein", () => {
    // Auf dieser Maschine hängt ein ausgehender Proxy den echten Schlüssel an.
    // Der Code läuft dann genau wie in Produktion, nur ohne Schlüssel auf Platte.
    // Das Bekenntnis ist ausdrücklich, damit ein VERGESSENES Feld nicht dasselbe
    // bedeutet wie ein absichtlich leeres.
    const cfg = loadKiConfig(schreibeRoh(JSON.stringify({ ...GUELTIG, apiKey: "", keyFromProxy: true })));
    expect(cfg).not.toBeNull();
    expect(cfg?.apiKey).toBe("");
    expect(cfg?.keyFromProxy).toBe(true);
  });
});

describe("betreiber-config.ts — schreibeKiConfig() / entferneKiConfig()", () => {
  let pfad: string;

  beforeEach(() => {
    pfad = join(makeTmpDir("regoro-ki-w-"), "ki.json");
  });

  const cfg: KiConfig = GELADEN;

  test("Schreiben und Lesen ergibt dasselbe zurück", () => {
    schreibeKiConfig(cfg, pfad);
    expect(loadKiConfig(pfad)).toEqual(cfg);
  });

  test("die Datei bekommt 0600 — sie enthält einen Zugang, der alle Kunden bedient", () => {
    schreibeKiConfig(cfg, pfad);
    expect(statSync(pfad).mode & 0o777).toBe(0o600);
  });

  test("fehlendes Verzeichnis wird angelegt", () => {
    const tief = join(makeTmpDir("regoro-ki-w-"), "regoro", "ki.json");
    schreibeKiConfig(cfg, tief);
    expect(existsSync(tief)).toBe(true);
  });

  test("die geschriebene Datei trägt eine Version — sonst ist sie später nicht prüfbar", () => {
    schreibeKiConfig(cfg, pfad);
    expect(JSON.parse(readFileSync(pfad, "utf8")).v).toBe(1);
  });

  test("braveKey null überlebt den Umlauf als null", () => {
    schreibeKiConfig({ ...cfg, braveKey: null }, pfad);
    expect(loadKiConfig(pfad)?.braveKey).toBeNull();
  });

  test("ein leerer Schlüssel überlebt den Umlauf als leer, nicht als null", () => {
    // Sonst schaltete das bloße Neuschreiben der Datei die Funktion ab, die der
    // Betreiber gerade eingerichtet hat.
    schreibeKiConfig({ ...cfg, braveKey: "", firecrawlKey: "" }, pfad);
    const wieder = loadKiConfig(pfad);
    expect(wieder?.braveKey).toBe("");
    expect(wieder?.firecrawlKey).toBe("");
  });

  test("keyFromProxy überlebt den Umlauf — sonst wäre die KI direkt nach dem Einrichten aus", () => {
    // Ohne das zurückgeschriebene Flag legte `regoro ki --key-from-proxy` eine
    // Datei an, die der nächste loadKiConfig wegen apiKey:"" verwirft.
    schreibeKiConfig({ ...cfg, apiKey: "", keyFromProxy: true }, pfad);
    const wieder = loadKiConfig(pfad);
    expect(wieder).not.toBeNull();
    expect(wieder?.keyFromProxy).toBe(true);
  });

  test("entferneKiConfig löscht die Datei — danach ist die KI aus", () => {
    schreibeKiConfig(cfg, pfad);
    entferneKiConfig(pfad);
    expect(existsSync(pfad)).toBe(false);
    expect(loadKiConfig(pfad)).toBeNull();
  });

  test("entferneKiConfig auf eine nicht vorhandene Datei wirft nicht", () => {
    expect(() => entferneKiConfig(join(makeTmpDir("regoro-ki-w-"), "weg.json"))).not.toThrow();
  });

  test("Überschreiben ersetzt den alten Schlüssel vollständig", () => {
    schreibeKiConfig(cfg, pfad);
    schreibeKiConfig({ ...cfg, apiKey: "sk-or-v1-neuneuneuneuneuneuneuneuneu" }, pfad);
    const roh = readFileSync(pfad, "utf8");
    expect(roh).not.toContain(GUELTIG.apiKey);
    expect(loadKiConfig(pfad)?.apiKey).toBe("sk-or-v1-neuneuneuneuneuneuneuneuneu");
  });
});

describe("betreiber-config.ts — kein Test fasst /etc/regoro an", () => {
  test("loadKiConfig ohne Pfad benutzt betreiberConfigPfad(), legt aber nichts an", () => {
    // Reine Leseoperation: Auf dieser Maschine existiert /etc/regoro/ki.json nicht,
    // also null. Der Test hält fest, dass der Aufruf ohne Argument zulässig ist
    // und nicht wirft — nicht, dass /etc/regoro leer ist.
    const vorher = process.env.CREDENTIALS_DIRECTORY;
    process.env.CREDENTIALS_DIRECTORY = join(makeTmpDir("regoro-ki-cred-"));
    try {
      expect(loadKiConfig()).toBeNull();
    } finally {
      if (vorher === undefined) delete process.env.CREDENTIALS_DIRECTORY;
      else process.env.CREDENTIALS_DIRECTORY = vorher;
    }
  });

  test("aus $CREDENTIALS_DIRECTORY wird wirklich gelesen", () => {
    const dir = makeTmpDir("regoro-ki-cred-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ki"), JSON.stringify(GUELTIG));
    const vorher = process.env.CREDENTIALS_DIRECTORY;
    process.env.CREDENTIALS_DIRECTORY = dir;
    try {
      expect(loadKiConfig()?.model).toBe(GUELTIG.model);
    } finally {
      if (vorher === undefined) delete process.env.CREDENTIALS_DIRECTORY;
      else process.env.CREDENTIALS_DIRECTORY = vorher;
    }
  });
});
