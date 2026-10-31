/**
 * The diagnostic journal's registered event codes (#20, "Diagnostic journal"). logger.event
 * takes only a code listed here, with only the evidence fields its entry lists, each of which
 * is on the allowlist (evidence.js). Anything else throws in tests and is dropped and counted
 * in production (journal.js).
 *
 * A code that stands for a failure the Recovery Center shows also names the incident it
 * raises: its provider, fault, and severity, keyed with the event's `subjectId` when it has
 * one, so a repeat updates the one incident. The failure sites #20 slice 1b moves here are
 * background capture, embedding load, worker storage init, auto-backup, and indexer start.
 *
 * Adding a code is a PR that adds its entry here, with its fields from the allowlist.
 */

import { EVIDENCE_FIELDS } from './evidence.js';

/** @typedef {import('./vocabulary.js').Severity} Severity */

/**
 * A success names the failure code whose incident it resolves (`resolves`), and a site that
 * repeats while nothing changes is journaled once while its incident is open
 * (`quietWhileOpen`), as `next`'s journal reads them (#20 slice 4's prerequisites)
 * @typedef {Readonly<{
 *   fields: readonly string[],
 *   incident?: Readonly<{providerId: string, faultCode: string, severity: Severity}>,
 *   resolves?: string,
 *   quietWhileOpen?: boolean,
 * }>} EventCode
 */

/** A code: dotted, each part lowercase words joined by hyphens, such as `capture.failed` */
export const EVENT_CODE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;

/** What every failure event may say about the error, never its message */
const ERROR = Object.freeze(['cause', 'errorCode', 'exception', 'retryable']);

/** @type {Readonly<Record<string, EventCode>>} */
export const EVENT_CODES = Object.freeze({
  // The failure sites #20 slice 1b moves onto logger.event
  'capture.failed': Object.freeze({
    fields: Object.freeze([...ERROR, 'surface', 'commandId', 'subjectId']),
    incident: Object.freeze({ providerId: 'capture', faultCode: 'capture-failed', severity: 'capture-risk' }),
  }),
  'storage.open-failed': Object.freeze({
    fields: Object.freeze([...ERROR, 'surface', 'schemaVersion', 'durationMs', 'subjectId']),
    incident: Object.freeze({ providerId: 'storage', faultCode: 'open-failed', severity: 'capture-risk' }),
  }),
  'embeddings.load-failed': Object.freeze({
    fields: Object.freeze([...ERROR, 'surface', 'durationMs', 'bytes']),
    incident: Object.freeze({ providerId: 'local-inference', faultCode: 'load-failed', severity: 'degraded' }),
  }),
  'backup.auto-failed': Object.freeze({
    fields: Object.freeze([...ERROR, 'records', 'bytes']),
    incident: Object.freeze({ providerId: 'backup', faultCode: 'auto-backup-failed', severity: 'data-risk' }),
  }),
  'indexer.start-failed': Object.freeze({
    fields: Object.freeze([...ERROR, 'surface']),
    incident: Object.freeze({ providerId: 'index', faultCode: 'indexer-start-failed', severity: 'degraded' }),
  }),
  // The Trust Center's own
  'trust.check-failed': Object.freeze({
    fields: Object.freeze(['providerId', 'durationMs', ...ERROR]),
  }),
  'trust.check-timed-out': Object.freeze({ fields: Object.freeze(['providerId', 'durationMs', 'timeoutMs']) }),
  'trust.reconciled': Object.freeze({ fields: Object.freeze(['count', 'records']) }),
  'incident.raised': Object.freeze({
    fields: Object.freeze(['incidentId', 'providerId', 'faultCode', 'severity', 'count']),
  }),
  'incident.resolved': Object.freeze({ fields: Object.freeze(['incidentId', 'providerId', 'faultCode']) }),
  'diagnostics.rejected': Object.freeze({ fields: Object.freeze(['reason', 'count']) }),
  'diagnostics.exported': Object.freeze({ fields: Object.freeze(['records', 'bytes']) }),
  // #17's recovery-point purge (purge.js): a sweep that stopped at a point that didn't verify,
  // keyed by the point, which later sweeps back off on until the points change, and its end,
  // once a later sweep finishes that point or the point goes
  'storage.purge-stopped': Object.freeze({
    fields: Object.freeze(['errorCode', 'subjectId', 'surface']),
    incident: Object.freeze({ providerId: 'recovery-readiness', faultCode: 'purge-stopped', severity: 'degraded' }),
    quietWhileOpen: true,
  }),
  'storage.purge-completed': Object.freeze({
    fields: Object.freeze(['subjectId']),
    resolves: 'storage.purge-stopped',
  }),
});

/** Every registered code, sorted */
export const EVENT_CODE_NAMES = Object.freeze(Object.keys(EVENT_CODES).sort());

/**
 * Whether `code` is registered
 * @param {unknown} code
 * @returns {code is string}
 */
export function isEventCode(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(EVENT_CODES, code);
}

/**
 * The registry's own problems: a code that breaks the pattern, or a field the allowlist lacks.
 * test/kernel/trust-journal.test.mjs holds it to none.
 * @returns {string[]}
 */
export function eventCodeProblems() {
  /** @type {string[]} */
  const problems = [];
  for (const [name, entry] of Object.entries(EVENT_CODES)) {
    if (!EVENT_CODE_PATTERN.test(name) || name.length > 64) problems.push(`${name}: not a code`);
    for (const field of entry.fields) {
      if (!Object.prototype.hasOwnProperty.call(EVIDENCE_FIELDS, field)) problems.push(`${name}: ${field} isn't evidence`);
    }
    if (new Set(entry.fields).size !== entry.fields.length) problems.push(`${name}: lists a field twice`);
  }
  return problems;
}
