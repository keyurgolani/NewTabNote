/**
 * getSyncData, catalog version 1 (#17 PR 4b): what sync uploads, 1.4.x's export as one object
 * (Storage.exportAll): every note outside trash, then the templates, without #17 PR 3's fields
 * beside their flags; their blocks; their media, each Blob a data URL; and every folder. Only
 * an adapter with the backup tasks makes it, the new tab's, and on one without it's `failed`,
 * `adapter`, `backups-need-legacy-storage`. It holds no conflict record, which Export JSON does.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { blockRecord, folderRecord, noteRecord } from '../entities.js';
import { content, id, timestamp } from '../fields.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

/** A media row as an export holds it: an image or a file of a note's, so it's content */
const mediaRow = content(v.looseObject({ id, canvasId: v.optional(v.unknown()) }));

export const payload = queryPayload('getSyncData', {});

export const result = queryStateSchema(
  v.strictObject({
    version: v.literal(1),
    exportedAt: timestamp,
    canvases: v.array(noteRecord),
    elements: v.array(blockRecord),
    media: v.array(mediaRow),
    folders: v.array(folderRecord),
  }),
);

/** @typedef {v.InferOutput<typeof payload>} GetSyncData */
