/**
 * Contribution states and the reasons behind them (#15, "Required states and failure
 * behavior"). Every state a report shows comes with a reason code from this table, or from a
 * family's own `reasons`, and the reason's text is code-owned, so a report never carries
 * anything a contribution or the user wrote: no note content, no error message.
 *
 * | State | Ordinary flows | On invoke |
 * | --- | --- | --- |
 * | `enabled` | shown | runs |
 * | `disabled-by-user` | hidden | nothing |
 * | `not-applicable` | disabled or hidden | nothing |
 * | `needs-permission` | shown | asks in the same gesture |
 * | `needs-setup` | shown | setup |
 * | `temporarily-unavailable` | disabled with a reason | nothing |
 * | `not-implemented` | hidden, explained in the report | can't be enabled |
 * | `unresolved` | hidden, explained in the report with remediation | nothing |
 */

/**
 * @typedef {'enabled' | 'disabled-by-user' | 'not-applicable' | 'needs-permission' | 'needs-setup'
 *   | 'temporarily-unavailable' | 'not-implemented' | 'unresolved'} State
 */

/** @type {readonly State[]} */
export const STATES = Object.freeze([
  'enabled',
  'disabled-by-user',
  'not-applicable',
  'needs-permission',
  'needs-setup',
  'temporarily-unavailable',
  'not-implemented',
  'unresolved',
]);

/**
 * The states a probe may answer with. A probe can't disable, unresolve, or implement anything.
 * @typedef {'enabled' | 'not-applicable' | 'needs-permission' | 'needs-setup' | 'temporarily-unavailable'} ProbeState
 */

/** @type {readonly ProbeState[]} */
export const PROBE_STATES = Object.freeze([
  'enabled',
  'not-applicable',
  'needs-permission',
  'needs-setup',
  'temporarily-unavailable',
]);

/** @typedef {Readonly<{state: State, message: string, remediation: string}>} Reason */

const FIX_DESCRIPTOR = 'Fix the descriptor; npm test fails until a built-in is valid.';

/**
 * The kit's reasons, by code
 * @type {Readonly<Record<string, Reason>>}
 */
export const REASONS = Object.freeze({
  ok: { state: 'enabled', message: 'Available.', remediation: '' },
  'disabled-by-user': { state: 'disabled-by-user', message: 'Turned off.', remediation: 'Turn it back on to use it.' },
  'other-host': {
    state: 'not-applicable',
    message: "Doesn't run here.",
    remediation: 'Use it where it runs.',
  },
  'dependency-disabled': {
    state: 'not-applicable',
    message: 'Something it needs is turned off.',
    remediation: 'Turn on what it needs.',
  },
  'dependency-not-applicable': {
    state: 'not-applicable',
    message: "Something it needs doesn't run here.",
    remediation: 'Use it where everything it needs runs.',
  },
  'not-applicable': { state: 'not-applicable', message: "Doesn't apply right now.", remediation: '' },
  'not-implemented': {
    state: 'not-implemented',
    message: 'Not available in this version.',
    remediation: 'None. It arrives in a later version.',
  },
  'missing-permission': {
    state: 'needs-permission',
    message: 'Needs a browser permission.',
    remediation: 'Grant the permission when asked.',
  },
  'needs-setup': { state: 'needs-setup', message: 'Needs setting up.', remediation: 'Finish its setup.' },
  'probe-pending': {
    state: 'temporarily-unavailable',
    message: 'Still checking whether it can run.',
    remediation: 'Wait a moment.',
  },
  'probe-failed': {
    state: 'temporarily-unavailable',
    message: "Couldn't check whether it can run.",
    remediation: 'Try again later.',
  },
  unavailable: { state: 'temporarily-unavailable', message: "Can't run right now.", remediation: 'Try again later.' },
  'dependency-unavailable': {
    state: 'temporarily-unavailable',
    message: "Something it needs can't run right now.",
    remediation: 'Try again later.',
  },
  'invalid-descriptor': { state: 'unresolved', message: 'Its descriptor is malformed.', remediation: FIX_DESCRIPTOR },
  'invalid-id': {
    state: 'unresolved',
    message: "Its id isn't a valid contribution id.",
    remediation: FIX_DESCRIPTOR,
  },
  'invalid-version': {
    state: 'unresolved',
    message: "Its version or apiVersion isn't a positive integer.",
    remediation: FIX_DESCRIPTOR,
  },
  'invalid-order': {
    state: 'unresolved',
    message: "Its group isn't one of its family's, or its rank isn't an integer.",
    remediation: FIX_DESCRIPTOR,
  },
  'invalid-host': {
    state: 'unresolved',
    message: "Its hosts aren't a list of its family's hosts.",
    remediation: FIX_DESCRIPTOR,
  },
  'invalid-requires': {
    state: 'unresolved',
    message: "Its requires list doesn't name contributions.",
    remediation: FIX_DESCRIPTOR,
  },
  'invalid-text': {
    state: 'unresolved',
    message: 'Its label, description, keywords, icon, or accessibility fields are malformed.',
    remediation: FIX_DESCRIPTOR,
  },
  'invalid-permissions': {
    state: 'unresolved',
    message: 'Its permission fields are malformed.',
    remediation: FIX_DESCRIPTOR,
  },
  'invalid-field': {
    state: 'unresolved',
    message: "A field its family defines doesn't hold what the family allows.",
    remediation: FIX_DESCRIPTOR,
  },
  'unknown-field': {
    state: 'unresolved',
    message: "It has a field its family doesn't define.",
    remediation: FIX_DESCRIPTOR,
  },
  'invalid-chord': {
    state: 'unresolved',
    message: "One of its keyboard shortcuts isn't spelled as an exact chord.",
    remediation: FIX_DESCRIPTOR,
  },
  'reserved-chord': {
    state: 'unresolved',
    message: 'One of its keyboard shortcuts is one Chrome keeps for itself.',
    remediation: 'Choose another shortcut; npm test fails until a built-in has none of these.',
  },
  'invalid-loader': {
    state: 'unresolved',
    message: 'Its loader or implementation is malformed, or its family allows neither.',
    remediation: FIX_DESCRIPTOR,
  },
  'missing-loader': {
    state: 'unresolved',
    message: 'It has no loader or implementation, and its family needs one.',
    remediation: FIX_DESCRIPTOR,
  },
  'dynamic-loader-on-background': {
    state: 'unresolved',
    message: 'It runs in the service worker but loads its implementation lazily.',
    remediation: 'Import its implementation statically; the service worker has no import().',
  },
  'invalid-probe': { state: 'unresolved', message: "Its probe isn't a function.", remediation: FIX_DESCRIPTOR },
  'missing-fixture': {
    state: 'unresolved',
    message: "It doesn't declare every conformance fixture its family requires.",
    remediation: 'Add the fixtures; npm test fails until a built-in declares them.',
  },
  'incompatible-api-version': {
    state: 'unresolved',
    message: 'It targets a different version of its family contract.',
    remediation: 'Update it to the contract version this build has.',
  },
  unauthorized: {
    state: 'unresolved',
    message: "It asks for a permission, AI scope, or destination its family doesn't allow.",
    remediation: "Remove the request, or change the family's ceiling in review.",
  },
  'duplicate-id': {
    state: 'unresolved',
    message: 'Another contribution in its family has the same id.',
    remediation: 'Give each contribution its own id; neither is used until then.',
  },
  'ordering-conflict': {
    state: 'unresolved',
    message: 'Another contribution in its group has the same rank.',
    remediation: 'Give each contribution in a group its own rank.',
  },
  'chord-conflict': {
    state: 'unresolved',
    message: 'Another contribution in its family binds the same keyboard shortcut.',
    remediation: 'Give each contribution its own shortcut.',
  },
  'dependency-cycle': {
    state: 'unresolved',
    message: 'What it requires ends up requiring it.',
    remediation: 'Break the cycle in the requires lists.',
  },
  'missing-dependency': {
    state: 'unresolved',
    message: 'Something it requires is missing.',
    remediation: 'Register what it requires, or drop the requirement.',
  },
  'dependency-unresolved': {
    state: 'unresolved',
    message: "Something it requires couldn't be resolved.",
    remediation: 'Fix what it requires first.',
  },
  'not-registered': {
    state: 'unresolved',
    message: 'Nothing by that id is registered here.',
    remediation: 'Check the id, and that its family is registered in this root.',
  },
  'load-failed': {
    state: 'unresolved',
    message: "Its code didn't load, twice.",
    remediation: 'Reload the page. If it keeps failing, report it.',
  },
});

/**
 * The reason a family's own table or the kit's gives for `code`, or undefined
 * @param {Readonly<Record<string, Reason>>} familyReasons
 * @param {string} code
 * @returns {Reason | undefined}
 */
export function reasonFor(familyReasons, code) {
  if (Object.hasOwn(familyReasons, code)) return familyReasons[code];
  return Object.hasOwn(REASONS, code) ? REASONS[code] : undefined;
}
