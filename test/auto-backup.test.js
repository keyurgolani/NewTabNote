'use strict';

// Automatic backups as the page makes them since #17 PR 4a, the createAutoBackup command on
// #17's adapter (backups.js) through the page's settings port, on fake-indexeddb and
// legacy-env's chrome.storage.local stub: each backup is the export of what the database holds,
// stored under auto_backup_<ms>, the newest three kept, and lastBackupAt set once one is stored.
// Storage.getAutoBackups lists them, and a chrome.storage read that fails lists none; a write
// that fails stores none.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLegacyEnv, createDatabase, note, block, plain, releaseStorage, settingsOf, startNewTabKernel,
} = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js'];

/** Wait long enough for Date.now() to move, so two backups get different keys */
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 3));

/**
 * A new tab started on a database holding note N (Groceries) with one block, as its root starts
 * it, with the holders' Storage beside #17's adapter, and its settings port, whose
 * createAutoBackup runs on the adapter
 */
async function started() {
  const env = createLegacyEnv({ document: null });
  await createDatabase(env.indexedDB, {
    records: { canvases: [note('N', { name: 'Groceries' })], elements: [block('b1', 'N', 0, 'eggs')] },
  });
  env.load(...FILES);
  const storage = env.get('Storage');
  await startNewTabKernel(env);
  /** The auto_backup_ keys chrome.storage.local holds, oldest first */
  const backupKeys = () => Object.keys(env.chrome.local).filter((key) => key.startsWith('auto_backup_')).sort();
  return { env, storage, settings: env.settingsClient, backupKeys };
}

describe('auto-backup to chrome.storage.local', () => {
  it('createAutoBackup stores the export of the database under an auto_backup_ key', async () => {
    const { env, settings, backupKeys } = await started();
    const before = Date.now();
    await settings.createAutoBackup();

    const keys = backupKeys();
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^auto_backup_\d+$/);
    assert.ok(Number(keys[0].slice('auto_backup_'.length)) >= before);
    const stored = env.chrome.local[keys[0]];
    assert.equal(stored.autoBackup, true);
    assert.ok(stored.backupCreatedAt >= before);
    assert.deepEqual(stored.canvases.map((n) => [n.id, n.name]), [['N', 'Groceries']]);
    assert.deepEqual(stored.elements.map((b) => [b.id, b.canvasId, b.content]), [['b1', 'N', 'eggs']]);
  });

  it('createAutoBackup sets lastBackupAt', async () => {
    const { env, settings } = await started();
    const before = Date.now();
    await settings.createAutoBackup();
    assert.ok(env.chrome.local.setting_lastBackupAt >= before);
    assert.ok(await settingsOf(env).getSetting('lastBackupAt', 0) >= before);
  });

  it('keeps only the newest three backups', async () => {
    const { env, settings, backupKeys } = await started();
    const made = [];
    for (let i = 0; i < 4; i++) {
      await settings.createAutoBackup();
      made.push(backupKeys().at(-1));
      await nextMillisecond();
    }
    assert.equal(new Set(made).size, 4, 'each backup got its own key');
    assert.deepEqual(backupKeys(), made.slice(1), 'the oldest one is gone');
    // As 1.4.x's Storage lists them, newest first: the frozen 1.4.1 release's (#17 PR 4b)
    const release = await releaseStorage(env);
    assert.deepEqual(plain(await release.getAutoBackups()).map((b) => b.key), made.slice(1).reverse());
  });

  it('getAutoBackups lists none when there are none', async () => {
    const { storage } = await started();
    assert.deepEqual(plain(await storage.getAutoBackups()), []);
  });

  it('getAutoBackups lists the newest first, with what each stored', async () => {
    const { storage, settings, backupKeys } = await started();
    await settings.createAutoBackup();
    await nextMillisecond();
    await settings.createAutoBackup();

    const backups = plain(await storage.getAutoBackups());
    assert.deepEqual(backups.map((b) => b.key), backupKeys().reverse());
    assert.ok(backups[0].data.backupCreatedAt > backups[1].data.backupCreatedAt);
    assert.deepEqual(backups.map((b) => b.data.canvases.map((n) => n.id)), [['N'], ['N']]);
  });

  it('getAutoBackups resolves an empty list when chrome.storage reports lastError', async () => {
    const { env, storage, settings, backupKeys } = await started();
    await settings.createAutoBackup();
    assert.equal(backupKeys().length, 1);

    env.chrome.failNextGet();
    assert.deepEqual(plain(await storage.getAutoBackups()), []);
    // The next read works again
    assert.equal((await storage.getAutoBackups()).length, 1);
  });

  it('createAutoBackup rejects when chrome.storage refuses the write, and stores nothing', async () => {
    const { env, settings, backupKeys } = await started();
    env.chrome.failNextSet();
    // The command answers what refused it: chrome.storage.local's quota, as its message says
    await assert.rejects(settings.createAutoBackup(), (error) => {
      assert.deepEqual([error.name, error.outcome.kind, error.outcome.cause, error.code], ['SettingsWriteError', 'unavailable', 'quota', 'quota']);
      return true;
    });
    assert.deepEqual(backupKeys(), []);
    assert.equal(env.chrome.local.setting_lastBackupAt, undefined);
  });
});
