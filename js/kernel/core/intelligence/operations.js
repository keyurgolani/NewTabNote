/**
 * The intelligence lifecycle commands (#7, "Contracts"): `intelligence.complete`, `reopen`,
 * `dismiss`, `snooze`, and `correct`, each a versioned operation with a Valibot payload and
 * result schema, as #13's catalog entries are. Each carries the `expectedDecisionRevision` its
 * surface last read and a `commandId`, its idempotency key, made once when the intent happens
 * and reused by every retry. The first commit for a signal's revision wins, and the loser gets a
 * typed `SignalDecisionConflict` with the current state.
 *
 * This catalog is the domain's own, apart from #12's COMMANDS: no shipped root registers a
 * handler for it until a surface consumes it (#3, #4, #5), and `setTuning` and `deleteDerived`
 * come with slice 3. Outcomes are #12's closed union (contracts/outcomes.js) and carry ids,
 * codes, and revisions only, never content.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { content, id, revision, timestamp } from '../contracts/fields.js';
import { committedSchema, rejectedSchema, unavailableSchema, unknownSchema } from '../contracts/outcome-schemas.js';
import {
  CATEGORIES,
  DECISION_STATUSES,
  DISMISS_REASONS,
  REASON_MAX,
  plainText,
  signalId,
  sourceRefSchema,
  timeBasisSchema,
} from './records.js';

/** @typedef {import('./lifecycle.js').LifecycleAction} LifecycleAction */

/**
 * A lifecycle command's catalog entry
 * @typedef {Readonly<{
 *   kind: 'command',
 *   version: number,
 *   action: LifecycleAction,
 *   entityTypes: readonly ['intelligence'],
 *   idempotency: 'keyed',
 * }>} IntelligenceCommandEntry
 */

/**
 * @param {LifecycleAction} action
 * @returns {IntelligenceCommandEntry}
 */
const entry = action =>
  Object.freeze({
    kind: /** @type {const} */ ('command'),
    version: 1,
    action,
    entityTypes: /** @type {const} */ (['intelligence']),
    idempotency: /** @type {const} */ ('keyed'),
  });

export const INTELLIGENCE_COMMANDS = Object.freeze({
  'intelligence.complete': entry('complete'),
  'intelligence.reopen': entry('reopen'),
  'intelligence.dismiss': entry('dismiss'),
  'intelligence.snooze': entry('snooze'),
  'intelligence.correct': entry('correct'),
});

/** @typedef {keyof typeof INTELLIGENCE_COMMANDS} IntelligenceCommandType */

const keyed = {
  commandId: id,
  signalId,
  expectedDecisionRevision: revision,
};

export const completePayload = v.strictObject({ type: v.literal('intelligence.complete'), ...keyed });
export const reopenPayload = v.strictObject({ type: v.literal('intelligence.reopen'), ...keyed });
export const dismissPayload = v.strictObject({
  type: v.literal('intelligence.dismiss'),
  ...keyed,
  reason: v.optional(v.picklist(DISMISS_REASONS)),
});
export const snoozePayload = v.strictObject({ type: v.literal('intelligence.snooze'), ...keyed, until: timestamp });

/** What a correction asks for. The service records what it replaced as `before`. */
export const correctionAsk = v.variant('field', [
  v.strictObject({ field: v.literal('category'), after: v.nullable(v.picklist(CATEGORIES)) }),
  v.strictObject({ field: v.literal('time'), after: v.nullable(timeBasisSchema) }),
  v.strictObject({ field: v.literal('actionable'), after: v.boolean() }),
  v.strictObject({ field: v.literal('source'), sourceRef: sourceRefSchema, after: v.boolean() }),
]);

export const correctPayload = v.strictObject({
  type: v.literal('intelligence.correct'),
  ...keyed,
  // Chosen when the intent happens, so a retry appends the same entry
  entryId: id,
  change: correctionAsk,
  note: v.optional(content(plainText(REASON_MAX))),
});

export const payload = v.variant('type', [
  completePayload,
  reopenPayload,
  dismissPayload,
  snoozePayload,
  correctPayload,
]);

/**
 * A signal's user state as a conflict reports it, and as a surface compares against: its
 * effective status, the decision's fields, and for an objective task its block's `checked`
 */
export const decisionStateSchema = v.strictObject({
  signalId,
  status: v.picklist(DECISION_STATUSES),
  snoozedUntil: v.nullable(timestamp),
  dismissReason: v.nullable(v.picklist(DISMISS_REASONS)),
  decisionRevision: revision,
  checked: v.nullable(v.boolean()),
});

const severity = v.picklist(['success', 'info', 'warning', 'error']);
const messageKey = v.pipe(v.string(), v.regex(/^[a-z]+\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), v.maxLength(80));

/**
 * `SignalDecisionConflict`: the command expected a decision revision another commit moved
 * past (`signal-decision-conflict`), or an objective task's note changed since the signal read
 * it (`note-revision-conflict`). Either way nothing of this command was written, and `current`
 * is the state that stands.
 */
export const signalConflictSchema = v.strictObject({
  kind: v.literal('conflict'),
  code: v.picklist(['signal-decision-conflict', 'note-revision-conflict']),
  currentRevision: revision,
  current: decisionStateSchema,
  messageKey,
  severity,
});

export const result = v.variant('kind', [
  committedSchema,
  rejectedSchema,
  signalConflictSchema,
  unavailableSchema,
  unknownSchema,
]);

/** @typedef {v.InferOutput<typeof payload>} IntelligenceCommand */
/** @typedef {v.InferOutput<typeof completePayload>} CompleteSignal */
/** @typedef {v.InferOutput<typeof reopenPayload>} ReopenSignal */
/** @typedef {v.InferOutput<typeof dismissPayload>} DismissSignal */
/** @typedef {v.InferOutput<typeof snoozePayload>} SnoozeSignal */
/** @typedef {v.InferOutput<typeof correctPayload>} CorrectSignal */
/** @typedef {v.InferOutput<typeof decisionStateSchema>} DecisionState */
/** @typedef {v.InferOutput<typeof signalConflictSchema>} SignalDecisionConflict */
/** @typedef {v.InferOutput<typeof result>} IntelligenceOutcome */

/**
 * @param {'signal-decision-conflict' | 'note-revision-conflict'} conflictCode
 * @param {DecisionState} current
 * @returns {SignalDecisionConflict}
 */
export function signalConflict(conflictCode, current) {
  return {
    kind: 'conflict',
    code: conflictCode,
    currentRevision: current.decisionRevision,
    current: { ...current },
    messageKey: `conflict.${conflictCode}`,
    severity: 'warning',
  };
}
