import { test, expect } from '@playwright/test';

// The `sql` connector, over real SQLite.
//
// This file replaced one that asserted a hand-written engine's *refusals* —
// no joins, no subqueries, no transactions — because refusing was the
// honest thing to do while there was no SQLite in the page. There is now,
// so the assertions moved: the things that used to be refused are checked
// to work, and what remains under test is the confinement, which is the
// part that is genuinely weaker here than on the C host.
//
// `doc/Lab.md` §1a names three SQLite primitives no JavaScript driver
// exposes — the authorizer, `SQLITE_LIMIT_ATTACHED`, and
// `sqlite3_stmt_readonly`. Everything below either verifies a gate that
// stands in for one of them, or verifies a contract the C host also keeps.

async function open(page) {
  await page.goto('/test/kernel-page.html');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
}

/**
 * Run statements through the connector, exactly as a guest would reach it
 * -- which since v5.5.1_build7 means naming the database: the config
 * grants a scope and `args.db` picks a database inside it. Guest-side that
 * is what `host.sql.open("lab.db")` puts on every call it makes.
 */
const sql = (page, statements, config = { scope: 'lab', access: 'readwrite', max_result_rows: 8 },
  db = 'lab.db') =>
  page.evaluate(async ([list, cfg, name]) => {
    const sqlite = await window.lab.loadSqlite();
    const { connectors } = window.lab.buildConnectors({ sql: cfg }, { sqlite });
    const fn = connectors.get('sql');
    return list.map(([call, text, params]) => fn(`sql/${call}`,
      { db: name, sql: text, params: params ?? [] }));
  }, [statements, config, db]);

test.describe('what the old engine refused, SQLite does', () => {
  test('joins, subqueries and grouping', async ({ page }) => {
    await open(page);
    const out = await sql(page, [
      ['exec', 'CREATE TABLE account (id INTEGER PRIMARY KEY, k TEXT NOT NULL UNIQUE)'],
      ['exec', 'CREATE TABLE point (id INTEGER PRIMARY KEY, owner INTEGER NOT NULL, label TEXT)'],
      ['exec', "INSERT INTO account (k) VALUES ('x')"],
      ['exec', "INSERT INTO account (k) VALUES ('y')"],
      ['exec', "INSERT INTO point (owner, label) VALUES (1, 'l1')"],
      ['exec', "INSERT INTO point (owner, label) VALUES (1, 'l2')"],
      ['exec', "INSERT INTO point (owner, label) VALUES (2, 'l3')"],
      ['query', `SELECT a.k, COUNT(p.id) AS n FROM account a
                 JOIN point p ON p.owner = a.id GROUP BY a.k ORDER BY n DESC`],
      ['query', 'SELECT k FROM account WHERE id IN (SELECT owner FROM point WHERE label = ?)', ['l3']],
    ]);
    expect(out.filter((r) => r.status !== 'ok')).toEqual([]);
    expect(out[7].value).toEqual({ cols: ['k', 'n'], rows: [['x', 2], ['y', 1]] });
    expect(out[8].value.rows).toEqual([['y']]);
  });

  test('SQLite\'s own constraint and NULL semantics, not an imitation of them', async ({ page }) => {
    await open(page);
    const out = await sql(page, [
      ['exec', 'CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT NOT NULL UNIQUE, note TEXT)'],
      ['exec', "INSERT INTO t (k) VALUES ('one')"],
      ['exec', "INSERT INTO t (k) VALUES ('one')"],
      ['exec', 'INSERT INTO t (k) VALUES (NULL)'],
      ['exec', "INSERT INTO t (k, note) VALUES ('two', NULL)"],
      ['query', 'SELECT id FROM t WHERE note = NULL'],
      ['query', 'SELECT id FROM t WHERE note IS NULL'],
    ]);
    expect(out[2].detail).toContain('UNIQUE');
    expect(out[3].detail).toContain('NOT NULL');
    // NULL compares equal to nothing, including itself: `= NULL` matches
    // no row, `IS NULL` matches both the row that omitted the column and
    // the row that set it explicitly.
    expect(out[5].value.rows).toEqual([]);
    expect(out[6].value.rows).toEqual([[1], [2]]);
  });

  test('changes and rowid come back from the engine', async ({ page }) => {
    await open(page);
    const out = await sql(page, [
      ['exec', 'CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)'],
      ['exec', 'INSERT INTO t (n) VALUES (1)'],
      ['exec', 'INSERT INTO t (n) VALUES (2)'],
      ['exec', 'UPDATE t SET n = n + 10'],
    ]);
    expect(out[1].value).toEqual({ changes: 1, rowid: 1 });
    expect(out[2].value.rowid).toBe(2);
    expect(out[3].value.changes).toBe(2);
  });
});

test.describe('the confinement, which is the weaker half', () => {
  test('transactions, ATTACH and PRAGMA are refused by keyword', async ({ page }) => {
    await open(page);
    // The C host denies these with `sqlite3_set_authorizer`. There is no
    // authorizer in any JavaScript driver, so this is a text gate — a
    // floor rather than a target, and the reason this connector is for
    // prototyping rather than for data that matters.
    const out = await sql(page, [
      ['exec', 'BEGIN'],
      ['exec', 'COMMIT'],
      ['exec', 'SAVEPOINT s1'],
      ['exec', "ATTACH DATABASE 'other.db' AS other"],
      ['exec', 'PRAGMA journal_mode = WAL'],
      ['exec', 'VACUUM'],
    ]);
    for (const answer of out) {
      expect(answer.status).toBe('error');
      expect(answer.detail).toMatch(/refused by this connector/);
    }
  });

  test('one statement per call, so a second cannot ride in unrun', async ({ page }) => {
    await open(page);
    // The drivers prepare the first statement and ignore the rest, which
    // is the worst of the three options: it neither runs nor refuses.
    const out = await sql(page, [
      ['exec', 'CREATE TABLE t (id INTEGER PRIMARY KEY)'],
      ['exec', "INSERT INTO t (id) VALUES (1); DROP TABLE t"],
      ['query', 'SELECT COUNT(*) AS n FROM t'],
      // A semicolon inside a literal is not a statement separator.
      ['exec', "INSERT INTO t (id) VALUES (2) -- ; not a second statement"],
    ]);
    expect(out[1].status).toBe('error');
    expect(out[1].detail).toContain('one statement per call');
    expect(out[2].value.rows).toEqual([[0]]);
    expect(out[3].status).toBe('ok');
  });

  test('the parameter count must match exactly', async ({ page }) => {
    await open(page);
    // Too few silently NULL-binds the rest, which is the same class of
    // silent wrongness the row cap refuses.
    const out = await sql(page, [
      ['exec', 'CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT)'],
      ['exec', 'INSERT INTO t (a, b) VALUES (?, ?)', ['only-one']],
      ['exec', 'INSERT INTO t (a, b) VALUES (?, ?)', ['a', 'b', 'c']],
      ['exec', 'INSERT INTO t (a, b) VALUES (?, ?)', ['a', 'b']],
      // A `?` inside a string literal is not a parameter.
      ['exec', "INSERT INTO t (a, b) VALUES ('why?', ?)", ['b']],
    ]);
    expect(out[1].detail).toContain('takes 2 parameter(s) and 1 were given');
    expect(out[2].detail).toContain('takes 2 parameter(s) and 3 were given');
    expect(out[3].status).toBe('ok');
    expect(out[4].status).toBe('ok');
  });

  test('the row cap refuses rather than truncating, and does not materialise first', async ({ page }) => {
    await open(page);
    const out = await sql(page, [
      ['exec', 'CREATE TABLE t (id INTEGER PRIMARY KEY)'],
      ['exec', 'INSERT INTO t (id) VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10)'],
      ['query', 'SELECT id FROM t'],
      ['query', 'SELECT id FROM t LIMIT 4'],
    ]);
    // Stepped, not `.all()`-ed: `doc/Lab.md` §1a calls materialising past
    // a hostile cap a memory DoS the C host does not have.
    expect(out[2].status).toBe('error');
    expect(out[2].detail).toContain('refused rather than');
    expect(out[3].value.rows.length).toBe(4);
  });

  test('the read/write split, and what classifies it here', async ({ page }) => {
    await open(page);
    // The C connector asks `sqlite3_stmt_readonly`, so SQLite classifies
    // its own statement. sql.js exposes no such thing — checked, not
    // assumed — so this splits on the first keyword, which classifies the
    // statement someone wrote rather than the one SQLite compiled.
    const out = await sql(page, [
      ['exec', 'CREATE TABLE t (id INTEGER PRIMARY KEY)'],
      ['query', 'DELETE FROM t'],
      ['exec', 'SELECT * FROM t'],
      ['query', 'WITH x AS (SELECT 1 AS n) SELECT n FROM x'],
    ]);
    expect(out[1].detail).toContain('read-only');
    expect(out[2].detail).toContain('sql/query');
    expect(out[3].value.rows).toEqual([[1]]);
  });

  test('read-only mode leaves sql/exec unwired, which is what the grant says', async ({ page }) => {
    await open(page);
    const out = await sql(page, [
      ['query', 'SELECT 1 AS one'],
      ['exec', 'CREATE TABLE t (id INTEGER)'],
    ], { scope: 'lab', access: 'read' });
    // The grant is checked before the database is, exactly as `conn_sql`
    // does: an ungranted write hears that it is not wired rather than that
    // its database could not be created.
    expect(out[1].status).toBe('denied');
    expect(out[1].detail).toContain("'sql/exec' is not wired");
    // And the read half: a read-only scope cannot bring a database into
    // existence either, because `create` follows the write grant.
    expect(out[0].status).toBe('error');
    expect(out[0].detail).toContain('creating one is not granted');
  });

  test('create without the write grant is refused, not half-honoured', async ({ page }) => {
    await open(page);
    const refused = await page.evaluate(async () => {
      const sqlite = await window.lab.loadSqlite();
      try {
        window.lab.buildConnectors(
          { sql: { scope: 'lab', access: 'read', create: true } }, { sqlite });
        return null;
      } catch (err) { return err.message; }
    });
    expect(refused).toContain('needs access "readwrite"');
  });
});

test.describe('the scope, which is the grant the config actually makes', () => {
  test('a name that is a path is denied, not clamped to something inside', async ({ page }) => {
    await open(page);
    // Flat by construction, exactly as `dhost_sql.c`'s `db_for` is: a
    // separator or a `..` kills traversal before any resolution runs. And
    // it is DENIED rather than quietly turned into a legal name, because a
    // program that asked for the wrong database should hear so instead of
    // silently getting a different one.
    const out = await page.evaluate(async () => {
      const sqlite = await window.lab.loadSqlite();
      const { connectors } = window.lab.buildConnectors(
        { sql: { scope: 'lab', access: 'readwrite' } }, { sqlite });
      const fn = connectors.get('sql');
      const ask = (db) => fn('sql/query', { db, sql: 'SELECT 1 AS one', params: [] });
      return {
        traversal: ask('../secrets.db'),
        nested: ask('sub/other.db'),
        windows: ask('sub\\\\other.db'),
        dot: ask('..'),
        missing: ask(undefined),
        empty: ask(''),
        fine: ask('lab.db'),
      };
    });
    for (const key of ['traversal', 'nested', 'windows', 'dot']) {
      expect(out[key].status, key).toBe('denied');
      expect(out[key].detail, key).toContain('steps outside the granted scope');
    }
    // An absent name is a malformed request rather than an escape attempt,
    // and the C host says so with `error` too.
    expect(out.missing.status).toBe('error');
    expect(out.missing.detail).toContain('args.db');
    expect(out.empty.status).toBe('error');
    expect(out.fine.status).toBe('ok');
  });

  test('several databases in one scope, each its own', async ({ page }) => {
    await open(page);
    // The whole point of the scope model: the deployment grants a
    // directory and the *program* decides what to open in it. Two names
    // are two databases, not two views of one.
    const out = await page.evaluate(async () => {
      const sqlite = await window.lab.loadSqlite();
      const { connectors, scope } = window.lab.buildConnectors(
        { sql: { scope: 'lab', access: 'readwrite' } }, { sqlite });
      const fn = connectors.get('sql');
      fn('sql/exec', { db: 'a.db', sql: 'CREATE TABLE only_in_a (id INTEGER)', params: [] });
      fn('sql/exec', { db: 'b.db', sql: 'CREATE TABLE only_in_b (id INTEGER)', params: [] });
      return {
        crossed: fn('sql/query', { db: 'b.db', sql: 'SELECT * FROM only_in_a', params: [] }),
        own: fn('sql/query', { db: 'b.db', sql: 'SELECT * FROM only_in_b', params: [] }),
        names: scope.databases.map((d) => d.name),
      };
    });
    expect(out.crossed.status).toBe('error');
    expect(out.crossed.detail).toContain('only_in_a');
    expect(out.own.status).toBe('ok');
    expect(out.names).toEqual(['a.db', 'b.db']);
  });

  test('create is the grant that decides whether a new name may appear', async ({ page }) => {
    await open(page);
    // An open-mode detail, defaulting to the write grant -- a read-only
    // deployment that created files would be the config contradicting
    // itself. Set explicitly here so the refusal is about `create` and not
    // about `access`.
    const out = await page.evaluate(async () => {
      const sqlite = await window.lab.loadSqlite();
      const { connectors } = window.lab.buildConnectors({
        sql: {
          scope: 'lab', access: 'readwrite', create: false,
          databases: { 'seeded.db': null },
        },
      }, { sqlite });
      const fn = connectors.get('sql');
      return {
        unknown: fn('sql/query', { db: 'fresh.db', sql: 'SELECT 1 AS one', params: [] }),
        seeded: fn('sql/query', { db: 'seeded.db', sql: 'SELECT 1 AS one', params: [] }),
      };
    });
    expect(out.unknown.status).toBe('error');
    expect(out.unknown.detail).toContain('creating one is not granted');
    expect(out.seeded.status).toBe('ok');
  });

  test('the pre-build7 config keys are refused by name, with their replacement', async ({ page }) => {
    await open(page);
    // A config that looks accepted and silently grants a default instead
    // of what it says is the worst of the three outcomes, so each old key
    // is refused by name with the new one in the sentence -- the same
    // migration `dhost.c` performs.
    const out = await page.evaluate(async () => {
      const sqlite = await window.lab.loadSqlite();
      const refuse = (spec) => {
        try { window.lab.buildConnectors({ sql: spec }, { sqlite }); return null; }
        catch (err) { return err.message; }
      };
      return {
        path: refuse({ path: 'lab.db', access: 'read' }),
        mode: refuse({ scope: 'lab', mode: 'readwrite' }),
        maxRows: refuse({ scope: 'lab', max_rows: 64 }),
        access: refuse({ scope: 'lab', access: 'rw' }),
      };
    });
    expect(out.path).toContain('scope');
    expect(out.mode).toContain('access');
    expect(out.maxRows).toContain('max_result_rows');
    expect(out.access).toContain('"read" or "readwrite"');
  });
});

test('literals and comments are blanked before anything is counted', async ({ page }) => {
  await open(page);
  // The gate reads the statement's *text*, so it has to know where text
  // stops being SQL. Blanked rather than removed, so offsets still line up.
  const stripped = await page.evaluate(() => {
    const f = window.lab.stripLiterals;
    return {
      quoted: f("SELECT 'a;b?c' AS x"),
      escaped: f("SELECT 'it''s ; here' AS x"),
      dashComment: f('SELECT 1 -- ; ? trailing\nFROM t'),
      blockComment: f('SELECT /* ; ? */ 1'),
      identifier: f('SELECT "od;d" FROM t'),
    };
  });
  for (const [name, text] of Object.entries(stripped)) {
    expect(`${name}: ${text}`).not.toMatch(/[;?](?!.*trailing)/);
  }
  // And the length is preserved, which is what "blanked" buys.
  expect(stripped.quoted).toHaveLength("SELECT 'a;b?c' AS x".length);
});

test.describe('a database is a file, in both directions', () => {
  test('what the connector wrote can be read back by SQLite itself', async ({ page }) => {
    await open(page);
    const out = await page.evaluate(async () => {
      const sqlite = await window.lab.loadSqlite();
      const { scope, connectors } = window.lab.buildConnectors(
        { sql: { scope: 'lab', access: 'readwrite', max_result_rows: 8 } }, { sqlite });
      const fn = connectors.get('sql');
      const db = 'lab.db';
      fn('sql/exec', { db, sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT)', params: [] });
      fn('sql/exec', { db, sql: 'INSERT INTO t (k) VALUES (?)', params: ['alpha'] });
      fn('sql/exec', { db, sql: 'INSERT INTO t (k) VALUES (?)', params: ['beta'] });

      const bytes = scope.export(db);
      // Not a bespoke dump: SQLite serialises itself, so the first sixteen
      // bytes are the format's own magic and any tool that reads one reads
      // this. That is what makes a schema able to leave the Lab.
      const magic = new TextDecoder().decode(bytes.slice(0, 15));

      // And back in through the front door: a fresh connector opened on
      // those bytes, reached the way a guest reaches it.
      const { connectors: reopened } = window.lab.buildConnectors({
        sql: {
          scope: 'lab', access: 'readwrite', max_result_rows: 8,
          databases: { 'restored.db': bytes },
        },
      }, { sqlite });
      const read = reopened.get('sql')('sql/query',
        { db: 'restored.db', sql: 'SELECT k FROM t ORDER BY id', params: [] });
      return { magic, size: bytes.length, read };
    });
    expect(out.magic).toBe('SQLite format 3');
    expect(out.size).toBeGreaterThan(0);
    expect(out.read.status).toBe('ok');
    expect(out.read.value.rows).toEqual([['alpha'], ['beta']]);
  });

  test('bytes that are not a database are refused when opened, not at first query', async ({ page }) => {
    await open(page);
    const out = await page.evaluate(async () => {
      const sqlite = await window.lab.loadSqlite();
      const rubbish = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      let refused = null;
      try {
        window.lab.buildConnectors(
          { sql: { scope: 'lab', access: 'read', databases: { 'rubbish.db': rubbish } } },
          { sqlite });
      } catch (err) { refused = err.message; }

      // And what SQLite alone would have done with the same bytes, which
      // is why the check above exists rather than being belt-and-braces.
      let sqlJsAlone = 'constructed without complaint';
      const db = new sqlite.Database(rubbish);
      try {
        db.exec('SELECT 1');
        sqlJsAlone = 'and answered a query too';
      } catch (err) { sqlJsAlone = `threw only at query time: ${err.message}`; }
      return { refused, sqlJsAlone, magic: window.lab.looksLikeSqlite(rubbish) };
    });
    expect(out.refused).toContain('not a database file');
    expect(out.magic).toBe(false);
    // Documented rather than asserted loosely: sql.js accepts the bytes and
    // defers the complaint, which puts it arbitrarily far from the wrong
    // file that caused it.
    expect(out.sqlJsAlone).toMatch(/threw only at query time|answered a query too/);
  });
});

test('the one-statement gate is SQLite\'s parser now, not a scan for semicolons', async ({ page }) => {
  await open(page);
  const out = await sql(page, [
    ['exec', 'CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)'],
    // Two statements: refused, and the second must not have run.
    ['exec', "INSERT INTO t (a) VALUES ('x'); DROP TABLE t"],
    // A semicolon inside a literal is one statement, and SQLite is what
    // says so — the text scan this replaced had to blank literals first to
    // reach the same answer, and only for the cases it anticipated.
    ['exec', "INSERT INTO t (a) VALUES ('x;y')"],
    // A trailing semicolon and trailing space are not a second statement.
    ['exec', "INSERT INTO t (a) VALUES ('z');   "],
    ['query', 'SELECT a FROM t ORDER BY id'],
  ]);
  expect(out[1].status).toBe('error');
  expect(out[1].detail).toContain('one statement per call');
  expect(out[2].status).toBe('ok');
  expect(out[3].status).toBe('ok');
  // The table is still here, so the refused DROP never ran — the gate
  // prepares and frees, and preparing is not running.
  expect(out[4].value.rows).toEqual([['x;y'], ['z']]);
});
