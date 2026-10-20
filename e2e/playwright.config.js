const path = require('path');
const { defineConfig } = require('@playwright/test');

/**
 * Packaged-extension tests, run by `npm run test:extension`. They load the build in dist/,
 * or NTN_DIST, and never build it, so run `npm run build` first. Specs are *.spec.js
 * anywhere under e2e/ and import `test` from e2e/harness.
 */
module.exports = defineConfig({
  // Paths here are relative to this file, so '.' is e2e/
  testDir: '.',
  testMatch: '**/*.spec.js',
  outputDir: path.join(__dirname, '..', 'test-results'),
  // A test that passes on its retry is reported as flaky; failing both attempts fails
  retries: process.env.CI ? 1 : 0,
  // Each test starts its own browser; one at a time keeps the legacy UI's timing steady
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  expect: { timeout: 10_000 },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
