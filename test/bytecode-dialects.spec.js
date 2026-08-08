import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

// Both containers, against committed dumps from real builds.
//
// Diluvium 5.5 rebased onto Lua 5.5, which changed the dump container out
// from under the reader: an inverted varint terminator, zigzag integer
// constants, interned strings, a relocated `source` field, aligned
// sections, and two new opcodes that shift every opcode number after
// `VARARG`.
//
// The Lab can only run one kernel at a time, so a suite that tested
// containers through the live kernel could only ever cover whichever one
// happened to be pinned -- and re-pinning would silently drop the other.
// Hence fixtures: `scripts/make-bytecode-fixtures.lua`, run once by a
// native interpreter built from each tag, with the bytes committed. The
// live kernel is exercised by bytecode.spec.js, whose assertions are
// deliberately dialect-agnostic.

const DIALECTS = {
  '5.4': JSON.parse(readFileSync(new URL('./fixtures/bytecode-5.4.json', import.meta.url), 'utf8')),
  '5.5': JSON.parse(readFileSync(new URL('./fixtures/bytecode-5.5.json', import.meta.url), 'utf8')),
};

const named = (dialect, name) => {
  const found = DIALECTS[dialect].cases.find((c) => c.name === name);
  if (!found) throw new Error(`no ${dialect} fixture named ${name}`);
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

const plaintext = (fixture) => Buffer.from(fixture.hex, 'hex').toString('latin1');

// --- what both dialects must do ---------------------------------------

for (const [dialect, fixtures] of Object.entries(DIALECTS)) {
  test.describe(`the ${dialect} container`, () => {
    test('every fixture parses, stripped and unstripped', async ({ page }) => {
      await openLab(page);
      // readChunk throws unless the parse lands exactly on the final byte
      // and every opcode exists, so "it parsed" is a real claim about all
      // of them and not just an absence of exceptions.
      for (const c of fixtures.cases) {
        for (const key of ['hex', 'strippedHex']) {
          const parsed = await read(page, c[key]);
          expect(parsed.header.lua, `${c.name} (${key})`).toBe(dialect);
          expect(parsed.functions.length).toBeGreaterThan(0);
        }
      }
    });

    test('the header names the dialect and the Diluvium format byte', async ({ page }) => {
      await openLab(page);
      const { header } = await read(page, named(dialect, 'empty').hex);
      expect(header.version).toBe(dialect === '5.4' ? 0x54 : 0x55);
      expect(header.format).toBe(0x44);
      expect(header.dialect).toBe('diluvium');
    });

    test('the same source compiles to the same instructions in both', async ({ page }) => {
      await openLab(page);
      const { functions } = await read(page, named(dialect, 'add').hex);
      const add = functions.find((f) => f.numParams === 2);
      expect(add.ops).toEqual(['ADD', 'MMBIN', 'RETURN1', 'RETURN0']);
    });

    test('reads 64-bit integer constants exactly', async ({ page }) => {
      await openLab(page);
      // 5.4 stores these as raw little-endian; 5.5 as zigzag varints,
      // where maxinteger becomes 2^64 - 2 and a JS number would round it.
      const { functions } = await read(page, named(dialect, 'big integers').hex);
      expect(functions[0].constants.map((c) => c.value)).toEqual([
        '9223372036854775807', '-9223372036854775808', '-4294967296', '4294967296',
      ]);
    });

    test('keeps floats, long strings and the empty string intact', async ({ page }) => {
      await openLab(page);
      const floats = await read(page, named(dialect, 'floats').hex);
      expect(floats.functions[0].constants.map((c) => c.value)).toEqual(['1.5', '-0.25', '1e+308']);
      const long = await read(page, named(dialect, 'long string').hex);
      expect(long.functions[0].constants[0].value).toHaveLength(300);
      // The awkward one in both dialects, for opposite reasons: 5.4's
      // scrambled branch stores an exact length, and 5.5 reuses a stored
      // size of zero to mean "reuse an earlier string".
      const empty = await read(page, named(dialect, 'empty string').hex);
      expect(empty.functions[0].constants.map((c) => c.value)).toEqual(['', 'tail']);
    });

    test('keeps debug names when they are there and drops them when stripped', async ({ page }) => {
      await openLab(page);
      const kept = await read(page, named(dialect, 'empty string').hex);
      expect(kept.functions[0].locals).toContain('x');
      // `=fixture`, with the `=` that tells Lua to use the name verbatim
      // in error messages -- stored as part of the string, so it comes back.
      expect(kept.functions[0].source).toBe('=fixture');
      const stripped = await read(page, named(dialect, 'empty string').strippedHex);
      expect(stripped.functions[0].locals).toEqual([]);
      expect(stripped.functions[0].source).toBeNull();
    });

    test('a `~function` scrambles its own code and strings, and they still decode', async ({ page }) => {
      await openLab(page);
      const { functions } = await read(page, named(dialect, 'secure').hex);
      const secure = functions.find((f) => f.path === 'main/0');
      expect(secure.encrypted).toBe(true);
      expect(secure.ops).toEqual(['LOADK', 'RETURN1', 'RETURN0']);
      expect(secure.constants.map((c) => c.value)).toContain('inside');
      // Really scrambled, not merely flagged.
      expect(plaintext(named(dialect, 'secure'))).not.toContain('inside');
    });

    test('secure is inherited by everything lexically inside', async ({ page }) => {
      await openLab(page);
      const { functions } = await read(page, named(dialect, 'secure nested').hex);
      expect(functions.map((f) => [f.path, f.encrypted])).toEqual([
        ['main', false], ['main/0', true], ['main/0/0', true],
      ]);
    });
  });
}

// --- where they differ, and why ---------------------------------------

test.describe('5.4.7 marks functions nobody asked it to', () => {
  test('a chunk with no `~` in it still has a secure subtree', async ({ page }) => {
    await openLab(page);
    // `~function` exists in 5.4.7 and works. What is missing is one line
    // in luaX_setinput: every other LexState field is initialised there
    // and `encrypted_flag` is not, and LexState is a stack local. So the
    // flag starts as whatever was on the stack, the first addprototype
    // consumes it, and its subtree inherits.
    //
    // Reproduced identically by the WASM build and a native build from
    // the tag, which is what makes "uninitialised" the explanation rather
    // than "some rule I have not worked out yet".
    const { functions } = await read(page, named('5.4', 'no tilde anywhere').hex);
    expect(functions.map((f) => [f.path, f.encrypted])).toEqual([
      ['main', false], ['main/0', true], ['main/0/0', true], ['main/1', false],
    ]);
  });

  test('5.5 initialises it, so the same chunk has none', async ({ page }) => {
    await openLab(page);
    const { functions } = await read(page, named('5.5', 'no tilde anywhere').hex);
    expect(functions.map((f) => f.encrypted)).toEqual([false, false, false, false]);
  });
});

test.describe('a secure function does not hide a shared literal', () => {
  // A finding, pinned as a test rather than as prose so that the release
  // which fixes it is noticed here.
  //
  // `dumpString` consults the saved-string table *before* it checks
  // whether it is inside a secure function, so a string already written
  // elsewhere is emitted as a bare index and the only stored copy is the
  // plain one. A function's own constants are dumped before its nested
  // protos, so a literal shared with the enclosing function is always the
  // plain copy. Correct on load, and weaker than the feature reads.
  test('a literal used only inside it is hidden', async ({ page }) => {
    await openLab(page);
    expect(plaintext(named('5.5', 'secure sibling'))).not.toContain('secure-only-literal');
  });

  test('a literal it shares with the enclosing chunk is not', async ({ page }) => {
    await openLab(page);
    expect(plaintext(named('5.5', 'secure shared literal'))).toContain('shared-secret');
  });
});

test.describe('the instruction sets are not interchangeable', () => {
  test('opcode 32 means different things, and the reader knows which', async ({ page }) => {
    await openLab(page);
    // SHRI and SHLI swapped places, and 5.5 inserted GETVARG and ERRNNIL
    // before VARARGPREP. Nothing in a chunk marks which set it used except
    // the version byte, so this is exactly the failure a single shared
    // table would produce: a plausible disassembly that is wrong.
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

  test('NEWTABLE and SETLIST read their operands at the right widths', async ({ page }) => {
    await openLab(page);
    // `{ 1, 2, 3, name = "x", other = "y" }` -- 3 array slots, 2 hash. In
    // 5.5 those are a 6-bit vB and a 10-bit vC rather than two 8-bit
    // fields, so reading them the 5.4 way yields plausible wrong numbers.
    for (const dialect of ['5.4', '5.5']) {
      const { functions } = await read(page, named(dialect, 'table').hex);
      const newtable = functions[0].rows.find((r) => r.name === 'NEWTABLE');
      expect(newtable.comment, dialect).toBe('3 array slots, 2 hash slots');
      const setlist = functions[0].rows.find((r) => r.name === 'SETLIST');
      expect(setlist.comment, dialect).toContain('3 values');
    }
  });

  test('a version this reader does not know is refused, not guessed at', async ({ page }) => {
    await openLab(page);
    // Byte 4 is the version. 0x56 would be Lua 5.6.
    const bytes = named('5.5', 'empty').hex.match(/.{2}/g);
    bytes[4] = '56';
    const message = await page.evaluate(async (h) => {
      const { readChunk, fromHex } = await import('./src/analysis/luac.js');
      try { readChunk(fromHex(h)); return null; } catch (e) { return e.message; }
    }, bytes.join(''));
    expect(message).toContain('0x56');
    expect(message).toContain('5.5');
  });

  test('both dialects read side by side, in the same page', async ({ page }) => {
    await openLab(page);
    const from54 = await read(page, named('5.4', 'empty').hex);
    const from55 = await read(page, named('5.5', 'empty').hex);
    expect([from54.header.lua, from55.header.lua]).toEqual(['5.4', '5.5']);
    // Same source, same meaning, different bytes.
    expect(from54.byteLength).not.toBe(from55.byteLength);
  });
});
