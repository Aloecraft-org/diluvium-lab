// The sandbox panel: what this cell costs when a host runs it.
//
// A cell normally runs in the notebook's own Lua state — it keeps its
// globals, it can reach `io` and `os`, and nothing bounds it. **Run
// sandboxed** runs the same source as a `dv_` instance instead: its own
// state, its own queues, and an instruction budget that stops a runaway
// loop rather than waiting for one.
//
// That is the difference between a notebook and a lab. The interesting
// output here is not the program's — it is what the program *cost*, and
// whether it finished, ran out, or parked waiting for a message that in
// this Lab will never come, because nothing here can send one yet.
//
// Three honest limits, stated in the panel rather than hidden:
//
//  - **The instruction count is the budget hook.** An instance run without
//    a budget reports zero however much work it did, because the counter
//    *is* the mechanism that enforces the limit. So there is always a
//    budget, and the control picks how big.
//  - **There is no scheduler.** A program that parks is reported as
//    parked, with what it is waiting on, and that is where it stops. The
//    loop that would feed it is the swarm host, which is not in the
//    artifact.
//  - **Queues are looked up, not enumerated.** The ABI has no "list
//    queues" call, so the panel asks after the names §9.2 reserves plus a
//    few conventional ones.

import { el } from './dom.js';

/** Budgets offered, in instructions. Coarse on purpose: this is a dial. */
export const BUDGETS = [
  ['200 thousand', 200_000],
  ['1 million', 1_000_000],
  ['10 million', 10_000_000],
  ['100 million', 100_000_000],
];

const DEFAULT_BUDGET = 10_000_000;

/** How a run ended, and how that should read. */
export function outcomeOf(report) {
  if (!report) return { tone: 'neutral', text: 'not run yet' };
  if (report.stage === 'load') return { tone: 'critical', text: 'did not compile' };
  if (report.exceeded) return { tone: 'serious', text: 'over budget' };
  if (report.parked) return { tone: 'warning', text: 'parked, waiting' };
  if (report.status === 'DV_ERROR') return { tone: 'critical', text: 'error' };
  if (report.status === 'DV_DONE') return { tone: 'good', text: 'finished' };
  return { tone: 'neutral', text: report.status ?? 'unknown' };
}

const number = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

export class SandboxView {
  /**
   * @param {HTMLElement} root
   * @param {(code: string, options: object) => Promise<object>} run
   * @param {() => string} sourceOf
   */
  constructor(root, run, sourceOf) {
    this.root = root;
    this.run = run;
    this.sourceOf = sourceOf;
    this.budget = DEFAULT_BUDGET;
    this.report = null;
    this.busy = false;
    this.render();
  }

  async execute() {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      this.report = await this.run(this.sourceOf(), { instructions: this.budget });
    } catch (err) {
      this.report = { stage: 'host', status: 'DV_ERROR', error: err.message };
    } finally {
      this.busy = false;
      this.render();
    }
  }

  render() {
    const select = el('select', { 'data-sandbox-budget': true, 'aria-label': 'Instruction budget' },
      BUDGETS.map(([label, value]) => el('option', { value }, [label])));
    select.value = String(this.budget);
    select.addEventListener('change', () => { this.budget = Number(select.value); });

    const runButton = el('button', {
      type: 'button', class: 'sandbox-run', 'data-action': 'sandbox-run',
    }, [this.busy ? 'Running…' : 'Run sandboxed']);
    runButton.disabled = this.busy;
    runButton.addEventListener('click', () => this.execute());

    const controls = el('div', { class: 'sandbox-controls' }, [
      runButton,
      el('label', { class: 'sandbox-budget' }, ['budget ', select]),
      el('span', { class: 'sandbox-note' },
        ['its own state, its own queues — nothing is shared with the notebook']),
    ]);

    this.root.replaceChildren(controls, ...(this.report ? this.results() : []));
  }

  results() {
    const report = this.report;
    const outcome = outcomeOf(report);
    const out = [];

    out.push(el('div', { class: 'sandbox-summary' }, [
      el('span', { class: 'events-chip', 'data-tone': outcome.tone, 'data-outcome': true }, [outcome.text]),
      // The budget is shown beside the count always, because "100,000"
      // means nothing without "of 10,000,000" beside it.
      report.stage === 'run' ? el('span', { class: 'sandbox-stat' }, [
        'instructions ', el('b', {}, [number(report.instructions)]),
        ' of ', number(report.budget?.instructions),
      ]) : null,
      report.stage === 'run' ? el('span', { class: 'sandbox-stat' }, [
        'peak memory ', el('b', {}, [`${number(report.peakMemoryKb)} KB`]),
      ]) : null,
    ]));

    if (report.parked && report.waiting?.length) {
      const names = report.waiting
        .map((id) => report.queues?.find((q) => q.id === id)?.name ?? `queue ${id}`);
      out.push(el('p', { class: 'hint', 'data-sandbox-parked': true }, [
        `It is waiting on ${names.join(', ')}. Nothing here can send it a message: `
        + 'that is a host loop’s job, and the swarm layer it belongs to is not in this build.',
      ]));
    }

    if (report.stdout) {
      out.push(el('pre', { class: 'sandbox-output', 'data-sandbox-output': true }, [report.stdout]));
    }
    if (report.stderr) {
      out.push(el('pre', { class: 'sandbox-output sandbox-stderr' }, [report.stderr]));
    }
    if (report.error) {
      // The runtime's own words, traceback and all -- the same rule the
      // cell error path follows. A sandboxed traceback names the chunk
      // `sandbox`, which is how you tell the two runs apart.
      out.push(el('pre', { class: 'sandbox-error', 'data-sandbox-error': true }, [report.error]));
    }

    if (report.queues?.length) {
      out.push(el('table', { class: 'events-table sandbox-queues' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { scope: 'col' }, ['queue']),
          el('th', { scope: 'col' }, ['id']),
          el('th', { scope: 'col' }, ['messages']),
          el('th', { scope: 'col' }, ['state']),
        ])]),
        el('tbody', {}, report.queues.map((q) => el('tr', { 'data-queue': q.name }, [
          el('td', {}, [q.name]),
          el('td', { class: 'events-id' }, [`#${q.id}`]),
          el('td', { class: 'events-id' }, [`${q.length} / ${q.capacity}`]),
          el('td', {}, [[q.enabled ? 'enabled' : 'disabled', q.exported ? 'exported' : null]
            .filter(Boolean).join(', ')]),
        ]))),
      ]));
    }

    return out;
  }
}
