// The Diluvium instruction set — both of them.
//
// Diluvium 5.4.x emits Lua 5.4's 83 opcodes; Diluvium 5.5.x emits Lua
// 5.5's 85. They are not a superset and a subset: two opcodes were
// inserted before the end, `SHLI` and `SHRI` swapped places, and
// `NEWTABLE` and `SETLIST` changed operand layout. So opcode 32 is `SHRI`
// in one dialect and `SHLI` in the other, and a reader that guesses wrong
// produces a disassembly that looks entirely plausible and is wrong.
//
// Hence: no default instruction set anywhere in this file. `decodeInstruction`
// takes the set as an argument, `readChunk` picks it from the version byte
// in the header, and there is no code path that decodes a word without
// having read that byte first.
//
// Both tables were generated from the shipped source (`lopcodes.h`'s enum
// paired with `lopcodes.c`'s `luaP_opmodes`) rather than transcribed, and
// the round-trip tests in test/bytecode.spec.js check real dumps against
// them.
//
// Instruction layout (lopcodes.h):
//
//   iABC   op:7  A:8  k:1  B:8   C:8
//   ivABC  op:7  A:8  k:1  vB:6  vC:10      (5.5 only)
//   iABx   op:7  A:8  Bx:17
//   iAsBx  op:7  A:8  sBx:17 biased by 65535
//   iAx    op:7  Ax:25
//   isJ    op:7  sJ:25 biased by 16777215

export const FORMAT = {
  ABC: 'iABC', vABC: 'ivABC', ABx: 'iABx', AsBx: 'iAsBx', Ax: 'iAx', sJ: 'isJ',
};

export const OFFSET_sBx = 65535;
export const OFFSET_sJ = 16777215;

const { ABC, vABC, ABx, AsBx, Ax, sJ } = FORMAT;

/** Lua 5.4: 83 opcodes. Diluvium 5.4.x. */
const OPCODES_54 = [
  ['MOVE', ABC], ['LOADI', AsBx], ['LOADF', AsBx],
  ['LOADK', ABx], ['LOADKX', ABx], ['LOADFALSE', ABC],
  ['LFALSESKIP', ABC], ['LOADTRUE', ABC], ['LOADNIL', ABC],
  ['GETUPVAL', ABC], ['SETUPVAL', ABC],
  ['GETTABUP', ABC], ['GETTABLE', ABC], ['GETI', ABC], ['GETFIELD', ABC],
  ['SETTABUP', ABC], ['SETTABLE', ABC], ['SETI', ABC], ['SETFIELD', ABC],
  ['NEWTABLE', ABC], ['SELF', ABC],
  ['ADDI', ABC],
  ['ADDK', ABC], ['SUBK', ABC], ['MULK', ABC], ['MODK', ABC],
  ['POWK', ABC], ['DIVK', ABC], ['IDIVK', ABC],
  ['BANDK', ABC], ['BORK', ABC], ['BXORK', ABC],
  ['SHRI', ABC], ['SHLI', ABC],
  ['ADD', ABC], ['SUB', ABC], ['MUL', ABC], ['MOD', ABC],
  ['POW', ABC], ['DIV', ABC], ['IDIV', ABC],
  ['BAND', ABC], ['BOR', ABC], ['BXOR', ABC], ['SHL', ABC], ['SHR', ABC],
  ['MMBIN', ABC], ['MMBINI', ABC], ['MMBINK', ABC],
  ['UNM', ABC], ['BNOT', ABC], ['NOT', ABC], ['LEN', ABC],
  ['CONCAT', ABC], ['CLOSE', ABC], ['TBC', ABC],
  ['JMP', sJ],
  ['EQ', ABC], ['LT', ABC], ['LE', ABC],
  ['EQK', ABC], ['EQI', ABC], ['LTI', ABC], ['LEI', ABC],
  ['GTI', ABC], ['GEI', ABC],
  ['TEST', ABC], ['TESTSET', ABC],
  ['CALL', ABC], ['TAILCALL', ABC],
  ['RETURN', ABC], ['RETURN0', ABC], ['RETURN1', ABC],
  ['FORLOOP', ABx], ['FORPREP', ABx],
  ['TFORPREP', ABx], ['TFORCALL', ABC], ['TFORLOOP', ABx],
  ['SETLIST', ABC],
  ['CLOSURE', ABx],
  ['VARARG', ABC], ['VARARGPREP', ABC],
  ['EXTRAARG', Ax],
];

/**
 * Lua 5.5: 85 opcodes. Diluvium 5.5.x.
 *
 * Differences from 5.4, all of which move opcode numbers:
 *   - `SHLI` and `SHRI` are swapped (32/33).
 *   - `NEWTABLE` (19) and `SETLIST` (78) are `ivABC`: a 6-bit vB and a
 *     10-bit vC in place of two 8-bit operands.
 *   - `GETVARG` (81) and `ERRNNIL` (82) are new, inserted between
 *     `VARARG` and `VARARGPREP`, so everything after `VARARG` shifts.
 */
const OPCODES_55 = [
  ['MOVE', ABC], ['LOADI', AsBx], ['LOADF', AsBx],
  ['LOADK', ABx], ['LOADKX', ABx], ['LOADFALSE', ABC],
  ['LFALSESKIP', ABC], ['LOADTRUE', ABC], ['LOADNIL', ABC],
  ['GETUPVAL', ABC], ['SETUPVAL', ABC],
  ['GETTABUP', ABC], ['GETTABLE', ABC], ['GETI', ABC], ['GETFIELD', ABC],
  ['SETTABUP', ABC], ['SETTABLE', ABC], ['SETI', ABC], ['SETFIELD', ABC],
  ['NEWTABLE', vABC], ['SELF', ABC],
  ['ADDI', ABC],
  ['ADDK', ABC], ['SUBK', ABC], ['MULK', ABC], ['MODK', ABC],
  ['POWK', ABC], ['DIVK', ABC], ['IDIVK', ABC],
  ['BANDK', ABC], ['BORK', ABC], ['BXORK', ABC],
  ['SHLI', ABC], ['SHRI', ABC],
  ['ADD', ABC], ['SUB', ABC], ['MUL', ABC], ['MOD', ABC],
  ['POW', ABC], ['DIV', ABC], ['IDIV', ABC],
  ['BAND', ABC], ['BOR', ABC], ['BXOR', ABC], ['SHL', ABC], ['SHR', ABC],
  ['MMBIN', ABC], ['MMBINI', ABC], ['MMBINK', ABC],
  ['UNM', ABC], ['BNOT', ABC], ['NOT', ABC], ['LEN', ABC],
  ['CONCAT', ABC], ['CLOSE', ABC], ['TBC', ABC],
  ['JMP', sJ],
  ['EQ', ABC], ['LT', ABC], ['LE', ABC],
  ['EQK', ABC], ['EQI', ABC], ['LTI', ABC], ['LEI', ABC],
  ['GTI', ABC], ['GEI', ABC],
  ['TEST', ABC], ['TESTSET', ABC],
  ['CALL', ABC], ['TAILCALL', ABC],
  ['RETURN', ABC], ['RETURN0', ABC], ['RETURN1', ABC],
  ['FORLOOP', ABx], ['FORPREP', ABx],
  ['TFORPREP', ABx], ['TFORCALL', ABC], ['TFORLOOP', ABx],
  ['SETLIST', vABC],
  ['CLOSURE', ABx],
  ['VARARG', ABC], ['GETVARG', ABC], ['ERRNNIL', ABx], ['VARARGPREP', ABC],
  ['EXTRAARG', Ax],
];

const build = (rows, lua) => ({
  lua,
  opcodes: rows.map(([name, format]) => ({ name, format })),
});

/** Keyed by the header's version byte, which is where the choice comes from. */
export const INSTRUCTION_SETS = {
  0x54: build(OPCODES_54, '5.4'),
  0x55: build(OPCODES_55, '5.5'),
};

/** The instruction set for a header version byte, or null if unknown. */
export function instructionSet(version) {
  return INSTRUCTION_SETS[version] ?? null;
}

/** Opcodes whose k flag means "B (or C) is a constant index". Same in both. */
export const K_SELECTS_CONSTANT = new Set([
  'GETFIELD', 'SETFIELD', 'GETTABUP', 'SETTABUP', 'SELF',
  'ADDK', 'SUBK', 'MULK', 'MODK', 'POWK', 'DIVK', 'IDIVK', 'BANDK', 'BORK', 'BXORK',
  'EQK', 'MMBINK',
]);

/**
 * One 32-bit word, taken apart against a given instruction set.
 *
 * `set` is required. Decoding a word without knowing which dialect wrote
 * it is the single easiest way to produce confident nonsense here.
 */
export function decodeInstruction(word, set) {
  const opcode = word & 0x7f;
  const entry = set.opcodes[opcode] ?? { name: `UNKNOWN_${opcode}`, format: FORMAT.ABC };
  const A = (word >>> 7) & 0xff;
  const k = (word >>> 15) & 0x1;

  const decoded = { opcode, name: entry.name, format: entry.format, word, A, k };

  switch (entry.format) {
    case FORMAT.vABC:
      decoded.B = (word >>> 16) & 0x3f;         // vB, 6 bits
      decoded.C = (word >>> 22) & 0x3ff;        // vC, 10 bits
      break;
    case FORMAT.ABx:
      decoded.B = (word >>> 16) & 0xff;
      decoded.C = (word >>> 24) & 0xff;
      decoded.Bx = (word >>> 15) & 0x1ffff;
      break;
    case FORMAT.AsBx:
      decoded.B = (word >>> 16) & 0xff;
      decoded.C = (word >>> 24) & 0xff;
      decoded.sBx = ((word >>> 15) & 0x1ffff) - OFFSET_sBx;
      break;
    case FORMAT.Ax:
      decoded.Ax = (word >>> 7) & 0x1ffffff;
      break;
    case FORMAT.sJ:
      decoded.sJ = ((word >>> 7) & 0x1ffffff) - OFFSET_sJ;
      break;
    default:
      decoded.B = (word >>> 16) & 0xff;
      decoded.C = (word >>> 24) & 0xff;
  }
  return decoded;
}

/** The operands that actually mean something, in luac's order. */
export function operandsOf(instruction) {
  switch (instruction.format) {
    case FORMAT.ABx: return [instruction.A, instruction.Bx];
    case FORMAT.AsBx: return [instruction.A, instruction.sBx];
    case FORMAT.Ax: return [instruction.Ax];
    case FORMAT.sJ: return [instruction.sJ];
    default: {
      const parts = [instruction.A, instruction.B, instruction.C];
      return instruction.k ? [...parts, `k=${instruction.k}`] : parts;
    }
  }
}
