// The on-page WASM kernel: `libdiluvium_wasi.wasm` running in the tab.
//
// The default backend, and the one that always works with zero setup. Other
// backends (Stage 3's local `diluvium` over WebSocket, a hosted endpoint)
// are escape hatches for capabilities a browser cannot provide -- they do
// not replace this one.

import { Kernel, STATUS } from './kernel.js';
import { createWasi, unshimmedImports } from './wasi.js';
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
export function incompatibilities(module, wasi) {
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

  const missing = unshimmedImports(module, wasi);
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
  }

  get capabilities() {
    return {
      ...super.capabilities, interrupt: false, restart: true, bytecode: true, widgets: true,
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
    this._setStatus(STATUS.DEAD);
  }

  async _compile() {
    const bytes = this.moduleBytes ?? await fetchModuleBytes(this.wasmUrl);
    return new WebAssembly.Module(bytes);
  }

  _instantiate() {
    const wasi = createWasi();
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
    const { pieces } = parseRecords(raw.stdout, nonce);
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
    return { ...raw, messages, output, record };
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

    this._setStatus(STATUS.BUSY);
    const run = this._runInterleaved(executeChunk(code, nonce), nonce);
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
      // The harness never reported. That is a bug in this file rather than
      // in the user's code, so surface whatever the kernel did say instead
      // of inventing a tidier story.
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
