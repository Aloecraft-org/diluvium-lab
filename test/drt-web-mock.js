// A stand-in for `drt-web`, so the Lab's side can be built before it ships.
//
// The mirror of what the DRT session already did in the other direction:
// `crates/drt-web/tests/bridge.rs` fakes a *diluvium instance* in Rust so a
// real `Swarm` can be driven under ordinary `cargo test`. This fakes the
// *swarm* in JavaScript so the Lab's real bridge, real kernel and real
// panel wiring can be driven with no wasm-bindgen module present.
//
// ## What this is and is not
//
// It presents `doc/Browser.md`'s export table -- the names, the arities,
// the return shapes -- over the Lab's real `createBridge`. Every instance
// it makes is a genuine `dv_` instance in the real kernel, and every step
// crosses the real boundary. So what it exercises is the *plumbing*: does
// the Lab's code hold the right shape, does the id-to-handle join work,
// does a fault arrive as a value.
//
// It is emphatically **not** a second swarm implementation. It does not do
// attenuation, provenance, hibernation policy, spawn rate limits, the
// bounded wake buffer or the four-row delivery table. DRT's swarm does all
// of that and is differentially tested against `dvs.c` at exact fidelity
// (37 checks, `drt-bench`); reimplementing any of it here would be
// re-deriving their work badly and then trusting the copy. Where this
// cannot answer faithfully it says so -- `MOCK_UNSUPPORTED` -- rather than
// inventing a plausible number, because a mock that lies is worse than one
// that refuses.
//
// When `drt-web` lands, this file is deleted and the specs that use it
// point at the real module. If they need editing to do that, this file was
// wrong about the shape, which is the other thing it is for.

import { createBridge } from '../src/kernel/bridge.js';

/** Thrown for the surface this deliberately does not implement. */
export const MOCK_UNSUPPORTED = 'not implemented by the drt-web stand-in';

/** `doc/Browser.md`'s export table, so a spec can assert the shape. */
export const DRT_WEB_EXPORTS = [
  'free', 'root', 'step', 'alive', 'ids', 'parent', 'kill', 'push',
  'budget', 'caps', 'holds', 'resident', 'cachedSize', 'abiVersion',
  'hibernate', 'wake', 'wakeOnMessage', 'mayGrant', 'slotsAllocated',
  'allowHibernation', 'allowBytecode', 'allowUnsafeStdlib', 'setHostIdentity',
];

/**
 * A `Swarm`, as `drt-web` will present one.
 *
 * `Swarm.new(maxInstances, spawnsPerStep)` in the export table; a factory
 * here because a JS class constructor cannot take the bridge the Rust one
 * receives at construction.
 */
export function createMockDrtWeb(exports, options = {}) {
  const { maxInstances = 64, spawnsPerStep = 8 } = options;

  /** id -> what the mock swarm knows. Ids are never reused, as in `dvs.c`. */
  const slots = new Map();
  let nextId = 1;
  let hostIdentity = null;
  let bytecodeAllowed = false;
  let hibernationAllowed = true;
  let unsafeStdlib = false;
  let freed = false;

  // The real bridge, over the real kernel. The mock drives instances
  // through it exactly as `drt-web` will.
  const bridge = createBridge(exports, {
    drive: (id, handle, b) => {
      const slot = slots.get(id);
      if (!slot) return { faulted: `no slot for id ${id}` };
      if (slot.pump) slot.pump(id, handle, b);       // the Lab's own pump
      const wait = b.currentWait(handle);
      const step = wait
        ? b.resume(handle, slot.fired ?? wait.queues[0] ?? 0)
        : b.run(handle);
      slot.fired = null;
      return step.done ? 'exited' : 'alive';
    },
  });

  const live = () => [...slots.entries()].filter(([, s]) => !s.gone);

  function needAlive() {
    if (freed) throw new Error('this swarm has been freed');
  }

  const swarm = {
    // --- the export table --------------------------------------------

    abiVersion: () => bridge.abiVersion(),

    /** `root(code, caps, budget)` -> the root instance's id. */
    root(code, caps = [], budget = {}) {
      needAlive();
      if (slots.size >= maxInstances) {
        throw new Error(`the instance table is full (${maxInstances})`);
      }
      if (code instanceof Uint8Array && !bytecodeAllowed) {
        // The refusal DRT makes before the bridge is reached, kept here so
        // the Lab sees the same one it will see from the real module.
        throw new Error('the browser engine loads source only: there is no '
          + 'bytecode verifier (GUARANTEES.md), and a precompiled chunk is '
          + 'refused rather than trusted');
      }
      const id = nextId++;
      const handle = bridge.load(String(code), `instance-${id}`, budget, unsafeStdlib);
      slots.set(id, {
        handle, parent: 0, caps: [...caps], budget, gone: false,
        resident: true, pump: null, fired: null,
      });
      // The pairing the Lab needs. Recorded by driving once, which is also
      // what the real swarm does on its first step.
      bridge.drive(id, handle);
      return id;
    },

    /** `step()` -> the alive count, as the export table says. */
    step() {
      needAlive();
      for (const [id, slot] of live()) {
        if (!slot.resident) continue;                // hibernated: it sleeps
        const out = bridge.drive(id, slot.handle);
        if (out === 'exited') swarm.kill(id);
        else if (out && out.faulted) { slot.fault = out.faulted; swarm.kill(id); }
      }
      return swarm.alive();
    },

    alive: () => live().length,
    ids: () => live().map(([id]) => id),
    slotsAllocated: () => slots.size,
    parent: (id) => slots.get(id)?.parent ?? 0,

    kill(id) {
      const slot = slots.get(id);
      if (!slot || slot.gone) return;
      slot.gone = true;
      bridge.release(slot.handle);       // the leak `release` exists to stop
    },

    push(id, queue, msgpackBytes) {
      needAlive();
      const slot = slots.get(id);
      if (!slot || slot.gone) throw new Error(`no instance ${id}`);
      const q = typeof queue === 'string' ? bridge.queue(slot.handle, queue) : queue;
      if (q === null) throw new Error(`instance ${id} has no queue ${queue}`);
      slot.fired = q;
      return bridge.push(slot.handle, q, msgpackBytes);
    },

    budget: (id) => slots.get(id)?.budget ?? null,
    caps: (id) => slots.get(id)?.caps ?? null,

    /**
     * `holds(id, cap)` -- the one place the mock's shallowness shows, and
     * it is flagged rather than hidden. This is a literal match against the
     * grant list. The real `Swarm::holds` runs `drt-caps`' grammar --
     * `host:fs/*` covering call names the way `queue:*` covers queues, with
     * attenuation and provenance behind it, differentially tested against
     * `dvs_holds`. A wildcard answered here would be a guess wearing the
     * same name.
     */
    holds(id, cap) {
      const caps = slots.get(id)?.caps;
      if (!caps) return false;
      // An exact match needs no grammar, so it is answered. Only a question
      // that would require *matching* a wildcard is refused, which keeps
      // the refusal to the cases where a guess would actually be a guess.
      if (caps.includes(cap)) return true;
      if (caps.some((c) => c.includes('*'))) throw new Error(MOCK_UNSUPPORTED);
      return false;
    },

    mayGrant() { throw new Error(MOCK_UNSUPPORTED); },

    resident: (id) => slots.get(id)?.resident === true,
    cachedSize: (id) => (slots.get(id)?.resident === false ? 1 : 0),
    wakeOnMessage: () => false,

    hibernate(id) {
      if (!hibernationAllowed) throw new Error('hibernation is not allowed on this swarm');
      const slot = slots.get(id);
      if (!slot || slot.gone) throw new Error(`no instance ${id}`);
      // Real snapshot bytes through the real ABI: the part worth exercising.
      slot.snapshot = bridge.snapshot(slot.handle, hostIdentity);
      bridge.release(slot.handle);
      slot.handle = null;
      slot.resident = false;
    },

    wake(id) {
      const slot = slots.get(id);
      if (!slot || slot.gone) throw new Error(`no instance ${id}`);
      if (slot.resident) return;
      slot.handle = bridge.restore(slot.snapshot, hostIdentity, slot.budget, unsafeStdlib);
      slot.resident = true;
      bridge.drive(id, slot.handle);     // re-establish the id-to-handle join
    },

    allowHibernation: (on) => { hibernationAllowed = !!on; },
    allowBytecode: (on) => { bytecodeAllowed = !!on; },
    allowUnsafeStdlib: (on) => { unsafeStdlib = !!on; },
    setHostIdentity: (name) => { hostIdentity = name == null ? null : String(name); },

    free() {
      if (freed) return;
      freed = true;
      bridge.destroy();
      slots.clear();
    },

    // --- not part of the export table ---------------------------------

    /** The bridge underneath, so a spec can reach the real instances. */
    bridge,

    /** Attach the Lab's hostcall pump to an instance, as swarm.js will. */
    setPump(id, pump) {
      const slot = slots.get(id);
      if (slot) slot.pump = pump;
    },

    /** Whether this is the stand-in. The real module will not have it. */
    isMock: true,
  };

  return swarm;
}
