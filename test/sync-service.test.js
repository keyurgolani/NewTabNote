const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// Provide minimal globals expected by the module
globalThis.window = globalThis;
globalThis.document = { body: { appendChild() {}, removeChild() {} }, createElement() { return { className: '', setAttribute() {}, appendChild() {}, addEventListener() {}, focus() {}, classList: { add() {}, remove() {}, toggle() {} }, style: {} }; } };
globalThis.Utils = { showToast() {} };
globalThis.confirmDialog = null;
globalThis.btoa = (s) => Buffer.from(s).toString('base64');

const { SyncService, GoogleDriveProvider, DropboxProvider, WebDAVProvider } = require('../js/services/sync-service.js');
const { expectFailure } = require('./helpers/expect-failure');

// Sync's handle as the new tab's root gives it (#17 PR 4b): its settings, and the export, which
// holds every folder
function createMockStorage() {
  const settings = new Map();
  return {
    getSetting(key) { return Promise.resolve(settings.get(key) ?? null); },
    setSetting(key, val) { settings.set(key, val); return Promise.resolve(); },
    exportAll() {
      return Promise.resolve({ version: 1, exportedAt: Date.now(), canvases: [], elements: [], media: [], folders: [] });
    },
  };
}

function createMockLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

describe('SyncService', () => {
  let service, storage, logger;

  beforeEach(() => {
    storage = createMockStorage();
    logger = createMockLogger();
    service = new SyncService({ storage, logger });
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

  it("keeps the WebDAV config before its first call to the server, which the network guard reads the server's origin from (#21 slice 1b)", async (t) => {
    const seen = [];
    t.mock.method(globalThis, 'fetch', async () => {
      const config = await storage.getSetting('syncWebdavConfig');
      seen.push(config && config.serverUrl);
      return { status: 200 };
    });
    await service.connect('webdav', { serverUrl: 'https://dav.example.test', username: 'user', password: 'synthetic-test-value' });
    assert.deepEqual(seen, ['https://dav.example.test']);
    assert.equal(await storage.getSetting('syncProvider'), 'webdav');
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

  it('destroy stops auto sync', async () => {
    await service.init();
    service.startAutoSync(60000);
    assert.notEqual(service._syncInterval, null);
    service.destroy();
    assert.equal(service._syncInterval, null);
  });

  it('applies remote data and tells no one of it, since nothing heard sync:remoteApplied (#13)', async () => {
    const imported = [];
    const quiet = new SyncService({ storage: { ...storage, importAll: async (data) => imported.push(data) }, logger });
    const heard = [];
    quiet.onStateChanged((event) => heard.push(event));
    await quiet._applyRemoteData({ version: 1 });
    assert.deepEqual(imported, [{ version: 1 }]);
    assert.deepEqual(heard, []);
  });

  it('tells sync.stateChanged listeners the state without its error text, which getState() still has until #19 (#13)', async () => {
    await service.init();
    const heard = [];
    service.onStateChanged((event) => heard.push(event));
    await service.sync();
    assert.deepEqual(heard.map((event) => ({ ...event })), [
      { type: 'sync.stateChanged', status: 'error', provider: null, pendingChanges: 0, lastSyncAt: null },
    ]);
    assert.ok(Object.isFrozen(heard[0]));
    assert.match(service.getState().errorMessage, /No sync provider/);
  });

  it('keeps a sync.stateChanged listener that throws from stopping the others, and one that left hears nothing (#13)', async () => {
    const warnings = [];
    const watched = new SyncService({ storage, logger: { ...logger, warn: (...args) => warnings.push(args[1]) } });
    await watched.init();
    const heard = [];
    watched.onStateChanged(() => { throw new Error('a broken listener'); });
    const leave = watched.onStateChanged(() => heard.push('left'));
    watched.onStateChanged((event) => heard.push(event.status));
    leave();
    await watched.sync();
    assert.deepEqual(heard, ['error']);
    assert.equal(warnings.length, 1);
  });

  for (const [name, label] of [['gdrive', 'Google Drive'], ['dropbox', 'Dropbox']]) {
    it(`connect('${name}') rejects with not-implemented and connects nothing`, async () => {
      await service.init();
      const changes = [];
      service.onStateChanged((event) => changes.push(event));
      await assert.rejects(() => service.connect(name), (error) => {
        assert.equal(error.code, 'not-implemented');
        assert.match(error.message, new RegExp(`^${label} sync isn't available yet$`));
        return true;
      });
      assert.equal(service.activeProvider, null);
      assert.equal(service.providers[name].connected, false);
      assert.equal(service.getState().provider, null);
      assert.equal(await storage.getSetting('syncProvider'), null, 'nothing remembers the provider');
      assert.deepEqual(changes, [], 'no state change claims a connection');
      await service.sync();
      assert.equal(service.getState().status, 'error', 'a sync after it has no provider to run on');
    });
  }

  it('tells sync.stateChanged listeners of a disconnect', async () => {
    await service.init();
    service.state.provider = 'webdav';
    service.activeProvider = service.providers.webdav;
    let emitted = false;
    service.onStateChanged(() => { emitted = true; });
    await service.disconnect();
    assert.ok(emitted);
  });
});

describe('GoogleDriveProvider', () => {
  it('connect rejects with not-implemented and leaves it disconnected', async () => {
    const p = new GoogleDriveProvider();
    await assert.rejects(() => p.connect(), { code: 'not-implemented' });
    assert.equal(p.connected, false);
  });

  it('disconnect resets state', async () => {
    const p = new GoogleDriveProvider();
    p.fileId = 'file-1';
    await p.disconnect();
    assert.equal(p.connected, false);
    assert.equal(p.fileId, null);
  });

  it('upload and download throw, since it never connects', async () => {
    const p = new GoogleDriveProvider();
    await assert.rejects(() => p.connect(), { code: 'not-implemented' });
    await assert.rejects(() => p.upload({}), /not connected/);
    await assert.rejects(() => p.download(), /not connected/);
    assert.equal(await p.getLastModified(), null);
  });
});

describe('DropboxProvider', () => {
  it('connect rejects with not-implemented and leaves it disconnected', async () => {
    const p = new DropboxProvider();
    await assert.rejects(() => p.connect(), { code: 'not-implemented' });
    assert.equal(p.connected, false);
  });

  it('upload and download throw, since it never connects', async () => {
    const p = new DropboxProvider();
    await assert.rejects(() => p.connect(), { code: 'not-implemented' });
    await assert.rejects(() => p.upload({}), /not connected/);
    await assert.rejects(() => p.download(), /not connected/);
    assert.equal(await p.getLastModified(), null);
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

  it('connects only once the server takes the credentials: a 401 rejects and leaves it disconnected', async (t) => {
    const statuses = [401, 200];
    t.mock.method(globalThis, 'fetch', async () => ({ status: statuses.shift() }));
    const p = new WebDAVProvider();
    p.configure({ serverUrl: 'https://dav.example.test', username: 'user', password: 'synthetic-test-value' });
    await assert.rejects(() => p.connect(), /^Error: WebDAV connection failed: WebDAV authentication failed$/);
    assert.equal(p.connected, false);
    await p.connect();
    assert.equal(p.connected, true);
  });

  // connect() refuses only a 401, so any other answer counts as connected. #15 slice 4 owns
  // the honest state; #19's real verification is the fix that lands it.
  expectFailure('KD-009 WebDAV connect stays disconnected when the server answers 403, 404, or 500', async (t) => {
    let status = 0;
    t.mock.method(globalThis, 'fetch', async () => ({ status, ok: status >= 200 && status < 300 }));
    for (const answer of [403, 404, 500]) {
      status = answer;
      const p = new WebDAVProvider();
      p.configure({ serverUrl: 'https://dav.example.test', username: 'user', password: 'synthetic-test-value' });
      await assert.rejects(() => p.connect(), /^Error: WebDAV connection failed/, `a ${answer} connects`);
      assert.equal(p.connected, false, `a ${answer} leaves it connected`);
    }
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
