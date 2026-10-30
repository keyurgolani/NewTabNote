/**
 * The diagnostic journal (#20, "Diagnostic journal"): `logger.event(code, fields)` appends
 * one event to NewTabNoteTrust's journal, and a code that stands for a failure raises or
 * updates its incident too (event-codes.js). The code must be registered and every field must
 * be on the evidence allowlist and on the code's own list, with a value its schema takes.
 * Anything else is refused whole:
 * - in tests (`strict: true`) it throws a TypeError that names the rule and, for a listed
 *   field, the field, never a value;
 * - in production it's dropped and counted under its reason, and a `diagnostics.rejected`
 *   event records the reason and the running count.
 *
 * The journal never writes to the console. A logger's level methods (js/core/logger.js) stay
 * console-only, and withEvents gives one an `event` method beside them; #20 slice 1b moves
 * today's failure sites onto it.
 */

import { checkEvidence } from './evidence.js';
import { EVENT_CODES, isEventCode } from './event-codes.js';

/** @typedef {import('./ports.js').Clock} Clock */
/** @typedef {import('./trust-records.js').TrustRecords} TrustRecords */

/**
 * Why an event was refused
 * @typedef {'unregistered-code' | 'field-not-allowed' | 'value-not-allowed' | 'not-an-object'} RejectionReason
 */

/** @type {readonly RejectionReason[]} */
export const REJECTION_REASONS = Object.freeze(['unregistered-code', 'field-not-allowed', 'value-not-allowed', 'not-an-object']);

/**
 * @typedef {object} DiagnosticJournal
 * @property {(code: string, fields?: Record<string, unknown>) => boolean} event
 *   Records an event and answers true, or refuses it: throws when strict, and otherwise
 *   answers false after counting it
 * @property {() => Readonly<Record<RejectionReason, number>>} rejected - refusals so far, by reason
 * @property {() => Promise<void>} flush - resolves once every write so far has settled
 */

/**
 * @param {{records: TrustRecords, clock: Clock, strict?: boolean}} options - `strict` in tests only
 * @returns {DiagnosticJournal}
 */
export function createDiagnosticJournal({ records, clock, strict = false }) {
  /** @type {Record<RejectionReason, number>} */
  const counts = { 'unregistered-code': 0, 'field-not-allowed': 0, 'value-not-allowed': 0, 'not-an-object': 0 };
  /** @type {Set<Promise<void>>} */
  const writes = new Set();

  /** @param {Promise<unknown>} write */
  const track = write => {
    const settled = write.then(
      () => {},
      () => {},
    );
    writes.add(settled);
    settled.then(() => writes.delete(settled));
  };

  /**
   * @param {RejectionReason} reason
   * @param {string | null} field - an allowlisted field's name, or null
   * @returns {false}
   */
  const refuse = (reason, field) => {
    if (strict) {
      throw new TypeError(`logger.event refused an event: ${reason}${field ? ` (${field})` : ''}`);
    }
    counts[reason] += 1;
    track(records.append({ at: clock.now(), code: 'diagnostics.rejected', fields: { reason, count: counts[reason] } }));
    return false;
  };

  return Object.freeze({
    event(code, fields) {
      if (!isEventCode(code)) return refuse('unregistered-code', null);
      const entry = EVENT_CODES[code];
      const checked = checkEvidence(fields, entry.fields);
      if (!checked.ok) {
        const refused = /** @type {import('./evidence.js').RefusedEvidence} */ (checked);
        return refuse(refused.reason, refused.field);
      }
      const at = clock.now();
      track(records.append({ at, code, fields: checked.value }));
      if (entry.incident) {
        const subjectId = checked.value.subjectId;
        track(
          records.raise({
            ...entry.incident,
            subjectId: typeof subjectId === 'string' ? subjectId : null,
            evidence: checked.value,
          }),
        );
      }
      return true;
    },

    rejected: () => Object.freeze({ ...counts }),

    async flush() {
      while (writes.size > 0) await Promise.all([...writes]);
    },
  });
}

/**
 * `logger` with an `event` method that writes to `journal`. Its level methods are left as
 * they are, console-only.
 * @template {object} L
 * @param {L} logger
 * @param {DiagnosticJournal} journal
 * @returns {L & {event: DiagnosticJournal['event']}}
 */
export function withEvents(logger, journal) {
  return Object.freeze(Object.assign({}, logger, { event: journal.event }));
}
