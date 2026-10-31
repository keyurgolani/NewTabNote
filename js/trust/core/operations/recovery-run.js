/**
 * recovery.run, catalog version 1 (#20, "Contracts"): run a remediation the user chose.
 * `userInitiated` is always `true`, set only by a click handler on a `newtab` or `recovery`
 * page, so nothing else can start one. Slice 3's pipeline (remediation/pipeline.js) is its use
 * case, and no root registers a handler for it yet.
 *
 * A run goes plan, preview, protect, apply, verify, record. A class that needs the user's
 * confirmation answers `awaiting-confirmation` with its preview first, and the view sends the
 * same remediation again with that run's `runId`, `decision: 'confirm'` (or `'cancel'`), and
 * the `previewDigest` the answer gave, so a confirmation applies only the preview the user
 * saw, plus `typedPhrase`, the action's name typed out, for an irreversible one. None of them
 * is stored. `subjectId` is only for a remediation that takes one (Save as file).
 *
 * A saved file's run names each source or store it couldn't read in `unreadable`: `verified`
 * only when every one read, `saved-partial` (a warning) when some didn't but the file holds
 * records, and `failed` with `nothing-readable` when it holds none while any source didn't
 * read. `unreadable` carries the first 64, and `unreadableCount` how many there were.
 * `fileMayBeEmpty` says a file was picked and the save didn't verify, so the file the user
 * chose may be empty or short, and a good file they picked over may be gone. `saved` says how
 * much a file it saved and read back holds (so "Saved and checked" can say how much), and
 * `noteId` is the note a run made (recover-orphans' new Inbox note), for the view to open.
 *
 * It answers a `remediation` outcome for every run it started, whatever state the run is in,
 * so nothing reads a run that didn't verify as committed: `succeeded` only once its verify
 * passed. A run it couldn't start answers rejected (a payload or a remediation that isn't
 * there) or unavailable (another context runs the same key, `coordinator`
 * `remediation-running`, or its record wouldn't write, `storage` `not-recorded`).
 */

import * as v from '../../../lib/valibot/index.mjs';
import { count } from '../../../kernel/core/contracts/fields.js';
import { commandPayload } from '../../../kernel/core/contracts/operation.js';
import {
  rejectedSchema,
  unavailableSchema,
  unknownSchema,
} from '../../../kernel/core/contracts/outcome-schemas.js';
import { RUN_OUTCOMES } from '../codes.js';
import { recordId, recoveryPointId, remediationId, subjectId } from '../evidence.js';
import { previewSchema } from '../remediation/preview.js';
import { MAX_UNREADABLE, savedSchema, unreadableSchema } from '../records.js';
import { PROTECTIONS, REMEDIATION_CLASSES, RUN_STATES, RUN_STEPS } from '../vocabulary.js';

/** A preview's digest (pipeline.js's digestOf): what a confirmation names the preview it confirms by */
export const previewDigest = v.pipe(v.string(), v.regex(/^[0-9a-f]{16}$/));

export const payload = commandPayload('recovery.run', {
  remediationId,
  incidentId: v.optional(v.nullable(recordId)),
  subjectId: v.optional(v.nullable(subjectId)),
  runId: v.optional(recordId),
  decision: v.optional(v.picklist(['confirm', 'cancel'])),
  previewDigest: v.optional(previewDigest),
  typedPhrase: v.optional(v.pipe(v.string(), v.maxLength(64))),
  userInitiated: v.literal(true),
});

/** A run's answer, in whatever state the run is: never a committed outcome */
export const remediationSchema = v.strictObject({
  kind: v.literal('remediation'),
  runId: recordId,
  remediationId,
  class: v.picklist(REMEDIATION_CLASSES),
  state: v.picklist(RUN_STATES),
  step: v.nullable(v.picklist(RUN_STEPS)),
  outcome: v.nullable(v.picklist(RUN_OUTCOMES)),
  needs: v.pipe(v.array(v.picklist(PROTECTIONS)), v.maxLength(PROTECTIONS.length)),
  impact: v.nullable(previewSchema),
  previewDigest: v.nullable(previewDigest),
  unreadable: v.pipe(v.array(unreadableSchema), v.maxLength(MAX_UNREADABLE)),
  unreadableCount: count,
  fileMayBeEmpty: v.boolean(),
  saved: v.optional(savedSchema),
  noteId: v.optional(recordId),
  recoveryPointId: v.optional(recoveryPointId),
  recorded: v.boolean(),
  messageKey: v.pipe(v.string(), v.regex(/^remediation\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), v.maxLength(80)),
  severity: v.picklist(['success', 'info', 'warning', 'error']),
});

/** @typedef {v.InferOutput<typeof remediationSchema>} RemediationAnswer */

export const result = v.variant('kind', [remediationSchema, rejectedSchema, unavailableSchema, unknownSchema]);

/** @typedef {v.InferOutput<typeof payload>} RecoveryRun */
