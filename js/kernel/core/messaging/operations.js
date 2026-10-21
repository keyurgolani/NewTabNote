/**
 * Operations as the router and the client find them (#13, "Validation"): a catalog entry with
 * the payload and result schemas its module exports. An MV3 worker can't import() a module,
 * so each composition root imports the schema modules its surface serves or sends and hands
 * them here. The coordinator's own queries (contracts/system.js) are always found, and no one
 * else's operation can take their names.
 */

import { SYSTEM_QUERIES } from '../contracts/system.js';
import * as messagingHealth from '../contracts/operations/system-messaging-health.js';

/** @typedef {import('../../../lib/valibot/index.mjs').GenericSchema} GenericSchema */
/** @typedef {import('../contracts/validate.js').Operation} Operation */
/** @typedef {import('../contracts/commands.js').CommandEntry} CommandEntry */
/** @typedef {import('../contracts/queries.js').QueryEntry} QueryEntry */

/**
 * Finds the operation a name names, or nothing
 * @typedef {(name: string) => Operation | undefined} Lookup
 */

/**
 * The operation for a catalog entry and the schema module it names
 * @param {CommandEntry | QueryEntry} entry
 * @param {{payload: GenericSchema, result: GenericSchema}} module
 * @returns {Operation}
 */
export function operationOf(entry, { payload, result }) {
  return Object.freeze({ entry, payload, result });
}

/** @type {Readonly<Record<string, Operation>>} */
const SYSTEM_OPERATIONS = Object.freeze({
  'system.messagingHealth': operationOf(SYSTEM_QUERIES['system.messagingHealth'], messagingHealth),
});

/**
 * A lookup over the coordinator's own queries and then `operations`. A name only an object's
 * prototype has, such as `constructor`, finds nothing.
 * @param {Readonly<Record<string, Operation>>} [operations]
 * @returns {Lookup}
 */
export function createLookup(operations = {}) {
  return name => {
    if (Object.hasOwn(SYSTEM_OPERATIONS, name)) return SYSTEM_OPERATIONS[name];
    return Object.hasOwn(operations, name) ? operations[name] : undefined;
  };
}
