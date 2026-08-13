import { test, expect } from '@playwright/test';

// The topology model, and the picture drawn from it.
//
// Two halves, tested apart on purpose. `src/kernel/topology.js` is a pure
// function over a host report and is meant to end up in `doc/Host.md` and
// grow a C implementation, so it is asserted as data — no page, no DOM. The
// panel half is asserted through the real page, driving a real swarm.

async function openKernelPage(page) {
  await page.goto('/test/kernel-page.html');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
}

/** A report shaped like `SwarmHost.snapshot()`, with only what this reads. */
const REPORT = {
  steps: 12,
  connectors: ['listen', 'time'],
  aliases: { root: 1, worker: 3 },
  roster: [
    {
      id: 1, parent: 0, role: 'root', state: 'parked', resident: true, caps: ['lifecycle', 'queue:*'],
      budget: { instructions: 500_000 }, usage: { instructions: 1000, peakMemoryKb: 84 },
      queues: [
        { name: 'http_in', length: 0, capacity: 16, exported: false },
        { name: 'log', length: 0, capacity: 64, exported: true },
        { name: 'idle_out', length: 0, capacity: 8, exported: true },
      ],
      delivered: { http_in: 2 }, createdAtStep: 0,
    },
    {
      id: 2, parent: 1, role: 'child', state: 'gone', resident: false, outcome: 'exited',
      caps: ['queue:*'], queues: [], delivered: {}, createdAtStep: 1, goneAtStep: 7,
    },
    {
      id: 3, parent: 1, role: 'child', state: 'hibernated', resident: false, cachedSize: 4096,
      caps: ['queue:*'], queues: [], delivered: {}, createdAtStep: 2,
    },
    {
      id: 4, parent: 3, role: 'child', state: 'running', resident: true,
      caps: [], queues: [], delivered: {}, createdAtStep: 3,
    },
  ],
  events: [
    { event: 'message', id: 1, queue: 'log', detail: 'x' },
    { event: 'message', id: 1, queue: 'log', detail: 'y' },
    { event: 'spawned', id: 2, detail: 'child of 1' },
  ],
};

const graphOf = (page, report = REPORT) =>
  page.evaluate((r) => window.lab.topologyOf(r), report);

test.describe('the model', () => {
  test('nodes carry their generation, their names and their state', async ({ page }) => {
    await openKernelPage(page);
    const graph = await graphOf(page);
    expect(graph.nodes.map((n) => [n.id, n.depth, n.state])).toEqual([
      [1, 0, 'parked'], [2, 1, 'gone'], [3, 1, 'hibernated'], [4, 2, 'running'],
    ]);
    // An alias is a name the roster does not carry, and more than one may
    // point at the same instance, so a node collects all of them.
    expect(graph.nodes[0].names).toEqual(['root']);
    expect(graph.nodes[2].names).toEqual(['worker']);
    expect(graph.stats).toMatchObject({ instances: 4, live: 3, gone: 1, depth: 2 });
  });

  test('spawn edges come from the runtime, not from a guess', async ({ page }) => {
    await openKernelPage(page);
    const graph = await graphOf(page);
    const spawns = graph.edges.filter((e) => e.kind === 'spawn').map((e) => `${e.from}>${e.to}`);
    // Three, not four: the root has no parent, so nothing spawned it.
    expect(spawns).toEqual(['1>2', '1>3', '3>4']);
    expect(graph.edges.every((e) => e.declared)).toBe(true);
  });

  test('traffic is counted in both directions, and a route with none still shows', async ({ page }) => {
    await openKernelPage(page);
    const graph = await graphOf(page);
    const named = (kind) => graph.edges.filter((e) => e.kind === kind)
      .map((e) => `${e.from}>${e.to} ${e.queue}=${e.count}`);
    // Inbound: what the host pushed and the push returned OK for.
    expect(named('deliver')).toEqual(['host>1 http_in=2']);
    // Outbound: exported queues, counted from the messages actually drained.
    // `idle_out` is declared and has carried nothing, and is present at zero
    // rather than absent — a route that exists is a fact about the program.
    expect(named('export')).toEqual(['1>host log=2', '1>host idle_out=0']);
  });

  test('there are no instance-to-instance edges, because there is no such thing', async ({ page }) => {
    await openKernelPage(page);
    const graph = await graphOf(page);
    // A guest cannot push to another guest. A message leaves on an exported
    // queue, the host takes it, and the host decides what happens next --
    // so A → B would assert a route the runtime does not have.
    const queueEdges = graph.edges.filter((e) => e.kind !== 'spawn');
    expect(queueEdges.every((e) => e.from === 'host' || e.to === 'host')).toBe(true);
  });

  test('an empty report is a graph with nothing in it, not a throw', async ({ page }) => {
    await openKernelPage(page);
    for (const empty of [{}, { roster: [] }, { roster: [], events: null }]) {
      const graph = await page.evaluate((r) => window.lab.topologyOf(r), empty);
      expect(graph.nodes).toEqual([]);
      expect(graph.edges).toEqual([]);
    }
  });
});

test.describe('the Mermaid it emits', () => {
  test('is a flowchart naming every instance and every edge', async ({ page }) => {
    await openKernelPage(page);
    const text = await page.evaluate((r) => window.lab.mermaidOf(window.lab.topologyOf(r)), REPORT);
    expect(text.split('\n')[0]).toBe('flowchart TD');
    for (const id of ['i1', 'i2', 'i3', 'i4', 'host']) expect(text).toContain(id);
    // Named once, not twice: the root's alias *is* `root`, so the role
    // adds nothing and is left off.
    expect(text).toContain('1 root · parked');
    expect(text).not.toContain('root · root');
    expect(text).toContain('2 · gone: exited');
    expect(text).toContain('|"log ×2"|');
    // A declared route with no traffic is dotted, and the legend says so
    // rather than leaving a reader to infer it from the line style.
    expect(text).toContain('-.->');
    expect(text).toContain('%% dotted');
  });

  test('a label that would break the syntax is escaped rather than emitted', async ({ page }) => {
    await openKernelPage(page);
    const text = await page.evaluate(() => window.lab.mermaidOf(window.lab.topologyOf({
      roster: [{ id: 1, parent: 0, role: 'root', state: 'gone', outcome: 'said "no"', queues: [] }],
      aliases: {}, events: [],
    })));
    // Mermaid has no backslash escape inside a quoted label; `#quot;` is the
    // entity form. A raw quote here would end the label early and the rest
    // of the line would be read as syntax -- so every line that carries a
    // label must hold exactly two quote characters, the ones delimiting it.
    expect(text).toContain('#quot;no#quot;');
    for (const line of text.split('\n')) {
      const quotes = (line.match(/"/g) ?? []).length;
      expect(`${line} -> ${quotes} quote(s)`).toMatch(/-> (0|2) quote\(s\)$/);
    }
  });
});

test.describe('the layout', () => {
  test('puts the host above the root and each generation below the last', async ({ page }) => {
    await openKernelPage(page);
    const at = await page.evaluate((r) => {
      const map = window.lab.layoutOf(window.lab.topologyOf(r));
      return Object.fromEntries([...map.entries()].map(([k, v]) => [k, v]));
    }, REPORT);
    expect(at.host.y).toBe(0);
    expect(at['1'].y).toBeGreaterThan(at.host.y);
    expect(at['2'].y).toBeGreaterThan(at['1'].y);
    expect(at['4'].y).toBeGreaterThan(at['2'].y);
    // Siblings share a row and are spread across it rather than stacked.
    expect(at['2'].y).toBe(at['3'].y);
    expect(at['2'].x).not.toBe(at['3'].x);
    // Everything stays inside the unit box, so the caller owns the pixels.
    for (const p of Object.values(at)) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  test('a lone root does not divide by zero', async ({ page }) => {
    await openKernelPage(page);
    const at = await page.evaluate(() => {
      const map = window.lab.layoutOf(window.lab.topologyOf({
        roster: [{ id: 1, parent: 0, role: 'root', state: 'running', queues: [] }],
        aliases: { root: 1 }, events: [],
      }));
      return Object.fromEntries(map.entries());
    });
    for (const p of Object.values(at)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});
