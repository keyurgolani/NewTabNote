/**
 * system.coordinatorHealth, catalog version 1: the background coordinator's own state (#35,
 * "Incidents and health"), which #20's `coordinator` provider reads. What its welcome says,
 * its instance id and when it started, the commands it ran by outcome, when the oldest journal
 * entry its last drain left with no live owner was written, null with none (#35 slice 3), and
 * while it says `migrating`, whether its run upgrades the database or an older build's open page
 * blocks that upgrade (#35 slice 2). While its last drain held notes back, it names them, ten at
 * most, each by id and the code it stopped at, with the total of every one held (`held`, slice
 * 3b, optional at version 1 as `orders` was for saveNoteContent, so an older worker's answer
 * still parses). While a command holds its queue, it says which: the command's type, when its turn
 * began, and how many wait behind it (`running`), and from its first cut turn, how many turns the
 * queue cut at TURN_LIMIT_MS in this worker's life (`cutTurns`). While its last drain stopped at an
 * entry, it says the stop's code, and how many drains in a row stopped there where that's counted
 * (`stuck`). All three are optional at version 1 too (#35 slice 4b-1). Ids, counts, times, codes and
 * command names only: nothing in it holds what the user wrote.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { COMMAND_NAMES } from '../command-names.js';
import { code, count, id, timestamp } from '../fields.js';
import { queryPayload } from '../operation.js';
import { OUTCOME_KINDS } from '../outcomes.js';
import { queryStateSchema } from '../outcome-schemas.js';

/** How many of the notes its last drain held back the answer names, beside the total of all of them */
export const HELD_NOTES_NAMED = 10;

export const payload = queryPayload('system.coordinatorHealth', {});

/** The coordinator's state since this worker instance started */
export const coordinatorHealth = v.strictObject({
  status: v.picklist(['ready', 'degraded']),
  reason: v.optional(code),
  coordinatorId: id,
  // When its first start began, and null before one
  startedAt: v.nullable(timestamp),
  commands: v.array(v.strictObject({ outcome: v.picklist([...OUTCOME_KINDS, 'bulk']), count })),
  oldestOrphanedEntryAt: v.nullable(timestamp),
  // While it says migrating: its run upgrading the database, or an older build's open page
  // blocking that upgrade; null otherwise
  migration: v.nullable(v.picklist(['running', 'blocked'])),
  // While its last drain held notes back: the first of them by id and why, and how many in all
  held: v.optional(
    v.strictObject({
      total: count,
      notes: v.pipe(v.array(v.strictObject({ noteId: id, code })), v.maxLength(HELD_NOTES_NAMED)),
    }),
  ),
  // While a command holds the queue: its type, by name only, when its turn began, and how many wait
  // behind it; absent while the queue is idle
  running: v.optional(v.strictObject({ type: v.picklist(COMMAND_NAMES), since: timestamp, waiting: count })),
  // How many turns the queue cut in this worker's life, from the first cut on
  cutTurns: v.optional(count),
  // While its last drain stopped at an entry: the stop's code, and how many drains in a row stopped
  // there, where they're counted
  stuck: v.optional(v.strictObject({ code, count: v.optional(count) })),
});

export const result = queryStateSchema(coordinatorHealth);

/** @typedef {v.InferOutput<typeof payload>} CoordinatorHealthQuery */
/** @typedef {v.InferOutput<typeof coordinatorHealth>} CoordinatorHealth */
