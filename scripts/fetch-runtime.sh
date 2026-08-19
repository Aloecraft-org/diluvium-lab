#!/usr/bin/env bash
#
# Pin a Diluvium runtime into vendor/.
#
#   scripts/fetch-runtime.sh [tag]        default: v5.5.1_build5
#
# Downloads the kernel module plus the release's checksum and build
# manifest, and verifies the module against the former. This is the
# Stage 2 mechanism in miniature -- the version dropdown does the same
# three steps in the browser.
#
# Two modules now, not one. `diluvium_swarm_wasi.wasm` arrived in
# v5.5.1_build5: the same objects as libdiluvium_wasi.wasm plus dvs.o and
# dvs_shim.o, so it is the kernel *and* the swarm layer in one artifact.
# It is fetched when the release has it and skipped without complaint when
# it does not -- every tag before build5 is in the second case, and a Lab
# pinned to one of those runs cells perfectly well and says the swarm
# panel is unavailable rather than failing.
#
# Pulls from the mirror by default. Set DILUVIUM_RELEASE_BASE to point
# somewhere else -- notably at GitHub, which is where a build the mirror
# does not carry lives:
#
#   DILUVIUM_RELEASE_BASE=https://github.com/Aloecraft-org/diluvium/releases/download \
#     scripts/fetch-runtime.sh v5.5.1_build3
#
# This used to say that only v5.4.7_release attaches libdiluvium_wasi.wasm
# to its GitHub release. That is no longer true: build1, build2 and build3
# all do. What GitHub does not do is send Access-Control-Allow-Origin, so
# the *browser* still needs the mirror even though curl does not.
#
# Which tags the mirror should carry is not a judgement call -- it is
# `mirror_tags` in the Diluvium repository's changelog.json, and
# scripts/build-mirror.sh reads it. v5.5.1_build3 is deliberately not in
# that set: it is a prerelease whose supported configuration is narrower
# than the feature set it ships. Pin it if you want what it added; do not
# pin it by default.

set -euo pipefail

TAG="${1:-v5.5.1_build10}"
MIRROR="${DILUVIUM_RELEASE_BASE:-https://diluvium.aloecraft.org/release}"
BASE="$MIRROR/$TAG"
DEST="$(cd "$(dirname "$0")/.." && pwd)/vendor"

mkdir -p "$DEST"

for f in libdiluvium_wasi.wasm SHA256SUMS.txt BUILDINFO.txt; do
  echo "fetching $f ..."
  curl -fsSL --retry 3 -o "$DEST/$f" "$BASE/$f"
done

# Verify a downloaded artifact against the release's own SHA256SUMS.txt.
# Kept as a function because there are two artifacts now and the second one
# must be checked exactly as hard as the first: an unverified module is one
# the page would execute on nobody's word.
verify () {
  local name="$1" expected actual
  expected=$(grep " ${name//./\\.}\$" "$DEST/SHA256SUMS.txt" | cut -d' ' -f1)
  actual=$(sha256sum "$DEST/$name" | cut -d' ' -f1)
  if [ -z "$expected" ]; then
    echo "error: $name not listed in SHA256SUMS.txt" >&2
    return 1
  fi
  if [ "$expected" != "$actual" ]; then
    echo "error: checksum mismatch for $name" >&2
    echo "  expected $expected" >&2
    echo "  actual   $actual" >&2
    return 1
  fi
  printf '%s' "$actual"
}

actual=$(verify libdiluvium_wasi.wasm)

# The swarm module, when the release has one. Absence is a fact about the
# release rather than a failure here, so it is reported and not fatal --
# but a *listed* artifact that will not verify is still fatal, because at
# that point something is wrong rather than merely old.
swarm_sha=""
if grep -q ' diluvium_swarm_wasi\.wasm$' "$DEST/SHA256SUMS.txt"; then
  echo "fetching diluvium_swarm_wasi.wasm ..."
  curl -fsSL --retry 3 -o "$DEST/diluvium_swarm_wasi.wasm" "$BASE/diluvium_swarm_wasi.wasm"
  swarm_sha=$(verify diluvium_swarm_wasi.wasm)
else
  rm -f "$DEST/diluvium_swarm_wasi.wasm"
  echo "note: $TAG publishes no diluvium_swarm_wasi.wasm; the swarm panel will say so"
fi

printf '%s\n' "$TAG" > "$DEST/PINNED_TAG"

# The same facts as a module, so the page can state exactly which build it
# is running without a fetch or a parse. BUILDINFO.txt is the source: it
# carries the version the release job recorded, which is not always
# derivable from the tag.
version=$(sed -n 's/^version *: *//p' "$DEST/BUILDINFO.txt" | head -1)
commit=$(sed -n 's/^commit *: *//p' "$DEST/BUILDINFO.txt" | head -1)
built=$(sed -n 's/^built *: *//p' "$DEST/BUILDINFO.txt" | head -1)

# Whether this tag is a *release*, from the Diluvium repository's own
# changelog.json -- the same file scripts/build-mirror.sh reads for
# `mirror_tags`. BUILDINFO.txt does not carry it, and a build's stability
# is not derivable from its tag: `v5.5.1_build3` has no `rc` in its name
# and is a prerelease, because its supported configuration is narrower
# than the feature set it ships.
#
# The page shows this in the runtime dropdown. A Lab that bundles a
# prerelease should say which, in the place someone is already choosing.
# Unknown (the fetch failed, or the tag has no entry) is recorded as
# `null`, which the page reads as "not stated" rather than as "fine".
stable=$(curl -fsSL --retry 3 "${DILUVIUM_CHANGELOG_URL:-https://raw.githubusercontent.com/Aloecraft-org/diluvium/main/changelog.json}" 2>/dev/null \
  | TAG="$TAG" node -e '
      let raw = "";
      process.stdin.on("data", (d) => { raw += d; });
      process.stdin.on("end", () => {
        try {
          const doc = JSON.parse(raw);
          const r = (doc.releases || []).find((x) => x.tag === process.env.TAG);
          process.stdout.write(r === undefined || r.stable === undefined ? "null" : String(r.stable === true));
        } catch { process.stdout.write("null"); }
      });
    ' 2>/dev/null) || stable="null"
[ -z "$stable" ] && stable="null"

cat > "$DEST/pinned.js" <<EOF
// Generated by scripts/fetch-runtime.sh. Do not edit.
//
// The bundled Diluvium, stated rather than guessed at. Imported as a
// module so the page needs no fetch and no parsing to say what it runs --
// which matters because this is the first thing a bug report should carry.

export const BUNDLED = {
  tag: '$TAG',
  version: '$version',
  commit: '$commit',
  built: '$built',
  sha256: '$actual',
  artifact: 'libdiluvium_wasi.wasm',
  // The swarm build, when this release has one: the same objects plus
  // dvs.o and dvs_shim.o. \`null\` means this tag does not publish it, and
  // the page reads that as "no swarm panel on this runtime" rather than
  // as an error. New in v5.5.1_build5.
  swarm: $( [ -n "$swarm_sha" ] && printf "{ artifact: 'diluvium_swarm_wasi.wasm', sha256: '%s' }" "$swarm_sha" || printf 'null' ),
  // From changelog.json, where upstream states it. \`null\` means this
  // script could not ask -- not that the build is fine.
  stable: $stable,
};
EOF

echo "ok: $TAG pinned, sha256 $actual"
[ -n "$swarm_sha" ] && echo "    swarm module pinned too, sha256 $swarm_sha"
echo "    wrote vendor/pinned.js ($version, commit ${commit:0:12}, stable: $stable)"
[ "$stable" = "false" ] && echo "    note: this is a PRERELEASE; the dropdown and the About panel will say so"
