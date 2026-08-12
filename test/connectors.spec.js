import { test, expect } from '@playwright/test';

// The connectors, and the engine behind the `sql` one.
//
// The property under test throughout is **refusal**. A mock that answers a
// query it does not understand with a plausible wrong answer is worse than
// no mock: the program written against it looks like it works, and it stops
// working the day it meets the real host. So the assertions here are mostly
// about what this engine *declines* to do and how clearly it says so.

async function open(page) {
  await page.goto('/test/kernel-page.html');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
}

const sql = (page, statements) => page.evaluate(([list]) => {
  const db = new window.lab.MockDatabase({ mode: 'readwrite', max_rows: 8 });
  return list.map(([kind, text, params]) => {
    try {
      return { ok: true, value: kind === 'query' ? db.query(text, params ?? []) : db.exec(text, params ?? []) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}, [statements]);

test.describe('the sql connector’s engine', () => {
  test('a schema, some rows, and a query over them', async ({ page }) => {
    await open(page);
    const out = await sql(page, [
      ['exec', 'CREATE TABLE endpoint (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE, hits INTEGER)'],
      ['exec', 'INSERT INTO endpoint (label, hits) VALUES (?, ?)', ['alpha', 3]],
      ['exec', 'INSERT INTO endpoint (label, hits) VALUES (?, ?)', ['beta', 9]],
      ['query', 'SELECT label, hits FROM endpoint WHERE hits > ? ORDER BY hits DESC', [2]],
    ]);
    expect(out.every((r) => r.ok)).toBe(true);
    expect(out[1].value).toEqual({ changes: 1, rowid: 1 });
    expect(out[3].value.cols).toEqual(['label', 'hits']);
    expect(out[3].value.rows).toEqual([['beta', 9], ['alpha', 3]]);
  });

  test('constraints are enforced rather than decorative', async ({ page }) => {
    await open(page);
    const out = await sql(page, [
      ['exec', 'CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE)'],
      ['exec', "INSERT INTO t (label) VALUES ('one')"],
      ['exec', "INSERT INTO t (label) VALUES ('one')"],
      ['exec', 'INSERT INTO t (label) VALUES (NULL)'],
      // An UPDATE that leaves a unique column alone must not collide with
      // itself, which is the classic way a naive uniqueness check breaks.
      ['exec', "UPDATE t SET label = 'one' WHERE id = 1"],
    ]);
    expect(out[2].error).toContain('UNIQUE constraint failed');
    expect(out[3].error).toContain('NOT NULL constraint failed');
    expect(out[4].ok).toBe(true);
  });

  test('NULL compares equal to nothing, including itself', async ({ page }) => {
    await open(page);
    const out = await sql(page, [
      ['exec', 'CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT)'],
      ['exec', "INSERT INTO t (note) VALUES ('a'), (NULL)"],
      ['query', 'SELECT id FROM t WHERE note = NULL'],
      ['query', 'SELECT id FROM t WHERE note IS NULL'],
    ]);
    expect(out[2].value.rows).toEqual([]);
    expect(out[3].value.rows).toEqual([[2]]);
  });

  test('aggregates and GROUP BY keep first-appearance order', async ({ page }) => {
    await open(page);
    const out = await sql(page, [
      ['exec', 'CREATE TABLE hit (id INTEGER PRIMARY KEY, path TEXT NOT NULL, ms INTEGER)'],
      ['exec', "INSERT INTO hit (path, ms) VALUES ('/b', 10), ('/a', 4), ('/b', 20)"],
      ['query', 'SELECT path, COUNT(*) AS n, SUM(ms) AS total FROM hit GROUP BY path'],
    ]);
    expect(out[2].value.cols).toEqual(['path', 'n', 'total']);
    expect(out[2].value.rows).toEqual([['/b', 2, 30], ['/a', 1, 4]]);
  });

  test('the row cap refuses rather than truncating', async ({ page }) => {
    await open(page);
    const out = await sql(page, [
      ['exec', 'CREATE TABLE t (id INTEGER PRIMARY KEY)'],
      ['exec', 'INSERT INTO t (id) VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9)'],
      ['query', 'SELECT id FROM t'],
      ['query', 'SELECT id FROM t LIMIT 4'],
    ]);
    // A truncated result is a silent lie; the guest pages with LIMIT.
    expect(out[2].error).toContain('refuses rather than truncating');
    expect(out[3].value.rows.length).toBe(4);
  });

  test('a query may not write and an exec may not read', async ({ page }) => {
    await open(page);
    const out = await sql(page, [
      ['exec', 'CREATE TABLE t (id INTEGER PRIMARY KEY)'],
      ['query', 'DELETE FROM t'],
      ['exec', 'SELECT * FROM t'],
    ]);
    expect(out[1].error).toContain('read-only');
    expect(out[2].error).toContain('sql/query');
  });

  test('what it cannot do, it says, rather than guessing', async ({ page }) => {
    await open(page);
    const out = await sql(page, [
      ['exec', 'CREATE TABLE a (id INTEGER PRIMARY KEY, b INTEGER)'],
      ['exec', 'CREATE TABLE b (id INTEGER PRIMARY KEY)'],
      ['query', 'SELECT a.id FROM a JOIN b ON a.b = b.id'],
      ['query', 'SELECT id FROM a WHERE id IN (SELECT id FROM b)'],
      ['exec', 'BEGIN'],
      ['exec', 'PRAGMA journal_mode = WAL'],
      ['query', 'SELECT strftime(?, id) FROM a', ['%s']],
      ['exec', 'CREATE TABLE c (x INTEGER, y INTEGER, PRIMARY KEY (x, y))'],
    ]);
    // Every one of these is a refusal naming the limitation. None of them
    // is a wrong answer, which is the whole design of this file.
    expect(out[2].error).toContain('no joins');
    expect(out[3].error).toMatch(/no subqueries|understood the statement/);
    expect(out[4].error).toMatch(/implements SELECT, INSERT/);
    expect(out[5].error).toMatch(/implements SELECT, INSERT/);
    expect(out[6].error).toContain('COUNT, SUM, MIN, MAX and AVG');
    expect(out[7].error).toContain('composite key');
  });

  test('read-only mode leaves sql/exec unwired, which is what the grant says', async ({ page }) => {
    await open(page);
    const answer = await page.evaluate(() => {
      const { connectors } = window.lab.buildConnectors({ sql: { mode: 'read' } });
      return {
        query: connectors.get('sql')('sql/query', { sql: 'SELECT 1 AS one' }),
        exec: connectors.get('sql')('sql/exec', { sql: 'CREATE TABLE t (id INTEGER)' }),
      };
    });
    expect(answer.exec.status).toBe('denied');
    expect(answer.exec.detail).toContain('read-only');
  });
});

test.describe('the other connectors', () => {
  test('an unknown connector name is refused by name, at configuration time', async ({ page }) => {
    await open(page);
    const error = await page.evaluate(() => {
      try { window.lab.buildConnectors({ postgres: true }); return null; }
      catch (err) { return err.message; }
    });
    // An unknown key is a typo about to become a silent default. The C
    // host refuses one by name at parse time and so does this.
    expect(error).toContain("unknown connector 'postgres'");
  });

  test('the time connector answers `time` and nothing else', async ({ page }) => {
    await open(page);
    const answers = await page.evaluate(() => {
      const { connectors } = window.lab.buildConnectors({ time: true });
      const fn = connectors.get('time');
      return { good: fn('time'), bad: fn('time/zone') };
    });
    expect(answers.good.status).toBe('ok');
    expect(answers.good.value).toBeGreaterThan(1_700_000_000_000);
    expect(answers.bad.status).toBe('error');
  });

  test('the listener records the port it would bind and binds nothing', async ({ page }) => {
    await open(page);
    const state = await page.evaluate(() => {
      const { listener } = window.lab.buildConnectors({ listen: { port: 9999, max_body: 8 } });
      const request = listener.request({ method: 'POST', path: '/x', body: 'hi' });
      let tooBig = null;
      try { listener.request({ path: '/y', body: 'x'.repeat(64) }); }
      catch (err) { tooBig = err.message; }
      const unmatched = listener.reply({ conn: 999, status: 200 });
      const matched = listener.reply({ conn: request.conn, status: 204, body: 'done' });
      return { request, tooBig, unmatched, matched, bound: listener.bound, port: listener.port };
    });
    expect(state.bound).toBe(false);
    expect(state.port).toBe(9999);
    expect(state.request).toMatchObject({ conn: 1, method: 'POST', path: '/x', body: 'hi' });
    expect(state.tooBig).toContain('max_body');
    // A reply for a conn nobody asked about is visible rather than swallowed.
    expect(state.unmatched).toBeNull();
    expect(state.matched.status).toBe(204);
  });
});
