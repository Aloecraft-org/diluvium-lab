// The swarm host, in JavaScript. `doc/Host.md`'s seven duties, in a browser.
//
// A *host* is the embedding application: the code standing outside the
// sandbox boundary, speaking the `dv_`/`dvs_` ABI. One of them exists in C
// (`host/` in the Diluvium tree, over the system SQLite and a real socket)
// and this is the other one. The acceptance test for the protocol is
// behavioural and it is the reason this file is worth writing carefully:
// **a guest program must not be able to tell the two apart.** A supervisor
// prototyped here against a mock connector is the same bytes that run on
// the C host against a real one.
//
// ## Why this can exist at all, which was predicted wrong once
//
// `dvs_new` takes a vtable of C function pointers and JavaScript cannot
// make one -- a wasm function pointer is a table index. `doc/Lab.md` read
// that and concluded the host must therefore be C, compiled in, behind a
// narrow door. The premise was right and the conclusion was not.
// `src/dvs_shim.c` inverts it: the *trampolines* are C, declared as imports
// from module `env` (`js_host_create` / `js_host_destroy` / `js_host_drive`),
// and `dvsjs_new` stands in for `dvs_new`. The duties -- drive, roster, pump
// -- are ordinary JavaScript. So the door is not narrow: the whole `dvs_`
// surface is exported and this file calls it directly.
//
// That is also why the swarm build is a separate artifact. A wasm module's
// imports are mandatory, so linking the shim into `libdiluvium_wasi.wasm`
// would break `wasmtime libdiluvium_wasi.wasm` and every other pure-WASI
// consumer. `diluvium_swarm_wasi.wasm` is the same objects plus `dvs.o` and
// `dvs_shim.o`, and the Lab supplies the three `env` imports.
//
// ## The rule that shapes every function here
//
// A host callback runs *inside* `dvs_step`, which means inside a wasm frame.
// A JavaScript exception thrown from one unwinds the wasm stack mid-step and
// leaves the swarm's bookkeeping in a state nothing can describe. So every
// callback in this file catches everything, records it, and returns a value.
// `_faults` is where those go, and the panel shows them: a host that swallowed
// its own bugs silently would be worse than one that crashed.

import { decode, encode } from '../../vendor/msgpack.js';
import { readLayout, readCString, EXPECTED_ABI } from './instance.js';

/** The queue names `doc/Host.md` fixes, so guests are portable between hosts. */
export const HOSTCALL_QUEUE = 'host/calls';
export const HOSTREPLY_QUEUE = 'host/replies';

/** `dvs_status`, in dvs.h's order. */
const DVS = { OK: 0, ERROR: 1, UNKNOWN: 2, DENIED: 3, LIMIT: 4, GONE: 5 };
const DVS_NAMES = ['ok', 'error', 'unknown', 'denied', 'limit', 'gone'];

/** `dv_status`, the values the drive loop branches on. */
const DV = { OK: 0, IDLE: 6, DONE: 7, ERROR: 8, BUSY: 11 };

/**
 * The largest lifecycle request the swarm layer will read (`DVS_MAX_REQUEST_BYTES`).
 *
 * Worth exporting rather than hiding, because a spawn request carries the
 * child's *source*: the toy swarm example in the Diluvium tree came up
 * with one instance
 * instead of eight after four lines of comment pushed its coordinator past
 * this, and the only symptom was `denied ... the request is too large`.
 */
export const MAX_REQUEST_BYTES = 32768;

/**
 * The `dvs_*` calls this host needs before it will drive a module.
 *
 * Deliberately not every export: `dvs_set_host_identity` and
 * `dvs_allow_unsafe_stdlib` are policy a Lab session may never touch, and
 * demanding them would refuse a future build that dropped one for a reason.
 */
const REQUIRED_SWARM = [
  'dvsjs_new', 'dvs_free', 'dvs_root', 'dvs_step', 'dvs_alive', 'dvs_instance',
  'dvs_parent', 'dvs_kill', 'dvs_push', 'dvs_budget', 'dvs_caps', 'dvs_holds',
  'dvs_resident', 'dvs_cached_size', 'dvs_last_error', 'dvs_abi_version',
];

/** Can this module be driven as a swarm? Asked of the module, never of a version string. */
export function swarmCapable(exports) {
  if (!exports) return false;
  if (!REQUIRED_SWARM.every((name) => typeof exports[name] === 'function')) return false;
  try {
    // A future ABI break is a refusal rather than a best effort: these are
    // raw pointers into another language's structs.
    return exports.dvs_abi_version() === 1 && exports.dv_abi_version() === EXPECTED_ABI;
  } catch {
    return false;
  }
}

/**
 * Why a module cannot be driven, as sentences.
 *
 * The panel says this instead of being empty. "It does not export dvsjs_new"
 * points at the build; an empty panel points at nothing.
 */
export function swarmProblems(exports) {
  if (!exports) return ['there is no module loaded'];
  const missing = REQUIRED_SWARM.filter((name) => typeof exports[name] !== 'function');
  if (missing.length === REQUIRED_SWARM.length) {
    return ['this build has no swarm layer: it exports no `dvs_*` calls at all, '
      + 'which every Diluvium before v5.5.1_build5 is the case for'];
  }
  if (missing.length) return [`this build is missing ${missing.join(', ')}`];
  try {
    const abi = exports.dvs_abi_version();
    if (abi !== 1) return [`the swarm layer is ABI version ${abi}; this host speaks 1`];
  } catch (err) {
    return [`asking for the swarm ABI version threw: ${err.message}`];
  }
  return [];
}

/**
 * The shadow stack `dvs_step` needs, and does not get from v5.5.1_build5.
 *
 * **This is a workaround for an upstream link flag, and it is written to
 * stop being one.** Measured, not inferred:
 *
 *   `diluvium_swarm_wasi.wasm` (v5.5.1_build5) reports `__stack_low = 0`,
 *   `__stack_high = 65536` -- wasm-ld's default 64 KiB shadow stack,
 *   because `BUILD_WASM_OPT` in the Makefile passes no `-z stack-size`.
 *   `dvs_step` does not fit in it: `drain()` declares
 *   `uint8_t buf[DVS_MAX_REQUEST]`, which is 32 KiB, and the compiler
 *   inlines it into `dvs_step` alongside `spawn()`'s capability array. The
 *   frame underflows the stack on entry, so the first read through the
 *   stack pointer traps -- which is why the symptom is `memory access out
 *   of bounds` inside `dv_queue_lookup`, a function that works perfectly
 *   when called directly with the same arguments one line earlier.
 *
 * That was verified by bisection: with the shadow stack relocated, the same
 * `dvs_step` traps at 64 KiB and runs a three-child swarm to completion at
 * 96 KiB. Upstream's own `bindings/js/test/swarm.integration.mjs` fails the
 * same way, and says of itself "this file has never executed anywhere",
 * which is exactly what a first run is for.
 *
 * **The real fix is one linker flag upstream** -- `-Wl,-z,stack-size=1048576`
 * on the `diluvium_swarm_wasi.wasm` link line. Until that ships, the Lab
 * relocates the stack itself, which it can do because `__stack_pointer` is
 * an exported mutable global and a malloc'd block is memory nothing else
 * will touch. The shadow stack is a convention between the linker and the
 * generated code; no other part of the runtime knows where it is.
 *
 * It is conditional on measurement rather than on a version, so a build
 * that ships with a large enough stack is left alone and this quietly stops
 * happening. `test/swarm.spec.js` asserts the condition either way, so the
 * day upstream fixes it, the suite says so instead of going quiet.
 */
export const STACK_FLOOR = 96 * 1024;
export const STACK_WANTED = 1024 * 1024;

/**
 * Give a module a stack big enough to run a swarm in, if it has not got one.
 *
 * @returns {{moved: boolean, had: number, now: number, why: string}}
 */
export function ensureStack(exports, { floor = STACK_FLOOR, wanted = STACK_WANTED } = {}) {
  const low = exports.__stack_low?.value;
  const high = exports.__stack_high?.value;
  const pointer = exports.__stack_pointer;
  const had = (typeof low === 'number' && typeof high === 'number') ? high - low : null;

  if (had === null || !pointer) {
    return { moved: false, had, now: had, why: 'this module does not say where its stack is, so it was left alone' };
  }
  if (had >= floor) {
    return { moved: false, had, now: had, why: `its own ${Math.round(had / 1024)} KiB stack is enough` };
  }
  const block = exports.malloc(wanted);
  if (!block) {
    return { moved: false, had, now: had, why: 'there was no memory to relocate it into' };
  }
  // Never freed, deliberately: this block *is* the stack for the module's
  // remaining life, and freeing it would hand the allocator memory that is
  // being written to by every function call.
  //
  // Aligned down to 16, which is wasm's stack alignment. An unaligned stack
  // pointer is not a trap, it is a slow and occasionally wrong program.
  pointer.value = (block + wanted) & ~15;
  return {
    moved: true,
    had,
    now: wanted,
    why: `this build's ${Math.round(had / 1024)} KiB shadow stack is too small for dvs_step `
      + `(it needs at least ${Math.round(floor / 1024)} KiB), so the Lab moved it into a `
      + `${Math.round(wanted / 1024)} KiB heap block. The upstream fix is -Wl,-z,stack-size on `
      + 'the diluvium_swarm_wasi.wasm link line.',
  };
}

/**
 * A scope for allocations inside the guest's linear memory.
 *
 * Every name and every message has to live in the module's memory before
 * the ABI can see it, and every one of those has to come back. Doing it by
 * hand at each call site is how a wasm binding leaks.
 */
class Scratch {
  constructor(exports) {
    this.exports = exports;
    this.owned = [];
  }

  alloc(n) {
    const ptr = this.exports.malloc(n);
    if (!ptr) throw new Error(`out of memory allocating ${n} bytes inside the module`);
    this.owned.push(ptr);
    return ptr;
  }

  bytes(src) {
    const ptr = this.alloc(src.length || 1);
    // Derived after the malloc, which can grow memory and detach any view
    // taken before it.
    new Uint8Array(this.exports.memory.buffer).set(src, ptr);
    return ptr;
  }

  cstring(text) {
    const b = new TextEncoder().encode(text);
    const ptr = this.alloc(b.length + 1);
    const mem = new Uint8Array(this.exports.memory.buffer);
    mem.set(b, ptr);
    mem[ptr + b.length] = 0;
    return ptr;
  }

  free() {
    for (const ptr of this.owned) {
      try { this.exports.free(ptr); } catch { /* the module is already gone */ }
    }
    this.owned.length = 0;
  }
}

/**
 * The `env` imports `dvs_shim.c` declares.
 *
 * Late-bound the way the WASI shim late-binds memory: the module is
 * instantiated with these in place and the real host is installed
 * afterwards, because a `SwarmHost` needs the instance's exports to exist
 * before it can be built. The default `drive` throws by name -- an instance
 * silently dropped by a missing host is the failure this design has, and it
 * should arrive as a sentence rather than as a swarm that quietly does
 * nothing.
 */
export function swarmImports() {
  const ref = { current: null };
  return {
    ref,
    imports: {
      js_host_create: (ud, id, inst) => {
        const host = ref.current;
        if (!host) return id | 0;        // non-zero: dvs guards destroy on ctx
        return host._onCreate(id >>> 0, inst >>> 0) | 0;
      },
      js_host_destroy: (ud, id, ctx) => {
        ref.current?._onDestroy(id >>> 0, ctx >>> 0);
      },
      js_host_drive: (ud, id, inst, ctx) => {
        const host = ref.current;
        if (!host) {
          // Not a throw: unwinding the wasm stack out of `dvs_step` is worse
          // than an instance that does not advance, and the swarm is about to
          // be told it is finished anyway.
          return 0;
        }
        return host._onDrive(id >>> 0, inst >>> 0, ctx >>> 0) ? 1 : 0;
      },
    },
  };
}

/**
 * One swarm, driven from JavaScript.
 *
 * Construction is `start()` rather than the constructor because loading the
 * root program can fail, and a half-built host is worse than none.
 */
export class SwarmHost {
  /**
   * @param {object} exports the wasm instance's exports
   * @param {object} ref the `{current}` box `swarmImports()` returned
   * @param {object} [options]
   * @param {(text: string, fd?: 1|2) => void} [options.onOutput] where a
   *   guest's `print` goes; the shim collects it per-drain and this splits
   *   it out per step rather than per instance, which is honest -- WASI's
   *   fd 1 is the module's, and instances share the module.
   * @param {(event: object) => void} [options.onEvent] host-observed
   *   lifecycle, as it happens
   */
  constructor(exports, ref, options = {}) {
    this.exports = exports;
    this._ref = ref;
    this._layout = readLayout(exports);
    this._onEvent = options.onEvent ?? (() => {});
    this._drainOutput = options.drain ?? (() => ({ stdout: '', stderr: '' }));
    this.sw = 0;
    this.rootId = 0;
    /** id -> what the host knows about it. The roster of duty 3. */
    this.slots = new Map();
    /** Errors thrown inside a callback, which must never escape into wasm. */
    this._faults = [];
    /** The connector registry of duty 5; empty means every call is denied. */
    this._connectors = new Map();
    this._events = [];
    this._steps = 0;
    this._seq = 0;
    this._waitset = 0;
    this._queueInfo = 0;
    this._config = null;
  }

  // --- duty 1: construction ------------------------------------------

  /**
   * Create the swarm and start exactly one program: the root.
   *
   * Order matters and is not guessable: identity and the policy opt-outs
   * are read when a snapshot is taken, so they are set between `dvsjs_new`
   * and `dvs_root` -- "set it once, right after dvs_new, before anything
   * hibernates".
   *
   * @param {string} source the root program
   * @param {object} config the deployment, in `host/example.host.lua`'s shape
   */
  start(source, config = {}) {
    if (this.sw) throw new Error('this swarm is already running; free it first');
    const {
      maxInstances = 64,
      spawnsPerStep = 4,
      identity = null,
      hibernation = true,
      caps = [],
      budget = {},
      connectors = {},
      // Which exported queues to drain each step. A name list rather than a
      // discovery because there is no enumeration call for queues either: a
      // host is expected to know the names it agreed with the guest.
      watch = ['log', 'outbox', 'http_out'],
    } = config;

    if (!swarmCapable(this.exports)) {
      throw new Error(swarmProblems(this.exports).join('; '));
    }
    const code = new TextEncoder().encode(source);
    if (code.length > MAX_REQUEST_BYTES) {
      // Not the swarm's limit for a *root* -- dvs_root takes the source
      // directly -- but saying it here means a program that would be refused
      // as a spawn payload is refused at the same size wherever it appears,
      // which is the surprise this check exists to remove.
      this._note('the root program is larger than a spawn request may be '
        + `(${code.length} > ${MAX_REQUEST_BYTES} bytes), so it could not be spawned by a supervisor`);
    }

    this._config = {
      maxInstances, spawnsPerStep, identity, hibernation,
      caps: [...caps], budget, connectors, watch: [...watch],
    };
    this.sw = this.exports.dvsjs_new(maxInstances, spawnsPerStep);
    if (!this.sw) throw new Error('dvsjs_new returned NULL: the swarm could not be created');
    this._ref.current = this;

    const scratch = new Scratch(this.exports);
    try {
      if (identity) {
        const st = this.exports.dvs_set_host_identity(this.sw, scratch.cstring(identity));
        if (st !== DVS.OK) throw new Error(`dvs_set_host_identity: ${this._lastError(st)}`);
      }
      if (!hibernation) this.exports.dvs_allow_hibernation(this.sw, 0);

      // The root's ceiling: an array of pointers to cstrings, which is what
      // `const char *const *` is on the far side.
      const capPtrs = caps.map((c) => scratch.cstring(c));
      const capArray = scratch.alloc(Math.max(4, capPtrs.length * 4));
      {
        const view = new DataView(this.exports.memory.buffer);
        capPtrs.forEach((p, i) => view.setUint32(capArray + i * 4, p, true));
      }
      const codePtr = scratch.bytes(code);
      const out = scratch.alloc(4);
      const st = this.exports.dvs_root(
        this.sw, codePtr, code.length, capArray, capPtrs.length,
        BigInt(budget.instructions ?? 0), BigInt(budget.memoryKb ?? 0), out,
      );
      if (st !== DVS.OK) {
        const detail = this._lastError(st);
        this.free();
        throw new Error(`the root program did not load (${DVS_NAMES[st] ?? st}): ${detail}`);
      }
      this.rootId = new DataView(this.exports.memory.buffer).getUint32(out, true);
    } finally {
      scratch.free();
    }

    // Connectors are wired by `connect()` before `start()`, not from this
    // object: a connector is a function and the configuration is data.
    // That split is the same one the C host has -- `example.host.lua` names
    // `sql = {path = ...}` and `dhost_sql.c` is what answers -- and it is
    // what lets the configuration cross a worker boundary at all.
    this._declared = connectors;
    this._emit({ event: 'host', id: 0, detail: `swarm up: root is instance ${this.rootId}` });
    return this.rootId;
  }

  // --- duty 2: the drive loop ----------------------------------------

  /**
   * One `dvs_step`, plus the pumps that bracket it.
   *
   * The order is the whole protocol in four lines, and it is the order the
   * C host uses: answer hostcalls first so a program parked on its replies
   * has something to wake for, then step (which drains `system/lifecycle`,
   * spawns, and drives every resident instance once through `drive`), then
   * drain what the guests exported.
   *
   * @returns {number} instances still alive
   */
  step() {
    if (!this.sw) return 0;
    this._steps++;
    this._pumpHostcalls();
    const alive = this.exports.dvs_step(this.sw);
    this._drainExports();
    this._collectOutput();
    return alive;
  }

  /**
   * Step until nothing is alive, a step budget runs out, or a wall-clock
   * slice does.
   *
   * A slice rather than a loop to exhaustion, because this runs on a thread
   * that has other things to answer -- in the worker, the Stop message; in
   * the baked build, the page itself. `dvs_step` is synchronous and cannot
   * be interrupted, so the only place control can be given back is between
   * steps, and this is that place.
   */
  runSlice({ maxSteps = 64, budgetMs = 20 } = {}) {
    const started = performance.now();
    let alive = this.exports.dvs_alive(this.sw);
    let steps = 0;
    while (alive > 0 && steps < maxSteps && performance.now() - started < budgetMs) {
      alive = this.step();
      steps++;
    }
    return { alive, steps, ms: performance.now() - started };
  }

  /**
   * `drive`, called from inside `dvs_step` for every resident instance.
   *
   * Deliver the round-robin next queue that has something, or start the
   * program, or report it finished. Round-robin rather than first-match is
   * not a nicety: a program waiting on `{urgent, work}` where `urgent`
   * always has a message would never be handed `work` at all, and the
   * review of that toy swarm lists exactly that as a fix to carry forward.
   *
   * @returns {boolean} true to keep the instance, false when it is finished
   */
  _onDrive(id, inst, ctx) {
    const slot = this.slots.get(id);
    try {
      const waitset = this._waitsetPtr();
      const status = this.exports.dv_waitset_get(inst, waitset);
      if (status === DV.OK) {
        const ids = this._readWaitset(waitset);
        if (ids.length > 0) {
          const start = slot ? slot.rrNext : 0;
          for (let k = 0; k < ids.length; k++) {
            const i = (start + k) % ids.length;
            const info = this._readQueue(inst, ids[i]);
            if (info && info.length > 0) {
              if (slot) slot.rrNext = (i + 1) % ids.length;
              const st = this.exports.dv_resume(inst, ids[i]);
              return this._settle(id, inst, st, slot);
            }
          }
          if (slot) slot.parked = true;
          return true;                   // parked; nothing to deliver yet
        }
      }
      const st = this.exports.dv_run(inst, waitset);
      if (st === DV.BUSY) return true;
      return this._settle(id, inst, st, slot);
    } catch (err) {
      // Never rethrow: this frame is inside `dvs_step`.
      this._fault('drive', id, err);
      return false;
    }
  }

  /**
   * What a `dv_run`/`dv_resume` status means for the instance's life, and
   * -- the part a roster needs -- *why* it ended.
   *
   * Read here rather than at `destroy`, because by then the instance has
   * been freed and `dv_exceeded` has nothing to answer about. This is the
   * only moment the difference between exited, faulted and exceeded is
   * still knowable from outside.
   */
  _settle(id, inst, status, slot) {
    if (status === DV.IDLE) {
      if (slot) slot.parked = true;
      return true;
    }
    if (slot) {
      slot.parked = false;
      slot.finalUsage = this._usage(inst);
      // The last moment this instance exists. `destroy` fires after the
      // swarm has released it, and by then its queues are gone -- so a
      // program whose final act is to push its answer to `outbox` would
      // have that answer silently disappear, which is what the first
      // version of this file did. Drain here, before saying it is
      // finished.
      this._drainInstance(slot.id, inst);
      if (status === DV.DONE) {
        slot.outcome = 'exited';
      } else if (this.exports.dv_exceeded(inst) !== 0) {
        slot.outcome = 'exceeded';
        slot.detail = readCString(this.exports, this.exports.dv_last_error(inst));
      } else {
        slot.outcome = 'faulted';
        slot.detail = readCString(this.exports, this.exports.dv_last_error(inst));
      }
    }
    return false;
  }

  // --- duty 3: the roster --------------------------------------------

  /**
   * `create` fires for every instance that comes to exist -- spawn and wake
   * alike -- and `destroy` for every one that stops being resident, death
   * and hibernate alike. There is deliberately no enumeration API, so this
   * pair *is* the roster.
   *
   * The return value is load-bearing: `dvs.c` guards its destroy callback
   * on `ctx != NULL`, so a host returning 0 is never told the instance went
   * away. `swarmd.c` found that the hard way, and the C host allocates a
   * one-field struct for exactly this reason. Here the id itself is the
   * context, which is never 0.
   */
  _onCreate(id, inst) {
    try {
      const existing = this.slots.get(id);
      if (existing) {
        // A wake, not a spawn: the id is the swarm's and is never reused, so
        // seeing one twice means it came back rather than that two things
        // share it.
        existing.resident = true;
        existing.wakes++;
        this._emit({ event: 'status', id, detail: 'woke from the snapshot cache' });
        return id;
      }
      // Read once. `this.rootId` is not assigned until `dvs_root` returns,
      // and `create` fires from inside it -- so "am I the root" has to be
      // asked of the swarm (no parent) rather than of a field that is
      // still 0 at the only moment it matters.
      const parent = this.exports.dvs_parent(this.sw, id) >>> 0;
      this.slots.set(id, {
        id,
        parent,
        createdAtStep: this._steps,
        resident: true,
        parked: false,
        rrNext: 0,
        wakes: 0,
        outcome: null,
        detail: null,
        finalUsage: null,
        caps: this._capsOf(id),
        budget: this._budgetOf(id),
      });
      this._emit({ event: 'spawned', id, detail: parent === 0 ? 'the root' : `child of ${parent}` });
      return id;
    } catch (err) {
      this._fault('create', id, err);
      return id;
    }
  }

  /**
   * Death and hibernation arrive through the same callback, and telling
   * them apart is the host's job rather than the callback's.
   *
   * `dvs_cached_size` is the discriminator: a hibernated instance has
   * bytes in the cache and a dead one does not. Asked here, after the
   * swarm has done whatever it was doing, because that is when the answer
   * is true.
   */
  _onDestroy(id) {
    try {
      const slot = this.slots.get(id);
      if (!slot) return;
      slot.resident = false;
      const cached = this.exports.dvs_cached_size(this.sw, id) >>> 0;
      if (cached > 0) {
        slot.cachedSize = cached;
        this._emit({ event: 'hibernated', id, detail: `${cached} bytes cached` });
        return;
      }
      slot.gone = true;
      slot.goneAtStep = this._steps;
      this._emit({
        event: slot.outcome ?? 'exited',
        id,
        detail: slot.detail ?? (slot.outcome === 'exited' ? 'returned' : 'stopped being resident'),
      });
    } catch (err) {
      this._fault('destroy', id, err);
    }
  }

  /**
   * The roster, as the panel reads it.
   *
   * Every figure is asked of the thing it describes at the moment of
   * asking. The one documented hole is a hibernated instance's instruction
   * count: the number is in its snapshot header and the swarm API has no
   * accessor for it yet, so such an instance reports its budget and its
   * cached size and `usage: null`. `doc/Host.md` calls that the agreed v1
   * behaviour, and showing the last resident figure instead would be
   * showing a stale number as a live one.
   */
  roster() {
    if (!this.sw) return [];
    const out = [];
    for (const slot of this.slots.values()) {
      const resident = !slot.gone && this.exports.dvs_resident(this.sw, slot.id) === 1;
      const inst = resident ? this.exports.dvs_instance(this.sw, slot.id) : 0;
      out.push({
        id: slot.id,
        parent: slot.parent,
        role: slot.parent === 0 ? 'root' : 'child',
        state: slot.gone ? 'gone' : resident ? (slot.parked ? 'parked' : 'running') : 'hibernated',
        outcome: slot.outcome,
        detail: slot.detail,
        caps: slot.caps,
        budget: slot.budget,
        usage: inst ? this._usage(inst) : (slot.gone ? slot.finalUsage : null),
        exceeded: inst ? this.exports.dv_exceeded(inst) !== 0 : slot.outcome === 'exceeded',
        cachedSize: resident ? 0 : (this.exports.dvs_cached_size(this.sw, slot.id) >>> 0),
        queues: inst ? this._queuesOf(inst) : [],
        createdAtStep: slot.createdAtStep,
        goneAtStep: slot.goneAtStep ?? null,
        wakes: slot.wakes,
      });
    }
    return out.sort((a, b) => a.id - b.id);
  }

  /** Everything the panel needs in one round trip, because it is across a worker. */
  snapshot() {
    return {
      running: this.sw !== 0,
      rootId: this.rootId,
      steps: this._steps,
      alive: this.sw ? this.exports.dvs_alive(this.sw) : 0,
      config: this._config,
      connectors: [...this._connectors.keys()].sort(),
      roster: this.roster(),
      events: this._events,
      faults: this._faults,
    };
  }

  // --- duty 4: the queue pump ----------------------------------------

  /**
   * Push a message into a guest's queue by name.
   *
   * `dvs_push` rather than `dv_queue_push` because it is the only call that
   * knows what to do about a non-resident destination: a cached instance
   * with `wake_on_message` gets a bounded host buffer and comes back, one
   * without it is `gone`. Reimplementing that here would be a second
   * delivery policy.
   */
  push(id, queue, value) {
    if (!this.sw) throw new Error('no swarm is running');
    const payload = value instanceof Uint8Array ? value : encode(value);
    const scratch = new Scratch(this.exports);
    try {
      const st = this.exports.dvs_push(
        this.sw, id, scratch.cstring(queue), scratch.bytes(payload), payload.length,
      );
      return { status: DVS_NAMES[st] ?? String(st), detail: st === DVS.OK ? null : this._lastError(st) };
    } finally {
      scratch.free();
    }
  }

  /**
   * Drain the queues a deployment said it cares about.
   *
   * "Exported" is the guest's word for a queue the host may read, so this
   * asks about the names the configuration named and takes what is there.
   * There is no enumeration call for queues either, which is why a name
   * list is the interface rather than a discovery.
   */
  _drainExports() {
    for (const slot of this.slots.values()) {
      if (slot.gone) continue;
      const inst = this.exports.dvs_instance(this.sw, slot.id);
      if (!inst) continue;               // hibernated: its messages sleep with it
      this._drainInstance(slot.id, inst);
    }
  }

  /** One instance's watched queues, emptied. Safe to call twice; a queue
   * that has already been drained is simply empty. */
  _drainInstance(id, inst) {
    const watch = this._config?.watch ?? ['log', 'outbox', 'http_out'];
    for (const name of watch) {
      const qid = this._lookup(inst, name);
      if (!qid) continue;
      for (;;) {
        const msg = this._pop(inst, qid);
        if (msg === undefined) break;
        this._emit({ event: 'message', id, queue: name, detail: describeMessage(msg), value: msg });
      }
    }
  }

  // --- duty 5: hostcalls ---------------------------------------------

  /**
   * Wire a connector. Every one is off until a deployment names it, which
   * is what makes "the guest cannot tell a mock from the real thing" a
   * property of configuration rather than of luck.
   *
   * @param {string} prefix the family: `time`, `sql`, `js`
   * @param {(call: string, args: any, id: number) => {status: string, value?: any, detail?: string}} fn
   */
  connect(prefix, fn) {
    this._connectors.set(prefix, fn);
  }

  /**
   * Drain every resident guest's `host/calls`, answer each one, push the
   * reply to `host/replies`.
   *
   * Three rules from `doc/Hostcall.md`, all load-bearing:
   *
   *   Every drained request is answered -- `ok`, `denied`, `error` or
   *   `malformed`, never dropped, because a dropped request is invisible
   *   backpressure.
   *
   *   The correlation token is echoed verbatim and never interpreted. A
   *   guest may have several requests outstanding; replies arrive in
   *   whatever order the host answers.
   *
   *   A request is not *drained* until there is room for its reply. That
   *   looks like an optimisation and is not: answering, failing to
   *   deliver, and recomputing next turn would double-apply a stateful
   *   connector's write.
   */
  _pumpHostcalls() {
    for (const slot of this.slots.values()) {
      if (slot.gone) continue;
      const inst = this.exports.dvs_instance(this.sw, slot.id);
      if (!inst) continue;               // hibernated: its calls wait with it
      const calls = this._lookup(inst, HOSTCALL_QUEUE);
      if (!calls) continue;              // declares none, so costs nothing
      const replies = this._lookup(inst, HOSTREPLY_QUEUE);
      for (;;) {
        if (replies) {
          const info = this._readQueue(inst, replies);
          if (info && info.capacity > 0 && info.length >= info.capacity) break;
        }
        const raw = this._peek(inst, calls);
        if (raw === undefined) break;
        const reply = this._answer(slot.id, raw);
        this.exports.dv_queue_release(inst, calls);
        if (replies) {
          const bytes = encode(reply);
          this.exports.dv_queue_push(inst, replies, ...this._inMemory(bytes));
        }
        // No reply queue means the program asked and declared nowhere to
        // hear the answer. The request is consumed so the queue cannot
        // wedge; the reply has nowhere to go, which is its own diagnostic.
      }
    }
  }

  /** One request, answered. Never throws: a connector's bug is an `error` reply. */
  _answer(id, raw) {
    let request;
    try {
      request = decode(raw);
    } catch (err) {
      return { status: 'malformed', detail: `the request is not msgpack: ${err.message}` };
    }
    const tok = request && typeof request === 'object' ? request.tok : undefined;
    const hasTok = typeof tok === 'number' && Number.isInteger(tok) && tok >= 0;
    const call = request && typeof request === 'object' ? request.call : undefined;

    if (!hasTok || typeof call !== 'string' || call === '') {
      // Answered with whatever token was readable, because an
      // uncorrelatable reply is the sender's own diagnostic where silence
      // diagnoses nothing.
      const reply = { status: 'malformed', detail: !hasTok
        ? "a hostcall request needs an integer 'tok' (Hostcall.md: the correlation "
          + 'token is required, from the first prototype on)'
        : "a hostcall request needs a 'call' string naming what is asked" };
      if (hasTok) reply.tok = tok;
      return reply;
    }

    const cap = `host:${call}`;
    if (!this._holds(id, cap)) {
      return { tok, status: 'denied', detail:
        `this program does not hold '${cap}'; a call outside the grant is refused, never dropped` };
    }

    const family = call.includes('/') ? call.slice(0, call.indexOf('/')) : call;
    const connector = this._connectors.get(family);
    if (!connector) {
      return { tok, status: 'denied', detail:
        `no connector answers '${call}' in this deployment; connectors are all off by default `
        + 'and wired by configuration' };
    }

    try {
      const answer = connector(call, request.args, id) ?? {};
      if (answer.status === 'ok') return { tok, status: 'ok', value: answer.value ?? null };
      return {
        tok,
        status: answer.status === 'denied' ? 'denied' : 'error',
        detail: answer.detail ?? 'the connector refused without saying why, which is its bug',
      };
    } catch (err) {
      return { tok, status: 'error', detail: `the connector threw: ${err.message}` };
    }
  }

  /**
   * `dvs_holds`, so a host mediating its own resources asks the same
   * question the swarm asks about queues. Reimplementing the pattern match
   * here would be a second policy, and the two would drift.
   */
  _holds(id, cap) {
    const scratch = new Scratch(this.exports);
    try {
      return this.exports.dvs_holds(this.sw, id, scratch.cstring(cap)) === 1;
    } finally {
      scratch.free();
    }
  }

  // --- duty 6: hibernation policy ------------------------------------

  /** The mechanism is the runtime's; *when* is the host's, and here it is a button. */
  hibernate(id) {
    const st = this.exports.dvs_hibernate(this.sw, id);
    return { status: DVS_NAMES[st] ?? String(st), detail: st === DVS.OK ? null : this._lastError(st) };
  }

  wake(id) {
    const st = this.exports.dvs_wake(this.sw, id);
    return { status: DVS_NAMES[st] ?? String(st), detail: st === DVS.OK ? null : this._lastError(st) };
  }

  kill(id) {
    const st = this.exports.dvs_kill(this.sw, id);
    return { status: DVS_NAMES[st] ?? String(st), detail: st === DVS.OK ? null : this._lastError(st) };
  }

  // --- duty 7: shutdown ----------------------------------------------

  /**
   * Stop stepping, then `dvs_free`, which releases every slot.
   *
   * Nothing here is graceful by magic: a program that should flush on
   * shutdown should be told, by a message, like everything else.
   */
  free() {
    if (!this.sw) return;
    const sw = this.sw;
    this.sw = 0;                         // before the call: destroy fires during it
    this._ref.current = null;
    try { this.exports.dvs_free(sw); } catch (err) { this._fault('free', 0, err); }
    for (const ptr of [this._waitset, this._queueInfo]) {
      if (ptr) { try { this.exports.free(ptr); } catch { /* module gone */ } }
    }
    this._waitset = 0;
    this._queueInfo = 0;
  }

  // --- the small mechanical half -------------------------------------

  _waitsetPtr() {
    if (!this._waitset) this._waitset = this.exports.malloc(this._layout.WAITSET_SIZE);
    if (!this._waitset) throw new Error('out of memory allocating a wait-set');
    new Uint8Array(this.exports.memory.buffer)
      .fill(0, this._waitset, this._waitset + this._layout.WAITSET_SIZE);
    return this._waitset;
  }

  _readWaitset(ptr) {
    const view = new DataView(this.exports.memory.buffer);
    const count = view.getUint32(ptr + this._layout.WAITSET_N, true);
    // Clamped rather than trusted: this is a length read out of another
    // language's struct.
    const max = Math.floor((this._layout.WAITSET_TIMEOUT - this._layout.WAITSET_IDS) / 4);
    const ids = [];
    for (let i = 0; i < Math.min(count, max); i++) {
      ids.push(view.getUint32(ptr + this._layout.WAITSET_IDS + i * 4, true));
    }
    return ids;
  }

  _queueInfoPtr() {
    if (!this._queueInfo) this._queueInfo = this.exports.malloc(this._layout.QUEUE_INFO_SIZE);
    if (!this._queueInfo) throw new Error('out of memory allocating a queue info');
    return this._queueInfo;
  }

  _readQueue(inst, qid) {
    const ptr = this._queueInfoPtr();
    if (this.exports.dv_queue_state(inst, qid, ptr) !== DV.OK) return null;
    const view = new DataView(this.exports.memory.buffer);
    return {
      id: qid,
      capacity: view.getUint32(ptr + this._layout.QUEUE_INFO_CAPACITY, true),
      length: view.getUint32(ptr + this._layout.QUEUE_INFO_LEN, true),
      enabled: view.getUint8(ptr + this._layout.QUEUE_INFO_ENABLED) !== 0,
      exported: view.getUint8(ptr + this._layout.QUEUE_INFO_EXPORTED) !== 0,
    };
  }

  _lookup(inst, name) {
    const scratch = new Scratch(this.exports);
    try {
      return this.exports.dv_queue_lookup(inst, scratch.cstring(name)) >>> 0;
    } finally {
      scratch.free();
    }
  }

  /** Peek without consuming: the pump must be able to leave a request in place. */
  _peek(inst, qid) {
    const scratch = new Scratch(this.exports);
    try {
      const pp = scratch.alloc(4);
      const plen = scratch.alloc(4);
      const st = this.exports.dv_queue_peek(inst, qid, pp, plen);
      if (st !== DV.OK) return undefined;
      const view = new DataView(this.exports.memory.buffer);
      const ptr = view.getUint32(pp, true);
      const len = view.getUint32(plen, true);
      return new Uint8Array(this.exports.memory.buffer).slice(ptr, ptr + len);
    } finally {
      scratch.free();
    }
  }

  _pop(inst, qid) {
    const raw = this._peek(inst, qid);
    if (raw === undefined) return undefined;
    this.exports.dv_queue_release(inst, qid);
    try {
      return decode(raw);
    } catch {
      return { '(undecodable)': [...raw.slice(0, 32)] };
    }
  }

  /** Bytes into linear memory for a call that takes `(ptr, len)`. Frees after. */
  _inMemory(bytes) {
    const ptr = this.exports.malloc(bytes.length || 1);
    if (!ptr) throw new Error('out of memory pushing a reply');
    new Uint8Array(this.exports.memory.buffer).set(bytes, ptr);
    // The runtime copies on push, so the buffer is ours to release at once.
    queueMicrotask(() => { try { this.exports.free(ptr); } catch { /* gone */ } });
    return [ptr, bytes.length];
  }

  _usage(inst) {
    const ptr = this.exports.malloc(16);
    if (!ptr) return null;
    try {
      this.exports.dv_usage(inst, ptr, ptr + 8);
      const view = new DataView(this.exports.memory.buffer);
      return {
        instructions: Number(view.getBigUint64(ptr, true)),
        peakMemoryKb: Number(view.getBigUint64(ptr + 8, true)),
      };
    } finally {
      this.exports.free(ptr);
    }
  }

  _budgetOf(id) {
    const ptr = this.exports.malloc(16);
    if (!ptr) return null;
    try {
      if (this.exports.dvs_budget(this.sw, id, ptr, ptr + 8) !== DVS.OK) return null;
      const view = new DataView(this.exports.memory.buffer);
      return {
        instructions: Number(view.getBigUint64(ptr, true)),
        memoryKb: Number(view.getBigUint64(ptr + 8, true)),
      };
    } finally {
      this.exports.free(ptr);
    }
  }

  /**
   * `dvs_caps` twice: once with max 0 to learn the count, once to read it.
   *
   * The header documents that shape explicitly -- "a caller can size a
   * buffer by asking with max == 0" -- and 9.3's attenuation is only
   * auditable if the set can be read out, which is what this is for.
   */
  _capsOf(id) {
    const count = this.exports.dvs_caps(this.sw, id, 0, 0) >>> 0;
    if (!count) return [];
    const ptr = this.exports.malloc(count * 4);
    if (!ptr) return [];
    try {
      const wrote = this.exports.dvs_caps(this.sw, id, ptr, count) >>> 0;
      const view = new DataView(this.exports.memory.buffer);
      const out = [];
      for (let i = 0; i < Math.min(wrote, count); i++) {
        out.push(readCString(this.exports, view.getUint32(ptr + i * 4, true)));
      }
      return out;
    } finally {
      this.exports.free(ptr);
    }
  }

  _queuesOf(inst) {
    const names = ['inbox', 'outbox', 'system/events', 'system/lifecycle',
      HOSTCALL_QUEUE, HOSTREPLY_QUEUE, 'log', 'roles', 'code', 'work',
      'http_in', 'http_out'];
    const out = [];
    for (const name of names) {
      const qid = this._lookup(inst, name);
      if (!qid) continue;
      const info = this._readQueue(inst, qid);
      if (info) out.push({ name, ...info });
    }
    return out;
  }

  _lastError(status) {
    const ptr = this.exports.dvs_last_error(this.sw);
    return readCString(this.exports, ptr) ?? `dvs status ${DVS_NAMES[status] ?? status}`;
  }

  _collectOutput() {
    const { stdout, stderr } = this._drainOutput();
    if (stdout) this._emit({ event: 'stdout', id: 0, detail: stdout });
    if (stderr) this._emit({ event: 'stderr', id: 0, detail: stderr });
  }

  _emit(event) {
    const record = { seq: ++this._seq, step: this._steps, ...event };
    // Bounded: a swarm can run for as long as someone leaves it running,
    // and an unbounded log is the one place in this page where a slow leak
    // would be invisible.
    this._events.push(record);
    if (this._events.length > 2000) this._events.splice(0, this._events.length - 2000);
    try { this._onEvent(record); } catch { /* a listener's bug is not the swarm's */ }
  }

  _note(detail) {
    this._emit({ event: 'status', id: 0, detail });
  }

  _fault(where, id, err) {
    const record = { where, id, message: err?.message ?? String(err), at: this._steps };
    this._faults.push(record);
    this._emit({ event: 'faulted', id, detail: `the host's ${where} callback threw: ${record.message}` });
  }
}

/** A one-line rendering of a drained message, for the event list. */
function describeMessage(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  try {
    const text = JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? `${v}` : v));
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  } catch {
    return String(value);
  }
}
