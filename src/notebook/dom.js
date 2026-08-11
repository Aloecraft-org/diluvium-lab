// The one DOM helper.
//
// It lives on its own rather than in ui.js because everything that builds
// nodes needs it -- the notebook, the console, the bytecode panel, the
// charts -- and the charts are reached *from* ui.js. Importing it back out
// of ui.js would make a cycle that happens to work, which is a worse thing
// to leave behind than a four-line module.

/**
 * `el('div', { class: 'x' }, ['text', node])`.
 *
 * Attributes only, never markup: children arrive as strings or nodes and a
 * string becomes a text node, so there is no path in this codebase by which
 * notebook content reaches the DOM as HTML.
 */
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
