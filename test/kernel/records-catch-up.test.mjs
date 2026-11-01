// The worker's one-time catch-up of the records 1.4.x left behind their blocks (#33, the lead's
// Q9 and QA3): catchUpNoteRecords on the in-memory adapter and #17's (application/
// record-catch-up.js), and the worker's run of it after the update (composition/background.js):
// each record gets the preview and to-do progress its blocks give and nothing else, the run
// happens once, and a run cut off picks up after the last batch it finished.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { RECORDS_CAUGHT_UP_KEY, createWorkerClient } from '../../js/kernel/composition/background.js';
import { CATCH_UP_BYTES, CATCH_UP_NOTES } from '../../js/kernel/core/application/record-catch-up.js';
import { unitsWork } from '../../js/kernel/core/application/work.js';
import { committed } from '../../js/kernel/core/contracts/outcomes.js';
import { inBlockOrder, noteSaveMetadata } from '../../js/kernel/core/domain/note.js';
import { VERSION_FIELDS } from '../../js/kernel/adapters/indexeddb/versions.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { KeyRange, legacyEnv, profileWith, run, synthesized, transform } from './migration-support.mjs';
import { indexedDbFixture, recordsOf } from './storage-fixture.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';
import { createKernel } from './test-kernel.mjs';

/** @typedef {import('../../js/kernel/core/contracts/commands.js').Command} Command */
/** @typedef {import('../../js/kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../js/kernel/core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */
/** @typedef {import('./migration-support.mjs').Profile} Profile */
/** @typedef {any} Row */

const WORKER = CALLERS['worker-internal'];
const FIXTURES = synthesized();

/** @type {(id: string, fields?: Row) => Row} */
const note = (id, fields) => legacyEnv.note(id, fields);
/** @type {(id: string, canvasId: string | undefined, order: number, content?: string, fields?: Row) => Row} */
const block = (id, canvasId, order, content, fields) => legacyEnv.block(id, canvasId, order, content, fields);

/**
 * The preview and to-do progress `blocks` give their note
 * @param {Row[]} blocks
 */
const derivedOf = blocks => {
  const { preview, todoProgress } = noteSaveMetadata(inBlockOrder(blocks));
  return { preview, todoProgress };
};

/**
 * A note's record without the fields #17's adapter keeps its versions in, which `versions` reads
 * @param {Row} record
 */
const withoutVersions = record =>
  Object.fromEntries(Object.entries(record).filter(([field]) => !VERSION_FIELDS.includes(field)));

/** @typedef {{adapter: KernelAdapter, ids: {next(): string}, kernel: Kernel, close: () => Promise<void> | void}} Context */

/** @type {Array<{name: string, start: () => Promise<Context>}>} */
const CONTEXTS = [
  {
    name: 'in-memory',
    async start() {
      const adapter = createMemoryAdapter();
      const ids = testIds();
      const kernel = createKernel({ adapter, policy: createBaselinePolicy(), caller: WORKER, ids, clock: testClock() });
      return { adapter, ids, kernel, close: () => {} };
    },
  },
  {
    name: "#17's IndexedDB",
    async start() {
      const ctx = await indexedDbFixture.start();
      return { adapter: ctx.adapter, ids: ctx.ids, kernel: ctx.kernel(WORKER), close: ctx.close };
    },
  },
];

/**
 * Records as 1.4.x left them, put through the adapter's own commit
 * @param {Context} ctx
 * @param {StoreName} store
 * @param {Row[]} records
 */
async function seed(ctx, store, records) {
  const seeding = /** @type {Command} */ ({ type: 'runStartupMaintenance', commandId: ctx.ids.next() });
  const unit = {
    stores: [store],
    /** @param {import('../../js/kernel/core/ports/repository.js').Tx} tx */
    async run(tx) {
      for (const record of records) tx.put(store, /** @type {any} */ (record));
    },
  };
  const { outcome } = await ctx.adapter.commit(unitsWork(seeding, [unit], () => committed('seeded', [])));
  assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
}

/**
 * A note's record, with its versions when the adapter keeps them
 * @param {Context} ctx
 * @param {string} noteId
 */
const noteOf = (ctx, noteId) =>
  ctx.adapter.read(['notes'], async tx => {
    const record = await tx.get('notes', noteId);
    return { record, versions: record ? tx.versions('notes', noteId) : undefined };
  });

/**
 * @param {Context} ctx
 * @param {string[]} noteIds
 */
const catchUp = (ctx, noteIds) =>
  ctx.kernel.execute(/** @type {Command} */ ({ type: 'catchUpNoteRecords', commandId: ctx.ids.next(), noteIds }));

for (const { name, start } of CONTEXTS) {
  describe(`catchUpNoteRecords on ${name}`, () => {
    it("gives each note it names its blocks' preview and to-do progress where they differ, and nothing else, moving no version", async () => {
      const ctx = await start();
      try {
        const typed = { name: 'Typed by hand', titleManuallySet: true, preview: 'stale', todoProgress: null };
        await seed(ctx, 'notes', [note('A', typed), note('B', { name: 'Bravo', preview: 'bravo' })]);
        const blocks = [
          block('a1', 'A', 0, 'alpha'),
          block('a2', 'A', 1, 'buy milk', { type: 'todo', checked: true }),
          block('a3', 'A', 2, 'buy eggs', { type: 'todo', checked: false }),
          block('b1', 'B', 0, 'bravo'),
        ];
        await seed(ctx, 'blocks', blocks);
        const a = await noteOf(ctx, 'A');
        const b = await noteOf(ctx, 'B');
        const blocksBefore = await ctx.adapter.read(['blocks'], tx => tx.getAll('blocks'));

        const outcome = await catchUp(ctx, ['A', 'B', 'gone']);
        assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
        assert.equal(outcome.code, 'records-caught-up');
        assert.deepEqual(outcome.changedIds, ['A']);

        const expected = derivedOf(blocks.filter(item => item.canvasId === 'A'));
        assert.notEqual(expected.preview, 'stale');
        assert.notEqual(expected.todoProgress, null);
        const after = await noteOf(ctx, 'A');
        assert.deepEqual(withoutVersions(after.record), withoutVersions({ ...a.record, ...expected }));
        assert.equal(after.record.name, 'Typed by hand');
        assert.equal(after.record.titleManuallySet, true);
        assert.equal(after.record.updatedAt, a.record.updatedAt);
        assert.deepEqual(after.versions, a.versions);
        assert.deepEqual(await noteOf(ctx, 'B'), b);
        assert.deepEqual(await ctx.adapter.read(['blocks'], tx => tx.getAll('blocks')), blocksBefore);
      } finally {
        await ctx.close();
      }
    });

    it('stops past its bytes once it has read a note, answers records-caught-up-part, and leaves the notes after it for the next batch', async () => {
      const ctx = await start();
      try {
        await seed(ctx, 'notes', [note('A', { preview: 'stale' }), note('B', { preview: 'stale' })]);
        const big = block('a1', 'A', 0, 'x'.repeat(CATCH_UP_BYTES + 1));
        await seed(ctx, 'blocks', [big, block('b1', 'B', 0, 'bravo')]);

        const part = await catchUp(ctx, ['A', 'B']);
        assert.equal(part.kind, 'committed', JSON.stringify(part).slice(0, 300));
        assert.equal(part.code, 'records-caught-up-part');
        assert.deepEqual(part.changedIds, ['A']);
        assert.equal((await noteOf(ctx, 'A')).record.preview, derivedOf([big]).preview);
        assert.equal((await noteOf(ctx, 'B')).record.preview, 'stale');

        const rest = await catchUp(ctx, ['B']);
        assert.equal(rest.kind, 'committed', JSON.stringify(rest));
        assert.equal(rest.code, 'records-caught-up');
        assert.deepEqual(rest.changedIds, ['B']);
        assert.equal((await noteOf(ctx, 'B')).record.preview, 'bravo');
      } finally {
        await ctx.close();
      }
    });

    it(`takes at most ${CATCH_UP_NOTES} notes a batch, and only from the worker`, async () => {
      const ctx = await start();
      try {
        const many = Array.from({ length: CATCH_UP_NOTES + 1 }, (_, index) => `n${index}`);
        const over = await catchUp(ctx, many);
        assert.equal(over.kind, 'rejected', JSON.stringify(over));
        const page = createKernel({
          adapter: ctx.adapter,
          policy: createBaselinePolicy(),
          caller: CALLERS.newtab,
          ids: testIds(),
          clock: testClock(),
        });
        const fromPage = await page.execute(
          /** @type {Command} */ ({ type: 'catchUpNoteRecords', commandId: 'from-a-page', noteIds: ['A'] }),
        );
        assert.equal(fromPage.kind, 'rejected', JSON.stringify(fromPage));
      } finally {
        await ctx.close();
      }
    });
  });
}

// ============ The worker's run, after the update ============

/**
 * The worker's host over `of`, whose settings writes `writes` hears
 * @param {Profile} of
 * @param {Row[]} [writes]
 */
const hostOf = (of, writes = []) => {
  const local = of.chrome.api.storage.local;
  return {
    indexedDB: of.real,
    keyRange: KeyRange,
    settings: {
      ...local,
      get: (/** @type {any} */ keys) => local.get(keys),
      set: (/** @type {Row} */ items) => {
        writes.push(structuredClone(items));
        return local.set(items);
      },
      remove: (/** @type {any} */ keys) => local.remove(keys),
    },
    locks: legacyEnv.createLockManager(),
    estimate: null,
    crypto: /** @type {any} */ (webcrypto),
  };
};

/**
 * Puts `records` in `store` of the profile's CanvasTabDB on a connection of its own
 * @param {Profile} of
 * @param {string} store
 * @param {Row[]} records
 * @returns {Promise<void>}
 */
const putRecords = (of, store, records) =>
  new Promise((resolve, reject) => {
    const request = of.real.open('CanvasTabDB');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(store, 'readwrite');
      for (const record of records) tx.objectStore(store).put(record);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });

/**
 * v8.basic, whose records 1.4.x left with no preview and no to-do progress, its first note's
 * title typed by hand, at this build's version as its run and transforms leave it
 * @returns {Promise<Profile>}
 */
async function updatedProfile() {
  const fixture = structuredClone(/** @type {any} */ (FIXTURES.get('v8.basic')));
  const canvases = fixture.databases[0].stores.find((/** @type {Row} */ store) => store.name === 'canvases');
  const first = canvases.records.map((/** @type {Row} */ record) => record.key).sort()[0];
  const typed = canvases.records.find((/** @type {Row} */ record) => record.key === first).value;
  Object.assign(typed, { name: 'Typed by hand', titleManuallySet: true });
  const of = await profileWith(fixture);
  assert.equal((await run(of)).status, 'migrated');
  await transform(of);
  return of;
}

/**
 * A note's record with its versions as #17's adapter reads them: 0 for one it has none of, as
 * the run leaves 1.4.x's records (adapters/indexeddb/versions.js), and as its next write puts them
 * @param {Row} record
 */
const versioned = record => ({ ...Object.fromEntries(VERSION_FIELDS.map(field => [field, 0])), ...record });

/**
 * Each record as the catch-up leaves it: with the preview and to-do progress its blocks give,
 * and its versions where they were
 * @param {Row[]} notes
 * @param {Row[]} blocks
 */
const caughtUpFrom = (notes, blocks) =>
  notes.map(record => versioned({ ...record, ...derivedOf(blocks.filter(item => item.canvasId === record.id)) }));

/**
 * @param {Profile} of
 * @returns {Promise<Row>}
 */
const markOf = async of => (await of.chrome.api.storage.local.get([RECORDS_CAUGHT_UP_KEY]))[RECORDS_CAUGHT_UP_KEY];

/** @param {Row[]} records */
const byId = records => [...records].sort((a, b) => (a.id < b.id ? -1 : 1));

describe("the worker's catch-up of 1.4.x's lagging records", () => {
  it('the first start after the update gives every record its blocks\' preview and to-do progress, and nothing else, once', async () => {
    const of = await updatedProfile();
    const before = byId(await recordsOf(of, 'canvases'));
    const blocks = await recordsOf(of, 'elements');
    const expected = caughtUpFrom(before, blocks);
    const lagging = expected.filter((record, index) => JSON.stringify(record) !== JSON.stringify(versioned(before[index])));
    assert.ok(lagging.length >= 3, `${lagging.length} lagging records`);

    const first = createWorkerClient(hostOf(of));
    assert.equal((await first.migration.done).status, 'current');
    assert.deepEqual(await first.recordsCatchUp.done, { status: 'done', caughtUp: lagging.length });
    const after = byId(await recordsOf(of, 'canvases'));
    assert.deepEqual(after.map(versioned), expected);
    const typed = after[0];
    assert.equal(typed.name, 'Typed by hand');
    assert.equal(typed.titleManuallySet, true);
    assert.deepEqual(
      after.map(record => record.updatedAt),
      before.map(record => record.updatedAt),
    );
    assert.deepEqual(await recordsOf(of, 'elements'), blocks);
    const mark = await markOf(of);
    assert.equal(mark.done, true);
    assert.equal(typeof mark.at, 'number');

    // A record that lags again, as no 1.4.x tab can leave one now, stays as it is: the catch-up is done
    await putRecords(of, 'canvases', [{ ...typed, preview: 'stale' }]);
    const next = createWorkerClient(hostOf(of));
    assert.deepEqual(await next.recordsCatchUp.done, { status: 'done-before', caughtUp: 0 });
    const kept = (await recordsOf(of, 'canvases')).find(record => record.id === typed.id);
    assert.equal(kept.preview, 'stale');
  });

  it('a run cut off picks up after the last note it finished, and redoes none before it', async () => {
    const of = await updatedProfile();
    const before = byId(await recordsOf(of, 'canvases'));
    const blocks = await recordsOf(of, 'elements');
    const expected = caughtUpFrom(before, blocks);
    const after = before[1].id;
    await of.chrome.api.storage.local.set({ [RECORDS_CAUGHT_UP_KEY]: { done: false, after } });
    /** @type {Row[]} */
    const writes = [];

    const worker = createWorkerClient(hostOf(of, writes));
    const lagging = expected.filter(
      (record, index) => record.id > after && JSON.stringify(record) !== JSON.stringify(versioned(before[index])),
    );
    assert.deepEqual(await worker.recordsCatchUp.done, { status: 'done', caughtUp: lagging.length });
    const now = byId(await recordsOf(of, 'canvases'));
    assert.deepEqual(
      now.filter(record => record.id <= after),
      before.filter(record => record.id <= after),
    );
    assert.deepEqual(
      now.filter(record => record.id > after).map(versioned),
      expected.filter(record => record.id > after),
    );
    const marks = writes.filter(items => RECORDS_CAUGHT_UP_KEY in items).map(items => items[RECORDS_CAUGHT_UP_KEY]);
    assert.deepEqual(
      marks.slice(0, -1),
      [{ done: false, after: before[before.length - 1].id }],
    );
    assert.equal(marks[marks.length - 1].done, true);
  });

  it('a batch past its bytes goes again as its first half, the batches grow back, and every record is caught up', async () => {
    const of = await updatedProfile();
    const before = byId(await recordsOf(of, 'canvases'));
    const stored = await recordsOf(of, 'elements');
    const big = { ...stored.find(item => item.canvasId === before[0].id), id: 'big-block', content: 'x'.repeat(CATCH_UP_BYTES + 1) };
    await putRecords(of, 'elements', [big]);
    const blocks = await recordsOf(of, 'elements');
    const expected = caughtUpFrom(before, blocks);
    /** @type {Row[]} */
    const writes = [];

    const worker = createWorkerClient(hostOf(of, writes));
    const lagging = expected.filter((record, index) => JSON.stringify(record) !== JSON.stringify(versioned(before[index])));
    assert.deepEqual(await worker.recordsCatchUp.done, { status: 'done', caughtUp: lagging.length });
    assert.deepEqual(byId(await recordsOf(of, 'canvases')).map(versioned), expected);
    // The first note alone, then two, then the rest
    const ids = before.map(record => record.id);
    const marks = writes.filter(items => RECORDS_CAUGHT_UP_KEY in items).map(items => items[RECORDS_CAUGHT_UP_KEY]);
    assert.deepEqual(
      marks.slice(0, -1).map(mark => mark.after),
      [ids[0], ids[2], ids[ids.length - 1]],
    );
  });
});
