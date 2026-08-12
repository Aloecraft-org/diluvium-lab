// The outline: every markdown heading in the notebook, in order, as a
// clickable table of contents -- what Jupyter's TOC extension and Colab's
// outline pane both do.
//
// Headings only, and only ATX ones (`#` through `######`). Setext
// headings (a line underlined with = or -) are not recognised, matching
// the Lab's own markdown renderer -- an outline that saw headings the
// page does not render as headings would be lying about the document.

import { el } from './dom.js';

/**
 * The ATX headings of one markdown source.
 *
 * Fenced code blocks are skipped, because `# comment` inside a ```lua
 * fence is a comment. The fence tracking is deliberately simple -- any
 * fence marker toggles -- which mis-nests exotic mixes of ``` and ~~~;
 * a notebook doing that to its own outline has earned the result.
 *
 * @returns {{level: number, text: string}[]}
 */
export function headingsOf(source) {
  const found = [];
  let inFence = false;
  for (const line of String(source ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) found.push({ level: m[1].length, text: headingText(m[2]) });
  }
  return found;
}

/** Strip inline markdown so the outline shows words, not syntax. */
function headingText(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')   // images -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')    // links -> text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .trim();
}

/**
 * The whole notebook's outline: one entry per heading, carrying the cell
 * it lives in so a click can go there. `cellIndex` rides along so the
 * active-section logic below can compare document positions.
 *
 * @param {{id: string, cell_type: string, source: string}[]} cells
 */
export function buildOutline(cells) {
  const entries = [];
  cells.forEach((cell, cellIndex) => {
    if (cell.cell_type !== 'markdown') return;
    for (const h of headingsOf(cell.source)) {
      entries.push({ cellId: cell.id, cellIndex, level: h.level, text: h.text });
    }
  });
  return entries;
}

/**
 * Render the outline into `container` (a tool for panel.js).
 *
 * The active entry is the *section* the selection is in, not just "a
 * heading cell is selected": the last heading at or above the selected
 * cell, which is how Jupyter and Colab both read. A selection above the
 * first heading belongs to no section, and nothing is marked.
 *
 * @param {Element} container
 * @param {{cells: object[], selectedId: string|null,
 *          onJump: (cellId: string) => void}} options
 */
export function renderOutline(container, { cells, selectedId, onJump }) {
  const entries = buildOutline(cells);

  if (entries.length === 0) {
    container.append(el('p', { class: 'outline-empty' }, [
      'No headings yet. A markdown cell starting with # makes one.',
    ]));
    return;
  }

  const selectedIndex = cells.findIndex((c) => c.id === selectedId);
  let active = null;
  if (selectedIndex !== -1) {
    for (const entry of entries) {
      if (entry.cellIndex <= selectedIndex) active = entry;
      else break;
    }
  }

  container.append(...entries.map((entry) => {
    const button = el('button', {
      type: 'button', class: 'outline-entry',
      'data-outline-cell': entry.cellId,
      'data-level': entry.level,
      'data-active': String(entry === active),
      title: entry.text,
    }, [entry.text]);
    button.style.setProperty('--depth', entry.level - 1);
    button.addEventListener('click', () => onJump(entry.cellId));
    return button;
  }));
}
