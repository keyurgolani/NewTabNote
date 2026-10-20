/**
 * Storage manager using IndexedDB for New Tab Note
 * 
 * Note: IndexedDB store names remain as 'canvases' for backward compatibility
 * with existing user data. The API methods use "Note" terminology.
 */

// Mock chrome.storage for local testing if running via file://
if (typeof chrome === 'undefined' || !chrome.storage) {
  const mockStorage = {
    local: {
      get: (keys, callback) => {
        const result = {};
        const ks = Array.isArray(keys) ? keys : [keys];
        ks.forEach(k => {
          try {
            const val = localStorage.getItem(`chrome_mock_${k}`);
            result[k] = val ? JSON.parse(val) : undefined;
          } catch (e) {
            result[k] = undefined;
          }
        });
        setTimeout(() => callback(result), 0);
      },
      set: (items, callback) => {
        Object.keys(items).forEach(k => {
          localStorage.setItem(`chrome_mock_${k}`, JSON.stringify(items[k]));
        });
        if (callback) setTimeout(callback, 0);
      }
    },
    onChanged: {
      addListener: () => { }
    }
  };
  const mockRuntime = {
    lastError: null,
    sendMessage: () => { }
  };

  // Assign to all possible global scopes
  if (typeof window !== 'undefined') window.chrome = { storage: mockStorage, runtime: mockRuntime };
  if (typeof self !== 'undefined') self.chrome = { storage: mockStorage, runtime: mockRuntime };
  if (typeof globalThis !== 'undefined') globalThis.chrome = { storage: mockStorage, runtime: mockRuntime };
}

/**
 * What an import writes, prepared before its transaction opens.
 * @typedef {Object} ImportPlan
 * @property {'merge'|'replace'} mode
 * @property {Array<Object>} notes - Package notes (from a structuredClone of the parsed file)
 * @property {Map<string, string>} noteIds - Package note ID to the new local ID
 * @property {Array<Object>} elements - Blocks with new IDs and mapped canvasId
 * @property {Array<Object>} media - Media rows with new IDs, mapped canvasId, and Blob data
 * @property {Array<Object>} folders - Package folders
 * @property {number} skippedMedia - Media rows whose note isn't in the package
 */

/**
 * What a committed import did.
 * @typedef {Object} ImportResult
 * @property {'merge'|'replace'} mode
 * @property {number} notes
 * @property {number} blocks
 * @property {number} folders - Folders added
 * @property {number} reusedFolders - Package folders whose ID already existed locally
 * @property {number} media
 * @property {number} skippedMedia
 * @property {Array<string>} trashedIds - Local notes Replace all moved to trash
 * @property {number} trashedAt
 */

class DatabaseManager {
  constructor() {
    this.dbName = 'CanvasTabDB';
    this.dbVersion = 8; // Bumped version for snapshots
    this.db = null;
    // Store names kept as 'canvases' for backward compatibility with existing databases
    this.requiredStores = ['canvases', 'elements', 'settings', 'media', 'search_index', 'folders', 'links', 'themes', 'vectors', 'snapshots'];
    /** Without these the notes can't be read, so init() refuses to run. */
    this.coreStores = ['canvases', 'elements'];
    /**
     * 'closed' before init; 'open' after it (check missingStores for a degraded
     * database); 'newer-version' when a newer build upgraded the database;
     * 'missing-core-stores'; or 'failed'.
     * @type {'closed'|'open'|'newer-version'|'missing-core-stores'|'failed'}
     */
    this.openState = 'closed';
    /** @type {number|null} Version of the database on disk, read before opening */
    this.onDiskVersion = null;
    /** @type {Array<string>} Stores a version-8 database is missing */
    this.missingStores = [];
    /**
     * chrome.storage.local key naming the missing-stores recovery copy, so each
     * start reads this one small value instead of every stored backup. Whatever
     * removes that copy removes this key with it.
     */
    this.missingStoresCopyKey = 'recovery_copy_missing_stores';
  }

  /**
   * The chrome API (or the file:// mock installed at the top of this file).
   * @returns {any}
   */
  _chromeApi() {
    return /** @type {any} */ (globalThis).chrome;
  }

  /**
   * An Error with a machine-readable `code`. A plain Error rather than
   * StorageError, because the service worker doesn't load storage-error.js.
   * @param {string} code
   * @param {string} message
   * @returns {Error & {code: string}}
   */
  _codedError(code, message) {
    const error = /** @type {Error & {code: string}} */ (new Error(message));
    error.code = code;
    return error;
  }

  /**
   * Whether the open database has an object store.
   * @param {string} name
   * @returns {boolean}
   */
  hasStore(name) {
    return Boolean(this.db) && this.db.objectStoreNames.contains(name);
  }

  /**
   * Sleep for the specified number of milliseconds.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Retry a function with exponential backoff, throwing StorageError on final failure.
   * @param {Function} fn - Async function to execute
   * @param {string} operation - Name of the operation (for error reporting)
   * @param {number} [maxRetries=2] - Maximum number of retry attempts
   * @returns {Promise<*>}
   */
  async withRetry(fn, operation, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        // A store missing from the database won't appear on retry.
        if (error && error.code === 'STORE_UNAVAILABLE') throw error;
        if (attempt === maxRetries) {
          throw new StorageError('TRANSACTION_FAILED', operation, error);
        }
        await this._sleep(100 * Math.pow(4, attempt)); // 100ms, 400ms
      }
    }
  }

  /**
   * Open the database at this build's version (8).
   *
   * Nothing here deletes or rewrites a database. One a newer build upgraded is
   * left alone: init() rejects with code NEWER_SCHEMA before opening it at 8,
   * writing default settings, or running the integrity check. A version-8
   * database with stores missing is kept: without `canvases` or `elements`
   * init() rejects with MISSING_CORE_STORES; otherwise the app runs with those
   * features off (see missingStores and transaction()).
   * @returns {Promise<void>}
   */
  async init() {
    this.openState = 'closed';
    this.onDiskVersion = null;
    this.missingStores = [];

    await this.checkAndRepairDatabase();
    if (/** @type {string} */ (this.openState) === 'newer-version') {
      throw this._newerSchemaError();
    }
    this._throwIfCoreStoresMissing();

    let db;
    try {
      db = await this._openAtCurrentVersion();
    } catch (error) {
      if (error && error.name === 'VersionError') {
        // A newer build upgraded the database between the check and this open.
        this.openState = 'newer-version';
        this.onDiskVersion = await this._readOnDiskVersion();
        throw this._newerSchemaError();
      }
      this.openState = 'failed';
      console.error('IndexedDB error:', error);
      throw error;
    }

    this.db = db;
    this.missingStores = this.requiredStores.filter((store) => !db.objectStoreNames.contains(store));
    if (this.missingStores.length > 0) {
      console.warn('Missing stores detected:', this.missingStores);
    }
    try {
      this._throwIfCoreStoresMissing();
    } catch (error) {
      db.close();
      this.db = null;
      throw error;
    }
    this.openState = 'open';

    // Initialize default settings in chrome.storage.local on first load
    await this.initializeDefaultSettings();

    // Read-only integrity check: reports orphans, deletes nothing
    try {
      const report = await this.validateDatabase();
      const orphans = Object.entries(report)
        .filter(([key, value]) => key.startsWith('orphaned') && typeof value === 'number' && value > 0);
      if (orphans.length > 0) {
        console.info('Integrity check (read-only) found orphaned records:', Object.fromEntries(orphans));
      }
    } catch (e) {
      console.warn('Integrity check encountered an error:', e);
    }
  }

  /**
   * @returns {Error & {code: string}}
   */
  _newerSchemaError() {
    return this._codedError('NEWER_SCHEMA',
      `Notes database version ${this.onDiskVersion || 'unknown'} is newer than this build supports (${this.dbVersion})`);
  }

  /**
   * @returns {void}
   */
  _throwIfCoreStoresMissing() {
    const missingCore = this.coreStores.filter((store) => this.missingStores.includes(store));
    if (missingCore.length === 0) return;
    this.openState = 'missing-core-stores';
    throw this._codedError('MISSING_CORE_STORES', `Notes database is missing ${missingCore.join(' and ')}`);
  }

  /**
   * Open at this build's version, creating any store an older version lacks.
   * @returns {Promise<IDBDatabase>}
   */
  _openAtCurrentVersion() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (event) => {
        console.debug('Upgrading database from version', event.oldVersion, 'to', event.newVersion);
        this._createMissingStores(request.result);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        console.warn('Database upgrade blocked. Please close other tabs using this extension.');
      };
    });
  }

  /**
   * Create the version-8 stores an older database lacks. Runs only inside an upgrade.
   * @param {IDBDatabase} db
   * @returns {void}
   */
  _createMissingStores(db) {
    // Canvases store
    if (!db.objectStoreNames.contains('canvases')) {
      const canvasStore = db.createObjectStore('canvases', { keyPath: 'id' });
      canvasStore.createIndex('name', 'name', { unique: false });
      canvasStore.createIndex('updatedAt', 'updatedAt', { unique: false });
    }

    // Elements store
    if (!db.objectStoreNames.contains('elements')) {
      const elementStore = db.createObjectStore('elements', { keyPath: 'id' });
      elementStore.createIndex('canvasId', 'canvasId', { unique: false });
      elementStore.createIndex('type', 'type', { unique: false });
    }

    // Settings store
    if (!db.objectStoreNames.contains('settings')) {
      db.createObjectStore('settings', { keyPath: 'key' });
    }

    if (!db.objectStoreNames.contains('media')) {
      const mediaStore = db.createObjectStore('media', { keyPath: 'id' });
      mediaStore.createIndex('canvasId', 'canvasId', { unique: false });
    }

    // Search index store
    if (!db.objectStoreNames.contains('search_index')) {
      db.createObjectStore('search_index', { keyPath: 'noteId' });
    }

    // Folders store
    if (!db.objectStoreNames.contains('folders')) {
      const folderStore = db.createObjectStore('folders', { keyPath: 'id' });
      folderStore.createIndex('parentId', 'parentId', { unique: false });
      folderStore.createIndex('name', 'name', { unique: false });
    }

    // Links store (for bidirectional linking)
    if (!db.objectStoreNames.contains('links')) {
      const linkStore = db.createObjectStore('links', { keyPath: 'id' });
      linkStore.createIndex('fromNoteId', 'fromNoteId', { unique: false });
      linkStore.createIndex('toNoteId', 'toNoteId', { unique: false });
    }

    // Themes store
    if (!db.objectStoreNames.contains('themes')) {
      const themeStore = db.createObjectStore('themes', { keyPath: 'id' });
      themeStore.createIndex('name', 'name', { unique: false });
      themeStore.createIndex('updatedAt', 'updatedAt', { unique: false });
    }

    // Vectors store (for embeddings)
    if (!db.objectStoreNames.contains('vectors')) {
      db.createObjectStore('vectors', { keyPath: 'id' });
    }

    // Snapshots store (for version history)
    if (!db.objectStoreNames.contains('snapshots')) {
      const snapshotStore = db.createObjectStore('snapshots', { keyPath: 'id' });
      snapshotStore.createIndex('noteId', 'noteId', { unique: false });
      snapshotStore.createIndex('timestamp', 'timestamp', { unique: false });
    }
  }

  /**
   * Look at the database before opening it at this build's version, through
   * an unversioned open: record its version and missing stores, and write a
   * recovery copy when a version-8 database is missing stores. Never deletes
   * or changes the database.
   * @returns {Promise<void>}
   */
  async checkAndRepairDatabase() {
    const db = await this._openUnversioned();
    if (!db) return;
    try {
      this.onDiskVersion = db.version;
      if (db.version > this.dbVersion) {
        this.openState = 'newer-version';
        return;
      }
      // An older database gets its missing stores from the upgrade.
      if (db.version !== this.dbVersion) return;

      this.missingStores = this.requiredStores.filter((store) => !db.objectStoreNames.contains(store));
      // Page contexts only: the service worker leaves the copy to the next page that opens.
      if (this.missingStores.length > 0 && this.isPageContext()) {
        try {
          await this._writeMissingStoresCopy(db, this.missingStores);
        } catch (error) {
          console.warn('Could not save a recovery copy of the incomplete database:', error);
        }
      }
    } finally {
      db.close();
    }
  }

  /**
   * Open the database at whatever version it has, without upgrading it.
   * @returns {Promise<IDBDatabase|null>} null when it can't be opened
   */
  _openUnversioned() {
    return new Promise((resolve) => {
      const request = indexedDB.open(this.dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  }

  /**
   * @returns {Promise<number|null>}
   */
  async _readOnDiskVersion() {
    const db = await this._openUnversioned();
    if (!db) return null;
    const version = db.version;
    db.close();
    return version;
  }

  /**
   * Whether this is a page (new tab, popup, side panel) rather than the service worker.
   * @returns {boolean}
   */
  isPageContext() {
    return typeof document !== 'undefined';
  }

  /**
   * Save one recovery copy of a version-8 database that is missing stores:
   * every readable store except `settings` under its own name, with Blobs as
   * data URLs. Skipped when a copy for the same missing stores exists, which
   * the `missingStoresCopyKey` value records.
   * @param {IDBDatabase} db - Open through an unversioned open
   * @param {Array<string>} missing
   * @returns {Promise<void>}
   */
  async _writeMissingStoresCopy(db, missing) {
    const sameStores = (list) => Array.isArray(list) && list.length === missing.length
      && missing.every((store) => list.includes(store));
    const written = await this._getStorageValue(this.missingStoresCopyKey);
    if (written && sameStores(written.missingStores)) return;

    /** @type {Object<string, *>} */
    const copy = { recoveryBackup: true, reason: 'missing-stores', timestamp: Date.now(), missingStores: missing.slice() };
    for (const name of Array.from(db.objectStoreNames)) {
      // settings is skipped: versions up to 1.1.2 kept the AI key there in plaintext.
      if (name === 'settings') continue;
      try {
        copy[name] = await this._readStoreForCopy(db, name);
      } catch (error) {
        console.warn(`Recovery copy skipped unreadable store ${name}:`, error);
      }
    }
    await this._writeRecoveryBackup(copy, (key) => ({
      [this.missingStoresCopyKey]: { key, missingStores: copy.missingStores, timestamp: copy.timestamp },
    }));
  }

  /**
   * Read every store except `settings` through an unversioned open, changing
   * nothing. The newer-version and incomplete-database screens offer this
   * when the regular export can't run.
   * @returns {Promise<{rawExport: true, onDiskVersion: number, exportedAt: number, stores: Object<string, Array<*>>}>}
   */
  async exportRawStores() {
    const db = await this._openUnversioned();
    if (!db) throw new Error("couldn't open the notes database");
    try {
      /** @type {Object<string, Array<*>>} */
      const stores = {};
      for (const name of Array.from(db.objectStoreNames)) {
        if (name === 'settings') continue;
        stores[name] = await this._readStoreForCopy(db, name);
      }
      return { rawExport: true, onDiskVersion: db.version, exportedAt: Date.now(), stores };
    } finally {
      db.close();
    }
  }

  /**
   * Read a whole store for a copy: its values with Blobs as data URLs. Stores
   * without a key path (none in version 8) come back as {key, value} pairs.
   * @param {IDBDatabase} db
   * @param {string} name
   * @returns {Promise<Array<*>>}
   */
  async _readStoreForCopy(db, name) {
    const { values, keys } = await new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readonly');
      const store = tx.objectStore(name);
      const valuesRequest = store.getAll();
      const keysRequest = store.keyPath === null ? store.getAllKeys() : null;
      tx.oncomplete = () => resolve({ values: valuesRequest.result || [], keys: keysRequest ? keysRequest.result : null });
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const converted = [];
    for (const value of values) {
      converted.push(await this._blobsToDataUrls(value));
    }
    return keys ? converted.map((value, i) => ({ key: keys[i], value })) : converted;
  }

  /**
   * Copy a stored value with every Blob in it replaced by a data URL.
   * @param {*} value
   * @returns {Promise<*>}
   */
  async _blobsToDataUrls(value) {
    if (value instanceof Blob) return this._blobToDataUrl(value);
    if (!this._hasBlob(value, 0)) return value;
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) out.push(await this._blobsToDataUrls(item));
      return out;
    }
    /** @type {Object<string, *>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = await this._blobsToDataUrls(item);
    }
    return out;
  }

  /**
   * @param {*} value
   * @param {number} depth
   * @returns {boolean}
   */
  _hasBlob(value, depth) {
    if (value instanceof Blob) return true;
    if (!value || typeof value !== 'object' || depth > 32 || ArrayBuffer.isView(value)) return false;
    const items = Array.isArray(value) ? value : Object.values(value);
    return items.some((item) => this._hasBlob(item, depth + 1));
  }

  /**
   * @param {Blob} blob
   * @returns {Promise<string>}
   */
  _blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Create an automatic JSON backup of all notes to chrome.storage.local.
   * Retains the last 3 backups, removing the oldest when exceeded.
   * @returns {Promise<void>}
   */
  async createAutoBackup() {
    const data = await this.exportAll();
    data.autoBackup = true;
    data.backupCreatedAt = Date.now();

    const key = `auto_backup_${Date.now()}`;

    // Get existing auto backup keys
    const existingKeys = await this._getAutoBackupKeys();

    // Save new backup
    await new Promise((resolve, reject) => {
      chrome.storage.local.set({ [key]: data }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve();
      });
    });

    // Remove oldest backups if more than 3 (including the new one)
    const allKeys = [...existingKeys, key].sort();
    if (allKeys.length > 3) {
      const toRemove = allKeys.slice(0, allKeys.length - 3);
      await new Promise((resolve) => {
        chrome.storage.local.remove(toRemove, () => resolve());
      });
    }

    // Update last backup timestamp
    await this.setSetting('lastBackupAt', Date.now());
  }

  /**
   * Get all automatic backup entries from chrome.storage.local.
   * @returns {Promise<Array<{key: string, data: Object}>>}
   */
  async getAutoBackups() {
    const keys = await this._getAutoBackupKeys();
    if (keys.length === 0) return [];

    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => {
        const backups = keys
          .filter(k => result[k])
          .map(k => ({ key: k, data: result[k] }))
          .sort((a, b) => (b.data.backupCreatedAt || 0) - (a.data.backupCreatedAt || 0));
        resolve(backups);
      });
    });
  }

  /**
   * Get the storage keys for all automatic backups.
   * @returns {Promise<string[]>}
   */
  async _getAutoBackupKeys() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (result) => {
        if (chrome.runtime.lastError) { resolve([]); return; }
        const keys = Object.keys(result).filter(k => k.startsWith('auto_backup_'));
        resolve(keys.sort());
      });
    });
  }

  /**
   * One value from chrome.storage.local, reading only that key.
   * @param {string} key
   * @returns {Promise<*>} undefined when the key isn't set or can't be read
   */
  _getStorageValue(key) {
    const chromeApi = this._chromeApi();
    return new Promise((resolve) => {
      chromeApi.storage.local.get(key, (result) => {
        if (chromeApi.runtime.lastError || !result) { resolve(undefined); return; }
        resolve(result[key]);
      });
    });
  }

  /**
   * Save a recovery copy to chrome.storage.local under a new
   * `recovery_backup_<timestamp>` key. Nothing prunes these; the backup and
   * Recovery Center work (#18, #20) reads them.
   * @param {Object} copy
   * @param {(key: string) => Object<string, *>} [withItems] - More items to set in the same write, given the key
   * @returns {Promise<string>} The key written
   */
  async _writeRecoveryBackup(copy, withItems) {
    const chromeApi = this._chromeApi();
    // Check only the key about to be used, rather than reading every stored backup.
    let stamp = Date.now();
    while ((await this._getStorageValue(`recovery_backup_${stamp}`)) !== undefined) stamp += 1;
    const key = `recovery_backup_${stamp}`;
    const items = { [key]: copy, ...(withItems ? withItems(key) : {}) };
    await new Promise((resolve, reject) => {
      chromeApi.storage.local.set(items, () => {
        const error = chromeApi.runtime.lastError;
        if (error) {
          reject(new Error(error.message || String(error)));
        } else {
          resolve(key);
        }
      });
    });
    return key;
  }

  /**
   * Collect all note IDs from the canvases store.
   * @returns {Promise<Set<string>>}
   */
  async _getAllNoteIds() {
    return new Promise((resolve, reject) => {
      const store = this.getStore('canvases');
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(new Set(/** @type {Array<string>} */ (request.result)));
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Validate database integrity and return a report.
   * Does NOT modify data — read-only scan. Missing stores are skipped. Index
   * key cursors keep media and element payloads from being loaded.
   * @returns {Promise<{orphanedElements: number, orphanedSearchIndex: number, orphanedLinks: number, orphanedVectors: number, orphanedSnapshots: number, orphanedMedia: number, missingStores: string[]}>}
   */
  async validateDatabase() {
    const report = {
      orphanedElements: 0,
      orphanedSearchIndex: 0,
      orphanedLinks: 0,
      orphanedVectors: 0,
      orphanedSnapshots: 0,
      orphanedMedia: 0,
      missingStores: this.requiredStores.filter((store) => !this.hasStore(store))
    };

    const noteIds = await this._getAllNoteIds();

    if (this.hasStore('elements')) {
      report.orphanedElements = await this._countOrphanIndexKeys('elements', 'canvasId', noteIds);
    }

    if (this.hasStore('search_index')) {
      // keyPath is noteId
      const keys = await this._getAllKeys('search_index');
      report.orphanedSearchIndex = keys.filter((key) => !noteIds.has(/** @type {string} */ (key))).length;
    }

    if (this.hasStore('links')) {
      const links = await new Promise((resolve, reject) => {
        const request = this.getStore('links').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      report.orphanedLinks = links.filter(l =>
        (l.fromNoteId && !noteIds.has(l.fromNoteId)) ||
        (l.toNoteId && !noteIds.has(l.toNoteId))
      ).length;
    }

    if (this.hasStore('vectors')) {
      // saveVector keys each vector by its note ID
      const keys = await this._getAllKeys('vectors');
      report.orphanedVectors = keys.filter((key) => !noteIds.has(/** @type {string} */ (key))).length;
    }

    if (this.hasStore('snapshots')) {
      report.orphanedSnapshots = await this._countOrphanIndexKeys('snapshots', 'noteId', noteIds);
    }

    if (this.hasStore('media')) {
      report.orphanedMedia = await this._countOrphanIndexKeys('media', 'canvasId', noteIds);
    }

    return report;
  }

  /**
   * @param {string} storeName
   * @returns {Promise<Array<IDBValidKey>>}
   */
  _getAllKeys(storeName) {
    return new Promise((resolve, reject) => {
      const request = this.getStore(storeName).getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Count records whose index key names a note that doesn't exist.
   * @param {string} storeName
   * @param {string} indexName - Index on the note-ID field
   * @param {Set<string>} noteIds
   * @returns {Promise<number>}
   */
  _countOrphanIndexKeys(storeName, indexName, noteIds) {
    return new Promise((resolve, reject) => {
      let orphans = 0;
      const request = this.getStore(storeName).index(indexName).openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(orphans);
          return;
        }
        if (cursor.key && !noteIds.has(/** @type {string} */ (cursor.key))) orphans += 1;
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Generic transaction helper. A store the database lacks throws an Error
   * with code STORE_UNAVAILABLE: reads of auxiliary stores treat it as empty,
   * and writes let it reach their error toasts.
   * @param {string|Array<string>} storeNames
   * @param {IDBTransactionMode} [mode='readonly']
   * @returns {IDBTransaction}
   */
  transaction(storeNames, mode = 'readonly') {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const missing = names.filter((name) => !this.hasStore(name));
    if (this.db && missing.length > 0) {
      throw this._codedError('STORE_UNAVAILABLE', `Store unavailable: ${missing.join(', ')}`);
    }
    return this.db.transaction(storeNames, mode);
  }

  /**
   * Get object store
   * @param {string} storeName
   * @param {IDBTransactionMode} [mode='readonly']
   * @returns {IDBObjectStore}
   */
  getStore(storeName, mode = 'readonly') {
    return this.transaction(storeName, mode).objectStore(storeName);
  }

  /**
   * Run a read of an auxiliary store, treating a missing store as empty.
   * @template T
   * @param {() => Promise<T>} read
   * @param {T} emptyValue
   * @returns {Promise<T>}
   */
  async _readAux(read, emptyValue) {
    try {
      return await read();
    } catch (error) {
      if (error && error.code === 'STORE_UNAVAILABLE') return emptyValue;
      throw error;
    }
  }

  // ============ Daily Note Operations ============

  /**
   * Get today's daily note
   */
  async getTodayNote() {
    const todayStr = new Date().toISOString().split('T')[0];
    const notes = await this.getAllNotes(true); // Include archived to find daily notes
    return notes.find(n => n.isDaily && n.dateStr === todayStr);
  }

  /**
   * Create daily note for today if it doesn't exist
   */
  async ensureDailyNote() {
    let note = await this.getTodayNote();
    if (!note) {
      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      const name = `Daily Note - ${today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      note = await this.createNote(name);
      note.isDaily = true;
      note.dateStr = todayStr;
      await this.updateNote(note);

      // Check for daily note template
      const templateId = await this.getSetting('dailyNoteTemplate');
      if (templateId) {
        await this.applyTemplateToNote(note.id, templateId);
      }
    }
    return note;
  }

  /**
   * Create or get daily note for a specific date
   */
  async ensureDailyNoteForDate(dateStr) {
    const notes = await this.getAllNotes(true);
    let note = notes.find(n => n.isDaily && n.dateStr === dateStr);
    if (!note) {
      const date = new Date(dateStr + 'T00:00:00');
      const name = `Daily Note - ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      note = await this.createNote(name);
      note.isDaily = true;
      note.dateStr = dateStr;
      await this.updateNote(note);

      const templateId = await this.getSetting('dailyNoteTemplate');
      if (templateId) {
        await this.applyTemplateToNote(note.id, templateId);
      }
    }
    return note;
  }

  // ============ Note Operations ============

  /**
   * Create a new note
   */
  async createNote(name = 'Untitled') {
    const note = {
      id: Utils.generateId(),
      name: name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      archivedAt: null,
      titleManuallySet: false, // Track if user manually set the title
      lastAutoTitleAt: null, // Track when auto-title last ran
      insights: null, // AI-extracted insights (todos, reminders, deadlines, highlights)
      lastInsightsExtractedAt: null, // Track when insights were last extracted
      preview: '',
      pinned: false,
      todoProgress: null,
      isDaily: false, // flag for daily notes
      dateStr: null, // e.g., '2026-01-28' for daily notes
      isTemplate: false, // flag for template notes
      folderId: null, // parent folder ID
      viewport: {
        scale: 1,
        offsetX: 0,
        offsetY: 0,
      },
      settings: {
        gridType: 'dots',
        backgroundColor: '#fafafa',
      },
    };

    // Without a search_index store the note is still created; only its index entry is skipped.
    const indexed = this.hasStore('search_index');
    return this.withRetry(async () => {
      const tx = this.transaction(indexed ? ['canvases', 'search_index'] : ['canvases'], 'readwrite');
      await tx.objectStore('canvases').add(note);

      // Initial search index entry
      if (indexed) {
        await tx.objectStore('search_index').add({
          noteId: note.id,
          name: note.name,
          content: '',
          updatedAt: note.updatedAt
        });
      }

      return note;
    }, 'createNote');
  }

  /**
   * Get all notes (excludes archived and trashed by default)
   */
  async getAllNotes(includeArchived = false) {
    return new Promise((resolve, reject) => {
      // Store name 'canvases' kept for backward compatibility
      const store = this.getStore('canvases');
      const request = store.index('updatedAt').getAll();
      request.onsuccess = () => {
        let notes = request.result.reverse();
        // Always exclude trashed notes
        notes = notes.filter(note => !note.trashed);
        // Always exclude templates from main list
        notes = notes.filter(note => !note.isTemplate);
        if (!includeArchived) {
          notes = notes.filter(note => !note.archived);
        }
        resolve(notes);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all note names for autocomplete
   */
  async getNoteNames() {
    const notes = await this.getAllNotes(true);
    return notes
      .map(n => n.name)
      .filter(name => name && name.trim() !== '' && name.toLowerCase() !== 'untitled');
  }

  /**
   * Get archived notes only (excludes trashed)
   */
  async getArchivedNotes() {
    return new Promise((resolve, reject) => {
      const store = this.getStore('canvases');
      const request = store.index('updatedAt').getAll();
      request.onsuccess = () => {
        const notes = request.result
          .filter(note => note.archived && !note.trashed)
          .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
        resolve(notes);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Apply a template to a note
   */
  async applyTemplateToNote(noteId, templateId) {
    const templateElements = await this.getElementsByNote(templateId);
    if (!templateElements || templateElements.length === 0) return;

    const note = await this.getNote(noteId);
    if (!note) return;

    // Build replacement variables
    const now = new Date();
    const variables = {
      '{{date}}': now.toLocaleDateString(),
      '{{time}}': now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      '{{title}}': note.name || 'Untitled',
      '{{datetime}}': now.toLocaleString(),
    };

    const processText = (text) => {
      if (typeof text !== 'string') return text;
      let result = text;
      for (const [key, value] of Object.entries(variables)) {
        result = result.split(key).join(value);
      }
      return result;
    };

    // Clone and save elements
    for (const element of templateElements) {
      const newElement = {
        ...element,
        id: Utils.generateId(),
        canvasId: noteId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      if (newElement.content) {
        newElement.content = processText(newElement.content);
      }
      if (newElement.tableData) {
        newElement.tableData = newElement.tableData.map(row =>
          row.map(cell => processText(cell))
        );
      }

      await this.saveElement(newElement);
    }
  }

  /**
   * Get all template notes
   */
  async getTemplates() {
    return new Promise((resolve, reject) => {
      const store = this.getStore('canvases');
      const request = store.index('updatedAt').getAll();
      request.onsuccess = () => {
        const notes = request.result
          .filter(note => note.isTemplate && !note.trashed)
          .sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(notes);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Archive a note
   */
  async archiveNote(id) {
    const note = await this.getNote(id);
    if (!note) return null;

    note.archived = true;
    note.archivedAt = Date.now();
    return this.updateNote(note);
  }

  /**
   * Unarchive a note
   */
  async unarchiveNote(id) {
    const note = await this.getNote(id);
    if (!note) return null;

    note.archived = false;
    note.archivedAt = null;
    return this.updateNote(note);
  }

  // ============ Search Index Operations ============

  /**
   * Get all search index entries
   */
  async getSearchIndex() {
    return this._readAux(() => new Promise((resolve, reject) => {
      const store = this.getStore('search_index');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }), []);
  }

  /**
   * Set the entire search index
   */
  async setSearchIndex(data) {
    // Background indexing is skipped while the search_index store is missing.
    if (!this.hasStore('search_index')) return;
    return this.withRetry(() => new Promise((resolve, reject) => {
      const store = this.getStore('search_index', 'readwrite');
      store.clear();
      data.forEach(entry => store.put(entry));
      const tx = store.transaction;
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }), 'setSearchIndex');
  }

  /**
   * Update search index for a note
   */
  async updateNoteSearchIndex(noteId, data) {
    if (!this.hasStore('search_index')) return;
    return this.withRetry(async () => {
      const store = this.getStore('search_index', 'readwrite');
      const entry = await store.get(noteId);
      if (entry) {
        const updatedEntry = { ...entry, ...data, updatedAt: Date.now() };
        await store.put(updatedEntry);
      } else {
        await store.add({ noteId, ...data, updatedAt: Date.now() });
      }
    }, 'updateNoteSearchIndex');
  }

  /**
   * Set a single search index entry (upsert)
   * @param {Object} entry - Search index entry with noteId
   */
  async setSearchIndexEntry(entry) {
    if (!this.hasStore('search_index')) return;
    return this.withRetry(() => new Promise((resolve, reject) => {
      const store = this.getStore('search_index', 'readwrite');
      const request = store.put(entry);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }), 'setSearchIndexEntry');
  }

  /**
   * Remove a single search index entry by noteId
   * @param {string} noteId
   */
  async removeSearchIndexEntry(noteId) {
    if (!this.hasStore('search_index')) return;
    return this.withRetry(() => new Promise((resolve, reject) => {
      const store = this.getStore('search_index', 'readwrite');
      const request = store.delete(noteId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }), 'removeSearchIndexEntry');
  }

  /**
   * Check if a note is empty (has no meaningful content)
   */
  async isNoteEmpty(noteId) {
    const elements = await this.getElementsByNote(noteId);

    // No elements means empty
    if (elements.length === 0) {
      return true;
    }

    // Check if all elements have no meaningful content
    for (const el of elements) {
      // Check text content
      if (el.content) {
        // Strip HTML tags and check for actual text
        const textContent = el.content.replace(/<[^>]*>/g, '').trim();
        if (textContent.length > 0) {
          return false;
        }
      }

      // Check for media content
      if (el.imageUrl || el.fileData || el.videoUrl) {
        return false;
      }

      // Check for table data
      if (el.tableData && Array.isArray(el.tableData)) {
        const hasContent = el.tableData.some(row =>
          row.some(cell => cell && cell.trim() && !cell.startsWith('Header '))
        );
        if (hasContent) {
          return false;
        }
      }

      // Check for bookmark
      if (el.url && el.title) {
        return false;
      }

      // Check for toggle children content
      if (el.children) {
        const childContent = el.children.replace(/<[^>]*>/g, '').trim();
        if (childContent.length > 0) {
          return false;
        }
      }

      // Check for equation
      if (el.equation && el.equation.trim()) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if a note is untitled
   */
  isNoteUntitled(note) {
    if (!note || !note.name) return true;
    const name = note.name.toLowerCase().trim();
    return name === '' || name === 'untitled' || name.match(/^untitled\s*\d*$/);
  }

  /**
   * Move note to trash (soft delete)
   * If note is untitled and empty, permanently delete instead
   */
  async trashNote(id) {
    const note = await this.getNote(id);
    if (!note) return null;

    // Check if note is untitled and empty - if so, permanently delete
    const isUntitled = this.isNoteUntitled(note);
    if (isUntitled) {
      const isEmpty = await this.isNoteEmpty(id);
      if (isEmpty) {
        await this.permanentlyDeleteNote(id);
        return { permanentlyDeleted: true };
      }
    }

    note.trashed = true;
    note.trashedAt = Date.now();
    // Clear archived status when trashing
    note.archived = false;
    note.archivedAt = null;
    return this.updateNote(note);
  }

  /**
   * Restore note from trash
   */
  async restoreNote(id) {
    const note = await this.getNote(id);
    if (!note) return null;

    note.trashed = false;
    note.trashedAt = null;
    return this.updateNote(note);
  }

  /**
   * Get trashed notes
   */
  async getTrashedNotes() {
    return new Promise((resolve, reject) => {
      const store = this.getStore('canvases');
      const request = store.index('updatedAt').getAll();
      request.onsuccess = () => {
        const notes = request.result
          .filter(note => note.trashed)
          .sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));
        resolve(notes);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Permanently delete note (used for emptying trash)
   */
  async permanentlyDeleteNote(id) {
    // Delete all elements for this note
    await this.deleteElementsByNote(id);
    // Delete all media for this note
    await this.deleteMediaByNote(id);

    // Delete vectors for this note (none exist while the vectors store is missing)
    if (this.hasStore('vectors')) {
      try {
        const store = this.getStore('vectors', 'readwrite');
        await store.delete(id);
      } catch (e) {
        console.warn('Failed to delete vectors for note:', id, e);
      }
    }

    // Delete snapshots for this note
    try {
      await this.deleteSnapshotsByNote(id);
    } catch (e) {
      console.warn('Failed to delete snapshots for note:', id, e);
    }

    return this.withRetry(() => new Promise((resolve, reject) => {
      const store = this.getStore('canvases', 'readwrite');
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }), 'permanentlyDeleteNote');
  }

  /**
   * Perform an action on multiple notes at once
   * @param {Array<string>} ids - Array of note IDs
   * @param {string} action - 'trash', 'archive', 'unarchive', 'restore', 'delete'
   */
  async bulkNoteAction(ids, action) {
    if (!ids || ids.length === 0) return [];

    const results = [];
    for (const id of ids) {
      let result;
      switch (action) {
        case 'trash':
          result = await this.trashNote(id);
          break;
        case 'archive':
          result = await this.archiveNote(id);
          break;
        case 'unarchive':
          result = await this.unarchiveNote(id);
          break;
        case 'restore':
          result = await this.restoreNote(id);
          break;
        case 'delete':
          result = await this.permanentlyDeleteNote(id);
          break;
      }
      results.push(result);
    }
    return results;
  }

  /**
   * Alias for getElementsByNote for backward compatibility/consistency
   */
  async getElements(noteId) {
    return this.getElementsByNote(noteId);
  }

  /**
   * Clean up old trashed notes (auto-delete after retention period)
   */
  async cleanupTrash(retentionDays = 30) {
    const trashedNotes = await this.getTrashedNotes();
    const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);

    const expiredNotes = trashedNotes.filter(note =>
      note.trashedAt && note.trashedAt < cutoffTime
    );

    for (const note of expiredNotes) {
      await this.permanentlyDeleteNote(note.id);
    }

    return expiredNotes.length;
  }

  /**
   * Empty trash (permanently delete all trashed notes)
   */
  async emptyTrash() {
    const trashedNotes = await this.getTrashedNotes();
    for (const note of trashedNotes) {
      await this.permanentlyDeleteNote(note.id);
    }
    return trashedNotes.length;
  }

  /**
   * Get note by ID
   */
  async getNote(id) {
    return new Promise((resolve, reject) => {
      // Store name 'canvases' kept for backward compatibility
      const store = this.getStore('canvases');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Update note
   */
  async updateNote(note) {
    note.updatedAt = Date.now();
    return this.withRetry(() => new Promise((resolve, reject) => {
      // Store name 'canvases' kept for backward compatibility
      const store = this.getStore('canvases', 'readwrite');
      const request = store.put(note);
      request.onsuccess = async () => {
        // Update search index if name changed
        if (note.name !== undefined) {
          await this.updateNoteNameInSearchIndex(note.id, note.name);
        }
        resolve(note);
      };
      request.onerror = () => reject(request.error);
    }), 'updateNote');
  }

  /**
   * Write a note and its blocks in one readwrite transaction on `canvases` and
   * `elements`, so a note is never stored without the blocks the editor had for it.
   * Sets `updatedAt` like updateNote. The transaction opens synchronously, before
   * this returns, which lets pagehide and visibilitychange handlers use it.
   *
   * Trash and archive state stays as stored: the editor never sets it, and its
   * copy of the note can be older than a trash, restore, or import Replace done
   * meanwhile (in this tab or another). The stored values are copied onto `note`.
   * @param {Object} note - Note record (`updatedAt` is set on it)
   * @param {Array<Object>} elements - Block records, each with `canvasId` set to the note's ID
   * @returns {Promise<Object>} The note, once the transaction completes
   */
  saveNoteWithBlocks(note, elements) {
    note.updatedAt = Date.now();
    return new Promise((resolve, reject) => {
      const tx = this.transaction(['canvases', 'elements'], 'readwrite');
      tx.oncomplete = () => resolve(note);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('saveNoteWithBlocks transaction aborted'));
      // A put that throws (for example DataCloneError) must not let the rest commit.
      const fail = (error) => {
        tx.abort();
        reject(error);
      };
      try {
        const elementStore = tx.objectStore('elements');
        for (const element of elements) {
          elementStore.put(element);
        }
        const canvases = tx.objectStore('canvases');
        const read = canvases.get(note.id);
        read.onsuccess = () => {
          try {
            this._keepStoredNoteState(note, read.result);
            canvases.put(note);
          } catch (error) {
            fail(error);
          }
        };
      } catch (error) {
        fail(error);
      }
    });
  }

  /**
   * Copy the stored trash and archive fields onto a note about to be written.
   * @param {Object} note
   * @param {Object|undefined} stored - The note as stored, if it is
   * @returns {void}
   */
  _keepStoredNoteState(note, stored) {
    if (!stored) return;
    for (const field of ['trashed', 'trashedAt', 'archived', 'archivedAt']) {
      if (field in stored) note[field] = stored[field];
      else delete note[field];
    }
  }

  /**
   * Helper to update only name in search index
   */
  async updateNoteNameInSearchIndex(noteId, name) {
    // A side effect of saving: skipped while the search_index store is missing.
    if (!this.hasStore('search_index')) return;
    return this.withRetry(() => new Promise((resolve, reject) => {
      const store = this.getStore('search_index', 'readwrite');
      const getRequest = store.get(noteId);
      getRequest.onsuccess = () => {
        const entry = getRequest.result;
        if (entry) {
          entry.name = name;
          entry.updatedAt = Date.now();
          const putRequest = store.put(entry);
          putRequest.onsuccess = () => resolve();
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          resolve();
        }
      };
      getRequest.onerror = () => reject(getRequest.error);
    }), 'updateNoteNameInSearchIndex');
  }

  // ============ Folder Operations ============

  /**
   * Create a new folder
   */
  async createFolder(name, parentId = null) {
    const folder = {
      id: Utils.generateId(),
      name: name,
      parentId: parentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      color: null,
      collapsed: false
    };

    await this.withRetry(async () => {
      await this.getStore('folders', 'readwrite').add(folder);
    }, 'createFolder');
    return folder;
  }

  /**
   * Get all folders
   */
  async getAllFolders() {
    return this._readAux(() => new Promise((resolve, reject) => {
      const request = this.getStore('folders').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }), []);
  }

  /**
   * Get folder by ID
   */
  async getFolder(id) {
    return this._readAux(() => new Promise((resolve, reject) => {
      const request = this.getStore('folders').get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }), undefined);
  }

  /**
   * Update a folder
   */
  async updateFolder(folder) {
    folder.updatedAt = Date.now();
    return this.withRetry(() => new Promise((resolve, reject) => {
      const request = this.getStore('folders', 'readwrite').put(folder);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    }), 'updateFolder');
  }

  /**
   * Delete a folder and its contents (recursive)
   */
  async deleteFolder(folderId) {
    // 1. Get all child folders and notes
    const folders = await this.getAllFolders();
    const notes = await this.getAllNotes(true);

    const childrenToProcess = [folderId];
    const foldersToDelete = [];
    const notesToProcess = [];

    // Find all nested folders
    let i = 0;
    while (i < childrenToProcess.length) {
      const currentId = childrenToProcess[i];
      foldersToDelete.push(currentId);

      const childFolders = folders.filter(f => f.parentId === currentId);
      childFolders.forEach(f => {
        if (!childrenToProcess.includes(f.id)) {
          childrenToProcess.push(f.id);
        }
      });

      const folderNotes = notes.filter(n => n.folderId === currentId);
      folderNotes.forEach(n => notesToProcess.push(n));

      i++;
    }

    // 2. Delete folders and process notes (e.g., move to trash or delete)
    return this.withRetry(() => new Promise((resolve, reject) => {
      const tx = this.transaction(['folders', 'canvases'], 'readwrite');
      const folderStore = tx.objectStore('folders');
      const noteStore = tx.objectStore('canvases');

      for (const id of foldersToDelete) {
        folderStore.delete(id);
      }

      for (const note of notesToProcess) {
        // For now, move orphaned notes to root (null folder)
        note.folderId = null;
        note.updatedAt = Date.now();
        noteStore.put(note);
      }

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    }), 'deleteFolder');
  }

  /**
   * Move note to folder
   */
  async moveNoteToFolder(noteId, folderId) {
    const note = await this.getNote(noteId);
    if (note) {
      note.folderId = folderId;
      return this.updateNote(note);
    }
    return false;
  }

  /**
   * Delete note (moves to trash - soft delete)
   */
  async deleteNote(id) {
    return this.trashNote(id);
  }

  // ============ Linking & Backlinks Operations ============

  /**
   * Update internal links for a note
   * @param {string} fromNoteId - The source note
   * @param {Array<string>} targetNoteNames - Names of notes being linked to
   */
  async updateNoteLinks(fromNoteId, targetNoteNames) {
    // A side effect of saving: skipped while the links store is missing.
    if (!this.hasStore('links')) return;
    if (!targetNoteNames || targetNoteNames.length === 0) {
      // Clear existing links from this note
      await this.clearLinksFromNote(fromNoteId);
      return;
    }

    // 1. Find IDs for these note names
    const allNotes = await this.getAllNotes(true);
    const targetIds = [];

    targetNoteNames.forEach(name => {
      const targetNote = allNotes.find(n => n.name && n.name.toLowerCase() === name.toLowerCase());
      if (targetNote && targetNote.id !== fromNoteId) {
        targetIds.push(targetNote.id);
      }
    });

    // 2. Clear old links and add new ones
    return this.withRetry(() => {
      const tx = this.transaction('links', 'readwrite');
      const store = tx.objectStore('links');

      // Manual clear
      const index = store.index('fromNoteId');
      const request = index.getAll(fromNoteId);

      return new Promise((resolve, reject) => {
        request.onsuccess = async () => {
          const existingLinks = request.result;
          existingLinks.forEach(link => store.delete(link.id));

          // Add new unique links
          const uniqueTargetIds = [...new Set(targetIds)];
          uniqueTargetIds.forEach(toNoteId => {
            store.add({
              id: Utils.generateId(),
              fromNoteId,
              toNoteId,
              createdAt: Date.now()
            });
          });

          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    }, 'updateNoteLinks');
  }

  /**
   * Clear all links originating from a note
   */
  async clearLinksFromNote(noteId) {
    if (!this.hasStore('links')) return;
    return this.withRetry(() => {
      const tx = this.transaction('links', 'readwrite');
      const store = tx.objectStore('links');
      const index = store.index('fromNoteId');
      const request = index.getAll(noteId);

      return new Promise((resolve) => {
        request.onsuccess = () => {
          request.result.forEach(link => store.delete(link.id));
          resolve();
        };
        request.onerror = () => resolve();
      });
    }, 'clearLinksFromNote');
  }

  /**
   * Get all backlinks for a note
   */
  async getBacklinks(noteId) {
    return this._readAux(() => new Promise((resolve, reject) => {
      const store = this.getStore('links');
      const index = store.index('toNoteId');
      const request = index.getAll(noteId);

      request.onsuccess = async () => {
        const links = request.result;
        const sourceNoteIds = links.map(l => l.fromNoteId);

        // Fetch note details for each source
        const sourceNotes = [];
        for (const id of sourceNoteIds) {
          const note = await this.getNote(id);
          if (note) sourceNotes.push(note);
        }
        resolve(sourceNotes);
      };
      request.onerror = () => reject(request.error);
    }), []);
  }

  // ============ Element Operations ============

  /**
   * Save element
   */
  async saveElement(element) {
    return this.withRetry(() => new Promise((resolve, reject) => {
      const store = this.getStore('elements', 'readwrite');
      const request = store.put(element);
      request.onsuccess = () => resolve(element);
      request.onerror = () => reject(request.error);
    }), 'saveElement');
  }

  /**
   * Save multiple elements
   */
  async saveElements(elements) {
    return this.withRetry(() => new Promise((resolve, reject) => {
      const tx = this.transaction('elements', 'readwrite');
      const store = tx.objectStore('elements');

      elements.forEach((el) => store.put(el));

      tx.oncomplete = () => resolve(elements);
      tx.onerror = () => reject(tx.error);
    }), 'saveElements');
  }

  /**
   * Get elements by note ID
   * Note: Index name 'canvasId' kept for backward compatibility
   */
  async getElementsByNote(noteId) {
    return new Promise((resolve, reject) => {
      const store = this.getStore('elements');
      const index = store.index('canvasId');
      const request = index.getAll(noteId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete element
   */
  async deleteElement(id) {
    return this.withRetry(() => new Promise((resolve, reject) => {
      const store = this.getStore('elements', 'readwrite');
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }), 'deleteElement');
  }

  /**
   * Delete multiple elements
   */
  async deleteElements(ids) {
    return this.withRetry(() => new Promise((resolve, reject) => {
      const tx = this.transaction('elements', 'readwrite');
      const store = tx.objectStore('elements');

      ids.forEach((id) => store.delete(id));

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }), 'deleteElements');
  }

  /**
   * Delete all elements for a note
   */
  async deleteElementsByNote(noteId) {
    const elements = await this.getElementsByNote(noteId);
    const ids = elements.map((el) => el.id);
    if (ids.length > 0) {
      await this.deleteElements(ids);
    }
  }

  // ============ Media Operations ============

  /**
   * Save media blob
   */
  async saveMedia(id, canvasId, blob, type) {
    const media = {
      id,
      canvasId,
      blob,
      type,
      createdAt: Date.now(),
    };

    return this.withRetry(() => new Promise((resolve, reject) => {
      const store = this.getStore('media', 'readwrite');
      const request = store.put(media);
      request.onsuccess = () => resolve(media);
      request.onerror = () => reject(request.error);
    }), 'saveMedia');
  }

  /**
   * Get media by ID
   */
  async getMedia(id) {
    return this._readAux(() => new Promise((resolve, reject) => {
      const store = this.getStore('media');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }), undefined);
  }

  /**
   * Delete media by note
   * Note: Index name 'canvasId' kept for backward compatibility
   */
  async deleteMediaByNote(noteId) {
    // No media exists while the media store is missing, so there is nothing to delete.
    if (!this.hasStore('media')) return;
    return this.withRetry(() => new Promise((resolve, reject) => {
      const tx = this.transaction('media', 'readwrite');
      const store = tx.objectStore('media');
      // Index name 'canvasId' kept for backward compatibility
      const index = store.index('canvasId');
      const request = index.getAllKeys(noteId);

      request.onsuccess = () => {
        request.result.forEach((key) => store.delete(key));
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }), 'deleteMediaByNote');
  }

  // ============ Settings Operations ============
  // Settings use chrome.storage.local for cross-tab synchronization

  /**
   * Get setting from chrome.storage.local
   */
  async getSetting(key, defaultValue = null) {
    return new Promise((resolve) => {
      const storageKey = `setting_${key}`;
      chrome.storage.local.get([storageKey], (result) => {
        if (chrome.runtime.lastError) {
          console.warn('Error getting setting:', chrome.runtime.lastError);
          resolve(defaultValue);
          return;
        }
        resolve(result[storageKey] !== undefined ? result[storageKey] : defaultValue);
      });
    });
  }

  /**
   * Set setting in chrome.storage.local
   */
  async setSetting(key, value) {
    return new Promise((resolve, reject) => {
      const storageKey = `setting_${key}`;
      chrome.storage.local.set({ [storageKey]: value }, () => {
        if (chrome.runtime.lastError) {
          console.error('Error setting value:', chrome.runtime.lastError);
          reject(chrome.runtime.lastError);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Get all settings
   */
  async getAllSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (result) => {
        if (chrome.runtime.lastError) {
          console.warn('Error getting all settings:', chrome.runtime.lastError);
          resolve({});
          return;
        }
        // Filter to only setting_ prefixed keys and remove prefix
        const settings = {};
        for (const [key, value] of Object.entries(result)) {
          if (key.startsWith('setting_')) {
            settings[key.substring(8)] = value;
          }
        }
        resolve(settings);
      });
    });
  }

  /**
   * Add listener for settings changes (for cross-tab sync)
   */
  onSettingsChange(callback) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;

      const settingChanges = {};
      for (const [key, change] of Object.entries(changes)) {
        if (key.startsWith('setting_')) {
          const settingKey = key.substring(8);
          settingChanges[settingKey] = {
            oldValue: change.oldValue,
            newValue: change.newValue
          };
        }
      }

      if (Object.keys(settingChanges).length > 0) {
        callback(settingChanges);
      }
    });
  }

  /**
   * Initialize default settings in chrome.storage.local on first load
   * This ensures the storage permission is actively used from the start
   */
  async initializeDefaultSettings() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        console.warn('Storage: chrome.storage.local not available. Fallback might be needed.');
        resolve();
        return;
      }

      chrome.storage.local.get(['setting_storageInitialized'], async (result) => {
        if (result.setting_storageInitialized) {
          // Already initialized
          resolve();
          return;
        }

        // Default settings to write
        const defaultSettings = {
          setting_storageInitialized: true,
          setting_theme: 'system',
          setting_font: 'default',
          setting_width: 'default',
          setting_llmProvider: 'none',
          setting_llmApiKey: '',
          setting_llmModel: '',
          setting_ollamaUrl: 'http://localhost:11434',
          setting_trashRetention: 30,
          setting_sidebarOpen: true,
          setting_sidebarWidth: 260,
          setting_sidebarViewMode: 'list',
          setting_autoTitleEnabled: false,
          setting_autoTitleInterval: 15,
          setting_insightsEnabled: false,
          setting_insightsInterval: 360,
          setting_aiSidebarWidth: 360,
          setting_openTabs: null,
          setting_activeTabIndex: 0,
          setting_aiChatHistory: [],
          setting_noteChatMessages: [],
          setting_globalChatHistory: [],
          setting_globalChatMessages: [],
          setting_lastAutoTitleRun: 0,
          setting_lastInsightsRun: 0
        };

        chrome.storage.local.set(defaultSettings, () => {
          if (chrome.runtime.lastError) {
            console.warn('Error initializing default settings:', chrome.runtime.lastError);
          } else {
            console.debug('Default settings initialized in chrome.storage.local');
          }
          resolve();
        });
      });
    });
  }

  // ============ Export/Import ============

  /**
   * Export every note outside trash (active, archived, and templates) with
   * its blocks and media, plus all folders. Export JSON, Create Backup,
   * auto-backup, and the Replace all recovery copy use this. `version` stays
   * 1 so 1.4.0 can still import the file.
   * @returns {Promise<Object>} {version, exportedAt, canvases, elements, media, folders}
   */
  async exportAll() {
    const notes = [...(await this.getAllNotes(true)), ...(await this.getTemplates())];
    const noteIds = new Set(notes.map((note) => note.id));
    const allElements = [];

    for (const note of notes) {
      const elements = await this.getElementsByNote(note.id);
      allElements.push(...elements);
    }

    // Only media whose note is exported (1.4.0 exported the whole store)
    const allMedia = (await this._getAllMedia()).filter((m) => noteIds.has(m.canvasId));

    // Convert blobs to base64 for export
    const mediaWithBase64 = await Promise.all(
      allMedia.map(async (m) => {
        if (m.blob instanceof Blob) {
          const base64 = await Utils.readFileAsDataURL(m.blob);
          return { ...m, blob: base64 };
        }
        return m;
      })
    );

    return {
      version: 1,
      exportedAt: Date.now(),
      // Key name 'canvases' kept for backward compatibility with existing exports
      canvases: notes,
      elements: allElements,
      media: mediaWithBase64,
      folders: await this.getAllFolders(),
    };
  }

  /**
   * Every media row.
   * @returns {Promise<Array<Object>>}
   */
  async _getAllMedia() {
    return this._readAux(() => new Promise((resolve, reject) => {
      const request = this.getStore('media').getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    }), []);
  }

  /**
   * Export single note
   */
  async exportNote(noteId) {
    const note = await this.getNote(noteId);
    const elements = await this.getElementsByNote(noteId);

    // Get media for this note
    const media = await this._readAux(() => new Promise((resolve, reject) => {
      // Index name 'canvasId' kept for backward compatibility
      const request = this.getStore('media').index('canvasId').getAll(noteId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }), []);

    // Convert blobs to base64
    const mediaWithBase64 = await Promise.all(
      media.map(async (m) => {
        if (m.blob instanceof Blob) {
          const base64 = await Utils.readFileAsDataURL(m.blob);
          return { ...m, blob: base64 };
        }
        return m;
      })
    );

    return {
      version: 1,
      exportedAt: Date.now(),
      // Key name 'canvases' kept for backward compatibility with existing exports
      canvases: [note],
      elements,
      media: mediaWithBase64,
    };
  }

  /**
   * Check a parsed backup before anything is written. Writes nothing.
   * The format uses the 'canvases' key for backward compatibility.
   * @param {*} data - Parsed backup file
   * @returns {{ok: true, counts: {notes: number, blocks: number, folders: number, media: number, skippedMedia: number}} | {ok: false, reason: string}}
   */
  validateImport(data) {
    /**
     * @param {string} reason
     * @returns {{ok: false, reason: string}}
     */
    const refuse = (reason) => ({ ok: false, reason });
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('canvases' in data)) {
      return refuse("the file isn't a NewTabNote backup");
    }
    if (data.version !== 1) {
      return refuse(data.version === undefined
        ? 'the file has no backup version'
        : `backup version ${String(data.version)} isn't supported`);
    }
    if (!Array.isArray(data.canvases)) return refuse("its notes aren't a list");
    if (!Array.isArray(data.elements)) return refuse('it has no list of blocks');
    const optionalList = (value) => value === undefined || value === null || Array.isArray(value);
    if (!optionalList(data.media)) return refuse("its media isn't a list");
    if (!optionalList(data.folders)) return refuse("its folders aren't a list");
    const media = Array.isArray(data.media) ? data.media : [];
    const folders = Array.isArray(data.folders) ? data.folders : [];

    /**
     * @param {Array<*>} list
     * @param {string} one - Singular label
     * @param {string} many - Plural label
     * @returns {string|null} Refusal reason
     */
    const checkRecords = (list, one, many) => {
      const seen = new Set();
      for (let i = 0; i < list.length; i++) {
        const record = list[i];
        if (!record || typeof record !== 'object' || Array.isArray(record)) return `${one} ${i + 1} isn't a record`;
        if (typeof record.id !== 'string' || record.id === '') return `${one} ${i + 1} has no text ID`;
        if (seen.has(record.id)) return `two ${many} share the ID "${record.id}"`;
        seen.add(record.id);
      }
      return null;
    };
    const recordProblem = checkRecords(data.canvases, 'note', 'notes')
      || checkRecords(data.elements, 'block', 'blocks')
      || checkRecords(media, 'media item', 'media items')
      || checkRecords(folders, 'folder', 'folders');
    if (recordProblem) return refuse(recordProblem);

    const noteIds = new Set(data.canvases.map((n) => n.id));
    const orphan = data.elements.find((el) => !noteIds.has(el.canvasId));
    if (orphan) return refuse(`block "${orphan.id}" belongs to a note that isn't in the file`);

    // 1.4.0 exports carry the whole media store, so media for notes outside the file is skipped, not refused.
    const skippedMedia = media.filter((m) => !noteIds.has(m.canvasId)).length;
    return {
      ok: true,
      counts: {
        notes: data.canvases.length,
        blocks: data.elements.length,
        folders: folders.length,
        media: media.length - skippedMedia,
        skippedMedia,
      },
    };
  }

  /**
   * Import a backup. Never writes package data over a local record: notes,
   * blocks, and media get new IDs; a package folder whose ID exists locally
   * reuses the local folder untouched. Replace all also moves every active
   * note to trash, in the same transaction, after saving a recovery copy.
   * Works on a structuredClone of `data`, so the parsed input isn't changed.
   * @param {*} data - Parsed backup file (checked with validateImport)
   * @param {'merge'|'replace'} mode
   * @returns {Promise<ImportResult>}
   */
  async importData(data, mode) {
    if (mode !== 'merge' && mode !== 'replace') {
      throw this._codedError('IMPORT_INVALID', `unknown import mode "${mode}"`);
    }
    const check = this.validateImport(data);
    if (check.ok === false) {
      throw this._codedError('IMPORT_INVALID', check.reason);
    }

    const pkg = structuredClone(data);
    const folders = Array.isArray(pkg.folders) ? pkg.folders : [];
    const mediaRows = Array.isArray(pkg.media) ? pkg.media : [];
    if (folders.length > 0 && !this.hasStore('folders')) {
      throw this._codedError('IMPORT_INVALID', "this profile's folders store is missing");
    }

    const noteIds = new Map(pkg.canvases.map((n) => [n.id, Utils.generateId()]));
    // Field name 'canvasId' kept for backward compatibility
    const elements = pkg.elements.map((el) => ({ ...el, id: Utils.generateId(), canvasId: noteIds.get(el.canvasId) }));
    const media = [];
    let skippedMedia = 0;
    for (const row of mediaRows) {
      if (!noteIds.has(row.canvasId)) {
        skippedMedia += 1;
        continue;
      }
      // Turn data URLs into Blobs now: awaiting inside the transaction would let it commit early.
      const blob = typeof row.blob === 'string' && row.blob.startsWith('data:') ? this._dataUrlToBlob(row.blob) : row.blob;
      media.push({ ...row, id: Utils.generateId(), canvasId: noteIds.get(row.canvasId), blob });
    }
    if (media.length > 0 && !this.hasStore('media')) {
      throw this._codedError('IMPORT_INVALID', "this profile's media store is missing");
    }

    if (mode === 'replace') {
      // A superset of the export and the older recovery format, for the legacy decoders in #18.
      const copy = { ...(await this.exportAll()), recoveryBackup: true, reason: 'pre-import-replace', timestamp: Date.now() };
      try {
        await this._writeRecoveryBackup(copy);
      } catch (error) {
        console.warn('Recovery copy before Replace all failed:', error);
        throw this._codedError('RECOVERY_COPY_FAILED', "couldn't save a recovery copy");
      }
    }

    return this._commitImport({ mode, notes: pkg.canvases, noteIds, elements, media, folders, skippedMedia });
  }

  /**
   * The import commit: one readwrite transaction over canvases, elements,
   * media, and folders. Local notes and folders are read inside it, so what
   * it decides (trash, folder reuse, daily-note dates) matches what it writes.
   * Any failure aborts the whole transaction.
   * @param {ImportPlan} plan
   * @returns {Promise<ImportResult>}
   */
  _commitImport(plan) {
    return new Promise((resolve, reject) => {
      const scope = ['canvases', 'elements'];
      if (this.hasStore('media')) scope.push('media');
      if (this.hasStore('folders')) scope.push('folders');
      const tx = this.transaction(scope, 'readwrite');
      const now = Date.now();
      /** @type {ImportResult} */
      const result = {
        mode: plan.mode,
        notes: plan.notes.length,
        blocks: plan.elements.length,
        folders: 0,
        reusedFolders: 0,
        media: plan.media.length,
        skippedMedia: plan.skippedMedia,
        trashedIds: [],
        trashedAt: now,
      };
      /** @type {*} */
      let failure = null;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error || new Error('Import transaction aborted'));

      const notesRequest = tx.objectStore('canvases').getAll();
      const foldersRequest = scope.includes('folders') ? tx.objectStore('folders').getAll() : null;
      let waiting = foldersRequest ? 2 : 1;
      const onRead = () => {
        waiting -= 1;
        if (waiting > 0) return;
        try {
          this._writeImport(tx, plan, notesRequest.result, foldersRequest ? foldersRequest.result : [], result);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      notesRequest.onsuccess = onRead;
      if (foldersRequest) foldersRequest.onsuccess = onRead;
    });
  }

  /**
   * Queue the import's writes inside its transaction.
   * @param {IDBTransaction} tx
   * @param {ImportPlan} plan
   * @param {Array<Object>} localNotes - Every note record, read in this transaction
   * @param {Array<Object>} localFolders - Every folder record, read in this transaction
   * @param {ImportResult} result - Updated with what was written
   * @returns {void}
   */
  _writeImport(tx, plan, localNotes, localFolders, result) {
    const noteStore = tx.objectStore('canvases');
    const localFolderIds = new Set(localFolders.map((f) => f.id));
    const packageFolderIds = new Set(plan.folders.map((f) => f.id));
    /** @param {*} id */
    const resolveFolder = (id) => (id && (packageFolderIds.has(id) || localFolderIds.has(id)) ? id : null);

    if (plan.mode === 'replace') {
      for (const local of localNotes) {
        if (local.trashed || local.archived || local.isTemplate) continue;
        // As trashNote does, without its hard delete of empty untitled notes.
        local.trashed = true;
        local.trashedAt = result.trashedAt;
        local.archived = false;
        local.archivedAt = null;
        local.updatedAt = result.trashedAt;
        noteStore.put(local);
        result.trashedIds.push(local.id);
      }
    }

    // Dates that keep a local daily note outside trash after this commit.
    const dailyDates = new Set(localNotes
      .filter((n) => !n.trashed && n.isDaily && n.dateStr)
      .map((n) => n.dateStr));

    if (plan.folders.length > 0) {
      const folderStore = tx.objectStore('folders');
      for (const folder of plan.folders) {
        if (localFolderIds.has(folder.id)) {
          result.reusedFolders += 1;
          continue;
        }
        folderStore.add({ ...folder, parentId: resolveFolder(folder.parentId) });
        result.folders += 1;
      }
    }

    for (const packageNote of plan.notes) {
      const imported = { ...packageNote, id: plan.noteIds.get(packageNote.id), folderId: resolveFolder(packageNote.folderId) };
      // Imported notes start outside trash, so an import never queues anything for deletion.
      delete imported.trashed;
      delete imported.trashedAt;
      if (imported.isDaily && imported.dateStr && dailyDates.has(imported.dateStr)) {
        imported.isDaily = false;
        imported.dateStr = null;
        imported.name = `${imported.name || 'Untitled'} (imported)`;
      }
      noteStore.add(imported);
    }

    const elementStore = tx.objectStore('elements');
    for (const element of plan.elements) {
      elementStore.add(element);
    }
    if (plan.media.length > 0) {
      const mediaStore = tx.objectStore('media');
      for (const row of plan.media) {
        mediaStore.add(row);
      }
    }
  }

  /**
   * Decode a data URL into a Blob without fetch (the extension CSP doesn't allow data: in connect-src).
   * @param {string} dataUrl
   * @returns {Blob}
   */
  _dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    if (comma === -1) throw new Error('malformed data URL in media');
    const meta = dataUrl.slice(5, comma);
    const payload = dataUrl.slice(comma + 1);
    const isBase64 = /;base64$/i.test(meta);
    const type = meta.replace(/;base64$/i, '').split(';')[0] || '';
    if (!isBase64) {
      return new Blob([decodeURIComponent(payload)], { type });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type });
  }

  /**
   * Get all custom themes
   */
  async getCustomThemes() {
    return this._readAux(() => new Promise((resolve, reject) => {
      const store = this.getStore('themes');
      const request = store.index('updatedAt').getAll();
      request.onsuccess = () => {
        resolve(request.result.reverse());
      };
      request.onerror = () => reject(request.error);
    }), []);
  }

  /**
   * Save a custom theme
   */
  async saveCustomTheme(theme) {
    if (!theme.id) theme.id = Utils.generateId();
    theme.updatedAt = Date.now();

    return this.withRetry(() => new Promise((resolve, reject) => {
      const store = this.getStore('themes', 'readwrite');
      const request = store.put(theme);
      request.onsuccess = () => resolve(theme);
      request.onerror = () => reject(request.error);
    }), 'saveCustomTheme');
  }

  /**
   * Delete a custom theme
   */
  async deleteCustomTheme(id) {
    return this.withRetry(() => new Promise((resolve, reject) => {
      const store = this.getStore('themes', 'readwrite');
      const request = store.delete(id);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    }), 'deleteCustomTheme');
  }

  /**
   * Save a vector embedding for a note
   */
  async saveVector(noteId, vector) {
    // Background indexing is skipped while the vectors store is missing.
    if (!this.hasStore('vectors')) return false;
    return this.withRetry(() => new Promise((resolve, reject) => {
      const store = this.getStore('vectors', 'readwrite');
      const request = store.put({ id: noteId, noteId, vector, updatedAt: Date.now() });
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    }), 'saveVector');
  }

  /**
   * Get a vector embedding for a note
   */
  async getVector(noteId) {
    return this._readAux(() => new Promise((resolve, reject) => {
      const store = this.getStore('vectors', 'readonly');
      const request = store.get(noteId);
      request.onsuccess = () => resolve(request.result?.vector || null);
      request.onerror = () => reject(request.error);
    }), null);
  }

  /**
   * Get all vectors
   */
  async getAllVectors() {
    return this._readAux(() => new Promise((resolve, reject) => {
      const store = this.getStore('vectors', 'readonly');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    }), []);
  }
  // ============ Snapshot / Version History Operations ============

  /**
   * Save a version snapshot for a note.
   * @param {string} noteId
   * @param {Array<Object>} blocks - Serialized block data
   * @param {string} title - Note title at snapshot time
   * @returns {Promise<Object>} The saved snapshot
   */
  async saveSnapshot(noteId, blocks, title) {
    const snapshot = {
      id: Utils.generateId(),
      noteId,
      timestamp: Date.now(),
      blocks,
      title,
    };

    await this.withRetry(() => new Promise((resolve, reject) => {
      const store = this.getStore('snapshots', 'readwrite');
      const request = store.put(snapshot);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }), 'saveSnapshot');

    // Prune to max 50 per note
    await this.pruneSnapshots(noteId, 50);

    return snapshot;
  }

  /**
   * Get all snapshots for a note, sorted newest-first.
   * @param {string} noteId
   * @returns {Promise<Array<Object>>}
   */
  async getSnapshots(noteId) {
    return this._readAux(() => new Promise((resolve, reject) => {
      const store = this.getStore('snapshots');
      const index = store.index('noteId');
      const request = index.getAll(noteId);
      request.onsuccess = () => {
        const snapshots = request.result.sort((a, b) => b.timestamp - a.timestamp);
        resolve(snapshots);
      };
      request.onerror = () => reject(request.error);
    }), []);
  }

  /**
   * Delete a single snapshot by ID.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async deleteSnapshot(id) {
    return this.withRetry(() => new Promise((resolve, reject) => {
      const store = this.getStore('snapshots', 'readwrite');
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }), 'deleteSnapshot');
  }

  /**
   * Prune snapshots for a note, keeping only the most recent `maxCount`.
   * @param {string} noteId
   * @param {number} maxCount
   * @returns {Promise<number>} Number of snapshots removed
   */
  async pruneSnapshots(noteId, maxCount) {
    const snapshots = await this.getSnapshots(noteId);
    if (snapshots.length <= maxCount) return 0;

    const toRemove = snapshots.slice(maxCount);
    return this.withRetry(() => new Promise((resolve, reject) => {
      const tx = this.transaction('snapshots', 'readwrite');
      const store = tx.objectStore('snapshots');
      for (const s of toRemove) {
        store.delete(s.id);
      }
      tx.oncomplete = () => resolve(toRemove.length);
      tx.onerror = () => reject(tx.error);
    }), 'pruneSnapshots');
  }

  /**
   * Delete all snapshots for a note.
   * @param {string} noteId
   * @returns {Promise<void>}
   */
  async deleteSnapshotsByNote(noteId) {
    const snapshots = await this.getSnapshots(noteId);
    if (snapshots.length === 0) return;

    return this.withRetry(() => new Promise((resolve, reject) => {
      const tx = this.transaction('snapshots', 'readwrite');
      const store = tx.objectStore('snapshots');
      for (const s of snapshots) {
        store.delete(s.id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }), 'deleteSnapshotsByNote');
  }
}

// Global instance
const Storage = new DatabaseManager();
(typeof window !== 'undefined' ? window : self).Storage = Storage;
