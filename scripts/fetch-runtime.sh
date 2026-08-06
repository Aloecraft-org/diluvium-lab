#!/usr/bin/env bash
#
# Pin a Diluvium runtime into vendor/.
#
#   scripts/fetch-runtime.sh [tag]        default: v5.4.7_release
#
# Downloads the kernel module plus the release's checksum and build
# manifest, and verifies the module against the former. This is the
# Stage 2 mechanism in miniature -- when the version dropdown arrives it
# does the same three steps in the browser.

set -euo pipefail

TAG="${1:-v5.4.7_release}"
BASE="https://github.com/Aloecraft-org/diluvium/releases/download/$TAG"
DEST="$(cd "$(dirname "$0")/.." && pwd)/vendor"

mkdir -p "$DEST"

for f in libdiluvium_wasi.wasm SHA256SUMS.txt BUILDINFO.txt; do
  echo "fetching $f ..."
  curl -fsSL --retry 3 -o "$DEST/$f" "$BASE/$f"
done

expected=$(grep ' libdiluvium_wasi\.wasm$' "$DEST/SHA256SUMS.txt" | cut -d' ' -f1)
actual=$(sha256sum "$DEST/libdiluvium_wasi.wasm" | cut -d' ' -f1)

if [ -z "$expected" ]; then
  echo "error: libdiluvium_wasi.wasm not listed in SHA256SUMS.txt" >&2
  exit 1
fi
if [ "$expected" != "$actual" ]; then
  echo "error: checksum mismatch" >&2
  echo "  expected $expected" >&2
  echo "  actual   $actual" >&2
  exit 1
fi

printf '%s\n' "$TAG" > "$DEST/PINNED_TAG"
echo "ok: $TAG pinned, sha256 $actual"
