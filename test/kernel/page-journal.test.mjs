// #35 slice 3b's journal on a page: the shim every page's client goes through
// (composition/host.js, journalingClient), and the lazy journal chunk's start
// (composition/journal-chunk.js, startPageJournal). The shim loads the chunk on the first
// journaled command or at idle after the page's first read, whichever comes first, and holds no
// command for it, so the window with no journal is the first save at most, which the close-time
// draft still covers (the lead's addition to 3b's plan). The chunk's start applies the editor
// saves a closed page left (core/application/journal-apply.js), and wakes the worker's drain for
// an entry the worker replays. A profile with no journal opens nothing and makes none.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { inContextStores } from '../../js/kernel/adapters/in-context.js';
import { journalingClient } from '../../js/kernel/composition/host.js';
import { startPageJournal } from '../../js/kernel/composition/journal-chunk.js';
import { createJournaling } from '../../js/kernel/core/application/journaling.js';
import { blockDigest } from '../../js/kernel/core/domain/close-draft.js';
import { UNTOLD_KEY } from '../../js/kernel/core/domain/close-draft-keys.js';
import { DRAIN_MESSAGE, journalEntry } from '../../js/kernel/core/domain/journal.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createMemoryJournal } from '../../js/kernel/core/memory/journal.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { legacyEnv } from './storage-fixture.mjs';
import { faultyFactory } from './storage-faults.mjs';
import { CALLERS, NOW, testClock, testIds } from './support.mjs';
import { createKernel } from './test-kernel.mjs';

/** @typedef {import('../../js/kernel/core/domain/close-draft.js').CloseDraft} CloseDraft */
/** @typedef {any} Row */

const { IDBFactory } = createRequire(import.meta.url)('fake-indexeddb');

/** Lets every promise and timer queued now run */
const tick = () => new Promise(resolve => setImmediate(resolve));

/**
 * A new tab's client as its root hands it out, on a memory kernel, logging each command it sends
 */
function pageClient() {
  const adapter = createMemoryAdapter();
  const clock = testClock();
  const kernel = createKernel({
    adapter,
    policy: createBaselinePolicy(),
    caller: CALLERS.newtab,
    ids: testIds('page'),
    clock,
  });
  /** @type {string[]} the commandId of each command the kernel was handed, in order */
  const sent = [];
  /** @type {import('../../js/kernel/composition/host.js').Client} */
  const client = /** @type {any} */ (
    Object.freeze({
      /** @param {any} command */
      execute: command => {
        sent.push(command.commandId);
        return kernel.execute(command);
      },
      query: kernel.query,
      subscribe: kernel.subscribe,
      whenReady: kernel.whenReady,
      ids: testIds('client'),
    })
  );
  /** @param {string} noteId */
  const blocksOf = noteId => adapter.read(['blocks'], tx => tx.getAllByIndex('blocks', 'canvasId', noteId));
  /** @param {string} noteId */
  const revisionOf = noteId =>
    adapter.read(['notes'], async tx => {
      await tx.get('notes', noteId);
      return tx.versions('notes', noteId)?.revision ?? 0;
    });
  return { adapter, clock, kernel, client, sent, blocksOf, revisionOf };
}

/**
 * Note A, made through the kernel itself: a1 and a2
 * @param {ReturnType<typeof pageClient>} p
 */
async function noteA(p) {
  const made = await p.kernel.execute({
    type: 'createNote',
    commandId: 'c-make-a',
    noteId: 'A',
    name: 'Alpha plan',
    blocks: [
      { id: 'a1', type: 'text', content: 'alpha', order: 0 },
      { id: 'a2', type: 'text', content: 'alpha two', order: 1 },
    ],
  });
  assert.equal(made.kind, 'committed', JSON.stringify(made));
}

/**
 * An editor's save of note A's a1
 * @param {string} commandId
 * @param {string} text
 * @returns {any}
 */
const saveOfA = (commandId, text) => ({
  type: 'saveNoteContent',
  commandId,
  noteId: 'A',
  blocks: [{ id: 'a1', type: 'text', content: text, order: 0 }],
  deriveFromStored: true,
});

/**
 * The chunk as a test loads it: its start gives the page's journaling on `journal`, and says
 * when it started
 * @param {ReturnType<typeof createMemoryJournal>} journal
 * @param {{now(): number}} clock
 * @param {number[]} [started]
 */
const chunkOn = (journal, clock, started = []) => ({
  /** @param {{sessionId: string, surface: any}} options */
  startPageJournal: ({ sessionId, surface }) => {
    started.push(Date.now());
    const journaling = createJournaling({
      journal,
      locks: /** @type {any} */ (legacyEnv.createLockManager()),
      sessionId,
      surface,
      clock,
    });
    return { ...journaling, applied: Promise.resolve(null) };
  },
});

describe("a page's journal shim and chunk (#35 slice 3b)", () => {
  it("sends the first journaled command at once, unjournaled, and starts the journal's load, holds no command for it, and journals a save once it's in (the lead's early window)", async () => {
    const p = pageClient();
    await noteA(p);
    const journal = createMemoryJournal();
    let loads = 0;
    /** @type {(chunk: unknown) => void} */
    let deliver = () => {};
    const loading = new Promise(resolve => {
      deliver = resolve;
    });
    const client = journalingClient(p.client, {
      surface: 'newtab',
      sessionId: 'page-1',
      load: () => {
        loads += 1;
        return /** @type {any} */ (loading);
      },
      // A page that doesn't go idle here
      requestIdle: () => {},
    });
    // A command the catalog doesn't journal loads nothing
    const renamed = await client.execute({ type: 'renameNote', commandId: 'c-rename', noteId: 'A', name: 'Renamed' });
    assert.equal(renamed.kind, 'committed');
    assert.equal(loads, 0);
    // The first save goes out in the task that sends it, unjournaled, and starts the load
    const first = client.execute(saveOfA('c-save-1', 'alpha, one'));
    assert.deepEqual(p.sent, ['c-rename', 'c-save-1']);
    assert.equal(loads, 1);
    // So does a save sent while it loads: none waits for it, since one held could go out after a
    // later command and write older text over it
    const second = client.execute(saveOfA('c-save-2', 'alpha, two'));
    assert.deepEqual(p.sent, ['c-rename', 'c-save-1', 'c-save-2']);
    assert.equal(loads, 1, 'one load');
    assert.equal((await first).kind, 'committed');
    assert.equal((await second).kind, 'committed');
    assert.deepEqual(journal.entries(), []);

    // Once it's in, a save is journaled: its entry is written before it's sent, and goes once it
    // commits
    deliver(chunkOn(journal, p.clock));
    await tick();
    await tick();
    const third = client.execute(saveOfA('c-save-3', 'alpha, three'));
    assert.deepEqual(
      journal.entries().map(entry => entry.opId),
      ['c-save-3'],
    );
    assert.equal(p.sent.at(-1), 'c-save-3');
    assert.equal((await third).kind, 'committed');
    assert.deepEqual(journal.entries(), []);
    assert.equal(loads, 1);
    // With what its caller tells of it: an editor save's draft and pane
    const draft = /** @type {any} */ ({ v: 1, id: 'c-save-4', noteId: 'A', blocks: [], deletedBlockIds: [] });
    const fourth = client.execute(saveOfA('c-save-4', 'alpha, four'), { draft, pane: 'main' });
    assert.deepEqual(
      journal.entries().map(entry => [entry.opId, entry.draft, entry.pane]),
      [['c-save-4', draft, 'main']],
    );
    assert.equal((await fourth).kind, 'committed');
  });

  it("loads the journal at idle once the page's first read is in, never before it, and within 3 s of it when the page doesn't go idle (the lead's bound)", async () => {
    const p = pageClient();
    await noteA(p);
    /** @type {unknown[]} */
    const asked = [];
    /** @type {number[]} */
    const started = [];
    let loads = 0;
    // A first read that's answered only when the test says
    /** @type {() => void} */
    let answer = () => {};
    const answered = new Promise(resolve => {
      answer = () => resolve(undefined);
    });
    /** @type {import('../../js/kernel/composition/host.js').Client} */
    const slow = /** @type {any} */ ({
      ...p.client,
      query: (/** @type {any} */ query) => answered.then(() => p.client.query(query)),
    });
    const client = journalingClient(slow, {
      surface: 'newtab',
      sessionId: 'page-1',
      load: async () => {
        loads += 1;
        return /** @type {any} */ (chunkOn(createMemoryJournal(), p.clock, started));
      },
      // A page kept busy past the cap: requestIdleCallback calls back at its timeout
      requestIdle: (/** @type {() => void} */ callback, /** @type {{timeout?: number} | undefined} */ options) => {
        asked.push(options);
        setTimeout(callback, options?.timeout ?? 0);
      },
    });
    await tick();
    await tick();
    assert.deepEqual([asked, loads], [[], 0], 'nothing before the first read');
    const reading = client.query({ type: 'listNotes', view: 'active' });
    await tick();
    assert.deepEqual([asked, loads], [[], 0], 'nor while it reads');
    answer();
    const read = await reading;
    const readAt = Date.now();
    assert.equal(read.kind, 'ready');
    await tick();
    assert.deepEqual(asked, [{ timeout: 2000 }]);
    for (let waited = 0; started.length === 0 && waited < 3500; waited += 50) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(started.length, 1, 'started once');
    assert.ok(started[0] - readAt < 3000, `started ${started[0] - readAt} ms after the first read`);
    assert.equal(loads, 1);
  });

  it('opens no journal and makes none on a profile that has none, and applies nothing', async () => {
    const real = new IDBFactory();
    const faults = faultyFactory(real);
    const p = pageClient();
    const started = startPageJournal({
      client: p.client,
      sessionId: 'page-1',
      surface: 'newtab',
      stores: inContextStores({ indexedDB: faults.factory }),
      locks: legacyEnv.createLockManager(),
      storage: legacyEnv.createLocalStorage(),
      runtime: { sendMessage: async () => {} },
      clock: p.clock,
    });
    assert.equal(await started.applied, null);
    assert.deepEqual(faults.connections, []);
    assert.deepEqual(await real.databases(), []);
    assert.deepEqual(p.sent, []);
  });

  it("applies the editor saves a closed page left, tells a recovered note to the toasts' list, and wakes the worker's drain once for the entries it replays, and only then", async () => {
    const real = new IDBFactory();
    const faults = faultyFactory(real);
    const p = pageClient();
    await noteA(p);
    // A closed page's save of a1, on a1 as it saw it commit, which another tab has changed since
    const [a1] = (await p.blocksOf('A')).filter((/** @type {Row} */ block) => block.id === 'a1');
    const revision = await p.revisionOf('A');
    const save = saveOfA('c-save', 'alpha, the older edit');
    /** @type {CloseDraft} */
    const draft = {
      v: 1,
      id: 'c-save',
      page: 'page-gone',
      noteId: 'A',
      at: NOW,
      base: { revision, updatedAt: null, issued: [], name: 'Alpha plan', blocks: { a1: blockDigest(a1, 'A') } },
      blocks: save.blocks.map((/** @type {Row} */ block) => ({ ...block, canvasId: 'A' })),
      deletedBlockIds: [],
      preview: 'alpha, the older edit',
      todoProgress: null,
      linkedNames: [],
    };
    const newer = await p.kernel.execute(saveOfA('c-other-tab', 'alpha, a newer edit'));
    assert.equal(newer.kind, 'committed');
    const writer = inContextStores({ indexedDB: real }).journal();
    await writer.open();
    /** @param {any} command @param {number} seq @param {CloseDraft} [withDraft] */
    const left = (command, seq, withDraft) =>
      journalEntry({
        command,
        v: 1,
        noteId: command.noteId,
        surface: 'newtab',
        ownerSessionId: 'page-gone',
        seq,
        createdAt: NOW,
        draft: withDraft,
        pane: withDraft ? 'main' : undefined,
      });
    await writer.put(left(save, 1, draft));
    writer.close();
    /** @type {unknown[]} */
    const messages = [];
    const runtime = {
      sendMessage: async (/** @type {unknown} */ message) => {
        messages.push(message);
      },
    };
    const storage = legacyEnv.createLocalStorage();
    const started = startPageJournal({
      client: p.client,
      sessionId: 'page-1',
      surface: 'newtab',
      stores: inContextStores({ indexedDB: faults.factory }),
      locks: legacyEnv.createLockManager(),
      storage,
      runtime,
      clock: p.clock,
    });
    const result = await started.applied;
    assert.deepEqual(result?.recovered, [{ noteId: 'A', recoveredId: 'c-save-recovered' }]);
    assert.deepEqual(p.sent, ['c-save-apply']);
    assert.deepEqual(JSON.parse(storage.getItem(UNTOLD_KEY) || 'null'), [{ id: 'c-save-recovered', of: 'A' }]);
    // Every entry it found was the pages' to apply, so it leaves the worker's drain be
    assert.deepEqual(messages, []);

    // Quick notes a closed page left are the worker's to replay: the next page wakes its drain, once
    const more = inContextStores({ indexedDB: real }).journal();
    await more.open();
    for (const [seq, id] of /** @type {const} */ ([
      [2, 'c-quick'],
      [3, 'c-quick-2'],
    ])) {
      await more.put(
        left(
          {
            type: 'createNote',
            commandId: id,
            noteId: `n-${id}`,
            name: 'Call the plumber',
            blocks: [{ id: `n-${id}-b1`, type: 'text', content: 'Call the plumber' }],
          },
          seq,
        ),
      );
    }
    // And a save whose draft no page can apply, which the apply leaves to the worker too
    await more.put(left(saveOfA('c-bad', 'alpha, typed'), 4, /** @type {any} */ ({ v: 1, id: 'c-bad' })));
    more.close();
    const next = startPageJournal({
      client: p.client,
      sessionId: 'page-2',
      surface: 'newtab',
      stores: inContextStores({ indexedDB: faults.factory }),
      locks: legacyEnv.createLockManager(),
      storage,
      runtime,
      clock: p.clock,
    });
    assert.deepEqual((await next.applied)?.saved, []);
    assert.deepEqual(messages, [{ type: DRAIN_MESSAGE }]);
    assert.deepEqual(p.sent, ['c-save-apply']);
    // The quick notes are still there, for the worker, and the save without its draft
    const reader = inContextStores({ indexedDB: real }).journal();
    await reader.open();
    const kept = await reader.list();
    reader.close();
    assert.deepEqual(
      kept.map(entry => [entry.opId, entry.draft]),
      [
        ['c-quick', undefined],
        ['c-quick-2', undefined],
        ['c-bad', undefined],
      ],
    );
    // A page that finds only the worker's entries, with nothing to apply, wakes its drain too
    const third = startPageJournal({
      client: p.client,
      sessionId: 'page-3',
      surface: 'newtab',
      stores: inContextStores({ indexedDB: faults.factory }),
      locks: legacyEnv.createLockManager(),
      storage,
      runtime,
      clock: p.clock,
    });
    assert.equal(await third.applied, null);
    assert.deepEqual(messages, [{ type: DRAIN_MESSAGE }, { type: DRAIN_MESSAGE }]);
  });

  it("issues a journaled command's entry in the task that sends it, once the journal is open", async () => {
    const real = new IDBFactory();
    const faults = faultyFactory(real);
    const p = pageClient();
    await noteA(p);
    // A journal an earlier page made, with nothing left in it
    const writer = inContextStores({ indexedDB: real }).journal();
    await writer.open();
    writer.close();
    const started = startPageJournal({
      client: p.client,
      sessionId: 'page-1',
      surface: 'newtab',
      stores: inContextStores({ indexedDB: faults.factory }),
      locks: legacyEnv.createLockManager(),
      storage: legacyEnv.createLocalStorage(),
      runtime: { sendMessage: async () => {} },
      clock: p.clock,
    });
    assert.equal(await started.applied, null);
    assert.equal(await started.ready, true);
    const before = faults.transactions.length;
    const answer = started.execute(saveOfA('c-save', 'alpha, edited'), p.client.execute);
    // Both before execute() returned: the entry's transaction, and the save sent
    assert.deepEqual(
      faults.transactions.slice(before).map(tx => [tx.names, tx.mode]),
      [[['entries'], 'readwrite']],
    );
    assert.deepEqual(p.sent, ['c-save']);
    assert.equal((await answer).kind, 'committed');
  });
});
