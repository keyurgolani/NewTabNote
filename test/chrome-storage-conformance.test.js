'use strict';

// The chrome.storage.local conformance suite (helpers/chrome-storage-suite.js) on the stub in
// helpers/legacy-env.js, the one every legacy test runs on. e2e/chrome-storage.spec.js runs the
// same cases on Chromium. The two contexts are a worker and a page sharing one stub, as the
// service worker and a page of the extension share chrome.storage.local.

const { it } = require('node:test');
const vm = require('node:vm');

const { createChromeStub, createLegacyEnv } = require('./helpers/legacy-env');
const { describeChromeStorageLocal, QUOTA_MESSAGE } = require('./helpers/chrome-storage-suite');

/** A context of `env`: evaluate runs the step's source there, and only JSON crosses, as with Playwright */
function contextOf(env, name) {
  return {
    name,
    async evaluate(step, arg) {
      const run = vm.runInContext(`(${step})`, env.context);
      const result = await run(arg === undefined ? undefined : JSON.parse(JSON.stringify(arg)));
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    },
  };
}

describeChromeStorageLocal(it, {
  async open() {
    const chrome = createChromeStub();
    const worker = createLegacyEnv({ context: 'worker', chrome });
    const page = createLegacyEnv({ chrome, document: null });
    return {
      contexts: [contextOf(worker, 'the worker'), contextOf(page, 'a page')],
      async refuseNextSet() {
        chrome.failNextSet(new Error(QUOTA_MESSAGE));
        return { bytes: 16 };
      },
      async close() {},
    };
  },
});
