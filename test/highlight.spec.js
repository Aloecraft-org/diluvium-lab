import { test, expect } from '@playwright/test';

// Syntax highlighting, and the two things that can go wrong with an overlay
// editor: the text can drift out of alignment with the caret, or the
// tokenizer can silently eat a character.

async function openLab(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  return problems;
}

const codeCell = (page) => page.locator('.cell[data-cell-type="code"]').first();

/** Tokenize in the page, using the real module. */
const tokensFor = (page, src) => page.evaluate(async (s) => {
  const { tokenize } = await import('./src/notebook/highlight.js');
  return tokenize(s, window.lab.language).map((t) => ({ type: t.type, text: s.slice(t.start, t.end) }));
}, src);

const typesIn = async (page, src, text) =>
  (await tokensFor(page, src)).filter((t) => t.text === text).map((t) => t.type);

// ---------------------------------------------------------------------
// The invariant: the highlight is exactly the source, or the caret lies.
// ---------------------------------------------------------------------

test.describe('the highlight reproduces the source exactly', () => {
  const SAMPLES = [
    'print("hello")',
    'local x <close> = 1',
    '-- a comment\nlocal y = 2',
    '--[[ long\n comment ]] print(1)',
    '--[==[ levelled ]==]',
    '[[a long string]]',
    '[==[ nested ]] still ]==]',
    'print($"hi {name}, you are {age + 1}")',
    's = "unterminated',
    'x = 0xFF + 1e10 + .5 + 0x1p4',
    'a.b.c:d()',
    't = { [1] = "x", ["k"] = 2 }',
    'print("emoji 🌊 and 世界")',
    'a = b // c ~ d << e >> f',
    '',
    '\n\n\n',
    '   \t  leading whitespace',
    'trailing newline\n',
    '$"just an fstring"',
    '$"unclosed {expr',
    'print("]]") --[[x]]',
  ];

  for (const src of SAMPLES) {
    test(`round trips ${JSON.stringify(src.slice(0, 40))}`, async ({ page }) => {
      await openLab(page);
      const ok = await page.evaluate(async (s) => {
        const { plainTextOf, highlightToHtml } = await import('./src/notebook/highlight.js');
        // 1. the token stream covers the source exactly
        const covered = plainTextOf(s, window.lab.language);
        // 2. and so does the rendered HTML, once tags are removed
        const div = document.createElement('div');
        div.innerHTML = highlightToHtml(s, window.lab.language);
        return { covered, rendered: div.textContent };
      }, src);
      expect(ok.covered).toBe(src);
      expect(ok.rendered).toBe(src);
    });
  }
});

// ---------------------------------------------------------------------

test.describe('tokens', () => {
  test('keywords, builtins and identifiers are distinguished', async ({ page }) => {
    await openLab(page);
    const src = 'local function greet(who) print(who) end';
    expect(await typesIn(page, src, 'local')).toEqual(['keyword']);
    expect(await typesIn(page, src, 'function')).toEqual(['keyword']);
    expect(await typesIn(page, src, 'print')).toEqual(['builtin']);
    expect(await typesIn(page, src, 'greet')).toEqual(['ident']);
    expect(await typesIn(page, src, 'who')).toEqual(['ident', 'ident']);
  });

  test('a field named like a global is not coloured as one', async ({ page }) => {
    await openLab(page);
    // `t.print` is a table field; colouring it as the builtin would be a lie
    expect(await typesIn(page, 't.print = 1', 'print')).toEqual(['ident']);
    expect(await typesIn(page, 'obj:type()', 'type')).toEqual(['ident']);
  });

  test('comments swallow code, and long comments span lines', async ({ page }) => {
    await openLab(page);
    const tokens = await tokensFor(page, '-- print("not code")\nprint("code")');
    expect(tokens[0]).toEqual({ type: 'comment', text: '-- print("not code")' });
    expect(tokens.some((t) => t.type === 'builtin' && t.text === 'print')).toBe(true);

    const long = await tokensFor(page, '--[[\nstill\ncomment\n]] x = 1');
    expect(long[0].type).toBe('comment');
    expect(long[0].text).toContain('still');
  });

  test('long strings are one token at the right level', async ({ page }) => {
    await openLab(page);
    const tokens = await tokensFor(page, 'x = [==[ has ]] inside ]==]');
    const str = tokens.find((t) => t.type === 'string');
    expect(str.text).toBe('[==[ has ]] inside ]==]');
  });

  test('f-string interpolation is highlighted as the code it is', async ({ page }) => {
    await openLab(page);
    const tokens = await tokensFor(page, '$"total: {count + 1}"');
    // the `$"` prefix, the literal, the braces, and real tokens between them
    expect(tokens[0]).toEqual({ type: 'string-prefix', text: '$"' });
    expect(tokens.some((t) => t.type === 'interp-brace' && t.text === '{')).toBe(true);
    expect(tokens.some((t) => t.type === 'interp-brace' && t.text === '}')).toBe(true);
    expect(tokens.some((t) => t.type === 'number' && t.text === '1')).toBe(true);
    expect(tokens.some((t) => t.type === 'ident' && t.text === 'count')).toBe(true);
  });

  test('numbers in every Lua spelling', async ({ page }) => {
    await openLab(page);
    for (const n of ['42', '0xFF', '1e10', '3.14', '.5', '0x1p4', '1E-3']) {
      const tokens = await tokensFor(page, `x = ${n}`);
      expect(tokens.find((t) => t.type === 'number')?.text, `for ${n}`).toBe(n);
    }
  });
});

// ---------------------------------------------------------------------
// The overlay. If these two boxes measure differently, every glyph past
// the difference sits somewhere other than the caret that types it.
// ---------------------------------------------------------------------

test.describe('the overlay lines up with the textarea', () => {
  test('the highlight and the textarea agree on layout', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    const editor = cell.locator('[data-editor]');
    // long enough to wrap, and tall enough to have several lines
    await editor.fill(
      'local sentence = "a fairly long line that should wrap somewhere in the middle of the editor box"\n'
      + 'for i = 1, 10 do print(i, sentence) end\n'
      + 'local another = { alpha = 1, beta = 2 }');

    const metrics = await cell.evaluate((node) => {
      const ta = node.querySelector('[data-editor]');
      const pre = node.querySelector('.editor-highlight');
      const a = ta.getBoundingClientRect();
      const b = pre.getBoundingClientRect();
      const sa = getComputedStyle(ta);
      const sb = getComputedStyle(pre);
      return {
        box: { dx: Math.abs(a.left - b.left), dy: Math.abs(a.top - b.top),
               dw: Math.abs(a.width - b.width) },
        font: [sa.fontFamily === sb.fontFamily, sa.fontSize === sb.fontSize,
               sa.lineHeight === sb.lineHeight, sa.letterSpacing === sb.letterSpacing,
               sa.paddingLeft === sb.paddingLeft, sa.paddingTop === sb.paddingTop,
               sa.borderLeftWidth === sb.borderLeftWidth, sa.borderTopWidth === sb.borderTopWidth,
               sa.whiteSpace === sb.whiteSpace, sa.tabSize === sb.tabSize],
        // the decisive one: identical text in identical boxes wraps the same
        scrollHeight: [ta.scrollHeight, pre.scrollHeight],
        scrollWidth: [ta.scrollWidth, pre.scrollWidth],
      };
    });

    expect(metrics.font).toEqual(new Array(10).fill(true));
    expect(metrics.box.dx).toBeLessThan(0.5);
    expect(metrics.box.dy).toBeLessThan(0.5);
    expect(metrics.box.dw).toBeLessThan(0.5);
    expect(Math.abs(metrics.scrollHeight[0] - metrics.scrollHeight[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.scrollWidth[0] - metrics.scrollWidth[1])).toBeLessThanOrEqual(1);
  });

  test('the overlay text tracks what is typed', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('local pending = 1');
    await expect(cell.locator('.editor-highlight')).toHaveText('local pending = 1');
    await expect(cell.locator('.editor-highlight .tok-keyword').first()).toHaveText('local');

    await cell.locator('[data-editor]').fill('print("changed")');
    await expect(cell.locator('.editor-highlight')).toHaveText('print("changed")');
  });

  test('the textarea keeps its text, so copy and screen readers still work', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('local visible = true');
    await expect(cell.locator('[data-editor]')).toHaveValue('local visible = true');
    // the caret is ours even though the glyphs are not
    const caret = await cell.locator('[data-editor]').evaluate((n) => getComputedStyle(n).caretColor);
    expect(caret).not.toBe('transparent');
  });

  test('markdown cells are not tokenized as Lua', async ({ page }) => {
    await openLab(page);
    await page.locator('[data-toolbar="add-markdown"]').click();
    const md = page.locator('.cell[data-cell-type="markdown"]').last();
    await md.locator('[data-editor]').fill('This sentence has for and end and local in it.');
    await expect(md.locator('.editor-highlight')).toHaveCount(0);
  });

  test('the console input is highlighted too', async ({ page }) => {
    await openLab(page);
    await page.locator('[data-console-input]').fill('for i = 1, 3 do print(i) end');
    await expect(page.locator('[data-console] .editor-highlight .tok-keyword').first()).toHaveText('for');
  });

  test('running a console line clears the highlight with the input', async ({ page }) => {
    await openLab(page);
    await page.locator('[data-console-input]').fill('print("cleared")');
    await page.locator('[data-console-input]').press('Enter');
    await expect(page.locator('[data-console-stream="stdout"]')).toContainText('cleared');
    // programmatic .value writes fire no input event; the overlay must
    // still have been repainted
    await expect(page.locator('[data-console] .editor-highlight')).toHaveText('');
  });
});

// ---------------------------------------------------------------------

test.describe('the keyword set comes from the kernel', () => {
  test('the running build reports its own reserved words', async ({ page }) => {
    await openLab(page);
    const language = await page.evaluate(() => window.lab.language);

    // 5.4.7 reserves exactly stock Lua 5.4's 22 words -- measured, not assumed
    expect(language.keywords).toContain('local');
    expect(language.keywords).toContain('goto');
    expect(language.keywords).toHaveLength(22);
    // and does not reserve the 5.5 additions, so they must not be coloured
    expect(language.keywords).not.toContain('switch');
    expect(language.version).toContain('diluvium');

    expect(language.globals).toContain('print');
    expect(language.globals).toContain('string');
  });

  test('a word this build does not reserve is an ordinary identifier', async ({ page }) => {
    await openLab(page);
    expect(await typesIn(page, 'switch = 1', 'switch')).toEqual(['ident']);
  });
});
