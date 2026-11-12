'use strict';

// #26 slice 1: npm run check:states. On the repository it passes with the seeded baseline, which
// lists all 11 states for each contribution, since nothing has rows yet (call 2). On a copy it fails
// on a missing row the baseline doesn't list, on a written row it still lists, on an entry for a
// contribution or a state that doesn't exist, and on a row whose message has no catalog string or
// whose primary action is off the list. A run leaves the baseline's bytes as they were, and a flag
// it doesn't know, a write flag among them, exits 2.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const check = require('../scripts/check-states.js');

/** @type {any} */
let words;
before(async () => {
  words = await import('../js/states/core/vocabulary.js');
});

/** @type {string[]} */
const temps = [];
after(() => temps.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

/**
 * check:states on `root`, with what it said
 * @param {string[]} argv
 */
async function run(argv, root = ROOT) {
  /** @type {string[]} */
  const lines = [];
  const code = await check.main(argv, { root, log: (/** @type {string} */ line) => lines.push(line), error: (/** @type {string} */ line) => lines.push(line) });
  return { code, output: lines.join('\n') };
}

/** A copy of js/ and the baseline to change, fresh each time, since a module loads once per path */
function copy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-check-states-'));
  temps.push(root);
  fs.cpSync(path.join(ROOT, 'js'), path.join(root, 'js'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ci', 'baselines'), { recursive: true });
  fs.cpSync(path.join(ROOT, check.BASELINE), path.join(root, check.BASELINE));
  return root;
}
const baselineOf = (root = ROOT) => JSON.parse(fs.readFileSync(path.join(root, check.BASELINE), 'utf8'));
/**
 * The copy's baseline, with `subject`'s entry changed by `change`
 * @param {string} root
 * @param {string} subject
 * @param {(states: string[]) => string[]} change
 */
const listing = (root, subject, change) => {
  const baseline = baselineOf(root);
  baseline.missing[subject] = change(baseline.missing[subject] ?? []);
  fs.writeFileSync(path.join(root, check.BASELINE), JSON.stringify(baseline));
};
/** Rows the copy registers, as owners will in js/states/rows.js */
const registering = (/** @type {string} */ root, /** @type {unknown[]} */ rows) =>
  fs.writeFileSync(path.join(root, 'js/states/rows.js'), `export const ROWS = Object.freeze(${JSON.stringify(rows)});\n`);

const ROW = {
  messageKey: 'state.failed.headline',
  dataChanged: 'none',
  preserved: ['capture'],
  primaryAction: 'retry',
  politeness: 'assertive',
  placement: 'inline',
  atomicity: 'atomic',
  staleness: 'none',
};
/** create-note's matrix descriptor, with `states` */
const createNote = (/** @type {Record<string, unknown>} */ states) => ({
  ...{ id: 'create-note', version: 1, apiVersion: 1, group: 'command', rank: 1, hosts: ['workspace'] },
  ...{ label: 'Create note', owner: 2, subject: 'create-note', states },
});
const without = (/** @type {string[]} */ ...gone) => (/** @type {string[]} */ states) => states.filter(state => !gone.includes(state));

describe('npm run check:states (#26 slice 1)', () => {
  it('passes on the repository, its seeded baseline listing all 11 states for each command, query and surface', async () => {
    const { code, output } = await run([]);
    assert.equal(code, 0, output);
    const { missing } = baselineOf();
    for (const [subject, states] of Object.entries(missing)) assert.deepEqual(states, [...words.STATES], subject);
    for (const subject of ['command:create-note', 'command:probe-commit', 'query:list-notes', 'surface:moment', 'surface:background'])
      assert.ok(subject in missing, subject);
  });

  it('fails a missing row the baseline does not list, naming the contribution and its states', async () => {
    const root = copy();
    listing(root, 'command:create-note', without('failed', 'empty'));
    const { code, output } = await run([], root);
    assert.equal(code, 1, output);
    assert.match(output, /command:create-note has no row for empty, failed, and ci\/baselines\/states\.json doesn't list them/);
  });

  it('fails a written row the baseline still lists and says to remove it, and passes once it is off the list', async () => {
    const root = copy();
    registering(root, [createNote({ failed: ROW, empty: { notApplicable: 'A command reads nothing' } })]);
    const { code, output } = await run([], root);
    assert.equal(code, 1, output);
    assert.match(output, /command:create-note has rows for empty, failed: remove them from its entry in ci\/baselines\/states\.json/);
    listing(root, 'command:create-note', without('failed', 'empty'));
    const passing = await run([], root);
    assert.equal(passing.code, 0, passing.output);
  });

  it('fails an entry for a contribution no catalog has, or a state outside the 11', async () => {
    const root = copy();
    listing(root, 'command:no-such-thing', () => ['failed']);
    listing(root, 'query:list-notes', states => [...states, 'saved']);
    const { code, output } = await run([], root);
    assert.equal(code, 1, output);
    assert.match(output, /command:no-such-thing is no registered contribution/);
    assert.match(output, /query:list-notes lists saved, which isn't one of the 11 states/);
  });

  it('fails a row whose message has no catalog string, or whose primary action is off the list', async () => {
    for (const [row, said] of [
      [{ ...ROW, messageKey: 'state.nowhere.headline' }, /state\.nowhere\.headline has no catalog string/],
      [{ ...ROW, primaryAction: 'delete' }, /matrix create-note: invalid-field \(states\)/],
    ]) {
      const root = copy();
      listing(root, 'command:create-note', without('failed'));
      registering(root, [createNote({ failed: row })]);
      const { code, output } = await run([], root);
      assert.equal(code, 1, output);
      assert.match(output, /** @type {RegExp} */ (said));
    }
  });

  it("leaves the baseline's bytes as they were, and exits 2 on a flag it doesn't know", async () => {
    const before = fs.readFileSync(path.join(ROOT, check.BASELINE));
    await run([]);
    assert.deepEqual(fs.readFileSync(path.join(ROOT, check.BASELINE)), before);
    for (const flag of ['--write', '--update', '--seed']) assert.equal((await run([flag])).code, 2, flag);
  });
});
