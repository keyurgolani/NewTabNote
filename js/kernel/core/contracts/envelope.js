/**
 * The frames every transport carries (#13, "Topology", "Handshake and compatibility", and
 * "Cancellation, deadlines, payloads"): the handshake that opens a connection, a request, its
 * response or the error that refuses it, a cancel, and the two replies to a cancel. Each frame
 * is one message through contracts/codec.js, and contracts/validate.js checks it here before
 * it checks the payload or result against the operation's own schema. Hints come with the
 * hint channel (#13 slice 2b), and stream frames with streams (slice 4).
 *
 * A frame's own fields are ids, names, versions, times, and codes. Only a payload or a result
 * carries content, in the fields its operation's schema marks.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { code, count, id, timestamp } from './fields.js';
import { bulkResultSchema } from './outcome-schemas.js';
import { SURFACES } from './surfaces.js';
import { NO_ANSWER_CODES, POLICY_CODES, VALIDATION_CODES } from './transport-codes.js';

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

/** The protocol a peer speaks (contracts/limits.js, PROTOCOL_VERSION) */
export const protocolSchema = v.strictObject({ major: count, minor: count });

/** An extension version as a manifest writes one: one to four numbers, dot-separated */
export const extensionVersion = v.pipe(v.string(), v.regex(/^\d{1,5}(?:\.\d{1,5}){0,3}$/));

/**
 * The first frame on a connection, from the client: the protocol it speaks, the extension
 * version it runs, its surface, and the session it keeps across reconnects, which becomes its
 * `contextId`. The router holds the surface to the one it read from the sender, so a page
 * can't claim another.
 */
export const helloSchema = v.strictObject({
  frame: v.literal('hello'),
  protocol: protocolSchema,
  extensionVersion,
  surface: v.picklist(SURFACES),
  sessionId: id,
});

/**
 * The coordinator's answer to a hello, sent before its start-up maintenance: the protocol it
 * speaks, its extension version, this instance's id, which a client sees change when the
 * worker restarted, and whether it's ready or degraded and why (#35's `starting`,
 * `migrating`, and `restoring`). A client whose major version differs sends no command.
 */
export const welcomeSchema = v.strictObject({
  frame: v.literal('welcome'),
  protocol: protocolSchema,
  extensionVersion,
  coordinatorId: id,
  status: v.picklist(['ready', 'degraded']),
  reason: v.optional(code),
});

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

/**
 * A request the router refused before any handler ran, by its transport code
 * (contracts/transport-codes.js). The router can't always tell a command from a query, since
 * the operation it names may be one it doesn't know, so the client, which knows what it sent,
 * turns the code into that kind's outcome or failed state, as for a request that never started.
 */
export const errorSchema = v.strictObject({
  frame: v.literal('error'),
  requestId: id,
  code: v.picklist([...VALIDATION_CODES, ...POLICY_CODES, ...NO_ANSWER_CODES]),
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
  helloSchema,
  welcomeSchema,
  requestSchema,
  responseSchema,
  errorSchema,
  cancelSchema,
  cancelledSchema,
  tooLateSchema,
]);

/** @typedef {v.InferOutput<typeof protocolSchema>} ProtocolVersion */
/** @typedef {v.InferOutput<typeof helloSchema>} HelloFrame */
/** @typedef {v.InferOutput<typeof welcomeSchema>} WelcomeFrame */
/** @typedef {v.InferOutput<typeof errorSchema>} ErrorFrame */
/** @typedef {v.InferOutput<typeof requestSchema>} RequestFrame */
/** @typedef {v.InferOutput<typeof responseSchema>} ResponseFrame */
/** @typedef {v.InferOutput<typeof cancelSchema>} CancelFrame */
/** @typedef {v.InferOutput<typeof cancelledSchema>} CancelledFrame */
/** @typedef {v.InferOutput<typeof tooLateSchema>} TooLateFrame */
/** @typedef {v.InferOutput<typeof frameSchema>} Frame */
