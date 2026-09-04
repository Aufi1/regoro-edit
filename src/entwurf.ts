/**
 * Das Entwurfs-Repo — wo die Arbeit des Kunden wirklich liegt (Contract C4).
 *
 * `<siteDir>/.regoro/entwurf/` ist ein vollwertiges git-Repo, dessen Arbeitsbaum
 * die ganze Website ist. Beide Editoren — der manuelle und der KI-gestützte —
 * schreiben hierhin, nicht mehr in den Site-Ordner. Der Site-Ordner ist seither
 * ein reiner Abzug (siehe `veroeffentlichen.ts`) und trägt **kein** `.git` mehr.
 *
 * WARUM UNTER `.regoro/` UND NICHT UNTER `runtimeWurzel()`. Das Entwurfs-Repo
 * muss so haltbar sein wie die Website selbst: Eine gespeicherte, noch nicht
 * veröffentlichte Änderung soll einen Neustart und mehrere Tage überstehen. Die
 * Arbeitskopie des Agenten darf genau das nicht — sie ist Wegwerfware und liegt
 * weiter unter `runtimeWurzel()`.
 *
 * DER AGENT SIEHT DIESES REPO NIE. Die Sandbox hat genau einen beschreibbaren
 * Pfad (die Arbeitskopie); hier hineinzuschreiben wäre ein zweiter, direkt neben
 * `auth.json`. Der Elternprozess trägt geprüfte Ergebnisse herüber — dieselbe
 * Aufteilung wie beim Gesprächsverlauf (`verlauf.ts`), und sauberer als vorher:
 * Früher lag das Repo im Site-Ordner, den der Agent kopiert bekam.
 *
 * Der Ordner liegt hinter der Dotfile-Sperre (Invariante 3) und ist über
 * `.regoro/` in `.gitignore` erfasst — er wird nie ausgeliefert.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { byteHashDatei, siteDateien } from "./arbeitskopie.ts";
import { ensureRepo, git } from "./git.ts";
import { hatPunktSegment, schreibeStand } from "./veroeffentlichen.ts";

/** `<siteDir>/.regoro/entwurf` — der Arbeitsbaum des Entwurfs-Repos. */
export function entwurfPfad(siteDir: string): string {
  return join(siteDir, ".regoro", "entwurf");
}

/**
 * Gibt es das Entwurfs-Repo?
 *
 * Gefragt wird nach `.git`, nicht nach dem Ordner: Ein angelegter, aber nicht
 * initialisierter Ordner ist ein halber Zustand (abgebrochenes `init`, volle
 * Platte), und den soll `stelleEntwurfBereit` zu Ende bringen dürfen, statt ihn
 * für fertig zu halten.
 */
export function entwurfVorhanden(siteDir: string): boolean {
  return existsSync(join(entwurfPfad(siteDir), ".git"));
}

/**
 * Liegt im Site-Ordner noch ein Repo aus der Zeit vor diesem Umbau?
 *
 * Reine Frage nach `<siteDir>/.git`. Sie allein ist **kein** Grund abzuschalten
 * — dafür ist `istNichtMigriert()` da.
 */
export function pruefeAltRepo(siteDir: string): boolean {
  return existsSync(join(siteDir, ".git"));
}

/**
 * Der Zustand, auf den fail-closed abgeschaltet werden muss: ein altes Repo im
 * Site-Ordner, aber noch kein Entwurfs-Repo.
 *
 * Es gibt keine Bestandsseiten und deshalb keine Migration. Taucht trotzdem eine
 * auf, darf der Editor auf keinen Fall danebenschreiben: Er würde in einen
 * Site-Ordner schreiben, dessen Historie er nicht führt, und die Änderungen
 * wären in keinem der beiden Repos vollständig.
 *
 * `pruefeAltRepo()` allein taugt dafür nicht — nach einer Migration bliebe
 * `<siteDir>/.git` womöglich stehen, und der Editor bliebe für immer aus.
 */
export function istNichtMigriert(siteDir: string): boolean {
  return pruefeAltRepo(siteDir) && !entwurfVorhanden(siteDir);
}

/**
 * Legt das Entwurfs-Repo an, falls es fehlt. Idempotent.
 *
 * REIHENFOLGE: erst die Website hineinkopieren, dann `ensureRepo`. Der
 * Baseline-Commit entsteht damit auf dem fertig ausgerollten Stand — es gibt
 * nichts zusammenzuführen, und „Entwurf verwerfen" führt von Anfang an auf einen
 * sinnvollen Stand zurück. Dieselbe Überlegung wie bei `cmdInit`, wo der
 * Baseline-Commit vor `auth.json` entsteht.
 *
 * Kopiert wird über `siteDateien()` — dieselbe Quelle, aus der die Arbeitskopie
 * des Agenten und das Veröffentlichen ihre Dateimenge nehmen. Zwei Definitionen
 * von „was gehört zur Website" ließen die erste Veröffentlichung wie eine
 * Massenänderung aussehen.
 *
 * ES WIRD NICHT GEPRÜFT, ob eine alte, nicht migrierte Site vorliegt. Dieses
 * Urteil gehört zum Aufrufer (`istNichtMigriert()`, Contract C4): Sobald das
 * Entwurfs-Repo existiert, ist die Frage ohnehin beantwortet, und ein Wurf an
 * dieser Stelle träfe genau den Aufruf, der den Zustand beheben soll.
 */
export function stelleEntwurfBereit(siteDir: string): void {
  if (entwurfVorhanden(siteDir)) return;

  const ziel = entwurfPfad(siteDir);
  mkdirSync(ziel, { recursive: true, mode: 0o700 });

  const stand: Record<string, string> = {};
  for (const rel of siteDateien(siteDir)) {
    // Punkt-Segmente kommen aus `siteDateien` gar nicht erst zurück; der Filter
    // steht hier, weil ein `.regoro/` im Entwurfs-Arbeitsbaum ein Repo im Repo
    // wäre — und weil diese Schleife die Aufzeichnung mitschreibt, aus der
    // später die Fremdänderungs-Prüfung urteilt.
    if (hatPunktSegment(rel)) continue;
    const quelle = join(siteDir, rel);
    const kopie = join(ziel, rel);
    mkdirSync(dirname(kopie), { recursive: true });
    copyFileSync(quelle, kopie);
    try {
      stand[rel] = byteHashDatei(quelle);
    } catch {
      // Unlesbar: dann eben nicht aufgezeichnet. Die Datei gilt beim nächsten
      // Veröffentlichen als fremd — richtig, denn wir wissen nichts über sie.
    }
  }

  ensureRepo(ziel);

  // Die Eigentums-Übergabe festhalten: Ab jetzt gehört die Website dem
  // Entwurfs-Repo. Ohne diese Aufzeichnung bliebe ein Neubau der Fabrik
  // unbemerkt, und die erste Veröffentlichung überschriebe ihn wortlos — die
  // Notbremse hätte nichts, wogegen sie vergleichen könnte.
  let commit = "";
  try {
    commit = git(ziel, "rev-parse", "HEAD").trim();
  } catch {
    // Ohne Commit-Angabe fällt der Bezugspunkt für „unveröffentlicht" auf den
    // Wurzel-Commit zurück; die Prüfsummen wirken unabhängig davon.
  }
  schreibeStand(siteDir, stand, commit);
}
