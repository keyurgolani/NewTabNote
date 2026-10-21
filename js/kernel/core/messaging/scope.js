/**
 * The entity-scope and destination check the router runs before dispatch (#13, "Outcomes and
 * authorization"): every entity id a payload carries is of a type its catalog entry declares
 * in `entityTypes`, and every destination it names is one the entry lists in `destinations`.
 * Where a payload holds them comes from its schema: contracts/fields.js marks each entity id
 * with its type, and #21 (security boundaries) marks the destination fields it adds with
 * `{destination: true}` the same way. Until then no schema has one, and every entry's
 * `destinations` is empty.
 */

import { walk } from '../contracts/schema-walk.js';

/** @typedef {import('../contracts/validate.js').Operation} Operation */

/**
 * Where a payload can hold an entity id or a destination: the path the walk names it by,
 * `[]` for each item of an array
 * @typedef {{path: string[], entity: string | null, destination: boolean}} Mark
 */

/**
 * @param {unknown} schema
 * @returns {Mark[]}
 */
function marksOf(schema) {
  /** @type {Mark[]} */
  const marks = [];
  for (const { path, metadata } of walk(schema)) {
    // The nearest mark wins, as the walk lists a field's own metadata last
    const entity = [...metadata].reverse().find(item => typeof item.entity === 'string')?.entity;
    const destination = metadata.some(item => item.destination === true);
    if (typeof entity === 'string' || destination) {
      marks.push({ path, entity: typeof entity === 'string' ? entity : null, destination });
    }
  }
  return marks;
}

/**
 * The values at `path` in `value`, stepping into every item of an array at `[]`
 * @param {unknown} value
 * @param {readonly string[]} path
 * @returns {unknown[]}
 */
function valuesAt(value, path) {
  let values = [value];
  for (const step of path) {
    values = values.flatMap(current => {
      if (step === '[]') return Array.isArray(current) ? current : [];
      if (current === null || typeof current !== 'object' || Array.isArray(current)) return [];
      return Object.hasOwn(current, step) ? [/** @type {Record<string, unknown>} */ (current)[step]] : [];
    });
  }
  return values;
}

/**
 * A check of payloads against their operations' scopes, which reads each operation's schema
 * once. A schema the walk can't read all of is out of scope, so no payload passes a part of it
 * the check couldn't see.
 * @returns {(operation: Operation, payload: unknown) => boolean}
 */
export function createScopeCheck() {
  /** @type {WeakMap<Operation, Mark[] | null>} */
  const known = new WeakMap();

  /**
   * @param {Operation} operation
   * @returns {Mark[] | null}
   */
  const marksFor = operation => {
    let marks = known.get(operation);
    if (marks === undefined) {
      try {
        marks = marksOf(operation.payload);
      } catch {
        marks = null;
      }
      known.set(operation, marks);
    }
    return marks;
  };

  return (operation, payload) => {
    const marks = marksFor(operation);
    if (marks === null) return false;
    const entityTypes = /** @type {readonly string[]} */ (operation.entry.entityTypes);
    const { destinations } = operation.entry;
    return marks.every(mark =>
      valuesAt(payload, mark.path).every(value => {
        // An id a schema lets be null names nothing
        if (typeof value !== 'string') return true;
        if (mark.entity !== null && !entityTypes.includes(mark.entity)) return false;
        return !mark.destination || destinations.includes(value);
      }),
    );
  };
}
