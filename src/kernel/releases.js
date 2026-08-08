// Where runtimes come from.
//
// A note on why this is a mirror and not the GitHub Releases API.
//
// GitHub serves release assets from release-assets.githubusercontent.com
// with **no `Access-Control-Allow-Origin` header at all** -- measured, not
// assumed. A browser therefore cannot read those bytes from another origin,
// whatever the API says about them. So the roadmap's "optionally mirror
// artifacts" is not optional: it is the only way the Lab can download a
// runtime in a page. `scripts/fetch-runtime.sh` still pulls from GitHub
// because curl is not a browser and has no origin to violate.
//
// A mirror is also strictly better on two counts the CORS problem hides:
// it sidesteps the 60-requests-per-hour unauthenticated API limit, and it
// can carry builds that never got a GitHub release asset -- which today is
// most of them, since only v5.4.7_release publishes one.

import { sha256Hex } from './digest.js';

/**
 * Where the Lab looks for runtimes it did not ship with.
 *
 * `/release/`, singular — that is the path the mirror actually serves.
 */
export const DEFAULT_MIRROR = 'https://diluvium.aloecraft.org/release/';

/** The artifact the Lab runs. Never the command module, never luac. */
export const KERNEL_ARTIFACT = 'libdiluvium_wasi.wasm';

export class ReleaseError extends Error {}

/**
 * A place runtimes can be listed and fetched from.
 *
 * Same shape of decision as the kernel interface: one implementation today
 * (a static mirror), but a hosted index, a local directory or a future
 * CORS-enabled GitHub would all be instances rather than rewrites.
 */
export class ReleaseSource {
  /** @returns {Promise<Array<{tag: string, version: string, published?: string}>>} */
  async list() { throw new Error('not implemented'); }

  /** @returns {Promise<Uint8Array>} the verified kernel for `tag` */
  async fetchKernel(tag) { throw new Error('not implemented'); }
}

/**
 * A static mirror. Everything it needs is plain files behind CORS:
 *
 *   <base>/index.json
 *   <base>/<tag>/libdiluvium_wasi.wasm
 *   <base>/<tag>/SHA256SUMS.txt      (or BUILDINFO.txt -- see below)
 *
 * index.json is `{ "schema": 1, "releases": [ { "tag", "version",
 * "published" } ] }`. Nothing else is required of the host: no API, no
 * redirects, no auth. See README for the full contract.
 *
 * The checksum can come from either `SHA256SUMS.txt` or `BUILDINFO.txt`,
 * because the release job publishes both and BUILDINFO.txt embeds the same
 * `<sha256>  <filename>` lines under an `Artifacts` heading. Accepting
 * both means a mirror that carries only the build manifest still works,
 * and it costs one extra request only when the first file is absent.
 */
export class MirrorSource extends ReleaseSource {
  constructor(baseUrl = DEFAULT_MIRROR) {
    super();
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  }

  url(path) { return new URL(path, this.baseUrl).href; }

  async _get(path, kind) {
    let response;
    try {
      response = await fetch(this.url(path));
    } catch (cause) {
      // A CORS rejection and an offline network are the same TypeError
      // here, so say both rather than guessing which one it was.
      throw new ReleaseError(
        `could not reach the runtime mirror at ${this.baseUrl} -- it may be ` +
        `offline, or it may not be sending CORS headers (${cause.message})`,
        { cause });
    }
    if (!response.ok) {
      throw new ReleaseError(`${kind} is not on the mirror: ${response.status} ${response.statusText}`);
    }
    return response;
  }

  /** Like `_get`, but a missing file is `null` rather than a throw. */
  async _getOptional(path) {
    try {
      return await this._get(path, path);
    } catch (error) {
      if (error instanceof ReleaseError && /is not on the mirror/.test(error.message)) return null;
      throw error;                            // unreachable host, CORS: still fatal
    }
  }

  async list() {
    const index = await (await this._get('index.json', 'the release index')).json();
    if (!Array.isArray(index?.releases)) {
      throw new ReleaseError('the mirror index is not in the expected shape (no `releases` array)');
    }
    return index.releases
      .filter((r) => typeof r.tag === 'string')
      .map((r) => ({
        tag: r.tag,
        version: r.version ?? r.tag,
        published: r.published ?? null,
        notes: r.notes ?? null,
      }));
  }

  /**
   * The kernel's expected checksum for `tag`, or null.
   *
   * SHA256SUMS.txt first, because it is the file `scripts/fetch-runtime.sh`
   * checks, so the browser path and the shell path agree on what "correct"
   * means. BUILDINFO.txt carries the identical lines and is the fallback.
   */
  async checksumFor(tag) {
    const dir = encodeURIComponent(tag);
    for (const file of ['SHA256SUMS.txt', 'BUILDINFO.txt']) {
      const response = await this._getOptional(`${dir}/${file}`);
      if (!response) continue;
      const found = parseChecksums(await response.text()).get(KERNEL_ARTIFACT);
      if (found) return found;
    }
    return null;
  }

  /**
   * Download and verify. The Lab fetches a binary and then executes it, so
   * the checksum is not a nicety.
   */
  async fetchKernel(tag) {
    const expected = await this.checksumFor(tag);
    if (!expected) {
      throw new ReleaseError(
        `${tag} publishes no checksum for ${KERNEL_ARTIFACT}. Looked for `
        + `SHA256SUMS.txt and BUILDINFO.txt under ${this.url(`${encodeURIComponent(tag)}/`)}. `
        + 'A runtime that cannot be verified is not loaded.');
    }

    const response = await this._get(`${encodeURIComponent(tag)}/${KERNEL_ARTIFACT}`, KERNEL_ARTIFACT);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = await sha256Hex(bytes);
    if (actual !== expected) {
      throw new ReleaseError(
        `${tag} failed its checksum and was not loaded.\n` +
        `  expected ${expected}\n  actual   ${actual}`);
    }
    return bytes;
  }
}

/**
 * `<hex>  <filename>` per line, the format sha256sum writes.
 *
 * Also parses BUILDINFO.txt, without needing to know it is doing so: the
 * manifest's prose header has no line matching this shape, and its
 * `Artifacts` section is exactly sha256sum output.
 */
export function parseChecksums(text) {
  const sums = new Map();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}
