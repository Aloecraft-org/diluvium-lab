// The bytecode panel: what the compiler made of this cell.
//
// Three things in one place, because they are the same object seen three
// ways — the disassembly, the raw hex, and a box to paste hex back into.
// That last one is the point of doing this in a notebook rather than a
// terminal: someone can be handed a blob of compiled Diluvium, paste it,
// and read it, with nothing installed.
//
// Compiling is not running. Everything here loads the chunk and dumps it;
// no user code executes, which is what makes it safe to point at bytecode
// you were sent and have not read.

import { el } from './ui.js';
import { readChunk, fromHex, toHex, flattenProtos, BytecodeError } from '../analysis/luac.js';
import { disassemble, describeFunction, showConstant, toText } from '../analysis/disasm.js';

function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** `1b 4c 75 …` back into a file people can hand to `luac`-shaped tools. */
function downloadBinary(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function renderProto(path, proto) {
  const rows = disassemble(proto).map((row) => el('tr', { 'data-pc': row.pc }, [
    el('td', { class: 'bc-pc' }, [String(row.pc + 1)]),
    el('td', { class: 'bc-line' }, [row.line === null ? '' : `[${row.line}]`]),
    el('td', { class: 'bc-op' }, [row.name]),
    el('td', { class: 'bc-args' }, [row.operands]),
    el('td', { class: 'bc-comment' }, [row.comment ?? '']),
  ]));

  const parts = [
    el('h4', { class: 'bc-fn', 'data-proto': path }, [describeFunction(proto, path)]),
    el('table', { class: 'bc-table' }, [el('tbody', {}, rows)]),
  ];

  if (proto.constants.length) {
    parts.push(el('div', { class: 'bc-aside' }, [
      el('strong', {}, ['constants ']),
      ...proto.constants.flatMap((c, i) => [
        el('span', { class: 'bc-const' }, [`${i}: ${showConstant(c)}`]),
        ' ',
      ]),
    ]));
  }
  if (proto.upvalues.length) {
    parts.push(el('div', { class: 'bc-aside' }, [
      el('strong', {}, ['upvalues ']),
      ...proto.upvalues.flatMap((u, i) => [
        el('span', { class: 'bc-const' }, [`${i}: ${u.name ?? '?'}`]),
        ' ',
      ]),
    ]));
  }
  return el('section', { class: 'bc-proto' }, parts);
}

/**
 * @param {HTMLElement} host where the panel lives
 * @param {() => Promise<string>} compile returns hex for the current cell
 */
export class BytecodeView {
  constructor(host, compile) {
    this.host = host;
    this.compile = compile;
    this.chunk = null;
    this.bytes = null;
    this.tab = 'disassembly';
  }

  async refreshFromCell() {
    this.host.dataset.state = 'working';
    try {
      const hex = await this.compile();
      this.load(fromHex(hex));
    } catch (err) {
      this.fail(err);
    }
  }

  load(bytes) {
    this.bytes = bytes;
    try {
      this.chunk = readChunk(bytes);
      this.render();
    } catch (err) {
      this.chunk = null;
      this.fail(err);
    }
  }

  fail(err) {
    this.host.dataset.state = 'error';
    const isFormat = err instanceof BytecodeError;
    this.host.replaceChildren(el('div', { class: 'bc-error', 'data-bytecode-error': true }, [
      el('strong', {}, [isFormat ? 'This chunk could not be read. ' : 'Could not compile. ']),
      err.message,
      // A parser that guessed would be worse than one that stops, so say
      // which of the two things went wrong rather than blaming the code.
      isFormat
        ? el('p', { class: 'bc-note' }, [
          'The bytes are here and downloadable below; it is the reader that '
          + 'ran out of road, not the compiler.'])
        : null,
    ].filter(Boolean)));
    if (this.bytes) this.host.appendChild(this.hexPanel());
  }

  render() {
    const flat = flattenProtos(this.chunk.main);
    const { header, byteLength } = this.chunk;

    const tabs = el('div', { class: 'bc-tabs' }, [
      this.tabButton('disassembly', 'Disassembly'),
      this.tabButton('hex', 'Hex'),
      this.tabButton('paste', 'Read hex'),
      el('span', { class: 'bc-summary', 'data-bc-summary': true }, [
        `${byteLength} bytes · ${flat.length} function${flat.length === 1 ? '' : 's'} · `
        // Which container, not just whose: 5.4 and 5.5 chunks look alike
        // and are read completely differently, so pasting one in should
        // say which one it turned out to be.
        + `Lua ${header.lua} · format 0x${header.format.toString(16)} (${header.dialect})`,
      ]),
    ]);

    const body = el('div', { class: 'bc-body' });
    if (this.tab === 'disassembly') {
      body.append(...flat.map(({ path, proto }) => renderProto(path, proto)));
      body.appendChild(el('div', { class: 'bc-actions' }, [
        this.action('copy-text', 'Copy disassembly'),
        this.action('download-text', 'Download .txt'),
      ]));
    } else if (this.tab === 'hex') {
      body.appendChild(el('pre', { class: 'bc-hex', 'data-bc-hex': true }, [toHex(this.bytes)]));
      body.appendChild(el('div', { class: 'bc-actions' }, [
        this.action('copy-hex', 'Copy hex'),
        this.action('download-bin', 'Download .luac'),
      ]));
    } else {
      body.appendChild(el('p', { class: 'bc-note' }, [
        'Paste compiled Diluvium as hex — spaces, newlines, commas and 0x prefixes are all fine. '
        + 'Nothing runs; it is only read.',
      ]));
      const box = el('textarea', { class: 'bc-paste', 'data-bc-paste': true, rows: 6, spellcheck: 'false' });
      body.appendChild(box);
      body.appendChild(el('div', { class: 'bc-actions' }, [this.action('read-hex', 'Read it')]));
    }

    this.host.dataset.state = 'ready';
    this.host.replaceChildren(tabs, body);
    this.host.onclick = (event) => this.onClick(event);
  }

  tabButton(id, label) {
    return el('button', {
      type: 'button', class: 'bc-tab', 'data-bc-tab': id,
      'data-active': this.tab === id ? 'true' : 'false',
    }, [label]);
  }

  action(id, label) {
    return el('button', { type: 'button', class: 'bc-action', 'data-bc-action': id }, [label]);
  }

  hexPanel() {
    return el('pre', { class: 'bc-hex', 'data-bc-hex': true }, [toHex(this.bytes)]);
  }

  onClick(event) {
    const tab = event.target.closest('[data-bc-tab]');
    if (tab) { this.tab = tab.dataset.bcTab; this.render(); return; }

    const action = event.target.closest('[data-bc-action]')?.dataset.bcAction;
    if (!action) return;
    const flat = this.chunk ? flattenProtos(this.chunk.main) : [];

    switch (action) {
      case 'copy-text': navigator.clipboard?.writeText(toText(this.chunk, flat)); break;
      case 'download-text': download('bytecode.txt', toText(this.chunk, flat)); break;
      case 'copy-hex': navigator.clipboard?.writeText(toHex(this.bytes)); break;
      case 'download-bin': downloadBinary('chunk.luac', this.bytes); break;
      case 'read-hex': {
        const text = this.host.querySelector('[data-bc-paste]')?.value ?? '';
        try {
          this.tab = 'disassembly';
          this.load(fromHex(text));
        } catch (err) {
          this.fail(err);
        }
        break;
      }
      default: break;
    }
  }
}
