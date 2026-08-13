// Real SQLite, behind the `sql` hostcall connector.
//
// This replaces a small hand-written engine that answered the same two
// calls over a subset of SQL and refused the rest by name. That was the
// honest thing to ship while there was no SQLite in the page; it is not
// the thing to keep once there is, because the ceiling you hit with it —
// no joins, no subqueries, no transactions — is exactly the ceiling you
// hit the moment you try to prototype a schema of any weight.
//
// ## The contract is the C host's, and the confinement is not
//
// `doc/Host.md`'s acceptance test is that a guest must not be able to tell
// two hosts apart, and for the *contract* that holds: same two calls, same
// `{sql, params}` in, same `{cols, rows}` / `{changes, rowid}` out, same
// read/write split, same row cap that refuses rather than truncates.
//
// The *confinement* is weaker, and `doc/Lab.md` §1a is explicit about why:
// `host/dhost_sql.c` earns its confinement from three SQLite primitives no
// JavaScript driver exposes — `sqlite3_set_authorizer`, `SQLITE_LIMIT_ATTACHED`,
// and `sqlite3_stmt_readonly`. Without an authorizer, the escapes are
// gated at the text level, which is a floor rather than a target. Each row
// of that table is implemented below and each is commented with what it
// cannot promise.
//
// The practical rule, and it is in the panel too: **build to the contract
// so the guest cannot tell, and do not point this at a database that
// matters.** Production is the C host.

import { bytesToHex } from './sha256.js';

/**
 * Where the vendored SQLite lives. See scripts/vendor-sqlite.sh.
 *
 * Resolved against this module rather than against the page, unlike the
 * kernel's own URLs -- because those are chosen by whoever constructs the
 * kernel and these are not: nothing passes them, so they have to be right
 * from wherever the module was imported. `index.html` and
 * `test/kernel-page.html` sit at different depths and both work.
 */
export const SQLITE_JS_URL = new URL('../../vendor/sql-wasm.js', import.meta.url).href;
export const SQLITE_WASM_URL = new URL('../../vendor/sql-wasm.wasm', import.meta.url).href;

/**
 * Statements that are refused outright, by first keyword.
 *
 * A text gate, and weaker than the authorizer the C host uses — a fact
 * worth stating rather than glossing, because the reason `dhost_sql.c`
 * uses the authorizer is precisely that a regex is the wrong tool. What
 * this catches is the ordinary case; what it cannot catch is a statement
 * that reaches these through a path the first keyword does not name.
 *
 * `ATTACH`/`DETACH`: a second database file, which would escape the one
 * this connector opened. `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`/`RELEASE`:
 * a transaction spanning hostcalls would be host state held against the
 * guest, and the v1 encoding deliberately has nowhere to put a handle.
 * `PRAGMA`: several are connection-state changes rather than queries.
 * `VACUUM`/`ANALYZE`/`REINDEX`: whole-database operations with no bounded cost.
 */
const REFUSED_KEYWORDS = new Set([
  'attach', 'detach', 'begin', 'commit', 'end', 'rollback', 'savepoint',
  'release', 'pragma', 'vacuum', 'analyze', 'reindex',
]);

/** Statements that read. Everything else is a write. */
const READ_KEYWORDS = new Set(['select', 'with', 'explain', 'values']);

let factory = null;

/**
 * Load and initialise SQLite, once.
 *
 * Asynchronous, and therefore callable only from somewhere that can await
 * — which is why the kernel does it in `swarmStart` rather than inside the
 * connector. Every call *after* this is synchronous, which the cell
 * channel depends on absolutely: a hostcall is answered from inside
 * `run_lua`, where there is no event loop to return to.
 */
export async function loadSqlite({
  jsUrl = SQLITE_JS_URL,
  wasmUrl = SQLITE_WASM_URL,
  wasmBinary = null,
} = {}) {
  if (factory) return factory;
  const { default: initSqlJs } = await import(/* @vite-ignore */ new URL(jsUrl, import.meta.url).href);
  const bytes = wasmBinary
    ?? new Uint8Array(await (await fetch(new URL(wasmUrl, import.meta.url))).arrayBuffer());
  // `wasmBinary` rather than a URL, so nothing here ever fetches on its
  // own -- the baked single-file build has no network at all, and a module
  // that reached for one would work in development and fail in the file
  // someone was emailed.
  factory = await initSqlJs({ wasmBinary: bytes });
  return factory;
}

// A note on the baked single-file build, because the shape above looks
// like a hole in "no external requests" and is not. `scripts/bake.mjs`
// flattens static imports and cannot flatten a dynamic one, so the two
// files above stay outside the bundle. Nothing there ever calls this:
// `index.html` passes `swarmUrl: null` for that build, and both callers go
// through `_swarmExports()` first, which throws on a runtime with no swarm
// module. So the baked page has no SQL connector for the same reason it
// has no swarm panel, and says so in the panel rather than 404ing.

export class SqliteDatabase {
  /**
   * @param {object} SQL the initialised sql.js factory
   * @param {object} [config] the connector's configuration, in
   *   `host/types/host.lua`'s `diluvium.HostSql` shape
   */
  constructor(SQL, { path = ':memory:', mode = 'read', max_rows: maxRows = 1024 } = {}) {
    // Kept, and not honoured: there is no filesystem behind sql.js, so
    // every database here is in memory and dies with the kernel. The path
    // is carried because it is *topology* -- a deployment moving to the C
    // host should not have to discover the field exists -- and the panel
    // shows it next to a sentence saying nothing is written to it. Same
    // reasoning as the listener's unbound port.
    this.path = path;
    this.readwrite = mode === 'readwrite';
    this.maxRows = maxRows;
    this.statements = 0;
    this.db = new SQL.Database();
  }

  /**
   * `sql/query`: one statement, and it must not write.
   *
   * The C connector asks `sqlite3_stmt_readonly`, so its classification is
   * SQLite's own. **sql.js exposes no such thing** — checked, not assumed:
   * a prepared statement's prototype has `bind`, `step`, `get`,
   * `getColumnNames` and no `reader`. So the split here is by first
   * keyword, which is `doc/Lab.md` §1a's stated fallback and is weaker:
   * it classifies the statement someone wrote rather than the statement
   * SQLite compiled.
   */
  query(sql, params = []) {
    const statement = this._prepareOne(sql, params);
    if (!READ_KEYWORDS.has(statement.keyword)) {
      throw new Error(
        `sql/query runs read-only statements and this is a ${statement.keyword.toUpperCase()}; `
        + 'use sql/exec, which a deployment wires only when its mode is readwrite');
    }
    this.statements++;
    const stmt = this.db.prepare(sql);
    try {
      if (params.length) stmt.bind(params);
      const rows = [];
      // Stepped rather than materialised. `doc/Lab.md` §1a calls
      // `.all()` past a hostile row cap a memory DoS the C host does not
      // have, and it is right: the whole result would already be in
      // memory before anyone counted it. Refusing on the way through
      // costs one comparison per row and cannot be made to allocate.
      while (stmt.step()) {
        if (rows.length >= this.maxRows) {
          throw new Error(
            `this query passed the ${this.maxRows}-row cap and was refused rather than `
            + 'truncated; page with LIMIT and OFFSET');
        }
        rows.push(stmt.get().map(normalise));
      }
      return { cols: stmt.getColumnNames(), rows };
    } finally {
      stmt.free();
    }
  }

  /** `sql/exec`: one statement that writes. `{changes, rowid}`. */
  exec(sql, params = []) {
    const statement = this._prepareOne(sql, params);
    if (READ_KEYWORDS.has(statement.keyword)) {
      throw new Error('sql/exec runs statements that change the database; '
        + 'a SELECT belongs on sql/query');
    }
    this.statements++;
    const stmt = this.db.prepare(sql);
    try {
      if (params.length) stmt.bind(params);
      stmt.step();
    } finally {
      stmt.free();
    }
    return {
      changes: this.db.getRowsModified(),
      rowid: Number(this.db.exec('SELECT last_insert_rowid()')[0].values[0][0]),
    };
  }

  /** What the panel shows: the schema, from SQLite's own catalogue. */
  get tables() {
    try {
      const out = this.db.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      if (!out.length) return [];
      return out[0].values.map(([name]) => {
        const count = this.db.exec(`SELECT COUNT(*) FROM "${String(name).replace(/"/g, '""')}"`);
        const cols = this.db.exec(`SELECT name FROM pragma_table_info('${String(name).replace(/'/g, "''")}')`);
        return {
          name,
          rows: count.length ? Number(count[0].values[0][0]) : 0,
          columns: cols.length ? cols[0].values.map(([c]) => c) : [],
        };
      });
    } catch {
      return [];
    }
  }

  close() {
    try { this.db.close(); } catch { /* already gone */ }
  }

  /**
   * The gate every call goes through: refuse what must not run, refuse
   * more than one statement, and refuse a parameter count that does not
   * match.
   */
  _prepareOne(sql, params) {
    if (typeof sql !== 'string') throw new Error('args.sql must be a string');
    if (sql.includes('\0')) throw new Error('the statement has an embedded NUL');

    const stripped = stripLiterals(sql);
    const keyword = (/^\s*([a-z]+)/i.exec(stripped)?.[1] ?? '').toLowerCase();
    if (!keyword) throw new Error('an empty statement');
    if (REFUSED_KEYWORDS.has(keyword)) {
      throw new Error(
        `${keyword.toUpperCase()} is refused by this connector. Transactions, ATTACH and `
        + 'PRAGMA are host state held against a guest, and the hostcall encoding has nowhere '
        + 'to put a handle that spans two calls.');
    }

    // One statement per call. The drivers prepare the first and ignore the
    // rest, so a second statement would ride in unauthorised and silently
    // unrun -- which is worse than either running it or refusing it.
    const trailing = stripped.replace(/;\s*$/, '');
    if (trailing.includes(';')) {
      throw new Error('one statement per call; this request carries more than one');
    }

    // Exact parameter count. Too few silently NULL-binds the rest, which
    // is the same class of silent truncation the row cap refuses. Counted
    // from the text with literals and comments removed, because sql.js
    // exposes no `sqlite3_bind_parameter_count`.
    const wanted = (trailing.match(/\?/g) ?? []).length;
    if (wanted !== params.length) {
      throw new Error(
        `this statement takes ${wanted} parameter(s) and ${params.length} were given`);
    }
    return { keyword };
  }
}

/**
 * Blobs arrive as `Uint8Array` and would msgpack as an array of numbers,
 * which is a different type to the guest than the hex string the C
 * connector sends. Everything else is already a number, a string or null.
 */
function normalise(value) {
  return value instanceof Uint8Array ? bytesToHex(value) : value;
}

/**
 * String literals, quoted identifiers and comments, blanked.
 *
 * So that `';'` inside a literal is not read as a statement separator and
 * `'?'` inside one is not counted as a parameter. Blanked rather than
 * removed, so every offset in the result still lines up with the input.
 */
export function stripLiterals(sql) {
  let out = '';
  let i = 0;
  const blank = (n) => { out += ' '.repeat(n); };
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote && sql[j + 1] === quote) { j += 2; continue; }
        if (sql[j] === quote) { j++; break; }
        j++;
      }
      blank(j - i); i = j; continue;
    }
    if (c === '[') {
      const j = sql.indexOf(']', i);
      const end = j === -1 ? sql.length : j + 1;
      blank(end - i); i = end; continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? sql.length : j;
      blank(end - i); i = end; continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      const end = j === -1 ? sql.length : j + 2;
      blank(end - i); i = end; continue;
    }
    out += c; i++;
  }
  return out;
}
