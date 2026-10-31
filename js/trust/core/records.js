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
import {
  capability,
  errorCode,
  evidenceSchema,
  faultCode,
  pointId,
  providerId,
  recordId,
  recoveryPointId,
  remediationId,
  subjectId,
} from './evidence.js';
import {
  CAPTURE_STATES,
  COST_CLASSES,
  INCIDENT_STATES,
  RECEIPT_STATUSES,
  RUN_STATES,
  RUN_STEPS,
  SECRET_PLACES,
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
  providerId,
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
  nextAction: v.nullable(remediationId),
  executionClass: v.optional(v.picklist(COST_CLASSES)),
  transition: v.boolean(),
});

/** @typedef {v.InferOutput<typeof receiptSchema>} HealthReceipt */

/**
 * An Incident. `key` (provider, fault, subject) makes a repeat update this record, and `ref`
 * is the first 6 characters of `id`, uppercased, for support. `resolvedAt` is set once
 * re-verification passes, and cleared if the fault comes back after it. `dismissChangedAt` is
 * when it was last dismissed or undismissed, and `dismissedCause` the error code it held when
 * it was dismissed, while it is. incidents.js holds the rules.
 */
export const incidentSchema = v.strictObject({
  id: recordId,
  ref: v.pipe(v.string(), v.regex(/^[A-Z0-9-]{6}$/)),
  key: incidentKeySchema,
  providerId,
  faultCode,
  subjectId: v.nullable(subjectId),
  severity: v.picklist(SEVERITIES),
  state: v.picklist(INCIDENT_STATES),
  dismissed: v.boolean(),
  dismissChangedAt: v.nullable(timestamp),
  // The cause (`evidence.errorCode`) it was dismissed with, null for none: a later sighting
  // naming another brings it back (incidents.js). Absent while it isn't dismissed.
  dismissedCause: v.optional(v.nullable(errorCode)),
  firstSeenAt: timestamp,
  lastSeenAt: timestamp,
  resolvedAt: v.nullable(timestamp),
  occurrences: v.pipe(count, v.minValue(1)),
  affected: capabilities,
  preserved: capabilities,
  evidence: evidenceSchema,
  // The copy lineages already replayed into it, each with the highest count applied, newest
  // last, so a replay never counts twice (incidents.js)
  appliedOps: v.pipe(v.array(v.strictObject({ lineage: recordId, count })), v.maxLength(64)),
  // The contexts (each records instance's random id) that sighted it since it was last
  // resolved, at most 8: the records resolve their own write-failed only when it's one, the
  // context resolving (trust-records.js)
  sightedBy: v.optional(v.pipe(v.array(recordId), v.maxLength(8))),
});

/** @typedef {v.InferOutput<typeof incidentSchema>} Incident */

/** Where a salvage file reads from (remediation/salvage-file.js) */
export const SALVAGE_ORIGINS = Object.freeze(/** @type {const} */ (['CanvasTabDB', 'legacyCopies', 'recoveryPoints']));

/**
 * The CanvasTabDB stores a salvage file holds: version 8's, but the secret `settings`, #17's
 * `meta` and `migrations`, the four step 10 adds (#17 PR 2a): the ledger, the change log, the
 * conflict records, which keep the text of a save that lost, and the tombstones, and step 11's
 * daily index (#17 PR 3b). Any other store is left out, since nothing says what it holds.
 */
export const SALVAGE_STORES = Object.freeze(
  /** @type {const} */ ([
    'canvases',
    'elements',
    'media',
    'folders',
    'search_index',
    'links',
    'themes',
    'vectors',
    'snapshots',
    'meta',
    'migrations',
    'operations',
    'changes',
    'conflicts',
    'tombstones',
    'daily_index',
  ]),
);

/** The most `unreadable` entries an answer or a run record carries; a count says how many there were */
export const MAX_UNREADABLE = 64;

/**
 * A source or a store a saved file couldn't read: where, and its code. `part` is the store,
 * null for a whole source, and `pointId` the recovery point it's in, when it's in one.
 */
export const unreadableSchema = v.strictObject({
  origin: v.picklist(SALVAGE_ORIGINS),
  part: v.nullable(v.picklist(SALVAGE_STORES)),
  pointId: v.nullable(pointId),
  code: v.picklist(RUN_OUTCOMES),
});

/**
 * How much a file a run saved holds, as it read back: notes (trashed and unimportable ones
 * included), blocks, media, folders, legacy copies, and recovery points, and its length in
 * characters. A file that isn't a notes file (the diagnostic report) has only its length.
 */
export const savedSchema = v.strictObject({
  notes: v.optional(count),
  blocks: v.optional(count),
  media: v.optional(count),
  folders: v.optional(count),
  legacyCopies: v.optional(count),
  recoveryPoints: v.optional(count),
  characters: count,
});

/** @typedef {v.InferOutput<typeof savedSchema>} Saved */

/** The saved-key places a secret removal names, by name, never a value */
export const placesSchema = v.pipe(v.array(v.picklist(SECRET_PLACES)), v.maxLength(SECRET_PLACES.length));

/**
 * A RemediationRun: one remediation's run, written before its first mutation (slice 3's
 * pipeline). `commandId` is the remediation's id. `step` is the step it's on or stopped at,
 * written before that step starts, and `subjectId` what it acts on when it isn't the whole
 * store, such as the legacy copy a Save as file saves. `fileSavedAt` is when a recovery file
 * this run saved read back verified.
 */
export const runSchema = v.strictObject({
  id: recordId,
  commandId: remediationId,
  incidentId: v.nullable(recordId),
  subjectId: v.optional(v.nullable(subjectId)),
  state: v.picklist(RUN_STATES),
  step: v.optional(v.picklist(RUN_STEPS)),
  recoveryPointId: v.optional(recoveryPointId),
  fileSavedAt: v.optional(timestamp),
  // What a saved file couldn't read (the first 64), how many there were, and whether the file
  // the user picked may be empty, so a resend answers as the run finished
  unreadable: v.optional(v.pipe(v.array(unreadableSchema), v.maxLength(MAX_UNREADABLE))),
  unreadableCount: v.optional(count),
  fileMayBeEmpty: v.optional(v.boolean()),
  // How much the file it saved holds, and the note it made (recover-orphans'), so a resend
  // answers as it finished
  saved: v.optional(savedSchema),
  noteId: v.optional(recordId),
  // What a secret removal took out, and what it found still there after
  removed: v.optional(placesSchema),
  kept: v.optional(placesSchema),
  // What it couldn't tell went or stayed, when the read after it failed
  unknown: v.optional(placesSchema),
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
