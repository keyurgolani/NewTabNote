/**
 * The frames on #13's hint channel, BroadcastChannel `ntn-hints` (#13, "Topology" and
 * "Desired behavior"): the coordinator's commit hints, and page-addressed requests with their
 * answers. BroadcastChannel carries no sender identity, so each frame is checked on origin,
 * schema, and payloads of ids only, as port traffic is, and a hint names what changed, never
 * what it says. Notices come with their first entries: slice 5's `settings.changed` and
 * `sync.stateChanged`, and #5's `page.accessChanged`.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { catalogVersion, operationName } from './envelope.js';
import { ENTITY_TYPES, commitSeq, id, revision, timestamp } from './fields.js';

/** The BroadcastChannel's name */
export const HINT_CHANNEL = 'ntn-hints';

/**
 * A commit hint: which entity changed, its revision, and the commit's place in #17's change
 * log. The coordinator coalesces them per entity, and a page catches up from its cursor.
 */
export const hintSchema = v.strictObject({
  frame: v.literal('hint'),
  entityType: v.picklist(ENTITY_TYPES),
  entityId: id,
  revision,
  commitSeq,
});

/** A Web Lock's name, such as #6's `ntn-editor:<noteId>`: a lowercase name, then an id */
export const lockName = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9.-]*(?::[A-Za-z0-9_.-]+)?$/), v.maxLength(200));

/**
 * The one page a page-addressed request is for: the page whose session its handshake named,
 * or the page that holds a Web Lock
 */
export const targetSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('session'), sessionId: id }),
  v.strictObject({ kind: v.literal('lock'), lock: lockName }),
]);

/**
 * A page-addressed request: a request frame's fields, and the page it's for. Its payload is
 * checked against its operation's schema next, by the page it addresses.
 */
export const pageRequestSchema = v.strictObject({
  frame: v.literal('page-request'),
  requestId: id,
  operation: operationName,
  version: catalogVersion,
  deadline: timestamp,
  target: targetSchema,
  payload: v.unknown(),
});

/** The addressed page's answer, a query state checked against the operation's result schema */
export const pageResponseSchema = v.strictObject({
  frame: v.literal('page-response'),
  requestId: id,
  result: v.unknown(),
});

export const channelFrameSchema = v.variant('frame', [hintSchema, pageRequestSchema, pageResponseSchema]);

/** @typedef {v.InferOutput<typeof hintSchema>} HintFrame */
/** @typedef {v.InferOutput<typeof targetSchema>} Target */
/** @typedef {v.InferOutput<typeof pageRequestSchema>} PageRequestFrame */
/** @typedef {v.InferOutput<typeof pageResponseSchema>} PageResponseFrame */
/** @typedef {v.InferOutput<typeof channelFrameSchema>} ChannelFrame */
