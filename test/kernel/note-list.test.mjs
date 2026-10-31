// The new tab's note-list projection (js/kernel/core/application/note-list.js, #12 slice 4c)
// over a kernel on the in-memory adapter: what it reads and when, the order its reads land in,
// its states, and that nothing it hands out can be changed. legacy-parity.test.mjs holds its
// views to Storage's orders, and test/note-list.test.js holds the sidebar, the palette, App,
// and analytics to one projection.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { createNoteList } from '../../js/kernel/core/application/note-list.js';
import { newCommand } from '../../js/kernel/core/contracts/commands.js';
import { NOTE_VIEWS } from '../../js/kernel/core/domain/note.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { CALLERS, NOW, testClock, testIds } from './support.mjs';

/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */
/** @typedef {import('../../js/kernel/core/application/note-list.js').NoteList} NoteList */
/** @typedef {import('../../js/kernel/core/application/note-list.js').NoteListChange} NoteListChange */
/** @typedef {import('../../js/kernel/core/application/feed.js').CommitListener} CommitListener */
/** @typedef {import('../../js/kernel/core/contracts/queries.js').Query} Query */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').CommandType} CommandType */

/**
 * @template {CommandType} T
 * @typedef {import('../../js/kernel/core/contracts/commands.js').CommandOf<T>} CommandOf
 */

/**
 * A promise and the function that resolves it
 * @returns {{promise: Promise<void>, open: () => void}}
 */
function gate() {
  /** @type {() => void} */
  let open = () => {};
  const promise = new Promise(resolve => {
    open = () => resolve(undefined);
  });
  return { promise, open };
}

/**
 * A kernel on a fresh in-memory adapter, and a note list on it whose reads are recorded in
 * `reads`, one entry per query: its type, with the ids getNotesByIds asked for. `around` can
 * delay or change what a query answers.
 * @param {{
 *   around?: (query: Query, read: Kernel['query']) => Promise<any>,
 *   whenReady?: Kernel['whenReady'],
 *   subscribe?: Kernel['subscribe'],
 * }} [options]
 */
function start({ around, whenReady, subscribe } = {}) {
  const adapter = createMemoryAdapter();
  const ids = testIds();
  const kernel = createKernel({
    adapter,
    policy: createBaselinePolicy(),
    caller: CALLERS.newtab,
    ids,
    clock: testClock(),
  });
  /** @type {string[]} */
  const reads = [];
  /** @type {Array<{event: string, detail: Record<string, unknown>}>} */
  const warnings = [];
  const list = createNoteList({
    query: /** @type {Kernel['query']} */ (
      /** @param {Query} query */
      query => {
        reads.push(query.type === 'getNotesByIds' ? `getNotesByIds ${query.noteIds.join(',')}` : query.type);
        return around ? around(query, kernel.query) : kernel.query(query);
      }
    ),
    subscribe: subscribe || kernel.subscribe,
    whenReady: whenReady || kernel.whenReady,
    logger: { warn: (event, detail) => warnings.push({ event, detail }) },
  });
  /**
   * @template {CommandType} T
   * @param {T} type
   * @param {Omit<CommandOf<T>, 'type' | 'commandId'>} fields
   */
  const run = async (type, fields) => {
    const outcome = await kernel.execute(/** @type {any} */ (newCommand(ids, type, fields)));
    assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  };
  // Another tab's kernel on the same storage, whose commits this tab's feed never hears of
  const elsewhere = createKernel({
    adapter,
    policy: createBaselinePolicy(),
    caller: { ...CALLERS.newtab, contextId: 'newtab-elsewhere' },
    ids,
    clock: testClock(),
  });
  /**
   * @template {CommandType} T
   * @param {T} type
   * @param {Omit<CommandOf<T>, 'type' | 'commandId'>} fields
   */
  const runElsewhere = async (type, fields) => {
    const outcome = await elsewhere.execute(/** @type {any} */ (newCommand(ids, type, fields)));
    assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
  };
  return { kernel, list, reads, warnings, run, runElsewhere, ids };
}

/**
 * @param {NoteList} list
 * @param {import('../../js/kernel/core/domain/note.js').NoteView} view
 */
const idsIn = (list, view) => list.view(view).map(note => note.id);

describe('the note-list projection', () => {
  it('is loading until its first read answers, then empty with no note and no folder, then ready', async () => {
    const ready = gate();
    const { kernel, list, run } = start({ whenReady: () => ready.promise.then(() => kernel.whenReady()) });
    assert.deepEqual(list.state(), { kind: 'loading' });
    assert.deepEqual(list.view('active'), []);
    ready.open();
    await list.settled();
    assert.deepEqual(list.state(), { kind: 'empty', asOf: NOW });
    await run('createNote', { noteId: 'n1', name: 'Plan' });
    await list.settled();
    assert.deepEqual(list.state(), { kind: 'ready', asOf: NOW });
    assert.deepEqual(idsIn(list, 'active'), ['n1']);
  });

  it('fails with its cause when the kernel does not start, or its first read fails, and a reload recovers', async () => {
    const down = start({
      whenReady: async () => ({
        kind: 'unavailable',
        cause: 'newer-schema',
        code: 'newer-schema',
        retryable: false,
        messageKey: 'unavailable.newer-schema',
        severity: 'error',
      }),
    });
    await down.list.settled();
    assert.deepEqual(down.list.state(), { kind: 'failed', cause: 'newer-schema', code: 'newer-schema' });

    let failing = true;
    const { list, warnings } = start({
      around: async (query, read) =>
        failing ? { kind: 'failed', cause: 'storage', code: 'read-failed' } : read(query),
    });
    await list.settled();
    assert.deepEqual(list.state(), { kind: 'failed', cause: 'storage', code: 'read-failed' });
    assert.deepEqual(
      warnings.map(({ event, detail }) => [event, detail.query, detail.code]),
      [['note-list-read-failed', 'getNoteList', 'read-failed']],
    );
    failing = false;
    assert.deepEqual(await list.reload(), { kind: 'empty', asOf: NOW });
  });

  it("reads each commit's notes with one getNotesByIds, and never every list but in reload()", async () => {
    const { list, reads, run } = start();
    await list.settled();
    assert.deepEqual(reads, ['getNoteList']);
    reads.length = 0;
    await run('createNote', { noteId: 'n1', name: 'Plan' });
    await list.settled();
    await run('renameNote', { noteId: 'n1', name: 'Plans' });
    await list.settled();
    await run('setPinned', { noteId: 'n1', pinned: true });
    await list.settled();
    await run('saveNoteContent', { noteId: 'n1', blocks: [{ id: 'b1', type: 'text', content: 'Hello', order: 0 }] });
    await list.settled();
    await run('archiveNote', { noteId: 'n1' });
    await list.settled();
    assert.deepEqual(reads, Array(5).fill('getNotesByIds n1'));
    const note = list.note('n1');
    assert.deepEqual([note?.name, note?.pinned, note?.archived], ['Plans', true, true]);
    assert.deepEqual([idsIn(list, 'active'), idsIn(list, 'archived')], [[], ['n1']]);
    reads.length = 0;
    await list.reload();
    assert.deepEqual(reads, ['getNoteList']);
  });

  it('reads the folders again for a folder commit, and nothing for a preferences or session commit', async () => {
    const { list, reads, run } = start();
    await list.settled();
    reads.length = 0;
    await run('createFolder', { folderId: 'f1', name: 'Work', parentId: null });
    await list.settled();
    assert.deepEqual(reads, ['listFolders']);
    assert.deepEqual(
      list.folders().map(folder => folder.id),
      ['f1'],
    );
    reads.length = 0;
    await run('setPreferences', { values: { theme: 'dark' } });
    await run('saveWorkspaceSession', { session: { activeTabIndex: 0 } });
    await list.settled();
    assert.deepEqual(reads, []);
  });

  it('reads nothing for a snapshot, and the note again after a revert or an AI insert, with its new preview', async () => {
    const { list, reads, run } = start();
    await run('createNote', { noteId: 'n1', name: 'Plan', blocks: [{ id: 'b1', type: 'text', content: 'Then' }] });
    await list.settled();
    reads.length = 0;
    await run('saveSnapshot', {
      noteId: 'n1',
      snapshotId: 's1',
      blocks: [{ id: 'b1', type: 'text', content: 'Then' }],
      title: 'Plan',
    });
    await list.settled();
    assert.deepEqual(reads, []);
    await run('insertBlocks', {
      noteId: 'n1',
      blocks: [{ id: 'b2', type: 'text', content: 'From the chat' }],
      atOrder: 0,
    });
    await list.settled();
    assert.equal(list.note('n1')?.preview, 'From the chat');
    await run('restoreSnapshot', {
      noteId: 'n1',
      snapshotId: 's1',
      preSnapshotId: 's2',
      blocks: [{ id: 'b1', type: 'text', content: 'Then' }],
      name: 'Restored',
    });
    await list.settled();
    assert.deepEqual(reads, ['getNotesByIds n1', 'getNotesByIds n1']);
    assert.equal(list.note('n1')?.name, 'Restored');
  });

  it('a note a commit names that is gone leaves the lists, with its search entry', async () => {
    const { list, run } = start();
    await run('createNote', { noteId: 'n1', name: 'Untitled' });
    await list.settled();
    assert.ok(list.searchEntry('n1'));
    // Trashing an untitled empty note deletes it, as Storage.trashNote did
    await run('trashNote', { noteId: 'n1' });
    await list.settled();
    assert.equal(list.note('n1'), undefined);
    assert.equal(list.searchEntry('n1'), undefined);
    assert.deepEqual(list.state(), { kind: 'empty', asOf: NOW });
  });

  it('lists each view as listNotes lists it, after each change', async () => {
    const { kernel, list, run } = start();
    for (const noteId of ['a', 'b', 'c', 'd', 'e']) await run('createNote', { noteId, name: `Note ${noteId}` });
    await run('archiveNote', { noteId: 'b' });
    await run('trashNote', { noteId: 'c' });
    await run('setPinned', { noteId: 'd', pinned: true });
    await run('renameNote', { noteId: 'a', name: 'First' });
    await list.settled();
    for (const view of NOTE_VIEWS) {
      const state = await kernel.query({ type: 'listNotes', view });
      assert.deepEqual(list.view(view), state.kind === 'ready' ? state.data : [], view);
    }
    assert.throws(() => list.view(/** @type {any} */ ('everything')), TypeError);
  });

  it('hands out frozen records, views, folders, and entries, and a change replaces them, never edits them', async () => {
    const { list, run } = start();
    await run('createFolder', { folderId: 'f1', name: 'Work', parentId: null });
    await run('createNote', { noteId: 'n1', name: 'Plan', folderId: 'f1' });
    await list.settled();
    const note = /** @type {Record<string, any>} */ (list.note('n1'));
    const view = list.view('active');
    const folder = /** @type {Record<string, any>} */ (list.folders()[0]);
    const entry = /** @type {Record<string, any>} */ (list.searchEntry('n1'));
    for (const frozen of [
      note,
      note.viewport,
      note.settings,
      view,
      list.folders(),
      folder,
      entry,
      list.searchEntries(),
    ]) {
      assert.ok(Object.isFrozen(frozen));
    }
    assert.throws(() => {
      note.name = 'Changed';
    }, TypeError);
    assert.throws(() => {
      note.viewport.scale = 2;
    }, TypeError);
    assert.throws(() => {
      folder.collapsed = true;
    }, TypeError);
    assert.throws(() => /** @type {any[]} */ (/** @type {unknown} */ (view)).push(note), TypeError);
    assert.throws(() => /** @type {any[]} */ (/** @type {unknown} */ (view)).splice(0, 1), TypeError);

    await run('renameNote', { noteId: 'n1', name: 'Plans' });
    await list.settled();
    assert.equal(note.name, 'Plan', 'the record handed out before stays as it was');
    assert.equal(view[0], note);
    assert.equal(list.note('n1')?.name, 'Plans');
    assert.notEqual(list.view('active'), view);
    assert.equal(list.view('active'), list.view('active'), 'a view is the same array until the next change');
  });

  it('never lands an older reload over a newer change', async () => {
    const answer = gate();
    let delayReload = false;
    const { list, reads, run } = start({
      // The reload's read answers what was stored when it ran, but only once the gate opens
      around: (query, read) => {
        const answered = read(query);
        if (query.type !== 'getNoteList' || !delayReload) return answered;
        delayReload = false;
        return answer.promise.then(() => answered);
      },
    });
    await run('createNote', { noteId: 'n1', name: 'Before' });
    await list.settled();
    reads.length = 0;
    delayReload = true;
    const reloaded = list.reload();
    // Let the reload's read run, so it reads the note as it was
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await run('renameNote', { noteId: 'n1', name: 'After' });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    // The commit's read waits for the reload, so it has not been asked for yet
    assert.deepEqual(reads, ['getNoteList']);
    assert.deepEqual(list.state(), { kind: 'stale', asOf: NOW });
    answer.open();
    await reloaded;
    await list.settled();
    assert.deepEqual(reads, ['getNoteList', 'getNotesByIds n1']);
    assert.equal(list.note('n1')?.name, 'After');
    assert.deepEqual(list.state(), { kind: 'ready', asOf: NOW });
  });

  it('runs a reload asked for while a commit is being read after that read', async () => {
    const answer = gate();
    let delay = false;
    const { list, reads, run } = start({
      around: (query, read) => {
        if (query.type !== 'getNotesByIds' || !delay) return read(query);
        delay = false;
        return answer.promise.then(() => read(query));
      },
    });
    await run('createNote', { noteId: 'n1', name: 'Before' });
    await list.settled();
    reads.length = 0;
    delay = true;
    await run('renameNote', { noteId: 'n1', name: 'After' });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const reloaded = list.reload();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.deepEqual(reads, ['getNotesByIds n1']);
    answer.open();
    await reloaded;
    assert.deepEqual(reads, ['getNotesByIds n1', 'getNoteList']);
    assert.equal(list.note('n1')?.name, 'After');
  });

  it('reads the notes the commits in one task publish with one getNotesByIds', async () => {
    /** @type {CommitListener[]} */
    const feed = [];
    /** @type {{promise: Promise<void>, open: () => void} | null} */
    let hold = null;
    const { list, reads, run } = start({
      around: (query, read) => {
        const held = hold;
        hold = null;
        return held ? held.promise.then(() => read(query)) : read(query);
      },
      subscribe: listener => {
        feed.push(listener);
        return () => {};
      },
    });
    for (const noteId of ['n1', 'n2', 'n3']) await run('createNote', { noteId, name: `Note ${noteId}` });
    await list.settled();
    reads.length = 0;
    // As a bulk action's items publish, one after another in one task
    for (const noteId of ['n1', 'n2', 'n3'])
      for (const listener of feed) listener({ aggregate: 'note', ids: [noteId] });
    for (const listener of feed) listener({ aggregate: 'note', ids: ['n2'] });
    assert.deepEqual(list.state(), { kind: 'stale', asOf: NOW });
    await list.settled();
    assert.deepEqual(reads, ['getNotesByIds n1,n2,n3']);

    // Ids that arrive while a read runs wait for the next one, and go in it together
    reads.length = 0;
    const held = gate();
    hold = held;
    for (const listener of feed) listener({ aggregate: 'note', ids: ['n1'] });
    while (reads.length === 0) await Promise.resolve();
    for (const listener of feed) listener({ aggregate: 'note', ids: ['n2'] });
    await Promise.resolve();
    for (const listener of feed) listener({ aggregate: 'note', ids: ['n3'] });
    held.open();
    await list.settled();
    assert.deepEqual(reads, ['getNotesByIds n1', 'getNotesByIds n2,n3']);
  });

  it('reads search entries again when the indexer wrote them, and says so as a search change', async () => {
    const { list, reads, run, runElsewhere } = start();
    await run('createNote', { noteId: 'n1', name: 'Plan' });
    await run('createNote', { noteId: 'n2', name: 'Groceries' });
    await list.settled();
    /** @type {NoteListChange[]} */
    const changes = [];
    list.subscribe(change => {
      changes.push(change);
    });
    reads.length = 0;
    await list.searchEntriesChanged(['n2']);
    // Every entry, and no note: what a sidebar search reads on each render
    await list.searchEntriesChanged('all');
    await list.searchEntriesChanged([]);
    assert.deepEqual(reads, ['getNotesByIds n2', 'listSearchEntries']);
    // The indexer's write elsewhere, which the next read of every entry finds
    await runElsewhere('renameNote', { noteId: 'n1', name: 'Plans' });
    await list.searchEntriesChanged('all');
    assert.equal(list.searchEntry('n1')?.name, 'Plans');
    assert.equal(list.note('n1')?.name, 'Plan', 'it reads entries, not notes');
    assert.deepEqual(
      changes.map(({ reason, ids }) => [reason, ids]),
      [
        ['search', ['n2']],
        ['search', []],
      ],
      'a read that found the entries it held changes nothing',
    );
    assert.deepEqual(
      list
        .searchEntries()
        .map(entry => entry.noteId)
        .sort(),
      ['n1', 'n2'],
    );
  });

  it('tells each listener once per change, after it applied, and one that throws stops no other', async () => {
    const { list, run, runElsewhere, warnings } = start();
    await list.settled();
    /** @type {Array<[number, string, string | undefined]>} */
    const seen = [];
    list.subscribe(() => {
      throw new Error('a broken listener');
    });
    list.subscribe(change => {
      seen.push([change.version, change.reason, list.note('n1')?.name]);
    });
    let rendered = false;
    list.subscribe(async () => {
      await Promise.resolve();
      rendered = true;
    });
    await run('createNote', { noteId: 'n1', name: 'Plan' });
    await list.settled();
    assert.equal(rendered, true, 'settled waits for listeners');
    rendered = false;
    await list.reload();
    assert.equal(rendered, false, 'a reload that found what the list holds tells no one');
    await runElsewhere('renameNote', { noteId: 'n1', name: 'Plans' });
    await list.reload();
    assert.equal(rendered, true, 'reload resolves once its listeners settled');
    assert.deepEqual(seen, [
      [2, 'commit', 'Plan'],
      [3, 'reload', 'Plans'],
    ]);
    assert.deepEqual(
      warnings.map(({ event }) => event),
      ['note-list-listener-failed', 'note-list-listener-failed'],
    );
  });

  it('never waits on a listener that asks for a read while a reload tells it, as the sidebar does with a search typed', async () => {
    const { list, run, runElsewhere, reads } = start();
    await run('createNote', { noteId: 'n1', name: 'Plan' });
    await list.settled();
    let searching = true;
    /** @type {string[]} */
    const rendered = [];
    list.subscribe(async change => {
      // SidebarController._onNoteListChanged, renderSearchResults, refreshSearchIndexEntries
      if (change.reason === 'search' || !searching) return;
      await list.searchEntriesChanged('all');
      rendered.push(`${change.reason} ${list.note('n1')?.name}`);
    });
    const within = (/** @type {Promise<unknown>} */ promise) =>
      Promise.race([
        promise.then(() => 'resolved'),
        new Promise(resolve => setTimeout(() => resolve('timed out'), 1000)),
      ]);
    await runElsewhere('renameNote', { noteId: 'n1', name: 'Plans' });
    assert.equal(await within(list.reload()), 'resolved');
    // A commit while the listener reads, and the indexer's own read of every entry
    await run('setPinned', { noteId: 'n1', pinned: true });
    assert.equal(await within(list.searchEntriesChanged('all')), 'resolved');
    assert.equal(await within(list.settled()), 'resolved');
    searching = false;
    await runElsewhere('renameNote', { noteId: 'n1', name: 'Later' });
    assert.equal(await within(list.reload()), 'resolved', 'the queue still moves');
    assert.deepEqual(rendered, ['reload Plans', 'commit Plans']);
    assert.equal(list.note('n1')?.name, 'Later');
  });

  it('tries a failed read of changes again, a few times, and stays stale until one succeeds', async () => {
    let failures = 0;
    const { list, run, reads } = start({
      around: async (query, read) => {
        if (query.type === 'getNotesByIds' && failures > 0) {
          failures -= 1;
          return { kind: 'failed', cause: 'storage', code: 'read-failed' };
        }
        return read(query);
      },
    });
    await run('createNote', { noteId: 'n1', name: 'Plan' });
    await list.settled();
    // One failure: the retry reads it with no other commit
    failures = 1;
    reads.length = 0;
    await run('renameNote', { noteId: 'n1', name: 'Plans' });
    await list.settled();
    assert.deepEqual(reads, ['getNotesByIds n1', 'getNotesByIds n1']);
    assert.equal(list.note('n1')?.name, 'Plans');
    assert.deepEqual(list.state(), { kind: 'ready', asOf: NOW });
    // Every try fails: it stops after four reads, and waits as stale
    failures = 100;
    reads.length = 0;
    await run('renameNote', { noteId: 'n1', name: 'Plans again' });
    await list.settled();
    assert.deepEqual(reads, Array(4).fill('getNotesByIds n1'));
    assert.deepEqual(list.state(), { kind: 'stale', asOf: NOW });
    assert.equal(list.note('n1')?.name, 'Plans');
  });

  it('gives a failed read of changes its full retries again once a reload has read what it missed', async () => {
    let failing = false;
    const { list, run, reads } = start({
      around: async (query, read) =>
        failing && query.type === 'getNotesByIds'
          ? { kind: 'failed', cause: 'storage', code: 'read-failed' }
          : read(query),
    });
    await list.settled();
    failing = true;
    reads.length = 0;
    await run('createNote', { noteId: 'n1', name: 'One' });
    await list.settled();
    assert.deepEqual(reads, Array(4).fill('getNotesByIds n1'), 'one read and three retries');
    // A reload reads what the failed reads missed
    reads.length = 0;
    assert.deepEqual(await list.reload(), { kind: 'ready', asOf: NOW });
    assert.ok(list.note('n1'));
    await run('createNote', { noteId: 'n2', name: 'Two' });
    await list.settled();
    assert.deepEqual(reads, ['getNoteList', ...Array(4).fill('getNotesByIds n2')], 'three retries again, not fewer');
  });

  it('stays stale after a failed reload, even once a read of changes succeeds, until a reload succeeds', async () => {
    let failReload = false;
    const { list, run } = start({
      around: async (query, read) =>
        failReload && query.type === 'getNoteList'
          ? { kind: 'failed', cause: 'storage', code: 'read-failed' }
          : read(query),
    });
    await run('createNote', { noteId: 'n1', name: 'Plan' });
    await list.settled();
    failReload = true;
    assert.deepEqual(await list.reload(), { kind: 'stale', asOf: NOW });
    await run('renameNote', { noteId: 'n1', name: 'Plans' });
    await list.settled();
    assert.equal(list.note('n1')?.name, 'Plans');
    assert.deepEqual(
      list.state(),
      { kind: 'stale', asOf: NOW },
      "the reload's write outside the kernel may still be unread",
    );
    failReload = false;
    assert.deepEqual(await list.reload(), { kind: 'ready', asOf: NOW });
  });

  it('keeps the last lists as stale while a read of changes fails, and reads them with the next one', async () => {
    let failing = false;
    const { list, run, reads } = start({
      around: async (query, read) =>
        failing && query.type === 'getNotesByIds'
          ? { kind: 'failed', cause: 'storage', code: 'read-failed' }
          : read(query),
    });
    await run('createNote', { noteId: 'n1', name: 'Plan' });
    await list.settled();
    failing = true;
    await run('renameNote', { noteId: 'n1', name: 'Plans' });
    await list.settled();
    assert.deepEqual(list.state(), { kind: 'stale', asOf: NOW });
    assert.equal(list.note('n1')?.name, 'Plan');
    failing = false;
    reads.length = 0;
    await run('createNote', { noteId: 'n2', name: 'Groceries' });
    await list.settled();
    assert.deepEqual(reads, ['getNotesByIds n1,n2']);
    assert.equal(list.note('n1')?.name, 'Plans');
    assert.deepEqual(list.state(), { kind: 'ready', asOf: NOW });
  });
});
