/**
 * The frames every transport carries (#13, "Topology" and "Cancellation, deadlines,
 * payloads"): a request, its response, a cancel, and the two replies to a cancel. Each frame
 * is one message through contracts/codec.js, and contracts/validate.js checks it here before
 * it checks the payload or result against the operation's own schema. The handshake and hints
 * come with the router (#13 slice 2), and stream frames with streams (slice 4).
 *
 * A frame's own fields are ids, names, versions, times, and codes. Only a payload or a result
 * carries content, in the fields its operation's schema marks.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { id, timestamp } from './fields.js';
import { bulkResultSchema } from './outcome-schemas.js';

/**
 * An operation's name as the catalog keys it: camelCase words, with a dot between a family
 * and its member, such as `createNote` or #35's `jobs.runNow`
 */
export const operationName = v.pipe(
  v.string(),
  v.regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/),
  v.maxLength(64),
);

/** A catalog version: an integer from 1 */
export const catalogVersion = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

/**
 * A request. `requestId` ties its response and any cancel to it, `operation` and `version`
 * name the catalog entry it was built against, and `deadline` is when the coordinator stops
 * working on it, in milliseconds since the epoch. Its payload is checked against the
 * operation's schema next.
 */
export const requestSchema = v.strictObject({
  frame: v.literal('request'),
  requestId: id,
  operation: operationName,
  version: catalogVersion,
  deadline: timestamp,
  payload: v.unknown(),
});

/** A request's answer: a command's outcome or a query's state, checked against the operation's result schema */
export const responseSchema = v.strictObject({
  frame: v.literal('response'),
  requestId: id,
  result: v.unknown(),
});

/** Asks the coordinator to stop a request */
export const cancelSchema = v.strictObject({ frame: v.literal('cancel'), requestId: id });

/**
 * The cancel landed: a query stopped, or a command stopped before its transaction opened, and
 * the request's response is rejected/validation `cancelled`
 */
export const cancelledSchema = v.strictObject({ frame: v.literal('cancelled'), requestId: id });

/**
 * The cancel came after the command's transaction opened. It carries the command's final
 * outcome, a bulk command's included, which its response carries too.
 */
export const tooLateSchema = v.strictObject({
  frame: v.literal('too-late'),
  requestId: id,
  outcome: bulkResultSchema,
});

export const frameSchema = v.variant('frame', [
  requestSchema,
  responseSchema,
  cancelSchema,
  cancelledSchema,
  tooLateSchema,
]);

/** @typedef {v.InferOutput<typeof requestSchema>} RequestFrame */
/** @typedef {v.InferOutput<typeof responseSchema>} ResponseFrame */
/** @typedef {v.InferOutput<typeof cancelSchema>} CancelFrame */
/** @typedef {v.InferOutput<typeof cancelledSchema>} CancelledFrame */
/** @typedef {v.InferOutput<typeof tooLateSchema>} TooLateFrame */
/** @typedef {v.InferOutput<typeof frameSchema>} Frame */
