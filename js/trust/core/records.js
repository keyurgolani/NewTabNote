/**
 * What NewTabNoteTrust stores (#20, "Contracts" and "Records"): health receipts, incidents,
 * remediation runs, and the diagnostic journal, each as a strict Valibot schema that holds
 * ids, codes, counts, times, and allowlisted evidence only, and the bounds each store keeps.
 * None of them holds content, so no record can carry a note's text, a title, a URL, a
 * credential, or an error message. They're `diagnostic`: never in a backup or in sync.
 */

import * as v from '../../lib/valibot/index.mjs';
import { count, timestamp } from '../../kernel/core/contracts/fields.js';
import { check } from '../../kernel/core/contracts/validate.js';
import { RUN_OUTCOMES } from './codes.js';
import { EVENT_CODE_NAMES } from './event-codes.js';
import { capability, contributionId, evidenceSchema, faultCode, recordId, subjectId } from './evidence.js';
import {
  CAPTURE_STATES,
  COST_CLASSES,
  INCIDENT_STATES,
  RECEIPT_STATUSES,
  RUN_STATES,
  SEVERITIES,
} from './vocabulary.js';

/** @typedef {import('./vocabulary.js').ReceiptStatus} ReceiptStatus */
/** @typedef {import('./vocabulary.js').Severity} Severity */

/**
 * What each store keeps (#20, "Bounds"; the first limit hit wins):
 * - incidents: every open one, dismissed included, and resolved ones for 90 days, 200 at most;
 * - receipts: the latest per provider, plus its 20 newest status transitions;
 * - runs: the newest 200, with any still running kept;
 * - journal: 2,000 events, none older than 14 days.
 */
export const BOUNDS = Object.freeze({
  resolvedIncidentAgeMs: 90 * 24 * 60 * 60 * 1000,
  resolvedIncidents: 200,
  receiptTransitions: 20,
  runs: 200,
  journalEvents: 2000,
  journalAgeMs: 14 * 24 * 60 * 60 * 1000,
});

/**
 * A verification operation's code, such as `storage.probe-readwrite`: dotted, each part
 * lowercase words joined by hyphens
 */
export const operationCode = v.pipe(
  v.string(),
  v.regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){0,3}$/),
  v.maxLength(64),
);

/** A key into the code-owned consequence text, `<group>.<code>`, resolved at render */
export const consequenceKey = v.pipe(
  v.string(),
  v.regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  v.maxLength(80),
);

/** The capabilities an incident affects or a degraded system still preserves, registered in codes.js */
export const capabilities = v.pipe(v.array(capability), v.maxLength(32));

/**
 * The incident key: provider, fault, and subject, `-` when there's no subject. Its bound is
 * past the longest each part takes (a 64-character contribution id, a registered fault, and a
 * 36-character UUID or a shorter subject), so any incident the records accept has a valid key.
 */
export const incidentKeySchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.:/-]{1,256}$/));

/**
 * A HealthReceipt: one check's result. `transition` marks a receipt whose status differs from
 * the provider's receipt before it, which the receipt bound keeps 20 of.
 */
export const receiptSchema = v.strictObject({
  id: recordId,
  providerId: contributionId,
  installId: recordId,
  status: v.picklist(RECEIPT_STATUSES),
  capture: v.optional(v.picklist(CAPTURE_STATES)),
  verifiedAt: timestamp,
  durationMs: count,
  freshnessMs: count,
  operation: operationCode,
  evidence: evidenceSchema,
  consequenceKey: v.nullable(consequenceKey),
  preserved: capabilities,
  nextAction: v.nullable(contributionId),
  executionClass: v.optional(v.picklist(COST_CLASSES)),
  transition: v.boolean(),
});

/** @typedef {v.InferOutput<typeof receiptSchema>} HealthReceipt */

/**
 * An Incident. `key` (provider, fault, subject) makes a repeat update this record, and `ref`
 * is the first 6 characters of `id`, uppercased, for support. `resolvedAt` is set once
 * re-verification passes, and cleared if the fault comes back.
 */
export const incidentSchema = v.strictObject({
  id: recordId,
  ref: v.pipe(v.string(), v.regex(/^[A-Z0-9-]{6}$/)),
  key: incidentKeySchema,
  providerId: contributionId,
  faultCode,
  subjectId: v.nullable(subjectId),
  severity: v.picklist(SEVERITIES),
  state: v.picklist(INCIDENT_STATES),
  dismissed: v.boolean(),
  firstSeenAt: timestamp,
  lastSeenAt: timestamp,
  resolvedAt: v.nullable(timestamp),
  occurrences: v.pipe(count, v.minValue(1)),
  affected: capabilities,
  preserved: capabilities,
  evidence: evidenceSchema,
});

/** @typedef {v.InferOutput<typeof incidentSchema>} Incident */

/** A RemediationRun: one remediation's run, written before its first mutation (slice 3) */
export const runSchema = v.strictObject({
  id: recordId,
  commandId: contributionId,
  incidentId: v.nullable(recordId),
  state: v.picklist(RUN_STATES),
  recoveryPointId: v.optional(recordId),
  outcome: v.nullable(v.picklist(RUN_OUTCOMES)),
  startedAt: timestamp,
  updatedAt: timestamp,
});

/** @typedef {v.InferOutput<typeof runSchema>} RemediationRun */

/** A journal event. `seq` orders events in the store, which assigns it. */
export const journalEventSchema = v.strictObject({
  seq: v.pipe(count, v.minValue(1)),
  at: timestamp,
  code: v.picklist(EVENT_CODE_NAMES),
  fields: evidenceSchema,
});

/** @typedef {v.InferOutput<typeof journalEventSchema>} JournalEvent */

/**
 * `value` checked against `schema`, or a TypeError that names only the rule and the path it
 * broke, never the value: Valibot's own error quotes what it received, and a caller that logs
 * the error would log whatever text was passed in (contracts/validate.js's issues hold none)
 * @template {v.GenericSchema} S
 * @param {S} schema
 * @param {unknown} value
 * @param {string} what - the record's kind, for the message
 * @returns {v.InferOutput<S>}
 */
export function parseRecord(schema, value, what) {
  const checked = check(schema, value);
  if (checked.ok) return checked.value;
  const [issue] = /** @type {{ok: false, issues: {type: string, path: string}[]}} */ (checked).issues;
  throw new TypeError(`${what} refused: ${issue ? `${issue.type} at ${issue.path || '/'}` : 'invalid'}`);
}

/**
 * An incident's key
 * @param {string} providerId
 * @param {string} faultCode
 * @param {string | null | undefined} subjectId
 */
export function incidentKey(providerId, faultCode, subjectId) {
  return `${providerId}/${faultCode}/${subjectId || '-'}`;
}

/**
 * An incident's support ref: the first 6 characters of its id, uppercased
 * @param {string} id
 */
export function refOf(id) {
  return id.slice(0, 6).toUpperCase();
}

/**
 * The worse of two severities
 * @param {Severity} a
 * @param {Severity} b
 * @returns {Severity}
 */
export function worseSeverity(a, b) {
  return SEVERITIES.indexOf(a) <= SEVERITIES.indexOf(b) ? a : b;
}
