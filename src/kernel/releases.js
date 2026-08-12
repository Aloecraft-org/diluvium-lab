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

/**
 * The swarm build, when a release has one.
 *
 * Fetched beside the kernel and from the *same tag*, which is the whole
 * point: pairing one build's swarm module with another build's kernel
 * would put two different Diluviums in one page and call the pair a
 * runtime. A tag that publishes no checksum for this simply has no swarm,
 * which is every release before v5.5.1_build5 and is a fact rather than a
 * failure.
 */
export const SWARM_ARTIFACT = 'diluvium_swarm_wasi.wasm';

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

  /** The swarm build, or null when this release has none. */
  async fetchSwarm(tag) { return null; }
}

/**
 * A static mirror. Everything it needs is plain files behind CORS:
 *
 *   <base>/releases.json
 *   <base>/<tag>/libdiluvium_wasi.wasm
 *   <base>/<tag>/SHA256SUMS.txt      (or BUILDINFO.txt -- see below)
 *
 * `releases.json` is the index the publishing job writes:
 *
 *   { "repo", "latest", "latest_prerelease", "generated_at",
 *     "releases": [ { "tag", "name", "published_at", "prerelease",
 *                     "assets": [ { "name", "size", "sha256" } ] } ] }
 *
 * `index.json` is accepted as an alias with `published` in place of
 * `published_at`, because that is what earlier versions of
 * `scripts/build-mirror.sh` wrote. Both normalise to the same thing.
 *
 * Nothing else is required of the host: no API, no redirects, no auth.
 * See README for the full contract.
 *
 * The checksum can come from three places, in descending order of
 * authority: `SHA256SUMS.txt`, `BUILDINFO.txt` (whose `Artifacts` section
 * is the same sha256sum output), and the index's own `assets[].sha256`.
 * The first two are what the release job publishes and what
 * `scripts/fetch-runtime.sh` checks, so they win; the index is a fallback
 * for a mirror that carries only a manifest. When more than one is
 * present they must agree, and a mirror that contradicts itself is
 * refused rather than resolved.
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
    const response = await this._getOptional('releases.json')
      ?? await this._get('index.json', 'the release index (releases.json or index.json)');
    const index = await response.json();
    if (!Array.isArray(index?.releases)) {
      throw new ReleaseError('the mirror index is not in the expected shape (no `releases` array)');
    }
    this.latest = typeof index.latest === 'string' ? index.latest : null;
    return index.releases
      .filter((r) => typeof r.tag === 'string')
      .map((r) => ({
        tag: r.tag,
        version: versionOf(r),
        published: r.published_at ?? r.published ?? null,
        prerelease: r.prerelease === true,
        // Kept so fetchKernel can cross-check the index against the
        // release's own checksum files rather than trusting either alone.
        assets: assetChecksums(r.assets),
        notes: r.notes ?? null,
      }));
  }

  /**
   * The kernel's expected checksum for `tag`, or null.
   *
   * SHA256SUMS.txt first, because it is the file `scripts/fetch-runtime.sh`
   * checks, so the browser path and the shell path agree on what "correct"
   * means. BUILDINFO.txt carries the identical lines. The index's own
   * `assets[].sha256` is last, and is also used to cross-check: two
   * sources that disagree mean a stale mirror, and guessing which half is
   * current is exactly the wrong instinct when the answer decides which
   * binary gets executed.
   *
   * @param {string} tag
   * @param {string|null} [fromIndex] the sha256 the index claimed
   */
  async checksumFor(tag, fromIndex = null, artifact = KERNEL_ARTIFACT) {
    const dir = encodeURIComponent(tag);
    const claims = new Map();
    if (fromIndex) claims.set('the release index', fromIndex.toLowerCase());

    for (const file of ['SHA256SUMS.txt', 'BUILDINFO.txt']) {
      const response = await this._getOptional(`${dir}/${file}`);
      if (!response) continue;
      const found = parseChecksums(await response.text()).get(artifact);
      if (found) claims.set(file, found);
    }
    if (claims.size === 0) return null;

    const distinct = new Set(claims.values());
    if (distinct.size > 1) {
      const detail = [...claims].map(([where, sum]) => `  ${sum}  (${where})`).join('\n');
      throw new ReleaseError(
        `${tag} publishes more than one checksum for ${artifact} and they disagree, `
        + `so the mirror is stale or damaged and nothing was loaded:\n${detail}`);
    }
    // Preference order is insertion order minus the index, which is only
    // authoritative when it is all there is.
    for (const file of ['SHA256SUMS.txt', 'BUILDINFO.txt']) {
      if (claims.has(file)) return claims.get(file);
    }
    return claims.get('the release index');
  }

  /**
   * Download and verify. The Lab fetches a binary and then executes it, so
   * the checksum is not a nicety.
   */
  async fetchKernel(tag, options = {}) {
    return this.fetchArtifact(tag, KERNEL_ARTIFACT, options);
  }

  /**
   * The swarm build for a tag, or `null` when it publishes none.
   *
   * Absence is answered rather than thrown, because "this release has no
   * swarm layer" is the ordinary state of every build before
   * v5.5.1_build5 and must not stop the kernel loading.
   */
  async fetchSwarm(tag, { indexChecksum = null } = {}) {
    const expected = await this.checksumFor(tag, indexChecksum, SWARM_ARTIFACT);
    if (!expected) return null;
    return this.fetchArtifact(tag, SWARM_ARTIFACT, { indexChecksum });
  }

  async fetchArtifact(tag, artifact = KERNEL_ARTIFACT, { indexChecksum = null } = {}) {
    const expected = await this.checksumFor(tag, indexChecksum, artifact);
    if (!expected) {
      throw new ReleaseError(
        `${tag} publishes no checksum for ${artifact}. Looked in the release index, `
        + `and for SHA256SUMS.txt and BUILDINFO.txt under ${this.url(`${encodeURIComponent(tag)}/`)}. `
        + 'A runtime that cannot be verified is not loaded.');
    }

    const response = await this._get(`${encodeURIComponent(tag)}/${artifact}`, artifact);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = await sha256Hex(bytes);
    if (actual !== expected) {
      throw new ReleaseError(
        `${tag}'s ${artifact} failed its checksum and was not loaded.\n` +
        `  expected ${expected}\n  actual   ${actual}`);
    }
    return bytes;
  }
}

/**
 * What to call a release in the dropdown.
 *
 * Layered so each step is a fact rather than a pattern, as far as it can
 * be. An explicit `version` wins. Otherwise the publishing job's `name`
 * ("Diluvium 5.5.1_build1") carries exactly what BUILDINFO.txt's
 * `version` field says, for both `v5.4.7_release` -> `5.4.7` and
 * `v5.5.1_build1` -> `5.5.1_build1`, which no rule applied to the tag
 * alone gets right. The tag is the last resort.
 */
export function versionOf(release) {
  if (typeof release.version === 'string' && release.version) return release.version;
  const named = /^\s*Diluvium\s+(\S+)\s*$/.exec(release.name ?? '');
  if (named) return named[1];
  return String(release.tag).replace(/^v/, '').replace(/_release$/, '');
}

/**
 * Take a version apart into something comparable.
 *
 * Two shapes have to work, and they have to work *together*, because a
 * mirror will carry both for as long as the old tags exist:
 *
 *   v5.4.7_release      the current scheme: `_release` is the final one
 *   v5.5.1_build1       ...and `_buildN` is an iteration on it
 *   v5.5.1-rc.2         semver, which is where this is going
 *   1.4.0+lua.5.5.1     semver with build metadata, ignored for ordering
 *
 * The Lab is deliberately the tolerant end of this. Making the consumer
 * accept the new format *before* anything emits one means the day the
 * release job changes, nothing here has to change with it and no tag has
 * to be renamed — renaming a published tag would break its checksums, the
 * mirror, `vendor/PINNED_TAG` and the committed bytecode fixtures all at
 * once.
 *
 * @returns {{core: number[], pre: Array<string|number>|null}} `pre` is
 *   null for a final release, which sorts *above* any pre-release of the
 *   same core version — that is semver's rule and also the intuitive one.
 */
export function parseVersion(raw) {
  const text = String(raw ?? '').trim().replace(/^v/i, '');
  // Build metadata never affects ordering. Semver is explicit about this
  // and it is the whole reason `1.4.0+lua.5.5.1` is a workable way to
  // record which Lua a Diluvium tracks.
  const [beforeMeta] = text.split('+');

  let core = beforeMeta;
  let pre = null;
  const hyphen = beforeMeta.indexOf('-');
  const underscore = beforeMeta.indexOf('_');

  if (hyphen !== -1) {
    core = beforeMeta.slice(0, hyphen);
    pre = beforeMeta.slice(hyphen + 1);
  } else if (underscore !== -1) {
    core = beforeMeta.slice(0, underscore);
    const legacy = beforeMeta.slice(underscore + 1);
    // `_release` marks the final build rather than a pre-release of it,
    // so `5.4.7_release` and `5.4.7` are the same version.
    pre = /^release$/i.test(legacy) ? null : legacy;
  }

  return {
    core: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
    pre: pre === null ? null : identifiers(pre),
  };
}

/**
 * Pre-release identifiers, dot-separated, numbers compared as numbers.
 *
 * `build1` is split into `['build', 1]` rather than left as one string,
 * which is what makes `build10` sort after `build2` instead of before it
 * — the trap in the current scheme, since string order puts `10` first.
 */
function identifiers(pre) {
  return pre.split('.').flatMap((part) => {
    const match = /^([A-Za-z-]*)(\d*)$/.exec(part);
    if (!match) return [part];
    const [, word, digits] = match;
    return [...(word ? [word] : []), ...(digits ? [Number.parseInt(digits, 10)] : [])];
  });
}

/** Newest first, for a dropdown. Returns <0, 0 or >0 like a comparator. */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);

  const depth = Math.max(va.core.length, vb.core.length);
  for (let i = 0; i < depth; i++) {
    const diff = (va.core[i] ?? 0) - (vb.core[i] ?? 0);
    if (diff !== 0) return diff;
  }

  if (va.pre === null && vb.pre === null) return 0;
  if (va.pre === null) return 1;              // a release outranks its pre-releases
  if (vb.pre === null) return -1;

  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined) return -1;           // fewer identifiers sorts lower
    if (y === undefined) return 1;
    if (x === y) continue;
    // Numeric identifiers always sort below alphanumeric ones, and
    // compare numerically among themselves.
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** `{ name: sha256 }` from an index's asset array, lowercased. */
function assetChecksums(assets) {
  const out = {};
  if (!Array.isArray(assets)) return out;
  for (const asset of assets) {
    if (typeof asset?.name === 'string' && /^[0-9a-f]{64}$/i.test(asset?.sha256 ?? '')) {
      out[asset.name] = asset.sha256.toLowerCase();
    }
  }
  return out;
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
