#!/usr/bin/env bash
#
# Build the static runtime mirror the version dropdown reads.
#
#   scripts/build-mirror.sh [outdir] [tag ...]
#
# Default outdir is ./mirror, default tags are every tag that publishes a
# libdiluvium_wasi.wasm. Upload the result to a static host and point the
# Lab at it. Nothing dynamic is required: no API, no redirects, no auth.
#
# Why this exists at all: GitHub serves release assets from
# release-assets.githubusercontent.com with no Access-Control-Allow-Origin
# header, so a browser cannot read those bytes from another origin however
# public they are. curl has no origin and does not care, which is why this
# script can fetch what the page cannot.
#
# The one thing the host MUST do:
#
#   Access-Control-Allow-Origin: *
#
# on every file below -- index.json, the .wasm and SHA256SUMS.txt alike.
# Without it the Lab sees exactly what it sees from GitHub: nothing.
#
# Layout produced:
#
#   <outdir>/index.json
#   <outdir>/<tag>/libdiluvium_wasi.wasm
#   <outdir>/<tag>/SHA256SUMS.txt
#   <outdir>/<tag>/BUILDINFO.txt      (optional, not read by the Lab)

set -euo pipefail

REPO="Aloecraft-org/diluvium"
ARTIFACT="libdiluvium_wasi.wasm"
OUT="${1:-mirror}"
shift || true

# Tags known to publish the kernel artifact. Add to this list as releases
# appear -- or pass them on the command line.
DEFAULT_TAGS=(v5.4.7_release)
TAGS=("$@")
[ ${#TAGS[@]} -eq 0 ] && TAGS=("${DEFAULT_TAGS[@]}")

say() { printf '  %s\n' "$*"; }

mkdir -p "$OUT"
entries=()

for tag in "${TAGS[@]}"; do
  base="https://github.com/$REPO/releases/download/$tag"
  dest="$OUT/$tag"

  printf '\n== %s\n' "$tag"
  if ! curl -fsSL --retry 3 --head -o /dev/null "$base/$ARTIFACT" 2>/dev/null; then
    say "skip: $tag publishes no $ARTIFACT"
    continue
  fi

  mkdir -p "$dest"
  for f in "$ARTIFACT" SHA256SUMS.txt; do
    say "fetching $f"
    curl -fsSL --retry 3 -o "$dest/$f" "$base/$f"
  done
  curl -fsSL --retry 3 -o "$dest/BUILDINFO.txt" "$base/BUILDINFO.txt" 2>/dev/null \
    || say "no BUILDINFO.txt (fine)"

  expected=$(grep " \*\?$ARTIFACT\$" "$dest/SHA256SUMS.txt" | cut -d' ' -f1)
  actual=$(sha256sum "$dest/$ARTIFACT" | cut -d' ' -f1)
  if [ -z "$expected" ]; then
    echo "error: $tag/SHA256SUMS.txt does not list $ARTIFACT" >&2
    exit 1
  fi
  if [ "$expected" != "$actual" ]; then
    echo "error: $tag checksum mismatch" >&2
    echo "  expected $expected" >&2
    echo "  actual   $actual" >&2
    exit 1
  fi
  say "verified $actual"

  version=$(sed -n 's/^version *: *//p' "$dest/BUILDINFO.txt" 2>/dev/null | head -1)
  [ -z "$version" ] && version="${tag#v}"
  published=$(sed -n 's/^built *: *//p' "$dest/BUILDINFO.txt" 2>/dev/null | head -1)

  entries+=("$(printf '{"tag":"%s","version":"%s","published":"%s"}' "$tag" "$version" "$published")")
done

if [ ${#entries[@]} -eq 0 ]; then
  echo "error: nothing to mirror" >&2
  exit 1
fi

{
  printf '{\n  "schema": 1,\n  "releases": [\n'
  for i in "${!entries[@]}"; do
    printf '    %s' "${entries[$i]}"
    [ "$i" -lt $((${#entries[@]} - 1)) ] && printf ','
    printf '\n'
  done
  printf '  ]\n}\n'
} > "$OUT/index.json"

printf '\n== Done\n'
say "wrote $OUT/index.json with ${#entries[@]} release(s)"
say ""
say "Upload $OUT/ so that index.json sits at the URL you give the Lab, e.g."
say "  https://diluvium.aloecraft.org/releases/index.json"
say ""
say "Then serve every file under it with:  Access-Control-Allow-Origin: *"
say "Check it with:"
say "  curl -sI -H 'Origin: https://example.org' <url>/index.json | grep -i access-control"
