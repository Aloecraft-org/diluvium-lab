// What a `display_data` output looks like on the page.
//
// One dispatcher, keyed on mime type, over the bundle nbformat stores. The
// bundle carries several representations of one thing and the *richest one
// this page understands* wins -- which is Jupyter's rule, and the reason a
// notebook written here still says something useful when opened somewhere
// that has never heard of Diluvium: `text/plain` always ships alongside.
//
// The types the Lab draws itself carry data, never markup. A chart is
// `{"series": [...]}`, an event stream is a list of records, a control is
// its own description. None of them can carry a script, an event handler
// or a remote URL, whatever the file says -- which matters, because a
// notebook is untrusted input and this is the first feature that renders
// something other than text out of one.
//
// Two types do carry markup, because there is no way for them not to:
// `image/svg+xml` and raster images. SVG goes through `sanitiseSvg` on the
// way in; raster images become data URIs and never a URL, so nothing here
// can make a request.

import { el } from './dom.js';
import { renderPlot } from './plot.js';
import { MIME } from '../kernel/lua-harness.js';

/**
 * Mime types this page can draw, richest first.
 *
 * Order is the whole contract: a bundle with both a plot and a text
 * fallback is a plot, and the same bundle in a reader that knows only
 * `text/plain` is a line of text. Nothing needs to negotiate.
 */
export const RENDERABLE = [
  MIME.PLOT,
  MIME.EVENTS,
  MIME.WIDGET,
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/json',
  'text/plain',
];

export function preferredMime(bundle) {
  return RENDERABLE.find((mime) => typeof bundle?.[mime] === 'string') ?? null;
}

/**
 * Render one bundle.
 *
 * @param {Record<string,string>} bundle
 * @param {object} [ctx]
 * @param {(id: string, value: unknown) => void} [ctx.onWidget] a control moved
 * @param {boolean} [ctx.widgetsEnabled] false disables controls rather than
 *   letting them look live and do nothing
 * @param {(node: HTMLElement, dispose: () => void) => void} [ctx.onNode]
 * @returns {HTMLElement|null} null when nothing here can draw it, and the
 *   caller should fall back to text
 */
export function renderBundle(bundle, ctx = {}) {
  const mime = preferredMime(bundle);
  if (!mime || mime === 'text/plain') return null;
  const data = bundle[mime];

  try {
    switch (mime) {
      case MIME.PLOT: return renderPlot(parseSpec(data), ctx);
      case MIME.EVENTS: return renderEvents(parseSpec(data));
      case MIME.WIDGET: return renderWidget(parseSpec(data), ctx);
      case 'image/svg+xml': return renderSvg(data);
      case 'application/json': return renderJson(data);
      default: return renderImage(mime, data);
    }
  } catch (err) {
    // A bundle that will not render is a bad output, not a broken page.
    // Saying which type failed is the difference between "the notebook is
    // broken" and "this one chart came from a newer Lab".
    return el('div', { class: 'display-broken', 'data-broken': mime }, [
      `This ${mime} output could not be shown: ${err.message}`,
    ]);
  }
}

// Named for what it parses rather than for how, because `parseJson` is
// already a top-level name in ipynb.js and the bake flattens every module
// into one scope -- so two of them is a silent shadow. Its duplicate-name
// guard caught this, for the third time in this project's life.
function parseSpec(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object') throw new Error('it is not an object');
  return value;
}

// --- events ----------------------------------------------------------

/**
 * The kinds a swarm reports, and how each reads.
 *
 * These are `doc/Messaging.md` §9.2's list verbatim -- `spawned`, `exited`,
 * `faulted`, `exceeded`, `hibernated`, `throttled`, `denied`, `status` --
 * so a stream drained from a real `system/events` queue renders here with
 * no translation step to get wrong. Anything else still renders; it just
 * gets the neutral tone.
 *
 * The severities are the reserved status colours, which is why they are
 * not the chart palette: a fault must never be able to look like series 8.
 * Each ships with a word as well as a colour, because a colour alone says
 * nothing to a third of readers on a bad monitor.
 */
export const EVENT_KINDS = {
  spawned: { tone: 'good', text: 'spawned' },
  exited: { tone: 'neutral', text: 'exited' },
  faulted: { tone: 'critical', text: 'faulted' },
  exceeded: { tone: 'serious', text: 'over budget' },
  hibernated: { tone: 'neutral', text: 'hibernated' },
  throttled: { tone: 'warning', text: 'throttled' },
  denied: { tone: 'warning', text: 'denied' },
  status: { tone: 'neutral', text: 'status' },
};

export function renderEvents(spec) {
  const events = Array.isArray(spec.events) ? spec.events : [];
  const root = el('div', { class: 'events', 'data-viz': 'events' });

  if (spec.title) root.appendChild(el('div', { class: 'events-title' }, [String(spec.title)]));

  // Counts first. Scrolling a stream tells you what happened; the tally
  // tells you whether it went well, which is the question someone
  // watching a swarm actually has.
  const tally = new Map();
  for (const event of events) {
    const kind = String(event.event ?? event.kind ?? 'status');
    tally.set(kind, (tally.get(kind) ?? 0) + 1);
  }
  const summary = el('div', { class: 'events-tally' });
  for (const [kind, count] of [...tally].sort((a, b) => b[1] - a[1])) {
    summary.appendChild(el('span', {
      class: 'events-chip', 'data-tone': toneOf(kind),
    }, [`${EVENT_KINDS[kind]?.text ?? kind} ${count}`]));
  }
  root.appendChild(summary);

  const rows = events.map((event, i) => {
    const kind = String(event.event ?? event.kind ?? 'status');
    const detail = event.detail === undefined || event.detail === null ? '' : String(event.detail);
    return el('tr', { 'data-tone': toneOf(kind), 'data-kind': kind }, [
      el('td', { class: 'events-seq' }, [String(event.seq ?? i + 1)]),
      el('td', { class: 'events-kind' }, [EVENT_KINDS[kind]?.text ?? kind]),
      el('td', { class: 'events-id' }, [event.id === undefined ? '' : `#${event.id}`]),
      el('td', { class: 'events-detail' }, [detail]),
    ]);
  });

  root.appendChild(el('table', { class: 'events-table' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col' }, ['#']),
      el('th', { scope: 'col' }, ['event']),
      el('th', { scope: 'col' }, ['instance']),
      el('th', { scope: 'col' }, ['detail']),
    ])]),
    el('tbody', {}, rows.length ? rows : [el('tr', {}, [
      el('td', { colspan: '4', class: 'events-empty' }, ['no events']),
    ])]),
  ]));
  return root;
}

function toneOf(kind) {
  return EVENT_KINDS[kind]?.tone ?? 'neutral';
}

// --- controls --------------------------------------------------------

/**
 * A control, and the slot its callback's output lands in.
 *
 * The output slot is session-only and deliberately so: it is the answer to
 * *this* drag of *this* slider, and writing every intermediate answer into
 * the document would fill a saved notebook with the frames of an
 * animation. What is saved is the control and its last value.
 *
 * Where the backend cannot re-enter the program -- and after a reload,
 * before anything has run -- the control is disabled rather than live. A
 * slider that moves and does nothing is a worse lie than one that says it
 * is not connected.
 */
export function renderWidget(spec, ctx = {}) {
  const id = String(spec.id ?? '');
  const enabled = ctx.widgetsEnabled !== false && typeof ctx.onWidget === 'function';
  const root = el('div', { class: 'widget', 'data-widget': id, 'data-kind': spec.kind });
  const results = el('div', { class: 'widget-out', 'data-widget-out': id });

  const labelText = spec.label ? String(spec.label) : spec.kind;
  const readout = el('output', { class: 'widget-value' });

  const fire = (value) => ctx.onWidget?.(id, value, results, {});

  let control;
  if (spec.kind === 'slider') {
    const min = Number.isFinite(Number(spec.min)) ? Number(spec.min) : 0;
    const max = Number.isFinite(Number(spec.max)) ? Number(spec.max) : 100;
    const step = Number.isFinite(Number(spec.step)) ? Number(spec.step) : 'any';
    control = el('input', {
      type: 'range', min, max, step,
      value: Number.isFinite(Number(spec.value)) ? Number(spec.value) : min,
      'aria-label': labelText,
    });
    readout.textContent = control.value;
    // `input` rather than `change`: a slider that only answers when you
    // let go is not a slider, it is a form field. The kernel call is
    // coalesced by the caller, which is where it can see how long the
    // last one took.
    control.addEventListener('input', () => {
      readout.textContent = control.value;
      fire(Number(control.value));
    });
  } else if (spec.kind === 'select') {
    const options = Array.isArray(spec.options) ? spec.options : [];
    control = el('select', { 'aria-label': labelText },
      options.map((option) => el('option', { value: String(option) }, [String(option)])));
    if (spec.value !== undefined && spec.value !== null) control.value = String(spec.value);
    control.addEventListener('change', () => fire(control.value));
  } else if (spec.kind === 'checkbox') {
    control = el('input', { type: 'checkbox', 'aria-label': labelText });
    control.checked = spec.value === true;
    control.addEventListener('change', () => fire(control.checked));
  } else {
    control = el('button', { type: 'button', class: 'widget-button' },
      [spec.text ? String(spec.text) : labelText]);
    control.addEventListener('click', () => fire(true));
  }

  if (!enabled) {
    control.disabled = true;
    root.dataset.disabled = 'true';
  }

  const showsLabel = spec.kind !== 'button';
  root.appendChild(el('div', { class: 'widget-row' }, [
    showsLabel ? el('span', { class: 'widget-label' }, [labelText]) : null,
    control,
    spec.kind === 'slider' ? readout : null,
    enabled ? null : el('span', { class: 'widget-note' }, ['not connected to a kernel']),
  ]));
  root.appendChild(results);

  // Run the callback once, at the value the control was created with, so
  // running the cell *shows* something instead of showing a slider and
  // waiting to be poked. `interact` in Jupyter does the same, and for the
  // same reason: a control with nothing under it reads as broken.
  //
  // Not for a button: a button that presses itself is not a button. And
  // marked `auto`, so a notebook reopened from a file -- where the
  // callbacks died with the kernel that held them -- gets a quiet nothing
  // rather than a warning on every control it contains.
  if (enabled && spec.kind !== 'button') {
    ctx.onWidget(id, initialValue(spec, control), results, { auto: true });
  }
  return root;
}

function initialValue(spec, control) {
  if (spec.kind === 'checkbox') return control.checked;
  if (spec.kind === 'select') return control.value;
  return Number(control.value);
}

// --- images and json -------------------------------------------------

function renderImage(mime, base64) {
  // A data URI, never a URL. Nothing a notebook contains can cause this
  // page to make a request, which is the property the no-external-requests
  // constraint is protecting and the one an `<img src>` would give away.
  const clean = base64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('it is not base64');
  const img = el('img', {
    class: 'display-image', alt: 'output image', loading: 'lazy',
    src: `data:${mime};base64,${clean}`,
  });
  return el('div', { class: 'display-media' }, [img]);
}

function renderSvg(source) {
  const svg = sanitiseSvg(source);
  if (!svg) throw new Error('it is not an SVG document');
  svg.classList.add('display-svg');
  return el('div', { class: 'display-media' }, [svg]);
}

function renderJson(text) {
  // Pretty-printed as text. A collapsible tree would be nicer and would be
  // the third structured renderer in this file; the echo already renders
  // Lua tables readably, so this is for the case where the program chose
  // JSON on purpose.
  return el('pre', { class: 'display-json' }, [JSON.stringify(JSON.parse(text), null, 2)]);
}

/**
 * An SVG with everything that can act removed.
 *
 * Allowlisted rather than blocklisted, because a blocklist of dangerous
 * SVG is a list nobody has ever finished. What survives is shapes, paths,
 * text, groups and the attributes that position and colour them. What goes
 * is every element that can fetch or run -- `script`, `foreignObject`,
 * `use`, `image`, `animate` and friends -- every `on*` attribute, and every
 * URL-bearing attribute, since `href="javascript:"` and `href="http://"`
 * are the two ways a picture stops being a picture.
 *
 * Parsed with DOMParser in the XML mode, so nothing is executed to inspect
 * it: a detached XML document has no browsing context and no scripts run.
 *
 * @returns {SVGElement|null}
 */
export function sanitiseSvg(source) {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return null;
  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== 'svg') return null;

  const ALLOWED = new Set([
    'svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse',
    'line', 'polyline', 'polygon', 'text', 'tspan', 'marker', 'symbol',
    'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern',
  ]);

  const walk = (node) => {
    for (const child of [...node.children]) {
      if (!ALLOWED.has(child.localName.toLowerCase())) { child.remove(); continue; }
      for (const attr of [...child.attributes]) {
        if (!attributeIsSafe(attr)) child.removeAttributeNode(attr);
      }
      walk(child);
    }
  };
  for (const attr of [...root.attributes]) {
    if (!attributeIsSafe(attr)) root.removeAttributeNode(attr);
  }
  walk(root);

  // Adopted rather than imported wholesale so the returned node belongs to
  // the live document and lays out with the rest of the page.
  return document.importNode(root, true);
}

function attributeIsSafe(attr) {
  const name = attr.name.toLowerCase();
  if (name.startsWith('on')) return false;
  if (name === 'href' || name === 'xlink:href' || name === 'src') return false;
  // `style` can carry url(), and a url() in an SVG is a request. Presentation
  // attributes cover everything a drawing needs.
  if (name === 'style') return false;
  if (attr.value.toLowerCase().includes('url(')) return false;
  return true;
}
