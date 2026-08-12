import { test, expect } from '@playwright/test';

// `swarm.*` — a notebook cell driving a swarm.
//
// Every other thing a cell can do with the page is one-way: the program
// emits a record and the page renders it once `run_lua` returns. A swarm
// cannot work that way, because `swarm.step(10)` has to *return* its events
// to the line that asked. So the mechanism under test is a synchronous
// round trip out of the kernel and back, inside a single `run_lua`: one
// unbuffered write carrying the request, one read collecting the answer.
//
// The programs here are deliberately generic — a supervisor, workers, a
// counter. What they exercise is the runtime's, not any application's:
// spawning, attenuation, budgets, hibernation, and the queue discipline.

async function openKernel(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(msg.text()); });
  await page.goto('/test/kernel-page.html');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  return problems;
}

const run = (page, code) => page.evaluate((c) => window.lab.run(c), code);

/** A worker that answers its inbox and counts what it has seen. */
const WORKER = `
local out = queue.lookup('outbox')
local seen = 0
while true do
  local q, m = queue.wait({ queue.lookup('inbox') })
  seen = seen + 1
  queue.push(out, { kind = 'ack', seen = seen, said = m.said })
end`;

/** A root that admits workers on request and reports what it did. */
const ROOT = `
local sys = queue.declare('system/lifecycle', { capacity = 16 })
local ev  = queue.declare('system/events', { capacity = 64 })
local inb = queue.lookup('inbox')
local out = queue.lookup('outbox')
local GRANTABLE = 'queue:'
local pending = nil
while true do
  local q, m = queue.wait({ inb, ev })
  if q == inb and m.op == 'admit' then
    local bad = nil
    for _, c in ipairs(m.caps or { 'queue:*' }) do
      if c:sub(1, #GRANTABLE) ~= GRANTABLE then bad = c end
    end
    if bad then
      queue.push(out, { kind = 'refused', label = m.label,
                        detail = bad .. ' would widen what a worker may hold' })
    else
      pending = m.label
      queue.push(sys, { op = 'spawn', code = m.src, caps = m.caps or { 'queue:*' },
                        budget = { instructions = 2000000, memory_kb = 256 },
                        wake_on_message = true })
    end
  elseif m.event == 'spawned' and pending then
    queue.push(out, { kind = 'admitted', label = pending, id = m.id })
    pending = nil
  elseif m.event == 'denied' and pending then
    queue.push(out, { kind = 'refused', label = pending, detail = tostring(m.detail) })
    pending = nil
  end
end`;

const START = `
swarm.start{
  root = [==[${ROOT}]==],
  caps = { "lifecycle", "queue:*", "host:time" },
  budget = { instructions = 50000000, memory_kb = 4096 },
  max_instances = 16, spawns_per_step = 4,
  hibernation = "on",
  connectors = { time = true },
}`;

const ADMIT = (label, caps = null) => `
swarm.push("root", "inbox", { op = "admit", label = ${JSON.stringify(label)},
  ${caps ? `caps = ${caps},` : ''} src = [==[${WORKER}]==] })
for _, e in ipairs(swarm.step(10)) do
  if e.event == "spawned" then swarm.alias(${JSON.stringify(label)}, e.id) end
end`;

test('the global is installed only when there is a host to answer it', async ({ page }) => {
  await openKernel(page);
  // A capability a program can test for, rather than one that exists and
  // throws. `type(swarm)` is exactly how a notebook decides whether to run
  // its swarm sections.
  const probe = await run(page, 'print(type(swarm), type(json), type(events))');
  expect(probe.stdout.trim()).toBe('table\ttable\tfunction');
});

test('a cell starts a swarm, spawns a worker, and talks to it', async ({ page }) => {
  const problems = await openKernel(page);
  const r = await run(page, `
local root = ${START}
${ADMIT('alpha')}
local admitted
for _, m in ipairs(swarm.drain("root", "outbox")) do
  if m.kind == "admitted" then admitted = m end
end
assert(admitted and admitted.label == "alpha", "the root reports the admission it performed")
assert(admitted.id ~= root, "a worker is not the root")

local ok, why = swarm.push("alpha", "inbox", { said = "hello" })
assert(ok, "push to a live worker: " .. tostring(why))
swarm.step(5)
local ack
for _, m in ipairs(swarm.drain("alpha", "outbox")) do
  if m.kind == "ack" then ack = m end
end
assert(ack and ack.seen == 1 and ack.said == "hello", "the worker answered")
print("root", root, "worker", admitted.id, "ack", ack.seen)
`);
  expect(r.status).toBe('ok');
  expect(r.stdout).toContain('ack\t1');
  expect(problems).toEqual([]);
});

test('drained messages are delivered once, not replayed', async ({ page }) => {
  await openKernel(page);
  // A mailbox, not a log: reading it takes the messages. The first version
  // of the host kept only a rendering of each message for the panel and
  // dropped the values, so nothing could read a program's output at all.
  const r = await run(page, `
${START}
${ADMIT('alpha')}
swarm.push("alpha", "inbox", { said = "one" })
swarm.step(5)
local first = swarm.drain("alpha", "outbox")
local second = swarm.drain("alpha", "outbox")
print(#first, #second)
`);
  expect(r.status).toBe('ok');
  expect(r.stdout.trim()).toBe('1\t0');
});

test('a worker\'s last message survives the worker', async ({ page }) => {
  await openKernel(page);
  // The instance is freed the moment its drive reports it finished, and
  // its queues go with it -- so a program whose final act is to push its
  // answer needs the host to have drained at that exact moment.
  const r = await run(page, `
${START}
swarm.push("root", "inbox", { op = "admit", label = "brief",
  src = [==[queue.push(queue.lookup('outbox'), { kind = 'done', value = 42 }) return 0]==] })
for _, e in ipairs(swarm.step(10)) do
  if e.event == "spawned" then swarm.alias("brief", e.id) end
end
local last
for _, m in ipairs(swarm.drain("brief", "outbox")) do last = m end
assert(last and last.value == 42, "the answer outlived the instance")
print("gone:", swarm.status().brief.state, "said:", last.value)
`);
  expect(r.status).toBe('ok');
  expect(r.stdout).toContain('said:\t42');
});

test('a widening grant is refused, and the refusal is visible', async ({ page }) => {
  await openKernel(page);
  const r = await run(page, `
${START}
swarm.push("root", "inbox", { op = "admit", label = "greedy",
  caps = { "lifecycle" }, src = [==[return 0]==] })
swarm.step(5)
local refused
for _, m in ipairs(swarm.drain("root", "outbox")) do
  if m.kind == "refused" then refused = m end
end
assert(refused and refused.label == "greedy", "a widening admit is refused")
print("refused:", refused.detail)
`);
  expect(r.status).toBe('ok');
  expect(r.stdout).toContain('would widen');
});

test('hibernate and wake, with the state crossing the gap', async ({ page }) => {
  const problems = await openKernel(page);
  // The drill the runtime's most delicate feature deserves: park an
  // instance out to its snapshot, prove it is not resident, wake it with a
  // message, and check its counter continued rather than restarted.
  const r = await run(page, `
${START}
${ADMIT('alpha')}
swarm.push("alpha", "inbox", { said = "one" })
swarm.step(5)
swarm.drain("alpha", "outbox")

assert(swarm.hibernate("alpha"), "the host asked it to swap out")
swarm.step(1)
local sleeping = swarm.status().alpha
assert(sleeping.resident == false, "parked out")
assert(sleeping.cachedSize > 0, "there are snapshot bytes to show for it")
-- A push to a non-resident instance is accepted only because it was
-- spawned with wake_on_message; without that flag it is "gone".
assert(swarm.push("alpha", "inbox", { said = "two" }), "accepted for a sleeper")
swarm.step(5)
assert(swarm.status().alpha.resident == true, "woken by the message")

local ack
for _, m in ipairs(swarm.drain("alpha", "outbox")) do
  if m.kind == "ack" then ack = m end
end
assert(ack and ack.seen == 2, "the counter continued: state crossed the gap")
print("cached", sleeping.cachedSize > 0, "seen", ack.seen)
`);
  expect(r.status).toBe('ok');
  expect(r.stdout).toContain('seen\t2');
  expect(problems).toEqual([]);
});

test('status is keyed by alias and by id, onto the same row', async ({ page }) => {
  await openKernel(page);
  const r = await run(page, `
${START}
${ADMIT('alpha')}
local st = swarm.status()
local id = st.alpha.id
assert(st[tostring(id)], "addressable by id as well as by name")
assert(st[tostring(id)].state == st.alpha.state, "one row, two keys")
assert(st.alpha.caps[1] == "queue:*", "a worker holds what it was granted")
assert(st.root.caps[1] == "lifecycle", "and the root holds the ceiling")
print("ok", id)
`);
  expect(r.status).toBe('ok');
});

test('the errors a cell can provoke arrive as Lua errors, not as silence', async ({ page }) => {
  await openKernel(page);
  const noSwarm = await run(page, 'local ok, err = pcall(swarm.step, 1) print(ok, err)');
  expect(noSwarm.stdout).toContain('no swarm is running');

  const badTarget = await run(page, `
${START}
local ok, err = pcall(swarm.push, "nobody", "inbox", {})
print(ok, err)
`);
  expect(badTarget.stdout).toContain("no instance is called 'nobody'");

  const noRoot = await run(page, 'local ok, err = pcall(swarm.start, { caps = {} }) print(ok, err)');
  expect(noRoot.stdout).toContain('needs a root program');
});

test('a cell that never mentions the swarm is untouched by any of this', async ({ page }) => {
  const problems = await openKernel(page);
  const r = await run(page, 'io.write("plain output, ") print("and a print")');
  // The control channel rides on stdout, so ordinary writes must be
  // completely unaffected -- including `io.write`, which is what a request
  // is made of.
  expect(r.stdout).toBe('plain output, and a print\n');
  expect(problems).toEqual([]);
});
