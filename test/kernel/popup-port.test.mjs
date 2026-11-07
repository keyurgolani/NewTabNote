// #35 slice 4b-2: Popup's page side once its writes go to the worker over #13's port (the 4b
// plan's rules 3, 8 and 9, and Q9). Popup's root reads in the page, on #17's reader, and
// sends its quick note and a closing tab's edit through its send chunk, which it loads as it
// starts. Each command waits for the chunk in order, then for the journal's owner lock, and goes,
// journaled as the catalog says, on the session the worker's router knows the page by, the one its
// journal names, so the drain on a closed port waits on that page alone. On legacy-env profiles,
// with a stand-in for the worker (popup-worker.mjs).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inContextStores } from '../../js/kernel/adapters/in-context.js';
import { waitForWorkerUpgrade } from '../../js/kernel/composition/host.js';
import { createNewTabAdapter, createNewTabClient } from '../../js/kernel/composition/newtab.js';
import { createPopupClient } from '../../js/kernel/composition/popup.js';
import { legacyContext, legacyEnv } from './legacy-fixture.mjs';
import { popupWorker } from './popup-worker.mjs';

/** @typedef {import('./legacy-fixture.mjs').LegacyContext} LegacyContext */
/** @typedef {import('./popup-worker.mjs').Handed} Handed */
/** @typedef {import('../../js/kernel/core/ports/runtime.js').Timers} Timers */

/**
 * Popup's root, with a host, its drafts, the applier and the send chunk's loader
 * @type {(...args: unknown[]) => ReturnType<typeof createPopupClient>}
 */
const popupClient = /** @type {any} */ (createPopupClient);

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
});
