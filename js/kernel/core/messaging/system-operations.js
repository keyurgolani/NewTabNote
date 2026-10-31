/**
 * The coordinator's own queries (contracts/system.js) as operations, which the router always
 * knows, whatever lookup its composition root gives it. It answers system.messagingHealth
 * itself, and #35's coordinator system.coordinatorHealth through the handler the worker gives
 * it. A client that asks one adds these to its lookup.
 */

import { SYSTEM_QUERIES } from '../contracts/system.js';
import * as coordinatorHealth from '../contracts/operations/system-coordinator-health.js';
import * as messagingHealth from '../contracts/operations/system-messaging-health.js';
import { operationOf } from './operations.js';

/** @typedef {import('../contracts/validate.js').Operation} Operation */

/** @type {Readonly<Record<string, Operation>>} */
export const SYSTEM_OPERATIONS = Object.freeze({
  'system.messagingHealth': operationOf(SYSTEM_QUERIES['system.messagingHealth'], messagingHealth),
  'system.coordinatorHealth': operationOf(SYSTEM_QUERIES['system.coordinatorHealth'], coordinatorHealth),
});
