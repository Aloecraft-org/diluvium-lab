// The backend chooser and the `drt-web` stand-in, under Node.
//
// These are the two pieces that could not be tested while `drt-web` was the
// only thing that could answer `drtCapable`. The stand-in answers it now --
// over the real bridge and the real kernel -- so the chooser has two arms
// to choose between and both are exercised.
//
// What is deliberately *not* asserted here is swarm behaviour: attenuation,
// hibernation policy, the delivery table, budget enforcement. Those are
// DRT's and are differentially tested against `dvs.c` in `drt-bench`. What
// is asserted is the Lab's side of the seam.

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootKernel } from './kernel.mjs';
import { encode, decode } from '../../vendor/msgpack.js';
import {
  selectBackend, drtCapable, drtProblems, backendProblems, DRT_REQUIRED,
} from '../../src/kernel/backend.js';
import { createMockDrtWeb, DRT_WEB_EXPORTS, MOCK_UNSUPPORTED } from '../drt-web-mock.js';

const PARKS = `
local inq = queue.declare('work', {capacity = 4})
local out = queue.lookup('outbox')
for _ = 1, 3 do
  local _, msg = queue.wait({inq})
  queue.push(out, {saw = msg})
end
return 0
`;

test('the stand-in presents every export doc/Browser.md names', async () => {
  const { exports } = await bootKernel();
  const drt = createMockDrtWeb(exports);
  try {
    for (const name of DRT_WEB_EXPORTS) {
      assert.equal(typeof drt[name], 'function', `missing export: ${name}`);
    }
    // The chooser's own required set must be a subset of the table, or it
    // would refuse a real module for lacking something never promised.
    for (const name of DRT_REQUIRED) {
      assert.ok(DRT_WEB_EXPORTS.includes(name), `${name} is not in the export table`);
    }
  } finally {
    drt.free();
  }
});

test('a page with both backends prefers drt-web, and can be told not to', async () => {
  const { exports } = await bootKernel();
  const drt = createMockDrtWeb(exports);
  try {
    // The vendored kernel is `libdiluvium_wasi.wasm`, which carries the
    // `dv_` ABI but no `dvs_*` -- so "both" is not reachable from it, and
    // the swarm arm is exercised in the browser spec against the module
    // that does carry one. Here: drt available, swarm not.
    const chosen = selectBackend({ exports, drtWeb: drt });
    assert.equal(chosen.name, 'drt');
    assert.match(chosen.why, /drt-web is loaded/);

    // Asked for the one that is not there, it does not invent it.
    const forced = selectBackend({ exports, drtWeb: drt, prefer: 'swarm' });
    assert.equal(forced.name, 'drt', 'a preference cannot conjure a backend');
  } finally {
    drt.free();
  }
});

test('no drt-web and no swarm layer is two labelled refusals, not an empty panel', async () => {
  const { exports } = await bootKernel();
  const chosen = selectBackend({ exports, drtWeb: null });
  assert.equal(chosen.name, null);
  const why = backendProblems(chosen);
  assert.ok(why.some((s) => s.startsWith('drt-web:')), why.join(' | '));
  assert.ok(why.some((s) => s.startsWith('the C swarm layer:')), why.join(' | '));
  // Each names the thing to go look at, rather than saying "unavailable".
  assert.match(why.join(' '), /loaded no drt-web module/);
  assert.match(why.join(' '), /no swarm layer/);
});

test('a partial drt-web is refused by the name of what it lacks', async () => {
  const { exports } = await bootKernel();
  const drt = createMockDrtWeb(exports);
  try {
    const { step, ...crippled } = drt;      // eslint-disable-line no-unused-vars
    assert.equal(drtCapable(crippled), false);
    assert.match(drtProblems(crippled)[0], /missing step/);
    // And the chooser falls through rather than picking a broken arm.
    assert.equal(selectBackend({ exports, drtWeb: crippled }).name, null);
  } finally {
    drt.free();
  }
});

test('a root runs on the stand-in, over the real bridge and the real kernel', async () => {
  const { exports } = await bootKernel();
  const drt = createMockDrtWeb(exports);
  try {
    const id = drt.root(PARKS, ['queue:*'], { instructions: 10_000_000 });
    assert.equal(drt.alive(), 1);
    assert.deepEqual(drt.ids(), [id]);
    assert.equal(drt.parent(id), 0);
    assert.equal(drt.resident(id), true);

    // `ids()` is a roster and not a pointer, so reaching the instance goes
    // through the Lab's own table -- which is the join `handleFor` exists
    // for and the structural change from `dvs_instance`.
    const handle = drt.bridge.handleFor(id);
    assert.ok(handle !== null, 'the id-to-handle join must resolve after a drive');
    assert.equal(drt.bridge.idFor(handle), id);

    drt.push(id, 'work', encode(7));
    drt.step();
    const answer = drt.bridge.pop(handle, drt.bridge.queue(handle, 'outbox'));
    assert.deepEqual(decode(answer), { saw: 7 });
    assert.deepEqual(drt.bridge.faults, []);
  } finally {
    drt.free();
  }
});

test('killing an instance releases its handle and forgets the join', async () => {
  const { exports } = await bootKernel();
  const drt = createMockDrtWeb(exports);
  try {
    const id = drt.root(PARKS, [], { instructions: 10_000_000 });
    const handle = drt.bridge.handleFor(id);
    assert.equal(drt.bridge.handles.length, 1);

    drt.kill(id);

    // Without `release` this table grows for the page's lifetime, which is
    // the leak the contract's sixteenth function exists to prevent.
    assert.deepEqual(drt.bridge.handles, []);
    assert.equal(drt.bridge.handleFor(id), null, 'a dead id must not resolve');
    assert.equal(drt.bridge.idFor(handle), null);
    assert.equal(drt.alive(), 0);
    // Ids are never reused, so the slot is still counted.
    assert.equal(drt.slotsAllocated(), 1);
  } finally {
    drt.free();
  }
});

test('hibernate and wake round-trip through real snapshot bytes', async () => {
  const { exports } = await bootKernel();
  const drt = createMockDrtWeb(exports);
  try {
    drt.setHostIdentity('lab-node');
    const id = drt.root(PARKS, [], { instructions: 10_000_000 });

    drt.hibernate(id);
    assert.equal(drt.resident(id), false);
    assert.ok(drt.cachedSize(id) > 0);
    assert.deepEqual(drt.bridge.handles, [], 'a hibernated instance holds no handle');

    drt.wake(id);
    assert.equal(drt.resident(id), true);

    // It continues rather than restarting: the message it was parked for
    // still gets an answer.
    drt.push(id, 'work', encode(11));
    drt.step();
    const handle = drt.bridge.handleFor(id);
    const answer = drt.bridge.pop(handle, drt.bridge.queue(handle, 'outbox'));
    assert.deepEqual(decode(answer), { saw: 11 });
  } finally {
    drt.free();
  }
});

test('the stand-in refuses what it cannot answer faithfully', async () => {
  const { exports } = await bootKernel();
  const drt = createMockDrtWeb(exports);
  try {
    const id = drt.root(PARKS, ['queue:*'], {});
    // An exact match needs no grammar, so it is answered.
    assert.equal(drt.holds(id, 'queue:*'), true);
    // `queue:work` against a `queue:*` grant is the grammar's job --
    // `drt-caps`, differentially tested against `dvs_holds`. A mock that
    // guessed here would be worse than one that refuses.
    assert.throws(() => drt.holds(id, 'queue:work'), new RegExp(MOCK_UNSUPPORTED));
    assert.throws(() => drt.mayGrant(id, 'queue:work'), new RegExp(MOCK_UNSUPPORTED));
  } finally {
    drt.free();
  }
});

test('bytecode is refused before it reaches the bridge', async () => {
  const { exports } = await bootKernel();
  const drt = createMockDrtWeb(exports);
  try {
    assert.throws(
      () => drt.root(new Uint8Array([0x1b, 0x4c, 0x75, 0x61]), [], {}),
      /no bytecode verifier/,
    );
    // The refusal is one place for every host, so nothing was created.
    assert.equal(drt.alive(), 0);
    assert.deepEqual(drt.bridge.handles, []);
  } finally {
    drt.free();
  }
});
