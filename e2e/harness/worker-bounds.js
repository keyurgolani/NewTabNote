/**
 * The bounds on the harness's own waits in the service worker (#286), which the characterization
 * driver and the fixture host share: a wait past its bound fails naming what it waited on, inside
 * a test's 30 s, so a stall reads as one in the report rather than as the test's timeout.
 */

/** How long the worker's storage upgrade may take before the harness says so: past 1.7.0's slowest, 10.7 s (#286) */
const UPGRADE_BOUND_MS = 15_000;
/** How long one of the harness's deletes in the worker may go unanswered before it says so (#286) */
const DELETE_BOUND_MS = 10_000;

module.exports = { UPGRADE_BOUND_MS, DELETE_BOUND_MS };
