// A kernel that runs off the main thread, and can therefore be stopped.
//
// `run_lua` is a synchronous WASM call. Nothing preempts it. On the main
// thread that means `while true do end` in a cell freezes the whole tab
// with no recovery but closing it and losing the notebook -- which is the
// first thing a stranger will do to a public notebook, probably by
// accident.
//
// A worker does not make the call interruptible. It makes it *survivable*:
// the frozen thread is not the one painting the UI, and `terminate()` is
// an immediate, unconditional stop. That is the whole of the win, and it
// is a large one.
//
// ## What stop costs
//
// Terminating a worker destroys the Lua state with it. This is not
// Jupyter's interrupt, which unwinds and leaves your variables alone; it
// is closer to pulling the plug. `capabilities.interruptLosesState` says
// so, and the UI is required to say so too -- CLAUDE.md's rule about not
// designing UI that implies an interrupt tier which does not exist cuts
// both ways.
//
// ## When there is no worker
//
// A `file://` page has an opaque origin and browsers refuse to start a
// worker from one, which is exactly the baked single-file build. Rather
// than fail, this falls back to running the kernel in the page and says
// so through `offThread` and `capabilities.interrupt`. The baked build
// already trades away runtime switching for the same reason (no secure
// context, so no checksums); losing stop is the same kind of trade and it
// is better than not opening.

import { LAB_VERSION } from '../version.js';
import { Kernel, STATUS } from './kernel.js';
import { MSG } from './protocol.js';
import { WasmKernel, DEFAULT_WASM_URL, DEFAULT_SWARM_URL } from './wasm-kernel.js';

/**
 * Where the worker script lives, relative to this module.
 *
 * Versioned by hand because an import map does not apply to `new Worker()`
 * -- worker scripts are fetched outside module resolution, so this is the
 * one URL in the graph that `scripts/stamp-imports.mjs` cannot reach. A
 * stale worker is the same class of bug as a stale module and deserves the
 * same fix.
 */
export const WORKER_URL = new URL(`./kernel-worker.js?v=${LAB_VERSION}`, import.meta.url);

/** How long to wait for the worker to come up before giving up on it. */
const HANDSHAKE_MS = 15_000;

export class WorkerKernel extends Kernel {
  /**
   * @param {object} options
   * @param {string} [options.wasmUrl]
   * @param {BufferSource} [options.moduleBytes]
   * @param {string} [options.label]
   * @param {boolean} [options.allowFallback] run in the page if the worker
   *   cannot start. True by default; tests set it false to assert that the
   *   worker path is really the one being exercised.
   */
  constructor(options = {}) {
    super();
    this.wasmUrl = options.wasmUrl ?? DEFAULT_WASM_URL;
    this.moduleBytes = options.moduleBytes ?? null;
    this.baseLabel = options.label ?? 'WASM';
    this.label = this.baseLabel;
    this.allowFallback = options.allowFallback ?? true;
    this.swarmUrl = options.swarmUrl === undefined ? DEFAULT_SWARM_URL : options.swarmUrl;
    this.swarmBytes = options.swarmBytes ?? null;

    this._worker = null;
    this._pending = new Map();
    this._nextId = 1;
    this._workerCapabilities = null;
    /** Set when the worker could not be used and the page is running it. */
    this._fallback = null;
    this._starting = null;
  }

  /** True when the kernel is genuinely on another thread. */
  get offThread() { return this._worker !== null; }

  get executionCount() {
    return this._fallback ? this._fallback.executionCount : this._executionCount;
  }

  /**
   * Messages from whichever kernel is behind this one.
   *
   * Status has to be intercepted rather than merely forwarded: callers read
   * `kernel.status` synchronously (`app.js` gates every run on it), so a
   * status message that is republished without updating `_status` leaves
   * the getter permanently stale — the UI would show the right thing and
   * the code would believe the wrong one.
   */
  _onKernelMessage(message) {
    if (message?.msg_type === MSG.STATUS) this._setStatus(message.content.execution_state);
    else this._publish(message);
  }

  get capabilities() {
    if (this._fallback) return { ...this._fallback.capabilities, interruptLosesState: false };
    return {
      ...super.capabilities,
      ...(this._workerCapabilities ?? {}),
      // The honest pair: there is a stop button, and pressing it is a
      // restart. A caller that shows "interrupt" without reading the
      // second flag is making a promise this kernel cannot keep.
      interrupt: true,
      interruptLosesState: true,
    };
  }

  // --- lifecycle ------------------------------------------------------

  async start() {
    if (this._worker || this._fallback) return;
    if (this._starting) return this._starting;
    this._starting = this._start().finally(() => { this._starting = null; });
    return this._starting;
  }

  async _start() {
    this._setStatus(STATUS.STARTING);
    try {
      await this._startWorker();
      this.label = `${this.baseLabel} (worker)`;
      this._setStatus(STATUS.IDLE);
    } catch (err) {
      if (!this.allowFallback) { this._setStatus(STATUS.DEAD); throw err; }
      await this._startInPage(err);
    }
  }

  async _startWorker() {
    let worker;
    try {
      worker = new Worker(WORKER_URL, { type: 'module' });
    } catch (cause) {
      throw new Error(`this browser would not start a module worker: ${cause.message}`);
    }

    const ready = new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(
        () => reject(new Error('the kernel worker did not answer in time')), HANDSHAKE_MS);
      const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };

      worker.onmessage = (event) => {
        const data = event.data ?? {};
        if (data.id === id && data.type === 'ready') {
          this._workerCapabilities = data.capabilities;
          settle(resolve)(data);
        } else if (data.id === id && data.type === 'failed') {
          settle(reject)(new Error(data.error?.message ?? 'the kernel worker failed to start'));
        } else {
          this._receive(data);
        }
      };
      // A module worker that fails to *load* (a 404, a syntax error, an
      // engine without module-worker support) reports it here and never
      // answers the handshake, so both paths have to settle the promise.
      worker.onerror = (event) => {
        event.preventDefault?.();
        settle(reject)(new Error(event.message || 'the kernel worker failed to load'));
      };
      worker.onmessageerror = () => settle(reject)(new Error('the kernel worker sent something uncloneable'));

      // moduleBytes is cloned rather than transferred: the caller (and the
      // runtime cache) keeps its copy, and a detached buffer on the main
      // thread would break the next restart.
      worker.postMessage({
        id,
        type: 'init',
        args: {
          moduleBytes: this.moduleBytes,
          // Absolute, because a relative URL inside the worker resolves
          // against the *worker's* base -- `/src/kernel/` -- and a
          // `vendor/...` path would quietly 404 there. It fell back to
          // running in the page, the whole suite still passed, and the
          // only visible symptom was that stop did not work.
          wasmUrl: new URL(this.wasmUrl, self.location.href).href,
          // Same hazard, same fix. `null` stays null: it is how a runtime
          // says it publishes no swarm module, and resolving it would turn
          // "there is none" into a 404 at the worst possible moment.
          swarmUrl: this.swarmUrl === null ? null
            : new URL(this.swarmUrl, self.location.href).href,
          swarmBytes: this.swarmBytes,
          label: this.baseLabel,
        },
      });
    });

    try {
      await ready;
    } catch (err) {
      worker.terminate();
      throw err;
    }
    this._worker = worker;
    // Past the handshake, an error is a crash rather than a load failure.
    worker.onerror = (event) => {
      event.preventDefault?.();
      this._die(new Error(event.message || 'the kernel worker crashed'));
    };
  }

  /** The worker is not available. Run in the page and be honest about it. */
  async _startInPage(reason) {
    this._fallback = new WasmKernel({
      wasmUrl: this.wasmUrl,
      moduleBytes: this.moduleBytes,
      label: this.baseLabel,
    });
    this._fallback.onMessage((message) => this._onKernelMessage(message));
    this.fallbackReason = reason?.message ?? String(reason);
    this.label = `${this.baseLabel} (in page)`;
    await this._fallback.start();
    this._setStatus(this._fallback.status);
  }

  async restart() {
    if (this._fallback) {
      await this._fallback.restart();
      this._executionCount = this._fallback.executionCount;
      return;
    }
    await this._teardown(new Error('the kernel was restarted'));
    this._executionCount = 0;
    await this.start();
  }

  async shutdown() {
    if (this._fallback) { await this._fallback.shutdown(); this._fallback = null; return; }
    await this._teardown(new Error('the kernel was shut down'));
    this._setStatus(STATUS.DEAD);
  }

  /**
   * Stop whatever is running, now.
   *
   * The only real stop available: terminate the thread. Every in-flight
   * call is rejected rather than left hanging -- a promise that never
   * settles is how a UI ends up stuck on "running" forever -- and the
   * kernel comes back up empty.
   */
  async interrupt() {
    if (this._fallback) {
      throw new Error(
        'This kernel is running in the page, so it cannot be stopped. '
        + `(${this.fallbackReason ?? 'no worker available'})`);
    }
    await this._teardown(new Error('the kernel was stopped'));
    this._executionCount = 0;
    await this.start();
  }

  async _teardown(reason) {
    const worker = this._worker;
    this._worker = null;
    for (const [, pending] of this._pending) pending.reject(reason);
    this._pending.clear();
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
    this._setStatus(STATUS.DEAD);
  }

  _die(err) {
    this._teardown(err);
    this._publish({
      msg_type: 'error',
      content: { ename: 'KernelError', evalue: err.message, traceback: [] },
    });
  }

  // --- the wire -------------------------------------------------------

  _receive(data) {
    if (data.type === 'publish') { this._onKernelMessage(data.message); return; }
    const pending = this._pending.get(data.id);
    if (!pending) return;                       // a reply from a terminated run
    if (data.type === 'stream') { pending.onMessage?.(data.message); return; }
    this._pending.delete(data.id);
    if (typeof data.executionCount === 'number') this._executionCount = data.executionCount;
    if (data.type === 'result') pending.resolve(data.value);
    else pending.reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
  }

  _call(method, args, onMessage) {
    if (this._fallback) return this._fallback[method](...args);
    if (!this._worker) return Promise.reject(new Error('the kernel is not running'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, onMessage });
      this._worker.postMessage({ id, type: 'call', method, args });
    });
  }

  // --- the interface --------------------------------------------------

  async execute(code, onMessage = () => {}) {
    return this._streaming('execute', { code }, onMessage, () => this._fallback.execute(code, onMessage));
  }

  async callWidget(id, value, onMessage = () => {}) {
    return this._streaming('callWidget', { id, value }, onMessage,
      () => this._fallback.callWidget(id, value, onMessage));
  }

  /**
   * A call whose messages arrive before its reply does.
   *
   * `_call` cannot carry these: its `onMessage` is stored but the worker
   * only posts a result, so a streaming method routed through it would
   * drop every `stream` and every `display_data` on the floor and still
   * resolve. Both streaming methods go through here instead.
   */
  _streaming(method, args, onMessage, viaFallback) {
    if (this._fallback) return viaFallback();
    if (!this._worker) return Promise.reject(new Error('the kernel is not running'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, onMessage });
      this._worker.postMessage({ id, type: 'call', method, args });
    });
  }

  async complete(code, cursorPos = code.length) { return this._call('complete', [code, cursorPos]); }
  async isComplete(code) { return this._call('isComplete', [code]); }
  async languageInfo() { return this._call('languageInfo', []); }
  async dumpBytecode(code, options = {}) { return this._call('dumpBytecode', [code, options]); }
  async runInstance(code, options = {}) { return this._call('runInstance', [code, options]); }

  // The swarm, forwarded. Plain proxies because the worker's dispatcher
  // calls `kernel[method](...args)` for anything without a streaming half,
  // and every one of these answers with a structured-cloneable report.
  //
  // Running the host *in the worker* is the point rather than an accident:
  // `dvs_step` is synchronous and a guest can loop forever inside it, so
  // the thread it blocks should not be the one painting the page -- and
  // Stop, which is `terminate()`, takes the swarm down with the kernel
  // exactly as it takes a runaway cell.
  async swarmStart(source, config = {}) { return this._call('swarmStart', [source, config]); }
  async swarmStep() { return this._call('swarmStep', []); }
  async swarmRun(options = {}) { return this._call('swarmRun', [options]); }
  async swarmSnapshot() { return this._call('swarmSnapshot', []); }
  async swarmPush(id, queue, value) { return this._call('swarmPush', [id, queue, value]); }
  async swarmRequest(request) { return this._call('swarmRequest', [request]); }
  async swarmControl(action, id) { return this._call('swarmControl', [action, id]); }
  async swarmStop() { return this._call('swarmStop', []); }
}
