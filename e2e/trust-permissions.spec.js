/**
 * #20 slice 2 in Chromium. The permissions and destinations provider: its check, run in an
 * extension page against Chrome's own chrome.permissions.getAll() and the installed manifest,
 * verifies, and the receipt runCheck makes from it is one NewTabNoteTrust's schema takes. The
 * page loads the build's own js/trust/, which ships since slice 1b, and the legacy secret
 * reader leaves no database behind.
 */

const { test, expect, expectNoUncaught } = require('./harness');

/**
 * In the page: the permissions provider's check, run into a receipt against chrome.permissions
 * and the installed manifest
 */
async function checkPermissions() {
  const { comparePermissions, permissions } = await import('/js/trust/core/providers/permissions.js');
  const { runCheck } = await import('/js/trust/core/checks.js');
  const { receiptSchema } = await import('/js/trust/core/records.js');
  const v = await import('/js/lib/valibot/index.mjs');
  const manifest = chrome.runtime.getManifest();
  const run = await runCheck(
    {
      id: 'permissions',
      operation: 'permissions.compare-manifest',
      observes: ['grant-missing', 'permission-changed'],
      costClass: 'local-cheap',
      timeoutMs: 5000,
      freshnessMs: 86_400_000,
      check: context => permissions.check(context),
    },
    {
      context: { permissions: chrome.permissions, manifest },
      clock: { now: () => Date.now() },
      timers: { set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle) },
    },
  );
  const stored = {
    ...run.receipt,
    id: '00000000-0000-4000-8000-000000000001',
    installId: '00000000-0000-4000-8000-000000000002',
    transition: true,
  };
  const granted = await chrome.permissions.getAll();
  return {
    outcome: run.outcome,
    receipt: run.receipt,
    faults: run.faults,
    storable: v.is(receiptSchema, stored),
    granted: (granted.permissions || []).length + (granted.origins || []).length,
    difference: comparePermissions(granted, manifest),
  };
}

test("the permissions provider verifies against Chrome's grants for the installed manifest", async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await extension.openSurface('popup');
  const result = await page.evaluate(checkPermissions);
  expect(result.outcome).toBe('answered');
  expect(result.difference).toMatchObject({ missingApis: [], missingOrigins: [], extraApis: [], extraOrigins: [] });
  expect(result.faults).toEqual([]);
  expect(result.receipt.status).toBe('verified');
  expect(result.receipt.operation).toBe('permissions.compare-manifest');
  expect(result.receipt.evidence.count).toBe(result.granted);
  expect(result.storable).toBe(true);
  await expectNoUncaught(extension, page);
});

/**
 * In the page: with no CanvasTabDB in the profile, the legacy secret reader answers and leaves
 * none behind. It resolves with the database names before and after.
 */
async function readSecretsWithoutDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('CanvasTabDB');
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
  const names = async () => (await indexedDB.databases()).map(database => database.name).sort();
  const before = await names();
  const { createLegacySecretReader } = await import('/js/kernel/adapters/indexeddb/legacy-secrets.js');
  const present = await createLegacySecretReader({ indexedDB, settings: chrome.storage.local }).present();
  return { before, present: [...present], after: await names() };
}

test('the legacy secret reader makes no database in Chromium on a profile without one', async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await extension.openSurface('popup');
  const result = await page.evaluate(readSecretsWithoutDatabase);
  expect(result.before).not.toContain('CanvasTabDB');
  expect(result.present).toEqual([]);
  expect(result.after).toEqual(result.before);
  await expectNoUncaught(extension, page);
});
