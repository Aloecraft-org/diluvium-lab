// Turning a parsed chunk into something a person learns from.
//
// The instructions are the easy half. What makes a disassembly teach rather
// than merely tell is the right-hand column: `GETTABUP 0 0 0` is a fact,
// and `GETTABUP 0 0 0  ; _ENV "print"` is an explanation. Every annotation
// here resolves an operand that would otherwise be an unexplained integer —
// constants, upvalue names, jump destinations, child functions.

import { FORMAT, K_SELECTS_CONSTANT, operandsOf } from './opcodes.js';

/** How a constant reads in the comment column. */
export function showConstant(constant) {
  if (!constant) return '?';
  switch (constant.type) {
    case 'string': return JSON.stringify(constant.value);
    case 'integer': return String(constant.value);
    case 'float': return Number.isInteger(constant.value) ? `${constant.value}.0` : String(constant.value);
    case 'boolean': return String(constant.value);
    default: return 'nil';
  }
}

const upvalueName = (proto, i) => proto.upvalues[i]?.name ?? `upvalue ${i}`;
const constantAt = (proto, i) => showConstant(proto.constants[i]);

/**
 * The comment for one instruction, or null.
 *
 * Deliberately not exhaustive: an annotation that is wrong is worse than
 * none, so this covers the ones whose operands have an unambiguous
 * referent and says nothing about the rest.
 *
 * Shared by both dialects. `NEWTABLE` and `SETLIST` changed operand
 * *widths* between 5.4 and 5.5 but not operand *meanings*, and the reader
 * has already put vB/vC into B/C, so one case serves both. `GETVARG` and
 * `ERRNNIL` exist only in 5.5, which costs nothing here — the names simply
 * never come up when disassembling a 5.4 chunk.
 */
export function annotate(instruction, proto, pc) {
  const { name, A, B, C, k } = instruction;

  switch (name) {
    case 'LOADK': return constantAt(proto, instruction.Bx);
    case 'LOADKX': return 'constant from the next EXTRAARG';
    case 'GETUPVAL': case 'SETUPVAL': return upvalueName(proto, B);

    case 'GETTABUP': return `${upvalueName(proto, B)} ${constantAt(proto, C)}`;
    case 'SETTABUP': return `${upvalueName(proto, A)} ${constantAt(proto, B)} ${k ? `= ${constantAt(proto, C)}` : ''}`.trim();
    case 'GETFIELD': return constantAt(proto, C);
    case 'SETFIELD': return `${constantAt(proto, B)}${k ? ` = ${constantAt(proto, C)}` : ''}`;
    case 'SELF': return k ? constantAt(proto, C) : null;

    case 'GETI': case 'SETI': return `index ${name === 'GETI' ? C : B}`;

    case 'CLOSURE': return `function ${instruction.Bx}${describeProto(proto.protos[instruction.Bx])}`;

    case 'JMP': return `to ${pc + 1 + instruction.sJ + 1}`;
    case 'FORLOOP': return `to ${pc + 1 - instruction.Bx + 1}`;
    // FORPREP jumps Bx + 1 to skip the loop body; TFORPREP jumps Bx flat.
    // They look alike and are not, so they do not share a case.
    case 'FORPREP': return `to ${pc + 1 + instruction.Bx + 1 + 1}`;
    case 'TFORPREP': return `to ${pc + 1 + instruction.Bx + 1}`;
    case 'TFORLOOP': return `to ${pc + 1 - instruction.Bx + 1}`;

    case 'NEWTABLE': return tableShape(B, C, k);
    case 'SETLIST': return `${B === 0 ? 'every value up to the top' : `${B} value${B === 1 ? '' : 's'}`}`
      + `, starting at index ${C + 1}`;
    case 'GETVARG': return 'index into `...`';
    case 'ERRNNIL': return instruction.Bx > 0 ? `${constantAt(proto, instruction.Bx - 1)} is not declared` : null;
    case 'VARARG': return C === 0 ? 'all of `...`' : `${C - 1} value${C - 1 === 1 ? '' : 's'} from \`...\``;

    case 'EQK': return constantAt(proto, B);
    case 'ADDK': case 'SUBK': case 'MULK': case 'MODK': case 'POWK':
    case 'DIVK': case 'IDIVK': case 'BANDK': case 'BORK': case 'BXORK':
      return constantAt(proto, C);
    case 'MMBINK': return constantAt(proto, B);

    case 'CALL': return callShape(B, C);
    case 'TAILCALL': return `${callShape(B, C)} — tail call, so this frame is reused`;
    case 'RETURN0': return 'no values';
    case 'RETURN1': return 'one value';
    case 'VARARGPREP': return 'set up for `...`';
    default:
      return K_SELECTS_CONSTANT.has(name) && k ? constantAt(proto, C) : null;
  }
}

/** B is log2(hash size) + 1, C is the array size — in both dialects. */
function tableShape(B, C, k) {
  const hash = B > 0 ? 2 ** (B - 1) : 0;
  const parts = [];
  if (C) parts.push(`${C} array slot${C === 1 ? '' : 's'}`);
  if (hash) parts.push(`${hash} hash slot${hash === 1 ? '' : 's'}`);
  if (k) parts.push('plus the next EXTRAARG');
  return parts.length ? parts.join(', ') : 'empty';
}

function callShape(B, C) {
  const args = B === 0 ? 'all remaining args' : `${B - 1} arg${B - 1 === 1 ? '' : 's'}`;
  const results = C === 0 ? 'all results' : `${C - 1} result${C - 1 === 1 ? '' : 's'}`;
  return `${args}, ${results}`;
}

function describeProto(proto) {
  if (!proto) return '';
  const params = proto.numParams + (proto.isVararg ? 1 : 0);
  return ` (${proto.numParams} param${proto.numParams === 1 ? '' : 's'}${proto.isVararg ? ' + ...' : ''}, ${params >= 0 ? `${proto.code.length} instructions` : ''})`;
}

/** One row per instruction, ready to render as a table or as text. */
export function disassemble(proto) {
  return proto.instructions.map((instruction, pc) => ({
    pc,
    line: proto.lines[pc] ?? null,
    name: instruction.name,
    operands: operandsOf(instruction).join(' '),
    comment: annotate(instruction, proto, pc),
    word: instruction.word,
    isJump: [FORMAT.sJ].includes(instruction.format)
      || ['FORLOOP', 'FORPREP', 'TFORPREP', 'TFORLOOP'].includes(instruction.name),
  }));
}

/** A header line for a function, in the shape luac uses. */
export function describeFunction(proto, path) {
  const where = proto.lineDefined === 0
    ? 'main chunk'
    : `function at lines ${proto.lineDefined}–${proto.lastLineDefined}`;
  return `${path}: ${where} — ${proto.numParams} param${proto.numParams === 1 ? '' : 's'}`
    + `${proto.isVararg ? ' + ...' : ''}, ${proto.maxStackSize} slots, `
    + `${proto.code.length} instruction${proto.code.length === 1 ? '' : 's'}, `
    + `${proto.constants.length} constant${proto.constants.length === 1 ? '' : 's'}, `
    + `${proto.upvalues.length} upvalue${proto.upvalues.length === 1 ? '' : 's'}`;
}

/** Plain text, for copying out. */
export function toText(chunk, flattened) {
  const lines = [
    `; Diluvium bytecode — ${chunk.byteLength} bytes, ${flattened.length} function(s)`,
    `; format 0x${chunk.header.format.toString(16)} (${chunk.header.dialect}), Lua ${(chunk.header.version >> 4)}.${chunk.header.version & 0xf}`,
    '',
  ];
  for (const { path, proto } of flattened) {
    lines.push(describeFunction(proto, path));
    for (const row of disassemble(proto)) {
      const pc = String(row.pc + 1).padStart(4);
      const line = row.line === null ? '     ' : `[${row.line}]`.padStart(6);
      const body = `${row.name} ${row.operands}`.padEnd(30);
      lines.push(`${pc}${line}  ${body}${row.comment ? `; ${row.comment}` : ''}`.trimEnd());
    }
    if (proto.constants.length) {
      lines.push('  constants:');
      proto.constants.forEach((c, i) => lines.push(`    ${i}  ${c.type.padEnd(8)} ${showConstant(c)}`));
    }
    if (proto.upvalues.length) {
      lines.push('  upvalues:');
      proto.upvalues.forEach((u, i) => lines.push(
        `    ${i}  ${(u.name ?? '?').padEnd(12)} ${u.inStack ? 'from the enclosing stack' : 'from an enclosing upvalue'}, index ${u.index}`));
    }
    lines.push('');
  }
  return lines.join('\n');
}
