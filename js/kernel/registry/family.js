/**
 * A family contract (#15, "Kit"): what one capability's contributions may declare. Every
 * family is built on this one primitive and shares only identity, version, validation,
 * ordering, lifecycle, availability, and diagnostics with the others. There's no universal
 * plugin object: a family adds its own fields, with a check for each, and nothing else.
 *
 * A family sets the ceiling on the Chrome permissions, AI scopes, and destinations its
 * contributions may ask for. A contribution that asks for more is unresolved. A contract that
 * breaks a rule here is a programming error, so defineFamily throws.
 */

import { isId } from './ids.js';
import { PROBE_STATES, REASONS } from './reasons.js';
import { AI_SCOPES, HOSTS, LIMITS } from './vocabulary.js';

/** @typedef {import('./vocabulary.js').Host} Host */
/** @typedef {import('./vocabulary.js').AiScope} AiScope */
/** @typedef {import('./reasons.js').Reason} Reason */
/** @typedef {import('./reasons.js').ProbeState} ProbeState */

/**
 * The most a family's contributions may ask for. `chromePermissions` names manifest
 * permissions, which only `background` contributions may declare; `destinations` names where
 * data may go, which only sync and #9's and #11's families allow.
 * @typedef {Readonly<{
 *   chromePermissions: readonly string[],
 *   aiScopes: readonly AiScope[],
 *   destinations: readonly string[],
 * }>} Ceilings
 */

/**
 * A family as defineFamily takes it.
 * - `apiVersion`: the contract's major version; a contribution targets exactly one.
 * - `groups`: its semantic groups in browse order. Browse order is group, then integer rank.
 * - `hosts`: where its contributions may run, all of them when left out.
 * - `pathIds`: whether ids may join segments with `/`, as navigation's do.
 * - `chords`: whether contributions may bind keyboard chords.
 * - `loader`: whether a contribution needs a loader or implementation, may have one, or has none.
 * - `requireDescription`: whether every contribution needs a description, as palette entries do.
 * - `fixtures`: the conformance fixtures every contribution has to declare.
 * - `fields`: the family's own descriptor fields, each with a check of its static value.
 * - `reasons`: the family's own probe reasons, by code, with code-owned text.
 * @typedef {object} FamilySpec
 * @property {string} id
 * @property {number} apiVersion
 * @property {readonly string[]} groups
 * @property {readonly Host[]} [hosts]
 * @property {Partial<Ceilings>} [ceilings]
 * @property {boolean} [pathIds]
 * @property {boolean} [chords]
 * @property {'required' | 'optional' | 'none'} [loader]
 * @property {boolean} [requireDescription]
 * @property {readonly string[]} [fixtures]
 * @property {Readonly<Record<string, (value: unknown) => boolean>>} [fields]
 * @property {Readonly<Record<string, {state: ProbeState, message: string, remediation: string}>>} [reasons]
 */

/**
 * @typedef {Readonly<{
 *   id: string,
 *   apiVersion: number,
 *   groups: readonly string[],
 *   hosts: readonly Host[],
 *   ceilings: Ceilings,
 *   pathIds: boolean,
 *   chords: boolean,
 *   loader: 'required' | 'optional' | 'none',
 *   requireDescription: boolean,
 *   fixtures: readonly string[],
 *   fields: Readonly<Record<string, (value: unknown) => boolean>>,
 *   reasons: Readonly<Record<string, Reason>>,
 * }>} Family
 */

/** Descriptor fields every family shares, which a family's own fields can't reuse */
export const COMMON_FIELDS = Object.freeze([
  'id',
  'version',
  'apiVersion',
  'group',
  'rank',
  'hosts',
  'requires',
  'label',
  'description',
  'keywords',
  'icon',
  'accessibility',
  'chromePermissions',
  'aiScopes',
  'destinations',
  'authorization',
  'load',
  'implementation',
  'probe',
  'chords',
  'fixtures',
  'notImplemented',
]);

/** @type {WeakSet<object>} */
const DEFINED = new WeakSet();

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
const isStringList = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item !== '');

/**
 * @param {readonly unknown[]} list
 */
const isUnique = list => new Set(list).size === list.length;

/**
 * Check a family contract and freeze it
 * @param {FamilySpec} spec
 * @returns {Family}
 */
export function defineFamily(spec) {
  const fail = (/** @type {string} */ why) => {
    throw new TypeError(`registry family ${spec && typeof spec.id === 'string' ? spec.id : '(unnamed)'}: ${why}`);
  };
  if (!spec || typeof spec !== 'object') fail('needs a contract object');
  if (!isId(spec.id)) fail('needs an id that matches the contribution id rule');
  if (!Number.isSafeInteger(spec.apiVersion) || spec.apiVersion < 1) fail('needs an apiVersion of 1 or more');
  if (!Array.isArray(spec.groups) || spec.groups.length === 0 || !spec.groups.every(group => isId(group))) {
    fail('needs at least one group, each an id');
  }
  if (!isUnique(spec.groups)) fail('lists a group twice');

  const hosts = spec.hosts ?? HOSTS;
  if (!Array.isArray(hosts) || hosts.length === 0 || !hosts.every(host => HOSTS.includes(host)) || !isUnique(hosts)) {
    fail(`needs hosts from ${HOSTS.join(', ')}, each once`);
  }

  const ceilings = { chromePermissions: [], aiScopes: [], destinations: [], ...spec.ceilings };
  for (const [name, list] of Object.entries(ceilings)) {
    if (!['chromePermissions', 'aiScopes', 'destinations'].includes(name))
      fail(`has a ceiling the kit doesn't define: ${name}`);
    if (!isStringList(list) || !isUnique(list)) fail(`needs ${name} as a list of names, each once`);
  }
  if (!ceilings.aiScopes.every(scope => AI_SCOPES.includes(scope)))
    fail(`may only allow AI scopes from ${AI_SCOPES.join(', ')}`);
  if (!ceilings.destinations.every(destination => isId(destination))) fail('needs destination ids');
  if (ceilings.chromePermissions.length > 0 && !hosts.includes('background')) {
    fail('allows Chrome permissions, which only background contributions may declare, but not the background host');
  }

  const loader = spec.loader ?? 'optional';
  if (!['required', 'optional', 'none'].includes(loader)) fail('needs loader to be required, optional, or none');

  const fixtures = spec.fixtures ?? [];
  if (!Array.isArray(fixtures) || !fixtures.every(name => isId(name)) || !isUnique(fixtures))
    fail('needs fixture ids, each once');
  if (fixtures.length > LIMITS.fixtures) fail(`requires more than ${LIMITS.fixtures} fixtures`);

  const fields = spec.fields ?? {};
  for (const [name, check] of Object.entries(fields)) {
    if (COMMON_FIELDS.includes(name)) fail(`redefines the shared field ${name}`);
    if (typeof check !== 'function') fail(`needs a check function for its field ${name}`);
  }

  /** @type {Record<string, Reason>} */
  const reasons = {};
  for (const [code, reason] of Object.entries(spec.reasons ?? {})) {
    if (!isId(code)) fail(`has a reason code that isn't an id: ${code}`);
    if (Object.hasOwn(REASONS, code)) fail(`redefines the kit's reason ${code}`);
    if (!reason || !PROBE_STATES.includes(reason.state) || reason.state === 'enabled') {
      fail(`needs reason ${code} to name a state a probe can answer other than enabled`);
    }
    if (typeof reason.message !== 'string' || reason.message === '' || typeof reason.remediation !== 'string') {
      fail(`needs reason ${code} to have a message and a remediation`);
    }
    reasons[code] = Object.freeze({ state: reason.state, message: reason.message, remediation: reason.remediation });
  }

  /** @type {Family} */
  const family = Object.freeze({
    id: spec.id,
    apiVersion: spec.apiVersion,
    groups: Object.freeze([...spec.groups]),
    hosts: Object.freeze([...hosts]),
    ceilings: Object.freeze({
      chromePermissions: Object.freeze([...ceilings.chromePermissions]),
      aiScopes: Object.freeze([...ceilings.aiScopes]),
      destinations: Object.freeze([...ceilings.destinations]),
    }),
    pathIds: spec.pathIds === true,
    chords: spec.chords === true,
    loader,
    requireDescription: spec.requireDescription === true,
    fixtures: Object.freeze([...fixtures]),
    fields: Object.freeze({ ...fields }),
    reasons: Object.freeze(reasons),
  });
  DEFINED.add(family);
  return family;
}

/**
 * Whether `value` came from defineFamily
 * @param {unknown} value
 * @returns {value is Family}
 */
export function isFamily(value) {
  return typeof value === 'object' && value !== null && DEFINED.has(value);
}
