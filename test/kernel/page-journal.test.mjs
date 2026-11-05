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
import { COMMANDS } from '../../js/kernel/core/contracts/commands.js';
import { blockDigest } from '../../js/kernel/core/domain/close-draft.js';
import { DRAFTS_LOCK, UNTOLD_KEY } from '../../js/kernel/core/domain/close-draft-keys.js';
import { DRAIN_MESSAGE, journalEntry } from '../../js/kernel/core/domain/journal.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createMemoryJournal } from '../../js/kernel/core/memory/journal.js';
import { createMemoryLedger } from '../../js/kernel/core/memory/ledger.js';
import { applyCloseDrafts, closeDraftStore } from '../../js/kernel/core/application/close-drafts.js';
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
 * @param {{ledger?: ReturnType<typeof createMemoryLedger>}} [options] - the ledger its adapter keeps, if any
 */
function pageClient({ ledger } = {}) {
  const adapter = createMemoryAdapter(ledger ? { ledger } : {});
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
  /** @param {unknown} client @param {string} sessionId @param {any} surface */
  startPageJournal: (client, sessionId, surface) => {
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
    const client = journalingClient(
      p.client,
      'newtab',
      () => {
        loads += 1;
        return /** @type {any} */ (loading);
      },
      // A page that doesn't go idle here
      () => {},
      'page-1',
    );
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
    const client = journalingClient(
      slow,
      'newtab',
      async () => {
        loads += 1;
        return /** @type {any} */ (chunkOn(createMemoryJournal(), p.clock, started));
      },
      // A page kept busy past the cap: requestIdleCallback calls back at its timeout
      (/** @type {() => void} */ callback, /** @type {{timeout?: number} | undefined} */ options) => {
        asked.push(options);
        setTimeout(callback, options?.timeout ?? 0);
      },
      'page-1',
    );
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
    const started = startPageJournal(p.client, 'page-1', 'newtab', {
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
    const started = startPageJournal(p.client, 'page-1', 'newtab', {
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
    const next = startPageJournal(p.client, 'page-2', 'newtab', {
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
    const third = startPageJournal(p.client, 'page-3', 'newtab', {
      stores: inContextStores({ indexedDB: faults.factory }),
      locks: legacyEnv.createLockManager(),
      storage,
      runtime,
      clock: p.clock,
    });
    assert.equal(await third.applied, null);
    assert.deepEqual(messages, [{ type: DRAIN_MESSAGE }, { type: DRAIN_MESSAGE }]);
  });

  it("loads no apply, takes no DRAFTS_LOCK and wakes no drain for an editor save the apply leaves: a newer build's, or one the worker holds under a tombstone it keeps for (R191's finding 4)", async () => {
    for (const kind of /** @type {const} */ (['newer', 'held'])) {
      const real = new IDBFactory();
      const faults = faultyFactory(real);
      const p = pageClient();
      await noteA(p);
      const save = saveOfA(`c-${kind}`, `alpha, ${kind}`);
      const entry = journalEntry({
        command: save,
        v: COMMANDS.saveNoteContent.version + (kind === 'newer' ? 1 : 0),
        noteId: 'A',
        surface: 'newtab',
        ownerSessionId: 'page-gone',
        seq: 1,
        createdAt: NOW,
        draft: /** @type {any} */ ({ v: 1, id: save.commandId, noteId: 'A' }),
        pane: 'main',
      });
      const writer = inContextStores({ indexedDB: real }).journal();
      await writer.open();
      await writer.put(kind === 'held' ? { ...entry, unreplayable: { code: 'note-deleted', at: NOW } } : entry);
      writer.close();
      /** @type {string[]} the name of each Web Lock the page asked for */
      const requested = [];
      const pageLocks = legacyEnv.createLockManager();
      const locks = {
        /**
         * @template T
         * @param {string} name
         * @param {{mode: 'exclusive'}} options
         * @param {() => Promise<T>} callback
         * @returns {Promise<T>}
         */
        request: (name, options, callback) => {
          requested.push(name);
          return pageLocks.request(name, options, callback);
        },
        query: () => pageLocks.query(),
      };
      /** @type {unknown[]} */
      const messages = [];
      const started = startPageJournal(p.client, 'page-1', 'newtab', {
        stores: inContextStores({ indexedDB: faults.factory }),
        locks,
        storage: legacyEnv.createLocalStorage(),
        runtime: {
          sendMessage: async (/** @type {unknown} */ message) => {
            messages.push(message);
          },
        },
        clock: p.clock,
      });
      assert.equal(await started.applied, null, `${kind}: no apply`);
      assert.equal(requested.includes(DRAFTS_LOCK), false, `${kind}: no DRAFTS_LOCK`);
      assert.deepEqual(messages, [], `${kind}: the drain has nothing to do for it`);
      assert.deepEqual(p.sent, [], kind);
    }
  });

  it("journals journal.append-failed to the page's failure events, with the entry's note and the failure, for an entry its journal couldn't take, and still sends the command (#35 slice 4a)", async () => {
    const real = new IDBFactory();
    const faults = faultyFactory(real);
    const p = pageClient();
    await noteA(p);
    /** @type {Array<[string, unknown, unknown]>} */
    const seen = [];
    const started = startPageJournal(p.client, 'page-1', 'newtab', {
      stores: inContextStores({ indexedDB: faults.factory }),
      locks: legacyEnv.createLockManager(),
      storage: legacyEnv.createLocalStorage(),
      runtime: { sendMessage: async () => {} },
      clock: p.clock,
      events: { event: (code, fields, failure) => seen.push([code, fields, failure]) },
    });
    assert.equal(await started.ready, true);
    // The disk refuses the entry's transaction as it commits
    const refused = faults.abortAfterNextWrite('entries', 'QuotaExceededError');
    const answer = started.execute(saveOfA('c-save', 'alpha, edited'), p.client.execute);
    await refused;
    assert.equal((await answer).kind, 'committed');
    assert.deepEqual(p.sent, ['c-save']);
    for (let round = 0; round < 5 && seen.length === 0; round++) await tick();
    assert.deepEqual(
      seen.map(([code, fields]) => [code, fields]),
      [['journal.append-failed', { subjectId: 'A' }]],
    );
    assert.ok(seen[0][2] && typeof seen[0][2] === 'object', 'the failure, whose code the event keeps');
  });

  it("hands the page's failure events to the chunk's start, which a root without them leaves out (#35 slice 4a)", async () => {
    const p = pageClient();
    /** @type {unknown[]} */
    const handed = [];
    const chunk = {
      /** @param {unknown} client @param {string} sessionId @param {unknown} surface @param {unknown} [ports] */
      startPageJournal: (client, sessionId, surface, ports) => {
        handed.push(ports);
        return { execute: (/** @type {any} */ command, /** @type {any} */ send) => send(command) };
      },
    };
    const events = { event: () => {} };
    const withEvents = journalingClient(
      p.client,
      'newtab',
      async () => /** @type {any} */ (chunk),
      undefined,
      'page-1',
      events,
    );
    await withEvents.execute(saveOfA('c-1', 'alpha one'));
    await tick();
    const without = journalingClient(p.client, 'popup', async () => /** @type {any} */ (chunk), undefined, 'page-2');
    await without.execute(saveOfA('c-2', 'alpha two'));
    await tick();
    assert.equal(handed.length, 2);
    assert.equal(/** @type {any} */ (handed[0])?.events, events);
    assert.equal(/** @type {any} */ (handed[1])?.events, undefined);
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
    const started = startPageJournal(p.client, 'page-1', 'newtab', {
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

describe("the journal entries a close-time draft's close covered (#6, #191's known limit 2)", () => {
  /** What the closed page's pane wrote of note A's block `id`, a1 unless named, on it as stored, before its close */
  const baseOf = async (/** @type {ReturnType<typeof pageClient>} */ p, id = 'a1') => {
    const [row] = (await p.blocksOf('A')).filter((/** @type {Row} */ block) => block.id === id);
    return { revision: await p.revisionOf('A'), updatedAt: null, issued: [], name: 'Alpha plan', blocks: { [id]: blockDigest(row, 'A') }, issuedSaves: [] };
  };

  /**
   * An editor save of `noteId`'s block `block`, its first unless named, that page `page`'s pane
   * `pane` left in the journal, with its draft on `base`, as 3b's journaling writes one
   * @param {string} opId
   * @param {{noteId?: string, page?: string, pane?: string, seq?: number, base?: Row, text?: string, v?: number, block?: string, order?: number}} [options]
   */
  const leftBy = (
    opId,
    { noteId = 'A', page = 'page-w1', pane = 'pane-1', seq = 1, base = {}, text = 'typed', v = 1, block = `${noteId.toLowerCase()}1`, order = 0 } = {},
  ) => {
    const blocks = [{ id: block, type: 'text', content: text, order }];
    const command = { type: 'saveNoteContent', commandId: opId, noteId, blocks, deriveFromStored: true };
    return journalEntry({
      command: /** @type {any} */ (command),
      v,
      noteId,
      surface: 'newtab',
      ownerSessionId: 'page-gone',
      seq,
      createdAt: NOW,
      draft: /** @type {any} */ ({
        v: 1,
        id: opId,
        page,
        noteId,
        at: NOW,
        base: { revision: 0, updatedAt: null, issued: [], blocks: {}, issuedSaves: [], ...base },
        blocks: blocks.map(block => ({ ...block, canvasId: noteId })),
        deletedBlockIds: [],
        preview: text,
        todoProgress: null,
        linkedNames: [],
      }),
      pane,
    });
  };

  /**
   * The close-time draft page `page-w1`'s pane `pane-1` wrote of note A at its close, on `base`
   * @param {Row} base
   * @param {string} text
   */
  const closingDraft = (base, text) => ({
    v: 1,
    id: 'c-closing',
    page: 'page-w1',
    pane: 'pane-1',
    noteId: 'A',
    at: NOW + 1,
    base,
    blocks: [{ id: 'a1', type: 'text', content: text, order: 0, canvasId: 'A' }],
    deletedBlockIds: [],
    preview: text,
    todoProgress: null,
    linkedNames: [],
  });

  /** journal-chunk.js's forgetCovered, read as the module has it, so a build without it reads as one */
  const forgetOf = async () => /** @type {any} */ (await import('../../js/kernel/composition/journal-chunk.js')).forgetCovered;

  /** The opIds the journal on `real` holds, sorted */
  const opIdsIn = async (/** @type {IDBFactory} */ real) => {
    const reader = inContextStores({ indexedDB: real }).journal();
    await reader.open();
    const ids = (await reader.list()).map(entry => entry.opId).sort();
    reader.close();
    return ids;
  };

  it("forgetCovered takes the editor saves of the draft's note from its page and pane, and leaves another page's, another pane's, another note's, a newer build's and one the worker holds", async () => {
    const real = new IDBFactory();
    const writer = inContextStores({ indexedDB: real }).journal();
    await writer.open();
    const entries = [
      leftBy('c-own-1', { seq: 1 }),
      leftBy('c-own-2', { seq: 2 }),
      leftBy('c-other-page', { page: 'page-w2', seq: 3 }),
      leftBy('c-other-pane', { pane: 'pane-2', seq: 4 }),
      leftBy('c-other-note', { noteId: 'B', seq: 5 }),
      leftBy('c-newer', { v: COMMANDS.saveNoteContent.version + 1, seq: 6 }),
      { ...leftBy('c-held', { seq: 7 }), unreplayable: { code: 'note-deleted', at: NOW } },
    ];
    for (const entry of entries) await writer.put(entry);
    writer.close();
    const forgetCovered = await forgetOf();
    await forgetCovered(closingDraft({}, 'alpha, typed as the tab closed'), inContextStores({ indexedDB: real }));
    assert.deepEqual(await opIdsIn(real), ['c-held', 'c-newer', 'c-other-note', 'c-other-page', 'c-other-pane']);
  });

  it('forgetCovered opens nothing on a profile with no journal, and makes none', async () => {
    const real = new IDBFactory();
    const faults = faultyFactory(real);
    const forgetCovered = await forgetOf();
    await forgetCovered(closingDraft({}, 'alpha, typed as the tab closed'), inContextStores({ indexedDB: faults.factory }));
    assert.deepEqual(faults.connections, []);
    assert.deepEqual(await real.databases(), []);
  });

  it("forgetCovered resolves when the journal can't open, and leaves its entries, and the drafts' apply goes on to the next draft, whose forget takes its own pane's", async t => {
    const warned = t.mock.method(console, 'warn', () => {});
    const real = new IDBFactory();
    const p = pageClient();
    await noteA(p);
    const base = await baseOf(p);
    const writer = inContextStores({ indexedDB: real }).journal();
    await writer.open();
    await writer.put(leftBy('c-s1', { base, text: 'alpha, first' }));
    await writer.put(leftBy('c-t1', { pane: 'pane-2', seq: 2, base, text: 'alpha, from the other pane' }));
    writer.close();
    const storage = legacyEnv.createLocalStorage();
    storage.setItem('ntn-close-draft:c-closing', JSON.stringify(closingDraft(base, 'alpha, first and more')));
    // The same page's other pane on the note closed later, on the text the first draft saves
    const second = { ...closingDraft(base, 'alpha, first and more'), id: 'c-closing-2', pane: 'pane-2', at: NOW + 2 };
    storage.setItem('ntn-close-draft:c-closing-2', JSON.stringify(second));
    const faults = faultyFactory(real);
    faults.failNextOpen('NewTabNoteJournal', 'UnknownError');
    const forgetCovered = await forgetOf();
    const store = closeDraftStore(storage);
    // Each forget on stores of its own, as the roots' applier hands it: one closes its journal for good
    const options = {
      client: p.client,
      store,
      locks: legacyEnv.createLockManager(),
      forget: (/** @type {unknown} */ draft) => forgetCovered(draft, inContextStores({ indexedDB: faults.factory })),
    };
    const result = await applyCloseDrafts(options);
    assert.deepEqual([result.saved, result.dropped], [['A'], ['A']], 'both drafts apply');
    assert.deepEqual(await opIdsIn(real), ['c-s1'], "the first draft's entry stays, and the second's goes");
    assert.equal(store.has(), false, 'both drafts go');
    assert.deepEqual(
      warned.mock.calls.map(call => call.arguments[0]),
      ['NewTabNote journal: entries-not-forgotten'],
    );
  });

  it("at the next start, the draft of a close that died before its closing save's answer takes its pane's earlier entries before the journal's apply lists them, so the older text makes no recovered note", async () => {
    const real = new IDBFactory();
    const p = pageClient();
    await noteA(p);
    const base = await baseOf(p);
    // The closed page's pane kept a save of a1 that answered unavailable, then closed with more
    // typed, and its closing save never answered
    const writer = inContextStores({ indexedDB: real }).journal();
    await writer.open();
    await writer.put(leftBy('c-s1', { base, text: 'alpha, first' }));
    writer.close();
    const storage = legacyEnv.createLocalStorage();
    storage.setItem('ntn-close-draft:c-closing', JSON.stringify(closingDraft(base, 'alpha, first and more')));
    const locks = legacyEnv.createLockManager();
    const forgetCovered = await forgetOf();
    const stores = inContextStores({ indexedDB: real });
    const options = {
      client: p.client,
      store: closeDraftStore(storage),
      locks,
      forget: (/** @type {unknown} */ draft) => forgetCovered(draft, stores),
    };
    assert.deepEqual((await applyCloseDrafts(options)).saved, ['A']);
    const started = startPageJournal(p.client, 'page-next', 'newtab', {
      stores: inContextStores({ indexedDB: real }),
      locks,
      storage,
      runtime: { sendMessage: async () => {} },
      clock: p.clock,
    });
    const applied = await started.applied;
    assert.deepEqual(applied?.recovered ?? [], [], 'no recovered note of the older text');
    assert.deepEqual(await opIdsIn(real), []);
    const [a1] = (await p.blocksOf('A')).filter((/** @type {Row} */ block) => block.id === 'a1');
    assert.equal(a1.content, 'alpha, first and more');
    assert.equal(await p.adapter.read(['notes'], tx => tx.get('notes', 'c-s1-recovered')), undefined);
  });

  /**
   * The closed page's pane kept a save of a1 that never committed, `c-s1`, then closed with more
   * typed, and its closing save under the draft's id committed before the page could hear, or
   * never did. A page already open when it went runs its journal apply, at its first journaled
   * command or at idle, before the next start's drafts apply, or after.
   * @param {{journalFirst: boolean, closingCommitted: boolean}} order
   */
  async function closedBesideAnOpenPage({ journalFirst, closingCommitted }) {
    const real = new IDBFactory();
    const p = pageClient({ ledger: createMemoryLedger() });
    await noteA(p);
    const base = await baseOf(p);
    const writer = inContextStores({ indexedDB: real }).journal();
    await writer.open();
    await writer.put(leftBy('c-s1', { base, text: 'alpha, first' }));
    writer.close();
    // The draft knows c-s1, a save its pane issued since the base, as the editor's draft does
    const issued = blockDigest({ id: 'a1', type: 'text', content: 'alpha, first', order: 0 }, 'A');
    const draft = closingDraft({ ...base, issuedSaves: [{ blocks: { a1: issued } }] }, 'alpha, first and more');
    const storage = legacyEnv.createLocalStorage();
    storage.setItem('ntn-close-draft:c-closing', JSON.stringify(draft));
    if (closingCommitted) {
      assert.equal((await p.kernel.execute(saveOfA('c-closing', 'alpha, first and more'))).kind, 'committed');
    }
    const locks = legacyEnv.createLockManager();
    const forgetCovered = await forgetOf();
    const stores = inContextStores({ indexedDB: real });
    const drafts = () =>
      applyCloseDrafts({
        client: p.client,
        store: closeDraftStore(storage),
        locks,
        forget: (/** @type {unknown} */ closing) => forgetCovered(closing, stores),
      });
    const journal = () =>
      startPageJournal(p.client, 'page-open', 'newtab', {
        stores: inContextStores({ indexedDB: real }),
        locks,
        storage,
        runtime: { sendMessage: async () => {} },
        clock: p.clock,
      }).applied;
    let applied;
    if (journalFirst) {
      applied = await journal();
      await drafts();
    } else {
      await drafts();
      applied = await journal();
    }
    const [a1] = (await p.blocksOf('A')).filter((/** @type {Row} */ block) => block.id === 'a1');
    return {
      a1: a1.content,
      recovered: (applied?.recovered ?? []).map(made => made.recoveredId),
      made: (await p.adapter.read(['notes'], tx => tx.get('notes', 'c-s1-recovered'))) !== undefined,
      left: await opIdsIn(real),
    };
  }

  /** What every order below ends with: the closing text in the note, no recovered note, no entry */
  const closingTextAlone = { a1: 'alpha, first and more', recovered: [], made: false, left: [] };

  it("a page already open when the closing page went leaves the entries its draft names to that draft, so when its journal apply runs before the next start's drafts apply, the older text still makes no recovered note", async () => {
    assert.deepEqual(await closedBesideAnOpenPage({ journalFirst: true, closingCommitted: true }), closingTextAlone);
  });

  it("the same close, with the next start's drafts applied before the open page's journal: no recovered note", async () => {
    assert.deepEqual(await closedBesideAnOpenPage({ journalFirst: false, closingCommitted: true }), closingTextAlone);
  });

  it("the open page's journal apply first, over a closing save that never committed: the draft goes by the rules, knows the entry's save, and makes no recovered note", async () => {
    assert.deepEqual(await closedBesideAnOpenPage({ journalFirst: true, closingCommitted: false }), closingTextAlone);
  });

  it("applies an entry it left for a close-time draft as before once no draft names it, as when that draft is dropped as unreadable, so none waits for good, and holds back no other pane's entry", async () => {
    const real = new IDBFactory();
    const p = pageClient();
    await noteA(p);
    const base = await baseOf(p);
    const writer = inContextStores({ indexedDB: real }).journal();
    await writer.open();
    await writer.put(leftBy('c-s1', { base, text: 'alpha, first' }));
    // The same page's other pane on the note, which the draft doesn't name, typed in a2
    const otherPane = { pane: 'pane-2', seq: 2, base: await baseOf(p, 'a2'), block: 'a2', order: 1, text: 'alpha two, from the other pane' };
    await writer.put(leftBy('c-other-pane', otherPane));
    writer.close();
    const storage = legacyEnv.createLocalStorage();
    storage.setItem('ntn-close-draft:c-closing', JSON.stringify(closingDraft(base, 'alpha, first and more')));
    const locks = legacyEnv.createLockManager();
    /** @param {string} sessionId */
    const journalOf = sessionId =>
      startPageJournal(p.client, sessionId, 'newtab', {
        stores: inContextStores({ indexedDB: real }),
        locks,
        storage,
        runtime: { sendMessage: async () => {} },
        clock: p.clock,
      }).applied;
    /** Note A's blocks' text, by id */
    const textOf = async () =>
      Object.fromEntries((await p.blocksOf('A')).map((/** @type {Row} */ block) => [block.id, block.content]));
    const first = await journalOf('page-open');
    assert.deepEqual(await opIdsIn(real), ['c-s1'], 'the entry the draft names waits for it');
    assert.deepEqual(first?.saved, ['A'], "the other pane's entry is applied");
    assert.deepEqual(await textOf(), { a1: 'alpha', a2: 'alpha two, from the other pane' }, 'a1 waits with its entry');
    // The draft can't be read now, so the next apply's list drops it, and no draft names the entry
    storage.setItem('ntn-close-draft:c-closing', '{"v":1,');
    const next = await journalOf('page-open-2');
    assert.deepEqual(next?.saved, ['A'], 'the entry is applied as before');
    assert.deepEqual(await textOf(), { a1: 'alpha, first', a2: 'alpha two, from the other pane' });
    assert.deepEqual(await opIdsIn(real), []);
    assert.equal(storage.getItem('ntn-close-draft:c-closing'), null, 'the unreadable draft is gone');
  });

  it("leaves the pane's entries for the worker's sweep when the note of a committed close was deleted for good since, as 3b leaves a gone note's entries", async () => {
    const real = new IDBFactory();
    const p = pageClient({ ledger: createMemoryLedger() });
    await noteA(p);
    const base = await baseOf(p);
    const writer = inContextStores({ indexedDB: real }).journal();
    await writer.open();
    await writer.put(leftBy('c-s1', { base, text: 'alpha, first' }));
    writer.close();
    const storage = legacyEnv.createLocalStorage();
    storage.setItem('ntn-close-draft:c-closing', JSON.stringify(closingDraft(base, 'alpha, first and more')));
    // Its closing save committed under the draft's id, and the note was deleted for good since
    assert.equal((await p.kernel.execute(saveOfA('c-closing', 'alpha, first and more'))).kind, 'committed');
    for (const type of ['trashNote', 'deleteNotePermanently']) {
      const outcome = await p.kernel.execute(/** @type {any} */ ({ type, commandId: `c-${type}`, noteId: 'A' }));
      assert.equal(outcome.kind, 'committed', type);
    }
    const forgetCovered = await forgetOf();
    const stores = inContextStores({ indexedDB: real });
    const options = {
      client: p.client,
      store: closeDraftStore(storage),
      locks: legacyEnv.createLockManager(),
      forget: (/** @type {unknown} */ draft) => forgetCovered(draft, stores),
    };
    assert.deepEqual((await applyCloseDrafts(options)).gone, ['A']);
    assert.deepEqual(await opIdsIn(real), ['c-s1']);
  });
});
