// The Lua 5.4 instruction set, as Diluvium emits it.
//
// Verified against the shipped artifact rather than taken from a document:
// `function() end` dumps to a single instruction whose low seven bits are
// 71, and 71 is `RETURN0` in this table. `CLOSURE` (79) and `RETURN1` (72)
// were confirmed the same way. If a future build renumbers anything, the
// round-trip test in test/bytecode.spec.js fails loudly rather than
// disassembling into plausible nonsense.
//
// Instruction layout (lopcodes.h):
//
//   iABC   op:7  A:8  k:1  B:8  C:8
//   iABx   op:7  A:8  Bx:17
//   iAsBx  op:7  A:8  sBx:17 biased by 65535
//   iAx    op:7  Ax:25
//   isJ    op:7  sJ:25 biased by 16777215

export const FORMAT = { ABC: 'iABC', ABx: 'iABx', AsBx: 'iAsBx', Ax: 'iAx', sJ: 'isJ' };

export const OFFSET_sBx = 65535;
export const OFFSET_sJ = 16777215;

/**
 * name, format, and which operands carry meaning worth annotating.
 * `k` marks opcodes whose k flag selects a constant.
 */
export const OPCODES = [
  ['MOVE', FORMAT.ABC], ['LOADI', FORMAT.AsBx], ['LOADF', FORMAT.AsBx],
  ['LOADK', FORMAT.ABx], ['LOADKX', FORMAT.ABx], ['LOADFALSE', FORMAT.ABC],
  ['LFALSESKIP', FORMAT.ABC], ['LOADTRUE', FORMAT.ABC], ['LOADNIL', FORMAT.ABC],
  ['GETUPVAL', FORMAT.ABC], ['SETUPVAL', FORMAT.ABC],
  ['GETTABUP', FORMAT.ABC], ['GETTABLE', FORMAT.ABC], ['GETI', FORMAT.ABC], ['GETFIELD', FORMAT.ABC],
  ['SETTABUP', FORMAT.ABC], ['SETTABLE', FORMAT.ABC], ['SETI', FORMAT.ABC], ['SETFIELD', FORMAT.ABC],
  ['NEWTABLE', FORMAT.ABC], ['SELF', FORMAT.ABC],
  ['ADDI', FORMAT.ABC],
  ['ADDK', FORMAT.ABC], ['SUBK', FORMAT.ABC], ['MULK', FORMAT.ABC], ['MODK', FORMAT.ABC],
  ['POWK', FORMAT.ABC], ['DIVK', FORMAT.ABC], ['IDIVK', FORMAT.ABC],
  ['BANDK', FORMAT.ABC], ['BORK', FORMAT.ABC], ['BXORK', FORMAT.ABC],
  ['SHRI', FORMAT.ABC], ['SHLI', FORMAT.ABC],
  ['ADD', FORMAT.ABC], ['SUB', FORMAT.ABC], ['MUL', FORMAT.ABC], ['MOD', FORMAT.ABC],
  ['POW', FORMAT.ABC], ['DIV', FORMAT.ABC], ['IDIV', FORMAT.ABC],
  ['BAND', FORMAT.ABC], ['BOR', FORMAT.ABC], ['BXOR', FORMAT.ABC], ['SHL', FORMAT.ABC], ['SHR', FORMAT.ABC],
  ['MMBIN', FORMAT.ABC], ['MMBINI', FORMAT.ABC], ['MMBINK', FORMAT.ABC],
  ['UNM', FORMAT.ABC], ['BNOT', FORMAT.ABC], ['NOT', FORMAT.ABC], ['LEN', FORMAT.ABC],
  ['CONCAT', FORMAT.ABC], ['CLOSE', FORMAT.ABC], ['TBC', FORMAT.ABC],
  ['JMP', FORMAT.sJ],
  ['EQ', FORMAT.ABC], ['LT', FORMAT.ABC], ['LE', FORMAT.ABC],
  ['EQK', FORMAT.ABC], ['EQI', FORMAT.ABC], ['LTI', FORMAT.ABC], ['LEI', FORMAT.ABC],
  ['GTI', FORMAT.ABC], ['GEI', FORMAT.ABC],
  ['TEST', FORMAT.ABC], ['TESTSET', FORMAT.ABC],
  ['CALL', FORMAT.ABC], ['TAILCALL', FORMAT.ABC],
  ['RETURN', FORMAT.ABC], ['RETURN0', FORMAT.ABC], ['RETURN1', FORMAT.ABC],
  ['FORLOOP', FORMAT.ABx], ['FORPREP', FORMAT.ABx],
  ['TFORPREP', FORMAT.ABx], ['TFORCALL', FORMAT.ABC], ['TFORLOOP', FORMAT.ABx],
  ['SETLIST', FORMAT.ABC],
  ['CLOSURE', FORMAT.ABx],
  ['VARARG', FORMAT.ABC], ['VARARGPREP', FORMAT.ABC],
  ['EXTRAARG', FORMAT.Ax],
].map(([name, format]) => ({ name, format }));

/** Opcodes whose k flag means "B (or C) is a constant index". */
export const K_SELECTS_CONSTANT = new Set([
  'GETFIELD', 'SETFIELD', 'GETTABUP', 'SETTABUP', 'SELF',
  'ADDK', 'SUBK', 'MULK', 'MODK', 'POWK', 'DIVK', 'IDIVK', 'BANDK', 'BORK', 'BXORK',
  'EQK', 'MMBINK',
]);

/** One 32-bit word, taken apart. */
export function decodeInstruction(word) {
  const opcode = word & 0x7f;
  const entry = OPCODES[opcode] ?? { name: `UNKNOWN_${opcode}`, format: FORMAT.ABC };
  const A = (word >>> 7) & 0xff;
  const k = (word >>> 15) & 0x1;
  const B = (word >>> 16) & 0xff;
  const C = (word >>> 24) & 0xff;
  const Bx = (word >>> 15) & 0x1ffff;
  const Ax = (word >>> 7) & 0x1ffffff;

  const decoded = { opcode, name: entry.name, format: entry.format, word, A, B, C, k };
  if (entry.format === FORMAT.ABx) decoded.Bx = Bx;
  if (entry.format === FORMAT.AsBx) decoded.sBx = Bx - OFFSET_sBx;
  if (entry.format === FORMAT.Ax) decoded.Ax = Ax;
  if (entry.format === FORMAT.sJ) decoded.sJ = Ax - OFFSET_sJ;
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
