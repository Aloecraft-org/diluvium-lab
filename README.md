# Diluvium Lab

A notebook front end for [Diluvium](https://github.com/Aloecraft-org/diluvium):
cells, a console, and kernel controls, running a Diluvium WASM build in the
page. No framework, no bundler, no CDN — plain modules and the DOM.

Cells and the console share one kernel, so state carries between them. The
kernel is `libdiluvium_wasi.wasm` running in the tab: a real Lua 5.4 state
with the full standard library, reached through a WASI shim the page
supplies itself.

## Development

```sh
npm install          # @playwright/test only; Chromium is expected to exist
npm start            # serve the page at http://localhost:8080
npm test             # drive the real page in a real browser
npm run bake         # emit dist/diluvium-lab.html, a single double-click file
```

Other scripts:

```sh
scripts/fetch-runtime.sh v5.4.7_release   # re-pin the bundled runtime
scripts/build-mirror.sh mirror            # build the runtime mirror (see below)
```

The page needs a static server — any one will do — because browsers refuse
to `fetch` the kernel over `file://`. `npm run bake` is the answer for the
double-click case: it flattens the module graph and inlines the kernel as
base64 into one ~1.2 MB file that makes no network requests at all.

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
`Proto::is_encrypted`. In 5.5 it is the `~function` marker; when it is set,
that function's instructions and strings are stored XORed with `0xbe`. The
reader undoes it, so a secure function disassembles like any other — which
is worth knowing before relying on it to hide anything.

`src/analysis/luac.js` verifies its own output: the parse must consume
every byte and every opcode must exist, or it refuses. A disassembly that
looks right and is not would be worse than none. The 5.4 path is tested
against the live kernel; the 5.5 path against committed dumps from a real
5.5.1 build (`scripts/make-bytecode-fixtures.lua`).

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
scripts/build-mirror.sh mirror v5.4.7_release      # downloads and verifies
# upload mirror/ so index.json lands at the URL the Lab points to
```

The layout is plain files:

```
<base>/index.json
<base>/<tag>/libdiluvium_wasi.wasm
<base>/<tag>/SHA256SUMS.txt        (or BUILDINFO.txt)
```

`index.json` is the only file the Lab cannot do without — it is how the
dropdown learns which tags exist, and there is no way to enumerate a
static directory from a browser. The checksum may come from either
`SHA256SUMS.txt` or `BUILDINFO.txt`, since the release job publishes both
and the build manifest embeds the same `<sha256>  <filename>` lines.

```json
{
  "schema": 1,
  "releases": [
    { "tag": "v5.4.7_release", "version": "5.4.7", "published": "2026-08-05T22:53:34Z" }
  ]
}
```

The host must do exactly one thing, on every file above:

```
Access-Control-Allow-Origin: *
```

No API, no redirects, no auth, no dynamic anything. Check it with:

```sh
curl -sI -H 'Origin: https://example.org' <base>/index.json | grep -i access-control
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

**Today the mirror will list one build.** Nineteen tags exist on the
Diluvium repository, but only `v5.4.7_release` attaches
`libdiluvium_wasi.wasm` to its release — including `v5.5.0` and
`v5.5.1_rc1`, which do not. The dropdown is waiting on the release job, not
on the Lab.

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
scripts/fetch-runtime.sh v5.4.7_release
```

Diluvium itself is never built here — the Lab consumes published release
artifacts.

## Where this is going

`ROADMAP.md` carries the staging, the decisions already made, and the
risks; `CLAUDE.md` carries the constraints any contributor works under.
Stages 0, 1 and 2 are done. Next is a second kernel backend (Stage 3):
a local `diluvium` over WebSocket, which is where the real REPL protocol
replaces the `run_lua` shim. The adapter it plugs into already exists.
