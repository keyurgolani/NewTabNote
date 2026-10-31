/**
 * The `block` family on #15's kit, and a root's block registry (#14 slice 1, approved AC4).
 * Kernel core can't import the kit, so the family is defined here, where roots are assembled,
 * from the spec the model layer declares (js/kernel/core/blocks/contract.js).
 *
 * A block registry registers its definitions on a fresh root for its host and resolves it, so
 * every rule the kit has (ids, versions, groups and ranks, hosts, fields, fixtures, duplicates)
 * holds for block types, then checks each model as the contract does (capabilities, upcaster
 * chain, view version, a static model). Startup never throws for a bad definition: each one
 * that breaks a rule is disabled, alone, and named in `problems` with the code and the path it's
 * about. Every other type decodes and projects through the registry's catalog as usual. A type
 * for other hosts only isn't this host's: it's left out of the catalog, and it's no problem.
 *
 * `health()` is the block-health query #20's `block-types` provider joins (#14, "Diagnostics"):
 * how many of this host's types there are, enabled and disabled, and the problems' type ids,
 * codes, and paths. Content-free: nothing in it comes from a record.
 */

import { BLOCK_FAMILY_SPEC, blockProblem } from '../core/blocks/contract.js';
import { BUILT_IN_BLOCKS } from '../core/blocks/builtins.js';
import { createCatalog } from '../core/blocks/catalog.js';
import { projectionsOf } from '../core/blocks/index.js';
import { defineFamily } from '../registry/family.js';
import { createRegistryRoot } from '../registry/root.js';

/** @typedef {import('../registry/vocabulary.js').Host} Host */
/** @typedef {import('../registry/resolve.js').Resolution} Resolution */
/** @typedef {import('../core/blocks/contract.js').BlockProblem} BlockProblem */
/** @typedef {import('../core/blocks/catalog.js').Catalog} Catalog */

/**
 * What the block-health query answers
 * @typedef {Readonly<{
 *   types: number,
 *   enabled: number,
 *   disabled: number,
 *   problems: readonly Readonly<{type: string | null, code: string, field: string}>[],
 * }>} BlockHealth
 */

/**
 * @typedef {Readonly<{
 *   host: Host,
 *   resolution: Resolution,
 *   catalog: Catalog,
 *   problems: readonly BlockProblem[],
 *   projections: ReturnType<typeof projectionsOf>,
 *   health: () => BlockHealth,
 * }>} BlockRegistry
 */

/** The kit's states that mean a type is broken, as #20's providers count them */
const BROKEN_STATES = Object.freeze(['unresolved', 'temporarily-unavailable']);

/** The `block` family, which #20's block-types provider reads */
export const block = defineFamily(BLOCK_FAMILY_SPEC);

/**
 * A descriptor's id when it's a string
 * @param {unknown} descriptor
 */
const idOf = descriptor =>
  descriptor !== null && typeof descriptor === 'object' && typeof (/** @type {{id?: unknown}} */ (descriptor).id) === 'string'
    ? /** @type {string} */ (/** @type {{id: string}} */ (descriptor).id)
    : null;

/**
 * Register and check the block definitions for one host
 * @param {{host: Host, descriptors?: readonly unknown[]}} options
 * @returns {BlockRegistry}
 */
export function createBlockRegistry({ host, descriptors = BUILT_IN_BLOCKS }) {
  const root = createRegistryRoot({ host });
  root.register(block, descriptors);
  const resolution = root.resolve();

  // What the kit didn't resolve, by the id it gave (a duplicate's both copies). A type for
  // other hosts only isn't this host's, so it's left out of the catalog, but it isn't broken:
  // only an unresolved or temporarily unavailable type is a problem
  /** @type {BlockProblem[]} */
  const kitProblems = [];
  /** @type {Set<string>} */
  const unresolved = new Set();
  /** @type {Set<string>} */
  const elsewhere = new Set();
  for (const contribution of resolution.list(block.id)) {
    if (contribution.state === 'enabled') continue;
    const type = contribution.id ?? contribution.rawId;
    if (type !== null) unresolved.add(type);
    if (!BROKEN_STATES.includes(contribution.state)) {
      if (type !== null) elsewhere.add(type);
      continue;
    }
    kitProblems.push(
      contribution.reason === 'duplicate-id'
        ? blockProblem(contribution.id, 'duplicate-id', 'id')
        : blockProblem(contribution.id, 'unresolved', contribution.reason),
    );
  }

  // The model checks run on what the kit resolved; a duplicate is reported once
  const resolved = descriptors.filter(descriptor => {
    const id = idOf(descriptor);
    return id !== null && !unresolved.has(id);
  });
  const catalog = createCatalog(resolved);
  /** @type {BlockProblem[]} */
  const seen = [];
  for (const problem of [...kitProblems, ...catalog.problems]) {
    if (!seen.some(other => other.type === problem.type && other.code === problem.code && other.field === problem.field)) {
      seen.push(problem);
    }
  }
  const problems = Object.freeze(seen);
  // This host's types: a type for other hosts only is neither enabled nor disabled here
  const types = new Set(descriptors.map(idOf).filter(id => id !== null && !elsewhere.has(id)));

  return Object.freeze({
    host,
    resolution,
    catalog,
    problems,
    projections: projectionsOf(catalog),
    health: () =>
      Object.freeze({
        types: types.size,
        enabled: catalog.types.length,
        disabled: types.size - catalog.types.length,
        problems: Object.freeze(problems.map(({ type, code, field }) => Object.freeze({ type, code, field }))),
      }),
  });
}
