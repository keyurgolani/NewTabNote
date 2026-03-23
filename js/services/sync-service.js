/**
 * SyncService — Cross-device sync via Google Drive, Dropbox, or WebDAV.
 *
 * Provides provider abstraction, background sync, conflict resolution,
 * and sync status tracking. OAuth flows for Google Drive and Dropbox
 * are placeholder implementations (require API keys and redirect URIs).
 * WebDAV uses basic auth and is more fully implemented.
 *
 * @typedef {'idle'|'syncing'|'error'} SyncStatus
 * @typedef {'gdrive'|'dropbox'|'webdav'} SyncProvider
 *
 * @typedef {Object} SyncState
 * @property {SyncStatus} status
 * @property {number|null} lastSyncAt
 * @property {number} pendingChanges
 * @property {SyncProvider|null} provider
 * @property {string|null} errorMessage
 *
 * @typedef {Object} SyncProviderInterface
 * @property {function(): Promise<void>} connect
 * @property {function(): Promise<void>} disconnect
 * @property {function(Object): Promise<void>} upload
 * @property {function(): Promise<Object|null>} download
 * @property {function(): Promise<number|null>} getLastModified
 */

/**
 * Base class for sync providers.
 */
class BaseSyncProvider {
  constructor() {
    this.connected = false;
  }
  /** @returns {Promise<void>} */
  async connect() { throw new Error('Not implemented'); }
  /** @returns {Promise<void>} */
  async disconnect() { this.connected = false; }
  /** @param {Object} data @returns {Promise<void>} */
  async upload(data) { throw new Error('Not implemented'); }
  /** @returns {Promise<Object|null>} */
  async download() { throw new Error('Not implemented'); }
  /** @returns {Promise<number|null>} */
  async getLastModified() { throw new Error('Not implemented'); }
}

/**
 * Google Drive sync provider (placeholder — requires OAuth client ID).
 */
class GoogleDriveProvider extends BaseSyncProvider {
  constructor() {
    super();
    this.fileName = 'newtabnote-sync.json';
    this.fileId = null;
  }

  async connect() {
    // Placeholder: In production, this would initiate OAuth2 flow via
    // chrome.identity.launchWebAuthFlow with a registered client ID.
    if (typeof Utils !== 'undefined') {
      Utils.showToast('Google Drive sync requires OAuth configuration. See extension settings for setup instructions.', 'info', 5000);
    }
    this.connected = true;
  }

  async disconnect() {
    this.fileId = null;
    this.connected = false;
  }

  async upload(data) {
    if (!this.connected) throw new Error('Google Drive not connected');
    // Placeholder: Would use Google Drive API v3 to upload/update file
    console.debug('[SyncService] Google Drive upload placeholder', { size: JSON.stringify(data).length });
  }

  async download() {
    if (!this.connected) throw new Error('Google Drive not connected');
    // Placeholder: Would use Google Drive API v3 to download file
    console.debug('[SyncService] Google Drive download placeholder');
    return null;
  }

  async getLastModified() {
    if (!this.connected) return null;
    // Placeholder: Would query file metadata for modifiedTime
    return null;
  }
}

/**
 * Dropbox sync provider (placeholder — requires OAuth app key).
 */
class DropboxProvider extends BaseSyncProvider {
  constructor() {
    super();
    this.filePath = '/newtabnote-sync.json';
  }

  async connect() {
    // Placeholder: In production, this would initiate OAuth2 PKCE flow
    // via chrome.identity.launchWebAuthFlow with a registered app key.
    if (typeof Utils !== 'undefined') {
      Utils.showToast('Dropbox sync requires OAuth configuration. See extension settings for setup instructions.', 'info', 5000);
    }
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
  }

  async upload(data) {
    if (!this.connected) throw new Error('Dropbox not connected');
    // Placeholder: Would use Dropbox API v2 files/upload endpoint
    console.debug('[SyncService] Dropbox upload placeholder', { size: JSON.stringify(data).length });
  }

  async download() {
    if (!this.connected) throw new Error('Dropbox not connected');
    // Placeholder: Would use Dropbox API v2 files/download endpoint
    console.debug('[SyncService] Dropbox download placeholder');
    return null;
  }

  async getLastModified() {
    if (!this.connected) return null;
    // Placeholder: Would query file metadata for server_modified
    return null;
  }
}

/**
 * WebDAV sync provider — more fully implemented since it uses basic auth.
 */
class WebDAVProvider extends BaseSyncProvider {
  constructor() {
    super();
    this.serverUrl = '';
    this.username = '';
    this.password = '';
    this.filePath = '/newtabnote-sync.json';
  }

  /**
   * Configure WebDAV connection.
   * @param {{ serverUrl: string, username: string, password: string }} config
   */
  configure(config) {
    this.serverUrl = (config.serverUrl || '').replace(/\/+$/, '');
    this.username = config.username || '';
    this.password = config.password || '';
  }

  async connect() {
    if (!this.serverUrl) throw new Error('WebDAV server URL is required');
    try {
      const response = await fetch(this.serverUrl + this.filePath, {
        method: 'OPTIONS',
        headers: this._authHeaders(),
      });
      if (response.status === 401) throw new Error('WebDAV authentication failed');
      this.connected = true;
    } catch (err) {
      this.connected = false;
      throw new Error('WebDAV connection failed: ' + err.message);
    }
  }

  async disconnect() {
    this.connected = false;
  }

  async upload(data) {
    if (!this.connected) throw new Error('WebDAV not connected');
    const body = JSON.stringify(data);
    const response = await fetch(this.serverUrl + this.filePath, {
      method: 'PUT',
      headers: { ...this._authHeaders(), 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) throw new Error('WebDAV upload failed: ' + response.status);
  }

  async download() {
    if (!this.connected) throw new Error('WebDAV not connected');
    const response = await fetch(this.serverUrl + this.filePath, {
      method: 'GET',
      headers: this._authHeaders(),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('WebDAV download failed: ' + response.status);
    return response.json();
  }

  async getLastModified() {
    if (!this.connected) return null;
    try {
      const response = await fetch(this.serverUrl + this.filePath, {
        method: 'HEAD',
        headers: this._authHeaders(),
      });
      if (!response.ok) return null;
      const lastMod = response.headers.get('Last-Modified');
      return lastMod ? new Date(lastMod).getTime() : null;
    } catch {
      return null;
    }
  }

  /** @returns {Object} */
  _authHeaders() {
    const encoded = typeof btoa === 'function'
      ? btoa(this.username + ':' + this.password)
      : Buffer.from(this.username + ':' + this.password).toString('base64');
    return { 'Authorization': 'Basic ' + encoded };
  }
}

/**
 * SyncService — orchestrates cross-device sync with provider abstraction.
 *
 * @param {Object} deps
 * @param {DatabaseManager} deps.storage
 * @param {EventBus} deps.eventBus
 * @param {Logger} deps.logger
 */
class SyncService {
  constructor({ storage, eventBus, logger }) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.logger = logger;

    /** @type {SyncState} */
    this.state = {
      status: 'idle',
      lastSyncAt: null,
      pendingChanges: 0,
      provider: null,
      errorMessage: null,
    };

    /** @type {BaseSyncProvider|null} */
    this.activeProvider = null;

    /** @type {Object<string, BaseSyncProvider>} */
    this.providers = {
      gdrive: new GoogleDriveProvider(),
      dropbox: new DropboxProvider(),
      webdav: new WebDAVProvider(),
    };

    this._syncInterval = null;
    this._pendingTracker = null;
  }

  /** Initialize the sync service, restoring saved state. */
  async init() {
    const savedProvider = await this.storage.getSetting('syncProvider');
    const savedLastSync = await this.storage.getSetting('syncLastSyncAt');
    if (savedProvider && this.providers[savedProvider]) {
      this.state.provider = savedProvider;
      this.state.lastSyncAt = savedLastSync || null;
    }

    // Track pending changes via note:saved events
    this._pendingTracker = () => {
      this.state.pendingChanges++;
      this._emitStateChange();
    };
    this.eventBus.on('note:saved', this._pendingTracker);
  }

  /** Tear down intervals and listeners. */
  destroy() {
    this.stopAutoSync();
    if (this._pendingTracker) {
      this.eventBus.off('note:saved', this._pendingTracker);
    }
  }

  /**
   * Connect to the specified provider.
   * @param {SyncProvider} providerName
   * @param {Object} [config] - Provider-specific config (e.g. WebDAV credentials)
   */
  async connect(providerName, config) {
    const provider = this.providers[providerName];
    if (!provider) throw new Error('Unknown sync provider: ' + providerName);

    if (providerName === 'webdav' && config) {
      /** @type {WebDAVProvider} */ (provider).configure(config);
    }

    await provider.connect();
    this.activeProvider = provider;
    this.state.provider = providerName;
    this.state.status = 'idle';
    this.state.errorMessage = null;

    await this.storage.setSetting('syncProvider', providerName);
    if (providerName === 'webdav' && config) {
      await this.storage.setSetting('syncWebdavConfig', {
        serverUrl: config.serverUrl,
        username: config.username,
        // Note: password stored in IndexedDB — same security model as API keys
        password: config.password,
      });
    }

    this._emitStateChange();
    this.logger.info('SyncService', 'Connected to ' + providerName);
  }

  /** Disconnect from the current provider. */
  async disconnect() {
    if (this.activeProvider) {
      await this.activeProvider.disconnect();
    }
    this.stopAutoSync();
    this.activeProvider = null;
    this.state.provider = null;
    this.state.status = 'idle';
    this.state.errorMessage = null;
    this.state.pendingChanges = 0;

    await this.storage.setSetting('syncProvider', null);
    await this.storage.setSetting('syncWebdavConfig', null);
    await this.storage.setSetting('syncLastSyncAt', null);

    this._emitStateChange();
    this.logger.info('SyncService', 'Disconnected from sync provider');
  }

  /**
   * Export local data as a sync-ready JSON payload.
   * @returns {Promise<Object>}
   */
  async _exportLocalData() {
    const exportData = await this.storage.exportAll();
    // Augment with folders and settings for full sync
    const folders = await this._getAllFromStore('folders');
    const settings = await this._getAllFromStore('settings');
    return {
      ...exportData,
      folders,
      settings,
      syncVersion: 1,
      syncedAt: Date.now(),
    };
  }

  /**
   * Read all entries from an IndexedDB store.
   * @param {string} storeName
   * @returns {Promise<Array>}
   */
  async _getAllFromStore(storeName) {
    return new Promise((resolve, reject) => {
      try {
        const store = this.storage.getStore(storeName);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      } catch (e) {
        resolve([]);
      }
    });
  }

  /**
   * Perform a sync operation: export local → compare with remote → resolve conflicts → apply.
   * Runs in the background without blocking UI.
   * @returns {Promise<void>}
   */
  async sync() {
    if (!this.activeProvider || !this.activeProvider.connected) {
      this.state.errorMessage = 'No sync provider connected';
      this.state.status = 'error';
      this._emitStateChange();
      return;
    }

    if (this.state.status === 'syncing') return; // Already syncing

    this.state.status = 'syncing';
    this.state.errorMessage = null;
    this._emitStateChange();

    try {
      const localData = await this._exportLocalData();
      const remoteData = await this.activeProvider.download();

      if (!remoteData) {
        // No remote data — first sync, just upload
        await this.activeProvider.upload(localData);
      } else {
        // Compare timestamps to detect conflicts
        const localTime = localData.exportedAt || 0;
        const remoteTime = remoteData.syncedAt || remoteData.exportedAt || 0;

        if (this.state.pendingChanges > 0 && remoteTime > (this.state.lastSyncAt || 0)) {
          // Conflict: both local and remote have changes since last sync
          const resolution = await this._resolveConflict();
          await this._applyResolution(resolution, localData, remoteData);
        } else if (this.state.pendingChanges > 0) {
          // Only local changes — upload
          await this.activeProvider.upload(localData);
        } else if (remoteTime > (this.state.lastSyncAt || 0)) {
          // Only remote changes — download and apply
          await this._applyRemoteData(remoteData);
        }
        // else: no changes on either side
      }

      this.state.lastSyncAt = Date.now();
      this.state.pendingChanges = 0;
      this.state.status = 'idle';
      this.state.errorMessage = null;
      await this.storage.setSetting('syncLastSyncAt', this.state.lastSyncAt);
      this.logger.info('SyncService', 'Sync completed successfully');
    } catch (err) {
      this.state.status = 'error';
      this.state.errorMessage = err.message || 'Sync failed';
      this.logger.error('SyncService', 'Sync failed', err);
    }

    this._emitStateChange();
  }

  /**
   * Show conflict resolution dialog.
   * @returns {Promise<'local'|'remote'|'both'>}
   */
  async _resolveConflict() {
    if (typeof confirmDialog === 'undefined' && typeof window !== 'undefined' && window.confirmDialog) {
      // Use window reference
    }

    const resolveDialog = typeof confirmDialog === 'function' ? confirmDialog : (typeof window !== 'undefined' ? window.confirmDialog : null);

    if (!resolveDialog) {
      // Fallback: keep local if no dialog available
      return 'local';
    }

    // Show three-option conflict dialog using sequential confirmDialog calls
    const keepRemote = await resolveDialog({
      title: 'Sync Conflict Detected',
      message: 'This note was modified on another device. How would you like to resolve the conflict?',
      confirmText: 'Keep Remote',
      cancelText: 'More Options...',
    });

    if (keepRemote) return 'remote';

    const keepBoth = await resolveDialog({
      title: 'Sync Conflict — More Options',
      message: 'Choose how to handle the conflict:',
      confirmText: 'Keep Both',
      cancelText: 'Keep Local',
    });

    return keepBoth ? 'both' : 'local';
  }

  /**
   * Apply conflict resolution.
   * @param {'local'|'remote'|'both'} resolution
   * @param {Object} localData
   * @param {Object} remoteData
   */
  async _applyResolution(resolution, localData, remoteData) {
    switch (resolution) {
      case 'local':
        await this.activeProvider.upload(localData);
        break;
      case 'remote':
        await this._applyRemoteData(remoteData);
        // Re-export after applying remote to keep remote in sync
        const freshData = await this._exportLocalData();
        await this.activeProvider.upload(freshData);
        break;
      case 'both': {
        // Merge: upload local, but keep remote notes that don't exist locally
        const localNoteIds = new Set((localData.canvases || []).map(n => n.id));
        const remoteOnly = (remoteData.canvases || []).filter(n => !localNoteIds.has(n.id));
        if (remoteOnly.length > 0) {
          // Import remote-only notes
          for (const note of remoteOnly) {
            await this.storage.importNote(note);
          }
          const remoteElements = (remoteData.elements || []).filter(
            e => remoteOnly.some(n => n.id === e.canvasId)
          );
          for (const el of remoteElements) {
            await this.storage.saveElement(el);
          }
        }
        const mergedData = await this._exportLocalData();
        await this.activeProvider.upload(mergedData);
        break;
      }
    }
  }

  /**
   * Apply remote data to local storage (import).
   * @param {Object} remoteData
   */
  async _applyRemoteData(remoteData) {
    if (!remoteData) return;
    // Use storage's import mechanism if available, otherwise manual import
    if (typeof this.storage.importAll === 'function') {
      await this.storage.importAll(remoteData);
    } else {
      this.logger.warn('SyncService', 'storage.importAll not available, skipping remote data apply');
    }
    this.eventBus.emit('sync:remoteApplied', {});
  }

  /**
   * Start automatic background sync on an interval.
   * @param {number} [intervalMs=300000] - Sync interval in ms (default 5 min)
   */
  startAutoSync(intervalMs = 300000) {
    this.stopAutoSync();
    this._syncInterval = setInterval(() => this.sync(), intervalMs);
    this.logger.debug('SyncService', 'Auto-sync started, interval: ' + intervalMs + 'ms');
  }

  /** Stop automatic background sync. */
  stopAutoSync() {
    if (this._syncInterval) {
      clearInterval(this._syncInterval);
      this._syncInterval = null;
    }
  }

  /** Emit sync state change event. */
  _emitStateChange() {
    this.eventBus.emit('sync:stateChanged', { ...this.state });
  }

  /** @returns {SyncState} Current sync state (copy). */
  getState() {
    return { ...this.state };
  }
}

// Dual CommonJS/browser export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SyncService, BaseSyncProvider, GoogleDriveProvider, DropboxProvider, WebDAVProvider };
} else if (typeof window !== 'undefined') {
  window.SyncService = SyncService;
}
