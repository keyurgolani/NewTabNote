// #35 slice 4b-2: Popup's page side once its writes go to the worker over #13's port (the 4b
// plan's rules 3, 7, 8, 9 and 10, Q9 and Q11). Popup's root reads in the page, on #17's reader, and
// sends its quick note and a closing tab's edit through its send chunk, which it loads as it
// starts. Each command waits for the chunk in order, then for the journal's owner lock, and goes,
// journaled as the catalog says, on the session the worker's router knows the page by, the one its
// journal names, so the drain on a closed port waits on that page alone. A chunk that can't load
// sends nothing. On legacy-env profiles, with a stand-in for the worker (popup-worker.mjs).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inContextStores } from '../../js/kernel/adapters/in-context.js';
import { waitForWorkerUpgrade } from '../../js/kernel/composition/host.js';
import { createNewTabAdapter, createNewTabClient } from '../../js/kernel/composition/newtab.js';
import { createPopupClient } from '../../js/kernel/composition/popup.js';
import { MAX_MESSAGE_BYTES } from '../../js/kernel/core/contracts/limits.js';
import { committed, unavailable } from '../../js/kernel/core/contracts/outcomes.js';
import { blockDigest } from '../../js/kernel/core/domain/close-draft.js';
import { DRAFT_PREFIX } from '../../js/kernel/core/domain/close-draft-keys.js';
import { ownerLock } from '../../js/kernel/core/domain/journal.js';
import { legacyContext, legacyEnv } from './legacy-fixture.mjs';
import { settle, testScheduler } from './messaging-support.mjs';
import { popupWorker } from './popup-worker.mjs';

/** @typedef {import('./legacy-fixture.mjs').LegacyContext} LegacyContext */
/** @typedef {import('./popup-worker.mjs').Handed} Handed */
/** @typedef {import('../../js/kernel/core/ports/runtime.js').Timers} Timers */

/**
 * Popup's root, with a host, its drafts, the applier and the send chunk's loader
 * @type {(...args: unknown[]) => ReturnType<typeof createPopupClient>}
 */
const popupClient = /** @type {any} */ (createPopupClient);

/** Q11's wait */
const APPLY_WAIT_MS = 2000;

/** @type {(id: string, canvasId: string, order: number, content?: string) => any} */
const block = (id, canvasId, order, content) => legacyEnv.block(id, canvasId, order, content);

/** A profile with note A and its blocks a1 and a2, which a new tab made */
async function profile() {
  const tab = legacyContext();
  const newtab = createNewTabClient(
    createNewTabAdapter({
      indexedDB: tab.env.indexedDB,
      settings: tab.env.chrome.api.storage.local,
      awaitUpgrade: () => waitForWorkerUpgrade({ runtime: tab.env.chrome.api.runtime }),
      locks: tab.env.global.navigator.locks || null,
    }),
  );
  assert.equal(await newtab.whenReady(), null);
  const blocks = [block('a1', 'A', 0, 'alpha'), block('a2', 'A', 1, 'alpha two')];
  const made = await newtab.execute({
    type: 'createNote',
    commandId: newtab.ids.next(),
    noteId: 'A',
    name: 'Alpha plan',
    blocks,
  });
  assert.equal(made.kind, 'committed');
  return tab;
}

/**
 * Popup on `tab`'s profile, its writes to a stand-in for the worker
 * @param {LegacyContext} tab
 * @param {{status?: any, before?: (handed: Handed) => unknown, timers?: Timers, locks?: unknown, send?: () => Promise<unknown>}} [options]
 */
function popupOn(tab, { status, before, timers, locks, send } = {}) {
  const stand = popupWorker({
    indexedDB: tab.env.indexedDB,
    settings: tab.env.chrome.api.storage.local,
    status,
    before,
  });
  const host = {
    indexedDB: tab.env.indexedDB,
    settings: tab.env.chrome.api.storage.local,
    awaitUpgrade: async () => {},
    runtime: stand.runtime,
    extensionVersion: stand.extensionVersion,
    locks: locks || tab.env.global.navigator.locks,
    ...(timers ? { timers } : {}),
  };
  const drafts = { storage: tab.env.global.localStorage, locks: tab.env.global.navigator.locks };
  return { stand, client: popupClient(host, drafts, undefined, send) };
}

/**
 * The quick note, under ids of its own
 * @param {{ids: {next(): string}}} client
 */
const quickNote = (client, name = 'Quick note') => ({
  type: /** @type {const} */ ('createNote'),
  commandId: client.ids.next(),
  noteId: client.ids.next(),
  name,
});

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
 * A closing tab's edit of A, a1 changed, on the base the tab saw, with `content` for a1
 * @param {LegacyContext} tab
 */
function writeDraft(tab, content = 'alpha, edited as the tab closed') {
  const draft = {
    v: 1,
    id: 'draft-a',
    page: 'page-1',
    noteId: 'A',
    at: Date.UTC(2026, 10, 6, 9, 0),
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
  tab.env.global.localStorage.setItem(`${DRAFT_PREFIX}${draft.id}`, JSON.stringify(draft));
  return `${DRAFT_PREFIX}${draft.id}`;
}

describe("Popup's writes, over #13's port (#35 slice 4b-2)", () => {
  it('sends the quick note to the worker as popup, journaled until its answer, and it commits there (rule 3)', async () => {
    const tab = await profile();
    let journaled = false;
    const { stand, client } = popupOn(tab, {
      before: async one => {
        journaled = await until(async () => (await journalOf(tab)).some(entry => entry.opId === one.commandId));
      },
    });
    const note = quickNote(client);
    const outcome = await client.execute(note);
    assert.deepEqual(outcome.kind === 'committed' && [outcome.code, outcome.changedIds], [
      'note-created',
      [note.noteId],
    ]);
    assert.deepEqual(
      stand.handed.map(one => [one.surface, one.type, one.commandId]),
      [['popup', 'createNote', note.commandId]],
    );
    assert.equal(journaled, true, 'its entry was in the journal while the worker held it');
    assert.deepEqual(
      (await journalOf(tab)).map(entry => entry.opId),
      [],
      'and went with its answer',
    );
    stand.close();
  });

  it('lists the quick note right after the reply, read in the page (rule 8, #74)', async () => {
    const tab = await profile();
    const { stand, client } = popupOn(tab);
    assert.equal((await client.execute(quickNote(client, 'Read right after'))).kind, 'committed');
    assert.deepEqual(
      stand.handed.map(one => one.type),
      ['createNote'],
      'the worker committed it',
    );
    const listed = await client.query({ type: 'listNotes', view: 'popup' });
    assert.ok(
      listed.kind === 'ready' && listed.data.some(row => row.name === 'Read right after'),
      JSON.stringify(listed),
    );
    stand.close();
  });

  it('sends the quick note on a starting welcome too, which it never reads as a failure (rule 9)', async () => {
    const tab = await profile();
    const { stand, client } = popupOn(tab, { status: () => ({ status: 'degraded', reason: 'starting' }) });
    try {
      const sent = client.execute(quickNote(client));
      assert.equal(
        await until(() => stand.handed.length === 1),
        true,
        'the worker got it while the welcome said starting',
      );
      assert.equal((await sent).kind, 'committed');
      assert.deepEqual(
        stand.handed.map(one => one.type),
        ['createNote'],
      );
    } finally {
      stand.close();
    }
  });

  it("sends nothing for a closing tab's edit over the port's 1 MiB, which stays for a page that applies it in-process (rule 10)", async () => {
    const tab = await profile();
    const key = writeDraft(tab, 'x'.repeat(MAX_MESSAGE_BYTES));
    const { stand, client } = popupOn(tab);
    assert.equal(await client.whenReady(), null);
    assert.deepEqual(
      stand.frames.filter(frame => frame.operation === 'applyCloseDraft'),
      [],
      'nothing went on the port',
    );
    assert.notEqual(tab.env.global.localStorage.getItem(key), null, 'the draft stays');
    assert.deepEqual((await client.applied())?.kept, ['A'], "Popup's start applied it, and kept it");
    stand.close();
  });

  it("waits at most 2 s for the start's apply, then reads what's stored, and applied answers once it's done (Q11)", async () => {
    const tab = await profile();
    writeDraft(tab);
    /** @type {(value?: unknown) => void} */
    let release = () => {};
    const held = new Promise(resolve => {
      release = resolve;
    });
    const scheduler = testScheduler();
    const { stand, client } = popupOn(tab, {
      timers: scheduler.timers,
      before: one => (one.type === 'applyCloseDraft' ? held : undefined),
    });
    let ready = false;
    client.whenReady().then(() => {
      ready = true;
    });
    assert.ok(await until(() => stand.handed.some(one => one.type === 'applyCloseDraft')), 'the apply sent the edit');
    await scheduler.advance(APPLY_WAIT_MS - 1);
    assert.equal(ready, false, 'it waits for the apply');
    await scheduler.advance(1);
    assert.equal(ready, true, 'for 2 s at most');
    release();
    const applied = await client.applied();
    assert.deepEqual(applied?.saved, ['A']);
    stand.close();
  });

  it("names the journal's owner lock and each entry for the session its hello says, which the worker's drain on a closed port waits on (rule 7)", async () => {
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
    const { stand, client } = popupOn(tab, {
      locks,
      before: async one => {
        await until(async () => (await journalOf(tab)).some(entry => entry.opId === one.commandId));
        owners = (await journalOf(tab)).map(entry => entry.ownerSessionId);
      },
    });
    assert.equal((await client.execute(quickNote(client))).kind, 'committed');
    const [sent] = stand.handed;
    assert.ok(sent, 'the worker got it');
    assert.ok(requested.includes(ownerLock(sent.sessionId)), requested.join(', '));
    assert.deepEqual(owners, [sent.sessionId]);
    stand.close();
  });

  it('holds each command, in order, until the send chunk is in and its journal holds the owner lock (rule 3)', async () => {
    const tab = await profile();
    /** @type {(value?: unknown) => void} */
    let chunkIn = () => {};
    /** @type {(value: boolean) => void} */
    let lockHeld = () => {};
    const loaded = new Promise(resolve => {
      chunkIn = resolve;
    });
    /** @type {Promise<boolean>} */
    const ready = new Promise(resolve => {
      lockHeld = resolve;
    });
    /** @type {string[]} */
    const went = [];
    const chunk = {
      popupWrites: () => ({
        ready,
        execute: async (/** @type {{commandId: string, noteId: string}} */ command) => {
          went.push(command.commandId);
          return committed('note-created', [command.noteId]);
        },
      }),
    };
    const { stand, client } = popupOn(tab, { send: () => loaded.then(() => chunk) });
    const first = quickNote(client, 'First');
    const second = quickNote(client, 'Second');
    const answers = [client.execute(first), client.execute(second)];
    await settle();
    chunkIn();
    await settle();
    assert.deepEqual(went, [], 'nothing goes before the owner lock');
    const third = quickNote(client, 'Third');
    answers.push(client.execute(third));
    lockHeld(true);
    await Promise.all(answers);
    assert.deepEqual(went, [first.commandId, second.commandId, third.commandId]);
    stand.close();
  });

  it("answers each command unavailable, reload-required, when the send chunk can't load, and sends nothing", async () => {
    const tab = await profile();
    const { stand, client } = popupOn(tab, {
      send: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
    });
    assert.deepEqual(await client.execute(quickNote(client)), unavailable('coordinator', 'reload-required', false));
    assert.deepEqual(stand.frames, []);
    stand.close();
  });
});
