/**
 * The coordinator's own queries (contracts/system.js) as operations, which the router always
 * knows and answers itself, whatever lookup its composition root gives it. A client that asks
 * one adds these to its lookup.
 */

import { SYSTEM_QUERIES } from '../contracts/system.js';
import * as messagingHealth from '../contracts/operations/system-messaging-health.js';
import { operationOf } from './operations.js';

/** @typedef {import('../contracts/validate.js').Operation} Operation */

/** @type {Readonly<Record<string, Operation>>} */
export const SYSTEM_OPERATIONS = Object.freeze({
  'system.messagingHealth': operationOf(SYSTEM_QUERIES['system.messagingHealth'], messagingHealth),
});
