import { test, expect } from '@playwright/test';
import { dismissLauncher } from './chrome.js';

// The instances panel, through the real page and the real buttons.
//
// `swarm.spec.js` asserts what the runtime did; this asserts that the panel
// shows it. The two are deliberately separate, because a panel test that
// also had to set up a swarm would end up asserting its own fixture --
// which is the failure mode the project's own notes call "a check that
// reports success without checking".

async function openLab(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  await dismissLauncher(page);
  return problems;
}

const openPanel = async (page) => {
  await page.locator('[data-tool="swarm"]').click();
  await expect(page.locator('[data-tool-panel]')).toBeVisible();
};

test('the rail offers the instances tool and it opens', async ({ page }) => {
  const problems = await openLab(page);
  await openPanel(page);
  await expect(page.locator('[data-tool-panel-title]')).toHaveText('Instances');
  // Wider than the outline, because a roster does not fit in 17rem.
  await expect(page.locator('[data-tool-panel][data-wide]')).toBeVisible();
  expect(problems).toEqual([]);
});

test('starting a swarm fills the roster with the instances it created', async ({ page }) => {
  const problems = await openLab(page);
  await openPanel(page);

  await page.locator('[data-swarm="swarm-start"]').click();
  await expect(page.locator('[data-swarm-roster] tr[data-instance]')).toHaveCount(1);
  await page.locator('[data-swarm="swarm-run"]').click();

  // Three workers plus a root. The fourth spawn in that program is
  // deliberately refused by the runtime and creates nothing, which is what
  // makes 4 the right number rather than 5.
  await expect(page.locator('[data-swarm-roster] tr[data-instance]')).toHaveCount(4, { timeout: 15_000 });

  const root = page.locator('[data-swarm-roster] tr[data-instance="1"]');
  await expect(root).toContainText('root');

  // And the event list shows them arriving, which is the thing the panel
  // exists for: sub-instances, as they are created.
  await expect(page.locator('[data-swarm-events] [data-event="spawned"]')).toHaveCount(4);
  expect(problems).toEqual([]);
});

test('a refused spawn is visible rather than silent', async ({ page }) => {
  await openLab(page);
  await openPanel(page);
  await page.locator('[data-swarm="swarm-start"]').click();
  await page.locator('[data-swarm="swarm-run"]').click();
  await expect(page.locator('[data-swarm-events]')).toContainText('denied', { timeout: 15_000 });
});

test('a runaway shows as exceeded, with the budget that stopped it', async ({ page }) => {
  await openLab(page);
  await openPanel(page);
  await page.locator('[data-swarm-program]').selectOption('runaway');
  await page.locator('[data-swarm="swarm-start"]').click();
  await page.locator('[data-swarm="swarm-run"]').click();

  const gone = page.locator('[data-swarm-roster] tr[data-state="gone"]');
  await expect(gone.first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-swarm-roster]')).toContainText('exceeded', { timeout: 15_000 });
  // The instruction count is shown against the budget, so "it stopped"
  // and "it stopped at its limit" are distinguishable.
  await expect(page.locator('[data-swarm-roster]')).toContainText('500,000');
});

test('the listener composer drives a request through the program and back', async ({ page }) => {
  await openLab(page);
  await openPanel(page);
  await page.locator('[data-swarm-program]').selectOption('service');
  await page.locator('[data-swarm="swarm-start"]').click();
  await page.locator('[data-swarm="swarm-run"]').click();

  const listener = page.locator('[data-swarm-listener]');
  await expect(listener).toBeVisible({ timeout: 15_000 });
  // It says which port it would bind and that it did not.
  await expect(listener).toContainText('not bound');

  await page.locator('[data-listener-path]').fill('/hello');
  await page.locator('[data-swarm="listener-send"]').click();

  await expect(page.locator('[data-listener-exchanges]'))
    .toContainText('GET /hello → 200', { timeout: 15_000 });
  await expect(page.locator('[data-listener-exchanges]')).toContainText('1 time(s)');

  // A second request to the same path counts up, which is only
  // true if the database kept the row between hostcalls.
  await page.locator('[data-swarm="listener-send"]').click();
  await expect(page.locator('[data-listener-exchanges]'))
    .toContainText('2 time(s)', { timeout: 15_000 });

  // And the database section says what it is, rather than implying SQLite.
  await expect(page.locator('[data-swarm-database]')).toContainText('not SQLite');
  await expect(page.locator('[data-swarm-database]')).toContainText('visit');
});

test('stopping a swarm leaves the roster as the last thing the host saw', async ({ page }) => {
  await openLab(page);
  await openPanel(page);
  await page.locator('[data-swarm="swarm-start"]').click();
  await page.locator('[data-swarm="swarm-step"]').click();
  await page.locator('[data-swarm="swarm-stop"]').click();

  await expect(page.locator('[data-swarm="swarm-start"]')).toBeVisible();
  await expect(page.locator('[data-tool-panel-body]')).toContainText('This swarm has stopped');
});

test('the stack workaround is silent on a build that does not need it', async ({ page }) => {
  await openLab(page);
  await openPanel(page);
  await page.locator('[data-swarm="swarm-start"]').click();
  await expect(page.locator('[data-swarm-summary]')).toBeVisible();
  // The panel used to carry a note saying the Lab had moved this module's
  // shadow stack, because v5.5.1_build5 shipped one too small for
  // `dvs_step`. build6 fixed the link flag, so the note must now be
  // *absent* -- a workaround that keeps announcing itself after the thing
  // it worked around is fixed is just noise, and the note is what would
  // tell a reader the Lab is still patching around a live defect.
  await expect(page.locator('[data-swarm-stack]')).toHaveCount(0);
});

test('the notebook still works while a swarm is running', async ({ page }) => {
  const problems = await openLab(page);
  await openPanel(page);
  await page.locator('[data-swarm="swarm-start"]').click();
  await page.locator('[data-swarm="swarm-run"]').click();
  await expect(page.locator('[data-swarm-roster] tr[data-instance]')).toHaveCount(4, { timeout: 15_000 });

  // The swarm is a second module with its own linear memory, which is most
  // of why it is a second module: a guest that faults cannot take the
  // notebook's Lua state with it.
  const output = await page.evaluate(async () => {
    const messages = await window.lab.executeCollectMessages('greeting = "still here" print(greeting)');
    return messages.filter((m) => m.msg_type === 'stream').map((m) => m.content.text).join('');
  });
  expect(output).toContain('still here');
  expect(problems).toEqual([]);
});
