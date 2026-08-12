// A small SQL engine, so the `sql` connector has something behind it.
//
// ## Why this exists, and what it is not
//
// `doc/Host.md` duty 5 says a deployment's configuration names the
// connectors it wires, and that lab wires JavaScript functions where
// production wires system calls. The C host's `sql` connector stands on the
// system SQLite. A browser tab has no SQLite, and the Lab's hard constraints
// say no CDN and everything vendored -- so the choice is between shipping a
// megabyte of SQLite compiled to wasm, and writing enough of a relational
// engine to answer the same two calls.
//
// This is the second, and the reason it is defensible is the same reason the
// notebook's SQL page is called "SQL, without SQLite": **it refuses what it
// does not implement rather than approximating it.** An unsupported
// statement is an error naming the limitation, not a plausible wrong answer.
// A mock that silently misexecutes a query is worse than no mock at all,
// because the program that runs against it looks like it works.
//
// So the honest summary, which the panel repeats to anyone using it:
//
//   Same wire contract as the C host, same two calls, same shapes, same
//   read-only/readwrite split, same refuse-rather-than-truncate row cap.
//   Different engine, smaller dialect, no persistence, no transactions,
//   no joins, no subqueries. Test your schema here; test your SQL against
//   the real thing before you ship it.
//
// ## What is deliberately not here
//
// Joins and subqueries. Not because they are hard -- the notebook's SQL
// page builds a nested-loop join in ten lines -- but because a mock that
// implements half of SQL invites you to believe it implements the rest.
// The boundary is easier to state at "one table per statement" than at
// "joins, but not correlated ones, and not RIGHT".
//
// Transactions. `BEGIN` without rollback semantics would be a lie in the
// one place a database's promises actually matter.

/** Values a column may hold, in SQLite's storage classes. */
const SQL_TYPES = new Set(['INTEGER', 'INT', 'TEXT', 'REAL', 'BLOB', 'NUMERIC', 'BOOLEAN']);

export class MockDatabase {
  /**
   * @param {object} [config] the connector's configuration, in
   *   `host/types/host.lua`'s `diluvium.HostSql` shape
   */
  constructor({ path = ':memory:', mode = 'read', max_rows: maxRows = 1024 } = {}) {
    this.path = path;
    this.readwrite = mode === 'readwrite';
    this.maxRows = maxRows;
    /** name -> {columns, rows, nextRowid} */
    this.tables = new Map();
    this.statements = 0;
  }

  /**
   * `sql/query`: one statement, and it must not write.
   *
   * The C connector asks `sqlite3_stmt_readonly`, so its classification is
   * SQLite's own rather than a regex. This one classifies by parsing, which
   * is the same idea reached differently: the statement is understood before
   * it is judged, so `SELECT` is a query and everything else is not,
   * including a `PRAGMA` dressed up as one.
   */
  query(sql, params = []) {
    const statement = parseSql(sql);
    if (statement.kind !== 'select') {
      throw new Error(
        `sql/query runs read-only statements and this is a ${statement.kind.toUpperCase()}; `
        + 'use sql/exec, which a deployment wires only when its mode is readwrite');
    }
    this.statements++;
    return this._select(statement, params);
  }

  /** `sql/exec`: one statement that writes. `{changes, rowid}`. */
  exec(sql, params = []) {
    const statement = parseSql(sql);
    this.statements++;
    switch (statement.kind) {
      case 'create': return this._create(statement);
      case 'drop': return this._drop(statement);
      case 'insert': return this._insert(statement, params);
      case 'update': return this._update(statement, params);
      case 'delete': return this._delete(statement, params);
      case 'select':
        throw new Error('sql/exec runs statements that change the database; a SELECT belongs on sql/query');
      default:
        throw new Error(`this engine does not implement ${statement.kind.toUpperCase()}`);
    }
  }

  // --- statements ----------------------------------------------------

  _create(statement) {
    if (this.tables.has(statement.table)) {
      if (statement.ifNotExists) return { changes: 0, rowid: 0 };
      throw new Error(`table ${statement.table} already exists`);
    }
    this.tables.set(statement.table, {
      columns: statement.columns,
      rows: [],
      nextRowid: 1,
    });
    return { changes: 0, rowid: 0 };
  }

  _drop(statement) {
    if (!this.tables.has(statement.table)) {
      if (statement.ifExists) return { changes: 0, rowid: 0 };
      throw new Error(`no such table: ${statement.table}`);
    }
    this.tables.delete(statement.table);
    return { changes: 0, rowid: 0 };
  }

  _insert(statement, params) {
    const table = this._table(statement.table);
    const binder = new ParamBinder(params);
    const names = statement.columns ?? table.columns.map((c) => c.name);
    let changes = 0;
    let rowid = 0;
    for (const tuple of statement.values) {
      if (tuple.length !== names.length) {
        throw new Error(`${names.length} columns named but ${tuple.length} values given`);
      }
      const row = Object.create(null);
      for (const column of table.columns) {
        row[column.name] = column.default === undefined ? null : column.default;
      }
      names.forEach((name, i) => {
        this._column(table, statement.table, name);
        row[name] = coerceValue(evaluateSql(tuple[i], null, binder), this._column(table, statement.table, name));
      });
      row.rowid = row.rowid ?? table.nextRowid;
      // INTEGER PRIMARY KEY is the rowid, as in SQLite: an explicit value
      // sets it, and an absent one takes the next.
      const pk = table.columns.find((c) => c.primaryKey && /^INT/.test(c.type));
      if (pk) {
        if (row[pk.name] === null || row[pk.name] === undefined) row[pk.name] = table.nextRowid;
        row.rowid = row[pk.name];
      }
      this._checkConstraints(table, statement.table, row, null);
      table.rows.push(row);
      table.nextRowid = Math.max(table.nextRowid + 1, Number(row.rowid) + 1);
      rowid = Number(row.rowid);
      changes++;
    }
    return { changes, rowid };
  }

  _update(statement, params) {
    const table = this._table(statement.table);
    const binder = new ParamBinder(params);
    let changes = 0;
    for (const row of table.rows) {
      if (statement.where && !sqlTruthy(evaluateSql(statement.where, row, binder))) continue;
      const next = { ...row };
      for (const [name, expression] of statement.set) {
        this._column(table, statement.table, name);
        next[name] = coerceValue(evaluateSql(expression, row, binder), this._column(table, statement.table, name));
      }
      this._checkConstraints(table, statement.table, next, row);
      Object.assign(row, next);
      changes++;
    }
    return { changes, rowid: 0 };
  }

  _delete(statement, params) {
    const table = this._table(statement.table);
    const binder = new ParamBinder(params);
    const before = table.rows.length;
    table.rows = table.rows.filter(
      (row) => (statement.where ? !sqlTruthy(evaluateSql(statement.where, row, binder)) : false),
    );
    return { changes: before - table.rows.length, rowid: 0 };
  }

  _select(statement, params) {
    const table = this._table(statement.table);
    const binder = new ParamBinder(params);
    let rows = statement.where
      ? table.rows.filter((row) => sqlTruthy(evaluateSql(statement.where, row, binder)))
      : [...table.rows];

    const aggregating = statement.columns.some((c) => isAggregateExpr(c.expression))
      || statement.groupBy.length > 0;

    let result;
    if (aggregating) {
      const groups = groupSqlRows(rows, statement.groupBy, binder);
      result = groups.map(({ key, members }) => {
        const out = Object.create(null);
        for (const column of statement.columns) {
          out[column.alias] = evaluateSql(column.expression, key, binder, members);
        }
        return out;
      });
    } else {
      // ORDER BY may name a column the projection drops, so sorting happens
      // on the source rows and the projection comes after.
      if (statement.orderBy.length) rows = sortSqlRows(rows, statement.orderBy, binder);
      result = rows.map((row) => {
        const out = Object.create(null);
        for (const column of statement.columns) {
          if (column.star) {
            for (const c of table.columns) out[c.name] = row[c.name] ?? null;
          } else {
            out[column.alias] = evaluateSql(column.expression, row, binder);
          }
        }
        return out;
      });
    }

    if (aggregating && statement.orderBy.length) {
      result = sortSqlRows(result, statement.orderBy, binder);
    }
    if (statement.distinctRows) result = distinctRows(result);

    const offset = statement.offset ?? 0;
    if (offset) result = result.slice(offset);
    if (statement.limit !== null && statement.limit !== undefined) {
      result = result.slice(0, statement.limit);
    }

    // Refuse rather than truncate. A truncated result is a silent lie, and
    // the guest can page with LIMIT/OFFSET like everything else that reads
    // a database. The C connector does exactly this.
    if (result.length > this.maxRows) {
      throw new Error(
        `this query returns ${result.length} rows and the connector's max_rows is ${this.maxRows}; `
        + 'it refuses rather than truncating -- page with LIMIT and OFFSET');
    }

    const cols = result.length
      ? Object.keys(result[0])
      : statement.columns.filter((c) => !c.star).map((c) => c.alias);
    return { cols, rows: result.map((row) => cols.map((c) => row[c] ?? null)) };
  }

  // --- the small print -------------------------------------------------

  _table(name) {
    const table = this.tables.get(name);
    if (!table) throw new Error(`no such table: ${name}`);
    return table;
  }

  _column(table, tableName, name) {
    const column = table.columns.find((c) => c.name === name);
    if (!column) throw new Error(`table ${tableName} has no column named ${name}`);
    return column;
  }

  /**
   * NOT NULL and UNIQUE, checked before the write lands.
   *
   * `previous` is the row being replaced on an UPDATE, so a row does not
   * collide with itself -- the mistake that makes a naive uniqueness check
   * refuse every update that leaves a unique column alone.
   */
  _checkConstraints(table, tableName, row, previous) {
    for (const column of table.columns) {
      const value = row[column.name];
      if (column.notNull && (value === null || value === undefined)) {
        throw new Error(`NOT NULL constraint failed: ${tableName}.${column.name}`);
      }
      if ((column.unique || column.primaryKey) && value !== null && value !== undefined) {
        const clash = table.rows.some((other) => other !== previous && other[column.name] === value);
        if (clash) {
          throw new Error(`UNIQUE constraint failed: ${tableName}.${column.name}`);
        }
      }
    }
  }
}

/**
 * Positional `?` parameters.
 *
 * **Numbered at parseSql time, not consumed at evaluation time**, which is
 * SQLite's rule and is load-bearing rather than pedantic: a WHERE clause is
 * evaluated once per row, so a binder that handed out "the next parameter"
 * would give row 1 the first `?` and row 2 the second — and then run out.
 * That was this file's first bug, and it only showed up on the second row
 * of a table, which is why the test that found it inserts two.
 */
class ParamBinder {
  constructor(params) {
    this.params = params;
  }

  take(index) {
    const i = index - 1;
    if (i < 0 || i >= this.params.length) {
      throw new Error(`this statement wants parameter ${index} and ${this.params.length} were given`);
    }
    return this.params[i];
  }
}

// ======================================================================
// The parser. Three stages, as small as they can honestly be: tokenizeSql,
// parseSql to a tree, and refuse anything left over -- that last part being
// the one that makes this safe to put behind a connector.
// ======================================================================

const SQL_KEYWORDS = new Set([
  'select', 'distinctRows', 'from', 'where', 'order', 'by', 'asc', 'desc', 'limit',
  'offset', 'group', 'insert', 'into', 'values', 'update', 'set', 'delete',
  'create', 'table', 'drop', 'if', 'not', 'exists', 'and', 'or', 'null', 'is',
  'in', 'like', 'as', 'primary', 'key', 'unique', 'default', 'autoincrement',
  'true', 'false', 'count', 'sum', 'min', 'max', 'avg',
]);

function tokenizeSql(sql) {
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) { i += space[0].length; continue; }
    if (rest.startsWith('--')) { i += rest.indexOf('\n') === -1 ? rest.length : rest.indexOf('\n'); continue; }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      if (end === -1) throw new Error('unterminated /* comment');
      i += end + 2; continue;
    }
    const string = /^'((?:[^']|'')*)'/.exec(rest);
    if (string) {
      tokens.push({ kind: 'string', value: string[1].replace(/''/g, "'") });
      i += string[0].length; continue;
    }
    const quoted = /^"([^"]*)"/.exec(rest) || /^`([^`]*)`/.exec(rest) || /^\[([^\]]*)\]/.exec(rest);
    if (quoted) {
      tokens.push({ kind: 'name', value: quoted[1], quoted: true });
      i += quoted[0].length; continue;
    }
    const number = /^\d+\.\d+|^\d+/.exec(rest);
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      i += number[0].length; continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(rest);
    if (word) {
      const lower = word[0].toLowerCase();
      tokens.push(SQL_KEYWORDS.has(lower)
        ? { kind: 'keyword', value: lower }
        : { kind: 'name', value: word[0] });
      i += word[0].length; continue;
    }
    const param = /^\?(\d+)?/.exec(rest);
    if (param) {
      tokens.push({ kind: 'param', value: param[1] ? Number(param[1]) : null });
      i += param[0].length; continue;
    }
    const operator = /^(<>|!=|>=|<=|\|\|)/.exec(rest) || /^[=<>+\-*/%(),.;]/.exec(rest);
    if (operator) {
      tokens.push({ kind: 'op', value: operator[0] });
      i += operator[0].length; continue;
    }
    // Named parameters, JSON operators, window functions, whatever it was:
    // the answer is the same, and it says what it saw.
    throw new Error(`this engine cannot read \`${rest.slice(0, 12)}\` in a statement`);
  }
  return tokens;
}

class SqlParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
    /** How many bare `?` have been seen: the Nth is parameter N. */
    this.params = 0;
  }

  peek(offset = 0) { return this.tokens[this.i + offset]; }

  at(kind, value) {
    const t = this.peek();
    return !!t && t.kind === kind && (value === undefined || t.value === value);
  }

  atKeyword(...words) {
    const t = this.peek();
    return !!t && t.kind === 'keyword' && words.includes(t.value);
  }

  take() { return this.tokens[this.i++]; }

  expect(kind, value) {
    if (!this.at(kind, value)) {
      const got = this.peek() ? `\`${this.peek().value}\`` : 'the end of the statement';
      throw new Error(`expected ${value ?? kind} but found ${got}`);
    }
    return this.take();
  }

  /** A name, or a keyword being used as one -- `key`, `count` and friends. */
  name() {
    const t = this.peek();
    if (!t || (t.kind !== 'name' && t.kind !== 'keyword')) {
      throw new Error(`expected a name but found ${t ? `\`${t.value}\`` : 'nothing'}`);
    }
    this.take();
    return t.value;
  }

  done() {
    if (this.at('op', ';')) this.take();
    if (this.i < this.tokens.length) {
      const extra = this.tokens.slice(this.i).map((t) => t.value).join(' ');
      throw new Error(
        `this engine understood the statement up to \`${extra.slice(0, 40)}\` and stopped there. `
        + 'It implements one table per statement: no joins, no subqueries, no transactions. '
        + 'It refuses rather than guessing, because a wrong answer here would look like a right one.');
    }
  }
}

export function parseSql(sql) {
  const parser = new SqlParser(tokenizeSql(sql));
  if (!parser.peek()) throw new Error('an empty statement');
  const head = parser.peek();
  const unimplemented = () => new Error(
    'this engine implements SELECT, INSERT, UPDATE, DELETE, CREATE TABLE and DROP TABLE; '
    + `\`${String(head.value).toUpperCase()}\` is not one of them. Notably absent and deliberately `
    + 'so: BEGIN and friends, because a transaction without rollback semantics would be a lie in '
    + 'the one place a database’s promises matter, and PRAGMA, because a guest has no read-only '
    + 'PRAGMA worth having.');
  if (head.kind !== 'keyword') throw unimplemented();
  let statement;
  switch (head.value) {
    case 'select': statement = parseSelect(parser); break;
    case 'insert': statement = parseInsert(parser); break;
    case 'update': statement = parseUpdate(parser); break;
    case 'delete': statement = parseDelete(parser); break;
    case 'create': statement = parseCreate(parser); break;
    case 'drop': statement = parseDrop(parser); break;
    default:
      throw unimplemented();
  }
  parser.done();
  return statement;
}

function parseSelect(parser) {
  parser.expect('keyword', 'select');
  const distinctRows = parser.atKeyword('distinctRows') ? (parser.take(), true) : false;
  const columns = [];
  do {
    if (parser.at('op', '*')) {
      parser.take();
      columns.push({ star: true, alias: '*' });
    } else {
      const expression = parseExpression(parser);
      let alias = defaultColumnAlias(expression, columns.length);
      if (parser.atKeyword('as')) { parser.take(); alias = parser.name(); }
      else if (parser.at('name')) alias = parser.name();
      columns.push({ expression, alias });
    }
  } while (parser.at('op', ',') && parser.take());

  parser.expect('keyword', 'from');
  const table = parser.name();

  const where = parser.atKeyword('where') ? (parser.take(), parseExpression(parser)) : null;

  const groupBy = [];
  if (parser.atKeyword('group')) {
    parser.take();
    parser.expect('keyword', 'by');
    do { groupBy.push(parseExpression(parser)); } while (parser.at('op', ',') && parser.take());
  }

  const orderBy = [];
  if (parser.atKeyword('order')) {
    parser.take();
    parser.expect('keyword', 'by');
    do {
      const expression = parseExpression(parser);
      let descending = false;
      if (parser.atKeyword('asc')) parser.take();
      else if (parser.atKeyword('desc')) { parser.take(); descending = true; }
      orderBy.push({ expression, descending });
    } while (parser.at('op', ',') && parser.take());
  }

  let limit = null;
  let offset = 0;
  if (parser.atKeyword('limit')) {
    parser.take();
    limit = Number(parser.expect('number').value);
  }
  if (parser.atKeyword('offset')) {
    parser.take();
    offset = Number(parser.expect('number').value);
  }
  return { kind: 'select', distinctRows, columns, table, where, groupBy, orderBy, limit, offset };
}

function parseInsert(parser) {
  parser.expect('keyword', 'insert');
  parser.expect('keyword', 'into');
  const table = parser.name();
  let columns = null;
  if (parser.at('op', '(')) {
    parser.take();
    columns = [];
    do { columns.push(parser.name()); } while (parser.at('op', ',') && parser.take());
    parser.expect('op', ')');
  }
  parser.expect('keyword', 'values');
  const values = [];
  do {
    parser.expect('op', '(');
    const tuple = [];
    do { tuple.push(parseExpression(parser)); } while (parser.at('op', ',') && parser.take());
    parser.expect('op', ')');
    values.push(tuple);
  } while (parser.at('op', ',') && parser.take());
  return { kind: 'insert', table, columns, values };
}

function parseUpdate(parser) {
  parser.expect('keyword', 'update');
  const table = parser.name();
  parser.expect('keyword', 'set');
  const set = [];
  do {
    const name = parser.name();
    parser.expect('op', '=');
    set.push([name, parseExpression(parser)]);
  } while (parser.at('op', ',') && parser.take());
  const where = parser.atKeyword('where') ? (parser.take(), parseExpression(parser)) : null;
  return { kind: 'update', table, set, where };
}

function parseDelete(parser) {
  parser.expect('keyword', 'delete');
  parser.expect('keyword', 'from');
  const table = parser.name();
  const where = parser.atKeyword('where') ? (parser.take(), parseExpression(parser)) : null;
  return { kind: 'delete', table, where };
}

function parseCreate(parser) {
  parser.expect('keyword', 'create');
  parser.expect('keyword', 'table');
  let ifNotExists = false;
  if (parser.atKeyword('if')) {
    parser.take(); parser.expect('keyword', 'not'); parser.expect('keyword', 'exists');
    ifNotExists = true;
  }
  const table = parser.name();
  parser.expect('op', '(');
  const columns = [];
  do {
    // A table-level PRIMARY KEY (a, b) clause is where composite keys live,
    // and this engine has no composite keys -- so it says so rather than
    // parsing one and ignoring it.
    if (parser.atKeyword('primary', 'unique')) {
      throw new Error('this engine implements column constraints only; '
        + 'a table-level PRIMARY KEY or UNIQUE clause (and so a composite key) is not supported');
    }
    const name = parser.name();
    let type = 'TEXT';
    if (parser.at('name') || parser.atKeyword()) {
      const candidate = String(parser.peek().value).toUpperCase();
      if (SQL_TYPES.has(candidate)) { parser.take(); type = candidate; }
    }
    const column = { name, type, notNull: false, unique: false, primaryKey: false, default: undefined };
    for (;;) {
      if (parser.atKeyword('primary')) {
        parser.take(); parser.expect('keyword', 'key'); column.primaryKey = true;
        if (parser.atKeyword('autoincrement')) parser.take();
      } else if (parser.atKeyword('not')) {
        parser.take(); parser.expect('keyword', 'null'); column.notNull = true;
      } else if (parser.atKeyword('unique')) {
        parser.take(); column.unique = true;
      } else if (parser.atKeyword('default')) {
        parser.take();
        column.default = evaluateSql(parseExpression(parser), null, new ParamBinder([]));
      } else break;
    }
    columns.push(column);
  } while (parser.at('op', ',') && parser.take());
  parser.expect('op', ')');
  return { kind: 'create', table, columns, ifNotExists };
}

function parseDrop(parser) {
  parser.expect('keyword', 'drop');
  parser.expect('keyword', 'table');
  let ifExists = false;
  if (parser.atKeyword('if')) { parser.take(); parser.expect('keyword', 'exists'); ifExists = true; }
  return { kind: 'drop', table: parser.name(), ifExists };
}

// --- expressions, by precedence ---------------------------------------

function parseExpression(parser) { return parseOr(parser); }

function parseOr(parser) {
  let left = parseAnd(parser);
  while (parser.atKeyword('or')) {
    parser.take();
    left = { op: 'or', left, right: parseAnd(parser) };
  }
  return left;
}

function parseAnd(parser) {
  let left = parseNot(parser);
  while (parser.atKeyword('and')) {
    parser.take();
    left = { op: 'and', left, right: parseNot(parser) };
  }
  return left;
}

function parseNot(parser) {
  if (parser.atKeyword('not')) {
    parser.take();
    return { op: 'not', operand: parseNot(parser) };
  }
  return parseComparison(parser);
}

function parseComparison(parser) {
  let left = parseAdditive(parser);
  for (;;) {
    if (parser.atKeyword('is')) {
      parser.take();
      const negated = parser.atKeyword('not') ? (parser.take(), true) : false;
      parser.expect('keyword', 'null');
      left = { op: negated ? 'isnotnull' : 'isnull', operand: left };
    } else if (parser.atKeyword('in')) {
      parser.take();
      parser.expect('op', '(');
      const items = [];
      do { items.push(parseExpression(parser)); } while (parser.at('op', ',') && parser.take());
      parser.expect('op', ')');
      left = { op: 'in', left, items };
    } else if (parser.atKeyword('like')) {
      parser.take();
      left = { op: 'like', left, right: parseAdditive(parser) };
    } else if (parser.at('op') && ['=', '<>', '!=', '<', '<=', '>', '>='].includes(parser.peek().value)) {
      const op = parser.take().value;
      left = { op: op === '!=' ? '<>' : op, left, right: parseAdditive(parser) };
    } else return left;
  }
}

function parseAdditive(parser) {
  let left = parseMultiplicative(parser);
  while (parser.at('op') && ['+', '-', '||'].includes(parser.peek().value)) {
    const op = parser.take().value;
    left = { op, left, right: parseMultiplicative(parser) };
  }
  return left;
}

function parseMultiplicative(parser) {
  let left = parsePrimary(parser);
  while (parser.at('op') && ['*', '/', '%'].includes(parser.peek().value)) {
    const op = parser.take().value;
    left = { op, left, right: parsePrimary(parser) };
  }
  return left;
}

const SQL_AGGREGATES = new Set(['count', 'sum', 'min', 'max', 'avg']);

function parsePrimary(parser) {
  const t = parser.peek();
  if (!t) throw new Error('the statement ends where a value was expected');
  if (t.kind === 'number') { parser.take(); return { op: 'literal', value: t.value }; }
  if (t.kind === 'string') { parser.take(); return { op: 'literal', value: t.value }; }
  if (t.kind === 'param') {
    parser.take();
    // `?NNN` is explicit and 1-based; a bare `?` is the next in source
    // order. Fixed here, once, so evaluating the same node a thousand
    // times over a thousand rows asks for the same parameter each time.
    return { op: 'param', index: t.value === null ? ++parser.params : t.value };
  }
  if (parser.at('op', '(')) {
    parser.take();
    const inner = parseExpression(parser);
    parser.expect('op', ')');
    return inner;
  }
  if (parser.at('op', '-')) { parser.take(); return { op: 'negate', operand: parsePrimary(parser) }; }
  if (t.kind === 'keyword' && SQL_AGGREGATES.has(t.value)) {
    parser.take();
    parser.expect('op', '(');
    let argument = null;
    let star = false;
    if (parser.at('op', '*')) { parser.take(); star = true; }
    else argument = parseExpression(parser);
    parser.expect('op', ')');
    return { op: 'aggregateOver', fn: t.value, argument, star };
  }
  if (t.kind === 'keyword' && ['null', 'true', 'false'].includes(t.value)) {
    parser.take();
    return { op: 'literal', value: t.value === 'null' ? null : t.value === 'true' };
  }
  if (t.kind === 'keyword' && ['select', 'insert', 'update', 'delete', 'create', 'drop'].includes(t.value)) {
    // A statement keyword where a value belongs is a subquery, and the
    // useful error names that rather than complaining about a parenthesis
    // three tokens later.
    throw new Error('this engine implements one table per statement: no subqueries, '
      + `and \`${t.value.toUpperCase()}\` here is one. It refuses rather than guessing, `
      + 'because a wrong answer here would look like a right one.');
  }
  if (t.kind === 'name' || t.kind === 'keyword') {
    const name = parser.name();
    if (parser.at('op', '.')) {
      // `t.col` -- accepted and flattened, because one table per statement
      // means the qualifier can only be that table.
      parser.take();
      return { op: 'column', name: parser.name() };
    }
    if (parser.at('op', '(')) {
      throw new Error(`this engine implements COUNT, SUM, MIN, MAX and AVG; \`${name}\` is not one of them`);
    }
    return { op: 'column', name };
  }
  throw new Error(`\`${t.value}\` is not something this engine can evaluateSql`);
}

function defaultColumnAlias(expression, index) {
  if (expression.op === 'column') return expression.name;
  if (expression.op === 'aggregateOver') {
    return `${expression.fn.toUpperCase()}(${expression.star ? '*' : (expression.argument?.name ?? '?')})`;
  }
  return `column${index + 1}`;
}

// --- evaluation --------------------------------------------------------

function isAggregateExpr(expression) {
  if (!expression || typeof expression !== 'object') return false;
  if (expression.op === 'aggregateOver') return true;
  return ['left', 'right', 'operand', 'argument'].some((k) => isAggregateExpr(expression[k]))
    || (expression.items ?? []).some(isAggregateExpr);
}

/**
 * @param {object} expression
 * @param {object|null} row the row in scope, or the group key when aggregating
 * @param {ParamBinder} binder
 * @param {object[]|null} members the group's rows, when aggregating
 */
export function evaluateSql(expression, row, binder, members = null) {
  switch (expression.op) {
    case 'literal': return expression.value;
    case 'param': return binder.take(expression.index);
    case 'column': {
      if (row && expression.name in row) return row[expression.name];
      if (members && members.length && expression.name in members[0]) {
        // A bare column beside an aggregateOver is SQLite's "any member of the
        // group" rule. Taking the first is the same choice, and it is
        // arbitrary in the same way -- which is why GROUP BY exists.
        return members[0][expression.name];
      }
      if (row === null && members === null) {
        throw new Error(`no column named ${expression.name} is in scope here`);
      }
      return null;
    }
    case 'negate': return -Number(evaluateSql(expression.operand, row, binder, members));
    case 'not': return !sqlTruthy(evaluateSql(expression.operand, row, binder, members));
    case 'and': return sqlTruthy(evaluateSql(expression.left, row, binder, members))
      && sqlTruthy(evaluateSql(expression.right, row, binder, members));
    case 'or': return sqlTruthy(evaluateSql(expression.left, row, binder, members))
      || sqlTruthy(evaluateSql(expression.right, row, binder, members));
    case 'isnull': return evaluateSql(expression.operand, row, binder, members) === null;
    case 'isnotnull': return evaluateSql(expression.operand, row, binder, members) !== null;
    case 'in': {
      const value = evaluateSql(expression.left, row, binder, members);
      return expression.items.some((item) => compareValues(value, evaluateSql(item, row, binder, members)) === 0);
    }
    case 'like': {
      const value = evaluateSql(expression.left, row, binder, members);
      const pattern = evaluateSql(expression.right, row, binder, members);
      if (value === null || pattern === null) return false;
      return likeToRegExp(String(pattern)).test(String(value));
    }
    case 'aggregateOver': return aggregateOver(expression, binder, members ?? []);
    case '||': {
      const l = evaluateSql(expression.left, row, binder, members);
      const r = evaluateSql(expression.right, row, binder, members);
      return l === null || r === null ? null : `${l}${r}`;
    }
    case '+': case '-': case '*': case '/': case '%': {
      const l = evaluateSql(expression.left, row, binder, members);
      const r = evaluateSql(expression.right, row, binder, members);
      if (l === null || r === null) return null;
      const a = Number(l);
      const b = Number(r);
      if (expression.op === '+') return a + b;
      if (expression.op === '-') return a - b;
      if (expression.op === '*') return a * b;
      if (expression.op === '%') return b === 0 ? null : a % b;
      return b === 0 ? null : a / b;      // SQLite gives NULL, not an error
    }
    case '=': case '<>': case '<': case '<=': case '>': case '>=': {
      const l = evaluateSql(expression.left, row, binder, members);
      const r = evaluateSql(expression.right, row, binder, members);
      // NULL compares equal to nothing, including itself. `IS NULL` is the
      // test, and getting this wrong is the classic SQL bug.
      if (l === null || r === null) return false;
      const c = compareValues(l, r);
      switch (expression.op) {
        case '=': return c === 0;
        case '<>': return c !== 0;
        case '<': return c < 0;
        case '<=': return c <= 0;
        case '>': return c > 0;
        default: return c >= 0;
      }
    }
    default:
      throw new Error(`this engine cannot evaluateSql \`${expression.op}\``);
  }
}

function aggregateOver(expression, binder, members) {
  if (expression.fn === 'count') {
    if (expression.star) return members.length;
    return members.filter((r) => evaluateSql(expression.argument, r, binder) !== null).length;
  }
  const values = members
    .map((r) => evaluateSql(expression.argument, r, binder))
    .filter((v) => v !== null && v !== undefined);
  if (!values.length) return expression.fn === 'sum' ? 0 : null;
  switch (expression.fn) {
    case 'sum': return values.reduce((a, b) => a + Number(b), 0);
    case 'avg': return values.reduce((a, b) => a + Number(b), 0) / values.length;
    case 'min': return values.reduce((a, b) => (compareValues(a, b) <= 0 ? a : b));
    default: return values.reduce((a, b) => (compareValues(a, b) >= 0 ? a : b));
  }
}

function groupSqlRows(rows, groupBy, binder) {
  if (!groupBy.length) return [{ key: null, members: rows }];
  const groups = new Map();
  const order = [];
  for (const row of rows) {
    const values = groupBy.map((g) => evaluateSql(g, row, binder));
    const key = JSON.stringify(values);
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(row);
  }
  return order.map((key) => ({ key: groups.get(key)[0], members: groups.get(key) }));
}

function sortSqlRows(rows, orderBy, binder) {
  return [...rows].sort((a, b) => {
    for (const { expression, descending } of orderBy) {
      const av = expression.op === 'column' && !(expression.name in a)
        ? null : evaluateSql(expression, a, binder, [a]);
      const bv = expression.op === 'column' && !(expression.name in b)
        ? null : evaluateSql(expression, b, binder, [b]);
      const c = compareValues(av, bv);
      if (c !== 0) return descending ? -c : c;
    }
    return 0;
  });
}

function distinctRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** NULL sorts first, numbers before strings -- SQLite's storage-class order. */
function compareValues(a, b) {
  if (a === null || a === undefined) return (b === null || b === undefined) ? 0 : -1;
  if (b === null || b === undefined) return 1;
  const an = typeof a === 'number' || typeof a === 'boolean';
  const bn = typeof b === 'number' || typeof b === 'boolean';
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1;
  if (bn) return 1;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function sqlTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return true;
}

function likeToRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/%/g, '.*').replace(/_/g, '.')}$`, 'is');
}

/** SQLite's affinity, in the one form that matters: an INTEGER column stores integers. */
function coerceValue(value, column) {
  if (value === null || value === undefined) return null;
  if (/^INT/.test(column.type) && typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  if (column.type === 'REAL' && typeof value === 'string' && /^-?\d*\.?\d+$/.test(value)) {
    return Number(value);
  }
  if (column.type === 'TEXT' && typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}
