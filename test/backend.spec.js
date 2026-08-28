import { test, expect } from '@playwright/test';

// The backend chooser's other arm: the real C swarm module.
//
// `test/node/backend.test.mjs` covers the DRT arm and the refusals, in
// milliseconds and without a browser. What it cannot cover is a module
// carrying `dvs_*`, because the Node runner boots `libdiluvium_wasi.wasm`
// and only a page fetches `diluvium_swarm_wasi.wasm` beside it. So the
// assertions here are the ones that need a real swarm layer present -- and
// in particular the one case that decides the migration's behaviour: a
// page holding *both* backends.

async function open(page) {
  await page.goto('/test/kernel-page.html');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
}

test.describe('choosing a swarm backend', () => {
  test('the shipped swarm module is recognised, and chosen when it is the only one', async ({ page }) => {
    await open(page);
    const chosen = await page.evaluate(async () => {
      const exports = await window.lab.swarmExports();
      return window.lab.selectBackend({ exports, drtWeb: null });
    });
    expect(chosen.name).toBe('swarm');
    // Named rather than passed over in silence: this is the backend that
    // goes away when diluvium deletes dvs.c.
    expect(chosen.why).toContain('no drt-web is loaded');
  });

  test('a page holding both backends prefers drt-web, and says the other is there', async ({ page }) => {
    await open(page);
    const both = await page.evaluate(async () => {
      const exports = await window.lab.swarmExports();
      // The swarm module is a superset of the kernel -- same objects plus
      // dvs.o and dvs_shim.o -- so one module answers both questions, which
      // is exactly the "both available" case the chooser exists for.
      const drt = window.lab.createMockDrtWeb(exports);
      try {
        return {
          preferred: window.lab.selectBackend({ exports, drtWeb: drt }),
          forced: window.lab.selectBackend({ exports, drtWeb: drt, prefer: 'swarm' }),
        };
      } finally {
        drt.free();
      }
    });

    expect(both.preferred.name).toBe('drt');
    expect(both.preferred.why).toContain('both backends');
    expect(both.preferred.why).toContain('the C swarm layer is also available');

    // The preference is a default, not a rule: running one notebook against
    // two backends is the comparison this project exists to make.
    expect(both.forced.name).toBe('swarm');
    expect(both.forced.why).toContain('both backends');
  });

  test('an old runtime with neither is two labelled refusals', async ({ page }) => {
    await open(page);
    const why = await page.evaluate(() => {
      // The plain kernel: `dv_` but no `dvs_*`, which is every build before
      // v5.5.1_build5 and every build after dvs.c is deleted.
      const chosen = window.lab.selectBackend({
        exports: window.lab.moduleExports(), drtWeb: null,
      });
      return { name: chosen.name, problems: window.lab.backendProblems(chosen) };
    });

    expect(why.name).toBeNull();
    expect(why.problems.join(' ')).toContain('drt-web:');
    expect(why.problems.join(' ')).toContain('the C swarm layer:');
    // The sentence the C side already knew how to say, still said.
    expect(why.problems.join(' ')).toContain('no swarm layer');
  });

  test('a drt-web whose kernel cannot be bridged is refused for the kernel, not the swarm', async ({ page }) => {
    await open(page);
    const problems = await page.evaluate(async () => {
      const exports = await window.lab.swarmExports();
      const drt = window.lab.createMockDrtWeb(exports);
      try {
        // A complete drt-web against a module with no `dv_` ABI at all.
        // Both halves are needed in the browser tier, and the refusal must
        // point at the half that is actually missing.
        const chosen = window.lab.selectBackend({ exports: {}, drtWeb: drt });
        return { name: chosen.name, drt: chosen.problems.drt };
      } finally {
        drt.free();
      }
    });
    expect(problems.name).toBeNull();
    expect(problems.drt.join(' ')).toContain('missing');
  });
});
