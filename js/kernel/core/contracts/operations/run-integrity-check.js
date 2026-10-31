/**
 * runIntegrityCheck, catalog version 1: the read-only integrity check, which reports orphaned
 * records and changes nothing. The service worker runs it after an install or an update (#35
 * slice 1), so no start reads every store for it. #17's adapter has no check yet, so there it
 * commits and checks nothing until #17's scan exists.
 */

import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('runIntegrityCheck', {});

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} RunIntegrityCheck */
