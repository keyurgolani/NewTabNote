/**
 * listSearchEntries, catalog version 1: every search entry, and no note, as
 * Storage.getSearchIndex has read them for a sidebar search. The new tab's note list reads
 * them again with it after #22's indexer writes them.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { searchEntryRecord } from '../entities.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('listSearchEntries', {});

export const result = queryStateSchema(v.array(searchEntryRecord));

/** @typedef {v.InferOutput<typeof payload>} ListSearchEntries */
