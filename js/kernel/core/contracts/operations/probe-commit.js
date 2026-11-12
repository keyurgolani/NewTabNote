/**
 * probeCommit, version 1 (#35 slice 8): Capture's or Storage's check on recovery.html, committed
 * where the notes' writes commit, on the worker's queue (core/application/trust-probe.js, the
 * lead's call 10). Capture's writes, reads back and deletes a probe record in the notes and blocks
 * stores after reading the Daily Note template setting, as a capture does, and Storage's in the
 * notes store. It changes no entity. Only recovery.html sends it, and the shared catalog doesn't
 * list it (contracts/recovery-port.js).
 */

import * as v from '../../../../lib/valibot/index.mjs';
import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('probeCommit', { provider: v.picklist(['capture', 'storage']) });

export const result = outcomeSchema;

/** @typedef {v.InferOutput<typeof payload>} ProbeCommit */
