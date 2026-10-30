/**
 * Operations as the router and the client find them (#13, "Validation"): a catalog entry with
 * the payload and result schemas its module exports. An MV3 worker can't import() a module,
 * so each composition root imports the schema modules its surface serves or sends and hands
 * them here, and a page loads only the schemas it uses. The coordinator's own queries are in
 * messaging/system-operations.js, which the router always knows and a client adds to its
 * lookup when it asks one of them.
 */

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

/**
 * A lookup over `operations`. A name only an object's prototype has, such as `constructor`,
 * finds nothing.
 * @param {Readonly<Record<string, Operation>>} [operations]
 * @returns {Lookup}
 */
export function createLookup(operations = {}) {
  return name => (Object.hasOwn(operations, name) ? operations[name] : undefined);
}
