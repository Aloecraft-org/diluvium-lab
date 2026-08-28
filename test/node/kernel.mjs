// Boot the real kernel under Node, with the Lab's own modules.
//
// Nothing is shimmed and nothing is mocked: `createWasi` is the same WASI
// shim the page uses, the module is the same vendored artifact, and
// `WebAssembly` is Node's. The bridge turns out to need only
// `TextEncoder`, `TextDecoder` and `WebAssembly`, and the WASI shim only
// `performance` -- so the browser tier's JS half runs here unaltered.
//
// ## Why a second runner exists at all
//
// Two reasons, and neither is "Playwright is bad" -- the notebook's tests
// drive the real page and always will.
//
//   * **Speed.** A bridge assertion through Playwright costs a page load;
//     under Node it costs a module import. The DRT session made this exact
//     trade for the same surface (a mock bridge driving a real `Swarm`
//     under `cargo test`) and called it the load-bearing decision.
//   * **A second environment for one contract.** `doc/Host.md`'s
//     acceptance test is that a guest cannot tell two hosts apart. The Lab
//     could only ever demonstrate that against one host in one
//     environment; this is a second, and `drt-web` is aimed at a server
//     tier as well as a page, so the bridge having no accidental browser
//     dependency is a property worth holding on purpose.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createWasi } from '../../src/kernel/wasi.js';

const KERNEL = fileURLToPath(
  new URL('../../vendor/libdiluvium_wasi.wasm', import.meta.url),
);

/** Compiled once: the module is 1.1 MB and every test would pay for it. */
let compiled = null;

/**
 * A fresh instance of the kernel, with WASI wired and libc started.
 *
 * A fresh *instance* per caller rather than a shared one, because
 * `dv_` instances live in the module's linear memory and a test that
 * leaked one would otherwise be visible to the next.
 *
 * @returns {Promise<{exports: object, drain: () => object}>}
 */
export async function bootKernel() {
  compiled ??= await WebAssembly.compile(await readFile(KERNEL));
  const wasi = createWasi();
  const instance = new WebAssembly.Instance(compiled, {
    wasi_snapshot_preview1: wasi.exports,
  });
  wasi.bind(instance.exports.memory);
  // The order the page uses, and for the page's reason: it is the
  // documented contract and it is idempotent.
  instance.exports.__wasm_call_ctors?.();
  instance.exports.init_lua?.();
  return { exports: instance.exports, drain: () => wasi.drain() };
}
