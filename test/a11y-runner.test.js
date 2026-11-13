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
//   and pr-gate's local command for the job runs it too;
// - until test/a11y/baseline.json lands with its seed, the step passes a run whose page finds
//   something and prints the finding, and fails one whose checks spec fails. Once the file lands,
//   the same finding fails it. Playwright's command line runs specs that start no browser, on
//   test/a11y/'s config with its reporter's file and specs moved to a folder of their own. A test's
//   page is its spec's, even when a helper the spec loads declares it, as the matrix runner does.
// test/toolchain.test.js holds every devDependency to the version the lockfile installs.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli');
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

  it("passes and prints a page's finding before the seed, fails on a failing checks spec, and fails on the finding once the file lands", () => {
    // Playwright places a spec by its real path, and macOS's temporary folder sits behind a link
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-a11y-runner-')));
    try {
      const playwright = JSON.stringify(require.resolve('@playwright/test'));
      // A page's spec, whose test attaches what its checks found, as each page's test does
      fs.writeFileSync(path.join(dir, 'sample.spec.js'), [
        `const { test } = require(${playwright});`,
        "test('sample', async () => {",
        "  await test.info().attach('a11y-findings', { body: JSON.stringify({ findings: [{ rule: 'color-contrast', target: '#faint' }] }), contentType: 'application/json' });",
        '});',
      ].join('\n'));
      fs.mkdirSync(path.join(dir, 'checks'));
      const checks = (/** @type {number} */ value) => fs.writeFileSync(path.join(dir, 'checks', 'checks.spec.js'), [
        `const { test, expect } = require(${playwright});`,
        `test('the check library', () => { expect(${value}).toBe(1); });`,
      ].join('\n'));
      const baseline = path.join(dir, 'baseline.json');
      const reporter = [path.join(ROOT, 'test', 'a11y', 'baseline-reporter.js'), { baseline, specs: dir }];
      fs.writeFileSync(path.join(dir, 'playwright.config.js'), [
        `const config = require(${JSON.stringify(path.join(ROOT, 'test', 'a11y', 'playwright.config.js'))});`,
        `module.exports = { ...config, testDir: ${JSON.stringify(dir)}, outputDir: ${JSON.stringify(path.join(dir, 'results'))},`,
        `  reporter: config.reporter.map(entry => (entry[0] === './baseline-reporter.js' ? ${JSON.stringify(reporter)} : entry)) };`,
      ].join('\n'));
      const run = () => spawnSync(process.execPath, [PLAYWRIGHT_CLI, 'test', '-c', path.join(dir, 'playwright.config.js')], { cwd: dir, encoding: 'utf8' });
      const finding = `sample's color-contrast fails "#faint", which test/a11y/baseline.json doesn't list`;
      const reported = `test:a11y's findings, reported only until test/a11y/baseline.json lands with its seed:\n  ${finding}\n`;

      checks(1);
      const found = run();
      assert.equal(found.status, 0, `before the seed, a page's finding passes:\n${found.stdout}\n${found.stderr}`);
      assert.ok(found.stderr.includes(reported), `and is printed:\n${found.stderr}`);

      checks(2);
      const broken = run();
      assert.equal(broken.status, 1, `a failing checks spec fails the run:\n${broken.stdout}\n${broken.stderr}`);
      assert.ok(broken.stderr.includes(reported) && !broken.stderr.includes("don't match"), `the test fails it, not the finding:\n${broken.stderr}`);

      checks(1);
      fs.writeFileSync(baseline, JSON.stringify({ check: check.CHECK, entries: [] }));
      const seeded = run();
      assert.equal(seeded.status, 1, `once the file lands, the finding fails the run:\n${seeded.stdout}\n${seeded.stderr}`);
      assert.ok(seeded.stderr.includes(`test:a11y's findings don't match test/a11y/baseline.json:\n  ${finding}\n`), seeded.stderr);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes a test's page from its spec's own file, not from a helper the spec loads that declares it", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-a11y-runner-')));
    try {
      fs.writeFileSync(path.join(dir, 'helper.js'), [
        `const { test } = require(${JSON.stringify(require.resolve('@playwright/test'))});`,
        'module.exports = (/** @type {string} */ title) => test(title, async () => {',
        "  await test.info().attach('a11y-findings', { body: JSON.stringify({ findings: [{ rule: 'color-contrast', target: '#faint' }] }), contentType: 'application/json' });",
        '});',
      ].join('\n'));
      fs.writeFileSync(path.join(dir, 'sample.spec.js'), "require('./helper.js')('sample at default');\n");
      const reporter = [path.join(ROOT, 'test', 'a11y', 'baseline-reporter.js'), { baseline: path.join(dir, 'baseline.json'), specs: dir }];
      fs.writeFileSync(path.join(dir, 'playwright.config.js'), `module.exports = ${JSON.stringify({ testDir: dir, outputDir: path.join(dir, 'results'), workers: 1, reporter: [reporter] })};\n`);
      const run = spawnSync(process.execPath, [PLAYWRIGHT_CLI, 'test', '-c', path.join(dir, 'playwright.config.js')], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.ok(run.stderr.includes(`\n  sample's color-contrast fails "#faint", which test/a11y/baseline.json doesn't list\n`), run.stderr);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
