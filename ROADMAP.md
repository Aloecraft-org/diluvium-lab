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

### Bytecode viewer ✅ done

Not a numbered stage. `src/analysis/` reads compiled Diluvium and shows it,
per cell, next to the code it came from.

**The container is Lua 5.4's with one deliberate difference: `LUAC_FORMAT`
is `0x44` (`'D'`), where stock Lua writes `0` and refuses anything else.**
So Diluvium bytecode and PUC-Rio bytecode are not interchangeable by
design, even though the layout is otherwise identical.

Two things about nested functions were reverse engineered from the
artifact, because no document was available:

- **Every function is prefixed by one byte stock Lua does not write.**
- **When that byte is 1, the instruction bytes and the string constants are
  stored XORed with `0xbe`,** and those constants store their exact length
  rather than length + 1. The debug section of the same function is *not*
  transformed — local and upvalue names read plainly.

The evidence: `function(a) return a end` as a nested function stores
`f6 be bc be 79 be bf be`, which XORs to `RETURN1 0 2` / `RETURN0 0 1` —
exactly what the same source produces at the top level, where the flag is 0
and the bytes are plain. `04 85 ce cc d7 d0 ca` is a short-string constant
whose five content bytes XOR to `print`. A 31-sample corpus parses
stripped and unstripped, 64/64, and the disassembly agrees with
`diluvium_generate_report` on function count, parameter counts and which
call sites are tail calls — two completely different routes to the same
facts.

#### The flag byte, answered (2026-08-08)

It is **`Proto::is_encrypted`**, set in the compiler and written per
function by `dumpFunction`. The scrambler is one byte-level XOR with
`0xBE` applied to instruction bytes and to string-constant bytes alike.

Worth recording that this is *not* a 32-bit word key. An earlier draft
XORed instruction words with `0xCAFEBABE`; the shipped 5.4.7 does not, and
the byte pattern is how you tell — a 32-bit `0xCAFEBABE` on a
little-endian word leaves `be ba fe ca`, while every sample here reads
`f6 be bc be`, `0xbe` in all four positions.

Three things follow that the Lab should keep saying out loud:

1. **The distribution is an uninitialised variable.** *Corrected later,
   once the 5.4.7 source was to hand — the first version of this entry
   guessed at a rule and there is not one.* `~function` exists in 5.4.7
   and sets `LexState::encrypted_flag`, which the next `addprototype`
   consumes and the subtree inherits. But 5.4.7's `luaX_setinput`
   initialises every other LexState field and not that one, and LexState
   is a stack local. So a chunk with no `~` in it still marks its first
   nested function and everything inside it — measured identically from
   the WASM build and from a native build of the same tag, which is what
   makes "uninitialised" the explanation rather than a rule not yet
   worked out. 5.5 adds the one missing line.
2. **The string-size asymmetry is load-bearing.** Stock Lua stores
   length + 1 precisely so 0 can mean "no string"; the scrambled branch
   stores the length exactly and spends that. Both sides agree today —
   round-tripping `local x = ""` through `string.dump` and `load` in the
   running kernel yields `""`, not nil — but they agree by having been
   written together, not because anything checks. A tidy-up of
   `dumpString` that "fixes the inconsistency" breaks the loader silently.
3. **A change of key needs a change of `LUAC_FORMAT`.** Nothing
   authenticates the code section, so a chunk written with one key and
   read with another does not fail: it decodes to garbage instructions and
   the VM runs them. The format byte is already `0x44` rather than `0`, so
   the mechanism for refusing a mismatch exists and costs one increment.

`readChunk` still verifies its own output — the parse must consume every
byte and every opcode must exist — and throws rather than producing a
plausible disassembly of a format it has misread. That check was written
when the flag was a mystery, and it stays now that it is not: it is what
turns the next format change into an error message.

#### Reading 5.5 as well ✅ done

It turned the next format change into an error message about a week
later. Diluvium 5.5 rebased onto Lua 5.5 and the container moved:

| | 5.4 | 5.5 |
| :-- | :-- | :-- |
| varint terminator | high bit **set** on the last byte | high bit **clear** on the last byte |
| integer constants | raw 8-byte little-endian | zigzag varint |
| strings | inline, every time | interned: `size 0` means "reuse #n" |
| `source` | first field of a function | after the nested protos |
| vararg | its own byte | bits 0–1 of a `flag` byte |
| code section | packed | aligned to 4 first |
| `abslineinfo` | pairs of varints | aligned pairs of raw int32 |
| opcodes | 83 | 85, and renumbered |
| scramble covers | code and string constants | code and *every* string |

None of those is detectable from the bytes; the version byte in the
header is the only thing that says which set of rules applies. So
`src/analysis/luac.js` dispatches on it into one of two profiles, and
`src/analysis/opcodes.js` carries two instruction tables with **no
default** — `decodeInstruction` takes the set as an argument, because
`SHRI` and `SHLI` swapped opcode numbers and a wrong guess disassembles
into confident nonsense rather than into an error.

Verification is the part worth recording. The Lab never builds Diluvium,
but a container reader checked only against its author's reading of
`ldump.c` is not checked at all. So the 5.5.1 source was compiled to a
native interpreter once, `scripts/make-bytecode-fixtures.lua` dumped 21
real chunks with it, and `test/fixtures/bytecode-5.5.json` holds the
bytes. `test/bytecode-5.5.spec.js` parses all of them stripped and
unstripped. Regenerating that file is the documented way to re-verify
against a new release.

Two things fell out of having real 5.5 bytes to hand:

- **The 5.4.7 latch is gone, and it was an uninitialised field.**
  `~function` was never new — it is in 5.4.7 too. What 5.5 adds is
  `llex.c:198`, `ls->encrypted_flag = 0;`, the one line 5.4.7's
  `luaX_setinput` was missing. A 5.5 chunk with no `~` in it has no
  secure functions; the same source on 5.4.7 has a secure subtree. Both
  are pinned in test/bytecode-dialects.spec.js.
- **A secure function does not hide a literal it shares with a plain
  one.** `dumpString` consults the saved-string table before it checks
  whether it is inside a secure function, so an already-written string is
  emitted as a bare index and the only stored copy is the plain one. And
  since a function's own constants are dumped before its nested protos,
  any literal shared with the enclosing function is *always* the plain
  copy. Confirmed against the real build: `"shared-secret"` used in both
  the main chunk and a `~function` appears in the dump verbatim. It loads
  correctly — this is a confidentiality gap, not a correctness bug — but
  the feature reads stronger than it is. Pinned in
  test/bytecode-5.5.spec.js so a release that fixes it is noticed.

**The Lab cannot yet *run* 5.5.** This is the bytecode reader only. A 5.5
kernel needs `libdiluvium_wasi.wasm` published for a 5.5 tag, and the
version dropdown needs the mirror to index it.

### Keywords that are not reserved words

The highlighter takes its keyword set from the running kernel, and until
5.5 that was a solved problem: offer a candidate superset, try each word
as an identifier, and whatever fails is reserved. 5.4.7 answers with
stock Lua's 22.

5.5 breaks that probe on purpose. `switch`, `defer`, `with` and `global`
are **contextual** keywords — recognised at the start of a statement and
left as ordinary identifiers everywhere else, so that a program with a
variable called `switch` keeps working. `LUA_COMPAT_GLOBAL` de-reserves
`global` specifically to get it into the same category. So `local switch
= 1` compiles on 5.5.1, and the identifier probe concludes, correctly and
uselessly, that `switch` is not reserved.

The fix is a second probe that compiles a snippet which only parses if
the word is a statement keyword — `switch x do end`, `defer do end`,
`with x = 1 do end`, `global x = 1`. Each was checked both ways against
real builds: all four compile on native 5.5.1 and none compiles on the
vendored 5.4.7, which is pinned in test/highlight.spec.js because a
snippet that accidentally parsed on 5.4 would colour a word that build
treats as a name.

This is the first place the Lab has had to know any 5.5 *grammar* rather
than just ask the kernel questions. That is the cost of a keyword that is
not a reserved word, and it is worth stating plainly: **a language
feature the kernel cannot be asked about is a feature the Lab has to be
told about.** If a future build can name its own contextual keywords —
even a plain list in a `diluvium` table — this list goes away and the
probe becomes exact.

Completions are unaffected: they enumerate `_G` in the live kernel, so
new stdlib names arrive with no change here.

Compiling is not running: the panel loads and dumps the chunk and executes
nothing, which is what makes "paste bytecode someone sent you" a safe thing
to offer.

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
- ~~What the per-function flag byte in compiled chunks means~~ **Answered
  2026-08-08 — see the Bytecode viewer section.** `Proto::is_encrypted`,
  with a one-byte `0xBE` XOR over instruction and string-constant bytes.
  Which functions carry it still looks unintentional, and that is a
  question for the compiler rather than for the Lab
- **How the Lab learns a release's language, ahead of 5.5.1.** Keywords
  and globals are probed from the running kernel and need no edit here.
  New *syntax* does: the tokenizer in `src/notebook/highlight.js` knows
  Lua's lexical shape, so a new operator or string form would need a rule.
  A build that could name its own reserved words — a `diluvium.keywords`
  table, or any documented list — would turn the probe from guess-and-check
  into a lookup, and is the cheapest coupling available

### Stage 2, against the real mirror ✅ done

`diluvium.aloecraft.org/release/` is up, and three things about it were
not what the Lab had assumed:

- **The path is `/release/`, singular.** `DEFAULT_MIRROR` said
  `/releases/`, and `versions.spec.js` carried its own copy of the
  constant, so the copy would have failed rather than the code. It
  imports the real one now.
- **The index is `releases.json`, not `index.json`,** and richer than the
  shape here: `name`, `published_at`, `prerelease`, and a full asset list
  with `size` and `sha256` per file. `index.json` stays as an alias, since
  that is what earlier `scripts/build-mirror.sh` output wrote.
- **Every release already carries per-asset checksums,** so a mirror
  serving only an index is verifiable.

Which makes the checksum a question of *sources* rather than a lookup.
There are now three — `SHA256SUMS.txt`, `BUILDINFO.txt`, and the index —
and rather than take the first one found, the Lab collects every claim and
**refuses when they disagree**. A half-updated mirror is a normal failure,
and resolving it by preference order would mean picking which binary to
execute on no evidence. Preference order only decides which of several
*agreeing* sources is quoted.

One heuristic remains, and it is pinned in a test against the real index:
the dropdown label comes from `name` ("Diluvium 5.5.1_build1"), because no
rule applied to the tag alone turns both `v5.4.7_release` into `5.4.7` and
`v5.5.1_build1` into `5.5.1_build1`. `name` matches BUILDINFO.txt's own
`version` field for both.

**Not verified against the live host.** This session's environment blocks
egress to `diluvium.aloecraft.org` — `403` on CONNECT, from the proxy, for
curl and WebFetch alike — so the published `releases.json` is committed
under `test/fixtures/` and served locally instead. That checks the shape,
which is what was most likely to be wrong, and not the transport or the
CORS headers, which still need one `curl -sI` against the real host.

**`v5.5.1_build1` publishes `libdiluvium_wasi.wasm`.** Re-pinning `vendor/`
and running 5.5 in the page needs only that download plus `pinnedLabel` in
`src/app.js`, both blocked on the same egress.

### Pinned to 5.5.1_build1 ✅ done

The mirror's egress was allowlisted, so the 5.5.1 kernel could finally be
downloaded, verified and run rather than reasoned about. All three
checksum sources — `releases.json`, `SHA256SUMS.txt` and the bytes —
agree, the capability probe passes, and the module carries the same 45
`wasi_snapshot_preview1` imports and the same exports as 5.4.7. `vendor/`
is now `v5.5.1_build1` and `scripts/fetch-runtime.sh` defaults to it,
pulling from the mirror rather than GitHub because GitHub does not attach
the artifact to that tag.

**The suite passed 251 of 263 on the new kernel before anything was
changed.** Of the twelve failures, eleven were tests asserting 5.4-ness —
a keyword count, a dropdown label, a version byte — and one was a real
bug:

- **`cleanTraceback` stopped cutting.** It matched the literal phrase
  `[C]: in function 'xpcall'`; 5.5 writes `[C]: in global 'xpcall'`, so
  the harness frame started leaking back into user-facing tracebacks. Not
  a crash — a quiet regression in exactly the thing that pass was for. It
  now matches on the name, and drops the `(...tail calls...)` frame 5.5
  reports directly above it, but only the trailing one: a tail call
  further up the stack is the user's own.

The rest of the churn was structural and worth doing anyway. Container
assertions used to run against whichever kernel happened to be pinned,
which meant re-pinning silently dropped coverage of the other dialect.
They now run against committed dumps from native builds of **both** tags
(`test/bytecode-dialects.spec.js`, `test/fixtures/bytecode-5.{4,5}.json`),
and `test/bytecode.spec.js` keeps driving the live kernel with assertions
that hold either way.

End to end, in one page: switching from the bundled 5.5.1 to a real 5.4.7
takes the keyword set from 26 to 22, stops colouring `switch`, runs a cell
that prints `diluvium (lua) 5.4`, and flips the bytecode viewer to the 5.4
container. Nothing about that is configured; it all follows the kernel.

~~**Still outstanding: the mirror sends no `Access-Control-Allow-Origin`.**~~
**Fixed on the host, confirmed 2026-08-11.** `releases.json` now answers
with `access-control-allow-origin: *`, `access-control-allow-methods: GET,
HEAD, OPTIONS`, `cross-origin-resource-policy: cross-origin` and
`cache-control: public, max-age=300`. That was the last thing between
Stage 2 and the real host, and nothing in the Lab had to change for it.

What has *not* moved is the artifact list: the index is still
`generated_at 2026-08-08` with two releases, `v5.5.1_build1` and
`v5.4.7_release`, while `v5.5.1_build2` and `_build3` are published on
GitHub.

**And `scripts/build-mirror.sh` would not have fixed that, because it
carried a hardcoded `DEFAULT_TAGS=(v5.4.7_release v5.5.1_build1)`.** Its
own comment said "add to this list as releases appear"; nobody did, and
the script went on printing `wrote releases.json with 2 release(s)` long
after there were four. A mirror that is silently a subset is worse than
one that fails, because the dropdown looks complete — this is the same
class of defect as a stale module graph, and it took the same shape:
success reported against an input nobody re-checked.

**The first fix for that was also wrong, and in a more interesting way.**
Tags were discovered with `git ls-remote`, filtered by whether they
publish the artifact, and `prerelease` was guessed from the tag's
spelling. That produced four releases where there had been two — and one
of the four was `v5.5.1_build3`, whose own release notes say *"the release
mirror does not carry this one"*, labelled `prerelease: false` because the
name has no `rc` in it.

Both versions were the same mistake: inventing an answer upstream already
publishes. **`changelog.json` at the Diluvium repository root carries
`mirror_tags`** — the exact set — plus `latest`, and a per-release
`stable` flag that `CHANGELOG.yaml` calls "the truth", noting that
GitHub's own prerelease flag is *derived* from it. The script reads that
now, with node rather than jq (this repo already requires node and does
not require jq, and a mirror script that dies without jq dies exactly when
someone is trying to publish). The result is `v5.5.1_build2`,
`v5.5.1_build1`, `v5.4.7_release`, and `latest: v5.5.1_build2` — which is
what upstream says, rather than what the tag list happens to contain.

The thin-index problem was real and is fixed: the script emitted no
`version` and no `assets[].sha256`, so uploading its output would have
cost the Lab its cross-check, which compares the index's claimed checksum
against `SHA256SUMS.txt` and refuses a build where the two disagree. One
source cannot disagree with itself. `test/fixtures/releases-built.json` is
a verbatim capture of a real run, pinning that shape the way the published
index's already was.

**The published mirror is behind, and no change here fixes it.** The live
index is stamped `2026-08-08T04:01Z`; `v5.5.1_build2` was published at
`09:44Z` the same day. So the mirror does not carry the build its own
changelog marks `latest` and `mirror: true`. Regenerating it does.

### The kernel moved off the main thread ✅ done

The single worst thing about the Lab in public: `while true do end` in a
cell froze the whole tab, with no recovery but closing it and losing the
notebook. `run_lua` is a synchronous WASM call and nothing preempts it, so
there was no fix on the main thread — only somewhere else to put it.

`src/kernel/worker-kernel.js` is a `Kernel` that owns a Worker;
`src/kernel/kernel-worker.js` is the far side, and it owns a real
`WasmKernel` and forwards to it. That split matters: "in the page" and "in
a worker" are the same kernel rather than two implementations that drift.
The whole port fit behind `src/kernel/kernel.js` — `app.js` needed one
changed constructor call, which is the seam paying for itself.

**A worker does not make the call interruptible; it makes it survivable.**
The frozen thread is no longer the one painting the page, and
`terminate()` is an immediate unconditional stop. That is the entire win
and it is a large one. What it costs is the Lua state: this is not
Jupyter's interrupt, which unwinds and leaves your variables alone. So
`capabilities.interrupt` is true and `capabilities.interruptLosesState` is
true beside it, the control says **Stop** rather than Interrupt, and the
console says what it cost afterwards. CLAUDE.md's rule about not implying
an interrupt tier that does not exist cuts both ways.

Where a worker is impossible it falls back to running in the page and says
so — `offThread`, `fallbackReason`, `interrupt: false`, and a disabled
button rather than an inert one. That is the baked `file://` build, whose
opaque origin browsers refuse to start workers from. It already trades
runtime switching away for a related reason (no secure context, so no
checksums), and a Stop button that silently did nothing would be worse
than none.

**The bug this nearly shipped with is worth recording.** The first version
worked, passed the entire suite, and was running in the page the whole
time. The worker resolves `wasmUrl` against its own base — `/src/kernel/`
— so `vendor/libdiluvium_wasi.wasm` 404'd there, the fallback caught it,
and every test still passed because the fallback is fully functional. The
only symptom was that stop did nothing. `test/worker.spec.js` now asserts
`offThread` explicitly and prints `fallbackReason` when it fails, because
a silent fallback is the failure mode this design has.

### Public-readiness pass ✅ partly done

Ahead of putting the Lab somewhere strangers can find it. What landed,
and what deliberately did not.

**CI exists** (`.github/workflows/ci.yml`): one job, Chromium, plus the
bake and a new `scripts/check-bake.mjs` that asserts the single file is
genuinely self-contained. That check is not decoration — a stray
`<script src>` or an un-inlined kernel still renders, and only fails on a
machine with no network, which is the machine the baked file exists for.
Verified it catches both an injected CDN tag and an emptied kernel
constant. Firefox and WebKit are a matrix entry once the Lab is known to
pass on them, which is what the browser-check notebook is for.

**Mobile is no longer untested**, and four things were wrong: 24px touch
targets against a 44px floor, a 14px editor that makes iOS zoom in on
focus and never back out, a cell toolbar revealed by a hover that a touch
screen cannot perform, and outputs indented to line up under a prompt,
spending a third of a narrow screen on alignment. `test/mobile.spec.js`
drives a real phone viewport with touch and taps rather than typing
shortcuts. Note the media queries had to move to the end of the
stylesheet: they share selectors with the base rules, so the cascade
decides on source order and a media query adds no specificity — the first
attempt set 16px and computed 14.08px.

**Accessibility, the easy half only.** Icon-only buttons had a `title` and
no accessible name. Output regions now announce politely, having been
silent. The highlight overlay is `aria-hidden` — it is the textarea's text
a second time, and the copy is the one that cannot be edited or navigated.
Status and toasts are status regions; animation honours
`prefers-reduced-motion`. **Not done, and still owed:** focus management
across add/delete/run/restart, cell-level navigation ("cell 3 of 7"), and
a contrast audit of both themes.

**Persistence has a safety net** (`test/storage.spec.js`), and writing it
turned up a real gap: autosave is debounced 400ms and nothing flushed it
on the way out, so the last thing typed before a tab closed was the one
thing lost. `visibilitychange` → `hidden` is now flushed, chosen over
`beforeunload` because a backgrounded phone tab can be discarded without
ever firing an unload event. Covered: typing then reload, reload with no
time to debounce, outputs and execution counts, the filename, cell
add/delete, a corrupt record, IndexedDB unavailable, a failing write.

**`notebooks/browser-check.ipynb`** is the instrument for the engines
nobody here can run: open it, Run all, read the PASS/FAIL lines. Its most
important section is `pcall`, because if WASM exception handling is
missing then `pcall` silently stops catching and every other check still
passes. `test/browser-check.spec.js` runs the notebook itself and asserts
nothing prints FAIL — and asserts the `pcall` check has teeth by running
its logic against a deliberately broken `pcall`.

**Still open, and named so they are not mistaken for done:** the
JupyterLab story (a Lab `.ipynb` opens there and cannot run; a leading
markdown cell explaining that on export is the cheap fix, and it needs a
decision about round-tripping), `CONTRIBUTING.md`, the first-run
notebook, `<diluvium-cell>`, and the VS Code path — which is downstream of
the JupyterLab one, since VS Code's notebook editor reads the same
kernelspec.

### Saying which build this is ✅ done

**About** in the toolbar. It exists for bug reports: "it does not work" is
unactionable, and nobody should have to be talked through finding a
version. It states the Lab's version and commit, the Diluvium tag,
version, commit, build date and **sha256**, what the kernel reports about
*itself*, whether it is running off-thread, the notebook format and the
browser — and hands over a block to paste.

Two rules made it worth building rather than decorative. Every value is
read from the thing it describes: the kernel is asked for `_VERSION`
rather than trusting a constant, and the runtime reports its own tag and
checksum, so switching runtimes changes the panel. And the tests check the
facts are *true* rather than merely present — `test/about.spec.js`
compares the panel against `vendor/PINNED_TAG` and `vendor/pinned.js`, and
separately asks the running kernel what version it is and requires the
panel to agree. A version display that is confidently wrong is worse than
none, because it sends the reader to the wrong build.

`vendor/pinned.js` is generated by `scripts/fetch-runtime.sh` from the
release's own BUILDINFO.txt. A module rather than a file to fetch, so the
page states what it runs with no request and no parsing. Its export is
`BUNDLED` and not `PINNED` because `runtimes.js` already exports a
`PINNED` — the bake's duplicate-top-level-name guard caught the collision,
for the second time in this project's life, which is a reasonable argument
that the guard earns its keep.

#### On version schemes

Recorded because it came up and the answer is not obvious.

`v5.5.1_build1` has two problems. The small one: it is not semver, so
nothing sorts it — the Lab already has to derive a display name from the
release `name` field because no rule applied to the tag works for both
`v5.4.7_release` and `v5.5.1_build1`. Making the suffix legal fixes that
almost for free: **`v5.5.1-build.2`**, with a hyphen and a dot, sorts
correctly and orders before `5.5.1` as a pre-release should. Numeric
identifiers compare numerically, so `build.10 > build.9`.

The larger problem is that `build` is the wrong word. `build1` and
`build2` differ in *source* — build2 changes the obfuscation — so they are
pre-releases, not rebuilds of one source. `-rc.N` says what is happening.

And underneath both: **Diluvium is using Lua's version as its own.** That
works until Diluvium ships something Lua did not, which it already has —
`~function`, the contextual keywords — and then there is no number to bump
and the change has to be smuggled into a suffix. The durable fix is to
give Diluvium its own semver and record the Lua it tracks as metadata,
which semver ignores for ordering: `1.4.0+lua.5.5.1`. That is a bigger
change and belongs at a major boundary, not mid-flight.

Whichever is chosen, the cheapest improvement is for the release job to
publish the parts **separately** rather than encoding them in a string:
`releases.json` and BUILDSTATS.json already carry `version` and `commit`,
and adding explicit `lua_version` and `channel` fields would retire the
Lab's last parsing heuristic outright.

##### What was done about it, and what was deliberately not

Nothing was renamed. **No published tag may be renamed** — its checksums,
the mirror layout, `vendor/PINNED_TAG` and the committed bytecode
fixtures all point at it, and a rename breaks four things to fix a
cosmetic one.

What did land is the tolerant half, which is Lab-only and needs no
coordination: `compareVersions` in `src/kernel/releases.js` understands
**both** shapes and the registry now sorts with it instead of trusting the
order the mirror happened to write. So the version dropdown is correct
today with `_buildN` tags, correct afterwards with semver, and correct
during the overlap when the mirror carries both. The rules it encodes:

- `_release` marks the final build, so `5.4.7_release` == `5.4.7`.
- A final release outranks every pre-release of the same version, whether
  spelled `_buildN` or `-rc.N`.
- Numbers compare as numbers, so `build10 > build2` — the trap in the
  current scheme, since string order puts `10` first.
- Everything after `+` is ignored, which is what would make
  `1.4.0+lua.5.5.1` a safe way to carry the tracked Lua version.

Doing the consumer first is the point. The producer can change whenever
Diluvium is ready, in its own repository, on its own schedule, and nothing
here has to be timed against it.

### Startup fails loudly now ⚠️ partly diagnosed

Reported from the deployed site: no syntax highlighting, and an empty
runtime dropdown. Chrome and Firefox fine; Chromium, Opera and Brave not;
and fine locally under `npm start`.

**The empty dropdown was the useful clue.** `entries()` returns the
bundled runtime unconditionally, so an empty `<select>` cannot mean "found
no runtimes" — it means `_renderVersions()` never ran. And in the old
`start()` that method sat after `_setModel` and `await kernel.start()`
with nothing guarding either, so anything that threw *or hung* in those
left a page with no dropdown, no `data-ready`, and no explanation.

That hole is now closed regardless of what caused it, because it is a bug
on its own terms: each phase is guarded separately, `_renderVersions()`
and `data-ready` happen whatever else failed, the kernel start has a
30-second timeout so a hang becomes an ordinary error, and the problems
are toasted, logged and listed in About. `test/startup.spec.js` covers
kernel-cannot-start, storage-blocked and workers-blocked, and asserts the
dropdown is populated in every one.

The highlighter also fails soft now. A throw in `paint()` used to
propagate out through `render()` and take the whole page with it; it falls
back to plain text and keeps every character in place, which is what the
caret position depends on. Colour is a nicety; the overlay lining up is
not.

**What has been ruled out**, by measurement rather than reasoning:

- Not the deployment. Every file the domain serves is byte-identical to
  HEAD, with correct MIME types.
- Not Cloudflare rewriting anything, for the same reason.
- Not a CSP, COOP or COEP — the responses carry none.
- Not the `/lab/` subpath. Serving the repo under `/lab/` locally, without
  the COOP/COEP headers `serve.mjs` sets, works: dropdown populated,
  highlighting present, no errors.

**What remains, and neither can be settled from here.** A real browser
could not be pointed at the live host from this environment (the egress
proxy's TLS interception is not trusted by Chromium), so the next step
needs the console output from a browser that shows it.

1. **A stale module graph from HTTP caching.** The deployed responses
   carry no `Cache-Control` and no `ETag`, only `Last-Modified`, so
   browsers apply heuristic freshness and may hold one module from before
   a deploy alongside another from after. That fits every part of the
   pattern — per-browser variation, and correctness locally where
   `serve.mjs` sends `no-store`. **The host should send
   `Cache-Control: no-cache` for `.html` and `.js`.** A hard reload in a
   failing browser confirms or eliminates this in one keystroke.
2. **A browser-version feature gap.** Chromium, Opera and Brave builds lag
   Chrome. About now reports `CSS color-mix` and `<dialog>` support
   alongside the rest, because nearly every border and muted colour in the
   stylesheet is a `color-mix()` — a build without it renders a flat,
   unstyled-looking page that still runs, which is close to what was
   described.

#### Found it: a stale module graph, caused by the CDN ✅

Measured, not inferred:

```
/lab/            no Cache-Control at all        cf-cache-status: DYNAMIC
/lab/src/app.js  Cache-Control: max-age=14400   cf-cache-status: HIT
```

14400 seconds is four hours, and it is **Cloudflare's default Browser
Cache TTL** — applied because the origin sends no `Cache-Control` of its
own. HTML is not in Cloudflare's default cacheable set, so it always
arrives fresh. The scripts do not.

So every deploy opens a window of up to four hours in which a browser runs
a **fresh `index.html` against stale modules**. That explains every part
of the report, including the parts that made no sense:

- The About button exists (fresh HTML) and does nothing (stale `app.js`
  never binds it).
- The runtime dropdown is empty and highlighting is missing — an older
  `app.js` doing older things.
- **Nothing in the console**, which was the genuinely confusing detail:
  stale modules do not throw. They just quietly lack the newer half of the
  page.
- Firefox fine, Chromium/Opera/Brave not: each browser's cache was
  populated at a different moment relative to the deploy. Nothing to do
  with the engines.
- Fine locally, because `scripts/serve.mjs` sends `Cache-Control:
  no-store`.

**The fix is on the host** — `Cache-Control: no-cache` for everything under
the Lab's path, which means revalidate rather than do-not-store, and every
response already has an `ETag`, so it costs a 304 rather than a
re-download. Behind Cloudflare that also needs Browser Cache TTL set to
*Respect Existing Headers*, or a Cache Rule disabling browser caching for
the path. See README.

**What the Lab can do about it, and now does:** `index.html` carries a
`diluvium-lab-build` meta tag, and the scripts compare it against their own
`LAB_VERSION` at startup. Disagreement is impossible unless something is
serving one of them from an older deploy, so the page says exactly that,
names both versions, and says to reload bypassing the cache.
`scripts/check-version.mjs` now keeps three sources in step —
package.json, src/version.js and index.html — because a mismatch between
*those* would show every visitor a false alarm.

It only detects a skew across a version bump, which is a real limit and an
argument for bumping the version on every deploy. It cannot fix the cause.

#### The detector was in the wrong file ✅ fixed

The build-mismatch check shipped inside `src/app.js` — the very file that
goes stale. In the one situation it existed for, it was not there to run.
That is a design error rather than a detail, and it was caught by the
thing itself failing to fire on a live stale deploy.

It now lives **inline in `index.html`**, as a plain non-module script with
no imports and no dependency on anything having worked. `index.html` is
the one file always fetched fresh, so it is the only place such a check
can survive its own failure case. It reports two conditions:

- the running code's version disagrees with the page's, or
- nothing booted at all, so there is no version to compare —

and shows a banner rather than a line in a dialog. **The version is also
printed in the toolbar now.** Putting it behind the About button was the
second half of the same mistake: the button is bound by the code that goes
stale, so in exactly the case the version matters, it cannot be reached.

Its reload button appends a query rather than calling
`location.reload(true)`, which has been a no-op for years. Only a URL the
cache has never seen actually re-fetches — measured on the live host:
`/lab/src/app.js` returned `cf-cache-status: HIT` with a 23126-byte
build, while `/lab/src/app.js?bust=…` returned `MISS` with the correct
29089-byte one.

`scripts/check-version.mjs` now keeps four sources in step: package.json,
`src/version.js`, the `diluvium-lab-build` meta tag, and the inline
constant — because that constant is what decides whether every visitor
sees a banner.

#### Versioned module URLs ✅ done

The caching diagnosis was right about the mechanism and wrong about the
remedy: "configure the CDN, purge, and reload" leaves you at the mercy of
a configuration you cannot see failing. Every deploy is another chance for
the same silent skew, and the failure mode is a clean console.

`npm run stamp` writes an **import map** into `index.html` pinning all 28
modules to `?v=<LAB_VERSION>`. A different URL is a different cache entry,
so bumping the version invalidates the whole graph atomically and no cache
anywhere can serve half a build. This is the only fix that does not depend
on the CDN behaving; CI fails if the map is stale.

Why an import map rather than a query on the entry point: static `import`
specifiers cannot be rewritten at runtime, and a query does not propagate
— a relative import inside `app.js` resolves against `/src/app.js` and
drops it. An import map remaps *resolved* URLs, and it lives in
`index.html`, which is the one file always fetched fresh. It is generated
at release time, so the un-bundled page still runs as-is from a checkout.

**The gap, stated rather than glossed:** a module worker does not inherit
the document's import map, so the kernel worker's own imports resolve
unversioned. The worker script URL is stamped by hand at its use site,
which shrinks the window to that module's dependencies, and a kernel that
misbehaves falls back to running in the page. It is smaller, not zero.

Also fixed while here: the bake stripped the import map *after* computing
the offsets of the entry script, which shifted every index and silently
corrupted the output — caught by `bake.spec.js` noticing the baked file
had started fetching `src/app.js`. It strips first now.

#### The mobile toolbar ✅ fixed

Nine controls at a 44px touch-target minimum, with `flex-wrap: wrap`,
stacked into four or five rows before a single cell was visible — a
regression introduced by the touch-target fix itself. It is one
horizontally scrolling row now: **56px, 7–10% of the viewport** on a Pixel
7 and an iPhone SE, with nothing hidden and no page-level overflow. The
title and filename are dropped at that width, since neither tells a reader
anything they do not already know.

### Visual polish: the states the UI had nowhere to hang ✅ done

The notebook worked but told you almost nothing about itself. `:focus-within`
was the only "current cell" cue, so the instant you clicked Run all,
focus left for the toolbar and nothing on the page was current. A cell
that succeeded and a cell that failed both ended as `data-busy="false"`
and no other trace. This pass gives those states somewhere to live, and
adds the one Jupyter lacks.

- **Selection, independent of focus.** `view.select(id)` tracks a current
  cell that survives focus leaving the sheet and survives a structural
  re-render. Running a cell selects it, so Run all leaves the last cell
  run highlighted. There is always exactly one current cell.
- **Run state on a left rail.** `runStateOf(cell)` derives ok / error /
  stale / busy from the model, so it is right after a reload too (an
  error output *is* the error state). A coloured strip down the cell's
  left edge reads as "this one" from across the page without a banner:
  quiet green for success, red for error, a breathing amber while busy.
- **Stale — the state Jupyter does not have.** After a Stop or a restart,
  every `In [n]` describes a Lua state that is gone; Jupyter keeps showing
  those numbers as if live. `markAllStale()` replaced `resetExecution
  Counts()` at all three sites (stop, restart, runtime switch): the count
  is *kept* — you still see what ran and in what order — struck through
  and labelled, so it cannot be mistaken for current. Running a cell
  clears its mark.
- **Folding**, stored as nbformat's own `jupyter.source_hidden`, so a fold
  round-trips to JupyterLab. Folded cells keep a one-line preview.
- **Execution timing**, written as JupyterLab's `metadata.execution` ISO
  pair, so a duration survives a save and shows up in other tools. A busy
  cell shows a live elapsed clock -- eight seconds in looks different from
  just-started, which is the difference between "wait" and "press Stop".
- **Output height** capped with in-place scroll; `⛶` lifts the cap
  full-screen via the Fullscreen API. The soft line/byte caps still bound
  what is there first.

Cell `metadata` is now carried whole through `toIpynb`/`fromIpynb` rather
than rebuilt, so tags, slideshow settings and ExecuteTime stamps from
other tools survive a round trip. `test/polish.spec.js` asserts the states
rather than the pixels; the two existing tests that asserted the old
"restart blanks the counts" behaviour were updated to the new stale
contract.

### Output that is not text: display, plots, events, controls ✅ done

Until now the Lab could show one thing: characters. Everything asked for
next — a chart, a picture, a swarm's event stream, a slider — turned out
to be the same missing mechanism rather than four features, so it was
built once.

**The mechanism is Jupyter's `display_data`, and that is not a
coincidence.** A hard constraint since Stage 1 says kernel messages are
Jupyter-shaped, and `protocol.js` has carried a one-entry mime bundle
since then with a comment saying a future `image/png` slots in without
changing the message. It did. A chart is stored in the `.ipynb` as
`{"output_type": "display_data", "data": {...}}` — the same object
JupyterLab writes — so it round-trips, and a reader that has never heard
of Diluvium still gets the `text/plain` that ships in every bundle.

#### Lua emits data; the Lab draws

The decision the whole feature rests on, and the one with a plausible
alternative. `plot.line{1,4,9}` sends `{"series":[{"y":[1,4,9]}]}`, not
SVG.

A chart built in Lua would have to know the page's theme, its width, and
its fonts. None of those is knowable from inside a kernel that cannot see
the DOM, so such a chart would be wrong in dark mode, wrong on a phone,
and stale the moment the window moved. Sending data instead means the
renderer re-runs on resize and follows `prefers-color-scheme` for free.

The second benefit was not the motivation and may be the larger one:
**the built-in display types cannot carry markup.** A notebook is
untrusted input — it arrives from files and from other people's
repositories — and this is the first feature that renders something other
than text out of one. `{"series": [...]}` has nowhere to put a script tag.
`display` still accepts `image/svg+xml` and raster images for programs
that genuinely have a picture; SVG goes through an **allowlist**
sanitiser (`sanitiseSvg`), and raster images become `data:` URIs so
nothing a notebook contains can cause the page to make a request. Pinned
in `display.spec.js` with an SVG carrying an `onload`, a `<script>`, an
`<image href>` and a `javascript:` link, asserting the circle survives and
`window.__pwned` is still undefined.

#### The parse changed shape, and had to

The harness used to emit exactly one record, always last, so "everything
before the nonce" was the user's output. A cell that can draw *in the
middle* breaks that: `print("a") plot.line{1,2} print("b")` is three
things in that order, not two lines with a picture bolted on the end.

`parseRecords` reads stdout as a sequence — text, record, text, record —
and `parseRecord` is now a thin wrapper over it, so nothing else had to
change. Records stay length-prefixed, which is what lets a payload contain
newlines, separators and the nonce itself. A record cut short by the
output cap ends the scan rather than being half-parsed into a plausible
one.

#### Where the state lives

`display` and friends have to survive between cells, and they need the
*current* request's nonce — a function that closed over the nonce it was
defined with would frame its records for a listener that had already gone
away. So the nonce, the widget table and the ownership record live in
`debug.getregistry()`, which is what the Lua registry is for, and `_G`
gets four names and nothing else.

That matters more than it sounds: a notebook where `for k in pairs(_G)`
lists the tool's own bookkeeping is a notebook that lies to you, and the
globals probe feeds completion, so anything in `_G` shows up in the popup
too. `languageInfoChunk` filters the key back out for the fallback case
where `debug` has been narrowed away.

**And the API never takes a name the program has claimed.** A slot is the
Lab's to write only if it is empty or still holds the function the Lab put
there last time, so `plot = 42` sticks, and `plot = nil` gives it back.
Four globals is four names taken from the user; this is the cheapest way
to make that not a theft.

#### Charts

`src/notebook/plot.js`, plain DOM and inline SVG like everything else.
Line, scatter and bar; one axis, never two.

The palette is not taste. Both modes' eight categorical steps were run
through the lightness-band, chroma-floor, colour-vision-separation,
normal-vision-separation and contrast checks, against this page's own
surfaces rather than a default. Two results shaped the UI:

- **Three of the light steps sit below 3:1 on white.** The rule for that
  is relief — visible labels or a table — rather than re-stepping, since
  the eight are validated as a set and moving one breaks the separation
  of its neighbours. So every chart carries a **Table** toggle, and it is
  asserted to hold the real values rather than merely to exist.
- **The dark steps are a selected set, not an automatic flip.** Slot 6 is
  the same hex in both modes and the other seven are not, which is what
  choosing per surface produces and what a filter would not.

Colour is never the only carrier of identity: two or more series always
get a legend, slots are assigned in fixed order so removing a series never
repaints the survivors, and the legend text wears the page's text colour
with a swatch beside it rather than being coloured itself.

Two data decisions worth recording because they are the ones that make a
chart honest:

- **A missing value is a gap, not a zero.** JSON has no NaN and no
  infinities, so the encoder writes `null` and the renderer starts a new
  path — `math.log(0)` in the middle of a series leaves a hole rather
  than a spike to the floor. Bridging it would draw a measurement nobody
  took.
- **A bar chart's axis always includes zero.** A line chart may crop,
  because the question there is shape; a cropped bar chart misstates every
  ratio it draws.

#### Event streams

`events{...}` renders a list in **`doc/Messaging.md` §9.2's shape
exactly** — `event`, `id`, `detail` — with its eight kinds: `spawned`,
`exited`, `faulted`, `exceeded`, `hibernated`, `throttled`, `denied`,
`status`. The severities come from the reserved status palette rather than
the chart palette, deliberately: a faulted instance must never be able to
look like series 8. Each ships with a word as well as a colour.

#### A swarm runner: what is actually in the way

The ask that started this was "run a swarm and print its events". **The
Lab cannot do that today, and the blocker is in the artifact rather than
here.** Every published `libdiluvium_wasi.wasm` was downloaded and probed
rather than reasoned about, and the answer differs by build:

| build | `dv_*` | `dvs_*` | `queue` / `endpoint` / `msgpack` | bytecode format |
|---|---|---|---|---|
| `v5.4.7_release` | — | — | — | `0x44` |
| `v5.5.1_build1` | — | — | — | `0x44` |
| `v5.5.1_build2` (pinned) | — | — | — | `0x45` |
| `v5.5.1_build3` | **all 27** | — | **all three** | `0x46` |

`build3` exports the whole instance ABI — `dv_new`, `dv_load`, `dv_run`,
`dv_resume`, `dv_snapshot`, `dv_restore`, the `dv_queue_*` and
`dv_endpoint_*` families, `dv_set_budget`, `dv_usage`, `dv_exceeded` — and
its Lua globals include working `queue`, `endpoint` and `msgpack`.
`queue.declare`, `push`, `len`, `capacity` and the non-blocking `pop` all
run in an ordinary `run_lua` state; only the blocking `queue.wait` needs a
host that resumes, which a bare state is not.

**An earlier draft of this section said the guest messaging libraries were
absent. That was true of `build1` and `build2` and false of `build3`.** On
`build3` a notebook can declare `system/events`, push §9.2-shaped records
and drain them, so the event view has a real producer rather than
hand-written samples.

**That is not a reason to pin it, and an earlier draft of this file said
it was.** `build3` is a prerelease — not for being unfinished, but
because its *supported configuration* is narrower than what it ships:
hibernation is off and should stay off, and the capability layer is a
structuring device rather than a security boundary while `debug` is
available to guests. `changelog.json` marks it `stable: false` and
`mirror: false`, and its notes say `latest` stays on `build2` for exactly
that reason. Pinning it as the Lab's default would ship every reader on a
build upstream tells you to name deliberately.

What is still missing everywhere is `dvs_*`. `src/onelua.c` in the
Diluvium tree includes `dqueue.c`, `dendpoint.c`, `dmsgpack.c` and `dv.c`
— but **`dvs.c` is deliberately not in the amalgamation**, and
`libdiluvium_wasi.wasm` is linked from `onelua.o` + `wasm_stubs.o` +
`analyze.o` + `diluvium_api.o`. `build3` is the measurement that confirms
it: the instance ABI arrived and the swarm layer did not.

What would connect them is small and is Diluvium-side, in `wasm_stubs.c`
beside `init_lua`/`run_lua`: compile `dvs.c` into the wasi target, add the
single-threaded host vtable (`test/dvs_check.c:102`, about forty lines,
`create` a no-op and `drive` one `dv_run`), and export three functions —
start a swarm from source, step it, drain the next event as msgpack or
JSON. `doc/Lab.md` §1 prices the same work for the CLI and calls it "a
host and a command, not a feature"; the browser needs the identical host
and a different three-function door.

Until then the swarm is absent but the *pipe* is not, on `build3`: the
demo notebook carries a feature-detecting cell that declares
`system/events`, pushes §9.2 records into it, drains them with the loop a
supervisor runs, and renders the result. Verified end to end against the
downloaded `build3` artifact. On an older kernel the cell says which
version added `queue` and does nothing, which is why it is safe to ship
against a pinned build that lacks it.

The hand-written records stay in the notebook above it, and the cell above
*those* says they are hand-written rather than leaving a reader to
assume. **The transport is what changes when that lands; the
renderer does not** — which is the whole reason the record shape was
copied from §9.2 rather than invented.

#### Controls

`widget.slider`, `.select`, `.checkbox`, `.button`, each taking an
`on_change` closure.

**The closure never leaves the kernel** — it cannot; it captured locals
that exist nowhere else — so the page holds an id and asks for the
function by name when the control moves. `callWidget` is that door, and it
is an ordinary run: the callback may print, may draw a chart, may fail
with a traceback, and each reports through the records that already
existed. `_report` is shared with `execute` so there is one implementation
of "what did this run produce", not two.

Three decisions:

- **It does not advance the execution count.** Nothing new was submitted;
  the same cell is answering again with a different input, and bumping
  `In [n]` on every pixel of a drag would make the numbering meaningless.
- **Calls are coalesced.** A slider fires on every `input` event and
  `run_lua` cannot be interrupted, so at most one call is in flight and
  the newest pending value replaces any older one. Without that a
  two-second drag queues forty runs and the UI finishes catching up long
  after you let go.
- **The output goes in the control's own slot, and is not saved.** A file
  should carry the result the cell produced, not the last frame of
  someone playing with a slider. What is saved is the control.
- **It fires once on render, at the value it was created with.** Added
  after looking at the thing: a cell that produced a slider and nothing
  under it reads as broken, and the reader has no way to know whether
  moving it will do anything. Not for a button, which pressing itself
  would misrepresent, and marked `auto` so the failures it can produce
  stay quiet — a notebook reopened from a file has a dead callback behind
  every control, and a warning on each would be the first thing that
  reader saw. An automatic call is also skipped once the control has been
  moved, since by then the initial value is stale information and a
  re-render firing it again would discard what was asked for.

A control whose kernel has since restarted reports `stale`, and the page
says "this came from a kernel that has since restarted" rather than
failing. That is the ordinary state of a reopened notebook, not a fault —
and where the backend cannot re-enter the program at all
(`capabilities.widgets === false`) the control renders **disabled**, on
the same principle as the Stop button: a control that moves and silently
does nothing is a worse lie than one that says it is not connected.

#### Smaller things this turned up

- **`t[[[x]]]` does not mean what it looks like.** Indexing a table with a
  long string puts the string's opening `[[` against the index's `[`, and
  Lua lexes the run greedily: `unexpected symbol near ']'`, pointing at
  the wrong end of the expression. `widgetChunk` writes
  `__S.widgets[ [[id]] ]` and the spaces are load-bearing.
- **`el` moved to `src/notebook/dom.js`.** Charts are reached *from*
  `ui.js` and need the same helper, so importing it back out of `ui.js`
  would have made a cycle that happens to work — a worse thing to leave
  behind than a four-line module.
- **`Number(null)` is `0`, and that made a gap into a real zero.** The
  encoder wrote `null` for a NaN correctly and `normaliseSeries` coerced
  it straight back to a value on the axis — so the one thing the gap
  handling exists to prevent was happening in the renderer instead. Caught
  by the test that asserts two paths and got one. `null`, `undefined` and
  `''` are now rejected before `Number` sees them.
- **A control returned its id, and the cell echoed it.** `widget.slider{}`
  as a cell's last expression printed `Out[3]: w1` under the control every
  time — the Lab's own bookkeeping presented as the user's result. The
  constructors return nothing now.
- **`_call` in `worker-kernel.js` silently drops streamed messages.** It
  stores an `onMessage` the worker never posts to, so `callWidget` routed
  through it would have resolved with every `stream` and `display_data`
  lost. Both streaming methods go through `_streaming` instead, which is
  the shape `execute` already had and now has a name.

### Pinned to 5.5.1_build3, and the prerelease question ✅ done

**Superseding the section below**, which pinned `build2` and said `build3`
was too risky to default to. That was the right call on the evidence then
available — upstream marks `build3` `stable: false`, `mirror: false` — and
it was wrong once the evidence was actually gathered.

`build3` was pinned, the whole suite run against it, and **369 of 372
passed with no regressions**. The three failures were the pin's own
consequences, not defects: one was the demo notebook's queue cell finally
*running* and drawing a second event stream, and two were version labels.

#### Why "prerelease" does not reach the Lab

The instinct — do not default to a prerelease — is right in general and
does not survive reading what `build3`'s prerelease status actually
consists of. Its `known_issues` are three, in full:

1. **Hibernation is off and should stay off.** The defect is real and
   nasty: a restored program's thread record lacks `u2.funcidx`, so an
   error unwinds from the stack base and writes the error object over the
   driver's function slot. It is reached through `dvs_hibernate` /
   `dv_snapshot` / `dv_restore`.
2. **The capability layer is not a security boundary**, because a program
   holding one endpoint reference can forge another through `debug`. So a
   deployment "must treat every program it loads as trusted".
3. **Endpoint rebinding after `destroy` poisons the token**, and a
   snapshot of nested coroutines is captured rather than refused.

Every one of those is a statement about **instances**, and the Lab creates
none. It drives one global `lua_State` through `run_lua` (see
`src/wasm_stubs.c`); it never calls `dv_new`, never snapshots, never binds
an endpoint. `dvs_*` is not even in the artifact.

And (2) is worth reading twice, because it sounds like the fatal one and
is the opposite: *"treat every program it loads as trusted — written or
templated by the operator, not accepting arbitrary code from a user"*
**describes the Lab exactly.** A notebook cell already runs in a state
with full `debug`, `io` and `os`, and the code was typed by the person at
the keyboard. There is no capability layer here to be weakened; the Lab
is, by design, the permissive profile that caveat assumes.

#### What it buys

`queue`, `endpoint` and `msgpack` for every user, which is the whole
messaging story the event view was built for — and the demo notebook's
centrepiece stops printing "this kernel has no `queue` library". Measured
in a plain `run_lua` state: `declare`, `push`, `pop`, `len`, `capacity`
and `info` all work; only the blocking `queue.wait` needs a host that
resumes, which a bare state is not. Plus all 27 `dv_*` exports, which is
what an instance tier would be built on. And it contains `build2`'s
security fix, being later.

No export was lost between `build2` and `build3` — checked, not assumed.

#### Saying so, which is the part that makes it defensible

Upstream's instruction is *"a deployment that wants it should name the
tag."* Naming it is exactly what this does — in `vendor/PINNED_TAG`, in
`vendor/pinned.js`, in the About panel, and in the dropdown, which now
reads **`5.5.1_build3 (bundled, prerelease)`**.

That last one closed a gap that predated this decision: `releases.js`
parsed `prerelease` off the index and `entries()` **threw it away**, so a
prerelease on the mirror would have appeared indistinguishable from a
release. Upstream calls its own `stable` field "the truth" and derives
GitHub's flag from it — and a build can be unstable for a *narrower
supported configuration* rather than for being unfinished, which is
precisely the thing a chooser cannot infer from a version number.
`scripts/fetch-runtime.sh` now reads that flag from the same
`changelog.json` that `build-mirror.sh` reads for `mirror_tags`, and
records it in `pinned.js` as `true`, `false` or `null` — the third state
meaning "not stated", which is not the same as "fine".

Every stable build is one click away in the dropdown: `build2`, `build1`
and `5.4.7_release` are all mirrored. And reverting the default is one
command, which is the property that makes this a reasonable risk rather
than a bet:

```sh
scripts/fetch-runtime.sh v5.5.1_build2     # back to latest/stable
```

The residual costs, stated: pinning `build3` needs
`DILUVIUM_RELEASE_BASE` pointed at GitHub because the mirror does not
carry it (documented in the script's header), and if `build3` is
withdrawn or superseded by `build4` the Lab moves. Neither is silent.

### Pinned to 5.5.1_build2, and what the move found ✅ done — superseded above

The Lab ran on `5.5.1_build1` since Stage 2. `build2` is a **security
release** for that build — secure (`~`) functions did not hide string
constants that ordinary code in the same chunk also used, so a shared
literal was stored in the dump in the clear. Only the 5.5 line is
affected, because it depends on 5.5's saved-string table. That is reason
enough on its own; `build2` is also what `changelog.json` marks `latest`.

**Not `build3`**, for the reasons in the swarm section above: prerelease,
not mirrored, supported configuration narrower than its feature set. It
remains one command away for anyone who wants its queues —
`DILUVIUM_RELEASE_BASE=…/releases/download scripts/fetch-runtime.sh
v5.5.1_build3` — and `scripts/fetch-runtime.sh` now says so in its header
instead of claiming that only `v5.4.7_release` attaches the kernel to its
GitHub release, which stopped being true three builds ago.

#### The bytecode format is a generation counter, not a constant

This is what the move actually cost, and it was worth finding. `build2`
bumped `LUAC_FORMAT` from `0x44` to `0x45`; `build3` bumped it again to
`0x46`. The reader hardcoded `0x44` in three places and broke in eleven
tests with `string index 12 has not been seen yet` — a parse that had gone
off the rails several fields earlier.

Two changes, re-derived from `ldump.c` and `lundump.c` at each tag:

- **`0x45`: a written string's size field carries a scramble flag in its
  low bit.** The field went from `realLength + 1` to
  `(realLength + 1) * 2 + scrambled`. It had to: 5.5 stores a deduped
  string once, at whichever site wrote it first, and that site is not
  always the secure one — so "scramble by position in the proto tree"
  stored shared literals in the clear. That *is* the security fix.
- **`0x46`: the scramble became a keystream.** xorshift32 seeded from the
  block's own length, taking the top byte of each step. Still trivially
  reversible and deliberately so; what it stops is one `tr` pass over the
  whole file recovering every hidden string at once.

The second one is why `DILUVIUM_FORMATS` refuses an unknown format
outright rather than parsing hopefully. `0x46` moved **no bytes at all** —
a chunk written under a different keystream parses perfectly and decodes
to garbage silently, which is the one failure mode a bytecode reader must
not have. Upstream's own header comment makes the same point: bump this
whenever the layout *or the encoding* changes.

One consequence worth stating because it was a latent bug rather than a
new one: a scrambled code section is now read as **one block** and
unscrambled whole, then split into words. It used to be unscrambled four
bytes at a time, which a constant key made equivalent and a
length-seeded keystream does not.

The committed `0x44` fixtures still pass unchanged, which is the point of
having them: the reader gained two generations without losing one.

#### A hardcoded version string, in the place least likely to be looked at

`src/app.js` passed `pinnedLabel: options.pinnedLabel ?? '5.5.1_build1'`,
and nothing ever passed the option. So the dropdown labelled the bundled
runtime `5.5.1_build1` **whatever was actually in `vendor/`** — and
because `entries()` filters the mirror's copy of the pinned build by
comparing against that same string, the mirror's real `build1` would have
been offered a second time as though it were something else. Every other
use of `BUNDLED` in that file was already right; this one predated the
import. It reads `BUNDLED.version` now.

The same shape as the mirror's stale tag list and the stale module graph
before it: a fact written down in two places, where only one of them is
ever updated. `scripts/check-version.mjs` keeps four copies of the *Lab's*
version in step for exactly this reason; the pinned runtime's version now
has one copy and needs no such machinery.

#### Two tests were pinned to the pin

Both failed on the re-pin and neither was about the runtime, which is
worth recording because the fix is "isolate", not "update the number":

- `the dropdown is newest first` stubbed a mirror containing
  `v5.5.1_build2`. The moment that became the bundled build, the registry
  correctly filtered it out and an ordering test failed looking like a
  sorting bug. Its `_buildN` pair moved to `5.5.2`, a version line that
  cannot be the pin, and `build10` against `build2` still makes the
  lexical-versus-numeric point it exists for.
- `the bundled build is not offered twice` asserted against the captured
  live index, which predates `build2` and so can no longer demonstrate the
  filter at all. It now asserts what that capture can honestly show —
  including that the published mirror is behind — and the filter is
  exercised against `releases-built.json`, which does carry the pinned
  build.

### An instance tier, opening from a URL, and recents ✅ done

Three things, and one bug that had been there all along.

#### Sandboxed instances

`build3` put the whole `dv_` ABI in the browser artifact, so the Lab is
now a **host**: a per-cell **Sandbox** panel runs the cell's source as a
`dv_` instance — its own state, its own queues, an instruction budget —
and reports what it cost.

Every offset comes from `dv_layout`, which exists precisely so a binding
outside C can ask rather than hardcode; that it exists at all is a fair
sign the ABI expected to be driven from somewhere like this. Two entry
points are unreachable from JavaScript and only two: `dv_set_notify` and
`dv_set_endpoint_handler` take C function pointers, and a function pointer
in wasm is a table index that JS cannot mint. That is the same wall the
swarm host vtable hits — and worth knowing it stops *there*, since run,
budget, usage and queue calls are all pointers and integers.

Probed before any of it was written, because reading is not running:

- `dv_new(NULL)` works; a config is needed only for `DV_FLAG_TEXT_ONLY`,
  which the panel sets — a sandbox should not accept precompiled chunks
  by default.
- **Instances are isolated.** A global set in one is `nil` in the next.
- **`inbox` and `outbox` are pre-declared** in every instance;
  `system/events` and `system/lifecycle` are not, exactly as §9.2 says.
  That is why the panel looks queues up by name — the ABI has no
  enumerate call.
- **The instruction counter is the budget hook.** An instance with no
  budget reports `instructions: 0` however much it ran, so the panel
  always sets one and the control chooses how big. Measuring costs an
  armed hook; that is the trade.
- A runaway loop stops at its budget with `dv_exceeded` true, and the
  notebook's own kernel is untouched — which is the difference between
  this and a cell, where the same loop costs a worker.

#### Opening from a URL

**From URL…**, plus `?open=<url>` links. The link form **asks first** and
names the host: "no external requests at load" is a hard constraint, and
a link somebody sent you is not a decision you made. The parameter is
dropped from the address bar either way, so a reload does not ask twice.

A `github.com/.../blob/...` URL is rewritten to `raw.githubusercontent.com`
— the mistake everyone makes, whose natural error is JSON complaining
about `<`. And a cross-origin fetch a host has not opted into fails as an
indistinguishable `TypeError` with no status and no reason, by design, so
the message explains the likely cause instead of repeating "Failed to
fetch".

#### Recents

In IndexedDB, keyed by source so reopening moves an entry up rather than
duplicating it. **The content is kept, not just the name.** A browser
gives no way to re-read a local file without asking again, so an entry
that remembered only a location would work for URLs and be decoration for
files. Keeping the bytes makes every entry work and makes a URL entry work
offline. Capped at 12 entries and 2 MB each, and every failure is
swallowed: a recents list must never be why a notebook does not open.

#### The elapsed clock never stopped

Reported from use, and real: `1 + 2` answered `3` instantly and the timer
kept counting for as long as the page stayed open.

`updateOutputs` cleared `data-busy` and left the interval running, so
`_applyTiming` wrote the true duration and the tick overwrote it 100 ms
later. Nothing called `setBusy(id, false)` on the success path — and
nothing should have to, because having outputs is what finishing *means*.
The timer is stopped where the outputs arrive now. Both halves are pinned:
that it stops, and that it still runs while a cell is running, since "never
start the clock" would also have made the first test pass.

#### Two more of the same shape

- **Capabilities arrive after the last status change.** The worker's own
  kernel publishes `idle` while starting, which crosses the boundary and
  marks the proxy idle; only *then* does the handshake deliver
  `capabilities`. By that point `_setStatus(IDLE)` is a no-op, so no
  further status event fires — and the Sandbox button, gated on a
  capability read from the status handler, never appeared. Published from
  its own method now, called from the status handler *and* after start.
- **`page.route('https://**')` matches nothing.** Playwright's glob does
  not take `**` directly after the scheme, and the symptom is silence: no
  interception, and a real fetch failing with "Failed to fetch" — which
  reads exactly like the CORS error the feature under test is supposed to
  produce. A regex works. `storage.spec.js` also pinned the IndexedDB
  version number and broke the moment a store was added; it opens the
  current schema now.
- **The bake's duplicate-name guard fired a fourth time**, on `STATUS` in
  `instance.js` against `kernel.js`. It keeps earning its place.

### A notebook has a name now, and it is not its filename ✅ done

Click the name at the top of the page to rename it, Colab-style. Enter
keeps, Escape discards, and the tab title follows — somebody with four
Labs open is choosing between them by tab title, and "Diluvium Lab" four
times is no choice at all.

Stored in the notebook's own **`metadata.title`**. nbformat has no
standard field for this: Jupyter uses the filename and has nothing else.
Putting it in notebook metadata rather than beside the notebook means one
copy, so a restore cannot disagree with a save, and it rides through any
tool that preserves metadata. Colab's `metadata.colab.name` is read as a
fallback, so a notebook from there arrives with the name it had — and
renaming clears that copy, which would otherwise win on the next read and
silently undo the rename.

**Which turned up a bug older than the feature: `fromIpynb` dropped
notebook-level metadata entirely.** It built a `NotebookModel(cells)` and
nothing else, so every notebook opened here left stripped of its
top-level fields — authorship, widget state, Colab settings, anything.
Nobody would have noticed until they diffed a round trip. A title stored
there could not have survived either, so the feature could not be built
without fixing it. The model carries `metadata` now and `toIpynb` writes
it back, with the Lab's own `kernelspec` still overriding: whatever wrote
the file, *this* is what would run it.

A button that swaps to an input, not a `contenteditable`. Two reasons and
the first is the rule: `contenteditable` accepts **pasted markup**, and
nothing in this page reaches the DOM as markup. The second is that a field
gets focus, Enter and Escape for free, and Escape-to-cancel is not
something an always-live `contenteditable` can offer at all.

An empty name clears the key rather than storing `""`, so an untitled
notebook does not carry an empty title around forever — and the label says
"Untitled notebook" in a quieter style rather than leaving a gap nobody
would think to click. Recents show the notebook's name in preference to
its filename, because a list of five `notebook.ipynb`s is not a list.

### What the polish branch was holding ✅ reviewed and folded in

`claude/diluvium-lab-polish-4dr00q` looked eighteen commits ahead of
`main`. It was one: everything else had already been merged, and the
appearance came from a stale local `main` ref. The one commit,
`db30c62`, changed `ROADMAP.md` and a lockfile line — **no code at all.**

What it holds is a 329-line plan (its §9) for the polishing pass, written
*ahead* of the work with six probes run against the real page first. Most
of it has since been built, mostly without anyone reading it. That is
worth recording rather than deleting, because the parts that agree agree
for a reason and the parts that differ were decided twice.

#### Where it and the implementation independently agreed

Every one of these was in that plan and is now in the tree, arrived at
separately:

- `parseRecord` → `parseRecords`, scanning every nonce rather than the
  first — named as "a parser change rather than a protocol".
- `RECORD.DISPLAY = 'D'` carrying a mime bundle, published as Jupyter's
  `display_data`. Same letter.
- **Conflate, never queue** for drag samples. The plan measured it: 120
  queued samples cost 65 ms and burned 120 execution counts; conflated,
  2 ms.
- **Widget events are not history** — no execution count, output to the
  control's own area.
- **A stop kills every widget**, and they must say so rather than imply a
  liveness the kernel cannot deliver.
- **Every payload on this channel must be text.** The plan measured why:
  256 byte values written to stdout come back as 128 replacement
  characters, because the shim decodes UTF-8.
- Cell metadata round-trip, and folding through
  `metadata.jupyter.source_hidden` rather than an invented key.
- Selection, run state and `stale`.

#### Where they differ, and which won

- **The Lua API.** The plan proposed one `lab` table (`lab.svg`,
  `lab.html`, `lab.png`, `lab.show`); the tree has four globals
  (`display`, `plot`, `events`, `widget`). Four names against one is the
  cost; discoverability in completion and `plot.line{...}` reading like
  a verb is the gain. Not worth churning now, but the plan's version is
  the tidier one and is worth remembering if a fifth ever wants adding.
- **Markup.** The plan said `text/html` and SVG render in a sandboxed
  `<iframe srcdoc>` with scripts disallowed. The tree is *stricter*:
  `text/html` is not accepted at all, and SVG goes through an allowlist
  sanitiser. Same rule, less surface. The plan's reasoning is the better
  statement of *why*, and is quoted here because it is the sharpest
  version of it: **saved outputs render on open, before anything runs** —
  a notebook you were sent could carry a payload that executes the moment
  the file is opened, with no cell run and no consent.

#### The one item it predicted that was still broken

> the display channel needs its own budget accounting rather than sharing
> the output cap silently

It did share it, and the failure was worse than "the chart does not
appear". A cell plotting 300,000 points overran the 4 MiB stdout ceiling,
which cut the harness's own terminal record in half — so the run reported
**`HarnessError`**, a name this code reserves for *its own* bugs, with the
truncated stdout pasted into the message: raw nonce, separator bytes and
all, over the top of whatever the cell had legitimately printed.

Fixed. `parseRecords` now reports that it stopped mid-record and drops the
fragment rather than leaving it in `output` — nothing but the ceiling can
produce a nonce followed by a broken frame — and the kernel reports
`OutputTooLarge` with the ceiling, the fact that a chart counts against
it, and what to do instead.

#### Still open, and still worth doing

- **Canvas as draw commands, not pixels.** Measured: a 640×480 RGBA
  framebuffer built per-pixel in Lua and base64'd costs **365 ms a frame**
  (~2.7 fps); 160×120 reaches ~13 fps. So the canvas path is a display
  list the page replays, not a buffer. Pixel buffers stay fine for a
  *static* image. The escape hatch if per-frame pixels are ever genuinely
  needed: stop using stdout — `memory` is exported, so a host can read a
  framebuffer straight out of linear memory and skip both encode and
  decode.
- **Completion is still an alphabetical `_G` walk**, so `a` offers `arg`
  before `assert`. Rank by relevance, show the kind beside each match,
  match subsequences. Presentation only; the kernel already reports its
  globals and keywords.
- **Toolbar grouping and a collapsible, resizable console.** The toolbar
  has grown since that was written, which strengthens the case.
- **`executeRequest` still declares `silent` and `store_history` with
  nothing behind them.** The plan wanted them for widget events; the tree
  answered with a separate `callWidget` instead, which is the better
  shape. They are dead fields now and should be removed or wired.

The useful numbers, kept because nobody will re-measure them: a trivial
execute round-trips through the worker in **0.96 ms** median, a stored
closure call in **1.07 ms**, an SVG chart of 10,000 points builds in
**22 ms**, and stdout moves 1 MB in 27 ms.

### A Start here gallery, and cells that misbehave on purpose ✅ done

The example notebooks were one padded file and a browser check. There are
now seven, behind a **Start here** button, and every code cell in every
one of them is executed against the real pinned kernel on every CI run.

#### The seven

`hello` (17 cells), `language` (34), `secure-functions` (17), `messaging`
(26), `sandbox` (19), `showing-things` (22), `browser-check` (23). Each
carries `metadata.title` — so opening one names the notebook, through the
same path a file or a URL takes — and `metadata.diluvium_lab.summary`,
which is the line the gallery shows.

Nothing was written from memory. Every Lua snippet was run against the
pinned build first, in four batches of verification, which is how
`local ~function name(...)` was found to be the syntax: `~function` is a
statement, not an expression, and `local f = ~function() end` fails with
"attempt to perform bitwise operation on a function value" rather than
anything that points at the real problem.

#### Bundled, not fetched

`scripts/bundle-examples.mjs` emits `src/notebook/examples.js` from
`notebooks/*.ipynb`, with an explicit `ORDER` array — a new notebook that
nobody has placed in the reading order is an error, not a silent append.

Fetching them would have been less code. It would also have broken the
button in the single-file `file://` build, which has no `notebooks/` to
fetch from and cannot fetch anyway — and offline, which is the state the
Lab is designed for. **Start here** failing in exactly the situation
somebody reaches for it would be the worst button in the page.

The cost is that the bundle can go stale. Two things stop it: a CI step
running `bundle-examples --check`, and a Playwright test that compares
each bundled notebook against the file on disk.

#### The thing the tests found

Three of these notebooks contain cells that never return — `while true do
end` for the **Stop** button, and one for the Sandbox panel — and one
contains a cell that raises so you can see what an error looks like.
Sweeping **Run all** across them hung the kernel, which is a poor first
five minutes for somebody who has just pressed *Start here* and then
*Run all*.

The prose above each of those cells already said so. Prose is read after
the surprise as often as before it, and **Run all** cannot read prose at
all. So the fact moved into the file: `metadata.diluvium_lab.expect`,
either `"error"` or `"never-returns"`, unknown values meaning nothing so
a notebook from elsewhere using the key is not misread.

The page reads it in two places. The cell shows a badge — *errors on
purpose*, *never returns* — where the surprise happens. And **Run all**
steps over a `never-returns` cell and reports how many it skipped, while
pressing **Run** on that cell yourself still runs it, because that is the
demonstration and skipping it there would break the thing it teaches.

Writing the sweep also turned up two real bugs in notebooks that had been
proofread:

- `messaging.ipynb` did `local events = queue.declare("system/events", …)`
  and then called `events(drained, …)` — shadowing the display global with
  a queue id, so the cell that shows an event stream died on "attempt to
  call a number value". Exactly the kind of thing reading does not catch
  and running does.
- `sandbox.ipynb` was marked as though `queue.lookup("outbox")` fails
  outside an instance. It does not: `outbox` is a well-known queue in the
  notebook kernel too. The mark was wrong and came off — which is the
  point of asserting that a cell marked `expect: "error"` *did* error,
  rather than only that unmarked cells did not.

The sweep runs cells one at a time rather than pressing **Run all**,
because Run all stops at the first error — which in `hello.ipynb` is cell
9 of 17, and would have left most of the notebook unchecked.

### A tool panel, and the outline that lives in it ✅ done

The left edge now carries a rail of tools and one collapsible panel —
the generic surface — and the notebook outline, its first resident.

The genericity is the design decision, made before the second tool
exists: a tool is `{id, label, icon, render(container)}` registered with
`ToolPanel`, which owns the rail button, the open/close/toggle state, its
persistence (a `panel` key in the existing IndexedDB store — no version
bump), and nothing about any tool's content. `render` is called with an
empty container on open and on every refresh, so a tool holds no DOM
between paints and cannot leak listeners into the panel. The obvious
future residents — find, snippets, kernel variables — register the same
way.

The outline is Jupyter's TOC / Colab's outline pane: ATX headings from
markdown cells, in order, indented by depth, click to jump. Three details
carry the weight:

- **Fences are respected.** `# comment` inside a ```` ```lua ```` fence
  is a comment, and an outline that listed it would be lying about the
  document.
- **The active mark is the *section*, not the heading cell.** Selecting
  any cell marks the last heading at or above it, which is how both
  reference implementations read.
- **It follows the document, not the panel.** Model changes route
  through one `panel.refresh()` — a no-op while collapsed, a repaint
  (scroll position preserved) while open — so the outline needs no
  subscription of its own and survives the model being replaced wholesale
  by *Open* or *Start here*.

Layout-wise the body grid grew a column: workbench, then sheet, with the
toolbar, console and banners spanning both. The mobile suite passes
unchanged; rail buttons join the 44px touch-target rule.
