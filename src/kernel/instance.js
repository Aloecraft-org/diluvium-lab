// Running a program as a sandboxed *instance*, through the `dv_` ABI.
//
// A different thing from running a cell, and the difference is the point.
// A cell runs in the notebook's own Lua state: it keeps its globals, it can
// reach `io` and `os`, and nothing bounds it. An instance is what a *host*
// runs — its own state, its own globals, its own queues, and an instruction
// budget that stops a runaway loop rather than waiting for one.
//
// This is the shape `doc/Lab.md` calls a lab: not a second way to print
// things, but a way to watch a program cost something.
//
// Everything here is plain data across the wasm boundary. The ABI has two
// entry points that take C function pointers — `dv_set_notify` and
// `dv_set_endpoint_handler` — and neither is used, because a function
// pointer in wasm is a table index and JavaScript cannot mint one. That is
// the same wall the swarm layer's host vtable hits (see ROADMAP), and it is
// worth knowing that *only* those two are behind it: the run, budget,
// usage and queue calls are all pointers and integers.
//
// `dv_layout` is why none of the struct offsets below are hardcoded. It
// exists so a binding outside C can ask for them, which is a fair sign the
// ABI expected to be driven from here.

/** `dv_layout` slot names, in the order dv.h defines them. */
export const LAYOUT_SLOTS = [
  'CONFIG_SIZE', 'CONFIG_ABI', 'CONFIG_FLAGS',
  'QUEUE_INFO_SIZE', 'QUEUE_INFO_CAPACITY', 'QUEUE_INFO_LEN', 'QUEUE_INFO_ENABLED',
  'QUEUE_INFO_EXPORTED', 'QUEUE_INFO_DIRECTION', 'QUEUE_INFO_ON_FULL',
  'WAITSET_SIZE', 'WAITSET_N', 'WAITSET_IDS', 'WAITSET_TIMEOUT', 'WAITSET_FOR_WRITE',
];

/** Refuse precompiled chunks; accept source only. `DV_FLAG_TEXT_ONLY`. */
export const FLAG_TEXT_ONLY = 0x1;

/** The ABI this binding was written against. */
export const EXPECTED_ABI = 1;

/**
 * The calls this needs. Deliberately not every `dv_` export: a build
 * missing `dv_snapshot` could still run instances perfectly well, and
 * demanding the whole surface would refuse it for no reason.
 */
const REQUIRED = [
  'dv_abi_version', 'dv_layout', 'dv_new', 'dv_free', 'dv_load', 'dv_run',
  'dv_last_error', 'dv_status_name', 'dv_set_budget', 'dv_usage', 'dv_exceeded',
  'dv_queue_lookup', 'dv_queue_state',
];

/** Can this module drive `exports` as an instance host? */
export function instanceCapable(exports) {
  if (!exports) return false;
  if (!REQUIRED.every((name) => typeof exports[name] === 'function')) return false;
  // A future ABI break is a refusal, not a best effort: these are raw
  // pointers into another language's structs, and guessing is how a host
  // corrupts a heap rather than how it copes.
  try {
    return exports.dv_abi_version() === EXPECTED_ABI;
  } catch {
    return false;
  }
}

/** `dv_layout` as a named object. */
export function readLayout(exports) {
  const count = LAYOUT_SLOTS.length;
  const ptr = exports.malloc(count * 4);
  if (!ptr) throw new Error('out of memory reading the instance layout');
  try {
    const wrote = exports.dv_layout(ptr, count);
    const view = new DataView(exports.memory.buffer);
    const out = {};
    for (let i = 0; i < Math.min(wrote, count); i++) {
      out[LAYOUT_SLOTS[i]] = view.getUint32(ptr + i * 4, true);
    }
    return out;
  } finally {
    exports.free(ptr);
  }
}

/**
 * Queues every instance starts with.
 *
 * Measured rather than assumed: a fresh instance already has `inbox` and
 * `outbox`, and does *not* have `system/events` or `system/lifecycle` —
 * those are declared by the guest like any other queue, which is what
 * `doc/Messaging.md` §9.2 says and what a probe confirms. Listed here so
 * the panel can report a program's queues without the program having to
 * enumerate them, since `queue.lookup` is the only way in and it needs a
 * name to look up.
 */
export const WELL_KNOWN_QUEUES = [
  'inbox', 'outbox', 'system/events', 'system/lifecycle', 'work', 'log',
];

/**
 * Run `code` as a fresh instance and tear it down.
 *
 * One shot: created, loaded, run once, freed. There is no scheduler here
 * and none is pretended — a program that parks on a queue is reported as
 * parked, with what it is waiting for, and that is where it stops. Driving
 * it further is what a host loop is for, and the Lab does not have one
 * until something can spawn.
 *
 * @param {object} exports the wasm instance's exports
 * @param {() => {stdout: string, stderr: string, truncated: boolean}} drain
 * @param {string} code
 * @param {object} [options]
 * @param {number} [options.instructions] budget, 0 for none
 * @param {number} [options.memoryKb] heap cap in KB, 0 for none
 * @param {boolean} [options.textOnly] refuse precompiled chunks
 * @param {string} [options.name] chunk name, as it appears in tracebacks
 */
export function runInstance(exports, drain, code, options = {}) {
  const {
    // A budget by default, and a large one. Not only to stop a runaway:
    // **the instruction counter is the budget hook**, so an instance run
    // without a budget reports `instructions: 0` however much work it
    // did. Measuring at all costs an armed hook, which is a trade this
    // panel exists to make.
    instructions = 100_000_000,
    memoryKb = 0,
    textOnly = true,
    name = 'sandbox',
  } = options;

  if (!instanceCapable(exports)) {
    throw new Error('this build has no `dv_` instance ABI; it needs Diluvium 5.5.1_build3 or newer');
  }
  const layout = readLayout(exports);
  const owned = [];
  const alloc = (bytes) => {
    const ptr = exports.malloc(bytes);
    if (!ptr) throw new Error(`out of memory allocating ${bytes} bytes`);
    owned.push(ptr);
    return ptr;
  };
  const cstring = (text) => {
    const bytes = new TextEncoder().encode(`${text}\0`);
    const ptr = alloc(bytes.length);
    // Re-derived after the malloc, which can grow memory and detach any
    // view taken before it. The same hazard `_runRaw` documents.
    new Uint8Array(exports.memory.buffer).set(bytes, ptr);
    return { ptr, length: bytes.length - 1 };
  };

  let instance = 0;
  try {
    // A config only to set TEXT_ONLY. `dv_new(NULL)` means the defaults,
    // which accept precompiled chunks -- fine for code you wrote, and not
    // what a sandbox should default to for code you pasted.
    let config = 0;
    if (textOnly) {
      config = alloc(layout.CONFIG_SIZE);
      new Uint8Array(exports.memory.buffer).fill(0, config, config + layout.CONFIG_SIZE);
      const view = new DataView(exports.memory.buffer);
      view.setUint32(config + layout.CONFIG_ABI, EXPECTED_ABI, true);
      view.setUint32(config + layout.CONFIG_FLAGS, FLAG_TEXT_ONLY, true);
    }

    instance = exports.dv_new(config);
    if (!instance) return { ok: false, stage: 'new', status: 'DV_ERROR', error: 'dv_new returned NULL' };

    if (instructions > 0 || memoryKb > 0) {
      const st = exports.dv_set_budget(instance, BigInt(instructions), BigInt(memoryKb));
      if (st !== 0) {
        return { ok: false, stage: 'budget', status: statusName(exports, st), error: lastError(exports, instance) };
      }
    }

    const source = cstring(code);
    const chunkName = cstring(name);
    const loadStatus = exports.dv_load(instance, source.ptr, source.length, chunkName.ptr);
    if (loadStatus !== 0) {
      // A compile error, almost always. It arrives here rather than from
      // `dv_run`, which is why the panel can say "it did not compile"
      // instead of "it failed".
      return {
        ok: false, stage: 'load', status: statusName(exports, loadStatus),
        error: lastError(exports, instance), ...drain(),
      };
    }

    const waitset = alloc(layout.WAITSET_SIZE);
    new Uint8Array(exports.memory.buffer).fill(0, waitset, waitset + layout.WAITSET_SIZE);
    const runStatus = exports.dv_run(instance, waitset);

    const usage = readUsage(exports, instance);
    const result = {
      ok: runStatus === 0 || runStatus === DV_STATUS.IDLE,
      stage: 'run',
      status: statusName(exports, runStatus),
      parked: runStatus === DV_STATUS.IDLE,
      exceeded: exports.dv_exceeded(instance) !== 0,
      ...usage,
      budget: { instructions, memoryKb },
      error: runStatus === DV_STATUS.ERROR ? lastError(exports, instance) : null,
      waiting: runStatus === DV_STATUS.IDLE ? readWaitset(exports, waitset, layout) : [],
      queues: readQueues(exports, instance, layout),
      ...drain(),
    };
    return result;
  } finally {
    // Order matters: the instance owns Lua's heap and must go before the
    // buffers it was handed, and both must go even when something threw.
    // An instance leaked here is a leak per run of the panel.
    if (instance) exports.dv_free(instance);
    for (const ptr of owned) {
      try { exports.free(ptr); } catch { /* the module is already gone */ }
    }
  }
}

/**
 * `dv_status`, the values this file branches on.
 *
 * Named `DV_STATUS` rather than `STATUS` because the bake flattens every
 * module into one scope and `kernel.js` already has a `STATUS` -- its
 * duplicate-name guard caught this, for the fourth time in this project.
 */
const DV_STATUS = { OK: 0, IDLE: 6, DONE: 7, ERROR: 8 };

function statusName(exports, status) {
  const name = readCString(exports, exports.dv_status_name(status));
  return name ?? `status ${status}`;
}

function lastError(exports, instance) {
  return readCString(exports, exports.dv_last_error(instance));
}

function readUsage(exports, instance) {
  const ptr = exports.malloc(16);
  if (!ptr) return { instructions: null, peakMemoryKb: null };
  try {
    exports.dv_usage(instance, ptr, ptr + 8);
    const view = new DataView(exports.memory.buffer);
    return {
      instructions: Number(view.getBigUint64(ptr, true)),
      peakMemoryKb: Number(view.getBigUint64(ptr + 8, true)),
    };
  } finally {
    exports.free(ptr);
  }
}

/** The queue ids a parked program is waiting on. */
function readWaitset(exports, ptr, layout) {
  const view = new DataView(exports.memory.buffer);
  const count = view.getUint32(ptr + layout.WAITSET_N, true);
  const ids = [];
  // DV_WAIT_MAX is 32; the count is clamped to what the array can hold
  // rather than trusted, because this is a length read out of another
  // language's struct.
  const max = Math.floor((layout.WAITSET_TIMEOUT - layout.WAITSET_IDS) / 4);
  for (let i = 0; i < Math.min(count, max); i++) {
    ids.push(view.getUint32(ptr + layout.WAITSET_IDS + i * 4, true));
  }
  return ids;
}

/**
 * What queues the program has, by looking up the names it might use.
 *
 * `dv_queue_lookup` takes a name and there is no enumerate call, so this
 * asks about a list rather than discovering one. Not a limitation worth
 * hiding: a host is expected to know the names it agreed with the guest,
 * and the reserved ones are in §9.2.
 */
function readQueues(exports, instance, layout) {
  const out = [];
  const infoPtr = exports.malloc(layout.QUEUE_INFO_SIZE);
  if (!infoPtr) return out;
  try {
    for (const name of WELL_KNOWN_QUEUES) {
      const bytes = new TextEncoder().encode(`${name}\0`);
      const namePtr = exports.malloc(bytes.length);
      if (!namePtr) continue;
      let id = 0;
      try {
        new Uint8Array(exports.memory.buffer).set(bytes, namePtr);
        id = exports.dv_queue_lookup(instance, namePtr);
      } finally {
        exports.free(namePtr);
      }
      if (!id) continue;                       // 0 is never a valid handle

      const status = exports.dv_queue_state(instance, id, infoPtr);
      if (status !== 0) continue;
      const view = new DataView(exports.memory.buffer);
      out.push({
        name,
        id,
        capacity: view.getUint32(infoPtr + layout.QUEUE_INFO_CAPACITY, true),
        length: view.getUint32(infoPtr + layout.QUEUE_INFO_LEN, true),
        enabled: view.getUint8(infoPtr + layout.QUEUE_INFO_ENABLED) !== 0,
        exported: view.getUint8(infoPtr + layout.QUEUE_INFO_EXPORTED) !== 0,
      });
    }
  } finally {
    exports.free(infoPtr);
  }
  return out;
}

function readCString(exports, ptr) {
  if (!ptr) return null;
  const bytes = new Uint8Array(exports.memory.buffer);
  let end = ptr;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(ptr, end));
}
