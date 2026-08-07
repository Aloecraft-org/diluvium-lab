// Rendering the notebook.
//
// Plain modules and the DOM, which is a hard constraint and, at this size,
// also just the right tool. The one rule that keeps it from turning into a
// framework: structural changes (add / delete / move / type change) rebuild
// the cell list, and everything else patches in place. Rebuilding on every
// keystroke would throw away the caret.

import { renderMarkdown } from './markdown.js';
import { outputText } from './ipynb.js';
import { HighlightedEditor } from './editor.js';
import { hintFor, tipForOutput } from './hints.js';
import { BytecodeView } from './bytecode-view.js';

/**
 * Display caps. The kernel's ceiling is far higher (see wasi.js): these
 * exist so a 50,000-line cell does not lock the tab laying out text nobody
 * asked to read, and "show all" is always available because the output was
 * retained rather than thrown away.
 */
export const SOFT_MAX_LINES = 200;
export const SOFT_MAX_BYTES = 64 * 1024;

export function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of [].concat(kids)) {
    if (kid === null || kid === undefined) continue;
    node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return node;
}

function button(action, label, title) {
  return el('button', { type: 'button', 'data-action': action, title: title ?? label }, [label]);
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

export function renderOutputs(cell, expandedSet) {
  const wrap = el('div', { class: 'outputs', 'data-outputs': cell.id });
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
    // Highlighting follows the *running* kernel's language, so a version
    // switch re-colours without a table in this repo being edited.
    this.languageInfo = handlers.languageInfo ?? (() => ({}));
    this.editors = new Map();

    this.root.addEventListener('click', (event) => this._onClick(event));
    this.root.addEventListener('input', (event) => this._onInput(event));
    this.root.addEventListener('keydown', (event) => this._onKeydown(event));
    this.root.addEventListener('dblclick', (event) => this._onDoubleClick(event));
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
    this.root.replaceChildren(...this.model.cells.map((cell, i) => this._renderCell(cell, i)));

    if (focusedCell) {
      const editor = this.cellNode(focusedCell)?.querySelector('[data-editor]');
      if (editor && !editor.hidden) {
        editor.focus();
        if (caret !== null) editor.setSelectionRange(caret, caret);
      }
    }
  }

  updateOutputs(cellId) {
    const node = this.cellNode(cellId);
    const cell = this.model.get(cellId);
    if (!node || !cell) return;
    node.querySelector('[data-outputs]')?.replaceWith(renderOutputs(cell, this.expanded));
    const prompt = node.querySelector('[data-prompt]');
    if (prompt) prompt.textContent = promptText(cell);
    node.dataset.busy = 'false';
  }

  setBusy(cellId, busy) {
    const node = this.cellNode(cellId);
    if (!node) return;
    node.dataset.busy = busy ? 'true' : 'false';
    const prompt = node.querySelector('[data-prompt]');
    if (prompt && busy) prompt.textContent = 'In [*]:';
  }

  _renderCell(cell, index) {
    const isCode = cell.cell_type === 'code';
    // An empty markdown cell renders as nothing, so showing its rendered
    // view would leave a blank strip with no obvious way in. A new one
    // opens for editing until it has something to show.
    const editing = isCode || this.editingMarkdown.has(cell.id) || cell.source.trim() === '';

    const editor = el('textarea', {
      'data-editor': true,
      spellcheck: 'false',
      rows: Math.max(1, cell.source.split('\n').length),
      'aria-label': `${cell.cell_type} cell ${index + 1}`,
    });
    editor.value = cell.source;
    editor.hidden = !editing;

    const tools = el('div', { class: 'cell-tools' }, [
      isCode ? button('run', 'Run', 'Run this cell (Ctrl+Enter)') : button('run', 'Render', 'Render (Ctrl+Enter)'),
      isCode ? button('bytecode', 'Bytecode', 'Compile this cell and read the bytecode — nothing runs') : null,
      button('to-code', 'Code', 'Turn into a code cell'),
      button('to-markdown', 'Markdown', 'Turn into a markdown cell'),
      button('move-up', '↑', 'Move up'),
      button('move-down', '↓', 'Move down'),
      button('insert-below', '+', 'Insert a cell below'),
      button('delete', '✕', 'Delete this cell'),
    ]);

    const kids = [
      el('div', { class: 'cell-head' }, [
        el('span', { class: 'prompt', 'data-prompt': true }, [promptText(cell)]),
        tools,
      ]),
      editor,
    ];

    if (isCode) {
      kids.push(renderOutputs(cell, this.expanded));
      const panel = el('div', { class: 'bytecode', 'data-bytecode': cell.id });
      panel.hidden = !this.showingBytecode.has(cell.id);
      kids.push(panel);
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
    }, kids);

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
      case 'bytecode': this.toggleBytecode(cellId); break;
      case 'delete': this.model.deleteCell(cellId); break;
      case 'move-up': this.model.moveCell(cellId, -1); break;
      case 'move-down': this.model.moveCell(cellId, +1); break;
      case 'insert-below': this.model.addCell('code', cellId); break;
      case 'to-code': this._toType(cellId, 'code'); break;
      case 'to-markdown': this._toType(cellId, 'markdown'); break;
      default: break;
    }
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

  _toType(cellId, type) {
    const cell = this.model.get(cellId);
    if (!cell || cell.cell_type === type) return;
    if (type === 'markdown') this.editingMarkdown.add(cellId);
    else this.editingMarkdown.delete(cellId);
    this.model.setCellType(cellId, type);
  }

  _onInput(event) {
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
