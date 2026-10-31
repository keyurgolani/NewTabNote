// #17 PR 1a, "Security and privacy": the canary scan. The AI key a v1.0.0 to v1.1.2 profile
// keeps in plaintext in IndexedDB `settings`, and the one later profiles keep in
// chrome.storage.local, never reach a recovery point, a receipt, an outcome, or a log line,
// on a clean run, a stopped one, or a failing one. And no note content reaches a receipt, a
// point's record or manifest, an outcome, or a log line, for any fixture.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Killed, dump, profileWith, recordsIn, run, stringsIn, synthesized } from './migration-support.mjs';
import { adapterOn, closeAll, kernelOn, profile, recordsOf } from './storage-fixture.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';

const FIXTURES = synthesized();
const CANARY = 'canary-llm-api-key';
const SMALL = Object.freeze({ records: 2, bytes: 2 * 1024 * 1024 });

/**
 * Everything a run leaves that must hold no secret: the recovery database whole, the
 * receipts, the outcomes, and the log lines
 * @param {import('./migration-support.mjs').Profile} of
 * @param {unknown[]} outcomes
 */
async function leftBehind(of, outcomes) {
  const dumped = await dump(of);
  return JSON.stringify({
    recovery: dumped.databases.filter(db => db.name === 'NewTabNoteRecovery'),
    receipts: recordsIn(dumped, 'CanvasTabDB', 'migrations'),
    meta: recordsIn(dumped, 'CanvasTabDB', 'meta'),
    outcomes,
    logs: of.logs,
  });
}

describe('the canary scan', () => {
  for (const id of ['v2-idb-settings.idb-settings-secret', 'v2-local-settings.basic']) {
    it(`${id}: the key stays where it was and reaches no point, receipt, outcome, or log line`, async () => {
      const of = await profileWith(/** @type {any} */ (FIXTURES.get(id)));
      const before = await dump(of);
      assert.ok(JSON.stringify(before).includes(CANARY), 'the fixture holds its canary');
      const outcomes = [await run(of), await run(of)];
      assert.equal(outcomes[0].status, 'migrated');
      assert.equal((await leftBehind(of, outcomes)).includes(CANARY), false);
      // Still where it was, untouched
      const after = await dump(of);
      assert.deepStrictEqual(recordsIn(after, 'CanvasTabDB', 'settings'), recordsIn(before, 'CanvasTabDB', 'settings'));
      assert.deepStrictEqual(after.chromeStorageLocal, before.chromeStorageLocal);
    });
  }

  it('stopped at every step and failing on space or verification, the key reaches nothing either', async () => {
    const fixture = /** @type {any} */ (FIXTURES.get('v2-idb-settings.idb-settings-secret'));
    for (let at = 1; at < 40; at++) {
      const of = await profileWith(fixture);
      let stops = 0;
      const outcomes = [
        await run(of, {
          limits: SMALL,
          hooks: {
            between: () => {
              if (++stops === at) throw new Killed();
            },
          },
        }),
      ];
      outcomes.push(await run(of, { limits: SMALL }));
      assert.equal((await leftBehind(of, outcomes)).includes(CANARY), false, `stopped at ${at}`);
      if (stops < at) break;
    }
    const short = await profileWith(fixture);
    const blocked = await run(short, { estimate: async () => ({ quota: 1, usage: 0 }) });
    assert.equal(blocked.status, 'space-blocked');
    assert.equal((await leftBehind(short, [blocked])).includes(CANARY), false);
  });
});

describe('no content in receipts, manifests, outcomes, or logs', () => {
  for (const [id, fixture] of FIXTURES) {
    it(id, async () => {
      // Every text a note, block, folder, or snapshot holds, long enough to mean something
      const content = new Set(
        fixture.databases
          .flatMap((/** @type {any} */ db) => db.stores)
          .filter((/** @type {any} */ store) => !['meta', 'migrations'].includes(store.name))
          .flatMap((/** @type {any} */ store) => store.records.map((/** @type {any} */ record) => record.value))
          .flatMap((/** @type {any} */ value) =>
            ['name', 'content', 'title', 'imageUrl', 'fileData', 'url'].map(field => value && value[field]),
          )
          .filter((/** @type {unknown} */ text) => typeof text === 'string' && text.length >= 4),
      );
      const of = await profileWith(fixture);
      const outcomes = [await run(of), await run(of)];
      const dumped = await dump(of);
      const points = recordsIn(dumped, 'NewTabNoteRecovery', 'points').map(record => record.value);
      const said = stringsIn({
        receipts: recordsIn(dumped, 'CanvasTabDB', 'migrations'),
        points,
        progress: recordsIn(dumped, 'NewTabNoteRecovery', 'progress'),
        outcomes,
        logs: of.logs,
      });
      for (const text of said) assert.equal(content.has(text), false, `"${text}" left the notes`);
    });
  }
});

describe("no note text in #17 PR 2a's ledger, change log, tombstones, or meta", () => {
  it('commands that carry canaries in titles, blocks, captures, and URLs leave them only in the notes and in conflict records', async () => {
    const of = profile();
    try {
      const adapter = adapterOn(of, { clock: testClock() });
      await adapter.open();
      const runtime = { ids: testIds(), clock: testClock() };
      const tab = kernelOn(adapter, runtime);
      const worker = kernelOn(adapter, runtime, CALLERS['worker-internal']);
      const text = (/** @type {string} */ where) => `canary-note-text-${where}`;
      const block = (/** @type {string} */ id, /** @type {string} */ where) => ({
        id,
        type: 'text',
        content: text(where),
        order: 0,
      });
      /** @type {unknown[]} */
      const outcomes = [];
      /** @param {Promise<unknown>} sent */
      const keep = async sent => outcomes.push(await sent);
      await keep(
        tab.execute({
          type: 'createNote',
          commandId: 'c1',
          noteId: 'n1',
          name: text('title'),
          blocks: [block('b1', 'block')],
        }),
      );
      await keep(tab.execute({ type: 'renameNote', commandId: 'c2', noteId: 'n1', name: text('renamed') }));
      await keep(
        tab.execute({
          type: 'saveNoteContent',
          commandId: 'c3',
          noteId: 'n1',
          blocks: [block('b1', 'saved')],
          name: text('saved-title'),
        }),
      );
      await keep(
        tab.execute({ type: 'attachInsights', commandId: 'c4', noteId: 'n1', insights: { todos: [text('insight')] } }),
      );
      await keep(
        worker.execute({
          type: 'captureToDailyNote',
          commandId: 'c5',
          noteId: 'd1',
          blockId: 'k1',
          capture: { type: 'bookmark', url: `https://example.test/${text('url')}`, title: text('page') },
        }),
      );
      await keep(
        tab.execute({
          type: 'saveNoteContent',
          commandId: 'c6',
          noteId: 'n1',
          blocks: [block('b1', 'lost')],
          expectedRevision: 1,
        }),
      );
      await keep(tab.execute({ type: 'createNote', commandId: 'c7', noteId: 'n2' }));
      await keep(tab.execute({ type: 'trashNote', commandId: 'c8', noteId: 'n2' }));
      const conflict = /** @type {{kind: string}} */ (outcomes[5]);
      assert.equal(conflict.kind, 'conflict');
      for (const store of ['operations', 'changes', 'tombstones', 'meta']) {
        const kept = JSON.stringify(await recordsOf(of, store));
        assert.ok(kept.length > 2, `${store} holds rows`);
        assert.equal(kept.includes('canary-note-text'), false, `${store} holds note text`);
      }
      assert.equal(JSON.stringify(outcomes).includes('canary-note-text'), false, 'an outcome holds note text');
      // The conflict record keeps the save that lost, text and all, by design
      assert.ok(JSON.stringify(await recordsOf(of, 'conflicts')).includes(text('lost')));
    } finally {
      closeAll(of);
    }
  });
});
