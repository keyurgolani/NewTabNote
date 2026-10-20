// #12's catalog with #13's fields (#13, "Desired behavior" and AC1): every operation has a
// full entry and a schema module, the two agree, and each schema accepts what the kernel
// takes and answers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as v from '../../js/lib/valibot/index.mjs';
import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { COMMANDS, COMMAND_TYPES } from '../../js/kernel/core/contracts/commands.js';
import { ENTITY_TYPES } from '../../js/kernel/core/contracts/fields.js';
import { MAX_MESSAGE_BYTES } from '../../js/kernel/core/contracts/limits.js';
import { QUERIES, QUERY_TYPES } from '../../js/kernel/core/contracts/queries.js';
import { SURFACES } from '../../js/kernel/core/contracts/surfaces.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { entityTypesIn, walk } from './schema-walk.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';

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
    expectedRevision: 1,
  },
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
  listFolders: {},
  getPreferences: { keys: ['theme', 'sidebarWidth'] },
  getWorkspaceSession: {},
};

/** @type {Map<string, SchemaModule>} */
const modules = new Map();
for (const [name, entry] of [...Object.entries(COMMANDS), ...Object.entries(QUERIES)]) {
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
    for (const [type, entry] of Object.entries(QUERIES)) {
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
    const entries = [...Object.entries(COMMANDS), ...Object.entries(QUERIES)];
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
    for (const [name, entry] of [...Object.entries(COMMANDS), ...Object.entries(QUERIES)]) {
      assert.equal(entry.schema, `./operations/${kebab(name)}.js`, name);
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
    const schemas = [...[...modules.values()].flatMap(({ payload, result }) => [payload, result])];
    assert.ok(schemas.length > 40);
    for (const schema of schemas) {
      for (const { schema: inner, path: at } of walk(schema)) {
        assert.ok(!undeclared.has(inner.type), `${inner.type} at ${at.join('.')}`);
      }
    }
  });

  it('declares exactly the entity types its payload ids name', () => {
    for (const [name, entry] of [...Object.entries(COMMANDS), ...Object.entries(QUERIES)]) {
      assert.deepEqual([...entry.entityTypes].sort(), entityTypesIn(moduleOf(name).payload), name);
    }
  });

  it('loads no schema: the catalog modules reach Valibot through no static import', () => {
    for (const file of ['commands.js', 'queries.js']) {
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
    for (const [type, fields] of Object.entries(QUERY_SAMPLES)) {
      const { payload } = moduleOf(type);
      assert.equal(v.safeParse(payload, { ...fields, type }).success, true, type);
      assert.equal(v.safeParse(payload, { ...fields, type, extra: 'x' }).success, false, type);
    }
  });

  it('accept every answer the kernel gives the samples, both ways (#13, AC1)', async () => {
    const kernel = createKernel({
      adapter: createMemoryAdapter(),
      policy: createBaselinePolicy(),
      caller: CALLERS.newtab,
      ids: testIds(),
      clock: testClock(),
    });
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
      const state = await kernel.query(
        /** @type {import('../../js/kernel/core/contracts/queries.js').Query} */ ({ ...fields, type }),
      );
      assert.ok(state.kind === 'ready' || state.kind === 'empty', `${type}: ${state.kind}`);
      const checked = v.safeParse(moduleOf(type).result, state);
      assert.equal(checked.success, true, `${type}: ${JSON.stringify(state)}`);
    }
  });
});
