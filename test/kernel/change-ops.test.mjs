// #17 PR 4c: each change row holds the ops its commit took (domain/changes.js), content-free, the
// op's name and a block's id or the names of the fields that changed (the lead's Q4). Every
// catalog sample's rows are held to change-ops.mjs's table on the in-memory adapter and #17's,
// and the two write the same ops. A save of every block names only the ones it changed. No row,
// live or in a recovery point, holds what the user wrote, a deleted note's rows keep their ops,
// and the CommitLog's reads hand on none of them (the lead, 4c's Q4).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';

import * as v from '../../js/lib/valibot/index.mjs';
import { createKernel } from './test-kernel.mjs';
import { COMMAND_TYPES } from '../../js/kernel/core/contracts/commands.js';
import { FOLDER_OP_FIELDS, NOTE_OP_FIELDS, changeOp, changeRecord } from '../../js/kernel/core/contracts/entities.js';
import { blocksByNote, folderOps, noteOps, sameValue } from '../../js/kernel/core/domain/changes.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createMemoryCommitLog } from '../../js/kernel/core/memory/commit-log.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { purgeRecoveryPoints } from '../../js/kernel/adapters/indexeddb/purge.js';
import {
  DEFAULT_LIMITS,
  copyPoint,
  keepVerified,
  listPoints,
  openRecovery,
  readPointStore,
  startPoint,
  storesToCopy,
  verifyPoint,
} from '../../js/kernel/adapters/indexeddb/recovery-points.js';
import { openWithoutUpgrade } from '../../js/kernel/adapters/indexeddb/shapes.js';
import { CHANGE_OPS } from './change-ops.mjs';
import { COMMAND_SAMPLES } from './command-samples.mjs';
import { KeyRange, adapterOn, closeAll, kernelOn, legacyEnv, profile, recordsOf } from './storage-fixture.mjs';
import { CALLERS, NOW, testClock, testIds } from './support.mjs';

/** @typedef {import('../../js/kernel/core/contracts/commands.js').Command} Command */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').CommandType} CommandType */
/** @typedef {import('../../js/kernel/core/contracts/entities.js').ChangeOp} ChangeOp */
/** @typedef {import('../../js/kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */

/**
 * A change row, as either adapter keeps it
 * @typedef {{seq: number, entityType: string, entityId: string, revision: number, ops: ChangeOp[]}} Row
 */

/**
 * A kernel on one adapter, the change rows its commits wrote, in the order they wrote them,
 * and each commit's command, by seq
 * @typedef {object} World
 * @property {string} name
 * @property {KernelAdapter} adapter
 * @property {Kernel} kernel
 * @property {import('../../js/kernel/core/ports/commit-log.js').CommitLog} commitLog - the log the rows are in
 * @property {() => Promise<Row[]>} rows
 * @property {Map<number, CommandType>} commandAt
 * @property {(type: string, fields: Record<string, unknown>) => Promise<any>} run
 *   Sends one command under a commandId of its own, and answers its outcome
 * @property {() => Promise<void>} close
 */

/**
 * Wraps `inner` so each commit that wrote rows names its command, by the seq it took
 * @param {KernelAdapter} inner
 * @param {Map<number, CommandType>} commandAt
 * @returns {KernelAdapter}
 */
const recording = (inner, commandAt) => ({
  ...inner,
  async commit(work) {
    const result = await inner.commit(work);
    const { commitSeq } = /** @type {{commitSeq?: number}} */ (result.outcome);
    if (typeof commitSeq === 'number') commandAt.set(commitSeq, /** @type {CommandType} */ (work.command.type));
    return result;
  },
});

/**
 * @param {Kernel} kernel
 * @returns {World['run']}
 */
const runner = kernel => {
  let sent = 0;
  return (type, fields) =>
    kernel.execute(/** @type {Command} */ ({ ...fields, type, commandId: `${type}-${(sent += 1)}` }));
};

/** @returns {Promise<World>} */
async function memoryWorld() {
  const log = createMemoryCommitLog();
  /** @type {Map<number, CommandType>} */
  const commandAt = new Map();
  const adapter = recording(createMemoryAdapter({ commitLog: log }), commandAt);
  const kernel = createKernel({
    adapter,
    policy: createBaselinePolicy(),
    caller: CALLERS.newtab,
    ids: testIds(),
    clock: testClock(),
  });
  return {
    name: 'memory',
    adapter,
    kernel,
    commitLog: log,
    commandAt,
    run: runner(kernel),
    rows: async () =>
      log.rows().map(({ commitSeq, entityType, entityId, revision, ops }) => ({
        seq: commitSeq,
        entityType,
        entityId,
        revision,
        ops,
      })),
    close: async () => {},
  };
}

/**
 * @param {{of?: ReturnType<typeof profile>}} [options]
 * @returns {Promise<World & {of: ReturnType<typeof profile>}>}
 */
async function indexedDbWorld({ of = profile() } = {}) {
  const clock = testClock();
  const inner = adapterOn(of, { clock, backups: true });
  await inner.open();
  /** @type {Map<number, CommandType>} */
  const commandAt = new Map();
  const adapter = recording(inner, commandAt);
  const kernel = kernelOn(/** @type {any} */ (adapter), { ids: testIds(), clock });
  return {
    name: 'indexeddb',
    of,
    adapter,
    kernel,
    commitLog: /** @type {any} */ (inner).commitLog,
    commandAt,
    run: runner(kernel),
    rows: async () =>
      /** @type {Array<Row & {position: number}>} */ (await recordsOf(of, 'changes'))
        .sort((a, b) => a.seq - b.seq || a.position - b.position)
        .map(({ seq, entityType, entityId, revision, ops }) => ({ seq, entityType, entityId, revision, ops })),
    close: async () => closeAll(of),
  };
}

const WORLDS = [memoryWorld, indexedDbWorld];

/**
 * The rows of the commit `outcome` answers, as [entityType, entityId, ops]
 * @param {World} world
 * @param {any} outcome
 * @returns {Promise<Array<[string, string, ChangeOp[]]>>}
 */
async function rowsOf(world, outcome) {
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  return (await world.rows())
    .filter(row => row.seq === outcome.commitSeq)
    .map(({ entityType, entityId, ops }) => /** @type {[string, string, ChangeOp[]]} */ ([entityType, entityId, ops]));
}

/**
 * Every catalog sample, in the order the samples run, on `world`, and the rows each command's
 * commits wrote, by command
 * @param {World} world
 * @returns {Promise<Map<CommandType, Array<[string, string, ChangeOp[]]>>>}
 */
async function samplesOn(world) {
  for (const [type, fields] of Object.entries(COMMAND_SAMPLES)) await world.run(type, fields);
  /** @type {Map<CommandType, Array<[string, string, ChangeOp[]]>>} */
  const byCommand = new Map();
  for (const row of await world.rows()) {
    const type = world.commandAt.get(row.seq);
    assert.ok(type, `${world.name}: row ${row.seq} has no command`);
    const list = byCommand.get(type) || [];
    list.push([row.entityType, row.entityId, row.ops]);
    byCommand.set(type, list);
  }
  return byCommand;
}

/** @param {ChangeOp[]} ops */
const isValid = ops => v.safeParse(v.array(changeOp), ops).success;

describe("#17 PR 4c: domain/changes.js's differ, on records made by hand", () => {
  /**
   * A block of note n1
   * @param {string} id
   * @param {Record<string, unknown>} [fields]
   */
  const block = (id, fields = {}) => ({ id, canvasId: 'n1', type: 'text', content: 'x', order: 0, ...fields });
  const note = { id: 'n1', name: 'Plan', pinned: false, updatedAt: 1 };

  it('a block put as it was takes none, one whose order alone changed moveBlock, and one changed with its order updateBlock alone', () => {
    assert.deepEqual(
      noteOps({ before: note, after: { ...note } }, [
        ['b1', { before: block('b1'), after: block('b1') }],
        ['b2', { before: block('b2'), after: block('b2', { order: 1 }) }],
        ['b3', { before: block('b3'), after: block('b3', { order: 2, content: 'y' }) }],
        ['b4', { before: null, after: block('b4') }],
        ['b5', { before: block('b5'), after: null }],
        ['b6', { before: null, after: null }],
      ]),
      [
        { op: 'moveBlock', blockId: 'b2' },
        { op: 'updateBlock', blockId: 'b3' },
        { op: 'insertBlock', blockId: 'b4' },
        { op: 'deleteBlock', blockId: 'b5' },
      ],
    );
  });

  it("a note whose updatedAt alone moved takes none, a field the schema doesn't name lands in no op, and deleteNote stands for its blocks", () => {
    assert.deepEqual(noteOps({ before: note, after: { ...note, updatedAt: 2 } }), []);
    assert.deepEqual(
      noteOps({ before: note, after: { ...note, name: 'Plan 2', pinned: true, 'Plans for Tuesday': 'x' } }),
      [{ op: 'updateNote', fields: ['name', 'pinned'] }],
    );
    assert.deepEqual(noteOps({ before: null, after: note }, [['b1', { before: null, after: block('b1') }]]), [
      { op: 'createNote' },
      { op: 'insertBlock', blockId: 'b1' },
    ]);
    assert.deepEqual(noteOps({ before: note, after: null }, [['b1', { before: block('b1'), after: null }]]), [
      { op: 'deleteNote' },
    ]);
    assert.deepEqual(noteOps({ before: null, after: null }), []);
  });

  it("a block that moved to another note leaves the one it left and joins the other, and a block of no note is no one's", () => {
    const byNote = blocksByNote([
      ['b1', { before: block('b1'), after: block('b1', { canvasId: 'n2' }) }],
      ['b2', { before: block('b2'), after: undefined }],
      ['b3', { before: null, after: { id: 'b3', type: 'text' } }],
    ]);
    assert.deepEqual([...byNote.keys()], ['n1', 'n2']);
    assert.deepEqual(noteOps({ before: null, after: undefined }, byNote.get('n1')), [
      { op: 'deleteBlock', blockId: 'b1' },
    ]);
    assert.deepEqual(noteOps({ before: null, after: undefined }, byNote.get('n2')), [
      { op: 'insertBlock', blockId: 'b1' },
    ]);
  });

  it("a folder the commit didn't write takes none, and one it made, changed, or deleted takes its op", () => {
    const folder = { id: 'f1', name: 'Work', parentId: null, updatedAt: 1 };
    assert.deepEqual(folderOps({ before: folder, after: undefined }), []);
    assert.deepEqual(folderOps({ before: null, after: folder }), [{ op: 'createFolder' }]);
    assert.deepEqual(folderOps({ before: folder, after: { ...folder, updatedAt: 2 } }), []);
    assert.deepEqual(folderOps({ before: folder, after: { ...folder, name: 'Projects', parentId: 'f0' } }), [
      { op: 'updateFolder', fields: ['name', 'parentId'] },
    ]);
    assert.deepEqual(folderOps({ before: folder, after: null }), [{ op: 'deleteFolder' }]);
    assert.deepEqual(folderOps({ before: null, after: null }), []);
  });

  it('compares stored values field by field, a missing field the same as an undefined one', () => {
    assert.equal(sameValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
    assert.equal(sameValue({ a: undefined }, {}), true);
    assert.equal(sameValue([], {}), false);
    assert.equal(sameValue({ a: [1] }, { a: [1, 2] }), false);
    assert.equal(sameValue(null, {}), false);
    assert.equal(sameValue(Number.NaN, Number.NaN), true);
  });
});

describe("#17 PR 4c: every catalog command's change ops", () => {
  it('names every catalog command once', () => {
    assert.deepEqual(Object.keys(CHANGE_OPS).sort(), [...COMMAND_TYPES].sort());
  });

  for (const make of WORLDS) {
    it(`each sample's rows on the ${make === memoryWorld ? 'memory' : 'indexeddb'} adapter hold only the ops the table gives its command, and every op is one the schema takes`, async () => {
      const world = await make();
      try {
        const byCommand = await samplesOn(world);
        // Every row #17's adapter keeps is a change record as the schema has it, which is strict,
        // so a field a row gains fails here until the schema names it (R131)
        if ('of' in world) {
          for (const row of await recordsOf(/** @type {ReturnType<typeof profile>} */ (world.of), 'changes')) {
            assert.ok(v.safeParse(changeRecord, row).success, JSON.stringify(row));
          }
        }
        /** @type {Set<string>} */
        const seen = new Set();
        for (const [type, rows] of byCommand) {
          const allowed = CHANGE_OPS[type];
          assert.notEqual(allowed.length, 0, `${world.name}: ${type} wrote rows the table says it writes none of`);
          for (const [entityType, entityId, ops] of rows) {
            assert.ok(isValid(ops), `${world.name}: ${type} ${entityType} ${entityId}: ${JSON.stringify(ops)}`);
            for (const { op } of ops) {
              assert.ok(allowed.includes(op), `${world.name}: ${type} took ${op}`);
              // A note's row holds note and block ops, and a folder's folder ops. A row whose
              // commit changed nothing of its entity, as a move to where it is, holds none
              assert.equal(
                op.endsWith('Folder'),
                entityType === 'folder',
                `${world.name}: ${type} ${entityType} ${op}`,
              );
              seen.add(op);
            }
          }
        }
        // The samples take every kind of op but the two only a block's own change makes, so the
        // checks above aren't empty. The save's sample sends its block as it's stored, and the
        // focused cases below take updateBlock and moveBlock
        for (const op of ['createNote', 'updateNote', 'deleteNote', 'insertBlock', 'deleteBlock']) {
          assert.ok(seen.has(op), `${world.name}: no sample took ${op}`);
        }
        for (const op of ['createFolder', 'updateFolder', 'deleteFolder'])
          assert.ok(seen.has(op), `${world.name}: ${op}`);
      } finally {
        await world.close();
      }
    });
  }

  it('the two adapters write the same rows with the same ops, for every sample the in-memory one runs', async () => {
    const memory = await memoryWorld();
    const indexeddb = await indexedDbWorld();
    try {
      const ours = await samplesOn(memory);
      const theirs = await samplesOn(indexeddb);
      // The in-memory adapter runs no backup task (the `backups` flag)
      for (const type of ['importBackup', 'createAutoBackup']) theirs.delete(/** @type {CommandType} */ (type));
      assert.deepEqual(Object.fromEntries(theirs), Object.fromEntries(ours));
    } finally {
      await memory.close();
      await indexeddb.close();
    }
  });
});

for (const make of WORLDS) {
  const name = make === memoryWorld ? 'the in-memory adapter' : "#17's adapter";
  describe(`#17 PR 4c's ops on ${name}`, () => {
    /**
     * A note with three blocks, made on `world`
     * @param {World} world
     */
    const threeBlocks = async world => {
      const blocks = ['b1', 'b2', 'b3'].map((id, order) => ({ id, type: 'text', content: `Line ${order}`, order }));
      await world.run('createNote', { noteId: 'n1', name: 'Plan', blocks });
      return blocks;
    };

    it('a note made takes createNote and an insertBlock for each block it is made with', async () => {
      const world = await make();
      try {
        const blocks = ['b1', 'b2'].map((id, order) => ({ id, type: 'text', content: 'x', order }));
        const outcome = await world.run('createNote', { noteId: 'n1', name: 'Plan', blocks });
        assert.deepEqual(await rowsOf(world, outcome), [
          [
            'note',
            'n1',
            [{ op: 'createNote' }, { op: 'insertBlock', blockId: 'b1' }, { op: 'insertBlock', blockId: 'b2' }],
          ],
        ]);
      } finally {
        await world.close();
      }
    });

    it('a save of every block names only the ones it changed, and one that changes nothing writes its row with no ops', async () => {
      const world = await make();
      try {
        const blocks = await threeBlocks(world);
        const typed = blocks.map(block => (block.id === 'b2' ? { ...block, content: 'Line 1, typed into' } : block));
        assert.deepEqual(await rowsOf(world, await world.run('saveNoteContent', { noteId: 'n1', blocks: typed })), [
          ['note', 'n1', [{ op: 'updateBlock', blockId: 'b2' }]],
        ]);
        // The same blocks again: the revision moves, and nothing changed
        assert.deepEqual(await rowsOf(world, await world.run('saveNoteContent', { noteId: 'n1', blocks: typed })), [
          ['note', 'n1', []],
        ]);
        // A block added at the end, the first two swapped, and a title typed
        const reordered = [
          { ...typed[1], order: 0 },
          { ...typed[0], order: 1 },
          typed[2],
          { id: 'b4', type: 'text', content: 'More', order: 3 },
        ];
        const saved = await world.run('saveNoteContent', { noteId: 'n1', blocks: reordered, name: 'Plan 2' });
        assert.deepEqual(await rowsOf(world, saved), [
          [
            'note',
            'n1',
            [
              { op: 'updateNote', fields: ['name', 'titleManuallySet'] },
              { op: 'moveBlock', blockId: 'b2' },
              { op: 'moveBlock', blockId: 'b1' },
              { op: 'insertBlock', blockId: 'b4' },
            ],
          ],
        ]);
      } finally {
        await world.close();
      }
    });

    it('insertBlocks inserts its blocks and moves the ones it shifts, and deleteBlocks deletes each it found', async () => {
      const world = await make();
      try {
        await threeBlocks(world);
        const inserted = await world.run('insertBlocks', {
          noteId: 'n1',
          blocks: [{ id: 'b9', type: 'text', content: 'From the chat' }],
          atOrder: 1,
        });
        const [[, , ops]] = await rowsOf(world, inserted);
        assert.deepEqual(
          ops.filter(({ op }) => op !== 'updateNote'),
          [
            { op: 'moveBlock', blockId: 'b2' },
            { op: 'moveBlock', blockId: 'b3' },
            { op: 'insertBlock', blockId: 'b9' },
          ],
        );
        const deleted = await world.run('deleteBlocks', { noteId: 'n1', blockIds: ['b2', 'never-saved'] });
        assert.deepEqual(await rowsOf(world, deleted), [['note', 'n1', [{ op: 'deleteBlock', blockId: 'b2' }]]]);
      } finally {
        await world.close();
      }
    });

    it('a note deleted for good takes deleteNote alone, and its earlier rows keep their ops', async () => {
      const world = await make();
      try {
        await threeBlocks(world);
        const before = await world.rows();
        await world.run('trashNote', { noteId: 'n1' });
        const deleted = await world.run('deleteNotePermanently', { noteId: 'n1' });
        assert.deepEqual(await rowsOf(world, deleted), [['note', 'n1', [{ op: 'deleteNote' }]]]);
        const after = await world.rows();
        assert.deepEqual(after.slice(0, before.length), before);
        assert.deepEqual(
          before[0].ops.map(({ op }) => op),
          ['createNote', 'insertBlock', 'insertBlock', 'insertBlock'],
        );
      } finally {
        await world.close();
      }
    });

    it("a folder's ops, and the notes deleteFolder files at the root", async () => {
      const world = await make();
      try {
        const made = await world.run('createFolder', { folderId: 'f1', name: 'Work', parentId: null });
        assert.deepEqual(await rowsOf(world, made), [['folder', 'f1', [{ op: 'createFolder' }]]]);
        const renamed = await world.run('renameFolder', { folderId: 'f1', name: 'Projects' });
        assert.deepEqual(await rowsOf(world, renamed), [['folder', 'f1', [{ op: 'updateFolder', fields: ['name'] }]]]);
        const collapsed = await world.run('setFolderCollapsed', { folderId: 'f1', collapsed: true });
        assert.deepEqual(await rowsOf(world, collapsed), [
          ['folder', 'f1', [{ op: 'updateFolder', fields: ['collapsed'] }]],
        ]);
        await threeBlocks(world);
        const filed = await world.run('moveNoteToFolder', { noteId: 'n1', folderId: 'f1' });
        const [[, , [moved]]] = await rowsOf(world, filed);
        assert.ok(moved.op === 'updateNote' && moved.fields.includes('folderId'), JSON.stringify(moved));
        const deleted = await rowsOf(world, await world.run('deleteFolder', { folderId: 'f1' }));
        assert.deepEqual(
          deleted.map(([entityType, entityId, ops]) => [entityType, entityId, ops.map(({ op }) => op)]),
          [
            ['note', 'n1', ['updateNote']],
            ['folder', 'f1', ['deleteFolder']],
          ].sort((a, b) => deleted.findIndex(row => row[1] === a[1]) - deleted.findIndex(row => row[1] === b[1])),
        );
        const [, , [refiled]] = /** @type {[string, string, any[]]} */ (deleted.find(row => row[1] === 'n1'));
        assert.ok(refiled.fields.includes('folderId'), JSON.stringify(refiled));
      } finally {
        await world.close();
      }
    });

    it("a capture into a Daily Note it makes takes createNote and the capture's insertBlock", async () => {
      const world = await make();
      try {
        const captured = await world.run('captureToDailyNote', {
          noteId: 'd1',
          blockId: 'c1',
          capture: { type: 'text', content: 'Quote' },
        });
        assert.deepEqual(await rowsOf(world, captured), [
          ['note', 'd1', [{ op: 'createNote' }, { op: 'insertBlock', blockId: 'c1' }]],
        ]);
        // Into the note it made: the capture's block only
        const again = await world.run('captureToDailyNote', {
          noteId: 'd2',
          blockId: 'c2',
          capture: { type: 'text', content: 'Another' },
        });
        assert.deepEqual(await rowsOf(world, again), [['note', 'd1', [{ op: 'insertBlock', blockId: 'c2' }]]]);
      } finally {
        await world.close();
      }
    });

    it('a field only a remote note names never lands in an op', async () => {
      const world = await make();
      try {
        await threeBlocks(world);
        const outcome = await world.run('applyRemoteContent', {
          noteId: 'n1',
          note: { id: 'n1', name: 'Plan from afar', 'Plans for Tuesday': 'secret' },
          blocks: [],
          expectedRevision: 1,
        });
        const [[, , ops]] = await rowsOf(world, outcome);
        const fields = ops.flatMap(op => ('fields' in op ? op.fields : []));
        assert.ok(fields.includes('name'), JSON.stringify(ops));
        assert.ok(
          fields.every(field => NOTE_OP_FIELDS.includes(field)),
          JSON.stringify(fields),
        );
        assert.equal(JSON.stringify(ops).includes('Tuesday'), false);
      } finally {
        await world.close();
      }
    });

    it("the CommitLog's reads hand on no op (the lead, 4c's Q4)", async () => {
      const world = await make();
      try {
        await threeBlocks(world);
        const read = await world.commitLog.readChangesSince(0, 10);
        assert.equal(read.kind, 'changes');
        const { entries } = /** @type {{entries: object[]}} */ (read);
        assert.ok(entries.length > 0);
        for (const entry of entries)
          assert.deepEqual(Object.keys(entry).sort(), ['commitSeq', 'entityId', 'entityType', 'revision']);
        // The rows themselves keep them
        assert.ok((await world.rows()).some(row => row.ops.length > 0));
      } finally {
        await world.close();
      }
    });
  });
}

describe("#17 PR 4c: the before-images #17's adapter takes the ops from", () => {
  /**
   * Runs `fn`, counting the gets of a block and the reads of the canvasId index it issues
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<{answer: T, reads: {gets: number, indexReads: number}}>}
   */
  const blockReads = async fn => {
    /** @type {{IDBObjectStore: any, IDBIndex: any}} */
    const fake = createRequire(import.meta.url)('fake-indexeddb');
    const realGet = fake.IDBObjectStore.prototype.get;
    const realGetKey = fake.IDBObjectStore.prototype.getKey;
    const realGetAll = fake.IDBIndex.prototype.getAll;
    const reads = { gets: 0, keyReads: 0, indexReads: 0 };
    fake.IDBObjectStore.prototype.get = function get(/** @type {unknown[]} */ ...args) {
      if (this.name === 'elements') reads.gets += 1;
      return realGet.apply(this, args);
    };
    fake.IDBObjectStore.prototype.getKey = function getKey(/** @type {unknown[]} */ ...args) {
      if (this.name === 'elements') reads.keyReads += 1;
      return realGetKey.apply(this, args);
    };
    fake.IDBIndex.prototype.getAll = function getAll(/** @type {unknown[]} */ ...args) {
      if (this.objectStore.name === 'elements' && this.name === 'canvasId') reads.indexReads += 1;
      return realGetAll.apply(this, args);
    };
    try {
      return { answer: await fn(), reads };
    } finally {
      fake.IDBObjectStore.prototype.get = realGet;
      fake.IDBObjectStore.prototype.getKey = realGetKey;
      fake.IDBIndex.prototype.getAll = realGetAll;
    }
  };

  let units = 0;
  /**
   * Commits one unit over `stores` on `world`'s adapter, as no catalog command, the way #20's
   * storage probe commits, and answers its outcome
   * @param {World} world
   * @param {string[]} stores
   * @param {(tx: any) => Promise<void>} run
   */
  const commitUnit = async (world, stores, run) => {
    units += 1;
    const work = {
      commandId: `unit-${units}`,
      command: { type: 'probe', commandId: `unit-${units}` },
      effect: { kind: 'units', units: [{ stores, run }] },
      done: () => ({
        kind: 'committed',
        code: 'test',
        changedIds: [],
        messageKey: 'committed.test',
        severity: 'success',
      }),
    };
    return (await world.adapter.commit(/** @type {any} */ (work))).outcome;
  };

  /**
   * A block of note n1, as a unit puts it
   * @param {string} id
   * @param {number} order
   */
  const blockOf = (id, order) => ({ id, canvasId: 'n1', type: 'text', content: id, order });

  it("a save of a 100-block note reads its blocks once, through the canvasId index, asks each block's key once, and looks none up by itself", async () => {
    const world = await indexedDbWorld();
    try {
      const blocks = Array.from({ length: 100 }, (_, order) => ({
        id: `b${order}`,
        type: 'text',
        content: `Line ${order}`,
        order,
      }));
      await world.run('createNote', { noteId: 'n1', name: 'Long', blocks });
      const typed = blocks.map(block => (block.id === 'b50' ? { ...block, content: 'Line 50, typed into' } : block));
      const { answer: saved, reads } = await blockReads(() =>
        world.run('saveNoteContent', { noteId: 'n1', blocks: typed }),
      );
      assert.deepEqual(reads, { gets: 0, keyReads: 100, indexReads: 1 });
      assert.deepEqual(await rowsOf(world, saved), [['note', 'n1', [{ op: 'updateBlock', blockId: 'b50' }]]]);
    } finally {
      await world.close();
    }
  });

  it("a new note's 50 blocks are each asked for by key once, and a key that finds no block counts as the block not there, so none is looked up again", async () => {
    const world = await indexedDbWorld();
    try {
      const blocks = Array.from({ length: 50 }, (_, order) => ({
        id: `b${order}`,
        type: 'text',
        content: `Line ${order}`,
        order,
      }));
      const { answer: created, reads } = await blockReads(() =>
        world.run('createNote', { noteId: 'n1', name: 'Long', blocks }),
      );
      assert.deepEqual(reads, { gets: 0, keyReads: 50, indexReads: 0 });
      assert.deepEqual(await rowsOf(world, created), [
        ['note', 'n1', [{ op: 'createNote' }, ...blocks.map(block => ({ op: 'insertBlock', blockId: block.id }))]],
      ]);
    } finally {
      await world.close();
    }
  });

  it('a key read that finds nothing after the commit deleted the block keeps what the block was before', async () => {
    const world = await indexedDbWorld();
    try {
      await world.run('createNote', {
        noteId: 'n1',
        name: 'Plan',
        blocks: [{ id: 'b1', type: 'text', content: 'b1', order: 0 }],
      });
      const b1 = (await recordsOf(world.of, 'elements')).find(record => record.id === 'b1');
      const { answer, reads } = await blockReads(() =>
        commitUnit(world, ['notes', 'blocks'], async tx => {
          tx.delete('blocks', 'b1');
          assert.equal(await tx.getKey('blocks', 'b1'), undefined);
          tx.put('blocks', { ...b1, content: 'Back' });
        }),
      );
      // The delete's own look-up answers first, so the key read's nothing changes no op
      assert.deepEqual(reads, { gets: 1, keyReads: 1, indexReads: 0 });
      assert.deepEqual(await rowsOf(world, answer), [['note', 'n1', [{ op: 'updateBlock', blockId: 'b1' }]]]);
    } finally {
      await world.close();
    }
  });

  it('a write of a block or a folder nothing read looks it up first, and a note it wrote only a block of takes a row', async () => {
    const world = await indexedDbWorld();
    try {
      await world.run('createFolder', { folderId: 'f1', name: 'Work', parentId: null });
      await world.run('createNote', {
        noteId: 'n1',
        name: 'Plan',
        blocks: [{ id: 'b1', type: 'text', content: 'b1', order: 0 }],
      });
      const b1 = (await recordsOf(world.of, 'elements')).find(record => record.id === 'b1');
      const [f1] = await recordsOf(world.of, 'folders');
      const { answer, reads } = await blockReads(() =>
        commitUnit(world, ['notes', 'blocks', 'folders'], async tx => {
          tx.put('blocks', { ...b1, content: 'Changed' });
          tx.put('folders', { ...f1, name: 'Projects' });
        }),
      );
      assert.equal(reads.gets, 1);
      assert.deepEqual(await rowsOf(world, answer), [
        ['folder', 'f1', [{ op: 'updateFolder', fields: ['name'] }]],
        ['note', 'n1', [{ op: 'updateBlock', blockId: 'b1' }]],
      ]);
    } finally {
      await world.close();
    }
  });

  it("a block put under a read of the note's blocks that the read didn't find is one the note didn't have, put before the read answered or after", async () => {
    const world = await indexedDbWorld();
    try {
      await world.run('createNote', {
        noteId: 'n1',
        name: 'Plan',
        blocks: [{ id: 'b1', type: 'text', content: 'b1', order: 0 }],
      });
      const { answer, reads } = await blockReads(() =>
        commitUnit(world, ['notes', 'blocks'], async tx => {
          const read = tx.getAllByIndex('blocks', 'canvasId', 'n1');
          tx.put('blocks', blockOf('b8', 8));
          const found = await read;
          tx.put('blocks', { ...found.find((/** @type {any} */ block) => block.id === 'b1'), content: 'Changed' });
          tx.put('blocks', blockOf('b9', 9));
          // Put and deleted in the one commit, so no op
          tx.delete('blocks', 'b8');
          tx.delete('blocks', 'b9');
          tx.put('blocks', blockOf('b7', 7));
        }),
      );
      assert.deepEqual(reads, { gets: 0, keyReads: 0, indexReads: 1 });
      assert.deepEqual(await rowsOf(world, answer), [
        [
          'note',
          'n1',
          [
            { op: 'updateBlock', blockId: 'b1' },
            { op: 'insertBlock', blockId: 'b7' },
          ],
        ],
      ]);
    } finally {
      await world.close();
    }
  });

  it('a block a unit read by its id is looked up no more', async () => {
    const world = await indexedDbWorld();
    try {
      await world.run('createNote', {
        noteId: 'n1',
        name: 'Plan',
        blocks: [{ id: 'b1', type: 'text', content: 'b1', order: 0 }],
      });
      const { answer, reads } = await blockReads(() =>
        commitUnit(world, ['notes', 'blocks'], async tx => {
          tx.put('blocks', { ...(await tx.get('blocks', 'b1')), content: 'Changed' });
        }),
      );
      assert.deepEqual(reads, { gets: 1, keyReads: 0, indexReads: 0 });
      assert.deepEqual(await rowsOf(world, answer), [['note', 'n1', [{ op: 'updateBlock', blockId: 'b1' }]]]);
    } finally {
      await world.close();
    }
  });
});

describe('#17 PR 4c: no change row holds what the user wrote, live or in a recovery point', () => {
  const CANARY = 'canary-ops-c4n4ry';

  it('through every writer, and after the note is deleted for good, the rows hold ids and field names only, and Export JSON holds no row', async () => {
    const world = await indexedDbWorld();
    const io = { keyRange: KeyRange, crypto: /** @type {any} */ (webcrypto), limits: DEFAULT_LIMITS };
    try {
      const text = (/** @type {string} */ slot) => `${CANARY} ${slot}`;
      await world.run('createFolder', { folderId: 'f1', name: text('folder'), parentId: null });
      await world.run('renameFolder', { folderId: 'f1', name: text('folder renamed') });
      await world.run('createNote', {
        noteId: 'n1',
        name: text('title'),
        folderId: 'f1',
        blocks: [{ id: 'b1', type: 'text', content: text('block'), order: 0 }],
      });
      await world.run('saveNoteContent', {
        noteId: 'n1',
        blocks: [{ id: 'b1', type: 'text', content: text('typed'), order: 0 }],
        preview: text('preview'),
        name: text('saved title'),
      });
      await world.run('renameNote', { noteId: 'n1', name: text('renamed'), origin: 'typed' });
      await world.run('insertBlocks', {
        noteId: 'n1',
        blocks: [{ id: 'b2', type: 'text', content: text('inserted') }],
      });
      await world.run('attachInsights', { noteId: 'n1', insights: { todos: [text('todo')] }, contentHash: 'h1' });
      await world.run('captureToDailyNote', {
        noteId: 'd1',
        blockId: 'c1',
        capture: { type: 'bookmark', url: `https://${CANARY}.example.test/`, title: text('page') },
      });
      // What a recovery point made now holds of the change log
      const source = /** @type {IDBDatabase} */ (await openWithoutUpgrade(world.of.faults.factory, 'CanvasTabDB'));
      const recovery = /** @type {IDBDatabase} */ (await openRecovery(world.of.faults.factory, { create: true }));
      /** @type {any[]} */
      let pointRows = [];
      try {
        const { point, progress } = await startPoint(recovery, {
          id: 'p-ops',
          kind: 'pre-repair',
          sourceShape: 'current',
          sourceVersion: source.version,
          structuralVersion: null,
          logicalVersion: null,
          target: null,
          stores: storesToCopy(source),
          createdAt: NOW,
        });
        await copyPoint({ source, recovery, point, progress, io });
        pointRows = await readPointStore(recovery, point, 'changes', io);
      } finally {
        source.close();
        recovery.close();
      }
      // Export JSON lists its records, and no change row
      const file = JSON.parse(await (await world.adapter.exportBackup({})).text());
      assert.deepEqual(Object.keys(file).sort(), ['canvases', 'elements', 'exportedAt', 'folders', 'media', 'version']);
      await world.run('trashNote', { noteId: 'n1' });
      await world.run('deleteNotePermanently', { noteId: 'n1' });

      const rows = await world.rows();
      assert.ok(pointRows.length > 0 && rows.length > pointRows.length);
      for (const held of [JSON.stringify(rows), JSON.stringify(pointRows)]) {
        assert.equal(held.includes(CANARY) || held.includes('c4n4ry'), false);
      }
      // Ops are there to check, and name schema fields only
      const ops = rows.flatMap(row => row.ops);
      assert.ok(ops.some(({ op }) => op === 'updateBlock') && ops.some(({ op }) => op === 'deleteNote'));
      for (const row of rows) {
        const fields = row.ops.flatMap(op => ('fields' in op ? op.fields : []));
        const known = row.entityType === 'folder' ? FOLDER_OP_FIELDS : NOTE_OP_FIELDS;
        assert.ok(
          fields.every(field => known.includes(field)),
          JSON.stringify(row),
        );
        assert.ok(isValid(row.ops), JSON.stringify(row));
      }
    } finally {
      await world.close();
    }
  });

  it("an imported note with a field no schema names, through edits, a pin, a move, deleteBlocks, a capture, a remote change, a snapshot's restore and a delete for good, leaves no row holding what was written, live or in a recovery point (R131)", async () => {
      const world = await indexedDbWorld();
      const io = { keyRange: KeyRange, crypto: /** @type {any} */ (webcrypto), limits: DEFAULT_LIMITS };
      /** @param {any} query */
      const ask = async query => /** @type {any} */ (await world.kernel.query(query)).data;
      try {
        const text = (/** @type {string} */ slot) => `${CANARY} ${slot}`;
        const imported = await world.run('importBackup', {
          mode: 'merge',
          backup: {
            version: 1,
            exportedAt: 1,
            canvases: [
              {
                id: 'p1',
                name: text('title'),
                createdAt: 1,
                updatedAt: 1,
                [`${CANARY}-field`]: text('made-up value'),
                insights: { todos: [text('insight')] },
              },
            ],
            elements: [{ id: 'pb1', canvasId: 'p1', type: 'text', content: text('block'), order: 0 }],
            folders: [{ id: 'pf1', name: text('folder'), parentId: null }],
          },
        });
        assert.equal(imported.kind, 'committed', JSON.stringify(imported));
        const [noteId] = imported.changedIds;
        const [block] = await ask({ type: 'getNoteBlocks', noteId });
        /** The note's versions as committed, for a remote change made from them */
        const versions = async () => {
          const { revision = 0, placementVersion = 0 } = await ask({ type: 'getNote', noteId });
          return { expectedRevision: revision, expectedPlacementVersion: placementVersion };
        };
        for (const [type, fields] of /** @type {Array<[string, Record<string, unknown>]>} */ ([
          ['saveNoteContent', { noteId, blocks: [{ ...block, content: text('typed') }], preview: text('preview'), name: text('saved') }],
          ['renameNote', { noteId, name: text('renamed'), origin: 'typed' }],
          ['insertBlocks', { noteId, blocks: [{ id: 'i1', type: 'text', content: text('inserted') }] }],
          ['setPinned', { noteId, pinned: true }],
          ['createFolder', { folderId: 'f2', name: text('new folder'), parentId: null }],
          ['moveNoteToFolder', { noteId, folderId: 'f2' }],
          ['deleteBlocks', { noteId, blockIds: ['i1'] }],
          ['captureToDailyNote', { noteId: 'd1', blockId: 'c1', capture: { type: 'text', content: text('capture'), source: text('source') } }],
        ])) {
          const outcome = await world.run(type, fields);
          assert.equal(outcome.kind, 'committed', `${type}: ${JSON.stringify(outcome)}`);
        }
        const remote = await world.run('applyRemoteChanges', {
          changes: [
            {
              note: { id: noteId, name: text('remote title'), pinned: true, folderId: 'f2' },
              blocks: [{ id: block.id, type: 'text', content: text('remote block'), order: 0 }],
              ...(await versions()),
            },
            { note: { id: 'r1', name: text('remote note') }, blocks: [{ id: 'rb1', type: 'text', content: text('remote line'), order: 0 }] },
          ],
        });
        assert.deepEqual(
          remote.items.map((/** @type {any} */ item) => item.outcome.kind),
          ['committed', 'committed'],
          JSON.stringify(remote),
        );
        for (const [type, fields] of /** @type {Array<[string, Record<string, unknown>]>} */ ([
          ['saveSnapshot', { noteId, snapshotId: 's1', blocks: [{ id: block.id, type: 'text', content: text('snapshot') }], title: text('snapshot title') }],
          ['restoreSnapshot', { noteId, snapshotId: 's1', preSnapshotId: 's2', blocks: [{ id: block.id, type: 'text', content: text('snapshot') }], name: text('restored') }],
          ['trashNote', { noteId }],
          ['deleteNotePermanently', { noteId }],
        ])) {
          const outcome = await world.run(type, fields);
          assert.equal(outcome.kind, 'committed', `${type}: ${JSON.stringify(outcome)}`);
        }

        // What a recovery point made now holds of the change log
        const rows = await world.rows();
        const source = /** @type {IDBDatabase} */ (await openWithoutUpgrade(world.of.faults.factory, 'CanvasTabDB'));
        const recovery = /** @type {IDBDatabase} */ (await openRecovery(world.of.faults.factory, { create: true }));
        /** @type {any[]} */
        let pointRows = [];
        try {
          const { point, progress } = await startPoint(recovery, {
            id: 'p-import',
            kind: 'pre-repair',
            sourceShape: 'current',
            sourceVersion: source.version,
            structuralVersion: null,
            logicalVersion: null,
            target: null,
            stores: storesToCopy(source),
            createdAt: NOW,
          });
          await copyPoint({ source, recovery, point, progress, io });
          pointRows = await readPointStore(recovery, point, 'changes', io);
        } finally {
          source.close();
          recovery.close();
        }
        assert.equal(pointRows.length, rows.length);
        for (const held of [JSON.stringify(rows), JSON.stringify(pointRows)]) {
          assert.equal(held.includes(CANARY) || held.includes('c4n4ry'), false);
        }
        // Each kind of writer left its ops, and they name schema fields only
        const ops = rows.flatMap(row => row.ops);
        for (const op of ['createFolder', 'createNote', 'updateNote', 'insertBlock', 'updateBlock', 'deleteBlock', 'deleteNote']) {
          assert.ok(
            ops.some(each => each.op === op),
            op,
          );
        }
        for (const row of rows) {
          const fields = row.ops.flatMap(op => ('fields' in op ? op.fields : []));
          const known = row.entityType === 'folder' ? FOLDER_OP_FIELDS : NOTE_OP_FIELDS;
          assert.ok(
            fields.every(field => known.includes(field)),
            JSON.stringify(row),
          );
          assert.ok(isValid(row.ops), JSON.stringify(row));
        }
      } finally {
        await world.close();
      }
  });

  it("a note deleted for good keeps its rows and their ops in a recovery point, which the purge leaves verifying, as it takes the note's records out", async () => {
    const world = await indexedDbWorld();
    const io = { keyRange: KeyRange, crypto: /** @type {any} */ (webcrypto), limits: DEFAULT_LIMITS };
    /**
     * `store`'s rows in the one point, and whether the point reads back as it was made
     * @param {string} store
     */
    const inPoint = async store => {
      const recovery = /** @type {IDBDatabase} */ (await openRecovery(world.of.faults.factory, { create: false }));
      try {
        const [point] = await listPoints(recovery);
        return {
          rows: await readPointStore(recovery, point, store, io),
          verdict: await verifyPoint({ recovery, point, io }),
        };
      } finally {
        recovery.close();
      }
    };
    try {
      await world.run('createNote', {
        noteId: 'n1',
        name: 'Doomed',
        blocks: [{ id: 'b1', type: 'text', content: 'one' }],
      });
      await world.run('saveNoteContent', { noteId: 'n1', blocks: [{ id: 'b1', type: 'text', content: 'two' }] });
      // A point of the database as it is, made before the delete
      const source = /** @type {IDBDatabase} */ (await openWithoutUpgrade(world.of.faults.factory, 'CanvasTabDB'));
      const recovery = /** @type {IDBDatabase} */ (await openRecovery(world.of.faults.factory, { create: true }));
      try {
        const { point, progress } = await startPoint(recovery, {
          id: 'p-purge',
          kind: 'pre-repair',
          sourceShape: 'current',
          sourceVersion: source.version,
          structuralVersion: null,
          logicalVersion: null,
          target: null,
          stores: storesToCopy(source),
          createdAt: NOW - 60_000,
        });
        await copyPoint({ source, recovery, point, progress, io });
        assert.deepEqual(await verifyPoint({ recovery, point, io }), { ok: true });
        await keepVerified({ recovery, point, clock: { now: () => NOW - 60_000 }, io });
      } finally {
        source.close();
        recovery.close();
      }
      const ofNote = (/** @type {Array<{value: any}>} */ rows) => rows.filter(({ value }) => value.entityId === 'n1');
      const before = ofNote((await inPoint('changes')).rows);
      assert.deepEqual(
        before.map(({ value }) => value.ops.map((/** @type {ChangeOp} */ op) => op.op)),
        [['createNote', 'insertBlock'], ['updateBlock']],
      );

      await world.run('trashNote', { noteId: 'n1' });
      await world.run('deleteNotePermanently', { noteId: 'n1' });
      const swept = await purgeRecoveryPoints({
        indexedDB: world.of.faults.factory,
        keyRange: KeyRange,
        locks: legacyEnv.createLockManager(),
        crypto: /** @type {any} */ (webcrypto),
        clock: { now: () => NOW + 60_000 },
        logger: { warn() {} },
      });
      assert.equal(swept.status, 'purged', JSON.stringify(swept));
      // The note and its block left the point; its change rows stayed, ops and all
      const notes = await inPoint('canvases');
      assert.deepEqual(
        notes.rows.filter(({ value }) => value.id === 'n1'),
        [],
      );
      assert.deepEqual(
        (await inPoint('elements')).rows.filter(({ value }) => value.canvasId === 'n1'),
        [],
      );
      assert.deepEqual(ofNote((await inPoint('changes')).rows), before);
      assert.deepEqual(notes.verdict, { ok: true });
    } finally {
      await world.close();
    }
  });
});
