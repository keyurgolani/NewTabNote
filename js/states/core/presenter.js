/**
 * The states presenter (#26, "View states"): one pure function that turns what happened, the
 * contribution's state rows and the surface into the state a person sees. It takes #12's outcomes,
 * a bulk, #12's query states, an optimistic `pending`, an `unknown` being checked or cleared for
 * one resend, and #20's provider statuses, and returns message keys, typed parameters and tokens
 * only, never an input's own text. It imports no catalog chunk, so a surface loads strings only
 * when it shows them.
 *
 * A row the contribution's matrix gives for the state sets its headline, placement, politeness and
 * what it preserves. Without one, the state's own headline and the defaults below apply.
 */

import { KERNEL_CAUSES, causeIdFor } from './causes.js';
import { INSPECT } from './vocabulary.js';

/**
 * #20's provider statuses as #26's View states map them. `degraded` is partial where the
 * contribution has a partial row, and stale where it hasn't. A test holds the keys to #20's list.
 */
export const PROVIDER_STATES = Object.freeze({
  checking: 'refreshing',
  verified: 'ready',
  stale: 'stale',
  unverified: 'stale',
  'not-configured': 'idle',
  off: 'idle',
  unsupported: 'blocked',
  locked: 'blocked',
  degraded: 'partial',
  'action-required': 'blocked',
  failed: 'failed',
});

/** What Inspect may show: the code, its subsystem and provider, an HTTP status, and #13's correlation id */
export const INSPECTED = Object.freeze(['code', 'subsystem', 'provider', 'httpStatus', 'correlationId']);

/**
 * Who hears a state with no row: a failure at once, a partial result politely, the rest not at all
 * @type {Readonly<Record<string, string>>}
 */
const POLITENESS = { failed: 'assertive', blocked: 'assertive', partial: 'polite' };
/** @type {Readonly<Record<string, string | null>>} */
const ROLES = { assertive: 'alert', polite: 'status', off: null };

/**
 * @typedef {Readonly<Record<string, any>>} Input
 * @typedef {Readonly<Record<string, Readonly<Record<string, any>>>>} Rows - a contribution's rows, by state
 * @typedef {{host: string, incident?: boolean, filters?: number}} Surface
 * @typedef {{state: string, reason?: string, headline?: string, message?: string | null,
 *   params?: Record<string, unknown>, action?: string | null, destination?: string, commandId?: string,
 *   retry?: string, proven?: boolean, dataChanged: string, units?: Record<string, unknown>}} Seen
 */

/**
 * @param {Rows} rows
 * @param {string} state
 */
const rowFor = (rows, state) => (rows[state] && !('notApplicable' in rows[state]) ? rows[state] : undefined);

/**
 * What changed: nothing for a command the router or the adapter refused, one that never reached the
 * coordinator, or a read; the committed units for a commit; and unknown for anything else
 * @param {Input} input
 */
function dataChangedOf(input) {
  if (input.kind === 'rejected' || input.kind === 'conflict' || input.kind === 'failed') return 'none';
  return input.kind === 'unavailable' && input.cause === 'coordinator' ? 'none' : 'unknown';
}

/**
 * The state `input` puts the view in, before rows and surface
 * @param {Input} input
 * @param {Rows} rows
 * @param {readonly Readonly<Record<string, any>>[]} causes
 * @returns {Seen}
 */
function seen(input, rows, causes) {
  const { kind } = input;
  if (kind === 'pending') return { state: 'loading', headline: 'state.pending.headline', dataChanged: 'unknown' };
  if (kind === 'provider') {
    /** @type {Readonly<Record<string, string>>} */
    const states = PROVIDER_STATES;
    const state = input.status === 'degraded' && !rowFor(rows, 'partial') ? 'stale' : states[input.status];
    return {
      state,
      ...(input.status === 'locked' ? { reason: 'vault-locked' } : {}),
      ...(input.status === 'unverified' ? { headline: 'state.unverified.headline' } : {}),
      proven: input.status === 'verified',
      dataChanged: 'none',
    };
  }
  // A command that committed without changing anything has nothing to show as a save
  if (kind === 'committed') {
    if (input.severity === 'info') return { state: 'idle', dataChanged: 'none' };
    return { state: 'ready', proven: true, dataChanged: 'committed' };
  }
  if (kind === 'bulk') {
    /** @type {{id: string, outcome: {kind: string}}[]} */
    const items = input.items;
    const failed = items.filter(item => item.outcome.kind !== 'committed').map(item => item.id);
    if (failed.length === 0) return { state: 'ready', proven: true, dataChanged: 'committed' };
    const committed = input.committedIds;
    return {
      state: committed.length === 0 ? 'failed' : 'partial',
      params: { committed: committed.length, total: input.items.length },
      action: 'retry',
      retry: 'user',
      dataChanged: committed.length === 0 ? 'unknown' : 'committed',
      units: {
        committed: { label: 'state.partial.committed', ids: [...committed] },
        failed: { label: 'state.partial.failed', ids: failed },
      },
    };
  }
  if (['loading', 'ready', 'stale', 'empty'].includes(kind)) return { state: kind, dataChanged: 'none' };
  // A failed read, a refusal, a conflict, an outage or an unknown command presents through its cause
  const id = causeIdFor(/** @type {any} */ (input), new Set(causes.map(c => c.id)));
  const cause = causes.find(c => c.id === id);
  if (!cause) return { state: 'failed', message: null, action: null, retry: 'never', dataChanged: 'unknown' };
  // Rule 6: an unknown command shows Retry only once its key allows one resend, and Retry reuses the key
  const resend = kind === 'unknown' && input.resend === true;
  return {
    state: resend ? 'failed' : cause.state,
    ...(resend || cause.reason === undefined ? {} : { reason: cause.reason }),
    message: resend ? null : cause.messageKey,
    params: typeof input.host === 'string' ? { host: input.host } : {},
    action: resend ? 'retry' : cause.action,
    ...(cause.destination ? { destination: cause.destination } : {}),
    ...(kind === 'unknown' ? { commandId: input.commandId } : {}),
    retry: resend ? 'user' : cause.retry,
    dataChanged: dataChangedOf(input),
  };
}

/**
 * #16's role for a state: sage only for a committed command or a verified provider, clay for stale,
 * offline, partial, blocked and recoverable, danger for one nothing retries, sand for one in flight
 * @param {Seen} view
 */
function toneOf({ state, retry, proven }) {
  if (state === 'ready') return proven ? 'sage' : 'neutral';
  if (state === 'failed') return retry === 'never' ? 'danger' : 'clay';
  if (['stale', 'offline', 'partial', 'blocked'].includes(state)) return 'clay';
  return ['loading', 'refreshing', 'recovering'].includes(state) ? 'sand' : 'neutral';
}

/**
 * The one primary action, or none. An empty view during a repair points to Recovery Center and
 * never offers New note (rule 1), and a filtered one offers Clear filters.
 * @param {Seen} view
 * @param {Readonly<Record<string, any>> | undefined} row
 * @param {Surface} surface
 */
function primaryOf(view, row, surface) {
  if (view.state === 'empty' && surface.incident) {
    return Object.freeze({ action: 'open', destination: 'recovery-center' });
  }
  if (view.state === 'empty' && (surface.filters ?? 0) > 0) return Object.freeze({ action: 'clear-filters' });
  const action = view.action !== undefined ? view.action : (row?.primaryAction ?? null);
  if (!action) return null;
  return Object.freeze({
    action,
    ...(view.destination ? { destination: view.destination } : {}),
    ...(action === 'retry' && view.commandId ? { commandId: view.commandId } : {}),
  });
}

/**
 * What Inspect shows of an input: the fields Inspect may hold, and nothing else of it
 * @param {Input} input
 */
function inspectOf(input) {
  /** @type {Record<string, string | number>} */
  const shown = {};
  for (const field of INSPECTED) {
    if (typeof input[field] === 'string' || typeof input[field] === 'number') shown[field] = input[field];
  }
  return Object.freeze(shown);
}

/**
 * The state a person sees for `input` on `surface`, given the contribution's rows by state, or
 * null where the surface shows nothing of it, as Moment has no offline state
 * @param {Input} input
 * @param {Rows} rows
 * @param {Surface} surface
 * @param {readonly Readonly<Record<string, any>>[]} [causes] - the registered causes, #12's and #13's by default
 */
export function present(input, rows, surface, causes = KERNEL_CAUSES) {
  const view = seen(input, rows, causes);
  if (view.state === 'offline' && surface.host === 'moment') return null;
  const row = rowFor(rows, view.state);
  const politeness = row?.politeness ?? POLITENESS[view.state] ?? 'off';
  return Object.freeze({
    state: view.state,
    ...(view.reason === undefined ? {} : { reason: view.reason }),
    headline: row?.messageKey ?? view.headline ?? `state.${view.state}.headline`,
    message: view.message ?? null,
    params: Object.freeze(view.params ?? {}),
    placement: row?.placement ?? (surface.host === 'background' ? 'notification' : 'inline'),
    politeness,
    role: ROLES[politeness] ?? null,
    tone: toneOf(view),
    primary: primaryOf(view, row, surface),
    secondary: Object.freeze([INSPECT]),
    inspect: inspectOf(input),
    dataChanged: view.dataChanged,
    ...(view.units ? { units: view.units } : {}),
    preserved: Object.freeze([...(row?.preserved ?? [])]),
  });
}
