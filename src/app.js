// Wiring. The notebook, the console and the kernel controls, joined up.
//
// Everything here talks to the kernel through the interface in
// src/kernel/kernel.js, never to `WasmKernel` directly beyond the one line
// that constructs it. That line is where Stage 2's version dropdown and
// Stage 3's second backend will plug in.

import { DEFAULT_WASM_URL } from './kernel/wasm-kernel.js';
import { WorkerKernel } from './kernel/worker-kernel.js';
import { STATUS } from './kernel/kernel.js';
import { MSG } from './kernel/protocol.js';
import { NotebookModel } from './notebook/model.js';
import { toIpynb, fromIpynb, messageToOutput, IpynbError } from './notebook/ipynb.js';
import { NotebookView } from './notebook/ui.js';
import { ConsoleView } from './notebook/console.js';
import { saveAutosave, loadAutosave, debounceSave } from './notebook/storage.js';
import { FALLBACK_KEYWORDS, FALLBACK_GLOBALS } from './notebook/highlight.js';
import { RuntimeRegistry, PINNED } from './kernel/runtimes.js';
import { LAB_VERSION, LAB_COMMIT } from './version.js';
// `BUNDLED`, not `PINNED`: runtimes.js already exports a `PINNED` (the
// runtime *id*), and the bake flattens every module into one scope --
// its duplicate-name guard is what caught this.
import { BUNDLED } from '../vendor/pinned.js';

/**
 * The notebook a first-time visitor gets. Embedded rather than fetched: the
 * page makes no network request at load beyond the kernel itself, and the
 * baked single-file build has nowhere to fetch from anyway.
 *
 * Kept to syntax the pinned 5.4.7 runtime understands -- `switch`, compound
 * assignment and the rewritten f-strings are 5.5 and would fail confusingly
 * on first run.
 */
const DEFAULT_NOTEBOOK = {
  cells: [
    { cell_type: 'markdown', metadata: {}, source: [
      '# Diluvium Lab\n', '\n',
      'Cells share one kernel, so state carries from one to the next.\n',
      'Run a cell with **Ctrl+Enter**, or Shift+Enter to run and move on.\n',
    ] },
    { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [
      'local who = "world"\n', 'print($"hello, {who}!")',
    ] },
    { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [
      '-- state persists across cells: this is the kernel\n',
      'counter = (counter or 0) + 1\n', 'counter',
    ] },
    { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [
      '-- errors are caught, and say where they came from\n',
      'pcall(function() error("caught") end)',
    ] },
  ],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
};

export class App {
  constructor(document_, options = {}) {
    this.document = document_;
    // A WorkerKernel by default, so a runaway cell freezes a worker
    // rather than the tab. It degrades to running in the page by itself
    // where a worker is impossible (the baked file:// build), which is
    // why there is no branch here.
    this.kernel = options.kernel ?? new WorkerKernel({
      wasmUrl: options.wasmUrl ?? DEFAULT_WASM_URL,
      moduleBytes: options.moduleBytes ?? null,
      label: 'On-page WASM',
    });
    this.model = new NotebookModel();
    this.filename = 'notebook.ipynb';
    this.autosave = debounceSave(saveAutosave, options.autosaveDelayMs ?? 400);

    this.registry = options.registry ?? new RuntimeRegistry({
      mirrorUrl: options.mirrorUrl,
      pinnedLabel: options.pinnedLabel ?? '5.5.1_build1',
      bundledBytes: options.moduleBytes ?? null,
      wasmUrl: options.wasmUrl ?? DEFAULT_WASM_URL,
    });
    this.runtimeId = PINNED;

    this.statusNode = document_.querySelector('[data-kernel-status]');
    this.versionNode = document_.querySelector('[data-version-select]');
    this.checkNode = document_.querySelector('[data-toolbar="check-versions"]');
    this.backendNode = document_.querySelector('[data-kernel-backend]');
    this.toastNode = document_.querySelector('[data-toast]');
    this.filenameNode = document_.querySelector('[data-filename]');

    // Filled in from the running kernel once it starts. Until then the
    // highlighter falls back to stock Lua 5.4, which is what 5.4.7 is.
    this.language = { keywords: FALLBACK_KEYWORDS, globals: FALLBACK_GLOBALS, version: null };
    const languageInfo = () => this.language;

    this.view = new NotebookView(document_.querySelector('[data-cells]'), this.model, {
      onRun: (cellId, opts) => this.runCell(cellId, opts),
      languageInfo,
      complete: (code, cursor) => this.completeAt(code, cursor),
      compile: (code) => this.kernel.dumpBytecode(code),
    });

    this.console = new ConsoleView(document_.querySelector('[data-console]'), {
      onExecute: (code) => this.executeCollectMessages(code),
      languageInfo,
      complete: (code, cursor) => this.completeAt(code, cursor),
      onIsComplete: async (code) => {
        if (this.kernel.status === STATUS.DEAD) return 'complete';
        return (await this.kernel.isComplete(code)).content.status;
      },
    });

    this._watchKernel();

    this._bindToolbar();
    this._bindModel();
    this._bindLifecycle();
  }

  /** Status messages come from whichever kernel is current. */
  _watchKernel() {
    this._unwatchKernel?.();
    this._unwatchKernel = this.kernel.onMessage((msg) => {
      if (msg.msg_type === MSG.STATUS) this._renderStatus(msg.content.execution_state);
    });
  }

  // --- boot ---------------------------------------------------------

  /**
   * Bring the page up, and never leave it silently half-built.
   *
   * Every phase is separately guarded and the last two lines run whatever
   * happened. The version this replaced put `_setModel` and `kernel.start`
   * ahead of `_renderVersions` with nothing around them, so anything that
   * threw or hung in either left a page with no runtime dropdown, no
   * `data-ready`, and no explanation -- which is indistinguishable from
   * "this browser is broken" and is exactly what a browser with unfamiliar
   * restrictions will produce. A page that half-works and says why beats a
   * page that stops and does not.
   */
  async start() {
    // Read by the inline script in index.html, which is the only code
    // guaranteed not to be stale. If these disagree, the page is running
    // modules from an older deploy than the HTML that loaded them.
    this.labVersion = LAB_VERSION;
    this.startupProblems = [];
    const phase = async (what, fn) => {
      try {
        return await fn();
      } catch (err) {
        this.startupProblems.push(`${what}: ${err?.message ?? err}`);
        console.error(`diluvium-lab: ${what} failed`, err);
        return undefined;
      }
    };

    await phase('checking this page and its scripts came from one deploy',
      () => this._checkBuildMatches());

    const restored = await phase('restoring the saved notebook', () => this._restore());
    await phase('rendering the notebook', () => {
      this._setModel(restored ?? fromIpynb(DEFAULT_NOTEBOOK));
    });

    await phase('showing the kernel status', () => {
      this._renderStatus(this.kernel.status);
      if (this.backendNode) this.backendNode.textContent = this.kernel.label ?? 'kernel';
    });

    const started = await phase('starting the kernel', async () => {
      // A hang here used to be indistinguishable from a slow start, and
      // nothing downstream ran. Now it becomes an ordinary failure.
      await withTimeout(this.kernel.start(), 30_000, 'the kernel did not start within 30 seconds');
      return true;
    });
    if (started) {
      await phase('asking the kernel about its language', () => this.refreshLanguage());
      this.console.note('Kernel ready. Cells and this console share it.');
    } else {
      this._renderStatus(STATUS.DEAD);
    }

    // Always. The dropdown carries the bundled runtime unconditionally, so
    // an empty one means this line never ran -- which is a fact worth being
    // unable to hide.
    await phase('listing runtimes', () => this._renderVersions());

    if (this.startupProblems.length) {
      const first = this.startupProblems[0];
      this._toast(`${first} — see About for details.`, 'error');
      for (const problem of this.startupProblems) this.console.note(problem);
    }
    this.document.body.dataset.ready = 'true';
    this.document.body.dataset.startupProblems = String(this.startupProblems.length);
  }

  /**
   * Does the HTML agree with the JavaScript about which build this is?
   *
   * They can only disagree if something is serving one of them from an
   * older deploy. That is a real and recurring failure for a page with no
   * build step and no content hashes in its URLs: a CDN or a browser
   * caches the modules for hours while the HTML, being uncacheable,
   * arrives fresh. Nothing throws -- the old code simply lacks the newer
   * half of the page -- so a clean console is exactly what it looks like,
   * and that is the worst kind of bug to be handed.
   */
  _checkBuildMatches() {
    const declared = this.document
      .querySelector('meta[name="diluvium-lab-build"]')?.getAttribute('content');
    if (!declared || declared === LAB_VERSION) return;
    this.buildMismatch = { html: declared, scripts: LAB_VERSION };
    throw new Error(
      `this page is version ${declared} but its scripts are ${LAB_VERSION}. `
      + 'Something is serving a cached copy of one of them. Reload bypassing the '
      + 'cache (Ctrl+Shift+R, or Cmd+Shift+R) — and if that fixes it, the host '
      + 'needs to stop caching unversioned scripts.');
  }

  /**
   * What this browser will and will not let the Lab do.
   *
   * Reported rather than assumed, because the interesting cases are the
   * ones nobody here can reproduce: a browser with strict privacy defaults
   * blocks some of these, and "it does not work in X" is unactionable
   * while "Worker: no, IndexedDB: no" is a bug report.
   */
  environment() {
    const view = this.document.defaultView ?? {};
    const has = (fn) => { try { return fn() ? 'yes' : 'no'; } catch (err) { return `blocked (${err.name})`; } };
    return [
      ['WebAssembly', has(() => typeof view.WebAssembly?.Module === 'function')],
      ['Web Worker', has(() => typeof view.Worker === 'function')],
      ['crypto.subtle', has(() => !!view.crypto?.subtle)],
      ['secure context', has(() => view.isSecureContext)],
      ['IndexedDB', has(() => !!view.indexedDB)],
      ['structuredClone', has(() => typeof view.structuredClone === 'function')],
      ['clipboard', has(() => !!view.navigator?.clipboard)],
      // Appearance rather than function, and the reason a page can look
      // wrong while working: nearly every border, background and muted
      // colour in the stylesheet is a color-mix(), so a build without it
      // renders a flat, unstyled-looking page that still runs.
      ['CSS color-mix', has(() => view.CSS?.supports?.('color', 'color-mix(in srgb, red 50%, blue)'))],
      ['<dialog>', has(() => typeof view.HTMLDialogElement !== 'undefined')],
      // Everything the page loads is same-origin and unversioned, so a
      // browser holding a stale copy of one module and a fresh copy of
      // another is a real failure mode. Comparing this against the commit
      // in the deployment is how you spot it.
      ['Lab build', LAB_COMMIT ? LAB_COMMIT.slice(0, 12) : 'unversioned (served from a checkout)'],
      ['HTML/script versions', this.buildMismatch
        ? `MISMATCH — page ${this.buildMismatch.html}, scripts ${this.buildMismatch.scripts} (stale cache)`
        : 'agree'],
    ];
  }

  // --- runtimes -----------------------------------------------------

  _renderVersions() {
    if (!this.versionNode) return;
    const entries = this.registry.entries();
    this.versionNode.replaceChildren(...entries.map((entry) => {
      const option = this.document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label;
      option.selected = entry.id === this.runtimeId;
      return option;
    }));

    const reason = this.registry.unavailableReason;
    this.versionNode.disabled = entries.length < 2 && !!reason;
    if (this.checkNode) {
      this.checkNode.disabled = !this.registry.canSwitch;
      this.checkNode.title = reason ?? 'Look for other Diluvium builds on the mirror';
    }
    this.document.body.dataset.runtime = this.runtimeId;
    this.versionNode.dataset.count = String(entries.length);
  }

  /**
   * Explicitly user-initiated, and the only outbound request the Lab makes
   * that is not the kernel itself. "No external requests at load" is a hard
   * constraint; this is a button.
   */
  async checkVersions() {
    if (!this.registry.canSwitch) {
      this._toast(this.registry.unavailableReason, 'error');
      return;
    }
    this.document.body.dataset.checking = 'true';
    try {
      const entries = await this.registry.check();
      this._renderVersions();
      const remote = entries.filter((e) => e.remote).length;
      this._toast(remote
        ? `Found ${remote} other build${remote === 1 ? '' : 's'} on the mirror.`
        : 'The mirror lists no other builds yet.');
    } catch (err) {
      this._toast(err.message, 'error');
    } finally {
      this.document.body.dataset.checking = 'false';
    }
  }

  /**
   * Swap the runtime. Fetch, verify, probe, and only then swap: a build
   * that fails any step leaves the running kernel exactly as it was, so
   * trying a version can never be how a session is lost.
   */
  async selectRuntime(id) {
    if (id === this.runtimeId) return;
    const previous = this.runtimeId;
    this.document.body.dataset.switching = 'true';
    this._renderStatus(STATUS.STARTING);

    let loaded;
    try {
      loaded = await this.registry.load(id);
    } catch (err) {
      this._toast(err.message, 'error');
      this.console.note(`Could not load ${id}: ${err.message}`);
      this.runtimeId = previous;
      this._renderVersions();
      this._renderStatus(this.kernel.status);
      this.document.body.dataset.switching = 'false';
      return;
    }

    const old = this.kernel;
    this.kernel = loaded.kernel;
    this.runtimeId = id;
    this._watchKernel();
    // Drop the old instance so its linear memory can go.
    await old.shutdown().catch(() => {});

    await this.refreshLanguage();
    this.model.markAllStale();
    this._renderVersions();
    this._renderStatus(this.kernel.status);
    if (this.backendNode) this.backendNode.textContent = this.kernel.label;
    this.console.note(
      `Switched to ${this.registry.entries().find((e) => e.id === id)?.label ?? id}` +
      `${loaded.fromCache ? ' (from cache)' : ''}. Every variable is gone.`);
    this.document.body.dataset.switching = 'false';
  }

  /**
   * Ask the kernel which words *it* reserves, and re-colour.
   *
   * The same discipline as reading the WASI import list off the binary
   * rather than guessing: a build that adds `switch` gets `switch`
   * highlighted, without anything in this repository being edited.
   */
  /** Completion, if the kernel is alive and willing. Never throws. */
  async completeAt(code, cursor) {
    if (this.kernel.status === STATUS.DEAD) return { matches: [] };
    if (!this.kernel.capabilities?.complete) return { matches: [] };
    const reply = await this.kernel.complete(code, cursor);
    return reply.content;
  }

  async refreshLanguage() {
    if (typeof this.kernel.languageInfo !== 'function') return;
    try {
      const info = await this.kernel.languageInfo();
      if (!info?.keywords?.length) return;
      this.language = info;
      this.view.repaintHighlights();
      this.console.repaintHighlight();
    } catch (err) {
      console.warn('could not read the kernel language info', err);
    }
  }

  async _restore() {
    try {
      const record = await loadAutosave();
      if (!record?.ipynb) return null;
      const model = fromIpynb(record.ipynb);
      if (record.filename) this.filename = record.filename;
      return model;
    } catch (err) {
      console.warn('could not restore the autosaved notebook', err);
      return null;
    }
  }

  _setModel(model) {
    this.model = model;
    this.view.setModel(model);
    this._bindModel();
    this._renderFilename();
  }

  _bindModel() {
    this._unbindModel?.();
    this._unbindModel = this.model.onChange((change) => {
      if (change.type === 'structure') this.view.render();
      else if (change.type === 'outputs') this.view.updateOutputs(change.cellId);
      this._scheduleAutosave();
    });
  }

  _scheduleAutosave() {
    this.autosave.schedule({ ipynb: toIpynb(this.model), filename: this.filename, savedAt: Date.now() });
  }

  /**
   * Write the pending autosave before the page can go away.
   *
   * Autosave is debounced 400ms, so without this the last thing typed
   * before closing a tab is the one thing lost -- which is exactly the
   * keystroke someone will remember.
   *
   * `visibilitychange` rather than `beforeunload`, and this matters on a
   * phone: a backgrounded tab can be discarded outright without ever
   * firing an unload event, and `hidden` is the last moment guaranteed to
   * arrive. `pagehide` covers the desktop close and the bfcache. Both are
   * cheap and idempotent, so registering both costs a redundant write at
   * worst.
   */
  _bindLifecycle() {
    const flush = () => { this.autosave.flush().catch(() => {}); };
    this.document.addEventListener('visibilitychange', () => {
      if (this.document.visibilityState === 'hidden') flush();
    });
    this.document.defaultView?.addEventListener('pagehide', flush);
  }

  // --- running ------------------------------------------------------

  /** Run one cell. Markdown cells "run" by rendering, which is what people expect. */
  async runCell(cellId, { advance = false } = {}) {
    const cell = this.model.get(cellId);
    if (!cell) return;

    if (cell.cell_type !== 'code') {
      this.view.finishMarkdownEdit(cellId);
      if (advance) this._focusNext(cellId);
      return;
    }

    if (this.kernel.status === STATUS.DEAD) {
      this._toast('The kernel is not running. Restart it first.', 'error');
      return;
    }

    this.view.select(cellId);
    this.view.setBusy(cellId, true);
    // Yield once so the In [*] marker actually paints before run_lua takes
    // the thread for however long it takes. This is the honest limit of a
    // synchronous kernel, not a loading spinner pretending to be one.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const startedAt = new Date().toISOString();
    const outputs = [];
    let reply;
    try {
      reply = await this.kernel.execute(cell.source, (msg) => {
        const output = messageToOutput(msg);
        if (output) outputs.push(output);
      });
    } catch (err) {
      this.model.setOutputs(cellId, [{
        output_type: 'error', ename: 'KernelError', evalue: err.message, traceback: [],
      }]);
      this.model.setExecutionTiming(cellId, startedAt, new Date().toISOString());
      this.view.setBusy(cellId, false);
      return;
    }

    this.model.setOutputs(cellId, outputs);
    this.model.setExecutionCount(cellId, reply.content.execution_count);
    this.model.setExecutionTiming(cellId, startedAt, new Date().toISOString());
    if (advance) this._focusNext(cellId);
    return reply;
  }

  /**
   * Run every code cell, top to bottom, stopping at the first error --
   * running on past a failure produces cascades of nonsense.
   */
  async runAll() {
    this.document.body.dataset.running = 'true';
    try {
      for (const cell of [...this.model.cells]) {
        if (cell.cell_type !== 'code') continue;
        if (cell.source.trim() === '') continue;
        const reply = await this.runCell(cell.id);
        if (reply?.content.status === 'error') {
          this._toast('Run all stopped at the first error.', 'error');
          break;
        }
        if (this.kernel.status === STATUS.DEAD) break;
      }
    } finally {
      this.document.body.dataset.running = 'false';
    }
  }

  async executeCollectMessages(code) {
    if (this.kernel.status === STATUS.DEAD) {
      return [{ msg_type: MSG.ERROR, content: { ename: 'KernelError', evalue: 'the kernel is not running', traceback: [] } }];
    }
    const messages = [];
    await this.kernel.execute(code, (msg) => messages.push(msg));
    return messages;
  }

  async restartKernel() {
    try {
      await this.kernel.restart();
      await this.refreshLanguage();
      this.model.markAllStale();
      this.console.note('Kernel restarted. Every variable is gone.');
      this._toast('Kernel restarted.');
    } catch (err) {
      this._renderStatus(STATUS.DEAD);
      this._toast(`Restart failed: ${err.message}`, 'error');
    }
  }

  // --- files --------------------------------------------------------

  saveFile() {
    const json = JSON.stringify(toIpynb(this.model), null, 1);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = this.document.createElement('a');
    link.href = url;
    link.download = this.filename;
    this.document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async openFile(file) {
    try {
      const model = fromIpynb(await file.text());
      this.filename = file.name || 'notebook.ipynb';
      this._setModel(model);
      this._scheduleAutosave();
      this._toast(`Opened ${this.filename}`);
    } catch (err) {
      if (err instanceof IpynbError) this._toast(err.message, 'error');
      else this._toast(`Could not open that file: ${err.message}`, 'error');
    }
  }

  // --- chrome -------------------------------------------------------

  _bindToolbar() {
    const on = (action, fn) => {
      for (const node of this.document.querySelectorAll(`[data-toolbar="${action}"]`)) {
        node.addEventListener('click', fn);
      }
    };
    on('add-code', () => this.model.addCell('code'));
    on('add-markdown', () => this.model.addCell('markdown'));
    on('run-all', () => this.runAll());
    on('restart', () => this.restartKernel());
    on('stop', () => this.stopKernel());
    on('about', () => this.showAbout());
    on('clear-outputs', () => this.model.clearAllOutputs());
    on('save', () => this.saveFile());

    on('check-versions', () => this.checkVersions());
    this.versionNode?.addEventListener('change', () => this.selectRuntime(this.versionNode.value));

    const fileInput = this.document.querySelector('[data-file-input]');
    on('open', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (file) await this.openFile(file);
      fileInput.value = '';
    });
  }

  _renderStatus(status) {
    this.document.body.dataset.kernelState = status;
    // Enabled only while there is something to stop and a kernel that can
    // stop it. Kept in the DOM and disabled rather than hidden: a control
    // that appears and vanishes moves the toolbar under the pointer and
    // drops in and out of the tab order mid-task.
    const stop = this.document.querySelector('[data-toolbar="stop"]');
    if (stop) stop.disabled = !(status === STATUS.BUSY && this.kernel.capabilities?.interrupt);
    if (!this.statusNode) return;
    this.statusNode.textContent = status;
    this.statusNode.dataset.status = status;
  }

  /**
   * Stop the running cell.
   *
   * Deliberately not called "interrupt". Terminating the worker is the
   * only way to stop a synchronous WASM call, and it takes the Lua state
   * with it -- so this says so plainly rather than letting someone
   * discover it by finding their variables gone.
   */
  async stopKernel() {
    if (!this.kernel.capabilities?.interrupt) {
      this._toast(this.kernel.fallbackReason
        ? `This kernel runs in the page and cannot be stopped (${this.kernel.fallbackReason}).`
        : 'This kernel cannot be stopped.', 'error');
      return;
    }
    try {
      await this.kernel.interrupt();
      await this.refreshLanguage();
      // Not resetExecutionCounts: keep the In [n] numbers and mark them
      // stale instead, so the reader still sees what ran and in what
      // order -- and sees that those results describe a Lua state that is
      // gone. Erasing the numbers would throw that history away.
      this.model.markAllStale();
      this.console.note('Stopped. The kernel restarted, so every variable is gone.');
      this._toast('Stopped the running cell.');
    } catch (err) {
      this._renderStatus(STATUS.DEAD);
      this._toast(`Could not stop the kernel: ${err.message}`, 'error');
    }
  }

  // --- about --------------------------------------------------------

  /**
   * Everything needed to identify this build, in one place.
   *
   * The point is not vanity, it is bug reports: "it does not work" is
   * unactionable, and nobody should have to be talked through finding a
   * version. So the panel states the facts and hands over a block to
   * paste. Every value is read from the thing it describes rather than
   * assumed -- the kernel is asked for its own version, the runtime
   * reports its own tag and checksum.
   */
  aboutFacts() {
    const entry = this.registry.entries().find((e) => e.id === this.runtimeId);
    const remote = this.registry.remote?.find((r) => r.tag === this.runtimeId);
    const bundled = this.runtimeId === PINNED;
    const view = this.document.defaultView;

    return [
      ['Lab', `${LAB_VERSION}${LAB_COMMIT ? ` (${LAB_COMMIT.slice(0, 12)})` : ' (commit unknown — served from a checkout)'}`],
      ['Diluvium', bundled ? BUNDLED.version : (remote?.version ?? entry?.label ?? this.runtimeId)],
      ['Release tag', bundled ? BUNDLED.tag : (remote?.tag ?? this.runtimeId)],
      ['Source', bundled ? 'bundled with this build' : `downloaded from the mirror`],
      ['Kernel sha256', bundled
        ? BUNDLED.sha256
        : (remote?.assets?.['libdiluvium_wasi.wasm'] ?? 'verified at download; not recorded here')],
      ['Diluvium commit', bundled ? BUNDLED.commit : (remote ? 'see the mirror\'s BUILDINFO.txt' : 'unknown')],
      ['Built', bundled ? BUNDLED.built : (remote?.published ?? 'unknown')],
      // Asked of the running kernel, so it cannot disagree with reality.
      ['Reported by the kernel', this.language.version ?? 'not started'],
      ['Execution', this.kernel.offThread === false
        ? `in the page — ${this.kernel.fallbackReason ?? 'no worker'}`
        : 'in a worker (Stop available)'],
      ['Notebook format', 'ipynb 4.5'],
      ['Browser', view?.navigator?.userAgent ?? 'unknown'],
      ...this.environment().map(([k, v]) => [`  ${k}`, v]),
      ...(this.startupProblems?.length
        ? [['Startup problems', this.startupProblems.join(' | ')]]
        : []),
    ];
  }

  /** The same facts as something a person can paste into an issue. */
  aboutReport() {
    return this.aboutFacts().map(([k, v]) => `${k}: ${v}`).join('\n');
  }

  showAbout() {
    const dialog = this.document.querySelector('[data-about]');
    if (!dialog) return;

    const list = dialog.querySelector('[data-about-facts]');
    if (list) {
      list.replaceChildren(...this.aboutFacts().flatMap(([term, value]) => {
        const dt = this.document.createElement('dt');
        dt.textContent = term;
        const dd = this.document.createElement('dd');
        dd.textContent = value;          // text, never markup
        return [dt, dd];
      }));
    }
    const report = dialog.querySelector('[data-about-report]');
    if (report) report.textContent = this.aboutReport();

    dialog.showModal?.() ?? dialog.setAttribute('open', '');
    this._bindAbout(dialog);
  }

  _bindAbout(dialog) {
    if (dialog.dataset.bound === 'true') return;
    dialog.dataset.bound = 'true';
    dialog.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-about-action]')?.dataset.aboutAction;
      if (action === 'close') dialog.close?.() ?? dialog.removeAttribute('open');
      if (action !== 'copy') return;
      try {
        await this.document.defaultView.navigator.clipboard.writeText(this.aboutReport());
        this._toast('Copied. Paste it into the bug report.');
      } catch {
        // Clipboard access is refused in plenty of ordinary situations.
        // The text is already on screen and selectable, so say that
        // rather than failing silently.
        this._toast('Could not reach the clipboard — select the text above and copy it.', 'error');
      }
    });
  }

  _renderFilename() {
    if (this.filenameNode) this.filenameNode.textContent = this.filename;
  }

  _focusNext(cellId) {
    const at = this.model.indexOf(cellId);
    const next = this.model.cells[at + 1] ?? this.model.addCell('code', cellId);
    this.view.cellNode(next.id)?.querySelector('[data-editor]')?.focus();
  }

  _toast(text, kind = 'info') {
    if (!this.toastNode) return;
    this.toastNode.textContent = text;
    this.toastNode.dataset.kind = kind;
    this.toastNode.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.toastNode.hidden = true; }, 6000);
  }
}

/**
 * Reject rather than hang for ever.
 *
 * A promise that never settles is worse than one that rejects: nothing
 * downstream runs, nothing reports, and the page sits half-built looking
 * like a browser problem. This turns that into an ordinary failure with a
 * sentence attached.
 */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}
