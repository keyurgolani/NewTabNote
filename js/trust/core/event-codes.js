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
 * A code that stands for a success at one of those sites names the failure code whose incident
 * it resolves (`resolves`): the indexer's first answer, an auto-backup that saved, and a
 * capture that committed. It resolves only the sightings it counted just before it (the
 * records' occurrence snapshot, never clocks), and is journaled only when it resolved one.
 * For each of them a success in one context is evidence for a failure in another: the indexer
 * and auto-backup run the same package on the same profile in every tab, and every capture
 * runs in the service worker, on the same profile.
 *
 * An incident entry may name what its failure breaks and what still works (`affected`,
 * `preserved`): a database the worker couldn't open breaks reading too. A failed capture says
 * nothing about reading, so it names only capture.
 *
 * `quietWhileOpen`: a code whose site repeats while nothing changes (the worker's storage open,
 * at every start) is journaled only when its incident isn't open already with the same error
 * code; each sighting still counts in the incident.
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
 *   incident?: Readonly<{providerId: string, faultCode: string, severity: Severity, affected?: readonly string[], preserved?: readonly string[]}>,
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
    incident: Object.freeze({
      providerId: 'capture',
      faultCode: 'capture-failed',
      severity: 'capture-risk',
      affected: Object.freeze(['capture']),
    }),
  }),
  'storage.open-failed': Object.freeze({
    fields: Object.freeze([...ERROR, 'surface', 'schemaVersion', 'durationMs', 'subjectId']),
    incident: Object.freeze({
      providerId: 'storage',
      faultCode: 'open-failed',
      severity: 'capture-risk',
      affected: Object.freeze(['capture', 'editing', 'reading']),
      preserved: Object.freeze([]),
    }),
    quietWhileOpen: true,
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
  // The successes at those sites, each resolving its site's incident
  'capture.committed': Object.freeze({ fields: Object.freeze(['surface', 'commandId']), resolves: 'capture.failed' }),
  'backup.auto-succeeded': Object.freeze({ fields: Object.freeze([]), resolves: 'backup.auto-failed' }),
  'indexer.started': Object.freeze({ fields: Object.freeze(['surface']), resolves: 'indexer.start-failed' }),
  // #17 PR 1b's migration run in the worker. None raises an incident of its own: a failed or
  // space-short run leaves version 8 working, and storage's check reports the state
  // (`degraded`, a migration fault), which its check at the latest version resolves. While
  // an upgrade is blocked, every worker command answers `blocked-upgrade`, so captures fail
  // and raise `capture/capture-failed`: capture carries that risk, not this event.
  // `schemaVersion` is the version the run upgrades to; `errorCode` why it stopped.
  'storage.migration-completed': Object.freeze({ fields: Object.freeze(['surface', 'schemaVersion']) }),
  'storage.migration-failed': Object.freeze({ fields: Object.freeze([...ERROR, 'surface', 'schemaVersion']) }),
  'storage.migration-blocked': Object.freeze({ fields: Object.freeze(['errorCode', 'surface', 'schemaVersion']) }),
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
  // A remediation run that ended, or that the next start found cut off (slice 3's pipeline)
  'remediation.finished': Object.freeze({
    fields: Object.freeze(['runId', 'remediationId', 'state', 'outcome', 'durationMs', 'recoveryPointId', 'count']),
  }),
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
    if (entry.resolves !== undefined) {
      const site = EVENT_CODES[entry.resolves];
      if (!site || !site.incident) problems.push(`${name}: resolves ${entry.resolves}, which raises no incident`);
      if (entry.incident) problems.push(`${name}: a success raises no incident`);
    }
  }
  return problems;
}
