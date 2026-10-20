/**
 * Reads test/known-defects.json, the ledger of what fails at the legacy 1.4.x code: tests
 * expected to fail, and uncaught exceptions the smoke tests tolerate. Each entry has
 *
 *   id          KD- and three digits
 *   ownerIssue  the issue whose fix removes the defect
 *   evidence    a GitHub link pinned to a full commit SHA, with a line anchor
 *   tests       titles of the tests that fail because of it, each carrying the id; empty
 *               for an entry that only lists uncaught messages
 *   uncaught    optional: exact messages of exceptions the smoke tests tolerate. Smoke
 *               fails on any other uncaught exception, and when a listed one never occurs.
 */

const fs = require('fs');
const path = require('path');

const LEDGER_PATH = path.join(__dirname, '..', '..', 'test', 'known-defects.json');
const LEDGER_KEYS = ['about', 'defects'];
const ENTRY_KEYS = ['id', 'ownerIssue', 'evidence', 'tests', 'uncaught'];
const ID = /^KD-\d{3}$/;
const PINNED_LINK = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/[0-9a-f]{40}\/[^\s#]+#L\d+(-L\d+)?$/;

function isTextList(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim() !== '');
}

/**
 * Every way a parsed ledger breaks the format, as messages; empty when it follows it
 */
function ledgerProblems(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || !Array.isArray(ledger.defects)) {
    return ['the ledger has to be an object with a `defects` array'];
  }
  const problems = Object.keys(ledger).filter(key => !LEDGER_KEYS.includes(key)).map(key => `unknown key \`${key}\``);
  const ids = new Set();

  ledger.defects.forEach((entry, index) => {
    const name = entry && typeof entry.id === 'string' ? entry.id : `defects[${index}]`;
    const problem = message => problems.push(`${name}: ${message}`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problem('has to be an object');
      return;
    }

    Object.keys(entry).filter(key => !ENTRY_KEYS.includes(key)).forEach(key => problem(`unknown key \`${key}\``));
    if (!ID.test(entry.id)) problem('`id` has to be KD- and three digits');
    else if (ids.has(entry.id)) problem('`id` is already used by an earlier entry');
    ids.add(entry.id);
    if (!Number.isInteger(entry.ownerIssue) || entry.ownerIssue < 1) problem('`ownerIssue` has to be an issue number');
    if (typeof entry.evidence !== 'string' || !PINNED_LINK.test(entry.evidence)) {
      problem('`evidence` has to be a GitHub link pinned to a full commit SHA, with a line anchor');
    }
    if (!isTextList(entry.tests)) {
      problem('`tests` has to be an array of test titles');
    } else {
      entry.tests.filter(title => !title.includes(entry.id)).forEach(title => problem(`test title doesn't carry the id: ${title}`));
    }
    if (entry.uncaught !== undefined && (!isTextList(entry.uncaught) || entry.uncaught.length === 0)) {
      problem('`uncaught` has to be a non-empty array of exception messages when present');
    }
    if (Array.isArray(entry.tests) && entry.tests.length === 0 && entry.uncaught === undefined) {
      problem('lists no tests and no uncaught messages');
    }
  });
  return problems;
}

/**
 * The ledger's entries. Throws, listing every problem, when the file breaks the format.
 */
function loadKnownDefects(file = LEDGER_PATH) {
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = ledgerProblems(ledger);
  if (problems.length > 0) {
    throw new Error(`${path.relative(process.cwd(), file)} breaks the ledger format:\n${problems.map(p => `  ${p}`).join('\n')}`);
  }
  return ledger.defects;
}

/**
 * The uncaught exception messages the smoke tests tolerate, each mapped to the ids of
 * the entries that list it
 */
function toleratedUncaught(defects = loadKnownDefects()) {
  const tolerated = new Map();
  for (const { id, uncaught = [] } of defects) {
    for (const message of uncaught) tolerated.set(message, [...(tolerated.get(message) || []), id]);
  }
  return tolerated;
}

module.exports = { LEDGER_PATH, ledgerProblems, loadKnownDefects, toleratedUncaught };
