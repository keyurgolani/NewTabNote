/**
 * recovery.copies, catalog version 1 (#20 slice 4a): Copies of your notes, newest first. #17's
 * recovery points, the `pre-repair` points a reversible repair makes included, and 1.4.x's
 * legacy copies in chrome.storage.local, each with when it was made, whether it verified, the
 * run that made it (a `pre-repair` point's), and what the view may offer for it: Save as file
 * (`save-recovery-file`), for a legacy copy or a verified point, while Restore is deferred.
 * Ids, kinds, and times only, never a row.
 *
 * `pointsRead` and `copiesRead` say whether each list was read: a read that failed, or a host
 * without the port, lists none of that kind, which is never "there are none".
 */

import * as v from '../../../lib/valibot/index.mjs';
import { timestamp } from '../../../kernel/core/contracts/fields.js';
import { queryPayload } from '../../../kernel/core/contracts/operation.js';
import { queryStateSchema } from '../../../kernel/core/contracts/outcome-schemas.js';
import { recordId, remediationId, subjectId } from '../evidence.js';

export const payload = queryPayload('recovery.copies', {});

export const copySchema = v.strictObject({
  // A point's id, or a legacy copy's key
  id: subjectId,
  kind: v.picklist(['recovery-point', 'legacy-copy']),
  pointKind: v.nullable(v.picklist(['pre-migration', 'pre-repair'])),
  at: v.nullable(timestamp),
  verified: v.boolean(),
  madeBy: v.nullable(v.strictObject({ runId: recordId, remediationId })),
  actions: v.pipe(v.array(remediationId), v.maxLength(4)),
});

/** @typedef {v.InferOutput<typeof copySchema>} Copy */

export const copiesSchema = v.strictObject({
  copies: v.pipe(v.array(copySchema), v.maxLength(500)),
  pointsRead: v.boolean(),
  copiesRead: v.boolean(),
});

/** @typedef {v.InferOutput<typeof copiesSchema>} Copies */

export const result = queryStateSchema(copiesSchema);

/** @typedef {v.InferOutput<typeof payload>} RecoveryCopiesQuery */
