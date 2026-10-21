// #13's schema lint (AC5, "Security and privacy"). It walks every contract schema and refuses:
// - a field named for a credential (authorization, a password, a secret, an API key, a
//   cookie, a token, or headers) anywhere, unless it's a vault reference or its operation
//   carriesSecret, both of which #21 adds;
// - a generic operation, which is what a payload or frame field is when it's a URL outside
//   content, a key the caller picks, a store or IndexedDB passthrough, an untyped value or a
//   loose object outside content, or a string outside content with no bound;
// - content in a frame or an outcome, which carry ids, codes, and times only, and a field
//   named for what the user wrote, or a URL, outside content anywhere;
// - a schema whose output differs from what it accepts: a transform, a default, a fallback,
//   or an object or tuple that drops what it doesn't declare. checkRequest and checkResult
//   (contracts/validate.js) pass on the value that arrived, not Valibot's output, which is
//   only safe while the two are the same.
// Content is a field marked with content() (contracts/fields.js): note text, titles,
// previews, insights, and a captured page's URL and title travel there and nowhere else.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as v from '../../js/lib/valibot/index.mjs';
import { COMMANDS } from '../../js/kernel/core/contracts/commands.js';
import * as entities from '../../js/kernel/core/contracts/entities.js';
import * as envelope from '../../js/kernel/core/contracts/envelope.js';
import { content, count, entityId, id } from '../../js/kernel/core/contracts/fields.js';
import { commandPayload } from '../../js/kernel/core/contracts/operation.js';
import { bulkResultSchema, failedSchema, outcomeSchema } from '../../js/kernel/core/contracts/outcome-schemas.js';
import { QUERIES } from '../../js/kernel/core/contracts/queries.js';
import * as settings from '../../js/kernel/core/contracts/settings.js';
import { isContent, walk } from './schema-walk.mjs';

/** @typedef {import('./schema-walk.mjs').Schema} Schema */
/** @typedef {import('./schema-walk.mjs').Visit} Visit */

/**
 * - payload: a command's or query's payload, held to every rule
 * - frame: an envelope frame, held to every rule, and content-free
 * - outcome: what a command answers, content-free
 * - result: a query's answer or a stored record, which carry content in their records
 * @typedef {'payload' | 'frame' | 'outcome' | 'result'} Role
 */

/** @typedef {{rule: string, path: string}} Violation */

/**
 * The words in a field's name: `accessToken` and `access_token` are both `access`, `token`
 * @param {string} name
 * @returns {string[]}
 */
const words = name =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const CREDENTIAL_WORDS = new Set([
  'auth',
  'authorization',
  'bearer',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'passphrase',
  'passwd',
  'password',
  'secret',
  'secrets',
]);

/**
 * A credential's name: one of CREDENTIAL_WORDS anywhere, an API key, or a name ending in
 * token or headers. `maxTokens` and `tokenCount` aren't credentials.
 * @param {string[]} name
 */
const isCredential = name =>
  name.some(word => CREDENTIAL_WORDS.has(word) || word === 'apikey') ||
  name.some((word, index) => word === 'api' && name[index + 1] === 'key') ||
  ['token', 'header', 'headers'].includes(name[name.length - 1]);

const URL_WORDS = new Set(['url', 'urls', 'uri', 'href', 'endpoint']);

/** @param {string[]} name */
const isUrlName = name => URL_WORDS.has(name[name.length - 1]);

/**
 * The last word of a field that holds what the user wrote: a note's or folder's name, a
 * title, a preview, content, text, insights, or a capture's source. `contentHash` and
 * `lastTitleContentHash` hold hashes. A URL is the URL rule's to judge.
 */
const CONTENT_WORDS = new Set([
  'name',
  'names',
  'title',
  'titles',
  'preview',
  'content',
  'contents',
  'text',
  'body',
  'insights',
  'source',
  'query',
  'prompt',
  'quote',
  'selection',
  'snippet',
  'summary',
  'description',
  'caption',
  'comment',
  'comments',
]);

/** @param {string[]} name */
const isContentName = name => CONTENT_WORDS.has(name[name.length - 1]);

/**
 * Schemas whose output drops what they don't declare: an object drops unknown keys. A tuple
 * drops items past its own too, but walk() refuses every tuple before any rule runs.
 */
const DROPPING = new Set(['object']);

/**
 * Transformations that change only a value's type, never the value: a brand and readonly
 */
const TYPE_ONLY = new Set(['brand', 'readonly']);

const STORAGE_WORDS = new Set(['store', 'stores', 'indexeddb', 'idb', 'db', 'database', 'transaction', 'sql']);

/**
 * A store's or IndexedDB's name: `storeName`, `objectStore`, `indexedDB`, `transaction`.
 * `restoreNote` isn't one.
 * @param {string[]} name
 */
const isStorageName = name => name.some(word => STORAGE_WORDS.has(word)) || STORAGE_WORDS.has(name.join(''));

/**
 * Every action in `schema`'s pipe, its base's first
 * @param {Schema} schema
 * @returns {Schema[]}
 */
function pipeActions(schema) {
  if (!schema.pipe) return [];
  const [base, ...actions] = schema.pipe;
  return [...(base === schema ? [] : pipeActions(base)), ...actions];
}

/**
 * `schema` without the optional, nullable, and array wrappers around it
 * @param {Schema} schema
 * @returns {Schema}
 */
function unwrapped(schema) {
  let current = schema;
  while (current.wrapped || (current.type === 'array' && current.item)) {
    current = /** @type {Schema} */ (current.wrapped || current.item);
  }
  return current;
}

/** A string's bound: its length, a pattern, or a picklist */
const BOUNDS = new Set(['max_length', 'length', 'regex', 'max_bytes', 'max_graphemes']);

/**
 * What the lint finds in `schema`
 * @param {unknown} root
 * @param {{role: Role, carriesSecret?: boolean, checkedElsewhere?: readonly unknown[]}} options
 *   `checkedElsewhere` names schemas inside `root` another schema checks, such as a request
 *   frame's payload, which the operation's own payload schema checks
 * @returns {Violation[]}
 */
export function lint(root, { role, carriesSecret = false, checkedElsewhere = [] }) {
  /** @type {Violation[]} */
  const found = [];
  const strict = role === 'payload' || role === 'frame';
  for (const visit of walk(root)) {
    const { schema, path } = visit;
    const at = path.join('.') || '(root)';
    // A field's name is judged where its schema is unwrapped: an optional or nullable's
    // wrapped schema comes next at the same path, with any content() mark on it
    const named = path.length > 0 && path[path.length - 1] !== '[]' && !schema.wrapped;
    const field = named ? words(path[path.length - 1]) : [];
    const contentHere = isContent(visit);
    const vaultRef = visit.metadata.some(item => item.vaultRef === true);
    /** @param {string} rule */
    const add = rule => found.push({ rule, path: at });
    const credential = field.length > 0 && isCredential(field);
    const storage = field.length > 0 && isStorageName(field);
    if (credential && !vaultRef && !carriesSecret) add('credential');
    if (storage) add('storage-passthrough');
    if ((role === 'frame' || role === 'outcome') && contentHere) add('content-in-' + role);
    // What arrived is what passes on, so a schema's output must be what it accepted, content
    // included: no transform, default, or fallback, and nothing it doesn't declare dropped
    if (pipeActions(schema).some(action => action.kind === 'transformation' && !TYPE_ONLY.has(action.type))) {
      add('transform');
    }
    if (/** @type {{default?: unknown}} */ (schema).default !== undefined) add('default');
    if ('fallback' in schema) add('fallback');
    if (DROPPING.has(schema.type)) add('drops-undeclared');
    if (contentHere || checkedElsewhere.includes(schema)) continue;
    // What the user wrote, and a URL, travel only in content, whatever the schema's role. A
    // store's name is the storage rule's to judge.
    if (field.length > 0 && isContentName(field) && !storage) add('content-unmarked');
    if (field.length > 0 && isUrlName(field)) add('url-outside-content');
    if (pipeActions(schema).some(action => action.type === 'url')) add('url-outside-content');
    if (!strict) continue;
    // A key a caller sends names one of a closed list, never a store's or a setting's key of
    // its own choosing. A credential's name is the credential rule's to judge, and an answer's
    // messageKey is no key a caller picks.
    if (role === 'payload' && !credential && ['key', 'keys'].includes(field[field.length - 1])) {
      if (!['picklist', 'literal', 'enum'].includes(unwrapped(schema).type)) add('open-key');
    }
    if (schema.type === 'unknown' || schema.type === 'any') add('untyped');
    if (schema.type === 'loose_object' || schema.type === 'loose_tuple') add('loose-object');
    if (schema.type === 'string' && !pipeActions(schema).some(action => BOUNDS.has(action.type))) {
      add('unbounded-string');
    }
  }
  // A wrapper and what it wraps can both trip one rule at one path
  return found.filter(
    (violation, index) =>
      found.findIndex(other => other.rule === violation.rule && other.path === violation.path) === index,
  );
}

const CATALOG_URL = new URL('../../js/kernel/core/contracts/commands.js', import.meta.url);

/** @type {Array<{name: string, entry: Record<string, unknown>, payload: unknown, result: unknown}>} */
const operations = [];
for (const [name, entry] of [...Object.entries(COMMANDS), ...Object.entries(QUERIES)]) {
  const { payload, result } = await import(new URL(entry.schema, CATALOG_URL).href);
  operations.push({ name, entry, payload, result });
}

/** Every Valibot schema a module exports */
const schemasIn = (/** @type {Record<string, unknown>} */ module) =>
  Object.entries(module).filter(
    ([, value]) => typeof value === 'object' && value !== null && /** @type {any} */ (value).kind === 'schema',
  );

/**
 * Where `schema` marks content: each path a content() mark starts at, sorted
 * @param {unknown} schema
 * @returns {string[]}
 */
function contentPaths(schema) {
  const paths = walk(schema)
    .filter(isContent)
    .map(visit => visit.path);
  const starts = paths.filter(
    path => !paths.some(other => other.length < path.length && other.every((key, index) => key === path[index])),
  );
  return [...new Set(starts.map(path => path.join('.') || '(root)'))].sort();
}

describe('the contract schema lint (#13, AC5)', () => {
  it('passes every operation payload', () => {
    assert.equal(operations.length, Object.keys(COMMANDS).length + Object.keys(QUERIES).length);
    for (const { name, entry, payload } of operations) {
      assert.deepEqual(lint(payload, { role: 'payload', carriesSecret: entry.carriesSecret === true }), [], name);
    }
  });

  it('passes every frame, with only its payload and result left to the operation schemas', () => {
    const checkedElsewhere = [envelope.requestSchema.entries.payload, envelope.responseSchema.entries.result];
    const frames = schemasIn(envelope);
    assert.ok(frames.length >= 6);
    for (const [name, schema] of frames) assert.deepEqual(lint(schema, { role: 'frame', checkedElsewhere }), [], name);
  });

  it('passes every answer and stored record, and finds no content in an outcome', () => {
    for (const [name, schema] of /** @type {Array<[string, unknown]>} */ ([
      ['outcomeSchema', outcomeSchema],
      ['bulkResultSchema', bulkResultSchema],
      ['failedSchema', failedSchema],
    ])) {
      assert.deepEqual(lint(schema, { role: 'outcome' }), [], name);
    }
    for (const { name, result } of operations) assert.deepEqual(lint(result, { role: 'result' }), [], name);
    for (const [name, schema] of [...schemasIn(entities), ...schemasIn(settings)]) {
      assert.deepEqual(lint(schema, { role: 'result' }), [], name);
    }
  });

  it('marks content exactly where what the user wrote travels, so a mark removed or added shows', () => {
    const marked = Object.fromEntries(
      [
        ...operations.map(({ name, payload }) => /** @type {[string, unknown]} */ ([name, payload])),
        ...schemasIn(entities),
        ...schemasIn(settings),
      ]
        .map(([name, schema]) => [name, contentPaths(schema)])
        .filter(([, paths]) => paths.length > 0),
    );
    assert.deepEqual(marked, {
      createNote: ['blocks.[]', 'name'],
      renameNote: ['name'],
      saveNoteContent: ['blocks.[]', 'preview'],
      applyDerivedTitle: ['name'],
      attachInsights: ['insights'],
      captureToDailyNote: ['capture.content', 'capture.source', 'capture.title', 'capture.url'],
      createFolder: ['name'],
      saveWorkspaceSession: ['session.openTabs.[]'],
      // A whole block is content, since any of its fields can hold what the user wrote
      blockInput: ['(root)'],
      blockRecord: ['(root)'],
      changeRecord: ['ops'],
      folderRecord: ['name'],
      noteRecord: ['insights', 'name', 'preview'],
      workspaceSession: ['openTabs.[]'],
    });
  });

  it('refuses a field named for a credential, and leaves one that only sounds like it', () => {
    const bounded = v.pipe(v.string(), v.maxLength(64));
    for (const name of [
      'apiKey',
      'api_key',
      'apikey',
      'accessToken',
      'token',
      'authorization',
      'auth',
      'password',
      'clientSecret',
      'sessionCookie',
      'headers',
      'authHeader',
      'credentials',
    ]) {
      const payload = commandPayload('example', { [name]: bounded });
      assert.deepEqual(lint(payload, { role: 'payload' }), [{ rule: 'credential', path: name }], name);
    }
    for (const name of ['maxTokens', 'tokenCount', 'author', 'keyboardLayout', 'secretary']) {
      assert.deepEqual(lint(commandPayload('example', { [name]: count }), { role: 'payload' }), [], name);
    }
    // A credential is a credential in an answer or a record too
    assert.deepEqual(lint(v.strictObject({ token: id }), { role: 'result' }), [{ rule: 'credential', path: 'token' }]);
  });

  it("lets #21's vault references and carriesSecret operations through", () => {
    const vaultRef = v.pipe(id, v.metadata({ vaultRef: true }));
    assert.deepEqual(lint(commandPayload('example', { apiKey: vaultRef }), { role: 'payload' }), []);
    const secret = commandPayload('example', { password: v.pipe(v.string(), v.maxLength(64)) });
    assert.deepEqual(lint(secret, { role: 'payload', carriesSecret: true }), []);
  });

  it('refuses a URL outside content, and takes a captured page URL marked content', () => {
    const bounded = v.pipe(v.string(), v.maxLength(2048));
    for (const [name, schema, path] of /** @type {const} */ ([
      ['a url field', { url: bounded }, 'url'],
      ['an endpoint', { endpoint: bounded }, 'endpoint'],
      ['a url check on any field', { target: v.pipe(v.string(), v.url(), v.maxLength(2048)) }, 'target'],
      ['a list of urls', { pageUrls: v.array(bounded) }, 'pageUrls'],
    ])) {
      assert.deepEqual(
        lint(commandPayload('example', schema), { role: 'payload' }),
        [{ rule: 'url-outside-content', path }],
        name,
      );
    }
    assert.deepEqual(
      lint(commandPayload('example', { url: content(v.pipe(v.string(), v.url())) }), { role: 'payload' }),
      [],
    );
  });

  it('refuses a key the caller picks, a store, and IndexedDB, and takes a closed list of keys', () => {
    const bounded = v.pipe(v.string(), v.maxLength(64));
    assert.deepEqual(lint(commandPayload('example', { key: bounded }), { role: 'payload' }), [
      { rule: 'open-key', path: 'key' },
    ]);
    assert.deepEqual(lint(commandPayload('example', { settingKey: bounded }), { role: 'payload' }), [
      { rule: 'open-key', path: 'settingKey' },
    ]);
    assert.deepEqual(
      lint(commandPayload('example', { keys: v.optional(v.array(v.picklist(['theme']))) }), { role: 'payload' }),
      [],
    );
    for (const name of ['storeName', 'objectStore', 'indexedDB', 'transaction', 'targetStore', 'database']) {
      const found = lint(commandPayload('example', { [name]: v.picklist(['notes']) }), { role: 'payload' });
      assert.deepEqual(found, [{ rule: 'storage-passthrough', path: name }], name);
    }
  });

  it('refuses an untyped value, a loose object, and a string with no bound outside content', () => {
    assert.deepEqual(lint(commandPayload('example', { data: v.unknown() }), { role: 'payload' }), [
      { rule: 'untyped', path: 'data' },
    ]);
    assert.deepEqual(lint(commandPayload('example', { data: v.any() }), { role: 'payload' }), [
      { rule: 'untyped', path: 'data' },
    ]);
    assert.deepEqual(
      lint(commandPayload('example', { options: v.looseObject({ size: count }) }), { role: 'payload' }),
      [{ rule: 'loose-object', path: 'options' }],
    );
    assert.deepEqual(lint(commandPayload('example', { label: v.optional(v.string()) }), { role: 'payload' }), [
      { rule: 'unbounded-string', path: 'label' },
    ]);
    // In a content field each is fine, as a block or the insights are
    for (const schema of [v.unknown(), v.looseObject({ id: entityId('block') }), v.string()]) {
      assert.deepEqual(lint(commandPayload('example', { body: content(schema) }), { role: 'payload' }), []);
    }
    // A frame is held to the same rules
    assert.deepEqual(lint(v.strictObject({ frame: v.literal('hint'), note: v.string() }), { role: 'frame' }), [
      { rule: 'unbounded-string', path: 'note' },
    ]);
  });

  it('refuses a schema whose output differs from what it accepted, in content too, since what arrived passes on', () => {
    const bounded = v.pipe(v.string(), v.maxLength(64));
    for (const [name, fields, rule, path] of /** @type {const} */ ([
      ['a trim in content', { name: content(v.pipe(v.string(), v.trim())) }, 'transform', 'name'],
      ['a transform', { size: v.pipe(bounded, v.transform(Number)) }, 'transform', 'size'],
      ['a default', { view: v.optional(v.picklist(['active', 'archived']), 'active') }, 'default', 'view'],
      ['a nullable default', { parentId: v.nullable(entityId('folder'), 'f1') }, 'default', 'parentId'],
      ['a fallback', { view: v.fallback(v.picklist(['active']), 'active') }, 'fallback', 'view'],
      ['an object', { options: v.object({ size: count }) }, 'drops-undeclared', 'options'],
    ])) {
      assert.deepEqual(lint(commandPayload('example', fields), { role: 'payload' }), [{ rule, path }], name);
    }
    // walk() refuses a tuple outright, since it doesn't follow a tuple's items
    assert.throws(
      () => lint(commandPayload('example', { range: v.tuple([count, count]) }), { role: 'payload' }),
      /walk\(\)/,
    );
    // An answer or a record is held to the same
    const record = v.looseObject({ id: entityId('note'), name: v.optional(content(v.string()), '') });
    assert.deepEqual(lint(record, { role: 'result' }), [{ rule: 'default', path: 'name' }]);
    // A brand or readonly changes only the type
    const branded = { noteId: v.pipe(entityId('note'), v.brand('NoteId')), ids: v.pipe(v.array(id), v.readonly()) };
    assert.deepEqual(lint(commandPayload('example', branded), { role: 'payload' }), []);
  });

  it('refuses what the user wrote outside content, in a payload, a frame, an answer, or a record', () => {
    const bounded = v.pipe(v.string(), v.maxLength(256));
    for (const name of ['name', 'title', 'pageTitle', 'preview', 'content', 'previewText', 'insights', 'source']) {
      const found = lint(commandPayload('example', { [name]: v.optional(bounded) }), { role: 'payload' });
      assert.deepEqual(found, [{ rule: 'content-unmarked', path: name }], name);
    }
    assert.deepEqual(lint(v.strictObject({ frame: v.literal('hint'), title: bounded }), { role: 'frame' }), [
      { rule: 'content-unmarked', path: 'title' },
    ]);
    const note = v.looseObject({
      id: entityId('note'),
      name: v.optional(v.string()),
      sourceUrl: v.optional(v.string()),
    });
    assert.deepEqual(lint(note, { role: 'result' }), [
      { rule: 'content-unmarked', path: 'name' },
      { rule: 'url-outside-content', path: 'sourceUrl' },
    ]);
    // Marked, or inside what's marked, it's content, and a hash of content isn't
    const marked = v.looseObject({ id: entityId('note'), name: v.optional(content(v.string())) });
    assert.deepEqual(lint(marked, { role: 'result' }), []);
    assert.deepEqual(
      lint(content(v.looseObject({ id: entityId('block'), title: v.string() })), { role: 'result' }),
      [],
    );
    const hashes = {
      contentHash: v.pipe(v.string(), v.maxLength(128)),
      lastTitleContentHash: v.pipe(v.string(), v.maxLength(128)),
    };
    assert.deepEqual(lint(commandPayload('example', hashes), { role: 'payload' }), []);
  });

  it('refuses content in a frame or an outcome', () => {
    const frame = v.strictObject({ frame: v.literal('hint'), title: content(v.string()) });
    assert.deepEqual(lint(frame, { role: 'frame' }), [{ rule: 'content-in-frame', path: 'title' }]);
    const outcome = v.strictObject({ kind: v.literal('committed'), preview: content(v.string()) });
    assert.deepEqual(lint(outcome, { role: 'outcome' }), [{ rule: 'content-in-outcome', path: 'preview' }]);
  });
});
