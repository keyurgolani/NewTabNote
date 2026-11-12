/**
 * rebuildSearchIndex, version 1 (#35 slice 8): one batch of rebuild-index's notes, up to
 * REBUILD_BATCH of them (core/application/search-rebuild.js), whose search entries the worker
 * writes again from their blocks. Only recovery.html sends it, after the Recovery Center's
 * confirmed preview, and the shared catalog doesn't list it (contracts/recovery-port.js). A note
 * deleted, trashed, archived or made a template since the preview gets nothing written.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { entityId } from '../fields.js';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('rebuildSearchIndex', {
  noteIds: v.pipe(v.array(entityId('note')), v.minLength(1), v.maxLength(100)),
});

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} RebuildSearchIndex */
