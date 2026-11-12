/**
 * The states catalog (#26, "Registries"): strings by message key, chunked per feature, with typed
 * safe parameters only, a count, a subsystem, a user-registered host and, in product UI only, a
 * note title. A chunk is one descriptor on #15's kit: the first key segments its strings hold, the
 * parameters each string declares, and a lazy `load`. A chunk on `background` loads eagerly
 * instead, since the kit refuses a dynamic loader there, and never declares a title.
 *
 * format fills a string's placeholders and refuses anything else, and chunkProblems holds a loaded
 * chunk's strings to its descriptor, so the tests and `npm run check:states` can.
 */

import { defineFamily } from '../../kernel/registry/family.js';
import { isId } from '../../kernel/registry/ids.js';
import { isMessageKey } from './vocabulary.js';

/** The safe parameter types: a count, a subsystem's id, a user-registered host, and a note title */
export const PARAMETER_TYPES = Object.freeze(/** @type {const} */ (['count', 'subsystem', 'host', 'title']));

/** Who brings a chunk: the kernel's, a surface's such as Moment's, or a feature's */
export const CHUNK_GROUPS = Object.freeze(/** @type {const} */ (['kernel', 'surface', 'feature']));

/** The longest note title a string may show, and the longest string */
export const TITLE_MAX = 80;
export const TEXT_MAX = 240;

const PLACEHOLDER = /\{([a-z][a-zA-Z0-9]*)\}/g;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;
const CONTROL = /\p{Cc}/u;

/**
 * A success word, which only a ready or committed key's string may hold as a claim, and an
 * action's label as what the action does
 */
const SUCCESS = /\b(?:saved|synced|verified|connected|complete|exported)\b/gi;
/** What before a success word in its sentence makes it no claim: a negation, or "whether" */
const NOT_A_CLAIM = /(?:\b(?:not|never|whether)\b|n't\b)[^.!?]*$/i;
const CLAIM_KEY = /(?:^|\.)(?:ready|committed)(?:\.|$)/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value */
const isType = value =>
  typeof value === 'string' && /** @type {readonly string[]} */ (PARAMETER_TYPES).includes(value);
/**
 * @param {object} object
 * @param {string} name
 */
const owns = (object, name) => Object.prototype.hasOwnProperty.call(object, name);

/**
 * Whether `value` lists the first key segments a chunk holds, each once
 * @param {unknown} value
 */
const isSegments = value =>
  Array.isArray(value) && value.length > 0 && value.every(item => isId(item)) && new Set(value).size === value.length;

export const catalog = defineFamily({
  id: 'catalog',
  apiVersion: 1,
  groups: CHUNK_GROUPS,
  loader: 'required',
  fields: {
    holds: isSegments,
    parameters: value =>
      isRecord(value) &&
      Object.entries(value).every(
        ([key, names]) => isMessageKey(key) && isRecord(names) && Object.values(names).every(isType),
      ),
    owner: value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 1000,
  },
});

/**
 * The names of a string's placeholders, each once, in order
 * @param {string} text
 */
export const placeholders = text => [...new Set([...text.matchAll(PLACEHOLDER)].map(match => match[1]))];

/**
 * How a value of `type` shows, or null when it's refused
 * @param {string} type
 * @param {unknown} value
 * @param {string} host
 */
function shown(type, value, host) {
  if (type === 'count') {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (type === 'subsystem') return isId(value) ? /** @type {string} */ (value) : null;
  if (type === 'host') return typeof value === 'string' && HOSTNAME.test(value) ? value : null;
  if (type !== 'title' || host === 'background' || typeof value !== 'string') return null;
  return value.trim() !== '' && value.length <= TITLE_MAX && !CONTROL.test(value) ? value : null;
}

/**
 * A catalog string with its placeholders filled, or null when a value is refused: one of the wrong
 * type, an object, text over its cap, a note title on `background`, or a placeholder the string
 * doesn't declare. A value for a name the string doesn't use is left out.
 * @param {string} text
 * @param {Readonly<Record<string, string>>} declared - the string's parameters, by name
 * @param {Readonly<Record<string, unknown>>} values
 * @param {string} host
 * @returns {string | null}
 */
export function format(text, declared, values, host) {
  let refused = false;
  const filled = text.replace(PLACEHOLDER, (_, /** @type {string} */ name) => {
    const value = owns(declared, name) && owns(values, name) ? shown(declared[name], values[name], host) : null;
    if (value === null) refused = true;
    return value ?? '';
  });
  return refused ? null : filled;
}

/**
 * Whether `text` claims a success: a success word that no negation or "whether" before it, in its
 * sentence, takes back
 * @param {string} text
 */
export const claimsSuccess = text =>
  [...text.matchAll(SUCCESS)].some(match => !NOT_A_CLAIM.test(text.slice(0, match.index ?? 0)));

/** @typedef {Readonly<Record<string, Readonly<Record<string, string>>>>} Parameters */

/**
 * What's wrong with a loaded chunk's strings against its descriptor: a key outside what it holds
 * or not a message key, a string that's blank or over the cap, placeholders that aren't exactly
 * the declared parameters, a declared string it lacks, a title on a chunk `background` loads, and
 * a success claim outside a ready or committed key or an action's label. Each as `problem: key`,
 * empty when it has none.
 * @param {{holds: readonly string[], parameters: Parameters, hosts: readonly string[]}} chunk
 * @param {Readonly<Record<string, unknown>>} strings
 * @returns {string[]}
 */
export function chunkProblems({ holds, parameters, hosts }, strings) {
  /** @type {string[]} */
  const problems = [];
  for (const [key, text] of Object.entries(strings)) {
    if (!isMessageKey(key) || !holds.includes(key.split('.')[0])) problems.push(`outside-holds: ${key}`);
    if (typeof text !== 'string' || text.trim() === '' || text.length > TEXT_MAX) {
      problems.push(`invalid-text: ${key}`);
      continue;
    }
    const declared = Object.keys(parameters[key] ?? {});
    if (placeholders(text).sort().join() !== declared.sort().join()) problems.push(`placeholders: ${key}`);
    if (claimsSuccess(text) && !CLAIM_KEY.test(key) && !key.startsWith('action.')) {
      problems.push(`success-word: ${key}`);
    }
  }
  for (const [key, names] of Object.entries(parameters)) {
    if (!owns(strings, key)) problems.push(`declared-missing: ${key}`);
    if (hosts.includes('background') && Object.values(names).includes('title')) {
      problems.push(`title-on-background: ${key}`);
    }
  }
  return problems;
}
