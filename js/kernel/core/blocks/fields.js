/**
 * What a block record holds (#14, "Data and migration"): the envelope every block has, and the
 * kinds a definition gives the fields it owns. A record's other fields aren't its type's: the
 * opaque rule carries them through decode unchanged (catalog.js, `decode`).
 *
 * The kinds are as lenient as what 1.4.x writes, so no record 1.4.x saved reads as invalid:
 * `Block`'s constructor fills its fields with `||` defaults, so a stored flag can be any
 * primitive and a text field can be null. Invalid is a value of the wrong class altogether (an
 * object where text goes, a grid that isn't rows), which no view could show as stored.
 * - `richText`: markup, a string (inline schema v1 from slice 2 on)
 * - `plainText`: text shown as text, a string
 * - `url`: a string a block links or loads
 * - `data`: a data URL or a URL, a string
 * - `number`: a finite number
 * - `flag`: a primitive read for its truthiness
 * - `grid`: rows, each a list of cells
 * Every kind also takes `undefined` (absent) and `null`.
 */

/** The fields every block record has, whatever its type, which no definition owns */
export const ENVELOPE_FIELDS = Object.freeze(['id', 'type', 'schemaVersion', 'canvasId', 'order', 'createdAt', 'updatedAt']);

/** @typedef {'richText' | 'plainText' | 'url' | 'data' | 'number' | 'flag' | 'grid'} FieldKind */

/** @type {Readonly<Record<FieldKind, (value: unknown) => boolean>>} */
const CHECKS = Object.freeze({
  richText: value => typeof value === 'string',
  plainText: value => typeof value === 'string',
  url: value => typeof value === 'string',
  data: value => typeof value === 'string',
  number: value => typeof value === 'number' && Number.isFinite(value),
  flag: value => typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'symbol',
  grid: value => Array.isArray(value) && value.every(row => Array.isArray(row)),
});

/** @type {readonly FieldKind[]} */
export const FIELD_KINDS = Object.freeze(/** @type {FieldKind[]} */ (Object.keys(CHECKS)));

/** A field name a definition may own: a JavaScript identifier, and no envelope field */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * Whether `value` is a definition's field map: field names to kinds, at least one, none an
 * envelope field
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, FieldKind>>}
 */
export function isFieldMap(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.length <= 32 &&
    entries.every(
      ([name, kind]) =>
        FIELD_NAME.test(name) &&
        !ENVELOPE_FIELDS.includes(name) &&
        /** @type {readonly unknown[]} */ (FIELD_KINDS).includes(kind),
    )
  );
}

/**
 * The first owned field of `record` whose value isn't its kind, or null when each is
 * @param {Readonly<Record<string, FieldKind>>} fields
 * @param {Readonly<Record<string, unknown>>} record
 * @returns {string | null}
 */
export function invalidField(fields, record) {
  for (const [name, kind] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(record, name)) continue;
    const value = record[name];
    if (value === undefined || value === null) continue;
    if (!CHECKS[kind](value)) return name;
  }
  return null;
}
