#!/bin/sh
# hoopilot installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/openhoo/hoopilot/main/scripts/install.sh | sh
#
# Pin a version or install dir:
#   ... | sh -s -- --version 0.2.5 --dir ~/bin
#   HOOPILOT_INSTALL_DIR=~/bin HOOPILOT_VERSION=0.2.5 ... | sh
set -eu

REPO="openhoo/hoopilot"
BIN="hoopilot"
GITHUB="${GITHUB_BASE_URL:-https://github.com}"
VERSION="${HOOPILOT_VERSION:-latest}"
INSTALL_DIR="${HOOPILOT_INSTALL_DIR:-$HOME/.local/bin}"

err() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
info() { printf '%s\n' "$*"; }

# --- args (passed via `sh -s -- ...`) ---
while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="${2:?--version needs a value}"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="${2:?--dir needs a value}"
      shift 2
      ;;
    -h | --help)
      info "usage: install.sh [--version <v>] [--dir <path>]"
      exit 0
      ;;
    *) err "unknown option: $1" ;;
  esac
done

# --- detect OS ---
os="$(uname -s)"
case "$os" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *) err "unsupported OS: $os (use the npm package: npx @openhoo/hoopilot)" ;;
esac

# --- detect arch ---
arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) arch="x64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *) err "unsupported architecture: $arch" ;;
esac

# --- Apple Silicon under Rosetta reports x86_64; correct it ---
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    arch="arm64"
  fi
fi

# --- libc on Linux: glibc vs musl ---
libc=""
if [ "$os" = "linux" ]; then
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
    libc="-musl"
  fi
fi

asset="${BIN}-${os}-${arch}${libc}"

if [ "$VERSION" = "latest" ]; then
  base="$GITHUB/$REPO/releases/latest/download"
else
  case "$VERSION" in
    v*) tag="$VERSION" ;;
    *) tag="v$VERSION" ;;
  esac
  base="$GITHUB/$REPO/releases/download/$tag"
fi

# --- download helper (curl preferred, wget fallback) ---
download() {
  # download <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    err "need curl or wget to download"
  fi
}

# --- install dir + a staging file on the SAME filesystem (so the final move is
#     an atomic rename, never a partial copy) ---
mkdir -p "$INSTALL_DIR" || err "cannot create $INSTALL_DIR"
[ -w "$INSTALL_DIR" ] ||
  err "$INSTALL_DIR is not writable. Set HOOPILOT_INSTALL_DIR or re-run with sudo."

tmp="$(mktemp -d)"
staging="$INSTALL_DIR/.$BIN.download.$$"
trap 'rm -rf "$tmp"; rm -f "$staging"' EXIT

info "Downloading $asset ($VERSION)..."
download "$base/$asset" "$staging" || err "download failed: $base/$asset"

# --- verify checksum ---
download "$base/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null ||
  err "could not download SHA256SUMS; refusing to install an unverified binary"

expected="$(grep " ${asset}\$" "$tmp/SHA256SUMS" 2>/dev/null | awk '{print $1}' | head -n1)"
[ -n "$expected" ] || err "no checksum for $asset in SHA256SUMS"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$staging" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$staging" | awk '{print $1}')"
else
  err "no sha256sum or shasum found; cannot verify checksum"
fi

if [ "$actual" != "$expected" ]; then
  err "checksum mismatch for $asset (expected $expected, got $actual)"
fi
info "Checksum verified."

# --- install (atomic same-filesystem rename) ---
chmod +x "$staging" || err "cannot make $staging executable"
mv -f "$staging" "$INSTALL_DIR/$BIN" || err "cannot install to $INSTALL_DIR/$BIN"
info "Installed $BIN to $INSTALL_DIR/$BIN"

# --- PATH hint ---
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf 'note: %s is not on your PATH. Add this to your shell profile:\n  export PATH="%s:$PATH"\n' \
      "$INSTALL_DIR" "$INSTALL_DIR" >&2
    ;;
esac

if "$INSTALL_DIR/$BIN" --version >/dev/null 2>&1; then
  info "Run: $BIN --help    (update later with: $BIN update)"
fi
