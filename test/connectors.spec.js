import { test, expect } from '@playwright/test';

// The connectors, minus `sql`, which has a file of its own.
//
// The property under test throughout is **refusal**. A connector that
// answers a call it does not understand with a plausible wrong answer is
// worse than no connector: the program written against it looks like it
// works, and it stops working the day it meets the real host. So the
// assertions here are mostly about what these *decline* to do and how
// clearly they say so.
//
// `sql` moved to test/sqlite.spec.js when the hand-written engine was
// replaced by real SQLite. Most of what used to be asserted here was that
// engine's refusals -- no joins, no subqueries, no transactions -- and
// those are not refusals any more.

async function open(page) {
  await page.goto('/test/kernel-page.html');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
}

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

  test('only allowlisted request headers reach the guest', async ({ page }) => {
    await open(page);
    // `host/dhost_http.c`'s rules, because this is the half a guest can
    // see: nothing forwarded by default, repeats joined ", " per RFC
    // 7230's list rule, an absent header absent rather than empty, and a
    // value past the bound refused rather than truncated.
    const state = await page.evaluate(() => {
      const bare = window.lab.buildConnectors({ listen: { port: 1 } }).listener;
      const picky = window.lab.buildConnectors({
        listen: { port: 2, headers: ['user-agent', 'Authorization', 'x-trace'] },
      }).listener;
      let tooLong = null;
      try {
        picky.request({ path: '/big', headers: { 'x-trace': 'z'.repeat(5000) } });
      } catch (err) { tooLong = err.message; }
      let tooMany = null;
      try {
        window.lab.buildConnectors({ listen: { headers: Array(9).fill('x') } });
      } catch (err) { tooMany = err.message; }
      return {
        bare: bare.request({ path: '/', headers: { 'user-agent': 'curl' } }),
        allowed: picky.request({
          path: '/',
          headers: {
            'User-Agent': 'curl/8',            // matched case-insensitively
            Authorization: 'Bearer t',         // allowlisted with a capital A
            Cookie: 'session=secret',          // not allowlisted: never seen
            'x-trace': ['a', 'b'],             // repeats join
          },
        }),
        none: picky.request({ path: '/', headers: {} }),
        allowlist: picky.headers,
        tooLong,
        tooMany,
      };
    });
    // Empty by default: a header the deployment did not name never arrives,
    // and the `headers` field is not there at all.
    expect(state.bare.headers).toBeUndefined();
    // The allowlist is lowercased, whatever the config wrote.
    expect(state.allowlist).toEqual(['user-agent', 'authorization', 'x-trace']);
    expect(state.allowed.headers).toEqual({
      'user-agent': 'curl/8',
      authorization: 'Bearer t',
      'x-trace': 'a, b',
    });
    // The map is there even when nothing matched, so the shape a guest
    // matches on is decided by config rather than by traffic.
    expect(state.none.headers).toEqual({});
    expect(state.tooLong).toContain('431');
    expect(state.tooMany).toContain('up to 8');
  });
});
