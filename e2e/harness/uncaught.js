/**
 * The uncaught-exception check a spec ends with: the startup work a page deferred to an
 * idle callback runs first, then the test fails on any uncaught exception, in a page or
 * the service worker, chrome.* listeners and callbacks included, that no entry in
 * test/known-defects.json lists under `uncaught`.
 *
 *   const { test, expect, expectNoUncaught } = require('./harness');
 *   await expectNoUncaught(extension, page);
 */

const { expect } = require('@playwright/test');
const { toleratedUncaught } = require('./known-defects');

/**
 * @param {{uncaught: () => Promise<Array<{source: string, where?: string, message: string, stack?: string}>>}} extension
 * @param {import('@playwright/test').Page} [page] - Waits for its idle callbacks first
 * @param {Map<string, Array<string>>} [tolerated] - Message -> ids of the ledger entries that list it
 * @returns {Promise<Array<{source: string, where?: string, message: string, stack?: string}>>} Every
 *   uncaught exception so far, the tolerated ones included
 */
async function expectNoUncaught(extension, page, tolerated = toleratedUncaught()) {
  if (page) await page.evaluate(() => new Promise(resolve => requestIdleCallback(() => resolve(), { timeout: 2000 })));
  const uncaught = await extension.uncaught();
  const unexpected = uncaught.filter(({ message }) => !tolerated.has(message));
  expect(
    unexpected.map(({ source, where, message, stack }) => `${source}${where ? ` (${where})` : ''}: ${stack || message}`),
    'uncaught exceptions that no test/known-defects.json entry lists under `uncaught`',
  ).toEqual([]);
  return uncaught;
}

module.exports = { expectNoUncaught };
