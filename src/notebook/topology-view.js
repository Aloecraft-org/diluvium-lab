// The topology, drawn.
//
// `src/kernel/topology.js` is the model and knows nothing about the page;
// this is the only file that turns it into nodes. The split is not
// ceremony -- the model is the thing that should end up in `doc/Host.md`
// and grow a C implementation, and it can only do that if it never touched
// a DOM.
//
// Drawn as SVG here rather than by rendering the Mermaid this also emits,
// because Mermaid's renderer is about a megabyte and everything this page
// uses is vendored. The graph arrives already laid out as a tree, so the
// drawing is lines and circles. The Mermaid text is offered beside the
// picture for the places a picture cannot go: a PR, an issue, a design doc.

import { el } from './dom.js';
import { HOST_NODE, mermaidOf, layoutOf } from '../kernel/topology.js';

const SVG = 'http://www.w3.org/2000/svg';

/** Named `svgEl` and not `svg`: plot.js already owns `svg` at top level,
 *  and scripts/bake.mjs flattens every module into one scope and refuses a
 *  collision rather than shadowing one silently. */
function svgEl(tag, attrs = {}, kids = []) {
  const node = document.createElementNS(SVG, tag);
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

const NODE_R = 15;
/** Named for this file: plot.js already owns a top-level `PAD`, and the
 *  bake flattens every module into one scope. */
const GRAPH_PAD = { x: 46, y: 30 };
const GRAPH_ROW = 76;
/** How far a queue edge steps aside from the straight run between two
 *  nodes, so the two directions are two lines. */
const LANE = 13;

/**
 * The panel's topology section.
 *
 * @param {object} graph from `topologyOf`
 */
export function topologySection(graph) {
  const section = el('section', { class: 'swarm-topology', 'data-swarm-topology': '' });
  section.append(el('h3', {}, ['Topology']));

  if (!graph.nodes.length) {
    section.append(el('p', { class: 'muted' }, ['Nothing has been created yet.']));
    return section;
  }

  section.append(el('p', { class: 'muted' }, [
    `${graph.stats.instances} instance(s), ${graph.stats.live} live, ${graph.stats.depth + 1} `
    + 'generation(s). Solid lines are spawns, which the runtime is the authority on. '
    + 'Queue lines are routes the guest declared; a dashed one has carried nothing yet. '
    + 'There are no instance-to-instance edges because there is no such thing — a message '
    + 'leaves on an exported queue, the host takes it, and the host decides what happens next.',
  ]));
  section.append(diagram(graph));

  const text = mermaidOf(graph);
  section.append(el('details', { class: 'swarm-mermaid' }, [
    el('summary', {}, ['As Mermaid, for somewhere that renders it']),
    el('pre', { 'data-swarm-mermaid': '' }, [text]),
  ]));
  return section;
}

function diagram(graph) {
  const at = layoutOf(graph);
  const rows = Math.max(...[...at.values()].map((p) => p.y)) || 1;
  const height = GRAPH_PAD.y * 2 + GRAPH_ROW * (graph.stats.depth + 1);
  const width = 460;
  const place = (key) => {
    const p = at.get(key);
    return {
      x: GRAPH_PAD.x + p.x * (width - GRAPH_PAD.x * 2),
      y: GRAPH_PAD.y + (rows ? p.y / rows : 0) * (height - GRAPH_PAD.y * 2),
    };
  };

  const canvas = svgEl('svg', {
    class: 'swarm-graph',
    'data-swarm-graph': '',
    viewBox: `0 0 ${width} ${height}`,
    // Scales down on a phone; the panel is the thing that scrolls, never
    // the page, which is the rule the rest of the panel already keeps.
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': `swarm topology, ${graph.stats.instances} instances`,
  });

  canvas.append(svgEl('defs', {}, [
    svgEl('marker', {
      id: 'topo-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4,
      markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
    }, [svgEl('path', { d: 'M 0 0 L 8 4 L 0 8 z', class: 'topo-arrowhead' })]),
  ]));

  // Edges first, so a node always sits on top of the lines touching it.
  const edges = svgEl('g', { class: 'topo-edges' });
  for (const edge of bundle(graph.edges)) {
    if (!at.has(edge.from) || !at.has(edge.to)) continue;
    const a = place(edge.from);
    const b = place(edge.to);
    const spawn = edge.kind === 'spawn';
    const dead = !spawn && !edge.count;
    // Trimmed to the circle's edge at both ends, so the arrowhead lands on
    // the node rather than inside it.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    // Nudged sideways so the two directions between a pair are two lines
    // rather than one line drawn twice with its labels on top of each
    // other. Perpendicular to the run, so it works whatever the angle.
    //
    // Measured off a *canonical* orientation of the pair rather than off
    // the direction of travel: reversing the travel flips the perpendicular
    // as well as the side, the two cancel, and both lines land in the same
    // place -- which is what the first version of this did.
    const forward = String(edge.from) < String(edge.to);
    const cuy = forward ? uy : -uy;
    const cux = forward ? ux : -ux;
    const side = spawn ? 0 : (edge.from === HOST_NODE ? LANE : -LANE);
    const ox = -cuy * side;
    const oy = cux * side;
    edges.append(svgEl('line', {
      x1: (a.x + ux * NODE_R + ox).toFixed(1), y1: (a.y + uy * NODE_R + oy).toFixed(1),
      x2: (b.x - ux * NODE_R + ox).toFixed(1), y2: (b.y - uy * NODE_R + oy).toFixed(1),
      class: `topo-edge topo-edge-${edge.kind}${dead ? ' topo-edge-idle' : ''}`,
      'marker-end': 'url(#topo-arrow)',
      'data-edge': `${edge.from}>${edge.to}`,
      'data-edge-kind': edge.kind,
      'data-edge-queues': edge.queues ? edge.queues.length : null,
    }, edge.queues ? [svgEl('title', {}, [edge.queues
      .map((q) => `${q.queue}: ${q.count} message(s)`).join('\n')])] : []));
    if (!spawn) {
      // Parked at different points along the run as well as on different
      // sides of it: two labels centred on the same midpoint collide even
      // when their lines do not.
      //
      // And parked near the *instance* end whichever way the edge runs,
      // because every queue edge has the host at its other end -- putting
      // them near the host stacked every label in the swarm on one spot,
      // while the instances are spread across their row and their labels
      // spread with them.
      const t = edge.from === HOST_NODE ? 0.72 : 0.28;
      edges.append(svgEl('text', {
        x: (a.x + dx * t + ox).toFixed(1),
        y: (a.y + dy * t + oy - 4).toFixed(1),
        class: 'topo-edge-label',
        'text-anchor': edge.from === HOST_NODE ? 'start' : 'end',
      }, [edge.label]));
    }
  }
  canvas.append(edges);

  const host = place(HOST_NODE);
  canvas.append(svgEl('g', { class: 'topo-node topo-host', 'data-node': 'host' }, [
    svgEl('rect', {
      x: host.x - 30, y: host.y - 12, width: 60, height: 24, rx: 4, class: 'topo-shape',
    }),
    svgEl('text', { x: host.x, y: host.y + 4, class: 'topo-label', 'text-anchor': 'middle' }, ['host']),
  ]));

  for (const node of graph.nodes) {
    const p = place(node.id);
    const name = node.names.length ? node.names[0] : String(node.id);
    const group = svgEl('g', {
      class: `topo-node topo-state-${node.state}`,
      'data-node': String(node.id),
      'data-node-state': node.state,
    });
    group.append(svgEl('title', {}, [describeNode(node)]));
    group.append(svgEl('circle', { cx: p.x, cy: p.y, r: NODE_R, class: 'topo-shape' }));
    group.append(svgEl('text', {
      x: p.x, y: p.y + 4, class: 'topo-label', 'text-anchor': 'middle',
    }, [String(node.id)]));
    // The caption is a *name*, and "root · root" is what appending the role
    // to it produced -- `SwarmHost.start` pre-aliases the root to `root`, so
    // the role was already the name. Appended only when it adds something.
    const caption = node.role === 'root' && name !== 'root' ? `${name} · root` : name;
    group.append(svgEl('text', {
      x: p.x, y: p.y + NODE_R + 13, class: 'topo-caption', 'text-anchor': 'middle',
    }, [caption]));
    canvas.append(group);
  }
  return canvas;
}

/**
 * Collapse queue edges that join the same pair in the same direction.
 *
 * The model keeps one edge per queue, which is the right thing for it to
 * keep and is what the Mermaid emits. Drawing them all is not: a program
 * with five exported queues put five arrows and five labels on the same
 * two points, and the result said less than one arrow would have. The
 * per-queue detail moves to the line's tooltip, where it is a hover away
 * rather than a pile.
 *
 * Spawn edges are never bundled -- there is only ever one, and it is the
 * shape the picture exists to show.
 */
function bundle(edges) {
  const out = [];
  const groups = new Map();
  for (const edge of edges) {
    if (edge.kind === 'spawn') { out.push({ ...edge, label: 'spawn' }); continue; }
    const key = `${edge.from}>${edge.to}`;
    if (!groups.has(key)) {
      groups.set(key, { from: edge.from, to: edge.to, kind: edge.kind, count: 0, queues: [] });
    }
    const group = groups.get(key);
    group.count += edge.count ?? 0;
    group.queues.push({ queue: edge.queue, count: edge.count ?? 0 });
  }
  for (const group of groups.values()) {
    const carrying = group.queues.filter((q) => q.count);
    // One queue names itself. Several name how many there are and how much
    // has crossed, because a list of five does not fit and a truncated list
    // reads as the whole list.
    group.label = group.queues.length === 1
      ? (group.count ? `${group.queues[0].queue} ×${group.count}` : group.queues[0].queue)
      : `${group.queues.length} queues${group.count ? ` ×${group.count}` : ''}`;
    group.carrying = carrying.length;
    out.push(group);
  }
  return out;
}

/** The tooltip. Everything the roster row would have said, in a sentence.
 *  `describeNode` and not `describe`: plot.js has its own `describe`. */
function describeNode(node) {
  const parts = [`instance ${node.id}`, node.role, node.state];
  if (node.outcome) parts.push(`outcome: ${node.outcome}`);
  if (node.usage) parts.push(`${node.usage.instructions.toLocaleString()} instructions`);
  if (!node.resident && node.cachedSize) parts.push(`${node.cachedSize} bytes cached`);
  parts.push(node.caps.length ? `caps: ${node.caps.join(' ')}` : 'no capabilities');
  return parts.join(' — ');
}
