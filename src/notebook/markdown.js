// A small markdown renderer for markdown cells.
//
// Small on purpose. A real markdown library would be the project's first
// vendored dependency, and this needs to render headings, emphasis, code,
// lists and links -- not CommonMark. When someone wants footnotes and
// tables, vendor a real one; until then this is a hundred lines that never
// need updating.
//
// Escaping happens *first*, on the raw text, and nothing downstream ever
// inserts un-escaped input. Notebooks arrive from files and from other
// people's repositories, so a markdown cell is untrusted input by default.

import { escapeHtml } from './escape.js';


/** Inline spans, applied to already-escaped text. */
function inline(escaped) {
  return escaped
    // `code` first: nothing inside it should be interpreted further, and
    // the placeholder pass below keeps later rules out of it.
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\b_([^_]+)_\b/g, '<em>$1</em>')
    // Only http(s) and relative links. A javascript: or data: URL in a
    // notebook someone sent you is not a link, it is a payload.
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text, href) => (
      /^(https?:\/\/|[./#])/i.test(href)
        ? `<a href="${href}" rel="noopener noreferrer" target="_blank">${text}</a>`
        : whole
    ));
}

export function renderMarkdown(source) {
  const lines = String(source).split('\n');
  const html = [];
  let paragraph = [];
  let list = null;      // 'ul' | 'ol' | null
  let fence = null;     // the fence marker that opened a code block
  let fenced = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${inline(escapeHtml(paragraph.join('\n')))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) { html.push(`</${list}>`); list = null; }
  };

  for (const line of lines) {
    // fenced code -- verbatim, escaped, no inline rules
    const fenceMatch = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1] === fence) {
        html.push(`<pre><code>${escapeHtml(fenced.join('\n'))}</code></pre>`);
        fence = null;
        fenced = [];
      } else {
        fenced.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      flushParagraph();
      closeList();
      fence = fenceMatch[1];
      continue;
    }

    if (line.trim() === '') { flushParagraph(); closeList(); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph();
      closeList();
      html.push('<hr>');
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const wanted = bullet ? 'ul' : 'ol';
      if (list !== wanted) { closeList(); html.push(`<${wanted}>`); list = wanted; }
      html.push(`<li>${inline(escapeHtml((bullet ?? numbered)[1]))}</li>`);
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${inline(escapeHtml(quote[1]))}</blockquote>`);
      continue;
    }

    paragraph.push(line);
  }

  // an unterminated fence still renders, as the code it obviously is
  if (fence !== null) html.push(`<pre><code>${escapeHtml(fenced.join('\n'))}</code></pre>`);
  flushParagraph();
  closeList();

  return html.join('\n');
}
