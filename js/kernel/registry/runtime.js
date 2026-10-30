/**
 * What happens after resolution (#15, "Kit"): availability from declared probes, and loaders
 * behind an error boundary. Neither runs during resolution.
 *
 * Availability comes only from what a contribution declares: its Chrome permissions, checked
 * through the root's injected `permissions.contains` (chrome.permissions.contains in a root,
 * since only roots touch chrome.*), then its `probe`. A contribution that declares either is
 * `temporarily-unavailable` until they answer. A probe may answer `enabled`, or
 * `not-applicable`, `needs-permission`, `needs-setup`, or `temporarily-unavailable` with a
 * reason code from the kit or its family. Anything else, a throw included, is
 * `temporarily-unavailable` with `probe-failed`. A probe can't enable a contribution
 * resolution didn't, and the answer's code is all the runtime keeps of it.
 *
 * A loader runs only for a contribution that's enabled now, as `status` gives it: not while
 * its probe hasn't answered or says no, or while something it requires is unavailable. Such a
 * load answers with that status and loads nothing. It runs once at a time: a second load
 * while one is in flight gets the same promise. A load that throws, rejects, or resolves to nothing is
 * tried once more, and if that fails too, the contribution is `unresolved` with
 * `load-failed` for the rest of this runtime. Probes and loaders get the root's injected
 * context and nothing else: no kernel, credential, storage, or network access of their own.
 */

import { makeResolution, internalsOf } from './resolve.js';
import { PROBE_STATES, reasonFor } from './reasons.js';

/** @typedef {import('./resolve.js').Resolution} Resolution */
/** @typedef {import('./resolve.js').Contribution} Contribution */
/** @typedef {import('./reasons.js').State} State */
/** @typedef {import('./reasons.js').ProbeState} ProbeState */

/** @typedef {'not-loaded' | 'loading' | 'loaded' | 'load-failed'} LoaderState */

/** @typedef {Readonly<{state: State, reason: string}>} Status */

/**
 * @typedef {{ok: true, implementation: unknown} | {ok: false, state: State, reason: string}} LoadOutcome
 */

/**
 * The root's own checks a runtime may call: whether the extension holds Chrome permissions
 * @typedef {{contains: (permissions: readonly string[]) => unknown}} PermissionsPort
 */

/**
 * @typedef {Readonly<{
 *   probe: (ref?: string) => Promise<void>,
 *   status: (ref: string) => Status,
 *   load: (ref: string) => Promise<LoadOutcome>,
 *   loaderState: (ref: string) => LoaderState | null,
 *   snapshot: () => Resolution,
 * }>} Runtime
 */

/** The reason a probe that answers a state without one gets */
const DEFAULT_REASONS = Object.freeze({
  enabled: 'ok',
  'not-applicable': 'not-applicable',
  'needs-permission': 'missing-permission',
  'needs-setup': 'needs-setup',
  'temporarily-unavailable': 'unavailable',
});

const ENABLED = Object.freeze({ state: /** @type {State} */ ('enabled'), reason: 'ok' });
const PENDING = Object.freeze({ state: /** @type {State} */ ('temporarily-unavailable'), reason: 'probe-pending' });
const PROBE_FAILED = Object.freeze({ state: /** @type {State} */ ('temporarily-unavailable'), reason: 'probe-failed' });
const MISSING_PERMISSION = Object.freeze({
  state: /** @type {State} */ ('needs-permission'),
  reason: 'missing-permission',
});
const LOAD_FAILED = Object.freeze({ state: /** @type {State} */ ('unresolved'), reason: 'load-failed' });
const NOT_REGISTERED = Object.freeze({ state: /** @type {State} */ ('unresolved'), reason: 'not-registered' });

/**
 * Probe and load the contributions of one resolution
 * @param {Resolution} resolution
 * @param {{context?: Readonly<Record<string, unknown>>, permissions?: PermissionsPort}} [options]
 *   `context` is what the root injects into every probe: #12 clients and declared projections
 * @returns {Runtime}
 */
export function createRuntime(resolution, { context = {}, permissions } = {}) {
  const internals = internalsOf(resolution);
  const injected = Object.freeze({ ...context });
  /** @type {Map<string, {answer: Status | null, generation: number}>} */
  const probes = new Map();
  /** @type {Map<string, {state: LoaderState, promise: Promise<LoadOutcome> | null, implementation: unknown}>} */
  const loaders = new Map();

  for (const contribution of resolution.contributions) {
    if (contribution.ref === null) continue;
    if (contribution.probed) probes.set(contribution.ref, { answer: null, generation: 0 });
    const internal = /** @type {import('./resolve.js').Internal} */ (internals.get(contribution.ref));
    loaders.set(
      contribution.ref,
      internal.implementation
        ? { state: 'loaded', promise: null, implementation: internal.implementation.value }
        : { state: 'not-loaded', promise: null, implementation: undefined },
    );
  }

  /**
   * @param {string} ref
   * @param {Set<string>} [visiting] the refs above this one, so a status never loops
   * @returns {Status}
   */
  const status = (ref, visiting = new Set()) => {
    const contribution = resolution.get(ref);
    if (!contribution) return NOT_REGISTERED;
    if (contribution.state !== 'enabled') return { state: contribution.state, reason: contribution.reason };
    if (loaders.get(ref)?.state === 'load-failed') return LOAD_FAILED;
    const probe = probes.get(ref);
    if (probe) {
      if (!probe.answer) return PENDING;
      if (probe.answer.state !== 'enabled') return probe.answer;
    }
    visiting.add(ref);
    for (const requirement of contribution.requires) {
      if (visiting.has(requirement)) continue;
      if (status(requirement, visiting).state !== 'enabled') {
        return { state: 'temporarily-unavailable', reason: 'dependency-unavailable' };
      }
    }
    visiting.delete(ref);
    return ENABLED;
  };

  /**
   * What a probe's answer means, from its state and reason code only
   * @param {Contribution} contribution
   * @param {unknown} answer
   * @returns {Status}
   */
  const read = (contribution, answer) => {
    if (answer === null || typeof answer !== 'object') return PROBE_FAILED;
    const { state, reason } = /** @type {{state?: unknown, reason?: unknown}} */ (answer);
    if (typeof state !== 'string' || !PROBE_STATES.includes(/** @type {ProbeState} */ (state))) return PROBE_FAILED;
    const code = reason === undefined ? DEFAULT_REASONS[/** @type {ProbeState} */ (state)] : reason;
    if (typeof code !== 'string') return PROBE_FAILED;
    const family = /** @type {import('./resolve.js').Internal} */ (
      internals.get(/** @type {string} */ (contribution.ref))
    ).family;
    const known = reasonFor(family.reasons, code);
    if (!known || known.state !== state) return PROBE_FAILED;
    return Object.freeze({ state: known.state, reason: code });
  };

  /**
   * @param {Contribution} contribution
   * @returns {Promise<Status>}
   */
  const ask = async contribution => {
    const internal = /** @type {import('./resolve.js').Internal} */ (
      internals.get(/** @type {string} */ (contribution.ref))
    );
    if (internal.chromePermissions.length > 0) {
      if (!permissions || typeof permissions.contains !== 'function') return MISSING_PERMISSION;
      try {
        const held = await permissions.contains(internal.chromePermissions);
        if (held !== true) return MISSING_PERMISSION;
      } catch {
        return PROBE_FAILED;
      }
    }
    const probe = internal.probe;
    if (!probe) return ENABLED;
    try {
      return read(contribution, await probe(injected));
    } catch {
      return PROBE_FAILED;
    }
  };

  /**
   * One load attempt, a throw and a missing implementation both counting as failure
   * @param {() => unknown} load
   */
  const attempt = async load => {
    const value = await load();
    if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
      throw new TypeError('loaded nothing');
    return value;
  };

  return Object.freeze({
    /**
     * Run the declared probes of every enabled contribution, or of one, and settle when
     * they've answered. Probing again keeps the last answer until the new one arrives, and
     * an answer older than the newest probe is dropped.
     * @param {string} [ref]
     */
    async probe(ref) {
      const targets = resolution.contributions.filter(
        contribution =>
          contribution.ref !== null &&
          contribution.state === 'enabled' &&
          probes.has(contribution.ref) &&
          (ref === undefined || contribution.ref === ref),
      );
      await Promise.all(
        targets.map(async contribution => {
          const entry = /** @type {{answer: Status | null, generation: number}} */ (
            probes.get(/** @type {string} */ (contribution.ref))
          );
          const generation = ++entry.generation;
          const answer = await ask(contribution);
          if (entry.generation === generation) entry.answer = answer;
        }),
      );
    },
    status: ref => status(ref),
    /**
     * The contribution's implementation, loaded once, or its status when it isn't enabled now
     * @param {string} ref
     * @returns {Promise<LoadOutcome>}
     */
    load(ref) {
      const contribution = resolution.get(ref);
      if (!contribution) return Promise.resolve({ ok: false, ...NOT_REGISTERED });
      const now = status(ref);
      if (now.state !== 'enabled') return Promise.resolve({ ok: false, state: now.state, reason: now.reason });
      const entry = /** @type {{state: LoaderState, promise: Promise<LoadOutcome> | null, implementation: unknown}} */ (
        loaders.get(ref)
      );
      if (entry.state === 'loaded') return Promise.resolve({ ok: true, implementation: entry.implementation });
      if (entry.state === 'load-failed') return Promise.resolve({ ok: false, ...LOAD_FAILED });
      if (entry.promise) return entry.promise;
      const load = /** @type {import('./resolve.js').Internal} */ (internals.get(ref)).load;
      if (!load) {
        entry.state = 'loaded';
        entry.implementation = null;
        return Promise.resolve({ ok: true, implementation: null });
      }
      entry.state = 'loading';
      entry.promise = (async () => {
        /** @type {LoadOutcome} */
        let outcome;
        try {
          entry.implementation = await attempt(load);
          entry.state = 'loaded';
          outcome = { ok: true, implementation: entry.implementation };
        } catch {
          try {
            entry.implementation = await attempt(load);
            entry.state = 'loaded';
            outcome = { ok: true, implementation: entry.implementation };
          } catch {
            entry.state = 'load-failed';
            outcome = { ok: false, ...LOAD_FAILED };
          }
        }
        entry.promise = null;
        return outcome;
      })();
      return entry.promise;
    },
    loaderState: ref => loaders.get(ref)?.state ?? null,
    /**
     * The resolution with every contribution's state as it stands now, for report.js
     */
    snapshot() {
      const contributions = resolution.contributions.map(contribution => {
        if (contribution.ref === null || contribution.state !== 'enabled') return contribution;
        const now = status(contribution.ref);
        return now.state === contribution.state && now.reason === contribution.reason
          ? contribution
          : Object.freeze({ ...contribution, state: now.state, reason: now.reason });
      });
      return makeResolution(resolution.host, resolution.families, contributions, resolution.problems, internals);
    },
  });
}
