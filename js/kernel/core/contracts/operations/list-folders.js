/**
 * listFolders, catalog version 1: every folder.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { folderRecord } from '../entities.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('listFolders', {});

export const result = queryStateSchema(v.array(folderRecord));

/** @typedef {v.InferOutput<typeof payload>} ListFolders */
