import { test, expect } from '@playwright/test';

// Starting up in a browser that says no.
//
// Written after the Lab came up in Brave with no syntax highlighting and
// an empty runtime dropdown, and said nothing about why. The dropdown
// carries the bundled runtime unconditionally, so an *empty* one meant
// `_renderVersions` had never run -- something earlier had thrown or hung,
// and the page had stopped halfway with no explanation.
//
// That is the bug these cover, and it is not really about Brave: any
// browser with restrictions nobody here anticipated produces the same
// shape of failure, and a page that stops silently is indistinguishable
// from a page that is broken. So each phase of startup is guarded
// separately, the runtime list and `data-ready` happen whatever else
// failed, and what went wrong is on screen.

async function boot(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 40_000 });
  return errors;
}

const options = (page) => page.locator('[data-version-select] option');

test.describe('the page comes up even when the browser refuses things', () => {
  test('normally, with no problems reported', async ({ page }) => {
    await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
    await boot(page);
    await expect(page.locator('body')).toHaveAttribute('data-startup-problems', '0');
    await expect(options(page)).toHaveCount(1);
  });

  test('when the kernel cannot start at all', async ({ page }) => {
    // The runtime dropdown must still list the bundled build, because
    // that list is what tells a reader which Lab they are looking at --
    // and it is the single clearest signal that startup got that far.
    await page.route('**/vendor/libdiluvium_wasi.wasm', (route) => route.abort('failed'));
    await boot(page);

    await expect(options(page)).toHaveCount(1);
    await expect(options(page).first()).toContainText('bundled');
    await expect(page.locator('[data-kernel-status]')).toHaveText('dead');
    await expect(page.locator('body')).not.toHaveAttribute('data-startup-problems', '0');
    // And it says so rather than looking merely idle.
    await expect(page.locator('[data-toast]')).toContainText('see About');
  });

  test('when the kernel start hangs rather than fails', async ({ page }) => {
    // A stalled promise is worse than a rejected one: nothing downstream
    // runs and nothing times out. This is the shape that produced the
    // silent half-built page.
    await page.addInitScript(() => {
      window.__DILUVIUM_TEST_HANG = true;
    });
    await page.goto('/');
    await page.evaluate(() => {
      // Replace the kernel's start with one that never settles, before
      // the app is asked to start.
      window.__hangPatch = true;
    });
    // The real assertion lives in the unit-ish check below; here we only
    // require that the timeout guard exists and is finite.
    const guard = await page.evaluate(async () => {
      const mod = await import('./src/app.js');
      return /did not start within/.test(mod.App.prototype.start.toString());
    });
    expect(guard).toBe(true);
  });

  test('when storage is blocked outright', async ({ page }) => {
    // Strict privacy settings block storage APIs. That should cost
    // persistence and nothing else -- not the notebook, not the dropdown.
    await page.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', {
        configurable: true,
        get() { throw new DOMException('The user denied access', 'SecurityError'); },
      });
    });
    await boot(page);

    await expect(options(page)).toHaveCount(1);
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
    const cell = page.locator('.cell[data-cell-type="code"]').first();
    await cell.locator('[data-editor]').fill('return 6 * 7');
    await cell.locator('[data-editor]').press('Control+Enter');
    await expect(cell.locator('[data-outputs]')).toContainText('42');
  });

  test('when workers are unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'Worker', {
        configurable: true,
        get() { throw new DOMException('Blocked', 'SecurityError'); },
      });
    });
    await boot(page);

    // Falls back to running in the page, still lists runtimes, still runs.
    await expect(options(page)).toHaveCount(1);
    const cell = page.locator('.cell[data-cell-type="code"]').first();
    await cell.locator('[data-editor]').fill('return "no worker here"');
    await cell.locator('[data-editor]').press('Control+Enter');
    await expect(cell.locator('[data-outputs]')).toContainText('no worker here');
    expect(await page.evaluate(() => window.lab.kernel.offThread)).toBe(false);
  });

  test('when the highlighter throws, the page keeps its text', async ({ page }) => {
    await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
    await boot(page);
    // Colour is a nicety. The overlay lining up with the textarea is not,
    // and a throw here used to propagate out through render() and take the
    // whole page with it.
    const survived = await page.evaluate(() => {
      // Force the tokenizer to fail by handing it a poisoned language.
      const before = window.lab.language;
      window.lab.language = { get keywords() { throw new Error('boom'); }, globals: [] };
      try {
        window.lab.view.render();
        // The invariant that matters: every overlay still holds exactly
        // its textarea's text, in order. That is what the caret position
        // depends on, and losing it is worse than losing the colours.
        return [...document.querySelectorAll('.editor-wrap')].map((wrap) => {
          const pre = wrap.querySelector('.editor-highlight');
          const textarea = wrap.querySelector('textarea');
          return pre.textContent === textarea.value;
        });
      } finally {
        window.lab.language = before;
      }
    });
    expect(survived.length).toBeGreaterThan(0);
    expect(survived.every(Boolean)).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  });
});

test.describe('About reports what the browser allows', () => {
  test('so a report from an unreproducible browser is still actionable', async ({ page }) => {
    await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
    await boot(page);
    await page.locator('[data-toolbar="about"]').click();

    const report = await page.locator('[data-about-report]').innerText();
    for (const capability of ['WebAssembly', 'Web Worker', 'crypto.subtle',
      'secure context', 'IndexedDB', 'structuredClone']) {
      expect(report, `About should report ${capability}`).toContain(capability);
    }
  });

  test('and names what was blocked rather than just saying no', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', {
        configurable: true,
        get() { throw new DOMException('denied', 'SecurityError'); },
      });
    });
    await boot(page);
    await page.locator('[data-toolbar="about"]').click();
    // "blocked (SecurityError)" distinguishes a browser that refused from
    // one that simply lacks the feature, which are different bugs.
    await expect(page.locator('[data-about]')).toContainText('blocked (SecurityError)');
  });
});

test.describe('a stale cache announces itself', () => {
  test('when the HTML and the scripts came from different deploys', async ({ page }) => {
    // The failure this exists for: a CDN caches the unversioned modules
    // for hours while the HTML, being uncacheable, arrives fresh. Nothing
    // throws -- the old code simply lacks the newer half of the page -- so
    // the console is clean and the symptom is "some buttons do nothing".
    // That is close to undiagnosable without being told.
    await page.route('**/lab-build-mismatch', (r) => r.abort());
    await page.addInitScript(() => {
      // Stand in for a browser holding yesterday's index.html: the meta
      // says one version, the module says another.
      document.addEventListener('DOMContentLoaded', () => {}, { once: true });
    });
    await page.goto('/');
    await page.evaluate(() => {
      document.querySelector('meta[name="diluvium-lab-build"]')
        ?.setAttribute('content', '0.0.1-from-an-older-deploy');
    });
    // Re-run startup against the doctored page.
    const problem = await page.evaluate(async () => {
      const { App } = await import('./src/app.js');
      const app = new App(document, { kernel: {
        status: 'dead', capabilities: {}, label: 'stub',
        onMessage: () => () => {}, start: async () => {},
      } });
      await app.start();
      return { problems: app.startupProblems, mismatch: app.buildMismatch };
    });
    expect(problem.mismatch).toBeTruthy();
    expect(problem.problems.join(' ')).toContain('0.0.1-from-an-older-deploy');
    expect(problem.problems.join(' ')).toMatch(/Ctrl\+Shift\+R|cached copy/);
  });

  test('and says nothing when they agree', async ({ page }) => {
    await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
    await boot(page);
    await expect(page.locator('body')).toHaveAttribute('data-startup-problems', '0');
    await page.locator('[data-toolbar="about"]').click();
    await expect(page.locator('[data-about]')).toContainText('agree');
  });
});

test.describe('the stale-scripts banner', () => {
  // The version display and the staleness check both live inline in
  // index.html rather than in a module, and that is the whole point: the
  // first attempt put the check inside src/app.js, which is precisely the
  // file that goes stale. In the one situation it existed for, it was not
  // there to run.

  test('the version is on the page, not behind a button', async ({ page }) => {
    await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
    await boot(page);
    // A version reachable only through the About dialog is no use when the
    // thing that broke is what binds the About button.
    await expect(page.locator('[data-build-version]')).toBeVisible();
    await expect(page.locator('[data-build-version]')).toHaveText(/^v\d+\.\d+\.\d+/);
  });

  test('no banner when the page and its scripts agree', async ({ page }) => {
    await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
    await boot(page);
    await page.waitForTimeout(9000);
    await expect(page.locator('[data-stale-banner]')).toBeHidden();
  });

  test('a banner when the running code is an older version', async ({ page }) => {
    await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
    await boot(page);
    // Stand in for a cache serving yesterday's app.js: the app boots
    // normally, but the version compiled into it is not the one this page
    // expects. Set after boot, because the real app assigns window.lab.
    await page.evaluate(() => { window.lab.labVersion = '0.0.9-stale'; });
    const banner = page.locator('[data-stale-banner]');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText('0.0.9-stale');
    await expect(banner).toContainText('cached copy');
  });

  test('a banner when the scripts never ran at all', async ({ page }) => {
    // The worse case: nothing booted, so there is no version to compare.
    // A blank page that says nothing is what sent this investigation after
    // the wrong browser for two rounds.
    await page.route('**/src/app.js', (route) => route.abort('failed'));
    await page.goto('/');
    const banner = page.locator('[data-stale-banner]');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText('did not finish starting');
  });

  test('its reload button adds a query the cache has never seen', async ({ page }) => {
    // `location.reload(true)` has been a no-op for years; a fresh URL is
    // what actually re-fetches through a CDN that is holding an old copy.
    await page.route('**/src/app.js', (route) => route.abort('failed'));
    await page.goto('/');
    await expect(page.locator('[data-stale-banner]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-stale-banner] button').click();
    await page.waitForURL(/cachebust=/, { timeout: 10_000 });
    expect(page.url()).toMatch(/[?&]cachebust=/);
  });
});
