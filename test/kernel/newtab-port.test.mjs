// #35 slice 4d's page move: the new tab's page side once its writes go to the worker over #13's
// port. The new tab's root reads in the page, on #17's read-only reader, and commits its session's
// write there, through its settings handle (rules 1 and 2). Every other command goes to the worker
// as `newtab`, through its send chunk, journaled as the catalog says, in the order the page sends
// them (rule 3), and each committed reply feeds the page's commit feed, so its note list follows
// (rule 5). The deletes for good keep the drafts' lock around their send (rule 7). On legacy-env
// profiles, with a stand-in for the worker that serves every page command (popup-worker.mjs), and
// the root as startNewTab builds it (newtab-root.mjs).

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inContextStores } from '../../js/kernel/adapters/in-context.js';
import { createIndexedDbAdapter } from '../../js/kernel/adapters/indexeddb/adapter.js';
import { DB_NAME, DB_VERSION } from '../../js/kernel/adapters/indexeddb/schema.js';
import { kernelClient, waitForWorkerUpgrade } from '../../js/kernel/composition/host.js';
import { createNewTabDocumentClient, createNewTabNoteList } from '../../js/kernel/composition/newtab.js';
import { WORKER_PAGE_HANDLERS } from '../../js/kernel/core/application/handlers-worker.js';
import { COMMANDS } from '../../js/kernel/core/contracts/commands.js';
import { COMMAND_CEILING_BYTES, MAX_MESSAGE_BYTES } from '../../js/kernel/core/contracts/limits.js';
import { committed, rejected, unavailable } from '../../js/kernel/core/contracts/outcomes.js';
import { blockDigest } from '../../js/kernel/core/domain/close-draft.js';
import { DRAFTS_LOCK, DRAFT_PREFIX } from '../../js/kernel/core/domain/close-draft-keys.js';
import { journalEntry, ownerLock } from '../../js/kernel/core/domain/journal.js';
import { COMMAND_SAMPLES } from './command-samples.mjs';
import { legacyContext, legacyEnv } from './legacy-fixture.mjs';
import { settle } from './messaging-support.mjs';
import { newTabOn } from './newtab-root.mjs';

/** @typedef {import('./legacy-fixture.mjs').LegacyContext} LegacyContext */

/** @type {(id: string, canvasId: string, order: number, content?: string) => any} */
const block = (id, canvasId, order, content) => legacyEnv.block(id, canvasId, order, content);

/** The new tabs a case opened, which its end closes */
/** @type {Array<ReturnType<typeof newTabOn>>} */
const opened = [];
afterEach(() => {
  for (const one of opened.splice(0)) one.close();
});

/**
 * The new tab on `tab`'s profile, its writes to a stand-in for the worker there
 * @param {LegacyContext} tab
 * @param {Parameters<typeof newTabOn>[1]} [options]
 */
const newTab = (tab, options) => {
  const one = newTabOn(tab.env, options);
  opened.push(one);
  return one;
};

/**
 * A profile with note A, its blocks a1 and a2, and note B, its block b1, made by the worker's own
 * kernel once its run made the database
 */
async function profile() {
  const tab = legacyContext();
  await waitForWorkerUpgrade({ runtime: tab.env.chrome.api.runtime });
  const adapter = createIndexedDbAdapter({
    indexedDB: tab.env.indexedDB,
    settings: tab.env.chrome.api.storage.local,
    mode: 'existing',
  });
  const worker = kernelClient({ adapter, surface: 'newtab', handlers: WORKER_PAGE_HANDLERS });
  assert.equal(await worker.whenReady(), null);
  for (const [noteId, name, blocks] of /** @type {const} */ ([
    ['A', 'Alpha plan', [block('a1', 'A', 0, 'alpha'), block('a2', 'A', 1, 'alpha two')]],
    ['B', 'Bravo plan', [block('b1', 'B', 0, 'bravo')]],
  ])) {
    const command = { type: 'createNote', commandId: `make-${noteId}`, noteId, name, blocks: [...blocks] };
    assert.equal((await worker.execute(/** @type {any} */ (command))).kind, 'committed');
  }
  adapter.close();
  return tab;
}

/**
 * Whether `check` holds within 2 s of real time, looked at every few milliseconds
 * @param {() => boolean | Promise<boolean>} check
 */
async function until(check) {
  for (const end = Date.now() + 2000; Date.now() < end;) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  return false;
}

/**
 * What the profile's journal holds now, on a connection of the test's own
 * @param {LegacyContext} tab
 */
async function journalOf(tab) {
  const stores = inContextStores({ indexedDB: tab.env.indexedDB });
  if (!(await stores.journalExists())) return [];
  const journal = stores.journal();
  try {
    await journal.open();
    return await journal.list();
  } finally {
    journal.close();
  }
}

/**
 * Note `noteId`'s blocks as stored, by id, read on a connection of the test's own
 * @param {LegacyContext} tab
 * @param {string} noteId
 */
async function storedBlocks(tab, noteId) {
  const rows = Object.values(legacyEnv.recordsOf(await legacyEnv.dumpDatabase(tab.env.indexedDB), 'elements'));
  return Object.fromEntries(rows.filter(row => row.canvasId === noteId).map(row => [row.id, row.content]));
}

/**
 * A whole-note save of A, as an editor with no base of it sends one, with `blocks`
 * @param {any[]} blocks
 */
const saveOfA = blocks => ({
  noteId: 'A',
  blocks,
  preview: blocks[0].content.slice(0, 80),
  todoProgress: null,
  linkedNames: [],
});

/** When the closing tabs wrote what they left */
const AT = Date.UTC(2026, 10, 8, 9, 0);

/**
 * A closing tab's edit of A, a1 changed, on the base the tab saw
 * @param {{id?: string, page?: string, at?: number, content?: string}} [options]
 */
function draftOf({ id = 'draft-a', page = 'page-1', at = AT, content = 'alpha, edited as the tab closed' } = {}) {
  return {
    v: 1,
    id,
    page,
    noteId: 'A',
    at,
    base: {
      revision: 0,
      updatedAt: null,
      issued: [],
      name: 'Alpha plan',
      blocks: {
        a1: blockDigest(block('a1', 'A', 0, 'alpha'), 'A'),
        a2: blockDigest(block('a2', 'A', 1, 'alpha two'), 'A'),
      },
      issuedSaves: [],
    },
    blocks: [block('a1', 'A', 0, content)],
    deletedBlockIds: [],
    preview: content.slice(0, 80),
    todoProgress: null,
    linkedNames: [],
  };
}

/**
 * Puts a closing tab's edit of A in the page's localStorage, and answers its key
 * @param {LegacyContext} tab
 * @param {string} [content]
 * @param {{id?: string, page?: string, at?: number}} [options]
 */
function writeDraft(tab, content = 'alpha, edited as the tab closed', options = {}) {
  const draft = draftOf({ ...options, content });
  tab.env.global.localStorage.setItem(`${DRAFT_PREFIX}${draft.id}`, JSON.stringify(draft));
  return `${DRAFT_PREFIX}${draft.id}`;
}

describe("the new tab's writes, over #13's port (#35 slice 4d)", () => {
  for (const [welcome, status] of /** @type {const} */ ([
    ['ready', undefined],
    ['starting', () => /** @type {const} */ ({ status: 'degraded', reason: 'starting' })],
  ])) {
    it(`sends an editor's save, a 2 MiB file block's among them, and a pop-out editor's, to the worker as newtab, journaled first, on a ${welcome} welcome, and its note list reads the note again (R1)`, async () => {
      const tab = await profile();
      /** @type {Array<[unknown, unknown, boolean]>} */
      const went = [];
      const { stand, reader, client } = newTab(tab, {
        ...(status ? { status } : {}),
        before: async one => {
          const journaled = await until(async () => (await journalOf(tab)).some(entry => entry.opId === one.commandId));
          went.push([one.surface, one.type, journaled]);
        },
      });
      assert.equal(await client.whenReady(), null);
      const noteList = createNewTabNoteList(client);
      await noteList.settled();
      const storage = tab.env.global.localStorage;
      const editor = createNewTabDocumentClient(client, reader, { storage });
      // The pop-out's editor, in a document of its own, saves through the opener's client and port (rule 14)
      const popOut = createNewTabDocumentClient(client, reader, { storage });
      const fileData = `data:application/pdf;base64,${'A'.repeat(2 * MAX_MESSAGE_BYTES)}`;
      const file = {
        ...block('a3', 'A', 2, ''),
        type: 'file',
        fileName: 'scan.pdf',
        fileSize: 1.5 * MAX_MESSAGE_BYTES,
        fileData,
      };
      const typed = block('a1', 'A', 0, 'alpha, typed in the tab');
      const saves = [
        await editor.saveContent(saveOfA([typed]), { pane: 'main' }),
        await editor.saveContent(saveOfA([typed, block('a2', 'A', 1, 'alpha two'), file]), { pane: 'main' }),
        await popOut.saveContent(saveOfA([block('a1', 'A', 0, 'alpha, typed in the pop-out')]), { pane: 'pip' }),
      ];
      assert.deepEqual(
        saves.map(outcome => outcome.kind),
        ['committed', 'committed', 'committed'],
      );
      assert.deepEqual(went, [
        ['newtab', 'saveNoteContent', true],
        ['newtab', 'saveNoteContent', true],
        ['newtab', 'saveNoteContent', true],
      ]);
      const stored = await storedBlocks(tab, 'A');
      assert.equal(stored.a1, 'alpha, typed in the pop-out', 'the worker committed each');
      assert.equal(stored.a3, '', 'the file block is stored');
      assert.equal(
        await until(() => noteList.note('A')?.preview === 'alpha, typed in the pop-out'),
        true,
        'the list read A again',
      );
      assert.deepEqual(
        (await journalOf(tab)).map(entry => entry.opId),
        [],
        'each entry went with its answer',
      );
    });
  }

  it('sends each of the 46 commands the worker serves the new tab as newtab, and commits its session in the page, with no frame (R2)', async () => {
    const tab = await profile();
    const { stand, client } = newTab(tab);
    assert.equal(await client.whenReady(), null);
    const sent = Object.keys(COMMANDS).filter(
      type =>
        COMMANDS[/** @type {keyof typeof COMMANDS} */ (type)].surfaces.includes('newtab') &&
        !['saveWorkspaceSession', 'runStartupMaintenance'].includes(type),
    );
    assert.equal(sent.length, 46);
    for (const type of sent) {
      const sample = COMMAND_SAMPLES[/** @type {keyof typeof COMMAND_SAMPLES} */ (type)];
      await client.execute(/** @type {any} */ ({ ...sample, type, commandId: `c-${type}` }));
    }
    assert.deepEqual(
      stand.handed.map(one => [one.surface, one.type]),
      sent.map(type => ['newtab', type]),
    );
    const session = { openTabs: [{ noteId: 'A', title: 'Alpha plan' }], activeTabIndex: 0 };
    const saved = await client.execute({ type: 'saveWorkspaceSession', commandId: 'c-session', session });
    assert.deepEqual(saved.kind === 'committed' && [saved.code, saved.changedIds], [
      'session-saved',
      ['openTabs', 'activeTabIndex'],
    ]);
    assert.deepEqual(
      legacyEnv.plain(tab.env.chrome.local.setting_openTabs),
      session.openTabs,
      'in the page, through its settings handle',
    );
    assert.equal(stand.frames.filter(frame => frame.operation === 'saveWorkspaceSession').length, 0, 'with no frame');
  });

  it("holds the drafts' lock around a delete for good's send, clears its note's draft after the reply, and wakes the purge (R3)", async () => {
    const tab = await profile();
    const storage = tab.env.global.localStorage;
    /** @type {Array<[boolean, boolean]>} */
    const held = [];
    let wakes = 0;
    const key = `${DRAFT_PREFIX}draft-b`;
    const { client } = newTab(tab, {
      wake: () => {
        wakes += 1;
      },
      before: async one => {
        if (one.type !== 'deleteNotePermanently') return;
        const locks = await tab.env.global.navigator.locks.query();
        held.push([
          (locks.held || []).some((/** @type {{name?: string}} */ lock) => lock.name === DRAFTS_LOCK),
          storage.getItem(key) !== null,
        ]);
      },
    });
    assert.equal(await client.whenReady(), null);
    assert.equal((await client.execute({ type: 'trashNote', commandId: 'c-trash', noteId: 'B' })).kind, 'committed');
    // A closing tab's edit of B, written after the start's apply, which the delete clears
    storage.setItem(key, JSON.stringify({ ...draftOf({ id: 'draft-b' }), noteId: 'B' }));
    const deleted = await client.execute({ type: 'deleteNotePermanently', commandId: 'c-delete', noteId: 'B' });
    assert.deepEqual(deleted.kind === 'committed' && [deleted.code, deleted.changedIds], ['note-deleted', ['B']]);
    assert.deepEqual(
      held,
      [[true, true]],
      'the lock held, and the draft still there, while the worker held the delete',
    );
    assert.equal(storage.getItem(key), null, 'the draft went once the reply came');
    assert.equal(wakes, 1, 'and the purge was woken');
  });

  it("publishes each committed item of a bulk action under its own id, as the kernel's run of the items does (R4p)", async () => {
    const tab = await profile();
    const { client } = newTab(tab);
    assert.equal(await client.whenReady(), null);
    /** @type {Array<{aggregate: string, ids: readonly string[]}>} */
    const heard = [];
    client.subscribe(event => {
      heard.push({ aggregate: event.aggregate, ids: [...event.ids] });
    });
    const outcome = await client.execute({
      type: 'runBulkAction',
      commandId: 'c-bulk',
      action: 'archive',
      noteIds: ['A', 'B', 'gone'],
    });
    assert.equal(outcome.kind, 'bulk');
    assert.deepEqual(heard, [
      { aggregate: 'note', ids: ['A'] },
      { aggregate: 'note', ids: ['B'] },
    ]);
  });
});

/**
 * An editor save of A's a1 that a page journaled and closed before its answer, under `id`, by the
 * page `session`
 * @param {LegacyContext} tab
 * @param {{id?: string, session?: string, at?: number}} [options]
 */
async function leaveSave(tab, { id = 'c-save', session = 'page-gone', at = AT } = {}) {
  const content = 'alpha, saved as its page closed';
  const blocks = [{ id: 'a1', type: 'text', content, order: 0 }];
  const command = { type: 'saveNoteContent', commandId: id, noteId: 'A', blocks, deriveFromStored: true };
  /** @type {any} the edit the page journaled with its save */
  const draft = {
    ...draftOf({ id, page: session, at, content }),
    blocks: blocks.map(saved => ({ ...saved, canvasId: 'A' })),
  };
  const writer = inContextStores({ indexedDB: tab.env.indexedDB }).journal();
  await writer.open();
  await writer.put(
    journalEntry({
      command,
      v: 1,
      noteId: 'A',
      surface: 'newtab',
      ownerSessionId: session,
      seq: 1,
      createdAt: at,
      draft,
      pane: 'main',
    }),
  );
  writer.close();
}

/** The worker's answer when it can't take a command */
const notTaken = () => unavailable('coordinator', 'unavailable', true);

/**
 * `runtime`, whose port, once `losing()` holds, loses the first reply it hears and drops on both
 * ends, as a worker that restarts after it committed does
 * @param {any} runtime - the page's chrome.runtime
 * @param {() => boolean} losing
 */
function losingReplies(runtime, losing) {
  return {
    get lastError() {
      return runtime.lastError;
    },
    connect(/** @type {unknown} */ info) {
      const port = runtime.connect(info);
      /** @type {Array<(message: unknown) => void>} */
      const heard = [];
      /** @type {Array<(port: unknown) => void>} */
      const gone = [];
      let lost = false;
      const end = {
        name: port.name,
        onMessage: { addListener: (/** @type {(message: unknown) => void} */ listener) => heard.push(listener) },
        onDisconnect: { addListener: (/** @type {(port: unknown) => void} */ listener) => gone.push(listener) },
        postMessage: (/** @type {unknown} */ message) => port.postMessage(message),
        disconnect: () => port.disconnect(),
      };
      port.onMessage.addListener((/** @type {unknown} */ message) => {
        if (!lost && losing() && typeof message === 'string' && JSON.parse(message).frame === 'response') {
          lost = true;
          // The page's own disconnect tells only the worker's end, so the page's listeners hear it here
          port.disconnect();
          for (const listener of gone) listener(end);
          return;
        }
        for (const listener of heard) listener(message);
      });
      port.onDisconnect.addListener(() => {
        for (const listener of gone) listener(end);
      });
      return end;
    },
  };
}

describe("the new tab's sends keep their order, its runs fail fast, and an upgrade gates them (#35 slice 4d)", () => {
  it('loads the send chunk once for every command, and sends each, in order, once it is in and its journal holds the owner lock (rule 3, R5)', async () => {
    const tab = await profile();
    /** @type {Array<() => void>} */
    const loads = [];
    /** @type {(value: boolean) => void} */
    let lockHeld = () => {};
    /** @type {Promise<boolean>} */
    const ready = new Promise(resolve => {
      lockHeld = resolve;
    });
    /** @type {string[]} */
    const went = [];
    const chunk = {
      newTabWrites: () => ({
        ready,
        execute: async (/** @type {{commandId: string, noteId: string}} */ command) => {
          went.push(command.commandId);
          return committed('note-renamed', [command.noteId]);
        },
      }),
    };
    // Each load answers once the case lets it, the last asked first
    const { client } = newTab(tab, { send: () => new Promise(resolve => loads.push(() => resolve(chunk))) });
    const answers = [
      client.execute({ type: 'renameNote', commandId: 'c-1', noteId: 'A', name: 'One' }),
      client.execute({ type: 'setPinned', commandId: 'c-2', noteId: 'A', pinned: true }),
    ];
    await settle();
    for (const load of [...loads].reverse()) load();
    await settle();
    assert.deepEqual(went, [], 'nothing goes before the owner lock');
    answers.push(client.execute({ type: 'archiveNote', commandId: 'c-3', noteId: 'B' }));
    lockHeld(true);
    await Promise.all(answers);
    assert.equal(loads.length, 1, 'one load');
    assert.deepEqual(went, ['c-1', 'c-2', 'c-3']);
  });

  it("answers each command unavailable, reload-required, not retryable, when the send chunk can't load, and sends nothing (R6)", async () => {
    const tab = await profile();
    const { stand, client } = newTab(tab, {
      send: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
    });
    const reload = unavailable('coordinator', 'reload-required', false);
    assert.deepEqual(
      await client.execute({ type: 'setPinned', commandId: 'c-pin', noteId: 'A', pinned: true }),
      reload,
    );
    const save = {
      type: /** @type {const} */ ('saveNoteContent'),
      commandId: 'c-save',
      ...saveOfA([block('a1', 'A', 0, 'alpha, typed')]),
    };
    assert.deepEqual(await client.execute(save), reload);
    assert.deepEqual(stand.frames, []);
  });

  it("sends the start's apply over the port, waits for all of it, and sends no more of it once the worker didn't take one (rule 6, R7)", async () => {
    const tab = await profile();
    const keys = [
      writeDraft(tab, 'alpha, from a first tab', { id: 'draft-a', page: 'page-1', at: AT }),
      writeDraft(tab, 'alpha, from a second tab', { id: 'draft-b', page: 'page-2', at: AT + 1 }),
      writeDraft(tab, 'alpha, from a third tab', { id: 'draft-c', page: 'page-3', at: AT + 2 }),
    ];
    const { stand, client } = newTab(tab, { answer: one => (one.type === 'applyCloseDraft' ? notTaken() : undefined) });
    let applied = false;
    client.applied().then(() => {
      applied = true;
    });
    assert.equal(await client.whenReady(), null);
    assert.equal(applied, true, 'whenReady waited for the whole apply');
    assert.deepEqual((await client.applied())?.kept, ['A', 'A', 'A'], 'all three stay for the next start');
    assert.deepEqual(
      stand.handed.map(one => [one.type, one.commandId]),
      [['applyCloseDraft', 'draft-a-apply']],
      'the other two never went',
    );
    for (const key of keys) assert.notEqual(tab.env.global.localStorage.getItem(key), null);
    const pinned = await client.execute({ type: 'setPinned', commandId: 'c-pin', noteId: 'B', pinned: true });
    assert.equal(pinned.kind, 'committed', "the page's own command still goes");
  });

  it("starts the journal's run afresh after the start's run stopped, so its first save still goes (rule 6, R7)", async () => {
    const tab = await profile();
    writeDraft(tab);
    await leaveSave(tab);
    /** @type {(value?: unknown) => void} */
    let chunkIn = () => {};
    const loaded = new Promise(resolve => {
      chunkIn = resolve;
    });
    const { stand, client } = newTab(tab, {
      answer: one => (one.commandId === 'draft-a-apply' ? notTaken() : undefined),
      send: () => loaded.then(() => import('../../js/kernel/composition/newtab-send-chunk.js')),
    });
    const applied = client.applied();
    // The start's run takes the drafts' lock before the send chunk is in, so it goes first
    const holdsDraftsLock = async () =>
      ((await tab.env.global.navigator.locks.query()).held || []).some(
        (/** @type {{name?: string}} */ lock) => lock.name === DRAFTS_LOCK,
      );
    assert.equal(await until(holdsDraftsLock), true, "the start's run holds the drafts' lock");
    chunkIn();
    assert.deepEqual((await applied)?.kept, ['A']);
    assert.equal(await until(() => stand.handed.length === 2), true, "the journal's run sent its own");
    assert.deepEqual(
      stand.handed.map(one => one.commandId),
      ['draft-a-apply', 'c-save-apply'],
    );
  });

  it("names the journal's owner lock and each entry for the session its hello says (rule 3, R8)", async () => {
    const tab = await profile();
    const real = tab.env.global.navigator.locks;
    /** @type {string[]} */
    const requested = [];
    const locks = {
      request: (/** @type {string} */ name, /** @type {any} */ options, /** @type {any} */ callback) => {
        requested.push(name);
        return real.request(name, options, callback);
      },
      query: () => real.query(),
    };
    /** @type {unknown[]} */
    let owners = [];
    const { stand, client } = newTab(tab, {
      locks,
      before: async one => {
        await until(async () => (await journalOf(tab)).some(entry => entry.opId === one.commandId));
        owners = (await journalOf(tab)).map(entry => entry.ownerSessionId);
      },
    });
    const save = {
      type: /** @type {const} */ ('saveNoteContent'),
      commandId: 'c-save',
      ...saveOfA([block('a1', 'A', 0, 'alpha, typed')]),
    };
    assert.equal((await client.execute(save)).kind, 'committed');
    const [sent] = stand.handed;
    assert.ok(sent, 'the worker got it');
    assert.ok(requested.includes(ownerLock(sent.sessionId)), requested.join(', '));
    assert.deepEqual(owners, [sent.sessionId]);
  });

  it('resolves a restore whose reply was lost by its key, from the ledger the reader reads (rule 3, R9)', async () => {
    const tab = await profile();
    let losing = false;
    const { client } = newTab(tab, { runtime: runtime => losingReplies(runtime, () => losing) });
    const snapshot = {
      type: /** @type {const} */ ('saveSnapshot'),
      commandId: 'c-snap',
      noteId: 'A',
      snapshotId: 's1',
    };
    assert.equal(
      (await client.execute({ ...snapshot, blocks: [block('a1', 'A', 0, 'alpha')], title: 'Alpha plan' })).kind,
      'committed',
    );
    const save = {
      type: /** @type {const} */ ('saveNoteContent'),
      commandId: 'c-save',
      ...saveOfA([block('a1', 'A', 0, 'alpha, changed')]),
    };
    assert.equal((await client.execute(save)).kind, 'committed');
    losing = true;
    const restored = await client.execute({
      type: 'restoreSnapshot',
      commandId: 'c-restore',
      noteId: 'A',
      snapshotId: 's1',
      preSnapshotId: 's2',
      blocks: [block('a1', 'A', 0, 'alpha')],
      name: 'Alpha plan',
    });
    assert.equal(restored.kind, 'committed', JSON.stringify(restored));
    assert.equal((await storedBlocks(tab, 'A')).a1, 'alpha');
  });

  it('reads the Daily Note an ensure over the port made, once its answer is in (#74, R10)', async () => {
    const tab = await profile();
    /** @type {string[]} the page's queries, each once it's answered */
    const answered = [];
    const { reader, client } = newTab(tab, {
      // The worker takes a moment over the ensure: half a second, or until the page's read of the
      // Daily Note is answered, as a read sent without waiting for the ensure's answer would be
      before: async one => {
        if (one.type !== 'ensureDailyNote') return;
        for (const end = Date.now() + 500; Date.now() < end && !answered.includes('findDailyNote');) {
          await new Promise(resolve => setTimeout(resolve, 2));
        }
      },
    });
    const watched = Object.freeze({
      ...client,
      query: async (/** @type {any} */ query) => {
        const state = await client.query(query);
        answered.push(query.type);
        return state;
      },
    });
    const editor = createNewTabDocumentClient(/** @type {any} */ (watched), reader, {
      storage: tab.env.global.localStorage,
    });
    const { outcome, note } = await editor.ensureDailyNote('2026-11-08');
    assert.equal(outcome.kind, 'committed');
    assert.equal(/** @type {any} */ (note)?.dateStr, '2026-11-08', JSON.stringify(note));
  });

  it("answers reload-required, unsent, once the reader's connection closed for an upgrade, while the save its close's flush sent still goes (rule 12, R11)", async () => {
    const tab = await profile();
    const { stand, reader, client } = newTab(tab);
    assert.equal(await client.whenReady(), null);
    /** @type {Promise<unknown> | undefined} */
    let flushed;
    reader.beforeClose(() => {
      flushed = client.execute({
        type: 'saveNoteContent',
        commandId: 'c-flush',
        ...saveOfA([block('a1', 'A', 0, 'alpha, as the close flushed it')]),
      });
    });
    // Another context's upgrade, which closes every connection on the database
    await new Promise((resolve, reject) => {
      const request = tab.env.indexedDB.open(DB_NAME, DB_VERSION + 1);
      request.onsuccess = () => {
        request.result.close();
        resolve(undefined);
      };
      request.onerror = () => reject(request.error);
    });
    assert.ok(flushed, 'the flush ran');
    const after = await client.execute({ type: 'setPinned', commandId: 'c-pin', noteId: 'A', pinned: true });
    assert.deepEqual(after, unavailable('storage', 'reload-required', false));
    await flushed;
    assert.deepEqual(
      stand.handed.map(one => one.commandId),
      ['c-flush'],
      'the flush went, and nothing after it',
    );
  });

  it('opens no port before its first command, though its first read loads the send chunk at idle (Q6 a, G1)', async () => {
    const tab = await profile();
    let connects = 0;
    let loads = 0;
    const { client } = newTab(tab, {
      runtime: runtime => ({
        get lastError() {
          return runtime.lastError;
        },
        connect: (/** @type {unknown} */ info) => {
          connects += 1;
          return runtime.connect(info);
        },
      }),
      // The page's idle, at once
      requestIdle: callback => {
        callback();
      },
      send: () => {
        loads += 1;
        return import('../../js/kernel/composition/newtab-send-chunk.js');
      },
    });
    assert.equal(await client.whenReady(), null);
    assert.equal((await client.query({ type: 'getNote', noteId: 'A' })).kind, 'ready');
    assert.equal(await until(() => loads === 1), true, 'the first read loaded the chunk at idle');
    await settle();
    assert.equal(connects, 0, 'and opened no port');
    assert.equal(
      (await client.execute({ type: 'setPinned', commandId: 'c-pin', noteId: 'A', pinned: true })).kind,
      'committed',
    );
    assert.equal(connects, 1, 'the first command did');
  });
});

describe('the answers only the port gives a save (#35 slice 4d)', () => {
  /**
   * The new tab's save of A from the main pane, under `commandId`, with `content` in a1
   * @param {ReturnType<typeof newTabOn>['client']} client
   * @param {string} commandId
   * @param {string} content
   */
  const save = (client, commandId, content) =>
    client.execute(
      { type: 'saveNoteContent', commandId, ...saveOfA([block('a1', 'A', 0, content)]) },
      { pane: 'main' },
    );

  /** @param {LegacyContext} tab */
  const entriesOf = async tab => (await journalOf(tab)).map(entry => entry.opId);

  it('hands a save answered migrating to the editor as it came, keeps its journal entry, and the next save commits once the worker is done migrating (rule 18, R22)', async () => {
    const tab = await profile();
    let migrating = true;
    const { client } = newTab(tab, {
      answer: one =>
        migrating && one.type === 'saveNoteContent' ? unavailable('coordinator', 'migrating', true) : undefined,
    });
    assert.deepEqual(
      await save(client, 'c-1', 'alpha, typed as it migrates'),
      unavailable('coordinator', 'migrating', true),
    );
    assert.deepEqual(await entriesOf(tab), ['c-1'], 'its entry stays');
    migrating = false;
    assert.equal((await save(client, 'c-2', 'alpha, typed as it migrates')).kind, 'committed');
    assert.deepEqual(await entriesOf(tab), [], "and goes with the next save's commit");
    assert.equal((await storedBlocks(tab, 'A')).a1, 'alpha, typed as it migrates');
  });

  it('keeps the entry of a save whose answer stays unknown, and its retry under a new key commits the latest text, makes no conflict record, and takes that entry with it (N3, R24)', async () => {
    const tab = await profile();
    // An answer the worker's router can't send, so the page hears outcome-unknown, twice, and the
    // ledger has nothing of it
    const { client } = newTab(tab, {
      answer: one => (one.commandId === 'c-1' ? /** @type {any} */ ({ kind: 'nonsense' }) : undefined),
    });
    const first = await save(client, 'c-1', 'alpha, first');
    assert.deepEqual(first.kind === 'unknown' && first.code, 'outcome-unknown');
    assert.deepEqual(await entriesOf(tab), ['c-1'], 'its entry stays');
    assert.equal((await save(client, 'c-2', 'alpha, first, then more')).kind, 'committed');
    assert.equal((await storedBlocks(tab, 'A')).a1, 'alpha, first, then more');
    assert.deepEqual(
      (await legacyEnv.dumpDatabase(tab.env.indexedDB)).stores.conflicts.records,
      [],
      'no conflict record',
    );
    assert.deepEqual(await entriesOf(tab), [], "the stale entry went with the retry's commit");
  });

  it('keeps the entry of a save answered deadline-exceeded, as one the worker held past its deadline, and the next save commits the text (S3, R25)', async () => {
    const tab = await profile();
    const { client } = newTab(tab, {
      answer: one => (one.commandId === 'c-1' ? unavailable('coordinator', 'deadline-exceeded', true) : undefined),
    });
    assert.deepEqual(
      await save(client, 'c-1', 'alpha, behind a long turn'),
      unavailable('coordinator', 'deadline-exceeded', true),
    );
    assert.deepEqual(await entriesOf(tab), ['c-1'], 'its entry stays');
    assert.equal((await save(client, 'c-2', 'alpha, behind a long turn')).kind, 'committed');
    assert.equal((await storedBlocks(tab, 'A')).a1, 'alpha, behind a long turn');
    assert.deepEqual(await entriesOf(tab), []);
  });

  it('refuses a save over the ceiling before it goes, as payload-too-large, and ends its journal entry (#259, R26)', async () => {
    const tab = await profile();
    const { stand, client } = newTab(tab);
    // A quote is two bytes in the codec's text, and four once Chrome encodes that text as JSON again
    const quotes = Math.floor(COMMAND_CEILING_BYTES * 0.3);
    assert.deepEqual(await save(client, 'c-big', '"'.repeat(quotes)), rejected('validation', 'payload-too-large'));
    assert.equal(stand.frames.filter(frame => frame.operation === 'saveNoteContent').length, 0, 'it never went');
    assert.deepEqual(await entriesOf(tab), [], 'its entry ended');
    assert.equal((await storedBlocks(tab, 'A')).a1, 'alpha', 'and nothing was stored');
  });
});
