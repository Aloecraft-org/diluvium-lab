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

/** Run statements through the connector, exactly as a guest would reach it. */
const sql = (page, statements, config = { mode: 'readwrite', max_rows: 8 }) =>
  page.evaluate(async ([list, cfg]) => {
    const sqlite = await window.lab.loadSqlite();
    const { connectors } = window.lab.buildConnectors({ sql: cfg }, { sqlite });
    const fn = connectors.get('sql');
    return list.map(([call, text, params]) => fn(`sql/${call}`, { sql: text, params: params ?? [] }));
  }, [statements, config]);

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
    ], { mode: 'read' });
    expect(out[0].status).toBe('ok');
    expect(out[1].status).toBe('denied');
    expect(out[1].detail).toContain('read-only');
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
