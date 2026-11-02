// #17 PR 4a, the lead's Q1: 1.4.x's export file, automatic backup, and import, moved from
// js/storage.js to #17's adapter (adapters/indexeddb/backups.js) with what each did there. Each
// is held to the frozen 1.4.1's own code on the same profile (test/fixtures/storage/releases/
// v1.4.1, the tag's own files), both ways: a file this build exports imports through 1.4.1, and
// a file 1.4.1 exported imports here as it does there. js/storage.js's copies, which only the
// legacy adapter called, are 4b's facade's to drop, so nothing here calls them. Then
// the commands that run them, on an adapter with the backup tasks, as the new tab's is, and on
// one without, as Popup's, Side Panel's, and the worker's are. The kernel-adapter suite runs
// its backups checks on the first (storage-contract.test.mjs).

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_BACKUP_PREFIX,
  LAST_BACKUP_KEY,
  createAutoBackup,
  exportFile,
  exportObject,
  importUnit,
  planImport,
  prepareImport,
  readExport,
  validateBackup,
} from '../../js/kernel/adapters/indexeddb/backups.js';
import { VERSION_FIELDS } from '../../js/kernel/adapters/indexeddb/versions.js';
import { newCommand } from '../../js/kernel/core/contracts/commands.js';
import { UnavailableError, committed, rejected, unavailable } from '../../js/kernel/core/contracts/outcomes.js';
import { NEW_NOTE_FIELDS } from '../../js/kernel/core/domain/placement.js';
import { adapterOn, closeAll, kernelOn, legacyEnv, profile } from './storage-fixture.mjs';
import { testIds } from './support.mjs';

/** @typedef {import('./storage-fixture.mjs').Profile} Profile */
/** @typedef {Record<string, any>} Row */

/** @type {Profile[]} */
const profiles = [];
after(() => profiles.forEach(closeAll));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const { note, block } = legacyEnv;

/** A profile with folders, active, empty, Daily, archived, template, and trashed notes, and media */
const RECORDS = () => ({
  folders: [
    { id: 'F1', name: 'Work', parentId: null, createdAt: 1, updatedAt: 1, color: null, collapsed: false },
    { id: 'F2', name: 'Plans', parentId: 'F1', createdAt: 1, updatedAt: 1, color: null, collapsed: false },
  ],
  canvases: [
    note('A', { name: 'Alpha', folderId: 'F2', updatedAt: 1700000000300 }),
    note('E', { name: 'Untitled' }),
    note('D', { name: 'Daily Note - Oct 1, 2026', isDaily: true, dateStr: '2026-10-01', updatedAt: 1700000000200 }),
    note('AR', { name: 'Old daily', isDaily: true, dateStr: '2026-09-30', archived: true, archivedAt: 5 }),
    note('T', { name: 'Meeting template', isTemplate: true }),
    note('T2', { name: 'Older template', isTemplate: true, updatedAt: 1600000000000 }),
    note('TR', { name: 'Thrown away', trashed: true, trashedAt: 6 }),
  ],
  elements: [
    block('a1', 'A', 0, 'alpha one'),
    block('a2', 'A', 1, 'alpha two'),
    block('d1', 'D', 0, 'daily'),
    block('ar1', 'AR', 0, 'archived daily'),
    block('t1', 'T', 0, 'template body'),
    block('tr1', 'TR', 0, 'trashed body'),
  ],
  media: [
    { id: 'm1', canvasId: 'A', blob: new Blob([PNG], { type: 'image/png' }), type: 'image/png', createdAt: 1 },
    { id: 'm2', canvasId: 'TR', blob: new Blob([PNG], { type: 'image/png' }), type: 'image/png', createdAt: 2 },
  ],
});

/**
 * A profile at 8, holding RECORDS, or `records`
 * @param {object} [spec]
 * @returns {Promise<Profile>}
 */
async function made(spec = {}) {
  const of = profile();
  profiles.push(of);
  await legacyEnv.createDatabase(of.real, { records: RECORDS(), ...spec });
  return of;
}

/**
 * A connection of its own to `of`'s CanvasTabDB, as the adapter's
 * @param {Profile} of
 * @returns {Promise<IDBDatabase>}
 */
const openDb = of => legacyEnv.requestToPromise(of.faults.factory.open('CanvasTabDB'));

/** A clock that moves on a millisecond each time it's read */
const ticking = (start = 1760000000000) => {
  let now = start;
  return { now: () => now++ };
};

/**
 * The frozen v1.4.1's Storage, from the tag's own files, opened with init as its pages opened
 * it, in a page of `of`'s profile, with each id it makes from `ids`
 * @param {Profile} of
 * @param {{ids?: () => string}} [options]
 * @returns {Promise<any>}
 */
async function release141(of, { ids } = {}) {
  const env = legacyEnv.createLegacyEnv({ context: 'page', indexedDB: of.real, chrome: of.chrome, worker: false });
  const dir = 'test/fixtures/storage/releases/v1.4.1/js';
  env.load(`${dir}/utils.js`, `${dir}/storage.js`);
  if (ids) env.get('Utils').generateId = ids;
  const storage = env.get('Storage');
  await storage.init();
  return storage;
}

/** Ids in order, the same for Storage and the port */
const sequence = (prefix = 'id') => {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
};

/** The six fields #17 PR 3 writes beside a note's flags, as a Daily Note at this build's version has them */
const PLACEMENT_FIELDS = Object.freeze({
  placement: { kind: 'daily', dateKey: '2026-10-01' },
  kind: 'note',
  lifecycle: 'active',
  dailyKey: '2026-10-01',
  dailyTimeZone: 'UTC',
  dailyDuplicateOf: null,
});

/** @param {string} text */
const timeless = text => text.replace(/^\{"version":1,"exportedAt":\d+/, '{"version":1,"exportedAt":0');

/**
 * Each store's records, by key, without the versions #17's adapter keeps on a note, and with
 * the times Replace all stamps on what it trashed set to 0. Each Blob is as the dump has it,
 * its bytes in base64 with its type.
 * @param {Profile} of
 */
async function contents(of) {
  const dumped = await legacyEnv.dumpDatabase(of.real);
  /** @type {Record<string, Record<string, Row>>} */
  const out = {};
  for (const store of ['canvases', 'elements', 'media', 'folders']) {
    out[store] = Object.fromEntries(
      Object.entries(legacyEnv.recordsOf(dumped, store)).map(([key, value]) => {
        const record = /** @type {Row} */ ({ ...value });
        if (store === 'canvases') {
          for (const field of VERSION_FIELDS) delete record[field];
          if (record.trashed && record.trashedAt > 1e12) Object.assign(record, { trashedAt: 0, updatedAt: 0 });
        }
        return [key, record];
      }),
    );
  }
  return out;
}

/**
 * A profile at this build's version, as the worker's run leaves it, holding the note L1 at
 * revision 4 and placement version 2, with one block
 * @returns {Promise<Profile>}
 */
async function latest() {
  const of = profile();
  profiles.push(of);
  const worker = adapterOn(of);
  await worker.open();
  worker.close();
  const seed = await openDb(of);
  const tx = seed.transaction(['canvases', 'elements'], 'readwrite');
  tx.objectStore('canvases').put(note('L1', { name: 'Local', revision: 4, placementVersion: 2, sourceRevision: 0 }));
  tx.objectStore('elements').put(block('l1', 'L1', 0));
  await new Promise(resolve => {
    tx.oncomplete = resolve;
  });
  seed.close();
  return of;
}

/**
 * The import's unit committed through #17's adapter, opened as the new tab will open it, in the
 * scope its importBackup command commits it in, with each new id from `newId`, so what it
 * writes can be held to Storage's import with the same ids
 * @param {Profile} of
 * @param {unknown} backup
 * @param {'merge' | 'replace'} mode
 * @param {() => string} newId
 */
async function importOn(of, backup, mode, newId) {
  const adapter = adapterOn(of, { mode: 'existing', requireCore: true });
  await adapter.open();
  const db = await openDb(of);
  const clock = ticking();
  try {
    const prepared = await prepareImport({ db, settings: of.chrome.api.storage.local, clock, backup, mode, newId });
    if ('refused' in prepared) return { outcome: prepared.refused, receipt: null };
    const { unit, receipt } = prepared;
    const { outcome } = await adapter.commit(
      /** @type {any} */ ({
        commandId: `import-${mode}`,
        command: { type: 'importBackup', commandId: `import-${mode}`, mode, backup },
        scope: mode === 'replace' ? 'placement' : 'content',
        effect: { kind: 'units', units: [unit] },
        done: () => committed('backup-imported', []),
      }),
    );
    return { outcome, receipt: receipt() };
  } finally {
    db.close();
    adapter.close();
  }
}

describe("Export JSON on #17's adapter (#17 PR 4a)", () => {
  it('writes what the frozen 1.4.1 writes for the same profile, byte for byte but the time', async () => {
    const of = await made();
    const db = await openDb(of);
    const rows = await readExport(db);
    db.close();
    const ours = await (await exportFile(rows, 1760000000000)).text();
    const frozen = await release141(of);
    assert.equal(timeless(ours), timeless(await (await frozen.exportAllAsBlob()).text()));
    // With Create Backup's fields, after the folders
    const extra = { backupType: 'full-backup', backupCreatedAt: '2026-10-31T00:00:00.000Z', backupVersion: 1 };
    assert.equal(
      timeless(await (await exportFile(rows, 1, extra)).text()),
      timeless(await (await frozen.exportAllAsBlob(extra)).text()),
    );
    // The object the automatic backup and Replace all's copy save is 1.4.1's exportAll's
    const object = await exportObject(rows, 7);
    assert.deepEqual({ ...object, exportedAt: 0 }, { ...legacyEnv.plain(await frozen.exportAll()), exportedAt: 0 });
    // What it holds: no note in the trash, nor its media; the templates after the rest
    const file = JSON.parse(ours);
    // Newest first, ties by id from the last, as Storage's index read gives them, then the templates
    assert.deepEqual(
      file.canvases.map((/** @type {Row} */ n) => n.id),
      ['A', 'D', 'E', 'AR', 'T', 'T2'],
    );
    assert.deepEqual(
      file.media.map((/** @type {Row} */ m) => [m.id, m.blob]),
      [['m1', `data:image/png;base64,${PNG.toString('base64')}`]],
    );
    frozen.db.close();
  });

  it('leaves out the six fields #17 PR 3 writes beside the flags, and the database keeps them', async () => {
    for (const field of NEW_NOTE_FIELDS) assert.ok(Object.hasOwn(PLACEMENT_FIELDS, field), field);
    const records = RECORDS();
    records.canvases = records.canvases.map(n => ({ ...n, ...PLACEMENT_FIELDS }));
    const of = await made({ records });
    const db = await openDb(of);
    const rows = await readExport(db);
    db.close();
    for (const exported of rows.notes) {
      for (const field of NEW_NOTE_FIELDS) assert.equal(field in exported, false, `${exported.id}: ${field}`);
    }
    // The file is the one 1.4.1 writes for the same notes without them, which it never knew
    const frozen = await release141(await made());
    assert.equal(
      timeless(await (await exportFile(rows, 1)).text()),
      timeless(await (await frozen.exportAllAsBlob()).text()),
    );
    frozen.db.close();
    assert.equal(legacyEnv.recordsOf(await legacyEnv.dumpDatabase(of.real), 'canvases').A.dailyKey, '2026-10-01');
  });

  it("a database without media or folders exports none of them, as 1.4.1's does", async () => {
    const of = await made({
      omit: ['media', 'folders'],
      records: { canvases: RECORDS().canvases, elements: RECORDS().elements },
    });
    const db = await openDb(of);
    const rows = await readExport(db);
    db.close();
    assert.deepEqual([rows.media, rows.folders], [[], []]);
    const frozen = await release141(of);
    assert.equal(
      timeless(await (await exportFile(rows, 1)).text()),
      timeless(await (await frozen.exportAllAsBlob()).text()),
    );
    frozen.db.close();
  });
});

describe("the automatic backup on #17's adapter (#17 PR 4a)", () => {
  it('keeps the newest three under auto_backup_<time>, each the export marked as a backup, and the time of the last', async () => {
    const of = await made();
    const db = await openDb(of);
    const clock = ticking();
    for (let i = 0; i < 4; i++) await createAutoBackup({ db, settings: of.chrome.api.storage.local, clock });
    db.close();
    const stored = legacyEnv.plain(of.chrome.local);
    const keys = Object.keys(stored)
      .filter(key => key.startsWith(AUTO_BACKUP_PREFIX))
      .sort();
    assert.equal(keys.length, 3);
    const newest = stored[keys[2]];
    assert.deepEqual([newest.autoBackup, typeof newest.backupCreatedAt], [true, 'number']);
    assert.equal(typeof stored[LAST_BACKUP_KEY], 'number');

    // 1.4.1's own backup of the same profile holds the same, but its times
    const theirs = await made();
    const frozen = await release141(theirs);
    await frozen.createAutoBackup();
    frozen.db.close();
    const [[, backup]] = Object.entries(legacyEnv.plain(theirs.chrome.local)).filter(([key]) =>
      key.startsWith(AUTO_BACKUP_PREFIX),
    );
    assert.deepEqual(
      { ...newest, exportedAt: 0, backupCreatedAt: 0 },
      { ...backup, exportedAt: 0, backupCreatedAt: 0 },
    );
  });

  it("rejects when it can't save the backup, leaving the ones before as they were", async () => {
    const of = await made();
    const db = await openDb(of);
    const clock = ticking();
    await createAutoBackup({ db, settings: of.chrome.api.storage.local, clock });
    const before = legacyEnv.plain(of.chrome.local);
    of.chrome.failNextSet();
    await assert.rejects(createAutoBackup({ db, settings: of.chrome.api.storage.local, clock }));
    db.close();
    assert.deepEqual(legacyEnv.plain(of.chrome.local), before);
  });
});

describe("the import on #17's adapter (#17 PR 4a)", () => {
  it("checks a parsed file as 1.4.1's validateImport does, for every refusal it has", async () => {
    const of = await made();
    const storage = await release141(of);
    storage.db.close();
    const good = {
      version: 1,
      exportedAt: 1,
      canvases: [note('X')],
      elements: [block('x1', 'X', 0)],
      media: [],
      folders: [],
    };
    const inputs = [
      good,
      { ...good, media: [{ id: 'orphan', canvasId: 'gone' }] },
      null,
      [],
      'text',
      { version: 1 },
      { ...good, version: undefined },
      { ...good, version: 2 },
      { ...good, canvases: {} },
      { ...good, elements: undefined },
      { ...good, media: 'x' },
      { ...good, folders: {} },
      { ...good, canvases: [null] },
      { ...good, canvases: [{ id: '' }] },
      { ...good, canvases: [note('X'), note('X')] },
      { ...good, elements: [block('x1', 'Y', 0)] },
      { ...good, folders: [{ id: 'f' }, { id: 'f' }] },
      { ...good, media: [{ id: 3 }] },
    ];
    for (const input of inputs) {
      assert.deepEqual(validateBackup(input), legacyEnv.plain(storage.validateImport(input)), JSON.stringify(input));
    }
  });

  it("Merge adds what a file 1.4.1 exported as 1.4.1 adds it, and changes no local record", async () => {
    const source = await made();
    const frozen = await release141(source);
    const file = JSON.parse(await (await frozen.exportAllAsBlob()).text());
    frozen.db.close();

    const ours = await made();
    const before = await contents(ours);
    const { outcome, receipt } = await importOn(ours, file, 'merge', sequence());
    assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
    const theirs = await made();
    const storage = await release141(theirs, { ids: sequence() });
    const result = await storage.importData(structuredClone(file), 'merge');
    storage.db.close();
    assert.deepEqual(await contents(ours), await contents(theirs));
    assert.deepEqual(receipt?.importedIds, [...result.importedIds]);
    // Every local record is as it was
    const now = await contents(ours);
    for (const store of Object.keys(before)) {
      for (const [key, record] of Object.entries(before[store]))
        assert.deepEqual(now[store][key], record, `${store} ${key}`);
    }
    // The Daily Note for a date a local one holds comes in as a plain note
    const daily = Object.values(now.canvases).find(n => n.name === 'Daily Note - Oct 1, 2026 (imported)');
    assert.deepEqual([daily?.isDaily, daily?.dateStr], [false, null]);
  });

  it("Replace all saves its recovery copy first, then moves every active note to trash in the import's own commit, as 1.4.1 does", async () => {
    const source = await made();
    const frozen = await release141(source);
    const file = JSON.parse(await (await frozen.exportAllAsBlob()).text());
    frozen.db.close();

    const ours = await made();
    const { outcome, receipt } = await importOn(ours, file, 'replace', sequence());
    assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
    const theirs = await made();
    const storage = await release141(theirs, { ids: sequence() });
    const result = await storage.importData(structuredClone(file), 'replace');
    storage.db.close();
    assert.deepEqual(await contents(ours), await contents(theirs));
    assert.deepEqual(receipt?.trashedIds, [...result.trashedIds]);
    // The copy holds the export as it was before the import, as 1.4.1's does
    /** @param {Profile} of */
    const copyOf = of => {
      const copies = Object.entries(legacyEnv.plain(of.chrome.local)).filter(([key]) =>
        key.startsWith('recovery_backup_'),
      );
      assert.equal(copies.length, 1);
      return { ...copies[0][1], exportedAt: 0, timestamp: 0 };
    };
    assert.deepEqual(copyOf(ours), copyOf(theirs));
    assert.equal(copyOf(ours).reason, 'pre-import-replace');
  });

  it("a recovery copy that can't be saved stops Replace all, with nothing written", async () => {
    const of = await made();
    const before = await legacyEnv.dumpDatabase(of.real);
    of.chrome.failNextSet();
    const { outcome } = await importOn(of, { version: 1, canvases: [], elements: [] }, 'replace', sequence());
    assert.deepEqual(outcome, unavailable('storage', 'recovery-copy-failed', true));
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);
  });

  it('a commit that aborts writes nothing', async () => {
    const of = await made();
    const before = await legacyEnv.dumpDatabase(of.real);
    const done = of.faults.abortAfterNextWrite('elements', 'QuotaExceededError');
    const file = { version: 1, canvases: [note('X')], elements: [block('x1', 'X', 0)] };
    const { outcome } = await importOn(of, file, 'merge', sequence());
    await done;
    assert.equal(outcome.kind, 'unavailable');
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);
  });

  it('refuses a file the check refuses, one a profile lacks the store for, and a malformed data URL, writing nothing', async () => {
    const without = await made({ omit: ['folders', 'media'], records: { canvases: [note('n1')] } });
    const before = await legacyEnv.dumpDatabase(without.real);
    const good = { version: 1, canvases: [note('X')], elements: [block('x1', 'X', 0)] };
    /** @type {Array<[unknown, string]>} */
    const cases = [
      [{ ...good, version: 2 }, 'import-invalid'],
      [{ ...good, folders: [{ id: 'f1', name: 'F', parentId: null }] }, 'folders-store-missing'],
      [{ ...good, media: [{ id: 'm', canvasId: 'X', blob: 'data:image/png;base64,AA==' }] }, 'media-store-missing'],
    ];
    for (const [file, code] of cases) {
      const { outcome } = await importOn(without, file, 'merge', sequence());
      assert.deepEqual(outcome, rejected('validation', code), code);
    }
    const malformed = await made();
    const { outcome } = await importOn(
      malformed,
      { ...good, media: [{ id: 'm', canvasId: 'X', blob: 'data:image/png;base64' }] },
      'merge',
      sequence(),
    );
    assert.deepEqual(outcome, rejected('validation', 'import-invalid'));
    assert.deepEqual(await legacyEnv.dumpDatabase(without.real), before);
  });

  it('never changes the parsed file, and plans the same ids in the order Storage takes them', () => {
    const file = {
      version: 1,
      canvases: [note('X'), note('Y')],
      elements: [block('x1', 'X', 0), block('y1', 'Y', 0)],
      media: [
        { id: 'm', canvasId: 'Y', blob: 'data:image/png;base64,AA==' },
        { id: 'orphan', canvasId: 'gone' },
      ],
      folders: [],
    };
    const copy = structuredClone(file);
    const planned = planImport(file, 'merge', { newId: sequence(), has: () => true });
    assert.deepEqual(file, copy);
    assert.ok('plan' in planned);
    const { plan } = /** @type {any} */ (planned);
    assert.deepEqual([...plan.noteIds.values()], ['id-1', 'id-2']);
    assert.deepEqual(
      plan.elements.map((/** @type {Row} */ e) => [e.id, e.canvasId]),
      [
        ['id-3', 'id-1'],
        ['id-4', 'id-2'],
      ],
    );
    assert.deepEqual(
      plan.media.map((/** @type {Row} */ m) => [m.id, m.canvasId, m.blob instanceof Blob]),
      [['id-5', 'id-2', true]],
    );
    assert.equal(plan.skippedMedia, 1);
    // The unit decides only from what it reads, so a second run of it answers the same
    const { unit, receipt } = importUnit(plan, ticking());
    assert.deepEqual(unit.stores, ['notes', 'blocks', 'media', 'folders']);
    assert.deepEqual(receipt(), { importedIds: [], addedFolderIds: [], trashedIds: [] });
  });

  it("at this build's version, the import commits with a change for each note and folder it wrote, and Replace all moves the placement version of each note it trashed", async () => {
    const of = await latest();
    const file = {
      version: 1,
      canvases: [note('X', { folderId: 'FX' })],
      elements: [block('x1', 'X', 0)],
      folders: [{ id: 'FX', name: 'From the file', parentId: 'gone' }],
    };
    const { outcome, receipt } = await importOn(of, file, 'replace', sequence());
    assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
    assert.deepEqual(receipt, { importedIds: ['id-1'], addedFolderIds: ['FX'], trashedIds: ['L1'] });
    const dumped = await legacyEnv.dumpDatabase(of.real);
    const notes = legacyEnv.recordsOf(dumped, 'canvases');
    assert.deepEqual(
      [notes.L1.trashed, notes.L1.revision, notes.L1.placementVersion, notes.L1.lifecycle],
      [true, 4, 3, undefined],
    );
    assert.deepEqual(legacyEnv.recordsOf(dumped, 'folders').FX.parentId, null);
    // As the log keys them: the commit's one seq, then each entity's type and id
    const changes = Object.values(legacyEnv.recordsOf(dumped, 'changes')).map(row => [row.entityType, row.entityId]);
    assert.deepEqual(changes, [
      ['folder', 'FX'],
      ['note', 'L1'],
      ['note', 'id-1'],
    ]);
  });
});

describe("the backup commands on #17's adapter (#17 PR 4a)", () => {
  /**
   * A new tab's kernel on #17's adapter over `of`, opened as the new tab will open it, with the
   * backup tasks unless `backups` is false, as Popup's, Side Panel's, and the worker's are
   * @param {Profile} of
   * @param {{backups?: boolean}} [options]
   */
  async function newTab(of, { backups = true } = {}) {
    const clock = ticking();
    const adapter = adapterOn(of, { mode: 'existing', requireCore: true, backups, clock });
    await adapter.open();
    const ids = testIds('cmd');
    return {
      adapter,
      kernel: kernelOn(adapter, { ids, clock }),
      /**
       * @param {'createAutoBackup' | 'importBackup'} type
       * @param {Record<string, unknown>} [fields]
       */
      command: (type, fields = {}) => newCommand(ids, type, /** @type {any} */ (fields)),
    };
  }

  /** @param {import('../../js/kernel/core/contracts/outcomes.js').Outcome} outcome */
  const failure = outcome =>
    outcome.kind === 'unavailable' && [outcome.cause, outcome.code, outcome.retryable, outcome.exception];

  /** @param {Profile} of */
  const backupKeys = of =>
    Object.keys(legacyEnv.plain(of.chrome.local)).filter(
      key => key.startsWith(AUTO_BACKUP_PREFIX) || key.startsWith('recovery_backup_') || key === LAST_BACKUP_KEY,
    );

  it("one made without `backups`, as Popup's, Side Panel's, and the worker's are, runs no task and makes no file, writing nothing", async () => {
    const of = await made();
    const before = [await legacyEnv.dumpDatabase(of.real), legacyEnv.plain(of.chrome.local)];
    const { adapter, kernel, command } = await newTab(of, { backups: false });
    assert.equal(adapter.flags.backups, false);
    const file = { version: 1, canvases: [note('X')], elements: [block('x1', 'X', 0)] };
    // The kernel refuses each command for the flag, and the adapter each task it's handed anyway
    for (const sent of [command('createAutoBackup'), command('importBackup', { mode: 'replace', backup: file })]) {
      assert.deepEqual(failure(await kernel.execute(sent)), [
        'adapter',
        'backups-need-legacy-storage',
        false,
        undefined,
      ]);
    }
    for (const task of [{ action: 'auto' }, { action: 'import', mode: 'replace', backup: file }]) {
      const type = task.action === 'auto' ? 'createAutoBackup' : 'importBackup';
      const { outcome } = await adapter.commit(
        /** @type {any} */ ({
          commandId: `direct-${task.action}`,
          command: { type, commandId: `direct-${task.action}` },
          effect: { kind: 'backup', ...task },
          done: () => committed('backup-imported', []),
        }),
      );
      assert.deepEqual(outcome, unavailable('adapter', 'backups-need-legacy-storage', false), task.action);
    }
    assert.deepEqual(await kernel.query({ type: 'exportBackup', backup: false }), {
      kind: 'failed',
      cause: 'adapter',
      code: 'backups-need-legacy-storage',
    });
    await assert.rejects(
      adapter.exportBackup({}),
      error =>
        error instanceof UnavailableError &&
        error.unavailableCause === 'adapter' &&
        error.code === 'backups-need-legacy-storage' &&
        !error.retryable,
    );
    adapter.close();
    assert.deepEqual([await legacyEnv.dumpDatabase(of.real), legacyEnv.plain(of.chrome.local)], before);
  });

  it('importBackup commits Replace all after its recovery copy, each note it trashed a placement version on, and a resend imports nothing', async () => {
    const of = await latest();
    const { adapter, kernel, command } = await newTab(of);
    const file = {
      version: 1,
      canvases: [note('X', { name: 'From the file', folderId: 'FX' })],
      elements: [block('x1', 'X', 0, 'line')],
      folders: [{ id: 'FX', name: 'Filed', parentId: null }],
    };
    const sent = command('importBackup', { mode: 'replace', backup: file });
    const outcome = await kernel.execute(sent);
    assert.equal(outcome.kind, 'committed', JSON.stringify(outcome));
    // The note it added, under a new id, then the folder it added, then the note it trashed
    const [added, ...rest] = outcome.kind === 'committed' ? outcome.changedIds : [];
    assert.deepEqual(rest, ['FX', 'L1']);
    const notes = legacyEnv.recordsOf(await legacyEnv.dumpDatabase(of.real), 'canvases');
    assert.deepEqual([notes.L1.trashed, notes.L1.revision, notes.L1.placementVersion], [true, 4, 3]);
    assert.deepEqual(
      [notes[added].name, notes[added].folderId, notes[added].trashed],
      ['From the file', 'FX', undefined],
    );
    const copies = backupKeys(of).filter(key => key.startsWith('recovery_backup_'));
    assert.equal(copies.length, 1);
    assert.equal(/** @type {Row} */ (legacyEnv.plain(of.chrome.local)[copies[0]]).reason, 'pre-import-replace');

    // The same command again, as a client sends it once the reply was lost, answers what it
    // answered, from its ledger row, read before the copy: it imports nothing and saves no copy
    const listed = Object.keys(notes).length;
    assert.deepEqual(await kernel.execute(sent), outcome);
    assert.equal(Object.keys(legacyEnv.recordsOf(await legacyEnv.dumpDatabase(of.real), 'canvases')).length, listed);
    assert.equal(backupKeys(of).filter(key => key.startsWith('recovery_backup_')).length, 1);
    // Another Replace all under its key is refused, with no copy either
    const reused = await kernel.execute(
      /** @type {any} */ ({ ...sent, backup: { ...file, canvases: [], elements: [] } }),
    );
    assert.deepEqual(reused.kind === 'rejected' && [reused.reason, reused.code], [
      'validation',
      'idempotency-key-reuse',
    ]);
    assert.equal(backupKeys(of).filter(key => key.startsWith('recovery_backup_')).length, 1);
    adapter.close();
  });

  it('the file exportBackup makes here imports through the frozen 1.4.1, every note, block, media item, and folder, with none of the six fields', async () => {
    const records = RECORDS();
    records.canvases = records.canvases.map(n => ({ ...n, ...PLACEMENT_FIELDS }));
    const of = await made({ records });
    const { adapter, kernel } = await newTab(of);
    const state = await kernel.query({ type: 'exportBackup', backup: true });
    adapter.close();
    assert.equal(state.kind, 'ready', JSON.stringify(state));
    const file = JSON.parse(await /** @type {Blob} */ (state.kind === 'ready' && state.data).text());
    for (const exported of file.canvases) {
      for (const field of NEW_NOTE_FIELDS) assert.equal(field in exported, false, `${exported.id}: ${field}`);
    }

    const there = profile();
    profiles.push(there);
    const frozen = await release141(there);
    const result = await frozen.importData(structuredClone(file), 'merge');
    frozen.db.close();
    assert.deepEqual(
      [result.notes, result.blocks, result.media, result.skippedMedia],
      [file.canvases.length, file.elements.length, file.media.length, 0],
    );
    const stored = await contents(there);
    /** @param {Row[]} rows @param {(row: Row) => unknown} field */
    const sorted = (rows, field) => rows.map(field).sort();
    assert.deepEqual(
      sorted(Object.values(stored.canvases), n => n.name),
      sorted(file.canvases, n => n.name),
    );
    for (const imported of Object.values(stored.canvases)) {
      for (const field of NEW_NOTE_FIELDS) assert.equal(field in imported, false, `${imported.name}: ${field}`);
    }
    assert.deepEqual(
      sorted(Object.values(stored.elements), b => b.content),
      sorted(file.elements, b => b.content),
    );
    // The one image outside trash, byte for byte
    assert.deepEqual(
      Object.values(stored.media).map(m => m.blob),
      [{ __blob: PNG.toString('base64'), type: 'image/png' }],
    );
    assert.deepEqual(
      Object.values(stored.folders).map(f => [f.id, f.parentId]),
      [
        ['F1', null],
        ['F2', 'F1'],
      ],
    );
  });

  it("a task that fails answers how: quota for a full chrome.storage.local, the exception an export read failed with, and a recovery copy that couldn't be saved, writing nothing", async () => {
    const of = await made();
    const before = await legacyEnv.dumpDatabase(of.real);
    const { adapter, kernel, command } = await newTab(of);
    of.chrome.failNextSet();
    assert.deepEqual(failure(await kernel.execute(command('createAutoBackup'))), ['quota', 'quota', false, undefined]);
    of.faults.failNextRead('canvases', 'UnknownError');
    assert.deepEqual(failure(await kernel.execute(command('createAutoBackup'))), [
      'storage',
      'transaction-failed',
      true,
      'UnknownError',
    ]);
    of.chrome.failNextSet();
    const file = { version: 1, canvases: [note('X')], elements: [block('x1', 'X', 0)] };
    assert.deepEqual(failure(await kernel.execute(command('importBackup', { mode: 'replace', backup: file }))), [
      'storage',
      'recovery-copy-failed',
      true,
      undefined,
    ]);
    adapter.close();
    assert.deepEqual(backupKeys(of), []);
    assert.deepEqual(await legacyEnv.dumpDatabase(of.real), before);
  });
});
