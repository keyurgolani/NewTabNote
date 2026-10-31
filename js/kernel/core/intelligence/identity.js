/**
 * A signal's stable identity (#7, "Records and identity"). A signal's `id` is the SHA-256, in
 * lowercase hex, of the UTF-8 JSON array `[producerId, noteId, anchorBlockId or null,
 * subjectKey]`. Nothing else goes in: not the producer's version, the model, or the source's
 * revision, so an edit to the source or an upgrade of whatever produced it keeps the id, and
 * the user's decision and corrections stay attached to it. #18 (backup) calls this too.
 *
 * Deterministic producers use fixed subject keys (`task`, `pinned`). #8's recipes bring their
 * own, normalized by the normalizer #8 lands with.
 */

import { digestOf } from '../memory/fingerprint.js';

/** What `signalIdOf` hashes: [producerId, noteId, anchorBlockId or null, subjectKey] */
/** @typedef {readonly [string, string, string | null, string]} IdentityTuple */

/**
 * The parts of a signal's identity, as its records store them beside its id
 * @typedef {{producerId: string, noteId: string, anchorBlockId: string | null, subjectKey: string}} Identity
 */

/** A signal id: 64 lowercase hex digits */
export const SIGNAL_ID = /^[0-9a-f]{64}$/;

/** The fixed subject keys of the deterministic producers */
export const SUBJECT_KEYS = Object.freeze({ task: 'task', pinned: 'pinned' });

/**
 * @param {unknown} value
 * @returns {value is string}
 */
const isPart = value => typeof value === 'string' && value !== '';

/**
 * The id of the signal `tuple` names. Its digest is of the JSON array exactly as written: an
 * array of strings and null has no keys to sort, so it's the canonical JSON as it stands.
 * @param {IdentityTuple} tuple
 * @returns {string}
 */
export function signalIdOf(tuple) {
  if (!Array.isArray(tuple) || tuple.length !== 4) throw new TypeError('an identity is four parts');
  const [producerId, noteId, anchorBlockId, subjectKey] = tuple;
  if (
    !isPart(producerId) ||
    !isPart(noteId) ||
    !isPart(subjectKey) ||
    !(anchorBlockId === null || isPart(anchorBlockId))
  ) {
    throw new TypeError('an identity names a producer, a note, an anchor block or null, and a subject');
  }
  return digestOf([producerId, noteId, anchorBlockId, subjectKey]);
}

/**
 * The tuple an identity hashes
 * @param {Identity} identity
 * @returns {IdentityTuple}
 */
export function tupleOf({ producerId, noteId, anchorBlockId, subjectKey }) {
  return [producerId, noteId, anchorBlockId, subjectKey];
}

/**
 * The id of the signal `identity` names
 * @param {Identity} identity
 * @returns {string}
 */
export function idOfIdentity(identity) {
  return signalIdOf(tupleOf(identity));
}
