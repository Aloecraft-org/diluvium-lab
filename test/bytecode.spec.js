import { test, expect } from '@playwright/test';

// The disassembler.
//
// The container format was reverse engineered from the shipped artifact,
// so these tests are the evidence that the reading is right rather than
// merely plausible. Three independent checks:
//
//   1. the parse ends exactly on the last byte (readChunk enforces it),
//   2. every opcode decodes to one that exists,
//   3. the instructions agree with what the compiler is known to emit.
//
// If a future build changes the encoding, these fail loudly. That is the
// point: a disassembly that looks right and is not would be worse than no
// disassembler at all.

async function openLab(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  return problems;
}

/** Compile in the page and disassemble with the real modules. */
const analyse = (page, source, options = {}) => page.evaluate(async ([src, opts]) => {
  const { readChunk, fromHex, flattenProtos } = await import('./src/analysis/luac.js');
  const { disassemble } = await import('./src/analysis/disasm.js');
  const hex = await window.lab.kernel.dumpBytecode(src, opts);
  const chunk = readChunk(fromHex(hex));
  return {
    header: chunk.header,
    byteLength: chunk.byteLength,
    functions: flattenProtos(chunk.main).map(({ path, proto }) => ({
      path,
      numParams: proto.numParams,
      isVararg: proto.isVararg,
      obfuscated: proto.obfuscated,
      constants: proto.constants.map((c) => ({ type: c.type, value: String(c.value) })),
      upvalues: proto.upvalues.map((u) => u.name),
      ops: disassemble(proto).map((r) => r.name),
      rows: disassemble(proto),
    })),
  };
}, [source, options]);

const codeCell = (page) => page.locator('.cell[data-cell-type="code"]').first();

test.describe('the container', () => {
  test('is Lua 5.4 with Diluvium\'s own format byte', async ({ page }) => {
    await openLab(page);
    const { header } = await analyse(page, 'return 1', { strip: true });
    expect(header.version).toBe(0x54);
    // 0x44 is 'D'. Stock Lua writes 0 here and refuses anything else, so
    // this is a deliberate compatibility fence, not decoration.
    expect(header.format).toBe(0x44);
    expect(header.dialect).toBe('diluvium');
    expect(header.sizeInstruction).toBe(4);
  });

  test('a chunk that is not compiled Lua is refused', async ({ page }) => {
    await openLab(page);
    const message = await page.evaluate(async () => {
      const { readChunk } = await import('./src/analysis/luac.js');
      try { readChunk(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])); return null; } catch (e) { return e.message; }
    });
    expect(message).toContain('not compiled Lua');
  });

  test('truncated bytecode is refused rather than half-read', async ({ page }) => {
    await openLab(page);
    const message = await page.evaluate(async () => {
      const { readChunk, fromHex } = await import('./src/analysis/luac.js');
      const hex = await window.lab.kernel.dumpBytecode('return 1', { strip: true });
      const bytes = fromHex(hex).slice(0, 40);
      try { readChunk(bytes); return null; } catch (e) { return e.message; }
    });
    expect(message).toMatch(/ends early|disagree/);
  });
});

test.describe('instructions', () => {
  test('an empty function is a single RETURN0', async ({ page }) => {
    await openLab(page);
    const { functions } = await analyse(page, 'return function() end', { strip: true });
    const child = functions.find((f) => f.path !== 'main');
    expect(child.ops).toEqual(['RETURN0']);
  });

  test('a + b compiles to ADD, MMBIN and a return', async ({ page }) => {
    await openLab(page);
    const { functions } = await analyse(page, 'local function add(a, b) return a + b end', { strip: true });
    const add = functions.find((f) => f.numParams === 2);
    expect(add.ops).toEqual(['ADD', 'MMBIN', 'RETURN1', 'RETURN0']);
  });

  test('calling a global goes through GETTABUP on _ENV', async ({ page }) => {
    await openLab(page);
    const { functions } = await analyse(page, 'print("hi")');
    const main = functions[0];
    expect(main.ops).toContain('GETTABUP');
    expect(main.ops).toContain('CALL');
    expect(main.upvalues).toContain('_ENV');
  });

  test('a numeric for loop uses FORPREP and FORLOOP', async ({ page }) => {
    await openLab(page);
    const { functions } = await analyse(page, 'for i = 1, 10 do print(i) end', { strip: true });
    expect(functions[0].ops).toContain('FORPREP');
    expect(functions[0].ops).toContain('FORLOOP');
  });

  test('a tail call is visible as TAILCALL', async ({ page }) => {
    await openLab(page);
    const { functions } = await analyse(page, 'local function loop() return loop() end', { strip: true });
    const loop = functions.find((f) => f.ops.includes('TAILCALL'));
    expect(loop).toBeTruthy();
    // The hazard worth teaching: an infinite tail call never overflows,
    // it just never returns.
    const row = loop.rows.find((r) => r.name === 'TAILCALL');
    expect(row.comment).toContain('frame is reused');
  });

  test('vararg functions are marked and prepared', async ({ page }) => {
    await openLab(page);
    const { functions } = await analyse(page, 'return function(...) return ... end', { strip: true });
    const child = functions.find((f) => f.path !== 'main');
    expect(child.isVararg).toBe(true);
    expect(child.ops).toContain('VARARGPREP');
  });
});

test.describe('debug information', () => {
  test('stripping drops the names, and the panel keeps them', async ({ page }) => {
    await openLab(page);
    const kept = await analyse(page, 'local function add(a, b) return a + b end');
    const stripped = await analyse(page, 'local function add(a, b) return a + b end', { strip: true });

    // Unstripped carries parameter names and _ENV; stripped is the same
    // code with the labels removed -- which is exactly the question
    // "what does the debug information cost" made visible.
    expect(kept.functions[0].upvalues).toContain('_ENV');
    expect(stripped.functions[0].upvalues).toEqual([null]);
    expect(stripped.byteLength).toBeLessThan(kept.byteLength);

    const opsOf = (a) => a.functions.map((f) => f.ops.join(' ')).join(' | ');
    expect(opsOf(stripped)).toBe(opsOf(kept));   // same instructions either way
  });
});

test.describe('the annotations are what make it teach', () => {
  test('constants are named, not numbered', async ({ page }) => {
    await openLab(page);
    const { functions } = await analyse(page, 'print("hello")');
    const row = functions[0].rows.find((r) => r.name === 'GETTABUP');
    expect(row.comment).toBe('_ENV "print"');
  });

  test('a CLOSURE says which function it makes', async ({ page }) => {
    await openLab(page);
    const { functions } = await analyse(page, 'local f = function(a) return a end');
    const row = functions[0].rows.find((r) => r.name === 'CLOSURE');
    expect(row.comment).toContain('function 0');
    expect(row.comment).toContain('1 param');
  });

  test('a call says how many arguments and results', async ({ page }) => {
    await openLab(page);
    const { functions } = await analyse(page, 'print(1, 2)');
    const row = functions[0].rows.find((r) => r.name === 'CALL');
    expect(row.comment).toMatch(/args/);
  });
});

test.describe('hex is the transport and the format', () => {
  test('round trips through hex exactly', async ({ page }) => {
    await openLab(page);
    const same = await page.evaluate(async () => {
      const { fromHex, toHex } = await import('./src/analysis/luac.js');
      const hex = await window.lab.kernel.dumpBytecode('return 1 + 1', { strip: true });
      const bytes = fromHex(hex);
      const again = fromHex(toHex(bytes));
      return bytes.length === again.length && bytes.every((b, i) => b === again[i]);
    });
    expect(same).toBe(true);
  });

  test('pasted hex is read forgivingly', async ({ page }) => {
    await openLab(page);
    const results = await page.evaluate(async () => {
      const { fromHex } = await import('./src/analysis/luac.js');
      const want = [0x1b, 0x4c, 0x75, 0x61];
      const same = (x) => x.length === 4 && x.every((b, i) => b === want[i]);
      return {
        spaces: same(fromHex('1b 4c 75 61')),
        newlines: same(fromHex('1b4c\n7561')),
        prefixed: same(fromHex('0x1b, 0x4c, 0x75, 0x61')),
        escaped: same(fromHex('\\x1b\\x4c\\x75\\x61')),
      };
    });
    expect(results).toEqual({ spaces: true, newlines: true, prefixed: true, escaped: true });
  });

  test('bad hex says what is wrong with it', async ({ page }) => {
    await openLab(page);
    const messages = await page.evaluate(async () => {
      const { fromHex } = await import('./src/analysis/luac.js');
      const grab = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
      return {
        odd: grab(() => fromHex('1b4')),
        junk: grab(() => fromHex('1b zz')),
        empty: grab(() => fromHex('   ')),
      };
    });
    expect(messages.odd).toMatch(/odd number/);
    expect(messages.junk).toMatch(/not a hex digit/);
    expect(messages.empty).toMatch(/no hex/);
  });
});

test.describe('the panel', () => {
  test('opens from the cell and shows the disassembly', async ({ page }) => {
    const problems = await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('print("in the panel")');
    await cell.locator('[data-action="bytecode"]').click();

    const panel = cell.locator('[data-bytecode]');
    await expect(panel).toHaveAttribute('data-state', 'ready');
    await expect(panel.locator('[data-bc-summary]')).toContainText('diluvium');
    await expect(panel.locator('.bc-op').first()).toBeVisible();
    await expect(panel).toContainText('GETTABUP');
    await expect(panel).toContainText('_ENV "print"');
    expect(problems).toEqual([]);
  });

  test('compiling does not run the cell', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    // If this ran, the global would exist afterwards.
    await cell.locator('[data-editor]').fill('sideEffect = "should not happen"');
    await cell.locator('[data-action="bytecode"]').click();
    await expect(cell.locator('[data-bytecode]')).toHaveAttribute('data-state', 'ready');

    const value = await page.evaluate(async () => {
      const messages = await window.lab.executeCollectMessages('print(tostring(sideEffect))');
      return messages.filter((m) => m.msg_type === 'stream').map((m) => m.content.text).join('');
    });
    expect(value).toBe('nil\n');
  });

  test('the hex tab shows bytes starting with the Lua signature', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('return 1');
    await cell.locator('[data-action="bytecode"]').click();
    await cell.locator('[data-bc-tab="hex"]').click();
    await expect(cell.locator('[data-bc-hex]')).toContainText('1b 4c 75 61 54 44');
  });

  test('hex can be pasted back in and read', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('print("original")');
    await cell.locator('[data-action="bytecode"]').click();

    // Take the bytes of a *different* program and read them in.
    const otherHex = await page.evaluate(() =>
      window.lab.kernel.dumpBytecode('for i = 1, 3 do end', { strip: true }));

    await cell.locator('[data-bc-tab="paste"]').click();
    await cell.locator('[data-bc-paste]').fill(otherHex);
    await cell.locator('[data-bc-action="read-hex"]').click();

    const panel = cell.locator('[data-bytecode]');
    await expect(panel).toHaveAttribute('data-state', 'ready');
    await expect(panel).toContainText('FORPREP');
    await expect(panel).not.toContainText('original');
  });

  test('nonsense pasted in is refused with a reason', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('return 1');
    await cell.locator('[data-action="bytecode"]').click();
    await cell.locator('[data-bc-tab="paste"]').click();
    await cell.locator('[data-bc-paste]').fill('de ad be ef');
    await cell.locator('[data-bc-action="read-hex"]').click();

    await expect(cell.locator('[data-bytecode]')).toHaveAttribute('data-state', 'error');
    await expect(cell.locator('[data-bytecode-error]')).toContainText('not compiled Lua');
  });

  test('a cell that does not compile says so', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('this is not lua');
    await cell.locator('[data-action="bytecode"]').click();
    await expect(cell.locator('[data-bytecode]')).toHaveAttribute('data-state', 'error');
    await expect(cell.locator('[data-bytecode-error]')).toContainText('Could not compile');
  });

  test('the panel closes again', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('return 1');
    await cell.locator('[data-action="bytecode"]').click();
    await expect(cell.locator('[data-bytecode]')).toBeVisible();
    await cell.locator('[data-action="bytecode"]').click();
    await expect(cell.locator('[data-bytecode]')).toBeHidden();
  });
});
