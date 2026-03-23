const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// Provide minimal globals expected by the module
globalThis.window = globalThis;
globalThis.document = { body: { appendChild() {}, removeChild() {} }, createElement() { return { className: '', setAttribute() {}, appendChild() {}, addEventListener() {}, focus() {}, classList: { add() {}, remove() {}, toggle() {} }, style: {} }; } };
globalThis.Utils = { showToast() {} };
globalThis.confirmDialog = null;
globalThis.btoa = (s) => Buffer.from(s).toString('base64');

const { SyncService, GoogleDriveProvider, DropboxProvider, WebDAVProvider } = require('../js/services/sync-service.js');
const { createEventBus } = require('../js/core/event-bus.js');

function createMockStorage() {
  const settings = new Map();
  return {
    getSetting(key) { return Promise.resolve(settings.get(key) ?? null); },
    setSetting(key, val) { settings.set(key, val); return Promise.resolve(); },
    getStore() {
      return { getAll() { return { result: [], onsuccess: null, onerror: null, set onsuccess(fn) { setTimeout(() => { this.result = []; fn(); }, 0); } }; } };
    },
    exportAll() {
      return Promise.resolve({ version: 1, exportedAt: Date.now(), canvases: [], elements: [], media: [] });
    },
  };
}

function createMockLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

describe('SyncService', () => {
  let service, storage, eventBus, logger;

  beforeEach(() => {
    storage = createMockStorage();
    eventBus = createEventBus();
    logger = createMockLogger();
    service = new SyncService({ storage, eventBus, logger });
  });

  it('initializes with idle state and no provider', async () => {
    await service.init();
    const state = service.getState();
    assert.equal(state.status, 'idle');
    assert.equal(state.provider, null);
    assert.equal(state.lastSyncAt, null);
    assert.equal(state.pendingChanges, 0);
    assert.equal(state.errorMessage, null);
  });

  it('restores saved provider on init', async () => {
    await storage.setSetting('syncProvider', 'webdav');
    await storage.setSetting('syncLastSyncAt', 12345);
    await service.init();
    const state = service.getState();
    assert.equal(state.provider, 'webdav');
    assert.equal(state.lastSyncAt, 12345);
  });

  it('tracks pending changes via note:saved events', async () => {
    await service.init();
    assert.equal(service.getState().pendingChanges, 0);
    eventBus.emit('note:saved', { noteId: 'abc' });
    assert.equal(service.getState().pendingChanges, 1);
    eventBus.emit('note:saved', { noteId: 'def' });
    assert.equal(service.getState().pendingChanges, 2);
  });

  it('disconnect clears state and settings', async () => {
    await service.init();
    // Manually set provider state
    service.state.provider = 'webdav';
    service.activeProvider = service.providers.webdav;
    await service.disconnect();
    const state = service.getState();
    assert.equal(state.provider, null);
    assert.equal(state.status, 'idle');
    assert.equal(state.pendingChanges, 0);
    assert.equal(service.activeProvider, null);
  });

  it('connect throws on unknown provider', async () => {
    await service.init();
    await assert.rejects(() => service.connect('unknown'), /Unknown sync provider/);
  });

  it('sync sets error when no provider connected', async () => {
    await service.init();
    await service.sync();
    assert.equal(service.getState().status, 'error');
    assert.match(service.getState().errorMessage, /No sync provider/);
  });

  it('getState returns a copy', async () => {
    await service.init();
    const s1 = service.getState();
    s1.status = 'syncing';
    assert.equal(service.getState().status, 'idle');
  });

  it('destroy stops auto sync and removes listener', async () => {
    await service.init();
    service.startAutoSync(60000);
    assert.notEqual(service._syncInterval, null);
    service.destroy();
    assert.equal(service._syncInterval, null);
    // Emitting after destroy should not increment
    const before = service.state.pendingChanges;
    eventBus.emit('note:saved', {});
    assert.equal(service.state.pendingChanges, before);
  });

  it('emits sync:stateChanged on disconnect', async () => {
    await service.init();
    service.state.provider = 'webdav';
    service.activeProvider = service.providers.webdav;
    let emitted = false;
    eventBus.on('sync:stateChanged', () => { emitted = true; });
    await service.disconnect();
    assert.ok(emitted);
  });
});

describe('GoogleDriveProvider', () => {
  it('connect sets connected to true', async () => {
    const p = new GoogleDriveProvider();
    await p.connect();
    assert.ok(p.connected);
  });

  it('disconnect resets state', async () => {
    const p = new GoogleDriveProvider();
    await p.connect();
    await p.disconnect();
    assert.equal(p.connected, false);
    assert.equal(p.fileId, null);
  });

  it('upload throws when not connected', async () => {
    const p = new GoogleDriveProvider();
    await assert.rejects(() => p.upload({}), /not connected/);
  });

  it('download returns null (placeholder)', async () => {
    const p = new GoogleDriveProvider();
    await p.connect();
    const result = await p.download();
    assert.equal(result, null);
  });
});

describe('DropboxProvider', () => {
  it('connect sets connected to true', async () => {
    const p = new DropboxProvider();
    await p.connect();
    assert.ok(p.connected);
  });

  it('upload throws when not connected', async () => {
    const p = new DropboxProvider();
    await assert.rejects(() => p.upload({}), /not connected/);
  });

  it('download returns null (placeholder)', async () => {
    const p = new DropboxProvider();
    await p.connect();
    const result = await p.download();
    assert.equal(result, null);
  });
});

describe('WebDAVProvider', () => {
  it('configure sets credentials', () => {
    const p = new WebDAVProvider();
    p.configure({ serverUrl: 'https://dav.example.com/', username: 'user', password: 'pass' });
    assert.equal(p.serverUrl, 'https://dav.example.com');
    assert.equal(p.username, 'user');
    assert.equal(p.password, 'pass');
  });

  it('connect throws without serverUrl', async () => {
    const p = new WebDAVProvider();
    await assert.rejects(() => p.connect(), /server URL is required/);
  });

  it('_authHeaders returns Basic auth header', () => {
    const p = new WebDAVProvider();
    p.username = 'user';
    p.password = 'pass';
    const headers = p._authHeaders();
    const expected = 'Basic ' + Buffer.from('user:pass').toString('base64');
    assert.equal(headers.Authorization, expected);
  });

  it('upload throws when not connected', async () => {
    const p = new WebDAVProvider();
    await assert.rejects(() => p.upload({}), /not connected/);
  });

  it('getLastModified returns null when not connected', async () => {
    const p = new WebDAVProvider();
    const result = await p.getLastModified();
    assert.equal(result, null);
  });
});
