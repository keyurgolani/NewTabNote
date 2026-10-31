/**
 * createAutoBackup, catalog version 1: the automatic backup 1.4.x keeps in chrome.storage.local,
 * the newest three of them, run by an adapter with the `backups` flag (#18 owns the engine).
 */

import { commandPayload } from '../operation.js';
import { outcomeSchema } from '../outcome-schemas.js';

export const payload = commandPayload('createAutoBackup', {});

export const result = outcomeSchema;

/** @typedef {import('../../../../lib/valibot/index.mjs').InferOutput<typeof payload>} CreateAutoBackup */
