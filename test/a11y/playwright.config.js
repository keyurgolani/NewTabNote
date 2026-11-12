const path = require('node:path');
const { defineConfig } = require('@playwright/test');

/**
 * #24's accessibility specs, run by `npm run test:a11y` (#24 slice 2): *.spec.js under test/a11y/, each in
 * #34's packaged harness (e2e/harness), which loads the build in dist/, or NTN_DIST, and never builds it.
 * A run that selects no test fails, as Playwright fails one without --pass-with-no-tests.
 * baseline-reporter.js holds what the checks find to test/a11y/baseline.json.
 */
module.exports = defineConfig({
  // Paths here are relative to this file, so '.' is test/a11y/
  testDir: '.',
  testMatch: '**/*.spec.js',
  outputDir: path.join(__dirname, '..', '..', 'test-results', 'a11y'),
  // What the checks find has to come from one attempt, so nothing retries
  retries: 0,
  // Each test starts its own browser, as in e2e/, one at a time
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: [...(process.env.CI ? [['list'], ['github']] : [['list']]), ['./baseline-reporter.js']],
  expect: { timeout: 10_000 },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
