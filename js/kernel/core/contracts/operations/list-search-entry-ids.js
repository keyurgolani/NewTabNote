/**
 * listSearchEntryIds, catalog version 1 (#262): the note ids of every stored search entry, keys
 * alone, with no entry's text. The new tab's whole index reads them once as its write begins, so it
 * removes only the stale entries that were stored then, and keeps any another command writes later.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId } from '../fields.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('listSearchEntryIds', {});

export const result = queryStateSchema(v.array(entityId('note')));

/** @typedef {v.InferOutput<typeof payload>} ListSearchEntryIds */
