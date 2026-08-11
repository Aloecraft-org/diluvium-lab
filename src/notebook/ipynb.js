// `.ipynb` in and out.
//
// A hard constraint, and an easy one to honour: nbformat 4 is JSON with a
// published schema, so storing it buys GitHub rendering, nbconvert, and
// round-tripping with real Jupyter. Inventing a format would buy nothing.
//
// The one thing worth knowing about the format: multi-line strings are
// stored as arrays of lines *with* their trailing newlines, last line
// exempt. Jupyter accepts a plain string too, so reading tolerates both and
// writing always produces the array form.

import { NotebookModel, newCell } from './model.js';
import { MSG } from '../kernel/protocol.js';

const NBFORMAT = 4;
const NBFORMAT_MINOR = 5;

/** nbformat's multiline string: ["a\n", "b"] */
export function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  return lines.map((line, i) => (i === lines.length - 1 ? line : `${line}\n`))
    .filter((line, i) => !(i === lines.length - 1 && line === ''));
}

export function joinLines(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join('');
  return '';
}

/** Kernel messages -> nbformat output objects. */
export function messageToOutput(msg) {
  switch (msg.msg_type) {
    case MSG.STREAM:
      return { output_type: 'stream', name: msg.content.name, text: splitLines(msg.content.text) };
    case MSG.EXECUTE_RESULT:
      return {
        output_type: 'execute_result',
        execution_count: msg.content.execution_count,
        data: { 'text/plain': splitLines(msg.content.data['text/plain']) },
        metadata: {},
      };
    case MSG.DISPLAY_DATA:
      return {
        output_type: 'display_data',
        data: splitBundle(msg.content.data),
        metadata: msg.content.metadata ?? {},
      };
    case MSG.ERROR:
      return {
        output_type: 'error',
        ename: msg.content.ename,
        evalue: msg.content.evalue,
        traceback: msg.content.traceback,
      };
    default:
      return null;
  }
}

/**
 * A mime bundle in the shape nbformat stores it.
 *
 * Text types are split into nbformat's line arrays, which is what makes a
 * saved notebook diff sanely -- a chart that gained a point should be one
 * changed line, not one changed 40 KB string. Base64 payloads are left as
 * single strings, which is what Jupyter itself writes for `image/png`:
 * splitting bytes into "lines" would be splitting on a character that
 * carries no meaning there.
 */
export function splitBundle(data) {
  const out = {};
  for (const [mime, value] of Object.entries(data ?? {})) {
    const text = typeof value === 'string' ? value : joinLines(value);
    out[mime] = isBase64Mime(mime) ? text : splitLines(text);
  }
  return out;
}

function isBase64Mime(mime) {
  return mime.startsWith('image/') && mime !== 'image/svg+xml';
}

/** The whole bundle, with every entry joined back into a plain string. */
export function bundleOf(output) {
  const out = {};
  for (const [mime, value] of Object.entries(output?.data ?? {})) {
    out[mime] = joinLines(value);
  }
  return out;
}

/** The text an output renders as, whichever kind it is. */
export function outputText(output) {
  switch (output.output_type) {
    case 'stream':
      return joinLines(output.text);
    case 'execute_result':
    case 'display_data':
      return joinLines(output.data?.['text/plain'] ?? '');
    case 'error': {
      const traceback = (output.traceback ?? []).join('\n');
      return traceback || `${output.ename}: ${output.evalue}`;
    }
    default:
      return '';
  }
}

export function toIpynb(model, metadata = {}) {
  return {
    cells: model.cells.map((cell) => {
      const base = {
        cell_type: cell.cell_type,
        // Carried whole, not rebuilt: a notebook that arrived with tags,
        // slideshow settings or ExecuteTime stamps should leave with
        // them. The Lab's own folding and timing live in here too, under
        // nbformat's `jupyter.source_hidden` and `execution` keys.
        metadata: cell.metadata ?? {},
        source: splitLines(cell.source),
      };
      if (cell.cell_type !== 'code') return base;
      return {
        ...base,
        execution_count: cell.execution_count,
        outputs: cell.outputs ?? [],
      };
    }),
    metadata: {
      kernelspec: { display_name: 'Diluvium', language: 'lua', name: 'diluvium' },
      language_info: { name: 'lua', file_extension: '.lua' },
      ...metadata,
    },
    nbformat: NBFORMAT,
    nbformat_minor: NBFORMAT_MINOR,
  };
}

export class IpynbError extends Error {}

/**
 * Read a notebook. Strict enough to reject something that is not a notebook,
 * lenient about the things Jupyter itself is lenient about.
 */
export function fromIpynb(json) {
  const doc = typeof json === 'string' ? parseJson(json) : json;
  if (!doc || typeof doc !== 'object') throw new IpynbError('this file is not a notebook');
  if (!Array.isArray(doc.cells)) throw new IpynbError('this file has no cells array, so it is not a notebook');
  if (doc.nbformat !== undefined && doc.nbformat !== NBFORMAT) {
    throw new IpynbError(`nbformat ${doc.nbformat} is not supported; this reads nbformat ${NBFORMAT}`);
  }

  const cells = doc.cells.map((raw) => {
    const type = raw.cell_type === 'markdown' || raw.cell_type === 'raw' ? raw.cell_type : 'code';
    const cell = newCell(type, joinLines(raw.source));
    cell.metadata = (raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata))
      ? raw.metadata : {};
    if (type === 'code') {
      cell.execution_count = typeof raw.execution_count === 'number' ? raw.execution_count : null;
      cell.outputs = Array.isArray(raw.outputs) ? raw.outputs.filter(isKnownOutput) : [];
    }
    return cell;
  });

  return new NotebookModel(cells);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new IpynbError(`this file is not valid JSON: ${cause.message}`);
  }
}

function isKnownOutput(output) {
  return output && typeof output === 'object'
    && ['stream', 'execute_result', 'display_data', 'error'].includes(output.output_type);
}
