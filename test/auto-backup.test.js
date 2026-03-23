const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Minimal mock of chrome.storage.local for testing auto-backup logic.
 */
function createMockChromeStorage() {
  const store = {};
  return {
    local: {
      get(keys, cb) {
        if (keys === null) {
          setTimeout(() => cb({ ...store }), 0);
          return;
        }
        const ks = Array.isArray(keys) ? keys : [keys];
        const result = {};
        ks.forEach(k => { if (store[k] !== undefined) result[k] = store[k]; });
        setTimeout(() => cb(result), 0);
      },
      set(items, cb) {
        Object.assign(store, items);
        if (cb) setTimeout(cb, 0);
      },
      remove(keys, cb) {
        const ks = Array.isArray(keys) ? keys : [keys];
        ks.forEach(k => delete store[k]);
        if (cb) setTimeout(cb, 0);
      },
    },
    onChanged: { addListener() {} },
    _store: store,
  };
}

/**
 * Minimal DatabaseManager stub with only the methods needed for auto-backup tests.
 */
function createStorageStub(chromeStorage) {
  // Patch global chrome for the module
  globalThis.chrome = { storage: chromeStorage, runtime: { lastError: null } };

  const proto = {
    async exportAll() {
      return { version: 1, exportedAt: Date.now(), canvases: [{ id: 'n1', name: 'Test' }], elements: [], media: [] };
    },
    async getSetting(key, defaultValue = null) {
      return new Promise(resolve => {
        const storageKey = `setting_${key}`;
        chrome.storage.local.get([storageKey], (result) => {
          resolve(result[storageKey] !== undefined ? result[storageKey] : defaultValue);
        });
      });
    },
    async setSetting(key, value) {
      return new Promise((resolve, reject) => {
        const storageKey = `setting_${key}`;
        chrome.storage.local.set({ [storageKey]: value }, () => {
          if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
          resolve();
        });
      });
    },
  };

  // Load the real createAutoBackup, getAutoBackups, _getAutoBackupKeys from storage.js
  // We replicate them here to test the logic in isolation without IndexedDB.
  proto.createAutoBackup = async function () {
    const data = await this.exportAll();
    data.autoBackup = true;
    data.backupCreatedAt = Date.now();

    const key = `auto_backup_${Date.now()}`;
    const existingKeys = await this._getAutoBackupKeys();

    await new Promise((resolve, reject) => {
      chrome.storage.local.set({ [key]: data }, () => {
        if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
        resolve();
      });
    });

    const allKeys = [...existingKeys, key].sort();
    if (allKeys.length > 3) {
      const toRemove = allKeys.slice(0, allKeys.length - 3);
      await new Promise(resolve => {
        chrome.storage.local.remove(toRemove, () => resolve());
      });
    }

    await this.setSetting('lastBackupAt', Date.now());
  };

  proto.getAutoBackups = async function () {
    const keys = await this._getAutoBackupKeys();
    if (keys.length === 0) return [];
    return new Promise(resolve => {
      chrome.storage.local.get(keys, (result) => {
        const backups = keys
          .filter(k => result[k])
          .map(k => ({ key: k, data: result[k] }))
          .sort((a, b) => (b.data.backupCreatedAt || 0) - (a.data.backupCreatedAt || 0));
        resolve(backups);
      });
    });
  };

  proto._getAutoBackupKeys = async function () {
    return new Promise(resolve => {
      chrome.storage.local.get(null, (result) => {
        const keys = Object.keys(result).filter(k => k.startsWith('auto_backup_'));
        resolve(keys.sort());
      });
    });
  };

  return proto;
}

describe('auto-backup to chrome.storage.local', () => {
  let chromeStorage;
  let storage;

  beforeEach(() => {
    chromeStorage = createMockChromeStorage();
    storage = createStorageStub(chromeStorage);
  });

  it('createAutoBackup saves a backup entry', async () => {
    await storage.createAutoBackup();
    const backups = await storage.getAutoBackups();
    assert.equal(backups.length, 1);
    assert.equal(backups[0].data.autoBackup, true);
    assert.ok(backups[0].data.canvases.length > 0);
  });

  it('createAutoBackup updates lastBackupAt setting', async () => {
    const before = Date.now();
    await storage.createAutoBackup();
    const lastBackup = await storage.getSetting('lastBackupAt', 0);
    assert.ok(lastBackup >= before);
  });

  it('retains only the last 3 backups', async () => {
    // Create 4 backups with small delays to get distinct timestamps
    for (let i = 0; i < 4; i++) {
      await storage.createAutoBackup();
      await new Promise(r => setTimeout(r, 5));
    }

    const backups = await storage.getAutoBackups();
    assert.equal(backups.length, 3, 'Should retain exactly 3 backups');
  });

  it('getAutoBackups returns empty array when no backups exist', async () => {
    const backups = await storage.getAutoBackups();
    assert.equal(backups.length, 0);
  });

  it('getAutoBackups returns backups sorted newest-first', async () => {
    await storage.createAutoBackup();
    await new Promise(r => setTimeout(r, 5));
    await storage.createAutoBackup();

    const backups = await storage.getAutoBackups();
    assert.equal(backups.length, 2);
    assert.ok(backups[0].data.backupCreatedAt >= backups[1].data.backupCreatedAt);
  });
});
