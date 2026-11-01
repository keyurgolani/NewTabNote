/**
 * listLinks, catalog version 1 (#17 PR 4b): every wiki link, as the graph view has read the
 * `links` store whole (Storage.getStore('links').getAll()). A link names two notes, and either
 * may be one the lists don't show, as the graph has always found them.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { linkRecord } from '../entities.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('listLinks', {});

export const result = queryStateSchema(v.array(linkRecord));

/** @typedef {v.InferOutput<typeof payload>} ListLinks */
