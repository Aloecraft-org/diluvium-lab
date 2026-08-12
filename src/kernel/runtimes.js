// The runtime registry: what the version dropdown is made of.
//
// More valuable than a dropdown looks. Running one notebook against two
// builds is precisely what a language author wants, and no general-purpose
// notebook offers it.
//
// Four things have to happen between picking a version and running a cell,
// and the order matters: fetch, verify, probe, only then swap. A build that
// fails any of the first three must leave the running kernel exactly where
// it was -- switching versions should never be how you lose a session.

import { MirrorSource, ReleaseError, DEFAULT_MIRROR, KERNEL_ARTIFACT, compareVersions } from './releases.js';
import { DEFAULT_WASM_URL, checkModuleBytes } from './wasm-kernel.js';
import { WorkerKernel } from './worker-kernel.js';
import { canVerify } from './digest.js';
import { getRuntime, putRuntime } from '../notebook/storage.js';

/** The runtime that ships with the Lab. Always present, never fetched. */
export const PINNED = 'pinned';

export class RuntimeRegistry {
  /**
   * @param {object} options
   * @param {string} [options.mirrorUrl]
   * @param {string} [options.pinnedLabel] e.g. "5.4.7"
   * @param {Uint8Array} [options.bundledBytes] set in the baked single file
   */
  constructor(options = {}) {
    this.source = options.source ?? new MirrorSource(options.mirrorUrl ?? DEFAULT_MIRROR);
    this.pinnedLabel = options.pinnedLabel ?? 'pinned';
    this.pinnedIsPrerelease = options.pinnedIsPrerelease === true;
    this.bundledBytes = options.bundledBytes ?? null;
    this.wasmUrl = options.wasmUrl ?? DEFAULT_WASM_URL;
    this.remote = null;      // null until the user asks
    this.lastError = null;
  }

  /**
   * Can this page fetch other runtimes at all?
   *
   * The baked single file cannot, and should not pretend to: it has no
   * secure context, so it cannot verify a checksum, and downloading an
   * unverified binary to execute is not a trade worth making.
   */
  get canSwitch() {
    return canVerify() && !this.bundledBytes;
  }

  get unavailableReason() {
    if (this.bundledBytes) return 'This is the single-file build; it carries one runtime and fetches nothing.';
    if (!canVerify()) return 'Checksums need a secure context (https or localhost), so downloads are off here.';
    return null;
  }

  /** What the dropdown shows. Remote entries appear only after a check. */
  entries() {
    // The bundled build's own stability comes from vendor/pinned.js, which
    // scripts/fetch-runtime.sh fills in from the same changelog.json that
    // decides what the mirror carries. A Lab bundling a prerelease should
    // say so in the one place a reader is already looking.
    const pinned = {
      id: PINNED,
      label: `${this.pinnedLabel} (bundled)`,
      tag: null,
      remote: false,
      prerelease: this.pinnedIsPrerelease,
    };
    if (!this.remote) return [pinned];
    return [pinned, ...this.remote
      // The mirror carries the pinned build too. Listing it twice invites
      // "why are there two 5.4.7s"; the bundled copy wins because it is
      // the one that works with no network.
      .filter((r) => (r.version ?? r.tag) !== this.pinnedLabel)
      // Newest first, and sorted here rather than trusting the index --
      // the order a mirror happens to write is not a promise, and the
      // comparator understands both the current `_buildN` tags and the
      // semver they are moving to, so this keeps working across that
      // change without anyone timing the two.
      .sort((a, b) => compareVersions(b.version ?? b.tag, a.version ?? a.tag))
      // `prerelease` was read off the index and then dropped here, so a
      // prerelease sat in the dropdown looking exactly like a release.
      // Upstream treats that flag as load-bearing -- CHANGELOG.yaml calls
      // its own `stable` field "the truth" and says GitHub's flag is
      // derived from it, and a build can be unstable for having a
      // *narrower supported configuration* rather than for being unfinished.
      // Somebody choosing a runtime deserves to be told which they picked.
      .map((r) => ({
        id: r.tag,
        label: r.version ?? r.tag,
        tag: r.tag,
        remote: true,
        prerelease: r.prerelease === true,
      }))];
  }

  /**
   * Ask the mirror what exists. Explicitly user-initiated: the page makes
   * no request at load, which is a hard constraint and not an accident.
   */
  async check() {
    if (!this.canSwitch) throw new ReleaseError(this.unavailableReason);
    this.remote = await this.source.list();
    this.lastError = null;
    return this.entries();
  }

  /** Bytes for an id, from the cache when possible. */
  async bytesFor(id) {
    if (id === PINNED) {
      return this.bundledBytes ?? await fetchLocal(this.wasmUrl);
    }

    const key = `${id}/${KERNEL_ARTIFACT}`;
    const cached = await getRuntime(key).catch(() => null);
    if (cached?.bytes) {
      // Cached bytes were verified before they were stored, so this is not
      // a second chance to accept something bad -- it is a megabyte the
      // network does not have to move again.
      return { bytes: new Uint8Array(cached.bytes), fromCache: true };
    }

    // The index may already carry the artifact's sha256. Passing it lets
    // the source cross-check it against the release's own checksum files
    // rather than trusting whichever it happened to read.
    const indexChecksum = this.remote?.find((r) => r.tag === id)?.assets?.[KERNEL_ARTIFACT] ?? null;
    const bytes = await this.source.fetchKernel(id, { indexChecksum });
    await putRuntime(key, { bytes, tag: id, storedAt: Date.now() }).catch(() => {});
    return { bytes, fromCache: false };
  }

  /**
   * Produce a started kernel for `id`, or throw without disturbing anything.
   * The caller swaps only on success.
   */
  async load(id) {
    const { bytes, fromCache } = await this.bytesFor(id);

    const { problems } = checkModuleBytes(bytes);
    if (problems.length) {
      throw new ReleaseError(
        `${id === PINNED ? 'the bundled runtime' : id} is not a build this Lab can run:\n` +
        problems.map((p) => `  - ${p}`).join('\n'));
    }

    // The bytes were fetched, checksummed and probed on this thread --
    // crypto.subtle and IndexedDB live here and the worker has no business
    // with either. Only the verified module crosses over.
    const entry = this.entries().find((e) => e.id === id);
    const kernel = new WorkerKernel({
      moduleBytes: bytes,
      // No swarm on a switched-to runtime, and that is a refusal rather
      // than an omission. The bundled `diluvium_swarm_wasi.wasm` belongs to
      // the *pinned* tag; handing it to a kernel running some other build's
      // `libdiluvium_wasi.wasm` would put two different Diluviums in one
      // page and call the pair a runtime. Fetching the matching swarm
      // artifact per tag is the fix and is a checksummed download this
      // registry does not do yet -- see ROADMAP.
      swarmUrl: null,
      label: `On-page WASM (${entry?.label ?? id})`,
    });
    await kernel.start();
    return { kernel, fromCache };
  }
}

/** The bundled runtime, fetched from our own origin -- no CORS, no checksum. */
async function fetchLocal(url) {
  const response = await fetch(url);
  if (!response.ok) throw new ReleaseError(`could not load the bundled runtime: ${response.status}`);
  return { bytes: new Uint8Array(await response.arrayBuffer()), fromCache: false };
}
