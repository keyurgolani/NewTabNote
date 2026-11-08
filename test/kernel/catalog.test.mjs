// #12's catalog with #13's fields (#13, "Desired behavior" and AC1): every operation has a
// full entry and a schema module, the two agree, and each schema accepts what the kernel
// takes and answers. Every check covers the worker's part of the catalog too
// (contracts/worker-catalog.js), and the split's own rules are pinned here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';

import * as v from '../../js/lib/valibot/index.mjs';
import { catalogFor, createKernel } from './test-kernel.mjs';
import { decode, encode } from '../../js/kernel/core/contracts/codec.js';
import { COMMANDS, COMMAND_TYPES } from '../../js/kernel/core/contracts/commands.js';
import * as envelope from '../../js/kernel/core/contracts/envelope.js';
import { ENTITY_TYPES } from '../../js/kernel/core/contracts/fields.js';
import * as limits from '../../js/kernel/core/contracts/limits.js';
import { MAX_MESSAGE_BYTES, SMALL_MESSAGE_BYTES } from '../../js/kernel/core/contracts/limits.js';
import { QUERIES, QUERY_TYPES } from '../../js/kernel/core/contracts/queries.js';
import { SYSTEM_QUERIES } from '../../js/kernel/core/contracts/system.js';
import { SURFACES } from '../../js/kernel/core/contracts/surfaces.js';
import {
  WORKER_COMMANDS,
  WORKER_COMMAND_TYPES,
  WORKER_GRANTS,
  WORKER_ONLY_COMMANDS,
  WORKER_ONLY_QUERIES,
  WORKER_QUERIES,
  WORKER_QUERY_TYPES,
} from '../../js/kernel/core/contracts/worker-catalog.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { entityTypesIn, walk } from '../../js/kernel/core/contracts/schema-walk.js';
import { importGraph } from './import-graph.mjs';
import { COMMAND_SAMPLES, senderOf } from './command-samples.mjs';
import { CALLERS, NOW, testClock, testIds } from './support.mjs';
import { JOURNALED_OPERATIONS } from '../../js/kernel/core/messaging/journaled-operations.js';
import { JOURNAL_UPCASTERS } from '../../js/kernel/core/contracts/upcast.js';

/** @typedef {import('../../js/kernel/core/contracts/commands.js').Command} Command */
/** @typedef {import('../../js/kernel/core/contracts/queries.js').Query} Query */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').CommandType} CommandType */
/** @typedef {import('../../js/kernel/core/contracts/queries.js').QueryType} QueryType */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').CommandEntry} CommandEntry */
/** @typedef {import('../../js/kernel/core/contracts/queries.js').QueryEntry} QueryEntry */

/**
 * @template {CommandType} T
 * @typedef {import('../../js/kernel/core/contracts/commands.js').CommandOf<T>} CommandOf
 */

/**
 * @template {QueryType} T
 * @typedef {import('../../js/kernel/core/contracts/queries.js').QueryOf<T>} QueryOf
 */

/** @typedef {{payload: v.GenericSchema, result: v.GenericSchema}} SchemaModule */

const CONTRACTS_DIR = path.join(import.meta.dirname, '..', '..', 'js', 'kernel', 'core', 'contracts');
const CATALOG_URL = new URL('../../js/kernel/core/contracts/commands.js', import.meta.url);

/** @type {{[T in QueryType]: Omit<QueryOf<T>, 'type'>}} */
const QUERY_SAMPLES = {
  listNotes: { view: 'active' },
  getNote: { noteId: 'n1' },
  getNoteBlocks: { noteId: 'n1' },
  getBacklinks: { noteId: 'n1' },
  getNoteList: {},
  getNotesByIds: { noteIds: ['n1', 'n2'] },
  listSearchEntries: {},
  listFolders: {},
  getPreferences: { keys: ['theme', 'sidebarWidth'] },
  getWorkspaceSession: {},
  getPopupInsightsEnabled: {},
  getInsightsPending: { noteId: 'n1' },
  getJobRuns: {},
  listSnapshots: { noteId: 'n1' },
  getSnapshot: { snapshotId: 's1' },
  findDailyNote: { dateStr: '2026-10-19' },
  getWorkspaceData: { keys: ['lastBackupAt', 'aiPromptTemplates'] },
  listThemes: {},
  exportBackup: { backup: true },
  profileHoldsContent: {},
  listLinks: {},
  listVectors: {},
  getSyncData: {},
  findTombstones: { noteIds: ['n1', 'gone'] },
};

/** The coordinator's own queries, which take no field */
const SYSTEM_SAMPLES = { 'system.messagingHealth': {}, 'system.coordinatorHealth': {} };

/**
 * Every entry of every catalog: the kernel's commands and queries, the worker's part's with them
 * as the worker composes them, and the coordinator's own queries (contracts/system.js)
 * @type {Array<[string, CommandEntry | QueryEntry]>}
 */
const ENTRIES = [
  ...Object.entries(WORKER_COMMANDS),
  ...Object.entries(WORKER_QUERIES),
  ...Object.entries(SYSTEM_QUERIES),
];

/** The journaled commands of `commands`, sorted */
const journaledIn = (/** @type {Readonly<Record<string, CommandEntry>>} */ commands) =>
  Object.entries(commands)
    .filter(([, entry]) => entry.journaled)
    .map(([type]) => type)
    .sort();

/** @type {Map<string, SchemaModule>} */
const modules = new Map();
for (const [name, entry] of ENTRIES) {
  modules.set(name, await import(new URL(entry.schema, CATALOG_URL).href));
}

/**
 * @param {string} name
 * @returns {SchemaModule}
 */
const moduleOf = name => /** @type {SchemaModule} */ (modules.get(name));

/** @param {string} name */
const kebab = name => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);

/**
 * A schema as plain data: its type, and what it holds (an object's entries, an optional's or a
 * pipe's schema, an array's item, a union's options, a literal), each action of its pipe with
 * its requirement and metadata. Two schemas that take the same payloads read the same.
 * @param {unknown} schema
 * @returns {unknown}
 */
function shapeOf(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const node = /** @type {Record<string, any>} */ (schema);
  /** @type {Record<string, unknown>} */
  const shape = { type: node.type };
  if (node.entries)
    shape.entries = Object.fromEntries(Object.entries(node.entries).map(([key, entry]) => [key, shapeOf(entry)]));
  if (node.wrapped) shape.wrapped = shapeOf(node.wrapped);
  if (node.item) shape.item = shapeOf(node.item);
  if (Array.isArray(node.options)) shape.options = node.options.map(shapeOf);
  if ('literal' in node) shape.literal = node.literal;
  if (node.key !== undefined) shape.key = node.key;
  if (node.rest) shape.rest = shapeOf(node.rest);
  if (Array.isArray(node.pipe)) {
    shape.pipe = node.pipe.slice(1).map((/** @type {Record<string, any>} */ action) => ({
      type: action.type,
      ...(action.requirement instanceof RegExp ? { requirement: String(action.requirement) } : {}),
      ...(typeof action.requirement === 'number' || typeof action.requirement === 'string'
        ? { requirement: action.requirement }
        : {}),
      ...(action.metadata ? { metadata: action.metadata } : {}),
      ...(action.kind === 'schema' ? { schema: shapeOf(action) } : {}),
    }));
  }
  return shape;
}

/**
 * Each journaled command's payload as a journal entry holds it at a catalog version (#35 slice
 * 3): its fields, `?` after an optional one, and a digest of its whole shape (shapeOf). A
 * journaled command's payload changes only with a new catalog version and a step from the last
 * one in contracts/upcast.js, since an entry an earlier build wrote has to replay: a field added
 * at the same version reads as malformed there, and the entry becomes a conflict record instead.
 * So a new version keeps its last one's line here, adds its own, and comes with its step.
 */
const JOURNALED_PAYLOADS = Object.freeze({
  'createNote@1': {
    fields: ['type', 'commandId', 'noteId', 'name?', 'folderId?', 'blocks?', 'pinned?', 'titleManuallySet?'],
    digest: '01d20e04c3b8f974',
  },
  'saveNoteContent@1': {
    fields: [
      'type',
      'commandId',
      'noteId',
      'blocks',
      'preview?',
      'todoProgress?',
      'name?',
      'titleOrigin?',
      'linkedNames?',
      'expectedRevision?',
      'deriveFromStored?',
      'orders?',
    ],
    digest: '59588fa3aeb5435c',
  },
  'insertBlocks@1': {
    fields: ['type', 'commandId', 'noteId', 'blocks', 'atOrder?', 'expectedRevision?'],
    digest: 'cac770814200ddd4',
  },
  'captureToDailyNote@1': {
    fields: ['type', 'commandId', 'noteId', 'blockId', 'capture', 'at?'],
    digest: '58659b7aefba635a',
  },
});

/**
 * What JOURNALED_PAYLOADS holds of `payload`
 * @param {v.GenericSchema} payload
 */
const journaledPayloadOf = payload => {
  const { entries } = /** @type {{entries: Record<string, {type: string}>}} */ (/** @type {unknown} */ (payload));
  return {
    fields: Object.entries(entries).map(([field, schema]) => (schema.type === 'optional' ? `${field}?` : field)),
    digest: createHash('sha256')
      .update(JSON.stringify(shapeOf(payload)))
      .digest('hex')
      .slice(0, 16),
  };
};

/**
 * `value` without the object fields whose value is undefined, as JSON leaves them out
 * @param {unknown} value
 * @returns {unknown}
 */
function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .map(([key, field]) => [key, withoutUndefined(field)]),
  );
}

/**
 * How many object fields in `value` hold undefined
 * @param {unknown} value
 * @returns {number}
 */
function undefinedFields(value) {
  if (value === null || typeof value !== 'object') return 0;
  return Object.values(value).reduce(
    (sum, field) => sum + (field === undefined ? 1 : undefinedFields(field)),
    /** @type {number} */ (0),
  );
}

describe('the catalog (#13, "Desired behavior")', () => {
  it("gives the ceiling to every command it doesn't size small, the chat's two saves among them, since their message lists are never trimmed (#259)", () => {
    const ceiling = /** @type {Record<string, unknown>} */ (limits).COMMAND_CEILING_BYTES;
    const large = Object.entries(WORKER_COMMANDS).filter(([, entry]) => entry.maxBytes !== SMALL_MESSAGE_BYTES);
    assert.deepEqual(
      large.filter(([, entry]) => entry.maxBytes !== ceiling).map(([name]) => name),
      [],
      'none at another size',
    );
    for (const type of [
      'saveChatHistory',
      'savePromptTemplates',
      'importBackup',
      'createNote',
      'applyCloseDraft',
      'keepJournalEntry',
    ]) {
      assert.ok(
        large.some(([name]) => name === type),
        type,
      );
    }
  });

  it('names every operation once, as a command or as a query', () => {
    assert.deepEqual(
      WORKER_COMMAND_TYPES.filter(type => Object.hasOwn(WORKER_QUERIES, type)),
      [],
    );
    assert.deepEqual(Object.keys(COMMAND_SAMPLES).sort(), [...WORKER_COMMAND_TYPES].sort());
    assert.deepEqual(Object.keys(QUERY_SAMPLES).sort(), [...WORKER_QUERY_TYPES].sort());
    // The coordinator answers its own queries, so none shares a name with the kernel's
    const kernelNames = new Set([...WORKER_COMMAND_TYPES, ...WORKER_QUERY_TYPES]);
    assert.deepEqual(
      Object.keys(SYSTEM_QUERIES).filter(name => kernelNames.has(/** @type {any} */ (name))),
      [],
    );
    assert.deepEqual(Object.keys(SYSTEM_SAMPLES).sort(), Object.keys(SYSTEM_QUERIES).sort());
  });

  it("puts each operation in one part: the shared catalog names no worker-internal, and the worker's own names nothing else", () => {
    assert.deepEqual(
      Object.keys(WORKER_ONLY_COMMANDS).filter(type => Object.hasOwn(COMMANDS, type)),
      [],
    );
    assert.deepEqual(
      Object.keys(WORKER_ONLY_QUERIES).filter(type => Object.hasOwn(QUERIES, type)),
      [],
    );
    // The two parts make the worker's catalog, and nothing else does
    assert.deepEqual([...WORKER_COMMAND_TYPES].sort(), [...COMMAND_TYPES, ...Object.keys(WORKER_ONLY_COMMANDS)].sort());
    assert.deepEqual([...WORKER_QUERY_TYPES].sort(), [...QUERY_TYPES, ...Object.keys(WORKER_ONLY_QUERIES)].sort());
    for (const [type, entry] of [...Object.entries(COMMANDS), ...Object.entries(QUERIES)]) {
      assert.ok(!entry.surfaces.includes('worker-internal'), `${type} is the worker's, so it's in the worker's part`);
    }
    for (const [type, entry] of [...Object.entries(WORKER_ONLY_COMMANDS), ...Object.entries(WORKER_ONLY_QUERIES)]) {
      assert.deepEqual(entry.surfaces, ['worker-internal'], type);
    }
  });

  it("lists every command name the worker's catalog holds in command-names.js, and nothing else, with neither catalog imported (#35 slice 4b-1)", async () => {
    // Imported here, so the file's other cases run on a build without the module
    const { COMMAND_NAMES } = await import('../../js/kernel/core/contracts/command-names.js');
    const listed = new Set(COMMAND_NAMES);
    assert.equal(listed.size, COMMAND_NAMES.length, 'each name once');
    assert.deepEqual(
      WORKER_COMMAND_TYPES.filter(type => !listed.has(type)),
      [],
      "a command the worker's catalog holds is missing from the list",
    );
    assert.deepEqual(
      COMMAND_NAMES.filter(name => !Object.hasOwn(WORKER_COMMANDS, name)),
      [],
      "the list names a command the worker's catalog doesn't hold",
    );
    assert.ok(Object.isFrozen(COMMAND_NAMES));
    // A literal list: what reads it loads no catalog, and no schema
    const graph = [...importGraph(path.join(CONTRACTS_DIR, 'command-names.js'))].map(full =>
      path.relative(CONTRACTS_DIR, full),
    );
    assert.deepEqual(graph, ['command-names.js']);
  });

  it("composes each shared entry as it is, but a grant's, which adds worker-internal and changes nothing else", () => {
    assert.deepEqual(Object.keys(WORKER_GRANTS).sort(), ['createNote', 'insertBlocks', 'runStartupMaintenance']);
    for (const type of COMMAND_TYPES) {
      const shared = COMMANDS[type];
      const composed = WORKER_COMMANDS[type];
      if (!Object.hasOwn(WORKER_GRANTS, type)) {
        assert.equal(composed, shared, type);
        continue;
      }
      const { surfaces, ...rest } = composed;
      const { surfaces: sharedSurfaces, ...sharedRest } = shared;
      assert.deepEqual(rest, sharedRest, `${type}: its version, aggregate, sizes, journaled, deadline and bulk`);
      assert.deepEqual(surfaces, [...sharedSurfaces, 'worker-internal'], type);
      assert.ok(Object.isFrozen(composed) && Object.isFrozen(surfaces), type);
    }
    for (const type of QUERY_TYPES) assert.equal(WORKER_QUERIES[type], QUERIES[type], type);
  });

  it('gives every command a full entry', () => {
    for (const [type, entry] of [...Object.entries(COMMANDS), ...Object.entries(WORKER_COMMANDS)]) {
      assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.surfaces), type);
      assert.ok(Object.isFrozen(entry.entityTypes) && Object.isFrozen(entry.destinations), type);
      assert.deepEqual(
        Object.keys(entry).sort(),
        [
          'aggregate',
          'cancellable',
          'deadlineMs',
          'destinations',
          'entityTypes',
          'idempotency',
          'journaled',
          'kind',
          'maxBytes',
          'schema',
          'surfaces',
          'version',
          ...(entry.bulk ? ['bulk'] : []),
        ].sort(),
        type,
      );
      assert.equal(entry.kind, 'command', type);
      assert.equal(entry.idempotency, 'keyed', type);
      assert.equal(entry.cancellable, 'before-transaction', type);
    }
  });

  it('gives every query a full entry', () => {
    for (const [type, entry] of [...Object.entries(WORKER_QUERIES), ...Object.entries(SYSTEM_QUERIES)]) {
      assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.surfaces), type);
      assert.deepEqual(
        Object.keys(entry).sort(),
        [
          'cancellable',
          'deadlineMs',
          'destinations',
          'entityTypes',
          'idempotency',
          'journaled',
          'kind',
          'maxBytes',
          'schema',
          'surfaces',
          'version',
        ].sort(),
        type,
      );
      assert.equal(entry.kind, 'query', type);
      assert.equal(entry.idempotency, 'none', type);
      assert.equal(entry.cancellable, 'any-time', type);
      assert.equal(entry.journaled, false, type);
    }
  });

  it('holds every entry to the limits: versions from 1, a command small or at the ceiling, the journaled ones at it, a query up to 1 MiB (#259)', () => {
    // Half the largest frame Chrome's port carried in #259's measure, 67,108,864 bytes (the lead's O3)
    const ceiling = /** @type {Record<string, unknown>} */ (limits).COMMAND_CEILING_BYTES;
    assert.equal(ceiling, 33554432, "the ceiling is half the measure's largest frame");
    /** @type {Array<[string, CommandEntry | QueryEntry]>} */
    const entries = ENTRIES;
    for (const [name, entry] of entries) {
      assert.ok(Number.isSafeInteger(entry.version) && entry.version >= 1, name);
      assert.ok(Number.isSafeInteger(entry.maxBytes) && entry.maxBytes > 0, name);
      if (entry.kind === 'command')
        assert.ok(entry.maxBytes === SMALL_MESSAGE_BYTES || entry.maxBytes === ceiling, name);
      else assert.ok(entry.maxBytes <= MAX_MESSAGE_BYTES, name);
      if (entry.journaled) assert.equal(entry.maxBytes, ceiling, name);
      assert.ok(Number.isSafeInteger(entry.deadlineMs) && entry.deadlineMs > 0, name);
      assert.ok(entry.surfaces.length > 0 && entry.surfaces.every(surface => SURFACES.includes(surface)), name);
      assert.ok(
        entry.entityTypes.every(type => ENTITY_TYPES.includes(type)),
        name,
      );
      assert.deepEqual(entry.destinations, [], `${name}: no destinations until #21 adds them`);
    }
    // #35 slice 3 journals content saves, note creation, appends, and captures (the plan's Q5), and
    // nothing else: a lost delete brings a block back and a lost rename keeps the old name, neither
    // an older text over a newer edit. The capture is the worker's, so it's in the worker's part
    assert.deepEqual(journaledIn(WORKER_COMMANDS), [
      'captureToDailyNote',
      'createNote',
      'insertBlocks',
      'saveNoteContent',
    ]);
    assert.deepEqual(journaledIn(COMMANDS), ['createNote', 'insertBlocks', 'saveNoteContent']);
    assert.deepEqual(journaledIn(WORKER_ONLY_COMMANDS), ['captureToDailyNote']);
  });

  it("gives the worker's drain each journaled command it replays as an operation, with its own entry and schemas (#35 slice 3)", () => {
    // An editor's save is the pages' to apply, as a close-time draft by #33's rules (slice 3b)
    assert.deepEqual(
      Object.keys(JOURNALED_OPERATIONS).sort(),
      journaledIn(WORKER_COMMANDS).filter(type => type !== 'saveNoteContent'),
    );
    for (const [type, operation] of Object.entries(JOURNALED_OPERATIONS)) {
      assert.equal(operation.entry, WORKER_COMMANDS[/** @type {CommandType} */ (type)], type);
      assert.equal(operation.payload, moduleOf(type).payload, type);
      assert.equal(operation.result, moduleOf(type).result, type);
    }
    // And the worker may send each, and keep an entry as a conflict record, but not apply a draft
    for (const type of ['createNote', 'insertBlocks', 'captureToDailyNote', 'keepJournalEntry']) {
      assert.ok(WORKER_COMMANDS[/** @type {CommandType} */ (type)].surfaces.includes('worker-internal'), type);
    }
    assert.deepEqual(WORKER_COMMANDS.applyCloseDraft.surfaces, ['newtab', 'popup', 'sidepanel']);
    assert.deepEqual(WORKER_QUERIES.findTombstones.surfaces, ['worker-internal']);
    assert.deepEqual(WORKER_COMMANDS.keepJournalEntry.surfaces, ['worker-internal']);
  });

  it("holds each journaled command's payload as it is at its version, which changes only with a new version and its upcast step (#35 slice 3)", () => {
    const journaled = Object.entries(WORKER_COMMANDS).filter(([, entry]) => entry.journaled);
    assert.deepEqual(
      journaled.map(([type, entry]) => `${type}@${entry.version}`).sort(),
      Object.keys(JOURNALED_PAYLOADS)
        .filter(key => journaled.some(([type, entry]) => key === `${type}@${entry.version}`))
        .sort(),
      'each journaled command has its line at its version',
    );
    for (const [type, entry] of journaled) {
      assert.deepEqual(
        journaledPayloadOf(moduleOf(type).payload),
        JOURNALED_PAYLOADS[/** @type {keyof typeof JOURNALED_PAYLOADS} */ (`${type}@${entry.version}`)],
        `${type}: a journaled payload changes only with a new catalog version and its upcast step`,
      );
      for (let version = 1; version < entry.version; version++) {
        assert.ok(Object.hasOwn(JOURNAL_UPCASTERS[type] || {}, version), `${type}: a step from version ${version}`);
      }
    }
  });

  it("names each operation's own schema module, whose payload is that operation's and nothing more", () => {
    for (const [name, entry] of ENTRIES) {
      assert.equal(entry.schema, `./operations/${kebab(name).replace(/\./g, '-')}.js`, name);
      const { payload, result } = moduleOf(name);
      assert.equal(payload.type, 'strict_object', name);
      assert.equal(typeof result?.['~run'], 'function', name);
      const entries = /** @type {Record<string, v.GenericSchema>} */ (
        /** @type {{entries: object}} */ (/** @type {unknown} */ (payload)).entries
      );
      assert.deepEqual(v.safeParse(entries.type, name).success, true, name);
      assert.deepEqual(v.safeParse(entries.type, `${name}x`).success, false, name);
      assert.equal(Object.hasOwn(entries, 'commandId'), entry.kind === 'command', name);
    }
  });

  it('names every key it accepts: no record, rest entries, map, or set, so no path holds a key the sender chose', () => {
    const undeclared = new Set(['record', 'object_with_rest', 'map', 'set']);
    const schemas = [
      ...[...modules.values()].flatMap(({ payload, result }) => [payload, result]),
      ...Object.values(envelope).filter(value => typeof value === 'object' && value !== null && 'kind' in value),
    ];
    assert.ok(schemas.length > 50);
    for (const schema of schemas) {
      for (const { schema: inner, path: at } of walk(schema)) {
        assert.ok(!undeclared.has(inner.type), `${inner.type} at ${at.join('.')}`);
      }
    }
  });

  it('declares exactly the entity types its payload ids name', () => {
    for (const [name, entry] of ENTRIES) {
      assert.deepEqual([...entry.entityTypes].sort(), entityTypesIn(moduleOf(name).payload), name);
    }
  });

  it('loads no schema: the catalog modules reach Valibot through no static import', () => {
    for (const file of ['commands.js', 'queries.js', 'system.js']) {
      const graph = [...importGraph(path.join(CONTRACTS_DIR, file))].map(full => path.relative(CONTRACTS_DIR, full));
      assert.deepEqual(graph.sort(), [file, 'limits.js'].sort(), file);
    }
    const worker = [...importGraph(path.join(CONTRACTS_DIR, 'worker-catalog.js'))].map(full =>
      path.relative(CONTRACTS_DIR, full),
    );
    assert.deepEqual(worker.sort(), ['commands.js', 'limits.js', 'queries.js', 'worker-catalog.js']);
  });
});

describe('schema modules (#13, AC1)', () => {
  it("accept every sample, and refuse a field the schema doesn't declare or a missing commandId", () => {
    for (const [type, fields] of Object.entries(COMMAND_SAMPLES)) {
      const { payload } = moduleOf(type);
      const command = { ...fields, type, commandId: 'c1' };
      assert.equal(v.safeParse(payload, command).success, true, type);
      assert.equal(v.safeParse(payload, { ...command, extra: 'x' }).success, false, type);
      assert.equal(v.safeParse(payload, { ...fields, type }).success, false, type);
    }
    for (const [type, fields] of [...Object.entries(QUERY_SAMPLES), ...Object.entries(SYSTEM_SAMPLES)]) {
      const { payload } = moduleOf(type);
      assert.equal(v.safeParse(payload, { ...fields, type }).success, true, type);
      assert.equal(v.safeParse(payload, { ...fields, type, extra: 'x' }).success, false, type);
    }
  });

  it('system.messagingHealth answers counters only: no content, no key a sender chose', () => {
    const health = {
      protocol: { major: 1, minor: 0 },
      coordinatorId: 'c1',
      connections: 2,
      handshakes: 3,
      reconnects: 1,
      requests: [{ operation: 'system.messagingHealth', count: 4 }],
      outcomes: [{ code: 'ready', count: 4 }],
      rejections: [{ reason: 'validation', code: 'unknown-operation', count: 1 }],
      latency: [
        { underMs: 10, count: 3 },
        { underMs: null, count: 1 },
      ],
    };
    const { result } = moduleOf('system.messagingHealth');
    assert.equal(v.safeParse(result, { kind: 'ready', asOf: NOW, data: health }).success, true);
    assert.equal(v.safeParse(result, { kind: 'failed', cause: 'coordinator', code: 'unavailable' }).success, true);
    for (const data of [
      { ...health, lastError: 'boom' },
      { ...health, requests: [{ operation: 'Bad Name', count: 1 }] },
      { ...health, rejections: [{ reason: 'storage', code: 'x', count: 1 }] },
      { ...health, latency: [{ underMs: 7, count: 1 }] },
    ]) {
      assert.equal(v.safeParse(result, { kind: 'ready', asOf: NOW, data }).success, false, JSON.stringify(data));
    }
  });

  it('system.coordinatorHealth answers ids, counts, times, and codes only (#35)', () => {
    const health = {
      status: 'degraded',
      reason: 'starting',
      coordinatorId: 'c1',
      startedAt: NOW,
      commands: [{ outcome: 'committed', count: 2 }],
      oldestOrphanedEntryAt: null,
      migration: null,
    };
    const { result } = moduleOf('system.coordinatorHealth');
    assert.equal(v.safeParse(result, { kind: 'ready', asOf: NOW, data: health }).success, true);
    const { reason, ...ready } = health;
    assert.equal(
      v.safeParse(result, { kind: 'ready', asOf: NOW, data: { ...ready, status: 'ready', startedAt: null } }).success,
      true,
    );
    // While it's migrating, whether the run upgrades or an older build's open page holds it (#35 slice 2)
    for (const migration of ['running', 'blocked']) {
      const data = { ...health, reason: 'migrating', migration };
      assert.equal(v.safeParse(result, { kind: 'ready', asOf: NOW, data }).success, true, migration);
    }
    const { migration, ...unsaid } = health;
    for (const data of [
      { ...health, reason: 'Disk full' },
      { ...health, lastError: 'boom' },
      { ...health, commands: [{ outcome: 'saved', count: 1 }] },
      { ...health, status: 'starting' },
      { ...health, oldestOrphanedEntryAt: 'yesterday' },
      { ...health, migration: 'copying 3 of 120 notes' },
      unsaid,
    ]) {
      assert.equal(v.safeParse(result, { kind: 'ready', asOf: NOW, data }).success, false, JSON.stringify(data));
    }
  });

  it("system.coordinatorHealth may name the notes its last drain held back, each by id and why, at most 10 with the total beside them, and an answer without them, as an older worker's, still parses (#35 slice 3b)", () => {
    const health = {
      status: 'ready',
      coordinatorId: 'c1',
      startedAt: NOW,
      commands: [],
      oldestOrphanedEntryAt: NOW,
      migration: null,
    };
    const { result } = moduleOf('system.coordinatorHealth');
    /** @param {unknown} data */
    const parses = data => v.safeParse(result, { kind: 'ready', asOf: NOW, data }).success;
    assert.equal(parses(health), true, "an older worker's answer");
    const notes = Array.from({ length: 10 }, (_, index) => ({ noteId: `n${index}`, code: 'timed-out' }));
    assert.equal(parses({ ...health, held: { total: 1, notes: notes.slice(0, 1) } }), true);
    // Ten at most by name, and the total of every one held beside them
    assert.equal(parses({ ...health, held: { total: 27, notes } }), true);
    for (const held of [
      { total: 11, notes: [...notes, { noteId: 'n10', code: 'timed-out' }] },
      { notes: notes.slice(0, 1) },
      { total: -1, notes: [] },
      { total: 1, notes: [{ noteId: 'n1' }] },
      { total: 1, notes: [{ noteId: 'n1', code: 'Disk full' }] },
      { total: 1, notes: [{ noteId: '', code: 'timed-out' }] },
      // Never what a note holds
      { total: 1, notes: [{ noteId: 'n1', code: 'timed-out', name: 'Call the plumber' }] },
      { total: 1, notes: notes.slice(0, 1), text: 'Call the plumber' },
    ]) {
      assert.equal(parses({ ...health, held }), false, JSON.stringify(held));
    }
  });

  it("system.coordinatorHealth may say which command holds the queue, by its type's name, when its turn began and how many wait behind it, and how many turns the queue cut, and an answer without them, as an older worker's, still parses (#35 slice 4b-1)", () => {
    const health = {
      status: 'ready',
      coordinatorId: 'c1',
      startedAt: NOW,
      commands: [],
      oldestOrphanedEntryAt: null,
      migration: null,
    };
    const { result } = moduleOf('system.coordinatorHealth');
    /** @param {unknown} data */
    const parses = data => v.safeParse(result, { kind: 'ready', asOf: NOW, data }).success;
    assert.equal(parses(health), true, "an older worker's answer");
    const running = { type: 'captureToDailyNote', since: NOW, waiting: 2 };
    assert.equal(parses({ ...health, running }), true);
    assert.equal(parses({ ...health, running: { ...running, type: 'createNote', waiting: 0 } }), true);
    assert.equal(parses({ ...health, cutTurns: 3 }), true);
    assert.equal(parses({ ...health, running, cutTurns: 1 }), true);
    for (const data of [
      { ...health, running: { ...running, type: 'notACommand' } },
      { ...health, running: { ...running, type: 'Call the plumber' } },
      { ...health, running: { type: 'createNote', since: NOW } },
      { ...health, running: { ...running, since: 'just now' } },
      { ...health, running: { ...running, waiting: -1 } },
      // Never what a command carries
      { ...health, running: { ...running, noteId: 'n1' } },
      { ...health, running: { ...running, payload: { name: 'Call the plumber' } } },
      { ...health, cutTurns: -1 },
      { ...health, cutTurns: 1.5 },
    ]) {
      assert.equal(parses(data), false, JSON.stringify(data));
    }
  });

  it('system.coordinatorHealth may say the last stop its last drain made at an entry, by code, with how many drains in a row stopped there, and an answer without it still parses (#35 slice 4b-1, Q6)', () => {
    const health = {
      status: 'ready',
      coordinatorId: 'c1',
      startedAt: NOW,
      commands: [],
      oldestOrphanedEntryAt: null,
      migration: null,
    };
    const { result } = moduleOf('system.coordinatorHealth');
    /** @param {unknown} data */
    const parses = data => v.safeParse(result, { kind: 'ready', asOf: NOW, data }).success;
    assert.equal(parses({ ...health, stuck: { code: 'timed-out', count: 2 } }), true);
    assert.equal(parses({ ...health, stuck: { code: 'quota' } }), true);
    for (const stuck of [
      { count: 2 },
      { code: 'Disk full', count: 1 },
      { code: 'timed-out', count: -1 },
      // Never what an entry holds
      { code: 'timed-out', count: 1, noteId: 'n1' },
      { code: 'timed-out', text: 'Call the plumber' },
    ]) {
      assert.equal(parses({ ...health, stuck }), false, JSON.stringify(stuck));
    }
  });

  it('accept every answer the kernel gives the samples, both ways (#13, AC1)', async () => {
    const adapter = createMemoryAdapter();
    const runtime = { ids: testIds(), clock: testClock() };
    /** @param {import('../../js/kernel/core/ports/policy.js').Caller} caller */
    const kernelFor = caller =>
      createKernel({ adapter, policy: createBaselinePolicy(catalogFor(caller)), caller, ...runtime });
    const kernel = kernelFor(CALLERS.newtab);
    const worker = kernelFor(CALLERS['worker-internal']);
    /** @type {string[]} */
    const kinds = [];
    for (const [type, fields] of Object.entries(COMMAND_SAMPLES)) {
      const outcome = await (senderOf(type) === CALLERS.newtab ? kernel : worker).execute(
        /** @type {import('../../js/kernel/core/contracts/commands.js').Command} */ ({
          ...fields,
          type,
          commandId: `c-${type}`,
        }),
      );
      kinds.push(`${type}:${outcome.kind}`);
      const checked = v.safeParse(moduleOf(type).result, outcome);
      assert.equal(checked.success, true, `${type}: ${JSON.stringify(outcome)}`);
    }
    // The samples commit, so the answers cover more than rejections
    assert.ok(kinds.filter(kind => kind.endsWith(':committed')).length >= 14, kinds.join(', '));
    assert.ok(kinds.includes('runBulkAction:bulk'), kinds.join(', '));
    for (const [type, fields] of Object.entries(QUERY_SAMPLES)) {
      // A query the new tab can't run, such as Popup's own, runs from the first surface that can
      const { surfaces } = WORKER_QUERIES[/** @type {QueryType} */ (type)];
      const reader = surfaces.includes('newtab') ? kernel : kernelFor(CALLERS[surfaces[0]]);
      const state = await reader.query(
        /** @type {import('../../js/kernel/core/contracts/queries.js').Query} */ ({ ...fields, type }),
      );
      // The export, as a file or as sync's object, is the backup tasks', which the memory adapter
      // doesn't run (`backups`)
      const unavailable = (type === 'exportBackup' || type === 'getSyncData') && !adapter.flags.backups;
      assert.ok(
        unavailable ? state.kind === 'failed' : state.kind === 'ready' || state.kind === 'empty',
        `${type}: ${state.kind}`,
      );
      const checked = v.safeParse(moduleOf(type).result, state);
      assert.equal(checked.success, true, `${type}: ${JSON.stringify(state)}`);
    }
  });

  it('encode every answer the kernel gives, from a store holding captures of pages with no URL or title', async () => {
    const adapter = createMemoryAdapter();
    const runtime = { ids: testIds(), clock: testClock() };
    /** @param {import('../../js/kernel/core/ports/policy.js').Caller} caller */
    const kernelFor = caller =>
      createKernel({ adapter, policy: createBaselinePolicy(catalogFor(caller)), caller, ...runtime });
    const kernel = kernelFor(CALLERS.newtab);
    const worker = kernelFor(CALLERS['worker-internal']);
    // 1.4.x's background.js stored a capture of a page with no URL or title as a bookmark with
    // `url` and `title` undefined, and the kernel's own bookmark capture does the same
    const seeded = await kernel.execute({
      type: 'createNote',
      commandId: 'c-seed',
      noteId: 'n-old',
      name: 'Captures',
      blocks: [{ id: 'b-old', type: 'bookmark', content: '', url: undefined, title: undefined, order: NOW }],
    });
    assert.equal(seeded.kind, 'committed');
    const captured = await worker.execute({
      type: 'captureToDailyNote',
      commandId: 'c-capture',
      noteId: 'd-old',
      blockId: 'b-capture',
      capture: { type: 'bookmark' },
    });
    assert.equal(captured.kind, 'committed');
    /** @type {Array<[string, unknown]>} */
    const answers = [];
    for (const [type, fields] of Object.entries(COMMAND_SAMPLES)) {
      const sender = senderOf(type) === CALLERS.newtab ? kernel : worker;
      answers.push([type, await sender.execute(/** @type {Command} */ ({ ...fields, type, commandId: `c-${type}` }))]);
    }
    /** @type {Array<[string, object]>} */
    const queries = [
      ...Object.entries(QUERY_SAMPLES),
      ['getNoteBlocks', { noteId: 'n-old' }],
      ['getNoteBlocks', { noteId: 'd-old' }],
      ['getNote', { noteId: 'n-old' }],
      ['listNotes', { view: 'withArchived' }],
    ];
    for (const [type, fields] of queries) {
      const { surfaces } = WORKER_QUERIES[/** @type {QueryType} */ (type)];
      const reader = surfaces.includes('newtab') ? kernel : kernelFor(CALLERS[surfaces[0]]);
      answers.push([type, await reader.query(/** @type {Query} */ ({ ...fields, type }))]);
    }
    let seen = 0;
    for (const [type, answer] of answers) {
      seen += undefinedFields(answer);
      const back = decode(encode(answer));
      assert.deepEqual(back, withoutUndefined(answer), type);
      assert.equal(v.safeParse(moduleOf(type).result, back).success, true, type);
    }
    // Both captures' url and title came back undefined, and the codec left them out
    assert.ok(seen >= 4, String(seen));
  });
});
