/**
 * system.messagingHealth, catalog version 1: the router's diagnostics (#13, "Security and
 * privacy"), which #20 registers as a health provider. Counters only: requests by operation,
 * answers by code, refusals by reason and code, latency by bucket, and connections, handshakes,
 * and reconnects. Nothing in it names a note, holds what the user wrote, or quotes a message.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { operationName, protocolSchema } from '../envelope.js';
import { code, count, id } from '../fields.js';
import { LATENCY_BUCKETS_MS } from '../limits.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('system.messagingHealth', {});

/** What the router counts since this coordinator instance started */
export const messagingHealth = v.strictObject({
  protocol: protocolSchema,
  coordinatorId: id,
  connections: count,
  handshakes: count,
  reconnects: count,
  requests: v.array(v.strictObject({ operation: operationName, count })),
  outcomes: v.array(v.strictObject({ code, count })),
  rejections: v.array(v.strictObject({ reason: v.picklist(['validation', 'policy', 'coordinator']), code, count })),
  // `underMs` is a bucket's upper bound, and null the bucket past the last one
  latency: v.array(v.strictObject({ underMs: v.nullable(v.picklist(LATENCY_BUCKETS_MS)), count })),
});

export const result = queryStateSchema(messagingHealth);

/** @typedef {v.InferOutput<typeof payload>} MessagingHealthQuery */
/** @typedef {v.InferOutput<typeof messagingHealth>} MessagingHealth */
