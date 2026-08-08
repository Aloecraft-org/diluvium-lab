# Diluvium Lab

A notebook front end for [Diluvium](https://github.com/Aloecraft-org/diluvium):
cells, a console, and kernel controls, running a Diluvium WASM build in the
page. No framework, no bundler, no CDN — plain modules and the DOM.

Cells and the console share one kernel, so state carries between them. The
kernel is `libdiluvium_wasi.wasm` running in the tab: a real Lua state
with the full standard library, reached through a WASI shim the page
supplies itself. The bundled build is **Diluvium 5.5.1_build1**; the
Runtime dropdown swaps it for any other the mirror carries, including
5.4.x.

## Running it

Nothing to compile and nothing to install. The kernel is committed under
`vendor/`, so a clone is a working copy:

```sh
git clone https://github.com/Aloecraft-org/diluvium-lab.git
cd diluvium-lab
node scripts/serve.mjs            # → http://localhost:8080
```

Node 18 or newer, and that is the whole dependency list — `serve.mjs` is
deliberately dependency-free. `npm install` is for the *test* harness and
is not needed to run the Lab.

Any static server will do; these are equivalent:

```sh
python3 -m http.server 8080
npx --yes serve -l 8080
```

It does need to be a server. Opened as a `file://` URL the page renders
and then cannot load its kernel, because browsers refuse `fetch` on the
`file:` scheme.

### With Docker

```sh
docker build -t diluvium-lab .
docker run --rm -p 8080:8080 diluvium-lab
```

The image is the source tree plus a Node runtime — no build stage, no
`npm install`, nothing fetched at run time.

### As one file

```sh
npm run bake                      # → dist/diluvium-lab.html
```

One ~1.5 MB file with the kernel inlined as base64, which makes no network
requests at all and can be opened by double-clicking, emailed, or dropped
on a USB stick. `scripts/check-bake.mjs` asserts that it really is
self-contained rather than merely looking it.

The trade is real and deliberate: a `file://` page is not a secure
context, so `crypto.subtle` is unavailable, so downloaded runtimes cannot
be checksummed — and the baked build therefore refuses to fetch them at
all and says so. It carries the one runtime it was baked with.

## Development

```sh
npm install          # @playwright/test only; Chromium is expected to exist
npm start            # serve the page at http://localhost:8080
npm test             # drive the real page in a real browser
npm run bake         # emit dist/diluvium-lab.html, a single double-click file
```

Other scripts:

```sh
scripts/fetch-runtime.sh v5.5.1_build1    # re-pin the bundled runtime
scripts/build-mirror.sh mirror            # build the runtime mirror (see below)
scripts/check-bake.mjs                    # assert the baked file is self-contained
```

Tests drive the real page in a real browser against the real kernel —
nothing about the kernel is mocked, which is the point. CI runs the same
suite plus the bake on every push and pull request.

`spike.html` is the Stage 0 spike, kept on purpose. It exercises the *raw*
`run_lua` contract that the kernel deliberately hides — status codes, the
`Error:` line on stdout, `longjmp` unwinding — so it is the first thing to
open when a new runtime is pinned.

## In a cell

| | |
| :--- | :--- |
| **Ctrl+Enter** | run the cell |
| **Shift+Enter** | run it and move on |
| **Tab** / **Shift+Tab** | indent / dedent (Escape first if you want Tab to move focus) |
| **Ctrl+/** | comment / uncomment the line or selection |
| **Ctrl+Space** | completions; typing `.` after a name opens them too |

A cell ending in an expression shows its value as `Out[n]`, and tables show
their contents rather than `table: 0x1f2e0`. `print` is left exactly as Lua
defines it — a notebook that redefined it would be teaching something that
stops being true in the terminal.

Errors keep the runtime's own message and add a plain-English hint beneath
it where there is something useful to say.

## Reading bytecode

Every code cell has a **Bytecode** button. It compiles the cell without
running it and shows the disassembly, with constants, upvalues and jump
targets resolved rather than left as numbers — `GETTABUP 1 0 0` is a fact,
`GETTABUP 1 0 0  ; _ENV "print"` is an explanation.

Two other tabs make it a converter as well as a viewer: **Hex** shows the
bytes and downloads them as a `.luac`, and **Read hex** takes a paste and
disassembles it. So a compiled chunk someone sends you can be read in a
browser with nothing installed — and since it is only compiled and read,
never run, that is safe to do with a blob you have not vetted.

Two containers are read: Diluvium 5.4's, which is Lua 5.4's, and Diluvium
5.5's, which is Lua 5.5's. They differ in almost every primitive — the
varint terminator is inverted, integers became zigzag varints, strings are
interned, `source` moved, sections are aligned, and two opcodes were
inserted so the numbering shifts. Nothing in the bytes announces which set
of rules applies except the version byte in the header, so that is what the
reader dispatches on, and there is no default instruction set anywhere in
the code.

Both carry Diluvium's own `LUAC_FORMAT` byte of `0x44` — stock Lua writes
`0` there and refuses anything else, so a Diluvium chunk and a PUC-Rio
chunk of the same Lua version are deliberately not interchangeable.

Diluvium also writes one byte per function that stock Lua does not,
`Proto::is_encrypted` — the `~function` marker. When it is set, that
function's instructions and strings are stored XORed with `0xbe`. The
reader undoes it, so a secure function disassembles like any other, which
is worth knowing before relying on it to hide anything. On 5.4.7 the flag
also lands on functions nobody marked, because the lexer field behind it
is never initialised; 5.5 fixes that.

`src/analysis/luac.js` verifies its own output: the parse must consume
every byte and every opcode must exist, or it refuses. A disassembly that
looks right and is not would be worse than none. Both containers are
tested against committed dumps from native builds of each tag
(`scripts/make-bytecode-fixtures.lua`), because the Lab runs one kernel at
a time and a suite tied to the pinned one would cover only half.

## Running against another Diluvium build

The **Runtime** dropdown switches which Diluvium the notebook runs on,
which is the thing no general-purpose notebook offers. The bundled build is
always there; press ⟳ to ask the mirror what else exists.

It has to be a mirror rather than GitHub, and that is not a preference.
GitHub serves release assets from `release-assets.githubusercontent.com`
with **no `Access-Control-Allow-Origin` header**, so a browser cannot read
those bytes cross-origin however public the release is.
`scripts/fetch-runtime.sh` still works because curl has no origin to
violate. A page does.

### Standing up the mirror

```sh
scripts/build-mirror.sh mirror v5.5.1_build1      # downloads and verifies
# upload mirror/ so releases.json lands at the URL the Lab points to
```

The layout is plain files:

```
<base>/releases.json
<base>/<tag>/libdiluvium_wasi.wasm
<base>/<tag>/SHA256SUMS.txt        (or BUILDINFO.txt)
```

`releases.json` is the only file the Lab cannot do without — it is how the
dropdown learns which tags exist, and there is no way to enumerate a
static directory from a browser. `index.json` is accepted as an alias.

The checksum can come from three places: `SHA256SUMS.txt`, `BUILDINFO.txt`
— whose `Artifacts` section is the same `sha256sum` output — or the
index's own `assets[].sha256`. The first two win, since they are what the
release job publishes and what `scripts/fetch-runtime.sh` checks. When
more than one is present **they must agree**: a mirror that contradicts
itself is half-updated, and choosing between two hashes is choosing which
binary to execute on no evidence.

```json
{
  "repo": "Aloecraft-org/diluvium",
  "latest": "v5.5.1_build1",
  "releases": [
    {
      "tag": "v5.5.1_build1",
      "name": "Diluvium 5.5.1_build1",
      "published_at": "2026-08-07T18:14:33Z",
      "prerelease": false,
      "assets": [
        { "name": "libdiluvium_wasi.wasm", "size": 945830, "sha256": "15e5a2..." }
      ]
    }
  ]
}
```

The dropdown label comes from `name` rather than the tag, because no rule
applied to tags alone turns both `v5.4.7_release` into `5.4.7` and
`v5.5.1_build1` into `5.5.1_build1`. An explicit `version` overrides it.

The host must do exactly one thing, on every file above:

```
Access-Control-Allow-Origin: *
```

No API, no redirects, no auth, no dynamic anything. Check it with:

```sh
curl -sI -H 'Origin: https://example.org' <base>/releases.json | grep -i access-control
```

The Lab verifies every download against that release's own
`SHA256SUMS.txt` — the same file `scripts/fetch-runtime.sh` checks, so the
browser path and the shell path agree on what "correct" means — then probes
the module for the exports it needs, and only then swaps. A build that
fails any step leaves the running kernel untouched.

To try a mirror before deploying it, serve the Lab locally and pass
`?mirror=http://localhost:8099/`. That override is honoured on localhost
only, on purpose: the Lab downloads a binary and executes it, so a query
parameter that redirects where that binary comes from would turn any link
into "run this wasm".

The mirror at `diluvium.aloecraft.org/release/` carries `v5.4.7_release`
and `v5.5.1_build1`, both with the kernel artifact.

## Versions

**About** in the toolbar states exactly what is running: the Lab's version
and commit, the Diluvium tag, version, commit and **sha256**, what the
kernel reports about itself, whether it is off-thread, and the browser.
There is a button to copy the lot as a block for a bug report. "It does
not work" is unactionable and nobody should have to be talked through
finding a version.

The Lab's own version is plain semver in `src/version.js`, hand-maintained
because the served page has no build step. It does **not** track
Diluvium's — the two move independently, and pinning one to the other
means either lying about one or being unable to ship a fix.
`scripts/check-version.mjs` keeps it in step with `package.json` and
rejects anything that is not semver; `npm run bake` stamps the git commit
into the baked file, which is the one artifact that travels detached from
its repository.

Which Diluvium is bundled lives in `vendor/pinned.js`, generated by
`scripts/fetch-runtime.sh` from the release's own `BUILDINFO.txt`. It is a
module rather than a file to fetch, so the page can say what it runs
without a request or a parse.

### Deploying it

One rule, and it is not optional: **do not let anything cache the scripts.**

The page has no build step, so module URLs carry no content hash — a
browser or CDN holding `src/app.js` from an older deploy has no way to
know. And because HTML is usually served uncached while `.js` is not, the
normal result of a deploy is a window where a *fresh* `index.html` runs
*stale* modules. Nothing throws. The old code simply lacks the newer half
of the page, so the console stays clean and the symptom is "some buttons
do nothing" — which is close to undiagnosable.

```
Cache-Control: no-cache
```

on everything under the Lab's path. `no-cache` means revalidate, not "do
not store", and every response already carries an `ETag`, so the cost is
one 304 per file rather than a re-download.

Behind Cloudflare, the origin sending no `Cache-Control` is not enough:
Cloudflare's **default Browser Cache TTL is 4 hours** and it applies that
to `.js` while leaving HTML uncached, which produces exactly the skew
above. Either set Browser Cache TTL to *Respect Existing Headers* and send
the header from the origin, or add a Cache Rule for the Lab's path that
disables browser caching. Check it with:

```sh
curl -sI <base>/src/app.js | grep -i 'cache-control\|cf-cache-status'
```

**Purging matters as much as the header.** Changing `Cache-Control`
governs what gets stored *next*; it does not evict what a CDN already
holds. After a deploy, purge — and then check that the edge agrees with
the origin, because a header set at the origin can also be overridden by
the CDN's own browser-cache setting:

```sh
curl -sI <base>/src/app.js | grep -i 'etag\|cache-control\|cf-cache-status'
curl -sI '<base>/src/app.js?bust=1' | grep -i etag   # what the origin really has
```

Two different etags means the edge is serving something the origin no
longer has.

The Lab defends itself as far as it can. The version is printed in the
toolbar, and `index.html` carries an **inline, non-module** script that
compares it against the version compiled into the running code. That
placement is the whole point: `index.html` is the one file always fetched
fresh, so it is the only place a staleness check can live and still be
there when everything under `src/` is old. If they disagree — or if
nothing booted at all — a banner says so and offers a reload that appends
a query string, since `location.reload(true)` has been a no-op for years
and only a URL the cache has never seen actually re-fetches.

## Security

The Lab downloads binaries and executes them, and it opens files people
send each other. Those are the two places to look, so here is what it
actually does.

**Everything runs in the tab's sandbox.** The kernel is WebAssembly with a
WASI shim this page supplies itself (`src/kernel/wasi.js`). It gets no
filesystem, no sockets, no clock beyond what the shim answers, and no way
out of the page — the shim implements the calls it needs and stubs the
rest. Your notebooks are in IndexedDB in your browser; nothing is uploaded
anywhere, and the Lab has no server, no account, and no telemetry.

**Runtimes are verified before they are run.** The order is fetch, verify,
probe, *then* swap: a download is checked against the release's own
`SHA256SUMS.txt` (or `BUILDINFO.txt`), the module is probed for the exports
a Diluvium kernel must have, and only a build that passes both replaces the
running one. Anything that fails leaves your session untouched. When more
than one checksum source is present they must agree — a mirror that
contradicts itself is refused rather than resolved, because picking one of
two hashes is picking which binary to execute on no evidence.

**`?mirror=` is honoured on localhost only.** That parameter redirects
where the Lab downloads executable code from, so accepting it on a
deployed page would turn any link into "run this wasm". It exists for
testing a mirror before deploying it, and it is deliberately useless as a
link.

**Reading bytecode does not run it.** The Bytecode panel and the "Read hex"
tab compile and parse; they never execute. That is what makes it safe to
paste a compiled chunk from someone you do not trust — and the parser is
strict on purpose, refusing anything whose bytes it cannot fully account
for rather than guessing.

**Nothing reaches the DOM as markup.** Markdown, hints, error text and
output are escaped before rendering, so a notebook cannot script the page
that opens it. `.ipynb` files are data here, not documents with behaviour.

**`~function` is obfuscation, not encryption.** Diluvium's secure-function
marker XORs a function's code and strings with a single-byte key. The Lab
reads through it and disassembles those functions like any other, which is
the honest thing for a tool that teaches the format to do. It stops
`strings` on a `.luac`; treat it as nothing more.

If you find a security problem, please open an issue — or mail the address
on the Diluvium repository if you would rather not do so in public.

## Layout

```
index.html          the notebook
spike.html          the Stage 0 spike: raw kernel contract, run this first
src/kernel/         the kernel interface and the one implementation behind it
src/notebook/       the document: model, .ipynb, markdown, highlighting, rendering
vendor/             the pinned Diluvium runtime
```

Everything reaches the kernel through `src/kernel/kernel.js`. That is the
seam Stage 2's version dropdown and Stage 3's second backend plug into.

The pinned runtime lives in `vendor/`. Re-pin with:

```sh
scripts/fetch-runtime.sh v5.5.1_build1
```

Diluvium itself is never built here — the Lab consumes published release
artifacts.

## Where this is going

`ROADMAP.md` carries the staging, the decisions already made, and the
risks; `CLAUDE.md` carries the constraints any contributor works under.
Stages 0, 1 and 2 are done. Next is a second kernel backend (Stage 3):
a local `diluvium` over WebSocket, which is where the real REPL protocol
replaces the `run_lua` shim. The adapter it plugs into already exists.
