// The JS half of DRT's browser tier: `doc/Browser.md`'s host bridge.
//
// DRT is the Diluvium RunTime — the Rust reimplementation of the swarm
// layer and the generic host that are being lifted out of the C tree. Its
// browser build (`drt-web`, a wasm-bindgen `cdylib`) carries the swarm
// bookkeeping, and it reaches a *diluvium instance* by calling back out to
// JavaScript, because two wasm modules cannot call each other directly in a
// page. This file is that callee.
//
// ## Why this is the shape, and not the other one
//
// `SPEC.md` §4 designates the Lab's JS host as DRT's browser
// implementation, so this is not a workaround for a missing feature — it is
// the named plan. `drt-web` defines the contract (`HostBridge` in
// `crates/drt-web/src/bridge.rs`) because whoever owns the trait writes the
// contract; this implements it against the `dv_` ABI the Lab already loads.
//
// The consequence worth stating: **this path does not use
// `diluvium_swarm_wasi.wasm` at all.** Today the Lab loads a kernel plus
// that swarm module and drives `dvs_*` exports; under DRT it loads a kernel
// plus `drt-web` and the C swarm module is gone. Since diluvium plans to
// delete `dvs.c` once DRT's swarm passes acceptance, the Lab is not racing
// that deletion — it is stepping off the dependency.
//
// ## The six calls that move
//
// The Lab already spoke seventeen `dv_` calls. Six more move from C into
// JavaScript here, because they were what `dvs.c` did on the far side of
// the wall: `dv_queue_push`, `dv_queue_pop`, `dv_resume`, `dv_waitset_get`,
// `dv_restore` and `dv_memory`. All six are exported by the kernel the Lab
// already ships, which is why this file can be written and tested before
// `drt-web` exists.
//
// ## Two rules that shape every function below
//
// **Throwing is part of the contract, and so is not throwing.** `doc/
// Browser.md` splits the surface: the fallible imports may throw and the
// shim turns the exception into an `EngineError`, routed by *which* import
// threw — `run`/`resume`/`resumeTimeout`/`load` become a program fault (the
// instance's fate), `queueInfo`/`push`/`pop`/`snapshot` become an engine
// fault. The rest — `abiVersion`, `release`, `queue`, `currentWait`,
// `usage`, `exceeded`, and above all `drive` — have nowhere to put an
// exception, and one thrown from them aborts the module. Those catch
// everything and return a safe value. `drive` reports a fault as
// `{faulted}`, a *value*, for the reason `swarm.js` already gives itself:
// unwinding the wasm stack out of a step is worse than an instance that
// does not advance.
//
// **Any allocation can detach every view.** `malloc` may grow the module's
// memory, which detaches any `DataView` or `Uint8Array` taken before it.
// So nothing here holds one across a call; `u8()` and `view()` re-derive
// on every use. This is the hazard `instance.js` documents and the one
// that produces silent garbage rather than an error.

import { readLayout, readCString, EXPECTED_ABI, FLAG_TEXT_ONLY } from './instance.js';

/** `DV_FLAG_UNSAFE_STDLIB`: give the program `io`, `os` and `package`. */
export const FLAG_UNSAFE_STDLIB = 0x4;

/** `dv_status`, in dv.h's order. */
const DV_CODE = {
  OK: 0, QUEUE_FULL: 1, QUEUE_DISABLED: 2, QUEUE_UNKNOWN: 3, QUEUE_EMPTY: 4,
  QUEUE_GONE: 5, IDLE: 6, DONE: 7, ERROR: 8, ABI_MISMATCH: 9,
  SNAPSHOT_MISMATCH: 10, BUSY: 11, BUFFER_TOO_SMALL: 12, QUEUE_DROPPED: 13,
};

/**
 * The `dv_` calls this bridge needs.
 *
 * Longer than `instance.js`'s list, and deliberately so: that file runs a
 * program once and can do without `dv_resume`, while a swarm exists to
 * drive parked instances and cannot. A build missing one of these cannot
 * back `drt-web`, and saying which is missing beats an empty panel.
 */
const BRIDGE_REQUIRED = [
  'dv_abi_version', 'dv_layout', 'dv_new', 'dv_free', 'dv_load', 'dv_run',
  'dv_resume', 'dv_waitset_get', 'dv_last_error', 'dv_status_name',
  'dv_set_budget', 'dv_usage', 'dv_memory', 'dv_exceeded',
  'dv_queue_lookup', 'dv_queue_state', 'dv_queue_push', 'dv_queue_pop',
  'dv_snapshot', 'dv_restore', 'malloc', 'free',
];

/**
 * Can this module back the browser tier?
 *
 * The counterpart to `swarm.js`'s `swarmCapable`, and the seam
 * `doc/Browser.md` names for recognising a second backend: a page asks
 * both and takes whichever answers. Asked of the module, never of a
 * version string.
 */
export function bridgeCapable(exports) {
  if (!exports) return false;
  if (!BRIDGE_REQUIRED.every((name) => typeof exports[name] === 'function')) return false;
  try {
    return exports.dv_abi_version() === EXPECTED_ABI;
  } catch {
    return false;
  }
}

/**
 * Why a module cannot back the browser tier, as sentences.
 *
 * `swarmProblems`' counterpart, for the same reason: "it does not export
 * dv_resume" points at the build, and an empty panel points at nothing.
 */
export function bridgeProblems(exports) {
  if (!exports) return ['there is no module loaded'];
  const missing = BRIDGE_REQUIRED.filter((name) => typeof exports[name] !== 'function');
  if (missing.length) {
    return [`this build is missing ${missing.join(', ')}`];
  }
  let abi;
  try {
    abi = exports.dv_abi_version();
  } catch (err) {
    return [`this build's dv_abi_version() threw: ${err.message}`];
  }
  if (abi !== EXPECTED_ABI) {
    return [`this build speaks dv ABI v${abi} and the bridge was written against v${EXPECTED_ABI}`];
  }
  return [];
}

/**
 * Build the sixteen-function object `drt-web` is constructed with.
 *
 * Sixteen, not the fifteen `doc/Browser.md`'s import block lists: `release`
 * appears in that document's may-throw table and in `HostBridge` but was
 * left out of the code block. It is not optional — `BrowserInstance`'s drop
 * calls it, and without it a swarm that hibernates and kills leaks this
 * table for the page's lifetime.
 *
 * @param {object} exports the wasm instance's exports, speaking `dv_`
 * @param {object} [options]
 * @param {(id: number, handle: number, inst: Bridged) => object} [options.drive]
 *   one drive of one instance, synchronously. The host's duty, injected
 *   rather than implemented here: what a drive *does* — pump hostcalls,
 *   then advance — belongs to the layer that owns the connectors, and this
 *   file owns only the ABI. The default advances the instance and nothing
 *   more, which is enough to test the crossing.
 * @param {(text: string, fd?: 1|2) => void} [options.onOutput]
 * @returns {object} the bridge, plus `_table` for assertions
 */
export function createBridge(exports, options = {}) {
  const problems = bridgeProblems(exports);
  if (problems.length) throw new Error(`this build cannot back drt-web: ${problems[0]}`);

  const layout = readLayout(exports);

  /** handle -> the instance behind it. Handles are minted here and opaque
   * to Rust, which is what `doc/Browser.md` asks for. */
  const table = new Map();
  /** swarm instance id -> handle, learned at `drive`. See `handleFor`. */
  const byId = new Map();
  let nextHandle = 1;                 // 0 is never a handle, matching dv_queue_id

  // Re-derived on every use: see the note at the top of the file about
  // allocation detaching views.
  const u8 = () => new Uint8Array(exports.memory.buffer);
  const view = () => new DataView(exports.memory.buffer);

  const statusName = (status) => readCString(exports, exports.dv_status_name(status))
    ?? `status ${status}`;

  const lastError = (inst) => readCString(exports, exports.dv_last_error(inst));

  /** A scratch allocation, always released. */
  function withMemory(bytes, fn) {
    const ptr = exports.malloc(bytes);
    if (!ptr) throw new Error(`out of memory allocating ${bytes} bytes`);
    try {
      return fn(ptr);
    } finally {
      exports.free(ptr);
    }
  }

  /** A NUL-terminated copy of `text` in linear memory. */
  function withCString(text, fn) {
    const bytes = new TextEncoder().encode(`${text}\0`);
    return withMemory(bytes.length, (ptr) => {
      u8().set(bytes, ptr);
      return fn(ptr, bytes.length - 1);
    });
  }

  /** The instance behind a handle, or a throw naming the handle. */
  function need(handle) {
    const entry = table.get(handle);
    if (!entry) throw new Error(`no instance for handle ${handle}`);
    return entry;
  }

  /**
   * A fresh instance with its flags and budget already applied.
   *
   * The order is dv.h's and is not negotiable: `dv_set_budget` refuses an
   * instance that has started, so the budget goes on before the load or
   * the restore, never after.
   */
  function fresh(budget, unsafeStdlib) {
    let flags = FLAG_TEXT_ONLY;      // bytecode never reaches here; see below
    if (unsafeStdlib) flags |= FLAG_UNSAFE_STDLIB;

    const config = exports.malloc(layout.CONFIG_SIZE);
    if (!config) throw new Error('out of memory building an instance config');
    let inst = 0;
    try {
      u8().fill(0, config, config + layout.CONFIG_SIZE);
      const v = view();
      v.setUint32(config + layout.CONFIG_ABI, EXPECTED_ABI, true);
      v.setUint32(config + layout.CONFIG_FLAGS, flags, true);
      inst = exports.dv_new(config);
    } finally {
      exports.free(config);
    }
    if (!inst) throw new Error('dv_new returned NULL');

    const instructions = BigInt(budget?.instructions ?? 0);
    const memoryKb = BigInt(budget?.memoryKb ?? 0);
    if (instructions > 0n || memoryKb > 0n) {
      const status = exports.dv_set_budget(inst, instructions, memoryKb);
      if (status !== DV_CODE.OK) {
        const why = lastError(inst) ?? statusName(status);
        exports.dv_free(inst);
        throw new Error(`the budget was refused: ${why}`);
      }
    }
    return inst;
  }

  /** Read a `dv_waitset` out of linear memory. */
  function readWaitset(ptr) {
    const v = view();
    const count = v.getUint32(ptr + layout.WAITSET_N, true);
    // The count is clamped rather than trusted: it is a length read out of
    // another language's struct, and the array is the real bound.
    const max = Math.floor((layout.WAITSET_TIMEOUT - layout.WAITSET_IDS) / 4);
    const queues = [];
    for (let i = 0; i < Math.min(count, max); i++) {
      queues.push(v.getUint32(ptr + layout.WAITSET_IDS + i * 4, true));
    }
    const timeout = Number(v.getBigInt64(ptr + layout.WAITSET_TIMEOUT, true));
    return {
      queues,
      // dv.h: negative means the program set no timeout. `null` says that
      // in a shape Rust reads as `Option::None` rather than as a duration
      // of minus one.
      timeoutMs: timeout < 0 ? null : timeout,
      forSpace: v.getUint8(ptr + layout.WAITSET_FOR_WRITE) !== 0,
    };
  }

  /**
   * `dv_run`/`dv_resume`'s status as a `Step`.
   *
   * `DV_ERROR` throws rather than returning: `doc/Browser.md` routes a
   * throw from `run`/`resume` to a *program* fault, which is the guest's
   * fault and the instance's fate. Returning it as data would make the
   * swarm treat a raised error as an ordinary outcome.
   */
  function stepOf(inst, status, waitsetPtr) {
    if (status === DV_CODE.IDLE) return { parked: readWaitset(waitsetPtr) };
    if (status === DV_CODE.DONE || status === DV_CODE.OK) return { done: true };
    if (status === DV_CODE.ERROR) throw new Error(lastError(inst) ?? 'the program raised');
    throw new Error(`the program stopped with ${statusName(status)}`);
  }

  /** Everything a fallible import shares: run or resume, into a `Step`. */
  function advance(handle, call) {
    const entry = need(handle);
    return withMemory(layout.WAITSET_SIZE, (waitset) => {
      u8().fill(0, waitset, waitset + layout.WAITSET_SIZE);
      const status = call(entry.inst, waitset);
      // `dv_resume` fills no wait-set of its own, so a park after a resume
      // has to be asked for. dv.h says exactly this, and getting it wrong
      // is a parked instance the host thinks is waiting on nothing.
      if (status === DV_CODE.IDLE) {
        const got = exports.dv_waitset_get(entry.inst, waitset);
        if (got !== DV_CODE.OK && got !== DV_CODE.BUSY) {
          throw new Error(`the instance parked but its wait-set would not read: ${statusName(got)}`);
        }
      }
      return stepOf(entry.inst, status, waitset);
    });
  }

  /** Wrap a must-not-throw import so an exception cannot reach wasm. */
  function safe(fn, fallback, what) {
    return (...args) => {
      try {
        return fn(...args);
      } catch (err) {
        faults.push(`${what}: ${err.message}`);
        return typeof fallback === 'function' ? fallback() : fallback;
      }
    };
  }

  /** Errors swallowed by the must-not-throw set, so they are not lost. */
  const faults = [];

  const drive = options.drive ?? defaultDrive;

  const bridge = {
    // --- Engine -------------------------------------------------------

    abiVersion: safe(() => exports.dv_abi_version(), 0, 'abiVersion'),

    /**
     * `load(source, name, budget, unsafeStdlib) -> handle`
     *
     * Source text only. `LoadSpec::program` is `Source | Bytecode` in
     * Rust, but bytecode is refused before it reaches this bridge — the
     * browser tier has no verifier either — so there is no variant here to
     * discriminate. `DV_FLAG_TEXT_ONLY` is set regardless, which makes
     * that refusal true of the instance as well as of the caller.
     */
    load(source, name, budget, unsafeStdlib) {
      const inst = fresh(budget, unsafeStdlib);
      try {
        return withCString(String(source), (codePtr, len) => withCString(
          String(name ?? 'instance'),
          (namePtr) => {
            const status = exports.dv_load(inst, codePtr, len, namePtr);
            if (status !== DV_CODE.OK) {
              throw new Error(lastError(inst) ?? statusName(status));
            }
            const handle = nextHandle++;
            table.set(handle, { inst, name: String(name ?? 'instance') });
            return handle;
          },
        ));
      } catch (err) {
        exports.dv_free(inst);        // never leak an instance on a refusal
        throw err;
      }
    },

    /**
     * `restore(snapshot, hostStamp, budget, unsafeStdlib) -> handle`
     *
     * Into a *fresh* instance, which is dv.h's requirement and not an
     * implementation detail: restore reconstructs a call chain straight
     * into the interpreter, and it refuses rather than raising on any
     * input. A stamp passed here refuses an unstamped snapshot, so
     * stamping is never advisory.
     */
    restore(snapshot, hostStamp, budget, unsafeStdlib) {
      const bytes = snapshot instanceof Uint8Array ? snapshot : new Uint8Array(snapshot);
      const inst = fresh(budget, unsafeStdlib);
      try {
        const run = (stampPtr) => withMemory(Math.max(bytes.length, 1), (buf) => {
          u8().set(bytes, buf);
          const status = exports.dv_restore(inst, stampPtr, buf, bytes.length);
          if (status !== DV_CODE.OK) {
            const why = lastError(inst) ?? statusName(status);
            throw new Error(status === DV_CODE.SNAPSHOT_MISMATCH
              ? `the snapshot header was refused: ${why}`
              : why);
          }
          const handle = nextHandle++;
          table.set(handle, { inst, name: 'restored' });
          return handle;
        });
        return hostStamp == null ? run(0) : withCString(String(hostStamp), (p) => run(p));
      } catch (err) {
        exports.dv_free(inst);
        throw err;
      }
    },

    /**
     * `release(handle)` — the JS side of `BrowserInstance`'s drop.
     *
     * Must not throw, and must be idempotent: it is called from a Rust
     * destructor, which has no way to hear about a problem and no way to
     * try again.
     */
    release: safe((handle) => {
      const entry = table.get(handle);
      if (!entry) return;
      table.delete(handle);
      // The id index goes with it, or a killed instance's id would keep
      // resolving to a handle whose memory has been freed -- which is the
      // leak this call exists to prevent, wearing a second hat.
      if (entry.id !== undefined) byId.delete(entry.id);
      exports.dv_free(entry.inst);
    }, undefined, 'release'),

    // --- Instance -----------------------------------------------------

    /** `queue(h, name) -> queueHandle | null`. 0 is never valid, so it is
     * null here rather than a handle that would read as falsy twice. */
    queue: safe((handle, name) => {
      const entry = need(handle);
      const id = withCString(String(name), (ptr) => exports.dv_queue_lookup(entry.inst, ptr));
      return id === 0 ? null : id;
    }, null, 'queue'),

    queueInfo(handle, queue) {
      const entry = need(handle);
      return withMemory(layout.QUEUE_INFO_SIZE, (ptr) => {
        const status = exports.dv_queue_state(entry.inst, queue, ptr);
        if (status !== DV_CODE.OK) {
          throw new Error(`queue ${queue}: ${statusName(status)}`);
        }
        const v = view();
        return {
          len: v.getUint32(ptr + layout.QUEUE_INFO_LEN, true),
          capacity: v.getUint32(ptr + layout.QUEUE_INFO_CAPACITY, true),
          enabled: v.getUint8(ptr + layout.QUEUE_INFO_ENABLED) !== 0,
          exported: v.getUint8(ptr + layout.QUEUE_INFO_EXPORTED) !== 0,
        };
      });
    },

    /**
     * `push(h, q, bytes) -> 'accepted'|'droppedOldest'|'full'|'disabled'`
     *
     * A full or disabled queue is a normal outcome and not an error, which
     * is dv.h's rule and `PushOutcome`'s shape. An *unknown* queue is
     * neither — it is the host asking about something that does not exist,
     * so it throws.
     */
    push(handle, queue, bytes) {
      const entry = need(handle);
      const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      return withMemory(Math.max(payload.length, 1), (ptr) => {
        u8().set(payload, ptr);
        const status = exports.dv_queue_push(entry.inst, queue, ptr, payload.length);
        switch (status) {
          case DV_CODE.OK: return 'accepted';
          case DV_CODE.QUEUE_DROPPED: return 'droppedOldest';
          case DV_CODE.QUEUE_FULL: return 'full';
          case DV_CODE.QUEUE_DISABLED: return 'disabled';
          default: throw new Error(`push to queue ${queue}: ${statusName(status)}`);
        }
      });
    },

    /**
     * `pop(h, q) -> bytes | null`
     *
     * Two-phase, because `dv_queue_pop` reports what it needs rather than
     * truncating: an undersized buffer leaves the message in place and
     * sets the length, so asking with nothing and then with enough never
     * loses one. An empty queue is `null`, not an error.
     */
    pop(handle, queue) {
      const entry = need(handle);
      const needed = withMemory(4, (lenPtr) => {
        const status = exports.dv_queue_pop(entry.inst, queue, 0, 0, lenPtr);
        if (status === DV_CODE.QUEUE_EMPTY) return -1;
        if (status !== DV_CODE.BUFFER_TOO_SMALL && status !== DV_CODE.OK) {
          throw new Error(`pop from queue ${queue}: ${statusName(status)}`);
        }
        return view().getUint32(lenPtr, true);
      });
      if (needed < 0) return null;
      if (needed === 0) return new Uint8Array(0);
      return withMemory(needed, (buf) => withMemory(4, (lenPtr) => {
        const status = exports.dv_queue_pop(entry.inst, queue, buf, needed, lenPtr);
        if (status !== DV_CODE.OK) {
          throw new Error(`pop from queue ${queue}: ${statusName(status)}`);
        }
        const got = view().getUint32(lenPtr, true);
        // Copied out before the next allocation can detach the view.
        return u8().slice(buf, buf + got);
      }));
    },

    run(handle) {
      return advance(handle, (inst, waitset) => exports.dv_run(inst, waitset));
    },

    resume(handle, fired) {
      return advance(handle, (inst) => exports.dv_resume(inst, fired));
    },

    /** A timeout firing is a resume with no queue: queue id 0. */
    resumeTimeout(handle) {
      return advance(handle, (inst) => exports.dv_resume(inst, 0));
    },

    /** `currentWait(h)` — null when the instance is not parked. */
    currentWait: safe((handle) => {
      const entry = need(handle);
      return withMemory(layout.WAITSET_SIZE, (ptr) => {
        u8().fill(0, ptr, ptr + layout.WAITSET_SIZE);
        const status = exports.dv_waitset_get(entry.inst, ptr);
        if (status !== DV_CODE.OK) return null;      // DV_BUSY: running, not parked
        return readWaitset(ptr);
      });
    }, null, 'currentWait'),

    /**
     * `usage(h) -> {instructions, memoryKbPeak, bytesNow}`
     *
     * Three figures from two calls, and the third is not derivable from
     * the others. `dv_usage` answers a supervisor's question — does this
     * child need a bigger budget — so its memory figure is the high-water
     * mark. `dv_memory` answers a host's question about a swarm — what
     * does this cost at rest — and an idle agent's peak is whatever it
     * touched on the way to being idle.
     */
    usage: safe((handle) => {
      const entry = need(handle);
      return withMemory(32, (ptr) => {
        exports.dv_usage(entry.inst, ptr, ptr + 8);
        exports.dv_memory(entry.inst, ptr + 16, ptr + 24);
        const v = view();
        return {
          instructions: Number(v.getBigUint64(ptr, true)),
          memoryKbPeak: Number(v.getBigUint64(ptr + 8, true)),
          bytesNow: Number(v.getBigUint64(ptr + 16, true)),
        };
      });
    }, () => ({ instructions: 0, memoryKbPeak: 0, bytesNow: 0 }), 'usage'),

    exceeded: safe((handle) => exports.dv_exceeded(need(handle).inst) !== 0, false, 'exceeded'),

    /**
     * `snapshot(h, hostStamp) -> bytes`
     *
     * Two-phase like `pop`, and for the same reason: dv.h takes a NULL
     * buffer as a request for the size. The instance must be parked, which
     * is the only state in which all of it is written down.
     */
    snapshot(handle, hostStamp) {
      const entry = need(handle);
      const size = (stampPtr) => withMemory(4, (lenPtr) => {
        const status = exports.dv_snapshot(entry.inst, stampPtr, 0, 0, lenPtr);
        if (status !== DV_CODE.OK && status !== DV_CODE.BUFFER_TOO_SMALL) {
          throw new Error(lastError(entry.inst) ?? statusName(status));
        }
        return view().getUint32(lenPtr, true);
      });
      const write = (stampPtr, needed) => withMemory(Math.max(needed, 1), (buf) => withMemory(
        4,
        (lenPtr) => {
          const status = exports.dv_snapshot(entry.inst, stampPtr, buf, needed, lenPtr);
          if (status !== DV_CODE.OK) {
            throw new Error(lastError(entry.inst) ?? statusName(status));
          }
          return u8().slice(buf, buf + view().getUint32(lenPtr, true));
        },
      ));
      const both = (stampPtr) => write(stampPtr, size(stampPtr));
      return hostStamp == null ? both(0) : withCString(String(hostStamp), (p) => both(p));
    },

    // --- Host ---------------------------------------------------------

    /**
     * `drive(id, handle) -> 'alive'|'exited'|{faulted: message}`
     *
     * Two arguments, not the three `doc/Browser.md`'s import block shows:
     * `HostBridge::drive` is `(id, instance)` and the caps handle is gone,
     * because capability gating stays on the Rust side where `Swarm::holds`
     * already answers it.
     *
     * Must not throw. A fault is a value, because a throw here unwinds a
     * wasm frame in the middle of a step and leaves the swarm's
     * bookkeeping in a state nothing can describe.
     */
    drive(id, handle) {
      try {
        const entry = table.get(handle);
        if (!entry) return { faulted: `no instance for handle ${handle}` };
        // The only place the pairing is visible. See `handleFor` below.
        byId.set(id, handle);
        entry.id = id;
        return drive(id, handle, bridge, entry);
      } catch (err) {
        return { faulted: err?.message ?? String(err) };
      }
    },

    // --- Not part of the contract -------------------------------------

    /**
     * The handle behind a swarm instance id, or null.
     *
     * Not in `HostBridge`, and needed because of what DRT dropped on
     * purpose. `swarm.js` today calls `dvs_instance(sw, id)` and gets a
     * raw pointer into the C swarm's struct, then calls `dv_queue_lookup`
     * on it -- that is how both the export drain and the hostcall pump
     * reach a guest's queues. `drt-web` exports `ids()`, a roster, and no
     * pointer at all, because handing pointers to a CDN audience is the
     * thing its export table refuses. So the instance a swarm id refers to
     * is reachable only through *this* table: the Lab is on both sides of
     * the boundary, and this is the join.
     *
     * The catch, and it is worth knowing before it bites: the pairing is
     * only revealed when `drive` is called, because the swarm mints the id
     * after `load` has already returned the handle. An instance spawned
     * but not yet driven cannot be mapped, and a panel that reads state
     * between those two moments will not find it. `drt-web` could close
     * this by exporting the id-to-token lookup it already has via
     * `Instance::host_token`; raised upstream.
     */
    handleFor(id) {
      const handle = byId.get(id);
      return handle !== undefined && table.has(handle) ? handle : null;
    },

    /** The swarm id a handle was last driven as, or null. */
    idFor(handle) {
      return table.get(handle)?.id ?? null;
    },

    /** Live handles, for assertions and for the panel. */
    get handles() { return [...table.keys()]; },

    /** What the must-not-throw set swallowed. Empty is the healthy state. */
    get faults() { return faults.slice(); },

    /** Free every instance still held. Not a contract call: `release` is
     * per-instance and Rust-driven, and this is the page tearing down. */
    destroy() {
      for (const [handle, entry] of table) {
        table.delete(handle);
        try { exports.dv_free(entry.inst); } catch { /* module already gone */ }
      }
      byId.clear();
    },
  };

  return bridge;
}

/**
 * The drive a bridge uses when the caller injects none.
 *
 * Advances the instance and nothing else — no hostcall pump, because the
 * pump belongs to whoever owns the connectors and this file owns only the
 * ABI. `swarm.js` keeps `_pumpHostcalls`/`_settled` and passes its own
 * `drive` in; `doc/Browser.md` is explicit that the Lab does *not* take
 * DRT's `PumpHost`/`Dispatcher`, which await connectors on the spot and
 * cannot run on a browser main thread.
 */
function defaultDrive(id, handle, bridge) {
  const wait = bridge.currentWait(handle);
  const step = wait ? bridge.resume(handle, wait.queues[0] ?? 0) : bridge.run(handle);
  return step.done ? 'exited' : 'alive';
}
