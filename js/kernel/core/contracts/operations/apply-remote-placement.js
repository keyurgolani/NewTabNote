/**
 * applyRemotePlacement, catalog version 1 (#17 PR 4b): one note's placement as another profile
 * has it, which applyRemoteChanges sends for each note it doesn't make: pinned, archived,
 * trashed, a template, each with the time it was set, and its folder. They replace the note's,
 * and its placement, kind, and lifecycle follow (#17 PR 3a). A note that's moved past
 * `expectedPlacementVersion` is a `placement-conflict`, kept in `conflicts`, and changes in
 * nothing; one already placed as the remote has it changes in nothing either. A trash also
 * needs the note's text at `expectedRevision`, 0 when left out, since trash leads to deletion:
 * one whose text moved past it is a `revision-conflict` (R131). A folder this profile doesn't
 * have files the note at the root.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId, revision, timestamp } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('applyRemotePlacement', {
  noteId: entityId('note'),
  placement: v.strictObject({
    pinned: v.optional(v.boolean()),
    archived: v.optional(v.boolean()),
    archivedAt: v.optional(v.nullable(timestamp)),
    trashed: v.optional(v.boolean()),
    trashedAt: v.optional(v.nullable(timestamp)),
    isTemplate: v.optional(v.boolean()),
    folderId: v.optional(v.nullable(entityId('folder'))),
  }),
  expectedPlacementVersion: revision,
  expectedRevision: v.optional(revision),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} ApplyRemotePlacement */
