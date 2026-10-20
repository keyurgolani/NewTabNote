/**
 * The checks a message passes before any handler sees it (#13, AC1 and AC4), in the order
 * the router runs them: its size, its JSON, its frame, the catalog entry and version it
 * names, that operation's own size limit, and its payload schema. A failure carries its
 * transport code (contracts/transport-codes.js). An answer is checked against its result
 * schema the same way before it's sent back, so a reply is as strict as a request.
 *
 * What a schema refused comes back as issues that hold no value: never what was received or
 * Valibot's message, which quotes it, and no key the sender chose. A key a strict object
 * doesn't declare shows as `*`, and every other key in a path is one a schema declares, since
 * contract schemas use no record, rest entries, map, or set (test/kernel/catalog.test.mjs
 * holds that). Issues are for tests and debugging, and nothing puts them in an outcome or a
 * log.
 *
 * The router (#13 slice 2) runs these first, then the sender, surface, entity-scope, and
 * destination checks through #12's PolicyPort.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { CodecError, decode, encodedBytes } from './codec.js';
import { frameSchema } from './envelope.js';
import { MAX_MESSAGE_BYTES } from './limits.js';

/** @typedef {import('./envelope.js').Frame} Frame */
/** @typedef {import('./envelope.js').RequestFrame} RequestFrame */
/** @typedef {import('./transport-codes.js').TransportCode} TransportCode */
/** @typedef {import('./commands.js').CommandEntry} CommandEntry */
/** @typedef {import('./queries.js').QueryEntry} QueryEntry */

/**
 * One thing a schema refused, without the value it refused
 * @typedef {object} Issue
 * @property {string} type - the schema or action that refused it, such as `string`, `strict_object`, or `max_length`
 * @property {string} path - a JSON Pointer to it
 */

/**
 * @template T
 * @typedef {{ok: true, value: T} | {ok: false, issues: Issue[]}} Checked
 */

/**
 * An operation as the router knows it: its catalog entry and its schema module's exports
 * @typedef {object} Operation
 * @property {CommandEntry | QueryEntry} entry
 * @property {v.GenericSchema} payload
 * @property {v.GenericSchema} result
 */

/**
 * @param {v.BaseIssue<unknown>} issue
 * @returns {Issue}
 */
function issueOf(issue) {
  const keys = (issue.path ?? []).map(item =>
    item.origin === 'key' ? '*' : String(item.key).replace(/~/g, '~0').replace(/\//g, '~1'),
  );
  return { type: issue.type, path: keys.map(key => `/${key}`).join('') };
}

/**
 * `value` checked against `schema`, which stops at the first issue. The value it returns is
 * Valibot's copy, with exactly the keys a strict object declares.
 * @template {v.GenericSchema} S
 * @param {S} schema
 * @param {unknown} value
 * @returns {Checked<v.InferOutput<S>>}
 */
export function check(schema, value) {
  const result = v.safeParse(schema, value, { abortEarly: true });
  if (result.success) return { ok: true, value: result.output };
  return { ok: false, issues: result.issues.map(issueOf) };
}

/**
 * @typedef {{ok: true, frame: Frame, bytes: number}
 *   | {ok: false, code: TransportCode, issues: Issue[]}} ReadFrame
 */

/**
 * A message as it arrived, read as one frame. Any message over MAX_MESSAGE_BYTES fails
 * before it's parsed, as does one that isn't JSON the codec carries.
 * @param {unknown} text
 * @returns {ReadFrame}
 */
export function readFrame(text) {
  if (typeof text !== 'string') return { ok: false, code: 'invalid-payload', issues: [] };
  // Each UTF-16 unit takes at least one byte, so a longer text can't fit
  if (text.length > MAX_MESSAGE_BYTES) return { ok: false, code: 'payload-too-large', issues: [] };
  const bytes = encodedBytes(text);
  if (bytes > MAX_MESSAGE_BYTES) return { ok: false, code: 'payload-too-large', issues: [] };
  /** @type {unknown} */
  let message;
  try {
    message = decode(text);
  } catch (error) {
    if (error instanceof CodecError) return { ok: false, code: 'invalid-payload', issues: [] };
    throw error;
  }
  const frame = check(frameSchema, message);
  if (!frame.ok) return { ok: false, code: 'invalid-payload', issues: frame.issues };
  return { ok: true, frame: frame.value, bytes };
}

/**
 * @typedef {{ok: true, operation: Operation, payload: unknown}
 *   | {ok: false, code: TransportCode, issues: Issue[]}} CheckedRequest
 */

/**
 * A request frame checked against the operation it names. `bytes` is the encoded size of the
 * message it came in. A request names the catalog version it was built against, and only the
 * catalog's current version is served: a journaled command's older entry is upcast at replay
 * instead. The payload it passes on is the one that arrived, once its schema accepts it, not
 * Valibot's copy: that copy drops a `__proto__`, `constructor`, or `prototype` key a loose
 * object such as a block holds, and the kernel keeps such a key as data. That's safe because
 * no contract schema transforms, defaults, or drops what it accepts, which
 * test/kernel/contract-schema-lint.test.mjs holds them to.
 * @param {RequestFrame} request
 * @param {number} bytes
 * @param {(name: string) => Operation | undefined} lookup
 * @returns {CheckedRequest}
 */
export function checkRequest(request, bytes, lookup) {
  const operation = lookup(request.operation);
  if (!operation) return { ok: false, code: 'unknown-operation', issues: [] };
  // maxBytes is this version's, so a request for another version is refused for its version
  if (request.version !== operation.entry.version) return { ok: false, code: 'unsupported-version', issues: [] };
  if (bytes > operation.entry.maxBytes) return { ok: false, code: 'payload-too-large', issues: [] };
  const payload = check(operation.payload, request.payload);
  if (!payload.ok) return { ok: false, code: 'invalid-payload', issues: payload.issues };
  return { ok: true, operation, payload: request.payload };
}

/**
 * An answer checked against its operation's result schema. The answer it passes on is the one
 * given, once its schema accepts it, as checkRequest passes a payload on: Valibot's copy would
 * drop a `__proto__`, `constructor`, or `prototype` key a loose object such as a block holds.
 * @param {Operation} operation
 * @param {unknown} result
 * @returns {Checked<unknown>}
 */
export function checkResult(operation, result) {
  const checked = check(operation.result, result);
  return checked.ok ? { ok: true, value: result } : checked;
}
