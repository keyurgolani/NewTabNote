// #13's frames (contracts/envelope.js), the checks a message passes before a handler sees it
// (contracts/validate.js), and how transport codes map onto #12's outcomes
// (contracts/transport-codes.js).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as v from '../../js/lib/valibot/index.mjs';
import { encode } from '../../js/kernel/core/contracts/codec.js';
import { COMMANDS } from '../../js/kernel/core/contracts/commands.js';
import {
  cancelSchema,
  cancelledSchema,
  errorSchema,
  frameSchema,
  helloSchema,
  operationName,
  requestSchema,
  responseSchema,
  tooLateSchema,
  welcomeSchema,
} from '../../js/kernel/core/contracts/envelope.js';
import { MAX_DEPTH, MAX_MESSAGE_BYTES, SMALL_MESSAGE_BYTES } from '../../js/kernel/core/contracts/limits.js';
import { failedSchema, outcomeSchema } from '../../js/kernel/core/contracts/outcome-schemas.js';
import { bulk, committed, rejected } from '../../js/kernel/core/contracts/outcomes.js';
import { QUERIES } from '../../js/kernel/core/contracts/queries.js';
import {
  NO_ANSWER_CODES,
  POLICY_CODES,
  VALIDATION_CODES,
  commandOutcome,
  isTransportCode,
  queryFailure,
} from '../../js/kernel/core/contracts/transport-codes.js';
import { check, checkRequest, checkResult, readFrame } from '../../js/kernel/core/contracts/validate.js';
import { NOW } from './support.mjs';

/** @typedef {import('../../js/kernel/core/contracts/validate.js').Operation} Operation */

const CATALOG_URL = new URL('../../js/kernel/core/contracts/commands.js', import.meta.url);

/** @type {Map<string, Operation>} */
const operations = new Map();
for (const [name, entry] of [...Object.entries(COMMANDS), ...Object.entries(QUERIES)]) {
  const { payload, result } = await import(new URL(entry.schema, CATALOG_URL).href);
  operations.set(name, { entry, payload, result });
}

/** @param {string} name */
const lookup = name => operations.get(name);

/**
 * A request frame for `operation`
 * @param {string} operation
 * @param {unknown} payload
 * @param {Record<string, unknown>} [fields]
 */
const request = (operation, payload, fields = {}) => ({
  frame: 'request',
  requestId: 'r1',
  operation,
  version: 1,
  deadline: NOW + 30_000,
  payload,
  ...fields,
});

const capture = {
  type: 'captureToDailyNote',
  commandId: 'c1',
  noteId: 'd1',
  blockId: 'b1',
  capture: { type: 'text', content: 'A quote from the page', source: 'https://example.test/private' },
};

/**
 * The request `text` names, checked through to its payload
 * @param {string} text
 */
function readRequest(text) {
  const read = readFrame(text);
  if (!read.ok) return read;
  assert.equal(read.frame.frame, 'request');
  return checkRequest(
    /** @type {import('../../js/kernel/core/contracts/envelope.js').RequestFrame} */ (read.frame),
    read.bytes,
    lookup,
  );
}

describe('transport codes (#13, "Outcomes and authorization")', () => {
  it('are the codes #13 names, each in one group', () => {
    assert.deepEqual(VALIDATION_CODES, [
      'invalid-payload',
      'payload-too-large',
      'unknown-operation',
      'unsupported-version',
      'idempotency-key-reuse',
      'cancelled',
    ]);
    assert.deepEqual(POLICY_CODES, ['unauthorized-sender', 'forbidden-for-surface']);
    assert.deepEqual(NO_ANSWER_CODES, ['unavailable', 'outcome-unknown', 'deadline-exceeded']);
    for (const code of [...VALIDATION_CODES, ...POLICY_CODES, ...NO_ANSWER_CODES]) assert.ok(isTransportCode(code));
    for (const code of ['conflict', 'quota-exceeded', 'too-late', 'resync-required', '', 5]) {
      assert.equal(isTransportCode(code), false, String(code));
    }
  });

  it('give a command rejected, unknown, or unavailable, as #12 defines each', () => {
    for (const code of VALIDATION_CODES) {
      const outcome = commandOutcome(code, { commandId: 'c1', mayHaveStarted: true });
      assert.deepEqual(outcome, rejected('validation', code));
    }
    for (const code of POLICY_CODES) {
      assert.deepEqual(commandOutcome(code, { commandId: 'c1', mayHaveStarted: false }), rejected('policy', code));
    }
    /** @param {import('../../js/kernel/core/contracts/transport-codes.js').TransportCode} code @param {boolean} mayHaveStarted */
    const answer = (code, mayHaveStarted) => commandOutcome(code, { commandId: 'c1', mayHaveStarted });
    // A command that may have started is unknown, whatever stopped its answer, so a save that
    // may have committed never shows failed: the client resolves it by its key
    assert.deepEqual(answer('outcome-unknown', true), {
      kind: 'unknown',
      code: 'outcome-unknown',
      commandId: 'c1',
      messageKey: 'unknown.outcome-unknown',
      severity: 'warning',
    });
    assert.equal(answer('outcome-unknown', false).kind, 'unknown');
    assert.equal(answer('deadline-exceeded', true).kind, 'unknown');
    assert.deepEqual(answer('unavailable', true), {
      kind: 'unknown',
      code: 'unavailable',
      commandId: 'c1',
      messageKey: 'unknown.unavailable',
      severity: 'warning',
    });
    // Only one that can't have started is unavailable, and a resend is safe
    for (const [code, mayHaveStarted] of /** @type {const} */ ([
      ['deadline-exceeded', false],
      ['unavailable', false],
    ])) {
      assert.deepEqual(answer(code, mayHaveStarted), {
        kind: 'unavailable',
        cause: 'coordinator',
        code,
        retryable: true,
        messageKey: `unavailable.${code}`,
        severity: 'error',
      });
    }
    for (const code of [...VALIDATION_CODES, ...POLICY_CODES, ...NO_ANSWER_CODES]) {
      for (const mayHaveStarted of [true, false]) {
        assert.equal(v.safeParse(outcomeSchema, answer(code, mayHaveStarted)).success, true, code);
      }
    }
  });

  it('give a query the failed state with its cause', () => {
    for (const code of VALIDATION_CODES)
      assert.deepEqual(queryFailure(code), { kind: 'failed', cause: 'validation', code });
    for (const code of POLICY_CODES) assert.deepEqual(queryFailure(code), { kind: 'failed', cause: 'policy', code });
    for (const code of NO_ANSWER_CODES)
      assert.deepEqual(queryFailure(code), { kind: 'failed', cause: 'coordinator', code });
    for (const code of [...VALIDATION_CODES, ...POLICY_CODES, ...NO_ANSWER_CODES]) {
      assert.equal(v.safeParse(failedSchema, queryFailure(code)).success, true, code);
    }
  });
});

describe('frames (#13, "Topology")', () => {
  it('a request names its operation, catalog version, and deadline, and carries a payload', () => {
    assert.equal(check(requestSchema, request('createNote', {})).ok, true);
    assert.equal(check(frameSchema, request('jobs.runNow', {})).ok, true);
    for (const name of ['jobs.runNow', 'system.messagingHealth', 'getNote']) {
      assert.equal(check(operationName, name).ok, true, name);
    }
    for (const name of ['', 'CreateNote', 'create-note', 'jobs.', '.runNow', 'a b', 'x'.repeat(65)]) {
      assert.equal(check(operationName, name).ok, false, name);
    }
    for (const fields of [
      { version: 0 },
      { version: 1.5 },
      { deadline: -1 },
      { requestId: '' },
      { sender: 'newtab' },
      { frame: 'stream' },
    ]) {
      assert.equal(check(frameSchema, request('createNote', {}, fields)).ok, false, JSON.stringify(fields));
    }
  });

  it('a response, a cancel, and the two replies to a cancel', () => {
    const outcome = committed('note-created', ['n1']);
    assert.equal(check(responseSchema, { frame: 'response', requestId: 'r1', result: outcome }).ok, true);
    assert.equal(check(cancelSchema, { frame: 'cancel', requestId: 'r1' }).ok, true);
    assert.equal(check(cancelledSchema, { frame: 'cancelled', requestId: 'r1' }).ok, true);
    assert.equal(check(tooLateSchema, { frame: 'too-late', requestId: 'r1', outcome }).ok, true);
    const items = bulk('trash', [{ id: 'n1', outcome: committed('note-trashed', ['n1']) }]);
    assert.equal(check(tooLateSchema, { frame: 'too-late', requestId: 'r1', outcome: items }).ok, true);
    assert.equal(check(tooLateSchema, { frame: 'too-late', requestId: 'r1', outcome: { kind: 'saved' } }).ok, false);
    assert.equal(check(cancelSchema, { frame: 'cancel', requestId: 'r1', reason: 'closed' }).ok, false);
  });

  it('a hello names the protocol, extension version, surface, and session, and a welcome the coordinator and its status', () => {
    const hello = {
      frame: 'hello',
      protocol: { major: 1, minor: 0 },
      extensionVersion: '1.4.1',
      surface: 'popup',
      sessionId: 's1',
    };
    assert.equal(check(helloSchema, hello).ok, true);
    assert.equal(check(frameSchema, hello).ok, true);
    const welcome = {
      frame: 'welcome',
      protocol: { major: 1, minor: 2 },
      extensionVersion: '1.4.1',
      coordinatorId: 'c1',
      status: 'ready',
    };
    assert.equal(check(welcomeSchema, welcome).ok, true);
    assert.equal(check(frameSchema, { ...welcome, status: 'degraded', reason: 'starting' }).ok, true);
    for (const fields of [
      { surface: 'webpage' },
      { sessionId: '' },
      { extensionVersion: '1.4.1-beta' },
      { extensionVersion: '1.2.3.4.5' },
      { protocol: { major: 1 } },
      { protocol: { major: -1, minor: 0 } },
      { origin: 'chrome-extension://abc' },
    ]) {
      assert.equal(check(helloSchema, { ...hello, ...fields }).ok, false, JSON.stringify(fields));
    }
    for (const fields of [{ status: 'stopped' }, { reason: 'Starting up' }, { coordinatorId: '' }]) {
      assert.equal(check(welcomeSchema, { ...welcome, ...fields }).ok, false, JSON.stringify(fields));
    }
  });

  it('an error carries one transport code for a request the router refused, and nothing else', () => {
    for (const code of [...VALIDATION_CODES, ...POLICY_CODES, ...NO_ANSWER_CODES]) {
      assert.equal(check(errorSchema, { frame: 'error', requestId: 'r1', code }).ok, true, code);
    }
    assert.equal(check(frameSchema, { frame: 'error', requestId: 'r1', code: 'unknown-operation' }).ok, true);
    for (const fields of [{ code: 'quota' }, { code: 'conflict' }, { detail: 'too big' }, { requestId: '' }]) {
      const frame = { frame: 'error', requestId: 'r1', code: 'payload-too-large', ...fields };
      assert.equal(check(errorSchema, frame).ok, false, JSON.stringify(fields));
    }
  });
});

describe('the checks a request passes (#13, AC1 and AC4)', () => {
  it('passes a request that fits, with its payload as it arrived', () => {
    const checked = readRequest(encode(request('captureToDailyNote', capture)));
    assert.ok(checked.ok);
    assert.equal(checked.ok && checked.operation.entry, COMMANDS.captureToDailyNote);
    assert.deepEqual(checked.ok && checked.payload, capture);
    // A block's own __proto__ key stays, as data, as the kernel keeps it
    const text = `{"frame":"request","requestId":"r1","operation":"createNote","version":1,"deadline":${NOW},"payload":{"type":"createNote","commandId":"c1","noteId":"n1","blocks":[{"id":"b1","__proto__":{"x":1}}]}}`;
    const kept = readRequest(text);
    assert.ok(kept.ok);
    const [block] = /** @type {{blocks: Array<Record<string, unknown>>}} */ (kept.ok && kept.payload).blocks;
    assert.ok(Object.hasOwn(block, '__proto__'));
    assert.equal(Object.getPrototypeOf(block), Object.prototype);
  });

  it('refuses a message that is no text, over 1 MiB, not JSON, too deep, or no frame', () => {
    assert.deepEqual(readFrame(/** @type {any} */ ({ frame: 'request' })), {
      ok: false,
      code: 'invalid-payload',
      issues: [],
    });
    const long = readFrame('x'.repeat(MAX_MESSAGE_BYTES + 1));
    assert.equal(long.ok === false && long.code, 'payload-too-large');
    // Fewer UTF-16 units than the limit, but more bytes once it's UTF-8
    const wide = encode(request('createNote', { padding: '€'.repeat(MAX_MESSAGE_BYTES / 3 + 1) }));
    assert.ok(wide.length < MAX_MESSAGE_BYTES);
    const tooWide = readFrame(wide);
    assert.equal(tooWide.ok === false && tooWide.code, 'payload-too-large');
    const notJson = readFrame('{"frame":');
    assert.equal(notJson.ok === false && notJson.code, 'invalid-payload');
    const deep = readFrame(
      JSON.stringify(request('createNote', JSON.parse('['.repeat(MAX_DEPTH) + ']'.repeat(MAX_DEPTH)))),
    );
    assert.equal(deep.ok === false && deep.code, 'invalid-payload');
    const noFrame = readFrame(JSON.stringify({ kind: 'committed' }));
    assert.equal(noFrame.ok === false && noFrame.code, 'invalid-payload');
  });

  it('refuses an operation the catalog lacks, and a version it no longer serves', () => {
    const unknownOperation = readRequest(encode(request('dropDatabase', {})));
    assert.equal(unknownOperation.ok === false && unknownOperation.code, 'unknown-operation');
    const newer = readRequest(encode(request('captureToDailyNote', capture, { version: 2 })));
    assert.equal(newer.ok === false && newer.code, 'unsupported-version');
    // The version is checked before the size, since a newer version can have a larger limit
    const archive = { type: 'archiveNote', commandId: 'c1', noteId: 'n1', padding: 'x'.repeat(SMALL_MESSAGE_BYTES) };
    const newerAndLarger = readRequest(encode(request('archiveNote', archive, { version: 2 })));
    assert.equal(newerAndLarger.ok === false && newerAndLarger.code, 'unsupported-version');
    const larger = readRequest(encode(request('archiveNote', archive)));
    assert.equal(larger.ok === false && larger.code, 'payload-too-large');
  });

  it("holds a request to its operation's maxBytes before its schema, the limit itself included", () => {
    assert.equal(COMMANDS.archiveNote.maxBytes, SMALL_MESSAGE_BYTES);
    /** @param {number} bytes - what the encoded request comes to */
    const sized = bytes => {
      const payload = { type: 'archiveNote', commandId: 'c1', noteId: 'n1', padding: '' };
      const base = encode(request('archiveNote', payload)).length;
      return encode(request('archiveNote', { ...payload, padding: 'x'.repeat(bytes - base) }));
    };
    assert.equal(sized(SMALL_MESSAGE_BYTES).length, SMALL_MESSAGE_BYTES);
    const over = readRequest(sized(SMALL_MESSAGE_BYTES + 1));
    assert.equal(over.ok === false && over.code, 'payload-too-large');
    // At the limit the size passes, and the junk is a payload its schema refuses
    const at = readRequest(sized(SMALL_MESSAGE_BYTES));
    assert.equal(at.ok === false && at.code, 'invalid-payload');
  });

  it('reads a message of exactly MAX_MESSAGE_BYTES, and none a byte longer', () => {
    /** @param {number} bytes */
    const sized = bytes => {
      const base = encode(request('createNote', { padding: '' })).length;
      return encode(request('createNote', { padding: 'x'.repeat(bytes - base) }));
    };
    const at = readFrame(sized(MAX_MESSAGE_BYTES));
    assert.equal(at.ok && at.bytes, MAX_MESSAGE_BYTES);
    const over = readFrame(sized(MAX_MESSAGE_BYTES + 1));
    assert.equal(over.ok === false && over.code, 'payload-too-large');
  });

  it("says what a payload's schema refused, never the value or a key the sender chose", () => {
    const wrongType = readRequest(
      encode(request('captureToDailyNote', { ...capture, capture: { type: 'text', content: 5 } })),
    );
    assert.deepEqual(wrongType.ok === false && wrongType.issues, [{ type: 'string', path: '/capture/content' }]);
    const extraKey = readRequest(encode(request('captureToDailyNote', { ...capture, 'my secret note title': 'x' })));
    assert.deepEqual(extraKey.ok === false && extraKey.issues, [{ type: 'strict_object', path: '/*' }]);
    const nested = { ...capture, capture: { ...capture.capture, 'another private key': 'y' } };
    const nestedKey = readRequest(encode(request('captureToDailyNote', nested)));
    assert.deepEqual(nestedKey.ok === false && nestedKey.issues, [{ type: 'strict_object', path: '/capture/*' }]);
    const text = JSON.stringify([wrongType, extraKey, nestedKey]);
    for (const secret of ['A quote from the page', 'example.test', 'my secret note title', 'another private key']) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  it("checks an answer against its operation's result schema, as strictly as a request", () => {
    const operation = /** @type {Operation} */ (lookup('captureToDailyNote'));
    const outcome = committed('capture-saved', ['d1'], { revision: 2 });
    assert.deepEqual(checkResult(operation, outcome), { ok: true, value: outcome });
    const leaky = checkResult(operation, { ...outcome, title: 'A quote from the page' });
    assert.deepEqual(leaky, { ok: false, issues: [{ type: 'strict_object', path: '/*' }] });
    const query = /** @type {Operation} */ (lookup('listNotes'));
    assert.equal(checkResult(query, { kind: 'ready', asOf: NOW, data: [{ id: 'n1', name: 'Plan' }] }).ok, true);
    assert.equal(checkResult(query, { kind: 'ready', asOf: NOW, data: [{ name: 'no id' }] }).ok, false);
    // It passes on the answer it was given, not Valibot's copy, which drops a loose object's
    // own __proto__ key, as a request's payload is passed on
    const blocks = /** @type {Operation} */ (lookup('getNoteBlocks'));
    const answer = { kind: 'ready', asOf: NOW, data: [JSON.parse('{"id":"b1","canvasId":"n1","__proto__":{"x":1}}')] };
    const kept = checkResult(blocks, answer);
    assert.equal(kept.ok && kept.value, answer);
    const [block] = /** @type {{data: object[]}} */ (kept.ok && kept.value).data;
    assert.ok(Object.hasOwn(block, '__proto__'));
  });
});
