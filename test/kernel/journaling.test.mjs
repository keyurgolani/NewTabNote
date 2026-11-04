// #35 slice 3b's journaling in a page (js/kernel/core/application/journaling.js, the plan's item
// 9): a page's journaled command is written to NewTabNoteJournal in the task that sends it, just
// before it, so a save still opens its transaction in its calling task (application/kernel.js),
// and its entry goes once the command is answered for good. A page holds its owner lock,
// journal.owner.<sessionId>, before its first entry, so the coordinator's drain never takes an
// entry of a page that's still open, and the drain's sweep has less to do after a delete for good.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createJournaling } from '../../js/kernel/core/application/journaling.js';
import { committed, conflict, rejected, unavailable, unknown } from '../../js/kernel/core/contracts/outcomes.js';
import { ownerLock } from '../../js/kernel/core/domain/journal.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createMemoryJournal } from '../../js/kernel/core/memory/journal.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { CALLERS, NOW, testClock, testIds } from './support.mjs';
import { createKernel } from './test-kernel.mjs';

/** The page's own session */
const SESSION = 'page-1';

/**
 * Exclusive Web Locks that grant each request when the test says, and answer query() as
 * navigator.locks does
 */
function heldLocks() {
  /** @type {Array<{name: string, grant: () => void}>} */
  const pending = [];
  /** @type {Set<string>} */
  const held = new Set();
  return {
    pending,
    held,
    /**
     * @template T
     * @param {string} name
     * @param {{mode: 'exclusive'}} options
     * @param {() => Promise<T>} callback
     * @returns {Promise<T>}
     */
    request(name, options, callback) {
      return new Promise((resolve, reject) => {
        pending.push({
          name,
          grant: () => {
            held.add(name);
            Promise.resolve()
              .then(callback)
              .then(resolve, reject)
              .finally(() => held.delete(name));
          },
        });
      });
    },
    async query() {
      return { held: [...held].map(name => ({ name })) };
    },
    /** Grants every request made so far */
    grantAll() {
      for (const request of pending.splice(0)) request.grant();
    },
  };
}

/**
 * A new tab's kernel on a memory adapter, the page's journal, and its journaling, whose owner
 * lock is granted unless the test holds it back
 * @param {{granted?: boolean}} [options]
 */
async function page({ granted = true } = {}) {
  const adapter = createMemoryAdapter();
  const clock = testClock();
  const kernel = createKernel({
    adapter,
    policy: createBaselinePolicy(),
    caller: CALLERS.newtab,
    ids: testIds('page'),
    clock,
  });
  const journal = createMemoryJournal();
  const locks = heldLocks();
  /** @type {Array<[string, unknown]>} */
  const warned = [];
  /** @type {string[]} the commandIds the kernel was handed, in order */
  const sent = [];
  /** @param {any} command */
  const send = command => {
    sent.push(command.commandId);
    return kernel.execute(command);
  };
  const journaling = createJournaling({
    journal,
    locks: /** @type {any} */ (locks),
    sessionId: SESSION,
    surface: 'newtab',
    clock,
    warn: (event, error) => warned.push([event, error]),
  });
  if (granted) {
    locks.grantAll();
    await journaling.ready;
  }
  return { adapter, clock, kernel, journal, locks, warned, sent, send, journaling };
}

/**
 * A quick note's creation
 * @param {string} commandId
 * @returns {any}
 */
const quickNote = commandId => ({
  type: 'createNote',
  commandId,
  noteId: `note-${commandId}`,
  name: 'Call the plumber',
  blocks: [{ id: `block-${commandId}`, type: 'text', content: 'Call the plumber' }],
});

describe("a page's journaling (#35 slice 3b)", () => {
  it('journals nothing until it holds its owner lock, and holds it for as long as the page lives', async () => {
    const w = await page({ granted: false });
    assert.deepEqual(
      w.locks.pending.map(request => request.name),
      [ownerLock(SESSION)],
    );
    /** @type {number[]} how many entries the journal held as each command went */
    const atSend = [];
    const before = await w.journaling.execute(quickNote('c-before'), (/** @type {any} */ command) => {
      atSend.push(w.journal.entries().length);
      return w.send(command);
    });
    assert.equal(before.kind, 'committed');
    assert.deepEqual([atSend, w.journal.entries()], [[0], []], 'no entry before the lock');

    w.locks.grantAll();
    await w.journaling.ready;
    assert.deepEqual([...w.locks.held], [ownerLock(SESSION)]);
    const answer = w.journaling.execute(quickNote('c-after'), w.send);
    assert.deepEqual(
      w.journal.entries().map(entry => [entry.opId, entry.ownerSessionId, entry.surface, entry.state]),
      [['c-after', SESSION, 'newtab', 'submitted']],
    );
    await answer;
    assert.deepEqual([...w.locks.held], [ownerLock(SESSION)], 'still held');
  });

  it('writes the entry and sends the command in the task that sends it, the entry first', async () => {
    const w = await page();
    /** @type {string[]} */
    const order = [];
    const put = w.journal.put;
    const journal = { ...w.journal, put: (/** @type {any} */ entry) => (order.push(`put ${entry.opId}`), put(entry)) };
    const journaling = createJournaling({
      journal,
      locks: /** @type {any} */ (w.locks),
      sessionId: 'page-2',
      surface: 'newtab',
      clock: w.clock,
    });
    w.locks.grantAll();
    await journaling.ready;
    const answer = journaling.execute(quickNote('c-1'), (/** @type {any} */ command) => {
      order.push(`send ${command.commandId}`);
      return w.kernel.execute(command);
    });
    // Both before execute() returned, so nothing was awaited between them
    assert.deepEqual(order, ['put c-1', 'send c-1']);
    assert.equal((await answer).kind, 'committed');
  });

  it('removes the entry once the command is answered for good, and keeps it when it may land later', async () => {
    const w = await page();
    /** @type {Array<[string, any]>} */
    const answers = [
      ['c-committed', null],
      ['c-conflict', conflict('version-conflict', 3)],
      ['c-rejected', rejected('validation', 'invalid-payload')],
      ['c-unavailable', unavailable('storage', 'transaction-aborted', true)],
      ['c-unknown', unknown('outcome-unknown', 'c-unknown')],
    ];
    for (const [commandId, outcome] of answers) {
      const sent = outcome === null ? w.send : async () => outcome;
      await w.journaling.execute(quickNote(commandId), sent);
    }
    assert.deepEqual(
      w.journal.entries().map(entry => entry.opId),
      ['c-unavailable', 'c-unknown'],
    );
  });

  it("writes no entry for a command the catalog doesn't journal, nor for one its caller covered", async () => {
    const w = await page();
    const made = await w.journaling.execute(quickNote('c-make'), w.send);
    assert.equal(made.kind, 'committed');
    await w.journaling.execute(
      { type: 'renameNote', commandId: 'c-rename', noteId: 'note-c-make', name: 'Renamed' },
      w.send,
    );
    // The closing save: its close-time draft holds it under the same id (the plan's Q3)
    await w.journaling.execute(
      {
        type: 'saveNoteContent',
        commandId: 'c-closing',
        noteId: 'note-c-make',
        blocks: [{ id: 'block-c-make', type: 'text', content: 'Closing', order: 0 }],
      },
      async () => unavailable('storage', 'transaction-aborted', true),
      { covered: true },
    );
    assert.deepEqual(w.journal.entries(), []);
    assert.deepEqual(w.sent, ['c-make', 'c-rename']);
  });

  it("keeps an editor save's close-time draft and its pane on its entry", async () => {
    const w = await page();
    const draft = /** @type {any} */ ({ v: 1, id: 'c-save', noteId: 'n1', blocks: [], deletedBlockIds: [] });
    await w.journaling.execute(
      { type: 'saveNoteContent', commandId: 'c-save', noteId: 'n1', blocks: [] },
      async () => unavailable('storage', 'transaction-aborted', true),
      { draft, pane: 'main' },
    );
    const [entry] = w.journal.entries();
    assert.deepEqual([entry.opId, entry.noteId, entry.draft, entry.pane], ['c-save', 'n1', draft, 'main']);
    assert.equal(entry.createdAt, NOW);
  });

  it("removes its pane's earlier entries for a note once a later save of that note commits, and leaves another pane's and another note's (R182's S2)", async () => {
    const w = await page();
    const made = await w.journaling.execute(quickNote('c-make'), w.send);
    assert.equal(made.kind, 'committed');
    const noteId = 'note-c-make';
    const fail = async () => unavailable('storage', 'transaction-aborted', true);
    /**
     * An editor save of `noteId` from `pane`
     * @param {string} commandId
     * @param {string} note
     * @param {string} content
     * @returns {any}
     */
    const save = (commandId, note, content) => ({
      type: 'saveNoteContent',
      commandId,
      noteId: note,
      blocks: [{ id: 'block-c-make', type: 'text', content, order: 0 }],
    });
    /** @param {string} id @param {string} note */
    const draftOf = (id, note) => /** @type {any} */ ({ v: 1, id, noteId: note, blocks: [], deletedBlockIds: [] });
    // Two saves of the note from the main pane that didn't land, one from another pane, and one
    // of another note from the main pane
    await w.journaling.execute(save('c-main-1', noteId, 'a'), fail, {
      draft: draftOf('c-main-1', noteId),
      pane: 'main',
    });
    await w.journaling.execute(save('c-main-2', noteId, 'ab'), fail, {
      draft: draftOf('c-main-2', noteId),
      pane: 'main',
    });
    await w.journaling.execute(save('c-side', noteId, 'side'), fail, {
      draft: draftOf('c-side', noteId),
      pane: 'side',
    });
    await w.journaling.execute(save('c-other', 'note-other', 'x'), fail, {
      draft: draftOf('c-other', 'note-other'),
      pane: 'main',
    });
    // The main pane's next save of the note commits, and carries everything it changed since its
    // last commit, so its earlier entries for that note are covered
    const committed = await w.journaling.execute(save('c-main-3', noteId, 'abc'), w.send, {
      draft: draftOf('c-main-3', noteId),
      pane: 'main',
    });
    assert.equal(committed.kind, 'committed', JSON.stringify(committed));
    assert.deepEqual(
      w.journal
        .entries()
        .map(entry => entry.opId)
        .sort(),
      ['c-other', 'c-side'],
    );
  });

  it("runs the command as it did when the journal can't take its entry, and says so on the console", async () => {
    const w = await page();
    w.journal.failNext('put');
    const answer = await w.journaling.execute(quickNote('c-1'), w.send);
    assert.equal(answer.kind, 'committed');
    assert.deepEqual(w.sent, ['c-1']);
    assert.deepEqual(w.journal.entries(), []);
    assert.deepEqual(
      w.warned.map(([event]) => event),
      ['entry-not-written'],
    );
  });

  it("removes the entries of notes deleted for good, whatever they hold, and leaves the others'", async () => {
    const w = await page();
    const fail = async () => unavailable('storage', 'transaction-aborted', true);
    await w.journaling.execute(quickNote('c-1'), fail);
    await w.journaling.execute(quickNote('c-2'), fail);
    await w.journaling.forget(['note-c-1']);
    assert.deepEqual(
      w.journal.entries().map(entry => entry.opId),
      ['c-2'],
    );
  });

  it("removes the entries of the notes a command deletes for good once it's answered, whoever wrote them, and leaves them when the delete didn't commit (the lead's call on 3b)", async () => {
    const w = await page();
    const fail = async () => unavailable('storage', 'transaction-aborted', true);
    /** The journal's entries, by opId */
    const left = () =>
      w.journal
        .entries()
        .map(entry => entry.opId)
        .sort();
    /**
     * Lets the journal's work go on until `done` holds, for a few turns at most
     * @param {() => boolean} [done]
     */
    const settled = async (done = () => false) => {
      for (let turn = 0; turn < 20 && !done(); turn += 1) await new Promise(resolve => setImmediate(resolve));
    };
    // Notes a to d, each with a save that may land later, and a save of a that a page that went left
    for (const id of ['a', 'b', 'c', 'd']) {
      assert.equal((await w.journaling.execute(quickNote(id), w.send)).kind, 'committed');
      await w.journaling.execute(
        {
          type: 'saveNoteContent',
          commandId: `c-save-${id}`,
          noteId: `note-${id}`,
          blocks: [{ id: `block-${id}`, type: 'text', content: 'Edited', order: 0 }],
        },
        fail,
      );
    }
    const [saved] = w.journal.entries();
    await w.journal.put({ ...saved, opId: 'c-gone-a', ownerSessionId: 'page-gone' });
    assert.deepEqual(left(), ['c-gone-a', 'c-save-a', 'c-save-b', 'c-save-c', 'c-save-d']);

    // A delete for good that didn't commit leaves every entry
    assert.equal(
      (await w.journaling.execute({ type: 'trashNote', commandId: 'c-trash-a', noteId: 'note-a' }, w.send)).kind,
      'committed',
    );
    await w.journaling.execute({ type: 'deleteNotePermanently', commandId: 'c-delete-try', noteId: 'note-a' }, fail);
    await settled();
    assert.deepEqual(left(), ['c-gone-a', 'c-save-a', 'c-save-b', 'c-save-c', 'c-save-d']);

    // One that did removes its note's entries, whoever wrote them, and leaves the others'
    const deleted = await w.journaling.execute(
      { type: 'deleteNotePermanently', commandId: 'c-delete-a', noteId: 'note-a' },
      w.send,
    );
    assert.deepEqual([deleted.kind, deleted.code], ['committed', 'note-deleted']);
    await settled(() => left().length < 5);
    assert.deepEqual(left(), ['c-save-b', 'c-save-c', 'c-save-d']);

    // A bulk delete names its notes in its items' answers
    for (const id of ['b', 'c']) {
      assert.equal(
        (await w.journaling.execute({ type: 'trashNote', commandId: `c-trash-${id}`, noteId: `note-${id}` }, w.send))
          .kind,
        'committed',
      );
    }
    const bulk = await w.journaling.execute(
      { type: 'runBulkAction', commandId: 'c-bulk', action: 'delete', noteIds: ['note-b'] },
      w.send,
    );
    assert.equal(bulk.kind, 'bulk');
    await settled(() => left().length < 3);
    assert.deepEqual(left(), ['c-save-c', 'c-save-d']);

    // Empty Trash names the notes it deleted only in its answer
    const emptied = await w.journaling.execute({ type: 'emptyTrash', commandId: 'c-empty' }, w.send);
    assert.deepEqual([emptied.kind, emptied.code], ['committed', 'trash-emptied']);
    await settled(() => left().length < 2);
    assert.deepEqual(left(), ['c-save-d']);

    // So does trash retention, answered here as the kernel answers one that deleted a note for good
    await w.journaling.execute({ type: 'runTrashCleanup', commandId: 'c-cleanup' }, async () =>
      committed('trash-cleaned', ['note-d']),
    );
    await settled(() => left().length === 0);
    assert.deepEqual(left(), []);
  });

  it('tells whether the journal holds an entry no live context holds, for the page to wake the drain', async () => {
    const w = await page();
    assert.equal(await w.journaling.orphaned(), false);
    // Its own, while it lives, are never orphaned
    await w.journaling.execute(quickNote('c-own'), async () => unavailable('storage', 'transaction-aborted', true));
    assert.equal(await w.journaling.orphaned(), false);
    // A page that went left one behind
    const [own] = w.journal.entries();
    await w.journal.put({ ...own, opId: 'c-gone', ownerSessionId: 'page-gone' });
    assert.equal(await w.journaling.orphaned(), true);
  });
});
