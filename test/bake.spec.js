import { test, expect } from '@playwright/test';
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

async function openBaked(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  const requests = [];
  page.on('request', (req) => requests.push(req.url()));

  await page.goto(pathToFileURL(OUT).href);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60_000 });
  return { problems, requests };
}

test('the baked file is one self-contained page', async () => {
  const { size } = await stat(OUT);
  expect(size).toBeGreaterThan(1_000_000);   // the kernel really is in there
  expect(size).toBeLessThan(4_000_000);
});

test('it boots from file:// with the kernel inlined', async ({ page }) => {
  const { problems, requests } = await openBaked(page);

  await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
  expect(problems).toEqual([]);

  // The point of the exercise: nothing was fetched. One request, for the
  // document itself.
  expect(requests.filter((url) => !url.startsWith('file://'))).toEqual([]);
  expect(requests).toHaveLength(1);
});

test('cells run, echo and error correctly with no server', async ({ page }) => {
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
  await openBaked(page);
  await page.locator('[data-console-input]').fill('("baked"):upper()');
  await page.locator('[data-console-input]').press('Enter');
  await expect(page.locator('[data-console-result]')).toHaveText('BAKED');
});

test('restart works without a network round trip', async ({ page }) => {
  await openBaked(page);
  // The first cell of the sample notebook is markdown, whose editor is
  // hidden until it is being edited -- take the first code cell.
  const cell = page.locator('.cell[data-cell-type="code"]').first();
  await cell.locator('[data-editor]').fill('marker = "before restart"');
  await cell.locator('[data-editor]').press('Control+Enter');

  await page.locator('[data-toolbar="restart"]').click();
  await expect(page.locator('[data-kernel-status]')).toHaveText('idle');

  await cell.locator('[data-editor]').fill('print(tostring(marker))');
  await cell.locator('[data-editor]').press('Control+Enter');
  await expect(cell.locator('[data-outputs]')).toContainText('nil');
});
