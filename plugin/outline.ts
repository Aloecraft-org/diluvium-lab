// The Outline panel: the lab's `outline.js` over whichever notebook is
// active, as a tool panel beside it.
import { Widget } from '@lumino/widgets';
import { renderOutline } from '../src/notebook/outline.js';
import type { NotebookPanel } from './notebook';

export class OutlinePanel extends Widget {
  private notebook?: NotebookPanel;
  private readonly body: HTMLElement;
  private readonly head: HTMLElement;

  constructor() {
    super();
    this.addClass('lab-outline');
    this.title.label = 'Outline';
    this.title.caption = 'The active notebook’s markdown headings';
    this.node.innerHTML = `<div class="lab-outline-head" data-outline-for></div><div class="lab-outline-body" data-outline></div>`;
    this.head = this.node.querySelector('[data-outline-for]')!;
    this.body = this.node.querySelector('[data-outline]')!;
    this.render();
  }

  /** Follow a notebook; undefined when none is open. */
  setNotebook(notebook: NotebookPanel | undefined): void {
    if (notebook === this.notebook) return;
    this.unfollow();
    this.notebook = notebook;
    if (notebook) {
      notebook.edited.connect(this.render, this);
      notebook.selected.connect(this.render, this);
      notebook.changed.connect(this.render, this);
      notebook.disposed.connect(this.unfollow, this);
    }
    this.render();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.unfollow();
    super.dispose();
  }

  private unfollow(): void {
    const { notebook } = this;
    if (!notebook) return;
    notebook.edited.disconnect(this.render, this);
    notebook.selected.disconnect(this.render, this);
    notebook.changed.disconnect(this.render, this);
    notebook.disposed.disconnect(this.unfollow, this);
    this.notebook = undefined;
    this.render();
  }

  /** Repaints in place; the scroll position survives, as the page's tool panel keeps it. */
  private render(): void {
    const { notebook } = this;
    const scrolled = this.body.scrollTop;
    this.body.replaceChildren();
    if (!notebook || notebook.isDisposed) {
      this.head.textContent = 'No notebook is open.';
      return;
    }
    this.head.textContent = notebook.title.label;
    renderOutline(this.body, {
      cells: notebook.model.cells,
      selectedId: notebook.view.selectedId,
      onJump: (cellId: string) => {
        notebook.jumpTo(cellId);
        notebook.activate();
      },
    });
    this.body.scrollTop = scrolled;
  }
}
