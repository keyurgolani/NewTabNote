/**
 * The chrome.storage.local conformance suite (test/helpers/chrome-storage-suite.js) on
 * Chromium, so the stub every legacy test runs on (test/helpers/legacy-env.js, which
 * test/chrome-storage-conformance.test.js runs the same cases on) is held to the real thing.
 * The two contexts are the extension's service worker and its popup page, open as a tab.
 *
 * The build asks for unlimitedStorage, so no set of it fails. The case that needs one runs on a
 * copy of the build without that permission, where a set over QUOTA_BYTES fails.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, launchExtension, resolveDist } = require('./harness');
const { describeChromeStorageLocal } = require('../test/helpers/chrome-storage-suite');

// Over chrome.storage.local.QUOTA_BYTES, 10 MiB
const OVER_QUOTA_BYTES = 11 * 1024 * 1024;

/** A copy of the build without unlimitedStorage, in a temp dir outside the repo */
function quotaBuild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-e2e-quota-'));
  fs.cpSync(resolveDist(), dir, { recursive: true });
  const file = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.permissions = manifest.permissions.filter(permission => permission !== 'unlimitedStorage');
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

function contextOf(target, name) {
  return { name, evaluate: (step, arg) => target.evaluate(step, arg) };
}

/** A session on `extension`, whose close closes the extension too when `owned` */
async function sessionOn(extension, { owned }) {
  let page;
  try {
    page = await extension.openSurface('popup');
  } catch (error) {
    if (owned) await extension.close();
    throw error;
  }
  return {
    contexts: [contextOf(extension.worker, 'the service worker'), contextOf(page, 'the popup page')],
    async refuseNextSet() {
      return { bytes: OVER_QUOTA_BYTES };
    },
    async close() {
      await (owned ? extension.close() : page.close());
    },
  };
}

/** Launch the quota build: launchExtension loads its own copy, so the temp dir goes at once */
async function launchQuotaBuild(options) {
  const dist = quotaBuild();
  try {
    return await launchExtension({ ...options, dist });
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
}

test.describe('chrome.storage.local in Chromium', () => {
  let shared = null;
  let options = null;

  test.beforeAll(async ({ playwright, headless }) => {
    options = { chromium: playwright.chromium, headless };
    shared = await launchExtension(options);
  });

  test.afterAll(async () => {
    if (shared) await shared.close();
  });

  describeChromeStorageLocal(
    (name, body) => test(name, body),
    {
      open: async ({ quota }) => (quota
        ? sessionOn(await launchQuotaBuild(options), { owned: true })
        : sessionOn(shared, { owned: false })),
    },
  );
});
