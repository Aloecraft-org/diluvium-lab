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

  test('the retired rng connector is refused with its replacement named', async ({ page }) => {
    await open(page);
    const error = await page.evaluate(() => {
      try { window.lab.buildConnectors({ rng: true }); return null; }
      catch (err) { return err.message; }
    });
    // A stored config naming `rng` wants the replacement, not "unknown
    // connector 'rng'". `crypto/random` is the spelling `src/dhostlib.h`
    // binds and the C host answers, so it is the one that travels.
    expect(error).toContain('retired');
    expect(error).toContain('crypto/random');
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

  // build10's other half of the same idea. The rules are the request
  // side's mirrored, with one deliberate asymmetry: this direction drops
  // where that one refuses, because the party a bad header endangers here
  // is the client rather than the guest, and a refused response would let
  // a guest turn its own bug into an outage.
  test('only allowlisted response headers survive a reply', async ({ page }) => {
    await open(page);
    const state = await page.evaluate(() => {
      const { listener } = window.lab.buildConnectors({
        listen: { port: 3, response_headers: ['Location', 'x-thing'] },
      });
      const bare = window.lab.buildConnectors({ listen: { port: 4 } }).listener;

      const answer = (l, headers) => {
        const { conn } = l.request({ path: '/x' });
        return l.reply({ conn, status: 200, body: 'ok', content_type: 'text/plain', headers });
      };

      const good = answer(listener, {
        Location: '/next',                  // guest's case, allowlist's spelling out
        'x-thing': 'v1',
        'x-evil': 'nope',                   // not allowlisted
      });
      const injected = answer(listener, { location: '/a\r\nEvil-Injected: 1' });
      const huge = answer(listener, { location: 'z'.repeat(5000) });
      const none = answer(listener, {});
      const absent = answer(listener, undefined);
      const unwired = answer(bare, { location: '/nope' });

      let owned = null;
      try {
        window.lab.buildConnectors({
          listen: { response_headers: ['location', 'content-length'] },
        });
      } catch (err) { owned = err.message; }

      let tooMany = null;
      try {
        window.lab.buildConnectors({ listen: { response_headers: Array(9).fill('x') } });
      } catch (err) { tooMany = err.message; }

      return {
        good: good.headers,
        injected: injected.headers,
        huge: huge.headers,
        none: none.headers,
        absent: absent.headers,
        unwired: unwired.headers,
        allowlist: listener.responseHeaders,
        owned,
        tooMany,
      };
    });
    // The allowlist decides the spelling, so guest bytes never name a
    // header, and a name it does not list never appears.
    expect(state.allowlist).toEqual(['location', 'x-thing']);
    expect(state.good).toEqual({ location: '/next', 'x-thing': 'v1' });
    // A CRLF drops that header WHOLE -- not truncated, not sanitised --
    // and the response still answers.
    expect(state.injected).toEqual({});
    expect(state.huge).toEqual({});
    // Present-and-empty when the deployment allowlists anything, absent
    // when it does not: the shape is config's decision, both directions.
    expect(state.none).toEqual({});
    expect(state.absent).toEqual({});
    expect(state.unwired).toBeUndefined();
    // A name the framing owns is a config error, where it is still a typo.
    expect(state.owned).toContain('content-length');
    expect(state.tooMany).toContain('up to 8');
  });

  // The outbound connector. Its refusals matter more than its successes:
  // this is the only connector that reaches the network on the *guest's*
  // initiative, so every path that should not leave the page is asserted
  // here, with a stub fetch so the assertions are about the connector
  // rather than about somebody's uptime.
  test('the rest connector refuses everything outside its grant', async ({ page }) => {
    await open(page);
    const state = await page.evaluate(async () => {
      const calls = [];
      const stub = async (url, init) => {
        calls.push({ url, method: init.method, headers: init.headers });
        return new Response('hi', {
          status: 201,
          headers: { 'content-type': 'text/plain', 'x-rate': '9' },
        });
      };
      const wired = (spec) => window.lab.buildConnectors(
        { rest: spec }, { fetch: stub },
      ).connectors.get('rest');

      const granted = wired({ allow: ['https://api.example.com/v1/'] });
      const ungranted = wired({});

      const settle = async (answer) => (answer.status === 'pending'
        ? answer.promise : answer);

      const good = await settle(granted('rest/get',
        { url: 'https://api.example.com/v1/thing', headers: { 'X-Tok': 'abc' } }));

      return {
        // the happy path, so the shape is pinned
        good: {
          status: good.status,
          value: good.value && {
            status: good.value.status,
            content_type: good.value.content_type,
            headers: good.value.headers,
            body: new TextDecoder().decode(good.value.body),
          },
        },
        deferred: granted('rest/get', { url: 'https://api.example.com/v1/x' }).status,
        offAllowlist: (await settle(granted('rest/get',
          { url: 'https://elsewhere.example/v1/x' }))),
        noAllowlist: (await settle(ungranted('rest/get',
          { url: 'https://api.example.com/v1/x' }))),
        badScheme: (await settle(granted('rest/get', { url: 'file:///etc/passwd' }))),
        credsInUrl: (await settle(granted('rest/get',
          { url: 'https://u:p@api.example.com/v1/x' }))),
        injected: (await settle(granted('rest/get',
          { url: 'https://api.example.com/v1/x', headers: { 'X-Bad': 'a\r\nEvil: 1' } }))),
        unknownCall: (await settle(granted('rest/delete', { url: 'https://api.example.com/v1/x' }))),
        sent: calls,
      };
    });

    // The answer is deferred -- the swarm takes the call and keeps going.
    expect(state.deferred).toBe('pending');
    // The result shape is the plugin's, header map included.
    expect(state.good.status).toBe('ok');
    expect(state.good.value.status).toBe(201);
    expect(state.good.value.content_type).toContain('text/plain');
    expect(state.good.value.headers['x-rate']).toBe('9');
    expect(state.good.value.body).toBe('hi');

    // Everything that must not leave the page.
    expect(state.offAllowlist.status).toBe('denied');
    expect(state.offAllowlist.detail).toContain('allowlist');
    expect(state.noAllowlist.status).toBe('denied');
    expect(state.noAllowlist.detail).toContain('reaches nothing');
    expect(state.badScheme.detail).toContain('http://');
    expect(state.credsInUrl.detail).toContain('Authorization header instead');
    expect(state.injected.detail).toContain('refused rather than stripped');
    expect(state.unknownCall.detail).toContain("'rest/delete' is neither");

    // The property that matters: nothing outside the grant ever reached
    // fetch. Only the two granted calls did (the happy path and the one
    // that checked deferral), and the guest's header rode along.
    expect(state.sent.every((c) => c.url.startsWith('https://api.example.com/v1/'))).toBe(true);
    expect(state.sent[0].url).toBe('https://api.example.com/v1/thing');
    expect(state.sent[0].headers['X-Tok']).toBe('abc');
  });
});
