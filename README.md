# Diluvium Lab

A notebook front end for [Diluvium](https://github.com/Aloecraft-org/diluvium):
cells, a console, and kernel controls, running a Diluvium WASM build in the
page. No framework, no bundler, no CDN — plain modules and the DOM.

Cells and the console share one kernel, so state carries between them. The
kernel is `libdiluvium_wasi.wasm` running in the tab: a real Lua state
with the full standard library, reached through a WASI shim the page
supplies itself. The bundled build is **Diluvium 5.5.1_build6**; the
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
scripts/fetch-runtime.sh v5.5.1_build6    # re-pin the bundled runtime
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

## Showing things that are not text

A cell can print. It can also **display**: charts, event streams and
controls, all through one primitive.

```lua
plot.line{ 1, 4, 9, 16 }                   -- y only, or (x, y)
plot.bar({ "a", "b", "c" }, { 3, 1, 4 })
plot.scatter(xs, ys, { title = "..." })

plot{                                       -- several series, named
  title = "Growth", x_label = "n",
  series = { { name = "raw", y = a }, { name = "smoothed", y = b } },
}
```

**Lua sends numbers; the Lab draws them.** A chart built in the kernel
could not know the page's theme, its width or its fonts, so it would be
wrong in dark mode and stale after a resize. Sending data means the chart
follows the page — and means a saved notebook carries numbers rather than
markup.

Every chart has a **Table** button, and it is not a fallback: some of the
series colours are deliberately low-contrast, and the rule for that is
that the numbers must be reachable another way. A missing value is drawn
as a gap, never as a zero, and a bar chart's axis always includes zero.

`events` renders a list of records in the shape Diluvium's swarm layer
emits on `system/events` — `event`, `id`, `detail`:

```lua
events{
  { event = "spawned", id = 2 },
  { event = "denied",  id = 3, detail = "capability not held: lifecycle" },
}
```

From **5.5.1_build3** onward the browser kernel ships `queue`, `endpoint`
and `msgpack`, so those records need not be hand-written: a program can
push them into an actual `system/events` queue and drain it, which is the
queue a swarm writes to.

From **5.5.1_build6** onward it also ships `json`, `bytes` and `time`,
which is what lets a program encode a response, base64url a token segment
and stamp a record without reaching for `os`.

**The Lab bundles `build6`, and says so.** It is marked stable upstream.
The About panel states the release status and the sha256 of the exact
bytes; every other build the mirror carries is one click away in the
dropdown, and the Lab says which of those are prereleases rather than
leaving you to read a tag name.

Switching runtimes keeps the swarm. The matching
`diluvium_swarm_wasi.wasm` is fetched from the **same tag** and verified
the same way — pairing one build's swarm layer with another build's
kernel would put two different Diluviums in one page and call the pair a
runtime. A release that publishes none (everything before `build5`) still
runs cells; the Instances panel says why it cannot run a swarm.

**And since `build5` this *is* a swarm.** `dvs.c` used to be absent from
every published artifact, so there was no supervisor, no capability
attenuation and no subtree kill — the pipe and the record shape were real
and the layer above them was not there. `diluvium_swarm_wasi.wasm` carries
it now, and the Instances panel above drives it: programs spawn programs,
grants only ever narrow, and a budget stops a runaway. Hand-written
`events{...}` records still work, and they are no longer the only way to
get one.

`widget` makes it interactive. The callback stays in the kernel — it
captured locals that exist nowhere else — so the page holds an id and asks
for the function by name when the control moves:

```lua
widget.slider{ label = "terms", min = 2, max = 24, value = 8,
  on_change = function(n)
    local ys = {}
    for i = 1, n do ys[i] = 2 ^ i end
    plot.line(ys)
  end }
```

It runs once at the value it was created with, so running the cell shows
something. A control's output lands under the control and is **not** saved
with the notebook: a file should carry the result the cell produced, not
the last frame of someone dragging a slider. Reopen a notebook without
running it and the controls are there but disabled, because the kernel
that held their callbacks is gone.

`display` is what all of that is built on, and takes a mime bundle exactly
as Jupyter's `display_data` does — so it round-trips through `.ipynb`, and
a reader that has never heard of Diluvium still gets the `text/plain` that
ships in every bundle.

```lua
display{ ["text/plain"] = "a red circle",
         ["image/svg+xml"] = "<svg ...>" }
```

`notebooks/showing-things.ipynb` is all of the above, runnable.

## Start here

The **Start here** button opens a gallery of runnable notebooks. They are
bundled into the page rather than fetched, so they work offline and they
work in the single-file build — a button that broke in exactly the
situation someone reaches for it would be worth less than no button.

| | |
| :--- | :--- |
| **Hello, Diluvium** | the shortest path to having run some, and a map of the rest |
| **The 5.5 language** | `switch`, `defer`, `with`, safe navigation, compound assignment, f-strings |
| **Secure functions** | `~function`, what it protects and what it does not |
| **Messages and queues** | msgpack, `queue.declare` / `push` / `pop` / `info`, endpoints |
| **Sandboxed instances** | budgets, isolation, and what a sandboxed run refuses |
| **Showing things** | charts, event streams, controls, raw mime bundles |
| **A swarm, from a cell** | programs that spawn programs: grants that only narrow, budgets that stop a runaway, and the shape they make |
| **SQL, without SQLite** | a relational engine and a working SQL parser in pure Lua — then the same query asked of a real SQLite, by hostcall |
| **Browser check** | what works in the browser you are reading this in |

Opening one replaces what is on screen, so save first if you have unsaved
work. The sources are in `notebooks/`; `npm run bundle-examples` folds an
edit back into the page, and CI fails if you forget.

### Cells that misbehave on purpose

A teaching notebook needs a cell that raises so you can see what an error
looks like, and one that loops forever so you have something to press
**Stop** on. Those carry `metadata.diluvium_lab.expect` — `"error"` or
`"never-returns"` — which the page reads:

- the cell shows a small badge saying what it will do, where the surprise
  happens rather than only in the prose above it;
- **Run all** steps over a `never-returns` cell and says how many it
  skipped. Pressing **Run** on it yourself still runs it, because that is
  the demonstration.

## The chrome

Three rows. The **masthead** carries the notebook's name and filename, the
autosave status, and three deliberate reservations on the right: a
disabled history clock (checkpoints are planned), a **read-only** toggle,
and a dashed circle where identity lands when live collaboration does.
Prime real estate is reserved now rather than crowded later. The `˄` at
the right of the menu row folds the masthead away, and remembers.

The **menu row** holds File / Edit / View / Help — defined once as data
and rendered twice, as the menu bar and as the hamburger drawer that
replaces the top rows on a narrow screen (which also carries rename and
read-only, so nothing masthead-only is out of reach on a phone). The
split buttons in the action row define their own items on the same
dropdown machinery (`src/notebook/menu.js`), so open, close, keyboard
and positioning are one behaviour everywhere. Menus re-render on every
open, so enabled/checked state is always current.

- **File**: New, Open…, Open from URL…, Recent…, Save .ipynb (Ctrl+S),
  and **Show source** — the exact `.ipynb` JSON a save would write, in a
  copyable viewer.
- **Edit**: Undo/Redo (structural — see below), cut/copy/paste cell
  (an internal clipboard; no permission theatre), clear all outputs, and
  **Duplicate notebook**, which is also read-only's escape hatch.
- **View**: **Hide code** (markdown and outputs only — the notebook read
  as a report), collapse/expand all code, the console toggle, and one
  entry per registered panel tool — a future debugger appears here by
  registering, not by being remembered.
- **Help**: the Diluvium docs, and About.

The **action row** keeps the working controls: **+ Cell ▾** (adds the
kind it last added; the arrow chooses), **Run all ▾** (run focused, run
cells above, run cell and below, sandbox the focused cell, clear all
outputs), the runtime
selector with its refresh, **Stop ▾** (restart lives behind the arrow —
it says Stop, not Interrupt, because stopping terminates the worker and
the state goes with it), and the kernel status.

**Undo/redo is structural, on purpose.** Add, delete, move, convert,
paste, clear-outputs and rename are snapshots on a stack inside the
model, and a run of typing between structural changes is captured as one
step of its own — so a structural undo can never silently destroy typing
it did not own. Ctrl+Z outside an editor walks the stack; *inside* an
editor it stays the editor's own native undo — the two meet only at
session edges, which is how document-wide undo avoids the usual fight.

**Read-only** blocks the document changing — typing (the editors
themselves become read-only), structure, renaming — while running still
works, the way Colab reads. Today it is a toggle anyone can flip; it is
the seam for a file model where editing someone's notebook requires
copying it first.

**Home** (⌂) opens the launcher — New / Open / From URL, recents, and
the Start here gallery in one place. A genuine first visit with nothing
loaded gets it unprompted, once.

## The tool panel

The rail down the left edge holds tools; clicking one opens a collapsible
panel beside it, and clicking again (or ✕) puts it away. Whether it was
open — and to what — survives a reload.

The first tool is the **outline**: every markdown heading in the
notebook, in order, the way Jupyter's TOC and Colab's outline pane read.
Click a heading to jump to its cell; the entry for the section your
selection is in stays marked. Headings inside fenced code blocks are
ignored, because `# comment` in a ```` ```lua ```` fence is a comment.

The second is **Instances** — a swarm, while it is running. See below.

The panel is generic on purpose — a tool is an id, a label, and a render
function registered in `app.js`; the rail and collapse behaviour come for
free (`src/notebook/panel.js`). The outline just happens to be the first
resident.

## Instances: running a swarm

The **Instances** tool needs `diluvium_swarm_wasi.wasm`, which arrived in
v5.5.1_build5. On anything older the panel says so and does nothing else:
older builds can run a single sandboxed instance (the Sandbox button
below) but nothing in them can spawn.

Pick a root program, press **Start**, then **Step** one step at a time or
**Run** to a standstill.

Above the roster is the **topology**: the shape the instances make, drawn
as it changes. Solid lines are spawns, which the runtime is the authority
on — `dvs_parent` said so at create time. Queue lines are routes the guest
declared, drawn dashed until something has crossed them and labelled with
how much has; hovering one lists the queues behind it, because a program
with five exported queues would otherwise put five arrows on the same two
points and say less than one.

**There are no instance-to-instance edges, and that is not an omission.**
Guests do not push to each other. A message leaves on an exported queue,
the host takes it, and the host decides what happens next — so an arrow
from one instance to another would assert a route the runtime does not
have. A → host → B is two edges, and is what actually happened.

The same graph is offered as Mermaid text under the picture, for a PR or a
design doc — and, if you ask for it, drawn.

**View → Diagram renderer…** downloads Mermaid once (3.4 MB), checks it
against a checksum pinned in `src/notebook/mermaid.js`, keeps it in
IndexedDB and draws the topology with it from then on. It is the only
thing this page fetches that is not a Diluvium release, which is why it is
a menu item rather than something that happens on its own — see the
amended constraint in `CLAUDE.md`. Nothing else changes if you never click
it: the Lab draws its own SVG and emits the text either way, and the
rendered diagram appears *beside* the hand-drawn one rather than replacing
it, because the one that needs no download is the one that always works.

The roster below fills in as instances come to exist:

| column | what it is |
| :--- | :--- |
| `#` | the instance id, which the swarm assigns and never reuses |
| `parent` | who spawned it — `—` for the root |
| `state` | running, parked, hibernated, or gone with how it ended |
| `instructions` | used against the budget it was given |
| `mem` | peak KB |
| `caps` | what it holds, which can only ever narrow going down the tree |

Underneath, the event list shows what happened in the order it happened:
spawns, exits, faults, budget kills, refused grants, and every message the
host drained from a guest's exported queues.

Three things the panel is careful about, because a prettier one would be
lying:

- **A hibernated instance shows no instruction count.** The number is in
  its snapshot header and the swarm API has no accessor for it yet, so it
  reports budget and cached size and nothing else. Showing its last
  resident figure would be showing a stale number as a live one.
- **Instructions are counted by the budget hook**, which fires every 1000.
  A program doing less than that between parks reports zero.
- **The listener binds no port.** A browser tab binds nothing. It says
  which port it *would* bind, because that is topology and it comes from
  the configuration exactly as it does on the real host.

The **Stop** button is called Stop rather than Interrupt for the same
reason the kernel's is: it frees the swarm and every instance's Lua state
goes with it.

Each row also lists its queues as `name len/capacity`, with a full one
marked. That is usually the answer to "why is this parked": every queue in
Diluvium is bounded, so a program blocks because its outbound queue is
full, waits because its inbound one is empty, or is refused because it
declared `on_full = "reject"`.

### From a cell, not only from the panel

A cell can drive the same swarm, on runtimes that have `json`
(5.5.1_build6) and a swarm module:

```lua
swarm.start{
  root = [==[ ... ]==],
  caps = { "lifecycle", "queue:*", "host:time" },
  budget = { instructions = 5000000, memory_kb = 512 },
  max_instances = 16, spawns_per_step = 4,
  hibernation = "on",
  connectors = { time = true },
}
swarm.push("root", "inbox", { op = "admit", label = "alpha" })
for _, e in ipairs(swarm.step(10)) do
  if e.event == "spawned" then swarm.alias("alpha", e.id) end
end
events(swarm.step(5))
for _, m in ipairs(swarm.drain("alpha", "outbox")) do print(m.kind) end
print(swarm.status().alpha.resident)
```

`start`, `alias`, `push`, `drain`, `step`, `status`, `hibernate`, `wake`,
`kill`, `stop`. The config is `host/example.host.lua`'s shape and the same
keys — `spawns_per_step`, `memory_kb`, `hibernation = "on"` — so a
deployment prototyped here is a translation rather than a rewrite.

**These return synchronously, inside the cell**, which is the whole trick:
`run_lua` is one blocking WASM call with no event loop to return to, so
the round trip is one unbuffered write to stdout carrying the request and
one read from stdin collecting the answer, both intercepted by the page's
own WASI shim. Everything a connector does must therefore be synchronous
too.

`swarm` is simply **absent** when the runtime has no `json`, or the build
publishes no swarm module — so `type(swarm) == "table"` is a capability a
notebook can test for, rather than a global that exists and throws.

### The host, and why a guest cannot tell

What the panel drives is a **host** in `doc/Host.md`'s sense: the code
outside the sandbox speaking the `dv_`/`dvs_` ABI. Diluvium has two — one
in C over the system SQLite and a real socket, and this one in JavaScript.
The protocol's acceptance test is behavioural: *a guest program must not
be able to tell them apart.* A supervisor prototyped here is the same
bytes that run over there.

So the mocked connectors are not simulations of hostcalls — they *are*
hostcalls, answered by different code. Same encoding, same correlation
token, same capability check, same `ok`/`denied`/`error`/`malformed`
vocabulary. What differs is what stands behind each one, and the Lab says
which:

| connector | here | in production |
| :--- | :--- | :--- |
| `time` | wall clock | wall clock — identical |
| `sql/query`, `sql/exec` | real SQLite, compiled to WASM (`vendor/sql-wasm.js`) | the system SQLite |
| `listen` | a request composer in the panel | a bound socket |
| `crypto/*` | a vendored synchronous SHA-256/HMAC | the same, over the runtime's SHA-256 |
| `rng`, `js/invoke` | `crypto`, a registered function | host's choice |

Connectors are **all off by default**; a deployment names the ones it
wires, and a call to an unwired one is `denied` with a sentence saying so.
The configuration is `host/example.host.lua`'s shape on purpose, so moving
a deployment to the C host is a translation of the same keys rather than a
rewrite.

**`crypto/*` is where the runtime's sharpest claim becomes visible.** A
program granted `host:crypto/jwt_sign` holds the right to ask for a
signature, not the key: it cannot exfiltrate a secret it was never handed,
and the key is in neither its heap nor its snapshot. The Lab copies the C
host's semantics rather than inventing any — two subkeys derived under
separate labels so `host:crypto/hmac` is not an oracle for forging a
token, a fixed header compared rather than parsed so `alg` confusion is
closed structurally, and `iat`/`exp` owned by the host so a guest cannot
mint a token that never expires. The primitive underneath is vendored and
synchronous, and checked against FIPS 180-4 and RFC 4231 vectors rather
than against itself.

**The SQL engine is SQLite — really it, compiled to WebAssembly and
vendored.** So the dialect is not a subset of anything: joins, subqueries,
CTEs, window functions, its own constraint and NULL semantics. A query
that runs here runs on the C host, and a constraint that fires here fires
there.

What is weaker here is the **confinement**, not the contract, and the
difference is worth knowing before you trust it with anything. The C
connector earns its confinement from three SQLite primitives no JavaScript
driver exposes — the authorizer, `SQLITE_LIMIT_ATTACHED` and
`sqlite3_stmt_readonly` — so in their place this one reads the statement's
text: `ATTACH`, `BEGIN`, `PRAGMA`, `VACUUM` and their neighbours are
refused by first keyword, the read/write split is by first keyword, and
the `?` parameters are counted from the text and must match exactly. Two
further rules are not standing in for anything: one statement per call, so
a second cannot ride in silently unrun, and the row cap is checked while
stepping a cursor rather than after materialising the result.

A text gate is a floor rather than a target. Build to the contract so your
guest cannot tell the two hosts apart, and do not point this at a database
that matters — production is the C host.

One of those gates stopped being a text gate. **One statement per call** is
now decided by SQLite's own parser: `iterateStatements` hands back the text
it has not parsed, which is the same question answered by the thing that
will run the statement. It is side-effect free — preparing is not running,
and a request whose tail is `DROP TABLE t` leaves the table standing.

### The database is a file

The database lives in memory — there is no filesystem behind a browser tab
— but it is a real SQLite database, and it can leave. **Download .sqlite**
in the Instances panel exports it, and what comes out begins `SQLite format
3` because SQLite serialised it; `sqlite3`, a GUI, or another Lab session
will open it. **Open .sqlite…** beside the program picker goes the other
way, staged until you press Start because the database is built when the
swarm is.

A file that is not a database is refused when you choose it, by name.
That check is not decoration: sql.js accepts arbitrary bytes without
complaint and only fails at the first *query*, which would put the
complaint arbitrarily far from the wrong file that caused it.

This is also the half of "does a session survive a reload" that is not
blocked upstream. A swarm's Lua state is unreachable — `dvs_hibernate`
caches a snapshot and nothing hands over the bytes — but a database hands
over its own.

## Naming a notebook

The name at the top of the page is the notebook's, and it is **not** its
filename. Click it to rename, Enter to keep, Escape to discard.

It is stored in the notebook's own `metadata.title`, so it survives a
save, a reopen, and any tool that preserves notebook metadata. nbformat
has no standard field for this — Jupyter uses the filename and has nothing
else — and a notebook from Colab arrives with the name it had there, read
from `metadata.colab.name`.

The filename stays what it was, and is what **Save .ipynb** writes.

## Opening a notebook

**Open…** takes a file. **From URL…** takes a URL:

```
https://raw.githubusercontent.com/owner/repo/main/notebooks/hello.ipynb
```

A GitHub *page* URL works too — it is rewritten to its raw form, because
pasting the page you were looking at is the mistake everyone makes and
`Unexpected token '<'` explains nothing. The host has to send
`Access-Control-Allow-Origin`; `raw.githubusercontent.com` does, a plain
`github.com` page does not, and the error says so rather than repeating
"Failed to fetch".

A link can carry one: `?open=<url>`. It **asks first**, naming the host it
would talk to, and fetches nothing until you press the button — "no
external requests at load" is a hard constraint, and a link somebody sent
you is not a decision you made.

**Recent** lists what you have opened before, kept in this browser. The
notebook's content is kept too, not just its name: a browser gives no way
to re-read a local file without asking again, so an entry that remembered
only where something came from would work for URLs and not for files.
Reopening comes from that copy, so it works offline.

## Running a cell in a sandbox

Every code cell has a **Sandbox** button on a runtime that has the `dv_`
instance ABI (5.5.1_build3 and later — it is hidden otherwise). It runs the
same source as a Diluvium *instance* rather than in the notebook's state:

- its own globals and its own queues, sharing nothing with your cells
- an **instruction budget**, so `while true do end` stops after 200,000
  instructions instead of costing a worker
- a report of what it cost: instructions used against the budget, peak
  memory, the queues it ended up with and how full they are

A program that parks on a queue is reported as parked, with what it is
waiting for, and stops there. Nothing here can send it a message — that is
a host loop's job, and the Lab now has one: see **Instances** above, which
drives many instances rather than one and can answer their parks.

One thing worth knowing, because it is the reason a budget is always set:
**the instruction counter is the budget hook.** An instance run with no
budget reports zero however much work it did.

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
scripts/build-mirror.sh mirror v5.5.1_build6      # downloads and verifies
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

**Version the module URLs, and none of this can bite you.** `npm run stamp`
writes an import map into `index.html` pinning every module to
`?v=<version>`; bump the version, re-stamp, deploy, and every URL is one a
cache has never seen. That is the only fix that does not depend on the CDN
being configured correctly, and CI fails if the map is stale. It runs at
release time, not development time — a checkout still runs as-is, because
the map points at the same files with a query the server ignores.

One honest gap: a module worker does not inherit the document's import
map, so the kernel worker's own imports resolve unversioned. The worker
script itself is stamped by hand, which shrinks the window, and a kernel
that misbehaves falls back to running in the page — but the host still
should not cache unversioned scripts.

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

That holds for rich output too. The display types the Lab draws itself
carry **data** — a chart is `{"series": [...]}` — which has nowhere to put
a script tag. The two types that must carry markup are handled rather than
trusted: `image/svg+xml` goes through an allowlist sanitiser that keeps
shapes and text and drops everything that can run or fetch, and raster
images become `data:` URIs, so nothing a notebook contains can cause the
page to make a request.

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
src/notebook/display.js  rich output by mime type; plot.js draws the charts
src/kernel/swarm.js      the swarm host: doc/Host.md's seven duties, in JS
src/kernel/connectors.js the hostcall connectors; sqlite.js is the sql one
src/kernel/topology.js   a host report as a graph — no DOM, so it can be
                    lifted into doc/Host.md and grown in the C host
notebooks/          the Start here gallery, bundled into the page by
                    scripts/bundle-examples.mjs -> src/notebook/examples.js
vendor/             the pinned Diluvium runtime, both modules, plus the
                    msgpack codec and SQLite (verbatim copies — see the
                    matching *.SOURCE.txt beside each)
```

Everything reaches the kernel through `src/kernel/kernel.js`. That is the
seam Stage 2's version dropdown and Stage 3's second backend plug into.

The pinned runtime lives in `vendor/`. Re-pin with:

```sh
scripts/fetch-runtime.sh v5.5.1_build5
```

That fetches both modules — the kernel and, when the release has one, the
swarm build — and verifies each against the release's own
`SHA256SUMS.txt`. A release with no swarm artifact is a fact rather than a
failure: it is skipped, and the Instances panel says why.

The mirror is the default source. A build the mirror has not picked up yet
lives on GitHub, which `curl` can read even though a browser cannot (no
CORS on release assets):

```sh
DILUVIUM_RELEASE_BASE=https://github.com/Aloecraft-org/diluvium/releases/download \
  scripts/fetch-runtime.sh v5.5.1_build5
```

Diluvium itself is never built here — the Lab consumes published release
artifacts.

## Where this is going

`ROADMAP.md` carries the staging, the decisions already made, and the
risks; `CLAUDE.md` carries the constraints any contributor works under.
Stages 0, 1 and 2 are done. Next is a second kernel backend (Stage 3):
a local `diluvium` over WebSocket, which is where the real REPL protocol
replaces the `run_lua` shim. The adapter it plugs into already exists.
