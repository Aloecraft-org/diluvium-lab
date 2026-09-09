import { test, expect } from '@playwright/test';
import { viaControl, dismissLauncher } from './chrome.js';

// Syntax highlighting, and the two things that can go wrong with an overlay
// editor: the text can drift out of alignment with the caret, or the
// tokenizer can silently eat a character.

async function openLab(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
  await dismissLauncher(page);
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
    // The 5.5 forms. These round trip whether or not the running build
    // has them: a form the build lacks is scanned as the operators and
    // identifiers it is there, and either way every character comes back.
    '`(\\d{4})-(\\d{2})-(\\d{2})`',
    '`a``b`',
    'x = `unterminated\nprint(1)',
    '$"total: ${amount::%.2f}"',
    '$"[{qty::%-10s}]"',
    'x = 1_000_000 + 0b1010',
    'n += 1 s ..= "x" k //= 2',
    'a = b?.c ?? d?[1]',
    '~function hidden(s) return s end',
    'map(xs, |x| x * 2)',
    'local thunk = || compute()',
    'local m = a | b',
    'function price(qty, rate) <deterministic> return qty * rate end',
    'function deposit(amt) @balance += amt return @:self() end',
    'local t = {...defaults, ...overrides}',
    'local function g(...) return ... end',
    'const RATE = 0.05d',
    'name = users?[id]?:display()',
    'xs[2:5]',
    'local a = xs[3:] local b = xs[:2]',
    'local v = t[obj:method()]',
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
    await viaControl(page, 'add-markdown');
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
// The overlay makes the textarea's own text transparent, which means the
// caret and the selection have to be given real colours explicitly. Both
// were briefly defined as `currentColor` -- which, inside that textarea, is
// transparent. The editor looked perfect and could not be typed in.
//
// Computed styles catch the definition; pixels catch the result. Both are
// here because either alone would have missed something.
// ---------------------------------------------------------------------

/**
 * Alpha of a computed colour, resolved by the browser rather than parsed.
 *
 * getComputedStyle returns `rgb()`, `rgba()` or `color(srgb ... / a)`
 * depending on the value and the property, and a regex over all three is
 * how you end up reading the blue channel of `rgb(0, 0, 0)` as the alpha
 * and calling a perfectly visible caret invisible.
 */
const alphaOf = (page, css) => page.evaluate((value) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data[3] / 255;
}, css);

test.describe('the caret and the selection survive the transparent text', () => {
  for (const [what, selector] of [
    ['a code cell', '.cell[data-cell-type="code"] [data-editor]'],
    ['the console input', '[data-console-input]'],
  ]) {
    test(`${what} has a visible caret`, async ({ page }) => {
      await openLab(page);
      const styles = await page.locator(selector).first().evaluate((n) => {
        const cs = getComputedStyle(n);
        return { color: cs.color, caretColor: cs.caretColor };
      });
      // The text is transparent on purpose ...
      expect(await alphaOf(page, styles.color)).toBe(0);
      // ... which is exactly why the caret may not inherit from it.
      expect(await alphaOf(page, styles.caretColor)).toBeGreaterThan(0);
    });

    test(`${what} has a visible, translucent selection`, async ({ page }) => {
      await openLab(page);
      const sel = await page.locator(selector).first().evaluate((n) => {
        const s = getComputedStyle(n, '::selection');
        return { background: s.backgroundColor, color: s.color };
      });
      const alpha = await alphaOf(page, sel.background);
      expect(alpha).toBeGreaterThan(0);
      // Opaque would hide the very text being selected, since the
      // rectangle is painted above the highlighted <pre>.
      expect(alpha).toBeLessThan(1);
      // And the selected glyphs stay transparent, or they double up with
      // the ones showing through from behind.
      expect(await alphaOf(page, sel.color)).toBe(0);
    });
  }

  test('selecting text visibly tints the region it selects', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    const editor = cell.locator('[data-editor]');
    await editor.fill('local greeting = "select me"\nprint(greeting, 42)');

    const box = await cell.boundingBox();
    const clip = { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 120) };

    await editor.click();
    const unselected = await page.screenshot({ clip });
    await editor.press('Control+a');
    const selected = await page.screenshot({ clip });

    // "the images differ" is not enough: a transparent selection still
    // moves some pixels, and that version of this test passed on the
    // broken build. Counting them separates the two cleanly -- measured
    // at 10.5% of the clip with the selection working and 2.8% with it
    // transparent, so the threshold below sits between the two.
    const diff = await page.evaluate(async ([a, b]) => {
      const load = (base64) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.src = `data:image/png;base64,${base64}`;
      });
      const [imageA, imageB] = await Promise.all([load(a), load(b)]);
      const canvas = document.createElement('canvas');
      canvas.width = imageA.width;
      canvas.height = imageA.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(imageA, 0, 0);
      const pixelsA = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(imageB, 0, 0);
      const pixelsB = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

      let changed = 0;
      for (let i = 0; i < pixelsA.length; i += 4) {
        const delta = Math.abs(pixelsA[i] - pixelsB[i])
          + Math.abs(pixelsA[i + 1] - pixelsB[i + 1])
          + Math.abs(pixelsA[i + 2] - pixelsB[i + 2]);
        if (delta > 12) changed++;
      }
      return { changed, total: pixelsA.length / 4 };
    }, [unselected.toString('base64'), selected.toString('base64')]);

    expect(diff.changed / diff.total).toBeGreaterThan(0.06);
  });

  test('the caret is actually painted', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    const editor = cell.locator('[data-editor]');
    await editor.fill('local x = 1');
    await editor.click();
    await editor.press('End');

    const box = await cell.boundingBox();
    const clip = { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 100) };

    // caret: 'initial' matters -- Playwright hides the caret by default for
    // stable screenshots, which would make this pass on a broken editor.
    const frames = [];
    for (let i = 0; i < 16; i++) {
      frames.push((await page.screenshot({ clip, caret: 'initial' })).toString('base64'));
      await page.waitForTimeout(90);
    }
    // A blinking caret means the frames cannot all be identical.
    expect(new Set(frames).size).toBeGreaterThan(1);
  });

  test('the caret follows the theme rather than being pinned to black', async ({ page }) => {
    await openLab(page);
    const read = () => codeCell(page).locator('[data-editor]')
      .evaluate((n) => getComputedStyle(n).caretColor);

    await page.emulateMedia({ colorScheme: 'light' });
    const light = await read();
    await page.emulateMedia({ colorScheme: 'dark' });
    const dark = await read();

    expect(await alphaOf(page, light)).toBeGreaterThan(0);
    expect(await alphaOf(page, dark)).toBeGreaterThan(0);
    // A hardcoded colour would be invisible in one theme or the other.
    expect(dark).not.toBe(light);
  });
});

// ---------------------------------------------------------------------

test.describe('the keyword set comes from the kernel', () => {
  test('the running build reports its own reserved words', async ({ page }) => {
    await openLab(page);
    const language = await page.evaluate(() => window.lab.language);

    // The pinned 5.5.1 build: stock Lua's 22 reserved words plus six
    // contextual ones. Measured, not assumed -- and a count rather than a
    // spot check, because the failure this guards against is a probe that
    // quietly stops finding things.
    //
    // It was four until `case` and `default` got snippets of their own.
    // They are as contextual as `switch` is and had been sitting in
    // `switch x do case 1 then ... end` uncoloured, because the only
    // probe that could see them is one that compiles a switch body.
    expect(language.keywords).toContain('local');
    expect(language.keywords).toContain('goto');
    expect(language.keywords).toHaveLength(28);
    for (const word of ['switch', 'case', 'default', 'defer', 'with', 'global']) {
      expect(language.keywords, `${word} should be a 5.5 keyword`).toContain(word);
    }
    // A word nothing reserves stays an identifier, which is what stops
    // the candidate list from simply colouring everything it asks about.
    expect(language.keywords).not.toContain('fallthrough');
    expect(language.keywords).not.toContain('async');
    expect(language.version).toContain('diluvium');

    expect(language.globals).toContain('print');
    expect(language.globals).toContain('string');
  });

  test('a word this build does not reserve is an ordinary identifier', async ({ page }) => {
    await openLab(page);
    expect(await typesIn(page, 'fallthrough = 1', 'fallthrough')).toEqual(['ident']);
  });

  test('the contextual keywords were found by the second probe, not the first', async ({ page }) => {
    await openLab(page);
    // `switch` is a keyword here *and* a legal variable name, which is
    // the whole point of a contextual keyword and the reason the
    // identifier probe cannot see it. If this ever compiles-and-is-absent
    // the snippet probe has stopped working; if it fails to compile, the
    // build hard-reserved the word and the first probe would have caught
    // it anyway.
    const asName = await page.evaluate(async () => {
      const { executeCollected } = await import('./src/kernel/kernel.js');
      return executeCollected(window.lab.kernel, 'local switch = 1 return switch');
    });
    expect(asName.status).toBe('ok');
    expect(asName.result).toBe('1');
    expect(await page.evaluate(() => window.lab.language.keywords)).toContain('switch');
    expect(await typesIn(page, 'switch x do end', 'switch')).toEqual(['keyword']);
  });
});


// ---------------------------------------------------------------------
// The forms past stock Lua.
//
// Each one is behind a name the *running kernel* was asked to compile, so
// these tests come in two halves: what the tokenizer does when a form is
// switched on, and what the page does with the build it actually has.
// The second half is the one that matters -- it is what stops a form
// drafted ahead of the compiler from colouring source that will not run.
// ---------------------------------------------------------------------

/** Tokenize with every form this file knows switched on. */
const tokensWithAll = (page, src) => page.evaluate(async (s) => {
  const { tokenize, SYNTAX_FORMS } = await import('./src/notebook/highlight.js');
  const options = { ...window.lab.language, syntax: SYNTAX_FORMS };
  return tokenize(s, options).map((t) => ({ type: t.type, text: s.slice(t.start, t.end) }));
}, src);

const oneOf = async (page, src, type) =>
  (await tokensWithAll(page, src)).filter((t) => t.type === type).map((t) => t.text);

test.describe('the forms past stock Lua, switched on', () => {
  test('a regex literal is one token, and a doubled backtick does not close it', async ({ page }) => {
    await openLab(page);
    expect(await oneOf(page, 'local ymd = `(\\d{4})-(\\d{2})`', 'regex'))
      .toEqual(['`(\\d{4})-(\\d{2})`']);
    expect(await oneOf(page, 'local t = `a``b`', 'regex')).toEqual(['`a``b`']);
  });

  test('an unterminated regex stops at the line rather than eating the file', async ({ page }) => {
    await openLab(page);
    const tokens = await tokensWithAll(page, 'x = `oops\nprint(1)');
    expect(tokens.find((t) => t.type === 'regex').text).toBe('`oops');
    // the next line is still code
    expect(tokens.some((t) => t.type === 'builtin' && t.text === 'print')).toBe(true);
  });

  test('an apostrophe inside a regex is pattern, not the start of a string', async ({ page }) => {
    await openLab(page);
    // Without the literal this scans as a `'` opening a string that runs
    // to the end of the line, which is the visible bug it fixes.
    const tokens = await tokensWithAll(page, "x = `it's` print(1)");
    expect(tokens.find((t) => t.type === 'regex').text).toBe("`it's`");
    expect(tokens.some((t) => t.type === 'builtin' && t.text === 'print')).toBe(true);
  });

  test('a format spec is not code', async ({ page }) => {
    await openLab(page);
    // `%-10s` tokenized as Lua is an operator, a number and an
    // identifier, and it is none of those -- it goes to string.format.
    expect(await oneOf(page, '$"[{name::%-10s}]"', 'format-spec')).toEqual(['::%-10s']);
    expect(await oneOf(page, '$"{pi::%.2f}"', 'format-spec')).toEqual(['::%.2f']);
    // A single colon is still a method call, and stays code.
    const method = await tokensWithAll(page, '$"{obj:name()}"');
    expect(method.some((t) => t.type === 'format-spec')).toBe(false);
    expect(method.some((t) => t.type === 'ident' && t.text === 'name')).toBe(true);
  });

  test('the dollar before an interpolation is literal text', async ({ page }) => {
    await openLab(page);
    // `$"total: ${t::%.2f}"` prints a dollar sign; only the `$"` opens.
    const tokens = await tokensWithAll(page, '$"total: ${t::%.2f}"');
    expect(tokens[0]).toEqual({ type: 'string-prefix', text: '$"' });
    expect(tokens[1]).toEqual({ type: 'string', text: 'total: $' });
  });

  test('separators and binary literals are part of the number', async ({ page }) => {
    await openLab(page);
    expect(await oneOf(page, 'x = 1_000_000', 'number')).toEqual(['1_000_000']);
    expect(await oneOf(page, 'x = 0b1010', 'number')).toEqual(['0b1010']);
    expect(await oneOf(page, 'x = 0xFF_FF', 'number')).toEqual(['0xFF_FF']);
    // The underscore has to sit between digits, or `x = 1` next to `_G`
    // would be one token.
    expect(await oneOf(page, 'x = 1 _G', 'number')).toEqual(['1']);
  });

  test('lambdas, and the bitwise or they have to be told apart from', async ({ page }) => {
    await openLab(page);
    // Both bars belong to the lambda; the parameters between are ordinary.
    expect(await oneOf(page, 'map(xs, |x| x * 2)', 'lambda-bar')).toEqual(['|', '|']);
    expect(await oneOf(page, 'sort(t, |a, b| a.score > b.score)', 'lambda-bar')).toEqual(['|', '|']);
    expect(await oneOf(page, 'local thunk = || compute()', 'lambda-bar')).toEqual(['|', '|']);
    // `a | b` has a name after the bar and no closing bar, and `f(x) | y`
    // follows a `)`. Neither is a lambda and neither may be painted as one.
    expect(await oneOf(page, 'local m = a | b', 'lambda-bar')).toEqual([]);
    expect(await oneOf(page, 'local n = f(x) | y', 'lambda-bar')).toEqual([]);
  });

  test('a function attribute, and the comparison it must not swallow', async ({ page }) => {
    await openLab(page);
    expect(await oneOf(page, 'function price(q, r) <deterministic> return q end', 'attribute'))
      .toEqual(['<deterministic>']);
    // The attribute only follows a `)`, which is what the freeness
    // argument rests on and what keeps this from being one.
    expect(await oneOf(page, 'if a < b and c > d then end', 'attribute')).toEqual([]);
    expect(await oneOf(page, 'x = a<b>c', 'attribute')).toEqual([]);
  });

  test('@ is self, and the name after it is still a field', async ({ page }) => {
    await openLab(page);
    const tokens = await tokensWithAll(page, 'function deposit(amt) @balance += amt end');
    expect(tokens.filter((t) => t.type === 'self-sugar').map((t) => t.text)).toEqual(['@']);
    expect(tokens.some((t) => t.type === 'ident' && t.text === 'balance')).toBe(true);
    expect(await oneOf(page, 'return @:render()', 'self-sugar')).toEqual(['@']);
  });

  test('spread is told apart from vararg', async ({ page }) => {
    await openLab(page);
    expect(await oneOf(page, 'f(a, ...args)', 'spread')).toEqual(['...']);
    // A constructor opens and then spreads; the operator run must not
    // swallow `{...` whole.
    expect(await oneOf(page, 'local t = {...defaults, ...overrides}', 'spread'))
      .toEqual(['...', '...']);
    // A bare `...` is the vararg it has always been.
    expect(await oneOf(page, 'local function g(...) return ... end', 'spread')).toEqual([]);
  });

  test('a slice colon, and the method call it must not swallow', async ({ page }) => {
    await openLab(page);
    expect(await oneOf(page, 'local a = xs[2:4]', 'slice')).toEqual([':']);
    expect(await oneOf(page, 'local b = xs[3:]', 'slice')).toEqual([':']);
    expect(await oneOf(page, 'local c = xs[:2]', 'slice')).toEqual([':']);
    // `t[obj:method()]` is ordinary Lua and stays a method call. This is
    // the whole reason the test is not just "a colon inside brackets".
    expect(await oneOf(page, 'local v = t[obj:method()]', 'slice')).toEqual([]);
    expect(await oneOf(page, 'local w = t[f(a):g()]', 'slice')).toEqual([]);
    // and a colon that is not in an index is untouched
    expect(await oneOf(page, 'obj:method()', 'slice')).toEqual([]);
    expect(await oneOf(page, 'goto done ::done::', 'slice')).toEqual([]);
    expect(await oneOf(page, '$"{pi::%.2f}"', 'slice')).toEqual([]);
  });

  test('a literal suffix belongs to the numeral', async ({ page }) => {
    await openLab(page);
    expect(await oneOf(page, 'const RATE = 0.05d', 'number')).toEqual(['0.05d']);
    expect(await oneOf(page, 'x = 1.23d + 4', 'number')).toEqual(['1.23d', '4']);
  });

  test('the safe-navigation family, compound assignment and ~function', async ({ page }) => {
    await openLab(page);
    expect(await oneOf(page, 'a = b?.c ?? d?[1]', 'null-safe')).toEqual(['?.', '??', '?[']);
    expect(await oneOf(page, 'name = users?:display() or a?(1)', 'null-safe')).toEqual(['?:', '?(']);
    expect(await oneOf(page, 'n += 1 s ..= "x" k //= 2 m <<= 3', 'compound-assign'))
      .toEqual(['+=', '..=', '//=', '<<=']);
    expect(await oneOf(page, '~function hidden() end', 'secure')).toEqual(['~']);
    // The same characters elsewhere are the operators they have always been.
    expect(await oneOf(page, 'if a >= b and c ~= d then end', 'compound-assign')).toEqual([]);
    expect(await oneOf(page, 'x = ~y', 'secure')).toEqual([]);
  });
});

test.describe('a form is dark until the build has it', () => {
  test('the probe names and the tokenizer names are the same list', async ({ page }) => {
    await openLab(page);
    // A name in one and not the other is a form that can never light up,
    // and nothing else would say so.
    const { probed, known } = await page.evaluate(async () => {
      const [{ SYNTAX_CANDIDATES }, { SYNTAX_FORMS }] = await Promise.all([
        import('./src/kernel/lua-harness.js'),
        import('./src/notebook/highlight.js'),
      ]);
      return { probed: SYNTAX_CANDIDATES.map(([name]) => name), known: SYNTAX_FORMS };
    });
    expect([...probed].sort()).toEqual([...known].sort());
  });

  test('the running build reports the forms it actually parses', async ({ page }) => {
    await openLab(page);
    const syntax = await page.evaluate(() => window.lab.language.syntax);

    // Measured against the pinned 5.5.1_build10, not assumed. These three
    // are in it: `a?.b`, `n += 1` and `~function f() end` all compile.
    expect(syntax).toEqual(expect.arrayContaining(['optional', 'compound', 'secure']));

    // Everything else is not, and that is the point of the probe rather
    // than a version check. Regex literals land in build13; the rest are
    // session A's Tier A, B and C work. Each turns on here by the pin
    // moving, with nothing in this repository edited. When one of these
    // starts failing, the pin moved -- move the name up a line.
    for (const form of ['regex', 'separators', 'binary', 'suffix', 'optional-call',
      'spread', 'lambda', 'attribute', 'at-self', 'slice']) {
      expect(syntax, `${form} should not be in build10`).not.toContain(form);
    }
    // `?.` and `?[` are in this build and `?:` and `?(` are not, which is
    // why they are two flags: one would paint a syntax error.
    expect(syntax).toContain('optional');
  });

  test('the contextual keywords the proposals doc adds are not here yet', async ({ page }) => {
    await openLab(page);
    const keywords = await page.evaluate(() => window.lab.language.keywords);
    // Each is still an ordinary identifier on build10, so it must read as
    // one. These flip on with session A's Tier A, B and C milestones.
    for (const word of ['continue', 'const', 'export', 'class',
      'extends', 'static', 'super']) {
      expect(keywords, `${word} is not a build10 keyword`).not.toContain(word);
      expect(await typesIn(page, `${word} = 1`, word)).toEqual(['ident']);
    }
    // `case` and `default` are the exception, and they are why the whole
    // class of body-only keywords was worth probing: they shipped with
    // `switch` and the Lab had been painting them as identifiers.
    for (const word of ['switch', 'case', 'default', 'defer', 'with', 'global']) {
      expect(keywords).toContain(word);
    }
    expect(await typesIn(page, 'switch x do case 1 then end end', 'case')).toEqual(['keyword']);
  });

  test('a form this build lacks draws nothing in a cell', async ({ page }) => {
    await openLab(page);
    const cell = codeCell(page);
    await cell.locator('[data-editor]').fill('local re = `\\d+`');
    await expect(cell.locator('.editor-highlight')).toHaveText('local re = `\\d+`');
    // build10 has no regex literal, so nothing may claim to be one.
    await expect(cell.locator('.editor-highlight .tok-regex')).toHaveCount(0);
    // and the forms it does have are painted
    await cell.locator('[data-editor]').fill('count += 1');
    await expect(cell.locator('.editor-highlight .tok-compound-assign')).toHaveText('+=');
  });

  test('every probe snippet round trips through the tokenizer', async ({ page }) => {
    await openLab(page);
    // A snippet the highlighter mangles is a form whose own probe would
    // misalign the caret the moment the build grows it.
    const bad = await page.evaluate(async () => {
      const [{ SYNTAX_CANDIDATES }, { plainTextOf, SYNTAX_FORMS }] = await Promise.all([
        import('./src/kernel/lua-harness.js'),
        import('./src/notebook/highlight.js'),
      ]);
      const options = { ...window.lab.language, syntax: SYNTAX_FORMS };
      return SYNTAX_CANDIDATES
        .filter(([, snippet]) => plainTextOf(snippet, options) !== snippet)
        .map(([name]) => name);
    });
    expect(bad).toEqual([]);
  });
});
