/**
 * `pathInsideSite` — die Symlink-sichere Containment-Prüfung vor JEDEM Write.
 *
 * Eigene Datei, weil das Verhalten unabhängig vom Editor gilt: Sobald ein
 * Agentenlauf Dateien in die Live-Site übernimmt, ist diese Funktion der
 * einzige Riegel zwischen „der Agent hat eine Datei erzeugt" und „die Datei
 * landet irgendwo auf dem Server". Sie wird deshalb hier direkt geprüft und
 * nicht nur über die HTTP-Routen mitgenommen.
 *
 * Der zentrale Fall ist der HÄNGENDE Symlink (Ziel existiert noch nicht):
 * `existsSync` folgt dem Symlink, ein hängender gilt damit als „gibt es nicht",
 * und die Prüfung fiel auf den Zweig für neue Dateien zurück — realpath des
 * Elternverzeichnisses plus Basename. Das liegt innerhalb der Site, also sagte
 * sie `true`. Der folgende `writeFileSync` folgte dann dem Symlink nach
 * draußen und legte die Datei dort an. „Neue Datei" ist genau das, was ein
 * Agentenlauf produziert.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  cpSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Auth-Env VOR den dynamischen Host-Importen ----------------------------
const TEST_SECRET = "testsecret-aaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_NUMMER = "+4915120464812";
const TEST_AUTH = { nummern: [TEST_NUMMER], emails: [], secret: TEST_SECRET };

const REPO_ROOT = join(import.meta.dir, "..");
import { entwurfPfad, stelleEntwurfBereit } from "./entwurf.ts";
import { schwebendPfad } from "./arbeitskopie.ts";

const REAL_SITE = join(REPO_ROOT, "examples", "site");

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

describe("apply.ts — pathInsideSite", () => {
  let apply: typeof import("./apply.ts");
  let siteDir: string;
  let aussen: string;

  beforeAll(async () => {
    apply = await import("./apply.ts");
  });

  beforeEach(() => {
    siteDir = makeTmpDir("regoro-site-");
    aussen = makeTmpDir("regoro-aussen-");
    writeFileSync(join(siteDir, "index.html"), "<html><body><p>drin</p></body></html>");
  });

  test("normale Datei innerhalb der Site → true", () => {
    expect(apply.pathInsideSite(siteDir, join(siteDir, "index.html"))).toBe(true);
  });

  test("noch nicht existierende Datei innerhalb der Site → true (der legitime Fall)", () => {
    // Das ist der Normalfall eines Agentenlaufs: eine neue Unterseite. Er darf
    // NICHT abgelehnt werden, sonst kann der Agent nichts anlegen.
    expect(apply.pathInsideSite(siteDir, join(siteDir, "leistungen.html"))).toBe(true);
  });

  test("Pfad außerhalb der Site → false", () => {
    expect(apply.pathInsideSite(siteDir, join(aussen, "beute.html"))).toBe(false);
  });

  test("Symlink auf eine EXISTIERENDE Datei außerhalb → false", () => {
    const ziel = join(aussen, "geheim.html");
    writeFileSync(ziel, "GEHEIM");
    const link = join(siteDir, "verlinkt.html");
    symlinkSync(ziel, link);
    expect(apply.pathInsideSite(siteDir, link)).toBe(false);
  });

  test("HÄNGENDER Symlink nach außen → false (der Fehler)", () => {
    // Zielt nach draußen auf etwas, das es noch NICHT gibt. `existsSync` folgt
    // dem Symlink und meldet false — die alte Fassung hielt das für „neue Datei
    // innerhalb der Site" und gab true zurück. Ein Write hätte die Datei
    // draußen angelegt.
    const link = join(siteDir, "neu.html");
    symlinkSync(join(aussen, "gibtsnochnicht.html"), link);
    expect(apply.pathInsideSite(siteDir, link)).toBe(false);
  });

  test("hängender Symlink INNERHALB der Site → ebenfalls false", () => {
    // Auch wenn das Ziel innen läge: Durch einen Symlink wird nie geschrieben.
    // Die Prüfung „wohin zeigt er gerade" wäre ein Rennen — zwischen Prüfung
    // und Write kann er umgehängt werden. Deshalb: kein Symlink, Punkt.
    const link = join(siteDir, "auch-neu.html");
    symlinkSync(join(siteDir, "gibtsnochnicht.html"), link);
    expect(apply.pathInsideSite(siteDir, link)).toBe(false);
  });

  test("Symlink im ELTERNsegment nach außen → false (bestehendes Verhalten)", () => {
    const assets = join(siteDir, "assets");
    symlinkSync(aussen, assets, "dir");
    expect(apply.pathInsideSite(siteDir, join(assets, "bild.webp"))).toBe(false);
  });

  test("siteDir selbst → true, Elternverzeichnis → false", () => {
    expect(apply.pathInsideSite(siteDir, siteDir)).toBe(true);
    expect(apply.pathInsideSite(siteDir, join(siteDir, ".."))).toBe(false);
  });

  test("unauflösbares Elternverzeichnis → false (fail-closed)", () => {
    expect(apply.pathInsideSite(siteDir, join(siteDir, "gibt", "es", "nicht.html"))).toBe(false);
  });
});

describe("host.ts — der hängende Symlink schreibt nicht nach draußen", () => {
  let host: typeof import("./host.ts");
  let git: typeof import("./git.ts");
  let ctx: import("./host.ts").HostCtx;
  let versand: import("./versand.ts").Attrappe;
  let aussen: string;

  beforeAll(async () => {
    git = await import("./git.ts");
    host = await import("./host.ts");
  });

  beforeEach(async () => {
    const repoRoot = makeTmpDir("regoro-fixture-");
    const siteDir = repoRoot;
    cpSync(REAL_SITE, siteDir, { recursive: true });
    // Kein Repo IM Site-Ordner: die Historie wohnt im Entwurfs-Repo (C1), und
    // ein `<siteDir>/.git` wäre der Zustand, den `istNichtMigriert()`
    // fail-closed abschaltet.
    stelleEntwurfBereit(siteDir);
    aussen = makeTmpDir("regoro-aussen-");
    versand = (await import("./versand.ts")).attrappenVersand();
    ctx = {
      repoRoot: entwurfPfad(siteDir),
      entwurfDir: entwurfPfad(siteDir),
      schwebendDir: schwebendPfad(siteDir),
      siteDir,
      basis: "",
      staging: false,
      sitePrefix: "",
      pageWhitelist: ["index.html", "impressum.html", "datenschutz.html", "agb.html"],
      auth: TEST_AUTH,
      versand,
    };
  });

  function call(method: string, path: string, init?: RequestInit): Promise<Response> {
    const url = new URL("http://localhost:8788" + path);
    return Promise.resolve(host.handleEditorRequest(new Request(url, { method, ...init }), url, ctx));
  }

  async function login(): Promise<string> {
    const feld = (extra = "") => `kennung=${encodeURIComponent(TEST_NUMMER)}&weg=sms${extra}`;
    const kopf = { "content-type": "application/x-www-form-urlencoded" };
    await call("POST", "/edit/login", { headers: kopf, body: feld() });
    const code = versand.gesendet.at(-1)?.code;
    if (!code) throw new Error("kein Code verschickt");
    const res = await call("POST", "/edit/login", { headers: kopf, body: feld(`&code=${code}`) });
    const sc = res.headers.get("set-cookie");
    if (!sc) throw new Error(`Login lieferte kein Cookie (Status ${res.status})`);
    return sc.split(";")[0]!;
  }

  function pngBytes(): Uint8Array {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return new Uint8Array([...sig, ...new Array(64).fill(0x00)]);
  }

  test("Upload auf einen vorbereiteten hängenden Symlink → 400, nichts landet draußen", async () => {
    const cookie = await login();
    const bytes = pngBytes();

    // Der Dateiname des Uploads ist aus dem INHALT abgeleitet und damit
    // vorhersagbar: Wer die Bytes kennt, kennt den Zielpfad und kann ihn vorab
    // als Symlink nach draußen anlegen. Genau das tut dieser Test.
    const sha8 = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
    // GESCHRIEBEN WIRD IN DEN ENTWURF, nicht in den Site-Ordner (C1). Ein
    // Symlink im Site-Ordner wäre nach dem Umbau wirkungslos — der Test hätte
    // dann bestanden, ohne den Riegel je berührt zu haben.
    const assets = join(ctx.entwurfDir, "assets");
    mkdirSync(assets, { recursive: true });
    const beute = join(aussen, "beute.png");
    symlinkSync(beute, join(assets, `upload-${sha8}.png`));

    const fd = new FormData();
    fd.set("pagePath", "index.html");
    fd.set("imgIdx", "0");
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    fd.set("image", new Blob([ab], { type: "image/png" }), "f.png");

    const url = new URL("http://localhost:8788/edit/upload");
    const res = await host.handleEditorRequest(
      new Request(url, { method: "POST", headers: { cookie }, body: fd }),
      url,
      ctx,
    );

    expect(res.status).toBe(400);
    // Der eigentliche Beweis: draußen ist nichts entstanden.
    expect(existsSync(beute)).toBe(false);
    expect(readdirSync(aussen).length).toBe(0);
  });

  test("Upload ohne Symlink → 200 (Gegenprobe: der Riegel sperrt nicht den Normalfall)", async () => {
    const cookie = await login();
    const fd = new FormData();
    fd.set("pagePath", "index.html");
    fd.set("imgIdx", "0");
    const bytes = pngBytes();
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    fd.set("image", new Blob([ab], { type: "image/png" }), "f.png");

    const url = new URL("http://localhost:8788/edit/upload");
    const res = await host.handleEditorRequest(
      new Request(url, { method: "POST", headers: { cookie }, body: fd }),
      url,
      ctx,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; src: string };
    expect(json.ok).toBe(true);

    /**
     * ZWEI ORTE, EINE DATEI (C1/C11): Geschrieben wird in den Entwurf, aber die
     * zurückgegebene Adresse zeigt in die ENTWURFS-SICHT (`/edit-vorschau/…`) —
     * sonst zeigte der Editor das frisch hochgeladene Bild erst nach dem
     * Veröffentlichen an, also genau dann nicht, wenn man es ansehen will.
     */
    expect(json.src.startsWith("/edit-vorschau/assets/")).toBe(true);
    const relativZumEntwurf = json.src.replace(/^\/edit-vorschau\//, "");
    expect(readFileSync(join(ctx.entwurfDir, relativZumEntwurf))).toHaveLength(72);
    // Und im ausgelieferten Site-Ordner ist es NICHT gelandet.
    expect(existsSync(join(ctx.siteDir, relativZumEntwurf))).toBe(false);
  });
});
