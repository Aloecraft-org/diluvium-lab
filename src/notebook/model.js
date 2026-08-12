// The notebook document.
//
// Deliberately plain: cells are data, and the model owns no DOM and no
// kernel. It notifies on change and nothing more. The `.ipynb` mapping lives
// next door in ipynb.js so this file never has to care about the wire format.

let nextId = 0;

/** Long enough for a sentence, short enough to render in a toolbar. */
export const MAX_TITLE = 120;

/**
 * What a cell's author says the cell will do, read from
 * `metadata.diluvium_lab.expect`.
 *
 * A teaching notebook needs cells that misbehave: one that raises so you
 * can see what an error looks like, one that loops forever so you have
 * something to press **Stop** on. Prose says so, but only to a reader --
 * **Run all** would still hang the kernel on the second kind, which is a
 * poor first five minutes for somebody who just pressed *Start here* and
 * then *Run all*. Saying it in the file makes it true for the page too.
 *
 * Unknown values mean nothing rather than something, so a notebook from
 * elsewhere that happens to use the key is not misread.
 */
export const EXPECT = { ERROR: 'error', NEVER_RETURNS: 'never-returns' };

const EXPECT_VALUES = new Set(Object.values(EXPECT));

/** @returns {string|null} one of EXPECT, or null. */
export function expectationOf(cell) {
  const value = cell?.metadata?.diluvium_lab?.expect;
  return EXPECT_VALUES.has(value) ? value : null;
}

export function newCell(cellType = 'code', source = '') {
  nextId += 1;
  return {
    id: `cell-${nextId}`,
    cell_type: cellType,
    source,
    outputs: [],
    execution_count: null,
    // nbformat cell metadata, carried whole. The Lab reads two corners of
    // it -- `jupyter.source_hidden` for folding and `execution` for timing
    // -- and preserves the rest untouched, because a notebook that came
    // from JupyterLab with tags or slideshow settings should leave with
    // them.
    metadata: {},
    // Session-only: true after the kernel that produced this cell's
    // outputs died. Not serialised -- toIpynb never reads it -- because
    // "stale" is a fact about the session, not the document.
    stale: false,
  };
}

/** How many undo steps to keep. Snapshots are whole notebooks, so this is
    bounded memory: fifty of a large notebook is a few MB, transient. */
const UNDO_LIMIT = 50;

export class NotebookModel {
  constructor(cells, metadata = {}) {
    this.cells = cells && cells.length ? cells : [newCell('code')];
    // Notebook-level metadata, carried whole. `fromIpynb` used to drop it
    // on the floor -- so a notebook that arrived from Colab or JupyterLab
    // with settings, a widget state or an authorship block left without
    // them. The title below lives here, which is what makes it survive a
    // save and a reopen.
    this.metadata = (metadata && typeof metadata === 'object' && !Array.isArray(metadata))
      ? metadata : {};
    this._listeners = new Set();
    // Structural undo. Snapshots, not inverse operations: the memento is
    // twenty lines where a command stack is two hundred, and a notebook
    // is small enough that copying it is nothing.
    //
    // Text granularity is the *session*, not the keystroke: the first
    // setSource after any boundary takes a checkpoint, so a structural
    // undo can never silently destroy typing it did not own -- the typing
    // is its own step. Inside an editor, Ctrl+Z stays the textarea's
    // native undo; the two meet only at session edges.
    this._undoStack = [];
    this._redoStack = [];
    this._typing = false;
    // Bumped by markAllStale (a kernel died). Snapshots remember which
    // era they were taken in, so an undo across a restart cannot present
    // a dead kernel's outputs as fresh.
    this._generation = 0;
  }

  /** Drop all undo/redo history -- a freshly adopted document has no past. */
  clearHistory() {
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this._typing = false;
  }

  // --- undo (structural) ---------------------------------------------

  _snapshot() {
    // Deep copy via JSON: cells are plain data; ids are preserved so
    // selection and folding survive a restore. The generation rides along
    // for the staleness check in _restore.
    return JSON.parse(JSON.stringify({
      cells: this.cells, metadata: this.metadata, generation: this._generation,
    }));
  }

  /**
   * Remember the current state as an undo point. Every structural mutator
   * calls this before changing anything; app-level compound operations
   * (clear all outputs, paste) call it themselves where noted.
   */
  checkpoint() {
    this._undoStack.push(this._snapshot());
    if (this._undoStack.length > UNDO_LIMIT) this._undoStack.shift();
    // A new edit forks history; the redone future is no longer reachable.
    this._redoStack.length = 0;
    // A structural boundary ends any typing session.
    this._typing = false;
  }

  get canUndo() { return this._undoStack.length > 0; }
  get canRedo() { return this._redoStack.length > 0; }

  undo() {
    if (!this.canUndo) return false;
    this._redoStack.push(this._snapshot());
    this._restore(this._undoStack.pop());
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    this._undoStack.push(this._snapshot());
    this._restore(this._redoStack.pop());
    return true;
  }

  _restore(snap) {
    this.cells = snap.cells;
    this.metadata = snap.metadata;
    // A snapshot from before a kernel restart carries outputs that kernel
    // produced. They come back -- undo restores the document -- but marked
    // stale, because the Lua state that made them is gone either way.
    if ((snap.generation ?? 0) !== this._generation) {
      for (const cell of this.cells) {
        if (cell.execution_count !== null || (cell.outputs?.length ?? 0) > 0) cell.stale = true;
      }
    }
    this._typing = false;
    this._emit('structure');
    this._emit('title');
  }

  /**
   * What this notebook is called, as distinct from what it is saved as.
   *
   * nbformat has no standard field for it -- Jupyter uses the filename and
   * has nothing else -- so `metadata.title` is the Lab's, and Colab's
   * `metadata.colab.name` is read as a fallback so a notebook from there
   * arrives with the name it had. Empty means untitled, which the page
   * shows as a placeholder rather than as an empty gap.
   */
  get title() {
    const own = this.metadata?.title;
    if (typeof own === 'string' && own.trim()) return own.trim();
    const colab = this.metadata?.colab?.name;
    if (typeof colab === 'string' && colab.trim()) return colab.trim().replace(/\.ipynb$/i, '');
    return '';
  }

  /**
   * Rename it. An empty string clears the title rather than storing one,
   * so an untitled notebook does not carry `"title": ""` around forever.
   */
  setTitle(title) {
    const next = String(title ?? '').trim().slice(0, MAX_TITLE);
    if (next === this.title) return false;
    this.checkpoint();
    this.metadata = { ...this.metadata };
    if (next) this.metadata.title = next;
    else delete this.metadata.title;
    // Colab's copy would otherwise win on the next read and silently undo
    // a rename of a notebook that came from there.
    if (this.metadata.colab?.name) {
      this.metadata.colab = { ...this.metadata.colab };
      delete this.metadata.colab.name;
    }
    this._emit('title');
    return true;
  }

  /**
   * @param {(change: {type: string, cellId?: string}) => void} listener
   * @returns {() => void} unsubscribe
   */
  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit(type, cellId) {
    for (const listener of this._listeners) listener({ type, cellId });
  }

  indexOf(cellId) { return this.cells.findIndex((c) => c.id === cellId); }
  get(cellId) { return this.cells[this.indexOf(cellId)] ?? null; }

  // --- structure (these re-render the list) -------------------------

  addCell(cellType = 'code', afterId = null) {
    this.checkpoint();
    const cell = newCell(cellType);
    const at = afterId === null ? this.cells.length : this.indexOf(afterId) + 1;
    this.cells.splice(at, 0, cell);
    this._emit('structure', cell.id);
    return cell;
  }

  /**
   * Insert a copy of existing cell *data* -- what paste is. A fresh id,
   * because the clipboard may be pasted twice and ids must stay unique.
   */
  insertCell(data, afterId = null) {
    this.checkpoint();
    const cell = newCell(data.cell_type ?? 'code', data.source ?? '');
    cell.outputs = JSON.parse(JSON.stringify(data.outputs ?? []));
    cell.metadata = JSON.parse(JSON.stringify(data.metadata ?? {}));
    cell.execution_count = data.execution_count ?? null;
    const at = afterId === null ? this.cells.length : this.indexOf(afterId) + 1;
    this.cells.splice(at, 0, cell);
    this._emit('structure', cell.id);
    return cell;
  }

  deleteCell(cellId) {
    const at = this.indexOf(cellId);
    if (at === -1) return;
    // Deleting the only cell when it is already blank replaces it with an
    // identical blank; a checkpoint for that would burn the redo stack on
    // a visual no-op.
    const cell = this.cells[at];
    if (this.cells.length === 1 && cell.source === ''
        && (cell.outputs?.length ?? 0) === 0 && cell.execution_count === null) return;
    this.checkpoint();
    this.cells.splice(at, 1);
    // A notebook with no cells has no way back to having one, so keep a
    // blank code cell rather than stranding the user with an empty page.
    if (this.cells.length === 0) this.cells.push(newCell('code'));
    this._emit('structure');
  }

  /** @param {number} delta -1 for up, +1 for down. No-op at the ends. */
  moveCell(cellId, delta) {
    const at = this.indexOf(cellId);
    const to = at + delta;
    if (at === -1 || to < 0 || to >= this.cells.length) return false;
    this.checkpoint();
    const [cell] = this.cells.splice(at, 1);
    this.cells.splice(to, 0, cell);
    this._emit('structure', cellId);
    return true;
  }

  setCellType(cellId, cellType) {
    const cell = this.get(cellId);
    if (!cell || cell.cell_type === cellType) return;
    this.checkpoint();
    cell.cell_type = cellType;
    cell.outputs = [];
    cell.execution_count = null;
    this._emit('structure', cellId);
  }

  // --- content ------------------------------------------------------

  setSource(cellId, source) {
    const cell = this.get(cellId);
    if (!cell || cell.source === source) return;
    // First edit since a boundary: the typing session becomes one undo
    // step, captured before the first keystroke lands.
    if (!this._typing) {
      this.checkpoint();
      this._typing = true;
    }
    cell.source = source;
    // 'source' does not re-render: the textarea is already showing this.
    this._emit('source', cellId);
  }

  setOutputs(cellId, outputs) {
    const cell = this.get(cellId);
    if (!cell) return;
    cell.outputs = outputs;
    cell.stale = false;             // these outputs are from the live kernel
    this._emit('outputs', cellId);
  }

  setExecutionCount(cellId, count) {
    const cell = this.get(cellId);
    if (!cell) return;
    cell.execution_count = count;
    cell.stale = false;
    this._emit('outputs', cellId);
  }

  /**
   * Record when a run started and finished, in the shape JupyterLab's
   * ExecuteTime extension reads (`metadata.execution` with ISO
   * timestamps). Duration is derived from the pair, so it survives a
   * save/load round trip and even shows up in other tools.
   */
  setExecutionTiming(cellId, startedAtIso, endedAtIso) {
    const cell = this.get(cellId);
    if (!cell) return;
    cell.metadata = {
      ...cell.metadata,
      execution: {
        ...(cell.metadata?.execution ?? {}),
        'iopub.execute_input': startedAtIso,
        'shell.execute_reply': endedAtIso,
      },
    };
    this._emit('outputs', cellId);
  }

  /**
   * Fold or unfold a cell's source. Stored as nbformat's own
   * `jupyter.source_hidden`, so a folded cell arrives folded in
   * JupyterLab and vice versa -- the convention exists, so inventing a
   * private one would only cost interoperability.
   */
  setFolded(cellId, folded) {
    const cell = this.get(cellId);
    if (!cell) return;
    cell.metadata = {
      ...cell.metadata,
      jupyter: { ...(cell.metadata?.jupyter ?? {}), source_hidden: !!folded },
    };
    this._emit('structure', cellId);
  }

  isFolded(cellId) {
    return this.get(cellId)?.metadata?.jupyter?.source_hidden === true;
  }

  clearOutputs(cellId) {
    const cell = this.get(cellId);
    if (!cell || ((cell.outputs?.length ?? 0) === 0 && cell.execution_count === null)) return;
    this.checkpoint();
    this.setOutputs(cellId, []);
    this.setExecutionCount(cellId, null);
  }

  clearAllOutputs() {
    // A no-op clear takes no checkpoint -- clicking it twice must not eat
    // the redo stack.
    if (!this.cells.some((c) => (c.outputs?.length ?? 0) > 0 || c.execution_count !== null || c.stale)) return;
    this.checkpoint();
    for (const cell of this.cells) {
      cell.outputs = [];
      cell.execution_count = null;
      cell.stale = false;
    }
    this._emit('structure');
  }

  /**
   * The kernel these results came from is gone; say so on every cell that
   * shows any.
   *
   * This replaced blanking the execution counts, deliberately. `In [ ]`
   * erases history -- the reader loses the order things ran in *and* the
   * fact that they ran. Keeping `In [3]` and marking it stale preserves
   * both while making clear the number describes a Lua state that no
   * longer exists. Jupyter has no such state; after a restart it happily
   * shows counts from a dead kernel as if nothing happened, and every
   * teacher of it warns about exactly that.
   */
  markAllStale() {
    this._generation += 1;
    for (const cell of this.cells) {
      if (cell.execution_count !== null || (cell.outputs?.length ?? 0) > 0) {
        cell.stale = true;
      }
    }
    this._emit('structure');
  }
}
