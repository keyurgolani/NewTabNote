'use strict';

// #34: a characterization self-test that edits the build's minified code, such as the reopen
// check's edit of tab-controller.js, skips with a reason on a build from elsewhere (NTN_DIST)
// that hasn't got that code, such as a release tag's own build. On this checkout's own build it
// always runs, so an edit that stops matching still fails there (e2e/harness/build-files.js).

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { editSkipReason } = require('../e2e/harness/build-files.js');

const FILE = 'js/controllers/tab-controller.js';
// The reopen check's pattern (e2e/characterization/notes.spec.js)
const PATTERN = /void 0!==(\w+)\.activeTabIndex\?\1\.activeTabIndex:0/;
// The saved tab index as this checkout's build minifies it, and as v1.4.1 reads it
const HEAD = 'const i=void 0!==s.activeTabIndex?s.activeTabIndex:0;';
const RELEASE = 'const i=await t.getSetting("activeTabIndex",0);';

const temps = [];
after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/**
 * A build in a temp dir: `files` maps each path in dist/ to its text, and `modules`, when given,
 * is dist-report/modules.json's map from each source module to the chunks that hold it
 */
function build(files, modules) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-build-files-'));
  temps.push(root);
  const dist = path.join(root, 'dist');
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dist, file)), { recursive: true });
    fs.writeFileSync(path.join(dist, file), text);
  }
  if (modules) {
    fs.writeFileSync(path.join(dist, 'build-info.json'), JSON.stringify({ buildId: 'b1' }));
    fs.mkdirSync(path.join(root, 'dist-report'));
    fs.writeFileSync(path.join(root, 'dist-report', 'modules.json'), JSON.stringify({ buildId: 'b1', modules }));
  }
  return dist;
}

describe("the characterization self-tests' skip (e2e/harness/build-files.js)", () => {
  it("skips, with a reason that names the file, on a build from elsewhere that hasn't got the code the edit replaces", () => {
    const reason = editSkipReason({ dist: build({ [FILE]: RELEASE }), file: FILE, pattern: PATTERN, external: true });
    assert.equal(typeof reason, 'string');
    assert.match(reason, /js\/controllers\/tab-controller\.js/);
  });

  it('runs on a build from elsewhere that has the code, in the file itself or in a chunk that holds it', () => {
    assert.equal(editSkipReason({ dist: build({ [FILE]: HEAD }), file: FILE, pattern: PATTERN, external: true }), null);
    const bundled = build({ 'assets/newtab-A1.js': `a();${HEAD}b();` }, { [FILE]: ['assets/newtab-A1.js'] });
    assert.equal(editSkipReason({ dist: bundled, file: FILE, pattern: PATTERN, external: true }), null);
  });

  it("never skips on this checkout's own build, so an edit that stops matching still fails there", () => {
    assert.equal(editSkipReason({ dist: build({ [FILE]: RELEASE }), file: FILE, pattern: PATTERN, external: false }), null);
  });
});
