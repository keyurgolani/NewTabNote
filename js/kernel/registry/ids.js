/**
 * Contribution identity (#15, "Kit"). An id reuses the string already in use (a palette id, a
 * settings key, a `syncProvider` value, a manifest command name) and never comes from a label.
 * It's unique within its family. camelCase is allowed so today's settings keys stay valid, and
 * a family whose ids are paths (navigation's `settings/general`) may join segments with `/`.
 * Across families a contribution is named `<family>:<id>`, its ref.
 */

export const MAX_ID_LENGTH = 64;

const SEGMENT = '[a-z][A-Za-z0-9-]*(?:\\.[a-z][A-Za-z0-9-]*)*';
const ID = new RegExp(`^${SEGMENT}$`);
const PATH_ID = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`);

/**
 * Whether `value` is a contribution id, or a family id (which follows the same rule)
 * @param {unknown} value
 * @param {{paths?: boolean}} [options] whether `/` may join segments
 * @returns {value is string}
 */
export function isId(value, { paths = false } = {}) {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && (paths ? PATH_ID : ID).test(value);
}

/**
 * The ref that names `id` in `family` from anywhere
 * @param {string} family
 * @param {string} id
 */
export function refOf(family, id) {
  return `${family}:${id}`;
}

/**
 * What a `requires` entry names: `<family>:<id>` for another family's contribution, or a bare id
 * in `family` itself. Null when it names nothing a family could hold.
 * @param {unknown} entry
 * @param {string} family the family of the contribution that requires it
 * @returns {{family: string, id: string} | null}
 */
export function parseRef(entry, family) {
  if (typeof entry !== 'string') return null;
  const colon = entry.indexOf(':');
  const [target, id] = colon === -1 ? [family, entry] : [entry.slice(0, colon), entry.slice(colon + 1)];
  if (!isId(target) || !isId(id, { paths: true })) return null;
  return { family: target, id };
}
