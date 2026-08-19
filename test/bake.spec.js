import { test, expect } from '@playwright/test';
import { viaControl, dismissLauncher } from './chrome.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

// The single-file build, opened the way its whole reason for existing
// says it will be: from the filesystem, with no server anywhere.
//
// Stage 0 measured that a page opened over file:// renders but cannot fetch
// its kernel. This is the answer to that, so the test has to actually use
// file:// -- running it over http would prove nothing.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'dist/diluvium-lab.html');

test.beforeAll(() => {
  execFileSync(process.execPath, ['scripts/bake.mjs'], { cwd: ROOT, stdio: 'pipe' });
});

// A test that opens the baked page needs longer than Playwright's default
// 30s, and saying so is not optional: the wait below asks for 60s, and
// without this the *test* timeout ends the run at 30 while the selector is
// still within its allowance -- an intent the file states and cannot
// reach. It surfaces only where the page is slow to come up, which is a
// CI runner rather than a developer's machine: 2.5 MB of single-file HTML,
// a third of it base64 kernel, parsed from file:// with no server to
// stream it. Nothing here is waiting on the network, so a generous
// ceiling costs nothing when the page is quick.
const BAKED_BOOT_MS = 90_000;

async function openBaked(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  const requests = [];
  page.on('request', (req) => requests.push(req.url()));

  await page.goto(pathToFileURL(OUT).href);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
  await dismissLauncher(page);
  return { problems, requests };
}

test('the baked file is one self-contained page', async () => {
  const { size } = await stat(OUT);
  expect(size).toBeGreaterThan(1_000_000);   // the kernel really is in there
  expect(size).toBeLessThan(4_000_000);
});

test('it boots from file:// with the kernel inlined', async ({ page }) => {
  test.setTimeout(BAKED_BOOT_MS);
  const { problems, requests } = await openBaked(page);

  await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
  expect(problems).toEqual([]);

  // The point of the exercise: nothing was fetched. One request, for the
  // document itself.
  expect(requests.filter((url) => !url.startsWith('file://'))).toEqual([]);
  expect(requests).toHaveLength(1);
});

test('cells run, echo and error correctly with no server', async ({ page }) => {
  test.setTimeout(BAKED_BOOT_MS);
  await openBaked(page);

  // The first cell of the sample notebook is markdown, whose editor is
  // hidden until it is being edited -- take the first code cell.
  const cell = page.locator('.cell[data-cell-type="code"]').first();
  await cell.locator('[data-editor]').fill('print("baked and running")');
  await cell.locator('[data-editor]').press('Control+Enter');
  await expect(cell.locator('[data-outputs] .output')).toContainText('baked and running');

  await cell.locator('[data-editor]').fill('2 ^ 10');
  await cell.locator('[data-editor]').press('Control+Enter');
  await expect(cell.locator('[data-output-type="execute_result"]')).toContainText('1024');

  // The Stage 0 question, in the artifact people will actually open.
  await cell.locator('[data-editor]').fill('print(pcall(function() error("caught") end))');
  await cell.locator('[data-editor]').press('Control+Enter');
  await expect(cell.locator('[data-outputs]')).toContainText('caught');
});

test('the console works in the baked file too', async ({ page }) => {
  test.setTimeout(BAKED_BOOT_MS);
  await openBaked(page);
  await page.locator('[data-console-input]').fill('("baked"):upper()');
  await page.locator('[data-console-input]').press('Enter');
  await expect(page.locator('[data-console-result]')).toHaveText('BAKED');
});

test('restart works without a network round trip', async ({ page }) => {
  test.setTimeout(BAKED_BOOT_MS);
  await openBaked(page);
  // The first cell of the sample notebook is markdown, whose editor is
  // hidden until it is being edited -- take the first code cell.
  const cell = page.locator('.cell[data-cell-type="code"]').first();
  await cell.locator('[data-editor]').fill('marker = "before restart"');
  await cell.locator('[data-editor]').press('Control+Enter');

  await viaControl(page, 'restart');
  await expect(page.locator('[data-kernel-status]')).toHaveText('idle');

  await cell.locator('[data-editor]').fill('print(tostring(marker))');
  await cell.locator('[data-editor]').press('Control+Enter');
  await expect(cell.locator('[data-outputs]')).toContainText('nil');
});

test('it runs in the page, and says so rather than offering a stop that does nothing', async ({ page }) => {
  test.setTimeout(BAKED_BOOT_MS);
  await openBaked(page);

  // A file:// page has an opaque origin and browsers refuse to start a
  // worker from one, so the baked build cannot run the kernel off-thread
  // and cannot stop a runaway cell. That is an accepted trade -- the same
  // one that already costs it runtime switching, for the same reason --
  // but it has to be visible. A Stop button that silently does nothing
  // would be worse than no Stop button.
  const info = await page.evaluate(() => ({
    offThread: window.lab.kernel.offThread,
    interrupt: window.lab.kernel.capabilities.interrupt,
    label: window.lab.kernel.label,
    reason: window.lab.kernel.fallbackReason ?? null,
  }));

  expect(info.offThread).toBe(false);
  expect(info.interrupt).toBe(false);
  expect(info.label).toContain('in page');
  expect(info.reason).toBeTruthy();

  // Disabled, not merely inert.
  await expect(page.locator('[data-toolbar="stop"]')).toBeDisabled();

  // And it still runs code, which is the part that must not regress.
  // No dynamic import here: there is no ./src/ in a single file.
  const out = await page.evaluate(async () => {
    const messages = [];
    const reply = await window.lab.kernel.execute('return 6 * 7', (m) => messages.push(m));
    const result = messages.find((m) => m.msg_type === 'execute_result');
    return { status: reply.content.status, result: result?.content.data['text/plain'] ?? null };
  });
  expect(out.status).toBe('ok');
  expect(out.result).toBe('42');
});
