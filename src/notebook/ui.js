// Rendering the notebook.
//
// Plain modules and the DOM, which is a hard constraint and, at this size,
// also just the right tool. The one rule that keeps it from turning into a
// framework: structural changes (add / delete / move / type change) rebuild
// the cell list, and everything else patches in place. Rebuilding on every
// keystroke would throw away the caret.

import { el } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { outputText, bundleOf } from './ipynb.js';
import { renderBundle } from './display.js';
import { HighlightedEditor } from './editor.js';
import { hintFor, tipForOutput } from './hints.js';
import { BytecodeView } from './bytecode-view.js';
import { SandboxView } from './sandbox-view.js';
import { EXPECT, expectationOf } from './model.js';

/**
 * Display caps. The kernel's ceiling is far higher (see wasi.js): these
 * exist so a 50,000-line cell does not lock the tab laying out text nobody
 * asked to read, and "show all" is always available because the output was
 * retained rather than thrown away.
 */
export const SOFT_MAX_LINES = 200;
export const SOFT_MAX_BYTES = 64 * 1024;

/** performance.now(), or Date-free fallback -- only relative deltas are used. */
function performanceNow() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
}

function button(action, label, title) {
  // `title` is a tooltip and a *fallback* accessible name -- it is not
  // announced reliably, and several of these buttons are a single glyph
  // (`↑`, `✕`) that a screen reader either skips or reads as punctuation.
  // aria-label is the name; title stays for the sighted tooltip.
  return el('button', {
    type: 'button', 'data-action': action,
    title: title ?? label, 'aria-label': title ?? label,
  }, [label]);
}

/**
 * A cell that misbehaves on purpose, saying so before you press anything.
 *
 * The notebooks around it already explain in prose, but prose above a cell
 * is read after the surprise as often as before it. This is the same fact
 * where the surprise happens. Absent for every ordinary cell, which is
 * almost all of them.
 */
const EXPECT_BADGE = {
  [EXPECT.ERROR]: {
    label: 'errors on purpose',
    title: 'This cell raises deliberately — the error below is the lesson, not a fault.',
  },
  [EXPECT.NEVER_RETURNS]: {
    label: 'never returns',
    title: 'This cell runs forever on purpose. Run all steps over it; run it yourself and press Stop.',
  },
};

function expectBadge(cell) {
  const badge = EXPECT_BADGE[expectationOf(cell)];
  if (!badge) return null;
  return el('span', {
    class: 'expect-badge', 'data-expect': expectationOf(cell), title: badge.title,
  }, [badge.label]);
}

/** Trim text for display, reporting what was held back. */
export function capText(text, { expanded = false } = {}) {
  if (expanded) return { text, hidden: 0, total: countLines(text) };
  const total = countLines(text);
  if (total <= SOFT_MAX_LINES && text.length <= SOFT_MAX_BYTES) {
    return { text, hidden: 0, total };
  }
  let cut = 0;
  let seen = 0;
  while (seen < SOFT_MAX_LINES && cut < text.length && cut < SOFT_MAX_BYTES) {
    const next = text.indexOf('\n', cut);
    if (next === -1) { cut = text.length; break; }
    cut = next + 1;
    seen += 1;
  }
  if (cut > SOFT_MAX_BYTES) cut = SOFT_MAX_BYTES;
  return { text: text.slice(0, cut), hidden: total - countLines(text.slice(0, cut)), total };
}

function countLines(text) {
  if (text === '') return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

/**
 * Hint text carries `code spans`. Built as nodes rather than assigned as
 * HTML: hints are our own strings today, but the rule in this codebase is
 * that nothing reaches the DOM as markup, so there is no version of this
 * that can be got wrong later.
 */
function withCodeSpans(text) {
  return String(text).split(/`([^`]+)`/).map((piece, i) => (
    i % 2 === 1 ? el('code', {}, [piece]) : piece
  )).filter((piece) => piece !== '');
}

export function renderOutputs(cell, expandedSet, displayCtx = {}) {
  // Output arrives asynchronously, so a screen reader user gets nothing
  // unless the region announces itself. `polite` rather than `assertive`:
  // a cell finishing should not interrupt what is already being read.
  const wrap = el('div', {
    class: 'outputs', 'data-outputs': cell.id,
    role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false',
  });
  for (const [i, output] of (cell.outputs ?? []).entries()) {
    const key = `${cell.id}:${i}`;
    const expanded = expandedSet.has(key);
    const text = outputText(output);
    const capped = capText(text, { expanded });

    const kind = output.output_type;
    const node = el('div', {
      class: `output output-${kind}`,
      'data-output-type': kind,
      'data-stream': kind === 'stream' ? output.name : null,
    });

    if (kind === 'error') {
      node.appendChild(el('div', { class: 'error-name', 'data-error-name': true },
        [`${output.ename}: ${output.evalue}`]));
      // The runtime's own words first, always. The hint is additive: a
      // wrong guess costs one confusing sentence, and rewriting the error
      // would cost the ability to search for it.
      const hint = hintFor(output.evalue);
      if (hint) node.appendChild(el('p', { class: 'hint', 'data-hint': true }, withCodeSpans(hint)));
      if ((output.traceback ?? []).length) {
        node.appendChild(el('pre', { class: 'traceback' }, [capped.text]));
      }
    } else if (kind === 'execute_result') {
      node.appendChild(el('span', { class: 'result-prompt' },
        [`Out[${output.execution_count ?? ' '}]:`]));
      node.appendChild(el('pre', {}, [capped.text]));
    } else if (kind === 'display_data') {
      // The richest representation the page understands, falling back to
      // the text every bundle carries. A notebook written by a newer Lab
      // -- or by something else entirely -- therefore still says
      // something here rather than showing a blank.
      const drawn = renderBundle(bundleOf(output), displayCtx);
      node.appendChild(drawn ?? el('pre', {}, [capped.text]));
    } else {
      node.appendChild(el('pre', {}, [capped.text]));
      const tip = tipForOutput(text);
      if (tip) node.appendChild(el('p', { class: 'hint', 'data-tip': true }, withCodeSpans(tip)));
    }

    if (capped.hidden > 0) {
      node.appendChild(el('button', {
        type: 'button', class: 'show-all',
        'data-action': 'show-all', 'data-output-key': key,
      }, [`show all ${capped.total.toLocaleString()} lines (${capped.hidden.toLocaleString()} hidden)`]));
    } else if (expanded && countLines(text) > SOFT_MAX_LINES) {
      node.appendChild(el('button', {
        type: 'button', class: 'show-all',
        'data-action': 'show-less', 'data-output-key': key,
      }, ['show less']));
    }

    wrap.appendChild(node);
  }
  return wrap;
}

export class NotebookView {
  /**
   * @param {HTMLElement} root
   * @param {import('./model.js').NotebookModel} model
   * @param {Record<string, Function>} handlers
   */
  constructor(root, model, handlers = {}) {
    this.root = root;
    this.model = model;
    this.handlers = handlers;
    this.expanded = new Set();
    this.editingMarkdown = new Set();
    this.showingBytecode = new Set();
    this.bytecodeViews = new Map();
    this.showingSandbox = new Set();
    this.sandboxViews = new Map();
    // Highlighting follows the *running* kernel's language, so a version
    // switch re-colours without a table in this repo being edited.
    this.languageInfo = handlers.languageInfo ?? (() => ({}));
    this.editors = new Map();

    // What a `display_data` output needs to draw itself: somewhere to send
    // a control's new value, and whether the running kernel can take it.
    // Read through a getter rather than captured, because both change when
    // the kernel is swapped and a chart rendered before the swap must not
    // hold the old one.
    this.displayCtx = {
      // All four arguments: the fourth carries {auto: true} for a
      // control's initial render, and dropping it made every first paint
      // look like a user's drag.
      onWidget: (id, value, into, opts) => this.handlers.onWidget?.(id, value, into, opts),
      get widgetsEnabled() { return handlers.widgetsEnabled?.() !== false; },
    };

    // The current cell, independent of focus. `:focus-within` vanishes
    // the moment focus moves to the page toolbar, which is exactly when
    // "which cell is current" matters most -- at the instant you click
    // Run all, nothing on the page would be marked. Selection persists
    // until something else is selected.
    this.selectedId = null;
    this._busyTimers = new Map();

    this.root.addEventListener('click', (event) => this._onClick(event));
    this.root.addEventListener('input', (event) => this._onInput(event));
    this.root.addEventListener('keydown', (event) => this._onKeydown(event));
    this.root.addEventListener('dblclick', (event) => this._onDoubleClick(event));
    // pointerdown as well as focusin: tapping a cell's blank margin
    // focuses nothing, but it should still make that cell current.
    this.root.addEventListener('focusin', (event) => this.select(this._cellIdFor(event.target)));
    this.root.addEventListener('pointerdown', (event) => this.select(this._cellIdFor(event.target)));
  }

  /** Make a cell current. Passing null or an unknown id changes nothing. */
  select(cellId) {
    if (!cellId || cellId === this.selectedId || !this.model.get(cellId)) return;
    this.selectedId = cellId;
    this._applySelection();
  }

  _applySelection() {
    // Selection can outlive the cell it pointed at (delete, open file).
    // Falling back to the first cell keeps "there is always a current
    // cell" true, which is what folding and the keyboard will build on.
    if (this.selectedId && !this.model.get(this.selectedId)) this.selectedId = null;
    if (!this.selectedId) this.selectedId = this.model.cells[0]?.id ?? null;
    for (const node of this.root.querySelectorAll('[data-cell-id]')) {
      const selected = node.dataset.cellId === this.selectedId;
      node.dataset.selected = selected ? 'true' : 'false';
      if (selected) node.setAttribute('aria-current', 'true');
      else node.removeAttribute('aria-current');
    }
    // Selection is state other surfaces care about -- the outline marks
    // the section the selection is in -- so it is reported, not polled.
    this.handlers.onSelect?.(this.selectedId);
  }

  setModel(model) {
    this.model = model;
    this.expanded.clear();
    this.editingMarkdown.clear();
    this.render();
  }

  cellNode(cellId) { return this.root.querySelector(`[data-cell-id="${cellId}"]`); }

  /** Repaint every editor -- after a kernel swap changes the keyword set. */
  repaintHighlights() {
    for (const editor of this.editors.values()) editor.paint();
  }

  render() {
    const active = document.activeElement;
    const focusedCell = active?.closest?.('[data-cell-id]')?.dataset.cellId ?? null;
    const caret = active?.selectionStart ?? null;

    this.editors.clear();   // the old nodes, and their listeners, go with them
    this.bytecodeViews.clear();
    this.sandboxViews.clear();
    for (const timer of this._busyTimers.values()) clearInterval(timer);
    this._busyTimers.clear();
    this.root.replaceChildren(...this.model.cells.map((cell, i) => this._renderCell(cell, i)));

    if (focusedCell) {
      const editor = this.cellNode(focusedCell)?.querySelector('[data-editor]');
      if (editor && !editor.hidden) {
        editor.focus();
        if (caret !== null) editor.setSelectionRange(caret, caret);
      }
    }
    this._applySelection();
  }

  updateOutputs(cellId) {
    const node = this.cellNode(cellId);
    const cell = this.model.get(cellId);
    if (!node || !cell) return;
    node.querySelector('[data-outputs]')?.replaceWith(renderOutputs(cell, this.expanded, this.displayCtx));
    const prompt = node.querySelector('[data-prompt]');
    if (prompt) prompt.textContent = promptText(cell);
    node.dataset.busy = 'false';
    // The elapsed clock has to be stopped here, not merely overwritten.
    // This cleared `data-busy` and left the interval running, so
    // `_applyTiming` wrote the real duration and the tick overwrote it
    // 100ms later -- a cell that answered `3` instantly went on counting
    // for as long as the page was open. Nothing called `setBusy(id,
    // false)` on the success path, and nothing should have to: finishing
    // is what having outputs *means*.
    this._stopBusyTimer(cellId);
    // A cell that succeeded and a cell that failed used to leave the same
    // trace -- both just `data-busy="false"`. runStateOf tells them apart:
    // ok, error or stale, or absent for a cell that has never run.
    this._applyRunState(node, cell);
    this._applyTiming(node, cell);
  }

  _applyRunState(node, cell) {
    const state = runStateOf(cell);
    if (state) node.dataset.runState = state;
    else delete node.dataset.runState;
  }

  _applyTiming(node, cell) {
    const slot = node.querySelector('[data-timing]');
    if (!slot) return;
    const ms = durationOf(cell);
    slot.textContent = ms === null ? '' : formatDuration(ms);
    slot.hidden = ms === null;
  }

  setBusy(cellId, busy) {
    const node = this.cellNode(cellId);
    if (!node) return;
    node.dataset.busy = busy ? 'true' : 'false';
    const prompt = node.querySelector('[data-prompt]');
    if (prompt && busy) prompt.textContent = 'In [*]:';
    // While busy, show a live-updating elapsed clock. A cell that has been
    // running for eight seconds looks the same as one that just started
    // otherwise, which is the difference between "be patient" and "press
    // Stop". Cleared and replaced by the final duration in updateOutputs.
    const slot = node.querySelector('[data-timing]');
    this._stopBusyTimer(cellId);
    if (busy && slot) {
      const started = performanceNow();
      slot.hidden = false;
      const tick = () => { slot.textContent = formatDuration(performanceNow() - started); };
      tick();
      this._busyTimers.set(cellId, setInterval(tick, 100));
    }
  }

  /** Stop a cell's elapsed clock, if it has one. Safe to call twice. */
  _stopBusyTimer(cellId) {
    const timer = this._busyTimers.get(cellId);
    if (timer === undefined) return;
    clearInterval(timer);
    this._busyTimers.delete(cellId);
  }

  _renderCell(cell, index) {
    const isCode = cell.cell_type === 'code';
    // An empty markdown cell renders as nothing, so showing its rendered
    // view would leave a blank strip with no obvious way in. A new one
    // opens for editing until it has something to show.
    const editing = isCode || this.editingMarkdown.has(cell.id) || cell.source.trim() === '';

    const folded = isCode && this.model.isFolded(cell.id);

    const editor = el('textarea', {
      'data-editor': true,
      spellcheck: 'false',
      rows: Math.max(1, cell.source.split('\n').length),
      'aria-label': `${cell.cell_type} cell ${index + 1}`,
      // Only an empty editor shows it, which is exactly the moment the
      // two keys worth knowing are not yet discoverable any other way.
      placeholder: isCode
        ? '-- Ctrl+Enter runs · Ctrl+Space completes'
        : 'Write markdown — Ctrl+Enter renders it',
    });
    editor.value = cell.source;
    editor.hidden = !editing || folded;
    // Read-only is enforced in three layers: the textarea's readOnly
    // blocks typing, insertText refuses synthetic edits (Tab, Enter,
    // completion), and _onInput drops anything that still slips through.
    editor.readOnly = this.handlers.readOnly?.() === true;

    const tools = el('div', { class: 'cell-tools' }, [
      isCode ? button('run', 'Run', 'Run this cell (Ctrl+Enter)') : button('run', 'Render', 'Render (Ctrl+Enter)'),
      isCode ? button('bytecode', 'Bytecode', 'Compile this cell and read the bytecode — nothing runs') : null,
      // Always built, hidden by CSS when the running build has no `dv_`
      // ABI. Deciding here instead looked right and was not: cells render
      // before the kernel has answered what it can do -- and in the worker
      // path before the handshake has even happened -- so the button was
      // absent on every first paint. Hiding it from a body attribute also
      // means switching runtimes updates it without a re-render.
      isCode ? button('sandbox', 'Sandbox', 'Run this cell as an isolated instance with an instruction budget') : null,
      isCode ? button('fullscreen', '⛶', 'Show this cell\'s output full screen') : null,
      button('to-code', 'Code', 'Turn into a code cell'),
      button('to-markdown', 'Markdown', 'Turn into a markdown cell'),
      button('move-up', '↑', 'Move up'),
      button('move-down', '↓', 'Move down'),
      button('insert-below', '+', 'Insert a cell below'),
      button('delete', '✕', 'Delete this cell'),
    ]);

    // A fold toggle in the gutter, next to the prompt where the eye already
    // is. Only code cells fold -- a markdown cell folds by rendering.
    const foldToggle = isCode
      ? el('button', {
          type: 'button', class: 'fold-toggle', 'data-action': 'fold',
          title: folded ? 'Unfold this cell' : 'Fold this cell',
          'aria-label': folded ? 'Unfold this cell' : 'Fold this cell',
          'aria-expanded': folded ? 'false' : 'true',
        }, [folded ? '▸' : '▾'])
      : null;

    // A one-line preview when folded, so a folded cell is identifiable
    // without unfolding it. First non-blank line, trimmed.
    const firstLine = (cell.source.split('\n').find((l) => l.trim() !== '') ?? '').trim();
    const foldPreview = folded
      ? el('button', {
          type: 'button', class: 'fold-preview', 'data-action': 'fold',
          title: 'Unfold this cell',
        }, [firstLine || '(empty cell)'])
      : null;

    const kids = [
      el('div', { class: 'cell-head' }, [
        foldToggle,
        el('span', { class: 'prompt', 'data-prompt': true }, [promptText(cell)]),
        isCode ? el('span', { class: 'timing', 'data-timing': true, hidden: true }) : null,
        isCode ? expectBadge(cell) : null,
        tools,
      ]),
      foldPreview,
      editor,
    ];

    if (isCode) {
      kids.push(renderOutputs(cell, this.expanded, this.displayCtx));
      const panel = el('div', { class: 'bytecode', 'data-bytecode': cell.id });
      panel.hidden = !this.showingBytecode.has(cell.id);
      kids.push(panel);

      const sandbox = el('div', { class: 'sandbox', 'data-sandbox': cell.id });
      sandbox.hidden = !this.showingSandbox.has(cell.id);
      kids.push(sandbox);
    } else {
      const rendered = el('div', { class: 'rendered', 'data-rendered': true });
      rendered.innerHTML = renderMarkdown(cell.source);
      rendered.hidden = editing;
      kids.push(rendered);
    }

    const node = el('section', {
      class: 'cell',
      'data-cell-id': cell.id,
      'data-cell-type': cell.cell_type,
      'data-index': index,
      'data-editing': editing ? 'true' : 'false',
      'data-busy': 'false',
      'data-folded': folded ? 'true' : 'false',
      'data-run-state': runStateOf(cell) ?? false,
      'data-selected': cell.id === this.selectedId ? 'true' : 'false',
    }, kids);
    if (isCode) this._applyTiming(node, cell);

    // Only code cells get highlighted -- running a Lua tokenizer over prose
    // would colour the word "for" in an English sentence.
    if (isCode) {
      this.editors.set(cell.id, new HighlightedEditor(editor, this.languageInfo, {
        complete: this.handlers.complete,
      }));
    }
    return node;
  }

  // --- events -------------------------------------------------------

  _cellIdFor(target) { return target.closest('[data-cell-id]')?.dataset.cellId ?? null; }

  _onClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const cellId = this._cellIdFor(target);

    if (action === 'show-all' || action === 'show-less') {
      const key = target.dataset.outputKey;
      if (action === 'show-all') this.expanded.add(key); else this.expanded.delete(key);
      this.updateOutputs(cellId);
      return;
    }
    if (!cellId) return;

    switch (action) {
      case 'run': this.handlers.onRun?.(cellId); break;
      case 'fold': this.model.setFolded(cellId, !this.model.isFolded(cellId)); break;
      case 'fullscreen': this._fullscreenOutputs(cellId); break;
      case 'bytecode': this.toggleBytecode(cellId); break;
      case 'sandbox': this.toggleSandbox(cellId); break;
      case 'delete': this.model.deleteCell(cellId); break;
      case 'move-up': this.model.moveCell(cellId, -1); break;
      case 'move-down': this.model.moveCell(cellId, +1); break;
      case 'insert-below': this.model.addCell('code', cellId); break;
      case 'to-code': this._toType(cellId, 'code'); break;
      case 'to-markdown': this._toType(cellId, 'markdown'); break;
      default: break;
    }
  }

  /**
   * Put a cell's output full screen, or take it back.
   *
   * Uses the platform Fullscreen API on the outputs element itself, so the
   * height cap and the page chrome both fall away and the reader gets the
   * whole thing. A no-op where the API is unavailable (some embedded web
   * views) -- the height cap still scrolls, so nothing is lost, only the
   * lift.
   */
  _fullscreenOutputs(cellId) {
    const outputs = this.cellNode(cellId)?.querySelector('[data-outputs]');
    if (!outputs) return;
    const doc = outputs.ownerDocument;
    if (doc.fullscreenElement === outputs) { doc.exitFullscreen?.(); return; }
    outputs.requestFullscreen?.().catch(() => {});
  }

  /** Show or hide the bytecode panel, compiling the first time it opens. */
  toggleBytecode(cellId) {
    const panel = this.cellNode(cellId)?.querySelector('[data-bytecode]');
    if (!panel) return;
    if (this.showingBytecode.has(cellId)) {
      this.showingBytecode.delete(cellId);
      this.bytecodeViews.delete(cellId);
      panel.hidden = true;
      panel.replaceChildren();
      return;
    }
    this.showingBytecode.add(cellId);
    panel.hidden = false;
    const view = new BytecodeView(panel, () => this.handlers.compile(this.model.get(cellId)?.source ?? ''));
    this.bytecodeViews.set(cellId, view);
    view.refreshFromCell();
  }

  /**
   * Show or hide the sandbox panel.
   *
   * Nothing runs on opening, unlike the bytecode panel which compiles
   * straight away. Compiling is free and running is not: a sandboxed run
   * is a real execution with a real budget, and it should happen because
   * somebody asked for it.
   */
  toggleSandbox(cellId) {
    const panel = this.cellNode(cellId)?.querySelector('[data-sandbox]');
    if (!panel) return;
    if (this.showingSandbox.has(cellId)) {
      this.showingSandbox.delete(cellId);
      this.sandboxViews.delete(cellId);
      panel.hidden = true;
      panel.replaceChildren();
      return;
    }
    this.showingSandbox.add(cellId);
    panel.hidden = false;
    this.sandboxViews.set(cellId, new SandboxView(
      panel,
      (code, options) => this.handlers.runInstance(code, options),
      () => this.model.get(cellId)?.source ?? '',
    ));
  }

  _toType(cellId, type) {
    const cell = this.model.get(cellId);
    if (!cell || cell.cell_type === type) return;
    if (type === 'markdown') this.editingMarkdown.add(cellId);
    else this.editingMarkdown.delete(cellId);
    this.model.setCellType(cellId, type);
  }

  _onInput(event) {
    // The backstop for read-only: no input event -- typed, synthetic, or
    // pasted by an extension -- reaches the model while the document is
    // locked.
    if (this.handlers.readOnly?.() === true) return;
    const editor = event.target.closest('[data-editor]');
    if (!editor) return;
    const cellId = this._cellIdFor(editor);
    if (!cellId) return;
    editor.rows = Math.max(1, editor.value.split('\n').length);
    this.model.setSource(cellId, editor.value);
  }

  _onDoubleClick(event) {
    const rendered = event.target.closest('[data-rendered]');
    if (!rendered) return;
    const cellId = this._cellIdFor(rendered);
    if (!cellId) return;
    this.editingMarkdown.add(cellId);
    this.render();
    this.cellNode(cellId)?.querySelector('[data-editor]')?.focus();
  }

  _onKeydown(event) {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey || event.shiftKey)) return;
    const editor = event.target.closest('[data-editor]');
    if (!editor) return;
    const cellId = this._cellIdFor(editor);
    if (!cellId) return;
    event.preventDefault();
    this.handlers.onRun?.(cellId, { advance: event.shiftKey && !event.ctrlKey && !event.metaKey });
  }

  /** Markdown cells stop editing once they have been rendered. */
  finishMarkdownEdit(cellId) {
    this.editingMarkdown.delete(cellId);
    this.render();
  }
}

function promptText(cell) {
  if (cell.cell_type !== 'code') return '';
  return `In [${cell.execution_count ?? ' '}]:`;
}

/**
 * What the last run of this cell means now.
 *
 * Derived from the model rather than stored in the view, so it is right
 * after a reload too: an error output makes the cell an error cell, a
 * count makes it a ran-fine cell. `stale` is the one part that cannot be
 * derived -- it is session state, set when the kernel that produced these
 * results died -- and it outranks the others because "this errored" is
 * less important than "this is from a Lua state that no longer exists".
 */
export function runStateOf(cell) {
  if (cell.cell_type !== 'code') return null;
  if (cell.stale) return 'stale';
  if ((cell.outputs ?? []).some((o) => o.output_type === 'error')) return 'error';
  if (cell.execution_count !== null) return 'ok';
  return null;
}

/** `metadata.execution`'s ISO pair, as milliseconds, or null. */
export function durationOf(cell) {
  const execution = cell.metadata?.execution;
  const started = Date.parse(execution?.['iopub.execute_input'] ?? '');
  const ended = Date.parse(execution?.['shell.execute_reply'] ?? '');
  if (Number.isNaN(started) || Number.isNaN(ended) || ended < started) return null;
  return ended - started;
}

/** "12 ms", "1.4 s", "2m 05s" -- coarse on purpose; this is a hint, not a benchmark. */
export function formatDuration(ms) {
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
