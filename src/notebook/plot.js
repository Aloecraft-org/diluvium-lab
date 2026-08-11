// Charts, drawn from data.
//
// The kernel sends `{ series: [{ kind, x, y, name }], title, ... }` and this
// file turns it into SVG. Nothing about the picture crosses the wire, which
// is the decision the whole feature rests on: a chart built in Lua could
// not know the page's theme, its width, or whether the reader is on a
// phone, so it would be wrong in dark mode and stale after a resize. It
// also means a notebook file carries numbers rather than markup, so opening
// someone else's notebook cannot render anything they wrote.
//
// The palette and the mark specs are not taste. Both modes' steps are
// validated -- lightness band, chroma floor, colour-vision separation,
// normal-vision separation, contrast against the surface -- and the light
// steps sit below 3:1 on white, which is why a legend is always present for
// two or more series and the table view is always one click away rather
// than an extra. Identity is never carried by colour alone.

import { el } from './dom.js';

/** How wide to draw when the container has not been laid out yet. */
const FALLBACK_WIDTH = 640;
const MIN_WIDTH = 220;
const DEFAULT_HEIGHT = 260;

/** Room for the axes. Left is widest because it holds the y labels. */
const PAD = { top: 14, right: 16, bottom: 30, left: 52 };

/**
 * The categorical slots, in fixed order. Never cycled: a ninth series is a
 * chart that needs splitting, not a ninth hue, so past the eighth the
 * renderer says so rather than quietly reusing slot 1 and inventing a
 * second series that looks like the first.
 */
export const SERIES_SLOTS = 8;

export function renderPlot(spec, { onNode } = {}) {
  const series = normaliseSeries(spec);
  const figure = el('figure', { class: 'viz', 'data-viz': 'plot' });

  if (spec.title) figure.appendChild(el('figcaption', { class: 'viz-title' }, [String(spec.title)]));

  // A legend for two or more; one series is named by the title and a
  // legend box for it would be a row of chrome saying what the heading
  // already said.
  if (series.length > 1) figure.appendChild(legendFor(series));

  const canvas = el('div', { class: 'viz-canvas' });
  const tooltip = el('div', { class: 'viz-tooltip', role: 'status', hidden: true });
  figure.appendChild(canvas);
  figure.appendChild(tooltip);

  const table = tableFor(spec, series);
  table.hidden = true;
  const toggle = el('button', {
    type: 'button', class: 'viz-toggle', 'data-action': 'viz-table',
    'aria-expanded': 'false',
  }, ['Table']);
  toggle.addEventListener('click', () => {
    table.hidden = !table.hidden;
    toggle.setAttribute('aria-expanded', table.hidden ? 'false' : 'true');
    toggle.textContent = table.hidden ? 'Table' : 'Hide table';
  });
  figure.appendChild(toggle);
  figure.appendChild(table);

  const height = clampHeight(spec.height);
  const draw = () => {
    const width = Math.max(MIN_WIDTH, Math.round(canvas.clientWidth) || FALLBACK_WIDTH);
    canvas.replaceChildren(drawSvg(spec, series, width, height, tooltip));
  };
  draw();

  // Re-draw on a real width change only. Without the threshold a chart
  // redraws on every sub-pixel reflow, and with no observer at all it is
  // wrong the moment the window moves -- which for a notebook that lives
  // in a resizable pane is most of the time.
  if (typeof ResizeObserver === 'function') {
    let lastWidth = 0;
    const observer = new ResizeObserver(() => {
      const width = Math.round(canvas.clientWidth);
      if (Math.abs(width - lastWidth) < 16) return;
      lastWidth = width;
      draw();
    });
    observer.observe(canvas);
    onNode?.(figure, () => observer.disconnect());
  } else {
    onNode?.(figure, () => {});
  }

  return figure;
}

function clampHeight(value) {
  const height = Number(value);
  if (!Number.isFinite(height)) return DEFAULT_HEIGHT;
  return Math.min(720, Math.max(120, Math.round(height)));
}

/**
 * Series, in a shape the drawing code can rely on: numbers or nulls, a
 * slot number, and a name.
 *
 * A non-numeric y is a gap rather than a zero. Charting a missing
 * measurement as zero is the oldest way to publish a false claim, and Lua
 * hands us `nil` and NaN often enough -- `math.log(0)`, a division that
 * did not happen -- that it has to be decided here rather than by accident.
 */
export function normaliseSeries(spec) {
  const raw = Array.isArray(spec?.series) ? spec.series : [];
  return raw.slice(0, SERIES_SLOTS).map((s, i) => ({
    name: s.name ? String(s.name) : `series ${i + 1}`,
    named: Boolean(s.name),
    kind: s.kind === 'bar' || s.kind === 'scatter' ? s.kind : 'line',
    slot: i + 1,
    points: (Array.isArray(s.y) ? s.y : []).map((y, j) => ({
      x: numberOr(Array.isArray(s.x) ? s.x[j] : undefined, j + 1),
      y: numberOr(y, null),
    })),
  }));
}

function numberOr(value, fallback) {
  // `null` has to be rejected before `Number` sees it: `Number(null)` is
  // **0**, and `Number('')` is 0 as well. A JSON null is exactly how a
  // missing measurement arrives -- the Lua encoder writes one for nil, NaN
  // and the infinities -- so coercing it silently charts a gap as a real
  // zero, which is the one thing the gap handling exists to prevent.
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function legendFor(series) {
  return el('div', { class: 'viz-legend' }, series.map((s) => el('span', {
    class: 'viz-key', 'data-slot': s.slot,
  }, [el('span', { class: 'viz-swatch', 'aria-hidden': 'true' }), s.name])));
}

/**
 * The same numbers as a table.
 *
 * Not a fallback. Three of the light-mode series steps sit below 3:1
 * against a white surface, and the rule for that is relief -- visible
 * labels or a table -- rather than a different palette, since the steps
 * are chosen as a set and re-stepping one breaks the separation checks for
 * the others. It is also just the thing a notebook reader wants often
 * enough: a chart answers "what shape", a table answers "what exactly".
 */
function tableFor(spec, series) {
  const xs = [];
  for (const s of series) for (const p of s.points) if (!xs.includes(p.x)) xs.push(p.x);
  xs.sort((a, b) => a - b);
  const label = (x, i) => (Array.isArray(spec.labels) && spec.labels[i] !== undefined
    ? String(spec.labels[i]) : format(x));

  const head = el('tr', {}, [el('th', { scope: 'col' }, [spec.x_label ? String(spec.x_label) : 'x'])]);
  for (const s of series) head.appendChild(el('th', { scope: 'col' }, [s.name]));

  const body = xs.map((x, i) => {
    const row = el('tr', {}, [el('th', { scope: 'row' }, [label(x, i)])]);
    for (const s of series) {
      const point = s.points.find((p) => p.x === x);
      row.appendChild(el('td', {}, [point && point.y !== null ? format(point.y) : '—']));
    }
    return row;
  });

  return el('table', { class: 'viz-table' }, [
    el('thead', {}, [head]),
    el('tbody', {}, body),
  ]);
}

// --- drawing ---------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, kids = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  for (const kid of [].concat(kids)) {
    if (kid === null || kid === undefined) continue;
    node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return node;
}

function drawSvg(spec, series, width, height, tooltip) {
  const isBar = series.some((s) => s.kind === 'bar');
  const plotWidth = Math.max(20, width - PAD.left - PAD.right);
  const plotHeight = Math.max(20, height - PAD.top - PAD.bottom);

  const values = series.flatMap((s) => s.points.map((p) => p.y)).filter((y) => y !== null);
  const xs = series.flatMap((s) => s.points.map((p) => p.x));

  // A bar chart's baseline is zero or it is lying about the ratio between
  // its bars. A line chart may crop, because the question there is shape.
  const yBounds = niceBounds(
    numberOr(spec.y_min, isBar ? Math.min(0, ...values) : Math.min(...values)),
    numberOr(spec.y_max, Math.max(...values, isBar ? 0 : -Infinity)),
  );
  const xBounds = isBar
    ? { min: 0.5, max: Math.max(...xs, 1) + 0.5 }
    : niceBounds(Math.min(...xs), Math.max(...xs), { pad: false });

  const xAt = (x) => PAD.left + ((x - xBounds.min) / (xBounds.max - xBounds.min || 1)) * plotWidth;
  const yAt = (y) => PAD.top + plotHeight - ((y - yBounds.min) / (yBounds.max - yBounds.min || 1)) * plotHeight;

  const root = svg('svg', {
    class: 'viz-svg', width, height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': describe(spec, series),
  });

  // Grid and axes are recessive: horizontal rules only, no box, no
  // vertical grid. The data is the thing with contrast.
  const grid = svg('g', { class: 'viz-grid', 'aria-hidden': 'true' });
  for (const tick of yBounds.ticks) {
    const y = yAt(tick);
    grid.appendChild(svg('line', { x1: PAD.left, x2: PAD.left + plotWidth, y1: y, y2: y }));
    grid.appendChild(svg('text', {
      class: 'viz-tick', x: PAD.left - 8, y: y + 4, 'text-anchor': 'end',
    }, [format(tick)]));
  }
  root.appendChild(grid);

  const axis = svg('g', { class: 'viz-axis', 'aria-hidden': 'true' });
  for (const tick of xTicks(spec, series, xBounds, isBar)) {
    axis.appendChild(svg('text', {
      class: 'viz-tick', x: xAt(tick.at), y: height - PAD.bottom + 18, 'text-anchor': 'middle',
    }, [tick.label]));
  }
  if (spec.y_label) {
    axis.appendChild(svg('text', {
      class: 'viz-axis-label', x: 0, y: 0, 'text-anchor': 'middle',
      transform: `translate(12 ${PAD.top + plotHeight / 2}) rotate(-90)`,
    }, [String(spec.y_label)]));
  }
  if (spec.x_label) {
    axis.appendChild(svg('text', {
      class: 'viz-axis-label', x: PAD.left + plotWidth / 2, y: height - 2, 'text-anchor': 'middle',
    }, [String(spec.x_label)]));
  }
  root.appendChild(axis);

  // A zero line, where zero is inside the range and is not already the
  // bottom edge -- the one reference a reader needs to see crossings.
  if (yBounds.min < 0 && yBounds.max > 0) {
    root.appendChild(svg('line', {
      class: 'viz-zero', x1: PAD.left, x2: PAD.left + plotWidth, y1: yAt(0), y2: yAt(0),
    }));
  }

  const marks = svg('g', { class: 'viz-marks' });
  const barSeries = series.filter((s) => s.kind === 'bar');
  for (const s of series) {
    if (s.kind === 'bar') drawBars(marks, s, barSeries, xAt, yAt, yBounds, plotWidth, xBounds);
    else drawLineOrDots(marks, s, xAt, yAt);
  }
  root.appendChild(marks);

  attachHover(root, series, spec, xAt, tooltip,
    { left: PAD.left, width: plotWidth, bottom: height - PAD.bottom });
  return root;
}

/**
 * Bars: 4px rounded ends at the data end, square at the baseline, and a 2px
 * gap between neighbours so two adjacent bars never read as one block.
 */
function drawBars(parent, s, barSeries, xAt, yAt, yBounds, plotWidth, xBounds) {
  const slots = barSeries.length;
  const index = barSeries.indexOf(s);
  const span = plotWidth / Math.max(1, xBounds.max - xBounds.min);
  const groupWidth = Math.max(2, span * 0.72);
  const barWidth = Math.max(1, groupWidth / slots - 2);
  const base = yAt(Math.max(yBounds.min, 0));

  for (const point of s.points) {
    if (point.y === null) continue;
    const centre = xAt(point.x) - groupWidth / 2 + (index + 0.5) * (groupWidth / slots);
    const top = yAt(point.y);
    const height = Math.abs(base - top);
    parent.appendChild(svg('rect', {
      class: 'viz-bar', 'data-slot': s.slot,
      x: centre - barWidth / 2, y: Math.min(base, top),
      width: barWidth, height: Math.max(1, height),
      rx: Math.min(4, barWidth / 2),
    }));
  }
}

function drawLineOrDots(parent, s, xAt, yAt) {
  if (s.kind === 'line') {
    // Each run of present points is its own path, so a gap stays a gap.
    // Bridging it with a straight segment would draw a measurement that
    // was never taken.
    for (const run of runsOf(s.points)) {
      if (run.length < 2) continue;
      parent.appendChild(svg('path', {
        class: 'viz-line', 'data-slot': s.slot, fill: 'none',
        d: run.map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(p.x)} ${yAt(p.y)}`).join(' '),
      }));
    }
  }
  // Markers on scatter always, and on a line only when the run is a single
  // point -- otherwise a 40-point line becomes 40 dots and the shape is
  // lost behind them.
  const dotted = s.kind === 'scatter'
    ? s.points.filter((p) => p.y !== null)
    : runsOf(s.points).filter((run) => run.length === 1).flat();
  for (const point of dotted) {
    parent.appendChild(svg('circle', {
      class: 'viz-dot', 'data-slot': s.slot,
      cx: xAt(point.x), cy: yAt(point.y), r: 4.5,
    }));
  }
}

function runsOf(points) {
  const runs = [];
  let run = [];
  for (const point of points) {
    if (point.y === null) { if (run.length) runs.push(run); run = []; continue; }
    run.push(point);
  }
  if (run.length) runs.push(run);
  return runs;
}

/**
 * The hover layer, which is not optional: an SVG chart in a page is
 * interactive whether or not anyone designed it to be, and a reader who
 * points at a mark and gets nothing has been told the chart is dead.
 *
 * One crosshair keyed on the nearest x, so a multi-series chart reports
 * every series at that x rather than making the reader hunt for marks.
 */
function attachHover(root, series, spec, xAt, tooltip, plot) {
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
  if (!xs.length) return;

  const crosshair = svg('line', {
    class: 'viz-crosshair', y1: PAD.top, y2: plot.bottom, hidden: true,
  });
  root.appendChild(crosshair);

  const label = (x) => {
    const i = xs.indexOf(x);
    return Array.isArray(spec.labels) && spec.labels[i] !== undefined
      ? String(spec.labels[i]) : format(x);
  };

  const move = (event) => {
    const box = root.getBoundingClientRect();
    // The SVG is drawn at its measured CSS width, so client pixels and
    // user units are the same scale -- except while the browser is mid
    // reflow, when they are not. Scaling by the ratio costs nothing and
    // stops the crosshair drifting from the pointer at those moments.
    const scale = box.width ? root.getAttribute('width') / box.width : 1;
    const at = (event.clientX - box.left) * scale;
    if (at < plot.left - 8 || at > plot.left + plot.width + 8) return leave();

    let nearest = xs[0];
    for (const x of xs) if (Math.abs(xAt(x) - at) < Math.abs(xAt(nearest) - at)) nearest = x;

    crosshair.setAttribute('x1', xAt(nearest));
    crosshair.setAttribute('x2', xAt(nearest));
    crosshair.removeAttribute('hidden');

    const rows = series.map((s) => {
      const point = s.points.find((p) => p.x === nearest);
      if (!point || point.y === null) return null;
      return el('span', { class: 'viz-key', 'data-slot': s.slot }, [
        el('span', { class: 'viz-swatch', 'aria-hidden': 'true' }),
        series.length > 1 ? `${s.name} ` : '',
        el('b', {}, [format(point.y)]),
      ]);
    }).filter(Boolean);

    tooltip.replaceChildren(el('span', { class: 'viz-tip-x' }, [label(nearest)]), ...rows);
    tooltip.hidden = false;
    // Kept inside the figure: a tooltip that runs off the right edge of a
    // narrow phone screen is a tooltip nobody can read.
    const offset = Math.min(Math.max(0, at / scale - 40), Math.max(0, box.width - 160));
    tooltip.style.transform = `translateX(${Math.round(offset)}px)`;
  };

  const leave = () => {
    crosshair.setAttribute('hidden', '');
    tooltip.hidden = true;
  };

  root.addEventListener('pointermove', move);
  root.addEventListener('pointerdown', move);
  root.addEventListener('pointerleave', leave);
}

/** What a screen reader hears instead of the picture. */
function describe(spec, series) {
  const kinds = [...new Set(series.map((s) => s.kind))].join(' and ');
  const points = series.reduce((n, s) => n + s.points.length, 0);
  const named = series.filter((s) => s.named).map((s) => s.name);
  return [
    spec.title ? `${spec.title}.` : '',
    `${kinds} chart, ${series.length} series, ${points} points.`,
    named.length ? `Series: ${named.join(', ')}.` : '',
    'The table below has the values.',
  ].filter(Boolean).join(' ');
}

/**
 * Axis bounds a human would have chosen, and the ticks to go with them.
 *
 * `pad` widens the range by a step so marks do not sit on the frame; the x
 * axis skips it, because padding x invents room on both sides of data that
 * has a real extent.
 */
export function niceBounds(min, max, { pad = true, count = 5 } = {}) {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 1;
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  if (hi < lo) [lo, hi] = [hi, lo];

  const step = niceStep((hi - lo) / Math.max(1, count));
  if (pad) {
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
  }

  const ticks = [];
  const first = Math.ceil(lo / step) * step;
  for (let t = first; t <= hi + step / 1000 && ticks.length < 12; t += step) {
    // Floating point makes 0.30000000000000004 out of three additions of
    // 0.1, and an axis labelled that way looks broken. Snap to the step.
    ticks.push(Math.round(t / step) * step);
  }
  return { min: lo, max: hi, ticks, step };
}

function niceStep(rough) {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const snapped = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return snapped * magnitude;
}

/**
 * Where the x labels go, and what they say.
 *
 * Categorical labels (`plot.bar`) name each bar; a numeric axis gets the
 * nice ticks. Either way the count is capped, because labels that collide
 * are worse than labels that are absent.
 */
function xTicks(spec, series, bounds, isBar) {
  if (Array.isArray(spec.labels) && spec.labels.length) {
    const stride = Math.ceil(spec.labels.length / 12);
    return spec.labels.map((text, i) => ({ at: i + 1, label: String(text) }))
      .filter((_, i) => i % stride === 0);
  }
  if (isBar) {
    const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
    const stride = Math.ceil(xs.length / 12);
    return xs.filter((_, i) => i % stride === 0).map((x) => ({ at: x, label: format(x) }));
  }
  return niceBounds(bounds.min, bounds.max, { pad: false, count: 6 })
    .ticks.map((x) => ({ at: x, label: format(x) }));
}

/** Numbers that read as numbers: no 12 significant figures, no 1e-16. */
export function format(value) {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6 || magnitude < 1e-4) return value.toExponential(1).replace('e+', 'e');
  const decimals = magnitude >= 100 ? 0 : magnitude >= 1 ? 2 : 4;
  return String(Number(value.toFixed(decimals)));
}
