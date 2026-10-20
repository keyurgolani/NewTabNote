// The contract suite on the legacy adapter, over production js/storage.js, and what only the
// legacy adapter does: its two ways of opening, startup maintenance through
// DatabaseManager, stores an older or damaged database lacks, and agreeing with Storage's
// own rules.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { isEmpty, isUntitled } from '../../js/kernel/core/domain/note.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { runContractSuite } from './contract.mjs';
import { adapterFor, closeAll, kernelFor, legacyContext, legacyEnv, legacyFixture } from './legacy-fixture.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';

/** @typedef {import('./legacy-fixture.mjs').LegacyContext} LegacyContext */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').BulkOutcome} BulkOutcome */

runContractSuite(legacyFixture);

const ROOT = path.join(import.meta.dirname, '..', '..');

/** @type {LegacyContext[]} */
const opened = [];
after(() => closeAll(opened));

/**
 * @param {any} [sharedWith]
 * @returns {LegacyContext}
 */
function context(sharedWith) {
  const made = legacyContext(sharedWith);
  opened.push(made);
  return made;
}

const runtime = () => ({ ids: testIds(), clock: testClock() });

/** @param {LegacyContext} page */
const settingWrites = page =>
  page.env.chrome
    .writes()
    .map((/** @type {{keys: string[]}} */ call) => call.keys)
    .flat();

/**
 * @param {Outcome | BulkOutcome} outcome
 * @param {string} kind
 */
const assertKind = (outcome, kind) => assert.equal(outcome.kind, kind, JSON.stringify(outcome));

/**
 * Waits for `upgrade`, or a second, whichever comes first. When `holder`'s connection is still
 * blocking it then, this closes that connection and waits for the upgrade, so a regression
 * fails a test instead of hanging the run.
 * @param {Promise<unknown>} upgrade
 * @param {LegacyContext} holder - the context whose open connection could block it
 * @returns {Promise<'opened' | 'blocked'>}
 */
async function settleUpgrade(upgrade, holder) {
  /** @type {Promise<'blocked'>} */
  const blocked = new Promise(resolve => setTimeout(() => resolve('blocked'), 1000).unref());
  const settled = await Promise.race([upgrade.then(() => /** @type {const} */ ('opened')), blocked]);
  if (settled === 'blocked') {
    holder.storage.db.close();
    await upgrade;
  }
  return settled;
}

/**
 * Records each connection `factory` opens from now on and whether it was closed, until stop()
 * gives `factory` its own open back. A connection left open fails a test at once, where an
 * upgrade it blocks would wait for ever.
 * @param {IDBFactory} factory
 * @returns {{stop: () => Array<{name: string, closed: boolean}>}}
 */
function recordConnections(factory) {
  /** @type {Array<{name: string, closed: boolean}>} */
  const connections = [];
  const { open } = factory;
  /** @type {any} */ (factory).open = (/** @type {string} */ name, /** @type {number | undefined} */ version) => {
    const request = version === undefined ? open.call(factory, name) : open.call(factory, name, version);
    request.addEventListener('success', () => {
      const connection = { name, closed: false };
      const db = request.result;
      const close = db.close.bind(db);
      db.close = () => {
        connection.closed = true;
        close();
      };
      connections.push(connection);
    });
    return request;
  };
  return {
    stop: () => {
      delete (/** @type {any} */ (factory).open);
      return connections;
    },
  };
}

describe('the legacy adapter', () => {
  it('has a declared-gap row in the kernel ledger for each guarantee it lacks, two contexts included', () => {
    const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/architecture/kernel-ledger.json'), 'utf8'));
    /** @type {Array<{file: string, rule: string, owner: number, verify: string}>} */
    const gaps = ledger.rows.filter((/** @type {{rule: string}} */ row) => row.rule === 'declared-gap');
    const flags = /** @type {Record<string, boolean>} */ ({ ...adapterFor(context()).flags });
    const lacking = Object.keys(flags).filter(flag => !flags[flag]);
    // Without revisions, two contexts saving one note's blocks race too (contract.mjs)
    if (!flags.revisions) lacking.push('two contexts');
    for (const gap of lacking) {
      const rows = gaps.filter(row => row.verify.includes(`the ${gap} check in test/kernel/contract.mjs`));
      assert.equal(rows.length, 1, `the ${gap} gap has ${rows.length} rows`);
      assert.deepEqual([rows[0].file, rows[0].owner], ['js/kernel/adapters/legacy/adapter.js', 17], gap);
    }
    assert.equal(gaps.length, lacking.length, 'a declared-gap row for a guarantee the adapter has');
  });

  it('saveNoteContent opens its IndexedDB transaction, over canvases and elements, in the calling task', async () => {
    const page = context();
    const adapter = adapterFor(page);
    await adapter.open();
    const kernel = kernelFor(adapter, runtime());
    assertKind(await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' }), 'committed');
    /** @type {unknown[]} */
    const opens = [];
    const transaction = page.storage.transaction;
    page.storage.transaction = (/** @type {string[]} */ names, /** @type {string} */ mode) => {
      opens.push([names, mode]);
      return transaction(names, mode);
    };
    const pending = kernel.execute({
      type: 'saveNoteContent',
      commandId: 'c2',
      noteId: 'n1',
      blocks: [{ id: 'b1', type: 'text', content: 'Hello' }],
    });
    assert.deepEqual(opens, [[['canvases', 'elements'], 'readwrite']]);
    assertKind(await pending, 'committed');
  });

  it('opens a database as it is for Popup and Side Panel: no upgrade, repair, or maintenance', async () => {
    const page = context();
    await legacyEnv.createDatabase(page.env.indexedDB, {
      version: 7,
      omit: ['snapshots'],
      records: { canvases: [legacyEnv.note('n1', { name: 'Old note' })] },
    });
    const before = await legacyEnv.dumpDatabase(page.env.indexedDB);
    const adapter = adapterFor(page, 'existing');
    await adapter.open();
    const popup = kernelFor(adapter, runtime(), CALLERS.popup);
    const list = await popup.query({ type: 'listNotes', view: 'active' });
    assert.deepEqual(list.kind === 'ready' && list.data.map(note => note.name), ['Old note']);
    page.storage.db.close();
    assert.deepEqual(await legacyEnv.dumpDatabase(page.env.indexedDB), before);
    assert.deepEqual(settingWrites(page), []);
  });

  it('opens no database for Popup and Side Panel on a profile that has none, and makes none', async () => {
    const page = context();
    const adapter = adapterFor(page, 'existing');
    const ready = adapter.open();
    await assert.rejects(ready, error => {
      const { unavailableCause, code } = /** @type {any} */ (error);
      return unavailableCause === 'storage' && code === 'no-database';
    });
    const popup = createKernel({
      adapter,
      policy: createBaselinePolicy(),
      caller: CALLERS.popup,
      ids: testIds(),
      clock: testClock(),
      ready,
    });
    const quickNote = await popup.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'Quick' });
    // Nothing opens it again before Popup reloads, so it isn't retryable
    assert.deepEqual(quickNote.kind === 'unavailable' && [quickNote.cause, quickNote.code, quickNote.retryable], [
      'storage',
      'no-database',
      false,
    ]);
    assert.deepEqual(await popup.query({ type: 'listNotes', view: 'active' }), {
      kind: 'failed',
      cause: 'storage',
      code: 'no-database',
    });
    assert.deepEqual(await page.env.indexedDB.databases(), []);
  });

  it("never blocks a new tab's upgrade from the database Popup or Side Panel holds open", async () => {
    for (const version of [7, 8]) {
      const panel = context();
      await legacyEnv.createDatabase(panel.env.indexedDB, {
        version,
        records: { canvases: [legacyEnv.note('n1', { name: 'Kept' })] },
      });
      await adapterFor(panel, 'existing').open();
      // A new tab upgrading to this build's version, or a newer build's tab past it
      const upgrade =
        version === 7
          ? adapterFor(context(panel.env)).open()
          : legacyEnv
              .requestToPromise(panel.env.indexedDB.open('CanvasTabDB', 9))
              .then((/** @type {IDBDatabase} */ db) => db.close());
      assert.equal(await settleUpgrade(upgrade, panel), 'opened', `version ${version}`);
      assert.equal(panel.storage.openState, 'version-changed', `version ${version}`);
    }
  });

  it('once another context upgrades the database, Popup and Side Panel answer reload-required, not retryable', async () => {
    const panel = context();
    await legacyEnv.createDatabase(panel.env.indexedDB, {
      version: 7,
      records: { canvases: [legacyEnv.note('n1', { name: 'Kept' })] },
    });
    const adapter = adapterFor(panel, 'existing');
    const ready = adapter.open();
    const popup = createKernel({
      adapter,
      policy: createBaselinePolicy(),
      caller: CALLERS.popup,
      ids: testIds(),
      clock: testClock(),
      ready,
    });
    // The kernel settles a turn after the open does
    await ready.then(() => new Promise(resolve => setImmediate(resolve)));
    assert.equal((await popup.query({ type: 'listNotes', view: 'active' })).kind, 'ready');
    assert.equal(await settleUpgrade(adapterFor(context(panel.env)).open(), panel), 'opened');
    for (let attempt = 0; attempt < 2; attempt++) {
      const quickNote = await popup.execute({ type: 'createNote', commandId: `c${attempt}`, noteId: 'n2' });
      assert.deepEqual(
        quickNote.kind === 'unavailable' && [
          quickNote.cause,
          quickNote.code,
          quickNote.retryable,
          quickNote.messageKey,
        ],
        ['storage', 'reload-required', false, 'unavailable.reload-required'],
      );
    }
    assert.deepEqual(await popup.query({ type: 'listNotes', view: 'active' }), {
      kind: 'failed',
      cause: 'storage',
      code: 'reload-required',
    });
  });

  it('never runs startup maintenance on a database opened as it is', async () => {
    const page = context();
    await legacyEnv.createDatabase(page.env.indexedDB, { version: 8 });
    const adapter = adapterFor(page, 'existing');
    await adapter.open();
    // The policy already keeps Popup and Side Panel from asking, so ask from a new-tab caller
    const kernel = kernelFor(adapter, runtime(), CALLERS.newtab);
    const outcome = await kernel.execute({ type: 'runStartupMaintenance', commandId: 'c1' });
    assert.deepEqual(outcome.kind === 'unavailable' && [outcome.cause, outcome.code], [
      'adapter',
      'maintenance-needs-versioned-open',
    ]);
    assert.deepEqual(settingWrites(page), []);
  });

  it('refuses a database a newer build upgraded, in both modes, and leaves it as it was', async () => {
    for (const mode of /** @type {const} */ (['existing', 'versioned'])) {
      const page = context();
      await legacyEnv.createDatabase(page.env.indexedDB, {
        version: 9,
        extraStores: { meta: { keyPath: 'key' } },
        records: { canvases: [legacyEnv.note('n1')] },
      });
      const before = await legacyEnv.dumpDatabase(page.env.indexedDB);
      const adapter = adapterFor(page, mode);
      const connections = recordConnections(page.env.indexedDB);
      const ready = adapter.open();
      await assert.rejects(ready, error => /** @type {any} */ (error).unavailableCause === 'newer-schema');
      // Every connection the refused open made is closed, so none holds up the newer build's
      // next upgrade
      assert.ok(connections.stop().length > 0, mode);
      assert.deepEqual(
        connections.stop().filter(connection => !connection.closed),
        [],
        `${mode}: a connection was left open`,
      );
      const kernel = createKernel({
        adapter,
        policy: createBaselinePolicy(),
        caller: mode === 'existing' ? CALLERS.popup : CALLERS.newtab,
        ids: testIds(),
        clock: testClock(),
        ready,
      });
      const outcome = await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n2' });
      assert.deepEqual(
        outcome.kind === 'unavailable' && [outcome.cause, outcome.retryable],
        ['newer-schema', false],
        mode,
      );
      assert.deepEqual(await kernel.query({ type: 'listNotes', view: 'active' }), {
        kind: 'failed',
        cause: 'newer-schema',
        code: 'newer-schema',
      });
      assert.deepEqual(await legacyEnv.dumpDatabase(page.env.indexedDB), before, mode);
      assert.deepEqual(settingWrites(page), [], mode);
    }
  });

  it('runs startup maintenance through Storage: default settings once, and orphans reported, not removed', async () => {
    const page = context();
    await legacyEnv.createDatabase(page.env.indexedDB, {
      records: { elements: [legacyEnv.block('orphan', 'missing-note', 0)] },
    });
    const adapter = adapterFor(page);
    await adapter.open();
    assert.deepEqual(settingWrites(page), []);
    const worker = kernelFor(adapter, runtime(), CALLERS['worker-internal']);
    assertKind(await worker.execute({ type: 'runStartupMaintenance', commandId: 'c1' }), 'committed');
    const stored = page.env.chrome.local;
    assert.deepEqual(
      [stored.setting_storageInitialized, stored.setting_theme, stored.setting_sidebarWidth],
      [true, 'system', 260],
    );
    const elements = legacyEnv.recordsOf(await legacyEnv.dumpDatabase(page.env.indexedDB), 'elements');
    assert.ok(elements.orphan, 'the orphaned block is still there');
    assert.ok(
      page.env.logs.some((/** @type {{args: unknown[]}} */ log) =>
        String(log.args[0]).includes('Integrity check (read-only) found orphaned records'),
      ),
    );
  });

  it('Storage.init still opens the database and then runs startup maintenance', async () => {
    const page = context();
    /** @type {string[]} */
    const order = [];
    const { open, runStartupMaintenance } = page.storage;
    page.storage.open = async () => {
      order.push('open');
      await open.call(page.storage);
    };
    page.storage.runStartupMaintenance = async () => {
      order.push('maintenance');
      await runStartupMaintenance.call(page.storage);
    };
    await page.storage.init();
    assert.deepEqual(order, ['open', 'maintenance']);
    assert.equal(page.storage.openState, 'open');
    assert.equal(page.env.chrome.local.setting_storageInitialized, true);
  });

  it('works on a database missing stores, the way Storage does: the search index is skipped, folders fail', async () => {
    const page = context();
    await legacyEnv.createDatabase(page.env.indexedDB, {
      omit: ['search_index', 'folders', 'media', 'vectors', 'snapshots'],
    });
    const adapter = adapterFor(page);
    await adapter.open();
    const kernel = kernelFor(adapter, runtime());
    assertKind(await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'Kept' }), 'committed');
    assertKind(
      await kernel.execute({ type: 'renameNote', commandId: 'c2', noteId: 'n1', name: 'Renamed' }),
      'committed',
    );
    assertKind(await kernel.execute({ type: 'createNote', commandId: 'c3', noteId: 'n2' }), 'committed');
    // An untitled, empty note is deleted without the stores it would also clear
    const trashed = await kernel.execute({ type: 'trashNote', commandId: 'c4', noteId: 'n2' });
    assert.equal(trashed.kind === 'committed' && trashed.code, 'note-deleted');
    const folder = await kernel.execute({
      type: 'createFolder',
      commandId: 'c5',
      folderId: 'f1',
      name: 'F',
      parentId: null,
    });
    assert.deepEqual(folder.kind === 'unavailable' && [folder.cause, folder.code], ['storage', 'store-unavailable']);
    assert.deepEqual(await kernel.query({ type: 'listFolders' }), { kind: 'empty', asOf: testClock().now() });
    const list = await kernel.query({ type: 'listNotes', view: 'active' });
    assert.deepEqual(list.kind === 'ready' && list.data.map(note => note.name), ['Renamed']);
  });

  it('a setting that hits the storage quota is unavailable with cause quota', async () => {
    const page = context();
    const adapter = adapterFor(page);
    await adapter.open();
    page.env.chrome.failNextSet();
    const outcome = await kernelFor(adapter, runtime()).execute({
      type: 'setPreferences',
      commandId: 'c1',
      values: { theme: 'dark' },
    });
    assert.deepEqual(outcome.kind === 'unavailable' && [outcome.cause, outcome.code, outcome.retryable], [
      'quota',
      'quota-exceeded',
      false,
    ]);
  });

  it('a write whose transaction aborts as it commits is unavailable, never committed', async () => {
    const page = context();
    const adapter = adapterFor(page);
    await adapter.open();
    const kernel = kernelFor(adapter, runtime());
    assertKind(
      await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'Before' }),
      'committed',
    );
    page.abortingOnCommit.push('notes');
    const outcome = await kernel.execute({ type: 'renameNote', commandId: 'c2', noteId: 'n1', name: 'After' });
    assert.deepEqual(outcome.kind === 'unavailable' && [outcome.cause, outcome.retryable], ['storage', true]);
    const note = await kernel.query({ type: 'getNote', noteId: 'n1' });
    assert.equal(note.kind === 'ready' && note.data.note.name, 'Before');
    assert.equal((await page.storage.getSearchIndex())[0].name, 'Before');
  });

  it("stores what Storage's own readers read: the note, its search entry, its blocks, and the settings", async () => {
    const page = context();
    const adapter = adapterFor(page);
    await adapter.open();
    const kernel = kernelFor(adapter, runtime());
    await kernel.execute({
      type: 'createNote',
      commandId: 'c1',
      noteId: 'n1',
      name: 'Plan',
      blocks: [{ id: 'b1', type: 'text', content: 'Milk', order: 0 }],
    });
    await kernel.execute({ type: 'setPreferences', commandId: 'c2', values: { sidebarWidth: 300 } });
    await kernel.execute({
      type: 'saveWorkspaceSession',
      commandId: 'c3',
      session: { lastOpenedNoteId: 'n1', activeTabIndex: 0 },
    });
    const { storage } = page;
    assert.equal((await storage.getNote('n1')).name, 'Plan');
    assert.deepEqual(
      legacyEnv.plain((await storage.getAllNotes()).map((/** @type {{id: string}} */ note) => note.id)),
      ['n1'],
    );
    assert.deepEqual(legacyEnv.plain(await storage.getSearchIndex()), [
      { noteId: 'n1', name: 'Plan', content: '', updatedAt: testClock().now() },
    ]);
    assert.equal((await storage.getElementsByNote('n1'))[0].content, 'Milk');
    assert.equal(await storage.getSetting('sidebarWidth'), 300);
    assert.equal(await storage.getSetting('activeTabIndex'), 0);
    assert.equal(page.env.chrome.local.lastOpenedNoteId, 'n1');
  });

  it('decides untitled and empty the way Storage.isNoteUntitled and Storage.isNoteEmpty do', async () => {
    const page = context();
    /** @type {Array<Record<string, unknown>[]>} */
    const blockSets = [
      [],
      [{ content: '<p> </p>' }],
      [{ content: '<p>x</p>' }],
      [{ imageUrl: 'data:,' }],
      [{ tableData: [['Header 1', ' ']] }],
      [{ tableData: [['Header 1'], ['cell']] }],
      [{ url: 'https://example.test', title: 'Example' }],
      [{ url: 'https://example.test' }],
      [{ children: '<p>child</p>' }],
      [{ equation: ' ' }],
      [{ equation: 'x' }],
    ];
    await legacyEnv.createDatabase(page.env.indexedDB, {
      records: {
        elements: blockSets.flatMap((blocks, set) =>
          blocks.map((fields, index) =>
            legacyEnv.block(`b${set}-${index}`, `set${set}`, index, '', { content: '', ...fields }),
          ),
        ),
      },
    });
    await page.storage.open();
    for (const [set, blocks] of blockSets.entries()) {
      const stored = legacyEnv.plain(await page.storage.getElementsByNote(`set${set}`));
      assert.equal(isEmpty(stored), await page.storage.isNoteEmpty(`set${set}`), JSON.stringify(blocks));
    }
    for (const name of ['', '  ', 'Untitled', 'untitled 4', 'Untitled draft', 'Plan', undefined]) {
      const note = { id: 'n', name };
      assert.equal(isUntitled(note), Boolean(page.storage.isNoteUntitled(note)), JSON.stringify(name));
    }
  });

  it("puts a capture where Storage.getTodayNote looks for today's Daily Note", async () => {
    const page = context();
    const adapter = adapterFor(page);
    await adapter.open();
    const worker = kernelFor(adapter, { ids: testIds(), clock: { now: () => Date.now() } }, CALLERS['worker-internal']);
    const outcome = await worker.execute({
      type: 'captureToDailyNote',
      commandId: 'c1',
      noteId: 'd1',
      blockId: 'k1',
      capture: { type: 'text', content: 'Quote' },
    });
    assertKind(outcome, 'committed');
    const today = await page.storage.getTodayNote();
    assert.equal(today && today.id, 'd1');
    assert.equal((await page.storage.getElementsByNote('d1'))[0].content, 'Quote');
  });
});
