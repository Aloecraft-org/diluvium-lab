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

  /** @returns {Promise<object>} complete_reply */
  async complete(code, cursorPos) { throw new Error('not implemented'); }

  /** @returns {Promise<object>} is_complete_reply */
  async isComplete(code) { throw new Error('not implemented'); }
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
