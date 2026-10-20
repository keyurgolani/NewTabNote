// Walks a Valibot schema the way the contract tests read one: every schema and field inside
// it, with the metadata a field's pipe gives it (contracts/fields.js marks entity ids and
// content that way).

/**
 * A Valibot schema or pipe action, as these tests read one
 * @typedef {{
 *   kind: string,
 *   type: string,
 *   entries?: Record<string, Schema>,
 *   item?: Schema,
 *   wrapped?: Schema,
 *   options?: Schema[],
 *   pipe?: Schema[],
 *   metadata?: Record<string, unknown>,
 * }} Schema
 */

/**
 * One schema inside another, at `path`, with every metadata its pipe and the pipes around it
 * give it, the nearest last
 * @typedef {object} Visit
 * @property {Schema} schema
 * @property {string[]} path - field names, `[]` for an array's item
 * @property {Array<Record<string, unknown>>} metadata
 */

/**
 * @param {Schema} schema
 * @returns {Array<Record<string, unknown>>} the metadata actions in `schema`'s pipe, its base's first
 */
function pipeMetadata(schema) {
  if (!schema.pipe) return [];
  const [base, ...actions] = schema.pipe;
  return [
    ...(base === schema ? [] : pipeMetadata(base)),
    ...actions.filter(action => action.kind === 'metadata').map(action => action.metadata ?? {}),
  ];
}

/**
 * Every schema inside `schema`, `schema` included, depth first
 * @param {unknown} root
 * @returns {Visit[]}
 */
export function walk(root) {
  /** @type {Visit[]} */
  const visits = [];
  /**
   * @param {Schema} schema
   * @param {string[]} path
   * @param {Array<Record<string, unknown>>} outer
   */
  const visit = (schema, path, outer) => {
    const metadata = [...outer, ...pipeMetadata(schema)];
    visits.push({ schema, path, metadata });
    for (const [key, entry] of Object.entries(schema.entries ?? {})) visit(entry, [...path, key], metadata);
    if (schema.item) visit(schema.item, [...path, '[]'], metadata);
    if (schema.wrapped) visit(schema.wrapped, path, metadata);
    for (const option of schema.options ?? []) {
      if (typeof option === 'object' && option !== null) visit(option, path, metadata);
    }
  };
  visit(/** @type {Schema} */ (root), [], []);
  return visits;
}

/**
 * The entity types the ids inside `schema` name, sorted
 * @param {unknown} schema
 * @returns {string[]}
 */
export function entityTypesIn(schema) {
  const types = new Set();
  for (const { metadata } of walk(schema)) {
    for (const item of metadata) if (typeof item.entity === 'string') types.add(item.entity);
  }
  return [...types].sort();
}

/**
 * Whether a visit is inside a field marked content, or is one
 * @param {Visit} visitInfo
 * @returns {boolean}
 */
export function isContent(visitInfo) {
  return visitInfo.metadata.some(item => item.content === true);
}
