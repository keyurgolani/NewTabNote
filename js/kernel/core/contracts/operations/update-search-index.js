/**
 * updateSearchIndex, catalog version 1 (#17 PR 4b): search entries #22's indexer made from
 * notes (js/workers/indexer.js), each stored as it comes, and the notes whose entries go. An
 * entry may say the content revision it was made from, `sourceRevision`, which it keeps. With
 * `replaceAll` the entries are the whole index, as Storage.setSearchIndex wrote it, so the entry
 * of a note they don't name goes too. It's a derived write (application/scopes.js): it writes an
 * entry only for a note that's stored, never touches a note, and drops an entry made from an
 * older revision than the stored one, keeping the stored one, so a slow indexer never puts an
 * older entry back. When it changes nothing it commits as `search-index-unchanged`.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content, entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

/** An entry as the indexer makes it: its note's name, text, and tags, so the whole entry is content */
const entry = content(v.looseObject({ noteId: entityId('note'), sourceRevision: v.optional(revision) }));

export const payload = commandPayload('updateSearchIndex', {
  entries: v.array(entry),
  removed: v.optional(v.array(entityId('note'))),
  replaceAll: v.optional(v.boolean()),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} UpdateSearchIndex */
