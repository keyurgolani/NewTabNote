/**
 * Descriptor validation (#15, approved AC2): one descriptor against its family's contract, on
 * its own. What needs the other descriptors (duplicate ids, equal group and rank, chord
 * collisions, `requires` cycles and gaps) is resolve.js's. Validation never throws for a bad
 * descriptor: it returns the problems, and the contribution resolves as `unresolved` with the
 * first one as its reason, so one bad contribution can't take its root down. A family's
 * conformance suite fails `npm test` on any problem in a built-in.
 *
 * A descriptor is static data: its id, `version` (the contribution's own, a positive
 * integer), `apiVersion` (the family contract major it targets), `group` and integer `rank`,
 * `hosts`, `requires`, `label`, `description`, `keywords`, `icon`, `accessibility`, the
 * permission fields, `chords` where the family allows them, `fixtures`, `notImplemented`, and
 * its family's own fields. Beside the data it may carry a lazy `load` (which resolves to the
 * implementation, usually through import()), or a statically imported `implementation`, and a
 * `probe`.
 */

import { checkChords } from './chords.js';
import { COMMON_FIELDS } from './family.js';
import { frozenCopy, isPlainData } from './data.js';
import { MAX_ID_LENGTH, isId, parseRef } from './ids.js';
import { AI_SCOPES, LIMITS } from './vocabulary.js';

/** @typedef {import('./family.js').Family} Family */
/** @typedef {import('./vocabulary.js').Host} Host */
/** @typedef {import('./chords.js').Platform} Platform */

/**
 * A probe answers whether a resolved contribution can run, from the injected context only.
 * @typedef {(context: Readonly<Record<string, unknown>>) => unknown} Probe
 */

/**
 * A descriptor as a family module declares it. Family fields sit beside the shared ones.
 * @typedef {{
 *   id: string,
 *   version: number,
 *   apiVersion: number,
 *   group: string,
 *   rank: number,
 *   hosts: readonly Host[],
 *   label: string,
 *   requires?: readonly string[],
 *   description?: string,
 *   keywords?: readonly string[],
 *   icon?: string,
 *   accessibility?: Readonly<{label?: string, landmark?: string, keyboard?: string}>,
 *   chromePermissions?: readonly string[],
 *   aiScopes?: readonly import('./vocabulary.js').AiScope[],
 *   destinations?: readonly string[],
 *   authorization?: string,
 *   load?: () => unknown,
 *   implementation?: unknown,
 *   probe?: Probe,
 *   chords?: Readonly<Partial<Record<'default' | Platform, readonly string[]>>>,
 *   fixtures?: readonly string[],
 *   notImplemented?: boolean,
 * } & {[field: string]: unknown}} Descriptor
 */

/**
 * One thing wrong with a descriptor: a reason code from reasons.js, and the field it's about
 * @typedef {Readonly<{code: string, field: string}>} Problem
 */

/**
 * What resolution needs from one descriptor once it's checked. `id` is null when it isn't a
 * valid id, and `ordered` is false when the group or rank can't be compared.
 * @typedef {object} Checked
 * @property {readonly Problem[]} problems
 * @property {string | null} id
 * @property {string | null} rawId the id as written, for the report, when it's a string no longer than an id
 * @property {number | null} version
 * @property {boolean} compatible
 * @property {boolean} ordered
 * @property {number} groupIndex
 * @property {number} rank
 * @property {readonly Host[]} hosts
 * @property {readonly {family: string, id: string}[]} requires
 * @property {Readonly<Record<Platform, readonly string[]>> | null} pressed
 * @property {boolean} privileged
 * @property {boolean} notImplemented
 * @property {(() => unknown) | null} load
 * @property {{value: unknown} | null} implementation
 * @property {Probe | null} probe
 * @property {Readonly<Record<string, unknown>>} data the static fields, frozen
 */

const ACCESSIBILITY_FIELDS = ['label', 'landmark', 'keyboard'];

/**
 * @param {unknown} value
 * @returns {value is string}
 */
const isText = value => typeof value === 'string' && value.trim() !== '' && value.length <= LIMITS.textLength;

/**
 * @param {unknown} value
 * @param {(item: unknown) => boolean} check
 * @param {number} [max]
 * @returns {value is unknown[]}
 */
const isListOf = (value, check, max = Infinity) =>
  Array.isArray(value) && value.length <= max && value.every(check) && new Set(value).size === value.length;

/**
 * @param {unknown} value
 */
const isPositiveInteger = value => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 1;

/**
 * Check one descriptor against its family
 * @param {Family} family
 * @param {unknown} descriptor
 * @returns {Checked}
 */
export function checkDescriptor(family, descriptor) {
  /** @type {Problem[]} */
  const problems = [];
  const add = (/** @type {string} */ code, /** @type {string} */ field) =>
    problems.push(Object.freeze({ code, field }));

  /** @type {Checked} */
  const checked = {
    problems,
    id: null,
    rawId: null,
    version: null,
    compatible: false,
    ordered: false,
    groupIndex: -1,
    rank: 0,
    hosts: [],
    requires: [],
    pressed: null,
    privileged: false,
    notImplemented: false,
    load: null,
    implementation: null,
    probe: null,
    data: Object.freeze({}),
  };

  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    add('invalid-descriptor', '');
    return checked;
  }
  const d = /** @type {Record<string, unknown>} */ (descriptor);
  if (typeof d.id === 'string' && d.id.length <= MAX_ID_LENGTH) checked.rawId = d.id;

  // Identity and version come first: an id names the contribution in every other problem,
  // and a descriptor written for another contract version can't be read against this one
  if (isId(d.id, { paths: family.pathIds })) checked.id = d.id;
  else add('invalid-id', 'id');
  if (isPositiveInteger(d.version)) checked.version = /** @type {number} */ (d.version);
  else add('invalid-version', 'version');
  if (!isPositiveInteger(d.apiVersion)) add('invalid-version', 'apiVersion');
  else if (d.apiVersion !== family.apiVersion) {
    add('incompatible-api-version', 'apiVersion');
    return checked;
  } else {
    checked.compatible = true;
  }

  for (const field of Object.keys(d)) {
    if (!COMMON_FIELDS.includes(field) && !Object.hasOwn(family.fields, field)) add('unknown-field', field);
  }

  const groupIndex = typeof d.group === 'string' ? family.groups.indexOf(d.group) : -1;
  if (groupIndex === -1) add('invalid-order', 'group');
  if (!Number.isSafeInteger(d.rank)) add('invalid-order', 'rank');
  if (groupIndex !== -1 && Number.isSafeInteger(d.rank)) {
    checked.ordered = true;
    checked.groupIndex = groupIndex;
    checked.rank = /** @type {number} */ (d.rank);
  }

  if (isListOf(d.hosts, host => family.hosts.includes(/** @type {Host} */ (host))) && d.hosts.length > 0) {
    checked.hosts = Object.freeze(/** @type {Host[]} */ ([...d.hosts]));
  } else {
    add('invalid-host', 'hosts');
  }

  const requires = d.requires ?? [];
  const refs = Array.isArray(requires) ? requires.map(entry => parseRef(entry, family.id)) : [];
  if (isListOf(requires, () => true, LIMITS.requires) && refs.every(ref => ref !== null)) {
    checked.requires = Object.freeze(
      /** @type {{family: string, id: string}[]} */ (refs).map(ref => Object.freeze(ref)),
    );
  } else {
    add('invalid-requires', 'requires');
  }

  if (!isText(d.label)) add('invalid-text', 'label');
  if (d.description === undefined ? family.requireDescription : !isText(d.description))
    add('invalid-text', 'description');
  if (d.keywords !== undefined && !isListOf(d.keywords, isText, LIMITS.keywords)) add('invalid-text', 'keywords');
  if (d.icon !== undefined && !isId(d.icon)) add('invalid-text', 'icon');
  if (d.accessibility !== undefined) {
    const a11y = d.accessibility;
    const valid =
      a11y !== null &&
      typeof a11y === 'object' &&
      !Array.isArray(a11y) &&
      Object.entries(a11y).every(([key, value]) => ACCESSIBILITY_FIELDS.includes(key) && isText(value));
    if (!valid) add('invalid-text', 'accessibility');
  }

  checkPermissions(family, d, checked, add);

  if (d.notImplemented !== undefined && typeof d.notImplemented !== 'boolean')
    add('invalid-descriptor', 'notImplemented');
  checked.notImplemented = d.notImplemented === true;
  checkLoader(family, d, checked, add);
  if (d.probe !== undefined) {
    if (typeof d.probe === 'function') checked.probe = /** @type {Probe} */ (d.probe);
    else add('invalid-probe', 'probe');
  }

  if (d.chords !== undefined) {
    if (!family.chords) add('unknown-field', 'chords');
    else {
      const result = checkChords(d.chords, LIMITS.chordsPerPlatform);
      if (result.ok) checked.pressed = result.pressed;
      else add(result.code, 'chords');
    }
  }

  const fixtures = d.fixtures ?? [];
  if (!isListOf(fixtures, item => isId(item), LIMITS.fixtures)) add('invalid-descriptor', 'fixtures');
  else if (!family.fixtures.every(name => fixtures.includes(name))) add('missing-fixture', 'fixtures');

  for (const [field, check] of Object.entries(family.fields)) {
    const value = d[field];
    let ok = false;
    try {
      ok = (value === undefined || isPlainData(value)) && check(value) === true;
    } catch {
      ok = false;
    }
    if (!ok) add('invalid-field', field);
  }

  /** @type {Record<string, unknown>} */
  const data = {};
  for (const field of [...COMMON_FIELDS, ...Object.keys(family.fields)]) {
    if (['load', 'implementation', 'probe'].includes(field) || d[field] === undefined) continue;
    if (isPlainData(d[field])) data[field] = frozenCopy(d[field]);
  }
  checked.data = Object.freeze(data);
  return checked;
}

/**
 * The permission fields, within the family's ceilings. Chrome permissions are checked with
 * chrome.permissions.contains by the root that runs the contribution, so only `background`
 * contributions declare them.
 * @param {Family} family
 * @param {Record<string, unknown>} d
 * @param {Checked} checked
 * @param {(code: string, field: string) => void} add
 */
function checkPermissions(family, d, checked, add) {
  const names = /** @type {const} */ (['chromePermissions', 'aiScopes', 'destinations']);
  let unauthorized = false;
  for (const name of names) {
    const list = d[name] ?? [];
    const valid = isListOf(list, item => typeof item === 'string' && item !== '');
    if (!valid || (name === 'aiScopes' && !list.every(scope => AI_SCOPES.includes(/** @type {any} */ (scope))))) {
      add('invalid-permissions', name);
      continue;
    }
    const ceiling = /** @type {readonly string[]} */ (family.ceilings[name]);
    if (!list.every(item => ceiling.includes(/** @type {string} */ (item)))) {
      add('unauthorized', name);
      unauthorized = true;
    }
  }
  const chromePermissions = d.chromePermissions;
  if (!unauthorized && Array.isArray(chromePermissions) && chromePermissions.length > 0) {
    if (!Array.isArray(d.hosts) || d.hosts.some(host => host !== 'background'))
      add('unauthorized', 'chromePermissions');
  }
  if (d.authorization !== undefined && !isId(d.authorization)) add('invalid-permissions', 'authorization');

  const destinations = Array.isArray(d.destinations) ? d.destinations : [];
  const aiScopes = Array.isArray(d.aiScopes) ? d.aiScopes : [];
  checked.privileged = destinations.length > 0 || aiScopes.some(scope => scope !== 'metadata');
}

/**
 * The loader rules: a lazy `load` or a static `implementation`, never both; what the family
 * says about having one; and no lazy loader on `background`, since #12's module worker can't
 * import() and registers its listeners synchronously at top level. A placeholder needs no
 * implementation.
 * @param {Family} family
 * @param {Record<string, unknown>} d
 * @param {Checked} checked
 * @param {(code: string, field: string) => void} add
 */
function checkLoader(family, d, checked, add) {
  const hasLoad = d.load !== undefined;
  const hasImplementation = d.implementation !== undefined;
  if (hasLoad && typeof d.load !== 'function') add('invalid-loader', 'load');
  if (hasImplementation && (d.implementation === null || !['object', 'function'].includes(typeof d.implementation))) {
    add('invalid-loader', 'implementation');
  }
  if (hasLoad && hasImplementation) add('invalid-loader', 'load');
  if (family.loader === 'none' && (hasLoad || hasImplementation))
    add('invalid-loader', hasLoad ? 'load' : 'implementation');
  if (family.loader === 'required' && !hasLoad && !hasImplementation && d.notImplemented !== true)
    add('missing-loader', 'load');
  if (hasLoad && Array.isArray(d.hosts) && d.hosts.includes('background')) add('dynamic-loader-on-background', 'load');
  if (typeof d.load === 'function' && !hasImplementation) checked.load = /** @type {() => unknown} */ (d.load);
  if (hasImplementation && !hasLoad && d.implementation !== null) checked.implementation = { value: d.implementation };
}
