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
const os = require('node:os');
const { readFixtures, applyEdits, recordSecurityEntry, reportedCodes, liftByteRows, CANARY_NAMES } = require('../scripts/build/verify-fixtures.js');
const { checkSecurityBaseline, firstPartyScripts, SOURCES, CHANGES_FILE } = require('../scripts/build/security-baseline.js');

const ROOT = path.join(__dirname, '..');
const fixtures = readFixtures();

// Codes no fixture can show: a mistyped argument, no npm ci, a zip write that throws, the
// canary, which its own fixture proves absent, a page's preloads, which the bundler writes
// from the graph it built (test/bundler.test.js covers that rule), and security/changes.json's
// history, which npm run check:security-baseline -- --base holds to a git ref, not the build
// (test/security-baseline.test.js covers it)
const NOT_RULES = ['build/usage', 'toolchain/missing-tool', 'package/write', 'env/canary', 'closure/preload', 'security/history'];

describe('test/build-fixtures/', () => {
  it('has a fixture for every build failure rule, and the canary run', () => {
    const covered = new Set(fixtures.flatMap((fixture) => fixture.expect || []));
    const missing = Object.keys(CODES).filter((code) => !NOT_RULES.includes(code) && !covered.has(code));
    assert.deepEqual(missing, [], 'no fixture fails with these codes');
    assert.ok(fixtures.some((fixture) => fixture.kind === 'canary'));
  });

  it("sets the canary under a VITE_ name too, which Vite hands to import.meta.env from the environment even with envDir: false", () => {
    // #99's review: the release's secret names and the common ones, and none Vite reads itself
    assert.ok(CANARY_NAMES.includes('NTN_CANARY_SECRET'));
    assert.ok(CANARY_NAMES.some((name) => name.startsWith('VITE_')), CANARY_NAMES.join(', '));
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

  it("lifts every start byte row in a fixture's copy unless the fixture expects budget/bytes, so a copy's -dirty build id trips no row, and the bytes fixtures keep the real rows (#35 slice 4d)", () => {
    const bytes = fixtures.filter((fixture) => (fixture.expect || []).includes('budget/bytes')).map((fixture) => fixture.name);
    assert.deepEqual(bytes.sort(), ['budget-bytes', 'budget-start-chunk']);
    for (const fixture of fixtures) {
      // The copy's build/budgets.json alone, with the fixture's own edits to it
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-fixture-rows-'));
      try {
        fs.mkdirSync(path.join(dir, 'build'));
        fs.copyFileSync(path.join(ROOT, 'build', 'budgets.json'), path.join(dir, 'build', 'budgets.json'));
        applyEdits(dir, (fixture.edits || []).filter((edit) => edit.file === 'build/budgets.json'));
        const edited = fs.readFileSync(path.join(dir, 'build', 'budgets.json'), 'utf8');
        const lifted = liftByteRows(dir, fixture);
        const text = fs.readFileSync(path.join(dir, 'build', 'budgets.json'), 'utf8');
        if (bytes.includes(fixture.name) || fixture.name === 'budget-file') {
          // A bytes fixture builds against the real rows, and budget-file's file doesn't parse, its rule
          assert.equal(lifted, false, fixture.name);
          assert.equal(text, edited, `${fixture.name} keeps its copy's rows`);
          continue;
        }
        assert.equal(lifted, true, fixture.name);
        const rows = Object.values(JSON.parse(text).entries).flatMap((entry) => Object.values(entry.start || {})).filter(Boolean);
        assert.ok(rows.length >= 3, `${fixture.name}: the pages' rows`);
        for (const row of rows) assert.deepEqual(row, { raw: 2097152, gzip: 1048576 }, fixture.name);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    // The real tree's rows stay as they are
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'budgets.json'), 'utf8')).entries.newtab.start.js, { raw: 668520, gzip: 188943 });
  });

  it("a fixture that sets securityEntry is one for another rule, and its entry records the edited tree", () => {
    const flagged = fixtures.filter((fixture) => fixture.securityEntry);
    assert.ok(flagged.length > 0);
    // A fixture for a security/ rule never gets the entry that would hide it
    assert.deepEqual(fixtures.filter((fixture) => fixture.name.startsWith('security-') && fixture.securityEntry).map((fixture) => fixture.name), []);
    for (const fixture of flagged) {
      assert.equal(fixture.securityEntry, true, fixture.name);
      assert.ok(!(fixture.expect || []).some((code) => code.startsWith('security/')), `${fixture.name} expects a security/ code`);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-security-entry-'));
    try {
      for (const file of ['manifest.json', 'security/destinations.json', 'security/network-ledger.json', 'security/permissions.json', CHANGES_FILE, ...SOURCES]) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
      }
      const fixture = { name: 'an-edit', rule: 'an edit to a source the baseline records' };
      assert.throws(() => recordSecurityEntry(dir, fixture), /change nothing/);
      fs.cpSync(path.join(ROOT, 'js'), path.join(dir, 'js'), { recursive: true });
      applyEdits(dir, [{ file: 'js/offscreen.js', append: '\n// an edit\n' }]);
      const read = (/** @type {string} */ file) => fs.readFileSync(path.join(dir, file), 'utf8');
      const drift = () => checkSecurityBaseline({ manifest: JSON.parse(read('manifest.json')), scripts: firstPartyScripts(dir), read }).map((found) => found.code);
      assert.deepEqual(drift(), ['security/drift']);
      recordSecurityEntry(dir, fixture);
      assert.deepEqual(drift(), []);
      const latest = JSON.parse(read(CHANGES_FILE)).entries.at(-1);
      assert.deepEqual([latest.issue, latest.files], [27, ['js/offscreen.js']]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
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
