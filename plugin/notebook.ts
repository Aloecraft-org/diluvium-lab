// The Notebook panel: the lab's cell list (`src/notebook/ui.js`) over its
// model, inside a Lumino widget. The kernel is the shared service; what
// `src/app.js` did between the two is ported here, nothing more. Each panel
// is one notebook in one storage slot; the page's own notebook is the slot
// named `autosave`.
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import type { ILabKernel, KernelMessage, KernelStatus } from '@dirt-launcher/api';
import { STATUS } from '../src/kernel/kernel.js';
import { NotebookModel, EXPECT, expectationOf } from '../src/notebook/model.js';
import { toIpynb, fromIpynb, messageToOutput } from '../src/notebook/ipynb.js';
import { NotebookView, renderOutputs } from '../src/notebook/ui.js';
import { saveNotebook, loadNotebook, clearNotebook, debounceSave, rememberRecent } from '../src/notebook/storage.js';

// Surface: the panel's args, the notebook a first visit gets, and the names a file takes.

/** `lab:open` args: the storage slot; the page's own notebook when absent. */
export interface NotebookArgs extends ReadonlyPartialJSONObject {
  slot?: string;
}
/** The page's autosave slot: a notebook started in the page is the one the launcher opens first. */
export const PAGE_SLOT = 'autosave';
/** A fresh slot for a notebook opened beside the others. */
export const newSlot = (): string => `nb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
/** What a notebook opened from nothing is saved as until it is renamed. */
export const NEW_FILENAME = 'untitled.ipynb';
export const DEFAULT_FILENAME = 'notebook.ipynb';
/** Autosave waits this long after the last edit before writing. */
export const AUTOSAVE_DELAY_MS = 400;
/** The first notebook, as the lab's page seeds it: four cells, no fetch. */
export const DEFAULT_NOTEBOOK = {
  cells: [
    { cell_type: 'markdown', metadata: {}, source: [
      '# Diluvium Lab\n', '\n',
      'Cells share one kernel, so state carries from one to the next.\n',
      'Run a cell with **Ctrl+Enter** (⌘ on a Mac), or Shift+Enter to run and move on.\n',
      'The **Lab** menu adds cells, runs them all, and saves the notebook as `.ipynb`.\n',
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

/** A notebook to put in a new panel: its text, and where it came from for the recents list. */
export interface NotebookSource {
  text: string;
  name: string;
  origin: 'file' | 'url' | 'example' | 'replaced';
  url?: string | null;
}

export interface NotebookOptions {
  kernel: ILabKernel;
  slot: string;
  /** Opened with this document; otherwise the slot's saved notebook, or the seed for the page's slot. */
  initial?: NotebookSource;
  /** The footer's runtime button was pressed; opens the runtime menu over it. */
  onRuntimeMenu?: (anchor: HTMLElement) => void;
  notify: (message: string) => void;
}

type Cell = { id: string; cell_type: string; source: string };
type Output = Record<string, unknown>;

/**
 * The lab's model and view, as this panel uses them. Declared here because
 * the JS defaults (`afterId = null`) type those parameters as `null` alone.
 */
export interface LabModel {
  cells: Cell[];
  readonly title: string;
  get(cellId: string): Cell | null;
  indexOf(cellId: string): number;
  addCell(cellType: string, afterId: string | null): Cell;
  setOutputs(cellId: string, outputs: Output[]): void;
  setExecutionCount(cellId: string, count: number | null): void;
  setExecutionTiming(cellId: string, startedAt: string, endedAt: string): void;
  markAllStale(): void;
  onChange(listener: (change: { type: string; cellId?: string }) => void): () => void;
}
interface LabView {
  selectedId: string | null;
  readonly displayCtx: object;
  select(cellId: string): void;
  setModel(model: LabModel): void;
  render(): void;
  updateOutputs(cellId?: string): void;
  cellNode(cellId: string): HTMLElement | null;
  focusEditor(cellId?: string | null): void;
  setBusy(cellId: string, busy: boolean): void;
  finishMarkdownEdit(cellId: string): void;
  repaintHighlights(): void;
  _busyTimers: Map<string, number>;
}

/** A notebook with one blank code cell. */
const blankModel = (): LabModel => new NotebookModel() as unknown as LabModel;
const parse = (text: unknown): LabModel => fromIpynb(text) as unknown as LabModel;

export class NotebookPanel extends Widget {
  readonly slot: string;
  model: LabModel = blankModel();
  readonly view: LabView;
  filename = DEFAULT_FILENAME;
  /** Fires when the document is replaced or renamed. */
  readonly changed = new Signal<this, void>(this);
  /** Fires on every model change with its type: structure, source, outputs, title. */
  readonly edited = new Signal<this, string>(this);
  /** The current cell changed. */
  readonly selected = new Signal<this, string | null>(this);
  /** Resolves once the slot's notebook (or the seed) is on screen; commands that touch the document wait for it. */
  readonly ready: Promise<void>;
  private readonly kernel: ILabKernel;
  private readonly notify: (message: string) => void;
  private readonly cells: HTMLElement;
  private readonly statusNode: HTMLElement;
  private readonly runtimeNode: HTMLButtonElement;
  private readonly fileNode: HTMLElement;
  private readonly saveNode: HTMLElement;
  private readonly autosave: ReturnType<typeof debounceSave>;
  private unbindModel?: () => void;
  private running = false;
  private widgetQueue = new Map<string, { value: unknown; into: HTMLElement; auto: boolean }>();
  private widgetTouched = new Set<string>();
  private widgetBusy = false;

  constructor({ kernel, slot, initial, onRuntimeMenu, notify }: NotebookOptions) {
    super();
    this.kernel = kernel;
    this.slot = slot;
    this.notify = notify;
    this.addClass('lab-notebook');
    this.title.label = 'Notebook';
    this.title.caption = 'A Diluvium notebook';
    this.node.innerHTML = `
      <div class="lab-sheet"><div class="cells" data-cells></div></div>
      <div class="lab-foot">
        <span class="lab-dot"></span>
        <span class="lab-foot-info">kernel · <span data-kernel-status>starting</span></span>
        <button type="button" class="lab-foot-runtime" data-runtime title="The Diluvium build this notebook runs on; press to pick another"></button>
        <span class="lab-foot-file" data-filename></span>
        <span class="lab-foot-save" data-save-status></span>
      </div>`;
    this.cells = this.node.querySelector('[data-cells]')!;
    this.statusNode = this.node.querySelector('[data-kernel-status]')!;
    this.runtimeNode = this.node.querySelector('[data-runtime]')!;
    this.fileNode = this.node.querySelector('[data-filename]')!;
    this.saveNode = this.node.querySelector('[data-save-status]')!;
    this.runtimeNode.onclick = () => onRuntimeMenu?.(this.runtimeNode);
    this.autosave = debounceSave(async (record: unknown) => {
      this.setSaveStatus('saving');
      try {
        await saveNotebook(this.slot, record);
        this.setSaveStatus('saved');
      } catch (err) {
        this.setSaveStatus('failed');
        throw err;
      }
    }, AUTOSAVE_DELAY_MS);
    const languageInfo = () => kernel.language;
    this.view = new NotebookView(this.cells, this.model as NotebookModel, {
      onRun: (cellId: string, opts?: { advance?: boolean }) => this.runCell(cellId, opts),
      languageInfo,
      complete: (code: string, cursor: number) => kernel.complete(code, cursor),
      compile: (code: string) => kernel.kernel.dumpBytecode(code),
      onWidget: (id: string, value: unknown, into: HTMLElement, opts?: { auto?: boolean }) => this.widgetChanged(id, value, into, opts),
      runInstance: (code: string, options: Record<string, unknown>) => kernel.kernel.runInstance(code, options),
      instancesEnabled: () => kernel.capabilities.instances === true,
      widgetsEnabled: () => kernel.capabilities.widgets === true && kernel.status !== STATUS.DEAD,
      onSelect: (cellId: string | null) => this.selected.emit(cellId),
      readOnly: () => false,
    }) as unknown as LabView;
    kernel.statusChanged.connect(this.renderStatus, this);
    kernel.runtimesChanged.connect(this.renderStatus, this);
    kernel.languageChanged.connect(this.repaint, this);
    kernel.reset.connect(this.markStale, this);
    this.ready = initial ? this.open(initial) : this.restore();
    void this.ready.then(() => this.startKernel());
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.kernel.statusChanged.disconnect(this.renderStatus, this);
    this.kernel.runtimesChanged.disconnect(this.renderStatus, this);
    this.kernel.languageChanged.disconnect(this.repaint, this);
    this.kernel.reset.disconnect(this.markStale, this);
    this.unbindModel?.();
    for (const timer of this.view._busyTimers.values()) clearInterval(timer);
    void this.autosave.flush().catch(() => {});
    super.dispose();
  }

  /**
   * Closed by its tab: the notebook leaves its slot for the recents list,
   * so closing is never how work disappears. A layout restore disposes
   * panels without a close request, and their slots stay for the replay.
   */
  protected onCloseRequest(): void {
    if (this.slot !== PAGE_SLOT) {
      void this.autosave.flush()
        .then(() => this.stash('replaced'))
        .then(() => clearNotebook(this.slot))
        .catch(() => {});
    }
    this.dispose();
  }

  protected onActivateRequest(): void {
    this.view.focusEditor(this.view.selectedId);
  }

  // --- the document ---------------------------------------------------

  /** The nbformat document as a save would write it. */
  get ipynb(): object {
    return toIpynb(this.model);
  }

  /** Downloads the notebook as nbformat 4. */
  saveFile(): void {
    const json = JSON.stringify(this.ipynb, null, 1);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = this.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  addCell(cellType: 'code' | 'markdown'): void {
    const cell = this.model.addCell(cellType, this.view.selectedId);
    this.view.select(cell.id);
    this.view.focusEditor(cell.id);
  }

  /** The current cell, as Ctrl+Enter runs it; `advance` is Shift+Enter. */
  runSelected({ advance = false } = {}): Promise<KernelMessage | undefined> {
    const id = this.view.selectedId ?? this.model.cells[0]?.id;
    return id ? this.runCell(id, { advance }) : Promise.resolve(undefined);
  }

  /** Every code cell, top to bottom, stopping at the first error that was not declared. */
  async runAll(): Promise<void> {
    await this.runCells(this.model.cells, { notice: true });
  }

  /** The cells above the current one, or from it down. */
  async runRange(which: 'above' | 'below'): Promise<void> {
    const at = this.model.indexOf(this.view.selectedId ?? '');
    if (at === -1) return;
    await this.runCells(which === 'above' ? this.model.cells.slice(0, at) : this.model.cells.slice(at));
  }

  /** Select a cell and bring it into view: what an outline entry does. */
  jumpTo(cellId: string): void {
    const node = this.view.cellNode(cellId);
    if (!node) return;
    this.view.select(cellId);
    node.scrollIntoView({ block: 'start' });
  }

  // depth: boot and the model binding

  private async restore(): Promise<void> {
    let restored: LabModel | null = null;
    try {
      const record = await loadNotebook(this.slot);
      if (record?.ipynb) {
        restored = parse(record.ipynb);
        if (record.filename) this.filename = record.filename;
      }
    } catch (err) {
      console.warn('diluvium-lab: could not restore the saved notebook', err);
    }
    if (this.isDisposed) return;
    if (restored) this.setModel(restored);
    else if (this.slot === PAGE_SLOT) this.setModel(parse(DEFAULT_NOTEBOOK));
    else {
      this.filename = NEW_FILENAME;
      this.setModel(blankModel());
      this.scheduleAutosave();
    }
    this.renderStatus();
  }

  /** Parse, adopt, autosave, remember; a bad document throws before anything changes. */
  private async open({ text, name, origin, url }: NotebookSource): Promise<void> {
    const model = parse(text);
    if (this.isDisposed) return;
    this.filename = name || DEFAULT_FILENAME;
    this.setModel(model);
    this.scheduleAutosave();
    this.renderStatus();
    try {
      await rememberRecent({ name: this.filename, title: model.title, origin, url: url ?? null, ipynb: toIpynb(model) });
    } catch { /* a recents list is a convenience */ }
  }

  private async startKernel(): Promise<void> {
    try {
      await this.kernel.start();
    } catch (err) {
      this.notify(`The kernel did not start: ${(err as Error).message}`);
    }
    if (!this.isDisposed) this.renderStatus();
  }

  private setModel(model: LabModel): void {
    this.model = model;
    this.view.setModel(model);
    this.unbindModel?.();
    this.unbindModel = model.onChange((change: { type: string; cellId?: string }) => {
      if (change.type === 'structure') this.view.render();
      else if (change.type === 'outputs') this.view.updateOutputs(change.cellId);
      else if (change.type === 'title') this.renderTitle();
      this.scheduleAutosave();
      this.edited.emit(change.type);
    });
    this.renderTitle();
    this.edited.emit('structure');
  }

  private renderTitle(): void {
    this.title.label = this.model.title || this.filename.replace(/\.ipynb$/i, '');
    this.fileNode.textContent = this.filename;
    this.changed.emit();
  }

  private scheduleAutosave(): void {
    this.setSaveStatus('pending');
    this.autosave.schedule({ ipynb: toIpynb(this.model), filename: this.filename, savedAt: Date.now() });
  }

  private setSaveStatus(state: 'pending' | 'saving' | 'saved' | 'failed'): void {
    this.saveNode.dataset.state = state;
    this.saveNode.textContent = { pending: 'unsaved changes', saving: 'saving…', saved: 'autosaved', failed: 'autosave failed' }[state];
  }

  /** The notebook goes to the lab's recents, unless it is empty, the seed, or already there. */
  private async stash(origin: NotebookSource['origin']): Promise<void> {
    const { model } = this;
    if (!model.cells.some(cell => cell.source.trim() !== '')) return;
    const sources = JSON.stringify(model.cells.map(cell => cell.source));
    if (sources === JSON.stringify(parse(DEFAULT_NOTEBOOK).cells.map(cell => cell.source))) return;
    try {
      await rememberRecent({
        name: this.filename, title: model.title, origin, url: null, ipynb: toIpynb(model),
        source: `${origin}:${Date.now().toString(36)}:${this.filename}`,
      });
    } catch { /* recents are a convenience */ }
  }

  // depth: running cells, and a control's callback

  private async runCells(cells: readonly Cell[], { notice = false } = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.node.dataset.running = 'true';
    let skipped = 0;
    try {
      for (const [index, cell] of [...cells].entries()) {
        if (cell.cell_type !== 'code' || cell.source.trim() === '') continue;
        if (expectationOf(cell) === EXPECT.NEVER_RETURNS) { skipped += 1; continue; }
        const reply = await this.runCell(cell.id);
        if (reply?.content.status === 'error') {
          if (expectationOf(cell) === EXPECT.ERROR) {
            if (this.kernel.status === STATUS.DEAD) break;
            continue;
          }
          this.view.cellNode(cell.id)?.scrollIntoView({ block: 'center' });
          if (notice) this.notify(`Run all stopped at cell ${index + 1} — the first error.`);
          break;
        }
        if (this.kernel.status === STATUS.DEAD) break;
      }
      if (skipped && notice) this.notify(`Run all stepped over ${skipped} cell${skipped === 1 ? '' : 's'} that never returns on purpose — run those yourself.`);
    } finally {
      this.running = false;
      this.node.dataset.running = 'false';
    }
  }

  private async runCell(cellId: string, { advance = false }: { advance?: boolean } = {}): Promise<KernelMessage | undefined> {
    const cell = this.model.get(cellId);
    if (!cell) return;
    if (cell.cell_type !== 'code') {
      this.view.finishMarkdownEdit(cellId);
      if (advance) this.focusNext(cellId);
      return;
    }
    if (this.kernel.status === STATUS.DEAD) {
      this.notify('The kernel is not running. Restart it from the Lab menu.');
      return;
    }
    this.view.select(cellId);
    this.view.setBusy(cellId, true);
    // Let In [*] paint before the worker takes the request.
    await new Promise(resolve => setTimeout(resolve, 0));
    const startedAt = new Date().toISOString();
    const outputs: Output[] = [];
    let reply: KernelMessage;
    try {
      reply = await this.kernel.execute(cell.source, msg => {
        const output = messageToOutput(msg);
        if (output) outputs.push(output);
      });
    } catch (err) {
      this.model.setOutputs(cellId, [{ output_type: 'error', ename: 'KernelError', evalue: (err as Error).message, traceback: [] }]);
      this.model.setExecutionTiming(cellId, startedAt, new Date().toISOString());
      this.view.setBusy(cellId, false);
      return;
    }
    this.model.setOutputs(cellId, outputs);
    this.model.setExecutionCount(cellId, reply.content.execution_count);
    this.model.setExecutionTiming(cellId, startedAt, new Date().toISOString());
    if (advance) this.focusNext(cellId);
    return reply;
  }

  private focusNext(cellId: string): void {
    const at = this.model.indexOf(cellId);
    const next = this.model.cells[at + 1] ?? this.model.addCell('code', cellId);
    this.view.cellNode(next.id)?.querySelector<HTMLElement>('[data-editor]')?.focus();
  }

  /** A control moved: at most one callback in flight, the newest value replacing any older one waiting. */
  private async widgetChanged(id: string, value: unknown, into: HTMLElement, { auto = false }: { auto?: boolean } = {}): Promise<void> {
    if (auto && this.widgetTouched.has(id)) return;
    if (!auto) this.widgetTouched.add(id);
    this.widgetQueue.set(id, { value, into, auto });
    if (this.widgetBusy) return;
    this.widgetBusy = true;
    try {
      while (this.widgetQueue.size) {
        const [next] = this.widgetQueue.keys();
        const { value: latest, into: slot, auto: wasAuto } = this.widgetQueue.get(next)!;
        this.widgetQueue.delete(next);
        if (this.kernel.status === STATUS.DEAD) {
          if (!wasAuto) this.renderWidgetOutput(slot, [], 'The kernel is not running.');
          continue;
        }
        const messages: KernelMessage[] = [];
        try {
          const reply = await this.kernel.kernel.callWidget(next, latest, msg => void messages.push(msg));
          const stale = reply?.content?.stale === true;
          if (stale && wasAuto) continue;
          this.renderWidgetOutput(slot, messages, stale ? 'This control came from a kernel that has since restarted. Run its cell again.' : null);
        } catch (err) {
          if (!wasAuto) this.renderWidgetOutput(slot, [], (err as Error).message);
        }
      }
    } finally {
      this.widgetBusy = false;
    }
  }

  private renderWidgetOutput(slot: HTMLElement, messages: KernelMessage[], note: string | null): void {
    const outputs = messages.map(messageToOutput).filter(Boolean);
    slot.replaceChildren(renderOutputs({ id: 'widget', cell_type: 'code', outputs }, new Set(), this.view.displayCtx));
    if (note) {
      const line = document.createElement('p');
      line.className = 'hint';
      line.textContent = note;
      slot.prepend(line);
    }
  }

  // depth: what the kernel's state changes on the page

  private renderStatus(): void {
    const status: KernelStatus = this.kernel.status;
    this.statusNode.textContent = status;
    this.node.dataset.kernelState = status;
    this.node.dataset.instances = this.kernel.capabilities.instances === true ? 'true' : 'false';
    // The ⋯ menu in ui.js reads this from the body; one kernel, so one answer.
    document.body.dataset.instances = this.node.dataset.instances;
    const entry = this.kernel.runtimes.find(r => r.id === this.kernel.runtime);
    this.runtimeNode.textContent = entry?.label ?? this.kernel.runtime;
  }

  private repaint(): void {
    this.view.repaintHighlights();
  }

  private markStale(): void {
    this.model.markAllStale();
  }
}
