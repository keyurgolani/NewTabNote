/**
 * Playwright reporter that holds the tests that ran to test/known-defects.json, listed in
 * e2e/playwright.config.js's reporters. It fails the run when a test was expected to fail,
 * by test.fail() in any form (declared, called in the body, conditional, in a hook), but the
 * ledger doesn't list it under the id its title carries, and when a test carries an id the
 * ledger doesn't list it under or that wasn't expected to fail. test/known-defects.test.js
 * checks the declared form from the test list too, without running anything.
 *
 * It also deletes the error-context.md Playwright writes for every test that threw, for
 * each expected failure, so a clean run leaves nothing for CI to upload.
 *
 *   options.ledger  the ledger file (default: test/known-defects.json)
 */

const fs = require('fs');
const path = require('path');
const { LEDGER_PATH, loadKnownDefects } = require('./known-defects');

const ID = /\bKD-\d{3}\b/;

class ExpectedFailuresReporter {
  constructor({ ledger = LEDGER_PATH } = {}) {
    this._ledger = ledger;
    this._listedAs = new Map();
    this._problems = new Map();
  }

  printsToStdio() {
    return false;
  }

  onBegin() {
    this._listedAs = new Map(loadKnownDefects(this._ledger).flatMap(({ id, tests }) => tests.map(title => [title, id])));
  }

  onTestEnd(test, result) {
    if (test.expectedStatus === 'failed' && result.status === 'failed') {
      for (const { name, path: file } of result.attachments) {
        if (name === 'error-context' && file) fs.rmSync(file, { force: true });
      }
    }
    if (test.expectedStatus === 'skipped') return;

    const { title } = test;
    const where = `${path.relative(process.cwd(), test.location.file)}:${test.location.line}`;
    const expectedToFail = test.expectedStatus === 'failed';
    const carried = ID.exec(title);
    const listedAs = this._listedAs.get(title);
    let problem = null;
    if (!carried) {
      if (expectedToFail) problem = `${where}: "${title}" is expected to fail but carries no ledger id; add a test/known-defects.json entry and put its id in the title`;
    } else if (listedAs !== carried[0]) {
      problem = expectedToFail
        ? `${where}: "${title}" is expected to fail but test/known-defects.json doesn't list it under ${carried[0]}`
        : `${where}: "${title}" carries ${carried[0]} but no test/known-defects.json entry lists it; drop the id from the title if it's fixed`;
    } else if (!expectedToFail) {
      problem = `${where}: "${title}" is listed under ${carried[0]} but wasn't expected to fail; declare it with test.fail(title, body), or if it's fixed delete the entry and drop the id from the title`;
    }
    if (problem) this._problems.set(test.id, problem);
  }

  onEnd() {
    if (this._problems.size === 0) return undefined;
    process.stderr.write(`\nThe expected failures that ran don't match test/known-defects.json:\n${[...this._problems.values()].map(problem => `  ${problem}`).join('\n')}\n`);
    return { status: 'failed' };
  }
}

module.exports = ExpectedFailuresReporter;
