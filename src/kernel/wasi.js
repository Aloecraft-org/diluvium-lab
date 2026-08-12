// A wasi_snapshot_preview1 shim, only as much of one as the kernel asks for.
//
// Stage 0 read the import list off the binary rather than trusting any
// document: 45 imports, every one of them plain `wasi_snapshot_preview1`.
// This covers all 45. Everything the kernel does not need answers ENOSYS
// honestly instead of pretending to succeed -- a lying shim turns a missing
// capability into a mystery three layers up.

/** preview1 errno values used here. */
const E = { SUCCESS: 0, BADF: 8, NOSYS: 52, NOTSUP: 58 };

/**
 * Hard ceilings, to stop one runaway cell taking the tab with it.
 *
 * These are deliberately far above what anyone reads: the *display* cap
 * lives in the UI, which shows a few hundred lines behind a "show all".
 * That only works if the output still exists, so the shim retains far more
 * than it shows and truncates solely as a last line of defence.
 */
export const HARD_MAX_BYTES = 4 * 1024 * 1024;
export const HARD_MAX_LINES = 100_000;

export function createWasi() {
  let memory = null;
  const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
  let streams = fresh();

  function fresh() {
    return {
      1: { chunks: [], bytes: 0, lines: 0, truncated: false },
      2: { chunks: [], bytes: 0, lines: 0, truncated: false },
    };
  }

  const dv = () => new DataView(memory.buffer);
  // Re-derived on every use: run_lua can grow linear memory, which detaches
  // every view taken before the call. Stage 0 watched one cell take memory
  // from 128 KB to 16 MB mid-execution.
  const u8 = () => new Uint8Array(memory.buffer);

  function emit(fd, text) {
    const s = streams[fd];
    if (s.truncated) return;
    s.bytes += text.length;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) s.lines++;
    if (s.bytes > HARD_MAX_BYTES || s.lines > HARD_MAX_LINES) {
      s.truncated = true;
      s.chunks.push('\n[output truncated: the cell exceeded the kernel output ceiling]\n');
      return;
    }
    s.chunks.push(text);
  }

  const nosys = () => E.NOSYS;
  const notsup = () => E.NOTSUP;

  const exports = {
    // The only import that carries real data out of the kernel.
    fd_write(fd, iovs, iovsLen, nwrittenPtr) {
      if (fd !== 1 && fd !== 2) return E.BADF;
      const d = dv();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = d.getUint32(iovs + i * 8, true);
        const len = d.getUint32(iovs + i * 8 + 4, true);
        // `print` emits one fd_write per argument and per separator, so a
        // multi-byte character routinely straddles two calls. stream:true is
        // what stops those decoding to U+FFFD.
        emit(fd, decoders[fd].decode(u8().subarray(ptr, ptr + len), { stream: true }));
        total += len;
      }
      d.setUint32(nwrittenPtr, total, true);
      return E.SUCCESS;
    },

    // There is no stdin in a notebook. Report EOF rather than blocking --
    // run_lua is synchronous, so blocking would hang the tab outright.
    fd_read(fd, iovs, iovsLen, nreadPtr) {
      if (fd !== 0) return E.BADF;
      dv().setUint32(nreadPtr, 0, true);
      return E.SUCCESS;
    },

    fd_fdstat_get(fd, ptr) {
      if (fd > 2) return E.BADF;
      const d = dv();
      d.setUint8(ptr, 2);             // filetype: character_device
      d.setUint16(ptr + 2, 0, true);  // fdflags
      // Withhold fd_seek (bit 2) and fd_tell (bit 5). character_device plus
      // the absence of those two is exactly what wasi-libc's isatty() tests
      // for, and a tty keeps stdio line-buffered -- which is why output is
      // readable the moment run_lua returns, with no fflush anywhere.
      const rights = 0xffffffffn & ~((1n << 2n) | (1n << 5n));
      d.setBigUint64(ptr + 8, rights, true);
      d.setBigUint64(ptr + 16, rights, true);
      return E.SUCCESS;
    },

    fd_close: () => E.SUCCESS,
    fd_sync: () => E.SUCCESS,
    fd_datasync: () => E.SUCCESS,
    fd_fdstat_set_flags: () => E.SUCCESS,
    fd_fdstat_set_rights: () => E.SUCCESS,
    fd_seek: notsup,
    fd_tell: notsup,

    // No preopened directories: end libc's scan on the first probe.
    fd_prestat_get: () => E.BADF,
    fd_prestat_dir_name: () => E.BADF,

    args_sizes_get(c, s) { const d = dv(); d.setUint32(c, 0, true); d.setUint32(s, 0, true); return E.SUCCESS; },
    args_get: () => E.SUCCESS,
    environ_sizes_get(c, s) { const d = dv(); d.setUint32(c, 0, true); d.setUint32(s, 0, true); return E.SUCCESS; },
    environ_get: () => E.SUCCESS,

    clock_res_get(id, ptr) { dv().setBigUint64(ptr, 1_000_000n, true); return E.SUCCESS; },
    clock_time_get(id, precision, ptr) {
      const ms = performance.timeOrigin + performance.now();
      dv().setBigUint64(ptr, BigInt(Math.round(ms * 1e6)), true);
      return E.SUCCESS;
    },
    random_get(ptr, len) { crypto.getRandomValues(u8().subarray(ptr, ptr + len)); return E.SUCCESS; },
    sched_yield: () => E.SUCCESS,

    // Nothing to poll: run_lua never returns to the event loop.
    poll_oneoff: nosys,
    // os.exit() lands here. Throwing is right -- the instance is finished,
    // and the kernel reports itself dead rather than pretending otherwise.
    proc_exit(code) {
      const err = new Error(`the kernel called proc_exit(${code})`);
      err.procExit = code;
      throw err;
    },
  };

  // No filesystem and no sockets in v1 (an explicit non-goal). These exist
  // so the module links, and they say ENOSYS rather than lying.
  for (const name of [
    'fd_advise', 'fd_allocate', 'fd_filestat_get', 'fd_filestat_set_size',
    'fd_filestat_set_times', 'fd_pread', 'fd_pwrite', 'fd_readdir', 'fd_renumber',
    'path_create_directory', 'path_filestat_get', 'path_filestat_set_times',
    'path_link', 'path_open', 'path_readlink', 'path_remove_directory',
    'path_rename', 'path_symlink', 'path_unlink_file',
  ]) exports[name] = nosys;

  for (const name of ['sock_accept', 'sock_recv', 'sock_send', 'sock_shutdown']) {
    exports[name] = notsup;
  }

  return {
    exports,
    bind(m) { memory = m; },
    /** Drain everything written since the last drain. */
    drain() {
      const out = {
        stdout: streams[1].chunks.join(''),
        stderr: streams[2].chunks.join(''),
        truncated: streams[1].truncated || streams[2].truncated,
      };
      streams = fresh();
      return out;
    },
  };
}

/**
 * Check a module's imports against a shim before instantiating it, so an
 * unexpected import is a sentence rather than a LinkError. The binary is the
 * only authority here -- it is linked --allow-undefined, so no document can
 * be trusted about what it needs.
 */
export function unshimmedImports(module, wasi, extra = {}) {
  return WebAssembly.Module.imports(module)
    .filter((i) => {
      // The swarm build imports three trampolines from module `env`
      // (`js_host_create` / `js_host_destroy` / `js_host_drive`), which is
      // how a JavaScript host gets to be a `dvs_host` vtable at all. They
      // are supplied by whoever passes them here, so a caller that has not
      // brought them still gets the same clear sentence rather than a
      // LinkError -- which is what this function exists for.
      const supplied = i.module === 'wasi_snapshot_preview1'
        ? wasi.exports
        : extra[i.module];
      return typeof supplied?.[i.name] !== 'function';
    })
    .map((i) => `${i.module}.${i.name}`);
}
