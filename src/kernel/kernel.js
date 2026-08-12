// The kernel interface.
//
// Everything reaches the kernel through this, even though exactly one
// implementation exists today. That is deliberate and it is the single
// highest-leverage structural choice in the project: the version dropdown
// (Stage 2), a local `diluvium` over WebSocket (Stage 3), a hosted endpoint
// and any future JupyterLite adapter are all instances of this class rather
// than four separate retrofits.
//
// The rule for anyone adding a backend: if you need to reach past this
// interface to make something work, the interface is wrong -- widen it here
// rather than special-casing the caller.

import { MSG, statusMsg } from './protocol.js';

/** Kernel lifecycle states, spelled the way Jupyter spells them. */
export const STATUS = {
  STARTING: 'starting',
  IDLE: 'idle',
  BUSY: 'busy',
  DEAD: 'dead',
};

export class Kernel {
  constructor() {
    this._status = STATUS.DEAD;
    this._listeners = new Set();
    this._executionCount = 0;
  }

  get status() { return this._status; }

  /**
   * How many `execute_request`s have been counted. Jupyter's `In [n]`, and
   * it survives a restart being reset to zero because that is what a restart
   * means.
   */
  get executionCount() { return this._executionCount; }

  /** Backends that cannot do something say so here rather than throwing. */
  get capabilities() {
    return {
      // run_lua is a synchronous WASM call. Nothing can preempt it, so no
      // UI may imply otherwise until an interrupt tier actually exists.
      interrupt: false,
      restart: true,
      complete: true,
      isComplete: true,
      /** Compile without running, and hand back the bytecode. */
      bytecode: false,
      /**
       * Re-enter the program to run a control's callback. Needs persistent
       * state between requests, which is the same property that makes a
       * notebook a notebook -- so any backend that can run cells at all can
       * almost certainly do this too.
       */
      widgets: false,
      /**
       * Run a program as a sandboxed `dv_` instance: its own state, its
       * own queues, and an instruction budget. Depends on the *build*
       * rather than on the backend, so this is answered by asking the
       * running module what it exports.
       */
      instances: false,
      /**
       * Host a *swarm*: many sandboxed instances, spawning each other,
       * with capability attenuation and per-instance budgets, driven by
       * this page implementing `doc/Host.md`'s duties.
       *
       * A different claim from `instances`, and the difference is the
       * whole of `doc/Messaging.md` §9: one instance is a program in a
       * box, and a swarm is a program that can make more boxes. Needs the
       * `dvs_*` layer, which only `diluvium_swarm_wasi.wasm` carries and
       * only from v5.5.1_build5.
       */
      swarm: false,
    };
  }

  /** Subscribe to `status` messages. Returns an unsubscribe function. */
  onMessage(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _publish(message) {
    for (const listener of this._listeners) listener(message);
  }

  _setStatus(status) {
    if (this._status === status) return;
    this._status = status;
    this._publish(statusMsg(status));
  }

  // --- to implement -------------------------------------------------

  /** Bring the kernel up. Idempotent. */
  async start() { throw new Error('not implemented'); }

  /**
   * Tear down and bring up again. State is gone afterwards -- that is the
   * point of a restart, and a backend that cannot truly discard its state
   * should report `capabilities.restart === false` rather than fake it.
   */
  async restart() { throw new Error('not implemented'); }

  /** Release everything. The kernel is DEAD afterwards. */
  async shutdown() { throw new Error('not implemented'); }

  /**
   * Run code.
   *
   * `onMessage` receives the `stream`, `execute_result` and `error` messages
   * published during the run, in order. Resolves with the `execute_reply`.
   *
   * @param {string} code
   * @param {(msg: object) => void} onMessage
   * @returns {Promise<object>} execute_reply
   */
  async execute(code, onMessage) { throw new Error('not implemented'); }

  /**
   * A control the program drew has moved; run the callback it registered.
   *
   * Optional. A backend that cannot re-enter the program between cells --
   * anything without persistent state, in practice -- leaves this alone,
   * reports `capabilities.widgets === false`, and the page renders
   * controls as disabled rather than as controls that quietly do nothing.
   *
   * @param {string} id the control's id, as the program's display said
   * @param {number|string|boolean} value
   * @param {(msg: object) => void} onMessage
   * @returns {Promise<object>} execute_reply
   */
  async callWidget(id, value, onMessage) { throw new Error('not implemented'); }

  /**
   * Run `code` as a sandboxed instance and report what it cost.
   *
   * Optional; gated on `capabilities.instances`. Shares nothing with the
   * notebook's own state and does not advance the execution count -- it
   * is a measurement, not a cell.
   *
   * @returns {Promise<object>} a report: status, usage, queues, output
   */
  async runInstance(code, options) { throw new Error('not implemented'); }

  /**
   * Host a swarm: `doc/Host.md`'s seven duties, behind seven methods.
   *
   * Optional, gated on `capabilities.swarm`. They are on the interface
   * rather than reached for on the implementation for the reason at the
   * top of this file: a local `diluvium` over WebSocket would host a swarm
   * too, and it would be the *same* panel driving it.
   *
   * Every one of them answers with a report -- roster, events, config,
   * whatever the listener and the database have seen -- rather than with
   * nothing, because the caller is usually across a worker and a method
   * that returned void would cost a second round trip to learn what it did.
   *
   * @param {string} source the root program
   * @param {object} config the deployment, in `host/example.host.lua`'s shape
   * @returns {Promise<object>} a report
   */
  async swarmStart(source, config) { throw new Error('not implemented'); }

  /** One `dvs_step`: drain lifecycle, spawn, drive every resident instance once. */
  async swarmStep() { throw new Error('not implemented'); }

  /** Step until nothing is alive, or a step budget or wall-clock slice runs out. */
  async swarmRun(options) { throw new Error('not implemented'); }

  /** The current report, without advancing anything. */
  async swarmSnapshot() { throw new Error('not implemented'); }

  /** Duty 4's inbound half: put a message in a guest's queue by name. */
  async swarmPush(id, queue, value) { throw new Error('not implemented'); }

  /** An inbound request through the mocked listener, in `{method, path, body}`. */
  async swarmRequest(request) { throw new Error('not implemented'); }

  /** `kill`, `hibernate` or `wake`, by instance id. */
  async swarmControl(action, id) { throw new Error('not implemented'); }

  /** Duty 7. Idempotent. */
  async swarmStop() { throw new Error('not implemented'); }

  /** @returns {Promise<object>} complete_reply */
  async complete(code, cursorPos) { throw new Error('not implemented'); }

  /** @returns {Promise<object>} is_complete_reply */
  async isComplete(code) { throw new Error('not implemented'); }

  /**
   * Compile `code` and return its bytecode as a hex string, without
   * running it. Optional: a backend that cannot do this says so through
   * `capabilities.bytecode`.
   * @returns {Promise<string>} hex
   */
  async dumpBytecode(code, options) { throw new Error('not implemented'); }
}

/**
 * Collect an execution into a plain object, for callers that want the whole
 * result rather than a stream of messages. The notebook uses the streaming
 * form; tests and the console mostly want this.
 */
export async function executeCollected(kernel, code) {
  const messages = [];
  const reply = await kernel.execute(code, (msg) => messages.push(msg));
  const text = (name) => messages
    .filter((m) => m.msg_type === MSG.STREAM && m.content.name === name)
    .map((m) => m.content.text).join('');
  const result = messages.find((m) => m.msg_type === MSG.EXECUTE_RESULT);
  const error = messages.find((m) => m.msg_type === MSG.ERROR);
  return {
    status: reply.content.status,
    executionCount: reply.content.execution_count,
    stdout: text('stdout'),
    stderr: text('stderr'),
    result: result ? result.content.data['text/plain'] : null,
    error: error ? error.content : null,
    messages,
  };
}
