// Jupyter-shaped kernel messages.
//
// A hard constraint, and the cheapest one the project has: aligning with
// Jupyter's message set now turns "adopt JupyterLite" into an adapter
// instead of a rewrite, and costs nothing today. These are the shapes from
// the Jupyter messaging spec, trimmed to the fields that mean something
// here -- no `header`/`parent_header`/`metadata` envelope until something
// actually needs to route messages.
//
// Nothing in this file knows about WASM, and nothing in it touches the DOM.

/** Message types this project speaks. Anything else is a bug, not a feature. */
export const MSG = {
  // requests
  EXECUTE_REQUEST: 'execute_request',
  COMPLETE_REQUEST: 'complete_request',
  IS_COMPLETE_REQUEST: 'is_complete_request',
  // replies
  EXECUTE_REPLY: 'execute_reply',
  COMPLETE_REPLY: 'complete_reply',
  IS_COMPLETE_REPLY: 'is_complete_reply',
  // published on the way
  STATUS: 'status',
  STREAM: 'stream',
  EXECUTE_RESULT: 'execute_result',
  DISPLAY_DATA: 'display_data',
  ERROR: 'error',
};

let counter = 0;

/** Message ids only have to be unique within a session. */
export function msgId() {
  counter += 1;
  return `msg-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function executeRequest(code, options = {}) {
  return {
    msg_type: MSG.EXECUTE_REQUEST,
    msg_id: msgId(),
    content: {
      code,
      silent: options.silent ?? false,
      store_history: options.storeHistory ?? true,
      stop_on_error: options.stopOnError ?? true,
    },
  };
}

export function executeReply(status, executionCount, extra = {}) {
  return {
    msg_type: MSG.EXECUTE_REPLY,
    msg_id: msgId(),
    content: { status, execution_count: executionCount, ...extra },
  };
}

/** `name` is 'stdout' or 'stderr' -- the Jupyter spelling, not a fd number. */
export function stream(name, text) {
  return { msg_type: MSG.STREAM, msg_id: msgId(), content: { name, text } };
}

/**
 * The value of an expression cell. Jupyter carries a mime bundle; Diluvium
 * has one representation today, so the bundle has one entry. Keeping the
 * bundle shape is the point -- a future `image/png` from a plotting library
 * slots in without changing the message.
 */
export function executeResult(executionCount, text) {
  return {
    msg_type: MSG.EXECUTE_RESULT,
    msg_id: msgId(),
    content: {
      execution_count: executionCount,
      data: { 'text/plain': text },
      metadata: {},
    },
  };
}

/**
 * Something the program asked to show, which is not the value of the cell.
 *
 * The distinction Jupyter draws and the one worth keeping: `execute_result`
 * is what the last expression evaluated to and carries an `Out[n]` prompt,
 * while `display_data` is a thing the program chose to emit, possibly many
 * times, possibly in the middle. A chart is the second kind -- which is
 * why `plot.line{...}` returns nothing and still draws.
 *
 * `data` is a mime bundle, the same object nbformat stores.
 */
export function displayData(data, metadata = {}) {
  return {
    msg_type: MSG.DISPLAY_DATA,
    msg_id: msgId(),
    content: { data, metadata },
  };
}

export function errorMsg(ename, evalue, traceback = []) {
  return {
    msg_type: MSG.ERROR,
    msg_id: msgId(),
    content: { ename, evalue, traceback },
  };
}

export function statusMsg(executionState) {
  return {
    msg_type: MSG.STATUS,
    msg_id: msgId(),
    content: { execution_state: executionState },
  };
}

export function completeReply(matches, cursorStart, cursorEnd) {
  return {
    msg_type: MSG.COMPLETE_REPLY,
    msg_id: msgId(),
    content: { matches, cursor_start: cursorStart, cursor_end: cursorEnd, status: 'ok' },
  };
}

/** `status` is 'complete' | 'incomplete' | 'invalid' | 'unknown'. */
export function isCompleteReply(status, indent = '') {
  return {
    msg_type: MSG.IS_COMPLETE_REPLY,
    msg_id: msgId(),
    content: status === 'incomplete' ? { status, indent } : { status },
  };
}
