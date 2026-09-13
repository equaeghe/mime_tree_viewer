#!/usr/bin/env bash
# Packages src/ into a Thunderbird-installable .xpi under dist/.
#
# Usage:
#   ./build.sh
#
# Requires: bash, zip (both present by default on Linux/macOS; on Windows,
# run this from WSL or Git Bash with zip installed).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
DIST_DIR="$SCRIPT_DIR/dist"
NAME="mime-tree-viewer"

if [[ ! -f "$SRC_DIR/manifest.json" ]]; then
  echo "error: $SRC_DIR/manifest.json not found" >&2
  exit 1
fi

VERSION=$(
  grep -m1 '"version"' "$SRC_DIR/manifest.json" \
    | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
)

if [[ -z "$VERSION" ]]; then
  echo "error: could not read \"version\" from $SRC_DIR/manifest.json" >&2
  exit 1
fi

OUT="$DIST_DIR/${NAME}-${VERSION}.xpi"

mkdir -p "$DIST_DIR"
rm -f "$OUT"

# An .xpi is just a zip with manifest.json at its root (not nested in a
# subfolder), so we cd into src/ before zipping.
( cd "$SRC_DIR" && zip -r -X -q "$OUT" . -x '.*' )

echo "Built $OUT"
