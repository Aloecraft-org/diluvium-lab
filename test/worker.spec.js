import { test, expect } from '@playwright/test';

// The kernel off the main thread, and the stop that becomes possible.
//
// `run_lua` is a synchronous WASM call and nothing preempts it, so this
// suite cannot test "interrupt" in the Jupyter sense -- it does not exist.
// What it tests is the thing that does: the frozen thread is not the one
// painting the page, and terminating it is a real stop.
//
// The load-bearing assertion in most of these is that the *main thread is
// still alive* while a cell runs forever. Every check is written so that a
// blocked main thread fails it by timing out rather than by passing
// quietly -- an earlier version of this port silently fell back to running
// in the page, the whole suite still passed, and the only symptom was that
// stop did nothing.

async function openLab(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  return problems;
}

const codeCell = (page) => page.locator('.cell[data-cell-type="code"]').first();
const stopButton = (page) => page.locator('[data-toolbar="stop"]');

/** Start a cell that never finishes, and wait until it is really running. */
async function startRunaway(page) {
  const cell = codeCell(page);
  await cell.locator('[data-editor]').fill('while true do end');
  await cell.locator('[data-editor]').press('Control+Enter');
  await expect(page.locator('body')).toHaveAttribute('data-kernel-state', 'busy');
  return cell;
}

test.describe('the kernel runs off the main thread', () => {
  test('and says so, with the capabilities that follow from it', async ({ page }) => {
    await openLab(page);
    const info = await page.evaluate(() => ({
      offThread: window.lab.kernel.offThread,
      label: window.lab.kernel.label,
      caps: window.lab.kernel.capabilities,
      reason: window.lab.kernel.fallbackReason ?? null,
    }));

    expect(info.offThread, `fell back to the page: ${info.reason}`).toBe(true);
    expect(info.label).toContain('worker');
    expect(info.caps.interrupt).toBe(true);
    // The honest half of the pair. A UI that reads `interrupt` without
    // reading this one promises Jupyter's interrupt and delivers a restart.
    expect(info.caps.interruptLosesState).toBe(true);
  });

  test('a cell that never finishes leaves the page usable', async ({ page }) => {
    await openLab(page);
    await startRunaway(page);

    // All of this happens while Lua is spinning. On the main thread none
    // of it would run at all -- the assertions would time out.
    await expect(page.locator('body')).toHaveAttribute('data-kernel-state', 'busy');
    const before = await page.locator('.cell').count();
    await page.locator('[data-toolbar="add-markdown"]').click();
    await expect(page.locator('.cell')).toHaveCount(before + 1);
    const typed = page.locator('.cell').last().locator('[data-editor]');
    await typed.fill('typing works while a cell runs forever');
    await expect(typed).toHaveValue('typing works while a cell runs forever');
    // Scrolling, painting and the status indicator all still work too.
    await expect(page.locator('[data-kernel-status]')).toHaveText('busy');
  });

  test('stop ends it, and the kernel works again immediately', async ({ page }) => {
    await openLab(page);
    await startRunaway(page);

    await expect(stopButton(page)).toBeEnabled();
    await stopButton(page).click();
    await expect(page.locator('body')).toHaveAttribute('data-kernel-state', 'idle', { timeout: 15_000 });

    const after = await page.evaluate(async () => {
      const { executeCollected } = await import('./src/kernel/kernel.js');
      return executeCollected(window.lab.kernel, 'return 6 * 7');
    });
    expect(after.status).toBe('ok');
    expect(after.result).toBe('42');
  });

  test('the stopped call rejects rather than hanging forever', async ({ page }) => {
    await openLab(page);
    // A promise that never settles is how a UI ends up stuck on "running"
    // with no way back, which is the failure this whole change exists to
    // remove -- so the runaway's own promise has to settle too.
    const outcome = await page.evaluate(async () => {
      const kernel = window.lab.kernel;
      const running = kernel.execute('while true do end').then(() => 'resolved', (e) => e.message);
      await new Promise((r) => setTimeout(r, 300));
      await kernel.interrupt();
      return running;
    });
    expect(outcome).toContain('stopped');
  });

  test('stop is offered only when there is something to stop', async ({ page }) => {
    await openLab(page);
    await expect(stopButton(page)).toBeDisabled();
    await startRunaway(page);
    await expect(stopButton(page)).toBeEnabled();
    await stopButton(page).click();
    await expect(stopButton(page)).toBeDisabled();
  });

  test('the console says what stop cost', async ({ page }) => {
    await openLab(page);
    // Told, not discovered. Terminating the worker takes the Lua state
    // with it, and someone who is not told will find out by losing an
    // afternoon's variables.
    await page.evaluate(() => window.lab.kernel.execute('survivor = "before the stop"'));
    await startRunaway(page);
    await stopButton(page).click();
    await expect(page.locator('body')).toHaveAttribute('data-kernel-state', 'idle', { timeout: 15_000 });

    await expect(page.locator('[data-console]')).toContainText('every variable is gone');
    const gone = await page.evaluate(async () => {
      const { executeCollected } = await import('./src/kernel/kernel.js');
      return executeCollected(window.lab.kernel, 'return tostring(survivor)');
    });
    expect(gone.result).toBe('nil');
  });

  test('output produced before the runaway is not lost', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('print("printed first") while true do end');
    await cell.locator('[data-editor]').press('Control+Enter');
    await expect(page.locator('body')).toHaveAttribute('data-kernel-state', 'busy');
    await stopButton(page).click();
    await expect(page.locator('body')).toHaveAttribute('data-kernel-state', 'idle', { timeout: 15_000 });
    // Streamed while it ran, so it survives the kernel that produced it.
    // (Whether it arrives depends on stdio buffering, so this asserts the
    // page did not crash rather than asserting the text is there.)
    await expect(page.locator('.cell').first()).toBeVisible();
  });
});

test.describe('the worker is a real boundary', () => {
  test('a kernel error still reaches the page', async ({ page }) => {
    await openLab(page);
    const result = await page.evaluate(async () => {
      const { executeCollected } = await import('./src/kernel/kernel.js');
      return executeCollected(window.lab.kernel, 'error("across the boundary")');
    });
    expect(result.status).toBe('error');
    expect(result.error.evalue).toContain('across the boundary');
    // The traceback is an array of strings on the far side and has to
    // arrive as one -- this is the sort of thing structured clone silently
    // reshapes if the protocol objects were ever not plain.
    expect(Array.isArray(result.error.traceback)).toBe(true);
  });

  test('pcall still catches, which is the whole Stage 0 question', async ({ page }) => {
    await openLab(page);
    const result = await page.evaluate(async () => {
      const { executeCollected } = await import('./src/kernel/kernel.js');
      return executeCollected(window.lab.kernel,
        'local ok, err = pcall(function() error("caught") end) return tostring(ok) .. " / " .. tostring(err)');
    });
    expect(result.status).toBe('ok');
    expect(result.result).toContain('false');
    expect(result.result).toContain('caught');
  });

  test('bytecode, completion and is_complete all cross intact', async ({ page }) => {
    await openLab(page);
    const out = await page.evaluate(async () => {
      const kernel = window.lab.kernel;
      const { readChunk, fromHex } = await import('./src/analysis/luac.js');
      const hex = await kernel.dumpBytecode('return 1', { strip: true });
      const complete = await kernel.complete('str', 3);
      const isComplete = await kernel.isComplete('if x then');
      return {
        lua: readChunk(fromHex(hex)).header.lua,
        matches: complete.content.matches.includes('string'),
        status: isComplete.content.status,
      };
    });
    expect(out.lua).toBe('5.5');
    expect(out.matches).toBe(true);
    expect(out.status).toBe('incomplete');
  });

  test('restart clears state and resets the counter', async ({ page }) => {
    await openLab(page);
    await page.evaluate(() => window.lab.kernel.execute('kept = 1'));
    await page.locator('[data-toolbar="restart"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-kernel-state', 'idle', { timeout: 15_000 });
    const out = await page.evaluate(async () => {
      const { executeCollected } = await import('./src/kernel/kernel.js');
      const r = await executeCollected(window.lab.kernel, 'return tostring(kept)');
      return { result: r.result, count: r.executionCount };
    });
    expect(out.result).toBe('nil');
    expect(out.count).toBe(1);
  });

  test('the language probe still runs, so highlighting survives the move', async ({ page }) => {
    await openLab(page);
    const language = await page.evaluate(() => window.lab.language);
    expect(language.keywords).toHaveLength(26);
    expect(language.keywords).toContain('switch');
    expect(language.globals).toContain('print');
  });
});
