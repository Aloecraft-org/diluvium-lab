import { test, expect } from '@playwright/test';

// The kernel interface, exercised against the real WASM instance.
//
// Everything here goes through `Kernel`'s public surface. If a test needs to
// reach past it, the interface is wrong -- that is the whole point of having
// one implementation behind an abstraction from Stage 1.

async function openKernel(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(msg.text()); });
  await page.goto('/test/kernel-page.html');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  return problems;
}

const run = (page, code) => page.evaluate((c) => window.lab.run(c), code);

test.describe('execution', () => {
  test('stdout comes back as a stream message', async ({ page }) => {
    await openKernel(page);
    const r = await run(page, 'print("hello, lab")');
    expect(r.status).toBe('ok');
    expect(r.stdout).toBe('hello, lab\n');
    expect(r.error).toBeNull();
  });

  test('state persists across executions, which is what makes it a kernel', async ({ page }) => {
    await openKernel(page);
    await run(page, 'counter = 41');
    const r = await run(page, 'counter = counter + 1 print(counter)');
    expect(r.stdout).toBe('42\n');
  });

  test('execution counts increment like Jupyter In[n]', async ({ page }) => {
    await openKernel(page);
    const a = await run(page, 'print(1)');
    const b = await run(page, 'print(2)');
    expect(b.executionCount).toBe(a.executionCount + 1);
  });

  test('the full stdlib is there', async ({ page }) => {
    await openKernel(page);
    const r = await run(page, 'print(table.concat({"a","b"}, "-"), math.floor(3.7), ("x"):rep(3))');
    expect(r.stdout).toBe('a-b\t3\txxx\n');
  });
});

// ---------------------------------------------------------------------
// Expression echo. Stage 0 measured that prepending `return` host-side is
// not enough -- run_lua discards results -- so this is the part that has to
// be proven rather than assumed.
// ---------------------------------------------------------------------

test.describe('expression echo', () => {
  test('an expression cell reports its value as execute_result', async ({ page }) => {
    await openKernel(page);
    const r = await run(page, '1 + 1');
    expect(r.result).toBe('2');
    expect(r.stdout).toBe('');
    expect(r.status).toBe('ok');
  });

  test('multiple return values are tab-joined', async ({ page }) => {
    await openKernel(page);
    expect((await run(page, '1, 2, 3')).result).toBe('1\t2\t3');
  });

  test('nil echoes rather than vanishing', async ({ page }) => {
    await openKernel(page);
    expect((await run(page, 'nil')).result).toBe('nil');
  });

  test('a statement produces no result, only its output', async ({ page }) => {
    await openKernel(page);
    const r = await run(page, 'local z = 3 print("side effect")');
    expect(r.result).toBeNull();
    expect(r.stdout).toBe('side effect\n');
  });

  test('a call that returns nothing produces no result', async ({ page }) => {
    await openKernel(page);
    const r = await run(page, 'print("just output")');
    expect(r.result).toBeNull();
    expect(r.stdout).toBe('just output\n');
  });

  test('a cell of statements ending in an expression echoes the last one', async ({ page }) => {
    await openKernel(page);
    const r = await run(page, 'tally = (tally or 0) + 1\ntally');
    expect(r.result).toBe('1');
    expect(r.status).toBe('ok');
  });

  test('the trailing expression still sees locals declared above it', async ({ page }) => {
    await openKernel(page);
    // Only true if the whole cell compiles as one chunk. Running the halves
    // separately would put `t` out of scope and blow up.
    const r = await run(page, 'local t = { 10, 20, 30 }\nlocal n = #t\nt[n]');
    expect(r.result).toBe('30');
  });

  test('splitting never breaks out of a loop early', async ({ page }) => {
    await openKernel(page);
    // The dangerous case: a naive split puts `return` inside the loop body
    // and the cell prints 1 instead of 1, 2, 3.
    const r = await run(page, 'for i = 1, 3 do\n  print(i)\nend');
    expect(r.stdout).toBe('1\n2\n3\n');
    expect(r.result).toBeNull();
  });

  test('nor out of an if block', async ({ page }) => {
    await openKernel(page);
    const r = await run(page, 'if true then\n  print("inside")\nend\nprint("after")');
    expect(r.stdout).toBe('inside\nafter\n');
  });

  test('a trailing call with no return value echoes nothing', async ({ page }) => {
    await openKernel(page);
    const r = await run(page, 'local x = 1\nprint("done")');
    expect(r.stdout).toBe('done\n');
    expect(r.result).toBeNull();
  });

  test('output and value both survive, in that order', async ({ page }) => {
    await openKernel(page);
    const r = await run(page, '(function() print("first") return "second" end)()');
    expect(r.stdout).toBe('first\n');
    expect(r.result).toBe('second');
  });
});

// ---------------------------------------------------------------------
// Errors. Stage 0 found run_lua puts them on stdout with a non-zero status;
// the Lua harness turns them into structured `error` messages instead.
// ---------------------------------------------------------------------

test.describe('errors', () => {
  test('a runtime error is an error message, not stdout noise', async ({ page }) => {
    await openKernel(page);
    const r = await run(page, 'error("boom")');
    expect(r.status).toBe('error');
    expect(r.error.ename).toBe('LuaError');
    expect(r.error.evalue).toContain('boom');
    expect(r.stdout).toBe('');
  });

  test('errors carry a traceback', async ({ page }) => {
    await openKernel(page);
    const r = await run(page, 'local function inner() error("deep") end\nlocal function outer() inner() end\nouter()');
    expect(r.error.traceback.join('\n')).toContain('stack traceback');
  });

  test('a syntax error is reported as one, before anything runs', async ({ page }) => {
    await openKernel(page);
    const r = await run(page, 'this is not lua');
    expect(r.status).toBe('error');
    expect(r.error.ename).toBe('SyntaxError');
  });

  test('output printed before an error is kept', async ({ page }) => {
    await openKernel(page);
    const r = await run(page, 'print("got this far") error("then failed")');
    expect(r.stdout).toBe('got this far\n');
    expect(r.error.evalue).toContain('then failed');
  });

  test('pcall still catches -- the Stage 0 answer, through the real interface', async ({ page }) => {
    await openKernel(page);
    const r = await run(page, 'print(pcall(function() error("caught") end))');
    expect(r.status).toBe('ok');
    expect(r.stdout).toMatch(/^false\t/);
    expect(r.stdout).toContain('caught');
  });

  test('the kernel is usable after an error', async ({ page }) => {
    await openKernel(page);
    await run(page, 'error("boom")');
    const r = await run(page, 'print("still here")');
    expect(r.status).toBe('ok');
    expect(r.stdout).toBe('still here\n');
  });
});

// ---------------------------------------------------------------------
// The harness embeds user source as a Lua long string. If that embedding is
// wrong, code containing brackets executes as something else entirely --
// which is a correctness bug and a small injection surface.
// ---------------------------------------------------------------------

test.describe('source embedding', () => {
  const nasty = [
    ['closing long bracket', 'print("]]")', ']]\n'],
    ['levelled bracket', 'print("]==]")', ']==]\n'],
    ['both levels', 'print("]] and ]==]")', ']] and ]==]\n'],
    ['source ending in a bracket', 'print("x") --[[ ]]', 'x\n'],
    ['backslashes', 'print("a\\\\b")', 'a\\b\n'],
    ['a lone quote', "print('\"')", '"\n'],
    ['unicode', 'print("héllo → 世界")', 'héllo → 世界\n'],
    ['embedded newlines in a string', 'print("a\\nb")', 'a\nb\n'],
  ];

  for (const [name, code, expected] of nasty) {
    test(`survives ${name}`, async ({ page }) => {
      await openKernel(page);
      const r = await run(page, code);
      expect(r.status).toBe('ok');
      expect(r.stdout).toBe(expected);
    });
  }

  test('a long string that would close early is levelled correctly', async ({ page }) => {
    await openKernel(page);
    // The generated wrapper must pick a level higher than anything inside.
    const r = await run(page, 'print([==[ nested ]==])');
    expect(r.stdout).toBe(' nested \n');
  });
});

// ---------------------------------------------------------------------

test.describe('restart', () => {
  test('restart discards state', async ({ page }) => {
    await openKernel(page);
    await run(page, 'survivor = "before"');
    await page.evaluate(() => window.lab.kernel.restart());
    const r = await run(page, 'print(tostring(survivor))');
    expect(r.stdout).toBe('nil\n');
  });

  test('restart resets the execution count', async ({ page }) => {
    await openKernel(page);
    await run(page, 'print(1)');
    await run(page, 'print(2)');
    await page.evaluate(() => window.lab.kernel.restart());
    expect((await run(page, 'print(3)')).executionCount).toBe(1);
  });

  test('repeated restarts stay healthy and start from a fresh memory', async ({ page }) => {
    await openKernel(page);
    const sizes = await page.evaluate(async () => {
      const out = [];
      for (let i = 0; i < 20; i++) {
        await window.lab.kernel.restart();
        // grow this instance's memory, then check the next one starts small
        await window.lab.run('local t = {} for j = 1, 20000 do t[j] = ("x"):rep(40) end');
        out.push(window.lab.kernel._instance.exports.memory.buffer.byteLength);
      }
      return out;
    });
    // Every instance grew to roughly the same size: nothing is accumulating
    // across restarts, which is what dropping the instance reference buys.
    expect(sizes).toHaveLength(20);
    expect(Math.max(...sizes)).toBeLessThan(Math.min(...sizes) * 2);

    const r = await run(page, 'print("healthy")');
    expect(r.stdout).toBe('healthy\n');
  });

  test('status messages are published across a restart', async ({ page }) => {
    await openKernel(page);
    await page.evaluate(() => { window.lab.statuses.length = 0; });
    await page.evaluate(() => window.lab.kernel.restart());
    expect(await page.evaluate(() => window.lab.statuses)).toEqual(['starting', 'idle']);
  });
});

// ---------------------------------------------------------------------

test.describe('is_complete', () => {
  const cases = [
    ['print(1)', 'complete'],
    ['1 + 1', 'complete'],
    ['function f()', 'incomplete'],
    ['if true then', 'incomplete'],
    ['local t = {', 'incomplete'],
    ['this is not lua', 'invalid'],
    ['1 +', 'incomplete'],
  ];

  for (const [code, expected] of cases) {
    test(`${JSON.stringify(code)} is ${expected}`, async ({ page }) => {
      await openKernel(page);
      const status = await page.evaluate(
        async (c) => (await window.lab.kernel.isComplete(c)).content.status, code);
      expect(status).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------

test.describe('completion', () => {
  test('completes globals', async ({ page }) => {
    await openKernel(page);
    const matches = await page.evaluate(
      async () => (await window.lab.kernel.complete('prin', 4)).content.matches);
    expect(matches).toContain('print');
  });

  test('completes table fields', async ({ page }) => {
    await openKernel(page);
    const matches = await page.evaluate(
      async () => (await window.lab.kernel.complete('string.re', 9)).content.matches);
    expect(matches).toContain('rep');
    expect(matches).toContain('reverse');
    expect(matches).not.toContain('print');
  });

  test('completes user-defined values', async ({ page }) => {
    await openKernel(page);
    await run(page, 'mytable = { alpha = 1, alpine = 2, beta = 3 }');
    const matches = await page.evaluate(
      async () => (await window.lab.kernel.complete('mytable.alp', 11)).content.matches);
    expect(matches).toEqual(['alpha', 'alpine']);
  });

  test('reports the span it would replace', async ({ page }) => {
    await openKernel(page);
    const content = await page.evaluate(
      async () => (await window.lab.kernel.complete('x = string.re', 13)).content);
    expect(content.cursor_start).toBe(11);
    expect(content.cursor_end).toBe(13);
  });

  test('an unresolvable base yields nothing rather than throwing', async ({ page }) => {
    await openKernel(page);
    const matches = await page.evaluate(
      async () => (await window.lab.kernel.complete('nosuchthing.fo', 14)).content.matches);
    expect(matches).toEqual([]);
  });
});

// ---------------------------------------------------------------------

test.describe('protective limits', () => {
  test('a runaway cell is capped instead of taking the tab', async ({ page }) => {
    await openKernel(page);
    test.setTimeout(120_000);
    // Far past the kernel's output ceiling.
    const r = await run(page, 'for i = 1, 400000 do print(("y"):rep(200)) end');
    expect(r.stdout.length).toBeLessThan(8 * 1024 * 1024);
    expect(r.stderr).toContain('stopped recording output');

    // ... and the kernel still works afterwards.
    expect((await run(page, 'print("alive")')).stdout).toBe('alive\n');
  });
});

// ---------------------------------------------------------------------

test.describe('capabilities are honest', () => {
  test('interrupt is advertised as unavailable', async ({ page }) => {
    await openKernel(page);
    const caps = await page.evaluate(() => window.lab.kernel.capabilities);
    expect(caps.interrupt).toBe(false);
    expect(caps.restart).toBe(true);
  });
});
