'use strict';

/**
 * expectFailure(title, body) registers a node:test test for a step that fails at the
 * legacy 1.4.x code because of a defect in test/known-defects.json. The title starts with
 * the entry's id, and it is a string literal, since test/known-defects.test.js finds these
 * calls by scanning test/.
 *
 * The test passes when `body` fails an assertion and fails when `body` passes, so the PR
 * that fixes the defect turns the call into test() and deletes the entry. Any other error
 * (a TypeError, a timeout) fails the test as it would in test().
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ID = /^(KD-\d{3}) \S/;

/**
 * Run `body` and settle the way an expected failure should: resolve when it fails an
 * assertion, reject when it passes or throws anything else.
 * @param {string} id - The ledger id, for the messages
 * @param {(t?: any) => any} body
 * @param {any} [t] - The node:test context, passed to body
 * @returns {Promise<string>} The failed assertion's first line, and what it got
 */
async function runExpectedFailure(id, body, t) {
  try {
    await body(t);
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    const [first] = error.message.split('\n');
    const got = 'actual' in error ? ` got ${JSON.stringify(error.actual)}` : '';
    return `${first}${got}`.slice(0, 300);
  }
  throw new assert.AssertionError({
    message: `${id} passed, so its defect looks fixed: delete its entry from test/known-defects.json and turn this expectFailure() into test()`,
  });
}

/**
 * @param {string} title - "KD-NNN " and what the step should do
 * @param {(t: any) => any} body
 * @returns {void}
 */
function expectFailure(title, body) {
  const match = ID.exec(title);
  if (!match) throw new Error(`expectFailure: the title has to start with a ledger id and a space ("KD-NNN ..."): ${title}`);
  const [, id] = match;
  test(title, async t => {
    const failed = await runExpectedFailure(id, body, t);
    t.diagnostic(`fails as ${id} expects: ${failed}`);
  });
}

module.exports = { expectFailure, runExpectedFailure };
