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
    const cell = newCell(cellType);
    const at = afterId === null ? this.cells.length : this.indexOf(afterId) + 1;
    this.cells.splice(at, 0, cell);
    this._emit('structure', cell.id);
    return cell;
  }

  deleteCell(cellId) {
    const at = this.indexOf(cellId);
    if (at === -1) return;
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
    const [cell] = this.cells.splice(at, 1);
    this.cells.splice(to, 0, cell);
    this._emit('structure', cellId);
    return true;
  }

  setCellType(cellId, cellType) {
    const cell = this.get(cellId);
    if (!cell || cell.cell_type === cellType) return;
    cell.cell_type = cellType;
    cell.outputs = [];
    cell.execution_count = null;
    this._emit('structure', cellId);
  }

  // --- content ------------------------------------------------------

  setSource(cellId, source) {
    const cell = this.get(cellId);
    if (!cell || cell.source === source) return;
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
    this.setOutputs(cellId, []);
    this.setExecutionCount(cellId, null);
  }

  clearAllOutputs() {
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
    for (const cell of this.cells) {
      if (cell.execution_count !== null || (cell.outputs?.length ?? 0) > 0) {
        cell.stale = true;
      }
    }
    this._emit('structure');
  }
}
