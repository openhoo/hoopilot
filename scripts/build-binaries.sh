#!/usr/bin/env bash
# Cross-compile standalone hoopilot binaries for every supported platform and
# write a SHA256SUMS manifest. All targets cross-compile from a single Linux
# host. Usage: scripts/build-binaries.sh [version] [out-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(bun --print 'require("./package.json").version')}"
OUT="${2:-dist/bin}"
ENTRY="src/cli.ts"

# asset-suffix : bun --target
TARGETS="
linux-x64:bun-linux-x64
linux-arm64:bun-linux-arm64
linux-x64-musl:bun-linux-x64-musl
linux-arm64-musl:bun-linux-arm64-musl
darwin-x64:bun-darwin-x64
darwin-arm64:bun-darwin-arm64
# Keep the public asset name "windows-x64", but embed Bun's baseline x64
# runtime so older CPUs and VMs without AVX2 do not crash at startup.
windows-x64:bun-windows-x64-baseline
windows-arm64:bun-windows-arm64
"

rm -rf "$OUT"
mkdir -p "$OUT"

echo "Building hoopilot $VERSION binaries -> $OUT"
for entry in $TARGETS; do
  suffix="${entry%%:*}"
  target="${entry##*:}"
  name="hoopilot-${suffix}"
  case "$suffix" in
    windows-*) name="${name}.exe" ;;
  esac
  echo "  - $name ($target)"
  bun build "$ENTRY" \
    --compile \
    --target="$target" \
    --define "HOOPILOT_VERSION=\"${VERSION}\"" \
    --define "HOOPILOT_TARGET=\"${suffix}\"" \
    --outfile "$OUT/$name"
done

echo "Writing SHA256SUMS"
(
  cd "$OUT"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum hoopilot-* >SHA256SUMS
  else
    shasum -a 256 hoopilot-* >SHA256SUMS
  fi
)

echo "Done:"
ls -la "$OUT"
