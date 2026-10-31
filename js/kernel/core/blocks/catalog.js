/**
 * A block catalog (#14, "Data and migration" and the opaque rule): the valid definitions of a
 * list, keyed by exact type, and the one way to accept a record (`decode`) or make one
 * (`create`). Pure and synchronous, so the worker and every page run it the same.
 *
 * Decode reads a record as one of five states, and never changes or drops what it holds:
 * - `current`: a known type at its model's version;
 * - `upcast`: an older one (a record with no `schemaVersion` is version 0), brought up to the
 *   model's version in memory, one upcaster at a time;
 * - `newer`: a version above the model's, kept verbatim and read-only, never downgraded;
 * - `unknown`: a type no valid definition here has, kept verbatim;
 * - `invalid`: not a record, a type or version that can't be one, an upcaster that failed, or an
 *   owned field that isn't its kind, kept verbatim.
 * A known type carries every field it doesn't own through decode and back unchanged, in its
 * place. Encode gives back a `newer`, `unknown`, or `invalid` record as the same object, never
 * re-encoded, and a known one as its record at the model's version.
 *
 * The projections read a record of a known type through its model, and any other through
 * OPAQUE_PROJECTIONS, as 1.4.x's callers did (models.js). In this slice they read any record
 * of the type, whatever its state, which is what each caller did; slice 4 gives the safe states
 * their own projections as a declared change.
 */

import { definitionProblems, definitionsProblems } from './contract.js';
import { ENVELOPE_FIELDS } from './fields.js';
import { OPAQUE_PROJECTIONS } from './models.js';

/** @typedef {import('./models.js').BlockModel} BlockModel */
/** @typedef {import('./models.js').BlockRecord} BlockRecord */
/** @typedef {import('./contract.js').BlockProblem} BlockProblem */
/** @typedef {import('./fields.js').FieldKind} FieldKind */

/**
 * A valid definition, as the catalog keeps it
 * @typedef {Readonly<{type: string, version: number, fields: Readonly<Record<string, FieldKind>>, model: BlockModel}>} Definition
 */

/**
 * A decoded record, frozen. `record` is always what decode was given, as given.
 * @typedef {Readonly<{state: 'current' | 'upcast', type: string, version: number, from: number, block: BlockRecord,
 *   fields: Readonly<Record<string, unknown>>, extra: Readonly<Record<string, unknown>>, record: BlockRecord}>
 *   | Readonly<{state: 'newer' | 'unknown', type: string, version: number, record: unknown}>
 *   | Readonly<{state: 'invalid', reason: InvalidReason, type: string | null, field: string | null, record: unknown}>} Decoded
 */

/** @typedef {'not-a-record' | 'invalid-type' | 'invalid-version' | 'upcast-failed' | 'invalid-field'} InvalidReason */

/**
 * What create gives: the record, or why there's none. `field` names the input field it's about.
 * @typedef {Readonly<{ok: true, record: BlockRecord}>
 *   | Readonly<{ok: false, code: 'unknown-type' | 'invalid-id' | 'unknown-field' | 'invalid-field', field: string | null}>} Created
 */

/** The projections a model has, by kind */
/** @typedef {'preview' | 'plainText' | 'search' | 'aiContext'} ProjectionKind */

/**
 * @typedef {Readonly<{
 *   types: readonly string[],
 *   problems: readonly BlockProblem[],
 *   definition: (type: string) => Definition | undefined,
 *   decode: (record: unknown) => Decoded,
 *   encode: (decoded: Decoded) => unknown,
 *   create: (type: string, input: Readonly<Record<string, unknown>>) => Created,
 *   project: (kind: ProjectionKind, record: any) => unknown,
 *   markdown: (record: any) => string,
 * }>} Catalog
 */

/** The envelope fields create takes from its input; `type` and `schemaVersion` are its own */
const CREATE_ENVELOPE = Object.freeze(['id', 'canvasId', 'order', 'createdAt', 'updatedAt']);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {string | null} type
 * @param {unknown} record
 * @param {InvalidReason} reason
 * @param {string | null} [field]
 * @returns {Decoded}
 */
const invalid = (type, record, reason, field = null) => Object.freeze({ state: 'invalid', reason, type, field, record });

/**
 * A catalog of the valid definitions in `descriptors`; the others are its problems, and
 * records of their types read as unknown
 * @param {readonly unknown[]} descriptors
 * @returns {Catalog}
 */
export function createCatalog(descriptors) {
  const problems = Object.freeze(definitionsProblems(descriptors));
  const broken = new Set(problems.map(problem => problem.type));
  /** @type {Map<string, Definition>} */
  const byType = new Map();
  for (const descriptor of descriptors) {
    if (definitionProblems(descriptor).length > 0) continue;
    const d = /** @type {{id: string, version: number, fields: Readonly<Record<string, FieldKind>>, implementation: BlockModel}} */ (
      descriptor
    );
    // A type defined twice is neither's
    if (broken.has(d.id)) continue;
    byType.set(d.id, Object.freeze({ type: d.id, version: d.version, fields: d.fields, model: d.implementation }));
  }

  /**
   * @param {unknown} record
   * @returns {Decoded}
   */
  function decode(record) {
    if (!isRecord(record)) return invalid(null, record, 'not-a-record');
    const type = record.type;
    if (typeof type !== 'string' || type === '') return invalid(null, record, 'invalid-type');
    const from = record.schemaVersion === undefined ? 0 : record.schemaVersion;
    if (typeof from !== 'number' || !Number.isSafeInteger(from) || from < 0) return invalid(type, record, 'invalid-version');
    const definition = byType.get(type);
    if (!definition) return Object.freeze({ state: 'unknown', type, version: from, record });
    if (from > definition.version) return Object.freeze({ state: 'newer', type, version: from, record });

    /** @type {BlockRecord} */
    let block = record;
    try {
      for (let version = from; version < definition.version; version++) {
        const next = definition.model.upcast[version](block);
        if (!isRecord(next) || next.schemaVersion !== version + 1 || next.type !== type || next.id !== record.id) {
          return invalid(type, record, 'upcast-failed');
        }
        block = next;
      }
    } catch {
      return invalid(type, record, 'upcast-failed');
    }
    const field = definition.model.validate(block);
    if (field !== null) return invalid(type, record, 'invalid-field', field);

    // Built from entries, so every name is an own property, `__proto__` included
    /** @type {[string, unknown][]} */
    const fields = [];
    /** @type {[string, unknown][]} */
    const extra = [];
    for (const entry of Object.entries(block)) {
      if (Object.hasOwn(definition.fields, entry[0])) fields.push(entry);
      else if (!ENVELOPE_FIELDS.includes(entry[0])) extra.push(entry);
    }
    return Object.freeze({
      state: from === definition.version ? 'current' : 'upcast',
      type,
      version: definition.version,
      from,
      block,
      fields: Object.freeze(Object.fromEntries(fields)),
      extra: Object.freeze(Object.fromEntries(extra)),
      record,
    });
  }

  /**
   * @param {Decoded} decoded
   * @returns {unknown}
   */
  function encode(decoded) {
    return decoded.state === 'current' || decoded.state === 'upcast' ? decoded.block : decoded.record;
  }

  /**
   * A new record of `type` from `input`: its id, the envelope fields it gives, and the fields
   * the type owns, over the type's defaults, at the model's version
   * @param {string} type
   * @param {Readonly<Record<string, unknown>>} input
   * @returns {Created}
   */
  function create(type, input) {
    const definition = byType.get(type);
    if (!definition) return Object.freeze({ ok: false, code: 'unknown-type', field: null });
    if (!isRecord(input) || typeof input.id !== 'string' || input.id === '') {
      return Object.freeze({ ok: false, code: 'invalid-id', field: 'id' });
    }
    /** @type {Record<string, unknown>} */
    const owned = {};
    /** @type {Record<string, unknown>} */
    const envelope = {};
    for (const [name, value] of Object.entries(input)) {
      if (Object.hasOwn(definition.fields, name)) owned[name] = value;
      else if (CREATE_ENVELOPE.includes(name)) envelope[name] = value;
      else return Object.freeze({ ok: false, code: 'unknown-field', field: name });
    }
    const { id, ...rest } = envelope;
    const record = Object.freeze({
      id,
      type,
      ...definition.model.defaults,
      ...owned,
      ...rest,
      schemaVersion: definition.version,
    });
    const field = definition.model.validate(record);
    if (field !== null) return Object.freeze({ ok: false, code: 'invalid-field', field });
    return Object.freeze({ ok: true, record });
  }

  /**
   * The model a record's type has here, or none. Only an own, exact type matches.
   * @param {any} record
   */
  const modelOf = record => byType.get(record.type)?.model;

  return Object.freeze({
    types: Object.freeze([...byType.keys()]),
    problems,
    definition: (/** @type {string} */ type) => byType.get(type),
    decode,
    encode,
    create,
    project: (kind, record) => (modelOf(record)?.project ?? OPAQUE_PROJECTIONS)[kind](record),
    markdown: record => {
      const model = modelOf(record);
      return model ? model.codecs.markdown.encode(record) : OPAQUE_PROJECTIONS.markdown(record);
    },
  });
}
