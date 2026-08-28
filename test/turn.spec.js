import { test, expect } from '@playwright/test';

// `crypto/turn_credential`, and the reason it is worth the SHA-1.
//
// The Lab was behind *both* hosts on this one. The C host has answered it
// since build11 (`dhost_crypto.c`) and DRT's crypto connector answers it
// too; the Lab answered five of the six crypto calls. That is a place a
// program written against either host could tell it apart, which is exactly
// what `doc/Host.md`'s acceptance test forbids.
//
// The vectors under the primitive are in `test/node/digest.test.mjs`, where
// they run in a millisecond. What is asserted here is the *scheme*: coturn's
// `use-auth-secret`, where the username is `<expiry>:<user>` and the
// password is standard base64 of HMAC-SHA1 over it under the shared secret.
// The decisive assertion is the one that recomputes the MAC the way the TURN
// server will, because that is the only party whose opinion counts.

async function open(page) {
  await page.goto('/test/kernel-page.html');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
}

test('unwired, it is denied by the name of the knob to turn', async ({ page }) => {
  await open(page);
  const answer = await page.evaluate(() => {
    const { connectors } = window.lab.buildConnectors({ crypto: { secret: 'k' } });
    return connectors.get('crypto')('crypto/turn_credential', { user: 'ada' });
  });
  // `denied`, not `error`: a call the deployment did not wire is the same
  // posture as every other refusal in this tree, and the sentence names
  // the config key rather than the symptom.
  expect(answer.status).toBe('denied');
  expect(answer.detail).toContain('config.connectors.crypto.turn');
});

test('the password is what a TURN server recomputes', async ({ page }) => {
  await open(page);
  const got = await page.evaluate(() => {
    const { connectors } = window.lab.buildConnectors({
      crypto: { secret: 'unused-here', turn: { secret: 'shared-with-coturn', ttl: 600 } },
    });
    const answer = connectors.get('crypto')('crypto/turn_credential', { user: 'ada' });
    const { hmacSha1, base64std, utf8 } = window.lab.crypto;
    return {
      answer,
      recomputed: base64std(hmacSha1(utf8('shared-with-coturn'), utf8(answer.value.username))),
      now: Math.floor(Date.now() / 1000),
    };
  });

  expect(got.answer.status).toBe('ok');
  const { username, password, expires } = got.answer.value;
  expect(username).toBe(`${expires}:ada`);
  expect(password).toBe(got.recomputed);
  // No uris configured, so the field is absent rather than empty -- the C
  // host writes a three-entry map in that case and a four-entry one
  // otherwise, and a guest can see the difference.
  expect('uris' in got.answer.value).toBe(false);
  expect(expires).toBeGreaterThan(got.now + 590);
  expect(expires).toBeLessThan(got.now + 610);
});

test('the raw secret is used, not a derived subkey', async ({ page }) => {
  await open(page);
  const differs = await page.evaluate(() => {
    const { hmacSha1, hmacSha256, base64std, utf8 } = window.lab.crypto;
    const { connectors } = window.lab.buildConnectors({
      crypto: { turn: { secret: 'S' } },
    });
    const answer = connectors.get('crypto')('crypto/turn_credential', { user: 'ada' });
    const raw = base64std(hmacSha1(utf8('S'), utf8(answer.value.username)));
    // Every other call signs under a subkey derived from the master, so
    // that a `crypto/hmac` grant cannot forge a JWT. This one cannot: a
    // derived key would produce a MAC coturn has no way to check, which is
    // the one exception `GUARANTEES.md` records.
    const derived = base64std(
      hmacSha1(hmacSha256(utf8('S'), utf8('diluvium/crypto/hmac/v1')), utf8(answer.value.username)),
    );
    return { matchesRaw: answer.value.password === raw, matchesDerived: answer.value.password === derived };
  });
  expect(differs.matchesRaw).toBe(true);
  expect(differs.matchesDerived).toBe(false);
});

test('the host owns the expiry, so a guest cannot outlive its grant', async ({ page }) => {
  await open(page);
  const got = await page.evaluate(() => {
    const { connectors } = window.lab.buildConnectors({
      crypto: { turn: { secret: 's', ttl: 60 } },
    });
    const fn = connectors.get('crypto');
    return {
      now: Math.floor(Date.now() / 1000),
      // Past the ten-year cap the C host enforces: falls back to the
      // configured default rather than being honoured.
      huge: fn('crypto/turn_credential', { user: 'ada', ttl: 999999999999 }).value.expires,
      zero: fn('crypto/turn_credential', { user: 'ada', ttl: 0 }).value.expires,
      // Inside the bounds, the ttl is the guest's to choose. The expiry
      // never is: it is in the username in cleartext, and a guest that
      // picked it would be one field away from a permanent credential.
      fine: fn('crypto/turn_credential', { user: 'ada', ttl: 120 }).value.expires,
    };
  });
  expect(got.huge).toBeLessThan(got.now + 70);
  expect(got.zero).toBeLessThan(got.now + 70);
  expect(got.fine).toBeGreaterThan(got.now + 110);
});

test('the user is bounded, and configured uris ride along', async ({ page }) => {
  await open(page);
  const got = await page.evaluate(() => {
    const { connectors } = window.lab.buildConnectors({
      crypto: { turn: { secret: 's', uris: ['turn:turn.example.org:3478?transport=udp'] } },
    });
    const fn = connectors.get('crypto');
    return {
      empty: fn('crypto/turn_credential', { user: '' }),
      long: fn('crypto/turn_credential', { user: 'x'.repeat(257) }),
      notAString: fn('crypto/turn_credential', { user: 42 }),
      good: fn('crypto/turn_credential', { user: 'ada' }),
    };
  });
  expect(got.empty.status).toBe('error');
  expect(got.long.status).toBe('error');
  expect(got.notAString.detail).toContain('must be a string');
  // With uris the reply is a complete ICE server entry, so no program has
  // to hard-code where coturn lives.
  expect(got.good.value.uris).toEqual(['turn:turn.example.org:3478?transport=udp']);
});

test('the time connector answers monotonic too, in the same unit', async ({ page }) => {
  await open(page);
  const got = await page.evaluate(async () => {
    const { connectors } = window.lab.buildConnectors({ time: true });
    const fn = connectors.get('time');
    const first = fn('time/monotonic');
    await new Promise((r) => setTimeout(r, 25));
    return {
      wall: fn('time'),
      first,
      second: fn('time/monotonic'),
      bad: fn('time/zone'),
    };
  });

  // Both hosts answer this; the Lab did not, which was the gap.
  expect(got.first.status).toBe('ok');
  expect(got.second.value).toBeGreaterThanOrEqual(got.first.value);
  // Milliseconds on this page's own epoch -- so it is small, where `time`
  // is a wall clock since 1970. Two clocks in one connector answering in
  // different units would be a bug factory; answering in the same unit
  // from different epochs is the point.
  expect(got.first.value).toBeLessThan(60_000);
  expect(got.wall.value).toBeGreaterThan(1_700_000_000_000);
  // The refusal sentence is the C host's, word for word.
  expect(got.bad.detail).toContain("answers 'time' and 'time/monotonic'");
});
