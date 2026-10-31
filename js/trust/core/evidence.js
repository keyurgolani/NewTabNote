/**
 * The evidence allowlist (#20, "Security and privacy"): the only fields a receipt's evidence,
 * an incident raised through recovery.raise, or a journal event may hold, each with the one
 * kind of value it takes. Evidence holds opaque ids, counts, enums, error codes and exception
 * names, durations, versions, timestamps, revision ids, `seq`, and package hashes, and
 * nothing else: no note text, title, URL, credential, prompt, model output, or error message.
 * Titles resolve at render from the ids.
 *
 * No string here is free: a record id has a UUID's or a legacy id's shape (whose suffix can
 * still spell a short word), and a provider, a remediation, a subject that isn't a record, and
 * every code, reason, exception, and capability is one codes.js lists. So no title, key, host, or message fits in
 * any field. A field outside this list, or a value its schema refuses, is refused whole.
 */

import * as v from '../../lib/valibot/index.mjs';
import { commitSeq, count, revision, timestamp } from '../../kernel/core/contracts/fields.js';
import { FAIL_CAUSES } from '../../kernel/core/contracts/outcomes.js';
import { SURFACES } from '../../kernel/core/contracts/surfaces.js';
import {
  CAPABILITIES,
  ERROR_CODES,
  EXCEPTION_NAMES,
  FAULT_CODES,
  PROVIDER_IDS,
  REASON_CODES,
  REMEDIATION_IDS,
  RUN_OUTCOMES,
  SUBJECT_NAMES,
} from './codes.js';
import {
  CAPTURE_STATES,
  COST_CLASSES,
  INCIDENT_STATES,
  PROVIDER_STATUSES,
  RUN_STATES,
  SEVERITIES,
  TRIGGERS,
} from './vocabulary.js';

/**
 * A record's id, which the host's ids port makes: a UUID (crypto.randomUUID), or the id
 * Utils.generateId has made in every release, a 13-digit millisecond time, a hyphen, and what
 * `Math.random().toString(36).substr(2, 9)` gives: up to nine base-36 characters, fewer about
 * once in 4,650 calls. No sentence, host, path, or key fits, though a suffix can still spell a
 * short lowercase word or number.
 */
export const recordId = v.pipe(
  v.string(),
  v.regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{13}-[a-z0-9]{0,9})$/),
);

/**
 * A #17 recovery point's id (js/kernel/adapters/indexeddb/recovery-points.js): its kind and
 * the time it was made, with a counter when two share a millisecond, such as
 * `pre-migration-1760000000000` or `pre-repair-1760000000000-2`
 */
export const pointId = v.pipe(v.string(), v.regex(/^pre-(?:migration|repair)-[0-9]{10,16}(?:-[0-9]{1,3})?$/));

/** A recovery point's id as a record holds it: a #17 point's, or a record id */
export const recoveryPointId = v.union([recordId, pointId]);

/** A health provider's id, from the registered ones (codes.js) */
export const providerId = v.picklist(PROVIDER_IDS);

/** A remediation's id, from the registered ones (codes.js) */
export const remediationId = v.picklist(REMEDIATION_IDS);

/**
 * What an incident or a remediation is about: a record's id, a named database, store, or
 * permission, a legacy copy's key, or a #17 recovery point's id
 */
export const subjectId = v.union([
  recordId,
  v.picklist(SUBJECT_NAMES),
  v.pipe(v.string(), v.regex(/^(?:auto|recovery)_backup_[0-9]{10,16}$/)),
  pointId,
]);

/** An Error's or DOMException's name, from the known ones, never its message */
export const exceptionName = v.picklist(EXCEPTION_NAMES);

/** A registered error code (codes.js) */
export const errorCode = v.picklist(ERROR_CODES);

/** A registered fault code (codes.js) */
export const faultCode = v.picklist(FAULT_CODES);

/** A registered capability (codes.js) */
export const capability = v.picklist(CAPABILITIES);

/** A dotted version such as an extension's `1.4.1` or a browser's `131.0.6778.85` */
export const dottedVersion = v.pipe(v.string(), v.regex(/^[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}$/));

/** A SHA-256 package hash, in lowercase hex */
export const packageHash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));

/** A positive integer version, such as a schema's */
const integerVersion = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

/**
 * Every evidence field and the kind of value it holds
 * @type {Readonly<Record<string, v.GenericSchema>>}
 */
export const EVIDENCE_FIELDS = Object.freeze({
  // Ids
  providerId,
  remediationId,
  incidentId: recordId,
  runId: recordId,
  commandId: recordId,
  recoveryPointId,
  subjectId,
  // Registered codes, enums, and exception names
  faultCode,
  errorCode,
  reason: v.picklist(REASON_CODES),
  outcome: v.picklist(RUN_OUTCOMES),
  cause: v.picklist(FAIL_CAUSES),
  exception: exceptionName,
  status: v.picklist(PROVIDER_STATUSES),
  capture: v.picklist(CAPTURE_STATES),
  severity: v.picklist(SEVERITIES),
  state: v.picklist([...RUN_STATES, ...INCIDENT_STATES]),
  surface: v.picklist(SURFACES),
  trigger: v.picklist(TRIGGERS),
  costClass: v.picklist(COST_CLASSES),
  retryable: v.boolean(),
  // Counts and sizes
  count,
  attempts: count,
  bytes: count,
  records: count,
  pending: count,
  lag: count,
  // Durations
  durationMs: count,
  timeoutMs: count,
  ageMs: count,
  // Versions and hashes
  version: integerVersion,
  schemaVersion: integerVersion,
  extensionVersion: dottedVersion,
  browserVersion: dottedVersion,
  packageHash,
  // Timestamps, revisions, and positions in #17's change log
  at: timestamp,
  since: timestamp,
  verifiedAt: timestamp,
  revision,
  seq: commitSeq,
});

/** @typedef {keyof typeof EVIDENCE_FIELDS} EvidenceField */

/** Every evidence field's name, sorted */
export const EVIDENCE_FIELD_NAMES = Object.freeze(Object.keys(EVIDENCE_FIELDS).sort());

/**
 * Evidence as a schema: a strict object whose every field is optional and on the allowlist,
 * so a field outside it is refused, not dropped
 */
export const evidenceSchema = v.strictObject(
  /** @type {Record<string, v.OptionalSchema<v.GenericSchema, undefined>>} */ (
    Object.fromEntries(Object.entries(EVIDENCE_FIELDS).map(([name, schema]) => [name, v.optional(schema)]))
  ),
);

/** @typedef {Readonly<Record<string, string | number | boolean>>} Evidence */

/**
 * Why evidence was refused: a field the allowlist (or the event's own list) lacks, or a value
 * its field's schema refuses. Both are reason codes only, never the field's value.
 * @typedef {'field-not-allowed' | 'value-not-allowed' | 'not-an-object'} EvidenceRefusal
 */

/**
 * @typedef {{ok: false, reason: EvidenceRefusal, field: string | null}} RefusedEvidence
 */

/**
 * @typedef {{ok: true, value: Evidence} | RefusedEvidence} CheckedEvidence
 */

/**
 * Whether `value` is an object made by `{}` or Object.create(null), not an array, an Error, or
 * a class instance, whose own fields might be anything
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * `fields` checked against the allowlist, and against `allowed` when given (an event code's
 * own list). The value returned is a frozen copy with exactly those fields. `field` names the
 * refused field only when it's an allowlisted name, since a name the code didn't choose from
 * this list might be anything.
 * @param {unknown} fields
 * @param {readonly string[]} [allowed]
 * @returns {CheckedEvidence}
 */
export function checkEvidence(fields, allowed) {
  if (fields === undefined) return { ok: true, value: Object.freeze({}) };
  if (!isPlainObject(fields)) return { ok: false, reason: 'not-an-object', field: null };
  /** @type {Record<string, string | number | boolean>} */
  const copy = {};
  for (const name of Object.keys(fields)) {
    const listed = Object.prototype.hasOwnProperty.call(EVIDENCE_FIELDS, name);
    if (!listed || (allowed && !allowed.includes(name))) {
      return { ok: false, reason: 'field-not-allowed', field: listed ? name : null };
    }
    const value = fields[name];
    if (value === undefined) continue;
    if (!v.is(EVIDENCE_FIELDS[name], value)) return { ok: false, reason: 'value-not-allowed', field: name };
    copy[name] = /** @type {string | number | boolean} */ (value);
  }
  return { ok: true, value: Object.freeze(copy) };
}

/**
 * Whether `value` is a list of registered capabilities, as an incident's affected and preserved ones are
 * @param {unknown} value
 * @returns {value is string[]}
 */
export function isCodeList(value) {
  return Array.isArray(value) && value.length <= 32 && value.every(item => v.is(capability, item));
}
