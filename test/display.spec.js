import { test, expect } from '@playwright/test';
import { viaControl, dismissLauncher } from './chrome.js';

// The display channel: charts, event streams, controls, images.
//
// Every test here drives the real page and the real kernel. The Lua that
// produces a chart is run by `libdiluvium_wasi.wasm` in a worker, the
// record comes back over stdout, and the assertion is on the SVG that ends
// up in the document -- so nothing passes because two of our own functions
// agree with each other.
//
// The one thing worth stating about what is checked: a chart is asserted
// through its *data* (how many marks, which slot, what the table says),
// never its pixels. A test that pinned coordinates would fail on a font
// change and would still not notice a chart drawing the wrong numbers.

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

async function run(page, source) {
  const cell = codeCell(page);
  await cell.locator('[data-editor]').fill(source);
  await cell.locator('[data-editor]').press('Control+Enter');
  await expect(cell).toHaveAttribute('data-busy', 'false');
  return cell;
}

test.describe('display carries a mime bundle', () => {
  test('display() reaches the page as a display_data output', async ({ page }) => {
    await openLab(page);
    await run(page, `display{ ["text/plain"] = "plain words", ["application/json"] = '{"a":1}' }`);

    const outputs = await page.evaluate(() =>
      window.lab.model.cells.find((c) => c.outputs?.length)?.outputs);
    expect(outputs[0].output_type).toBe('display_data');
    // Both representations are stored, which is what makes the file
    // readable by something that has never heard of the richer one.
    expect(Object.keys(outputs[0].data).sort()).toEqual(['application/json', 'text/plain']);

    // JSON outranks text/plain in the preference order, so that is what
    // renders -- and the text is still there underneath.
    await expect(codeCell(page).locator('.display-json')).toContainText('"a": 1');
  });

  test('output and displays arrive in the order the program made them', async ({ page }) => {
    await openLab(page);
    // The whole reason stdout is parsed as a sequence. Before displays
    // existed the harness emitted one record at the end, so "everything
    // before the nonce" was the output; a chart in the middle of a cell
    // breaks that and would otherwise sort itself to the end.
    await run(page, 'print("first") plot.line{1,2,3} print("last")');

    const kinds = await page.evaluate(() => window.lab.model.cells
      .find((c) => c.outputs?.length).outputs
      .map((o) => (o.output_type === 'stream' ? o.text.join('').trim() : o.output_type)));
    expect(kinds).toEqual(['first', 'display_data', 'last']);
  });

  test('a bundle the page cannot draw falls back to its text', async ({ page }) => {
    await openLab(page);
    await run(page, `display{ ["text/plain"] = "fallback text", ["application/x-nonsense"] = "?" }`);
    await expect(codeCell(page).locator('.output-display_data pre')).toHaveText('fallback text');
  });
});

test.describe('plots', () => {
  test('plot.line draws a path and offers the numbers', async ({ page }) => {
    await openLab(page);
    const cell = await run(page, 'plot.line{1, 4, 9, 16}');

    await expect(cell.locator('.viz-svg')).toHaveCount(1);
    await expect(cell.locator('.viz-line')).toHaveCount(1);
    // One series needs no legend: the chart is the only thing on screen
    // and a legend box would say what nothing else is saying.
    await expect(cell.locator('.viz-legend')).toHaveCount(0);

    // The table is not decoration. Three of the light-mode series steps
    // sit below 3:1 against white, and this is the relief that makes that
    // legal -- so it has to exist and it has to have the real values.
    await cell.locator('[data-action="viz-table"]').click();
    await expect(cell.locator('.viz-table tbody tr')).toHaveCount(4);
    await expect(cell.locator('.viz-table tbody tr').last()).toContainText('16');
  });

  test('two series get a legend and separate colour slots', async ({ page }) => {
    await openLab(page);
    const cell = await run(page, `plot{
      title = "Two of them",
      series = { { name = "up", y = {1,2,3} }, { name = "down", y = {3,2,1} } },
    }`);

    await expect(cell.locator('.viz-title')).toHaveText('Two of them');
    await expect(cell.locator('.viz-legend .viz-key')).toHaveCount(2);
    await expect(cell.locator('.viz-legend .viz-key').first()).toContainText('up');
    // Identity is never colour alone, and the slots are assigned in fixed
    // order -- a filter that removed a series must not repaint the rest.
    await expect(cell.locator('.viz-line[data-slot="1"]')).toHaveCount(1);
    await expect(cell.locator('.viz-line[data-slot="2"]')).toHaveCount(1);
  });

  test('a gap in the data is a gap, not a zero', async ({ page }) => {
    await openLab(page);
    // JSON has no NaN, so the encoder writes null and the renderer breaks
    // the line there. Joining across it would draw a measurement nobody
    // took, and charting it as 0 would be worse still.
    const cell = await run(page, 'plot.line{1, 2, 0/0, 4, 5}');
    await expect(cell.locator('.viz-line')).toHaveCount(2);

    const spec = await page.evaluate(() => JSON.parse(window.lab.model.cells
      .find((c) => c.outputs?.length).outputs[0]
      .data['application/vnd.diluvium.plot+json'].join('')));
    expect(spec.series[0].y).toEqual([1, 2, null, 4, 5]);
  });

  test('bars are labelled and baselined at zero', async ({ page }) => {
    await openLab(page);
    const cell = await run(page, 'plot.bar({"alpha","beta","gamma"}, {5, 2, 8})');
    await expect(cell.locator('.viz-bar')).toHaveCount(3);
    await expect(cell.locator('.viz-svg')).toContainText('alpha');

    // A bar chart cropped above zero misstates every ratio it draws, so
    // the axis includes zero whatever the data does.
    const bottom = await cell.locator('.viz-grid text').first().textContent();
    expect(Number(bottom)).toBe(0);
  });

  test('hovering reports the values at that x', async ({ page }) => {
    await openLab(page);
    const cell = await run(page, 'plot{ series = { { name = "a", y = {10, 20, 30} } } }');
    const svg = cell.locator('.viz-svg');
    await svg.hover({ position: { x: 60, y: 60 } });
    await expect(cell.locator('.viz-tooltip')).toBeVisible();
    await expect(cell.locator('.viz-tooltip')).toContainText('10');
    // Not `toBeVisible`: an SVG <line> with x1 === x2 has a zero-width
    // bounding box, and Playwright calls that invisible however it is
    // styled. The attribute is what the crosshair actually is.
    await expect(cell.locator('.viz-crosshair')).not.toHaveAttribute('hidden', /.*/);
  });

  test('a chart survives a save and a reload', async ({ page }) => {
    await openLab(page);
    await run(page, 'plot.line{3, 1, 4, 1, 5}');
    // The point of storing a mime bundle rather than a private shape:
    // this is nbformat's own `display_data`, so it round-trips through
    // the file and through anything else that reads one.
    const json = await page.evaluate(async () => {
      const { toIpynb } = await import('./src/notebook/ipynb.js');
      return JSON.stringify(toIpynb(window.lab.model));
    });
    expect(json).toContain('application/vnd.diluvium.plot+json');

    await page.waitForTimeout(600);   // the autosave debounce is 400ms
    await page.reload();
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
    await dismissLauncher(page);
    await expect(page.locator('.viz-svg')).toHaveCount(1);
    await expect(page.locator('.viz-line')).toHaveCount(1);
  });
});

test.describe('event streams', () => {
  test('the swarm event kinds render with their own tone and a word', async ({ page }) => {
    await openLab(page);
    // The record shape is doc/Messaging.md 9.2's exactly -- `event`, `id`,
    // `detail` -- so a stream drained from a real system/events queue
    // renders here with nothing in between to get wrong.
    const cell = await run(page, `events({
      { event = "spawned", id = 2 },
      { event = "spawned", id = 3 },
      { event = "denied", id = 3, detail = "capability not held: lifecycle" },
      { event = "exceeded", id = 2, detail = "instruction budget" },
      { event = "faulted", id = 3, detail = "attempt to index a nil value" },
      { event = "exited", id = 2 },
    }, { title = "one step" })`);

    await expect(cell.locator('.events-title')).toHaveText('one step');
    await expect(cell.locator('.events-table tbody tr')).toHaveCount(6);

    // A colour never carries the meaning on its own: every row says the
    // word too, and the reserved status tones are kept clear of the chart
    // palette so a fault can never look like series 8.
    await expect(cell.locator('tr[data-kind="faulted"]')).toHaveAttribute('data-tone', 'critical');
    await expect(cell.locator('tr[data-kind="denied"]')).toHaveAttribute('data-tone', 'warning');
    await expect(cell.locator('tr[data-kind="faulted"] .events-kind')).toHaveText('faulted');
    await expect(cell.locator('tr[data-kind="exceeded"] .events-kind')).toHaveText('over budget');

    // The tally is what someone watching a swarm actually reads.
    await expect(cell.locator('.events-chip').first()).toContainText('spawned 2');
    await expect(cell.locator('.events-detail').nth(2)).toContainText('lifecycle');
  });

  test('an empty stream says so instead of drawing an empty table', async ({ page }) => {
    await openLab(page);
    const cell = await run(page, 'events{}');
    await expect(cell.locator('.events-empty')).toHaveText('no events');
  });
});

test.describe('controls', () => {
  test('a slider runs its callback and shows what it produced', async ({ page }) => {
    await openLab(page);
    const cell = await run(page, `
      widget.slider{ label = "n", min = 1, max = 8, value = 2,
        on_change = function(v) print("n is " .. v) end }
    `);

    const slider = cell.locator('.widget input[type="range"]');
    await expect(slider).toBeEnabled();
    await slider.fill('6');
    // The callback's output lands in the control's own slot, not in the
    // cell's output list -- a saved notebook should carry the result the
    // cell produced, not the last frame of someone dragging a slider.
    await expect(cell.locator('.widget-out')).toContainText('n is 6');
    const outputs = await page.evaluate(() =>
      window.lab.model.cells.find((c) => c.outputs?.length).outputs.length);
    expect(outputs).toBe(1);
  });

  test('the closure survives between cells, which is the whole trick', async ({ page }) => {
    await openLab(page);
    // The callback captured a local that exists only inside the kernel.
    // Nothing about it can cross to the page, so the page holds an id and
    // asks for the function by name.
    await run(page, `
      local scale = 3
      widget.slider{ label = "x", min = 1, max = 5, value = 1,
        on_change = function(v) print(v * scale) end }
    `);
    await codeCell(page).locator('.widget input[type="range"]').fill('4');
    await expect(codeCell(page).locator('.widget-out')).toContainText('12');
  });

  test('a control can draw a chart', async ({ page }) => {
    await openLab(page);
    await run(page, `
      widget.slider{ label = "n", min = 2, max = 10, value = 3,
        on_change = function(n)
          local ys = {}
          for i = 1, n do ys[i] = i * i end
          plot.line(ys)
        end }
    `);
    await codeCell(page).locator('.widget input[type="range"]').fill('5');
    await expect(codeCell(page).locator('.widget-out .viz-svg')).toHaveCount(1);
    await codeCell(page).locator('.widget-out [data-action="viz-table"]').click();
    await expect(codeCell(page).locator('.widget-out .viz-table tbody tr')).toHaveCount(5);
  });

  test('an error in a callback is reported, not swallowed', async ({ page }) => {
    await openLab(page);
    await run(page, `
      widget.button{ text = "break it", on_change = function() error("on purpose") end }
    `);
    await codeCell(page).locator('.widget-button').click();
    await expect(codeCell(page).locator('.widget-out .error-name')).toContainText('on purpose');
  });

  test('after a restart a control says it is not connected', async ({ page }) => {
    await openLab(page);
    await run(page, `widget.slider{ label = "n", min = 1, max = 5, value = 1,
      on_change = function(v) print(v) end }`);
    await viaControl(page, 'restart');
    // `data-ready` never goes false, so waiting on it waits for nothing.
    // The restart re-renders every cell, which would wipe the control's
    // output slot straight after we filled it.
    await expect(page.locator('[data-kernel-status]')).toHaveText('idle');
    await expect(codeCell(page)).toHaveAttribute('data-run-state', 'stale');

    // The kernel that held the closure is gone. The control is still in
    // the document because it was in the outputs, and moving it now would
    // be a promise nothing can keep -- so it says so.
    await codeCell(page).locator('.widget input[type="range"]').fill('4');
    await expect(codeCell(page).locator('.widget-out')).toContainText('has since restarted');
  });
});

test.describe('a notebook is untrusted input', () => {
  test('an SVG cannot bring a script or a request with it', async ({ page }) => {
    await openLab(page);
    // This is the one display type that carries markup, so it is the one
    // that has to be neutralised. Allowlisted rather than blocklisted: a
    // list of dangerous SVG is a list nobody has ever finished.
    await run(page, `display{ ["image/svg+xml"] = [[
      <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="window.__pwned = 1">
        <script>window.__pwned = 2</script>
        <circle cx="20" cy="20" r="10" fill="red"/>
        <image href="https://example.com/x.png"/>
        <a href="javascript:window.__pwned = 3"><rect width="5" height="5"/></a>
      </svg>
    ]] }`);

    const svg = codeCell(page).locator('.display-svg');
    await expect(svg).toHaveCount(1);
    await expect(svg.locator('circle')).toHaveCount(1);
    await expect(svg.locator('script')).toHaveCount(0);
    await expect(svg.locator('image')).toHaveCount(0);
    expect(await svg.getAttribute('onload')).toBeNull();
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });

  test('an image is a data URI, so nothing can be fetched', async ({ page }) => {
    await openLab(page);
    // A 1x1 transparent PNG.
    await run(page, `display{ ["image/png"] =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" }`);
    const src = await codeCell(page).locator('.display-image').getAttribute('src');
    expect(src.startsWith('data:image/png;base64,')).toBe(true);
  });

  test('a malformed bundle names itself instead of breaking the cell', async ({ page }) => {
    await openLab(page);
    await run(page, `display{ ["application/vnd.diluvium.plot+json"] = "not json at all" }
    print("the cell kept going")`);
    await expect(codeCell(page).locator('.display-broken')).toBeVisible();
    await expect(codeCell(page).locator('.output-stream')).toContainText('the cell kept going');
  });
});

test.describe('a display too large for the output ceiling', () => {
  test('says so, instead of leaking the framing onto the page', async ({ page }) => {
    test.slow();
    await openLab(page);
    // The display channel shares the kernel's 4 MB output ceiling, and a
    // chart counts against it. When the cap cuts a record in half the
    // harness's own terminal record goes with it -- which used to surface
    // as `HarnessError` (reserved for *our* bugs) with the truncated
    // stdout pasted in, nonce and separator bytes and all, over the top of
    // whatever the cell had legitimately printed.
    await run(page, [
      'local ys = {}',
      'for i = 1, 300000 do ys[i] = i * 1.0000001 end',
      'plot.line(ys)',
    ].join('\n'));

    const shown = await codeCell(page).locator('.outputs').textContent();
    expect(shown).not.toContain('HarnessError');
    // The record framing is internal and must never reach a reader.
    expect(shown).not.toMatch(/DL[0-9a-f]{16}/);
    await expect(codeCell(page).locator('[data-error-name]')).toContainText('OutputTooLarge');
    // And it says what to do about it, which "harness error" did not.
    await expect(codeCell(page).locator('[data-error-name]')).toContainText('plot fewer points');
  });
});

test.describe('the API does not take over the program', () => {
  test('a program that wants its own `plot` keeps it', async ({ page }) => {
    await openLab(page);
    // Four globals is four names taken from the user. A slot is ours to
    // write only if it is empty or still holds what we last put there.
    await run(page, 'plot = 42');
    await run(page, 'return plot');
    await expect(codeCell(page).locator('.output-execute_result pre')).toHaveText('42');

    await run(page, 'plot = nil');
    await run(page, 'return type(plot)');
    await expect(codeCell(page).locator('.output-execute_result pre')).toHaveText('table');
  });

  test('the kernel state stays out of _G', async ({ page }) => {
    await openLab(page);
    // The nonce and the widget table live in the Lua registry. A notebook
    // whose `_G` is full of the tool's bookkeeping is a notebook where
    // `for k in pairs(_G)` lies to you.
    await run(page, 'return _G["diluvium.lab"]');
    await expect(codeCell(page).locator('.output-execute_result pre')).toHaveText('nil');
  });

  test('the new globals turn up in completion', async ({ page }) => {
    await openLab(page);
    // The globals list is enumerated from the running kernel, so this is
    // the check that the API is installed before anything asks -- not
    // only after the first cell has run.
    const globals = await page.evaluate(() => window.lab.language.globals);
    expect(globals).toEqual(expect.arrayContaining(['display', 'plot', 'events', 'widget']));
    expect(globals).not.toContain('diluvium.lab');
  });
});

test('the example notebook runs clean', async ({ page }) => {
  // A notebook in the repository that errors is worse than no notebook:
  // it is the first thing someone runs. This drives the real file through
  // Run all and asserts nothing red, the same way browser-check.spec.js
  // does for the engine checks.
  await openLab(page);
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../notebooks/showing-things.ipynb', import.meta.url), 'utf8'));

  await page.evaluate(async (json) => {
    const { fromIpynb } = await import('./src/notebook/ipynb.js');
    window.lab._setModel(fromIpynb(json));
  }, source);

  await page.locator('[data-toolbar="run-all"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-running', 'false', { timeout: 90_000 });

  await expect(page.locator('.output-error')).toHaveCount(0);
  await expect(page.locator('.display-broken')).toHaveCount(0);
  // Every kind it is meant to demonstrate actually appeared -- a notebook
  // that ran clean by drawing nothing would pass the check above. The
  // exact counts are deliberate: changing the notebook should make someone
  // update this line and, in doing so, notice what they changed.
  await expect(page.locator('.viz-svg')).toHaveCount(7);
  // Two on a kernel with queues, one without: the notebook's last events
  // cell feature-detects `queue` and draws a real drained stream when it
  // is there. Derived from the running kernel rather than hardcoded, so
  // this test says the same true thing whichever build is pinned.
  const hasQueues = await page.evaluate(async () => {
    const { executeCollected } = await import('./src/kernel/kernel.js');
    const out = await executeCollected(window.lab.kernel, 'print(type(queue))');
    return out.stdout.trim() === 'table';
  });
  await expect(page.locator('.events-table')).toHaveCount(hasQueues ? 2 : 1);
  await expect(page.locator('.widget')).toHaveCount(2);
  await expect(page.locator('.display-svg')).toHaveCount(1);
});
