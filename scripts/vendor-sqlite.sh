#!/usr/bin/env bash
#
# Vendor sql.js into vendor/, for the `sql` hostcall connector.
#
#   scripts/vendor-sqlite.sh [version]        default: 1.14.1
#
# Why a script rather than a checked-in blob with a README: the copy is
# not byte-identical to upstream and cannot be. `sql-wasm.js` is UMD, and
# the Lab has no bundler, so it is imported as an ES module -- where the
# UMD tail is inert but the emcc shim's unconditional `module = undefined`
# throws, because assigning to an undeclared name is a ReferenceError in
# a module's strict mode.
#
# So exactly two edits are made, both mechanical, both recorded here: a
# declaration of the two names the UMD shim expects to find, and an export
# of the factory. Four lines in total, two of which say so in the file.
# Re-vendoring is running this again.
#
# sql.js is MIT; SQLite itself is public domain. Both notices are kept.

set -euo pipefail

VERSION="${1:-1.14.1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/vendor"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "fetching sql.js@$VERSION ..."
(cd "$WORK" && npm pack "sql.js@$VERSION" >/dev/null && tar xzf "sql.js-$VERSION.tgz")
SRC="$WORK/package/dist"

upstream_js=$(sha256sum "$SRC/sql-wasm.js" | cut -d' ' -f1)
upstream_wasm=$(sha256sum "$SRC/sql-wasm.wasm" | cut -d' ' -f1)

{
  printf '// Vendored by scripts/vendor-sqlite.sh -- see vendor/sql-wasm.SOURCE.txt.\n'
  printf '// The two edits to upstream are this declaration and the export at the end.\n'
  printf 'var module, exports;\n'
  cat "$SRC/sql-wasm.js"
  printf '\nexport default initSqlJs;\n'
} > "$DEST/sql-wasm.js"

cp "$SRC/sql-wasm.wasm" "$DEST/sql-wasm.wasm"
cp "$WORK/package/LICENSE" "$DEST/sql-wasm.LICENSE.txt"
# The tarball ships it executable, which git would then record. It is a
# wasm binary fetched by the page; nothing ever execs it.
chmod 644 "$DEST/sql-wasm.wasm" "$DEST/sql-wasm.js" "$DEST/sql-wasm.LICENSE.txt"

cat > "$DEST/sql-wasm.SOURCE.txt" <<PROV
# Where vendor/sql-wasm.* came from, and how to re-vendor them.
#
# SQLite compiled to WebAssembly, behind the \`sql\` hostcall connector.
# Not byte-identical to upstream, unavoidably: see scripts/vendor-sqlite.sh
# for the two lines added and why an ES module needs them.

package  sql.js@$VERSION  (MIT; SQLite itself is public domain)
npm      https://www.npmjs.com/package/sql.js
source   https://github.com/sql-js/sql.js

vendor/sql-wasm.js    <- dist/sql-wasm.js  + 3 prepended lines, 1 appended
upstream sha256  $upstream_js

vendor/sql-wasm.wasm  <- dist/sql-wasm.wasm  (byte-identical)
upstream sha256  $upstream_wasm
sha256           $(sha256sum "$DEST/sql-wasm.wasm" | cut -d' ' -f1)
PROV

echo "ok: vendored sql.js@$VERSION"
ls -la "$DEST"/sql-wasm.* | sed 's/^/    /'
