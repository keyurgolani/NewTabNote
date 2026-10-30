/**
 * Resolution (#15, "Kit"): every family's descriptors in one root, to one state per
 * contribution. It's synchronous, does no I/O, and calls no loader or probe. The same
 * descriptors and input give the same states and browse order whatever order they were
 * registered in, so a root can rerun it on every service worker wake. Only descriptors that
 * have no place to sort by (an invalid or repeated id) fall back to registration order.
 *
 * What one descriptor gets wrong is validate.js's. Here, across descriptors: two with one id
 * in a family are both unresolved, and so are two with one group and rank, two binding one
 * chord on a platform, and every member of a `requires` cycle. Something that requires a
 * missing or unresolved contribution is unresolved too. Then, for this root: a contribution
 * for another host, or one whose requirement is turned off or runs elsewhere, isn't
 * applicable, one the user turned off is `disabled-by-user`, and a placeholder is
 * `not-implemented`. Everything else is `enabled`, until probes run (runtime.js).
 */

import { refOf } from './ids.js';
import { PLATFORMS } from './chords.js';
import { checkDescriptor } from './validate.js';

/** @typedef {import('./family.js').Family} Family */
/** @typedef {import('./vocabulary.js').Host} Host */
/** @typedef {import('./reasons.js').State} State */
/** @typedef {import('./validate.js').Checked} Checked */
/** @typedef {import('./validate.js').Probe} Probe */
/** @typedef {import('./chords.js').Platform} Platform */

/**
 * One contribution as a resolution projects it, frozen. `ref` and `id` are null when the
 * descriptor's id isn't valid, and `rawId` is what it said. `chords` is what each platform
 * presses. `related` names the refs a conflict or requirement is about.
 * @typedef {Readonly<{
 *   ref: string | null,
 *   family: string,
 *   id: string | null,
 *   rawId: string | null,
 *   version: number | null,
 *   group: string | null,
 *   rank: number | null,
 *   hosts: readonly Host[],
 *   requires: readonly string[],
 *   chords: Readonly<Record<Platform, readonly string[]>> | null,
 *   privileged: boolean,
 *   lazy: boolean,
 *   probed: boolean,
 *   state: State,
 *   reason: string,
 *   related: readonly string[],
 *   data: Readonly<Record<string, unknown>>,
 * }>} Contribution
 */

/**
 * Something about a contribution that npm test fails on in a built-in, whatever the host
 * @typedef {Readonly<{family: string, id: string | null, code: string, field: string}>} ResolutionProblem
 */

/**
 * A family as a resolution names it: its id, contract version, and its own reasons, which
 * the report reads for the codes its probes answer with
 * @typedef {Readonly<{id: string, apiVersion: number, reasons: Readonly<Record<string, import('./reasons.js').Reason>>}>} FamilyInfo
 */

/**
 * A resolved root, frozen: its contributions sorted by family, then browse order (group, then
 * rank), then id, and the problems in them. `list` gives one family's in browse order.
 * @typedef {Readonly<{
 *   host: Host,
 *   families: readonly FamilyInfo[],
 *   contributions: readonly Contribution[],
 *   problems: readonly ResolutionProblem[],
 *   get: (ref: string) => Contribution | undefined,
 *   list: (family: string) => readonly Contribution[],
 * }>} Resolution
 */

/**
 * What runtime.js needs and a projection doesn't hand out: each enabled-able contribution's
 * loader, static implementation, probe, family, and declared Chrome permissions
 * @typedef {Readonly<{
 *   family: Family,
 *   load: (() => unknown) | null,
 *   implementation: {value: unknown} | null,
 *   probe: Probe | null,
 *   chromePermissions: readonly string[],
 * }>} Internal
 */

/** The field each cross-descriptor problem is about */
/** @type {Readonly<Record<string, string>>} */
const PROBLEM_FIELDS = Object.freeze({
  'duplicate-id': 'id',
  'ordering-conflict': 'rank',
  'chord-conflict': 'chords',
  'dependency-cycle': 'requires',
  'missing-dependency': 'requires',
  'dependency-unresolved': 'requires',
});

/** @type {WeakMap<object, ReadonlyMap<string, Internal>>} */
const INTERNALS = new WeakMap();

/**
 * The loaders, implementations, and probes behind a resolution, for runtime.js
 * @param {Resolution} resolution
 * @returns {ReadonlyMap<string, Internal>}
 */
export function internalsOf(resolution) {
  const internals = INTERNALS.get(resolution);
  if (!internals) throw new TypeError('not a resolution from this registry kit');
  return internals;
}

/**
 * Build a frozen resolution from sorted contributions
 * @param {Host} host
 * @param {readonly FamilyInfo[]} families
 * @param {readonly Contribution[]} contributions
 * @param {readonly ResolutionProblem[]} problems
 * @param {ReadonlyMap<string, Internal>} internals
 * @returns {Resolution}
 */
export function makeResolution(host, families, contributions, problems, internals) {
  /** @type {Map<string, Contribution>} */
  const byRef = new Map();
  /** @type {Map<string, Contribution[]>} */
  const byFamily = new Map(families.map(family => [family.id, []]));
  for (const contribution of contributions) {
    if (contribution.ref !== null) byRef.set(contribution.ref, contribution);
    /** @type {Contribution[]} */ (byFamily.get(contribution.family)).push(contribution);
  }
  const lists = new Map([...byFamily].map(([id, list]) => [id, Object.freeze(list)]));
  /** @type {Resolution} */
  const resolution = Object.freeze({
    host,
    families: Object.freeze(families),
    contributions: Object.freeze([...contributions]),
    problems: Object.freeze([...problems]),
    get: (/** @type {string} */ ref) => byRef.get(ref),
    list: (/** @type {string} */ family) => lists.get(family) ?? Object.freeze([]),
  });
  INTERNALS.set(resolution, internals);
  return resolution;
}

/**
 * @typedef {object} Node
 * @property {Family} family
 * @property {Checked} checked
 * @property {number} index registration order, the last tiebreak
 * @property {string | null} ref null for an invalid or duplicated id
 * @property {string | null} conflict
 * @property {Set<string>} related
 */

/**
 * Resolve every registered descriptor for one host
 * @param {Host} host
 * @param {ReadonlyMap<string, {family: Family, descriptors: readonly unknown[]}>} registered by family id
 * @param {{disabled?: Readonly<Record<string, readonly string[]>>}} [input] the ids the user
 *   turned off, by family; ids nothing has are kept and ignored
 * @returns {Resolution}
 */
export function resolve(host, registered, { disabled = {} } = {}) {
  const familyIds = [...registered.keys()].sort();
  /** @type {Node[]} */
  const nodes = [];
  /** @type {Map<string, Node>} */
  const byRef = new Map();
  /** @type {Set<string>} */
  const repeated = new Set();

  for (const familyId of familyIds) {
    const { family, descriptors } = /** @type {{family: Family, descriptors: readonly unknown[]}} */ (
      registered.get(familyId)
    );
    /** @type {Node[]} */
    const members = descriptors.map((descriptor, index) => ({
      family,
      checked: checkDescriptor(family, descriptor),
      index,
      ref: null,
      conflict: null,
      related: new Set(),
    }));
    nodes.push(...members);

    // One id, one contribution: every holder of a repeated id is unresolved, so neither wins
    /** @type {Map<string, Node[]>} */
    const byId = new Map();
    for (const node of members) {
      if (node.checked.id === null) continue;
      const holders = byId.get(node.checked.id) ?? [];
      holders.push(node);
      byId.set(node.checked.id, holders);
    }
    for (const [id, holders] of byId) {
      if (holders.length === 1) {
        holders[0].ref = refOf(familyId, id);
        byRef.set(holders[0].ref, holders[0]);
      } else {
        repeated.add(refOf(familyId, id));
        for (const node of holders) node.conflict = 'duplicate-id';
      }
    }

    const valid = members.filter(node => node.checked.problems.length === 0 && node.conflict === null);
    conflicts(valid, node => [`${node.checked.groupIndex}:${node.checked.rank}`], 'ordering-conflict');
    conflicts(
      valid,
      node =>
        node.checked.pressed
          ? PLATFORMS.flatMap(platform => node.checked.pressed?.[platform].map(chord => `${platform}:${chord}`) ?? [])
          : [],
      'chord-conflict',
    );
  }

  const cyclic = cycles(byRef);

  /** @type {Map<Node, {state: State, reason: string}>} */
  const states = new Map();
  /** @param {Node} node @returns {{state: State, reason: string}} */
  const stateOf = node => {
    const known = states.get(node);
    if (known) return known;
    const result = decide(node);
    states.set(node, result);
    return result;
  };
  /** @param {Node} node @returns {{state: State, reason: string}} */
  const decide = node => {
    const { checked, family } = node;
    if (checked.problems.length > 0) return { state: 'unresolved', reason: checked.problems[0].code };
    if (node.conflict) return { state: 'unresolved', reason: node.conflict };
    if (node.ref && cyclic.has(node.ref)) {
      for (const ref of /** @type {Set<string>} */ (cyclic.get(node.ref))) node.related.add(ref);
      return { state: 'unresolved', reason: 'dependency-cycle' };
    }
    /** @type {{state: State, reason: string} | null} */
    let blocked = null;
    for (const requirement of checked.requires) {
      const ref = refOf(requirement.family, requirement.id);
      const target = byRef.get(ref);
      if (!target) {
        node.related.add(ref);
        return { state: 'unresolved', reason: repeated.has(ref) ? 'dependency-unresolved' : 'missing-dependency' };
      }
      const { state } = stateOf(target);
      if (state === 'unresolved' || state === 'not-implemented') {
        node.related.add(ref);
        return { state: 'unresolved', reason: 'dependency-unresolved' };
      }
      if (!blocked && (state === 'not-applicable' || state === 'disabled-by-user')) {
        node.related.add(ref);
        blocked = {
          state: 'not-applicable',
          reason: state === 'disabled-by-user' ? 'dependency-disabled' : 'dependency-not-applicable',
        };
      }
    }
    if (checked.notImplemented) return { state: 'not-implemented', reason: 'not-implemented' };
    if (!checked.hosts.includes(host)) return { state: 'not-applicable', reason: 'other-host' };
    if (blocked) return blocked;
    const off = Object.hasOwn(disabled, family.id) ? disabled[family.id] : [];
    if (Array.isArray(off) && checked.id !== null && off.includes(checked.id)) {
      return { state: 'disabled-by-user', reason: 'disabled-by-user' };
    }
    return { state: 'enabled', reason: 'ok' };
  };

  /** @type {ResolutionProblem[]} */
  const problems = [];
  /** @type {Map<string, Internal>} */
  const internals = new Map();
  const ordered = [...nodes].sort(byBrowseOrder);
  const contributions = ordered.map(node => {
    const { checked, family } = node;
    const { state, reason } = stateOf(node);
    for (const problem of checked.problems)
      problems.push(Object.freeze({ family: family.id, id: checked.rawId, ...problem }));
    if (checked.problems.length === 0 && state === 'unresolved') {
      problems.push(
        Object.freeze({ family: family.id, id: checked.rawId, code: reason, field: PROBLEM_FIELDS[reason] ?? '' }),
      );
    }
    if (node.ref !== null) {
      internals.set(
        node.ref,
        Object.freeze({
          family,
          load: checked.load,
          implementation: checked.implementation,
          probe: checked.probe,
          chromePermissions: /** @type {readonly string[]} */ (checked.data.chromePermissions ?? []),
        }),
      );
    }
    /** @type {Contribution} */
    const contribution = Object.freeze({
      ref: node.ref,
      family: family.id,
      id: checked.id,
      rawId: checked.rawId,
      version: checked.version,
      group: checked.ordered ? family.groups[checked.groupIndex] : null,
      rank: checked.ordered ? checked.rank : null,
      hosts: checked.hosts,
      requires: Object.freeze(checked.requires.map(requirement => refOf(requirement.family, requirement.id))),
      chords: checked.pressed,
      privileged: checked.privileged,
      lazy: checked.load !== null,
      probed:
        checked.probe !== null ||
        (Array.isArray(checked.data.chromePermissions) && checked.data.chromePermissions.length > 0),
      state,
      reason,
      related: Object.freeze([...node.related].sort()),
      data: checked.data,
    });
    return contribution;
  });

  const families = familyIds.map(id => {
    const { family } = /** @type {{family: Family}} */ (registered.get(id));
    return Object.freeze({ id: family.id, apiVersion: family.apiVersion, reasons: family.reasons });
  });
  return makeResolution(host, families, contributions, problems, internals);
}

/**
 * Mark every node that shares a key with another as unresolved with `code`
 * @param {Node[]} nodes
 * @param {(node: Node) => string[]} keysOf
 * @param {string} code
 */
function conflicts(nodes, keysOf, code) {
  /** @type {Map<string, Node[]>} */
  const byKey = new Map();
  for (const node of nodes) {
    for (const key of keysOf(node)) {
      const holders = byKey.get(key) ?? [];
      if (!holders.includes(node)) holders.push(node);
      byKey.set(key, holders);
    }
  }
  for (const holders of byKey.values()) {
    if (holders.length < 2) continue;
    for (const node of holders) {
      node.conflict ??= code;
      for (const other of holders) if (other !== node && other.ref) node.related.add(other.ref);
    }
  }
}

/**
 * Every ref on a `requires` cycle, with the refs of its cycle, by Tarjan's strongly connected
 * components, iteratively so a long chain can't overflow the stack
 * @param {ReadonlyMap<string, Node>} byRef
 * @returns {Map<string, Set<string>>}
 */
function cycles(byRef) {
  /** @type {Map<string, string[]>} */
  const edges = new Map();
  for (const [ref, node] of byRef) {
    edges.set(
      ref,
      node.checked.requires
        .map(requirement => refOf(requirement.family, requirement.id))
        .filter(target => byRef.has(target)),
    );
  }
  /** @type {Map<string, Set<string>>} */
  const cyclic = new Map();
  /** @type {Map<string, number>} */
  const index = new Map();
  /** @type {Map<string, number>} */
  const low = new Map();
  /** @type {string[]} */
  const stack = [];
  const onStack = new Set();
  let next = 0;

  for (const start of [...edges.keys()].sort()) {
    if (index.has(start)) continue;
    /** @type {{ref: string, edge: number}[]} */
    const work = [{ ref: start, edge: 0 }];
    index.set(start, next);
    low.set(start, next++);
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const targets = /** @type {string[]} */ (edges.get(frame.ref));
      if (frame.edge < targets.length) {
        const target = targets[frame.edge++];
        if (!index.has(target)) {
          index.set(target, next);
          low.set(target, next++);
          stack.push(target);
          onStack.add(target);
          work.push({ ref: target, edge: 0 });
        } else if (onStack.has(target)) {
          low.set(
            frame.ref,
            Math.min(/** @type {number} */ (low.get(frame.ref)), /** @type {number} */ (index.get(target))),
          );
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].ref;
        low.set(parent, Math.min(/** @type {number} */ (low.get(parent)), /** @type {number} */ (low.get(frame.ref))));
      }
      if (low.get(frame.ref) === index.get(frame.ref)) {
        /** @type {string[]} */
        const component = [];
        let member;
        do {
          member = /** @type {string} */ (stack.pop());
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.ref);
        const selfLoop = component.length === 1 && /** @type {string[]} */ (edges.get(frame.ref)).includes(frame.ref);
        if (component.length > 1 || selfLoop) {
          const members = new Set(component);
          for (const ref of component) cyclic.set(ref, members);
        }
      }
    }
  }
  return cyclic;
}

/**
 * Family, then group, then rank, then id; descriptors without a comparable place sort after
 * the rest of their family by the id they wrote, then by registration order
 * @param {Node} a
 * @param {Node} b
 */
function byBrowseOrder(a, b) {
  if (a.family.id !== b.family.id) return a.family.id < b.family.id ? -1 : 1;
  const placed = (/** @type {Node} */ node) => node.checked.ordered && node.checked.compatible;
  if (placed(a) !== placed(b)) return placed(a) ? -1 : 1;
  if (placed(a)) {
    if (a.checked.groupIndex !== b.checked.groupIndex) return a.checked.groupIndex - b.checked.groupIndex;
    if (a.checked.rank !== b.checked.rank) return a.checked.rank - b.checked.rank;
  }
  const aId = a.checked.rawId ?? '';
  const bId = b.checked.rawId ?? '';
  if (aId !== bId) return aId < bId ? -1 : 1;
  return a.index - b.index;
}
