'use strict';

// #24 slice 2: npm run test:a11y, on test/a11y/'s own Playwright config, with axe pinned. AC5 asks
// that it run with pinned tools and fail when no test is selected:
// - @axe-core/playwright is 4.14.0, as #24 pins it, and so is the axe-core it runs, each exact in
//   package.json and the lockfile, with one copy of each, from the public registry;
// - test:a11y runs Playwright on test/a11y/playwright.config.js and nothing else, so none of the
//   flags that let a run with no test pass (--pass-with-no-tests, --shard, --only-changed,
//   --test-list) is set, and the config runs the *.spec.js under test/a11y/ one at a time, with no
//   retry, so a finding comes from one attempt;
// - the reporter the config builds reads test/a11y/baseline.json at the path check:a11y-baseline
//   reads, since a wrong one reads as no file, which after the seed is report-only;
// - CI's extension job runs it after test:extension, on the full Chromium build the job installs,
//   and pr-gate's local command for the job runs it too.
// test/toolchain.test.js holds every devDependency to the version the lockfile installs.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const check = require('../scripts/check-a11y-baseline.js');
const read = (/** @type {string} */ file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

describe('test:a11y and its pinned axe (#24 slice 2)', () => {
  it('pins @axe-core/playwright and the axe-core it runs at 4.14.0, one copy each, from the public registry', () => {
    const pkg = read('package.json');
    const lock = read('package-lock.json');
    assert.equal(pkg.devDependencies['@axe-core/playwright'], '4.14.0');
    assert.equal(pkg.devDependencies['axe-core'], '4.14.0');
    const wrapper = lock.packages['node_modules/@axe-core/playwright'];
    assert.equal(wrapper.version, '4.14.0');
    assert.equal(wrapper.dependencies['axe-core'], '~4.14.0');
    assert.equal(lock.packages['node_modules/axe-core'].version, '4.14.0');
    const copies = Object.keys(lock.packages).filter(key => /(^|\/)node_modules\/(axe-core|@axe-core\/playwright)$/.test(key));
    assert.deepEqual(copies.sort(), ['node_modules/@axe-core/playwright', 'node_modules/axe-core']);
    for (const key of copies) {
      assert.equal(lock.packages[key].dev, true, key);
      assert.match(lock.packages[key].resolved, /^https:\/\/registry\.npmjs\.org\//, key);
      assert.match(lock.packages[key].integrity, /^sha512-/, key);
    }
  });

  it('runs on its own config, with no flag that lets a run with no test pass, one spec at a time and no retry', () => {
    assert.equal(read('package.json').scripts['test:a11y'], 'playwright test -c test/a11y/playwright.config.js');
    const config = require('./a11y/playwright.config.js');
    const dir = path.join(ROOT, 'test', 'a11y');
    assert.equal(path.resolve(dir, config.testDir), dir);
    assert.equal(config.testMatch, '**/*.spec.js');
    assert.equal(config.retries, 0);
    assert.equal(config.workers, 1);
    // The baseline reporter is what fails a run on a finding, and a shard lets a run with no test pass
    assert.ok(config.reporter.some((/** @type {unknown[]} */ entry) => entry[0] === './baseline-reporter.js'), 'the baseline reporter');
    assert.equal(config.shard, undefined);
  });

  it('holds a real run to the file check:a11y-baseline reads, with the reporter as the config builds it', () => {
    const config = require('./a11y/playwright.config.js');
    const [name, options] = config.reporter.find((/** @type {unknown[]} */ entry) => entry[0] === './baseline-reporter.js');
    // Playwright resolves a reporter's path against its config's folder, and hands it the entry's options
    const Reporter = require(path.resolve(ROOT, 'test', 'a11y', name));
    // A wrong path in the reporter's default or the config's options reads as no file, which after the
    // seed is report-only, and --base, which reads the file itself, wouldn't notice
    assert.equal(check.baselineIn(), path.join(ROOT, 'test', 'a11y', 'baseline.json'));
    assert.equal(new Reporter(options)._baseline, check.baselineIn());
  });

  it("runs in CI's extension job after test:extension, on the Chromium the job installs, and pr-gate's local command for the job runs it", () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'pr-checks.yml'), 'utf8');
    const job = workflow.slice(workflow.indexOf('\n  extension:\n'), workflow.indexOf('\n  pr-gate:\n'));
    const order = ['run: npm run test:extension 2>&1', 'run: npm run test:a11y 2>&1 | tee -a "$RUNNER_TEMP/job.log"', 'job.log" extension'];
    const at = order.map(step => job.indexOf(step));
    assert.ok(at.every(index => index > 0) && at[0] < at[1] && at[1] < at[2], `the steps are at ${at.join(', ')}`);
    assert.match(workflow, /"extension": "npm run build -- --strict && npm run test:extension && npm run test:a11y"/);
    // The job installs Chromium with --no-shell, the full build the harness runs extensions on
    assert.equal(require('./a11y/playwright.config.js').use.channel, 'chromium');
  });
});
