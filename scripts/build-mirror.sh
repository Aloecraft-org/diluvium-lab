#!/usr/bin/env bash
#
# Build the static runtime mirror the version dropdown reads.
#
#   scripts/build-mirror.sh [outdir] [tag ...]
#
# Default outdir is ./mirror. With no tags given, the set comes from
# `mirror_tags` in the Diluvium repository's own `changelog.json`, which is
# where that decision is published. Upload the result to a static host and
# point the Lab at it. Nothing dynamic is required: no API, no redirects,
# no auth.
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
#   <outdir>/<tag>/diluvium_swarm_wasi.wasm   (when the release has one)
#   <outdir>/<tag>/SHA256SUMS.txt
#   <outdir>/<tag>/BUILDINFO.txt      (a checksum fallback)
#
# The index is named releases.json to match what the publishing job on
# diluvium.aloecraft.org already writes. The Lab still accepts index.json
# as an alias, which is what this script used to emit.

set -euo pipefail

REPO="Aloecraft-org/diluvium"
ARTIFACT="libdiluvium_wasi.wasm"
SWARM_ARTIFACT="diluvium_swarm_wasi.wasm"
OUT="${1:-mirror}"
shift || true

# Which tags to mirror is not this script's decision, and it used to try
# to make it twice over.
#
# First it carried a hardcoded DEFAULT_TAGS list with a comment telling
# whoever read it to add to the list. Nobody did, so it went on printing
# "wrote releases.json with 2 release(s)" long after there were four.
# Then it discovered tags from `git ls-remote` and guessed at prerelease
# from the tag name -- which mirrored v5.5.1_build3, a release whose own
# notes say "the release mirror does not carry this one", and labelled it
# stable because the name has no `rc` in it.
#
# Both were the same mistake: inventing an answer that upstream already
# publishes. `changelog.json` at the repository root carries `mirror_tags`
# (the exact set), `latest` (what a `latest/` path resolves to), and a
# `stable` flag per release which CHANGELOG.yaml calls "the truth", noting
# that GitHub's own prerelease flag is *derived* from it. Read that.
KNOWN_TAGS=(v5.4.7_release v5.5.1_build1)
CHANGELOG_URL="${DILUVIUM_CHANGELOG_URL:-https://raw.githubusercontent.com/$REPO/main/changelog.json}"

say() { printf '  %s\n' "$*"; }

# changelog.json -> lines of "tag<TAB>stable<TAB>latest".
#
# Parsed with node rather than jq: this repository already requires node
# and does not require jq, and a mirror script that fails on a machine
# without jq fails exactly when someone is trying to publish.
read_changelog() {
  curl -fsSL --retry 3 "$CHANGELOG_URL" 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", () => {
      const doc = JSON.parse(raw);
      const releases = Array.isArray(doc.releases) ? doc.releases : [];
      const by = new Map(releases.map((r) => [r.tag, r]));
      // `mirror_tags` is the published set. Falling back to the per-release
      // `mirror` flag keeps this working if the top-level list is dropped.
      const tags = Array.isArray(doc.mirror_tags) && doc.mirror_tags.length
        ? doc.mirror_tags
        : releases.filter((r) => r.mirror).map((r) => r.tag);
      for (const tag of tags) {
        const r = by.get(tag) ?? {};
        process.stdout.write([tag, r.stable === true, tag === doc.latest].join("\t") + "\n");
      }
    });
  ' 2>/dev/null
}

TAGS=("$@")
declare -A STABLE=() IS_LATEST=()

if [ ${#TAGS[@]} -eq 0 ]; then
  printf '== Reading %s\n' "$CHANGELOG_URL"
  if meta=$(read_changelog) && [ -n "$meta" ]; then
    while IFS=$'\t' read -r tag stable latest; do
      [ -z "$tag" ] && continue
      TAGS+=("$tag")
      STABLE["$tag"]="$stable"
      IS_LATEST["$tag"]="$latest"
    done <<< "$meta"
    say "mirror_tags: ${TAGS[*]}"
  else
    # Not fatal, but not silent either: the fallback set is a floor from
    # some past day, and shipping it as though it were current is the
    # exact failure this whole section exists to stop.
    say "could not read changelog.json -- falling back to a known list, which may be short"
    say "pass tags explicitly to be sure: $0 <outdir> <tag>..."
    TAGS=("${KNOWN_TAGS[@]}")
  fi
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

  # The swarm module, when the release has one -- the same discipline as
  # fetch-runtime.sh: absence is a fact about the release and not fatal,
  # but a listed artifact that will not verify is, because at that point
  # something is wrong rather than merely old. Without this block the
  # runtime dropdown could switch a page to a tag whose swarm module the
  # mirror never carried, and the instances panel would fail on a fetch
  # the version switch had implied would work.
  if grep -q " \*\?$SWARM_ARTIFACT\$" "$dest/SHA256SUMS.txt"; then
    say "fetching $SWARM_ARTIFACT"
    curl -fsSL --retry 3 -o "$dest/$SWARM_ARTIFACT" "$base/$SWARM_ARTIFACT"
    s_expected=$(grep " \*\?$SWARM_ARTIFACT\$" "$dest/SHA256SUMS.txt" | cut -d' ' -f1)
    s_actual=$(sha256sum "$dest/$SWARM_ARTIFACT" | cut -d' ' -f1)
    if [ "$s_expected" != "$s_actual" ]; then
      echo "error: $tag swarm module checksum mismatch" >&2
      echo "  expected $s_expected" >&2
      echo "  actual   $s_actual" >&2
      exit 1
    fi
    say "verified $s_actual"
  else
    say "no $SWARM_ARTIFACT in this release (fine)"
  fi

  version=$(sed -n 's/^version *: *//p' "$dest/BUILDINFO.txt" 2>/dev/null | head -1)
  [ -z "$version" ] && version="${tag#v}"
  published=$(sed -n 's/^built *: *//p' "$dest/BUILDINFO.txt" 2>/dev/null | head -1)

  # From the changelog, never from the tag's spelling. `v5.5.1_build3` has
  # no `rc` in its name and is a prerelease anyway -- its supported
  # configuration is narrower than the feature set it ships, which
  # CHANGELOG.yaml says is reason enough. A name-based guess called it
  # stable. Tags passed on the command line have no changelog entry to
  # consult, so they are taken at face value and said so below.
  case "${STABLE[$tag]:-}" in
    true)  prerelease=false ;;
    false) prerelease=true ;;
    *)     prerelease=false; say "no changelog entry; assuming a release" ;;
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

# `latest` as the changelog gives it, so a consumer resolving a `latest/`
# path agrees with upstream rather than with whatever sorts highest here.
latest=""
for tag in "${TAGS[@]}"; do
  [ "${IS_LATEST[$tag]:-}" = "true" ] && latest="$tag"
done

{
  printf '{\n  "schema": 1,\n  "repo": "%s",\n' "$REPO"
  [ -n "$latest" ] && printf '  "latest": "%s",\n' "$latest"
  printf '  "releases": [\n'
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
