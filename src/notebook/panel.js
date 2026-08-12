// A collapsible tool panel on the left edge, and the rail that drives it.
//
// Generic on purpose: the outline is the first tool that lives here, not
// the reason the shape exists. A tool is an object with an id, a label,
// something to put on the rail, and a render function -- registering one
// adds a rail button and nothing else. The panel owns which tool is open,
// the collapse behaviour, and nothing about any tool's content.
//
// One panel, one tool visible at a time. Tools that want to coexist are a
// sign the panel is being used as a dashboard, which is the sheet's job.

import { el } from './dom.js';

export class ToolPanel {
  /**
   * @param {Element} root the [data-workbench] element
   * @param {{onStateChange?: (state: {open: string|null}) => void}} options
   *   `onStateChange` fires on open/close with what to remember; the panel
   *   itself stores nothing, so the caller decides persistence.
   */
  constructor(root, { onStateChange } = {}) {
    this.rail = root.querySelector('[data-tool-rail]');
    this.panel = root.querySelector('[data-tool-panel]');
    this.titleEl = root.querySelector('[data-tool-panel-title]');
    this.body = root.querySelector('[data-tool-panel-body]');
    this.tools = [];
    /** The open tool's id, or null while collapsed. */
    this.active = null;
    this._onStateChange = onStateChange;
    root.querySelector('[data-tool-panel-close]')
      ?.addEventListener('click', () => this.close());
  }

  /**
   * Add a tool. `render(container)` is called with an empty container
   * every time the tool needs painting -- on open and on refresh -- so a
   * tool holds no DOM between calls and cannot leak listeners into the
   * panel. State a tool wants to keep belongs in its closure.
   *
   * @param {{id: string, label: string, icon?: string, title?: string,
   *          render: (container: Element) => void}} tool
   */
  register(tool) {
    this.tools.push(tool);
    const button = el('button', {
      type: 'button', 'data-tool': tool.id,
      title: tool.title ?? tool.label,
      'aria-label': tool.title ?? tool.label,
      'aria-pressed': 'false',
    }, [tool.icon ?? tool.label]);
    button.addEventListener('click', () => this.toggle(tool.id));
    this.rail.append(button);
  }

  toggle(id) {
    if (this.active === id) this.close();
    else this.open(id);
  }

  open(id) {
    const tool = this.tools.find((t) => t.id === id);
    if (!tool) return;
    this.active = id;
    this.titleEl.textContent = tool.label;
    // A tool may ask for more room. The outline is a list of headings and
    // fits in 17rem; a roster with capabilities and instruction counts in
    // it does not, and shrinking the columns to fit would be choosing the
    // panel's width over the data's legibility.
    this.panel.toggleAttribute('data-wide', tool.wide === true);
    this.panel.hidden = false;
    this._paint(tool);
    this._reflectPressed();
    this._onStateChange?.({ open: id });
  }

  close() {
    if (this.active === null) return;
    this.active = null;
    this.panel.hidden = true;
    this.body.replaceChildren();
    this._reflectPressed();
    this._onStateChange?.({ open: null });
  }

  /**
   * Re-render the open tool in place. A no-op while collapsed, which is
   * what lets callers report every model change here without checking
   * first. Scroll position survives the repaint: an outline that jumped
   * to the top every time a cell changed would be unusable.
   */
  refresh() {
    if (this.active === null) return;
    const tool = this.tools.find((t) => t.id === this.active);
    if (tool) this._paint(tool);
  }

  _paint(tool) {
    const scrolled = this.body.scrollTop;
    this.body.replaceChildren();
    tool.render(this.body);
    this.body.scrollTop = scrolled;
  }

  _reflectPressed() {
    for (const button of this.rail.querySelectorAll('button[data-tool]')) {
      button.setAttribute('aria-pressed', String(button.dataset.tool === this.active));
    }
  }
}
