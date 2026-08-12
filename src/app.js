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
import { NotebookModel, EXPECT, expectationOf } from './notebook/model.js';
import { toIpynb, fromIpynb, messageToOutput, IpynbError } from './notebook/ipynb.js';
import { NotebookView, renderOutputs } from './notebook/ui.js';
import { ConsoleView } from './notebook/console.js';
import { saveAutosave, loadAutosave, debounceSave, rememberRecent, listRecent, clearRecent, savePanelState, loadPanelState } from './notebook/storage.js';
import { ToolPanel } from './notebook/panel.js';
import { renderOutline } from './notebook/outline.js';
import { fetchNotebook, hostOf, describeOpenError, normaliseNotebookUrl } from './notebook/remote.js';
import { EXAMPLES, exampleById } from './notebook/examples.js';
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
      // From the vendored build, never a literal. This was `'5.5.1_build1'`
      // spelled out, and nothing passed the option -- so the dropdown
      // labelled the bundled runtime `5.5.1_build1` whatever was actually
      // in vendor/, and `entries()` filters the mirror's copy of the
      // pinned build by comparing against this string, so the mirror's
      // real build1 would also have been offered a second time. Every
      // other use of BUNDLED in this file was already right; this one
      // predated the import.
      pinnedLabel: options.pinnedLabel ?? BUNDLED.version,
      pinnedIsPrerelease: options.pinnedIsPrerelease ?? BUNDLED.stable === false,
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
    this.titleNode = document_.querySelector('[data-nb-title]');
    this.titleInput = document_.querySelector('[data-nb-title-input]');

    // Filled in from the running kernel once it starts. Until then the
    // highlighter falls back to stock Lua 5.4, which is what 5.4.7 is.
    this.language = { keywords: FALLBACK_KEYWORDS, globals: FALLBACK_GLOBALS, version: null };
    const languageInfo = () => this.language;

    this.view = new NotebookView(document_.querySelector('[data-cells]'), this.model, {
      onRun: (cellId, opts) => this.runCell(cellId, opts),
      languageInfo,
      complete: (code, cursor) => this.completeAt(code, cursor),
      compile: (code) => this.kernel.dumpBytecode(code),
      onWidget: (id, value, into) => this.widgetChanged(id, value, into),
      runInstance: (code, options) => this.kernel.runInstance(code, options),
      instancesEnabled: () => this.kernel.capabilities.instances === true,
      widgetsEnabled: () => this.kernel.capabilities.widgets === true
        && this.kernel.status !== STATUS.DEAD,
      // The panel exists a few lines down; by the time a user can select
      // anything it is there. Refresh keeps the outline's active-section
      // marker in step, and is a no-op while the panel is collapsed.
      onSelect: () => this.panel?.refresh(),
    });

    // The tool workbench: a rail on the left, one collapsible panel. The
    // outline is its first tool; anything else that earns a home on the
    // left edge registers the same way.
    this.panel = new ToolPanel(document_.querySelector('[data-workbench]'), {
      onStateChange: (state) => { savePanelState(state).catch(() => {}); },
    });
    this.panel.register({
      id: 'outline',
      label: 'Outline',
      icon: '☰',
      title: 'Outline — the notebook\'s markdown headings',
      render: (body) => renderOutline(body, {
        cells: this.model.cells,
        selectedId: this.view.selectedId,
        onJump: (cellId) => this._jumpToCell(cellId),
      }),
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
    this._bindTitle();
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

    // After the notebook, so an outline restored open has something to
    // outline on first paint rather than a flash of "no headings".
    await phase('restoring the tool panel', async () => {
      const state = await loadPanelState();
      if (state?.open) this.panel.open(state.open);
    });

    // After a notebook is on screen, so the bar appears over something
    // rather than over a blank page, and before the kernel starts, since
    // it is a question rather than a fetch.
    await phase('checking for a linked notebook', () => this._offerLinkedNotebook());

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
      // After the handshake, which is the first moment the answer is known.
      this._renderCapabilities();
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
      // Said in the label rather than shown as a colour or an icon: an
      // <option> can carry neither, and this is the one moment someone is
      // choosing between builds. Folded into an existing parenthetical
      // rather than added beside it, so the bundled prerelease reads
      // "5.5.1_build3 (bundled, prerelease)" and not "(bundled) (prerelease)".
      option.textContent = !entry.prerelease ? entry.label
        : (entry.label.endsWith(')')
          ? `${entry.label.slice(0, -1)}, prerelease)`
          : `${entry.label} (prerelease)`);
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
    this._renderTitle();
    // A new document is a new outline.
    this.panel.refresh();
  }

  /**
   * Go to a cell: select it and bring it into view. What an outline entry
   * does, and generic enough that anything else with a cell id can use it.
   */
  _jumpToCell(cellId) {
    const node = this.view.cellNode(cellId);
    if (!node) return;
    this.view.select(cellId);
    node.scrollIntoView({ block: 'start' });
  }

  _bindModel() {
    this._unbindModel?.();
    this._unbindModel = this.model.onChange((change) => {
      if (change.type === 'structure') this.view.render();
      else if (change.type === 'outputs') this.view.updateOutputs(change.cellId);
      else if (change.type === 'title') this._renderTitle();
      // Headings live in cell sources, and cells come and go -- both are
      // outline-visible. Cheap when the panel is closed (a no-op) and
      // cheap when open (a list repaint).
      if (change.type === 'structure' || change.type === 'source') this.panel.refresh();
      this._scheduleAutosave();
    });
  }

  _scheduleAutosave() {
    // The title rides inside the ipynb's own metadata rather than beside
    // it, so there is one copy and a restore cannot disagree with a save.
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
   *
   * Cells their author marked `never-returns` are stepped over. They exist
   * to be pressed **Stop** on, deliberately, one at a time; sweeping into
   * one would park the whole run on a cell that by construction never
   * finishes. Pressing Run on it yourself still runs it -- that is the
   * demonstration, and skipping it there would break the thing it teaches.
   */
  async runAll() {
    this.document.body.dataset.running = 'true';
    let skipped = 0;
    try {
      for (const cell of [...this.model.cells]) {
        if (cell.cell_type !== 'code') continue;
        if (cell.source.trim() === '') continue;
        if (expectationOf(cell) === EXPECT.NEVER_RETURNS) { skipped += 1; continue; }
        const reply = await this.runCell(cell.id);
        if (reply?.content.status === 'error') {
          this._toast('Run all stopped at the first error.', 'error');
          break;
        }
        if (this.kernel.status === STATUS.DEAD) break;
      }
      if (skipped) {
        this._toast(`Run all stepped over ${skipped} cell${skipped === 1 ? '' : 's'} that never returns on purpose — run those yourself.`);
      }
    } finally {
      this.document.body.dataset.running = 'false';
    }
  }

  /**
   * A control moved. Run its callback and show whatever it produced.
   *
   * Two things make this more than a call. A slider fires on every pixel
   * of a drag and `run_lua` cannot be interrupted, so the calls are
   * **coalesced**: at most one is in flight, and the newest value waiting
   * behind it replaces any older one, which is what keeps a drag
   * responsive instead of queueing forty runs of a callback that takes 20
   * ms each. And the output goes into the control's own slot rather than
   * the cell's output list, because it is the answer to this drag rather
   * than a new result -- a saved notebook should carry the chart the cell
   * produced, not the last frame of someone playing with a slider.
   */
  async widgetChanged(id, value, into, { auto = false } = {}) {
    this._widgetQueue ??= new Map();
    this._widgetTouched ??= new Set();

    // An automatic first call is "show the initial state". Once someone
    // has moved the control, the initial state is stale information, and
    // a re-render firing it again would throw away what they asked for.
    if (auto && this._widgetTouched.has(id)) return;
    if (!auto) this._widgetTouched.add(id);

    this._widgetQueue.set(id, { value, into, auto });
    if (this._widgetBusy) return;

    this._widgetBusy = true;
    try {
      while (this._widgetQueue.size) {
        const [next] = this._widgetQueue.keys();
        const { value: latest, into: slot, auto } = this._widgetQueue.get(next);
        this._widgetQueue.delete(next);

        // Nothing an automatic call finds is worth a sentence. It fires on
        // every render, including the render of a notebook just opened
        // from a file, where every control is necessarily disconnected --
        // a warning per control would be the first thing such a reader saw.
        if (this.kernel.status === STATUS.DEAD) {
          if (!auto) this._renderWidgetOutput(slot, [], 'The kernel is not running.');
          continue;
        }
        const messages = [];
        try {
          const reply = await this.kernel.callWidget(next, latest, (msg) => messages.push(msg));
          const stale = reply?.content?.stale === true;
          if (stale && auto) continue;
          this._renderWidgetOutput(slot, messages, stale
            ? 'This control came from a kernel that has since restarted. Run its cell again.'
            : null);
        } catch (err) {
          if (!auto) this._renderWidgetOutput(slot, [], err.message);
        }
      }
    } finally {
      this._widgetBusy = false;
    }
  }

  _renderWidgetOutput(slot, messages, note) {
    if (!slot) return;
    const outputs = messages.map(messageToOutput).filter(Boolean);
    // A throwaway cell, so the existing output renderer draws these --
    // charts, text and tracebacks alike -- with no second implementation.
    const cell = { id: 'widget', cell_type: 'code', outputs };
    slot.replaceChildren(renderOutputs(cell, new Set(), this.view.displayCtx));
    if (note) {
      const line = this.document.createElement('p');
      line.className = 'hint';
      line.textContent = note;
      slot.prepend(line);
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
      await this._open(await file.text(), { name: file.name || 'notebook.ipynb', origin: 'file' });
    } catch (err) {
      this._toast(describeOpenError(err), 'error');
    }
  }

  /**
   * Open a notebook from a URL.
   *
   * Every caller is something somebody pressed. The Lab makes no request
   * at load -- a hard constraint -- so a `?open=` link raises a bar and
   * waits rather than fetching, and this is what its Open button calls.
   */
  async openUrl(input) {
    try {
      const { text, url, name, rewrittenFrom } = await fetchNotebook(input);
      await this._open(text, { name, origin: 'url', url });
      this._toast(rewrittenFrom
        ? `Opened ${name} (rewritten to its raw URL)`
        : `Opened ${name} from ${hostOf(url)}`);
      return true;
    } catch (err) {
      this._toast(describeOpenError(err), 'error');
      return false;
    }
  }

  /**
   * The one place a notebook becomes *this* notebook.
   *
   * Parse, adopt, autosave, remember. Remembering is last and its failure
   * is swallowed: a recents list is a convenience, and it must never be
   * the reason a notebook does not open.
   */
  async _open(text, { name, origin, url = null }) {
    const model = fromIpynb(text);
    this.filename = name || 'notebook.ipynb';
    this._setModel(model);
    this._scheduleAutosave();
    if (origin === 'file') this._toast(`Opened ${this.filename}`);

    try {
      await rememberRecent({
        name: this.filename, title: model.title, origin, url, ipynb: toIpynb(model),
      });
    } catch { /* a full or blocked database is not a failure to open */ }
    return model;
  }

  /**
   * A `?open=<url>` link, which asks before it fetches.
   *
   * The constraint is "no external requests at load", and a link somebody
   * sent you is not a decision you made -- so this shows what it would
   * talk to and waits. The parameter is dropped from the address bar
   * either way, so a reload does not ask twice.
   */
  _offerLinkedNotebook() {
    const view = this.document.defaultView;
    const params = new URLSearchParams(view?.location?.search ?? '');
    const wanted = params.get('open');
    if (!wanted) return;

    const banner = this.document.querySelector('[data-link-banner]');
    const forget = () => {
      try {
        const here = new URL(view.location.href);
        here.searchParams.delete('open');
        view.history.replaceState(null, '', here.href);
      } catch { /* no history in this context */ }
    };

    let target;
    try {
      target = normaliseNotebookUrl(wanted).url;
    } catch (err) {
      forget();
      this._toast(describeOpenError(err), 'error');
      return;
    }
    if (!banner) return;

    const open = this.document.createElement('button');
    open.type = 'button';
    open.dataset.linkOpen = 'true';
    open.textContent = 'Open it';
    const dismiss = this.document.createElement('button');
    dismiss.type = 'button';
    dismiss.dataset.linkDismiss = 'true';
    dismiss.textContent = 'Not now';

    const where = this.document.createElement('span');
    where.className = 'link-where';
    where.textContent = hostOf(target);
    const said = this.document.createElement('span');
    said.textContent = 'This link wants to open a notebook from ';
    const after = this.document.createElement('span');
    after.textContent = '. Nothing has been fetched yet.';

    banner.replaceChildren(said, where, after, open, dismiss);
    banner.hidden = false;

    const close = () => { banner.hidden = true; banner.replaceChildren(); forget(); };
    open.addEventListener('click', async () => { close(); await this.openUrl(target); });
    dismiss.addEventListener('click', close);
  }

  // --- the examples gallery -----------------------------------------

  /**
   * The notebooks bundled with the page.
   *
   * Bundled rather than fetched, which is the whole reason this works: the
   * baked single-file build has no `notebooks/` to fetch from, and **Start
   * here** breaking in exactly the situation somebody reaches for it would
   * be the worst button in the page. See scripts/bundle-examples.mjs.
   */
  showExamples() {
    const dialog = this.document.querySelector('[data-examples]');
    const list = this.document.querySelector('[data-examples-list]');
    if (!dialog || !list) return;

    list.replaceChildren(...EXAMPLES.map((example) => {
      const button = this.document.createElement('button');
      button.type = 'button';
      button.className = 'example-entry';
      button.dataset.exampleOpen = example.id;

      const title = this.document.createElement('span');
      title.className = 'example-title';
      title.textContent = example.title;
      const count = this.document.createElement('span');
      count.className = 'example-count';
      count.textContent = `${example.cells} cells`;
      const summary = this.document.createElement('span');
      summary.className = 'example-summary';
      summary.textContent = example.summary;

      button.append(title, count, summary);
      button.addEventListener('click', () => { dialog.close(); this.openExample(example.id); });
      return button;
    }));
    dialog.showModal();
  }

  /**
   * Open one, by id.
   *
   * Through the same `_open` as a file or a URL, so it is remembered, it
   * autosaves, and its title comes out of its own metadata rather than
   * being set here.
   */
  async openExample(id) {
    const example = exampleById(id);
    if (!example) { this._toast(`There is no example called ${id}.`, 'error'); return; }
    try {
      await this._open(example.source, { name: example.file, origin: 'example' });
      this._toast(`Opened ${example.title}`);
    } catch (err) {
      // A bundled notebook that will not parse is this repository's bug,
      // not the reader's, and should say so rather than blaming the file.
      this._toast(`The bundled ${example.file} could not be opened: ${describeOpenError(err)}`, 'error');
    }
  }

  // --- recents ------------------------------------------------------

  async showRecent() {
    const dialog = this.document.querySelector('[data-recent]');
    const list = this.document.querySelector('[data-recent-list]');
    if (!dialog || !list) return;
    let entries = [];
    try {
      entries = await listRecent();
    } catch { /* fall through to the empty state */ }

    list.replaceChildren(...(entries.length ? entries.map((entry) => {
      const button = this.document.createElement('button');
      button.type = 'button';
      button.className = 'recent-entry';
      button.dataset.recentOpen = String(entry.openedAt);

      const name = this.document.createElement('span');
      name.className = 'recent-name';
      // The notebook's own name when it has one; the filename otherwise.
      // A list of five `notebook.ipynb`s is not a list.
      name.textContent = entry.title || entry.name;
      const where = this.document.createElement('span');
      where.className = 'recent-where';
      where.textContent = entry.url ?? (entry.origin === 'file' ? 'opened from a file' : entry.source);
      const when = this.document.createElement('span');
      when.className = 'recent-when';
      when.textContent = relativeTime(entry.openedAt);

      button.append(name, where, when);
      button.addEventListener('click', () => { dialog.close(); this.openRecent(entry); });
      return button;
    }) : [emptyRecent(this.document)]));

    dialog.showModal();
  }

  /**
   * Reopen a remembered notebook.
   *
   * From the stored copy, not by re-fetching. The copy is what makes a
   * *file* reopenable at all -- a browser gives no way to re-read one
   * without asking again -- and it means a URL entry still opens with the
   * network down. An entry too large to have been kept falls back to its
   * URL, and says so if it has none.
   */
  async openRecent(entry) {
    if (entry.ipynb) {
      try {
        await this._open(entry.ipynb, { name: entry.name, origin: entry.origin, url: entry.url });
        this._toast(`Opened ${entry.name}`);
        return;
      } catch (err) {
        this._toast(describeOpenError(err), 'error');
        return;
      }
    }
    if (entry.url) { await this.openUrl(entry.url); return; }
    this._toast(`${entry.name} was too large to keep a copy of, and it came from a file.`, 'error');
  }

  // --- the notebook's name ------------------------------------------

  /**
   * Paint the name, and the document title with it.
   *
   * The tab is worth updating too: someone with four Labs open is choosing
   * between them by their tab titles, and "Diluvium Lab" four times is no
   * choice at all.
   */
  _renderTitle() {
    const title = this.model.title;
    if (this.titleNode) {
      this.titleNode.textContent = title || 'Untitled notebook';
      this.titleNode.dataset.untitled = title ? 'false' : 'true';
    }
    const base = 'Diluvium Lab';
    this.document.title = title ? `${title} — ${base}` : base;
  }

  /**
   * Swap the label for a field, Colab-style.
   *
   * A button that becomes an input rather than a `contenteditable`:
   * contenteditable accepts *pasted markup*, and the rule in this codebase
   * is that nothing reaches the DOM as markup. It also gets focus, Enter
   * and Escape for free, which contenteditable does not.
   */
  _beginRename() {
    if (!this.titleNode || !this.titleInput || !this.titleInput.hidden) return;
    this.titleInput.value = this.model.title;
    this.titleNode.hidden = true;
    this.titleInput.hidden = false;
    this.titleInput.focus();
    this.titleInput.select();
  }

  _endRename(commit) {
    if (!this.titleInput || this.titleInput.hidden) return;
    const next = this.titleInput.value;
    this.titleInput.hidden = true;
    if (this.titleNode) this.titleNode.hidden = false;
    if (!commit) return;
    // Only autosave when something actually changed: `setTitle` reports
    // that, so pressing Enter on an unchanged name writes nothing.
    if (this.model.setTitle(next)) this._scheduleAutosave();
  }

  _bindTitle() {
    this.titleNode?.addEventListener('click', () => this._beginRename());
    this.titleInput?.addEventListener('blur', () => this._endRename(true));
    this.titleInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); this._endRename(true); this.titleNode?.focus(); }
      // Escape restores rather than commits, which is the whole reason a
      // field is better here than an always-live contenteditable.
      else if (event.key === 'Escape') { event.preventDefault(); this._endRename(false); this.titleNode?.focus(); }
    });
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

    on('examples', () => this.showExamples());
    this.document.querySelector('[data-examples-close]')
      ?.addEventListener('click', () => this.document.querySelector('[data-examples]')?.close());

    on('recent', () => this.showRecent());
    this.document.querySelector('[data-recent-close]')
      ?.addEventListener('click', () => this.document.querySelector('[data-recent]')?.close());
    this.document.querySelector('[data-recent-clear]')?.addEventListener('click', async () => {
      try { await clearRecent(); } catch { /* nothing to forget */ }
      this.document.querySelector('[data-recent]')?.close();
      this._toast('Recent notebooks forgotten.');
    });

    const urlDialog = this.document.querySelector('[data-open-url]');
    const urlInput = this.document.querySelector('[data-open-url-input]');
    on('open-url', () => {
      if (!urlDialog) return;
      if (urlInput) urlInput.value = '';
      urlDialog.showModal();
    });
    this.document.querySelector('[data-open-url-cancel]')
      ?.addEventListener('click', () => urlDialog?.close());
    // On the form rather than the button, so Enter in the field works --
    // which is how a pasted URL is actually submitted.
    this.document.querySelector('[data-open-url-form]')?.addEventListener('submit', () => {
      const value = urlInput?.value ?? '';
      if (value.trim()) this.openUrl(value);
    });

    const fileInput = this.document.querySelector('[data-file-input]');
    on('open', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (file) await this.openFile(file);
      fileInput.value = '';
    });
  }

  /**
   * Publish what the running build can do, as body attributes.
   *
   * Separate from `_renderStatus`, and it has to be: **capabilities
   * arrive after the last status change.** The worker's own kernel
   * publishes `idle` while starting, which crosses the boundary and marks
   * the proxy idle -- and only then does the handshake deliver
   * `capabilities`. By that point `_setStatus(IDLE)` is a no-op, so no
   * further status event ever fires and anything reading capabilities
   * from a status handler is reading them one beat too early.
   *
   * So this is called from the status handler *and* after the kernel
   * starts *and* after a runtime switch. Cheap, idempotent, and the only
   * arrangement that is right at every one of those moments.
   */
  _renderCapabilities() {
    this.document.body.dataset.instances =
      this.kernel.capabilities?.instances === true ? 'true' : 'false';
  }

  _renderStatus(status) {
    this.document.body.dataset.kernelState = status;
    this._renderCapabilities();
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
      // Stated, because "prerelease" upstream does not mean "unfinished" --
      // it can mean the supported configuration is narrower than the
      // feature set, which is a thing a bug report needs to carry.
      ['Release status', releaseStatus(bundled ? BUNDLED.stable : !remote?.prerelease)],
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

/**
 * How to describe a build's stability in the About panel.
 *
 * Three states, not two: `null` means nothing said so, which is different
 * from "it is fine". `scripts/fetch-runtime.sh` records `null` when it
 * could not reach the changelog, and a mirror index may carry no flag at
 * all.
 */
function releaseStatus(stable) {
  if (stable === true) return 'release';
  if (stable === false) return 'prerelease — upstream marks this build not stable';
  return 'not stated';
}

/**
 * "3 minutes ago". Coarse on purpose: a recents list answers "which one",
 * not "exactly when", and a precise timestamp is harder to read at a
 * glance than a rough one.
 */
export function relativeTime(then, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(then).toISOString().slice(0, 10);
}

function emptyRecent(document_) {
  const p = document_.createElement('p');
  p.className = 'recent-empty';
  p.dataset.recentEmpty = 'true';
  p.textContent = 'Nothing yet. Notebooks you open from a file or a URL turn up here.';
  return p;
}
