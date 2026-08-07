// The on-page WASM kernel: `libdiluvium_wasi.wasm` running in the tab.
//
// The default backend, and the one that always works with zero setup. Other
// backends (Stage 3's local `diluvium` over WebSocket, a hosted endpoint)
// are escape hatches for capabilities a browser cannot provide -- they do
// not replace this one.

import { Kernel, STATUS } from './kernel.js';
import { createWasi, unshimmedImports } from './wasi.js';
import {
  RECORD, makeNonce, executeChunk, isCompleteChunk, completeChunk,
  parseRecord, splitTraceback,
} from './lua-harness.js';
import {
  executeReply, stream, executeResult, errorMsg, completeReply, isCompleteReply,
} from './protocol.js';

export const DEFAULT_WASM_URL = 'vendor/libdiluvium_wasi.wasm';

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
    return { ...super.capabilities, interrupt: false, restart: true };
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
    const missing = unshimmedImports(this._module, wasi);
    if (missing.length) {
      throw new Error(`the kernel asks for imports this build does not shim: ${missing.join(', ')}`);
    }

    const instance = new WebAssembly.Instance(this._module, { wasi_snapshot_preview1: wasi.exports });
    wasi.bind(instance.exports.memory);

    // The order is not guessable from outside: __wasm_call_ctors, then
    // init_lua, then run_lua. Stage 0 found this build tolerates skipping
    // either of the first two -- run_lua initialises what it needs -- but
    // this is the documented contract and it is idempotent, so keep it.
    instance.exports.__wasm_call_ctors();
    instance.exports.init_lua();

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
    const run = this._runHarness(executeChunk(code, nonce), nonce);

    // The user's own output goes out first, in the order it was produced.
    if (run.output) onMessage(stream('stdout', run.output));
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
        const lines = traceback.split('\n').filter((l) => l.trim() !== '');
        onMessage(errorMsg('LuaError', message, lines));
        return executeReply('error', count, { ename: 'LuaError', evalue: message, traceback: lines });
      }
      case RECORD.RESULT:
        onMessage(executeResult(count, run.record.payload));
        return executeReply('ok', count);
      default:
        return executeReply('ok', count);
    }
  }

  async isComplete(code) {
    this._requireAlive();
    const nonce = makeNonce();
    const run = this._runHarness(isCompleteChunk(code, nonce), nonce);
    if (run.thrown) { this._die(run.thrown); return isCompleteReply('unknown'); }
    if (!run.record || run.record.kind !== RECORD.IS_COMPLETE) return isCompleteReply('unknown');
    return isCompleteReply(run.record.payload);
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
