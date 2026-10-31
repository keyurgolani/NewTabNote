/**
 * #20 slice 2's permissions and destinations provider in Chromium: its check, run in an
 * extension page against Chrome's own chrome.permissions.getAll() and the installed manifest,
 * verifies, and the receipt runCheck makes from it is one NewTabNoteTrust's schema takes.
 *
 * No shipped page loads js/trust/ in this slice, and the build doesn't copy it, so this loads
 * a copy of the build with the repository's js/trust/ beside it. Everything else the check
 * imports (#12's kernel core, #15's kit, Valibot) is the build's own.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, expectNoUncaught, launchExtension, resolveDist } = require('./harness');

const REPO_ROOT = path.join(__dirname, '..');

/** A copy of the build with js/trust/ added, in a temp dir outside the repo */
function buildWithTrust() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-e2e-trust-'));
  try {
    fs.cpSync(resolveDist(), dir, { recursive: true });
    fs.cpSync(path.join(REPO_ROOT, 'js', 'trust'), path.join(dir, 'js', 'trust'), { recursive: true });
    return dir;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * In the page: the permissions provider's check, run into a receipt against chrome.permissions
 * and the installed manifest
 */
async function checkPermissions() {
  const { permissions } = await import('/js/trust/core/providers/permissions.js');
  const { runCheck } = await import('/js/trust/core/checks.js');
  const { receiptSchema } = await import('/js/trust/core/records.js');
  const v = await import('/js/lib/valibot/index.mjs');
  const manifest = chrome.runtime.getManifest();
  const run = await runCheck(
    {
      id: 'permissions',
      operation: 'permissions.compare-manifest',
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
    declared: (manifest.permissions || []).length + (manifest.host_permissions || []).length,
    granted: (granted.permissions || []).length + (granted.origins || []).length,
  };
}

test("the permissions provider verifies against Chrome's grants for the installed manifest", async ({ playwright, headless }) => {
  const dist = buildWithTrust();
  let extension;
  try {
    extension = await launchExtension({ chromium: playwright.chromium, headless, dist });
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
  try {
    await extension.seedOnboarded();
    const page = await extension.openSurface('popup');
    const result = await page.evaluate(checkPermissions);
    expect(result.outcome).toBe('answered');
    expect(result.faults).toEqual([]);
    expect(result.receipt.status).toBe('verified');
    expect(result.receipt.operation).toBe('permissions.compare-manifest');
    expect(result.receipt.evidence.count).toBe(result.granted);
    expect(result.granted).toBe(result.declared);
    expect(result.storable).toBe(true);
    await expectNoUncaught(extension, page);
  } finally {
    await extension.close();
  }
});
