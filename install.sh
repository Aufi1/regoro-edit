#!/usr/bin/env sh
#
# regoro — Installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Aufi1/regoro-edit/main/install.sh | sh
#
# Lädt das passende Standalone-Binary aus dem GitHub-Release, prüft die
# SHA256-Summe und legt es nach ~/.local/bin/regoro. Bun wird NICHT benötigt
# (die Runtime steckt im Binary), `git` schon — die Versionierung ruft es auf.
#
# Steuerung über Umgebungsvariablen:
#   REGORO_VERSION      Tag statt "latest", z.B. v0.2.0
#   REGORO_INSTALL_DIR  Zielverzeichnis (default ~/.local/bin)
#   REGORO_BASE_URL     Basis-URL der Assets (für Tests/Mirror)
#
# POSIX sh, keine bashisms — läuft auch mit dash/busybox.

set -eu

REPO="Aufi1/regoro-edit"
VERSION="${REGORO_VERSION:-latest}"
INSTALL_DIR="${REGORO_INSTALL_DIR:-$HOME/.local/bin}"

if [ -n "${REGORO_BASE_URL:-}" ]; then
    BASE_URL="$REGORO_BASE_URL"
elif [ "$VERSION" = "latest" ]; then
    BASE_URL="https://github.com/$REPO/releases/latest/download"
else
    BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
fi

info() { printf '%s\n' "$*"; }
err() { printf 'Fehler: %s\n' "$*" >&2; }
# Zusatzzeilen zu einem Fehler — ohne "Fehler:"-Präfix, damit ein vorgeschlagener
# Befehl nicht wie eine Fehlermeldung aussieht (und copy-paste-bar bleibt).
note() { printf '%s\n' "$*" >&2; }

die() {
    err "$*"
    exit 1
}

# --- Vorbedingungen -------------------------------------------------------
# git ist eine ECHTE Laufzeit-Abhängigkeit: jede Speicherung im Editor ist ein
# git-Commit im Site-Ordner. Lieber hier scheitern als später beim ersten Save.
#
# Wir installieren git NICHT selbst: das bräuchte root und eine Paketmanager-
# Erkennung, und ein per `curl | sh` gestartetes Skript, das im Hintergrund
# `sudo apt-get install` aufruft, ist genau die Sorte Skript, vor der zu Recht
# gewarnt wird. Wir schlagen den Befehl nur vor — ausführen tust du ihn.
git_install_hint() {
    if command -v apt-get >/dev/null 2>&1; then
        echo "sudo apt-get install git"
    elif command -v dnf >/dev/null 2>&1; then
        echo "sudo dnf install git"
    elif command -v yum >/dev/null 2>&1; then
        echo "sudo yum install git"
    elif command -v pacman >/dev/null 2>&1; then
        echo "sudo pacman -S git"
    elif command -v zypper >/dev/null 2>&1; then
        echo "sudo zypper install git"
    elif command -v apk >/dev/null 2>&1; then
        echo "sudo apk add git"
    elif command -v brew >/dev/null 2>&1; then
        echo "brew install git"
    elif [ "$(uname -s)" = "Darwin" ]; then
        # Ohne Homebrew liefern die Command Line Tools git mit.
        echo "xcode-select --install"
    else
        echo "(Paketmanager nicht erkannt — git über die Paketquellen deiner Distribution installieren)"
    fi
}

if ! command -v git >/dev/null 2>&1; then
    err "git wird benötigt, ist aber nicht installiert."
    note ""
    note "regoro versioniert jede Speicherung als git-Commit im Site-Ordner."
    note "Installieren mit:"
    note ""
    note "  $(git_install_hint)"
    note ""
    note "Danach diesen Installer erneut ausführen."
    exit 1
fi

if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -qO "$2" "$1"; }
else
    die "weder curl noch wget gefunden."
fi

# --- Plattform bestimmen --------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
    Linux) os_tag="linux" ;;
    Darwin) os_tag="darwin" ;;
    *) die "nicht unterstütztes Betriebssystem: $os (unterstützt: Linux, macOS)" ;;
esac

case "$arch" in
    x86_64 | amd64) arch_tag="x64" ;;
    aarch64 | arm64) arch_tag="arm64" ;;
    *) die "nicht unterstützte Architektur: $arch (unterstützt: x86_64, arm64)" ;;
esac

asset="regoro-${os_tag}-${arch_tag}"

# --- Herunterladen --------------------------------------------------------
tmp="$(mktemp -d)"
# shellcheck disable=SC2064  # $tmp jetzt expandieren, nicht beim Trap
trap "rm -rf '$tmp'" EXIT INT TERM

info "Lade $asset ($VERSION) …"
fetch "$BASE_URL/$asset" "$tmp/regoro" || die "Download fehlgeschlagen: $BASE_URL/$asset"

# --- Integrität prüfen ----------------------------------------------------
# Ein per curl|sh ausgeführter Installer, der ein 90-MB-Binary ungeprüft
# ausführbar ablegt, ist ein lohnendes Ziel. SHA256SUMS liegt im selben Release.
if fetch "$BASE_URL/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
    expected="$(awk -v a="$asset" '$2 == a || $2 == "*" a {print $1}' "$tmp/SHA256SUMS")"
    [ -n "$expected" ] || die "kein SHA256-Eintrag für $asset in SHA256SUMS."

    if command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$tmp/regoro" | cut -d' ' -f1)"
    elif command -v shasum >/dev/null 2>&1; then
        actual="$(shasum -a 256 "$tmp/regoro" | cut -d' ' -f1)"
    else
        die "weder sha256sum noch shasum gefunden — Prüfsumme nicht verifizierbar."
    fi

    [ "$actual" = "$expected" ] || die "Prüfsumme stimmt nicht!
  erwartet: $expected
  bekommen: $actual
Abbruch — Binary NICHT installiert."
    info "Prüfsumme ok."
else
    die "SHA256SUMS nicht abrufbar — Abbruch (keine ungeprüften Binaries)."
fi

# --- Installieren ---------------------------------------------------------
mkdir -p "$INSTALL_DIR"
chmod 755 "$tmp/regoro"
# mv über Dateisystemgrenzen hinweg kann scheitern → cp + rm.
cp "$tmp/regoro" "$INSTALL_DIR/regoro.new"
chmod 755 "$INSTALL_DIR/regoro.new"
# Atomar ersetzen: ein laufender regoro-Prozess behält sein altes Inode.
mv -f "$INSTALL_DIR/regoro.new" "$INSTALL_DIR/regoro"

# --- Verifizieren ---------------------------------------------------------
installed_version="$("$INSTALL_DIR/regoro" --version 2>/dev/null)" ||
    die "installiertes Binary lässt sich nicht ausführen ($INSTALL_DIR/regoro)."

info ""
info "regoro $installed_version installiert nach $INSTALL_DIR/regoro"

# --- PATH-Hinweis ---------------------------------------------------------
case ":${PATH}:" in
    *":$INSTALL_DIR:"*)
        info ""
        info "Loslegen:"
        info "  cd /pfad/zu/deiner/site"
        info "  regoro init      # Passwort setzen"
        info "  regoro run       # Editor starten"
        ;;
    *)
        info ""
        info "ACHTUNG: $INSTALL_DIR liegt nicht in deinem PATH."
        info "Ergänze in ~/.bashrc (bzw. ~/.zshrc):"
        info ""
        info "  export PATH=\"$INSTALL_DIR:\$PATH\""
        info ""
        info "Danach: cd <site> && regoro init"
        ;;
esac
