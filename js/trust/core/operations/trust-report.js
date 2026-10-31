/**
 * trust.report, catalog version 1 (#20, "Contracts"): every provider the root registered,
 * with the verification operation and freshness it declares, its latest receipt, and the
 * status that receipt reads as now (`stale` past its window, `unverified` with no receipt
 * yet), plus the stored incidents (and whether the settings copy could be read for them) and
 * remediation runs. Ids, codes, counts, and times only. Each provider's row carries its one
 * next action and what still works beside its problems, from next-action.js, so no view picks
 * its own (slice 4a). The legacy copies and recovery points are recovery.copies'.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { count } from '../../../kernel/core/contracts/fields.js';
import { queryPayload } from '../../../kernel/core/contracts/operation.js';
import { queryStateSchema } from '../../../kernel/core/contracts/outcome-schemas.js';
import { providerId } from '../evidence.js';
import { nextActionSchema } from '../next-action.js';
import { capabilities, incidentSchema, operationCode, receiptSchema, runSchema } from '../records.js';
import { COST_CLASSES, HEALTH_GROUPS, PROVIDER_STATUSES } from '../vocabulary.js';

export const payload = queryPayload('trust.report', {});

export const reportSchema = v.strictObject({
  records: v.picklist(['closed', 'open', 'fallback']),
  providers: v.array(
    v.strictObject({
      providerId,
      group: v.picklist(HEALTH_GROUPS),
      core: v.boolean(),
      operation: operationCode,
      costClass: v.picklist(COST_CLASSES),
      freshnessMs: count,
      status: v.picklist(PROVIDER_STATUSES),
      receipt: v.nullable(receiptSchema),
      next: v.nullable(nextActionSchema),
      stillWorks: capabilities,
    }),
  ),
  incidents: v.array(incidentSchema),
  // Whether this report's read of the settings copy answered: when it didn't, incidents other
  // contexts hold may be missing
  copyRead: v.boolean(),
  // Whether this report's read of NewTabNoteTrust's incidents answered
  recordsRead: v.boolean(),
  runs: v.array(runSchema),
});

export const result = queryStateSchema(reportSchema);

/** @typedef {v.InferOutput<typeof payload>} TrustReportQuery */
/** @typedef {v.InferOutput<typeof reportSchema>} TrustReport */
