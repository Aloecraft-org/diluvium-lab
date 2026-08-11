// The kernel, running off the main thread.
//
// This is the other half of `worker-kernel.js`. It owns a real `WasmKernel`
// and does nothing clever: it forwards method calls and republishes the
// kernel's messages. All the interesting behaviour stays in WasmKernel,
// which is what makes "in the page" and "in a worker" the same kernel
// rather than two implementations that drift.
//
// Why a worker at all: `run_lua` is a synchronous WASM call and nothing
// can preempt it. On the main thread `while true do end` freezes the tab
// with no way out but closing it. In a worker the same loop freezes only
// the worker, and `worker.terminate()` is a real, immediate stop. That is
// the only interrupt this kernel can honestly offer, and it costs the Lua
// state -- see the note on interrupt in worker-kernel.js.
//
// Everything crossing the boundary is structured-cloneable: strings,
// plain objects from protocol.js, and Uint8Array. No functions, no class
// instances. `execute`'s `onMessage` callback cannot cross, so the worker
// republishes those messages as `stream` envelopes tagged with the call
// id and the main-thread proxy reassembles the callback from them.

import { WasmKernel } from './wasm-kernel.js';

/** @type {WasmKernel|null} */
let kernel = null;

const post = (message) => self.postMessage(message);

/**
 * An error, flattened to something postMessage can carry.
 *
 * DOMException and friends do clone, but a plain Error's `message` is the
 * only part the UI ever shows, and rebuilding one on the far side keeps
 * the proxy from having to care what kind of error it was.
 */
const flatten = (err) => ({
  message: err?.message ?? String(err),
  name: err?.name ?? 'Error',
  stack: err?.stack ?? null,
});

self.onmessage = async (event) => {
  const { id, type, method, args } = event.data ?? {};

  if (type === 'init') {
    try {
      kernel = new WasmKernel({
        moduleBytes: args.moduleBytes,
        wasmUrl: args.wasmUrl,
        label: args.label,
      });
      // Status changes are the one thing that arrives unprompted, so they
      // are republished rather than returned. The proxy feeds them to its
      // own listeners, which is how the UI's status indicator keeps
      // working across the boundary.
      kernel.onMessage((message) => post({ type: 'publish', message }));
      await kernel.start();
      post({ id, type: 'ready', capabilities: kernel.capabilities, label: kernel.label });
    } catch (err) {
      post({ id, type: 'failed', error: flatten(err) });
    }
    return;
  }

  if (type !== 'call') return;

  if (!kernel) {
    post({ id, type: 'error', error: flatten(new Error('the worker has no kernel yet')) });
    return;
  }

  try {
    let value;
    if (method === 'execute' || method === 'callWidget') {
      // The two methods with a streaming half. Each message goes back
      // tagged with this call's id, so concurrent calls -- which should
      // not happen, but would otherwise interleave silently -- cannot be
      // mistaken for one another.
      const relay = (message) => post({ id, type: 'stream', message });
      value = method === 'execute'
        ? await kernel.execute(args.code, relay)
        : await kernel.callWidget(args.id, args.value, relay);
    } else if (typeof kernel[method] === 'function') {
      value = await kernel[method](...(args ?? []));
    } else {
      throw new Error(`the kernel has no method ${method}`);
    }
    post({ id, type: 'result', value, status: kernel.status, executionCount: kernel.executionCount });
  } catch (err) {
    post({ id, type: 'error', error: flatten(err), status: kernel.status });
  }
};
