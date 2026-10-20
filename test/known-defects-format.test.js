const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LEDGER_PATH, ledgerProblems, loadKnownDefects, toleratedUncaught } = require('../e2e/harness/known-defects.js');

const EVIDENCE = 'https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/app.js#L185-L188';
let nextId = 900;
const entry = (fields = {}) => {
  const id = `KD-${nextId++}`;
  return { id, ownerIssue: 33, evidence: EVIDENCE, tests: [`${id} a step that fails at 1.4.0`], ...fields };
};

test('the committed ledger follows the format', () => {
  assert.ok(Array.isArray(loadKnownDefects(LEDGER_PATH)));
});

test('accepts an entry with tests, and one that only lists uncaught messages', () => {
  assert.deepEqual(ledgerProblems({ about: 'x', defects: [entry(), entry({ tests: [], uncaught: ['boom'] })] }), []);
});

test('names the entry and the rule for each problem', () => {
  const cases = [
    [{ id: 'KD-1' }, 'KD-1: `id` has to be KD- and three digits'],
    [{ ownerIssue: '33' }, '`ownerIssue` has to be an issue number'],
    [{ evidence: 'https://github.com/keyurgolani/NewTabNote/blob/main/js/app.js#L185' }, '`evidence` has to be a GitHub link pinned'],
    [{ evidence: EVIDENCE.replace(/#.*$/, '') }, '`evidence` has to be a GitHub link pinned'],
    [{ tests: ['a title without the id'] }, "test title doesn't carry the id: a title without the id"],
    [{ tests: 'KD-999 not a list' }, '`tests` has to be an array of test titles'],
    [{ tests: [], uncaught: [] }, '`uncaught` has to be a non-empty array'],
    [{ tests: [], uncaught: [42] }, '`uncaught` has to be a non-empty array'],
    [{ tests: [] }, 'lists no tests and no uncaught messages'],
    [{ note: 'x' }, 'unknown key `note`'],
  ];
  for (const [fields, expected] of cases) {
    const problems = ledgerProblems({ defects: [entry(fields)] });
    assert.ok(problems.some(problem => problem.includes(expected)), `${JSON.stringify(fields)}: ${JSON.stringify(problems)}`);
  }
});

test('refuses a reused id, a stray top-level key, and a ledger without a defects array', () => {
  const first = entry();
  assert.deepEqual(ledgerProblems({ defects: [first, { ...first }] }), [`${first.id}: \`id\` is already used by an earlier entry`]);
  assert.deepEqual(ledgerProblems({ defects: [], extra: true }), ['unknown key `extra`']);
  assert.deepEqual(ledgerProblems([]), ['the ledger has to be an object with a `defects` array']);
});

test('loadKnownDefects throws listing every problem', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-known-defects-'));
  try {
    const file = path.join(dir, 'known-defects.json');
    fs.writeFileSync(file, JSON.stringify({ defects: [entry({ ownerIssue: 0 }), entry({ tests: [] })] }));
    assert.throws(() => loadKnownDefects(file), error => {
      assert.match(error.message, /breaks the ledger format/);
      assert.match(error.message, /`ownerIssue` has to be an issue number/);
      assert.match(error.message, /lists no tests and no uncaught messages/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('maps each tolerated message to the entries that list it', () => {
  const a = entry({ tests: [], uncaught: ['first', 'second'] });
  const b = entry({ uncaught: ['first'] });
  assert.deepEqual([...toleratedUncaught([a, b, entry()])], [['first', [a.id, b.id]], ['second', [a.id]]]);
});
