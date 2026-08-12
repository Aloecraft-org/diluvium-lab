// SHA-256 and HMAC-SHA256, synchronously.
//
// **Why this is here rather than `crypto.subtle`.** The Web Crypto digest
// and sign calls return promises, and every connector in this Lab has to be
// synchronous: a cell reaching the host does it from inside `run_lua`,
// which is one blocking WASM call with no event loop to return to. An async
// primitive anywhere in that path would poison the whole channel. So the
// trade is a ~120-line vendored implementation against a capability the
// page cannot use, and it is the same trade the msgpack codec made.
//
// It is also, unlike `crypto.subtle`, available on a `file://` page — which
// is where the baked single-file build runs, and where `crypto.subtle` is
// absent entirely because that is not a secure context.
//
// The algorithm is FIPS 180-4 §6.2 and RFC 2104, both short and both fully
// specified. `test/crypto.spec.js` checks it against the published NIST
// vectors and against RFC 4231's HMAC cases rather than against itself,
// because a hash that agrees only with its own author is worth nothing:
// the C host signs with the runtime's own SHA-256, and a token minted here
// has to verify there.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const BLOCK = 64;
const DIGEST = 32;

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** @param {Uint8Array} bytes @returns {Uint8Array} 32 bytes */
export function sha256(bytes) {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  // The padded message: the data, a 0x80 byte, zeroes, and the bit length
  // as a big-endian 64-bit integer. The length is written as two 32-bit
  // halves because a JS number cannot hold 2^64 and BigInt here would cost
  // more than the two lines it saves.
  const bitLenHi = Math.floor((bytes.length / 0x20000000));
  const bitLenLo = (bytes.length << 3) >>> 0;
  const padded = new Uint8Array(((bytes.length + 9 + BLOCK - 1) / BLOCK | 0) * BLOCK);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLenHi, false);
  view.setUint32(padded.length - 4, bitLenLo, false);

  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += BLOCK) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(DIGEST);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i], false);
  return out;
}

/** RFC 2104. @returns {Uint8Array} 32 bytes */
export function hmacSha256(key, message) {
  // A key longer than the block is hashed first; a shorter one is padded
  // with zeroes. Both are the spec, and getting the first wrong produces a
  // MAC that is self-consistent and disagrees with everyone else.
  let k = key.length > BLOCK ? sha256(key) : key;
  const block = new Uint8Array(BLOCK);
  block.set(k);
  const ipad = new Uint8Array(BLOCK);
  const opad = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    ipad[i] = block[i] ^ 0x36;
    opad[i] = block[i] ^ 0x5c;
  }
  const inner = sha256(concat(ipad, message));
  return sha256(concat(opad, inner));
}

export function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export const utf8Bytes = (text) => new TextEncoder().encode(text);

export const bytesToHex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** base64url, unpadded: JWT's encoding, RFC 7515 §2. */
export function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Constant-time equality for two byte strings.
 *
 * A MAC compared with `===` on a hex string leaks its prefix through
 * timing. That matters less in a browser prototype than it does on
 * fetch1, and it is two lines, and the point of matching the C host's
 * semantics is that a habit formed here is the habit that ships.
 */
export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
