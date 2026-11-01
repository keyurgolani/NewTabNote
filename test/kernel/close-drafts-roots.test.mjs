// The close-time drafts in each root (#33, the stack's close-time PR): the new tab applies them
// before its note list's first read, from the applier its start holds, and Popup and Side Panel
// before theirs, from the `close-drafts` chunk they load only when their localStorage holds a
// draft or 1.4.3's catch-up key (composition/close-drafts.js, the lead's option 1). Each apply
// runs under the Web Lock `ntn-close-drafts`, with each key read again inside it
// (core/application/close-drafts.js). Each recovered note goes on the untold list once, whichever
// page made it, and each note in the Trash a draft was saved into on `ntn-saved-untold` (QA2).
// Every delete for good holds the same lock around its command and its clear (the lead's Q7), so
// an apply and a delete never interleave. clearAll clears everything, and 1.4.3's catch-up key
// is read at the first start, then removed (QA4). On legacy-env pages over one profile, sharing
// their localStorage and Web Locks.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { applyCloseDrafts, closeDraftStore } from '../../js/kernel/core/application/close-drafts.js';
import { CATCH_UP_KEY, DRAFTS_LOCK, SAVED_UNTOLD_KEY, UNTOLD_KEY } from '../../js/kernel/core/domain/close-draft-keys.js';
import { applyingCloseDrafts } from '../../js/kernel/composition/close-drafts.js';
import { waitForWorkerUpgrade } from '../../js/kernel/composition/host.js';
import {
  createNewTabAdapter,
  createNewTabClient,
  createNewTabNoteList,
  createNewTabPageClient,
  withCloseDraftClears,
} from '../../js/kernel/composition/newtab.js';
import { createPopupClient } from '../../js/kernel/composition/popup.js';
import { createSidePanelClient } from '../../js/kernel/composition/sidepanel.js';
import { blockDigest, recoveredIdOf } from '../../js/kernel/core/domain/close-draft.js';
import { legacyContext, legacyEnv } from './legacy-fixture.mjs';

/** @typedef {import('./legacy-fixture.mjs').LegacyContext} LegacyContext */
/** @typedef {import('../../js/kernel/composition/host.js').Client} Client */
/** @typedef {import('../../js/kernel/core/domain/close-draft.js').CloseDraft} CloseDraft */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').Command} Command */
/** @typedef {import('../../js/kernel/composition/close-drafts.js').Applier} Applier */
/** @typedef {any} Row */

const AT = Date.UTC(2026, 9, 31, 21, 41);
const PREFIX = 'ntn-close-draft:';

/** @type {(id: string, canvasId: string, order: number, content?: string, fields?: Row) => Row} */
const block = (id, canvasId, order, content, fields) => legacyEnv.block(id, canvasId, order, content, fields);

/** The applier the new tab's start holds, as Popup and Side Panel load it */
const LOAD = () => import('../../js/kernel/core/application/close-drafts.js');

/**
 * What the new tab's root reads from its page's globals (newtab.js, newTabHost)
 * @param {LegacyContext} context
 */
const hostOf = context => ({
  indexedDB: context.env.indexedDB,
  settings: context.env.chrome.api.storage.local,
  awaitUpgrade: () => waitForWorkerUpgrade({ runtime: context.env.chrome.api.runtime }),
  locks: context.env.global.navigator.locks || null,
});

/**
 * What Popup's and Side Panel's roots read from a page's globals
 * @param {LegacyContext} context
 */
const pageHostOf = context => ({
  indexedDB: context.env.indexedDB,
  settings: context.env.chrome.api.storage.local,
  awaitUpgrade: async () => {},
});

/**
 * The page's localStorage and Web Locks, as pageDrafts() reads them from its globals
 * @param {LegacyContext} context
 */
const draftsOf = context => ({ storage: context.env.global.localStorage, locks: context.env.global.navigator.locks });

/**
 * The page's apply, as a root runs it, through `client`
 * @param {LegacyContext} context
 * @param {import('../../js/kernel/core/application/close-drafts.js').DraftClient} client
 */
const applyIn = (context, client) =>
  applyCloseDrafts({ client, store: closeDraftStore(context.env.global.localStorage), locks: context.env.global.navigator.locks });

/**
 * A profile with note A, its blocks a1 and a2, and note B, made by a new tab, whose client it
 * answers, and the page a test's roots share it with
 */
async function profileWithA() {
  const tab = legacyContext();
  const client = createNewTabClient(createNewTabAdapter(hostOf(tab)));
  assert.equal(await client.whenReady(), null);
  /** @param {Command} command */
  const run = async command => {
    const outcome = await client.execute(command);
    assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
    return outcome;
  };
  await run({
    type: 'createNote',
    commandId: client.ids.next(),
    noteId: 'A',
    name: 'Alpha plan',
    blocks: [block('a1', 'A', 0, 'alpha'), block('a2', 'A', 1, 'alpha two')],
  });
  await run({ type: 'createNote', commandId: client.ids.next(), noteId: 'B', name: 'Bravo' });
  return { tab, client, run };
}

/**
 * A stack draft of A's edit, a1 changed, on the base its page saw at revision `revision`
 * @param {Partial<CloseDraft> & {revision?: number}} [fields]
 * @returns {CloseDraft}
 */
const draftOfA = ({ revision = 0, ...fields } = {}) =>
  /** @type {CloseDraft} */ ({
    v: 1,
    id: 'draft-a',
    page: 'page-1',
    noteId: 'A',
    at: AT,
    base: {
      revision,
      updatedAt: null,
      issued: [],
      name: 'Alpha plan',
      blocks: { a1: blockDigest(block('a1', 'A', 0, 'alpha'), 'A'), a2: blockDigest(block('a2', 'A', 1, 'alpha two'), 'A') },
      issuedSaves: [],
    },
    blocks: [block('a1', 'A', 0, 'alpha, edited as the tab closed')],
    deletedBlockIds: [],
    preview: 'alpha, edited as the tab closed',
    todoProgress: null,
    linkedNames: [],
    ...fields,
  });

/**
 * @param {LegacyContext} context
 * @param {CloseDraft} draft
 */
const write = (context, draft) => context.env.global.localStorage.setItem(PREFIX + draft.id, JSON.stringify(draft));

/** @param {LegacyContext} context */
const keysOf = context => {
  const storage = context.env.global.localStorage;
  return Array.from({ length: storage.length }, (_, index) => storage.key(index));
};

/**
 * @param {LegacyContext} context
 * @param {string} key
 */
const listOf = (context, key) => JSON.parse(context.env.global.localStorage.getItem(key) || 'null');

/**
 * Note `noteId`'s blocks, as `client` reads them
 * @param {Client} client
 * @param {string} noteId
 * @returns {Promise<Record<string, Row>>}
 */
async function blocksOf(client, noteId) {
  const blocks = await client.query({ type: 'getNoteBlocks', noteId });
  return blocks.kind === 'ready' ? Object.fromEntries(blocks.data.map(row => [row.id, row])) : {};
}

/**
 * A loader that counts its loads, and Web Locks that count what they grant
 * @param {LegacyContext} context
 */
function counted(context) {
  const counts = { loads: 0, locks: 0 };
  /** @returns {Promise<Applier>} */
  const load = () => {
    counts.loads++;
    return LOAD();
  };
  const real = context.env.global.navigator.locks;
  const locks = {
    request: /** @type {any} */ ((/** @type {string} */ name, /** @type {any} */ options, /** @type {() => Promise<unknown>} */ run) => {
      counts.locks++;
      return real.request(name, options, run);
    }),
  };
  return { counts, load, drafts: { storage: context.env.global.localStorage, locks } };
}

const PAGES = /** @type {const} */ ([
  ['Popup', createPopupClient, 'popup'],
  ['Side Panel', createSidePanelClient, 'sidePanel'],
]);

describe('the close-time drafts at each start', () => {
  it("the new tab applies them before its note list's first read, and removes them", async () => {
    const { tab } = await profileWithA();
    write(tab, draftOfA());
    const client = createNewTabPageClient(createNewTabAdapter(hostOf(tab)), { drafts: draftsOf(tab), wake: () => {} });
    const noteList = createNewTabNoteList(client);
    await noteList.settled();
    assert.equal(noteList.note('A')?.preview, 'alpha, edited as the tab closed', 'the first read has the edit in');
    assert.deepEqual(keysOf(tab), []);
  });

  for (const [page, create, view] of PAGES) {
    it(`${page} loads the applier and applies them before its first list read`, async () => {
      const { tab } = await profileWithA();
      write(tab, draftOfA());
      const { counts, load, drafts } = counted(tab);
      const client = create(pageHostOf(tab), drafts, load);
      assert.equal(await client.whenReady(), null);
      const listed = await client.query({ type: 'listNotes', view });
      assert.equal(listed.kind === 'ready' && listed.data.find(row => row.id === 'A')?.preview, 'alpha, edited as the tab closed');
      assert.deepEqual(keysOf(tab), []);
      assert.deepEqual(counts, { loads: 1, locks: 1 });
    });

    it(`${page} reads nothing before the apply is done when a draft is there`, async () => {
      const { tab } = await profileWithA();
      write(tab, draftOfA());
      /** @type {string[]} */
      const order = [];
      // An applier that loads late, and says when its apply is done
      /** @returns {Promise<Applier>} */
      const load = async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        const applier = await LOAD();
        return {
          closeDraftStore: applier.closeDraftStore,
          applyCloseDrafts: async options => {
            const result = await applier.applyCloseDrafts(options);
            order.push('applied');
            return result;
          },
        };
      };
      const client = create(pageHostOf(tab), draftsOf(tab), load);
      // What the page does at its start: wait for whenReady, then read
      await client.whenReady().then(() => order.push('ready'));
      const listed = await client.query({ type: 'listNotes', view });
      order.push('read');
      assert.deepEqual(order, ['applied', 'ready', 'read']);
      assert.equal(listed.kind === 'ready' && listed.data.find(row => row.id === 'A')?.preview, 'alpha, edited as the tab closed');
    });

    it(`${page} keeps the drafts for the next start when the applier can't load, and starts on what's stored`, async () => {
      const { tab } = await profileWithA();
      write(tab, draftOfA());
      /** @type {Array<[string, Record<string, unknown>]>} */
      const told = [];
      const warn = console.warn;
      console.warn = (/** @type {string} */ event, /** @type {Record<string, unknown>} */ detail) => {
        told.push([event, detail]);
      };
      try {
        const client = create(pageHostOf(tab), draftsOf(tab), () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')));
        assert.equal(await client.whenReady(), null);
        const listed = await client.query({ type: 'listNotes', view });
        assert.equal(listed.kind === 'ready' && listed.data.find(row => row.id === 'A')?.preview, '', 'as stored: the edit waits in its draft');
      } finally {
        console.warn = warn;
      }
      assert.deepEqual(keysOf(tab), [`${PREFIX}draft-a`], 'the draft stays');
      assert.deepEqual(told.map(([event]) => event), ['NewTabNote close-time drafts: close-drafts-not-applied']);
    });

    it(`${page} loads nothing and takes no lock for an untold entry with no draft, nor for nothing at all`, async () => {
      const { tab } = await profileWithA();
      const { counts, load, drafts } = counted(tab);
      assert.equal(await create(pageHostOf(tab), drafts, load).whenReady(), null);
      tab.env.global.localStorage.setItem(UNTOLD_KEY, JSON.stringify([{ id: 'draft-x-recovered', of: 'A' }]));
      tab.env.global.localStorage.setItem(SAVED_UNTOLD_KEY, JSON.stringify([{ id: 'B' }]));
      assert.equal(await create(pageHostOf(tab), drafts, load).whenReady(), null);
      assert.deepEqual(counts, { loads: 0, locks: 0 });
      assert.deepEqual(keysOf(tab).sort(), [SAVED_UNTOLD_KEY, UNTOLD_KEY].sort(), 'the lists wait for the new tab');
    });
  }

  it('puts each recovered note on the untold list once, and each note in the Trash a draft was saved into on its own list (V3)', async () => {
    const { tab, client, run } = await profileWithA();
    // Another tab saved a1 since the draft's base, so the draft becomes a recovered note
    await run({ type: 'saveNoteContent', commandId: client.ids.next(), noteId: 'A', blocks: [block('a1', 'A', 0, 'alpha, from another tab')] });
    const recovered = draftOfA();
    write(tab, recovered);
    // B is in the Trash, and its draft saves into it
    await run({ type: 'trashNote', commandId: client.ids.next(), noteId: 'B' });
    write(tab, draftOfA({ id: 'draft-b', noteId: 'B', at: AT + 1, base: { revision: 0, updatedAt: null, issued: [], name: 'Bravo', blocks: {}, issuedSaves: [] }, blocks: [block('b1', 'B', 0, 'bravo, edited')] }));
    const result = await applyIn(tab, client);
    const recoveredId = recoveredIdOf(recovered);
    assert.deepEqual([result.recovered, result.savedInTrash], [[{ noteId: 'A', recoveredId }], ['B']]);
    assert.deepEqual(listOf(tab, UNTOLD_KEY), [{ id: recoveredId, of: 'A' }]);
    assert.deepEqual(listOf(tab, SAVED_UNTOLD_KEY), [{ id: 'B' }]);
    // A start cut short before its remove leaves the draft: the next start tells nothing twice
    write(tab, recovered);
    const again = await applyIn(tab, client);
    assert.deepEqual(again.recovered, [{ noteId: 'A', recoveredId }]);
    assert.deepEqual(listOf(tab, UNTOLD_KEY), [{ id: recoveredId, of: 'A' }]);
    const notes = await client.query({ type: 'listNotes', view: 'sidePanel' });
    assert.equal(notes.kind === 'ready' && notes.data.filter(row => row.id === recoveredId).length, 1, 'one recovered note');
  });

  it('two pages starting together take turns: each draft is applied once', async () => {
    const { tab } = await profileWithA();
    write(tab, draftOfA());
    const popup = createPopupClient(pageHostOf(tab), draftsOf(tab), LOAD);
    const panel = createSidePanelClient(pageHostOf(tab), draftsOf(tab), LOAD);
    const [first, second] = await Promise.all([popup.applied(), panel.applied()]);
    assert.deepEqual([first?.saved || [], second?.saved || []].flat(), ['A']);
    assert.deepEqual([...(first?.dropped || []), ...(second?.dropped || [])], [], 'the second found the draft gone, not already in');
  });

  it('reads each key again inside the lock, so a draft cleared after the list is never applied', async () => {
    const { tab, client } = await profileWithA();
    write(tab, draftOfA());
    const store = closeDraftStore(tab.env.global.localStorage);
    // A store that clears the draft the moment the list has it, as a delete for good would have
    const clearing = {
      ...store,
      list: () => {
        const listed = store.list();
        store.clearNotes(['A']);
        return listed;
      },
    };
    const result = await applyCloseDrafts({ client, store: clearing, locks: tab.env.global.navigator.locks });
    assert.deepEqual([result.saved, result.kept], [[], []]);
    assert.equal((await blocksOf(client, 'A')).a1.content, 'alpha');
  });

  it('keeps a draft the kernel refused, telling only its code, and one it could not reach storage for', async () => {
    const { tab } = await profileWithA();
    write(tab, draftOfA());
    const store = closeDraftStore(tab.env.global.localStorage);
    /** @type {Array<[string, Record<string, unknown>]>} */
    const told = [];
    const refusing = { execute: async () => ({ kind: 'rejected', reason: 'validation', code: 'invalid-command', messageKey: 'x', severity: 'error' }) };
    const refused = await applyCloseDrafts({ client: refusing, store, logger: { warn: (event, detail) => told.push([event, detail]) } });
    assert.deepEqual(refused.kept, ['A']);
    assert.deepEqual(told, [['close-draft-refused', { code: 'invalid-command' }]]);
    const unavailable = { execute: async () => ({ kind: 'unavailable', cause: 'storage', code: 'reload-required', retryable: false, messageKey: 'x', severity: 'error' }) };
    assert.deepEqual((await applyCloseDrafts({ client: unavailable, store })).kept, ['A']);
    assert.deepEqual(keysOf(tab), [`${PREFIX}draft-a`], 'the draft stays for the next start');
  });

  it("reads 1.4.3's catch-up key at the first start, then removes it (QA4), on every page", async () => {
    for (const create of [createPopupClient, createSidePanelClient]) {
      const { tab } = await profileWithA();
      tab.env.global.localStorage.setItem(CATCH_UP_KEY, JSON.stringify({ dropped: ['A'], gone: ['Z'] }));
      const client = create(pageHostOf(tab), draftsOf(tab), LOAD);
      assert.deepEqual((await client.applied())?.catchUp, { dropped: ['A'], gone: ['Z'] });
      assert.deepEqual(keysOf(tab), []);
    }
    const { tab } = await profileWithA();
    tab.env.global.localStorage.setItem(CATCH_UP_KEY, JSON.stringify({ dropped: [], gone: ['Z'] }));
    const newTab = createNewTabPageClient(createNewTabAdapter(hostOf(tab)), { drafts: draftsOf(tab), wake: () => {} });
    assert.deepEqual((await newTab.applied())?.catchUp, { dropped: [], gone: ['Z'] });
    assert.deepEqual(keysOf(tab), []);
  });

  it("clearAll clears every draft, both untold lists, and 1.4.3's catch-up key, and nothing else", async () => {
    const { tab } = await profileWithA();
    write(tab, draftOfA());
    const storage = tab.env.global.localStorage;
    storage.setItem(UNTOLD_KEY, JSON.stringify([{ id: 'r1', of: 'A' }]));
    storage.setItem(SAVED_UNTOLD_KEY, JSON.stringify([{ id: 'B' }]));
    storage.setItem(CATCH_UP_KEY, JSON.stringify({ dropped: [], gone: [] }));
    storage.setItem('another-key', 'stays');
    closeDraftStore(storage).clearAll();
    assert.deepEqual(keysOf(tab), ['another-key']);
  });

  it('a whenReady that a kernel which couldn\'t open answers applies nothing', async () => {
    const fresh = legacyContext(undefined, { worker: false });
    write(fresh, draftOfA());
    const { counts, load, drafts } = counted(fresh);
    const failure = await createPopupClient(pageHostOf(fresh), drafts, load).whenReady();
    assert.deepEqual(failure && [failure.cause, failure.code], ['storage', 'no-database']);
    assert.deepEqual(counts, { loads: 0, locks: 0 });
    assert.deepEqual(keysOf(fresh), [`${PREFIX}draft-a`]);
  });
});

describe("every delete for good, under the drafts' lock (the lead's Q7)", () => {
  /**
   * A's draft, and untold entries naming A as a recovered note and as an original, with B's
   * draft and entries beside them, which stay
   * @param {LegacyContext} tab
   */
  function leave(tab) {
    write(tab, draftOfA());
    write(tab, draftOfA({ id: 'draft-b', noteId: 'B', at: AT + 2 }));
    const storage = tab.env.global.localStorage;
    storage.setItem(UNTOLD_KEY, JSON.stringify([{ id: 'draft-x-recovered', of: 'A' }, { id: 'A', of: 'C' }, { id: 'draft-y-recovered', of: 'B' }]));
    storage.setItem(SAVED_UNTOLD_KEY, JSON.stringify([{ id: 'A' }, { id: 'B' }]));
  }

  /**
   * What's left once A is gone for good: B's draft and entries
   * @param {LegacyContext} tab
   */
  function leftAfterA(tab) {
    assert.deepEqual(keysOf(tab).filter(key => key.startsWith(PREFIX)).sort(), [`${PREFIX}draft-b`], "A's draft gone, B's kept");
    assert.deepEqual(listOf(tab, UNTOLD_KEY), [{ id: 'draft-y-recovered', of: 'B' }]);
    assert.deepEqual(listOf(tab, SAVED_UNTOLD_KEY), [{ id: 'B' }]);
  }

  /**
   * The new tab's client on `client`, holding the lock and clearing, as its root builds it
   * @param {LegacyContext} tab
   * @param {Client} client
   */
  const clearingClient = (tab, client) =>
    withCloseDraftClears(client, { store: closeDraftStore(tab.env.global.localStorage), locks: tab.env.global.navigator.locks });

  it('a permanent delete clears what the note left, and so does a bulk delete', async () => {
    for (const bulk of [false, true]) {
      const { tab, client } = await profileWithA();
      const clearing = clearingClient(tab, client);
      assert.equal((await clearing.execute({ type: 'trashNote', commandId: client.ids.next(), noteId: 'A' })).kind, 'committed');
      leave(tab);
      const outcome = bulk
        ? await clearing.execute({ type: 'runBulkAction', commandId: client.ids.next(), action: 'delete', noteIds: ['A'] })
        : await clearing.execute({ type: 'deleteNotePermanently', commandId: client.ids.next(), noteId: 'A' });
      assert.equal(outcome.kind, bulk ? 'bulk' : 'committed');
      leftAfterA(tab);
    }
  });

  it('Empty Trash and trash retention clear what their notes left', async () => {
    for (const type of /** @type {const} */ (['emptyTrash', 'runTrashCleanup'])) {
      const { tab, client } = await profileWithA();
      const clearing = clearingClient(tab, client);
      assert.equal((await clearing.execute({ type: 'trashNote', commandId: client.ids.next(), noteId: 'A' })).kind, 'committed');
      if (type === 'runTrashCleanup') {
        // Kept for a day, and A went in the Trash two days ago
        tab.env.chrome.local.setting_trashRetention = 1;
        const db = await legacyEnv.requestToPromise(tab.env.indexedDB.open('CanvasTabDB'));
        const notes = db.transaction('canvases', 'readwrite').objectStore('canvases');
        const read = await legacyEnv.requestToPromise(notes.get('A'));
        await legacyEnv.requestToPromise(notes.put({ ...read, trashedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 }));
        db.close();
      }
      leave(tab);
      const outcome = await clearing.execute({ type, commandId: client.ids.next() });
      assert.equal(outcome.kind === 'committed' && outcome.changedIds.includes('A'), true, JSON.stringify(outcome));
      leftAfterA(tab);
    }
  });

  it("the Trash's delete for good of an empty untitled note clears what it left", async () => {
    const { tab, client, run } = await profileWithA();
    await run({ type: 'createNote', commandId: client.ids.next(), noteId: 'E' });
    write(tab, draftOfA({ id: 'draft-e', noteId: 'E' }));
    const outcome = await clearingClient(tab, client).execute({ type: 'trashNote', commandId: client.ids.next(), noteId: 'E' });
    assert.deepEqual(outcome.kind === 'committed' && [outcome.code, outcome.changedIds], ['note-deleted', ['E']]);
    assert.deepEqual(keysOf(tab), []);
  });

  it('a trash, an archive, or a folder deleted clears nothing', async () => {
    const { tab, client, run } = await profileWithA();
    const clearing = clearingClient(tab, client);
    await run({ type: 'createFolder', commandId: client.ids.next(), folderId: 'F', name: 'Work', parentId: null });
    await run({ type: 'moveNoteToFolder', commandId: client.ids.next(), noteId: 'B', folderId: 'F' });
    leave(tab);
    for (const command of [
      { type: 'trashNote', commandId: client.ids.next(), noteId: 'A' },
      { type: 'archiveNote', commandId: client.ids.next(), noteId: 'B' },
      { type: 'deleteFolder', commandId: client.ids.next(), folderId: 'F' },
    ]) assert.equal((await clearing.execute(/** @type {Command} */ (command))).kind, 'committed');
    assert.equal(keysOf(tab).filter(key => key.startsWith(PREFIX)).length, 2);
    assert.equal(listOf(tab, UNTOLD_KEY).length, 3);
  });

  it("waits for an apply under way, so a recovered note deleted for good meanwhile isn't made again", async () => {
    // A's draft whose recovered note R an earlier start made, its page gone before the remove
    const { tab, client, run } = await profileWithA();
    await run({ type: 'saveNoteContent', commandId: client.ids.next(), noteId: 'A', blocks: [block('a1', 'A', 0, 'alpha, from another tab')] });
    const draft = draftOfA();
    write(tab, draft);
    const recoveredId = recoveredIdOf(draft);
    // The first apply makes R, as the earlier start did, and the user puts R in the Trash
    assert.deepEqual((await applyIn(tab, client)).recovered, [{ noteId: 'A', recoveredId }]);
    await run({ type: 'trashNote', commandId: client.ids.next(), noteId: recoveredId });
    write(tab, draft);
    // An apply that has listed the draft and read its key again, then waits before its command
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise(resolve => {
      release = () => resolve(undefined);
    });
    let waiting = true;
    const slow = {
      execute: async (/** @type {Command} */ command) => {
        if (command.type === 'applyCloseDraft' && waiting) {
          waiting = false;
          await held;
        }
        return client.execute(command);
      },
    };
    const applying = applyIn(tab, slow);
    // The user deletes R for good while that apply waits
    const deleting = clearingClient(tab, client).execute({ type: 'deleteNotePermanently', commandId: client.ids.next(), noteId: recoveredId });
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    await Promise.all([applying, deleting]);
    const notes = await client.query({ type: 'listNotes', view: 'sidePanel' });
    assert.deepEqual(notes.kind === 'ready' && notes.data.map(row => row.id).sort(), ['A', 'B'], 'no copy of R is left');
    assert.deepEqual(keysOf(tab).filter(key => key.startsWith(PREFIX)), []);
  });

  it("is held under 1.4.3's lock name", () => {
    assert.equal(DRAFTS_LOCK, 'ntn-close-drafts');
  });
});

describe('applyingCloseDrafts, on its own', () => {
  it('applies once, however often whenReady is asked', async () => {
    const { tab, client } = await profileWithA();
    write(tab, draftOfA());
    let loads = 0;
    const wrapped = applyingCloseDrafts(client, draftsOf(tab), {
      load: () => {
        loads++;
        return LOAD();
      },
    });
    await Promise.all([wrapped.whenReady(), wrapped.whenReady(), wrapped.applied()]);
    await wrapped.whenReady();
    assert.equal(loads, 1);
  });
});
