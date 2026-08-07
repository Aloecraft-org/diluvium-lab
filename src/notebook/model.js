// The notebook document.
//
// Deliberately plain: cells are data, and the model owns no DOM and no
// kernel. It notifies on change and nothing more. The `.ipynb` mapping lives
// next door in ipynb.js so this file never has to care about the wire format.

let nextId = 0;

export function newCell(cellType = 'code', source = '') {
  nextId += 1;
  return {
    id: `cell-${nextId}`,
    cell_type: cellType,
    source,
    outputs: [],
    execution_count: null,
  };
}

export class NotebookModel {
  constructor(cells) {
    this.cells = cells && cells.length ? cells : [newCell('code')];
    this._listeners = new Set();
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
    this._emit('outputs', cellId);
  }

  setExecutionCount(cellId, count) {
    const cell = this.get(cellId);
    if (!cell) return;
    cell.execution_count = count;
    this._emit('outputs', cellId);
  }

  clearOutputs(cellId) {
    this.setOutputs(cellId, []);
    this.setExecutionCount(cellId, null);
  }

  clearAllOutputs() {
    for (const cell of this.cells) {
      cell.outputs = [];
      cell.execution_count = null;
    }
    this._emit('structure');
  }

  /** Forget every `In [n]`, which is what a kernel restart means for a document. */
  resetExecutionCounts() {
    for (const cell of this.cells) cell.execution_count = null;
    this._emit('structure');
  }
}
