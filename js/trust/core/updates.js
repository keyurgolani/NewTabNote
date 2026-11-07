/**
 * An update to how notes are stored, as every page reads it (the design review's change 9): the
 * update state storage's fault or receipt stands for, what says why it's there, and whether it's
 * waiting. An update that's waiting needs no one, as the worker finishes it on its own, so it
 * counts as attention nowhere: not in the Trust Center's rows (ui/model.js) and not in
 * trust.summary's Needs action (summary.js), which read it by this one rule (#20 slice 4c).
 *
 * It imports nothing, so a page that only shows status loads it with the summary and no more.
 */

/** @typedef {import('./records.js').HealthReceipt} HealthReceipt */
/** @typedef {import('./records.js').Incident} Incident */

/**
 * The update state storage's fault `faultCode` stands for, as the consequence its words are
 * under, or null for any other fault. `evidence` says why: a blocked update is a wait for free
 * space when the run said so (`space-short`), and any other wait, such as an upgrade waiting on
 * another connection, reads as waiting (#20 slice 4d says what to do about that one). With
 * nothing that says why (null), as after a later check's receipt took the update's place, a
 * blocked update reads as the wait for free space, which needs the user (#115's high review)
 * @param {string} faultCode
 * @param {Readonly<Record<string, unknown>> | null} evidence - whyOf's
 * @returns {string | null}
 */
export function updateKeyOf(faultCode, evidence) {
  if (faultCode === 'migration-blocked') {
    return evidence && evidence.errorCode !== 'space-short' ? 'storage.migration-pending' : 'storage.migration-blocked';
  }
  if (faultCode === 'migration-pending' || faultCode === 'migration-failed') return `storage.${faultCode}`;
  return null;
}

/**
 * The update state a storage receipt reports, or null
 * @param {HealthReceipt | null} receipt
 */
export function updateOf(receipt) {
  const key = receipt && receipt.consequenceKey;
  if (!key || !key.startsWith('storage.migration-')) return null;
  return updateKeyOf(key.slice('storage.'.length), /** @type {Record<string, unknown>} */ (receipt.evidence || {}));
}

/**
 * What says why storage's update is where it is: its latest receipt's evidence when that receipt
 * reports the update, with the incident's own over it, or null when neither says anything. A
 * check's incidents carry no evidence of their own (checks.js), and a later check's receipt that
 * isn't the update's, such as one that timed out, says nothing about it
 * @param {HealthReceipt | null | undefined} receipt
 * @param {Readonly<Record<string, unknown>>} [own] - the incident's
 * @returns {Record<string, unknown> | null}
 */
export function whyOf(receipt, own = {}) {
  if (receipt && updateOf(receipt) !== null) return { ...(receipt.evidence || {}), ...own };
  return Object.keys(own).length > 0 ? { ...own } : null;
}

/** The update states that are waiting: each needs no one, as the worker finishes it on its own */
export const WAITING = Object.freeze(['storage.migration-pending']);

/**
 * Whether `incident` is an update that's waiting: storage's migration-pending, or its
 * migration-blocked on anything but free space, read with storage's latest receipt (whyOf)
 * @param {Incident} incident
 * @param {HealthReceipt | null | undefined} receipt - storage's latest
 */
export function waits(incident, receipt) {
  if (incident.providerId !== 'storage') return false;
  return WAITING.includes(String(updateKeyOf(incident.faultCode, whyOf(receipt, incident.evidence))));
}
