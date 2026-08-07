import { test, expect } from '@playwright/test';

// Stage 0's whole point is one question, so this file asks it directly and
// asserts on what the kernel actually printed -- never on the page's own
// verdict alone, which would only prove the page agrees with itself.
//
// This is also the harness every later stage reuses: load the real page,
// drive the real UI, no mocking of the kernel.

/** Load the spike and fail loudly on anything the browser complained about. */
async function openSpike(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });

  await page.goto('/spike.html');
  await page.waitForSelector('body[data-done="true"]', { timeout: 30_000 });
  return problems;
}

const probe = (page, id) => page.locator(`[data-probe="${id}"]`);
const output = (page, id) => page.locator(`[data-output="${id}"]`);

test('the browser accepts the exception-handling opcodes the kernel is built with', async ({ page }) => {
  await openSpike(page);
  await expect(page.locator('[data-env="eh"]')).toHaveText('supported');
});

test('the kernel boots and the WASI shim carries stdout', async ({ page }) => {
  await openSpike(page);

  // The import list is read off the binary, not assumed.
  await expect(page.locator('[data-env="imports"]')).toHaveText('45 × wasi_snapshot_preview1');
  await expect(page.locator('[data-env="boot"]')).toHaveText('__wasm_call_ctors() → init_lua()');

  await expect(probe(page, 'print')).toHaveAttribute('data-status', 'pass');
  await expect(output(page, 'print')).toHaveText('hello from diluvium');
});

// ---------------------------------------------------------------------
// The unknown. A happy path proves nothing here: the error must be caught.
// ---------------------------------------------------------------------

test('pcall catches an explicit error and control returns to Lua', async ({ page }) => {
  const problems = await openSpike(page);

  await expect(probe(page, 'pcall-catch')).toHaveAttribute('data-status', 'pass');

  // pcall returned false plus the message -- so longjmp unwound into the
  // protected call rather than trapping or escaping to the host.
  const text = await output(page, 'pcall-catch').innerText();
  expect(text.startsWith('false')).toBeTruthy();
  expect(text).toContain('caught');

  // status 0 means run_lua itself succeeded: the error never reached it.
  await expect(page.locator('[data-meta="pcall-catch"]')).toContainText('status 0');

  expect(problems).toEqual([]);
});

test('pcall catches a fault raised inside the VM, not just error()', async ({ page }) => {
  await openSpike(page);

  await expect(probe(page, 'pcall-runtime')).toHaveAttribute('data-status', 'pass');
  const text = await output(page, 'pcall-runtime').innerText();
  expect(text.startsWith('false')).toBeTruthy();
  expect(text).toContain('nil value');
});

test('a thousand caught errors in a row leave the unwinder intact', async ({ page }) => {
  await openSpike(page);

  await expect(probe(page, 'unwind-1000')).toHaveAttribute('data-status', 'pass');
  await expect(output(page, 'unwind-1000')).toHaveText('caught\t1000');
});

test('an uncaught error is reported without taking the kernel down', async ({ page }) => {
  await openSpike(page);

  await expect(probe(page, 'error-uncaught')).toHaveAttribute('data-status', 'pass');

  // run_lua reports failure as a non-zero status and prints the message to
  // stdout, not stderr. Stage 1 parses this host-side.
  await expect(page.locator('[data-meta="error-uncaught"]')).toContainText('status 1');
  const text = await output(page, 'error-uncaught').innerText();
  expect(text.startsWith('Error:')).toBeTruthy();
  expect(text).toContain('boom');
  await expect(page.locator('[data-stderr="error-uncaught"]')).toHaveCount(0);

  // ... and the kernel is still usable afterwards, with state intact.
  await expect(probe(page, 'alive')).toHaveAttribute('data-status', 'pass');
  await expect(output(page, 'alive')).toContainText('diluvium');
});

test('every probe passes and the verdict is GO', async ({ page }) => {
  const problems = await openSpike(page);

  await expect(page.locator('#verdict')).toHaveAttribute('data-state', 'go');
  await expect(page.locator('#verdict .label')).toHaveText('GO');

  // No probe may be left pending or failing -- including any added later.
  await expect(page.locator('.probe[data-status="fail"]')).toHaveCount(0);
  await expect(page.locator('.probe[data-status="pending"]')).toHaveCount(0);
  expect(await page.locator('.probe[data-status="pass"]').count()).toBeGreaterThanOrEqual(6);

  // The verdict is only meaningful if the decisive probes actually ran.
  expect(await page.locator('.probe[data-decisive="true"]').count()).toBe(3);
  await expect(page.locator('.probe[data-decisive="true"][data-status="pass"]')).toHaveCount(3);

  expect(problems).toEqual([]);
});
