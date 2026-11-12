'use strict';

// #24 slice 2: test/a11y/baseline.json, #29's shared accessibility baseline under check ID
// a11y-rules, one line per page and rule with the targets that fail it. AC5 asks that test:a11y fail
// on a violation, on a new or higher entry, and on a drop not lowered in the file:
// - test/a11y/baseline-reporter.js fails a run on a finding no line lists, on a target its line
//   doesn't list, on a listed target that a page that ran no longer fails, and on a test that passed
//   without attaching what its checks found. A page is its spec's path under test/a11y/: a line whose
//   page has no spec fails, and so does a spec that ran without reporting while its page has lines,
//   but a page whose spec the run left out keeps its lines. A line is one page's, and a finding at a
//   gated point counts only against a line with that ownerGate, #16-dark;
// - npm run check:a11y-baseline checks the file's shape and each line's spec, and with --base fails a
//   line or target the base's file lacks, reading the base's own file, passing where the base has
//   none yet, and failing a head that drops a file the base has. The file lands with its seed, and
//   until then there's none, which is no lines. Neither one writes the file;
// - until the seed lands, the reporter reports what the checks find without failing on it, so no CI
//   step goes red on today's known issues. A spec that attaches nothing or garbles it still fails,
//   and so does any failing test.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const check = require('../scripts/check-a11y-baseline.js');
const Reporter = require('./a11y/baseline-reporter.js');

/** @type {string[]} */
const temps = [];
after(() => temps.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-a11y-baseline-'));
  temps.push(dir);
  return dir;
};

/**
 * The reporter over a run of `tests`, each a title, what it attached (null for nothing), its page and
 * its status, against a baseline of `entries`, or `file` as it's written (null for no file), with specs
 * for `specs`
 * @param {object[]} entries
 * @param {[string, object | null, string?, string?][]} tests
 */
function report(entries, tests, { file = { check: 'a11y-rules', entries }, specs = ['legacy-newtab', 'popup'] } = {}) {
  const dir = scratch();
  const baseline = path.join(dir, 'baseline.json');
  if (file !== null) fs.writeFileSync(baseline, JSON.stringify(file));
  for (const page of specs) fs.writeFileSync(path.join(dir, `${page}.spec.js`), '');
  let said = '';
  const reporter = new Reporter({ baseline, specs: dir, write: (/** @type {string} */ text) => (said += text) });
  const run = tests.map(([title, record, page = 'legacy-newtab', status = 'passed']) => ({
    test: { title, location: { file: path.join(dir, `${page}.spec.js`) } },
    result: { status, attachments: record === null ? [] : [{ name: 'a11y-findings', body: Buffer.from(JSON.stringify(record)) }] },
  }));
  reporter.onBegin({}, { allTests: () => run.map(({ test }) => test) });
  for (const { test, result } of run) reporter.onTestEnd(test, result);
  return { failed: reporter.onEnd()?.status === 'failed', said };
}
/** One test on the legacy new tab, with what it found */
const tab = (/** @type {object[]} */ findings) => [['Workspace at 1280', { findings }]];

/**
 * check:a11y-baseline, with what it said
 * @param {string[]} argv
 * @param {Record<string, unknown>} [given] - the root and the git it runs, when a test hands them in
 */
function run(argv, given = {}) {
  /** @type {string[]} */
  const lines = [];
  const say = (/** @type {string} */ line) => lines.push(line);
  const code = check.main(argv, { log: say, error: say, ...given });
  return { code, output: lines.join('\n') };
}

describe("test:a11y's baseline (#24 slice 2)", () => {
  it('has no baseline file until its seed lands with its first lines, and check:a11y-baseline reads none as no lines and writes none', () => {
    const file = path.join(ROOT, check.BASELINE);
    assert.equal(fs.existsSync(file), false, `${check.BASELINE} lands with its seed`);
    const ok = run([]);
    assert.equal(ok.code, 0, ok.output);
    assert.match(ok.output, /check:a11y-baseline: OK, no test\/a11y\/baseline\.json yet, so no lines/);
    for (const flag of ['--write', '--update', '--seed', '--base']) assert.equal(run([flag]).code, 2, flag);
    assert.equal(fs.existsSync(file), false);
    assert.equal(require('../package.json').scripts['check:a11y-baseline'], 'node scripts/check-a11y-baseline.js');
  });

  it('fails a finding no line lists, and a target its line does not list', () => {
    const line = { page: 'legacy-newtab', rule: 'target-size', targets: ['#add'] };
    assert.equal(report([line], tab([{ rule: 'target-size', target: '#add' }])).failed, false);
    const higher = report([line], tab([{ rule: 'target-size', target: '#add' }, { rule: 'target-size', target: '#drag' }]));
    assert.ok(higher.failed);
    assert.match(higher.said, /legacy-newtab's target-size fails "#drag", which test\/a11y\/baseline\.json doesn't list/);
    const violation = report([], tab([{ rule: 'button-name', target: '#menu' }]));
    assert.ok(violation.failed);
    assert.match(violation.said, /legacy-newtab's button-name fails "#menu"/);
    // A line is one page's: popup's #add hides nothing on the legacy tab
    const elsewhere = report([{ page: 'popup', rule: 'target-size', targets: ['#add'] }], tab([{ rule: 'target-size', target: '#add' }]));
    assert.ok(elsewhere.failed);
    assert.match(elsewhere.said, /legacy-newtab's target-size fails "#add", which test\/a11y\/baseline\.json doesn't list/);
  });

  it('fails a listed target a page that ran no longer fails, a line whose page has no spec, and a spec that ran without reporting, and keeps the lines of a spec the run left out', () => {
    const popup = { page: 'popup', rule: 'region', targets: ['main'] };
    const lines = [{ page: 'legacy-newtab', rule: 'target-size', targets: ['#add', '#drag'] }, popup];
    const dropped = report(lines, tab([{ rule: 'target-size', target: '#add' }]));
    assert.ok(dropped.failed);
    assert.match(dropped.said, /legacy-newtab's target-size no longer fails "#drag": lower its line in test\/a11y\/baseline\.json/);
    assert.doesNotMatch(dropped.said, /popup/);
    const lowered = [{ page: 'legacy-newtab', rule: 'target-size', targets: ['#add'] }, popup];
    assert.equal(report(lowered, tab([{ rule: 'target-size', target: '#add' }])).failed, false);
    const skipped = report([popup], [['Popup at 360', null, 'popup', 'skipped']]);
    assert.ok(skipped.failed);
    assert.match(skipped.said, /popup's spec ran, but no test of it reported what its checks found, so its lines go unchecked/);
    const gone = report([popup], [], { specs: [] });
    assert.ok(gone.failed);
    assert.match(gone.said, /popup has lines in test\/a11y\/baseline\.json, but there's no test\/a11y\/popup\.spec\.js to check them/);
  });

  it('counts a finding at a gated point only against a line with that ownerGate', () => {
    const plain = { page: 'legacy-newtab', rule: 'color-contrast', targets: ['.muted'] };
    const gated = { ...plain, ownerGate: '#16-dark' };
    const dark = tab([{ rule: 'color-contrast', target: '.muted', gate: '#16-dark' }]);
    assert.equal(report([gated], dark).failed, false);
    const ungated = report([plain], dark);
    assert.ok(ungated.failed);
    assert.match(ungated.said, /legacy-newtab's color-contrast \(#16-dark\) fails "\.muted"/);
    const light = report([gated], tab([{ rule: 'color-contrast', target: '.muted' }]));
    assert.ok(light.failed);
    assert.match(light.said, /legacy-newtab's color-contrast fails "\.muted", which/);
  });

  it('fails a test that passed without attaching what it found, and a file in the wrong shape', () => {
    const silent = report([], [['Workspace at 1280', null]]);
    assert.ok(silent.failed);
    assert.match(silent.said, /"Workspace at 1280" passed without attaching a11y-findings/);
    const garbled = report([], [['Popup at 360', { findings: [{ rule: 'region' }] }, 'popup']]);
    assert.ok(garbled.failed);
    assert.match(garbled.said, /"Popup at 360" attached a11y-findings that isn't a list of findings, each a rule and a target/);
    const known = check.gates();
    assert.deepEqual([...known], ['#16-dark']);
    const line = { page: 'legacy-newtab', rule: 'region', targets: ['main'] };
    assert.deepEqual(check.fileProblems({ check: 'a11y-rules', entries: [line] }, known), []);
    assert.deepEqual(check.fileProblems({ check: 'axe', entries: [] }, known), ['check is "axe", not "a11y-rules"']);
    const broken = [line, line, { ...line, rule: 'list', targets: [] }, { ...line, rule: 'label', targets: ['a', 'a'] }];
    broken.push({ ...line, rule: 'link-name', ownerGate: '#16-light' }, { ...line, rule: 'tabindex', points: [] });
    assert.deepEqual(check.fileProblems({ check: 'a11y-rules', entries: broken }, known), [
      "entries[1] repeats legacy-newtab's region's line",
      'entries[2] needs a list of targets',
      'entries[3] lists a target twice',
      'entries[4]\'s ownerGate "#16-light" is no gate matrix.json names',
      "entries[5] has points, which a line doesn't take",
    ]);
    const shape = report([], [], { file: { check: 'a11y-rules', entries: [{ page: 'popup', targets: ['main'] }] } });
    assert.ok(shape.failed);
    assert.match(shape.said, /entries\[0\] needs a page and a rule/);
  });

  it("reports what the checks find without failing on it until the baseline's seed lands, and still fails a spec that attaches nothing or garbles it", () => {
    const early = report([], tab([{ rule: 'button-name', target: '#menu' }]), { file: null });
    assert.equal(early.failed, false);
    assert.match(early.said, /test:a11y's findings, reported only until test\/a11y\/baseline\.json lands with its seed:\n {2}legacy-newtab's button-name fails "#menu"/);
    assert.ok(report([], [['Workspace at 1280', null]], { file: null }).failed);
    assert.ok(report([], [['Workspace at 1280', { findings: [{ rule: 'region' }] }]], { file: null }).failed);
    assert.equal(report([], tab([]), { file: null }).said, '');
    // Once the file lands, the same finding fails the run
    assert.ok(report([], tab([{ rule: 'button-name', target: '#menu' }])).failed);
  });

  it("fails a line whose page has no spec, and with --base a line or target the base's file lacks, or a file the base has and the head drops", () => {
    const root = scratch();
    fs.mkdirSync(path.join(root, 'test', 'a11y'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'a11y', 'legacy-newtab.spec.js'), '');
    fs.cpSync(path.join(ROOT, 'docs', 'accessibility', 'matrix.json'), path.join(root, 'docs', 'accessibility', 'matrix.json'));
    const line = { page: 'legacy-newtab', rule: 'target-size', targets: ['#add', '#drag'] };
    const write = (/** @type {object[]} */ entries) => fs.writeFileSync(path.join(root, check.BASELINE), JSON.stringify({ check: 'a11y-rules', entries }));
    write([line]);
    /**
     * A git that answers by ref: `refs` gives each ref's baseline lines, or null where it has no file,
     * and any other ref is one git can't read. HEAD holds the file under check, so a --base that read
     * HEAD's file instead of the base's would pass what the base's fails.
     */
    const at = (/** @type {Record<string, object[] | null>} */ refs) => ({
      root,
      git: (/** @type {string[]} */ args) => {
        const ref = args[0] === 'rev-parse' ? args[3].replace(/\^\{commit\}$/, '') : args[0] === 'ls-tree' ? args[2] : args[1].split(':')[0];
        if (!(ref in refs)) throw new Error(`fatal: Needed a single revision: ${ref}`);
        if (args[0] === 'rev-parse') return `${'a'.repeat(40)}\n`;
        if (args[0] === 'ls-tree') return refs[ref] === null ? '' : `${check.BASELINE}\n`;
        assert.equal(args[1], `${ref}:${check.BASELINE}`);
        return JSON.stringify({ check: 'a11y-rules', entries: refs[ref] });
      },
    });
    const head = [line];
    assert.equal(run(['--base', 'next'], at({ next: [line], HEAD: head })).code, 0);
    assert.equal(run(['--base', 'next'], at({ next: [{ ...line, targets: ['#add', '#drag', '#menu'] }], HEAD: head })).code, 0);
    const higher = run(['--base', 'next'], at({ next: [{ ...line, targets: ['#add'] }], HEAD: head }));
    assert.equal(higher.code, 1, higher.output);
    assert.match(higher.output, /legacy-newtab's target-size lists "#drag", which next's baseline doesn't: the baseline only shrinks/);
    assert.match(run(['--base', 'next'], at({ next: [], HEAD: head })).output, /legacy-newtab's target-size lists "#add", "#drag", which next's baseline/);
    const first = run(['--base', 'next'], at({ next: null, HEAD: head }));
    assert.equal(first.code, 0, first.output);
    assert.match(first.output, /OK, 1 line in test\/a11y\/baseline\.json listing 2 targets; next has no baseline yet/);
    assert.equal(run(['--base', 'next'], at({ HEAD: head })).code, 1);
    // A line's page and its gate are part of it: a target moved to another page, or from a plain line
    // onto a #16-dark one, is new to the base
    const moved = run(['--base', 'next'], at({ next: [{ ...line, page: 'popup' }], HEAD: head }));
    assert.match(moved.output, /legacy-newtab's target-size lists "#add", "#drag", which next's baseline doesn't/);
    const plain = { page: 'legacy-newtab', rule: 'color-contrast', targets: ['.muted'] };
    write([{ ...plain, ownerGate: '#16-dark' }]);
    const gated = run(['--base', 'next'], at({ next: [plain], HEAD: [] }));
    assert.equal(gated.code, 1, gated.output);
    assert.match(gated.output, /legacy-newtab's color-contrast \(#16-dark\) lists "\.muted", which next's baseline doesn't/);
    // Until the seed there's no file, which is no lines; a head that drops a base's file fails
    fs.rmSync(path.join(root, check.BASELINE));
    const none = run(['--base', 'next'], at({ next: null, HEAD: null }));
    assert.equal(none.code, 0, none.output);
    assert.match(none.output, /OK, no test\/a11y\/baseline\.json yet, so no lines; next has no baseline yet/);
    const dropped = run(['--base', 'next'], at({ next: [line], HEAD: null }));
    assert.equal(dropped.code, 1, dropped.output);
    assert.match(dropped.output, /test\/a11y\/baseline\.json is gone, though next has one: empty its lines instead of dropping it/);
    write([line]);
    const popup = { page: 'popup', rule: 'region', targets: ['main'] };
    fs.writeFileSync(path.join(root, check.BASELINE), JSON.stringify({ check: 'a11y-rules', entries: [line, popup] }));
    const unchecked = run([], { root });
    assert.equal(unchecked.code, 1, unchecked.output);
    assert.match(unchecked.output, /popup has lines in test\/a11y\/baseline\.json, but there's no test\/a11y\/popup\.spec\.js to check them/);
  });
});
