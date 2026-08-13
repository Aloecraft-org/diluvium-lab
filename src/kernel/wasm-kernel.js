// The on-page WASM kernel: `libdiluvium_wasi.wasm` running in the tab.
//
// The default backend, and the one that always works with zero setup. Other
// backends (Stage 3's local `diluvium` over WebSocket, a hosted endpoint)
// are escape hatches for capabilities a browser cannot provide -- they do
// not replace this one.

import { Kernel, STATUS } from './kernel.js';
import { instanceCapable, runInstance } from './instance.js';
import { createWasi, unshimmedImports, HARD_MAX_BYTES } from './wasi.js';
import { SwarmHost, swarmImports, swarmProblems, swarmCapable, ensureStack } from './swarm.js';
import { buildConnectors } from './connectors.js';
import { loadSqlite } from './sqlite.js';
import { topologyOf, mermaidOf } from './topology.js';
import {
  RECORD, KEYWORD_CANDIDATES, makeNonce, executeChunk, isCompleteChunk,
  completeChunk, languageInfoChunk, dumpChunk, widgetChunk, luaLiteral,
  parseRecord, parseRecords, parseBundle, splitPayload, splitTraceback,
} from './lua-harness.js';
import {
  executeReply, stream, executeResult, displayData, errorMsg, completeReply, isCompleteReply,
} from './protocol.js';

export const DEFAULT_WASM_URL = 'vendor/libdiluvium_wasi.wasm';

/**
 * The swarm build, and why it is a *second* module rather than the kernel.
 *
 * `diluvium_swarm_wasi.wasm` is the same objects as `libdiluvium_wasi.wasm`
 * plus `dvs.o` and `dvs_shim.o` -- measured, not assumed: identical 45 WASI
 * imports, identical `init_lua`/`run_lua`/`malloc`/`free`/`memory`, plus
 * three `env` imports and 24 `dvs_*` exports. So it could simply *be* the
 * kernel, and one module would cost less memory than two.
 *
 * It is not, for two reasons and one rule.
 *
 * The rule: CLAUDE.md names `libdiluvium_wasi.wasm` as the kernel artifact,
 * and that is a decision rather than a preference. Changing which binary
 * every notebook cell runs on is a conversation.
 *
 * The reasons are better than the rule, though. Every runtime before
 * v5.5.1_build5 publishes no swarm module at all, so the dropdown would
 * otherwise have entries that could not be selected. And a swarm is a place
 * where guest programs fault on purpose: keeping it in its own module means
 * a swarm that dies cannot take the notebook's Lua state with it, which is
 * exactly the isolation the two-module cost buys.
 *
 * The second module is loaded on demand -- when the swarm panel is first
 * used -- so a session that never opens it pays nothing.
 */
export const DEFAULT_SWARM_URL = 'vendor/diluvium_swarm_wasi.wasm';

/**
 * What this adapter needs a module to export before it will run it.
 *
 * `_start` is deliberately absent: it exists in these builds and must never
 * be called, since it runs the REPL against a stdin that is not there.
 */
const REQUIRED_EXPORTS = [
  ['memory', 'memory'],
  ['run_lua', 'function'],
  ['malloc', 'function'],
  ['free', 'function'],
];

/**
 * The capability probe. A build the Lab cannot drive has to say so plainly
 * -- "this build is too old" -- rather than failing somewhere strange three
 * calls later with a message about a null pointer.
 *
 * Checked before anything is instantiated or swapped in, so a bad download
 * leaves the running kernel exactly where it was.
 *
 * @returns {string[]} reasons it cannot be used; empty means it can
 */
export function incompatibilities(module, wasi, extraImports = {}) {
  const problems = [];

  const exports = new Map(WebAssembly.Module.exports(module).map((e) => [e.name, e.kind]));
  for (const [name, kind] of REQUIRED_EXPORTS) {
    if (!exports.has(name)) problems.push(`it does not export \`${name}\``);
    else if (exports.get(name) !== kind) problems.push(`\`${name}\` is a ${exports.get(name)}, not a ${kind}`);
  }

  // Neither is fatal on its own -- Stage 0 measured that run_lua
  // initialises what it needs -- but their absence together means this is
  // not the reactor build, and is worth saying before anything runs.
  if (!exports.has('init_lua') && !exports.has('__wasm_call_ctors')) {
    problems.push('it has neither `init_lua` nor `__wasm_call_ctors`, so it is probably not libdiluvium_wasi.wasm');
  }

  const missing = unshimmedImports(module, wasi, extraImports);
  if (missing.length) problems.push(`it imports things this page cannot supply: ${missing.join(', ')}`);

  return problems;
}

/** Compile and probe without touching any running kernel. */
export function checkModuleBytes(bytes) {
  let module;
  try {
    module = new WebAssembly.Module(bytes);
  } catch (cause) {
    return { module: null, problems: [`the browser refused to compile it: ${cause.message}`] };
  }
  return { module, problems: incompatibilities(module, createWasi()) };
}

export class WasmKernel extends Kernel {
  /**
   * @param {object} options
   * @param {string} [options.wasmUrl] where to fetch the module from
   * @param {BufferSource} [options.moduleBytes] pre-fetched bytes, which is
   *   how the baked single-file build hands the module over without a fetch
   * @param {string} [options.label] what to call this backend in the UI
   */
  constructor(options = {}) {
    super();
    this.wasmUrl = options.wasmUrl ?? DEFAULT_WASM_URL;
    this.moduleBytes = options.moduleBytes ?? null;
    this.label = options.label ?? 'On-page WASM';
    this._module = null;
    this._instance = null;
    this._wasi = null;
    this._encoder = new TextEncoder();

    // The swarm's half. `null` for `swarmUrl` means this runtime publishes
    // no swarm module, which is every Diluvium before v5.5.1_build5 and is
    // a fact rather than a fault.
    this.swarmUrl = options.swarmUrl === undefined ? DEFAULT_SWARM_URL : options.swarmUrl;
    this.swarmBytes = options.swarmBytes ?? null;
    this._swarmModule = null;
    this._swarmInstance = null;
    this._swarmWasi = null;
    this._swarmRef = null;
    this._host = null;
  }

  get capabilities() {
    return {
      ...super.capabilities, interrupt: false, restart: true, bytecode: true, widgets: true,
      // Asked of the running module, not of the version string. A build
      // either exports the `dv_` ABI at the version this binding was
      // written against or it does not, and the answer changes when the
      // runtime dropdown changes.
      instances: this._instance ? instanceCapable(this._instance.exports) : false,
      // Unlike `instances`, this cannot be answered by asking the running
      // module: the swarm lives in a *second* module that is not loaded
      // until someone opens the panel. So this says "there is a swarm
      // module to load", and `swarmStart` says whether it could be driven.
      // Getting that distinction wrong would mean a panel that is present
      // and inert, which this project has shipped once and does not intend
      // to again.
      swarm: !!(this.swarmUrl || this.swarmBytes),
    };
  }

  // --- lifecycle ----------------------------------------------------

  async start() {
    if (this._instance) return;
    this._setStatus(STATUS.STARTING);
    try {
      if (!this._module) this._module = await this._compile();
      this._instantiate();
      this._setStatus(STATUS.IDLE);
    } catch (err) {
      this._setStatus(STATUS.DEAD);
      throw err;
    }
  }

  async restart() {
    // Drop the instance and let it go. Each instance owns a linear memory,
    // so holding one alive is exactly how restarts leak. The compiled
    // Module is kept deliberately: it is code only, owns no memory, and
    // recompiling ~900 KB on every restart would be latency for nothing.
    //
    // Re-instantiating is the only true restart available. init_lua() is
    // not a reset -- Stage 0 measured globals surviving a second call.
    this._instance = null;
    this._wasi = null;
    this._executionCount = 0;
    // A swarm belongs to the kernel that was running when it started: its
    // instances hold Lua states in a module this restart is discarding, and
    // an instance held across one is a leaked linear memory twice over.
    this._dropSwarm();
    this._setStatus(STATUS.STARTING);
    try {
      if (!this._module) this._module = await this._compile();
      this._instantiate();
      this._setStatus(STATUS.IDLE);
    } catch (err) {
      this._setStatus(STATUS.DEAD);
      throw err;
    }
  }

  async shutdown() {
    this._instance = null;
    this._wasi = null;
    this._module = null;
    this._dropSwarm();
    this._swarmModule = null;
    this._setStatus(STATUS.DEAD);
  }

  /**
   * Let the swarm's instance go, keeping its compiled Module.
   *
   * The same asymmetry `restart` documents for the kernel: a Module is code
   * and owns no memory, an Instance owns a linear memory, and holding one is
   * exactly how a restart leaks.
   */
  _dropSwarm() {
    try { this._host?.free(); } catch { /* the module is already gone */ }
    this._host = null;
    this._listener = null;
    this._database = null;
    this._lastSwarmReport = null;
    this._swarmInstance = null;
    this._swarmWasi = null;
    this._swarmRef = null;
  }

  async _compile() {
    const bytes = this.moduleBytes ?? await fetchModuleBytes(this.wasmUrl);
    return new WebAssembly.Module(bytes);
  }

  _instantiate() {
    // The control responder is what makes `swarm.*` reachable from a cell:
    // one unbuffered write out, one read back, inside the same `run_lua`.
    const wasi = createWasi({ onControl: (text) => this._control(text) });
    const problems = incompatibilities(this._module, wasi);
    if (problems.length) {
      throw new Error(`this build cannot be used by the Lab: ${problems.join('; ')}`);
    }

    const instance = new WebAssembly.Instance(this._module, { wasi_snapshot_preview1: wasi.exports });
    wasi.bind(instance.exports.memory);

    // The order is not guessable from outside: __wasm_call_ctors, then
    // init_lua, then run_lua. Stage 0 found this build tolerates skipping
    // either of the first two -- run_lua initialises what it needs -- but
    // this is the documented contract and it is idempotent, so keep it.
    // Guarded, because the probe accepts a build carrying only one of the
    // two. Calling both when present is the documented contract.
    instance.exports.__wasm_call_ctors?.();
    instance.exports.init_lua?.();

    this._instance = instance;
    this._wasi = wasi;
  }

  // --- execution ----------------------------------------------------

  /**
   * One synchronous trip through `run_lua`.
   *
   * Nothing yields to the event loop inside this call, which is why output
   * cannot stream to the UI mid-execution however much we would like it to.
   * It arrives in one piece when the call returns. Do not build UI that
   * implies otherwise until an interrupt tier exists.
   */
  _runRaw(source) {
    const ex = this._instance.exports;
    const src = this._encoder.encode(source);
    const ptr = ex.malloc(src.length + 1);
    if (!ptr) throw new Error(`malloc failed for ${src.length + 1} bytes`);

    // Views are re-derived on each line, deliberately: run_lua can grow
    // memory, and a grown memory detaches every buffer taken before it.
    new Uint8Array(ex.memory.buffer).set(src, ptr);
    new Uint8Array(ex.memory.buffer)[ptr + src.length] = 0;

    let status = 0;
    let thrown = null;
    try {
      status = ex.run_lua(ptr);
    } catch (err) {
      thrown = err;
    } finally {
      try { ex.free(ptr); } catch { /* the instance is already gone */ }
    }

    return { status, thrown, ...this._wasi.drain() };
  }

  _runHarness(source, nonce) {
    const raw = this._runRaw(source);
    const { output, record } = parseRecord(raw.stdout, nonce);
    return { ...raw, output, record };
  }

  /**
   * The pieces of a request, in the order the program produced them.
   *
   * The terminal record is the last one -- the harness emits exactly one
   * and then returns -- and everything before it is either the program's
   * own output or a display it asked for.
   */
  _runInterleaved(source, nonce) {
    const raw = this._runRaw(source);
    const { pieces, cut } = parseRecords(raw.stdout, nonce);
    const messages = [];
    let output = '';
    let record = null;
    for (const piece of pieces) {
      if (piece.type === 'output') {
        output += piece.text;
        if (piece.text) messages.push(stream('stdout', piece.text));
      } else if (piece.kind === RECORD.DISPLAY) {
        messages.push(displayData(parseBundle(piece.payload)));
      } else {
        record = piece;
      }
    }
    return { ...raw, messages, output, record, cut };
  }

  /** A trap or a proc_exit leaves the instance unusable. Say so, once. */
  _die(err) {
    this._instance = null;
    this._wasi = null;
    this._setStatus(STATUS.DEAD);
    return err.procExit !== undefined
      ? `the kernel called os.exit(${err.procExit}). Restart it to continue.`
      : `the kernel stopped: ${err.message}. Restart it to continue.`;
  }

  _requireAlive() {
    if (!this._instance) throw new Error('the kernel is not running');
  }

  async execute(code, onMessage = () => {}) {
    this._requireAlive();
    this._executionCount += 1;
    const count = this._executionCount;
    const nonce = makeNonce();

    // The swarm module is fetched and compiled here, *before* the chunk
    // runs, because that is the last moment anything can be awaited: a
    // cell's `swarm.start` is answered from inside `run_lua`, where there
    // is no event loop to return to. A cell that never mentions `swarm`
    // pays nothing, and a mention that turns out to be a variable name
    // costs one preload nobody notices.
    if (/\bswarm\b/.test(code)) await this._preloadSwarm();

    this._setStatus(STATUS.BUSY);
    const run = this._runInterleaved(
      executeChunk(code, nonce, { swarm: this._swarmInstance !== null }), nonce);
    return this._report(run, count, nonce, onMessage);
  }

  /**
   * Turn one finished run into messages and a reply.
   *
   * Shared by `execute` and `callWidget` because a control's callback is
   * an ordinary run: it may print, it may draw, it may fail with a
   * traceback, and none of that should be a second implementation.
   */
  _report(run, count, nonce, onMessage) {
    // Output and displays go out in the order the program produced them,
    // so `print` before a chart lands before the chart.
    for (const message of run.messages) onMessage(message);
    if (run.stderr) onMessage(stream('stderr', run.stderr));
    if (run.truncated) {
      onMessage(stream('stderr', '\n[the kernel stopped recording output for this cell]\n'));
    }

    if (run.thrown) {
      const evalue = this._die(run.thrown);
      onMessage(errorMsg('KernelDied', evalue, []));
      return executeReply('error', count, { ename: 'KernelDied', evalue, traceback: [] });
    }

    this._setStatus(STATUS.IDLE);

    if (!run.record) {
      // Two different failures wore the same name. A cell that printed
      // past the kernel's output ceiling is not a bug in this file: the
      // harness's own record was cut off with everything else, and the
      // old message pasted the truncated stdout -- nonce, separators and
      // all -- into an error headed `HarnessError`, which reads as an
      // internal fault for what is really "that was too much output".
      //
      // `cut` says the stream stopped mid-record, which nothing but the
      // ceiling can cause.
      if (run.cut || run.truncated) {
        const evalue = 'this cell produced more output than the kernel will record, '
          + `so its result was lost. The ceiling is ${(HARD_MAX_BYTES / 1024 / 1024).toFixed(0)} MB `
          + 'of output per cell, and a chart or an image counts against it -- '
          + 'plot fewer points, or print less alongside it.';
        onMessage(errorMsg('OutputTooLarge', evalue, []));
        return executeReply('error', count, { ename: 'OutputTooLarge', evalue, traceback: [] });
      }
      const evalue = run.output.trim() || `run_lua returned ${run.status} without reporting`;
      onMessage(errorMsg('HarnessError', evalue, []));
      return executeReply('error', count, { ename: 'HarnessError', evalue, traceback: [] });
    }

    switch (run.record.kind) {
      case RECORD.COMPILE_ERROR: {
        const evalue = run.record.payload;
        onMessage(errorMsg('SyntaxError', evalue, []));
        return executeReply('error', count, { ename: 'SyntaxError', evalue, traceback: [] });
      }
      case RECORD.RUNTIME_ERROR: {
        const { message, traceback } = splitTraceback(run.record.payload);
        const lines = cleanTraceback(traceback, nonce);
        onMessage(errorMsg('LuaError', message, lines));
        return executeReply('error', count, { ename: 'LuaError', evalue: message, traceback: lines });
      }
      case RECORD.RESULT:
        onMessage(executeResult(count, run.record.payload));
        return executeReply('ok', count);
      default:
        return executeReply('ok', count, run.record.payload === 'stale' ? { stale: true } : {});
    }
  }

  /**
   * A control moved; run the callback the program registered with it.
   *
   * Not an `execute` -- deliberately. It does not advance the execution
   * count, because nothing new was submitted: the same cell is answering
   * again with a different input, and bumping `In [n]` on every drag of a
   * slider would make the numbering meaningless.
   *
   * A callback whose kernel has since restarted reports `stale`, which the
   * page turns into a sentence rather than an error. That is the ordinary
   * state of a notebook reopened from a file, not a fault.
   */
  async callWidget(id, value, onMessage = () => {}) {
    this._requireAlive();
    const nonce = makeNonce();
    this._setStatus(STATUS.BUSY);
    const run = this._runInterleaved(widgetChunk(id, luaLiteral(value), nonce), nonce);
    return this._report(run, this._executionCount, nonce, onMessage);
  }

  async isComplete(code) {
    this._requireAlive();
    const nonce = makeNonce();
    const run = this._runHarness(isCompleteChunk(code, nonce), nonce);
    if (run.thrown) { this._die(run.thrown); return isCompleteReply('unknown'); }
    if (!run.record || run.record.kind !== RECORD.IS_COMPLETE) return isCompleteReply('unknown');
    return isCompleteReply(run.record.payload);
  }

  /**
   * Compile `code` and return its bytecode, without running it.
   *
   * Compiling is not running: the chunk is loaded and dumped, and nothing
   * in it executes. That is what makes it safe to point at code you have
   * been sent and have not read.
   */
  async dumpBytecode(code, options = {}) {
    this._requireAlive();
    const nonce = makeNonce();
    const run = this._runHarness(dumpChunk(code, nonce, options), nonce);
    if (run.thrown) { this._die(run.thrown); throw new Error('the kernel stopped while compiling'); }
    if (!run.record) throw new Error('the kernel did not answer with bytecode');
    if (run.record.kind === RECORD.COMPILE_ERROR) {
      const error = new Error(run.record.payload);
      error.isCompileError = true;
      throw error;
    }
    if (run.record.kind !== RECORD.BYTECODE) throw new Error('unexpected reply while compiling');
    return run.record.payload;
  }

  /**
   * Run `code` as a sandboxed instance, with a budget.
   *
   * Not `execute`: it shares no state with the notebook, does not touch
   * the execution count, and produces a report rather than outputs. The
   * kernel's own Lua state is not involved at all -- `dv_new` makes its
   * own, and `dv_free` takes it away again.
   *
   * A trap here is as fatal as anywhere else: the instance ABI runs in
   * the same module as everything else, so a fault takes the whole
   * kernel with it and `_die` says so.
   */
  async runInstance(code, options = {}) {
    this._requireAlive();
    if (!instanceCapable(this._instance.exports)) {
      throw new Error(
        'this build cannot run sandboxed instances: it exports no `dv_` ABI at version 1. '
        + 'Diluvium 5.5.1_build3 was the first that does.');
    }
    this._setStatus(STATUS.BUSY);
    try {
      // Drained rather than accumulated: whatever the notebook's own state
      // wrote before this call is not this instance's output.
      this._wasi.drain();
      const report = runInstance(this._instance.exports, () => this._wasi.drain(), code, options);
      this._setStatus(STATUS.IDLE);
      return report;
    } catch (err) {
      if (err?.procExit !== undefined || /unreachable|memory access/i.test(err?.message ?? '')) {
        throw new Error(this._die(err));
      }
      this._setStatus(STATUS.IDLE);
      throw err;
    }
  }

  // --- the swarm ----------------------------------------------------
  //
  // `doc/Host.md`'s duties live in `swarm.js`; this is the part that owns a
  // module and a lifetime. Kept here rather than in the host so that
  // `SwarmHost` is testable against any set of exports, and so the two
  // modules' teardown is in one place -- an instance held after a restart
  // is a leaked linear memory, and there are two of them now.

  /**
   * Compile and instantiate the swarm module, once.
   *
   * Deliberately not part of `start()`: a session that never opens the
   * panel should not pay a second megabyte, and a runtime with no swarm
   * artifact should fail when someone asks for a swarm rather than when
   * they open a notebook.
   */
  async _swarmExports() {
    if (this._swarmInstance) return this._swarmInstance.exports;
    if (!this.swarmUrl && !this.swarmBytes) {
      throw new Error(
        'this runtime publishes no swarm module. `diluvium_swarm_wasi.wasm` arrived in '
        + 'v5.5.1_build5; on anything older the Lab can run instances but nothing can spawn.');
    }
    if (!this._swarmModule) {
      const bytes = this.swarmBytes ?? await fetchModuleBytes(this.swarmUrl);
      this._swarmModule = new WebAssembly.Module(bytes);
    }
    const wasi = createWasi();
    const { ref, imports } = swarmImports();
    const problems = incompatibilities(this._swarmModule, wasi, { env: imports });
    if (problems.length) {
      throw new Error(`this swarm module cannot be used by the Lab: ${problems.join('; ')}`);
    }
    const instance = new WebAssembly.Instance(this._swarmModule, {
      wasi_snapshot_preview1: wasi.exports,
      // Supplied whether or not anything calls them: a wasm module's
      // imports are mandatory, which is the entire reason this is a
      // separate artifact from the kernel.
      env: imports,
    });
    wasi.bind(instance.exports.memory);
    instance.exports.__wasm_call_ctors?.();

    const problemsAfter = swarmProblems(instance.exports);
    if (problemsAfter.length) throw new Error(problemsAfter.join('; '));

    // After the constructors and before anything calls `dvs_step`: see
    // `ensureStack`. On v5.5.1_build5 this is the difference between a
    // swarm panel and a trap in `dv_queue_lookup`.
    this._stack = ensureStack(instance.exports);

    this._swarmInstance = instance;
    this._swarmWasi = wasi;
    this._swarmRef = ref;
    return instance.exports;
  }

  /**
   * Bring a swarm up: duty 1, plus the connectors a configuration names.
   *
   * The connectors are built *here* rather than passed in, because a
   * connector is a function and this may be running in a worker. The
   * configuration is data and crosses; the code does not. That is the same
   * split the C host has, where `example.host.lua` names `sql = {path =
   * ...}` and `dhost_sql.c` is what answers.
   */
  async swarmStart(source, config = {}) {
    const exports = await this._swarmExports();
    const sqlite = config.connectors?.sql ? await loadSqlite() : null;
    if (this._host) this._host.free();
    const host = new SwarmHost(exports, this._swarmRef, {
      drain: () => this._swarmWasi.drain(),
    });
    const { connectors, listener, database } = buildConnectors(config.connectors ?? {}, { sqlite });
    for (const [name, fn] of connectors) host.connect(name, fn);
    this._listener = listener;
    this._database = database;
    this._lastSwarmReport = null;
    host.start(source, config);
    this._host = host;
    return this._swarmReport();
  }

  /** One `dvs_step`. Exposed alongside `swarmRun` because watching a swarm
   * advance one step at a time is most of what a lab is for. */
  async swarmStep() {
    this._requireSwarm();
    this._host.step();
    return this._swarmReport();
  }

  /** Step until nothing is alive or a slice runs out. See `runSlice`. */
  async swarmRun(options = {}) {
    this._requireSwarm();
    const result = this._host.runSlice(options);
    return { ...this._swarmReport(), ...result };
  }

  async swarmSnapshot() {
    // A stopped swarm is not the same as one that never ran. The panel
    // has words for both -- "its roster below is the last thing the host
    // saw" against "no swarm is running" -- and could never show the
    // first, because this forgot everything the moment the host was
    // freed. Remembering is also what leaves a stopped swarm's database
    // reachable, which is the one someone actually wants to download.
    if (!this._host) {
      return this._lastSwarmReport
        ?? { running: false, roster: [], events: [], faults: [] };
    }
    return this._swarmReport();
  }

  /**
   * The database as a `.sqlite` file, or null when none is wired.
   *
   * A method rather than a field on the report, because the report is
   * built on every step and crosses the worker boundary each time — a
   * megabyte of database riding along with it would be paid for
   * continuously to be used almost never.
   *
   * @returns {Promise<Uint8Array|null>}
   */
  async swarmDatabaseExport() {
    return this._database ? this._database.export() : null;
  }

  /**
   * Push a message into a guest's queue -- duty 4's inbound half, and the
   * one that makes a mocked listener indistinguishable from a socket.
   */
  async swarmPush(id, queue, value) {
    this._requireSwarm();
    return this._host.push(id, queue, value);
  }

  /** A request from the page, in the listener's shape. */
  async swarmRequest(request) {
    this._requireSwarm();
    if (!this._listener) {
      throw new Error('this deployment wired no listener; add `listen` to its connectors');
    }
    const message = this._listener.request(request);
    const result = this._host.push(this._host.rootId, this._listener.queue, message);
    return { ...result, conn: message.conn };
  }

  async swarmControl(action, id) {
    this._requireSwarm();
    switch (action) {
      case 'kill': return this._host.kill(id);
      case 'hibernate': return this._host.hibernate(id);
      case 'wake': return this._host.wake(id);
      default: throw new Error(`unknown swarm control: ${action}`);
    }
  }

  /** Duty 7. Idempotent, because a Stop that has already happened is fine. */
  async swarmStop() {
    if (!this._host) return { running: false, roster: [], events: [], faults: [] };
    const final = this._swarmReport();
    this._lastSwarmReport = { ...final, running: false };
    this._host.free();
    this._host = null;
    this._listener = null;
    // The database deliberately outlives the swarm that built it. The
    // final report still carries it, so the panel draws its Download
    // button after a Stop -- and nulling it here made that button throw
    // "this swarm wired no database, so there is nothing to export". A
    // stopped swarm's database is precisely what someone wants to take
    // away; the panel's own text promises it survives until the kernel
    // restarts, not until the swarm does. It is replaced by the next
    // `swarmStart` and released with the kernel.
    return { ...final, running: false };
  }

  _requireSwarm() {
    if (!this._host) throw new Error('no swarm is running; start one first');
  }

  /**
   * Get the swarm module in place if it can be, and say nothing if it
   * cannot.
   *
   * Failure here is not an error the cell should see: a runtime with no
   * swarm artifact is a legitimate configuration, and the cell's own
   * `type(swarm) == "table"` probe is the right place for it to find out.
   * What must not happen is a thrown fetch error turning an ordinary cell
   * into a failed one because the word "swarm" appeared in a comment.
   */
  async _preloadSwarm() {
    try {
      await this._swarmExports();
      // SQLite too, and for the same reason: a cell's `swarm.start` may
      // wire the `sql` connector, and by then nothing can be awaited.
      this._sqlite = await loadSqlite().catch(() => null);
    } catch {
      // Left absent. `executeChunk` will not install the global.
    }
  }

  /**
   * The synchronous half: what a cell's `swarm.*` call reaches.
   *
   * Called from inside `fd_write`, which is inside `run_lua`, which is a
   * single synchronous WASM call. So there is nothing to await here and
   * nothing may throw past this frame — a JavaScript exception crossing
   * back into wasm would unwind the Lua state. Everything is answered as
   * `{value}` or `{error}` and the guest turns the second into a Lua error
   * at its own call site.
   */
  _control(text) {
    let request;
    try {
      request = JSON.parse(text);
    } catch (err) {
      return JSON.stringify({ error: `the request was not JSON: ${err.message}` });
    }
    try {
      return JSON.stringify({ value: this._swarmOp(request.op, request.args ?? {}) ?? null });
    } catch (err) {
      return JSON.stringify({ error: err?.message ?? String(err) });
    }
  }

  /** One `swarm.*` operation. Synchronous throughout, by construction. */
  _swarmOp(op, args) {
    if (op === 'start') {
      if (!this._swarmInstance) {
        // Cannot be fixed from here: fetching and compiling a module is
        // asynchronous and this frame is inside `run_lua`. `execute`
        // preloads it before the chunk runs, so reaching this means the
        // preload was skipped or failed, and saying so beats hanging.
        throw new Error('the swarm module is not loaded; run the cell again');
      }
      if (this._host) this._host.free();
      const config = hostConfigFrom(args);
      const host = new SwarmHost(this._swarmInstance.exports, this._swarmRef, {
        drain: () => this._swarmWasi.drain(),
      });
      const { connectors, listener, database } = buildConnectors(
        config.connectors ?? {}, { sqlite: this._sqlite });
      for (const [name, fn] of connectors) host.connect(name, fn);
      this._listener = listener;
      this._database = database;
      this._host = host;
      this._eventMark = 0;
      return host.start(config.root, config);
    }

    // Stopping something already stopped is a no-op, not an error. A
    // notebook re-run from the top opens with `swarm.stop()` to clear
    // whatever the last run left, and throwing there would make the tidy
    // thing to write also the thing that breaks the cell. `swarm.spec.js`
    // already calls shutdown idempotent; this is that, from the cell side.
    if (op === 'stop' && !this._host) return false;

    this._requireSwarm();
    const host = this._host;
    const target = () => host.resolve(args.target);

    switch (op) {
      case 'alias':
        return host.alias(args.name, args.id);
      case 'push': {
        const result = host.push(target(), args.queue, args.value ?? null);
        return { ok: result.status === 'ok', why: result.detail ?? result.status };
      }
      case 'drain':
        return host.drain(target(), args.queue);
      case 'step': {
        // "Up to n steps": a swarm that drains early stops early rather
        // than spinning, and the events are everything emitted since the
        // caller last looked -- a watermark, not the whole log, because a
        // cell asking twice should not see the first batch again.
        const n = Math.max(1, Math.min(Number(args.n) || 1, 1000));
        for (let i = 0; i < n; i++) if (host.step() === 0) break;
        const since = this._eventMark;
        const events = host.snapshot().events.filter((e) => e.seq > since);
        this._eventMark = events.length ? events.at(-1).seq : since;
        return events.map(({ event, id, detail, queue }) => ({
          event, id, detail: detail ?? null, queue: queue ?? null,
        }));
      }
      case 'status':
        return host.status();
      // The topology, as Mermaid text, for a cell that wants to *show* the
      // shape rather than read a roster. The graph is a pure function of
      // the report the panel already draws from, so this is the same
      // picture reached from the other side of the kernel.
      case 'mermaid':
        return mermaidOf(topologyOf(this._swarmReport()));
      case 'hibernate': return host.hibernate(target()).status === 'ok';
      case 'wake': return host.wake(target()).status === 'ok';
      case 'kill': return host.kill(target()).status === 'ok';
      case 'stop': {
        // Same as `swarmStop`: remember what the host last saw, and keep
        // the database, so a cell that stops its swarm still leaves the
        // panel something to show and something to download.
        this._lastSwarmReport = { ...this._swarmReport(), running: false };
        host.free();
        this._host = null;
        this._listener = null;
        return true;
      }
      default:
        throw new Error(`no swarm operation called '${op}'`);
    }
  }

  /**
   * Everything the panel needs, in one structured-cloneable object.
   *
   * One round trip rather than six, because the panel is on the other side
   * of a worker and a roster read per column would be six message hops per
   * repaint.
   */
  _swarmReport() {
    const report = this._host.snapshot();
    // Carried on every report rather than only on start: the panel says
    // what the Lab had to do to this module, and a workaround nobody can
    // see is a workaround nobody will remove.
    report.stack = this._stack ?? null;
    if (this._listener) {
      report.listener = {
        port: this._listener.port,
        bind: this._listener.bind,
        bound: this._listener.bound,
        queue: this._listener.queue,
        replyQueue: this._listener.replyQueue,
        pending: [...this._listener.pending.values()],
        exchanges: this._listener.exchanges.slice(-50),
      };
      // Replies leave on the reply queue, which the host drains as an
      // exported queue; matching them back to their request is the
      // listener's job and happens here so a reply nobody asked for stays
      // visible instead of being quietly dropped.
      for (const event of report.events) {
        if (event.event === 'message' && event.queue === this._listener.replyQueue && !event.matched) {
          event.matched = true;
          const exchange = this._listener.reply(event.value);
          if (!exchange) {
            event.detail += '  (no request is waiting on that conn)';
          }
        }
      }
      report.listener.exchanges = this._listener.exchanges.slice(-50);
    }
    if (this._database) {
      report.database = {
        path: this._database.path,
        readwrite: this._database.readwrite,
        maxRows: this._database.maxRows,
        statements: this._database.statements,
        tables: this._database.tables,
      };
    }
    return report;
  }

  async languageInfo() {
    this._requireAlive();
    const nonce = makeNonce();
    const run = this._runHarness(languageInfoChunk(KEYWORD_CANDIDATES, nonce), nonce);
    if (run.thrown) { this._die(run.thrown); return null; }
    if (!run.record || run.record.kind !== RECORD.LANGUAGE) return null;
    const [version, keywords, globals] = splitPayload(run.record.payload);
    return {
      version,
      keywords: keywords ? keywords.split(' ') : [],
      globals: globals ? globals.split(' ') : [],
    };
  }

  async complete(code, cursorPos = code.length) {
    this._requireAlive();
    const { base, part, start } = splitCompletionToken(code, cursorPos);
    const nonce = makeNonce();
    const run = this._runHarness(completeChunk(base, part, nonce), nonce);
    if (run.thrown) { this._die(run.thrown); return completeReply([], cursorPos, cursorPos); }
    if (!run.record || run.record.kind !== RECORD.MATCHES) return completeReply([], cursorPos, cursorPos);

    const matches = run.record.payload === '' ? [] : run.record.payload.split('\n');
    return completeReply(matches, start, cursorPos);
  }
}

/**
 * A deployment in `host/example.host.lua`'s shape, as `SwarmHost` wants it.
 *
 * The translation is deliberately the only place the two spellings meet.
 * A guest program's config is written in the *.host.lua vocabulary —
 * `spawns_per_step`, `memory_kb`, `hibernation = "on"` — because the whole
 * point is that the same file describes the deployment here and on the C
 * host. Renaming those to match JavaScript's habits inside the guest's
 * config would mean a deployment that could not move.
 */
export function hostConfigFrom(config = {}) {
  const root = config.root ?? config.supervisor;
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error("a swarm needs a root program: pass `root = [[...]]` (or `supervisor`)");
  }
  const budget = config.budget ?? {};
  return {
    root,
    maxInstances: config.max_instances ?? config.maxInstances ?? 64,
    spawnsPerStep: config.spawns_per_step ?? config.spawnsPerStep ?? 4,
    identity: config.identity ?? null,
    // A string on the wire because that is what the Lua config says, and
    // anything other than an explicit "off" leaves the mechanism on --
    // which is the runtime's own default.
    hibernation: (config.hibernation ?? 'on') !== 'off',
    caps: asArray(config.caps),
    budget: {
      instructions: budget.instructions ?? 0,
      memoryKb: budget.memory_kb ?? budget.memoryKb ?? 0,
    },
    connectors: config.connectors ?? {},
    watch: config.watch ? asArray(config.watch) : undefined,
  };
}

/**
 * A Lua sequence, as an array.
 *
 * An empty Lua table is indistinguishable from an empty map, so it arrives
 * as `{}` and would otherwise become an object where the ABI wants a list
 * of capability strings. A non-empty sequence arrives as an array already;
 * a table with numeric keys is accepted too, because that is what a
 * sparsely-built list encodes as.
 */
function asArray(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => /^\d+$/.test(k)).sort((a, b) => a - b);
    return keys.map((k) => value[k]);
  }
  return [value];
}

/**
 * Trim the harness out of a traceback.
 *
 * The user's code is loaded as the chunk `cell`, so their frames read
 * `cell:3: in function 'f'`. Everything below the `xpcall` that wraps it is
 * this file's own scaffolding, and `run_lua` names a chunk after its source
 * text, so those frames arrive as
 * `[string "local __N = "DL7dfe…""]:137: in main chunk` -- nonce, control
 * characters and all. Showing that to someone learning the language is
 * worse than showing nothing: it looks like their mistake.
 *
 * Cut at the xpcall frame, which is the exact boundary between their stack
 * and ours, and drop anything still carrying the nonce as a backstop.
 */
export function cleanTraceback(traceback, nonce) {
  const lines = [];
  for (const line of traceback.split('\n')) {
    if (line.trim() === '') continue;
    // The frame that calls the user's chunk, and everything below it, is
    // ours. Matched on the name rather than on the whole phrase because
    // the phrase moves: 5.4 writes "[C]: in function 'xpcall'" and 5.5
    // writes "[C]: in global 'xpcall'". A pattern tied to one of those
    // silently stops cutting on the other, which is not a crash -- it is
    // a traceback that quietly starts showing the harness again.
    if (/^\s*\[C\]:.*\bxpcall\b/.test(line)) break;
    if (nonce && line.includes(nonce)) continue;
    lines.push(line);
  }
  // 5.5 reports the harness's tail call into the chunk as its own frame,
  // immediately above the xpcall we just cut at. Only the trailing one is
  // dropped: a `(...tail calls...)` further up is the user's own and is
  // exactly the kind of thing the bytecode viewer teaches people to look
  // for.
  while (lines.length && /^\s*\(\.\.\.tail calls\.\.\.\)\s*$/.test(lines.at(-1))) lines.pop();
  return lines;
}

/**
 * Split the identifier under the cursor into the part to resolve and the
 * fragment to match. `str.fo|` gives base `str`, part `fo`.
 */
export function splitCompletionToken(code, cursorPos) {
  let i = cursorPos;
  while (i > 0 && /[A-Za-z0-9_.:]/.test(code[i - 1])) i--;
  const token = code.slice(i, cursorPos);
  const cut = Math.max(token.lastIndexOf('.'), token.lastIndexOf(':'));
  if (cut === -1) return { base: '', part: token, start: i };
  return { base: token.slice(0, cut), part: token.slice(cut + 1), start: i + cut + 1 };
}

/**
 * Fetch the module, failing with something a human can act on. `file://`
 * lands here: Chromium refuses `fetch` on the file: scheme outright, which
 * is why the single-file build inlines the bytes instead of fetching them.
 */
export async function fetchModuleBytes(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (cause) {
    if (location.protocol === 'file:') {
      throw new Error(
        'this page was opened from the filesystem, and browsers refuse to fetch the ' +
        'kernel over file://. Serve it with `npm start`, or open the single-file ' +
        'build from `npm run bake`, which carries the kernel inline.',
        { cause },
      );
    }
    throw new Error(`could not fetch the kernel from ${url}: ${cause.message}`, { cause });
  }
  if (!response.ok) {
    throw new Error(`could not fetch the kernel from ${url}: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
