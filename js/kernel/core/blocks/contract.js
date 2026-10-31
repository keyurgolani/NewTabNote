/**
 * The block contract (#14, "Contract shape" and approved AC4): what a `block` contribution
 * declares, and the checks a definition has to pass before any record of its type is decoded,
 * projected, or created. The family itself is defined on #15's kit where a root assembles it
 * (js/kernel/composition/blocks.js), since kernel core imports only itself; this module holds
 * the family's spec and the checks, which are pure.
 *
 * A block contribution is a descriptor on the kit with two fields of the family's own:
 * - `fields`: the fields its records own, by kind (fields.js);
 * - `viewVersion`: the model version its view renders, once it has one (slice 4).
 * Its `version` is its model's version, which its records' `schemaVersion` counts to, and its
 * static `implementation` is its model (models.js). The model is static on every host: the
 * worker decodes and projects blocks, and has no `import()`.
 *
 * What the checks find, each naming the definition and what it lacks:
 * - `duplicate-id`: two definitions of one type; neither is used.
 * - `invalid-definition`: an id that isn't one, a version that isn't a positive integer, or a
 *   field map that isn't one.
 * - `missing-capability`: a model without one of MANDATORY_CAPABILITIES.
 * - `upcaster-gap`: a version below the model's with no upcaster to the next.
 * - `view-version-mismatch`: a view for another version of the model.
 * - `model-not-static`: a model behind a lazy loader.
 * A definition with a problem is disabled, and only it: records of its type read as unknown
 * (catalog.js, `decode`), kept verbatim, and every other type works.
 */

import { isFieldMap } from './fields.js';

/** The family's id, which #20's block-types provider reads (js/trust/core/providers/platform.js) */
export const BLOCK_FAMILY = 'block';

/** The groups a block type browses in, as the slash menu will list them (slice 4) */
export const BLOCK_GROUPS = Object.freeze(['text', 'list', 'structure', 'media']);

/**
 * Where block types run: every host #15's kit has (js/kernel/registry/vocabulary.js), spelled
 * out since core can't import the kit. The worker decodes and projects blocks too, and
 * recovery.html's root registers them for the block-health query (#20 slice 4b).
 */
export const BLOCK_HOSTS = Object.freeze(
  /** @type {const} */ (['moment', 'workspace', 'popup', 'sidepanel', 'background', 'pip', 'recovery']),
);

/** The conformance fixture every block contribution declares: its model's examples */
export const BLOCK_FIXTURE = 'block-model';

/** A contribution id, as #15's kit spells one (js/kernel/registry/ids.js) */
const TYPE_ID = /^[a-z][A-Za-z0-9-]*(?:\.[a-z][A-Za-z0-9-]*)*$/;

/** @param {unknown} value */
const isPositiveInteger = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** The most versions a model may have, so a chain of upcasters stays short */
export const MAX_MODEL_VERSION = 64;

/**
 * The spec #15's defineFamily takes for the `block` family
 */
export const BLOCK_FAMILY_SPEC = Object.freeze({
  id: BLOCK_FAMILY,
  apiVersion: 1,
  groups: BLOCK_GROUPS,
  loader: /** @type {'required'} */ ('required'),
  fixtures: Object.freeze([BLOCK_FIXTURE]),
  fields: Object.freeze({
    fields: isFieldMap,
    viewVersion: (/** @type {unknown} */ value) => value === undefined || isPositiveInteger(value),
  }),
});

/**
 * What a model has to have, as paths into it: decode, migration, the projections, and the
 * Markdown codec
 */
export const MANDATORY_CAPABILITIES = Object.freeze([
  'defaults',
  'validate',
  'upcast',
  'project.preview',
  'project.plainText',
  'project.search',
  'project.aiContext',
  'codecs.markdown.encode',
]);

/** The capabilities that are functions; the others are plain objects */
const OBJECT_CAPABILITIES = Object.freeze(['defaults', 'upcast']);

/**
 * The text each diagnostic shows, code-owned like the kit's reasons, so a diagnostic carries
 * nothing a definition wrote but its type id and the path it's about
 * @type {Readonly<Record<string, {message: string, remediation: string}>>}
 */
export const DIAGNOSTICS = Object.freeze({
  'duplicate-id': {
    message: 'Another definition has the same type id.',
    remediation: 'Give each block type its own id; neither is used until then.',
  },
  'invalid-definition': {
    message: "Its id, version, or field map isn't valid.",
    remediation: 'Fix the definition; npm test fails until a built-in is valid.',
  },
  'missing-capability': {
    message: 'Its model lacks a capability every block type has to have.',
    remediation: 'Add the capability the diagnostic names to its model.',
  },
  'upcaster-gap': {
    message: "Its upcasters don't reach its version from every older one.",
    remediation: 'Add the upcaster the diagnostic names, from that version to the next.',
  },
  'view-version-mismatch': {
    message: 'Its view renders another version of its model.',
    remediation: "Update the view to the model's version, or the model's version to the view's.",
  },
  'model-not-static': {
    message: 'Its model loads lazily, but blocks decode where nothing loads lazily.',
    remediation: 'Give it a static implementation; only its view may load lazily.',
  },
  // A kit rule its contribution broke (#15's resolution), as js/kernel/composition/blocks.js reports it
  unresolved: {
    message: 'Its contribution is unresolved on the registry kit.',
    remediation: "Fix what the registry report names for it; npm test fails until a built-in resolves.",
  },
});

/**
 * One thing wrong with a definition, frozen and content-free: its type id (null when it has
 * none), the code, and the path it's about
 * @typedef {Readonly<{type: string | null, code: string, field: string, message: string, remediation: string}>} BlockProblem
 */

/**
 * @param {string | null} type
 * @param {string} code
 * @param {string} field
 * @returns {BlockProblem}
 */
export function blockProblem(type, code, field) {
  const text = DIAGNOSTICS[code];
  return Object.freeze({ type, code, field, message: text.message, remediation: text.remediation });
}

/**
 * The value at a dotted path, or undefined
 * @param {unknown} value
 * @param {string} path
 */
function at(value, path) {
  let here = value;
  for (const key of path.split('.')) {
    if (here === null || typeof here !== 'object' || !Object.hasOwn(here, key)) return undefined;
    here = /** @type {Record<string, unknown>} */ (here)[key];
  }
  return here;
}

/**
 * Everything wrong with one definition on its own, in a fixed order: none when it's valid
 * @param {unknown} descriptor
 * @returns {BlockProblem[]}
 */
export function definitionProblems(descriptor) {
  if (descriptor === null || typeof descriptor !== 'object') return [blockProblem(null, 'invalid-definition', 'id')];
  const d = /** @type {Record<string, unknown>} */ (descriptor);
  const type = typeof d.id === 'string' && TYPE_ID.test(d.id) && d.id.length <= 64 ? d.id : null;
  if (type === null) return [blockProblem(null, 'invalid-definition', 'id')];
  /** @type {BlockProblem[]} */
  const problems = [];
  if (!isPositiveInteger(d.version) || /** @type {number} */ (d.version) > MAX_MODEL_VERSION) {
    problems.push(blockProblem(type, 'invalid-definition', 'version'));
  }
  if (!isFieldMap(d.fields)) problems.push(blockProblem(type, 'invalid-definition', 'fields'));
  if (d.load !== undefined) problems.push(blockProblem(type, 'model-not-static', 'load'));
  const model = d.implementation;
  for (const capability of MANDATORY_CAPABILITIES) {
    const value = at(model, capability);
    const ok = OBJECT_CAPABILITIES.includes(capability)
      ? value !== null && typeof value === 'object'
      : typeof value === 'function';
    if (!ok) problems.push(blockProblem(type, 'missing-capability', capability));
  }
  const upcast = at(model, 'upcast');
  if (upcast !== null && typeof upcast === 'object' && isPositiveInteger(d.version)) {
    for (let from = 0; from < /** @type {number} */ (d.version); from++) {
      if (typeof at(upcast, String(from)) !== 'function') problems.push(blockProblem(type, 'upcaster-gap', `upcast.${from}`));
    }
  }
  if (d.viewVersion !== undefined && d.viewVersion !== d.version) {
    problems.push(blockProblem(type, 'view-version-mismatch', 'viewVersion'));
  }
  return problems;
}

/**
 * A descriptor's id when it has a string one
 * @param {unknown} descriptor
 * @returns {string | null}
 */
function idOf(descriptor) {
  if (descriptor === null || typeof descriptor !== 'object') return null;
  const id = /** @type {{id?: unknown}} */ (descriptor).id;
  return typeof id === 'string' ? id : null;
}

/**
 * The problems in a list of definitions: each one's own, and every definition of a type
 * another one has too
 * @param {readonly unknown[]} descriptors
 * @returns {BlockProblem[]}
 */
export function definitionsProblems(descriptors) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const descriptor of descriptors) {
    const id = idOf(descriptor);
    if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  /** @type {BlockProblem[]} */
  const problems = [];
  /** @type {Set<string>} */
  const reported = new Set();
  for (const descriptor of descriptors) {
    const own = definitionProblems(descriptor);
    const id = idOf(descriptor);
    if (typeof id === 'string' && (counts.get(id) ?? 0) > 1) {
      if (!reported.has(id)) problems.push(blockProblem(id, 'duplicate-id', 'id'));
      reported.add(id);
      continue;
    }
    problems.push(...own);
  }
  return problems;
}
