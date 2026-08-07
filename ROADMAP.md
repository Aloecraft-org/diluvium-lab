# Diluvium Lab — Roadmap

Seed document for a **separate repository**. Diluvium Lab is a notebook
front end for Diluvium: cells, a console, kernel controls, running against
a Diluvium WASM build in the page.

It consumes published Diluvium releases and never builds Diluvium itself.
That keeps the two efforts independent, and it means the mechanism the Lab
needs anyway — fetch a release, load it, run it — is also its own dev
workflow.

Update this document in the same commit as the work it describes.

---

## 1. Where this starts from

The good news is concrete: **an MVP needs no changes to Diluvium.**

`src/wasm_stubs.c` in the Diluvium tree exports `init_lua()` and
`run_lua(code)` against a **persistent `global_L`** carrying the full
standard library. State survives between calls. That is a kernel already,
and persistent cross-cell state is the one property a notebook genuinely
needs and the most expensive one to bolt on later.

### The artifact to load

Three WASM files ship on the releases page. They are not
interchangeable:

| Artifact | What it is | Use |
| :--- | :--- | :--- |
| `libdiluvium_wasi.wasm` | linked `--no-entry --allow-undefined`; exports `init_lua`, `run_lua`, `malloc`, `free`, `memory` and the whole Lua C API | **this is the kernel** |
| `diluvium_wasi.wasm` | command module; runs `main` and the REPL from `_start` | not for the Lab |
| `diluvium_compiler_wasi.wasm` | `luac` | **not needed** — see below |

Both are **WASI** builds, not `wasm32-unknown-unknown`. The
`wasm32-unknown-unknown` target exists in the Makefile but only produces a
static archive (`libdiluvium_wasm_unknown.a`), never a linked `.wasm`, so
it is not a browser option today. The browser must therefore supply WASI
imports.

### What the binary actually says

Inspected from `v5.4.7_release`, `libdiluvium_wasi.wasm`
(sha256 `c3da069e…`, 895 771 bytes), by parsing its import and export
sections. These are facts about the shipped artifact, not expectations:

- **45 imports, every one of them plain `wasi_snapshot_preview1`** —
  `fd_*`, `path_*`, `clock_*`, `args_*`, `environ_*`, `sock_*`,
  `poll_oneoff`, `proc_exit`, `random_get`, `sched_yield`. Nothing
  custom. **An off-the-shelf preview1 shim covers it**; no bespoke shim is
  needed, which removes most of the risk Stage 0 was meant to price.
- **`_start` *is* exported**, alongside `init_lua` and `run_lua`. The
  module is linked `--no-entry` but still carries the command entry
  point. Do not call it — it runs the REPL against stdin. Call the
  exports directly.
- **`_initialize` is absent; `__wasm_call_ctors` is exported.** So this is
  *not* a canonical WASI reactor, and nothing initialises libc on your
  behalf. **Call `__wasm_call_ctors()` once, before `init_lua()`.**
  *Stage 0 correction:* the warning that used to sit here — that skipping
  it leaves libc stdio uninitialised and costs an afternoon — **is not
  true of this artifact.** All four combinations of skipping
  `__wasm_call_ctors` and skipping `init_lua` were measured, and every one
  of them printed, kept state across calls, and caught errors identically:
  `run_lua` initialises what it needs on its own. Keep calling both anyway
  — it is the documented contract, it is idempotent, and it costs nothing
  — but do not go hunting there when something else breaks.
- **`diluvium_generate_report` is exported from this same module**, so the
  analysis-report and determinism-verdict panel needs no second module and
  no `diluvium_compiler_wasi.wasm`. That makes it much cheaper than
  assumed and it can land whenever it is wanted.
- **`luaL_newstate` and the rest of the C API are exported.** A future
  kernel could create and destroy states directly instead of
  re-instantiating the module for a restart.
- **stdout and stderr arrive as `fd_write` on fd 1 and 2**, so output
  capture comes free from the shim rather than needing anything from the
  runtime. The *stream split* is another matter: Stage 0 never saw a
  single write to fd 2, errors included. See below.
- `SHA256SUMS.txt` lists `libdiluvium_wasi.wasm` and the published hash
  matches the downloaded bytes, so the Stage 2 integrity check works
  against releases as they exist today.

### What a notebook needs, and where it comes from

| Need | Today |
| :--- | :--- |
| Persistent state across cells | free — `global_L` |
| Output, with streams separated | WASI `fd_write`. **Measured: this build only ever writes fd 1.** See below |
| Expression echo (`1+1` → `2`) | `run_lua` uses `luaL_dostring`, which does not echo. The "retry with `return` prepended" trick alone is **not enough** — see below |
| Restart kernel | re-instantiate the module. Not optional: **`init_lua()` is not a reset**, see below |
| Completion | inject a Lua completion function and call it through `run_lua`; matches the handoff's "completion logic is written in Lua and embedded" |
| Errors | `run_lua` prints `Error: ...` to stdout and returns non-zero. Parse host-side for now; structured errors when the real protocol lands |
| **Interrupt** | **not possible.** `run_lua` is a synchronous WASM call and nothing can preempt it. See §6 |

### What Stage 0 measured

Stage 0 shipped (`index.html`, `test/stage0.spec.js`). It answers the
go/no-go below; these are the other things it turned up on the way, in
Chromium 141 against the pinned 5.4.7 artifact. Each one changes a plan
that was written on an assumption.

- **Lua errors go to stdout, and fd 2 is never touched.** `error("boom")`
  produces `Error: [string "…"]:1: boom` on **fd 1**, with `run_lua`
  returning 1. Nothing in the probe suite ever wrote to fd 2. So the
  stream split is real in the shim but decorative in practice: Stage 1
  cannot colour errors red by watching stderr, and must key off the
  non-zero status instead.
- **`init_lua()` is not a reset.** Calling it a second time leaves
  `global_L` and every global intact — a variable set before the second
  call is still readable after it. Confirms restart-by-re-instantiation as
  the only true restart, so the "drop module and instance references"
  gotcha is load-bearing rather than hygiene.
- **`return `-prefixing does not produce an echo by itself.** It compiles
  (`return 1+1` gives status 0), but `run_lua` discards the chunk's
  results, so nothing is printed. The prefix only classifies a chunk as an
  expression. Getting `1+1` → `2` needs the value *printed* inside Lua —
  `table.pack` the expression, `tostring` each result, `print` them
  tab-joined — which was verified to echo `1+1` → `2`, `1,2,3` →
  `1\t2\t3`, and `nil` → `nil` without disturbing statements. Cheap, but
  it is a transform, not a prefix.
- **`print` emits one `fd_write` per argument and separator.** Output
  arrives in many small writes, so a `TextDecoder` with `{stream: true}`
  is required or a multi-byte character split across two writes decodes to
  U+FFFD.
- **Memory grows during execution and detaches every view.** One probe
  took linear memory from 128 KB to 16 MB. Any `Uint8Array`/`DataView`
  taken before a `run_lua` call is dead after it; re-derive from
  `memory.buffer` every time.
- **Nothing has to be flushed.** Output is readable the moment `run_lua`
  returns, with no `fflush` call — the shim answers `fd_fdstat_get` with
  `character_device` and *withholds* the `fd_seek`/`fd_tell` rights bits,
  which is the combination wasi-libc's `isatty()` tests for. That is the
  configuration Stage 0 ran under and the one to keep; whether a shim that
  reported stdio as a regular file would end up block-buffered was not
  measured, so do not change it casually.
- **The page needs a server.** Opened as `file://` it renders but cannot
  load the kernel — Chromium refuses `fetch` on the `file:` scheme. See
  §8: a genuinely standalone single file has to carry the 896 KB module
  inline, which is a real decision and not a detail.

---

## 2. Build or adopt

Diluvium Lab is close to what **JupyterLite** already is: JupyterLab
compiled to run entirely in-browser, WASM kernels, static hosting,
`File > New > Notebook`, console, kernel controls.

The decision is **not to adopt it now, and not to foreclose it.** The app
shell — file browser, tabs, launcher, settings — is the most expensive and
least differentiated part of what we would otherwise build. If we ever
want it, buying it beats building it. But adopting it now means writing
against `@jupyterlite/kernel` interfaces before Diluvium's own kernel
framing has settled, and that ordering is backwards.

Two hooks keep the door open at near-zero cost, and both are decided:

1. **Store `.ipynb`.** It is JSON with a published schema. It buys GitHub
   rendering, `nbconvert`, portability both directions with real Jupyter,
   and it means no one's files are stranded by a later migration. There is
   no good reason to invent a format.
2. **Shape kernel messages like Jupyter's** — `execute_request` /
   `execute_reply`, `stream`, `error`, `status`, `complete_request`,
   `is_complete_request`. This is nearly the same message set the Diluvium
   handoff already specifies for its REPL protocol (`execute`,
   `complete(buffer, cursor)`, `reset`, streamed stdout/stderr). Aligning
   them costs nothing now and turns "adopt JupyterLite" into an adapter
   rather than a rewrite.

---

## 3. This is not a detour

The Diluvium handoff lists notebook architecture as "design after kernel
framing settles". The dependency runs the other way in practice.

**The Lab is the best pressure test the REPL/kernel protocol will get, and
gaps are far cheaper to find here than in the native REPL.** Completion
semantics, streaming, restart, error framing, interrupt — a notebook
exercises all of them under real use, months before the native REPL
depends on any of it. Building against a provisional shim now and swapping
in the real protocol at Stage 3 is a sequencing win.

The Lab is also the natural home for the analysis report and the
determinism verdict. *Run cell → see the verdict* is a demo no other
notebook can give, and it is exactly the playground artifact's pitch.

---

## 4. Stages

Each stage is independently usable. Stopping after any of them leaves
something worth having.

### Stage 0 — Spike ✅ done — **GO**

One HTML file. Load `libdiluvium_wasi.wasm`, instantiate with a WASI
shim, run one hard-coded snippet, show its output.

Not the product — a **go/no-go on one remaining unknown**.

The import question was already answered (§1): 45 standard
`wasi_snapshot_preview1` imports, so a stock preview1 shim suffices. What
was left was the one that could invalidate the approach:

- **Does `setjmp`/`longjmp` work in the browser?**

**Yes. The approach holds; build Stage 1 on it.**

`pcall` catches, in a real browser, and the kernel is unharmed afterwards.
Measured in Chromium 141 against the pinned 5.4.7 `libdiluvium_wasi.wasm`,
by `index.html`, asserted by `test/stage0.spec.js`:

| Probe | Result |
| :--- | :--- |
| `print(pcall(function() error("caught") end))` | `false  …:1: caught` — status 0, ~1 ms |
| `pcall` around a VM-raised fault (`nil + 1`) | `false  …attempt to perform arithmetic on a nil value` |
| 1000 caught errors in one chunk | `caught  1000`, status 0, ~13 ms |
| uncaught `error("boom")` | status 1, `Error: …: boom` on stdout, nothing thrown into JS |
| after all of the above | `alive  diluvium (lua) 5.4`, globals intact |

Two things make this a real answer rather than a hopeful one. The
thousand-catch probe rules out a lucky single unwind — that is 1000 round
trips through the unwinder with no leak, no trap and no corrupted stack,
in 13 ms. And the harness was mutation-checked: breaking `pcall`,
miscounting the unwinder, removing the artifact, and denying exception
handling each flip the verdict to NO-GO, so the green is load-bearing.

The mechanism, for the record: the module carries a **tag section
exporting `__c_longjmp`**, and its `target_features` declares
`+exception-handling` — WASM SJLJ, exactly as the build flags promise.
That it is the *final* opcodes and not the legacy ones was verified rather
than assumed: with V8's legacy encoding switched off
(`--no-experimental-wasm-legacy-eh`), a hand-built legacy `try`/`catch`
module stops validating while `libdiluvium_wasi.wasm` still validates.

That distinction matters for the probe. Chromium 141 accepts *both*
encodings, so a probe built from legacy opcodes would pass on browsers
that cannot run the kernel at all. The page's 33-byte probe therefore uses
`try_table`/`throw`, so an unsupported browser gets a sentence instead of
a `CompileError`.

Order of operations, which is not guessable from the outside:
instantiate → `__wasm_call_ctors()` → `init_lua()` → `run_lua(ptr)`, with
the code string written into `memory` via the exported `malloc`. Keep that
order — though see §1 for what it turns out actually to depend on.

Ends with a Playwright test that loads the page, runs the snippet, and
asserts on the output. That test is the harness every later stage reuses.
It asserts on the text the kernel actually printed, never on the page's
own verdict alone, which would only prove the page agrees with itself.

One repo mechanic learned here: `@playwright/test` is **pinned** to
`~1.56`, not floated. Each Playwright release demands one exact Chromium
revision, and 1.56 is the one that asks for the preinstalled 1194. A wider
range resolves to something newer and then refuses to launch.

### Stage 1 — The usable notebook

**The target to reach and then live with for a while.** Everything here
works against today's releases.

- Code and markdown cells; run cell, run all, add / delete / reorder
- Expression echo, so cells behave the way people expect
- A console pane sharing the kernel — scratch execution outside the document
- Restart kernel
- `.ipynb` load and save; file download and upload; autosave to IndexedDB
- Output caps per cell, with a "show all" escape

This is genuinely pleasant for prototyping Diluvium and asks nothing of
the runtime.

### Stage 2 — Version switching

The dropdown, and more valuable than it looks: running one notebook
against two builds is precisely what a language author wants, and no
general-purpose notebook offers it.

- GitHub Releases API, with the response cached (60 requests/hour
  unauthenticated is easy to exhaust on reloads)
- Downloaded modules cached in Cache API or IndexedDB — not a fresh
  megabyte per reload
- **Integrity checked against `SHA256SUMS.txt`**, which the Diluvium build
  already produces. The Lab fetches and executes a binary at runtime; this
  costs little and matters for a tool people paste code into
- A **capability probe**: builds older than whatever protocol we settle on
  must fail with a clear "this build is too old", never fail strangely
- Optionally mirror artifacts on aloecraft.org, which sidesteps the API
  rate limit and gives a stable fallback if GitHub is unreachable

### Stage 3 — A second kernel backend

Local `diluvium` over WebSocket, or a hosted endpoint. By now the adapter
exists, so this is additive rather than surgical. This is also where the
real REPL protocol replaces the `run_lua` shim.

A **local** kernel — connect to Diluvium running on your own machine — is
probably more useful than a hosted one and is already on the Diluvium
roadmap as the v1.2 remote REPL. No infra, no auth, no abuse surface.
On-page WASM stays the default and the thing that always works with zero
setup; other backends are escape hatches for capabilities a browser
cannot provide.

### Stage 4 — Workspace shell

Multiple notebooks, file tree, tabs, `File > New`.

**This is the JupyterLite decision point.** By then a kernel adapter
exists — the reusable part — so the bespoke work is not wasted either
way, and the choice can be made on evidence instead of prediction.

---

## 5. Decided

- Separate repository; consumes published releases, never builds Diluvium
- `.ipynb` as the storage format
- Jupyter-shaped kernel messages
- A kernel interface with one implementation behind it **from Stage 1** —
  the version dropdown, hosted mode, local mode and JupyterLite all become
  instances of one abstraction instead of four retrofits. This is the
  single highest-leverage structural choice in the project
- On-page WASM is the default backend
- `libdiluvium_wasi.wasm` is the kernel artifact

## 6. Risks and gotchas

**The pinned runtime is 5.4.7, and that is deliberate.** The Diluvium
Makefile pins the wasi-sdk container by digest, and that digest is
byte-identical between `v5.4.7_release` and current 5.5 work — so the
exception-handling lowering Stage 0 tests is produced by exactly the same
toolchain that will build the 5.5 artifacts. **The answer transfers.**

The consequence is that the pinned runtime does not have the 5.5 language
work (`switch`, compound assignment, the rewritten f-strings). Sample
notebooks in `notebooks/` must stay within 5.4.7 syntax or they fail
confusingly on first run. When a 5.5 artifact publishes, add a *second*
notebook that uses the new constructs: switching between the two is then
the natural Stage 2 demo.

**~~`setjmp`/`longjmp` is the real Stage 0 risk.~~ Retired — it works.**
Lua implements error handling with `longjmp`, and the WASM builds use
LLVM's WASM SJLJ (`-mllvm -wasm-enable-sjlj -mllvm
-wasm-use-legacy-eh=false`), which lowers onto the WebAssembly
exception-handling proposal — and specifically the *final* opcodes, not
the legacy ones. Browser support for final EH is more recent than for
legacy, so this was the risk that could have invalidated the whole
approach. **Stage 0 measured it: `pcall` catches, 1000 times in a row,
with the kernel intact afterwards.** The contingencies — a rebuild with
legacy EH, a browser floor, or getting a real linked artifact out of the
`wasm32-unknown-unknown` target — are not needed.

What survives is a **browser floor**, and it is higher than the usual one:
final EH is only in Chromium 137+ and comparably recent Firefox and
Safari. The page must therefore say so rather than fail obscurely, which
is why Stage 0's EH probe stays in the page. This is the same shape as
Stage 2's capability probe and should end up sharing its code.

**Interrupt has three tiers, and the middle one conflicts with a goal.**
- *No interrupt* (Stage 1). Honest, and fine to start.
- *Worker + SharedArrayBuffer*, which the Diluvium handoff assumes.
  SAB requires cross-origin isolation (COOP/COEP). **GitHub Pages cannot
  set those headers** — there is a service-worker workaround, but it is a
  hack — and a page opened from `file://` can never be isolated. So this
  tier is incompatible with the standalone-page goal.
- *Fuel-stepped*: run N instructions, return to the event loop, resume.
  Works everywhere, no headers, no SAB, no isolation. It is the same
  instruction-budget mechanism Diluvium wants for cooperative scheduling.
  **This is the tier that makes the standalone page work**, and a reason
  for that runtime work to land sooner.

**Hosting choice constrains the above.** Decide early whether the Lab is
served cross-origin-isolated; it is annoying to change later.

**Output volume.** One cell printing a million lines kills the tab. Cap
lines and bytes per cell from Stage 1 — cheap, and easy to forget until it
ruins a demo.

**IndexedDB, not localStorage.** 5 MB dies quickly once notebooks carry
saved output.

**Kernel restart leaks** unless module and instance references are
dropped. Each restart allocates a fresh linear memory.

## 7. Non-goals

- No Python, no Pyodide — a later experiment in the Diluvium docs, not here
- No collaboration or multi-user
- No virtual filesystem in v1
- No language server
- Do not fork JupyterLab. Adopt it whole, or not at all

## 8. Open

- Repository name, and where it is hosted
- Whether the standalone single-file page is a hard requirement or a
  nice-to-have — it is the single biggest constraint, since it rules out
  SAB-based interrupt and points at the fuel-stepped path. **Stage 0 put a
  price on it:** the page opens fine from `file://`, but Chromium refuses
  `fetch` on the `file:` scheme, so the kernel never loads. A page that
  really works from a double-click has to carry the 896 KB module inline
  as base64 (≈1.2 MB of HTML, and a re-vendoring step on every version
  bump) — which also collides head-on with Stage 2's version dropdown.
  Worth deciding before Stage 1 hardens around either answer
- Editor: a plain `<textarea>` is enough for Stage 1; CodeMirror is the
  obvious upgrade but is the first real dependency. Diluvium syntax
  highlighting exists in the browser REPL's PrismJS setup and could be
  reused
- Whether the analysis report / determinism verdict panel lands at Stage 2
  or Stage 3, and whether it uses `diluvium_compiler_wasi.wasm` as a second
  module or waits for the report to come through the kernel
