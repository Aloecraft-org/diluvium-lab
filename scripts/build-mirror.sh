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
# on every file below -- releases.json, the .wasm and SHA256SUMS.txt alike.
# Without it the Lab sees exactly what it sees from GitHub: nothing.
#
# Layout produced:
#
#   <outdir>/releases.json
#   <outdir>/<tag>/libdiluvium_wasi.wasm
#   <outdir>/<tag>/SHA256SUMS.txt
#   <outdir>/<tag>/BUILDINFO.txt      (a checksum fallback)
#
# The index is named releases.json to match what the publishing job on
# diluvium.aloecraft.org already writes. The Lab still accepts index.json
# as an alias, which is what this script used to emit.

set -euo pipefail

REPO="Aloecraft-org/diluvium"
ARTIFACT="libdiluvium_wasi.wasm"
OUT="${1:-mirror}"
shift || true

# Tags known to publish the kernel artifact.
#
# This used to be the whole input, and that was the bug: the list said
# "add to this list as releases appear", nobody did, and the script went on
# reporting success while quietly mirroring two releases out of four. A
# mirror that is silently a subset is worse than one that fails, because
# the dropdown looks complete.
#
# So it is now a *floor* rather than the list. Tags are discovered, the
# discovered set is unioned with this one, and every candidate still has to
# prove it publishes the artifact before it is mirrored -- which is the
# check that was always doing the real work.
KNOWN_TAGS=(v5.4.7_release v5.5.1_build1)

say() { printf '  %s\n' "$*"; }

# Every tag in the repository, newest-agnostic: ordering does not matter
# because the Lab sorts the dropdown itself.
#
# `git ls-remote` rather than the releases API: no auth, no rate limit, and
# no JSON to parse in shell. It over-reports -- most tags publish no
# artifact at all -- and the HEAD check below is what narrows it. Measured
# against this repository: 67 tags, of which 4 publish the kernel and none
# of those 4 is a prerelease.
discover_tags() {
  git ls-remote --tags "https://github.com/$REPO" 2>/dev/null \
    | sed 's|.*refs/tags/||' \
    | grep -v '\^{}$' \
    | grep '^v[0-9]'
}

TAGS=("$@")
if [ ${#TAGS[@]} -eq 0 ]; then
  printf '== Discovering tags\n'
  mapfile -t found < <(discover_tags)
  if [ ${#found[@]} -eq 0 ]; then
    say "could not reach the repository; falling back to the known list"
    TAGS=("${KNOWN_TAGS[@]}")
  else
    say "${#found[@]} tags in $REPO"
    # Union, so a discovery that comes back short can only ever add to the
    # known-good set and never silently drop one of it.
    mapfile -t TAGS < <(printf '%s\n' "${found[@]}" "${KNOWN_TAGS[@]}" | sort -u)
  fi
  say "checking ${#TAGS[@]} for $ARTIFACT (most publish none; this takes a moment)"
fi

mkdir -p "$OUT"
entries=()

for tag in "${TAGS[@]}"; do
  base="https://github.com/$REPO/releases/download/$tag"
  dest="$OUT/$tag"

  # Quietly, because most tags in a language's history publish no kernel
  # and 60 lines of "skip" would bury the four that matter.
  if ! curl -fsSL --retry 3 --head -o /dev/null "$base/$ARTIFACT" 2>/dev/null; then
    continue
  fi
  printf '\n== %s\n' "$tag"

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

  # Derived rather than hardcoded false. No prerelease publishes the
  # kernel today, so this changes nothing now -- but the day one does, a
  # mirror that called it stable would put it in the dropdown looking like
  # a release, which is the sort of wrong that is only found afterwards.
  case "$tag" in
    *_rc*|*-rc*|*alpha*|*beta*|*-pre*) prerelease=true ;;
    *) prerelease=false ;;
  esac

  # `version` and `assets[].sha256` as well as the name, so this script's
  # output is not a *downgrade* of the index the publishing job on
  # diluvium.aloecraft.org writes. Uploading a thinner index would cost the
  # Lab its cross-check: it compares the index's claimed checksum against
  # SHA256SUMS.txt and refuses the build when the two disagree, which is
  # how a stale mirror is caught. One source cannot disagree with itself.
  entries+=("$(printf '{"tag":"%s","name":"Diluvium %s","version":"%s","published_at":"%s","prerelease":%s,"sums":"SHA256SUMS.txt","assets":[{"name":"%s","sha256":"%s"}]}' \
    "$tag" "$version" "$version" "$published" "$prerelease" "$ARTIFACT" "$actual")")
done

if [ ${#entries[@]} -eq 0 ]; then
  echo "error: nothing to mirror" >&2
  exit 1
fi

{
  printf '{\n  "schema": 1,\n  "repo": "%s",\n  "releases": [\n' "$REPO"
  for i in "${!entries[@]}"; do
    printf '    %s' "${entries[$i]}"
    [ "$i" -lt $((${#entries[@]} - 1)) ] && printf ','
    printf '\n'
  done
  printf '  ]\n}\n'
} > "$OUT/releases.json"

printf '\n== Done\n'
say "wrote $OUT/releases.json with ${#entries[@]} release(s)"
say ""
say "Upload $OUT/ so that releases.json sits at the URL you give the Lab, e.g."
say "  https://diluvium.aloecraft.org/release/releases.json"
say ""
say "Then serve every file under it with:  Access-Control-Allow-Origin: *"
say "Check it with:"
say "  curl -sI -H 'Origin: https://example.org' <url>/releases.json | grep -i access-control"
