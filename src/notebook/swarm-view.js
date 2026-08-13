// The instances panel: a swarm, while it is running.
//
// The ask this was built for was "show sub instances as they are created",
// and the shape of the answer is decided by `doc/Host.md` duty 3 rather than
// by taste: **there is deliberately no enumeration API.** A host learns that
// an instance exists because its `create` callback fired, and learns it
// stopped because `destroy` did. So this panel is a view of the host's own
// roster, and every figure beside an id is asked of the thing it describes
// at the moment of asking -- `dvs_parent`, `dvs_caps`, `dvs_budget`,
// `dvs_resident`, `dvs_cached_size`, and `dv_usage` through `dvs_instance`
// while the instance is resident.
//
// Three things it says out loud rather than hiding, because each is a place
// where a prettier panel would be a lying one:
//
//   A hibernated instance shows no instruction count. The number is in its
//   snapshot header and the swarm API has no accessor for it yet;
//   `doc/Host.md` calls showing budget-and-cached-size-but-no-usage the
//   agreed v1 behaviour. Showing its last resident figure would be showing
//   a stale number as a live one.
//
//   Instructions are counted by the budget hook, which fires every 1000
//   instructions. A program that does less than that between parks reports
//   zero, and that is the counter's resolution rather than the program
//   doing nothing.
//
//   The listener binds no port. It is a mock, it says so, and it says which
//   port it *would* bind -- because that number is topology and it comes
//   from the configuration, exactly as it does on the C host.

import { el } from './dom.js';
import { topologyOf } from '../kernel/topology.js';
import { topologySection } from './topology-view.js';

/** Severity words for the §9.2 event kinds, from the reserved status palette. */
const EVENT_KIND = {
  spawned: 'good', exited: 'good', status: 'info', host: 'info', message: 'info',
  stdout: 'info', stderr: 'warn', hibernated: 'info', throttled: 'warn',
  denied: 'warn', faulted: 'bad', exceeded: 'bad',
};

/**
 * Render the panel.
 *
 * @param {Element} container
 * @param {object} options
 * @param {object|null} options.report the last swarm report, or null
 * @param {boolean} options.capable whether this kernel can host a swarm at all
 * @param {string} options.source the root program in the composer
 * @param {(patch: object) => void} options.onChange
 * @param {(action: string, arg?: any) => void} options.onAction
 */
export function renderSwarm(container, options) {
  const { report, capable, busy } = options;

  if (!capable) {
    container.append(unavailable());
    return;
  }

  container.append(controls(options));

  if (!report || !report.running) {
    container.append(el('p', { class: 'swarm-idle' }, [
      report && report.roster?.length
        ? 'This swarm has stopped. Its roster below is the last thing the host saw.'
        : 'No swarm is running. Choose a program and press Start.',
    ]));
    if (!report || !report.roster?.length) return;
  }

  if (report.stack?.moved) container.append(stackNote(report.stack));
  container.append(summary(report, busy));
  // Before the roster, because the shape is the question the panel was
  // asked -- "show sub instances as they are created" -- and the table is
  // the detail behind it rather than the other way round.
  container.append(topologySection(topologyOf(report)));
  container.append(roster(report, options));
  if (report.listener) {
    container.append(listenerSection(report.listener, {
      ...options,
      draft: options.draft ?? { method: 'GET', path: '/', body: '' },
    }));
  }
  if (report.sql) container.append(sqlSection(report.sql, options.onAction));
  if (report.faults?.length) container.append(faultsSection(report.faults));
  container.append(events(report.events ?? []));
}

function unavailable() {
  return el('div', { class: 'swarm-unavailable' }, [
    el('p', {}, ['This runtime cannot host a swarm.']),
    el('p', { class: 'muted' }, [
      'A swarm needs the `dvs_*` layer, which only `diluvium_swarm_wasi.wasm` carries and '
      + 'only from v5.5.1_build5. Older builds can still run a single sandboxed instance '
      + '— that is the Sandbox panel — but nothing in them can spawn.',
    ]),
    el('p', { class: 'muted' }, [
      'The single-file build is also in this case on purpose: it carries the kernel and '
      + 'nothing else, because a file:// page cannot fetch the megabyte the swarm needs. '
      + 'Serve the Lab to use one.',
    ]),
  ]);
}

/**
 * The workaround, stated where someone will see it.
 *
 * A patch nobody can see is a patch nobody will remove, and this one should
 * be removed the moment upstream passes `-z stack-size` on the swarm
 * module's link line.
 */
function stackNote(stack) {
  return el('details', { class: 'swarm-note', 'data-swarm-stack': '' }, [
    el('summary', {}, [`This build's shadow stack was too small; the Lab moved it (${
      Math.round(stack.had / 1024)} KiB → ${Math.round(stack.now / 1024)} KiB)`]),
    el('p', {}, [stack.why]),
  ]);
}

function summary(report, busy) {
  const roster = report.roster ?? [];
  const live = roster.filter((r) => r.state !== 'gone').length;
  return el('dl', { class: 'swarm-summary', 'data-swarm-summary': '' }, [
    ...pair('Step', String(report.steps ?? 0)),
    ...pair('Alive', String(report.alive ?? 0)),
    ...pair('Seen', String(roster.length)),
    ...pair('Live', String(live)),
    ...pair('Connectors', report.connectors?.length ? report.connectors.join(', ') : 'none wired'),
    ...(busy ? pair('Host', 'stepping…') : []),
  ]);
}

const pair = (term, value) => [el('dt', {}, [term]), el('dd', {}, [value])];

function controls({ report, busy, source, programs, staged, onChange, onAction }) {
  const running = !!report?.running;
  const row = el('div', { class: 'swarm-controls' });

  if (!running) {
    const select = el('select', { 'data-swarm-program': '', 'aria-label': 'Root program' });
    for (const program of programs ?? []) {
      select.append(el('option', { value: program.id, selected: program.id === source }, [program.label]));
    }
    select.addEventListener('change', () => onChange({ source: select.value }));
    row.append(select);
    row.append(actionButton('Start', 'swarm-start', () => onAction('start'), busy));
    // Only for a program that wires `sql`, and only before Start: the
    // database is opened when the swarm is built, so a file chosen after
    // that would be a file nothing read.
    if (programs?.find((p) => p.id === source)?.config?.connectors?.sql) {
      row.append(databaseChooser(staged, onAction));
    }
  } else {
    row.append(actionButton('Step', 'swarm-step', () => onAction('step'), busy));
    row.append(actionButton('Run', 'swarm-run', () => onAction('run'), busy));
    // Named Stop rather than Interrupt for the same reason the kernel's is:
    // this frees the swarm and takes every instance's Lua state with it.
    row.append(actionButton('Stop', 'swarm-stop', () => onAction('stop'), false));
  }
  return row;
}

/**
 * "Open .sqlite…", and what is staged.
 *
 * A file input rather than a button because a browser will not open a file
 * chooser any other way. Staged rather than opened on the spot: the
 * database is constructed when the swarm is, so the bytes wait for Start
 * — and the label says so, because a file that had been read but had done
 * nothing yet would otherwise look like a file that had been ignored.
 */
function databaseChooser(staged, onAction) {
  const wrap = el('label', { class: 'swarm-dbfile', 'data-swarm-dbfile': '' });
  const input = el('input', { type: 'file', accept: '.sqlite,.db,.sqlite3,application/vnd.sqlite3' });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) onAction('open-database', file);
  });
  wrap.append(input);
  if (!staged?.name) {
    wrap.append(el('span', {}, ['Open .sqlite\u2026']));
    return wrap;
  }
  // The name is editable because in the scope model it is the *address*:
  // a program reaches this file by asking for it by name, and the name a
  // file happened to have on someone's disk is rarely the one the program
  // was written against. Committed on blur or Enter rather than per
  // keystroke, so the panel is not rebuilt under the caret.
  const name = el('input', {
    type: 'text', class: 'swarm-dbname', 'data-swarm-dbname': '',
    value: staged.name, size: 16, 'aria-label': 'the name this database has in the scope',
  });
  const commit = () => { if (name.value !== staged.name) onAction('rename-database', name.value); };
  name.addEventListener('blur', commit);
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); name.blur(); }
    event.stopPropagation();          // the notebook's own keymap is not wanted here
  });
  // A file input's label swallows clicks into the file chooser, which
  // would make this field unfocusable.
  name.addEventListener('click', (event) => event.preventDefault());
  wrap.append(el('span', {}, [`${Math.ceil(staged.bytes.length / 1024)} KB opens on Start as`]));
  wrap.append(name);
  wrap.append(actionButton('clear', 'database-clear', () => onAction('clear-database'), false));
  return wrap;
}

function actionButton(label, name, onClick, disabled) {
  const node = el('button', { type: 'button', 'data-swarm': name, disabled: !!disabled }, [label]);
  node.addEventListener('click', onClick);
  return node;
}

function roster(report, { onAction }) {
  const rows = report.roster ?? [];
  const table = el('table', { class: 'swarm-roster', 'data-swarm-roster': '' });
  table.append(el('thead', {}, [el('tr', {}, [
    el('th', {}, ['#']), el('th', {}, ['parent']), el('th', {}, ['state']),
    el('th', {}, ['instructions']), el('th', {}, ['mem']), el('th', {}, ['caps']), el('th', {}, ['']),
  ])]));
  const body = el('tbody');
  for (const row of rows) {
    body.append(instanceRow(row, onAction));
  }
  table.append(body);
  return table;
}

function instanceRow(row, onAction) {
  const cells = [
    el('td', { class: 'swarm-id' }, [`${row.id}${row.role === 'root' ? ' · root' : ''}`]),
    el('td', {}, [row.parent ? String(row.parent) : '—']),
    el('td', {}, [el('span', { class: `swarm-state swarm-state-${row.state}` }, [
      row.state + (row.outcome && row.state === 'gone' ? `: ${row.outcome}` : ''),
    ])]),
    el('td', { class: 'swarm-num' }, [usageText(row)]),
    el('td', { class: 'swarm-num' }, [row.usage ? `${row.usage.peakMemoryKb} KB` : '—']),
    el('td', { class: 'swarm-caps' }, [row.caps?.length ? row.caps.join(' ') : 'none']),
  ];

  const actions = el('td', { class: 'swarm-actions' });
  if (row.state === 'parked' || row.state === 'running') {
    actions.append(actionButton('kill', `kill-${row.id}`, () => onAction('kill', row.id), false));
    if (row.state === 'parked') {
      actions.append(actionButton('hibernate', `hibernate-${row.id}`, () => onAction('hibernate', row.id), false));
    }
  } else if (row.state === 'hibernated') {
    actions.append(actionButton('wake', `wake-${row.id}`, () => onAction('wake', row.id), false));
  }
  cells.push(actions);

  const tr = el('tr', { 'data-instance': row.id, 'data-state': row.state }, cells);
  const extra = [];

  // Queue depths, which are most of the answer to "why is this parked".
  //
  // Every queue in Diluvium is bounded, and that is the whole backpressure
  // story: a program blocks because its outbound queue is full, or waits
  // because its inbound one is empty, or gets a refusal because it declared
  // `on_full = "reject"`. A roster that showed instances and not queues
  // could tell you an instance was parked and never why.
  if (row.queues?.length) {
    extra.push(el('tr', { class: 'swarm-queues', 'data-queues': row.id }, [
      el('td', { colspan: '7' }, row.queues.map((q) => el('span', {
        class: `swarm-queue${q.length >= q.capacity && q.capacity > 0 ? ' swarm-queue-full' : ''}`,
        title: `${q.name}: ${q.length} of ${q.capacity}`
          + `${q.exported ? ', exported' : ''}${q.enabled ? '' : ', disabled'}`,
      }, [`${q.name} ${q.length}/${q.capacity}`]))),
    ]));
  }
  if (row.detail) {
    // The detail is a runtime message and often a traceback, so it gets its
    // own full-width row rather than being squeezed into a cell.
    extra.push(el('tr', { class: 'swarm-detail' }, [
      el('td', { colspan: '7' }, [String(row.detail).split('\n')[0]]),
    ]));
  }
  return extra.length ? el('tbody', {}, [tr, ...extra]) : tr;
}

function usageText(row) {
  if (row.state === 'hibernated') {
    // Stated rather than blank: a blank cell reads as zero.
    return `hibernated, ${row.cachedSize} B cached`;
  }
  if (!row.usage) return '—';
  const budget = row.budget?.instructions;
  const used = row.usage.instructions.toLocaleString();
  return budget ? `${used} / ${budget.toLocaleString()}` : used;
}

/**
 * The mocked listener.
 *
 * `doc/Host.md` fixes the message shapes -- `{conn, method, path, body}` in,
 * `{conn, status, body, content_type?}` out -- so this composer produces
 * exactly what a socket would and the guest cannot tell which it was.
 */
function listenerSection(listener, { onAction, draft, onDraft }) {
  const section = el('section', { class: 'swarm-listener', 'data-swarm-listener': '' });
  section.append(el('h3', {}, ['Listener']));
  section.append(el('p', { class: 'muted' }, [
    `port ${listener.port} on ${listener.bind}, not bound — a browser tab binds nothing. `
    + `Requests arrive on \`${listener.queue}\`; replies drain from \`${listener.replyQueue}\`.`,
  ]));
  // Config a guest can observe, so the panel says it: with an allowlist
  // every request carries a `headers` map, and without one the field is
  // not there at all. Which of those a program should pattern-match is
  // decided here rather than by whatever traffic happens to arrive.
  section.append(el('p', { class: 'muted' }, [
    listener.headers?.length
      ? `Forwarded headers: ${listener.headers.join(', ')}. Anything else a request `
        + 'carries stops at the host.'
      : 'No headers are forwarded, so a request reaches the program as '
        + '{conn, method, path, body} and nothing else.',
  ]));

  // The composer's contents are the caller's, not this function's. The
  // panel repaints from scratch after every action -- that is what stops a
  // tool leaking listeners into the workbench -- so a field holding its own
  // value would silently reset to `/` the moment you pressed Send, and the
  // *second* request would go somewhere you did not ask for. Caught by the
  // test that sends twice and expects the count to reach two.
  const method = el('select', { 'data-listener-method': '' });
  for (const m of ['GET', 'POST', 'PUT', 'DELETE']) {
    method.append(el('option', { value: m, selected: m === draft.method }, [m]));
  }
  const path = el('input', { type: 'text', value: draft.path, 'data-listener-path': '', 'aria-label': 'Path' });
  const body = el('input', { type: 'text', value: draft.body, 'data-listener-body': '', 'aria-label': 'Body' });
  // `onDraft` deliberately does not repaint: repainting on every keystroke
  // would rebuild the input under the caret and lose focus mid-word.
  for (const [node, key] of [[method, 'method'], [path, 'path'], [body, 'body']]) {
    node.addEventListener('input', () => onDraft({ [key]: node.value }));
  }
  // Sent from the *draft*, not by reading these three nodes back. They are
  // the same value right up until a repaint lands between the keystroke
  // and Send -- at which point the nodes here are a fresh pair built from
  // whatever the draft held, and the ones the typing went into are
  // detached and hold the truth. Reading the DOM back made the composer
  // race the panel's own refresh and send the previous contents.
  const send = actionButton('Send', 'listener-send', () => onAction('request', { ...draft }), false);
  section.append(el('div', { class: 'swarm-request' }, [method, path, body, send]));

  if (listener.exchanges?.length) {
    const list = el('ol', { class: 'swarm-exchanges', 'data-listener-exchanges': '' });
    for (const exchange of listener.exchanges.slice().reverse()) {
      list.append(el('li', {}, [
        `#${exchange.conn} ${exchange.method} ${exchange.path} → `
        + (exchange.status === null ? 'waiting…' : `${exchange.status} ${truncate(exchange.body)}`),
      ]));
    }
    section.append(list);
  }
  if (listener.pending?.length) {
    section.append(el('p', { class: 'muted' }, [
      `${listener.pending.length} connection(s) still waiting for the program to answer.`,
    ]));
  }
  return section;
}

/**
 * The granted scope, and the databases programs have opened inside it.
 *
 * Two levels because the config has two: a deployment grants a *directory*
 * and a program names its database within it (`host.sql.open("orders.db")`).
 * A scope with nothing in it yet is a real and common state -- the grant
 * exists from Start and the databases appear on first use -- so it says so
 * rather than looking like a panel that failed to load.
 */
function sqlSection(sql, onAction) {
  const section = el('section', { class: 'swarm-database', 'data-swarm-database': '' });
  section.append(el('h3', {}, ['Databases']));
  section.append(el('p', { class: 'muted' }, [
    `scope ${sql.scope}, ${sql.readwrite ? 'readwrite' : 'read-only'}, `
    + `${sql.create ? 'may create' : 'no create'}, max_result_rows ${sql.maxResultRows}. `
    + 'Real SQLite, vendored \u2014 but in memory: the scope is the directory your '
    + 'configuration grants, and there is no filesystem here to put one on, so what a '
    + 'program builds is gone when the kernel restarts. Download it first and it is a '
    + 'real .sqlite file, openable anywhere and re-openable here. The contract is the C '
    + 'host\u2019s exactly; the confinement is weaker, because no JavaScript driver exposes '
    + 'SQLite\u2019s authorizer \u2014 transactions, ATTACH and PRAGMA are gated by keyword '
    + 'rather than refused by the engine. Fine for prototyping a schema; not for a '
    + 'database that matters.',
  ]));
  const databases = sql.databases ?? [];
  if (!databases.length) {
    section.append(el('p', { class: 'muted' }, [
      'No program has opened a database in this scope yet.',
    ]));
    return section;
  }
  for (const database of databases) {
    const block = el('div', { class: 'swarm-db', 'data-swarm-db': database.name });
    block.append(el('h4', {}, [`${database.name} \u2014 ${database.statements} statement(s) run`]));
    const list = el('ul', { class: 'swarm-tables' });
    for (const table of database.tables ?? []) {
      list.append(el('li', {}, [`${table.name} \u2014 ${table.rows} row(s): ${table.columns.join(', ')}`]));
    }
    block.append(database.tables?.length ? list : el('p', { class: 'muted' }, ['No tables yet.']));
    // `db.export()` is SQLite serializing itself, so this is a real file --
    // the same bytes `sqlite3` writes, openable anywhere. Which is what
    // makes the Lab somewhere a schema can be built rather than only tried.
    block.append(el('p', { class: 'swarm-dbactions' }, [
      actionButton('Download .sqlite', 'database-export',
        () => onAction('export-database', database.name), false),
    ]));
    section.append(block);
  }
  return section;
}

/**
 * Exceptions thrown inside a host callback.
 *
 * They cannot be allowed to escape into wasm -- a JavaScript throw from
 * inside `dvs_step` unwinds the wasm stack mid-step -- so they are caught
 * and collected. Collected and never shown would be a host that swallows
 * its own bugs, which is why this section exists.
 */
function faultsSection(faults) {
  const section = el('section', { class: 'swarm-faults', 'data-swarm-faults': '' });
  section.append(el('h3', {}, ['Host faults']));
  const list = el('ul');
  for (const fault of faults) {
    list.append(el('li', {}, [`step ${fault.at}: the host's ${fault.where} callback threw — ${fault.message}`]));
  }
  section.append(list);
  return section;
}

function events(records) {
  const section = el('section', { class: 'swarm-events', 'data-swarm-events': '' });
  section.append(el('h3', {}, ['Events']));
  const list = el('ol', { class: 'swarm-event-list' });
  for (const record of records.slice(-200).reverse()) {
    list.append(el('li', { class: `swarm-event swarm-${EVENT_KIND[record.event] ?? 'info'}`,
      'data-event': record.event }, [
      el('span', { class: 'swarm-event-step' }, [String(record.step)]),
      el('span', { class: 'swarm-event-kind' }, [record.event]),
      el('span', { class: 'swarm-event-id' }, [record.id ? `#${record.id}` : '']),
      el('span', { class: 'swarm-event-detail' }, [
        (record.queue ? `${record.queue}: ` : '') + truncate(record.detail ?? '', 300),
      ]),
    ]));
  }
  section.append(records.length ? list : el('p', { class: 'muted' }, ['Nothing yet.']));
  return section;
}

function truncate(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
