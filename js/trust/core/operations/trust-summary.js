/**
 * trust.summary, catalog version 1 (#20, "Contracts"): what Moment, Popup, Side Panel, and
 * the Trust Center's headline need, and no content: the worst core status, each group's
 * counts, whether capture is at risk, how many incidents need action, and where to send the
 * user. `route` is `recovery` (recovery.html's Recovery Center) when capture is at risk or
 * storage can't open, and `trust` otherwise, which is recovery.html's Trust Center view until
 * #3 mounts newtab.html#/workspace/trust.
 *
 * Each group says when it was last checked (`checkedAt`, its newest receipt's time) and its
 * cause (slice 4a), so the Side Panel and Popup cards can name what's wrong, and a database
 * that won't open (`open-failed`) reads apart from capture at risk for another cause (`quota`,
 * `probe-failed`): the group's worst problem that needs action, by severity and then most
 * recently seen, or, with none, its worst member at fault (failed, action required, or
 * degraded) by its receipt. A dismissed problem is never a cause.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { count, timestamp } from '../../../kernel/core/contracts/fields.js';
import { queryPayload } from '../../../kernel/core/contracts/operation.js';
import { queryStateSchema } from '../../../kernel/core/contracts/outcome-schemas.js';
import { errorCode, faultCode, providerId, recordId } from '../evidence.js';
import { consequenceKey } from '../records.js';
import { HEALTH_GROUPS, PROVIDER_STATUSES, SEVERITIES } from '../vocabulary.js';

export const payload = queryPayload('trust.summary', {});

/**
 * A group's cause: an incident's provider, fault, cause, severity, and when it was last seen,
 * or a receipt's provider, consequence, cause, and when it was checked
 */
export const causeSchema = v.strictObject({
  from: v.picklist(['incident', 'receipt']),
  providerId,
  faultCode: v.nullable(faultCode),
  errorCode: v.nullable(errorCode),
  severity: v.nullable(v.picklist(SEVERITIES)),
  consequenceKey: v.nullable(consequenceKey),
  incidentId: v.nullable(recordId),
  at: timestamp,
});

/** @typedef {v.InferOutput<typeof causeSchema>} Cause */

export const summarySchema = v.strictObject({
  worstCore: v.picklist(PROVIDER_STATUSES),
  capture: v.picklist(['safe', 'at-risk', 'unknown']),
  actionRequired: count,
  route: v.picklist(['recovery', 'trust']),
  records: v.picklist(['closed', 'open', 'fallback']),
  groups: v.array(
    v.strictObject({
      group: v.picklist(HEALTH_GROUPS),
      providers: count,
      needsAction: count,
      worst: v.picklist(PROVIDER_STATUSES),
      checkedAt: v.nullable(timestamp),
      cause: v.nullable(causeSchema),
    }),
  ),
});

export const result = queryStateSchema(summarySchema);

/** @typedef {v.InferOutput<typeof payload>} TrustSummaryQuery */
/** @typedef {v.InferOutput<typeof summarySchema>} TrustSummary */
