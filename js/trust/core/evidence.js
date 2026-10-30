/**
 * The evidence allowlist (#20, "Security and privacy"): the only fields a receipt's evidence,
 * an incident raised through recovery.raise, or a journal event may hold, each with the one
 * kind of value it takes. Evidence holds opaque ids, counts, enums, error codes and exception
 * names, durations, versions, timestamps, revision ids, `seq`, and package hashes, and
 * nothing else: no note text, title, URL, credential, prompt, model output, or error message.
 * Titles resolve at render from the ids.
 *
 * Every string here is bounded and patterned, so free text can't pass as one of them: an id
 * has no space or slash, a code is lowercase words joined by hyphens, and an exception is an
 * Error or DOMException name such as `QuotaExceededError`. A field outside this list, or a
 * value its schema refuses, is refused whole.
 */

import * as v from '../../lib/valibot/index.mjs';
import { operationName } from '../../kernel/core/contracts/envelope.js';
import { code, commitSeq, count, revision, timestamp } from '../../kernel/core/contracts/fields.js';
import { FAIL_CAUSES } from '../../kernel/core/contracts/outcomes.js';
import { SURFACES } from '../../kernel/core/contracts/surfaces.js';
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
 * An opaque id: what a record, a command, or a provider is keyed by, never a label. It
 * starts with a letter or digit and holds only letters, digits, `_`, `.`, `:`, and `-`, so no
 * sentence, path, or URL fits in one.
 */
export const opaqueId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/));

/** An Error's or DOMException's name, such as `QuotaExceededError`, never its message */
export const exceptionName = v.pipe(v.string(), v.regex(/^[A-Z][A-Za-z0-9]{0,63}$/));

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
  // Opaque ids
  providerId: opaqueId,
  incidentId: opaqueId,
  runId: opaqueId,
  commandId: opaqueId,
  subjectId: opaqueId,
  recoveryPointId: opaqueId,
  remediationId: opaqueId,
  // Codes, enums, and exception names
  code,
  faultCode: code,
  errorCode: code,
  reason: code,
  cause: v.picklist(FAIL_CAUSES),
  exception: exceptionName,
  status: v.picklist(PROVIDER_STATUSES),
  capture: v.picklist(CAPTURE_STATES),
  severity: v.picklist(SEVERITIES),
  state: v.picklist([...RUN_STATES, ...INCIDENT_STATES]),
  surface: v.picklist(SURFACES),
  operation: operationName,
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
 * @typedef {{ok: true, value: Evidence} | {ok: false, reason: EvidenceRefusal, field: string | null}} CheckedEvidence
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
 * Whether `value` is a list of codes, as an incident's affected and preserved capabilities are
 * @param {unknown} value
 * @returns {value is string[]}
 */
export function isCodeList(value) {
  return Array.isArray(value) && value.length <= 32 && value.every(item => v.is(code, item));
}
