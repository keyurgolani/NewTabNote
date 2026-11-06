/**
 * What a policy's answer refuses a request with, as #13's router answers it: the one mapping the
 * port router and the journal drain's replays both use (#35 slice 4b-1, the lead's ruling), so a
 * replay is refused with the code its surface's own request would get. Only `allowed: true` allows,
 * and a policy that throws, or answers anything else, denies. `unknown-caller` is a sender the
 * router can't name and `unknown-operation` one the policy has no entry for, and every other
 * denial, #21's included, is a surface the operation isn't for.
 */

/** @typedef {import('../contracts/transport-codes.js').TransportCode} TransportCode */
/** @typedef {import('../ports/policy.js').Caller} Caller */
/** @typedef {import('../ports/policy.js').PolicyPort} PolicyPort */

/**
 * The policy's codes that answer as codes of their own
 * @type {Readonly<Record<string, TransportCode>>}
 */
const DENIALS = Object.freeze({ 'unknown-caller': 'unauthorized-sender', 'unknown-operation': 'unknown-operation' });

/**
 * The code `policy` refuses `request` from `caller` with, or null when it allows it
 * @param {PolicyPort} policy
 * @param {unknown} request
 * @param {Caller} caller
 * @returns {TransportCode | null}
 */
export function denialOf(policy, request, caller) {
  try {
    const decision = /** @type {unknown} */ (policy.authorize(/** @type {{type?: unknown}} */ (request), caller));
    if (decision !== null && typeof decision === 'object') {
      const { allowed, code: denied } = /** @type {{allowed?: unknown, code?: unknown}} */ (decision);
      if (allowed === true) return null;
      if (typeof denied === 'string' && Object.hasOwn(DENIALS, denied)) return DENIALS[denied];
    }
  } catch {
    // Denied, below
  }
  return 'forbidden-for-surface';
}
