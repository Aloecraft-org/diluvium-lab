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

import { MirrorSource, ReleaseError, DEFAULT_MIRROR, KERNEL_ARTIFACT } from './releases.js';
import { WasmKernel, DEFAULT_WASM_URL, checkModuleBytes } from './wasm-kernel.js';
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
    const pinned = { id: PINNED, label: `${this.pinnedLabel} (bundled)`, tag: null, remote: false };
    if (!this.remote) return [pinned];
    return [pinned, ...this.remote
      // The mirror carries the pinned build too. Listing it twice invites
      // "why are there two 5.4.7s"; the bundled copy wins because it is
      // the one that works with no network.
      .filter((r) => (r.version ?? r.tag) !== this.pinnedLabel)
      .map((r) => ({ id: r.tag, label: r.version ?? r.tag, tag: r.tag, remote: true }))];
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

    const bytes = await this.source.fetchKernel(id);
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

    const entry = this.entries().find((e) => e.id === id);
    const kernel = new WasmKernel({
      moduleBytes: bytes,
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
