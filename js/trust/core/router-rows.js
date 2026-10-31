/**
 * The rows #13's router policy accepts trust operations by (#20 slice 4b): recovery.html's
 * own, and only what its Trust Center and Recovery Center call, so the page runs with least
 * privilege. Its root (js/kernel/composition/recovery.js) passes them to
 * createBaselinePolicy, and serves the operations in the page, since checks run in the page
 * that asks; the worker serves none of them. The catalog's `surfaces` (contracts.js) stay
 * what a page may ever ask for: the new tab gets rows of its own when #3 mounts the Trust
 * Center there.
 *
 * - The reads: `trust.summary` (the headline), `trust.report` (the Trust Center's rows), and
 *   `recovery.incidents` (the Recovery Center's problems).
 * - `trust.verify` only as the page opens (`trigger: 'open'`), which runs the local-cheap
 *   checks. The check after a repair is `recovery.check`.
 * - `recovery.dismiss` and `recovery.undismiss`.
 * - `recovery.run` only for `rebuild-index`, the one repair this slice offers: its preview,
 *   then its confirmed protect, apply, and verify.
 *
 * Nothing else runs from it: not `recovery.raise`, `recovery.copies`, `diagnostics.export`,
 * a verify on any other trigger, or another remediation. Every other surface is refused each
 * of these.
 */

/** @typedef {import('../../kernel/core/ports/policy.js').PolicyRow} PolicyRow */
/** @typedef {{type?: unknown} & Readonly<Record<string, unknown>>} Request - what a row's `allows` is given */

/** recovery.html, as #13's runtime port names it (js/kernel/adapters/messaging/runtime-port.js) */
const RECOVERY_PAGE = Object.freeze(/** @type {const} */ (['recovery']));

/** The one remediation recovery.html runs in this slice */
export const RECOVERY_PAGE_REMEDIATIONS = Object.freeze(/** @type {const} */ (['rebuild-index']));

/** @type {Readonly<Record<string, PolicyRow>>} */
export const RECOVERY_PAGE_ROWS = Object.freeze({
  'trust.summary': Object.freeze({ surfaces: RECOVERY_PAGE }),
  'trust.report': Object.freeze({ surfaces: RECOVERY_PAGE }),
  'recovery.incidents': Object.freeze({ surfaces: RECOVERY_PAGE }),
  'trust.verify': Object.freeze({ surfaces: RECOVERY_PAGE, allows: (/** @type {Request} */ request) => request.trigger === 'open' }),
  'recovery.check': Object.freeze({ surfaces: RECOVERY_PAGE }),
  'recovery.dismiss': Object.freeze({ surfaces: RECOVERY_PAGE }),
  'recovery.undismiss': Object.freeze({ surfaces: RECOVERY_PAGE }),
  'recovery.run': Object.freeze({
    surfaces: RECOVERY_PAGE,
    allows: (/** @type {Request} */ request) =>
      /** @type {readonly unknown[]} */ (RECOVERY_PAGE_REMEDIATIONS).includes(request.remediationId),
  }),
});
