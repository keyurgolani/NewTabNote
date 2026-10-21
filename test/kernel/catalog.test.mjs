// #12's catalog with #13's fields (#13, "Desired behavior" and AC1): every operation has a
// full entry and a schema module, the two agree, and each schema accepts what the kernel
// takes and answers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as v from '../../js/lib/valibot/index.mjs';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { decode, encode } from '../../js/kernel/core/contracts/codec.js';
import { COMMANDS, COMMAND_TYPES } from '../../js/kernel/core/contracts/commands.js';
import * as envelope from '../../js/kernel/core/contracts/envelope.js';
import { ENTITY_TYPES } from '../../js/kernel/core/contracts/fields.js';
import { MAX_MESSAGE_BYTES } from '../../js/kernel/core/contracts/limits.js';
import { QUERIES, QUERY_TYPES } from '../../js/kernel/core/contracts/queries.js';
import { SYSTEM_QUERIES } from '../../js/kernel/core/contracts/system.js';
import { SURFACES } from '../../js/kernel/core/contracts/surfaces.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { entityTypesIn, walk } from '../../js/kernel/core/contracts/schema-walk.js';
import { CALLERS, NOW, testClock, testIds } from './support.mjs';

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

/**
 * A payload for every command, in an order the kernel commits them in, typed as the command
 * it is, so each schema's type and its runtime check are held to the same samples
 * @type {{[T in CommandType]: Omit<CommandOf<T>, 'type' | 'commandId'>}}
 */
const COMMAND_SAMPLES = {
  runStartupMaintenance: {},
  createFolder: { folderId: 'f0', name: 'Work', parentId: null },
  createNote: { noteId: 'n1', name: 'Plan', folderId: 'f0', blocks: [{ id: 'b1', type: 'text', content: 'Line' }] },
  renameNote: { noteId: 'n1', name: 'Plan 2', origin: 'typed' },
  setPinned: { noteId: 'n1', pinned: true },
  saveNoteContent: {
    noteId: 'n1',
    blocks: [{ id: 'b1', type: 'text', content: 'Line', order: 0 }],
    preview: 'Line',
    todoProgress: { completed: 0, total: 1 },
    name: 'Plan 3',
    linkedNames: ['Plan 3', 'Elsewhere'],
    expectedRevision: 1,
  },
  deleteBlocks: { noteId: 'n1', blockIds: ['b1', 'never-saved'] },
  applyDerivedTitle: { noteId: 'n1', name: 'Derived', contentHash: 'h1' },
  attachInsights: { noteId: 'n1', insights: { todos: ['Call'] }, contentHash: 'h1' },
  captureToDailyNote: {
    noteId: 'd1',
    blockId: 'b9',
    capture: { type: 'text', content: 'Quote', source: 'https://example.test/' },
  },
  archiveNote: { noteId: 'n1' },
  unarchiveNote: { noteId: 'n1' },
  runBulkAction: { action: 'trash', noteIds: ['n1', 'gone'] },
  restoreNote: { noteId: 'n1' },
  trashNote: { noteId: 'd1' },
  moveFolder: { folderId: 'f0', parentId: null },
  setPreferences: { values: { theme: 'dark', sidebarWidth: 300, dailyNoteTemplate: '' } },
  saveWorkspaceSession: { session: { openTabs: [{ noteId: 'n1', title: 'Plan' }], activeTabIndex: 0 } },
};

/** @type {{[T in QueryType]: Omit<QueryOf<T>, 'type'>}} */
const QUERY_SAMPLES = {
  listNotes: { view: 'active' },
  getNote: { noteId: 'n1' },
  getNoteBlocks: { noteId: 'n1' },
  getBacklinks: { noteId: 'n1' },
  listFolders: {},
  getPreferences: { keys: ['theme', 'sidebarWidth'] },
  getWorkspaceSession: {},
  getPopupInsightsEnabled: {},
};

/** The coordinator's own queries, which take no field */
const SYSTEM_SAMPLES = { 'system.messagingHealth': {} };

/**
 * Every entry of every catalog: the kernel's commands and queries, and the coordinator's own
 * queries (contracts/system.js)
 * @type {Array<[string, CommandEntry | QueryEntry]>}
 */
const ENTRIES = [...Object.entries(COMMANDS), ...Object.entries(QUERIES), ...Object.entries(SYSTEM_QUERIES)];

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

/**
 * The relative modules `file` imports statically, as paths
 * @param {string} file
 * @returns {string[]}
 */
function staticImports(file) {
  const text = fs.readFileSync(file, 'utf8');
  const specifiers = [...text.matchAll(/^(?:import|export)\s[^;]*?from\s+'([^']+)'|^import\s+'([^']+)'/gm)].map(
    match => match[1] ?? match[2],
  );
  return specifiers.map(specifier => path.resolve(path.dirname(file), specifier));
}

/**
 * Every module `file` reaches through static imports, `file` included
 * @param {string} file
 * @returns {Set<string>}
 */
function importGraph(file) {
  const seen = new Set([file]);
  const pending = [file];
  while (pending.length > 0) {
    for (const next of staticImports(/** @type {string} */ (pending.pop()))) {
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }
  return seen;
}

describe('the catalog (#13, "Desired behavior")', () => {
  it('names every operation once, as a command or as a query', () => {
    assert.deepEqual(
      COMMAND_TYPES.filter(type => Object.hasOwn(QUERIES, type)),
      [],
    );
    assert.deepEqual(Object.keys(COMMAND_SAMPLES).sort(), [...COMMAND_TYPES].sort());
    assert.deepEqual(Object.keys(QUERY_SAMPLES).sort(), [...QUERY_TYPES].sort());
    // The coordinator answers its own queries, so none shares a name with the kernel's
    const kernelNames = new Set([...COMMAND_TYPES, ...QUERY_TYPES]);
    assert.deepEqual(
      Object.keys(SYSTEM_QUERIES).filter(name => kernelNames.has(/** @type {any} */ (name))),
      [],
    );
    assert.deepEqual(Object.keys(SYSTEM_SAMPLES).sort(), Object.keys(SYSTEM_QUERIES).sort());
  });

  it('gives every command a full entry', () => {
    for (const [type, entry] of Object.entries(COMMANDS)) {
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
    for (const [type, entry] of [...Object.entries(QUERIES), ...Object.entries(SYSTEM_QUERIES)]) {
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

  it('holds every entry to the limits: versions from 1, sizes up to 1 MiB, journaled ones exactly that', () => {
    /** @type {Array<[string, CommandEntry | QueryEntry]>} */
    const entries = ENTRIES;
    for (const [name, entry] of entries) {
      assert.ok(Number.isSafeInteger(entry.version) && entry.version >= 1, name);
      assert.ok(Number.isSafeInteger(entry.maxBytes) && entry.maxBytes > 0, name);
      assert.ok(entry.maxBytes <= MAX_MESSAGE_BYTES, name);
      if (entry.journaled) assert.equal(entry.maxBytes, MAX_MESSAGE_BYTES, name);
      assert.ok(Number.isSafeInteger(entry.deadlineMs) && entry.deadlineMs > 0, name);
      assert.ok(entry.surfaces.length > 0 && entry.surfaces.every(surface => SURFACES.includes(surface)), name);
      assert.ok(
        entry.entityTypes.every(type => ENTITY_TYPES.includes(type)),
        name,
      );
      assert.deepEqual(entry.destinations, [], `${name}: no destinations until #21 adds them`);
    }
    // Nothing is journaled until #35 sets it on its content saves, note creation, appends, and captures
    assert.deepEqual(
      Object.entries(COMMANDS).filter(([, entry]) => entry.journaled),
      [],
    );
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

  it('accept every answer the kernel gives the samples, both ways (#13, AC1)', async () => {
    const adapter = createMemoryAdapter();
    const runtime = { ids: testIds(), clock: testClock() };
    /** @param {import('../../js/kernel/core/ports/policy.js').Caller} caller */
    const kernelFor = caller => createKernel({ adapter, policy: createBaselinePolicy(), caller, ...runtime });
    const kernel = kernelFor(CALLERS.newtab);
    /** @type {string[]} */
    const kinds = [];
    for (const [type, fields] of Object.entries(COMMAND_SAMPLES)) {
      const outcome = await kernel.execute(
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
      const { surfaces } = QUERIES[/** @type {QueryType} */ (type)];
      const reader = surfaces.includes('newtab') ? kernel : kernelFor(CALLERS[surfaces[0]]);
      const state = await reader.query(
        /** @type {import('../../js/kernel/core/contracts/queries.js').Query} */ ({ ...fields, type }),
      );
      assert.ok(state.kind === 'ready' || state.kind === 'empty', `${type}: ${state.kind}`);
      const checked = v.safeParse(moduleOf(type).result, state);
      assert.equal(checked.success, true, `${type}: ${JSON.stringify(state)}`);
    }
  });

  it('encode every answer the kernel gives, from a store holding captures of pages with no URL or title', async () => {
    const kernel = createKernel({
      adapter: createMemoryAdapter(),
      policy: createBaselinePolicy(),
      caller: CALLERS.newtab,
      ids: testIds(),
      clock: testClock(),
    });
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
    const captured = await kernel.execute({
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
      answers.push([type, await kernel.execute(/** @type {Command} */ ({ ...fields, type, commandId: `c-${type}` }))]);
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
      answers.push([type, await kernel.query(/** @type {Query} */ ({ ...fields, type }))]);
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
