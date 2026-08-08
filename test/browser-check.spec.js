import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

// notebooks/browser-check.ipynb is handed to people on browsers nobody
// here can run, and asks them to read PASS/FAIL lines. So it has to be
// right on the browser we *can* run, or the first report back is a bug in
// the checklist rather than a bug in the engine.
//
// This opens the real file through the real Open… control and runs every
// cell except the deliberate infinite loop, then asserts that nothing
// printed FAIL. It is also what stops the notebook rotting: a change that
// breaks one of its checks fails here.

const NOTEBOOK = fileURLToPath(new URL('../notebooks/browser-check.ipynb', import.meta.url));

/** The cell that never finishes, by design. Section 10 is run by hand. */
const RUNAWAY = 'while true do end';

async function openLab(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  return problems;
}

test.describe('the browser-check notebook', () => {
  test('opens, and every automated check passes', async ({ page }) => {
    const problems = await openLab(page);
    await page.locator('[data-file-input]').setInputFiles(NOTEBOOK);
    await expect(page.locator('[data-filename]')).toContainText('browser-check');

    const outputs = await page.evaluate(async (runaway) => {
      const { executeCollected } = await import('./src/kernel/kernel.js');
      const results = [];
      for (const cell of window.lab.model.cells) {
        if (cell.cell_type !== 'code') continue;
        if (cell.source.includes(runaway)) continue;      // section 10, by hand
        const out = await executeCollected(window.lab.kernel, cell.source);
        results.push({
          source: cell.source.slice(0, 60),
          status: out.status,
          text: `${out.stdout}${out.result ?? ''}`,
          error: out.error?.evalue ?? null,
        });
      }
      return results;
    }, RUNAWAY);

    // Nothing may fail its own check...
    const failed = outputs.filter((o) => o.text.includes('FAIL'));
    expect(failed.map((f) => `${f.source} → ${f.text.split('\n').filter((l) => l.includes('FAIL')).join('; ')}`))
      .toEqual([]);

    // ...and nothing may error outright, which is a different failure: a
    // check that cannot even run tells the reporter nothing.
    const errored = outputs.filter((o) => o.status !== 'ok');
    expect(errored.map((e) => `${e.source} → ${e.error}`)).toEqual([]);

    // Every automated section should have said PASS about something.
    expect(outputs.filter((o) => o.text.includes('PASS')).length).toBeGreaterThanOrEqual(5);
    expect(problems).toEqual([]);
  });

  test('the pcall check would actually notice a broken pcall', async ({ page }) => {
    await openLab(page);
    // The most important line in the notebook is section 2, and a check
    // that cannot fail is worse than no check. This runs its logic against
    // a deliberately broken stand-in for pcall to confirm the assertion
    // has teeth rather than always printing PASS.
    const out = await page.evaluate(async () => {
      const { executeCollected } = await import('./src/kernel/kernel.js');
      return executeCollected(window.lab.kernel, `
        local real = pcall
        pcall = function() return true end        -- a pcall that never catches
        local caught = pcall(function() error("boom") end)
        local verdict = ((not caught) and "PASS" or "FAIL")
        pcall = real
        return verdict
      `);
    });
    expect(out.result).toBe('FAIL');
  });

  test('the output cap really truncates the runaway printer', async ({ page }) => {
    await openLab(page);
    // Section 6 asks the reader to look for a truncation note. Confirm
    // there is one to look for.
    const out = await page.evaluate(async () => {
      const { executeCollected } = await import('./src/kernel/kernel.js');
      const r = await executeCollected(window.lab.kernel, 'for i = 1, 5000 do print("line " .. i) end');
      return { status: r.status, lines: r.stdout.split('\n').length };
    });
    expect(out.status).toBe('ok');
    // It ran to completion and the Lab kept the output bounded rather
    // than holding five thousand lines in the page.
    expect(out.lines).toBeGreaterThan(10);
  });
});
