/**
 * The intelligence domain's typed events (#7, "Contracts"). Each commit that changes a
 * signal, its decision, or its corrections emits one event per change and signal, in #13's
 * hint shape with `entityType: 'intelligence'` and the signal's id, its entity revision, and
 * the commit's place in #17's change log. Like every hint they carry ids and numbers only, so
 * a surface that hears one reads the signal again whenever the hint's `commitSeq` is past its
 * `asOfCommitSeq`. Events can arrive late, twice, out of order, or not at all, and a surface
 * converges anyway, since it reads state rather than applying events.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { commitSeq, revision } from '../contracts/fields.js';
import { signalId } from './records.js';

export const EVENT_TYPES = Object.freeze(
  /** @type {const} */ ([
    'intelligence.signalChanged',
    'intelligence.signalRemoved',
    'intelligence.decisionChanged',
    'intelligence.decisionRemoved',
    'intelligence.correctionAppended',
    'intelligence.correctionsRemoved',
  ]),
);
/** @typedef {(typeof EVENT_TYPES)[number]} EventType */

export const eventSchema = v.strictObject({
  type: v.picklist(EVENT_TYPES),
  entityType: v.literal('intelligence'),
  entityId: signalId,
  revision,
  commitSeq,
});

/** @typedef {v.InferOutput<typeof eventSchema>} IntelligenceEvent */

/**
 * The commit hint an event posts as (#13's hint shape, messaging/hints.js)
 * @param {IntelligenceEvent} event
 * @returns {{entityType: 'intelligence', entityId: string, revision: number, commitSeq: number}}
 */
export function hintOf({ entityType, entityId, revision: entityRevision, commitSeq: seq }) {
  return { entityType, entityId, revision: entityRevision, commitSeq: seq };
}
