import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

// Diluvium 5.5 rebased onto Lua 5.5, which changed the dump container out
// from under the reader: an inverted varint terminator, zigzag integer
// constants, interned strings, a relocated `source` field, aligned
// sections, and two new opcodes that shift every opcode number after
// `VARARG`.
//
// The Lab cannot compile Diluvium, and until a 5.5 kernel is published it
// cannot run one either. So these fixtures are real bytes from a real
// build: `scripts/make-bytecode-fixtures.lua`, run by a native 5.5.1
// interpreter compiled from the tag. Regenerating them is the documented
// way to re-verify against a new release; the JSON is the evidence.
//
// The 5.4 path is covered by test/bytecode.spec.js, which drives the
// vendored kernel live. Between them both containers are exercised.

const FIXTURES = JSON.parse(
  readFileSync(new URL('./fixtures/bytecode-5.5.json', import.meta.url), 'utf8'));

const named = (name) => {
  const found = FIXTURES.cases.find((c) => c.name === name);
  if (!found) throw new Error(`no fixture named ${name}`);
  return found;
};

async function openLab(page) {
  await page.addInitScript(() => indexedDB.deleteDatabase('diluvium-lab'));
  await page.goto('/');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 30_000 });
}

/** Parse in the page, so the code under test is the code the Lab ships. */
const read = (page, hex) => page.evaluate(async (h) => {
  const { readChunk, fromHex, flattenProtos } = await import('./src/analysis/luac.js');
  const { disassemble } = await import('./src/analysis/disasm.js');
  const chunk = readChunk(fromHex(h));
  return {
    header: chunk.header,
    byteLength: chunk.byteLength,
    functions: flattenProtos(chunk.main).map(({ path, proto }) => ({
      path,
      numParams: proto.numParams,
      isVararg: proto.isVararg,
      encrypted: proto.encrypted,
      source: proto.source,
      locals: proto.locals.map((l) => l.name),
      constants: proto.constants.map((c) => ({ type: c.type, value: String(c.value) })),
      upvalues: proto.upvalues.map((u) => u.name),
      ops: disassemble(proto).map((r) => r.name),
      rows: disassemble(proto),
    })),
  };
}, hex);

test.describe('the 5.5 container', () => {
  test('every fixture parses, stripped and unstripped', async ({ page }) => {
    await openLab(page);
    // readChunk throws unless the parse lands exactly on the final byte
    // and every opcode exists, so "it parsed" is a real claim about all
    // 21 cases and not just an absence of exceptions.
    for (const c of FIXTURES.cases) {
      for (const key of ['hex', 'strippedHex']) {
        const parsed = await read(page, c[key]);
        expect(parsed.header.lua, `${c.name} (${key})`).toBe('5.5');
        expect(parsed.functions.length).toBeGreaterThan(0);
      }
    }
  });

  test('the header names Lua 5.5 and the Diluvium format', async ({ page }) => {
    await openLab(page);
    const { header } = await read(page, named('empty').hex);
    expect(header.version).toBe(0x55);
    expect(header.format).toBe(0x44);
    expect(header.dialect).toBe('diluvium');
  });

  test('a version this reader does not know is refused, not guessed at', async ({ page }) => {
    await openLab(page);
    // Byte 4 is the version. 0x56 would be Lua 5.6.
    const bytes = named('empty').hex.match(/.{2}/g);
    bytes[4] = '56';
    const message = await page.evaluate(async (h) => {
      const { readChunk, fromHex } = await import('./src/analysis/luac.js');
      try { readChunk(fromHex(h)); return null; } catch (e) { return e.message; }
    }, bytes.join(''));
    expect(message).toContain('0x56');
    expect(message).toContain('5.5');
  });
});

test.describe('the 5.5 instruction set', () => {
  test('is used instead of 5.4\'s', async ({ page }) => {
    await openLab(page);
    const { functions } = await read(page, named('add').hex);
    const add = functions.find((f) => f.numParams === 2);
    expect(add.ops).toEqual(['ADD', 'MMBIN', 'RETURN1', 'RETURN0']);
  });

  test('decodes NEWTABLE and SETLIST with their narrow operands', async ({ page }) => {
    await openLab(page);
    // `{ 1, 2, 3, name = "x", other = "y" }` — 3 array slots, 2 hash.
    // In 5.5 those are a 6-bit vB and a 10-bit vC, not two 8-bit fields,
    // so reading them the 5.4 way yields plausible wrong numbers.
    const { functions } = await read(page, named('table').hex);
    const newtable = functions[0].rows.find((r) => r.name === 'NEWTABLE');
    expect(newtable.comment).toBe('3 array slots, 2 hash slots');
    const setlist = functions[0].rows.find((r) => r.name === 'SETLIST');
    expect(setlist.comment).toContain('3 values');
  });

  test('reads 64-bit integer constants exactly', async ({ page }) => {
    await openLab(page);
    // Integer constants are zigzag varints in 5.5. maxinteger zigzags to
    // 2^64 - 2, which a double rounds; this is the test that catches a
    // reader accumulating them as JS numbers.
    const { functions } = await read(page, named('big integers').hex);
    expect(functions[0].constants.map((c) => c.value)).toEqual([
      '9223372036854775807', '-9223372036854775808', '-4294967296', '4294967296',
    ]);
  });

  test('keeps floats and long strings intact', async ({ page }) => {
    await openLab(page);
    const floats = await read(page, named('floats').hex);
    expect(floats.functions[0].constants.map((c) => c.value)).toEqual(['1.5', '-0.25', '1e+308']);
    const long = await read(page, named('long string').hex);
    expect(long.functions[0].constants[0].value).toHaveLength(300);
  });

  test('resolves interned strings, including the empty one', async ({ page }) => {
    await openLab(page);
    // 5.5 writes a string once and refers to it by index afterwards, and
    // a stored size of zero now means "reuse", not "absent" — so "" has
    // to come back as "" and not as null.
    const repeated = await read(page, named('repeated strings').hex);
    expect(repeated.functions[0].constants.map((c) => c.value)).toEqual(['same']);
    const empty = await read(page, named('empty string').hex);
    expect(empty.functions[0].constants.map((c) => c.value)).toEqual(['', 'tail']);
  });

  test('keeps debug names when they are there and drops them when stripped', async ({ page }) => {
    await openLab(page);
    const kept = await read(page, named('empty string').hex);
    expect(kept.functions[0].locals).toContain('x');
    // `=fixture`, with the `=` that tells Lua to use the name verbatim
    // in error messages — stored as part of the string, so it comes back.
    expect(kept.functions[0].source).toBe('=fixture');
    const stripped = await read(page, named('empty string').strippedHex);
    expect(stripped.functions[0].locals).toEqual([]);
    expect(stripped.functions[0].source).toBeNull();
  });
});

test.describe('`~function` in 5.5', () => {
  test('scrambles its own instructions and strings, and they still decode', async ({ page }) => {
    await openLab(page);
    const { functions } = await read(page, named('secure').hex);
    const secure = functions.find((f) => f.path === 'main/0');
    expect(secure.encrypted).toBe(true);
    expect(secure.ops).toEqual(['LOADK', 'RETURN1', 'RETURN0']);
    expect(secure.constants.map((c) => c.value)).toContain('inside');
  });

  test('is inherited by everything lexically inside it', async ({ page }) => {
    await openLab(page);
    const { functions } = await read(page, named('secure nested').hex);
    expect(functions.map((f) => [f.path, f.encrypted])).toEqual([
      ['main', false], ['main/0', true], ['main/0/0', true],
    ]);
  });

  test('is opt-in — a chunk with no `~` has no secure functions', async ({ page }) => {
    await openLab(page);
    // This is the 5.4.7 behaviour that is gone. There, the first nested
    // function and its subtree were marked whether or not anyone asked,
    // because `ls->encrypted_flag` started life set. 5.5 initialises it.
    const { functions } = await read(page, named('no tilde anywhere').hex);
    expect(functions.map((f) => f.encrypted)).toEqual([false, false, false, false]);
  });

  test('leaves siblings alone', async ({ page }) => {
    await openLab(page);
    const { functions } = await read(page, named('secure sibling').hex);
    expect(functions.map((f) => [f.path, f.encrypted])).toEqual([
      ['main', false], ['main/0', true], ['main/1', false],
    ]);
  });

  test('does not hide a literal it shares with a plain function', async ({ page }) => {
    // A finding, pinned as a test rather than as prose so that a release
    // which fixes it is noticed here.
    //
    // `dumpString` checks the saved-string table *before* it checks
    // whether it is inside a secure function, so a string already written
    // elsewhere is emitted as a bare index and the only stored copy is
    // the plain one. Since a function's own constants are dumped before
    // its nested protos, any literal shared with the enclosing function
    // is always the plain copy. Correct on load, and weaker than the
    // feature reads.
    const inSecureOnly = named('secure sibling');
    const shared = named('secure shared literal');
    const plainBytes = (c) => Buffer.from(c.hex, 'hex').toString('latin1');

    expect(plainBytes(inSecureOnly)).not.toContain('secure-only-literal');
    expect(plainBytes(shared)).toContain('shared-secret');
  });
});

test.describe('both dialects at once', () => {
  test('a live 5.4 chunk and a 5.5 fixture both read, each with its own opcode table', async ({ page }) => {
    await openLab(page);
    // The vendored kernel is 5.4.7, so this is a real 5.4 chunk made in
    // the page next to a real 5.5 chunk made by the native build.
    const live = await page.evaluate(() => window.lab.kernel.dumpBytecode('return function() end', { strip: true }));
    const from54 = await read(page, live);
    const from55 = await read(page, named('empty').hex);

    expect(from54.header.lua).toBe('5.4');
    expect(from55.header.lua).toBe('5.5');
    expect(from54.functions.at(-1).ops).toEqual(['RETURN0']);
    expect(from55.functions[0].ops).toContain('RETURN');
  });

  test('opcode 32 means different things in each, and the reader knows which', async ({ page }) => {
    await openLab(page);
    // SHRI and SHLI swapped places between 5.4 and 5.5. Nothing in a
    // chunk marks which set it used except the version byte, so this is
    // exactly the failure mode a single shared table would produce.
    const names = await page.evaluate(async () => {
      const { INSTRUCTION_SETS } = await import('./src/analysis/opcodes.js');
      return {
        v54: INSTRUCTION_SETS[0x54].opcodes[32].name,
        v55: INSTRUCTION_SETS[0x55].opcodes[32].name,
        count54: INSTRUCTION_SETS[0x54].opcodes.length,
        count55: INSTRUCTION_SETS[0x55].opcodes.length,
      };
    });
    expect(names).toEqual({ v54: 'SHRI', v55: 'SHLI', count54: 83, count55: 85 });
  });
});
