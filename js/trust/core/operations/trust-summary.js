/**
 * trust.summary, catalog version 1 (#20, "Contracts"): what Moment, Popup, Side Panel, and
 * the Trust Center's headline need, and no content: the worst core status, each group's
 * counts, whether capture is at risk, how many incidents need action, and where to send the
 * user. `route` is `recovery` (recovery.html's Recovery Center) when capture is at risk or
 * storage can't open, and `trust` otherwise, which is recovery.html's Trust Center view until
 * #3 mounts newtab.html#/workspace/trust.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { count } from '../../../kernel/core/contracts/fields.js';
import { queryPayload } from '../../../kernel/core/contracts/operation.js';
import { queryStateSchema } from '../../../kernel/core/contracts/outcome-schemas.js';
import { HEALTH_GROUPS, PROVIDER_STATUSES } from '../vocabulary.js';

export const payload = queryPayload('trust.summary', {});

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
    }),
  ),
});

export const result = queryStateSchema(summarySchema);

/** @typedef {v.InferOutput<typeof payload>} TrustSummaryQuery */
/** @typedef {v.InferOutput<typeof summarySchema>} TrustSummary */
