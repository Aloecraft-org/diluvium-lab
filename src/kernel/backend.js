// Which swarm backend this page is going to use, and why.
//
// There are two, and for a while there will be two: the C swarm layer
// (`diluvium_swarm_wasi.wasm`, driven through `dvs_*` by `swarm.js`) and
// DRT's (`drt-web`, driven through its export table over the host bridge in
// `bridge.js`). `doc/Browser.md` names this seam explicitly -- *"`swarm.js`'s
// `swarmCapable(exports)` is already the seam where a second backend is
// recognised; a `drtCapable` beside it is the natural migration"* -- and
// this is that beside.
//
// ## Why a chooser at all, rather than a swap
//
// Because for a while both are true and neither is guessable from a version
// string. A page may hold a runtime old enough to have no swarm layer, one
// with the C layer and no `drt-web` alongside, or both. The panel has to
// say which it got and, when it got neither, say what each one refused --
// an empty panel points at nothing, which is the argument `swarmProblems`
// already makes for itself.
//
// ## The preference, and why it is a default rather than a rule
//
// DRT wins when both are available. It is where the swarm is going: the C
// layer is deleted from diluvium once DRT's swarm passes acceptance, and a
// page that has both today will have only DRT tomorrow. But it is a
// `prefer` argument rather than a hardcoded order, because running one
// notebook against two backends is exactly the comparison this project
// exists to make -- the same argument the version dropdown already won.

import { swarmCapable, swarmProblems } from './swarm.js';
import { bridgeCapable, bridgeProblems } from './bridge.js';

/**
 * `doc/Browser.md`'s export table: what a `drt-web` module presents.
 *
 * Checked by name rather than trusted, for the same reason `swarmCapable`
 * checks `dvs_*` by name: the object arrives from another build, and a
 * partial one should be refused with a sentence rather than fail at the
 * first call it cannot make.
 */
export const DRT_REQUIRED = [
  'free', 'root', 'step', 'alive', 'ids', 'parent', 'kill', 'push',
  'budget', 'caps', 'holds', 'resident', 'cachedSize', 'abiVersion',
];

/** Can this object be driven as a DRT swarm? */
export function drtCapable(drtWeb) {
  if (!drtWeb) return false;
  if (!DRT_REQUIRED.every((name) => typeof drtWeb[name] === 'function')) return false;
  try {
    // The engine's ABI, reported through the bridge it was built with. A
    // `drt-web` wired to a kernel the Lab cannot speak is not usable here
    // however complete its own surface is.
    return drtWeb.abiVersion() === 1;
  } catch {
    return false;
  }
}

/** Why an object cannot be driven as a DRT swarm, as sentences. */
export function drtProblems(drtWeb) {
  if (!drtWeb) return ['this page loaded no drt-web module'];
  const missing = DRT_REQUIRED.filter((name) => typeof drtWeb[name] !== 'function');
  if (missing.length) return [`this drt-web is missing ${missing.join(', ')}`];
  let abi;
  try {
    abi = drtWeb.abiVersion();
  } catch (err) {
    return [`this drt-web's abiVersion() threw: ${err.message}`];
  }
  if (abi !== 1) {
    return [`this drt-web reports dv ABI v${abi}, and the Lab speaks v1`];
  }
  return [];
}

/**
 * Pick a backend, and be able to say why.
 *
 * @param {object} options
 * @param {object} [options.exports] the kernel module's exports
 * @param {object} [options.drtWeb] a `drt-web` swarm, when the page has one
 * @param {'drt'|'swarm'} [options.prefer] which wins when both are usable
 * @returns {{name: 'drt'|'swarm'|null, why: string, problems: object}}
 */
export function selectBackend({ exports, drtWeb = null, prefer = 'drt' } = {}) {
  // Two questions per backend, deliberately not one. DRT needs *both* a
  // usable drt-web and a kernel this page can bridge to, because the swarm
  // and the interpreter are separate modules there -- which is the whole
  // shape of the browser tier. The C backend needs one module that carries
  // both, which is what made it a single question.
  const drtOk = drtCapable(drtWeb) && bridgeCapable(exports);
  const swarmOk = swarmCapable(exports);

  const problems = {
    drt: drtCapable(drtWeb) ? bridgeProblems(exports) : drtProblems(drtWeb),
    swarm: swarmProblems(exports),
  };

  if (drtOk && swarmOk) {
    const name = prefer === 'swarm' ? 'swarm' : 'drt';
    const other = name === 'drt' ? 'the C swarm layer' : 'drt-web';
    return {
      name,
      why: `this page has both backends; ${name === 'drt' ? 'drt-web' : 'the C swarm layer'} `
        + `was preferred and ${other} is also available`,
      problems,
    };
  }
  if (drtOk) {
    return { name: 'drt', why: 'drt-web is loaded and the kernel can be bridged to it', problems };
  }
  if (swarmOk) {
    return {
      name: 'swarm',
      // Worth naming rather than passing over in silence: this is the
      // backend that goes away, and a page running on it is a page that
      // will need the other one.
      why: 'this runtime carries the C swarm layer; no drt-web is loaded',
      problems,
    };
  }
  return {
    name: null,
    why: 'this page has no swarm backend',
    problems,
  };
}

/**
 * The sentences a panel shows when `selectBackend` found nothing.
 *
 * Both refusals, labelled, because which one matters depends on what the
 * reader was expecting: someone on an old runtime wants the C layer's
 * answer, and someone mid-migration wants DRT's.
 */
export function backendProblems(selection) {
  if (!selection || selection.name) return [];
  return [
    ...selection.problems.drt.map((why) => `drt-web: ${why}`),
    ...selection.problems.swarm.map((why) => `the C swarm layer: ${why}`),
  ];
}
