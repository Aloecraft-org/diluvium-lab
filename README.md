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

The page needs a static server — any one will do — because browsers refuse
to `fetch` the kernel over `file://`. `npm run bake` is the answer for the
double-click case: it flattens the module graph and inlines the kernel as
base64 into one ~1.2 MB file that makes no network requests at all.

`spike.html` is the Stage 0 spike, kept on purpose. It exercises the *raw*
`run_lua` contract that the kernel deliberately hides — status codes, the
`Error:` line on stdout, `longjmp` unwinding — so it is the first thing to
open when a new runtime is pinned.

## Layout

```
index.html          the notebook
spike.html          the Stage 0 spike: raw kernel contract, run this first
src/kernel/         the kernel interface and the one implementation behind it
src/notebook/       the document: model, .ipynb, markdown, rendering
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
Stages 0 and 1 are done. Next is version switching (Stage 2), which is more
valuable than it looks: running one notebook against two builds is exactly
what a language author wants, and no general-purpose notebook offers it.
