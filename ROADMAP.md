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
  expression. Getting `1+1` → `2` needs the value *printed* inside Lua.
  Stage 1 does that in `src/kernel/lua-harness.js`; see the note there on
  the trailing-expression case, which is where the difficulty actually
  is.
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

### Stage 1 — The usable notebook ✅ done

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

**What shipped, and the parts that were not obvious.**

`src/kernel/` is the interface and the one implementation behind it —
`protocol.js` (Jupyter-shaped messages), `kernel.js` (the interface and its
`capabilities`), `wasi.js`, `lua-harness.js`, `wasm-kernel.js`.
`src/notebook/` is the document, and neither half knows about the other.

- **Everything the kernel does happens inside a Lua harness chunk**, not by
  handing user code to `run_lua` directly. Stage 0 forced this: echo has to
  print from inside Lua. Having paid for the wrapper, the error path came
  free *and* came structured — an `xpcall` handler yields message and
  traceback as data, which is strictly better than scraping the `Error:`
  line back out of stdout and breaking the first time the runtime rewords
  itself. Results return through a length-prefixed record tagged with a
  per-request nonce, so a payload can contain newlines, tabs, or the
  separator itself.
- **The trailing-expression case is the whole difficulty of echo.** A cell
  of statements ending in a bare `counter` is the ordinary notebook idiom
  and plain Lua rejects it, since an expression is not a statement. The fix
  is to compile the *whole* cell with `return ` spliced in before the last
  expression — never to run the two halves separately, or a `local`
  declared earlier goes out of scope. The guard is that the prefix must
  itself be a complete chunk: without it, `for i = 1, 3 do / print(i) /
  end` splits inside the loop body and turns the first iteration into an
  early return, printing `1` instead of `1, 2, 3`. That bug reached a
  screenshot before it reached a test, which is the argument for looking at
  the thing you built.
- **Two output ceilings, not one.** The shim caps at 4 MB / 100k lines to
  protect the tab; the UI shows 200 lines behind a "show all". A single cap
  cannot do both jobs — truncating in the shim would leave "show all"
  nothing to show.
- **Restart keeps the compiled `WebAssembly.Module` and drops the
  instance.** A Module is code and owns no memory; an Instance owns a
  linear memory, and holding one is exactly how restarts leak. A test runs
  20 restarts and asserts each instance starts from a fresh memory. This
  refines the §6 gotcha, which said to drop both.
- **Markdown is rendered by ~100 lines in `markdown.js`, escaping first.**
  A notebook is untrusted input — it arrives from files and other people's
  repositories — so HTML is escaped before anything else happens and only
  `http(s)`/relative links survive. A real markdown library would be the
  project's first vendored dependency; that trade can be made when someone
  wants tables.

95 tests, all driving the real page and the real kernel.

### Approachability pass ✅ done

Not a numbered stage. Notebooks are the onramp to Diluvium, so a set of
first-afternoon papercuts got fixed together.

- **Tables show their contents.** `tostring({1,2,3})` is `table: 0x1f2e0`,
  which is where a language starts to feel hostile. The **echo** renders
  the value instead — sorted keys, capped depth and width, cycles reported,
  `__tostring` honoured. `print` is deliberately left alone: a notebook
  that quietly redefined it would teach something that stops being true in
  the terminal. Output containing `table: 0x…` gets a one-line nudge
  pointing at the echo instead.
- **Errors carry a plain-English hint**, under the runtime's own message
  and never replacing it. A wrong guess costs one confusing sentence; a
  rewritten error costs the ability to search for it.
- **Tab indents**, Shift+Tab dedents, Enter keeps the indentation and adds
  one inside a block. Edits go through `execCommand('insertText')`, which
  is deprecated and is still the only way to edit a textarea without wiping
  its undo stack. Escape then Tab still moves focus, so a keyboard user is
  never trapped in a cell.
- **Completion is reachable at last.** The kernel has answered
  `complete_request` since Stage 1 and nothing asked it. Now Ctrl+Space
  asks, and so does typing `.` or `:` after a name — the second is the one
  that teaches, since `string.` shows the library without a reference.

Four bugs worth recording, because three of them were invisible to a test
that only checked the happy path:

- **The single-line trailing expression.** `local t = {3,1,2}
  table.sort(t) t` failed with `syntax error near <eof>`. Echo split
  candidates were newline positions only; they are now every token start,
  walked from the end. The prefix-must-compile guard still rejects splits
  inside a block.
- **The traceback leaked the harness.** Frames below the user's stack
  showed the generated chunk — `[string "local __N = "DL7dfe…""]:137` —
  nonce and control characters included. It looked like the reader's
  mistake. Cut at the `xpcall` frame, which is exactly the boundary
  between their stack and ours.
- **Completion raced the typist.** The `.` trigger fires mid-typing and the
  kernel round trip can land between two keystrokes, so filling in a shared
  prefix produced `inventory.apap`. Only an explicit Ctrl+Space may change
  the text now; auto-open only shows.
- **The popup always rendered empty**, because `_open()` called `close()`
  and `close()` cleared the match list first.

**`return f()` is a tail call, and an infinite one hangs the tab.** Lua
reuses the frame, so it never overflows the stack — it loops forever, and
`run_lua` cannot be interrupted. A test written with `return f()` froze the
browser outright; `1 + f()` overflows properly and is what the suite uses.
This is the sharpest argument yet for moving the kernel into a Worker: it
would not make the loop interruptible, but it would keep the page alive.

### Stage 2 — Version switching ✅ done

The dropdown, and more valuable than it looks: running one notebook
against two builds is precisely what a language author wants, and no
general-purpose notebook offers it.

- ~~GitHub Releases API~~ — **not reachable from a browser, see below**
- Downloaded modules cached in IndexedDB — not a fresh megabyte per reload
- **Integrity checked against `SHA256SUMS.txt`**, which the Diluvium build
  already produces. The Lab fetches and executes a binary at runtime; this
  costs little and matters for a tool people paste code into
- A **capability probe**: builds the adapter cannot drive fail with a clear
  sentence, never strangely
- ~~Optionally mirror artifacts on aloecraft.org~~ — **required, not
  optional**

**The finding that reshaped this stage: GitHub release assets carry no
CORS header.** `release-assets.githubusercontent.com` serves the bytes with
no `Access-Control-Allow-Origin` at all — checked against the real
`v5.4.7_release` asset, full header dump, nothing there. A browser
therefore cannot read a release asset cross-origin however public it is.
`scripts/fetch-runtime.sh` keeps working because curl has no origin to
violate. So the mirror is not a rate-limit convenience; it is the only way
this dropdown can exist.

That turns out to be the better architecture regardless. A mirror sidesteps
the 60-requests-per-hour limit, survives GitHub being unreachable, and —
the part that matters most today — can carry builds that never got a GitHub
release asset. **Only `v5.4.7_release` publishes `libdiluvium_wasi.wasm`.**
Nineteen tags exist, `v5.5.0` and `v5.5.1_rc1` among them, and none of the
others has the artifact attached. Until that changes the dropdown honestly
shows one entry, and the 5.5 demo this stage was meant to enable is waiting
on Diluvium's release job rather than on the Lab.

`scripts/build-mirror.sh` builds it: downloads, verifies against the
published checksums, skips tags with no artifact, writes `index.json`. The
host has to do exactly one thing — `Access-Control-Allow-Origin: *` — and
nothing else: no API, no redirects, no auth. The contract is in the README.

Order of operations is the part worth getting right: **fetch, verify,
probe, and only then swap.** A build that fails any of the first three
leaves the running kernel exactly where it was, so trying a version can
never be how a session is lost. Tests cover a flipped bit, a missing
`SHA256SUMS.txt`, a valid module exporting nothing, bytes that are not wasm
at all, an unreachable mirror and a mirror serving the wrong shape — each
asserting the old kernel still runs afterwards.

The page still makes **no request at load**: checking for versions is a
button, which is what that hard constraint requires.

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
- **The served page is the source of truth; the single file is a build
  output.** Decided at Stage 1, once Stage 0 had priced it. The page uses
  ES modules and fetches the kernel, so it needs a static server — any
  static server, including `npm start`. `npm run bake` emits
  `dist/diluvium-lab.html` with every module flattened and the kernel
  inlined as base64, for the double-click case.

  This amends the "openable directly" constraint rather than ignoring it,
  and the constraint's own escape clause is the reason it survives: the
  un-bundled page keeps working, and it is the thing being developed. The
  alternative — inlining from the start — would put 1.2 MB of base64 in
  git, add a re-vendoring step to every version bump, and collide head-on
  with Stage 2, since a dropdown that downloads releases cannot work from
  `file://` at all. `bake.mjs` is deliberately not a bundler: it resolves
  the module graph, concatenates it, strips the import/export syntax, and
  **stops** rather than guessing at anything it does not understand.
  `test/bake.spec.js` opens the output over `file://` and runs a cell,
  which is the only proof that counts

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

**An infinite tail call hangs the tab, and no cap helps.** `local function
f() return f() end f()` never overflows: Lua reuses the frame for a tail
call, so it is an infinite loop, not a runaway stack. It produces no
output, so the output ceiling never trips, and `run_lua` cannot be
interrupted — the only way out is closing the tab. Measured, not theorised:
it froze a test browser. Nothing in the Lab can fix this; a Worker would
keep the *page* responsive while the kernel span, which is the strongest
practical reason to move it there.

**IndexedDB, not localStorage.** 5 MB dies quickly once notebooks carry
saved output.

**Kernel restart leaks** unless instance references are dropped. Each
instance allocates its own linear memory, so one held reference is one
leaked memory. *Refined at Stage 1:* the compiled `WebAssembly.Module` is
the exception and is deliberately cached — it is code, owns no memory, and
recompiling ~900 KB per restart is latency for nothing.

## 7. Non-goals

- No Python, no Pyodide — a later experiment in the Diluvium docs, not here
- No collaboration or multi-user
- No virtual filesystem in v1
- No language server
- Do not fork JupyterLab. Adopt it whole, or not at all

## 8. Open

- Repository name, and where it is hosted
- ~~Whether the standalone single-file page is a hard requirement~~
  **Decided at Stage 1 — see §5.** The served page is the source of truth;
  `npm run bake` emits a single double-click-able file alongside it
- ~~Editor: a plain `<textarea>` is enough for Stage 1~~ **Answered.** It
  still is a `<textarea>`, with a highlighted `<pre>` underneath it and the
  text painted transparent. Native editing survives — undo, IME, mobile
  keyboards, screen readers — which a contenteditable would have cost.
  CodeMirror remains the obvious upgrade and remains a real dependency
  needing a real bundler; nothing here forecloses it. The tokenizer takes
  its keyword set **from the running kernel**, probed by offering a
  candidate superset and testing each word as an identifier, so a build
  that adds `switch` colours `switch` with no edit here
- Whether the analysis report / determinism verdict panel lands at Stage 2
  or Stage 3, and whether it uses `diluvium_compiler_wasi.wasm` as a second
  module or waits for the report to come through the kernel
