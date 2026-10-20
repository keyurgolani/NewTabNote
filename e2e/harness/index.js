/**
 * The `test` and `expect` every spec under e2e/ imports. The `extension` fixture launches
 * the built extension (launchExtension in extension.js) on a fresh profile for each test
 * and closes it afterwards. When the test fails it attaches the session log; the config
 * keeps the trace and a screenshot of every page.
 *
 *   test('...', async ({ extension }) => {
 *     await extension.seedOnboarded();
 *     const page = await extension.openSurface('newtab');
 *   });
 */

const { test: base, expect } = require('@playwright/test');
const { launchExtension, resolveDist, SURFACES, VIEWPORT } = require('./extension');

const test = base.extend({
  extension: async ({ playwright, headless }, use, testInfo) => {
    const extension = await launchExtension({ chromium: playwright.chromium, headless });
    await use(extension);
    try {
      if (testInfo.status !== testInfo.expectedStatus) await extension.attachLog(testInfo);
    } finally {
      await extension.close();
    }
  },
});

module.exports = { test, expect, launchExtension, resolveDist, SURFACES, VIEWPORT };
