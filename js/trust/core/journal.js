/**
 * The diagnostic journal (#20, "Diagnostic journal"): `logger.event(code, fields)` appends
 * one event to NewTabNoteTrust's journal, and a code that stands for a failure raises or
 * updates its incident too (event-codes.js). The code must be registered and every field must
 * be on the evidence allowlist and on the code's own list, with a value its schema takes.
 * Anything else is refused whole:
 * - in tests (`strict: true`) it throws a TypeError that names the rule and, for a listed
 *   field, the field, never a value;
 * - in production it's dropped and counted in memory under its reason (the diagnostic report
 *   holds the counts), and a `diagnostics.rejected` event records the reason and the running
 *   count the first time and then at most once an hour, so refusals never crowd real events
 *   out of the journal.
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
 * Why an event didn't reach the journal: refused, or (`write-failed`) accepted and then not
 * stored, because NewTabNoteTrust wouldn't take the write (nothing keeps the event; the
 * storage incident counts the failed write) or the records threw
 * @typedef {'unregistered-code' | 'field-not-allowed' | 'value-not-allowed' | 'not-an-object' | 'write-failed'} RejectionReason
 */

/** @type {readonly RejectionReason[]} */
export const REJECTION_REASONS = Object.freeze([
  'unregistered-code',
  'field-not-allowed',
  'value-not-allowed',
  'not-an-object',
  'write-failed',
]);

/**
 * How often a reason's running count is journaled: the first refusal, then at most once an
 * hour, so refusals never crowd real events out of the journal's 2,000
 */
export const REJECTION_JOURNAL_MS = 60 * 60 * 1000;

/**
 * @typedef {object} DiagnosticJournal
 * @property {(code: string, fields?: Record<string, unknown>) => boolean} event
 *   Records an event and answers true, or refuses it: throws when strict, and otherwise
 *   answers false after counting it in memory
 * @property {() => Readonly<Record<RejectionReason, number>>} rejected - refusals so far, by reason
 * @property {() => Promise<void>} flush - resolves once every write so far has settled
 */

/**
 * @param {{records: TrustRecords, clock: Clock, strict?: boolean}} options - `strict` in tests only
 * @returns {DiagnosticJournal}
 */
export function createDiagnosticJournal({ records, clock, strict = false }) {
  /** @type {Record<RejectionReason, number>} */
  const counts = { 'unregistered-code': 0, 'field-not-allowed': 0, 'value-not-allowed': 0, 'not-an-object': 0, 'write-failed': 0 };
  /** @type {Partial<Record<RejectionReason, number>>} */
  const journaledAt = {};
  /** @type {Set<Promise<void>>} */
  const writes = new Set();

  /**
   * Counts `reason`, and journals its running count the first time and then at most once per
   * REJECTION_JOURNAL_MS
   * @param {RejectionReason} reason
   */
  const count = reason => {
    counts[reason] += 1;
    const now = clock.now();
    const last = journaledAt[reason];
    if (last !== undefined && now - last < REJECTION_JOURNAL_MS) return;
    journaledAt[reason] = now;
    track(
      records.append({ at: now, code: 'diagnostics.rejected', fields: { reason, count: counts[reason] } }, { internal: true }),
      false,
    );
  };

  /**
   * @param {Promise<unknown>} write
   * @param {boolean} [counted] - whether a failure counts as `write-failed`
   */
  const track = (write, counted = true) => {
    const settled = write.then(
      result => {
        // Accepted, but the store wouldn't take it: the records' write-failed incident counts it too
        const answer = /** @type {{recorded?: unknown}} */ (result);
        if (counted && answer && answer.recorded === false) count('write-failed');
      },
      () => {
        if (counted) count('write-failed');
      },
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
    count(reason);
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
      const appended = { at, code, fields: checked.value };
      if (!entry.incident) {
        track(records.append(appended));
        return true;
      }
      // An event that raises an incident is one operation, which counts one failed write: the
      // raise goes first, and the append counts its own failure only when the raise didn't
      const subjectId = checked.value.subjectId;
      const raised = records.raise({
        ...entry.incident,
        subjectId: typeof subjectId === 'string' ? subjectId : null,
        evidence: checked.value,
      });
      track(raised);
      track(
        raised.then(
          result => records.append(appended, { internal: !result.recorded }),
          () => records.append(appended),
        ),
      );
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
