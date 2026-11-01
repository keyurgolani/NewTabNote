/**
 * listVectors, catalog version 1 (#17 PR 4b): every note's embedding, as Storage.getAllVectors
 * read them for the new tab's semantic search and for the job that finds the notes whose
 * embedding is older than their last edit.
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { vectorRecord } from '../entities.js';
import { queryPayload } from '../operation.js';
import { queryStateSchema } from '../outcome-schemas.js';

export const payload = queryPayload('listVectors', {});

export const result = queryStateSchema(v.array(vectorRecord));

/** @typedef {v.InferOutput<typeof payload>} ListVectors */
