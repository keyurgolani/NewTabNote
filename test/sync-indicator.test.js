// App's sync indicator on #13's typed sync.stateChanged: the event carries no error text, so
// App reads the state, errorMessage included, from SyncService.getState() each time it hears
// one, until #19 replaces both.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createLegacyEnv, createDatabase, FakeDocument, plain } = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/core/dom-refs.js', 'js/core/logger.js', 'js/storage.js',
  'js/search.js', 'js/services/sync-service.js', 'js/app.js'];

describe("App's sync indicator (#13)", () => {
  it('shows what getState() says on each sync.stateChanged, the error text included', async () => {
    const env = createLegacyEnv({ document: new FakeDocument() });
    await createDatabase(env.indexedDB, {});
    env.load(...FILES);
    await env.get('Storage').init();
    const shown = [];
    const app = {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      _updateSyncStatusUI: (state) => shown.push(state),
    };
    await env.get('App').prototype.initSyncService.call(app);
    await app.syncService.sync();
    const last = plain(shown.at(-1));
    assert.equal(last.status, 'error');
    assert.equal(last.errorMessage, 'No sync provider connected');
  });
});
