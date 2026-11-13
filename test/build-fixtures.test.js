'use strict';

// The fixtures npm run verify:fixtures builds (test/build-fixtures/, #27 test plan), checked
// without building: each is well formed, its edits still match today's tree, and every build
// failure rule has one. A fixture whose edit stopped matching would fail verify:fixtures
// anyway, but only in CI's fixtures-1 and fixtures-2 jobs, minutes later.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CODES } = require('../scripts/build/diagnostics.js');
const os = require('node:os');
const { readFixtures, applyEdits, recordSecurityEntry, reportedCodes, liftByteRows, outputProblems, CANARY_NAMES, KINDS } = require('../scripts/build/verify-fixtures.js');
const { packageOf } = require('./helpers/source-package.js');
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
      assert.ok(fixture.kind === undefined || KINDS.includes(fixture.kind), fixture.name);
      for (const code of fixture.expect || []) assert.ok(Object.hasOwn(CODES, code), `${fixture.name}: ${code}`);
      for (const mode of fixture.modes || []) assert.ok(['production', 'development'].includes(mode), `${fixture.name}: ${mode}`);
      // An output fixture's build passes, and what it proves is a marker it keeps out of dist/ (#300)
      if (fixture.kind === 'output') assert.ok((fixture.absent || []).length > 0 && !fixture.expect, `${fixture.name} keeps nothing out`);
      else if (fixture.kind !== 'canary') assert.ok((fixture.expect || []).length > 0, `${fixture.name} expects no code`);
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
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'budgets.json'), 'utf8')).entries.newtab.start.js, { raw: 668515, gzip: 188944 });
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

  it("reads an output fixture's dist/: each marker it keeps has to be in a script, page or stylesheet there, and each it keeps out in none (#300)", () => {
    assert.deepEqual(KINDS, ['build', 'package', 'canary', 'output']);
    const files = packageOf({ 'a.js': 'ntn-used', 'b.html': '<p>ntn-page</p>', 'c.css': '.ntn-dropped {}', 'd.png': 'ntn-unused' });
    assert.deepEqual(outputProblems(files, { name: 'x', rule: 'x', present: ['ntn-used', 'ntn-page'], absent: ['ntn-unused'] }), []);
    assert.deepEqual(outputProblems(files, { name: 'x', rule: 'x', present: ['ntn-missing'], absent: ['ntn-dropped'] }), [
      'ntn-missing is in no script, page or stylesheet',
      'ntn-dropped is in c.css',
    ]);
  });

  it('splits the fixtures into shards by name, so n shards hold each fixture exactly once and differ in size by one at most (#29)', () => {
    const { shardOf, parseShard } = require('../scripts/build/verify-fixtures.js');
    const names = fixtures.map(({ name }) => name).sort();
    for (const count of [1, 2, 3]) {
      const shards = Array.from({ length: count }, (_, i) => shardOf(fixtures, { index: i + 1, count }).map(({ name }) => name));
      assert.deepEqual(shards.flat().sort(), names, `${count} shards hold every fixture`);
      assert.equal(new Set(shards.flat()).size, names.length, `${count} shards hold no fixture twice`);
      const sizes = shards.map((shard) => shard.length);
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${count} shards: ${sizes.join(', ')}`);
    }
    // In name order, whatever order it's handed the fixtures in
    assert.deepEqual(shardOf([{ name: 'c' }, { name: 'a' }, { name: 'b' }], { index: 1, count: 2 }), [{ name: 'a' }, { name: 'c' }]);
    assert.deepEqual(parseShard('2/2'), { index: 2, count: 2 });
    for (const text of ['0/2', '3/2', '1/0', '1', '1/2/3', 'a/b', ' 1/2', '-1/2', '']) assert.equal(parseShard(text), null, JSON.stringify(text));
  });

  it("reads its arguments into the run's plan: the fixtures named, or all, and then the shard's of those, so a shard job runs only its own (#29)", () => {
    const { planRun } = require('../scripts/build/verify-fixtures.js');
    const all = ['d', 'a', 'c', 'b'].map((name) => ({ name }));
    const names = (/** @type {any} */ plan) => plan.fixtures.map((/** @type {{name: string}} */ { name }) => name);
    assert.deepEqual(names(planRun([], all, 8)), ['d', 'a', 'c', 'b']);
    assert.deepEqual([names(planRun(['--shard', '1/2'], all, 8)), names(planRun(['--shard', '2/2'], all, 8))], [['a', 'c'], ['b', 'd']]);
    assert.deepEqual(planRun(['--shard', '2/2'], all, 8).shard, { index: 2, count: 2 });
    // The names first, then the shard of them
    assert.deepEqual(names(planRun(['--shard', '2/2', 'a', 'c', 'd'], all, 8)), ['c']);
    assert.deepEqual(names(planRun(['b', '--shard', '2/2'], all, 8)), []);
    assert.deepEqual([planRun([], all, 8), planRun([], all, 2), planRun(['--jobs', '3'], all, 8)].map((plan) => plan.jobs), [4, 2, 3]);
    for (const argv of [['--shard', '3/2'], ['--shard'], ['--jobs', '0'], ['--jobs']]) assert.deepEqual(planRun(argv, all, 8), { usage: true }, argv.join(' '));
    assert.deepEqual(planRun(['a', 'gone'], all, 8), { missing: ['gone'] });
  });

  it("runs the fixtures in CI only in fixtures-1 and fixtures-2, each its own --shard i/2 with 30 minutes and no job to wait on, and leaves the build job no fixtures and 30 minutes (#29)", () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'pr-checks.yml'), 'utf8');
    // Each job's block, by its id: the lines from `  <id>:` to the next job's
    const jobs = Object.fromEntries(workflow.slice(workflow.indexOf('\njobs:\n') + 7).split(/\n(?= {2}[a-z0-9-]+:\n)/).map((block) => [/^ {2}([a-z0-9-]+):/.exec(block)?.[1], block]));
    const shards = /** @type {Record<string, string[]>} */ ({ 'fixtures-1': [' -- --shard 1/2'], 'fixtures-2': [' -- --shard 2/2'] });
    for (const [job, block] of Object.entries(jobs)) {
      const runs = [...block.matchAll(/^ +run: npm run verify:fixtures(.*?) 2>&1/gm)].map((match) => match[1]);
      assert.deepEqual(runs, shards[job] || [], `${job} runs the fixtures it should, and only those`);
    }
    for (const job of ['build', 'fixtures-1', 'fixtures-2']) assert.match(jobs[job] || '', /\n {4}timeout-minutes: 30\n/, `${job} has 30 minutes`);
    for (const job of ['fixtures-1', 'fixtures-2']) assert.doesNotMatch(jobs[job] || '', /\n {4}needs:/, `${job} waits on no job`);
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
