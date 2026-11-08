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
import { kernelClient, waitForWorkerUpgrade } from '../../js/kernel/composition/host.js';
import { createNewTabDocumentClient, createNewTabNoteList } from '../../js/kernel/composition/newtab.js';
import { WORKER_PAGE_HANDLERS } from '../../js/kernel/core/application/handlers-worker.js';
import { COMMANDS } from '../../js/kernel/core/contracts/commands.js';
import { MAX_MESSAGE_BYTES } from '../../js/kernel/core/contracts/limits.js';
import { COMMAND_SAMPLES } from './command-samples.mjs';
import { legacyContext, legacyEnv } from './legacy-fixture.mjs';
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
});
