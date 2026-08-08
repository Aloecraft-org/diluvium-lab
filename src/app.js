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

  async start() {
    const restored = await this._restore();
    this._setModel(restored ?? fromIpynb(DEFAULT_NOTEBOOK));

    this._renderStatus(this.kernel.status);
    if (this.backendNode) this.backendNode.textContent = this.kernel.label ?? 'kernel';

    try {
      await this.kernel.start();
      await this.refreshLanguage();
      this.console.note('Kernel ready. Cells and this console share it.');
    } catch (err) {
      this._renderStatus(STATUS.DEAD);
      this._toast(err.message, 'error');
      this.console.note(err.message);
    }
    this._renderVersions();
    this.document.body.dataset.ready = 'true';
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
    this.model.resetExecutionCounts();
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

    this.view.setBusy(cellId, true);
    // Yield once so the In [*] marker actually paints before run_lua takes
    // the thread for however long it takes. This is the honest limit of a
    // synchronous kernel, not a loading spinner pretending to be one.
    await new Promise((resolve) => setTimeout(resolve, 0));

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
      this.view.setBusy(cellId, false);
      return;
    }

    this.model.setOutputs(cellId, outputs);
    this.model.setExecutionCount(cellId, reply.content.execution_count);
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
      this.model.resetExecutionCounts();
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
      this.model.resetExecutionCounts();
      this.console.note('Stopped. The kernel restarted, so every variable is gone.');
      this._toast('Stopped the running cell.');
    } catch (err) {
      this._renderStatus(STATUS.DEAD);
      this._toast(`Could not stop the kernel: ${err.message}`, 'error');
    }
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
