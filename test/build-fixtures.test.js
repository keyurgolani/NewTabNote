'use strict';

// The fixtures npm run verify:fixtures builds (test/build-fixtures/, #27 test plan), checked
// without building: each is well formed, its edits still match today's tree, and every build
// failure rule has one. A fixture whose edit stopped matching would fail verify:fixtures
// anyway, but only in the build job, minutes later.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CODES } = require('../scripts/build/diagnostics.js');
const { readFixtures, reportedCodes } = require('../scripts/build/verify-fixtures.js');

const ROOT = path.join(__dirname, '..');
const fixtures = readFixtures();

// Codes no fixture can show: a mistyped argument, no npm ci, a zip write that throws, and
// the canary, which its own fixture proves absent
const NOT_RULES = ['build/usage', 'toolchain/missing-tool', 'package/write', 'env/canary'];

describe('test/build-fixtures/', () => {
  it('has a fixture for every build failure rule, and the canary run', () => {
    const covered = new Set(fixtures.flatMap((fixture) => fixture.expect || []));
    const missing = Object.keys(CODES).filter((code) => !NOT_RULES.includes(code) && !covered.has(code));
    assert.deepEqual(missing, [], 'no fixture fails with these codes');
    assert.ok(fixtures.some((fixture) => fixture.kind === 'canary'));
  });

  it('gives each fixture a rule, known codes, and a kind and modes the runner knows', () => {
    for (const fixture of fixtures) {
      assert.ok(typeof fixture.rule === 'string' && fixture.rule.length > 10, fixture.name);
      assert.ok([undefined, 'build', 'package', 'canary'].includes(fixture.kind), fixture.name);
      for (const code of fixture.expect || []) assert.ok(Object.hasOwn(CODES, code), `${fixture.name}: ${code}`);
      for (const mode of fixture.modes || []) assert.ok(['production', 'development'].includes(mode), `${fixture.name}: ${mode}`);
      if (fixture.kind !== 'canary') assert.ok((fixture.expect || []).length > 0, `${fixture.name} expects no code`);
    }
  });

  it('each edit still matches today\'s tree: every replaced text occurs once, and every removed path exists', () => {
    for (const fixture of fixtures) {
      for (const edit of fixture.edits || []) {
        if (edit.remove !== undefined) {
          assert.ok(fs.existsSync(path.join(ROOT, edit.remove)), `${fixture.name}: there's no ${edit.remove}`);
          continue;
        }
        if (edit.replace === undefined) continue;
        const text = fs.readFileSync(path.join(ROOT, edit.file), 'utf8');
        assert.equal(text.split(edit.replace).length, 2, `${fixture.name}: ${edit.file} doesn't hold ${JSON.stringify(edit.replace)} exactly once`);
      }
    }
  });

  it('reads the codes a build or package run reported from its problem lines', () => {
    const run = {
      status: 1,
      stdout: '',
      stderr: [
        '  ✗ [build/terser] js/a.js: refused',
        '',
        '✗ Build failed: 2 problems. No dist/ was written.',
        '   [build/terser] js/a.js: refused',
        '   [closure/missing] js/w.js: new Worker()',
        '      a detail line [not/a-code] here',
      ].join('\n'),
    };
    assert.deepEqual(reportedCodes(run), ['build/terser', 'closure/missing']);
  });
});
