# Diluvium Lab

A notebook front end for Diluvium: cells, a console, kernel controls,
running a Diluvium WASM build in the page.

Read `ROADMAP.md` first. It carries the staging, the decisions already
made, and the risks. Update it in the same commit as the work it
describes.

## Hard constraints

These are decisions, not preferences. Changing one is a conversation, not
a commit.

- **No build step for the page you develop.** `index.html` plus `src/` runs
  as-is from any static server; there is nothing to compile, and the
  un-bundled page is always the source of truth.

  *Amended at Stage 1, deliberately.* The original wording said "openable
  directly", which turned out not to be satisfiable: browsers refuse
  `fetch` over `file://`, so a page opened by double-click renders but
  never loads its kernel. `npm run bake` emits a single self-contained
  `dist/diluvium-lab.html` for that case. The intent behind the constraint
  — modularity, no toolchain between you and the running page — is what is
  being kept. See ROADMAP §5.
- **No framework.** No React, Vue, Svelte. Plain modules and the DOM.
- **No CDN, no external requests at load.** Everything vendored. The only
  network calls are the ones that fetch Diluvium releases, and those are
  explicit and user-initiated.
- **`.ipynb` is the storage format.** Not a bespoke one.
- **Kernel messages are Jupyter-shaped**: `execute_request` /
  `execute_reply`, `stream`, `error`, `status`, `complete_request`,
  `is_complete_request`.
- **Everything reaches the kernel through one interface**, even while
  there is only one implementation behind it. The version dropdown,
  hosted mode, local mode and any future JupyterLite adapter are all
  instances of it.
- **Diluvium is never built here.** The Lab consumes published release
  artifacts. Pinned copies for offline dev live in `vendor/`.

## The kernel artifact

`libdiluvium_wasi.wasm` — the reactor build: no `_start`, exports
`init_lua`, `run_lua`, `malloc`, `free`.

**And a second one, since v5.5.1_build5: `diluvium_swarm_wasi.wasm`.**
The same objects plus `dvs.o` and `dvs_shim.o` — so it is measurably a
superset, and it is still loaded *beside* the kernel rather than instead
of it. It is fetched only when the instances panel is used, it is the
only artifact carrying the `dvs_*` swarm layer, and it additionally
imports three trampolines from module `env` (`js_host_create`,
`js_host_destroy`, `js_host_drive`) which the page supplies. A release
that does not publish it is a release with no swarm panel, which the page
says rather than hides. See ROADMAP §"A swarm host, in JavaScript" for
why two modules beats one.

Not `diluvium_wasi.wasm` (a command module that runs the REPL from
`_start`) and not `diluvium_compiler_wasi.wasm` (that is `luac`, for the
analysis report later).

It is a **WASI** build, so the page supplies WASI imports. Discover the
real import list with `WebAssembly.Module.imports()` rather than guessing
— the module is linked `--allow-undefined`, so only the binary is
authoritative. stdout and stderr arrive as `fd_write` on fd 1 and 2;
that is where cell output comes from.

## Verification

Every stage ends with a **passing Playwright test**, not a screenshot and
a claim. Chromium is preinstalled in Claude Code web sessions
(`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); never run
`playwright install`.

A change is not done until `npm test` is green. Tests load the real page
and drive the real UI — no mocking the kernel.

## Things known to bite

- `pcall` depends on `setjmp`/`longjmp` lowering onto WASM exception
  handling. Test that errors are *caught*, never just the happy path.
- Cap output per cell in lines and bytes. *Amended at the Worker port:*
  a runaway cell no longer kills the tab, it kills a worker — but the caps
  still matter, because a cell that prints forever fills memory on both
  threads and only the caps stop it.
- IndexedDB, not localStorage.
- Drop module and instance references on kernel restart, or each restart
  leaks a linear memory.
- `run_lua` is synchronous and cannot be interrupted. *An interrupt tier
  now exists, and it is not what that word usually means:* the kernel runs
  in a Web Worker and stopping it is `terminate()`, which takes the Lua
  state with it. `capabilities.interrupt` is true and
  `capabilities.interruptLosesState` is true beside it; the control says
  **Stop**, not Interrupt. Nothing may imply Jupyter's interrupt, which
  unwinds and keeps your variables. Where no worker is possible — the
  baked `file://` build — the kernel runs in the page, reports
  `interrupt: false`, and the button is disabled rather than inert.
