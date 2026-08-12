// Hostcall connectors, in JavaScript. `doc/Hostcall.md`'s host half.
//
// A hostcall is a program asking its host for something the sandbox does not
// contain: the time, a row from a database, an inbound request. It is not an
// ABI -- it is a message on a queue the host drains and an answer on a queue
// the host pushes to, which is why it gets replay for free.
//
// ## What "mock" means here, precisely
//
// `doc/Host.md`'s acceptance test is that a guest must not be able to tell
// two hosts apart, and the whole lab workflow depends on that: prototype
// against a JavaScript handler, deploy against a C one, guest unchanged. So
// these are not simulations of hostcalls -- they *are* hostcalls, answered
// by different code. The request encoding, the capability check, the
// correlation token and the status vocabulary are the same on both sides.
//
// Where the two differ is in what stands behind the connector, and that
// difference is stated rather than hidden:
//
//   `time`    identical. Wall-clock milliseconds, both sides.
//   `sql`     a small in-memory engine, not SQLite. It answers the same two
//             calls over the same shapes and refuses -- loudly, by name --
//             everything it does not implement. See mock-sql.js for why
//             refusing beats approximating.
//   `listen`  there is no socket in a browser tab, so the port is a number
//             this connector records and never binds. Requests arrive
//             because something in the page pushed one, which is exactly
//             what `doc/Host.md` says the difference is worth: "a request
//             object pushed into a coordinator's inbox is indistinguishable
//             to the guest whether a socket or a button produced it."
//
// Connectors are **all off by default**. A deployment names the ones it
// wires, and a call to an unwired one is `denied` with a sentence saying so.

import { MockDatabase } from './mock-sql.js';

/** What a connector returns. Mirrors `dh_call_status` on the C side. */
const ok = (value) => ({ status: 'ok', value });
const denied = (detail) => ({ status: 'denied', detail });
const failed = (detail) => ({ status: 'error', detail });

/**
 * Build the connector functions a configuration names.
 *
 * Takes plain data and returns functions, which is the split that lets a
 * swarm configuration cross a worker boundary: the description is
 * structured-cloneable and the code is not.
 *
 * @param {object} description the `connectors` table, `host/example.host.lua`'s shape
 * @param {object} [services] host-side objects the connectors talk to
 * @returns {{connectors: Map<string, Function>, listener: Listener|null, database: MockDatabase|null}}
 */
export function buildConnectors(description = {}, services = {}) {
  const connectors = new Map();
  let listener = null;
  let database = null;

  for (const [name, spec] of Object.entries(description)) {
    if (!spec) continue;                 // false, null and absent all mean off
    switch (name) {
      case 'time':
        connectors.set('time', timeConnector(services.now));
        break;
      case 'rng':
        connectors.set('rng', rngConnector(spec));
        break;
      case 'sql':
        database = new MockDatabase(spec === true ? {} : spec);
        connectors.set('sql', sqlConnector(database));
        break;
      case 'listen':
        listener = new Listener(spec === true ? {} : spec);
        break;
      case 'js':
        connectors.set('js', jsConnector(services.invoke));
        break;
      default:
        // An unknown key is a typo about to become a silent default. The C
        // host refuses one by name at parse time and so does this.
        throw new Error(
          `unknown connector '${name}'; this host wires time, rng, sql, listen and js`);
    }
  }
  return { connectors, listener, database };
}

/**
 * `time` -> milliseconds since the epoch.
 *
 * The one nondeterminism every program eventually wants, and the reason the
 * queue shape wins: the answer arrives as a message, so it is in the log, so
 * a replay replays the same moment rather than the replayer's.
 */
export function timeConnector(now = () => Date.now()) {
  return (call) => {
    if (call !== 'time') {
      return failed(`the time connector answers 'time' and nothing else; '${call}' is not it`);
    }
    return ok(now());
  };
}

/**
 * `rng` -> a random integer, or bytes.
 *
 * Not in the C host's built-in set, and offered here because the alternative
 * in a sealed instance is `math.random` seeded identically in every
 * instance. A program that wants unpredictability should ask for it rather
 * than discover that it did not get any.
 */
export function rngConnector(spec) {
  const source = (spec && spec.source) || ((n) => crypto.getRandomValues(new Uint8Array(n)));
  return (call, args) => {
    if (call === 'rng' || call === 'rng/int') {
      const bytes = source(6);
      let v = 0;
      for (const b of bytes) v = v * 256 + b;   // 48 bits: exact in a double
      const max = Number.isInteger(args?.max) ? args.max : Number.MAX_SAFE_INTEGER;
      const min = Number.isInteger(args?.min) ? args.min : 0;
      if (max < min) return failed(`rng/int wants max >= min; got ${min}..${max}`);
      return ok(min + (v % (max - min + 1)));
    }
    if (call === 'rng/bytes') {
      const n = Number.isInteger(args?.n) ? args.n : 16;
      if (n < 1 || n > 4096) return failed(`rng/bytes wants 1..4096 bytes; asked for ${n}`);
      return ok(source(n));
    }
    return failed(`the rng connector answers 'rng/int' and 'rng/bytes'; '${call}' is neither`);
  };
}

/**
 * `sql/query` and `sql/exec`, over the mock engine.
 *
 * Split into two calls so the capability grammar can split with them: a
 * grant of `host:sql/query` against a read-only deployment says exactly what
 * it says, and `host:sql/*` on a readwrite one says the bigger thing.
 */
export function sqlConnector(database) {
  return (call, args) => {
    const sql = args?.sql;
    if (typeof sql !== 'string' || sql.trim() === '') {
      return failed(`${call} wants {sql = "...", params = {...}}; there is no 'sql' string in this request`);
    }
    const params = normaliseParams(args?.params);
    try {
      if (call === 'sql/query') return ok(database.query(sql, params));
      if (call === 'sql/exec') {
        if (!database.readwrite) {
          return denied('this deployment opened the database read-only, so sql/exec is unwired; '
            + "set mode = 'readwrite' in the connector's configuration to wire it");
        }
        return ok(database.exec(sql, params));
      }
      return failed(`the sql connector answers 'sql/query' and 'sql/exec'; '${call}' is neither`);
    } catch (err) {
      return failed(err.message);
    }
  };
}

/**
 * `js/invoke` -> call a JavaScript function the page registered.
 *
 * The one connector with a warning attached. `doc/Host.md`: the JS host
 * exposes JavaScript *only* as hostcall connectors, never as FFI, because
 * "the moment a JS function is callable without crossing the queue, sealing,
 * capabilities, metering and replay all have a hole in them at once". So
 * this passes plain data through a queue like everything else, and a
 * function it does not know about is `denied` rather than looked up.
 */
export function jsConnector(invoke) {
  return (call, args, id) => {
    if (call !== 'js/invoke') {
      return failed(`the js connector answers 'js/invoke'; '${call}' is not it`);
    }
    if (typeof invoke !== 'function') {
      return denied('this deployment wired no JavaScript functions');
    }
    const name = args?.name;
    if (typeof name !== 'string') return failed("js/invoke wants {name = '...', args = ...}");
    const result = invoke(name, args?.args, id);
    if (result === undefined) return denied(`no JavaScript function named '${name}' is registered`);
    return ok(result);
  };
}

/**
 * Inbound requests, without a socket.
 *
 * The C host binds a port, parses HTTP and pushes `{conn, method, path,
 * body}` onto the root's `http_in`; responses drain from `http_out` as
 * `{conn, status, body, content_type?}` with `conn` echoed verbatim. A
 * browser tab cannot bind anything, so this holds the same message shapes
 * and the same `conn` discipline and lets the *page* be what produces a
 * request.
 *
 * The port is kept and never bound. That is deliberate rather than
 * decorative: it is topology, it comes from configuration and never from a
 * guest, and a deployment that moves from here to the C host should not have
 * to discover the field exists.
 */
export class Listener {
  constructor({ port = 8080, bind = '127.0.0.1', queue = 'http_in',
    reply_queue: replyQueue = 'http_out', max_body: maxBody = 65536,
    deadline_ms: deadlineMs = 10000 } = {}) {
    this.port = port;
    this.bind = bind;
    this.queue = queue;
    this.replyQueue = replyQueue;
    this.maxBody = maxBody;
    this.deadlineMs = deadlineMs;
    this.bound = false;                  // a browser tab binds nothing, ever
    this._conn = 0;
    /** conn -> the request still waiting for its reply. */
    this.pending = new Map();
    this.exchanges = [];
  }

  /**
   * Turn a request into the message a guest sees. The `conn` is the host's
   * and means nothing to the program beyond "put it back on the reply".
   */
  request({ method = 'GET', path = '/', body = '', headers = {} } = {}) {
    const encoded = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    if (encoded.length > this.maxBody) {
      throw new Error(`the body is ${encoded.length} bytes and this listener's max_body is ${this.maxBody}`);
    }
    const conn = ++this._conn;
    const message = { conn, method, path, body: typeof body === 'string' ? body : body };
    this.pending.set(conn, { conn, method, path, at: Date.now() });
    this.exchanges.push({ conn, method, path, status: null, body: null, at: Date.now() });
    return message;
  }

  /**
   * A message drained from the reply queue. Returns the exchange it
   * completed, or null when the program answered a `conn` nobody asked
   * about -- which is a real thing to see rather than one to swallow.
   */
  reply(message) {
    const conn = message?.conn;
    const waiting = this.pending.get(conn);
    if (!waiting) return null;
    this.pending.delete(conn);
    const exchange = this.exchanges.find((e) => e.conn === conn) ?? { conn };
    exchange.status = message.status ?? null;
    exchange.body = message.body ?? null;
    exchange.contentType = message.content_type ?? null;
    exchange.ms = Date.now() - waiting.at;
    return exchange;
  }

  /** Connections the program has not answered past the configured deadline. */
  overdue(now = Date.now()) {
    return [...this.pending.values()].filter((c) => now - c.at > this.deadlineMs);
  }
}

/**
 * msgpack gives a Lua sequence back as an array and a Lua table as an
 * object; both spellings of "no parameters" arrive, and neither should be an
 * error.
 */
function normaliseParams(params) {
  if (params === undefined || params === null) return [];
  if (Array.isArray(params)) return params;
  if (typeof params === 'object') {
    // A sparse `{[1]=..., [2]=...}` decodes as an object with numeric keys.
    const keys = Object.keys(params).filter((k) => /^\d+$/.test(k)).sort((a, b) => a - b);
    if (keys.length) return keys.map((k) => params[k]);
  }
  return [params];
}
