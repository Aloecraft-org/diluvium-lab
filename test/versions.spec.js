import { test, expect } from '@playwright/test';
import { viaControl, dismissLauncher } from './chrome.js';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
// eats in a minute; and a suite that needs the network is a suite that
// fails for reasons that are not about the code.
//
// The mirror does now exist. Its published index is committed under
// fixtures/ and exercised at the bottom of this file, so the *shape* is
// checked against the real thing even though the transport is not.

// Imported rather than repeated: this const used to be a copy, and when
// the real mirror turned out to serve /release/ rather than /releases/,
// the copy is what failed instead of the code.
const { DEFAULT_MIRROR: MIRROR } = await import('../src/kernel/releases.js');

const kernelBytes = await readFile(new URL('../vendor/libdiluvium_wasi.wasm', import.meta.url));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** A minimal, perfectly valid wasm module that exports nothing at all. */
const EMPTY_MODULE = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function sumsFor(buf, name = 'libdiluvium_wasi.wasm') {
  return `${sha256(buf)}  ${name}\n${sha256(Buffer.from('other'))}  diluvium_wasi.wasm\n`;
}

/**
 * The kernel checksum a stubbed mirror is claiming for `tag` — read out of
 * whatever SHA256SUMS.txt the test declared, so the index agrees with it.
 * Falls back to the real vendored kernel, which is the default body.
 */
function declaredSum(bodies, tag) {
  const override = bodies[`${tag}/SHA256SUMS.txt`];
  const text = typeof override === 'string' ? override : null;
  const line = text && /^([0-9a-f]{64})\s+libdiluvium_wasi\.wasm\s*$/im.exec(text);
  return line ? line[1] : sha256(kernelBytes);
}

/** The release job's build manifest, in the shape vendor/BUILDINFO.txt has. */
function buildinfoFor(buf) {
  return [
    'Diluvium build manifest',
    '=======================',
    'version    : 5.5.0',
    'commit     : 0000000000000000000000000000000000000000',
    'built      : 2026-08-06T10:00:00Z',
    '',
    'Artifacts',
    '---------',
    sumsFor(buf).trimEnd(),
    '',
  ].join('\n');
}

/**
 * Stand up a mirror. `overrides` can replace any response by path suffix.
 * Returns a log of every mirror request, so tests can prove the page did
 * not fetch at load, and did not fetch twice when it had a cache.
 */
async function stubMirror(page, {
  // The shape the real mirror publishes: `name` rather than `version`,
  // `published_at` rather than `published`, and per-asset checksums.
  releases = [
    {
      tag: 'v5.4.7_release',
      name: 'Diluvium 5.4.7',
      published_at: '2026-08-05T22:53:58Z',
      prerelease: false,
      assets: [{ name: 'libdiluvium_wasi.wasm', size: kernelBytes.length, sha256: sha256(kernelBytes) }],
    },
    {
      tag: 'v5.5.0',
      name: 'Diluvium 5.5.0',
      published_at: '2026-08-06T10:00:00Z',
      prerelease: false,
      assets: [{ name: 'libdiluvium_wasi.wasm', size: kernelBytes.length, sha256: sha256(kernelBytes) }],
    },
  ],
  indexName = 'releases.json',
  // Whether the index carries per-asset checksums. A mirror that lists
  // releases without them is legal, and is the only way a release ends up
  // with no checksum anywhere.
  indexAssets = true,
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
      const override = bodies[path];
      // An override is a body, or `{ status, body }` when a test needs to
      // say "this file is not here" rather than "this file is wrong".
      const { status = 200, body } = (override && typeof override === 'object' && !Buffer.isBuffer(override))
        ? override : { body: override };
      return route.fulfill({ status, body, contentType: 'application/octet-stream' });
    }
    if (path === indexName) {
      // A real mirror's index and its SHA256SUMS.txt describe the same
      // bytes, and the Lab now refuses a mirror where they disagree. So
      // the stub derives the index's asset checksums from whatever
      // SHA256SUMS.txt this test declared, rather than letting the two
      // drift apart and testing a self-contradiction by accident.
      const consistent = releases.map((r) => ({
        ...r,
        assets: indexAssets ? [{
          name: 'libdiluvium_wasi.wasm',
          size: kernelBytes.length,
          sha256: declaredSum(bodies, r.tag),
        }] : [],
      }));
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          repo: 'Aloecraft-org/diluvium',
          latest: releases[0]?.tag ?? null,
          generated_at: '2026-08-08T02:55:23Z',
          releases: consistent,
        }) });
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
  await dismissLauncher(page);
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

    expect(requests).toEqual(['releases.json']);
    // Both mirror entries are offered: neither is the bundled build,
    // which is 5.5.1_build1. The dedup case has its own test below.
    // Newest first now that the registry sorts rather than trusting the
            // order the mirror happened to write.
    await expect(select(page).locator('option')).toHaveText([/\(bundled/, '5.5.0', '5.4.7']);
    await expect(select(page)).toHaveAttribute('data-count', '3');
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
    await expect(select(page).locator('option')).toHaveText([/bundled/, '5.5.1-rc1', '5.5.0', '5.4.7']);
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

  test('switching marks the old runs stale rather than blanking them', async ({ page }) => {
    await stubMirror(page);
    await openLab(page);
    await checkVersions(page);

    const cell = await runInCell(page, 'print(1)');
    await expect(cell.locator('[data-prompt]')).toHaveText('In [1]:');

    await select(page).selectOption('v5.5.0');
    await expect(page.locator('body')).toHaveAttribute('data-switching', 'false');
    // The counts survive the switch, marked stale: what ran on the old
    // runtime, and in what order, is history worth keeping visible.
    await expect(codeCell(page).locator('[data-prompt]')).toHaveText('In [1]:');
    await expect(codeCell(page)).toHaveAttribute('data-run-state', 'stale');
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

  test('a release with no checksum anywhere is refused rather than trusted', async ({ page }) => {
    // Nothing publishes one: the index carries no assets, SHA256SUMS.txt
    // has no line for the kernel, BUILDINFO.txt is absent.
    await stubMirror(page, {
      indexAssets: false,
      bodies: { 'v5.5.0/SHA256SUMS.txt': 'nothing useful here\n' },
    });
    await openLab(page);
    await checkVersions(page);

    await select(page).selectOption('v5.5.0');
    await expect(page.locator('[data-toast]')).toContainText('SHA256SUMS.txt');
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
  });

  test('a mirror that contradicts itself is refused, not resolved', async ({ page }) => {
    // The index and SHA256SUMS.txt describe different bytes, which is what
    // a half-updated mirror looks like. Picking one would mean picking
    // which binary to execute on no evidence.
    await stubMirror(page, {
      bodies: { 'v5.5.0/SHA256SUMS.txt': sumsFor(EMPTY_MODULE) },
      // declaredSum follows SHA256SUMS.txt, so force the index to disagree.
      releases: [
        { tag: 'v5.5.0', name: 'Diluvium 5.5.0', published_at: '2026-08-06T10:00:00Z' },
      ],
      indexAssets: true,
    });
    await page.route(`${MIRROR}releases.json`, async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        releases: [{
          tag: 'v5.5.0',
          name: 'Diluvium 5.5.0',
          assets: [{ name: 'libdiluvium_wasi.wasm', sha256: sha256(kernelBytes) }],
        }],
      }),
    }));
    await openLab(page);
    await checkVersions(page);

    await select(page).selectOption('v5.5.0');
    const toast = page.locator('[data-toast]');
    await expect(toast).toContainText('disagree');
    await expect(toast).toContainText('stale or damaged');
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
  });

  test('BUILDINFO.txt can carry the checksum when SHA256SUMS.txt is absent', async ({ page }) => {
    // The release job publishes both, and a mirror may carry only the
    // build manifest. Its Artifacts section is sha256sum output with a
    // prose header, so the same parser reads it.
    const requests = await stubMirror(page, {
      bodies: {
        'v5.5.0/SHA256SUMS.txt': { status: 404, body: 'not found' },
        'v5.5.0/BUILDINFO.txt': buildinfoFor(kernelBytes),
      },
    });
    await openLab(page);
    await checkVersions(page);

    await select(page).selectOption('v5.5.0');
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle', { timeout: 30_000 });
    await expect(select(page)).toHaveValue('v5.5.0');
    expect(requests).toContain('v5.5.0/BUILDINFO.txt');

    // It really ran: the fallback path is not a shortcut past verification.
    const cell = await runInCell(page, 'return 6 * 7');
    await expect(cell.locator('[data-outputs]')).toContainText('42');
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
    await stubMirror(page, { bodies: { 'releases.json': JSON.stringify({ hello: 'world' }) } });
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

// ---------------------------------------------------------------------

test.describe('the real mirror index', () => {
  const REAL = JSON.parse(
    readFileSync(new URL('./fixtures/releases-mirror.json', import.meta.url), 'utf8'));

  test('parses into the versions the dropdown should show', async ({ page }) => {
    // The Lab could not reach diluvium.aloecraft.org from the session this
    // was written in -- the environment's egress policy blocks it -- so the
    // published index is committed and served locally instead. That is
    // weaker than hitting the host, and it is exactly strong enough for
    // the thing most likely to be wrong: the shape.
    await page.route(`${MIRROR}releases.json`, async (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(REAL),
    }));
    await openLab(page);

    const listed = await page.evaluate(async (base) => {
      const { MirrorSource } = await import('./src/kernel/releases.js');
      return new MirrorSource(base).list();
    }, MIRROR);

    expect(listed.map((r) => [r.tag, r.version])).toEqual([
      ['v5.5.1_build1', '5.5.1_build1'],
      ['v5.4.7_release', '5.4.7'],
    ]);
    expect(listed[0].published).toBe('2026-08-07T18:14:33Z');
    expect(listed[0].prerelease).toBe(false);
    expect(listed[0].assets['libdiluvium_wasi.wasm'])
      .toBe('15e5a20ca98e3fbfa600ff03bf60bfd5bd9b03d2d793810f27cbe645b6912426');
  });

  test('offers everything it lists, and the published one is behind', async ({ page }) => {
    await page.route(`${MIRROR}releases.json`, async (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(REAL),
    }));
    await openLab(page);
    await checkVersions(page);

    // This capture was taken 2026-08-08 at 04:01Z and `v5.5.1_build2` was
    // published at 09:44Z the same day -- so the *live* index predates the
    // build its own changelog marks `latest` and `mirror: true`. Nothing
    // in the Lab can fix that; regenerating the mirror can. Asserted as it
    // is rather than as it should be, so this says something true.
    await expect(select(page).locator('option'))
      .toHaveText([/\(bundled/, '5.5.1_build1', '5.4.7']);
    expect(REAL.releases.map((r) => r.tag)).not.toContain('v5.5.1_build2');

    // The filter that stops the pinned build being listed twice is
    // exercised where it can be: against the index build-mirror.sh writes,
    // at the bottom of this file, which does carry it.
    expect(REAL.releases.find((r) => r.tag === 'v5.5.1_build1')
      .assets.find((a) => a.name === 'libdiluvium_wasi.wasm').sha256)
      .not.toBe(sha256(kernelBytes));
  });
});

// ---------------------------------------------------------------------

test.describe('version ordering across the format change', () => {
  // Diluvium's tags are moving from `v5.5.1_build1` to semver, and both
  // will exist on the mirror for as long as the old tags do. The Lab is
  // deliberately the tolerant end: it accepts the new shape *before*
  // anything emits one, so the day the release job changes, nothing here
  // changes with it and no published tag has to be renamed -- renaming one
  // would break its checksums, the mirror, vendor/PINNED_TAG and the
  // committed bytecode fixtures at once.
  const ORDERINGS = [
    ['5.5.1_build1', '5.4.7_release', 'a newer core wins'],
    ['5.5.1_build2', '5.5.1_build1', 'later builds of one version'],
    ['5.5.1_build10', '5.5.1_build2', 'build numbers compare as numbers, not strings'],
    ['5.5.1', '5.5.1_build9', 'the final release outranks its builds'],
    ['5.5.1-rc.2', '5.5.1-rc.1', 'semver pre-releases'],
    ['5.5.1', '5.5.1-rc.9', 'the final release outranks its pre-releases'],
    ['5.5.1-rc.10', '5.5.1-rc.9', 'semver numeric identifiers too'],
    ['5.5.1-build.2', '5.5.1_build1', 'the new shape against the old'],
    ['5.10.0', '5.9.0', 'ten is after nine'],
  ];

  test('the comparator puts every pair the right way round', async ({ page }) => {
    await openLab(page);
    const wrong = await page.evaluate(async (pairs) => {
      const { compareVersions } = await import('./src/kernel/releases.js');
      return pairs.filter(([bigger, smaller]) => !(compareVersions(bigger, smaller) > 0))
        .map(([bigger, smaller, why]) => `${bigger} should beat ${smaller} (${why})`);
    }, ORDERINGS);
    expect(wrong).toEqual([]);
  });

  test('`_release` means final, not a pre-release of itself', async ({ page }) => {
    await openLab(page);
    const equal = await page.evaluate(async () => {
      const { compareVersions } = await import('./src/kernel/releases.js');
      return compareVersions('5.4.7_release', '5.4.7') === 0
        && compareVersions('v5.4.7_release', '5.4.7') === 0;
    });
    expect(equal).toBe(true);
  });

  test('build metadata is carried but ignored for ordering', async ({ page }) => {
    await openLab(page);
    // `1.4.0+lua.5.5.1` is the shape that would let Diluvium have its own
    // version while still saying which Lua it tracks. Semver ignores
    // everything after `+`, which is what makes it safe to put facts there.
    const ignored = await page.evaluate(async () => {
      const { compareVersions } = await import('./src/kernel/releases.js');
      return compareVersions('1.4.0+lua.5.5.1', '1.4.0+lua.5.4.7') === 0;
    });
    expect(ignored).toBe(true);
  });

  test('the dropdown is newest first, whatever order the mirror wrote', async ({ page }) => {
    await stubMirror(page, {
      // Deliberately shuffled, and mixing both tag shapes.
      //
      // The `_buildN` pair is on 5.5.2 rather than 5.5.1 so that neither
      // can ever be the *pinned* build: `entries()` filters the mirror's
      // copy of whatever is bundled, and this test is about ordering, not
      // about that filter. When 5.5.1_build2 became the pin, it vanished
      // from this list and the failure looked like a sorting bug.
      // build10 against build2 is the point -- lexically build10 sorts
      // first, numerically it is later -- and it survives the move.
      releases: [
        { tag: 'v5.5.0', name: 'Diluvium 5.5.0' },
        { tag: 'v5.5.2_build10', name: 'Diluvium 5.5.2_build10' },
        { tag: 'v5.4.7_release', name: 'Diluvium 5.4.7' },
        { tag: 'v5.5.1-rc.1', name: 'Diluvium 5.5.1-rc.1' },
        { tag: 'v5.5.2_build2', name: 'Diluvium 5.5.2_build2' },
      ],
    });
    await openLab(page);
    await checkVersions(page);

    await expect(select(page).locator('option')).toHaveText([
      /\(bundled/,
      '5.5.2_build10', '5.5.2_build2', '5.5.1-rc.1', '5.5.0', '5.4.7',
    ]);
  });
});

test.describe('the index scripts/build-mirror.sh writes', () => {
  const BUILT = JSON.parse(
    readFileSync(new URL('./fixtures/releases-built.json', import.meta.url), 'utf8'));

  test('is read the same way as the published one', async ({ page }) => {
    // Two things write a releases.json the Lab has to read: the publishing
    // job on diluvium.aloecraft.org, and this repository's own script. The
    // fixture above pins the first; this pins the second, verbatim from a
    // real run.
    //
    // Worth pinning because the script drifted once already and the drift
    // was invisible: it carried a hardcoded tag list, and went on reporting
    // "wrote releases.json with 2 release(s)" long after there were four.
    await page.route(`${MIRROR}releases.json`, async (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(BUILT),
    }));
    await openLab(page);

    const listed = await page.evaluate(async (base) => {
      const { MirrorSource } = await import('./src/kernel/releases.js');
      return new MirrorSource(base).list();
    }, MIRROR);

    // `list()` preserves the index's order; the dropdown is what sorts. So
    // the script may write ascending while the publishing job writes
    // newest-first, and neither has to know about the other.
    // The set is `mirror_tags` from the Diluvium repository's own
    // changelog.json, which is where that decision is published -- not
    // every tag that happens to publish a kernel. v5.5.1_build3 does
    // publish one and is deliberately absent, because its release notes
    // say the mirror does not carry it.
    expect(listed.map((r) => [r.tag, r.version])).toEqual([
      ['v5.5.1_build2', '5.5.1_build2'],
      ['v5.5.1_build1', '5.5.1_build1'],
      ['v5.4.7_release', '5.4.7'],
    ]);
    expect(listed.map((r) => r.tag)).not.toContain('v5.5.1_build3');
    // The script emits `version` outright, so the dropdown never has to
    // fall back to parsing the name or guessing from the tag.
    expect(BUILT.releases.every((r) => typeof r.version === 'string')).toBe(true);
    // And a per-asset checksum, which is what the Lab cross-checks against
    // SHA256SUMS.txt. An index without one cannot disagree with itself,
    // and a stale mirror then goes unnoticed.
    expect(listed[0].assets['libdiluvium_wasi.wasm']).toMatch(/^[0-9a-f]{64}$/);

    // And what the reader ends up with. The bundled build heads the list
    // -- it is the one that works with no network -- and the mirror's own
    // copy of it is filtered out rather than listed twice.
    await checkVersions(page);
    await expect(select(page).locator('option'))
      .toHaveText([/\(bundled/, /5\.5\.1_build2/, /5\.5\.1_build1/, /5\.4\.7/]);
  });
});

test.describe('the swarm follows the runtime', () => {
  test('a switched runtime carries its own swarm module, checksummed', async ({ page }) => {
    // Pairing one build's swarm layer with another build's kernel would
    // put two different Diluviums in one page and call the pair a runtime.
    // So the swarm artifact is fetched from the *same tag*, verified the
    // same way, and a tag that publishes none simply has no swarm.
    const swarmBytes = await readFile(new URL('../vendor/diluvium_swarm_wasi.wasm', import.meta.url));
    const requests = await stubMirror(page, {
      bodies: {
        'v5.5.0/SHA256SUMS.txt':
          `${sha256(kernelBytes)}  libdiluvium_wasi.wasm\n`
          + `${sha256(swarmBytes)}  diluvium_swarm_wasi.wasm\n`,
        'v5.5.0/diluvium_swarm_wasi.wasm': swarmBytes,
        'v5.5.0/libdiluvium_wasi.wasm': kernelBytes,
      },
    });
    await openLab(page);
    await checkVersions(page);
    await select(page).selectOption('v5.5.0');
    await expect(page.locator('body')).toHaveAttribute('data-switching', 'false');
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');

    // It really went and got it, from that tag's directory.
    expect(requests.some((r) => r === 'v5.5.0/diluvium_swarm_wasi.wasm')).toBe(true);

    // And the swarm works on the switched-to runtime, which is the claim
    // that matters -- the panel being present is not the same as it
    // running anything.
    await page.locator('[data-tool="swarm"]').click();
    await page.locator('[data-swarm="swarm-start"]').click();
    await page.locator('[data-swarm="swarm-run"]').click();
    await expect(page.locator('[data-swarm-roster] tr[data-instance]'))
      .toHaveCount(4, { timeout: 20_000 });
  });

  test('a runtime that publishes no swarm module says so, and still runs cells', async ({ page }) => {
    // Every release before v5.5.1_build5 is this case. It must not stop
    // the kernel loading, and the panel must say why rather than sit
    // there empty.
    await stubMirror(page);          // no swarm artifact in any release
    await openLab(page);
    await checkVersions(page);
    await select(page).selectOption('v5.5.0');
    await expect(page.locator('body')).toHaveAttribute('data-switching', 'false');
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');

    const cell = await runInCell(page, 'print("cells still run")');
    await expect(cell).toContainText('cells still run');

    // And the panel says why rather than offering a Start that could not
    // work. Disabled-not-inert is the house rule; absent-and-explained is
    // the same rule for a control that has nothing to act on.
    await page.locator('[data-tool="swarm"]').click();
    await expect(page.locator('[data-tool-panel-body]'))
      .toContainText('cannot host a swarm');
    await expect(page.locator('[data-tool-panel-body]')).toContainText('v5.5.1_build5');
    await expect(page.locator('[data-swarm="swarm-start"]')).toHaveCount(0);
  });
});

test.describe('a prerelease says so', () => {
  test('a prerelease on the mirror is labelled in the dropdown', async ({ page }) => {
    // The index carried this flag and `entries()` dropped it, so a
    // prerelease sat in the list looking exactly like a release. Upstream
    // treats it as load-bearing: a build can be marked not-stable for
    // having a *narrower supported configuration* rather than for being
    // unfinished, which is precisely the thing a chooser cannot infer.
    await stubMirror(page, {
      releases: [
        { tag: 'v5.9.9_build1', name: 'Diluvium 5.9.9_build1', prerelease: true },
        { tag: 'v5.9.8_build1', name: 'Diluvium 5.9.8_build1', prerelease: false },
      ],
    });
    await openLab(page);
    await checkVersions(page);

    await expect(select(page).locator('option')).toHaveText([
      /\(bundled/, '5.9.9_build1 (prerelease)', '5.9.8_build1',
    ]);
  });

  test('and so does the bundled build, when it is one', async ({ page }) => {
    await openLab(page);
    // Read from vendor/pinned.js, which scripts/fetch-runtime.sh fills in
    // from the same changelog.json that decides what the mirror carries.
    // Whichever way this Lab is pinned, the label and the flag agree --
    // that is the invariant, not which build happens to be pinned today.
    const { stable, label } = await page.evaluate(async () => {
      const { BUNDLED } = await import('./vendor/pinned.js');
      return {
        stable: BUNDLED.stable,
        label: document.querySelector('[data-version-select] option').textContent,
      };
    });
    expect(stable === true || stable === false || stable === null).toBe(true);
    expect(/prerelease/.test(label)).toBe(stable === false);

    // And the About panel states it in words, because "prerelease" here
    // does not mean "unfinished" and a bug report needs to carry which.
    await viaControl(page, 'about');
    await expect(page.locator('[data-about]')).toContainText(
      stable === false ? 'prerelease' : /release|not stated/);
  });
});
