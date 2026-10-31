/**
 * What each remediation class needs before apply (#20, "Remediation pipeline"; approved AC4,
 * "every destructive or irreversible remediation previews impact, requires appropriate
 * confirmation, and creates or verifies a recovery path first"):
 * - non-destructive (inspect, retry, export, safe-disable): nothing extra.
 * - regenerable (rebuild or remove derived data): its preview, and the user's confirmation.
 * - reversible (recover or discard orphans, repair, restore): its preview, the confirmation,
 *   and a verified #17 recovery point taken in the run.
 * - irreversible (delete a recovery point or a legacy copy, reset): its preview, a recovery
 *   file saved in this run and read back verified, and the action's name typed out.
 * The confirmation and the typed words arrive in recovery.run's payload, which slice 4's
 * views fill from a click, and neither is ever stored.
 */

/** @typedef {import('../vocabulary.js').RemediationClass} RemediationClass */
/** @typedef {import('../vocabulary.js').Protection} Protection */

/** @type {Readonly<Record<RemediationClass, readonly Protection[]>>} */
export const CLASS_PROTECTIONS = Object.freeze({
  'non-destructive': Object.freeze([]),
  regenerable: Object.freeze(/** @type {Protection[]} */ (['confirmation'])),
  reversible: Object.freeze(/** @type {Protection[]} */ (['confirmation', 'recovery-point'])),
  irreversible: Object.freeze(/** @type {Protection[]} */ (['confirmation', 'recovery-file', 'typed-phrase'])),
});

/**
 * Whether a class waits for the user after its preview
 * @param {RemediationClass} remediationClass
 */
export const needsConfirmation = remediationClass => CLASS_PROTECTIONS[remediationClass].includes('confirmation');

/**
 * Typed words as they're compared: trimmed, spaces run together, and case folded
 * @param {unknown} words
 */
const normalized = words =>
  typeof words === 'string' ? words.trim().replace(/\s+/g, ' ').toLowerCase() : '';

/**
 * The user's part of the gate, checked before anything is protected: the confirmation, and for
 * an irreversible run the action's name typed out
 * @param {RemediationClass} remediationClass
 * @param {{decision?: 'confirm' | 'cancel', typedPhrase?: string}} given
 * @param {string | undefined} phrase - the words the remediation is confirmed by
 * @returns {{ok: true} | {ok: false, code: 'not-confirmed' | 'phrase-mismatch'}}
 */
export function checkConsent(remediationClass, given, phrase) {
  const needs = CLASS_PROTECTIONS[remediationClass];
  if (needs.includes('confirmation') && given.decision !== 'confirm') return { ok: false, code: 'not-confirmed' };
  if (needs.includes('typed-phrase')) {
    const expected = normalized(phrase);
    // A remediation that names no words can't be confirmed by any
    if (expected === '' || normalized(given.typedPhrase) !== expected) return { ok: false, code: 'phrase-mismatch' };
  }
  return { ok: true };
}

/**
 * What the run made, checked right before apply: the verified recovery point a reversible run
 * needs, and the recovery file an irreversible one saved and read back in this run
 * @param {RemediationClass} remediationClass
 * @param {{pointVerified?: boolean, fileSavedAt?: number}} made
 * @returns {{ok: true} | {ok: false, code: 'no-recovery-point' | 'file-not-saved'}}
 */
export function checkProtected(remediationClass, made) {
  const needs = CLASS_PROTECTIONS[remediationClass];
  if (needs.includes('recovery-point') && made.pointVerified !== true) return { ok: false, code: 'no-recovery-point' };
  if (needs.includes('recovery-file') && typeof made.fileSavedAt !== 'number') {
    return { ok: false, code: 'file-not-saved' };
  }
  return { ok: true };
}
