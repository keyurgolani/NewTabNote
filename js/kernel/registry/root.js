/**
 * A registry root (#15, "Kit"): what a composition root assembles its built-ins in. It takes
 * each family's descriptors at startup, then locks: the first resolve locks it, and
 * registering after that throws, so what a root runs is fixed once it starts. Entries from
 * user data (installed models, user destinations, prompt templates) aren't descriptors; their
 * family resolves them as records, so the lock doesn't cover them.
 *
 * Resolving again is allowed, with other input (the ids the user turned off), and gives a new
 * frozen resolution. Each resolution is what runtime.js probes and loads, and what report.js
 * explains.
 */

import { isFamily } from './family.js';
import { resolve as resolveRegistered } from './resolve.js';
import { HOSTS, LIMITS } from './vocabulary.js';

/** @typedef {import('./family.js').Family} Family */
/** @typedef {import('./vocabulary.js').Host} Host */
/** @typedef {import('./resolve.js').Resolution} Resolution */

/**
 * @typedef {Readonly<{
 *   host: Host,
 *   register: (family: Family, descriptors: readonly unknown[]) => void,
 *   lock: () => void,
 *   readonly locked: boolean,
 *   resolve: (input?: {disabled?: Readonly<Record<string, readonly string[]>>}) => Resolution,
 * }>} RegistryRoot
 */

/**
 * A root for one host
 * @param {{host: Host}} options
 * @returns {RegistryRoot}
 */
export function createRegistryRoot({ host }) {
  if (!HOSTS.includes(host)) throw new TypeError(`registry root: host must be one of ${HOSTS.join(', ')}`);
  /** @type {Map<string, {family: Family, descriptors: unknown[]}>} */
  const registered = new Map();
  let locked = false;

  return Object.freeze({
    host,
    /**
     * Add a family's descriptors. Several modules may register one family; its descriptors
     * join in the order they arrive. Each descriptor is copied, so changing it later changes
     * nothing here.
     * @param {Family} family
     * @param {readonly unknown[]} descriptors
     */
    register(family, descriptors) {
      if (locked) throw new Error(`registry root (${host}) is locked: register built-ins before the first resolve`);
      if (!isFamily(family)) throw new TypeError('registry root: register takes a family from defineFamily');
      if (!Array.isArray(descriptors)) throw new TypeError(`registry root: ${family.id} needs a list of descriptors`);
      const entry = registered.get(family.id) ?? { family, descriptors: [] };
      if (entry.family !== family) throw new Error(`registry root (${host}): two families are named ${family.id}`);
      if (entry.descriptors.length + descriptors.length > LIMITS.contributionsPerFamily) {
        throw new RangeError(
          `registry root (${host}): ${family.id} has more than ${LIMITS.contributionsPerFamily} contributions`,
        );
      }
      for (const descriptor of descriptors) {
        const copy =
          descriptor !== null && typeof descriptor === 'object' && !Array.isArray(descriptor)
            ? Object.freeze({ ...descriptor })
            : descriptor;
        entry.descriptors.push(copy);
      }
      registered.set(family.id, entry);
    },
    lock() {
      locked = true;
    },
    get locked() {
      return locked;
    },
    resolve(input = {}) {
      locked = true;
      return resolveRegistered(host, registered, input);
    },
  });
}
