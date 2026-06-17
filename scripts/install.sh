#!/bin/sh
# hoopilot installer for Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/openhoo/hoopilot/main/scripts/install.sh | sh
#
# Pin a version or install dir:
#   ... | sh -s -- --version <version> --dir ~/bin
#   HOOPILOT_INSTALL_DIR=~/bin HOOPILOT_VERSION=<version> ... | sh
set -eu

REPO="openhoo/hoopilot"
BIN="hoopilot"
CODEXX_BIN="codexx"
GITHUB="${GITHUB_BASE_URL:-https://github.com}"
VERSION="${HOOPILOT_VERSION:-latest}"
INSTALL_DIR="${HOOPILOT_INSTALL_DIR:-$HOME/.local/bin}"
CHECKSUM_ATTEMPTS="${HOOPILOT_CHECKSUM_ATTEMPTS:-12}"
CHECKSUM_RETRY_SECONDS="${HOOPILOT_CHECKSUM_RETRY_SECONDS:-5}"

err() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
info() { printf '%s\n' "$*"; }

install_codexx_wrapper() {
  wrapper="$INSTALL_DIR/$CODEXX_BIN"
  cat >"$wrapper" <<'EOF'
#!/bin/sh
set -eu
script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec "$script_dir/hoopilot" codexx "$@"
EOF
  chmod +x "$wrapper" || err "cannot make $wrapper executable"
  info "Installed $CODEXX_BIN to $wrapper"
}

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
expected=""
checksum_error="could not download SHA256SUMS; refusing to install an unverified binary"
attempt=1
while [ "$attempt" -le "$CHECKSUM_ATTEMPTS" ]; do
  if download "$base/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
    expected="$(
      awk -v asset="$asset" '
        {
          name = $2
          sub(/^\*/, "", name)
          if (name == asset) {
            print $1
            exit
          }
        }
      ' "$tmp/SHA256SUMS"
    )"
    if [ -n "$expected" ]; then
      break
    fi
    checksum_error="no checksum for $asset in SHA256SUMS"
  fi

  if [ "$attempt" -lt "$CHECKSUM_ATTEMPTS" ]; then
    info "Checksum is not ready yet; retrying in ${CHECKSUM_RETRY_SECONDS}s..."
    sleep "$CHECKSUM_RETRY_SECONDS"
  fi
  attempt=$((attempt + 1))
done
[ -n "$expected" ] || err "$checksum_error"

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
install_codexx_wrapper

# --- PATH hint ---
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf 'note: %s is not on your PATH. Add this to your shell profile:\n  export PATH="%s:$PATH"\n' \
      "$INSTALL_DIR" "$INSTALL_DIR" >&2
    ;;
esac

if "$INSTALL_DIR/$BIN" --version >/dev/null 2>&1; then
  info "Run: $BIN --help or $CODEXX_BIN --help    (update later with: $BIN update)"
fi
