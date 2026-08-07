// Wiring. The notebook, the console and the kernel controls, joined up.
//
// Everything here talks to the kernel through the interface in
// src/kernel/kernel.js, never to `WasmKernel` directly beyond the one line
// that constructs it. That line is where Stage 2's version dropdown and
// Stage 3's second backend will plug in.

import { WasmKernel, DEFAULT_WASM_URL } from './kernel/wasm-kernel.js';
import { STATUS } from './kernel/kernel.js';
import { MSG } from './kernel/protocol.js';
import { NotebookModel } from './notebook/model.js';
import { toIpynb, fromIpynb, messageToOutput, IpynbError } from './notebook/ipynb.js';
import { NotebookView } from './notebook/ui.js';
import { ConsoleView } from './notebook/console.js';
import { saveAutosave, loadAutosave, debounceSave } from './notebook/storage.js';

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
    this.kernel = options.kernel ?? new WasmKernel({
      wasmUrl: options.wasmUrl ?? DEFAULT_WASM_URL,
      moduleBytes: options.moduleBytes ?? null,
    });
    this.model = new NotebookModel();
    this.filename = 'notebook.ipynb';
    this.autosave = debounceSave(saveAutosave, options.autosaveDelayMs ?? 400);

    this.statusNode = document_.querySelector('[data-kernel-status]');
    this.backendNode = document_.querySelector('[data-kernel-backend]');
    this.toastNode = document_.querySelector('[data-toast]');
    this.filenameNode = document_.querySelector('[data-filename]');

    this.view = new NotebookView(document_.querySelector('[data-cells]'), this.model, {
      onRun: (cellId, opts) => this.runCell(cellId, opts),
    });

    this.console = new ConsoleView(document_.querySelector('[data-console]'), {
      onExecute: (code) => this.executeCollectMessages(code),
      onIsComplete: async (code) => {
        if (this.kernel.status === STATUS.DEAD) return 'complete';
        return (await this.kernel.isComplete(code)).content.status;
      },
    });

    this.kernel.onMessage((msg) => {
      if (msg.msg_type === MSG.STATUS) this._renderStatus(msg.content.execution_state);
    });

    this._bindToolbar();
    this._bindModel();
  }

  // --- boot ---------------------------------------------------------

  async start() {
    const restored = await this._restore();
    this._setModel(restored ?? fromIpynb(DEFAULT_NOTEBOOK));

    this._renderStatus(this.kernel.status);
    if (this.backendNode) this.backendNode.textContent = this.kernel.label ?? 'kernel';

    try {
      await this.kernel.start();
      this.console.note('Kernel ready. Cells and this console share it.');
    } catch (err) {
      this._renderStatus(STATUS.DEAD);
      this._toast(err.message, 'error');
      this.console.note(err.message);
    }
    this.document.body.dataset.ready = 'true';
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
    on('clear-outputs', () => this.model.clearAllOutputs());
    on('save', () => this.saveFile());

    const fileInput = this.document.querySelector('[data-file-input]');
    on('open', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (file) await this.openFile(file);
      fileInput.value = '';
    });
  }

  _renderStatus(status) {
    if (!this.statusNode) return;
    this.statusNode.textContent = status;
    this.statusNode.dataset.status = status;
    // A distinct name: `data-kernel-status` belongs to the indicator, and
    // reusing it on <body> would make every selector for it ambiguous.
    this.document.body.dataset.kernelState = status;
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
