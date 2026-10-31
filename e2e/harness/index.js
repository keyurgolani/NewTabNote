/**
 * The `test` and `expect` every spec under e2e/ imports. The `extension` fixture launches
 * the built extension (launchExtension in extension.js) on a fresh profile for each test
 * and closes it afterwards. When the test fails it attaches the session log; the config
 * keeps the trace and a screenshot of every page. `expectNoUncaught` (uncaught.js) is the
 * uncaught-exception check a spec ends with. `builtFiles` and `chunkFile` (build-files.js)
 * find a source file, or a chunk build-info.json names, in the bundled build.
 *
 *   test('...', async ({ extension }) => {
 *     await extension.seedOnboarded();
 *     const page = await extension.openSurface('newtab');
 *   });
 */

const { test: base, expect } = require('@playwright/test');
const { launchExtension, resolveDist, SURFACES, VIEWPORT } = require('./extension');
const { expectNoUncaught } = require('./uncaught');
const { builtFiles, chunkFile } = require('./build-files');

const test = base.extend({
  // Repository paths the extension copy also gets, at their own paths (launchExtension's
  // sources): a spec sets them with test.use
  extensionSources: [[], { option: true }],
  extension: async ({ playwright, headless, extensionSources }, use, testInfo) => {
    const extension = await launchExtension({ chromium: playwright.chromium, headless, sources: extensionSources });
    await use(extension);
    try {
      if (testInfo.status !== testInfo.expectedStatus) await extension.attachLog(testInfo);
    } finally {
      await extension.close();
    }
  },
});

module.exports = { test, expect, expectNoUncaught, launchExtension, resolveDist, builtFiles, chunkFile, SURFACES, VIEWPORT };
