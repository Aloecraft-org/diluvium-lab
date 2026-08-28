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
//   `sql`     real SQLite, compiled to wasm and vendored. The *contract*
//             is the C host's exactly; the *confinement* is weaker, because
//             no JavaScript driver exposes SQLite's authorizer. See
//             sqlite.js for what that costs and what is gated instead.
//   `listen`  there is no socket in a browser tab, so the port is a number
//             this connector records and never binds. Requests arrive
//             because something in the page pushed one, which is exactly
//             what `doc/Host.md` says the difference is worth: "a request
//             object pushed into a coordinator's inbox is indistinguishable
//             to the guest whether a socket or a button produced it."
//
// Connectors are **all off by default**. A deployment names the ones it
// wires, and a call to an unwired one is `denied` with a sentence saying so.

import { SqliteScope } from './sqlite.js';
import {
  sha256, hmacSha256, utf8Bytes, bytesToHex, base64url, fromBase64url, equalBytes,
  hmacSha1, base64std,
} from './sha256.js';

/** `TURN_USER_MAX` in `dhost_crypto.c`: the longest TURN username. */
const TURN_USER_MAX = 256;

/** The listener's header bounds. `DH_MAX_HDRS` and `HTTP_HDR_VALUE_MAX`. */
const MAX_HEADERS = 8;
const MAX_HEADER_VALUE = 4096;

/**
 * Names the response framing owns, refused in a `response_headers`
 * allowlist. `host/dhost.c` refuses these at config load, where the
 * conflict is a typo; allowing one would be a guest and a host arguing
 * about the wire format at traffic time. `content-type` is here for a
 * second reason: the reply already has a field for it.
 */
const HOST_OWNED_HEADERS = [
  'content-length', 'connection', 'transfer-encoding', 'content-type',
];

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
 * @returns {{connectors: Map<string, Function>, listener: Listener|null, scope: SqliteScope|null}}
 */
export function buildConnectors(description = {}, services = {}) {
  const connectors = new Map();
  let listener = null;
  let scope = null;

  for (const [name, spec] of Object.entries(description)) {
    if (!spec) continue;                 // false, null and absent all mean off
    switch (name) {
      case 'time':
        connectors.set('time', timeConnector(services.now));
        break;
      case 'rng':
        connectors.set('rng', rngConnector(spec));
        break;
      case 'sql': {
        // The factory is loaded by whoever can await -- the kernel, before
        // a swarm starts. A configuration that wires `sql` without one is
        // a deployment asking for a database the page could not load, and
        // says so rather than answering every query with an error.
        if (!services.sqlite) {
          throw new Error('the sql connector needs SQLite, which this page could not load');
        }
        scope = new SqliteScope(services.sqlite, spec === true ? {} : spec);
        connectors.set('sql', sqlConnector(scope));
        break;
      }
      case 'listen':
        listener = new Listener(spec === true ? {} : spec);
        break;
      case 'crypto':
        connectors.set('crypto', cryptoConnector(spec === true ? {} : spec));
        break;
      case 'js':
        connectors.set('js', jsConnector(services.invoke));
        break;
      case 'rest':
        connectors.set('rest', restConnector(spec === true ? {} : spec, services.fetch));
        break;
      default:
        // An unknown key is a typo about to become a silent default. The C
        // host refuses one by name at parse time and so does this.
        throw new Error(
          `unknown connector '${name}'; this host wires time, rng, crypto, sql, listen, `
          + 'rest and js');
    }
  }
  return { connectors, listener, scope };
}

/**
 * `time` -> milliseconds since the epoch.
 *
 * The one nondeterminism every program eventually wants, and the reason the
 * queue shape wins: the answer arrives as a message, so it is in the log, so
 * a replay replays the same moment rather than the replayer's.
 */
export function timeConnector(now = () => Date.now(), monotonic = () => performance.now()) {
  const started = monotonic();
  return (call) => {
    if (call === 'time') return ok(now());
    // Milliseconds, deliberately the same unit as `time`: `dhost.c` says
    // two clocks in one connector answering in different units would be a
    // bug factory, and DRT's `TimeConnector` repeats it. The epoch is this
    // page's own -- good for intervals within a session, reset by a
    // reload, never comparable to a persisted wall timestamp. Which is the
    // point: intervals belong here, records belong on `time`.
    if (call === 'time/monotonic') return ok(Math.round(monotonic() - started));
    return failed(`the time connector answers 'time' and 'time/monotonic'; '${call}' is neither`);
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
 * `sql/query` and `sql/exec`, over a granted scope.
 *
 * Split into two calls so the capability grammar can split with them: a
 * grant of `host:sql/query` against a read-only deployment says exactly what
 * it says, and `host:sql/*` on a readwrite one says the bigger thing.
 *
 * Every call names its database in `args.db` — the config granted a
 * directory, not a file, and which database inside it is the program's
 * business. Guest-side that is `host.sql.open("name")`, whose handle
 * carries the name into every request it makes.
 */
export function sqlConnector(scope) {
  return (call, args) => {
    if (call !== 'sql/query' && call !== 'sql/exec') {
      return failed(`the sql connector answers 'sql/query' and 'sql/exec'; '${call}' is neither`);
    }
    // The grant before the database, in that order, because `conn_sql`
    // checks them in that order: an ungranted `sql/exec` against a scope
    // holding no databases yet must hear that it is not wired, not that
    // the database it named could not be created.
    if (call === 'sql/exec' && !scope.readwrite) {
      return denied('this deployment grants read access '
        + '(config.connectors.sql.access "read"), so \'sql/exec\' is not wired');
    }
    const resolved = scope.open(args?.db);
    if (!resolved.db) {
      return resolved.status === 'denied' ? denied(resolved.detail) : failed(resolved.detail);
    }
    const database = resolved.db;
    const sql = args?.sql;
    if (typeof sql !== 'string' || sql.trim() === '') {
      return failed(`${call} wants {db = "name", sql = "...", params = {...}}; `
        + "there is no 'sql' string in this request");
    }
    const params = normaliseParams(args?.params);
    try {
      if (call === 'sql/query') return ok(database.query(sql, params));
      return ok(database.exec(sql, params));
    } catch (err) {
      return failed(err.message);
    }
  };
}

/**
 * `crypto/*` — the primitives an API server needs, with the property the
 * whole sandbox exists to give: **the signing key lives in the host and
 * never in a guest.**
 *
 * A program granted `host:crypto/jwt_sign` holds the right to ask for a
 * signature, not the key. A compromised instance cannot exfiltrate a secret
 * it was never handed, and the key is in neither its heap nor its snapshot.
 * That claim is the reason this connector is worth having in a Lab at all:
 * it is the one place the runtime's central promise becomes something you
 * can watch happen.
 *
 * Semantics copied from `host/dhost_crypto.c` rather than invented, because
 * a guest must not be able to tell the two hosts apart:
 *
 * - **The master secret signs nothing.** Two subkeys are derived from it,
 *   one for `crypto/hmac` and one for the JWT MAC, under versioned
 *   domain-separation labels. Without that split, a program holding only
 *   `host:crypto/hmac` could HMAC a JWT signing-input itself and assemble a
 *   token, bypassing `host:crypto/jwt_sign` entirely.
 * - **The header is fixed and compared, not parsed.** `alg` confusion —
 *   `alg: none`, `alg: RS256` — is closed structurally: there is no header
 *   field a token can set that changes how it is checked.
 * - **The host owns `iat` and `exp`.** Any `iat`/`exp`/`nbf` a guest puts in
 *   its claims is dropped and replaced, so a guest cannot mint a token that
 *   never expires. Verify requires an integer `exp`.
 * - **Verify checks the MAC before it decodes anything**, so the JSON
 *   parser only ever runs on bytes this host signed.
 */
export function cryptoConnector({
  secret = 'diluvium-lab-development-secret',
  default_ttl: defaultTtl = 3600,
  // `turn = {secret, ttl, uris}`. The C host also takes `secret_env` and
  // `secret_file`; a page has neither an environment nor a filesystem, so
  // those are absent here rather than accepted and ignored.
  turn = null,
  now = () => Math.floor(Date.now() / 1000),
  random = (n) => crypto.getRandomValues(new Uint8Array(n)),
} = {}) {
  const master = typeof secret === 'string' ? utf8Bytes(secret) : secret;
  // Raw, not derived -- see `crypto/turn_credential` below for why this
  // one call is the exception to the subkey rule.
  const turnSecret = turn?.secret
    ? (typeof turn.secret === 'string' ? utf8Bytes(turn.secret) : turn.secret)
    : null;
  const turnTtl = Number.isInteger(turn?.ttl) ? turn.ttl : 86400;
  const turnUris = Array.isArray(turn?.uris) ? turn.uris.map(String) : [];
  const kHmac = hmacSha256(master, utf8Bytes('diluvium/crypto/hmac/v1'));
  const kJwt = hmacSha256(master, utf8Bytes('diluvium/crypto/jwt-hs256/v1'));
  // The one header this connector will sign or accept, pre-encoded so
  // verify can compare the segment rather than parse it.
  const HEADER = base64url(utf8Bytes('{"alg":"HS256","typ":"JWT"}'));

  return (call, args = {}) => {
    switch (call) {
      case 'crypto/random': {
        const n = Number(args.bytes ?? 32);
        if (!Number.isInteger(n) || n < 1 || n > 1024) {
          return failed(`crypto/random: bytes must be 1..1024, not ${args.bytes}`);
        }
        return ok(bytesToHex(random(n)));
      }
      case 'crypto/hash': {
        const data = args.data ?? args.value;
        if (typeof data !== 'string') return failed('crypto/hash: args.data must be a string');
        return ok(bytesToHex(sha256(utf8Bytes(data))));
      }
      case 'crypto/hmac': {
        const data = args.data ?? args.value;
        if (typeof data !== 'string') return failed('crypto/hmac: args.data must be a string');
        return ok(bytesToHex(hmacSha256(kHmac, utf8Bytes(data))));
      }
      case 'crypto/jwt_sign': {
        const claims = args.claims;
        if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
          return failed('crypto/jwt_sign: args.claims must be a map');
        }
        const ttl = Number(args.ttl ?? defaultTtl);
        if (!Number.isFinite(ttl) || ttl <= 0) {
          return failed(`crypto/jwt_sign: ttl must be a positive number of seconds`);
        }
        const iat = now();
        const payload = {};
        for (const [k, v] of Object.entries(claims)) {
          // Dropped rather than refused, exactly as the C host does: a
          // guest that sets them is not attacking, it is guessing, and the
          // host's own values are the answer either way.
          if (k === 'iat' || k === 'exp' || k === 'nbf') continue;
          payload[k] = v;
        }
        payload.iat = iat;
        payload.exp = iat + Math.floor(ttl);
        const signingInput = `${HEADER}.${base64url(utf8Bytes(JSON.stringify(payload)))}`;
        const mac = hmacSha256(kJwt, utf8Bytes(signingInput));
        return ok(`${signingInput}.${base64url(mac)}`);
      }
      case 'crypto/jwt_verify': {
        const token = args.token ?? args.jwt;
        if (typeof token !== 'string') {
          return ok({ valid: false, reason: 'no token was supplied' });
        }
        const parts = token.split('.');
        if (parts.length !== 3) return ok({ valid: false, reason: 'malformed token' });
        const [header, body, signature] = parts;
        // Compared, not parsed. This is what closes alg confusion.
        if (header !== HEADER) return ok({ valid: false, reason: 'unexpected header' });
        const expected = hmacSha256(kJwt, utf8Bytes(`${header}.${body}`));
        let given;
        try { given = fromBase64url(signature); } catch { given = new Uint8Array(0); }
        if (!equalBytes(expected, given)) return ok({ valid: false, reason: 'bad signature' });
        // Only now, on bytes this host signed, is anything parsed.
        let claims;
        try {
          claims = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
        } catch {
          return ok({ valid: false, reason: 'the payload is not JSON' });
        }
        if (!Number.isInteger(claims?.exp)) {
          // A token with no enforceable expiry is treated as one that has
          // none, rather than as one that never expires.
          return ok({ valid: false, reason: 'no integer exp' });
        }
        if (claims.exp <= now()) return ok({ valid: false, reason: 'expired' });
        return ok({ valid: true, claims });
      }
      /**
       * coturn's `use-auth-secret` scheme: the username is
       * `<expiry>:<user>` and the password is standard base64 of
       * HMAC-SHA1 over it. The TURN server holds the *same* secret and
       * recomputes the MAC, which is why this is the one call that signs
       * under the raw configured secret rather than a derived subkey --
       * a subkey would produce a MAC coturn cannot check.
       *
       * The host owns the expiry, exactly as `jwt_sign` owns `exp`: the
       * call takes a ttl and never a timestamp, because the expiry sits
       * in the username in cleartext and a guest that chose it would be
       * one field away from a far-future credential.
       */
      case 'crypto/turn_credential': {
        if (!turnSecret) {
          return denied('this deployment configures no TURN shared secret '
            + "(config.connectors.crypto.turn), so 'crypto/turn_credential' is not wired");
        }
        const user = args.user;
        if (typeof user !== 'string') {
          return failed('crypto/turn_credential: args.user must be a string');
        }
        if (user.length < 1 || utf8Bytes(user).length > TURN_USER_MAX || user.includes('\0')) {
          return failed(`crypto/turn_credential: args.user must be 1..${TURN_USER_MAX} `
            + 'bytes with no NUL');
        }
        // An out-of-range ttl falls back to the configured default rather
        // than refusing, which is what the C host does with the same
        // bounds -- a guest cannot lengthen its own credential past them.
        const asked = args.ttl;
        const ttl = Number.isInteger(asked) && asked > 0 && asked <= 315360000
          ? asked : turnTtl;
        const expires = now() + ttl;
        const username = `${expires}:${user}`;
        const password = base64std(hmacSha1(turnSecret, utf8Bytes(username)));
        // The deployment's own uri list, verbatim: with it the reply is a
        // complete ICE server entry and no program hard-codes where
        // coturn lives.
        return ok(turnUris.length
          ? { username, password, expires, uris: turnUris }
          : { username, password, expires });
      }
      default:
        return failed(`the crypto connector answers crypto/random, crypto/hash, crypto/hmac, `
          + `crypto/jwt_sign, crypto/jwt_verify and crypto/turn_credential; `
          + `'${call}' is none of them`);
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
 * `rest/get` and `rest/post` -- outbound HTTP, the browser's half.
 *
 * On the C side this capability is not a connector at all: it is a separate
 * program the host execs, so `diluvium-host` links no TLS and opens no
 * socket. A page cannot exec anything, and it already holds `fetch`, so
 * here the same calls are answered in-process. The guest cannot tell:
 * `rest/get` takes `{url, headers?, timeout_ms?}` and answers `{status,
 * content_type, headers, body}` on both sides, with the same refusals for
 * the same reasons.
 *
 * ## The grant, and why it is not optional
 *
 * Every other connector here reaches something the page already owns -- a
 * clock, a vendored database, a button. This one reaches **the network, on
 * the guest's initiative**, which is the line the Lab's no-external-
 * requests rule draws and the first thing to cross it. So the deployment
 * does not merely wire `rest`; it names where the guest may go:
 *
 *   rest = { allow = ["https://api.example.com"] }
 *
 * An empty or missing allowlist wires a connector that refuses everything
 * and says so, rather than one that quietly reaches anywhere. A prefix
 * match is deliberate over a host match: `https://host/v1/` grants a path,
 * and a scheme is part of the grant because downgrading to `http://` is a
 * different risk than the origin it names.
 *
 * The page is still subject to CORS, which the guest experiences as a
 * failed call and which no amount of configuration here can lift. That is
 * a real difference from the C plugin and is reported as an error rather
 * than smoothed over: a program that works here and fails there, or the
 * reverse, should be able to see why.
 *
 * Answers are **deferred** (`{status: 'pending'}` plus a promise): the
 * swarm takes the call, keeps stepping every other instance, and delivers
 * the reply when it lands. Same seam `doc/BUILD8.md` built for exactly
 * this reason.
 */
export function restConnector(spec = {}, fetchImpl) {
  const doFetch = fetchImpl ?? ((...a) => fetch(...a));
  const allow = Array.isArray(spec.allow) ? spec.allow.map(String) : [];
  const maxBody = Number.isInteger(spec.max_body) ? spec.max_body : 8 * 1024 * 1024;
  const defaultMs = Number.isInteger(spec.timeout_ms) ? spec.timeout_ms : 15000;

  return (call, args) => {
    if (call !== 'rest/get' && call !== 'rest/post') {
      return failed(`the rest connector answers 'rest/get' and 'rest/post'; '${call}' is neither`);
    }
    const url = args?.url;
    if (typeof url !== 'string' || url === '') {
      return failed("the call needs a 'url' string");
    }
    let u;
    try { u = new URL(url); } catch { return failed('the url did not parse'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return failed('the url must begin http:// or https://');
    }
    if (u.username || u.password) {
      // The plugin's rule, and for the plugin's reason: a credential in a
      // url ends up in logs and referrers. It goes in a header or nowhere.
      return failed('credentials in a url are refused; send an Authorization header instead');
    }
    if (!allow.length) {
      return denied('the rest connector is wired with no allowlist, so it reaches nothing; '
        + 'name where this notebook may go: rest = { allow = ["https://host/path"] }');
    }
    if (!allow.some((prefix) => u.href.startsWith(prefix))) {
      return denied(`'${u.href}' is outside this deployment's rest allowlist `
        + `(${allow.join(', ')}); the grant names where a guest may go, and this is not it`);
    }

    const headers = {};
    for (const [k, v] of Object.entries(args?.headers ?? {})) {
      if (typeof v !== 'string') continue;
      // Refused, never stripped: silently changing what was sent is worse
      // than refusing to send it. The plugin says this in the same words.
      if (/[\r\n]/.test(k) || /[\r\n]/.test(v) || k.includes(':')) {
        return failed('a header name or value contained CR, LF or a colon; '
          + 'that is refused rather than stripped');
      }
      const lower = k.toLowerCase();
      // The three the fetch stack owns. A browser refuses them outright,
      // so dropping them here is what makes the same program run on both
      // hosts rather than throwing on one.
      if (lower === 'host' || lower === 'content-length' || lower === 'connection') continue;
      headers[k] = v;
    }

    const timeoutMs = (Number.isInteger(args?.timeout_ms) && args.timeout_ms > 0
      && args.timeout_ms <= 120000) ? args.timeout_ms : defaultMs;

    const promise = (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const init = {
          method: call === 'rest/post' ? 'POST' : 'GET',
          headers,
          signal: ctl.signal,
          redirect: 'follow',
        };
        if (call === 'rest/post') {
          init.body = args?.body instanceof Uint8Array
            ? args.body
            : new TextEncoder().encode(String(args?.body ?? ''));
        }
        const res = await doFetch(u.toString(), init);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > maxBody) {
          return failed(`the response body is ${buf.length} bytes and this connector's `
            + `bound is ${maxBody}`);
        }
        // The plugin's result bounds, so a guest reading `headers` sees the
        // same shape from either host: lowercase names (fetch's Headers
        // already are, repeats already joined), at most 32, and one past a
        // bound dropped whole rather than clipped.
        const out = {};
        let n = 0;
        for (const [k, v] of res.headers) {
          if (n >= 32) break;
          if (k.length > 64 || v.length > 4096) continue;
          out[k] = v;
          n++;
        }
        return ok({
          status: res.status,
          content_type: res.headers.get('content-type'),
          headers: out,
          body: buf,
        });
      } catch (err) {
        const msg = String(err?.message ?? err);
        if (err?.name === 'AbortError') return failed(`no answer within ${timeoutMs} ms`);
        // A browser reports a CORS refusal as an opaque network failure, so
        // the guess is named as a guess rather than asserted.
        return failed(`${msg} -- in a page this is often CORS: the endpoint did not `
          + 'allow this origin, which no configuration here can change');
      } finally {
        clearTimeout(timer);
      }
    })();

    return { status: 'pending', promise };
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
    deadline_ms: deadlineMs = 10000, headers = [],
    response_headers: responseHeaders = [] } = {}) {
    this.port = port;
    this.bind = bind;
    this.queue = queue;
    this.replyQueue = replyQueue;
    this.maxBody = maxBody;
    this.deadlineMs = deadlineMs;
    // A LOWERCASE allowlist, and empty by default: a header a deployment
    // did not name never reaches the guest. Lowercased here rather than
    // trusted, because HTTP field names are case-insensitive and a config
    // that wrote `Authorization` should not silently allowlist nothing.
    if (!Array.isArray(headers)) {
      throw new Error('connectors.listen.headers is an array of lowercase header names');
    }
    if (headers.length > MAX_HEADERS) {
      throw new Error(`connectors.listen.headers allows up to ${MAX_HEADERS} names, `
        + `and this one names ${headers.length}`);
    }
    this.headers = headers.map((name) => String(name).toLowerCase());
    // The reply side's allowlist, build10's. Same rules as the request
    // side -- lowercase, bounded, empty by default -- plus one the request
    // side has no need for: a name the response framing owns is refused
    // here, at config, where it is still a typo.
    if (!Array.isArray(responseHeaders)) {
      throw new Error('connectors.listen.response_headers is an array of lowercase header names');
    }
    if (responseHeaders.length > MAX_HEADERS) {
      throw new Error(`connectors.listen.response_headers allows up to ${MAX_HEADERS} names, `
        + `and this one names ${responseHeaders.length}`);
    }
    this.responseHeaders = responseHeaders.map((name) => String(name).toLowerCase());
    for (const name of this.responseHeaders) {
      if (HOST_OWNED_HEADERS.includes(name)) {
        throw new Error(`connectors.listen.response_headers may not name '${name}': the host `
          + 'owns the response framing, and the media type is the reply\'s content_type field');
      }
    }
    this.bound = false;                  // a browser tab binds nothing, ever
    this._conn = 0;
    /** conn -> the request still waiting for its reply. */
    this.pending = new Map();
    this.exchanges = [];
  }

  /**
   * Turn a request into the message a guest sees. The `conn` is the host's
   * and means nothing to the program beyond "put it back on the reply".
   *
   * Headers follow `host/dhost_http.c`'s rule exactly, because this is the
   * half a guest can see: only allowlisted names are forwarded, repeats
   * join `", "` (RFC 7230's list rule), an absent header is absent from
   * the map rather than present and empty, and a value past the bound is
   * **refused** rather than truncated — 431 on the socket, and a throw
   * here, which is the same answer the page's composer shows.
   *
   * When the deployment allowlists anything, the message always carries a
   * `headers` map even when no header matched, so the shape a guest
   * pattern-matches is decided by its config and not by its traffic.
   */
  request({ method = 'GET', path = '/', body = '', headers = {} } = {}) {
    const encoded = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    if (encoded.length > this.maxBody) {
      throw new Error(`the body is ${encoded.length} bytes and this listener's max_body is ${this.maxBody}`);
    }
    const conn = ++this._conn;
    const message = { conn, method, path, body: typeof body === 'string' ? body : body };
    if (this.headers.length) message.headers = this._allowed(headers);
    this.pending.set(conn, { conn, method, path, at: Date.now() });
    this.exchanges.push({ conn, method, path, status: null, body: null, at: Date.now() });
    return message;
  }

  /** The allowlisted subset of a request's headers, joined and bounded. */
  _allowed(headers) {
    // Repeats: an object cannot hold the same key twice, so a caller that
    // means "this header appeared twice" passes an array. Both spellings
    // fold to the one joined value the C host builds from the wire.
    const seen = new Map();
    for (const [name, value] of Object.entries(headers ?? {})) {
      const key = String(name).toLowerCase();
      if (!this.headers.includes(key)) continue;
      const joined = (Array.isArray(value) ? value : [value]).map(String).join(', ');
      seen.set(key, seen.has(key) ? `${seen.get(key)}, ${joined}` : joined);
    }
    const out = {};
    for (const name of this.headers) {
      const value = seen.get(name);
      if (value === undefined) continue;   // absent, not present and empty
      if (value.length > MAX_HEADER_VALUE) {
        throw new Error(`the '${name}' header is ${value.length} bytes and this host's `
          + `value bound is ${MAX_HEADER_VALUE}; the C host answers 431 rather than `
          + 'forwarding a truncated one');
      }
      out[name] = value;
    }
    return out;
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
    exchange.headers = this._responseHeaders(message.headers);
    exchange.ms = Date.now() - waiting.at;
    return exchange;
  }

  /**
   * The allowlisted subset of a reply's `headers` map (build10).
   *
   * This direction **drops** where the request direction refuses, and the
   * asymmetry is the point rather than an inconsistency. Inbound, a bad
   * header is a lying *client* and refusing protects the guest: the C host
   * answers 431. Outbound, a bad header is a lying *guest* and the party
   * needing protection is the client on the far side of the load balancer,
   * so `host/dhost_http.c` drops that header whole -- never truncated,
   * never "cleaned" -- and answers the response anyway. Refusing the whole
   * response there would hand a guest a way to turn its own bug into an
   * outage.
   *
   * A control byte is disqualifying because on the C side these bytes are
   * interpolated into the response head, where a CR or LF is header
   * injection. There is no head here, but a guest must not be able to tell
   * the two hosts apart, so the same values are dropped by the same rule.
   * The emitted name is the allowlist's spelling, never the guest's.
   */
  _responseHeaders(headers) {
    if (!this.responseHeaders.length) return undefined;
    const out = {};
    if (!headers || typeof headers !== 'object') return out;
    const offered = new Map();
    for (const [name, value] of Object.entries(headers)) {
      offered.set(String(name).toLowerCase(), value);
    }
    for (const name of this.responseHeaders) {
      if (!offered.has(name)) continue;
      const value = offered.get(name);
      if (typeof value !== 'string') continue;      // a map of strings, or nothing
      if (value.length > MAX_HEADER_VALUE) continue; // dropped whole, not clipped
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(value)) continue;
      out[name] = value;
    }
    return out;
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
