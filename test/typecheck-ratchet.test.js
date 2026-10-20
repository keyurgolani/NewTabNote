const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ratchet = require('../scripts/typecheck-ratchet.js');

// Canned `tsc --pretty false` lines
const NAME_X = "js/a.js(3,5): error TS2304: Cannot find name 'x'.";
const NAME_X_MOVED = "js/a.js(40,9): error TS2304: Cannot find name 'x'.";
const NAME_X_OTHER_FILE = "js/d.js(3,5): error TS2304: Cannot find name 'x'.";
const PROP_Y_1 = "js/b.js(10,1): error TS2339: Property 'y' does not exist on type 'Z'.";
const PROP_Y_2 = "js/b.js(20,1): error TS2339: Property 'y' does not exist on type 'Z'.";
const PROP_Y_3 = "js/b.js(30,1): error TS2339: Property 'y' does not exist on type 'Z'.";
const CHAIN = [
  "js/c.js(1,1): error TS2322: Type 'A' is not assignable to type 'B'.",
  "  Property 'q' is missing in type 'A' but required in type 'B'.",
].join('\n');
const PARAM_E = "js/c.js(7,12): error TS7006: Parameter 'e' implicitly has an 'any' type.";

const TODAY = [NAME_X, PROP_Y_1, PROP_Y_2, CHAIN].join('\n');

describe('typecheck ratchet', () => {
  let dir;
  let baselinePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-ratchet-'));
    baselinePath = path.join(dir, 'ci', 'baselines', 'typecheck.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(args, stdout, { status = stdout ? 2 : 0, stderr = '' } = {}) {
    const lines = [];
    const code = ratchet.main(args, {
      runTsc: () => ({ status, stdout, stderr }),
      baselinePath,
      log: (...parts) => lines.push(parts.join(' ')),
      error: (...parts) => lines.push(parts.join(' ')),
    });
    return { code, output: lines.join('\n') };
  }

  function readBaseline() {
    return JSON.parse(fs.readFileSync(baselinePath, 'utf8')).diagnostics;
  }

  function seed(stdout = TODAY) {
    assert.equal(run(['--init'], stdout).code, 0);
  }

  it('--init writes keys by file, code, and message, with counts, when no baseline exists', () => {
    const { code, output } = run(['--init'], TODAY);
    assert.equal(code, 0);
    assert.match(output, /4 diagnostics under 3 keys/);
    assert.deepEqual(readBaseline(), {
      'js/a.js': { TS2304: { "Cannot find name 'x'.": 1 } },
      'js/b.js': { TS2339: { "Property 'y' does not exist on type 'Z'.": 2 } },
      'js/c.js': {
        TS2322: {
          "Type 'A' is not assignable to type 'B'.\n  Property 'q' is missing in type 'A' but required in type 'B'.": 1,
        },
      },
    });
  });

  it('--init refuses to run when the baseline already exists', () => {
    seed();
    const before = fs.readFileSync(baselinePath);
    let ranTsc = false;
    const code = ratchet.main(['--init'], {
      runTsc: () => { ranTsc = true; return { status: 2, stdout: NAME_X_OTHER_FILE, stderr: '' }; },
      baselinePath,
      log() {},
      error() {},
    });
    assert.equal(code, 1);
    assert.equal(ranTsc, false);
    assert.deepEqual(fs.readFileSync(baselinePath), before);
  });

  it('passes when keys and counts match, even after diagnostics move to other lines', () => {
    seed();
    const moved = [PROP_Y_2, CHAIN, NAME_X_MOVED, PROP_Y_1].join('\n');
    const { code, output } = run([], moved);
    assert.equal(code, 0, output);
    assert.match(output, /OK, 4 diagnostics under 3 keys/);
  });

  it('fails on a new key and prints the diagnostic in full', () => {
    seed();
    const { code, output } = run([], `${TODAY}\n${PARAM_E}`);
    assert.equal(code, 1);
    assert.match(output, /1 new key/);
    assert.ok(output.includes(PARAM_E), output);
  });

  it('fails on a higher count and prints every diagnostic under that key', () => {
    seed();
    const { code, output } = run([], `${TODAY}\n${PROP_Y_3}`);
    assert.equal(code, 1);
    assert.match(output, /3 found, 2 allowed/);
    for (const line of [PROP_Y_1, PROP_Y_2, PROP_Y_3]) assert.ok(output.includes(line), output);
  });

  it('fails on a new diagnostic even when a fix under another key offsets the total', () => {
    seed();
    // Same total of four: one js/b.js diagnostic fixed, the same message added in js/d.js
    const { code, output } = run([], [NAME_X, PROP_Y_1, CHAIN, NAME_X_OTHER_FILE].join('\n'));
    assert.equal(code, 1);
    assert.ok(output.includes(NAME_X_OTHER_FILE), output);
  });

  it('counts a continuation line as part of the message, so a different chain is a new key', () => {
    seed();
    const otherChain = CHAIN.replace("Property 'q'", "Property 'r'");
    const { code, output } = run([], [NAME_X, PROP_Y_1, PROP_Y_2, otherChain].join('\n'));
    assert.equal(code, 1);
    assert.ok(output.includes("  Property 'r' is missing"), output);
  });

  it('fails on a lower count until --update records it', () => {
    seed();
    const fixed = [NAME_X, PROP_Y_1, CHAIN].join('\n');

    const check = run([], fixed);
    assert.equal(check.code, 1);
    assert.match(check.output, /below the baseline count/);
    assert.match(check.output, /npm run typecheck:ratchet -- --update/);

    assert.equal(run(['--update'], fixed).code, 0);
    assert.equal(readBaseline()['js/b.js'].TS2339["Property 'y' does not exist on type 'Z'."], 1);
    assert.equal(run([], fixed).code, 0);
  });

  it('fails on a removed key until --update removes it', () => {
    seed();
    const fixed = [PROP_Y_1, PROP_Y_2, CHAIN].join('\n');
    assert.equal(run([], fixed).code, 1);
    assert.equal(run(['--update'], fixed).code, 0);
    assert.equal(readBaseline()['js/a.js'], undefined);
    assert.equal(run([], fixed).code, 0);
  });

  it('--update exits 1 without writing when any key is new or higher, even beside a fix', () => {
    seed();
    const before = fs.readFileSync(baselinePath);

    const added = run(['--update'], [PROP_Y_1, PROP_Y_2, CHAIN, PARAM_E].join('\n'));
    assert.equal(added.code, 1);
    assert.match(added.output, /was not written/);
    assert.ok(added.output.includes(PARAM_E), added.output);
    assert.deepEqual(fs.readFileSync(baselinePath), before);

    const raised = run(['--update'], [PROP_Y_1, PROP_Y_2, PROP_Y_3, CHAIN].join('\n'));
    assert.equal(raised.code, 1);
    assert.deepEqual(fs.readFileSync(baselinePath), before);
  });

  it('--update with nothing lowered leaves the baseline untouched', () => {
    seed();
    const before = fs.readFileSync(baselinePath);
    const { code, output } = run(['--update'], TODAY);
    assert.equal(code, 0);
    assert.match(output, /nothing to record/);
    assert.deepEqual(fs.readFileSync(baselinePath), before);
  });

  it('fails on a nonzero tsc exit with nothing parseable, in every mode', () => {
    const crash = { status: 1, stderr: 'Error: Debug Failure.' };
    const init = run(['--init'], '', crash);
    assert.equal(init.code, 1);
    assert.match(init.output, /tsc exited 1 with no parseable diagnostics/);
    assert.match(init.output, /Debug Failure/);
    assert.equal(fs.existsSync(baselinePath), false);

    seed();
    const before = fs.readFileSync(baselinePath);
    assert.equal(run([], '', crash).code, 1);
    assert.equal(run(['--update'], '', crash).code, 1);
    assert.equal(run(['--update'], 'Segmentation fault', { status: 139 }).code, 1);
    assert.deepEqual(fs.readFileSync(baselinePath), before);
  });

  it('fails when tsc is killed by a signal, even with partial output', () => {
    seed();
    const before = fs.readFileSync(baselinePath);
    const { code, output } = run(['--update'], NAME_X, { status: null });
    assert.equal(code, 1);
    assert.match(output, /killed by a signal/);
    assert.deepEqual(fs.readFileSync(baselinePath), before);
  });

  it('fails when tsc prints diagnostics but exits with a code it does not use for them', () => {
    seed();
    const before = fs.readFileSync(baselinePath);
    for (const status of [0, 3, 134]) {
      const { code, output } = run(['--update'], [NAME_X, PROP_Y_1, CHAIN].join('\n'), { status });
      assert.equal(code, 1, `status ${status}`);
      assert.match(output, new RegExp(`exited ${status}, not 1 or 2`));
    }
    assert.deepEqual(fs.readFileSync(baselinePath), before);
  });

  it('fails when tsc writes to stderr beside its diagnostics, apart from Node warnings', () => {
    seed();
    const before = fs.readFileSync(baselinePath);
    const crashed = run(['--update'], [NAME_X, PROP_Y_1, CHAIN].join('\n'), { stderr: 'Error: Debug Failure. False expression.\n    at tsc.js:1:1' });
    assert.equal(crashed.code, 1);
    assert.match(crashed.output, /tsc wrote to stderr/);
    assert.match(crashed.output, /Debug Failure/);
    assert.deepEqual(fs.readFileSync(baselinePath), before);

    const warned = run([], TODAY, {
      stderr: '(node:4242) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n(Use `node --trace-deprecation ...` to show where the warning was created)\n',
    });
    assert.equal(warned.code, 0, warned.output);
  });

  it('fails on output lines it cannot parse instead of dropping them', () => {
    seed();
    const { code, output } = run([], `${TODAY}\nsomething tsc never prints`);
    assert.equal(code, 1);
    assert.match(output, /can't parse/);
    assert.ok(output.includes('something tsc never prints'), output);
  });

  it('counts a diagnostic without a file, such as a config error, as a new key', () => {
    seed();
    const configError = "error TS5058: The specified path does not exist: 'jsconfig.json'.";
    const { code, output } = run([], configError, { status: 1 });
    assert.equal(code, 1);
    assert.ok(output.includes(configError), output);
  });

  it('fails when the baseline is missing and points at --init', () => {
    const { code, output } = run([], TODAY);
    assert.equal(code, 1);
    assert.match(output, /--init/);
  });

  it('fails on a malformed baseline', () => {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify({ diagnostics: { 'js/a.js': { TS2304: { "Cannot find name 'x'.": 0 } } } }));
    const { code, output } = run([], TODAY);
    assert.equal(code, 1);
    assert.match(output, /can't read/);
  });

  it('rejects unknown flags and --init with --update', () => {
    assert.equal(run(['--fix'], TODAY).code, 2);
    assert.equal(run(['--init', '--update'], TODAY).code, 2);
  });
});
