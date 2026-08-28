// SHA-1 and HMAC-SHA1, against published vectors.
//
// Under Node rather than in a page because these are pure computation with
// nothing browser-shaped about them, and the whole file runs in about a
// millisecond where a Playwright page load costs three hundred.
//
// The vectors matter more than usual here. `crypto/turn_credential` exists
// so a notebook can mint a credential a *coturn server* will accept, and
// coturn recomputes the MAC with its own SHA-1. A digest that agrees only
// with its own author would pass every test written against it and fail the
// only thing it is for. So: FIPS 180-4 / RFC 3174 for SHA-1, RFC 2202 for
// HMAC-SHA1.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sha1, hmacSha1, base64std, utf8Bytes, bytesToHex } from '../../src/kernel/sha256.js';

test('SHA-1 matches the RFC 3174 vectors', () => {
  const hex = (s) => bytesToHex(sha1(utf8Bytes(s)));
  assert.equal(hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(
    hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
  );
  // The million-a case, which is the one that exercises the length field
  // past 32 bits of bit-count and the multi-block loop.
  assert.equal(hex('a'.repeat(1000000)), '34aa973cd4c4daa4f61eeb2bdbad27316534016f');
});

test('HMAC-SHA1 matches the RFC 2202 cases', () => {
  const hex = (k, m) => bytesToHex(hmacSha1(k, m));

  // Case 1: a 20-byte key.
  assert.equal(
    hex(new Uint8Array(20).fill(0x0b), utf8Bytes('Hi There')),
    'b617318655057264e28bc0b6fb378c8ef146be00',
  );
  // Case 2: a key shorter than the block.
  assert.equal(
    hex(utf8Bytes('Jefe'), utf8Bytes('what do ya want for nothing?')),
    'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79',
  );
  // Case 3: a 20-byte key and 50 bytes of 0xdd.
  assert.equal(
    hex(new Uint8Array(20).fill(0xaa), new Uint8Array(50).fill(0xdd)),
    '125d7342b9ac11cd91a39af48aa17b4f63f175d3',
  );
  // Case 6: a key *longer* than the block, so it is hashed first. This is
  // the branch a naive implementation skips and the one coturn would hit
  // with a long shared secret.
  assert.equal(
    hex(new Uint8Array(80).fill(0xaa), utf8Bytes('Test Using Larger Than Block-Size Key - Hash Key First')),
    'aa4ae5e15272d00e95705637ce8a3b55ed402112',
  );
});

test('base64std is the padded standard alphabet, not base64url', () => {
  // The TURN password field is standard base64. A `-` or `_` there simply
  // does not authenticate, so the two encodings are not interchangeable
  // and this asserts the difference rather than assuming it.
  const bytes = new Uint8Array([0xfb, 0xff, 0xbe, 0x01, 0x02]);
  const std = base64std(bytes);
  assert.equal(std, '+/++AQI=');
  assert.ok(std.includes('+') && std.includes('/'), 'standard alphabet');
  assert.ok(std.endsWith('='), 'padded');
});
