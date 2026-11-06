// #17's read-only reader (#35 slice 4b-0b): what a page that only reads opens CanvasTabDB with,
// once its writes go to the worker (4b on). It opens the database as it is, as #17's adapter's
// `existing` mode does, reads what that adapter reads and answers as it does, and holds nothing
// that writes: no commit, no recall, no export, no upgrade, and no module the architecture list
// (docs/architecture/committers.json) gives the role `writer`.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createIndexedDbReader } from '../../js/kernel/adapters/indexeddb/reader.js';
import { DB_VERSION } from '../../js/kernel/adapters/indexeddb/schema.js';
import { reachGraph } from './import-graph.mjs';
import { adapterOn, closeAll, kernelOn, legacyEnv, profile } from './storage-fixture.mjs';
import { CALLERS } from './support.mjs';

/** @typedef {import('./storage-fixture.mjs').Profile} Profile */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEXEDDB = 'js/kernel/adapters/indexeddb';

/** @type {Profile[]} */
const profiles = [];
after(() => profiles.forEach(closeAll));

/**
 * A profile, with a database made from `spec` first when given
 * @param {object} [spec] - for legacyEnv.createDatabase
 */
async function made(spec) {
  const of = profile();
  profiles.push(of);
  if (spec) await legacyEnv.createDatabase(of.real, spec);
  return of;
}

/**
 * The reader over `of`, as a page's root would make it
 * @param {Profile} of
 * @param {Partial<import('../../js/kernel/adapters/indexeddb/reader.js').IndexedDbReaderOptions>} [options]
 */
function readerOn(of, options = {}) {
  const reader = createIndexedDbReader({
    indexedDB: of.faults.factory,
    settings: of.chrome.api.storage.local,
    ...options,
  });
  of.adapters.push(/** @type {any} */ (reader));
  return reader;
}

/**
 * What a page's query answers, on `store`, as Popup asks it
 * @param {any} store - the reader or #17's adapter, opened
 * @param {{type: string} & Record<string, unknown>} query
 */
const asPopup = (store, query) => kernelOn(store, undefined, CALLERS.popup).query(/** @type {any} */ (query));

describe("#17's read-only reader (#35 slice 4b-0b)", () => {
  it("opens a database as it is, and answers Popup's queries and setting reads as #17's adapter does in existing mode", async () => {
    const of = await made({
      records: {
        canvases: [legacyEnv.note('n1', { name: 'Kept' })],
        settings: [
          { key: 'insightsEnabled', value: true },
          { key: 'llmApiKey', value: 'test-only-value' },
        ],
      },
    });
    const before = await legacyEnv.dumpDatabase(of.real);
    const adapter = adapterOn(of, { mode: 'existing' });
    const reader = readerOn(of);
    await adapter.open();
    await reader.open();
    for (const query of [{ type: 'listNotes', view: 'popup' }, { type: 'getPopupInsightsEnabled' }]) {
      assert.deepEqual(await asPopup(reader, query), await asPopup(adapter, query), query.type);
    }
    // The settings store also holds 1.4.x's provider keys, which nothing in the kernel may read
    await assert.rejects(reader.readSettings('idbSettings', ['llmApiKey']), { code: 'setting-not-served' });
    reader.close();
    adapter.close();
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);
  });

  it('never upgrades and never makes a database: one at version 7 stays as it was, and a profile without one gets none', async () => {
    const of = await made({ version: 7, omit: ['snapshots'], records: { canvases: [legacyEnv.note('n1')] } });
    const before = await legacyEnv.dumpDatabase(of.real);
    const reader = readerOn(of);
    await reader.open();
    const list = await asPopup(reader, { type: 'listNotes', view: 'popup' });
    assert.deepEqual(list.kind === 'ready' && /** @type {Array<{id: string}>} */ (list.data).map(note => note.id), [
      'n1',
    ]);
    reader.close();
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);

    const empty = await made();
    await assert.rejects(readerOn(empty).open(), error => {
      const { unavailableCause, code } = /** @type {any} */ (error);
      return unavailableCause === 'storage' && code === 'no-database';
    });
    assert.deepEqual(await empty.real.databases(), []);
  });

  it('refuses a database a newer build upgraded, as the adapter does, and leaves it as it was', async () => {
    const of = await made({
      version: DB_VERSION + 1,
      extraStores: { meta: { keyPath: 'key' } },
      records: { canvases: [legacyEnv.note('n1')] },
    });
    const before = await legacyEnv.dumpDatabase(of.real);
    await assert.rejects(readerOn(of).open(), error => {
      const { unavailableCause, code, retryable } = /** @type {any} */ (error);
      return unavailableCause === 'newer-schema' && code === 'version-too-new' && retryable === false;
    });
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);
  });

  it("holds nothing that writes: no commit, recall or export, and its ledger answers a command's status as the adapter's does", async () => {
    // The worker's adapter makes the database at this build's version, with its ledger
    const of = await made();
    const reader = readerOn(of);
    for (const name of ['commit', 'recall', 'exportBackup', 'exportData']) {
      assert.equal(Object.hasOwn(reader, name), false, name);
    }
    const adapter = adapterOn(of);
    await adapter.open();
    const kernel = kernelOn(adapter);
    const block = (/** @type {string} */ content) => ({ id: 'b1', type: 'text', content, order: 0 });
    /** @type {any} */
    const create = { type: 'createNote', commandId: 'c-made', noteId: 'n2', name: 'Made', blocks: [block('One')] };
    assert.equal((await kernel.execute(create)).kind, 'committed');
    const save = { type: 'saveNoteContent', commandId: 'c-newer', noteId: 'n2', blocks: [block('Two')] };
    assert.equal((await kernel.execute(/** @type {any} */ (save))).kind, 'committed');
    /** @type {any} */
    const stale = { ...save, commandId: 'c-stale', blocks: [block('Stale')], expectedRevision: 1 };
    assert.equal((await kernel.execute(stale)).kind, 'conflict');
    await reader.open();
    for (const commandId of ['c-made', 'c-newer', 'c-stale', 'c-never-sent']) {
      assert.deepEqual(await reader.ledger.status(commandId), await adapter.ledger.status(commandId), commandId);
    }
    // Its read compares the command too: another under a kept commandId is key reuse
    for (const command of [create, stale, { ...create, name: 'Another' }]) {
      const label = `${command.commandId} ${command.name ?? ''}`;
      assert.deepEqual(await reader.ledger.read(command), await adapter.ledger.read(command), label);
    }
    assert.deepEqual(await reader.ledger.read({ ...create, name: 'Another' }), { status: 'key-reuse' });
  });

  it('reaches no module the architecture list gives the role writer', () => {
    const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'architecture', 'committers.json'), 'utf8'));
    const writers = new Set(
      Object.entries(list.indexeddb)
        .filter(([, role]) => role === 'writer')
        .map(([file]) => `${INDEXEDDB}/${file}`),
    );
    const { modules } = reachGraph([path.join(ROOT, INDEXEDDB, 'reader.js')], {
      readFile: file => fs.readFileSync(file, 'utf8'),
    });
    const reached = [...modules]
      .map(file => path.relative(ROOT, file).split(path.sep).join('/'))
      .filter(file => writers.has(file));
    assert.deepEqual(reached, []);
  });
});
