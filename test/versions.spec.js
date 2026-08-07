import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Stage 2: version switching.
//
// The mirror is stubbed with page.route, and that is a deliberate line
// rather than a shortcut. What is stubbed is the *transport*: the bytes
// served are the real vendored kernel, the checksums are really computed,
// the browser really verifies them, really probes the module and really
// runs Lua in it. Nothing about the kernel is mocked.
//
// It has to be stubbed, for three reasons. The Lab must make no request at
// load, so tests that hit a real host would be testing the wrong thing;
// unauthenticated GitHub allows 60 requests an hour, which a test suite
// eats in a minute; and the mirror does not exist yet.

const MIRROR = 'https://diluvium.aloecraft.org/releases/';

const kernelBytes = await readFile(new URL('../vendor/libdiluvium_wasi.wasm', import.meta.url));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** A minimal, perfectly valid wasm module that exports nothing at all. */
const EMPTY_MODULE = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function sumsFor(buf, name = 'libdiluvium_wasi.wasm') {
  return `${sha256(buf)}  ${name}\n${sha256(Buffer.from('other'))}  diluvium_wasi.wasm\n`;
}

/**
 * Stand up a mirror. `overrides` can replace any response by path suffix.
 * Returns a log of every mirror request, so tests can prove the page did
 * not fetch at load, and did not fetch twice when it had a cache.
 */
async function stubMirror(page, {
  releases = [
    { tag: 'v5.4.7_release', version: '5.4.7', published: '2026-08-05T22:53:34Z' },
    { tag: 'v5.5.0', version: '5.5.0', published: '2026-08-06T10:00:00Z' },
  ],
  bodies = {},
  fail = null,
} = {}) {
  const requests = [];
  await page.route(`${MIRROR}**`, async (route) => {
    const url = route.request().url();
    requests.push(url.slice(MIRROR.length));
    if (fail) return route.abort('failed');

    const path = url.slice(MIRROR.length);
    if (path in bodies) {
      const body = bodies[path];
      return route.fulfill({ status: 200, body, contentType: 'application/octet-stream' });
    }
    if (path === 'index.json') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ schema: 1, releases }) });
    }
    if (path.endsWith('/SHA256SUMS.txt')) {
      return route.fulfill({ status: 200, contentType: 'text/plain', body: sumsFor(kernelBytes) });
    }
    if (path.endsWith('/libdiluvium_wasi.wasm')) {
      return route.fulfill({ status: 200, contentType: 'application/wasm', body: kernelBytes });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });
  return requests;
}

async function openLab(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  return problems;
}

const select = (page) => page.locator('[data-version-select]');
const checkButton = (page) => page.locator('[data-toolbar="check-versions"]');
const codeCell = (page) => page.locator('.cell[data-cell-type="code"]').first();

async function runInCell(page, source) {
  const cell = codeCell(page);
  await cell.locator('[data-editor]').fill(source);
  await cell.locator('[data-editor]').press('Control+Enter');
  await expect(cell).toHaveAttribute('data-busy', 'false');
  return cell;
}

async function checkVersions(page) {
  await checkButton(page).click();
  await expect(page.locator('body')).toHaveAttribute('data-checking', 'false');
}

// ---------------------------------------------------------------------

test.describe('no request at load', () => {
  test('the page fetches nothing from the mirror until asked', async ({ page }) => {
    const requests = await stubMirror(page);
    await openLab(page);

    // "No external requests at load" is a hard constraint. The bundled
    // runtime comes from our own origin; the mirror is untouched.
    expect(requests).toEqual([]);
    await expect(select(page)).toHaveAttribute('data-count', '1');
    await expect(select(page).locator('option')).toHaveText([/bundled/]);
  });

  test('checking is what triggers the one request', async ({ page }) => {
    const requests = await stubMirror(page);
    await openLab(page);
    await checkVersions(page);

    expect(requests).toEqual(['index.json']);
    // The mirror lists v5.4.7_release too, but that is the bundled build --
    // showing it twice would just invite "why are there two 5.4.7s".
    await expect(select(page).locator('option')).toHaveText([/5\.4\.7 \(bundled\)/, '5.5.0']);
    await expect(select(page)).toHaveAttribute('data-count', '2');
  });

  test('a mirror build that is not the bundled one is offered', async ({ page }) => {
    await stubMirror(page, {
      releases: [
        { tag: 'v5.4.7_release', version: '5.4.7' },
        { tag: 'v5.5.0', version: '5.5.0' },
        { tag: 'v5.5.1_rc1', version: '5.5.1-rc1' },
      ],
    });
    await openLab(page);
    await checkVersions(page);
    await expect(select(page).locator('option')).toHaveText([/bundled/, '5.5.0', '5.5.1-rc1']);
  });
});

// ---------------------------------------------------------------------

test.describe('switching', () => {
  test('selecting a version downloads it and runs cells on it', async ({ page }) => {
    const requests = await stubMirror(page);
    const problems = await openLab(page);
    await checkVersions(page);

    await runInCell(page, 'marker = "on the bundled runtime"');
    await select(page).selectOption('v5.5.0');
    await expect(page.locator('body')).toHaveAttribute('data-switching', 'false');
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');

    // It downloaded and verified before swapping.
    expect(requests).toContain('v5.5.0/SHA256SUMS.txt');
    expect(requests).toContain('v5.5.0/libdiluvium_wasi.wasm');

    // A different kernel: the old globals are gone, and the new one works.
    const cell = await runInCell(page, 'print(tostring(marker))');
    await expect(cell.locator('[data-outputs]')).toContainText('nil');
    const again = await runInCell(page, 'print("running on the new build")');
    await expect(again.locator('[data-outputs]')).toContainText('running on the new build');
    expect(problems).toEqual([]);
  });

  test('switching resets the execution counters', async ({ page }) => {
    await stubMirror(page);
    await openLab(page);
    await checkVersions(page);

    const cell = await runInCell(page, 'print(1)');
    await expect(cell.locator('[data-prompt]')).toHaveText('In [1]:');

    await select(page).selectOption('v5.5.0');
    await expect(page.locator('body')).toHaveAttribute('data-switching', 'false');
    await expect(codeCell(page).locator('[data-prompt]')).toHaveText('In [ ]:');
  });

  test('the console says which runtime is running', async ({ page }) => {
    await stubMirror(page);
    await openLab(page);
    await checkVersions(page);
    await select(page).selectOption('v5.5.0');
    await expect(page.locator('[data-console-log]')).toContainText('Switched to 5.5.0');
    await expect(page.locator('[data-kernel-backend]')).toContainText('5.5.0');
  });

  test('switching back to the bundled runtime works', async ({ page }) => {
    await stubMirror(page);
    await openLab(page);
    await checkVersions(page);

    await select(page).selectOption('v5.5.0');
    await expect(page.locator('body')).toHaveAttribute('data-switching', 'false');
    await select(page).selectOption('pinned');
    await expect(page.locator('body')).toHaveAttribute('data-switching', 'false');

    const cell = await runInCell(page, 'print("back on the bundled build")');
    await expect(cell.locator('[data-outputs]')).toContainText('back on the bundled build');
  });
});

// ---------------------------------------------------------------------

test.describe('the cache', () => {
  test('a second switch to the same version does not download again', async ({ page }) => {
    const requests = await stubMirror(page);
    await openLab(page);
    await checkVersions(page);

    await select(page).selectOption('v5.5.0');
    await expect(page.locator('body')).toHaveAttribute('data-switching', 'false');
    const afterFirst = requests.filter((r) => r.endsWith('libdiluvium_wasi.wasm')).length;
    expect(afterFirst).toBe(1);

    await select(page).selectOption('pinned');
    await expect(page.locator('body')).toHaveAttribute('data-switching', 'false');
    await select(page).selectOption('v5.5.0');
    await expect(page.locator('[data-console-log]')).toContainText('from cache');

    // Still one: a megabyte moved once, not once per switch.
    expect(requests.filter((r) => r.endsWith('libdiluvium_wasi.wasm')).length).toBe(1);
  });
});

// ---------------------------------------------------------------------
// The Lab downloads a binary and then executes it. These are the tests
// that matter most.
// ---------------------------------------------------------------------

test.describe('integrity', () => {
  test('a runtime whose bytes do not match its checksum is refused', async ({ page }) => {
    const tampered = Buffer.from(kernelBytes);
    tampered[tampered.length - 1] ^= 0xff;     // one flipped bit, at the end
    await stubMirror(page, { bodies: { 'v5.5.0/libdiluvium_wasi.wasm': tampered } });

    await openLab(page);
    await checkVersions(page);
    await runInCell(page, 'survivor = "still here"');

    await select(page).selectOption('v5.5.0');
    await expect(page.locator('[data-toast]')).toContainText('checksum');

    // The running kernel is untouched: switching versions must never be
    // how a session is lost.
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
    await expect(select(page)).toHaveValue('pinned');
    const cell = await runInCell(page, 'print(survivor)');
    await expect(cell.locator('[data-outputs]')).toContainText('still here');
  });

  test('a release with no SHA256SUMS.txt is refused rather than trusted', async ({ page }) => {
    await stubMirror(page, { bodies: { 'v5.5.0/SHA256SUMS.txt': 'nothing useful here\n' } });
    await openLab(page);
    await checkVersions(page);

    await select(page).selectOption('v5.5.0');
    await expect(page.locator('[data-toast]')).toContainText('SHA256SUMS.txt');
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
  });
});

// ---------------------------------------------------------------------

test.describe('the capability probe', () => {
  test('a build that is not a Diluvium kernel is rejected clearly', async ({ page }) => {
    // Valid wasm, correct checksum, exports nothing. Stands in for "too
    // old to drive": it must fail here, with a sentence, not later with
    // something strange about a null pointer.
    await stubMirror(page, {
      bodies: {
        'v5.5.0/libdiluvium_wasi.wasm': EMPTY_MODULE,
        'v5.5.0/SHA256SUMS.txt': sumsFor(EMPTY_MODULE),
      },
    });
    await openLab(page);
    await checkVersions(page);
    await runInCell(page, 'kept = "yes"');

    await select(page).selectOption('v5.5.0');
    const toast = page.locator('[data-toast]');
    await expect(toast).toContainText('not a build this Lab can run');
    await expect(toast).toContainText('run_lua');

    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
    const cell = await runInCell(page, 'print(kept)');
    await expect(cell.locator('[data-outputs]')).toContainText('yes');
  });

  test('bytes that are not wasm at all are rejected', async ({ page }) => {
    const junk = Buffer.from('this is not a wasm module, it is a sentence');
    await stubMirror(page, {
      bodies: { 'v5.5.0/libdiluvium_wasi.wasm': junk, 'v5.5.0/SHA256SUMS.txt': sumsFor(junk) },
    });
    await openLab(page);
    await checkVersions(page);

    await select(page).selectOption('v5.5.0');
    await expect(page.locator('[data-toast]')).toContainText('refused to compile');
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
  });
});

// ---------------------------------------------------------------------

test.describe('when the mirror is not there', () => {
  test('an unreachable mirror says so and leaves the Lab working', async ({ page }) => {
    await stubMirror(page, { fail: true });
    await openLab(page);
    await checkVersions(page);

    await expect(page.locator('[data-toast]')).toContainText('could not reach the runtime mirror');
    await expect(select(page)).toHaveAttribute('data-count', '1');

    const cell = await runInCell(page, 'print("the bundled runtime still runs")');
    await expect(cell.locator('[data-outputs]')).toContainText('the bundled runtime still runs');
  });

  test('a mirror serving the wrong shape is rejected', async ({ page }) => {
    await stubMirror(page, { bodies: { 'index.json': JSON.stringify({ hello: 'world' }) } });
    await openLab(page);
    await checkVersions(page);
    await expect(page.locator('[data-toast]')).toContainText('not in the expected shape');
  });

  test('an empty mirror says so plainly', async ({ page }) => {
    await stubMirror(page, { releases: [] });
    await openLab(page);
    await checkVersions(page);
    await expect(page.locator('[data-toast]')).toContainText('no other builds');
  });
});
