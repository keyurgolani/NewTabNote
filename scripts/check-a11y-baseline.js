#!/usr/bin/env node
'use strict';

/**
 * #29's shared accessibility baseline, test/a11y/baseline.json under check ID `a11y-rules`, which #24's
 * slice 2 creates (docs/accessibility/interaction-contract.md, "Baseline gates"). One line per page and
 * rule lists the targets that fail it. A page is its spec's path under test/a11y/ (`legacy-newtab` for
 * test/a11y/legacy-newtab.spec.js), so a line for a page with no spec fails. A line for dark pairs
 * carries `ownerGate`, a gate docs/accessibility/matrix.json names (`#16-dark`), and only a finding at
 * that gated point counts against it. The baseline only shrinks:
 * - test:a11y's reporter (test/a11y/baseline-reporter.js) fails a run on a finding no line lists, a
 *   violation or a higher entry, and on a listed target that a page that ran no longer fails, a drop not
 *   yet lowered. A spec that ran without reporting fails when its page has lines; a page whose spec the
 *   run left out keeps them, since Playwright doesn't tell a reporter which filters a run had.
 * - npm run check:a11y-baseline checks the file's shape and each line's spec. With --base <ref>, a line
 *   or target the base's baseline doesn't have fails, and a base with no baseline yet passes.
 * The file lands with its seed, its first lines. Until then there's none, which is no lines, and a head
 * that drops a file its base has fails --base. Nothing writes the file, and no flag makes either one.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BASELINE = 'test/a11y/baseline.json';
const SPECS = 'test/a11y';
const CHECK = 'a11y-rules';
const USAGE = 'usage: node scripts/check-a11y-baseline.js [--base <git ref>]';

/** @typedef {{page: string, rule: string, targets: string[], ownerGate?: string}} Line */
/** @typedef {{page: string, findings: {rule: string, target: string, gate?: string}[]}} Record */

/** The gates matrix.json names, as `#16-dark` */
function gates(root = ROOT) {
  /** @type {{gated: Record<string, Record<string, string>>}} */
  const matrix = JSON.parse(fs.readFileSync(path.join(root, 'docs/accessibility/matrix.json'), 'utf8'));
  return new Set(Object.values(matrix.gated).flatMap(values => Object.values(values)));
}

/** @param {{page: string, rule: string, ownerGate?: string}} line */
const keyOf = ({ page, rule, ownerGate }) => JSON.stringify([page, rule, ownerGate ?? null]);
/** @param {{page: string, rule: string, ownerGate?: string}} line */
const named = ({ page, rule, ownerGate }) => `${page}'s ${rule}${ownerGate ? ` (${ownerGate})` : ''}`;
/** @param {string[]} targets */
const listOf = targets => targets.map(target => JSON.stringify(target)).join(', ');

/**
 * What's wrong with the file's shape: its check ID, and each line's page, rule, targets and gate
 * @param {any} file
 * @param {ReadonlySet<string>} known - the gates a line may carry
 * @returns {string[]}
 */
function fileProblems(file, known) {
  /** @type {string[]} */
  const problems = [];
  if (file?.check !== CHECK) problems.push(`check is ${JSON.stringify(file?.check)}, not "${CHECK}"`);
  if (!Array.isArray(file?.entries)) return [...problems, 'entries is not a list'];
  const seen = new Set();
  file.entries.forEach((/** @type {any} */ line, /** @type {number} */ i) => {
    const { page, rule, targets, ownerGate, ...rest } = line ?? {};
    const at = `entries[${i}]`;
    if (typeof page !== 'string' || page === '' || typeof rule !== 'string' || rule === '') problems.push(`${at} needs a page and a rule`);
    if (!Array.isArray(targets) || targets.length === 0 || !targets.every(target => typeof target === 'string' && target !== '')) {
      problems.push(`${at} needs a list of targets`);
    } else if (new Set(targets).size !== targets.length) problems.push(`${at} lists a target twice`);
    if (ownerGate !== undefined && !known.has(ownerGate)) problems.push(`${at}'s ownerGate ${JSON.stringify(ownerGate)} is no gate matrix.json names`);
    if (Object.keys(rest).length > 0) problems.push(`${at} has ${Object.keys(rest).join(', ')}, which a line doesn't take`);
    if (typeof page === 'string' && typeof rule === 'string') {
      if (seen.has(keyOf(line))) problems.push(`${at} repeats ${named(line)}'s line`);
      seen.add(keyOf(line));
    }
  });
  return problems;
}

/**
 * The pages with lines and no spec, so nothing would check their lines
 * @param {{entries: readonly Line[]}} file
 * @param {string} dir - where the specs are: test/a11y/
 * @returns {string[]}
 */
function specProblems(file, dir) {
  return [...new Set(file.entries.map(({ page }) => page))]
    .filter(page => !fs.existsSync(path.join(dir, `${page}.spec.js`)))
    .map(page => `${page} has lines in ${BASELINE}, but there's no ${SPECS}/${page}.spec.js to check them`);
}

/**
 * A run's findings, by page, against the file's lines
 * @param {readonly Record[]} records
 * @param {{entries: readonly Line[]}} file
 * @returns {string[]}
 */
function runProblems(records, file) {
  const ran = new Set(records.map(({ page }) => page));
  /** @type {Map<string, {line: {page: string, rule: string, ownerGate?: string}, targets: Set<string>}>} */
  const found = new Map();
  for (const { page, findings } of records) {
    for (const { rule, target, gate } of findings) {
      const line = { page, rule, ...(gate === undefined ? {} : { ownerGate: gate }) };
      const key = keyOf(line);
      if (!found.has(key)) found.set(key, { line, targets: new Set() });
      found.get(key)?.targets.add(target);
    }
  }
  const listed = new Map(file.entries.map(line => [keyOf(line), line]));
  /** @type {string[]} */
  const problems = [];
  for (const [key, { line, targets }] of found) {
    const unlisted = [...targets].filter(target => !(listed.get(key)?.targets ?? []).includes(target));
    if (unlisted.length > 0) problems.push(`${named(line)} fails ${listOf(unlisted)}, which ${BASELINE} doesn't list`);
  }
  for (const line of file.entries) {
    if (!ran.has(line.page)) continue;
    const targets = found.get(keyOf(line))?.targets ?? new Set();
    const gone = line.targets.filter(target => !targets.has(target));
    if (gone.length > 0) problems.push(`${named(line)} no longer fails ${listOf(gone)}: lower its line in ${BASELINE}`);
  }
  return problems;
}

/**
 * The lines and targets `base`'s baseline doesn't have
 * @param {{entries: readonly Line[]}} file
 * @param {any} before - the base's baseline
 * @param {string} base
 * @returns {string[]}
 */
function historyProblems(file, before, base) {
  /** @type {Map<string, Line>} */
  const lines = Array.isArray(before?.entries) ? before.entries.filter((/** @type {unknown} */ line) => line && typeof line === 'object') : [];
  const had = new Map(lines.map((/** @type {Line} */ line) => [keyOf(line), line]));
  return file.entries.flatMap(line => {
    const added = line.targets.filter(target => !(had.get(keyOf(line))?.targets ?? []).includes(target));
    return added.length > 0 ? [`${named(line)} lists ${listOf(added)}, which ${base}'s baseline doesn't: the baseline only shrinks`] : [];
  });
}

/**
 * @param {string[]} [argv]
 * @param {{root?: string, log?: (line: string) => void, error?: (line: string) => void,
 *   git?: (args: string[]) => string}} [options] - `git` runs git in `root`, unless a test hands in another
 * @returns {number}
 */
function main(argv = process.argv.slice(2), options = {}) {
  const { root = ROOT, log = console.log, error = console.error } = options;
  const git = options.git ?? (args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  /** @type {string | null} */
  let base = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--base' || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      error(USAGE);
      return 2;
    }
    base = argv[(i += 1)];
  }
  const seeded = fs.existsSync(path.join(root, BASELINE));
  const file = seeded ? JSON.parse(fs.readFileSync(path.join(root, BASELINE), 'utf8')) : { check: CHECK, entries: [] };
  const problems = seeded ? fileProblems(file, gates(root)) : [];
  if (problems.length === 0) problems.push(...specProblems(file, path.join(root, SPECS)));
  let note = '';
  if (base !== null && problems.length === 0) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    } catch {
      error(`check:a11y-baseline failed: git can't read ${base}, so there's no baseline to hold this one to`);
      return 1;
    }
    if (git(['ls-tree', '--name-only', base, '--', BASELINE]).trim() === '') note = `; ${base} has no baseline yet`;
    else if (!seeded) problems.push(`${BASELINE} is gone, though ${base} has one: empty its lines instead of dropping it`);
    else {
      problems.push(...historyProblems(file, JSON.parse(git(['show', `${base}:${BASELINE}`])), base));
      note = `, none of them new since ${base}`;
    }
  }
  if (problems.length > 0) {
    error(`check:a11y-baseline failed: ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
    for (const problem of problems) error(`  - ${problem}`);
    return 1;
  }
  const count = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const targets = file.entries.reduce((/** @type {number} */ sum, /** @type {Line} */ line) => sum + line.targets.length, 0);
  const what = seeded ? `${count(file.entries.length, 'line')} in ${BASELINE} listing ${count(targets, 'target')}` : `no ${BASELINE} yet, so no lines`;
  log(`check:a11y-baseline: OK, ${what}${note}`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main, BASELINE, SPECS, CHECK, ROOT, gates, fileProblems, specProblems, runProblems, historyProblems };
