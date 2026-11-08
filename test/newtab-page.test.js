'use strict';

// #35 slice 4d's page move, against the real worker: the new tab's composition root
// (js/kernel/composition/newtab.js) loaded in a page, as newtab.html's workspace chunk loads it, on
// a profile js/background.js started on first, whose port reaches the router the worker installs
// (test/helpers/runtime-ports.js). The root's chunks load through import(), as Chrome loads them
// (#237's dynamicImports): its send chunk, and #13's client and journal under it. Its reads stay on
// #17's reader in the page, an editor's save goes over the port as newtab and commits in the
// worker, a closing tab's edit is applied over the port before the first read, and its session's
// write commits in the page. test/kernel/newtab-port.test.mjs holds the rest on a stand-in for the
// worker.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground } = require('./helpers/load-background');
const { createLegacyEnv, createDatabase, dumpDatabase, recordsOf, note, block, plain } = require('./helpers/legacy-env');
const { loadPageModule } = require('./helpers/page-module');
const { connectPage } = require('./helpers/runtime-ports');

/** When the closing tab wrote what it left */
const AT = Date.UTC(2026, 10, 8, 9, 0);

/**
 * The new tab's root on `records`, on a profile js/background.js started on first, as a browser
 * start wakes it. The page shares the worker's IndexedDB, chrome.* and Web Locks, as an
 * extension's page does, and `prepare` runs on its environment before the root starts.
 * @param {Object} records - rows per store
 * @param {(env: any) => void} [prepare]
 */
async function newTabOnWorker(records, prepare = () => {}) {
  const worker = await loadBackground({ setup: (env) => createDatabase(env.indexedDB, { records }) });
  connectPage(worker.env.chrome, 'newtab.html');
  const env = createLegacyEnv({ indexedDB: worker.indexedDB, chrome: worker.env.chrome, locks: worker.env.global.navigator.locks });
  prepare(env);
  const root = await loadPageModule(env, 'js/kernel/composition/newtab.js', { dynamicImports: true });
  const host = root.newTabHost();
  const reader = root.createNewTabReader(host);
  const client = root.createNewTabPageClient(reader, host, { wake: () => {} });
  return { worker, env, root, reader, client };
}

/** Note `noteId`'s blocks as stored, by id */
async function storedBlocks(indexedDB, noteId) {
  const rows = Object.values(recordsOf(await dumpDatabase(indexedDB), 'elements'));
  return Object.fromEntries(rows.filter((row) => row.canvasId === noteId).map((row) => [row.id, row.content]));
}

const RECORDS = {
  canvases: [note('A', { name: 'Alpha plan', updatedAt: AT - 1000 })],
  elements: [block('a1', 'A', 0, 'alpha')],
};

describe("the new tab's root on the real worker (#35 slice 4d)", () => {
  it("sends an editor's save to the worker over the port, which commits it, and reads it back on its reader", async () => {
    const { worker, env, reader, root, client } = await newTabOnWorker(RECORDS);
    assert.equal(await client.whenReady(), null);
    const editor = root.createNewTabDocumentClient(client, reader);
    // Made in the page's realm, as its editor makes a save, which the codec takes as plain data
    const save = env.get('JSON').parse(JSON.stringify({
      noteId: 'A',
      blocks: [{ id: 'a1', type: 'text', content: 'alpha, typed in the tab', order: 0 }],
      preview: 'alpha, typed in the tab',
      todoProgress: null,
      linkedNames: [],
    }));
    const saved = plain(await editor.saveContent(save, { pane: 'main' }));
    assert.equal(saved.kind, 'committed', JSON.stringify(saved));
    assert.equal((await storedBlocks(worker.indexedDB, 'A')).a1, 'alpha, typed in the tab', 'the worker committed it');
    const read = plain(await client.query({ type: 'getNoteBlocks', noteId: 'A' }));
    assert.deepEqual(read.kind === 'ready' && read.data.map((row) => row.content), ['alpha, typed in the tab'], 'and the reader reads it');
    // The worker's router knew the page as the new tab
    assert.ok(worker.env.logs.every((log) => !String(log.args[0]).includes('unauthorized-sender')));
  });

  it("applies a closing tab's edit over the port before its first read", async () => {
    const draft = {
      v: 1, id: 'draft-a', page: 'page-1', noteId: 'A', at: AT,
      base: { updatedAt: AT - 1000, issued: [], name: 'Alpha plan' },
      blocks: [{ id: 'a1', canvasId: 'A', type: 'text', content: 'alpha, edited as its tab closed', order: 0 }],
      deletedBlockIds: [], preview: 'alpha, edited as its tab closed', todoProgress: null, linkedNames: [],
    };
    const prepare = (env) => env.global.localStorage.setItem('ntn-close-draft:draft-a', JSON.stringify(draft));
    const { worker, env, client } = await newTabOnWorker(RECORDS, prepare);
    assert.equal(await client.whenReady(), null);
    assert.deepEqual(plain(await client.applied())?.saved, ['A']);
    assert.equal((await storedBlocks(worker.indexedDB, 'A')).a1, 'alpha, edited as its tab closed');
    assert.equal(env.global.localStorage.getItem('ntn-close-draft:draft-a'), null, 'and the draft went');
  });

  it('commits its workspace session in the page, through its settings handle', async () => {
    const { env, client } = await newTabOnWorker(RECORDS);
    assert.equal(await client.whenReady(), null);
    const session = { openTabs: [{ noteId: 'A', title: 'Alpha plan' }], activeTabIndex: 0 };
    const saved = plain(await client.execute({ type: 'saveWorkspaceSession', commandId: 'c-session', session }));
    assert.deepEqual(saved.kind === 'committed' && saved.code, 'session-saved');
    assert.deepEqual(plain(env.chrome.local.setting_openTabs), session.openTabs);
  });
});
