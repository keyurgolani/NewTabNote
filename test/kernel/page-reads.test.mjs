// #246: the run of a page's commands that stops sending once the worker didn't take one of them
// (page-reads.js's failingFast, Q5's b), which Popup's and Side Panel's roots wrap each of their
// runs in: the start's apply of closing tabs' edits, and the journal's apply of closed pages' saves.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as pageReads from '../../js/kernel/composition/page-reads.js';
import { committed, rejected, unavailable, unknown } from '../../js/kernel/core/contracts/outcomes.js';

/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {{commandId: string}} Sent */

/**
 * page-reads.js's failingFast, read off the module
 * @type {(send: (command: Sent) => Promise<Outcome>) => (command: Sent) => Promise<Outcome>}
 */
const failingFast = /** @type {any} */ (pageReads).failingFast;

/**
 * A send that answers each command with the next of `answers`, then `committed` for the rest, and
 * the ids of what it sent
 * @param {Outcome[]} answers
 */
function sending(answers) {
  /** @type {string[]} */
  const sent = [];
  /** @param {Sent} command */
  const send = async command => {
    sent.push(command.commandId);
    return answers.shift() ?? committed('close-draft-saved', ['A']);
  };
  return { sent, send };
}

/**
 * Each of `ids` through `run`, in order, as a run sends its commands, and what each answered
 * @param {(command: Sent) => Promise<Outcome>} run
 * @param {string[]} ids
 */
async function runOf(run, ids) {
  /** @type {Outcome[]} */
  const answered = [];
  for (const commandId of ids) answered.push(await run({ commandId }));
  return answered;
}

describe("A run that stops once the worker didn't take one of its commands (page-reads.js's failingFast, #246)", () => {
  it('stops once a command answers unknown, and answers each later one unavailable with its code, unsent', async () => {
    const { sent, send } = sending([unknown('deadline-exceeded', 'c1')]);
    const answered = await runOf(failingFast(send), ['c1', 'c2', 'c3']);
    assert.deepEqual(sent, ['c1'], 'the later two never went');
    assert.deepEqual(answered, [
      unknown('deadline-exceeded', 'c1'),
      unavailable('coordinator', 'deadline-exceeded', true),
      unavailable('coordinator', 'deadline-exceeded', true),
    ]);
  });

  it('stops once a command answers unavailable from the coordinator, and answers each later one as it did, unsent', async () => {
    const { sent, send } = sending([unavailable('coordinator', 'unavailable', true)]);
    const answered = await runOf(failingFast(send), ['c1', 'c2', 'c3']);
    assert.deepEqual(sent, ['c1'], 'the later two never went');
    assert.deepEqual(answered, Array(3).fill(unavailable('coordinator', 'unavailable', true)));
  });

  it('goes on after an unavailable from anywhere else, a refusal and a commit, since the worker took those', async () => {
    const { sent, send } = sending([
      unavailable('adapter', 'adapter-failed', false),
      rejected('validation', 'invalid-payload'),
      committed('close-draft-saved', ['A']),
    ]);
    await runOf(failingFast(send), ['c1', 'c2', 'c3', 'c4']);
    assert.deepEqual(sent, ['c1', 'c2', 'c3', 'c4'], 'every command went');
  });

  it('keeps each run to itself, so a run that stopped stops no other', async () => {
    const { sent, send } = sending([unavailable('coordinator', 'unavailable', true)]);
    const stopped = failingFast(send);
    const other = failingFast(send);
    await runOf(stopped, ['c1', 'c2']);
    assert.deepEqual(await runOf(other, ['d1']), [committed('close-draft-saved', ['A'])]);
    assert.deepEqual(sent, ['c1', 'd1'], "the other run's command went");
  });
});
