#!/usr/bin/env bash
#
# Seed the Diluvium Lab repository.
#
# Run once from the root of the new (otherwise empty) repo, which should
# already contain LAB_ROADMAP.md and LAB_CLAUDE.md.
#
#   ./seed-lab.sh [diluvium-tag]      default: v5.4.7_release
#
# Idempotent: existing files are left alone and reported, so it is safe to
# re-run after adding things by hand.

set -euo pipefail

TAG="${1:-v5.4.7_release}"
REPO="Aloecraft-org/diluvium"

say()  { printf '  %s\n' "$*"; }
head_() { printf '\n== %s\n' "$*"; }

# write <path> <<'EOF' ... EOF  -- never clobbers
write() {
  local path=$1
  if [ -e "$path" ]; then
    say "skip    $path (exists)"
    cat > /dev/null
    return
  fi
  mkdir -p "$(dirname "$path")"
  cat > "$path"
  say "create  $path"
}

[ -d .git ] || { echo "error: run this from the root of the git repo" >&2; exit 1; }

head_ "Documents"

for pair in "LAB_ROADMAP.md:ROADMAP.md" "LAB_CLAUDE.md:CLAUDE.md"; do
  from=${pair%%:*}; to=${pair##*:}
  if [ -f "$from" ] && [ ! -f "$to" ]; then
    git mv "$from" "$to" 2>/dev/null || mv "$from" "$to"
    say "rename  $from -> $to"
  elif [ -f "$to" ]; then
    say "skip    $to (exists)"
  else
    say "MISSING $from -- put the seed docs at the repo root first"
  fi
done

head_ "Layout"

mkdir -p src test vendor scripts notebooks
say "mkdir   src/ test/ vendor/ scripts/ notebooks/"

write .gitignore <<'EOF'
node_modules/
test-results/
playwright-report/
.DS_Store
EOF

write README.md <<'EOF'
# Diluvium Lab

A notebook front end for [Diluvium](https://github.com/Aloecraft-org/diluvium):
cells, a console, and kernel controls, running a Diluvium WASM build in
the page.

See `ROADMAP.md` for the staging and the decisions behind it, and
`CLAUDE.md` for the constraints any contributor (human or otherwise) works
under.

## Development

```sh
npm install          # @playwright/test only; Chromium is expected to exist
npm start            # serve the page at http://localhost:8080
npm test             # drive the real page in a real browser
```

The pinned Diluvium runtime lives in `vendor/`. Re-pin with:

```sh
scripts/fetch-runtime.sh v5.4.7_release
```

Diluvium itself is never built here.
EOF

write package.json <<'EOF'
{
  "name": "diluvium-lab",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node scripts/serve.mjs",
    "test": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0"
  }
}
EOF

write playwright.config.js <<'EOF'
import { defineConfig, devices } from '@playwright/test';

// Chromium is preinstalled in Claude Code web sessions via
// PLAYWRIGHT_BROWSERS_PATH; never run `playwright install` there.
export default defineConfig({
  testDir: './test',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'list' : 'html',
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'node scripts/serve.mjs',
    url: 'http://localhost:8080',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
  },
});
EOF

write scripts/serve.mjs <<'EOF'
// Minimal static server. Deliberately dependency-free: the page must be
// servable by anything, and the test harness should not need a bundler.
//
// Sets COOP/COEP so SharedArrayBuffer is available locally. That is only
// one of the interrupt tiers and may not survive contact with real
// hosting (GitHub Pages cannot set these headers) -- see ROADMAP.md.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ipynb': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let path = normalize(decodeURIComponent(url.pathname));
  if (path.endsWith('/')) path += 'index.html';
  const file = join(ROOT, path);

  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cache-Control': 'no-store',
    }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
EOF

write scripts/fetch-runtime.sh <<'EOF'
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
EOF
chmod +x scripts/fetch-runtime.sh 2>/dev/null || true

write notebooks/hello.ipynb <<'EOF'
{
 "cells": [
  {
   "cell_type": "markdown",
   "metadata": {},
   "source": ["# Hello, Diluvium\n", "\n", "Kept to syntax the pinned 5.4.7 runtime understands. Newer\n", "constructs (`switch`, `+=`, the rewritten f-strings) belong in a\n", "second notebook once a 5.5 artifact is published -- switching\n", "between the two is the Stage 2 demo."]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": ["local who = \"world\"\n", "print($\"hello, {who}!\")"]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": ["-- state persists across cells: this is the kernel\n", "counter = (counter or 0) + 1\n", "print(counter)"]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": ["-- errors must be catchable; see the longjmp note in ROADMAP.md\n", "print(pcall(function() error(\"caught\") end))"]
  }
 ],
 "metadata": {
  "kernelspec": {"display_name": "Diluvium", "language": "lua", "name": "diluvium"},
  "language_info": {"name": "lua", "file_extension": ".lua"}
 },
 "nbformat": 4,
 "nbformat_minor": 5
}
EOF

head_ "Runtime"
if scripts/fetch-runtime.sh "$TAG"; then
  :
else
  say "fetch failed -- run scripts/fetch-runtime.sh $TAG once you have network"
fi

head_ "Next"
cat <<'EOF'
  npm install
  git add -A && git commit -m "Seed the repository"

  Then open a Claude Code session and give it Stage 0 only:

    Read ROADMAP.md and CLAUDE.md. Do Stage 0 and nothing else.
    Answer both unknowns and record the answers in ROADMAP.md.

  Stage 0 is a go/no-go, not a feature. It ends with a passing
  Playwright test that catches a Lua error, not a happy path.
EOF
printf '\n'
