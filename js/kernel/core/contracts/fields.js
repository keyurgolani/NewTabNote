/**
 * The pieces every contract schema is built from (#13, "Validation"): ids, the ids that name
 * an entity, integer timestamps and revisions, codes, and the mark that lets a field carry
 * content. Schemas are Valibot (docs/adr/0001-kernel-stack.md, decision 2), and each one's
 * type comes from it through JSDoc, with nothing generated.
 *
 * Content (note text, titles, previews, insights, and a captured page's URL and title)
 * travels only in a field marked with content(), and such a field is never logged or counted.
 * test/kernel/contract-schema-lint.test.mjs holds every schema to that: a field named for
 * what the user wrote, or a URL, is content, and it lists each schema's content fields. It
 * also holds payloads and frames to more: outside content, a string has a bound, and nothing
 * is untyped or loose. No schema transforms, defaults, or drops what it accepts, since the
 * router passes on the value that arrived (contracts/validate.js).
 */

import * as v from '../../../lib/valibot/index.mjs';

/**
 * The kinds of entity an id can name, which a catalog entry's `entityTypes` lists. An
 * `intelligence` id is a signal's (#7, intelligence/identity.js), which its commit hints name.
 */
export const ENTITY_TYPES = Object.freeze(
  /** @type {const} */ (['note', 'block', 'folder', 'snapshot', 'intelligence']),
);

/** @typedef {(typeof ENTITY_TYPES)[number]} EntityType */

/** The longest id any store keys a record by: legacy ids are about 23 characters, UUIDs 36 */
export const MAX_ID_LENGTH = 128;

/** An id the kernel stores and looks up, such as a commandId: a non-empty string */
export const id = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_ID_LENGTH));

/**
 * An id that names an entity of `type`, which the router checks against the operation's
 * `entityTypes`
 * @template {EntityType} T
 * @param {T} type
 */
export const entityId = type => v.pipe(id, v.metadata({ entity: type }));

/**
 * A field that carries content: note text, a title, a preview, insights, or a captured page's
 * URL or title. Only these may, and none is logged or counted.
 * @template {v.GenericSchema} S
 * @param {S} schema
 */
export const content = schema => v.pipe(schema, v.metadata({ content: true }));

/** A time, as an integer count of milliseconds since the epoch */
export const timestamp = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** A content revision (#17): an integer from 0 */
export const revision = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** A position in #17's change log, which #13 calls commitSeq: an integer from 1 */
export const commitSeq = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

/** A count, size, or index: an integer from 0 */
export const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** An outcome or reason code, such as `note-not-found`: lowercase words joined by hyphens */
export const code = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), v.maxLength(64));
