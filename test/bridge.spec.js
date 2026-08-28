import { test, expect } from '@playwright/test';

// The JS half of DRT's browser tier, against the real kernel.
//
// `doc/Browser.md` in `diluvium-drt` specifies a bridge the Rust side is
// constructed with: sixteen functions over a diluvium instance, which JS
// supplies because two wasm modules cannot call each other in a page. This
// drives that surface directly, with no `drt-web` present -- the contract
// is what it speaks, and every one of the sixteen is answerable by the
// kernel the Lab already ships.
//
// The properties under test are the ones the contract is picky about, and
// they are picky for reasons that cost someone an afternoon on the C side:
//
//   * the may-throw / must-not-throw split, because an exception out of a
//     must-not-throw import aborts the module rather than failing;
//   * `release`, because a swarm that hibernates and kills leaks the JS
//     table for the page's lifetime without it;
//   * a full queue as a *value* and an unknown queue as a throw, because
//     `PushOutcome` has a variant for one and not the other;
//   * two-phase reads, because `dv_queue_pop` and `dv_snapshot` report
//     what they need rather than truncating.

async function open(page) {
  await page.goto('/test/kernel-page.html');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
}

/** A program that finishes on its own. */
const RUNS_TO_COMPLETION = `
local total = 0
for i = 1, 1000 do total = total + i end
return 0
`;

/**
 * A program that declares a queue and parks on it, twice.
 *
 * `outbox` is looked up rather than declared: a fresh instance already has
 * `inbox` and `outbox` (§9.2's reserved pair), and declaring one again is
 * an error rather than a no-op.
 */
const PARKS_ON_A_QUEUE = `
local inq = queue.declare('work', {capacity = 4})
local out = queue.lookup('outbox')
for _ = 1, 2 do
  local _, msg = queue.wait({inq})
  queue.push(out, {saw = msg})
end
return 0
`;

test.describe('the drt-web host bridge', () => {
  test('the shipped kernel can back the browser tier, and says so', async ({ page }) => {
    await open(page);
    const report = await page.evaluate(() => ({
      capable: window.lab.bridgeCapable(window.lab.moduleExports()),
      problems: window.lab.bridgeProblems(window.lab.moduleExports()),
      // The counterpart seam: a page asks both and takes whichever
      // answers, which is how a second backend arrives without a rewrite.
      nothing: window.lab.bridgeCapable(null),
      whyNothing: window.lab.bridgeProblems(null),
    }));
    expect(report.capable).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.nothing).toBe(false);
    expect(report.whyNothing[0]).toContain('no module loaded');
  });

  test('a program loads, runs to completion, and reports what it spent', async ({ page }) => {
    await open(page);
    const result = await page.evaluate((code) => {
      const bridge = window.lab.makeBridge();
      try {
        const h = bridge.load(code, 'adder', { instructions: 10_000_000 }, false);
        const step = bridge.run(h);
        const usage = bridge.usage(h);
        return { handle: h, step, usage, exceeded: bridge.exceeded(h), faults: bridge.faults };
      } finally {
        bridge.destroy();
      }
    }, RUNS_TO_COMPLETION);

    expect(result.step).toEqual({ done: true });
    expect(result.exceeded).toBe(false);
    // Three figures, and `bytesNow` is the one `doc/Browser.md` had to add
    // back: it is what an idle agent costs, which a peak cannot answer.
    expect(result.usage.instructions).toBeGreaterThan(0);
    expect(result.usage.bytesNow).toBeGreaterThan(0);
    expect(result.faults).toEqual([]);
  });

  test('a message round-trips: park, push, resume, pop the answer', async ({ page }) => {
    await open(page);
    const result = await page.evaluate((code) => {
      const bridge = window.lab.makeBridge();
      const { encode, decode } = window.lab.msgpack;
      try {
        const h = bridge.load(code, 'echo', { instructions: 10_000_000 }, false);

        // First run parks it on `work`.
        const parked = bridge.run(h);
        const work = bridge.queue(h, 'work');
        const outbox = bridge.queue(h, 'outbox');

        // The wait-set the program parked with, and the one it reports
        // when asked afterwards, must agree -- `dv_resume` fills no
        // wait-set of its own, so the second read is the one a host that
        // resumed would rely on.
        const wait = bridge.currentWait(h);

        const pushed = bridge.push(h, work, encode('hello'));
        const after = bridge.resume(h, work);
        const answer = bridge.pop(h, outbox);

        return {
          parked,
          waitAgrees: wait.queues.includes(work),
          // The program set no timeout, which dv.h spells as a negative
          // and this reports as null rather than as a duration of -1.
          timeoutMs: wait.timeoutMs,
          forSpace: wait.forSpace,
          pushed,
          parkedAgain: !!after.parked,
          answer: answer ? decode(answer) : null,
          faults: bridge.faults,
        };
      } finally {
        bridge.destroy();
      }
    }, PARKS_ON_A_QUEUE);

    expect(result.parked.parked.queues.length).toBeGreaterThan(0);
    expect(result.waitAgrees).toBe(true);
    expect(result.timeoutMs).toBeNull();
    expect(result.forSpace).toBe(false);
    expect(result.pushed).toBe('accepted');
    expect(result.parkedAgain).toBe(true);      // it loops, so it parks again
    expect(result.answer).toEqual({ saw: 'hello' });
    expect(result.faults).toEqual([]);
  });

  test('a program that will not compile throws from `load`, and leaks nothing', async ({ page }) => {
    await open(page);
    const result = await page.evaluate(() => {
      const bridge = window.lab.makeBridge();
      try {
        let message = null;
        try {
          bridge.load('this is not lua ((', 'broken', {}, false);
        } catch (err) {
          message = err.message;
        }
        // The refusal must not cost an instance. `load` frees on the way
        // out, so a page that types badly all afternoon does not grow.
        return { message, handles: bridge.handles };
      } finally {
        bridge.destroy();
      }
    });
    expect(result.message).toBeTruthy();
    expect(result.handles).toEqual([]);
  });

  test('`release` frees the handle, and is idempotent', async ({ page }) => {
    await open(page);
    const result = await page.evaluate((code) => {
      const bridge = window.lab.makeBridge();
      try {
        const a = bridge.load(code, 'a', {}, false);
        const b = bridge.load(code, 'b', {}, false);
        const before = bridge.handles.length;
        bridge.release(a);
        const after = bridge.handles.length;
        // Called from a Rust destructor, which has no way to hear about a
        // problem and no way to try again: a second release is a no-op,
        // never a throw.
        bridge.release(a);
        bridge.release(9999);
        return { before, after, left: bridge.handles, b, faults: bridge.faults };
      } finally {
        bridge.destroy();
      }
    }, RUNS_TO_COMPLETION);

    expect(result.before).toBe(2);
    expect(result.after).toBe(1);
    expect(result.left).toEqual([result.b]);
    expect(result.faults).toEqual([]);
  });

  test('a full queue is a value; an unknown queue is a throw', async ({ page }) => {
    await open(page);
    const result = await page.evaluate((code) => {
      const bridge = window.lab.makeBridge();
      const { encode } = window.lab.msgpack;
      try {
        const h = bridge.load(code, 'echo', { instructions: 10_000_000 }, false);
        bridge.run(h);
        const work = bridge.queue(h, 'work');

        // Capacity is 4. A full queue is a normal outcome and not an
        // error -- dv.h's rule, and `PushOutcome`'s shape.
        const outcomes = [];
        for (let i = 0; i < 6; i++) outcomes.push(bridge.push(h, work, encode(i)));

        // An unknown queue is the host asking about something that does
        // not exist, which has no variant and therefore throws.
        let unknown = null;
        try { bridge.push(h, 4242, encode('x')); } catch (err) { unknown = err.message; }

        // A name that was never declared is null, not a handle that would
        // read as falsy twice.
        const missing = bridge.queue(h, 'no-such-queue');

        return { outcomes, unknown, missing, info: bridge.queueInfo(h, work) };
      } finally {
        bridge.destroy();
      }
    }, PARKS_ON_A_QUEUE);

    expect(result.outcomes.slice(0, 4)).toEqual(
      ['accepted', 'accepted', 'accepted', 'accepted'],
    );
    expect(result.outcomes[4]).toBe('full');
    expect(result.unknown).toContain('4242');
    expect(result.missing).toBeNull();
    expect(result.info).toMatchObject({ capacity: 4, enabled: true });
  });

  test('popping an empty queue is null, not an error', async ({ page }) => {
    await open(page);
    const empty = await page.evaluate((code) => {
      const bridge = window.lab.makeBridge();
      try {
        const h = bridge.load(code, 'echo', { instructions: 10_000_000 }, false);
        bridge.run(h);
        return bridge.pop(h, bridge.queue(h, 'outbox'));
      } finally {
        bridge.destroy();
      }
    }, PARKS_ON_A_QUEUE);
    expect(empty).toBeNull();
  });

  test('a parked instance snapshots, and the bytes restore into a fresh handle', async ({ page }) => {
    await open(page);
    const result = await page.evaluate((code) => {
      const bridge = window.lab.makeBridge();
      const { encode, decode } = window.lab.msgpack;
      try {
        const h = bridge.load(code, 'echo', { instructions: 10_000_000 }, false);
        bridge.run(h);                        // park it: the only snapshottable state

        const bytes = bridge.snapshot(h, null);
        const restored = bridge.restore(bytes, null, { instructions: 10_000_000 }, false);

        // A restored instance continues; it does not start. So the next
        // call is the wait-set, then a resume -- never `run`.
        const wait = bridge.currentWait(restored);
        const work = bridge.queue(restored, 'work');
        bridge.push(restored, work, encode('after'));
        bridge.resume(restored, work);
        const answer = bridge.pop(restored, bridge.queue(restored, 'outbox'));

        return {
          size: bytes.length,
          differentHandle: restored !== h,
          parked: wait !== null,
          answer: answer ? decode(answer) : null,
        };
      } finally {
        bridge.destroy();
      }
    }, PARKS_ON_A_QUEUE);

    expect(result.size).toBeGreaterThan(0);
    expect(result.differentHandle).toBe(true);
    expect(result.parked).toBe(true);
    expect(result.answer).toEqual({ saw: 'after' });
  });

  test('a stamped snapshot refuses a mismatched stamp, by name', async ({ page }) => {
    await open(page);
    const message = await page.evaluate((code) => {
      const bridge = window.lab.makeBridge();
      try {
        const h = bridge.load(code, 'echo', { instructions: 10_000_000 }, false);
        bridge.run(h);
        const bytes = bridge.snapshot(h, 'lab-one');
        try {
          bridge.restore(bytes, 'lab-two', {}, false);
          return null;
        } catch (err) {
          return err.message;
        }
      } finally {
        bridge.destroy();
      }
    }, PARKS_ON_A_QUEUE);
    // Stamping is never advisory: a snapshot stamped by one host does not
    // restore under another's name.
    expect(message).toBeTruthy();
  });

  test('the must-not-throw set records a fault instead of throwing', async ({ page }) => {
    await open(page);
    const result = await page.evaluate(() => {
      const bridge = window.lab.makeBridge();
      try {
        // Every one of these is called from a context that has nowhere to
        // put an exception. A bogus handle must therefore produce a value.
        const answers = {
          queue: bridge.queue(9999, 'work'),
          currentWait: bridge.currentWait(9999),
          usage: bridge.usage(9999),
          exceeded: bridge.exceeded(9999),
          abiVersion: bridge.abiVersion(),
        };
        return { answers, faults: bridge.faults };
      } finally {
        bridge.destroy();
      }
    });

    expect(result.answers.queue).toBeNull();
    expect(result.answers.currentWait).toBeNull();
    expect(result.answers.usage).toEqual({ instructions: 0, memoryKbPeak: 0, bytesNow: 0 });
    expect(result.answers.exceeded).toBe(false);
    expect(result.answers.abiVersion).toBe(1);
    // Swallowed, but not lost: a host that hid its own bugs would be
    // worse than one that crashed.
    expect(result.faults.length).toBe(4);
    expect(result.faults[0]).toContain('9999');
  });

  test('`drive` reports a fault as a value, never as a throw', async ({ page }) => {
    await open(page);
    const result = await page.evaluate((code) => {
      const bridge = window.lab.makeBridge({
        drive: (id, handle, b) => {
          if (id === 7) throw new Error('a drive that misbehaves');
          const wait = b.currentWait(handle);
          const step = wait ? b.resume(handle, wait.queues[0] ?? 0) : b.run(handle);
          return step.done ? 'exited' : 'alive';
        },
      });
      try {
        const h = bridge.load(code, 'adder', { instructions: 10_000_000 }, false);
        return {
          // Unwinding a wasm frame mid-step leaves the swarm's bookkeeping
          // in a state nothing can describe, so a fault is a value.
          throwing: bridge.drive(7, h),
          missing: bridge.drive(1, 9999),
          ok: bridge.drive(1, h),
        };
      } finally {
        bridge.destroy();
      }
    }, RUNS_TO_COMPLETION);

    expect(result.throwing).toEqual({ faulted: 'a drive that misbehaves' });
    expect(result.missing.faulted).toContain('9999');
    expect(result.ok).toBe('exited');
  });

  test('an exhausted budget is reported, not raised', async ({ page }) => {
    await open(page);
    const result = await page.evaluate(() => {
      const bridge = window.lab.makeBridge();
      try {
        // Far less than the loop needs, so the hook stops it.
        const h = bridge.load('while true do end', 'runaway', { instructions: 200_000 }, false);
        let threw = null;
        try { bridge.run(h); } catch (err) { threw = err.message; }
        return { threw, exceeded: bridge.exceeded(h), usage: bridge.usage(h) };
      } finally {
        bridge.destroy();
      }
    });

    // The guest's fault, so it arrives as a throw from `run` -- which
    // `doc/Browser.md` routes to a Program error and the swarm reports as
    // a faulted instance.
    expect(result.threw).toBeTruthy();
    expect(result.exceeded).toBe(true);
    expect(result.usage.instructions).toBeGreaterThan(0);
  });
});
