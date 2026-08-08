#!/usr/bin/env bash
#
# Pin a Diluvium runtime into vendor/.
#
#   scripts/fetch-runtime.sh [tag]        default: v5.5.1_build1
#
# Downloads the kernel module plus the release's checksum and build
# manifest, and verifies the module against the former. This is the
# Stage 2 mechanism in miniature -- the version dropdown does the same
# three steps in the browser.
#
# Pulls from the mirror rather than from GitHub, because the mirror is
# where the artifacts reliably are: of the tags that exist upstream, only
# v5.4.7_release attaches libdiluvium_wasi.wasm to its GitHub release, and
# v5.5.1_build1 -- the one you most likely want -- does not. Set
# DILUVIUM_RELEASE_BASE to point somewhere else.

set -euo pipefail

TAG="${1:-v5.5.1_build1}"
MIRROR="${DILUVIUM_RELEASE_BASE:-https://diluvium.aloecraft.org/release}"
BASE="$MIRROR/$TAG"
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
