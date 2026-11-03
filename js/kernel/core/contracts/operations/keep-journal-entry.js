/**
 * keepJournalEntry, catalog version 1: a journal entry the coordinator's drain can't replay as
 * written, kept as a #17 conflict record so nothing the user typed is lost (#35 slice 3, "The
 * drain"): one whose command its catalog refuses as malformed (contracts/upcast.js), or that the
 * kernel refuses for a reason replaying it again can't change. An entry a newer build wrote
 * isn't kept this way: it stays in the journal until that build drains it (the lead's answer
 * to the plan's Q6).
 *
 * `opId` is the entry's key, which the record is kept under, so a second keep of it adds none;
 * `noteId` is its note's id, when it names one; `command` is what the entry held, all of it what
 * the user wrote.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content, entityId, id } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('keepJournalEntry', {
  opId: id,
  noteId: v.optional(entityId('note')),
  command: content(v.looseObject({})),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} KeepJournalEntry */
