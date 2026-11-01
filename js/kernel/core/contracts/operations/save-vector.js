/**
 * saveVector, catalog version 1 (#17 PR 4b): a note's embedding, which #22's search makes from
 * its title and text, stored as Storage.saveVector stored it, `{id, noteId, vector, updatedAt}`,
 * with the content revision it was made from, `sourceRevision`, when the job read one. It's a
 * derived write (application/scopes.js): refused for a note that's gone, and one made from an
 * older revision than the stored embedding's writes nothing and commits as `vector-unchanged`.
 * A database without the `vectors` store keeps no embedding, as Storage.saveVector skipped it.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { content, entityId, revision } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('saveVector', {
  noteId: entityId('note'),
  // Made from what the user wrote, so it's content too
  vector: content(v.pipe(v.array(v.pipe(v.number(), v.finite())), v.minLength(1))),
  sourceRevision: v.optional(revision),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} SaveVector */
