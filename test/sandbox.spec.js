import { test, expect } from '@playwright/test';
import { dismissLauncher } from './chrome.js';

// The sandbox panel: running a cell as a `dv_` instance.
//
// Everything here drives the real ABI in the real artifact. There is no
// mock: `dv_new`, `dv_load`, `dv_run` and `dv_set_budget` are called
// through the wasm boundary and the assertions are on what they reported.
//
// The panel exists only on a build that exports that ABI -- 5.5.1_build3
// was the first -- so these tests skip themselves rather than fail on an
// older pinned runtime. A test that goes red when someone deliberately
// pins a stable build would be a test punishing the right decision.

async function openLab(page) {
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  await dismissLauncher(page);
  await page.evaluate(async () => {
    const { clearAutosave } = await import('./src/notebook/storage.js');
    await clearAutosave();
  });
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  await dismissLauncher(page);
}

const codeCell = (page) => page.locator('.cell[data-cell-type="code"]').first();

async function sandbox(page, source, budgetLabel) {
  const cell = codeCell(page);
  await cell.locator('[data-editor]').fill(source);
  await cell.locator('[data-action="sandbox"]').click();
  if (budgetLabel) await cell.locator('[data-sandbox-budget]').selectOption({ label: budgetLabel });
  await cell.locator('[data-action="sandbox-run"]').click();
  await expect(cell.locator('[data-outcome]')).toBeVisible({ timeout: 30_000 });
  return cell;
}

test.beforeEach(async ({ page }) => {
  await openLab(page);
  const has = await page.evaluate(() => window.lab.kernel.capabilities.instances === true);
  test.skip(!has, 'the pinned runtime exports no dv_ instance ABI (needs 5.5.1_build3+)');
});

test.describe('the sandbox', () => {
  test('is offered only when the running build has the ABI', async ({ page }) => {
    // Driven from a body attribute rather than decided when the cell was
    // built: cells render before the kernel has answered, and in the
    // worker path before the handshake has even happened.
    await expect(page.locator('body')).toHaveAttribute('data-instances', 'true');
    // Quiet toolbar: the full set shows on the cell you are pointing at.
    await codeCell(page).hover();
    await expect(codeCell(page).locator('[data-action="sandbox"]')).toBeVisible();
  });

  test('runs the cell in its own state and reports what it cost', async ({ page }) => {
    const cell = await sandbox(page, 'local t = 0\nfor i = 1, 100000 do t = t + i end\nprint(t)');
    await expect(cell.locator('[data-outcome]')).toHaveText('finished');
    await expect(cell.locator('[data-sandbox-output]')).toContainText('5000050000');
    // The instruction counter *is* the budget hook, which is why a budget
    // is always set -- without one this reads zero however much work ran.
    const stats = await cell.locator('.sandbox-stat').first().textContent();
    expect(Number(stats.replace(/[^0-9]/g, '').slice(0, 6))).toBeGreaterThan(0);
  });

  test('shares nothing with the notebook', async ({ page }) => {
    // The whole distinction. A cell keeps its globals; an instance is a
    // fresh state that `dv_free` takes away again.
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('sandbox_marker = "from the notebook"');
    await cell.locator('[data-editor]').press('Control+Enter');
    await expect(cell).toHaveAttribute('data-busy', 'false');

    await sandbox(page, 'print(tostring(sandbox_marker))');
    await expect(cell.locator('[data-sandbox-output]')).toHaveText('nil\n');
  });

  test('a runaway loop is stopped by the budget', async ({ page }) => {
    // The reason this tier exists. `run_lua` cannot be interrupted and a
    // cell that loops forever costs a worker; an instance that loops
    // forever costs 200,000 instructions and reports why it stopped.
    const cell = await sandbox(page, 'while true do end', '200 thousand');
    await expect(cell.locator('[data-outcome]')).toHaveText('over budget');
    await expect(cell.locator('[data-sandbox-error]')).toContainText('instruction budget');
    await expect(cell.locator('.sandbox-stat').first()).toContainText('200,000');
  });

  test('a program that parks says what it is waiting for', async ({ page }) => {
    const cell = await sandbox(page,
      'local q = queue.declare("work", { capacity = 4 })\nprint("parking")\nqueue.wait({ q })');
    await expect(cell.locator('[data-outcome]')).toHaveText('parked, waiting');
    // And says plainly that nothing here will ever answer it: there is no
    // host loop, because the swarm layer is not in the artifact.
    await expect(cell.locator('[data-sandbox-parked]')).toContainText('work');
    await expect(cell.locator('[data-sandbox-parked]')).toContainText('host loop');
  });

  test('queues are reported, including what the program pushed', async ({ page }) => {
    const cell = await sandbox(page,
      'local q = queue.declare("work", { capacity = 8 })\nqueue.push(q, { hello = "world" })\nprint("pushed")');
    // `inbox` and `outbox` exist in every instance without being declared;
    // `work` is the program's own.
    await expect(cell.locator('[data-queue="inbox"]')).toBeVisible();
    await expect(cell.locator('[data-queue="work"]')).toContainText('1 / 8');
  });

  test('a compile error is reported as one, not as a failure to run', async ({ page }) => {
    // It arrives from `dv_load` rather than `dv_run`, which is the whole
    // reason the panel can tell the two apart.
    const cell = await sandbox(page, 'this is not lua');
    await expect(cell.locator('[data-outcome]')).toHaveText('did not compile');
    await expect(cell.locator('[data-sandbox-error]')).toContainText('syntax error');
  });

  test('a runtime error keeps the runtime’s own words', async ({ page }) => {
    const cell = await sandbox(page, 'error("on purpose")');
    await expect(cell.locator('[data-outcome]')).toHaveText('error');
    await expect(cell.locator('[data-sandbox-error]')).toContainText('on purpose');
    // Named `sandbox`, which is how a traceback tells you which run it was.
    await expect(cell.locator('[data-sandbox-error]')).toContainText('sandbox');
  });

  test('opening the panel runs nothing until asked', async ({ page }) => {
    // Unlike the bytecode panel, which compiles on open. Compiling is free
    // and running is not.
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('print("should not run")');
    await cell.locator('[data-action="sandbox"]').click();
    await expect(cell.locator('.sandbox-controls')).toBeVisible();
    await expect(cell.locator('[data-outcome]')).toHaveCount(0);
  });

  test('the notebook kernel is untouched by a sandboxed runaway', async ({ page }) => {
    await sandbox(page, 'while true do end', '200 thousand');
    // Still alive, still holding its own state: the budget stopped an
    // instance, not the kernel.
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('return 6 * 7');
    await cell.locator('[data-editor]').press('Control+Enter');
    await expect(cell).toHaveAttribute('data-busy', 'false');
    await expect(cell.locator('.output-execute_result pre')).toHaveText('42');
  });
});
