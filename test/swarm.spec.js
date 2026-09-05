import { test, expect } from '@playwright/test';
import { dismissLauncher } from './chrome.js';

// The swarm host: `doc/Host.md`'s seven duties, against the real
// `diluvium_swarm_wasi.wasm`.
//
// Nothing here is mocked. Every assertion is about what the runtime did --
// which instances came to exist, what the swarm layer refused, what a
// budget stopped -- rather than about what the panel says it did. The panel
// gets its own describe block at the bottom, driving the real buttons.

async function openKernel(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(msg.text()); });
  await page.goto('/test/kernel-page.html');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  return problems;
}

/** Start a swarm and run it to a standstill, then report. */
const drive = (page, source, config, steps = 40) => page.evaluate(async ([src, cfg, n]) => {
  await window.lab.kernel.swarmStart(src, cfg);
  for (let i = 0; i < n; i++) {
    const report = await window.lab.kernel.swarmStep();
    if (report.alive === 0) return report;
  }
  return window.lab.kernel.swarmSnapshot();
}, [source, config, steps]);

const WORKER = `
local out = queue.lookup('outbox')
queue.push(out, {said = 'a child ran'})
return 0`;

const SUPERVISOR = `
local sys = queue.declare('system/lifecycle', {capacity = 16})
local ev  = queue.declare('system/events', {capacity = 64})
local log = queue.declare('log', {capacity = 64, exported = true})
queue.push(sys, {op = 'spawn', code = ${JSON.stringify(WORKER)},
                 caps = {'queue:*'}, budget = {instructions = 2000000, memory_kb = 512}})
local seen = 0
while seen < 2 do
  local q, m = queue.wait({ev})
  queue.push(log, ('%s id=%s'):format(tostring(m.event), tostring(m.id)))
  seen = seen + 1
end
return 0`;

const ROOT_CONFIG = {
  maxInstances: 16,
  caps: ['lifecycle', 'queue:*'],
  budget: { instructions: 50_000_000, memoryKb: 4096 },
};

test.describe('the module', () => {
  test('the swarm build is the kernel build plus a swarm layer', async ({ page }) => {
    await openKernel(page);
    // Read off the binary rather than trusting any document about it --
    // the same discipline Stage 0 used on the WASI import list.
    const facts = await page.evaluate(async () => {
      const shape = async (url) => {
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        const module = await WebAssembly.compile(bytes);
        const imports = WebAssembly.Module.imports(module);
        const names = WebAssembly.Module.exports(module).map((e) => e.name);
        return {
          env: imports.filter((i) => i.module === 'env').map((i) => i.name).sort(),
          wasi: imports.filter((i) => i.module === 'wasi_snapshot_preview1').length,
          dvs: names.filter((n) => n.startsWith('dvs')).length,
          kernel: ['init_lua', 'run_lua', 'malloc', 'free', 'memory']
            .every((n) => names.includes(n)),
        };
      };
      return {
        plain: await shape('../vendor/libdiluvium_wasi.wasm'),
        swarm: await shape('../vendor/diluvium_swarm_wasi.wasm'),
      };
    });

    expect(facts.plain.dvs).toBe(0);
    expect(facts.plain.env).toEqual([]);
    expect(facts.swarm.kernel).toBe(true);
    expect(facts.swarm.wasi).toBe(facts.plain.wasi);
    // The three trampolines `dvs_shim.c` declares, which are why this is a
    // separate artifact: a wasm module's imports are mandatory, so linking
    // the shim into libdiluvium_wasi.wasm would break every pure-WASI
    // consumer of it.
    expect(facts.swarm.env).toEqual(['js_host_create', 'js_host_destroy', 'js_host_drive']);
    expect(facts.swarm.dvs).toBeGreaterThan(20);
  });

  test('the shadow stack is measured, and this build no longer needs relocating', async ({ page }) => {
    await openKernel(page);
    const report = await drive(page, SUPERVISOR, ROOT_CONFIG);

    // The history, because this assertion inverted once and should not
    // quietly invert back. v5.5.1_build5 shipped wasm-ld's default 64 KiB
    // shadow stack and `dvs_step` did not fit in it: `drain()` declares a
    // 32 KiB buffer the compiler inlines, the frame underflowed on entry,
    // and the first read through the stack pointer trapped -- surfacing as
    // `memory access out of bounds` inside `dv_queue_lookup`, a function
    // that worked perfectly when called directly one line earlier. The Lab
    // relocated the stack into a heap block to get a swarm at all.
    //
    // build6 puts `-Wl,-z,stack-size=1048576` on the swarm link line, so
    // the workaround now measures the module and correctly leaves it
    // alone. `ensureStack` stays, because the runtime dropdown can still
    // select build5, and it is conditional on measurement rather than on a
    // version -- but on the *pinned* build it must be inert.
    expect(report.stack).toBeTruthy();
    expect(report.stack.moved).toBe(false);
    expect(report.stack.had).toBeGreaterThanOrEqual(96 * 1024);
    expect(report.stack.why).toContain('enough');
  });

  test('a build with too small a stack would still be relocated', async ({ page }) => {
    await openKernel(page);
    // The machinery kept for build5 and older, exercised directly rather
    // than left as dead code nobody would notice rotting. `ensureStack`
    // reads `__stack_low`/`__stack_high` off the module and relocates only
    // when they are too small, so a stand-in reporting build5's numbers is
    // the honest way to test the branch the pinned build no longer takes.
    const verdicts = await page.evaluate(async () => {
      const { ensureStack, STACK_FLOOR } = await import('../src/kernel/swarm.js');
      const fake = (low, high) => ({
        __stack_low: { value: low },
        __stack_high: { value: high },
        __stack_pointer: { value: high },
        malloc: () => 4096,
      });
      return {
        small: ensureStack(fake(0, 65536), { wanted: 1024 }),
        ample: ensureStack(fake(0, STACK_FLOOR * 2), { wanted: 1024 }),
        silent: ensureStack({ malloc: () => 4096 }),
      };
    });
    expect(verdicts.small.moved).toBe(true);
    expect(verdicts.small.had).toBe(65536);
    expect(verdicts.small.why).toContain('stack-size');
    expect(verdicts.ample.moved).toBe(false);
    // A module that does not say where its stack is gets left alone rather
    // than guessed at.
    expect(verdicts.silent.moved).toBe(false);
    expect(verdicts.silent.why).toContain('does not say');
  });
});

test.describe('duty 1 and 3 — construction and the roster', () => {
  test('a root comes up and a spawned child appears in the roster', async ({ page }) => {
    const problems = await openKernel(page);
    const report = await drive(page, SUPERVISOR, ROOT_CONFIG);

    expect(report.roster.length).toBe(2);
    const [root, child] = report.roster;
    expect(root.role).toBe('root');
    expect(root.parent).toBe(0);
    expect(child.parent).toBe(root.id);
    // Ids are the swarm's and are never reused.
    expect(child.id).toBeGreaterThan(root.id);
    expect(problems).toEqual([]);
  });

  test('the roster records how each instance ended', async ({ page }) => {
    await openKernel(page);
    const report = await drive(page, SUPERVISOR, ROOT_CONFIG);
    for (const row of report.roster) {
      expect(row.state).toBe('gone');
      expect(row.outcome).toBe('exited');
    }
  });

  test('a capability set can only narrow, and the runtime is what enforces it', async ({ page }) => {
    await openKernel(page);
    const GREEDY = `
local sys = queue.declare('system/lifecycle', {capacity = 8})
local ev  = queue.declare('system/events', {capacity = 32})
local log = queue.declare('log', {capacity = 32, exported = true})
-- Wider than this program holds: it has queue:* and lifecycle, and asks
-- for a host capability nobody granted it.
queue.push(sys, {op = 'spawn', code = 'return 0',
                 caps = {'host:sql/exec'}, budget = {instructions = 1000}})
local q, m = queue.wait({ev})
queue.push(log, ('%s %s'):format(tostring(m.event), tostring(m.detail)))
return 0`;
    const report = await drive(page, GREEDY, ROOT_CONFIG);

    // Nothing was created: a refused spawn costs nothing and leaves
    // nothing behind, so the roster holds the root alone.
    expect(report.roster.length).toBe(1);
    const denied = report.events.find((e) => String(e.detail ?? '').includes('denied'));
    expect(denied).toBeTruthy();
    expect(String(denied.detail)).toContain('host:sql/exec');
  });

  // build10's guest library grew `spawn`, `children` and `events` -- the
  // lifecycle without the magic queue name, the raw op table, or the
  // hand-rolled correlation the tests above still spell out on purpose.
  //
  // Nothing in this host was changed to make it work, and that is the
  // assertion: the library is guest-side Lua riding in the module, so a
  // supervisor written against the C host runs here unaltered. This test
  // exists so that stops being luck.
  test('the guest library spawns without the raw lifecycle idiom', async ({ page }) => {
    await openKernel(page);
    const report = await page.evaluate(async () => {
      // No `system/lifecycle` anywhere in this program: the library owns
      // that name, the op shape and the outcome wait.
      const source = `
local log = queue.declare('log', {capacity = 8, exported = true})
local kid = host.spawn{ code = 'local a = 1', caps = {'queue:*'} }
local kids = 0
for _ in pairs(host.children()) do kids = kids + 1 end
local ok, err = pcall(host.spawn, { code = 'local b = 2', caps = {'host:nope/*'} })
queue.push(log, {id = kid.id, kids = kids,
                 denied = (not ok) and tostring(err):find('denied') ~= nil})
return 0`;
      await window.lab.kernel.swarmStart(source, {
        caps: ['lifecycle', 'queue:*'],
        budget: { instructions: 50_000_000, memoryKb: 4096 },
        connectors: {},
      });
      for (let i = 0; i < 40; i++) {
        const r = await window.lab.kernel.swarmStep();
        if (r.alive === 0) return r;
      }
      return window.lab.kernel.swarmSnapshot();
    });

    const answer = report.events.find((e) => e.event === 'message' && e.queue === 'log');
    expect(answer, 'the supervisor should have logged its child').toBeTruthy();
    // A real instance id from this host's own roster, not a fabricated one.
    expect(answer.value.id).toBeGreaterThan(1);
    expect(answer.value.kids).toBe(1);
    // Attenuation is the swarm's, so the library's raise carries the
    // swarm's own refusal rather than inventing a second policy.
    expect(answer.value.denied).toBe(true);
  });
});

test.describe('duty 2 — the drive loop', () => {
  test('an instruction budget stops a runaway, and nothing else is touched', async ({ page }) => {
    await openKernel(page);
    const RUNAWAY = `
local sys = queue.declare('system/lifecycle', {capacity = 8})
local ev  = queue.declare('system/events', {capacity = 32})
local log = queue.declare('log', {capacity = 32, exported = true})
queue.push(sys, {op = 'spawn', code = 'local n = 0 while true do n = n + 1 end',
                 caps = {'queue:*'}, budget = {instructions = 500000, memory_kb = 256}})
queue.push(sys, {op = 'spawn', code = ${JSON.stringify(WORKER)},
                 caps = {'queue:*'}, budget = {instructions = 2000000, memory_kb = 256}})
local seen = 0
while seen < 4 do
  local q, m = queue.wait({ev})
  queue.push(log, ('%s id=%s'):format(tostring(m.event), tostring(m.id)))
  seen = seen + 1
end
return 0`;
    const report = await drive(page, RUNAWAY, ROOT_CONFIG);

    const exceeded = report.roster.find((r) => r.outcome === 'exceeded');
    expect(exceeded).toBeTruthy();
    expect(exceeded.exceeded).toBe(true);
    expect(exceeded.detail).toContain('budget');
    // The limit is real: it stopped at the number it was given, not near it.
    expect(exceeded.usage.instructions).toBe(exceeded.budget.instructions);

    // And the sibling that behaved was untouched.
    const fine = report.roster.find((r) => r.outcome === 'exited' && r.parent !== 0);
    expect(fine).toBeTruthy();
  });

  test('a dying instance\'s last message is not lost', async ({ page }) => {
    await openKernel(page);
    // The child pushes to `outbox` and returns in the same drive. Its
    // queues are freed when the swarm releases it, so a host that drained
    // exported queues only after `dvs_step` would never see this.
    const report = await drive(page, SUPERVISOR, ROOT_CONFIG);
    const said = report.events.find((e) => e.event === 'message' && e.queue === 'outbox');
    expect(said).toBeTruthy();
    expect(said.value.said).toBe('a child ran');
  });
});

test.describe('duty 5 — hostcalls', () => {
  const HOSTCALL_ROOT = (body) => `
local calls   = queue.declare('host/calls',   {capacity = 8, exported = true, on_full = 'reject'})
local replies = queue.declare('host/replies', {capacity = 8})
local log     = queue.declare('log', {capacity = 32, exported = true})
${body}
return 0`;

  const CONFIG = {
    caps: ['queue:*', 'host:time', 'host:sql/query', 'host:sql/exec'],
    budget: { instructions: 50_000_000, memoryKb: 4096 },
    connectors: { time: true, sql: { scope: 'lab', access: 'readwrite' } },
  };

  test('a call is answered with its token echoed verbatim', async ({ page }) => {
    await openKernel(page);
    const report = await drive(page, HOSTCALL_ROOT(`
queue.push(calls, {tok = 77, call = 'time'})
local _, reply = queue.wait({replies})
queue.push(log, {tok = reply.tok, status = reply.status, gotvalue = reply.value ~= nil})`), CONFIG);

    const answer = report.events.find((e) => e.event === 'message' && e.queue === 'log');
    expect(answer.value.tok).toBe(77);
    expect(answer.value.status).toBe('ok');
    expect(answer.value.gotvalue).toBe(true);
  });

  test('replies may arrive out of order, which is why the token exists', async ({ page }) => {
    await openKernel(page);
    // Two outstanding calls, and the guest matches on `tok` rather than on
    // arrival order -- the discipline `doc/Hostcall.md` exists to reserve.
    const report = await drive(page, HOSTCALL_ROOT(`
queue.push(calls, {tok = 1, call = 'sql/exec',
  args = {db = 'lab.db',
          sql = 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)'}})
queue.push(calls, {tok = 2, call = 'time'})
local got = {}
for i = 1, 2 do
  local _, reply = queue.wait({replies})
  got[reply.tok] = reply.status
end
queue.push(log, {one = got[1], two = got[2]})`), CONFIG);

    const answer = report.events.find((e) => e.event === 'message' && e.queue === 'log');
    expect(answer.value.one).toBe('ok');
    expect(answer.value.two).toBe('ok');
  });

  test('a call outside the grant is denied, never dropped', async ({ page }) => {
    await openKernel(page);
    const report = await drive(page, HOSTCALL_ROOT(`
queue.push(calls, {tok = 5, call = 'js/invoke', args = {name = 'anything'}})
local _, reply = queue.wait({replies})
queue.push(log, {tok = reply.tok, status = reply.status, detail = reply.detail})`), CONFIG);

    const answer = report.events.find((e) => e.event === 'message' && e.queue === 'log');
    expect(answer.value.status).toBe('denied');
    expect(answer.value.tok).toBe(5);
    expect(answer.value.detail).toContain('host:js/invoke');
  });

  test('a request without a token is answered malformed, and says why', async ({ page }) => {
    await openKernel(page);
    const report = await drive(page, HOSTCALL_ROOT(`
queue.push(calls, {call = 'time'})
local _, reply = queue.wait({replies})
queue.push(log, {status = reply.status, detail = reply.detail, tok = reply.tok})`), CONFIG);

    const answer = report.events.find((e) => e.event === 'message' && e.queue === 'log');
    expect(answer.value.status).toBe('malformed');
    // No token was readable, so none is echoed: an uncorrelatable reply is
    // the sender's own diagnostic where silence diagnoses nothing.
    expect(answer.value.tok ?? null).toBeNull();
    expect(answer.value.detail).toContain('tok');
  });

  test('the host library reaches the same connector as the raw idiom', async ({ page }) => {
    await openKernel(page);
    // `host` is a guest library, not a connector: it writes the loop above
    // and nothing else changes. So a program that mixes the two on one
    // queue pair must work -- which is also what proves the library's
    // token space (0x40000000 up) is disjoint from a hand-rolled one.
    const report = await drive(page, HOSTCALL_ROOT(`
local db = host.sql.open('lab.db')
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT)')
db.exec('INSERT INTO t (k) VALUES (?)', 'via the library')

queue.push(calls, {tok = 3, call = 'sql/query',
  args = {db = 'lab.db', sql = 'SELECT k FROM t'}})
local _, reply = queue.wait({replies})

local _, status, detail = db.try_exec('BEGIN')
queue.push(log, {raw = reply.value.rows[1][1],
                 lib = db.query('SELECT k FROM t').rows[1][1],
                 refused = status, detail = detail})`), CONFIG);

    const answer = report.events.find((e) => e.event === 'message' && e.queue === 'log');
    // The row the library wrote, read back through a hand-rolled call.
    expect(answer.value.raw).toBe('via the library');
    expect(answer.value.lib).toBe('via the library');
    // And `try_*` returns a refusal rather than raising, with the
    // connector's own sentence intact.
    expect(answer.value.refused).toBe('error');
    expect(answer.value.detail).toContain('refused by this connector');
  });

  test('a database name that leaves the scope is denied, not clamped', async ({ page }) => {
    await openKernel(page);
    const report = await drive(page, HOSTCALL_ROOT(`
local _, status, detail = host.try('sql/query', {db = '../secrets.db', sql = 'SELECT 1'})
queue.push(log, {status = status, detail = detail})`), CONFIG);

    const answer = report.events.find((e) => e.event === 'message' && e.queue === 'log');
    expect(answer.value.status).toBe('denied');
    expect(answer.value.detail).toContain('steps outside the granted scope');
  });

  test('an unwired connector is denied even when the grant allows it', async ({ page }) => {
    await openKernel(page);
    const report = await drive(page, HOSTCALL_ROOT(`
queue.push(calls, {tok = 9, call = 'time'})
local _, reply = queue.wait({replies})
queue.push(log, {status = reply.status, detail = reply.detail})`), {
      ...CONFIG,
      // Granted, and wired to nothing. Connectors are off by default and a
      // deployment names the ones it wants.
      connectors: {},
    });

    const answer = report.events.find((e) => e.event === 'message' && e.queue === 'log');
    expect(answer.value.status).toBe('denied');
    expect(answer.value.detail).toContain('off by default');
  });

  // The deferred seam, against the real runtime.
  //
  // Every connector above answers within the same `_pumpHostcalls` that
  // drained the request. Nothing reaching the network can: `fetch` settles
  // on a later turn of the event loop, and the C host hit this first --
  // build8 gave a connector the right to *take* a call and answer later,
  // precisely so one slow answer does not stall every instance.
  //
  // The stub stands in for the endpoint, not for the machinery: the guest
  // is a real program parked on `host/replies`, the request crosses the
  // real queues, and the answer is delivered by a later `swarmStep`.
  test('a connector may take a call now and answer on a later step', async ({ page }) => {
    await openKernel(page);
    const report = await page.evaluate(async () => {
      // Stub only the endpoint under test and delegate everything else --
      // the kernel fetches its own wasm module lazily, and a blanket stub
      // hands the compiler the stub's body instead.
      //
      // It resolves only after a macrotask, so an answer *cannot* be
      // produced inside the step that took the call. If the seam were
      // synchronous this program would park forever and the assertions
      // below would find no log message at all.
      const realFetch = window.fetch.bind(window);
      window.fetch = (url, init) => (String(url).startsWith('https://api.example.com/')
        ? new Promise((resolve) => setTimeout(() => resolve(
          new Response('pong', {
            status: 200,
            headers: { 'content-type': 'text/plain', 'x-seen': String(url) },
          }),
        ), 5))
        : realFetch(url, init));

      const source = `
local calls   = queue.declare('host/calls',   {capacity = 4, exported = true, on_full = 'reject'})
local replies = queue.declare('host/replies', {capacity = 4})
local log     = queue.declare('log', {capacity = 8, exported = true})
queue.push(calls, {tok = 9, call = 'rest/get', args = {url = 'https://api.example.com/v1/ping'}})
local _, reply = queue.wait({replies}, 10000)
queue.push(log, {tok = reply.tok, status = reply.status,
                 code = reply.value and reply.value.status,
                 body = reply.value and reply.value.body,
                 ctype = reply.value and reply.value.content_type})
return 0`;

      await window.lab.kernel.swarmStart(source, {
        caps: ['queue:*', 'host:rest/get'],
        budget: { instructions: 50_000_000, memoryKb: 4096 },
        connectors: { rest: { allow: ['https://api.example.com/'] } },
      });
      // Steps are separate awaits, so the event loop turns between them --
      // which is the only reason a deferred answer can ever arrive.
      for (let i = 0; i < 40; i++) {
        const r = await window.lab.kernel.swarmStep();
        if (r.alive === 0) return r;
        await new Promise((r2) => setTimeout(r2, 2));
      }
      return window.lab.kernel.swarmSnapshot();
    });

    const answer = report.events.find((e) => e.event === 'message' && e.queue === 'log');
    expect(answer, 'the guest should have been resumed with its answer').toBeTruthy();
    expect(answer.value.tok).toBe(9);
    expect(answer.value.status).toBe('ok');
    expect(answer.value.code).toBe(200);
    expect(answer.value.ctype).toContain('text/plain');
    expect(answer.value.body).toBe('pong');
  });
});

test.describe('duty 4 — the listener, without a socket', () => {
  const SERVICE = `
local inq  = queue.declare('http_in',  {capacity = 8})
local outq = queue.declare('http_out', {capacity = 8, exported = true})
while true do
  local q, req = queue.wait({inq})
  queue.push(outq, {conn = req.conn, status = 200, content_type = 'text/plain',
                    body = ('you asked for %s %s'):format(req.method, req.path)})
end`;

  test('a request pushed by the page is answered by the program', async ({ page }) => {
    await openKernel(page);
    const report = await page.evaluate(async ([source]) => {
      const kernel = window.lab.kernel;
      await kernel.swarmStart(source, {
        caps: ['queue:*'],
        budget: { instructions: 50_000_000, memoryKb: 4096 },
        connectors: { listen: { port: 8080 } },
      });
      await kernel.swarmStep();
      await kernel.swarmRequest({ method: 'GET', path: '/hello' });
      return kernel.swarmRun({ maxSteps: 10, budgetMs: 500 });
    }, [SERVICE]);

    expect(report.listener.bound).toBe(false);
    expect(report.listener.port).toBe(8080);
    const exchange = report.listener.exchanges.at(-1);
    expect(exchange.status).toBe(200);
    expect(exchange.body).toBe('you asked for GET /hello');
    // `conn` is the host's and comes back verbatim.
    expect(exchange.conn).toBe(1);
  });
});

test.describe('duty 7 — shutdown', () => {
  test('stopping frees the swarm and is idempotent', async ({ page }) => {
    await openKernel(page);
    const after = await page.evaluate(async ([source, config]) => {
      const kernel = window.lab.kernel;
      await kernel.swarmStart(source, config);
      await kernel.swarmStep();
      const first = await kernel.swarmStop();
      const second = await kernel.swarmStop();
      return { first: first.running, second: second.running };
    }, [SUPERVISOR, ROOT_CONFIG]);
    expect(after.first).toBe(false);
    expect(after.second).toBe(false);
  });

  test('a second swarm can start after the first is stopped', async ({ page }) => {
    const problems = await openKernel(page);
    const rosters = await page.evaluate(async ([source, config]) => {
      const kernel = window.lab.kernel;
      const out = [];
      for (let i = 0; i < 2; i++) {
        await kernel.swarmStart(source, config);
        for (let s = 0; s < 20; s++) if ((await kernel.swarmStep()).alive === 0) break;
        out.push((await kernel.swarmSnapshot()).roster.length);
        await kernel.swarmStop();
      }
      return out;
    }, [SUPERVISOR, ROOT_CONFIG]);
    expect(rosters).toEqual([2, 2]);
    expect(problems).toEqual([]);
  });
});

test.describe('the host never lets an exception into wasm', () => {
  test('a connector that throws becomes an error reply, not a trap', async ({ page }) => {
    await openKernel(page);
    // A connector's bug must not unwind the wasm stack mid-`dvs_step`.
    const report = await page.evaluate(async () => {
      const kernel = window.lab.kernel;
      const source = `
local calls   = queue.declare('host/calls',   {capacity = 4, exported = true, on_full = 'reject'})
local replies = queue.declare('host/replies', {capacity = 4})
local log     = queue.declare('log', {capacity = 8, exported = true})
queue.push(calls, {tok = 3, call = 'crypto/random', args = {bytes = 0}})
local _, reply = queue.wait({replies})
queue.push(log, {status = reply.status, detail = reply.detail})
return 0`;
      await kernel.swarmStart(source, {
        caps: ['queue:*', 'host:crypto/random'],
        budget: { instructions: 20_000_000, memoryKb: 2048 },
        connectors: { crypto: true },
      });
      for (let i = 0; i < 20; i++) if ((await kernel.swarmStep()).alive === 0) break;
      return kernel.swarmSnapshot();
    });

    const answer = report.events.find((e) => e.event === 'message' && e.queue === 'log');
    expect(answer.value.status).toBe('error');
    expect(report.faults).toEqual([]);
  });
});
