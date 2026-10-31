/**
 * The invalidation table (#7, "Data and migration", approved AC4) and the freshness changes
 * it makes. Source changes come from the note side (a block edited or deleted, a note trashed,
 * archived, made a template, restored, or deleted for good), and the rest through the
 * `invalidate({cause, match})` hook #8 calls when a recipe, model, runtime, route, or scope
 * changes. User decisions and corrections survive every row but two: an anchor deleted
 * tombstones the decision, and a note deleted for good deletes them with its signals.
 *
 * | Cause                         | Objective signal          | Inferred signal          | Decision, corrections |
 * |-------------------------------|---------------------------|--------------------------|-----------------------|
 * | Anchor block edited           | Re-derived, same id       | `stale`, regenerated     | Kept                  |
 * | Anchor block deleted          | `invalidated`             | `invalidated`            | Tombstoned            |
 * | Note trashed or archived      | `suspended`               | `suspended`              | Kept                  |
 * | Note restored                 | Back as it was            | Back as it was           | Kept                  |
 * | Note deleted for good         | Deleted in the same unit  | Deleted                  | Deleted               |
 * | Note is or becomes a template | `suspended`               | `suspended`              | Kept                  |
 * | Producer or recipe version    | Re-derived                | `stale`, regenerated     | Kept                  |
 * | Model, runtime, or route      | n/a                       | `stale`, regenerated     | Kept                  |
 * | Scope grant revoked           | n/a                       | `invalidated`, cleared   | Kept                  |
 *
 * A signal never writes a note record, a note revision, or `updatedAt`: these records live in
 * their own repository.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { count, entityId, id, revision } from '../contracts/fields.js';
import { EXECUTION_CLASSES, signalId } from './records.js';

/** @typedef {import('./records.js').IntelligenceSignal} IntelligenceSignal */
/** @typedef {import('./records.js').FreshnessCause} FreshnessCause */
/** @typedef {import('./records.js').Category} Category */

/**
 * What each row does: to an objective signal, to an inferred one, and to the decision
 * @typedef {'rederive' | 'stale' | 'invalidate' | 'invalidate-and-clear' | 'suspend' | 'resume' | 'delete' | 'none'} SignalEffect
 * @typedef {'keep' | 'tombstone' | 'delete'} DecisionEffect
 */

/** @type {Readonly<Record<string, Readonly<{objective: SignalEffect, inferred: SignalEffect, decision: DecisionEffect}>>>} */
export const INVALIDATION_TABLE = Object.freeze({
  'anchor-edited': Object.freeze({ objective: 'rederive', inferred: 'stale', decision: 'keep' }),
  'anchor-deleted': Object.freeze({ objective: 'invalidate', inferred: 'invalidate', decision: 'tombstone' }),
  'note-trashed': Object.freeze({ objective: 'suspend', inferred: 'suspend', decision: 'keep' }),
  'note-archived': Object.freeze({ objective: 'suspend', inferred: 'suspend', decision: 'keep' }),
  'note-restored': Object.freeze({ objective: 'resume', inferred: 'resume', decision: 'keep' }),
  'note-deleted': Object.freeze({ objective: 'delete', inferred: 'delete', decision: 'delete' }),
  template: Object.freeze({ objective: 'suspend', inferred: 'suspend', decision: 'keep' }),
  'producer-version': Object.freeze({ objective: 'rederive', inferred: 'stale', decision: 'keep' }),
  'recipe-version': Object.freeze({ objective: 'rederive', inferred: 'stale', decision: 'keep' }),
  'model-changed': Object.freeze({ objective: 'none', inferred: 'stale', decision: 'keep' }),
  'runtime-changed': Object.freeze({ objective: 'none', inferred: 'stale', decision: 'keep' }),
  'route-changed': Object.freeze({ objective: 'none', inferred: 'stale', decision: 'keep' }),
  'scope-revoked': Object.freeze({ objective: 'none', inferred: 'invalidate-and-clear', decision: 'keep' }),
});

/** The causes the hook takes, each with the match field it needs */
export const HOOK_CAUSES = Object.freeze(
  /** @type {const} */ ([
    'producer-version',
    'recipe-version',
    'model-changed',
    'runtime-changed',
    'route-changed',
    'scope-revoked',
  ]),
);

/**
 * What the hook matches: a producer (or recipe) whose signals were made by another version
 * than `version`, a model, an execution class (a runtime), a provider (a route), or a scope
 * grant, optionally within one note
 */
export const matchSchema = v.strictObject({
  producerId: v.optional(id),
  version: v.optional(count),
  modelId: v.optional(id),
  executionClass: v.optional(v.picklist(EXECUTION_CLASSES)),
  providerId: v.optional(id),
  scopeId: v.optional(id),
  noteId: v.optional(entityId('note')),
});

/** The field each hook cause needs in its match */
const NEEDS = Object.freeze({
  'producer-version': ['producerId', 'version'],
  'recipe-version': ['producerId', 'version'],
  'model-changed': ['modelId'],
  'runtime-changed': ['executionClass'],
  'route-changed': ['providerId'],
  'scope-revoked': ['scopeId'],
});

export const invalidateSchema = v.pipe(
  v.strictObject({ cause: v.picklist(HOOK_CAUSES), match: matchSchema }),
  v.check(
    ({ cause, match }) =>
      NEEDS[cause].every(field => /** @type {Record<string, unknown>} */ (match)[field] !== undefined),
    'a match for the cause',
  ),
);

/** @typedef {v.InferOutput<typeof invalidateSchema>} Invalidation */
/** @typedef {v.InferOutput<typeof matchSchema>} Match */

/**
 * Whether the hook's `match` names `signal`, for `cause`
 * @param {IntelligenceSignal} signal
 * @param {Invalidation} invalidation
 * @returns {boolean}
 */
export function matches(signal, { cause, match }) {
  if (match.noteId !== undefined && signal.identity.noteId !== match.noteId) return false;
  switch (cause) {
    case 'producer-version':
    case 'recipe-version':
      return signal.identity.producerId === match.producerId && signal.producerVersion !== match.version;
    case 'model-changed':
      return signal.model?.id === match.modelId;
    case 'runtime-changed':
      return signal.executionClass === match.executionClass;
    case 'route-changed':
      return signal.providerId === match.providerId;
    case 'scope-revoked':
      return signal.scopeId === match.scopeId;
    default:
      return false;
  }
}

/**
 * @param {IntelligenceSignal} signal
 * @param {IntelligenceSignal['freshness']} freshness
 * @returns {IntelligenceSignal}
 */
const withFreshness = (signal, freshness) => ({ ...signal, freshness, revision: signal.revision + 1 });

/**
 * `signal` gone stale for `cause`. An invalidated one stays as it is, and a suspended one goes
 * stale when it's restored.
 * @param {IntelligenceSignal} signal
 * @param {FreshnessCause} cause
 * @param {number} now
 * @returns {IntelligenceSignal}
 */
export function staled(signal, cause, now) {
  const { freshness } = signal;
  if (freshness.state === 'invalidated') return signal;
  if (freshness.state === 'suspended') {
    if (freshness.resumeTo?.state === 'invalidated') return signal;
    return withFreshness(signal, { ...freshness, resumeTo: { state: 'stale', cause, invalidatedAt: null } });
  }
  return withFreshness(signal, { state: 'stale', cause, since: now, invalidatedAt: null, resumeTo: null });
}

/**
 * `signal` invalidated for `cause`. `clear` empties its title and its confidence reason, as a
 * revoked scope grant does.
 * @param {IntelligenceSignal} signal
 * @param {FreshnessCause} cause
 * @param {number} now
 * @param {{clear?: boolean}} [options]
 * @returns {IntelligenceSignal}
 */
export function invalidated(signal, cause, now, { clear = false } = {}) {
  if (signal.freshness.state === 'invalidated' && !clear) return signal;
  const next = withFreshness(signal, { state: 'invalidated', cause, since: now, invalidatedAt: now, resumeTo: null });
  if (!clear) return next;
  return {
    ...next,
    title: '',
    confidence: next.confidence ? { ...next.confidence, reason: '' } : null,
  };
}

/**
 * `signal` suspended for `cause`, remembering what to go back to
 * @param {IntelligenceSignal} signal
 * @param {FreshnessCause} cause
 * @param {number} now
 * @returns {IntelligenceSignal}
 */
export function suspended(signal, cause, now) {
  const { freshness } = signal;
  if (freshness.state === 'suspended') {
    return freshness.cause === cause ? signal : withFreshness(signal, { ...freshness, cause });
  }
  const resumeTo = {
    state: /** @type {'current' | 'stale' | 'invalidated'} */ (freshness.state),
    cause: freshness.cause,
    invalidatedAt: freshness.invalidatedAt,
  };
  return withFreshness(signal, { state: 'suspended', cause, since: now, invalidatedAt: null, resumeTo });
}

/**
 * `signal` back as it was before it was suspended
 * @param {IntelligenceSignal} signal
 * @param {number} now
 * @returns {IntelligenceSignal}
 */
export function resumed(signal, now) {
  const { freshness } = signal;
  if (freshness.state !== 'suspended' || !freshness.resumeTo) return signal;
  const { state, cause, invalidatedAt } = freshness.resumeTo;
  return withFreshness(signal, {
    state,
    cause: state === 'current' ? null : cause,
    since: state === 'current' ? null : now,
    invalidatedAt: state === 'invalidated' ? invalidatedAt : null,
    resumeTo: null,
  });
}

/**
 * Why a note's signals are suspended, from the note's state, or null when they aren't
 * @param {{trashed: boolean, archived: boolean, isTemplate: boolean}} note
 * @returns {FreshnessCause | null}
 */
export function suspensionOf({ trashed, archived, isTemplate }) {
  if (trashed) return 'note-trashed';
  if (archived) return 'note-archived';
  if (isTemplate) return 'template';
  return null;
}

/** The causes a regeneration request names */
export const REGENERATION_CAUSES = Object.freeze(
  /** @type {const} */ (['source-edited', 'recipe-version', 'model-changed', 'runtime-changed', 'route-changed']),
);
/** @typedef {(typeof REGENERATION_CAUSES)[number]} RegenerationCause */

/** The most signal ids one request names */
export const MAX_REGENERATION_SIGNALS = 500;

/**
 * A typed request for #8 to regenerate one note's signals from one recipe, which #8 queues
 * like an idle run. Nothing here calls a model. `priority` is the category order of the most
 * urgent signal it names: 0 for Now.
 */
export const regenerationRequestSchema = v.strictObject({
  noteId: entityId('note'),
  recipeId: id,
  signalIds: v.pipe(v.array(signalId), v.minLength(1), v.maxLength(MAX_REGENERATION_SIGNALS)),
  cause: v.picklist(REGENERATION_CAUSES),
  priority: count,
});

/** @typedef {v.InferOutput<typeof regenerationRequestSchema>} RegenerationRequest */

/**
 * One request per note and recipe for the inferred signals that just went stale, in priority
 * order, then by note and recipe
 * @param {Array<{signal: IntelligenceSignal, priority: number}>} staledSignals
 * @param {RegenerationCause} cause
 * @returns {RegenerationRequest[]}
 */
export function regenerationRequestsFor(staledSignals, cause) {
  /** @type {Map<string, RegenerationRequest>} */
  const requests = new Map();
  for (const { signal, priority } of staledSignals) {
    const key = JSON.stringify([signal.identity.noteId, signal.identity.producerId]);
    const known = requests.get(key);
    if (known) {
      if (!known.signalIds.includes(signal.id)) known.signalIds.push(signal.id);
      known.priority = Math.min(known.priority, priority);
    } else {
      requests.set(key, {
        noteId: signal.identity.noteId,
        recipeId: signal.identity.producerId,
        signalIds: [signal.id],
        cause,
        priority,
      });
    }
  }
  return [...requests.values()]
    .map(request => ({ ...request, signalIds: [...request.signalIds].sort() }))
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0) ||
        (a.recipeId < b.recipeId ? -1 : a.recipeId > b.recipeId ? 1 : 0),
    );
}

/** A note-side change the table applies */
export const noteChangeSchema = v.variant('type', [
  v.strictObject({
    type: v.literal('block-edited'),
    noteId: entityId('note'),
    blockId: entityId('block'),
    revision: v.nullable(revision),
  }),
  v.strictObject({ type: v.literal('block-deleted'), noteId: entityId('note'), blockId: entityId('block') }),
  v.strictObject({
    type: v.literal('note-state'),
    noteId: entityId('note'),
    trashed: v.boolean(),
    archived: v.boolean(),
    isTemplate: v.boolean(),
  }),
  v.strictObject({ type: v.literal('note-deleted'), noteId: entityId('note') }),
]);

/** @typedef {v.InferOutput<typeof noteChangeSchema>} NoteChange */
