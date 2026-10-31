/**
 * importBackup, catalog version 1: a parsed version-1 backup file, merged next to the notes or
 * replacing the active ones, run by an adapter with the `backups` flag through 1.4.x's import
 * (#18 owns the engine). It commits all of it or nothing, and its outcome lists the notes it
 * added, in backup order, then the folders it added, then the notes Replace all trashed.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('importBackup', {
  mode: v.picklist(['merge', 'replace']),
  backup: content(v.looseObject({})),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} ImportBackup */
