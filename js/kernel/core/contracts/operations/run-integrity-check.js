/**
 * runIntegrityCheck, catalog version 1: the read-only integrity check, which reports orphaned
 * records and changes nothing. The service worker runs it after an install or an update (#35
 * slice 1), so no start reads every store for it. #17's adapter runs the scan 1.4.x's Storage
 * runs (adapters/indexeddb/integrity.js, #17 PR 1b), and reports what Storage reports.
 */

import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('runIntegrityCheck', {});

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} RunIntegrityCheck */
