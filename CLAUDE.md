# Diluvium Lab

A notebook front end for Diluvium: cells, a console, kernel controls,
running a Diluvium WASM build in the page.

Read `ROADMAP.md` first. It carries the staging, the decisions already
made, and the risks. Update it in the same commit as the work it
describes.

## Hard constraints

These are decisions, not preferences. Changing one is a conversation, not
a commit.

- **No build step.** The page must be openable directly. If a bundler
  ever becomes unavoidable, the un-bundled page keeps working.
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
- Cap output per cell in lines and bytes. One runaway cell kills the tab.
- IndexedDB, not localStorage.
- Drop module and instance references on kernel restart, or each restart
  leaks a linear memory.
- `run_lua` is synchronous and cannot be interrupted. Do not design UI
  that implies otherwise until an interrupt tier actually exists.
