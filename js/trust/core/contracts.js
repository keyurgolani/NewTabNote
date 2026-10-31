/**
 * The Trust Center's catalog (#20, "Contracts"; approved AC1): its queries and commands as
 * #13 operations, each entry shaped like the kernel's (contracts/commands.js and queries.js)
 * and naming its schema module under operations/ the same way, a dot written as a hyphen.
 *
 * No shipped root registers a handler for any of them yet: they're catalog entries plus the
 * in-process use cases in use-cases.js, which slice 2 puts behind #13's worker router
 * (`trust.summary`, `recovery.incidents`, and `recovery.raise`, answered from
 * NewTabNoteTrust) and the Trust and Recovery pages. capture-critical.js never reaches this
 * file or a schema module it names, so Moment loads none of it.
 *
 * - `trust.summary` is read by every page that shows a status: the new tab, Popup, Side
 *   Panel, and recovery.html.
 * - `recovery.raise` runs from any context, the service worker and the offscreen document
 *   included, since a failure anywhere can raise an incident.
 * - `recovery.run` runs only from the `newtab` and `recovery` pages, and its payload's
 *   `userInitiated: true` only from a click handler there.
 * - Everything else is the Trust and Recovery views', on the new tab and recovery.html:
 *   slice 4a adds `recovery.dismiss` and `recovery.undismiss`, `recovery.check` (the check
 *   after a repair), and `recovery.copies` (Copies of your notes).
 */

import { COMMAND_DEADLINE_MS, QUERY_DEADLINE_MS, SMALL_MESSAGE_BYTES } from '../../kernel/core/contracts/limits.js';

/** @typedef {import('../../kernel/core/contracts/commands.js').CommandEntry} CommandEntry */
/** @typedef {import('../../kernel/core/contracts/queries.js').QueryEntry} QueryEntry */
/** @typedef {import('../../kernel/core/contracts/surfaces.js').Surface} Surface */

/** The pages that show a status */
const STATUS_PAGES = Object.freeze(/** @type {Surface[]} */ (['newtab', 'popup', 'sidepanel', 'recovery']));

/** The pages that hold the Trust and Recovery views */
const TRUST_PAGES = Object.freeze(/** @type {Surface[]} */ (['newtab', 'recovery']));

/** Every context that can hit a failure */
const ANY_CONTEXT = Object.freeze(
  /** @type {Surface[]} */ (['newtab', 'popup', 'sidepanel', 'offscreen', 'worker-internal', 'recovery']),
);

/** How long a full verify or an export may take: checks run one at a time, each to its timeout */
const LONG_DEADLINE_MS = 120_000;

/**
 * @param {string} module
 * @param {readonly Surface[]} surfaces
 * @returns {QueryEntry}
 */
const query = (module, surfaces) =>
  Object.freeze({
    kind: /** @type {const} */ ('query'),
    version: 1,
    schema: `./operations/${module}.js`,
    surfaces,
    maxBytes: SMALL_MESSAGE_BYTES,
    deadlineMs: QUERY_DEADLINE_MS,
    cancellable: /** @type {const} */ ('any-time'),
    idempotency: /** @type {const} */ ('none'),
    journaled: /** @type {const} */ (false),
    entityTypes: Object.freeze([]),
    destinations: Object.freeze([]),
  });

/**
 * @param {string} module
 * @param {readonly Surface[]} surfaces
 * @param {number} [deadlineMs]
 * @returns {CommandEntry}
 */
const command = (module, surfaces, deadlineMs = COMMAND_DEADLINE_MS) =>
  Object.freeze({
    kind: /** @type {const} */ ('command'),
    version: 1,
    schema: `./operations/${module}.js`,
    aggregate: /** @type {const} */ ('system'),
    surfaces,
    maxBytes: SMALL_MESSAGE_BYTES,
    deadlineMs,
    cancellable: /** @type {const} */ ('before-transaction'),
    idempotency: /** @type {const} */ ('keyed'),
    journaled: false,
    entityTypes: Object.freeze([]),
    destinations: Object.freeze([]),
  });

export const TRUST_QUERIES = Object.freeze({
  'trust.summary': query('trust-summary', STATUS_PAGES),
  'trust.report': query('trust-report', TRUST_PAGES),
  'recovery.incidents': query('recovery-incidents', TRUST_PAGES),
  'recovery.copies': query('recovery-copies', TRUST_PAGES),
});

export const TRUST_COMMANDS = Object.freeze({
  'trust.verify': command('trust-verify', TRUST_PAGES, LONG_DEADLINE_MS),
  'recovery.raise': command('recovery-raise', ANY_CONTEXT),
  'recovery.run': command('recovery-run', TRUST_PAGES, LONG_DEADLINE_MS),
  'diagnostics.export': command('diagnostics-export', TRUST_PAGES, LONG_DEADLINE_MS),
  'recovery.dismiss': command('recovery-dismiss', TRUST_PAGES),
  'recovery.undismiss': command('recovery-undismiss', TRUST_PAGES),
  'recovery.check': command('recovery-check', TRUST_PAGES, LONG_DEADLINE_MS),
});

/** @typedef {keyof typeof TRUST_QUERIES} TrustQueryType */
/** @typedef {keyof typeof TRUST_COMMANDS} TrustCommandType */
