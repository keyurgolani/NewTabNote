'use strict';

// #24 slice 2: npm run test:a11y, on test/a11y/'s own Playwright config, with axe pinned. AC5 asks
// that it run with pinned tools and fail when no test is selected:
// - @axe-core/playwright is 4.14.0, as #24 pins it, and so is the axe-core it runs, each exact in
//   package.json and the lockfile, with one copy of each, from the public registry;
// - test:a11y runs Playwright on test/a11y/playwright.config.js and nothing else, so none of the
//   flags that let a run with no test pass (--pass-with-no-tests, --shard, --only-changed,
//   --test-list) is set, and the config runs the *.spec.js under test/a11y/ one at a time, with no
//   retry, so a finding comes from one attempt.
// test/toolchain.test.js holds every devDependency to the version the lockfile installs.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
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
  });
});
