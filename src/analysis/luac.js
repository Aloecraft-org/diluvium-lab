// A reader for compiled Diluvium chunks — the bytes `string.dump` returns.
//
// The container is stock Lua 5.4's, with one difference this file exists to
// notice: **`LUAC_FORMAT` is 0x44, not 0.** Stock Lua writes zero there and
// refuses to load anything else, so a Diluvium chunk and a PUC-Rio Lua
// chunk are deliberately not interchangeable even though the layout is
// identical. `'D'` is a nice touch and it is also a compatibility fence, so
// the reader reports the byte instead of quietly accepting either.
//
// Everything here was derived from the shipped artifact by decoding
// `function() end` a byte at a time and checking the parse lands exactly on
// the last byte of the buffer. That "no bytes left over" property is the
// strongest cheap check a binary parser can have, and `readChunk` enforces
// it rather than trusting itself.

import { decodeInstruction } from './opcodes.js';

export const LUA_SIGNATURE = '\x1bLua';
export const LUAC_VERSION = 0x54;         // 5.4
export const DILUVIUM_FORMAT = 0x44;      // 'D'; stock Lua writes 0
export const LUAC_DATA = [0x19, 0x93, 0x0d, 0x0a, 0x1a, 0x0a];
export const LUAC_INT = 0x5678n;
export const LUAC_NUM = 370.5;

/** Constant type tags, as `ttypetag` writes them. */
const TAG = {
  NIL: 0x00, FALSE: 0x01, TRUE: 0x11,
  NUMINT: 0x03, NUMFLT: 0x13,
  SHRSTR: 0x04, LNGSTR: 0x14,
};

export class BytecodeError extends Error {}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
  }

  need(n) {
    if (this.at + n > this.bytes.length) {
      throw new BytecodeError(`the chunk ends early: wanted ${n} more byte(s) at offset ${this.at}`);
    }
  }

  byte() { this.need(1); return this.bytes[this.at++]; }
  take(n) { this.need(n); const out = this.bytes.subarray(this.at, this.at + n); this.at += n; return out; }

  /**
   * Lua 5.4's variable-length unsigned: seven bits per byte, most
   * significant first, and the byte that *has* the high bit set is the
   * last one. (Not the usual LEB128 convention, which is the other way
   * round in both respects.)
   */
  unsigned() {
    let value = 0;
    let b;
    do {
      b = this.byte();
      value = (value * 128) + (b & 0x7f);
    } while ((b & 0x80) === 0);
    return value;
  }

  int() { return this.unsigned(); }

  /**
   * Size 0 means absent; otherwise the stored size is length + 1.
   *
   * For a **constant** inside a scrambled function it is length exactly,
   * and the bytes are XORed like the instructions are: `04 85 ce cc d7 d0
   * ca` is a short-string constant whose five content bytes XOR to `print`,
   * five characters after a stored size of five. The debug section of the
   * same function is *not* transformed -- local and upvalue names read
   * plainly, which is why only readConstant passes a key.
   *
   * That +1 is not decoration in stock Lua: it is what lets 0 mean "no
   * string at all" (`loadStringN` returns NULL), which `source`, local
   * names and upvalue names all rely on. The scrambled branch spends it,
   * so inside a scrambled function a stored 0 is the empty string rather
   * than absence -- confirmed by round-tripping `local x = ""` through
   * `string.dump` and `load` in the running kernel, which yields `""` and
   * not nil. Both sides agree today. They agree by accident of being
   * written together, not because anything checks.
   */
  string(xorKey = 0) {
    const size = this.unsigned();
    if (size === 0) return null;
    const raw = this.take(xorKey ? size : size - 1);
    const bytes = xorKey ? raw.map((b) => b ^ xorKey) : raw;
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  integer() { this.need(8); const v = this.view.getBigInt64(this.at, true); this.at += 8; return v; }
  number() { this.need(8); const v = this.view.getFloat64(this.at, true); this.at += 8; return v; }
  instruction() { this.need(4); const v = this.view.getUint32(this.at, true); this.at += 4; return v; }

  /**
   * Same, for the functions Diluvium stores scrambled.
   *
   * Note this XORs each of the four bytes with the *same* key rather than
   * the word with a 32-bit one, which is what the compiler does and is
   * worth stating because the two are easy to confuse. A 32-bit key of
   * 0xCAFEBABE would put 0xbe in the low byte and 0xba, 0xfe, 0xca in the
   * others; every sample from this artifact has 0xbe in all four
   * positions.
   */
  instructionXor(key) {
    this.need(4);
    let word = 0;
    for (let i = 3; i >= 0; i--) word = ((word << 8) | (this.bytes[this.at + i] ^ key)) >>> 0;
    this.at += 4;
    return word;
  }
}

function readHeader(reader) {
  const signature = String.fromCharCode(...reader.take(4));
  if (signature !== LUA_SIGNATURE) {
    throw new BytecodeError('this is not compiled Lua: the \\x1bLua signature is missing');
  }
  const version = reader.byte();
  const format = reader.byte();
  const data = Array.from(reader.take(6));
  const sizeInstruction = reader.byte();
  const sizeInteger = reader.byte();
  const sizeNumber = reader.byte();
  const checkInteger = reader.integer();
  const checkNumber = reader.number();

  const problems = [];
  if (version !== LUAC_VERSION) {
    problems.push(`bytecode version 0x${version.toString(16)}, not 0x54 (Lua 5.4)`);
  }
  if (LUAC_DATA.some((b, i) => data[i] !== b)) problems.push('the LUAC_DATA guard bytes are wrong');
  if (sizeInstruction !== 4) problems.push(`instructions are ${sizeInstruction} bytes, not 4`);
  if (sizeInteger !== 8) problems.push(`integers are ${sizeInteger} bytes, not 8`);
  if (sizeNumber !== 8) problems.push(`numbers are ${sizeNumber} bytes, not 8`);
  if (checkInteger !== LUAC_INT) problems.push('the integer endianness check failed');
  if (checkNumber !== LUAC_NUM) problems.push('the float format check failed');
  if (problems.length) throw new BytecodeError(problems.join('; '));

  return {
    version,
    format,
    // Reported rather than enforced: a chunk from stock Lua parses fine
    // here, and saying whose it is beats pretending they are the same.
    dialect: format === DILUVIUM_FORMAT ? 'diluvium' : (format === 0 ? 'lua' : `format 0x${format.toString(16)}`),
    sizeInstruction,
    sizeInteger,
    sizeNumber,
  };
}

function readConstant(reader, xorKey) {
  const tag = reader.byte();
  switch (tag) {
    case TAG.NIL: return { type: 'nil', value: null };
    case TAG.FALSE: return { type: 'boolean', value: false };
    case TAG.TRUE: return { type: 'boolean', value: true };
    case TAG.NUMINT: return { type: 'integer', value: reader.integer() };
    case TAG.NUMFLT: return { type: 'float', value: reader.number() };
    case TAG.SHRSTR:
    case TAG.LNGSTR: return { type: 'string', value: reader.string(xorKey) ?? '' };
    default: throw new BytecodeError(`unknown constant tag 0x${tag.toString(16)}`);
  }
}

/**
 * Diluvium prefixes every function with one byte that stock Lua does not
 * write. It is `Proto::is_encrypted`, and when it is 1 both the
 * instruction bytes and the string-constant bytes are stored XORed with
 * 0xbe. (Confirmed against the compiler source, 2026-08-08. Everything
 * below was derived from the artifact first, which is why the evidence is
 * kept: it is what will catch the next change.)
 *
 * `function(a) return a end` compiled as a nested function stores
 * `f6 be bc be 79 be bf be`; XORed with 0xbe that is `48 00 02 00`
 * `47 00 01 00`, which decodes to `RETURN1 0 2` / `RETURN0 0 1` — exactly
 * what the same source produces at the top level, where the flag is 0 and
 * the bytes are stored plainly.
 *
 * The key is one byte applied to every byte, *not* a 32-bit word key. An
 * earlier draft of the compiler XORed instruction words with 0xCAFEBABE;
 * the shipped 5.4.7 does not, and `f6 be bc be` is how you tell — a
 * 32-bit 0xCAFEBABE would leave 0xba in the second position.
 *
 * Which functions get the flag is a separate question from what the flag
 * does, and the answer looks accidental. Across every shape tried, the
 * *first* nested function of a chunk and its entire subtree carry 1, and
 * the main chunk plus everything compiled after that subtree closes
 * carries 0:
 *
 *     local function a() local function a1() end end   -- a=1, a1=1
 *     local function b() local function b1() end end   -- b=0, b1=0
 *
 * That is a latch, not a policy: it means one arbitrary subtree of any
 * real program ships scrambled and the rest ships plain. `test/bytecode.
 * spec.js` pins the rule so that a build which changes it says so.
 */
const SCRAMBLE_KEY = 0xbe;

function readFunction(reader, parentSource) {
  const flag = reader.byte();
  const xorKey = flag === 1 ? SCRAMBLE_KEY : 0;
  const source = reader.string() ?? parentSource;
  const lineDefined = reader.int();
  const lastLineDefined = reader.int();
  const numParams = reader.byte();
  const isVararg = reader.byte();
  const maxStackSize = reader.byte();

  const code = [];
  const codeCount = reader.int();
  for (let i = 0; i < codeCount; i++) {
    code.push(flag === 1 ? reader.instructionXor(SCRAMBLE_KEY) : reader.instruction());
  }

  const constants = [];
  const constantCount = reader.int();
  for (let i = 0; i < constantCount; i++) constants.push(readConstant(reader, xorKey));

  const upvalues = [];
  const upvalueCount = reader.int();
  for (let i = 0; i < upvalueCount; i++) {
    upvalues.push({ inStack: reader.byte() === 1, index: reader.byte(), kind: reader.byte(), name: null });
  }

  const protos = [];
  const protoCount = reader.int();
  for (let i = 0; i < protoCount; i++) protos.push(readFunction(reader, source));

  // --- debug ---------------------------------------------------------
  const lineInfo = [];
  const lineInfoCount = reader.int();
  for (let i = 0; i < lineInfoCount; i++) {
    const b = reader.byte();
    lineInfo.push(b > 127 ? b - 256 : b);      // signed delta
  }

  const absLineInfo = [];
  const absCount = reader.int();
  for (let i = 0; i < absCount; i++) absLineInfo.push({ pc: reader.int(), line: reader.int() });

  const locals = [];
  const localCount = reader.int();
  for (let i = 0; i < localCount; i++) {
    locals.push({ name: reader.string(), startpc: reader.int(), endpc: reader.int() });
  }

  const upvalueNameCount = reader.int();
  for (let i = 0; i < upvalueNameCount; i++) {
    const name = reader.string();
    if (upvalues[i]) upvalues[i].name = name;
  }

  return {
    flag,
    encrypted: flag === 1,   // Proto::is_encrypted, as the compiler names it
    source,
    lineDefined,
    lastLineDefined,
    numParams,
    isVararg: isVararg !== 0,
    maxStackSize,
    code,
    instructions: code.map(decodeInstruction),
    constants,
    upvalues,
    protos,
    lineInfo,
    absLineInfo,
    locals,
    lines: absoluteLines(lineInfo, absLineInfo, lineDefined),
  };
}

/**
 * Lua stores one signed byte per instruction, as a delta from the previous
 * line, with absolute entries every so often to stop the deltas drifting.
 * A delta of -128 means "no info"; the absolute table is authoritative.
 */
function absoluteLines(lineInfo, absLineInfo, lineDefined) {
  const lines = [];
  let current = lineDefined;
  const absolute = new Map(absLineInfo.map(({ pc, line }) => [pc, line]));
  for (let pc = 0; pc < lineInfo.length; pc++) {
    if (absolute.has(pc)) current = absolute.get(pc);
    else if (lineInfo[pc] !== -128) current += lineInfo[pc];
    lines.push(current);
  }
  return lines;
}

/**
 * Parse a compiled chunk.
 *
 * Throws unless every byte is accounted for. A binary parser that stops
 * early has almost certainly gone wrong somewhere in the middle, and
 * "there are 40 bytes left" is a far better error than a disassembly that
 * looks right and is not.
 */
export function readChunk(bytes) {
  const reader = new Reader(bytes);
  const header = readHeader(reader);
  const sizeUpvalues = reader.byte();
  const main = readFunction(reader, null);

  if (reader.at !== bytes.length) {
    throw new BytecodeError(
      `parsed ${reader.at} of ${bytes.length} bytes — the reader and this chunk disagree about its layout`);
  }

  // Two self-checks, because the container format above was reverse
  // engineered and a plausible-looking wrong disassembly would be worse
  // than an error. A misaligned parse essentially never ends exactly on
  // the last byte *and* yields only real opcodes.
  for (const { path, proto } of flattenProtos(main)) {
    const bad = proto.instructions.find((i) => i.name.startsWith('UNKNOWN_'));
    if (bad) {
      throw new BytecodeError(
        `${path} decodes to opcode ${bad.opcode}, which does not exist in Lua 5.4. `
        + 'This build stores bytecode differently from the one this reader was derived from.');
    }
  }

  return { header, sizeUpvalues, main, byteLength: bytes.length };
}

// --- hex, which is both the transport and a thing people paste ---------

export function toHex(bytes, { groupsPerLine = 16 } = {}) {
  const parts = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  const lines = [];
  for (let i = 0; i < parts.length; i += groupsPerLine) {
    lines.push(parts.slice(i, i + groupsPerLine).join(' '));
  }
  return lines.join('\n');
}

/** Tolerant: whitespace, newlines, commas, `0x` and `\x` prefixes all fine. */
export function fromHex(text) {
  const cleaned = String(text).replace(/0x|\\x|[\s,]/gi, '');
  if (cleaned.length === 0) throw new BytecodeError('there is no hex here');
  if (!/^[0-9a-f]*$/i.test(cleaned)) {
    const bad = cleaned.match(/[^0-9a-f]/i);
    throw new BytecodeError(`"${bad[0]}" is not a hex digit`);
  }
  if (cleaned.length % 2 !== 0) throw new BytecodeError('an odd number of hex digits — one is missing');
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(cleaned.substr(i * 2, 2), 16);
  return bytes;
}

/** Every function in the chunk, flattened, with a path like `main/1/0`. */
export function flattenProtos(main, path = 'main') {
  const out = [{ path, proto: main }];
  main.protos.forEach((child, i) => out.push(...flattenProtos(child, `${path}/${i}`)));
  return out;
}
