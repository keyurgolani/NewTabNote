'use strict';

/**
 * expectFailure(title, body) registers a node:test test for a step that fails at the
 * legacy 1.4.x code because of a defect in test/known-defects.json. The title starts with
 * the entry's id, and the entry has to list it: expectFailure() throws when it's called with
 * a title the ledger doesn't list, whatever the title is built from. Keep it a string
 * literal too, since test/known-defects.test.js finds the calls by scanning test/ to check
 * every ledgered title has one.
 *
 * The test passes when `body` fails an assertion and fails when `body` passes. The PR that
 * fixes the defect deletes the entry, turns the call into test(), and drops the id from
 * the title. Any other error (a TypeError, a timeout) fails the test as it would in test().
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadKnownDefects } = require('../../e2e/harness/known-defects.js');

const ID = /^(KD-\d{3}) \S/;

/**
 * Run `body` and settle the way an expected failure should: resolve when it fails an
 * assertion, reject when it passes or throws anything else.
 * @param {string} id - The ledger id, for the messages
 * @param {(t?: any) => any} body
 * @param {any} [t] - The node:test context, passed to body
 * @returns {Promise<string>} The failed assertion's first line, and what it got when the
 *   message was generated from what it compared
 */
async function runExpectedFailure(id, body, t) {
  try {
    await body(t);
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    const [first] = error.message.split('\n');
    const got = error.generatedMessage ? ` got ${JSON.stringify(error.actual)}` : '';
    return `${first}${got}`.slice(0, 300);
  }
  throw new assert.AssertionError({
    message: `${id} passed, so its defect looks fixed: delete its entry from test/known-defects.json, turn this expectFailure() into test(), and drop ${id} from the title`,
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
  const entry = loadKnownDefects().find(defect => defect.id === id);
  if (!entry || !entry.tests.includes(title)) {
    throw new Error(`expectFailure: test/known-defects.json doesn't list "${title}" under ${id}; add it to that entry's tests (or add the entry)`);
  }
  test(title, async t => {
    const failed = await runExpectedFailure(id, body, t);
    t.diagnostic(`fails as ${id} expects: ${failed}`);
  });
}

module.exports = { expectFailure, runExpectedFailure };
