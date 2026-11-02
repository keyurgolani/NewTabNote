/**
 * The `Storage` global, the shell of 1.4.x's DatabaseManager the new tab's last holders still
 * call, and nothing more (#17 PR 4b, Q7). It keeps no database and no chrome.storage of its
 * own. The new tab's root connects it to the tab's kernel before App starts
 * (js/kernel/composition/newtab.js, connectNewTabStorage), so each call is a command or a query
 * there (js/kernel/composition/storage-facade.js), and a setting is read or written through the
 * holders' accessor (js/kernel/composition/holder-settings.js).
 *
 * - js/llm.js reads and writes the AI provider's settings, its key among them. LLMService keeps
 *   each key to the provider it was saved for (#21 slice 1a), and this is the one way under it
 *   to where the key is kept.
 * - App's reconnect reads sync's WebDAV config.
 * - NotesManager's index and embeddings, GraphView's notes and links, and sync's upload make
 *   the same calls on the handles the root gives them (LegacyStores).
 *
 * It goes once #11, #19 and #22 move their holders (Q7).
 */

/**
 * What the root connects the shell to (newtab.js): the facade's calls, and the settings of
 * the holders that call the global
 * @typedef {object} StorageShellCalls
 * @property {(name: string) => boolean} hasStore
 * @property {(entries: Array<Object>) => Promise<void>} setSearchIndex
 * @property {(entry: Object) => Promise<void>} setSearchIndexEntry
 * @property {(noteId: string) => Promise<void>} removeSearchIndexEntry
 * @property {() => Promise<Array<Object>>} getAllVectors
 * @property {(noteId: string, vector: Array<number>) => Promise<boolean>} saveVector
 * @property {(includeArchived?: boolean) => Promise<Array<Object>>} getAllNotes
 * @property {() => Promise<Array<Object>>} listLinks
 * @property {() => Promise<Object>} exportAll
 * @property {(key: string, defaultValue?: unknown) => Promise<unknown>} getSetting
 * @property {(key: string, value: unknown) => Promise<void>} setSetting
 */

class DatabaseManager {
  constructor() {
    /** @type {StorageShellCalls | null} What the root connected, none before it did */
    this.connected = null;
  }

  /**
   * Hands every call from here on to `calls`, the tab's kernel's
   * @param {StorageShellCalls} calls
   */
  connect(calls) {
    this.connected = calls;
  }

  /**
   * The connected call `name` with `args`, which rejects before the root connected one
   * @param {string} name
   * @param {Array<unknown>} args
   * @returns {Promise<any>}
   */
  async _call(name, args) {
    const call = this.connected && this.connected[name];
    if (typeof call !== 'function') {
      throw new Error(`NewTabNote's Storage can't ${name} until the new tab connects it`);
    }
    return call(...args);
  }

  /**
   * Whether the database is open with the store `name`, by its IndexedDB name
   * @param {string} name
   * @returns {boolean}
   */
  hasStore(name) {
    const calls = this.connected;
    return Boolean(calls && typeof calls.hasStore === 'function' && calls.hasStore(name));
  }

  /** @param {Array<Object>} entries - the whole search index */
  setSearchIndex(entries) {
    return this._call('setSearchIndex', [entries]);
  }

  /** @param {Object} entry - one note's search entry */
  setSearchIndexEntry(entry) {
    return this._call('setSearchIndexEntry', [entry]);
  }

  /** @param {string} noteId */
  removeSearchIndexEntry(noteId) {
    return this._call('removeSearchIndexEntry', [noteId]);
  }

  getAllVectors() {
    return this._call('getAllVectors', []);
  }

  /**
   * @param {string} noteId
   * @param {Array<number>} vector
   */
  saveVector(noteId, vector) {
    return this._call('saveVector', [noteId, vector]);
  }

  /** @param {boolean} [includeArchived] */
  getAllNotes(includeArchived = false) {
    return this._call('getAllNotes', [includeArchived]);
  }

  listLinks() {
    return this._call('listLinks', []);
  }

  exportAll() {
    return this._call('exportAll', []);
  }

  /**
   * @param {string} key
   * @param {unknown} [defaultValue]
   */
  getSetting(key, defaultValue = null) {
    return this._call('getSetting', [key, defaultValue]);
  }

  /**
   * @param {string} key
   * @param {unknown} value
   */
  setSetting(key, value) {
    return this._call('setSetting', [key, value]);
  }
}

// Global instance
const Storage = new DatabaseManager();
(typeof window !== 'undefined' ? window : self).Storage = Storage;
