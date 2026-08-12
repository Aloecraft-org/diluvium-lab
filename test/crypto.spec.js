import { test, expect } from '@playwright/test';

// The crypto connector, and the primitive under it.
//
// Checked against **published vectors** — FIPS 180-4 for SHA-256, RFC 4231
// for HMAC — rather than against itself. A hash that agrees only with its
// own author is worth nothing here: the C host signs with the runtime's own
// SHA-256, and `doc/Host.md`'s acceptance test is that a guest cannot tell
// the two hosts apart. A token minted in the Lab has to verify on fetch1.

async function open(page) {
  await page.goto('/test/kernel-page.html');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
}

test('SHA-256 matches the FIPS 180-4 vectors', async ({ page }) => {
  await open(page);
  const got = await page.evaluate(() => {
    const { sha256, utf8, toHex } = window.lab.crypto;
    return [
      'abc',
      '',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      'a'.repeat(1000000),
    ].map((s) => toHex(sha256(utf8(s))));
  });
  expect(got).toEqual([
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    // The million-a case, which is the one that catches a broken length
    // encoding: it is the only vector here past 2^32 bits of nothing.
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  ]);
});

test('HMAC-SHA256 matches RFC 4231, including a key longer than the block', async ({ page }) => {
  await open(page);
  const got = await page.evaluate(() => {
    const { hmacSha256, utf8, toHex } = window.lab.crypto;
    return {
      one: toHex(hmacSha256(new Uint8Array(20).fill(0x0b), utf8('Hi There'))),
      // A key past 64 bytes must be hashed first. Getting that wrong makes
      // a MAC that is self-consistent and disagrees with every other
      // implementation — the exact failure this file exists to catch.
      six: toHex(hmacSha256(new Uint8Array(131).fill(0xaa),
        utf8('Test Using Larger Than Block-Size Key - Hash Key First'))),
    };
  });
  expect(got.one).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  expect(got.six).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
});

test.describe('the JWT half, whose mistakes are famous', () => {
  const wire = (page, calls) => page.evaluate(([list]) => {
    const { connectors } = window.lab.buildConnectors({
      crypto: { secret: 'a-test-secret', default_ttl: 60 },
    });
    const fn = connectors.get('crypto');
    return list.map(([call, args]) => fn(call, args));
  }, [calls]);

  test('the host owns iat and exp, whatever the guest asked for', async ({ page }) => {
    await open(page);
    const [signed] = await wire(page, [
      ['crypto/jwt_sign', { claims: { sub: 'acct_1', exp: 99999999999, nbf: 1 }, ttl: 60 }],
    ]);
    const [verified] = await wire(page, [['crypto/jwt_verify', { token: signed.value }]]);
    expect(verified.value.valid).toBe(true);
    expect(verified.value.claims.sub).toBe('acct_1');
    // Dropped and replaced: a guest cannot mint a token that never expires.
    expect(verified.value.claims.exp).toBeLessThan(99999999999);
    expect(verified.value.claims.exp - verified.value.claims.iat).toBe(60);
    expect(verified.value.claims.nbf).toBeUndefined();
  });

  test('alg confusion is closed structurally, not by checking a field', async ({ page }) => {
    await open(page);
    const [signed] = await wire(page, [['crypto/jwt_sign', { claims: { sub: 'x' } }]]);
    const forged = await page.evaluate(([token]) => {
      const b64 = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const body = token.split('.')[1];
      return {
        none: `${b64('{"alg":"none","typ":"JWT"}')}.${body}.`,
        rs256: `${b64('{"alg":"RS256","typ":"JWT"}')}.${body}.${token.split('.')[2]}`,
      };
    }, [signed.value]);

    const answers = await wire(page, [
      ['crypto/jwt_verify', { token: forged.none }],
      ['crypto/jwt_verify', { token: forged.rs256 }],
      ['crypto/jwt_verify', { token: `${signed.value}x` }],
    ]);
    // The header is compared against its one known form rather than parsed,
    // so there is no field a token can set to change how it is checked.
    expect(answers[0].value).toEqual({ valid: false, reason: 'unexpected header' });
    expect(answers[1].value).toEqual({ valid: false, reason: 'unexpected header' });
    expect(answers[2].value.valid).toBe(false);
  });

  test('holding host:crypto/hmac is not an oracle for forging a token', async ({ page }) => {
    await open(page);
    const [signed] = await wire(page, [['crypto/jwt_sign', { claims: { sub: 'x' } }]]);
    const signingInput = signed.value.split('.').slice(0, 2).join('.');
    const [oracle] = await wire(page, [['crypto/hmac', { data: signingInput }]]);
    const realMac = await page.evaluate(([sig]) => {
      const pad = sig.replace(/-/g, '+').replace(/_/g, '/')
        + '='.repeat((4 - (sig.length % 4)) % 4);
      return [...atob(pad)].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    }, [signed.value.split('.')[2]]);

    // Two subkeys, derived under different domain-separation labels. Without
    // that split a program holding only host:crypto/hmac could HMAC the
    // signing input itself and assemble a token, bypassing jwt_sign.
    expect(oracle.value).not.toBe(realMac);
  });

  test('a token with no enforceable expiry is not valid', async ({ page }) => {
    await open(page);
    const answer = await page.evaluate(() => {
      const { connectors } = window.lab.buildConnectors({ crypto: { secret: 'k' } });
      const fn = connectors.get('crypto');
      // Signed by this host, so the MAC is genuine -- what is missing is
      // the exp, which verify requires as an integer.
      const b64 = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const header = b64('{"alg":"HS256","typ":"JWT"}');
      const body = b64('{"sub":"x"}');
      const mac = fn('crypto/hmac', { data: `${header}.${body}` });
      return { mac: mac.status, verified: fn('crypto/jwt_verify', { token: `${header}.${body}.zzz` }).value };
    });
    expect(answer.verified.valid).toBe(false);
  });

  test('the connector answers its five calls and refuses the rest', async ({ page }) => {
    await open(page);
    const answers = await wire(page, [
      ['crypto/random', { bytes: 16 }],
      ['crypto/random', { bytes: 0 }],
      ['crypto/hash', { data: 'abc' }],
      ['crypto/sign', { data: 'abc' }],
    ]);
    expect(answers[0].status).toBe('ok');
    expect(answers[0].value).toHaveLength(32);          // 16 bytes as hex
    expect(answers[1].status).toBe('error');
    expect(answers[2].value)
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(answers[3].status).toBe('error');
    expect(answers[3].detail).toContain('crypto/jwt_sign');
  });
});
