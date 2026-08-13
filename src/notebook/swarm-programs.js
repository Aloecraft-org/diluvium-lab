// Root programs for the instances panel.
//
// A swarm needs a root, and asking someone to write a supervisor before
// they have seen one is the wrong order. These are the smallest programs
// that each show one thing the swarm layer does and a notebook cannot.
//
// They are ordinary Diluvium programs and nothing here is special: a
// supervisor is a program that holds the `lifecycle` capability, which is
// §9.1's central claim -- there is no supervisor *type*, and the runtime
// does not distinguish one from any other program.
//
// Two rules they all obey, both learned from the toy swarm in the Diluvium
// tree rather than invented here:
//
//   A spawn request carries the child's *source*, and `DVS_MAX_REQUEST` is
//   32 KB. A program that grows past it fails at run time by coming up with
//   fewer instances than it should, with `denied ... the request is too
//   large` as the only symptom.
//
//   A child's name goes into its source as a Lua literal, so `%q` is the
//   difference between an example and an injection hole. One `gsub` pass
//   over all placeholders, never one pass each: sequential passes let an
//   earlier substitution's text be rewritten by a later one.

/** A worker that reports for duty, does a little arithmetic, and leaves. */
const WORKER = `
local out = queue.lookup('outbox')
local name = @NAME@
local total = 0
for i = 1, 5000 do total = total + i end
queue.push(out, {worker = name, total = total})
return 0
`;

const SUPERVISOR = `
-- A supervisor is a program holding the lifecycle capability. That is all
-- it is: the swarm layer reads system/lifecycle for a program that holds
-- it, and ignores the queue entirely for one that does not.
local sys = queue.declare('system/lifecycle', {capacity = 16})
local ev  = queue.declare('system/events', {capacity = 64})
local log = queue.declare('log', {capacity = 64, exported = true})

local WORKER = ${JSON.stringify(WORKER)}

local function worker_for (name)
  -- One pass over every placeholder. %q quotes the name into a Lua
  -- literal, which is what keeps a name from becoming code.
  return (WORKER:gsub('@(%u+)@', {NAME = ('%q'):format(name)}))
end

for _, name in ipairs({'ada', 'grace', 'edsger'}) do
  queue.push(sys, {
    op = 'spawn',
    code = worker_for(name),
    -- Strictly narrower than what this program holds: no lifecycle, so a
    -- worker cannot spawn anything of its own.
    caps = {'queue:*'},
    budget = {instructions = 2000000, memory_kb = 512},
  })
end

-- And one the runtime must refuse. Attenuation is enforced by the swarm
-- layer before anything is created, so a denied spawn costs nothing and
-- leaves nothing behind.
--
-- It has to ask for something this program does not hold. Asking for
-- 'lifecycle' would be *allowed*, because the root holds it and granting
-- what you hold is attenuation's equality case -- an earlier version of
-- this file got that wrong and the panel's own test caught it by counting
-- four instances where the comment promised three.
queue.push(sys, {
  op = 'spawn',
  code = 'return 0',
  caps = {'host:sql/exec'},
  budget = {instructions = 1000},
})

local live = 0
local seen = 0
while true do
  local q, m = queue.wait({ev})
  queue.push(log, ('%s id=%s %s'):format(
    tostring(m.event), tostring(m.id), tostring(m.detail or '')))
  if m.event == 'spawned' then live = live + 1 end
  if m.event == 'exited' or m.event == 'faulted' or m.event == 'exceeded' then
    live = live - 1
    seen = seen + 1
  end
  if seen >= 3 and live <= 0 then break end
end
queue.push(log, 'every worker is finished; the supervisor is done')
return 0
`;

const RUNAWAY = `
local sys = queue.declare('system/lifecycle', {capacity = 8})
local ev  = queue.declare('system/events', {capacity = 32})
local log = queue.declare('log', {capacity = 32, exported = true})

-- Nothing cooperative can stop this: it never yields, so no scheduler and
-- no message can reach it. The limit has to live outside the guest, which
-- is what a per-instance instruction budget is.
queue.push(sys, {
  op = 'spawn',
  code = 'local n = 0 while true do n = n + 1 end',
  caps = {'queue:*'},
  budget = {instructions = 500000, memory_kb = 256},
})
queue.push(sys, {
  op = 'spawn',
  code = 'local out = queue.lookup("outbox") queue.push(out, {still = "fine"}) return 0',
  caps = {'queue:*'},
  budget = {instructions = 2000000, memory_kb = 256},
})

local seen = 0
while seen < 4 do
  local q, m = queue.wait({ev})
  queue.push(log, ('%s id=%s %s'):format(
    tostring(m.event), tostring(m.id), tostring(m.detail or ''):gsub('%s+', ' ')))
  seen = seen + 1
end
queue.push(log, 'the runaway was stopped and everything else was untouched')
return 0
`;

const SERVICE = `
-- A request handler, against two connectors the host wired: a listener
-- that binds no port, and a SQLite whose confinement is thinner than the
-- C host's. Neither fact is visible from in here, which is the point --
-- doc/Host.md's acceptance test is that a guest cannot tell two hosts
-- apart.
local inq  = queue.declare('http_in',  {capacity = 16})
local outq = queue.declare('http_out', {capacity = 16, exported = true})
local log = queue.declare('log', {capacity = 64, exported = true})

-- \`host\` is a guest library (v5.5.1_build7+), not a connector: it is the
-- token loop, the correlation and the status check, written once in the
-- runtime instead of once per program. What goes over the wire is
-- unchanged -- {tok, call, args} out, {tok, status, value} back -- and
-- messaging.ipynb builds it by hand for anyone who wants to see it.
--
-- The deployment granted a *directory*; this names its database inside
-- it. Which database is the program's business, and the config cannot
-- make that choice for it.
local db = host.sql.open('visits.db')

db.exec('CREATE TABLE IF NOT EXISTS visit (id INTEGER PRIMARY KEY, path TEXT NOT NULL, at INTEGER)')
queue.push(log, 'schema: ok')

while true do
  local q, req = queue.wait({inq})
  -- Allowlisted request headers, when the deployment named any. A header
  -- it did not name is not here to be read.
  local agent = req.headers and req.headers['user-agent'] or 'nobody in particular'
  db.exec('INSERT INTO visit (path, at) VALUES (?, ?)', req.path, host.time())
  local counted = db.query('SELECT COUNT(*) AS n FROM visit WHERE path = ?', req.path)
  local n = counted.rows[1] and counted.rows[1][1] or 0
  -- conn echoed verbatim: it is the host's and means nothing in here.
  queue.push(outq, {
    conn = req.conn,
    status = 200,
    content_type = 'text/plain',
    body = ('%s %s has been asked for %d time(s), this one by %s')
      :format(req.method, req.path, n, agent),
  })
end
`;

/**
 * The programs the panel offers, with the deployment each one needs.
 *
 * The config is `host/example.host.lua`'s shape, deliberately: a deployment
 * that moves from the Lab to the generic C host should be a translation of
 * the same keys rather than a rewrite.
 */
export const SWARM_PROGRAMS = [
  {
    id: 'supervisor',
    label: 'A supervisor and three workers',
    source: SUPERVISOR,
    config: {
      maxInstances: 16,
      spawnsPerStep: 4,
      caps: ['lifecycle', 'queue:*'],
      budget: { instructions: 50_000_000, memoryKb: 4096 },
      connectors: {},
    },
  },
  {
    id: 'runaway',
    label: 'A runaway, stopped by its budget',
    source: RUNAWAY,
    config: {
      maxInstances: 8,
      caps: ['lifecycle', 'queue:*'],
      budget: { instructions: 50_000_000, memoryKb: 4096 },
      connectors: {},
    },
  },
  {
    id: 'service',
    label: 'A request handler, with a database',
    source: SERVICE,
    config: {
      maxInstances: 8,
      // `host:*` names gate hostcalls exactly as `queue:*` names gate
      // queues, and attenuate through spawns identically.
      caps: ['lifecycle', 'queue:*', 'host:time', 'host:sql/query', 'host:sql/exec'],
      budget: { instructions: 200_000_000, memoryKb: 8192 },
      connectors: {
        time: true,
        sql: { scope: 'lab', access: 'readwrite', max_result_rows: 1024 },
        listen: {
          port: 8080, queue: 'http_in', reply_queue: 'http_out',
          // Lowercase, and empty by default: a header the deployment does
          // not name never reaches the guest.
          headers: ['user-agent'],
        },
      },
    },
  },
];

/**
 * The notebook as the composer.
 *
 * `doc/Lab.md` calls this "the notebook-to-agents composer", and this is
 * its smallest honest form: the selected code cell *is* the root program.
 * A notebook can then hold a swarm the way it holds anything else — with
 * markdown around it explaining what each part does — and the panel runs
 * it without anything being pasted anywhere.
 *
 * The one runtime-imposed rule, which the notebook has to say out loud:
 * **a spawn ships source or bytecode, never a closure.** An agent function
 * cannot capture; it takes its state as a parameter. That is why a child's
 * source appears as a string inside its parent rather than as a function.
 *
 * Its deployment wires everything, because a cell being written now cannot
 * declare what it will need next. The capability list is the root's
 * ceiling and every descendant attenuates from it, so a generous ceiling
 * here is still a real one below.
 */
export const FROM_CELL = {
  id: 'cell',
  label: 'From the selected cell',
  config: {
    maxInstances: 32,
    spawnsPerStep: 4,
    caps: ['lifecycle', 'queue:*', 'host:time', 'host:rng/int', 'host:rng/bytes',
      'host:sql/query', 'host:sql/exec'],
    budget: { instructions: 500_000_000, memoryKb: 16384 },
    connectors: {
      time: true,
      rng: true,
      sql: { scope: 'lab', access: 'readwrite', max_result_rows: 1024 },
      listen: {
        port: 8080, queue: 'http_in', reply_queue: 'http_out',
        headers: ['user-agent', 'authorization'],
      },
    },
  },
};

export const ALL_PROGRAMS = [...SWARM_PROGRAMS, FROM_CELL];

export const programById = (id) => ALL_PROGRAMS.find((p) => p.id === id) ?? SWARM_PROGRAMS[0];
