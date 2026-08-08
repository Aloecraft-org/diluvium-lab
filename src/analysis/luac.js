// A reader for compiled Diluvium chunks — the bytes `string.dump` returns.
//
// It reads **two** containers, because Diluvium 5.5 rebased onto Lua 5.5
// and the dump format changed underneath it. They share a signature and
// almost nothing else, so the version byte in the header picks a profile
// and every difference lives in one of the two `PROFILES` entries below.
//
// What differs, all of it load-bearing:
//
// | | 5.4 | 5.5 |
// | :-- | :-- | :-- |
// | varint terminator | high bit **set** on the last byte | high bit **clear** on the last byte |
// | integer constants | raw 8-byte little-endian | zigzag varint |
// | strings | inline, every time | interned: `size 0` means "reuse #n" |
// | `source` | first field of a function | after the nested protos |
// | vararg | its own byte | bits 0–1 of a `flag` byte |
// | code section | packed | aligned to 4 first |
// | `abslineinfo` | pairs of varints | aligned pairs of raw int32 |
// | scramble covers | code and string constants | code and *every* string |
//
// The one thing they agree on is `LUAC_FORMAT` = 0x44 (`'D'`), where stock
// Lua writes 0 and refuses anything else — so a Diluvium chunk and a
// PUC-Rio chunk of the same Lua version are still deliberately not
// interchangeable.
//
// The 5.4 profile was derived from the shipped artifact by decoding
// `function() end` a byte at a time. The 5.5 profile was derived from
// `ldump.c` and `lundump.c` at tag v5.5.1_build1. Both are checked the
// same way at the end of `readChunk`: the parse must land exactly on the
// last byte and every opcode must exist.

import { decodeInstruction, instructionSet } from './opcodes.js';

export const LUA_SIGNATURE = '\x1bLua';
export const DILUVIUM_FORMAT = 0x44;      // 'D'; stock Lua writes 0
export const LUAC_DATA = [0x19, 0x93, 0x0d, 0x0a, 0x1a, 0x0a];

/** Constant type tags, as `ttypetag` writes them. Unchanged across 5.4/5.5. */
const TAG = {
  NIL: 0x00, FALSE: 0x01, TRUE: 0x11,
  NUMINT: 0x03, NUMFLT: 0x13,
  SHRSTR: 0x04, LNGSTR: 0x14,
};

/**
 * Diluvium scrambles secure functions with a single-byte XOR. One key,
 * applied byte by byte — *not* a 32-bit word key, which is worth stating
 * because the compiler carried a `0xCAFEBABE` word version at one point
 * and the two are easy to confuse. A 32-bit `0xCAFEBABE` on a
 * little-endian word leaves `be ba fe ca`; every sample here reads `0xbe`
 * in all four positions.
 *
 * In 5.4 this covers the instruction stream and the string constants,
 * with the debug section left plain. In 5.5 `DumpState::encrypted` gates
 * `dumpString` itself, so the source name and every local and upvalue
 * name are scrambled too.
 *
 * *Which* functions carry the flag is a separate question, and on 5.4.7
 * the answer is a bug rather than a rule. `~function` exists in both
 * dialects and sets `LexState::encrypted_flag`, which the next
 * `addprototype` consumes and the resulting subtree inherits. But 5.4.7's
 * `luaX_setinput` initialises every other LexState field and not that
 * one, and LexState is a stack local — so a chunk containing no `~` at
 * all still marks its first nested function and everything inside it.
 * 5.5 adds the missing initialisation and the same source marks nothing.
 * Both behaviours are pinned against committed dumps in
 * test/bytecode-dialects.spec.js.
 */
const SCRAMBLE_KEY = 0xbe;

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

  u32() { this.need(4); const v = this.view.getUint32(this.at, true); this.at += 4; return v; }
  i32() { this.need(4); const v = this.view.getInt32(this.at, true); this.at += 4; return v; }
  i64() { this.need(8); const v = this.view.getBigInt64(this.at, true); this.at += 8; return v; }
  f64() { this.need(8); const v = this.view.getFloat64(this.at, true); this.at += 8; return v; }

  /**
   * `dumpAlign` pads with zeros to the next multiple of `align`, measured
   * from the start of the dump — which is why this counts from `at` and
   * not from the start of the section.
   */
  align(width) {
    const padding = (width - (this.at % width)) % width;
    this.take(padding);
  }

  /**
   * Lua 5.4's variable-length unsigned: seven bits per byte, most
   * significant first, and the byte that *has* the high bit set is the
   * last one.
   */
  varint54() {
    let value = 0;
    let b;
    do {
      b = this.byte();
      value = (value * 128) + (b & 0x7f);
    } while ((b & 0x80) === 0);
    return value;
  }

  /**
   * Lua 5.5 inverted the convention: still most significant first, but now
   * the high bit is a *continuation* bit, so the last byte is the one with
   * it clear. Reading a 5.5 chunk with the 5.4 rule does not fail, it
   * silently returns a different number — which is most of why this file
   * refuses to have a default dialect.
   */
  varint55() {
    let value = 0;
    let b;
    do {
      b = this.byte();
      value = (value * 128) + (b & 0x7f);
    } while ((b & 0x80) !== 0);
    return value;
  }

  /**
   * The same, in BigInt. Integer *constants* are varints in 5.5, and a
   * Lua integer is 64 bits — `math.maxinteger` zigzags to 2^64 - 2, which
   * a JS number rounds. Counts and sizes are small enough not to care;
   * constants are not.
   */
  varint55Big() {
    let value = 0n;
    let b;
    do {
      b = this.byte();
      value = (value << 7n) | BigInt(b & 0x7f);
    } while ((b & 0x80) !== 0);
    return value;
  }
}

const decode = (bytes) => new TextDecoder('utf-8', { fatal: false }).decode(bytes);
const unscramble = (bytes) => bytes.map((b) => b ^ SCRAMBLE_KEY);

// --- 5.4 -------------------------------------------------------------

function readHeader54(reader) {
  const sizeInstruction = reader.byte();
  const sizeInteger = reader.byte();
  const sizeNumber = reader.byte();
  const checkInteger = reader.i64();
  const checkNumber = reader.f64();

  const problems = [];
  if (sizeInstruction !== 4) problems.push(`instructions are ${sizeInstruction} bytes, not 4`);
  if (sizeInteger !== 8) problems.push(`integers are ${sizeInteger} bytes, not 8`);
  if (sizeNumber !== 8) problems.push(`numbers are ${sizeNumber} bytes, not 8`);
  if (checkInteger !== 0x5678n) problems.push('the integer endianness check failed');
  if (checkNumber !== 370.5) problems.push('the float format check failed');
  return { problems, sizeInstruction, sizeInteger, sizeNumber };
}

/**
 * A string in 5.4: a size, then that many bytes minus one, with no
 * terminator stored.
 *
 * For a constant inside a scrambled function the stored size is the exact
 * length instead, and the bytes are XORed: `04 85 ce cc d7 d0 ca` is a
 * short-string constant whose five content bytes XOR to `print`. That
 * asymmetry spends the encoding stock Lua uses for "no string", which is
 * why it only applies where a string is never absent.
 */
function readString54(ctx, { scrambled = false } = {}) {
  const size = ctx.reader.varint54();
  if (size === 0) return null;
  const raw = ctx.reader.take(scrambled ? size : size - 1);
  return decode(scrambled ? unscramble(raw) : raw);
}

function readFunction54(ctx, parentSource) {
  const { reader } = ctx;
  const flag = reader.byte();
  const scrambled = flag === 1;

  const source = readString54(ctx) ?? parentSource;
  const lineDefined = reader.varint54();
  const lastLineDefined = reader.varint54();
  const numParams = reader.byte();
  const isVararg = reader.byte() !== 0;
  const maxStackSize = reader.byte();

  const code = [];
  const codeCount = reader.varint54();
  for (let i = 0; i < codeCount; i++) {
    code.push(scrambled ? readScrambledWord(reader) : reader.u32());
  }

  const constants = [];
  const constantCount = reader.varint54();
  for (let i = 0; i < constantCount; i++) {
    const tag = reader.byte();
    switch (tag) {
      case TAG.NIL: constants.push({ type: 'nil', value: null }); break;
      case TAG.FALSE: constants.push({ type: 'boolean', value: false }); break;
      case TAG.TRUE: constants.push({ type: 'boolean', value: true }); break;
      case TAG.NUMINT: constants.push({ type: 'integer', value: reader.i64() }); break;
      case TAG.NUMFLT: constants.push({ type: 'float', value: reader.f64() }); break;
      case TAG.SHRSTR:
      case TAG.LNGSTR: constants.push({ type: 'string', value: readString54(ctx, { scrambled }) ?? '' }); break;
      default: throw new BytecodeError(`unknown constant tag 0x${tag.toString(16)}`);
    }
  }

  const upvalues = [];
  const upvalueCount = reader.varint54();
  for (let i = 0; i < upvalueCount; i++) {
    upvalues.push({ inStack: reader.byte() === 1, index: reader.byte(), kind: reader.byte(), name: null });
  }

  const protos = [];
  const protoCount = reader.varint54();
  for (let i = 0; i < protoCount; i++) protos.push(readFunction54(ctx, source));

  // --- debug: never scrambled in 5.4 ---------------------------------
  const lineInfo = [];
  const lineInfoCount = reader.varint54();
  for (let i = 0; i < lineInfoCount; i++) {
    const b = reader.byte();
    lineInfo.push(b > 127 ? b - 256 : b);      // signed delta
  }

  const absLineInfo = [];
  const absCount = reader.varint54();
  for (let i = 0; i < absCount; i++) absLineInfo.push({ pc: reader.varint54(), line: reader.varint54() });

  const locals = [];
  const localCount = reader.varint54();
  for (let i = 0; i < localCount; i++) {
    locals.push({ name: readString54(ctx), startpc: reader.varint54(), endpc: reader.varint54() });
  }

  const upvalueNameCount = reader.varint54();
  for (let i = 0; i < upvalueNameCount; i++) {
    const name = readString54(ctx);
    if (upvalues[i]) upvalues[i].name = name;
  }

  return finish(ctx, {
    flag, source, lineDefined, lastLineDefined, numParams, isVararg, maxStackSize,
    code, constants, upvalues, protos, lineInfo, absLineInfo, locals,
  });
}

// --- 5.5 -------------------------------------------------------------

/**
 * `dumpNumInfo`: a size byte, then a check value of that width.
 *
 * A wrong width means the rest of the header cannot be located, so this
 * stops there rather than collecting further problems it would be
 * guessing at.
 */
function checkNum(reader, width, read, expected, label, problems) {
  const size = reader.byte();
  if (size !== width) {
    throw new BytecodeError(
      [...problems, `${label} is ${size} bytes, not ${width}`].join('; '));
  }
  if (read(reader) !== expected) problems.push(`the ${label} check value is wrong`);
}

function readHeader55(reader) {
  const problems = [];
  checkNum(reader, 4, (r) => r.i32(), -0x5678, 'int', problems);
  checkNum(reader, 4, (r) => r.u32(), 0x12345678, 'instruction', problems);
  checkNum(reader, 8, (r) => r.i64(), -0x5678n, 'Lua integer', problems);
  checkNum(reader, 8, (r) => r.f64(), -370.5, 'Lua number', problems);
  return { problems, sizeInstruction: 4, sizeInteger: 8, sizeNumber: 8 };
}

/**
 * A string in 5.5, where the format grew a saved-string table.
 *
 * A stored size of 0 is followed by an index: 0 means NULL, anything else
 * means "the string saved under that number". Otherwise the real length is
 * size - 1 and the terminating NUL *is* written, so `size` bytes follow.
 *
 * Note where the scramble sits relative to the dedup: back-references
 * carry no bytes, so they are never scrambled. A string first written
 * inside a plain function and reused inside a secure one is therefore
 * stored in the clear. That is the compiler's behaviour and this reader
 * only has to mirror it — but it is the reason `encrypted` is checked
 * *after* the size, not before.
 */
function readString55(ctx) {
  const { reader } = ctx;
  const size = reader.varint55();
  if (size === 0) {
    const index = reader.varint55();
    if (index === 0) return null;
    if (index > ctx.strings.length) throw new BytecodeError(`string index ${index} has not been seen yet`);
    return ctx.strings[index - 1];
  }
  const length = size - 1;
  const raw = reader.take(length + 1);                 // content plus the NUL
  const bytes = ctx.encrypted ? unscramble(raw) : raw;
  const value = decode(bytes.subarray(0, length));
  ctx.strings.push(value);
  return value;
}

/** Zigzag: 0 => 0, -1 => 1, 1 => 2, -2 => 3, ... */
function readZigzag55(reader) {
  const coded = reader.varint55Big();
  return (coded & 1n) === 0n ? coded / 2n : -(coded >> 1n) - 1n;
}

function readFunction55(ctx, parentSource) {
  const { reader } = ctx;
  const outer = ctx.encrypted;
  const flag = reader.byte();
  const scrambled = flag === 1;
  ctx.encrypted = scrambled;

  const lineDefined = reader.varint55();
  const lastLineDefined = reader.varint55();
  const numParams = reader.byte();
  const protoFlag = reader.byte();
  // PF_VAHID (1) | PF_VATAB (2); PF_FIXED (4) is a load-time thing.
  const isVararg = (protoFlag & 0x3) !== 0;
  const maxStackSize = reader.byte();

  const code = [];
  const codeCount = reader.varint55();
  reader.align(4);
  for (let i = 0; i < codeCount; i++) {
    code.push(scrambled ? readScrambledWord(reader) : reader.u32());
  }

  const constants = [];
  const constantCount = reader.varint55();
  for (let i = 0; i < constantCount; i++) {
    const tag = reader.byte();
    switch (tag) {
      case TAG.NIL: constants.push({ type: 'nil', value: null }); break;
      case TAG.FALSE: constants.push({ type: 'boolean', value: false }); break;
      case TAG.TRUE: constants.push({ type: 'boolean', value: true }); break;
      case TAG.NUMINT: constants.push({ type: 'integer', value: readZigzag55(reader) }); break;
      case TAG.NUMFLT: constants.push({ type: 'float', value: reader.f64() }); break;
      case TAG.SHRSTR:
      case TAG.LNGSTR: constants.push({ type: 'string', value: readString55(ctx) ?? '' }); break;
      default: throw new BytecodeError(`unknown constant tag 0x${tag.toString(16)}`);
    }
  }

  const upvalues = [];
  const upvalueCount = reader.varint55();
  for (let i = 0; i < upvalueCount; i++) {
    upvalues.push({ inStack: reader.byte() === 1, index: reader.byte(), kind: reader.byte(), name: null });
  }

  // Children come before this function's own source, and each restores
  // `encrypted` on the way out so the trailing fields below still read
  // under *this* function's flag.
  const protos = [];
  const protoCount = reader.varint55();
  for (let i = 0; i < protoCount; i++) protos.push(readFunction55(ctx, null));

  const source = readString55(ctx) ?? parentSource;

  // --- debug: scrambled along with everything else when secure --------
  const lineInfo = [];
  const lineInfoCount = reader.varint55();
  for (let i = 0; i < lineInfoCount; i++) {
    const b = reader.byte();
    lineInfo.push(b > 127 ? b - 256 : b);
  }

  const absLineInfo = [];
  const absCount = reader.varint55();
  if (absCount > 0) {
    reader.align(4);
    for (let i = 0; i < absCount; i++) absLineInfo.push({ pc: reader.i32(), line: reader.i32() });
  }

  const locals = [];
  const localCount = reader.varint55();
  for (let i = 0; i < localCount; i++) {
    locals.push({ name: readString55(ctx), startpc: reader.varint55(), endpc: reader.varint55() });
  }

  const upvalueNameCount = reader.varint55();
  for (let i = 0; i < upvalueNameCount; i++) {
    const name = readString55(ctx);
    if (upvalues[i]) upvalues[i].name = name;
  }

  ctx.encrypted = outer;
  return finish(ctx, {
    flag, source, lineDefined, lastLineDefined, numParams, isVararg, maxStackSize,
    code, constants, upvalues, protos, lineInfo, absLineInfo, locals,
  });
}

// --- shared ----------------------------------------------------------

/** Four bytes, each XORed with the key, reassembled little-endian. */
function readScrambledWord(reader) {
  reader.need(4);
  let word = 0;
  for (let i = 3; i >= 0; i--) word = ((word << 8) | (reader.bytes[reader.at + i] ^ SCRAMBLE_KEY)) >>> 0;
  reader.at += 4;
  return word;
}

function finish(ctx, proto) {
  return {
    ...proto,
    encrypted: proto.flag === 1,   // Proto::is_encrypted, as the compiler names it
    instructions: proto.code.map((word) => decodeInstruction(word, ctx.set)),
    lines: absoluteLines(proto.lineInfo, proto.absLineInfo, proto.lineDefined),
  };
}

const PROFILES = {
  0x54: { lua: '5.4', readHeader: readHeader54, readFunction: readFunction54 },
  0x55: { lua: '5.5', readHeader: readHeader55, readFunction: readFunction55 },
};

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
 * Parse a compiled chunk, of either dialect.
 *
 * Throws unless every byte is accounted for. A binary parser that stops
 * early has almost certainly gone wrong somewhere in the middle, and
 * "there are 40 bytes left" is a far better error than a disassembly that
 * looks right and is not.
 */
export function readChunk(bytes) {
  const reader = new Reader(bytes);

  const signature = String.fromCharCode(...reader.take(4));
  if (signature !== LUA_SIGNATURE) {
    throw new BytecodeError('this is not compiled Lua: the \\x1bLua signature is missing');
  }
  const version = reader.byte();
  const format = reader.byte();
  const data = Array.from(reader.take(6));

  const profile = PROFILES[version];
  const set = instructionSet(version);
  if (!profile || !set) {
    throw new BytecodeError(
      `bytecode version 0x${version.toString(16)} — this reader knows Lua 5.4 (0x54) and 5.5 (0x55). `
      + 'A newer Diluvium would need its container adding here.');
  }

  const { problems, ...sizes } = profile.readHeader(reader);
  if (LUAC_DATA.some((b, i) => data[i] !== b)) problems.unshift('the LUAC_DATA guard bytes are wrong');
  if (problems.length) throw new BytecodeError(problems.join('; '));

  const header = {
    version,
    format,
    lua: profile.lua,
    // Reported rather than enforced: a chunk from stock Lua parses fine
    // here, and saying whose it is beats pretending they are the same.
    dialect: format === DILUVIUM_FORMAT ? 'diluvium' : (format === 0 ? 'lua' : `format 0x${format.toString(16)}`),
    ...sizes,
  };

  const ctx = { reader, set, strings: [], encrypted: false };
  const sizeUpvalues = reader.byte();
  const main = profile.readFunction(ctx, null);

  if (reader.at !== bytes.length) {
    throw new BytecodeError(
      `parsed ${reader.at} of ${bytes.length} bytes — the reader and this chunk disagree about its layout`);
  }

  // Two self-checks, because both containers were derived rather than
  // specified and a plausible-looking wrong disassembly would be worse
  // than an error. A misaligned parse essentially never ends exactly on
  // the last byte *and* yields only real opcodes.
  for (const { path, proto } of flattenProtos(main)) {
    const bad = proto.instructions.find((i) => i.name.startsWith('UNKNOWN_'));
    if (bad) {
      throw new BytecodeError(
        `${path} decodes to opcode ${bad.opcode}, which does not exist in Lua ${profile.lua}. `
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
