import { test, expect } from '@playwright/test';

// The things that decide whether someone's first afternoon with Diluvium is
// pleasant: does a table show its contents, does an error say anything
// useful, does Tab indent, and can the standard library be found by
// pressing a key instead of by reading a reference.

async function openLab(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  return problems;
}

const codeCell = (page) => page.locator('.cell[data-cell-type="code"]').first();
const run = (page, code) => page.evaluate((c) => window.lab.executeCollectMessages(c), code);

async function runInCell(page, source) {
  const cell = codeCell(page);
  await cell.locator('[data-editor]').fill(source);
  await cell.locator('[data-editor]').press('Control+Enter');
  await expect(cell).toHaveAttribute('data-busy', 'false');
  return cell;
}

const resultOf = async (page, code) => {
  const messages = await run(page, code);
  return messages.find((m) => m.msg_type === 'execute_result')?.content.data['text/plain'] ?? null;
};

// ---------------------------------------------------------------------
// The bug: a cell of statements ending in an expression, all on one line.
// ---------------------------------------------------------------------

test.describe('trailing expressions on a single line', () => {
  test('the reported case echoes instead of erroring', async ({ page }) => {
    await openLab(page);
    // Was: syntax error near <eof>, which explains nothing.
    expect(await resultOf(page, 'local t = {3,1,2} table.sort(t) t')).toBe('{ 1, 2, 3 }');
  });

  test('several statements then an expression', async ({ page }) => {
    await openLab(page);
    expect(await resultOf(page, 'x = 1 y = 2 x + y')).toBe('3');
  });

  test('multi-line still works, and locals stay in scope', async ({ page }) => {
    await openLab(page);
    expect(await resultOf(page, 'local t = { 10, 20 }\nlocal n = #t\nt[n]')).toBe('20');
  });

  test('a single-line loop is never split apart', async ({ page }) => {
    await openLab(page);
    // The hazard the prefix-must-compile guard exists for: splitting inside
    // the body turns iteration one into an early return.
    const messages = await run(page, 'for i = 1, 3 do print(i) end');
    const stdout = messages.filter((m) => m.msg_type === 'stream').map((m) => m.content.text).join('');
    expect(stdout).toBe('1\n2\n3\n');
  });

  test('a single-line while loop runs fully and then echoes', async ({ page }) => {
    await openLab(page);
    expect(await resultOf(page, 'local i = 0 while i < 3 do i = i + 1 end i')).toBe('3');
  });
});

// ---------------------------------------------------------------------
// `table: 0x1f2e0` is where a language starts to feel hostile.
// ---------------------------------------------------------------------

test.describe('tables show their contents', () => {
  const cases = [
    ['an array', '{ 1, 2, 3 }', '{ 1, 2, 3 }'],
    ['a map, sorted', '{ b = 2, a = 1 }', '{ a = 1, b = 2 }'],
    ['both at once', '{ 1, 2, name = "diluvium" }', '{ 1, 2, name = "diluvium" }'],
    ['nested', '{ a = { b = { c = 1 } } }', '{ a = { b = { c = 1 } } }'],
    ['empty', '{}', '{}'],
    ['keys that need brackets', '{ ["two words"] = 1 }', '{ ["two words"] = 1 }'],
    ['booleans and nil inside', '{ true, false }', '{ true, false }'],
  ];

  for (const [name, code, expected] of cases) {
    test(name, async ({ page }) => {
      await openLab(page);
      expect(await resultOf(page, code)).toBe(expected);
    });
  }

  test('a string is bare on its own but quoted inside a table', async ({ page }) => {
    await openLab(page);
    // Bare matches what the REPL prints; quoted inside a table is what
    // makes "1" and 1 tellable apart.
    expect(await resultOf(page, '"hello"')).toBe('hello');
    expect(await resultOf(page, '{ "1", 1 }')).toBe('{ "1", 1 }');
  });

  test('a cycle is reported rather than followed forever', async ({ page }) => {
    await openLab(page);
    expect(await resultOf(page, 'local t = {} t.self = t t')).toBe('{ self = <cycle> }');
  });

  test('deep nesting stops at a readable depth', async ({ page }) => {
    await openLab(page);
    const result = await resultOf(page, 'local t = {} local c = t for i=1,10 do c.next = {} c = c.next end t');
    expect(result).toContain('{...}');
    expect(result.length).toBeLessThan(200);
  });

  test('a wide table stops and says so', async ({ page }) => {
    await openLab(page);
    const result = await resultOf(page, 'local t = {} for i = 1, 100 do t[i] = i end t');
    expect(result).toContain('...');
    expect(result).toContain('1, 2, 3');
    expect(result).not.toContain('100');
  });

  test('__tostring wins, because the author said so', async ({ page }) => {
    await openLab(page);
    expect(await resultOf(page, 'setmetatable({}, { __tostring = function() return "<custom>" end })'))
      .toBe('<custom>');
  });

  test('print is left exactly as Lua defines it', async ({ page }) => {
    await openLab(page);
    // Redefining print would teach something that stops being true in the
    // terminal. The nudge points at the echo instead.
    const cell = await runInCell(page, 'print({1,2})');
    await expect(cell.locator('[data-output-type="stream"] pre')).toContainText('table: 0x');
    await expect(cell.locator('[data-tip]')).toContainText('on a line by itself');
  });

  test('rendering never breaks a cell that otherwise ran', async ({ page }) => {
    await openLab(page);
    // A metatable that throws on every access is the nastiest input here.
    const messages = await run(page,
      'setmetatable({}, { __index = function() error("boom") end, __tostring = function() error("boom") end })');
    expect(messages.some((m) => m.msg_type === 'error')).toBe(false);
  });
});

// ---------------------------------------------------------------------

test.describe('errors explain themselves', () => {
  const cases = [
    ['an undefined global', 'total = total + 1', /has no value|starting value/i],
    ['calling something undefined', 'notAFunction()', /no function called/i],
    ['indexing nothing', 'local x = nil\nx.field', /nothing to look inside|is nil/i],
    ['concatenating nil', 'local name\nprint("hi " .. name)', /joins strings/i],
    ['= instead of ==', 'if 1 = 1 then end', /== to compare/i],
    ['an unclosed block', 'function f()', /needs a matching end|still open/i],
    // `return f()` would be a tail call -- Lua reuses the frame, so it
    // loops forever instead of overflowing. `1 + f()` is not one.
    ['runaway recursion', 'local function f() return 1 + f() end f()', /calling itself/i],
    ['a bad argument', 'string.rep(nil, 2)', /argument/i],
  ];

  for (const [name, code, pattern] of cases) {
    test(name, async ({ page }) => {
      await openLab(page);
      const cell = await runInCell(page, code);
      await expect(cell.locator('[data-output-type="error"]')).toHaveCount(1);
      await expect(cell.locator('[data-hint]')).toHaveText(pattern);
    });
  }

  test('the traceback shows the user\'s stack, not the harness', async ({ page }) => {
    await openLab(page);
    const cell = await runInCell(page,
      'local function inner() error("deep") end\nlocal function outer() inner() end\nouter()');
    const traceback = await cell.locator('.traceback').innerText();

    // Their frames, named for the cell.
    expect(traceback).toContain('cell:');
    // Not ours: the wrapper, the generated chunk, or the nonce that tags it.
    expect(traceback).not.toContain('xpcall');
    expect(traceback).not.toContain('__N');
    expect(traceback).not.toMatch(/DL[0-9a-f]{16}/);
    expect(traceback).not.toContain('\u0001');
  });

  test('the runtime message is always kept, above the hint', async ({ page }) => {
    await openLab(page);
    const cell = await runInCell(page, 'total = total + 1');
    // Searchable, verbatim, and first.
    await expect(cell.locator('[data-error-name]')).toContainText('attempt to perform arithmetic');
    await expect(cell.locator('[data-hint]')).toBeVisible();
  });

  test('an error with nothing useful to add gets no hint', async ({ page }) => {
    await openLab(page);
    const cell = await runInCell(page, 'error("a message of my own")');
    await expect(cell.locator('[data-output-type="error"]')).toHaveCount(1);
    await expect(cell.locator('[data-hint]')).toHaveCount(0);
  });

  test('hints render code spans as code, not as backticks', async ({ page }) => {
    await openLab(page);
    const cell = await runInCell(page, 'total = total + 1');
    await expect(cell.locator('[data-hint] code').first()).toBeVisible();
    await expect(cell.locator('[data-hint]')).not.toContainText('`');
  });
});

// ---------------------------------------------------------------------

test.describe('Tab indents', () => {
  test('Tab inserts an indent instead of leaving the field', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('print(1)');
    await editor.press('Home');
    await editor.press('Tab');

    await expect(editor).toHaveValue('  print(1)');
    await expect(editor).toBeFocused();
  });

  test('Shift+Tab takes one back', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('    print(1)');
    await editor.press('Home');
    await editor.press('ArrowRight');
    await editor.press('ArrowRight');
    await editor.press('ArrowRight');
    await editor.press('ArrowRight');
    await editor.press('Shift+Tab');
    await expect(editor).toHaveValue('  print(1)');
  });

  test('Shift+Tab dedents wherever the caret sits on the line', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');

    // Caret after the indentation.
    await editor.fill('    end');
    await editor.press('End');
    await editor.press('Shift+Tab');
    await expect(editor).toHaveValue('  end');

    // Caret before it, at column zero -- the same line and the same intent,
    // and it used to do nothing at all.
    await editor.fill('    end');
    await editor.press('Home');
    await editor.press('Shift+Tab');
    await expect(editor).toHaveValue('  end');

    // Caret in the middle of the word.
    await editor.fill('    end');
    await editor.press('Home');
    await editor.press('ArrowRight');
    await editor.press('ArrowRight');
    await editor.press('ArrowRight');
    await editor.press('ArrowRight');
    await editor.press('ArrowRight');
    await editor.press('Shift+Tab');
    await expect(editor).toHaveValue('  end');
  });

  test('Shift+Tab on an unindented line does nothing', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('end');
    await editor.press('Home');
    await editor.press('Shift+Tab');
    await expect(editor).toHaveValue('end');
  });

  test('a selection indents every line it covers', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('one\ntwo\nthree');
    await editor.press('Control+a');
    await editor.press('Tab');
    await expect(editor).toHaveValue('  one\n  two\n  three');

    // and stays selected, so it can be indented again
    await editor.press('Tab');
    await expect(editor).toHaveValue('    one\n    two\n    three');
    await editor.press('Shift+Tab');
    await expect(editor).toHaveValue('  one\n  two\n  three');
  });

  test('Enter keeps the indentation, and adds one inside a block', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('  local x = 1');
    await editor.press('End');
    await editor.press('Enter');
    await expect(editor).toHaveValue('  local x = 1\n  ');

    await editor.fill('for i = 1, 3 do');
    await editor.press('End');
    await editor.press('Enter');
    await expect(editor).toHaveValue('for i = 1, 3 do\n  ');
  });

  test('undo still works, so indenting is not a one-way door', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('print(1)');
    await editor.press('Home');
    await editor.press('Tab');
    await expect(editor).toHaveValue('  print(1)');

    // Assigning .value would have wiped the native undo stack.
    await editor.press('Control+z');
    await expect(editor).toHaveValue('print(1)');
  });

  test('Escape then Tab still moves focus, so keyboard users are not trapped', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('print(1)');
    await editor.press('Escape');
    await editor.press('Tab');

    await expect(editor).toHaveValue('print(1)');       // nothing inserted
    await expect(editor).not.toBeFocused();
  });

  test('Ctrl+Enter still runs rather than opening a line', async ({ page }) => {
    await openLab(page);
    const cell = await runInCell(page, 'print("ran")');
    await expect(cell.locator('[data-outputs]')).toContainText('ran');
    await expect(cell.locator('[data-editor]')).toHaveValue('print("ran")');
  });

  test('Tab indents in the console too, and Enter still submits there', async ({ page }) => {
    await openLab(page);
    const input = page.locator('[data-console-input]');
    await input.fill('x');
    await input.press('Home');
    await input.press('Tab');
    await expect(input).toHaveValue('  x');

    await input.fill('print("console still submits")');
    await input.press('Enter');
    await expect(page.locator('[data-console-stream="stdout"]')).toContainText('console still submits');
  });
});

// ---------------------------------------------------------------------

test.describe('Ctrl+/ comments', () => {
  test('one line, there and back', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('print(1)');
    await editor.press('End');
    await editor.press('Control+/');
    await expect(editor).toHaveValue('-- print(1)');

    await editor.press('Control+/');
    await expect(editor).toHaveValue('print(1)');
  });

  test('a selection, commented at the shallowest indent', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('for i = 1, 3 do\n  print(i)\n  print(i * 2)\nend');
    await editor.press('Control+a');
    await editor.press('Control+/');
    // Column zero is the shallowest line, so that is where the marker goes.
    await expect(editor).toHaveValue('-- for i = 1, 3 do\n--   print(i)\n--   print(i * 2)\n-- end');

    await editor.press('Control+/');
    await expect(editor).toHaveValue('for i = 1, 3 do\n  print(i)\n  print(i * 2)\nend');
  });

  test('an indented block keeps its shape', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('  print(1)\n    print(2)');
    await editor.press('Control+a');
    await editor.press('Control+/');
    // Marker at the shallowest indent, so the nesting is still visible.
    await expect(editor).toHaveValue('  -- print(1)\n  --   print(2)');
  });

  test('a part-commented block gets fully commented, not toggled', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('-- print(1)\nprint(2)');
    await editor.press('Control+a');
    await editor.press('Control+/');
    await expect(editor).toHaveValue('-- -- print(1)\n-- print(2)');
  });

  test('blank lines are left alone', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('print(1)\n\nprint(2)');
    await editor.press('Control+a');
    await editor.press('Control+/');
    await expect(editor).toHaveValue('-- print(1)\n\n-- print(2)');
  });

  test('uncommenting eats one space, so --- survives', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('--- a heading comment');
    await editor.press('Control+a');
    await editor.press('Control+/');
    await expect(editor).toHaveValue('- a heading comment');
  });

  test('a commented cell still runs, doing nothing', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('print("hidden")');
    await editor.press('Control+a');
    await editor.press('Control+/');
    await editor.press('Control+Enter');
    await expect(codeCell(page)).toHaveAttribute('data-busy', 'false');
    await expect(codeCell(page).locator('[data-outputs] .output')).toHaveCount(0);
  });

  test('undo puts it back', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('print(1)');
    await editor.press('End');
    await editor.press('Control+/');
    await expect(editor).toHaveValue('-- print(1)');
    await editor.press('Control+z');
    await expect(editor).toHaveValue('print(1)');
  });

  test('it works in the console too', async ({ page }) => {
    await openLab(page);
    const input = page.locator('[data-console-input]');
    await input.fill('print(1)');
    await input.press('End');
    await input.press('Control+/');
    await expect(input).toHaveValue('-- print(1)');
  });
});

// ---------------------------------------------------------------------

test.describe('Ctrl+/ comments and uncomments', () => {
  test('one line, both ways', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('print(1)');
    await editor.press('Control+/');
    await expect(editor).toHaveValue('-- print(1)');

    await editor.press('Control+/');
    await expect(editor).toHaveValue('print(1)');
  });

  test('a selection, and the marker lands at the shallowest indent', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('  local a = 1\n    local b = 2');
    await editor.press('Control+a');
    await editor.press('Control+/');
    // Aligned at column 2, so the shape of the block survives.
    await expect(editor).toHaveValue('  -- local a = 1\n  --   local b = 2');

    await editor.press('Control+/');
    await expect(editor).toHaveValue('  local a = 1\n    local b = 2');
  });

  test('a part-commented block gets commented, not toggled line by line', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('-- already\nprint(2)');
    await editor.press('Control+a');
    await editor.press('Control+/');
    await expect(editor).toHaveValue('-- -- already\n-- print(2)');
  });

  test('blank lines are left alone', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('print(1)\n\nprint(2)');
    await editor.press('Control+a');
    await editor.press('Control+/');
    await expect(editor).toHaveValue('-- print(1)\n\n-- print(2)');
  });

  test('uncommenting eats one space, so ---- and --[[ survive', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('-- --[[ kept ]]');
    await editor.press('Control+/');
    await expect(editor).toHaveValue('--[[ kept ]]');
  });

  test('the commented code actually stops running', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    const editor = cell.locator('[data-editor]');
    await editor.fill('print("before")\nprint("after")');
    // Control+Home, not Home: fill() leaves the caret at the end, so Home
    // would land on the *last* line and comment the wrong one.
    await editor.press('Control+Home');
    await editor.press('Control+/');
    await editor.press('Control+Enter');
    await expect(cell).toHaveAttribute('data-busy', 'false');

    const output = await cell.locator('[data-outputs]').innerText();
    expect(output).not.toContain('before');
    expect(output).toContain('after');
  });

  test('undo puts it back', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('print(1)');
    await editor.press('Control+/');
    await expect(editor).toHaveValue('-- print(1)');
    await editor.press('Control+z');
    await expect(editor).toHaveValue('print(1)');
  });

  test('it works in the console as well', async ({ page }) => {
    await openLab(page);
    const input = page.locator('[data-console-input]');
    await input.fill('print(1)');
    await input.press('Control+/');
    await expect(input).toHaveValue('-- print(1)');
  });
});

test.describe('completion makes the library findable', () => {
  const popup = (page) => page.locator('[data-completions]');

  test('a dot opens the list by itself', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('');
    await editor.pressSequentially('string.');

    await expect(popup(page)).toBeVisible();
    // Only the first 12 are shown, and `rep` sorts past them.
    await expect(popup(page).locator('li').first()).toHaveText('byte');
    await expect(popup(page).locator('.completions-more')).toBeVisible();
  });

  test('a decimal point does not', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('');
    await editor.pressSequentially('x = 3.');
    await expect(popup(page)).toHaveCount(0);
  });

  test('Ctrl+Space completes a partial name', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('');
    await editor.pressSequentially('string.rev');
    await editor.press('Control+Space');
    // exactly one match, so it fills in without a menu
    await expect(editor).toHaveValue('string.reverse');
  });

  test('arrows choose and Enter accepts', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('');
    await editor.pressSequentially('string.');
    await expect(popup(page)).toBeVisible();

    const first = await popup(page).locator('li[data-active="true"]').textContent();
    await editor.press('ArrowDown');
    const second = await popup(page).locator('li[data-active="true"]').textContent();
    expect(second).not.toBe(first);

    await editor.press('Enter');
    await expect(popup(page)).toHaveCount(0);
    await expect(editor).toHaveValue(`string.${second}`);
  });

  test('Escape closes it and leaves the text alone', async ({ page }) => {
    await openLab(page);
    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('');
    await editor.pressSequentially('string.');
    await expect(popup(page)).toBeVisible();
    await editor.press('Escape');
    await expect(popup(page)).toHaveCount(0);
    await expect(editor).toHaveValue('string.');
  });

  test('completion sees variables the notebook just defined', async ({ page }) => {
    await openLab(page);
    await runInCell(page, 'inventory = { apples = 1, apricots = 2 }');

    const editor = codeCell(page).locator('[data-editor]');
    await editor.fill('');
    await editor.pressSequentially('inventory.ap');
    await editor.press('Control+Space');
    // both share "ap...", so the shared prefix fills in and the menu stays
    await expect(editor).toHaveValue('inventory.ap');
    await expect(popup(page).locator('li')).toHaveText(['apples', 'apricots']);
  });

  test('it works in the console as well', async ({ page }) => {
    await openLab(page);
    const input = page.locator('[data-console-input]');
    await input.fill('');
    await input.pressSequentially('table.');
    await expect(page.locator('[data-console] [data-completions]')).toBeVisible();
  });
});
