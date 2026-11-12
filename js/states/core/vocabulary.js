/**
 * The fixed words of #26's states contract ("View states", "Registries") that a cause draws on:
 * the 11 states a view can be in, what a blocked one waits on, how a cause retries, who brings
 * causes, and the closed list of primary actions. Nothing adds to them at run time, and an action
 * joins the list with its catalog entry, in the same PR. A state row's own tokens come with its
 * family.
 *
 * js/states/core/ is host-neutral under #12's module rules: no browser API, no legacy global, and
 * imports only from itself, #12's kernel core, #15's registry kit and the vendored Valibot, never
 * from the trust core, whose views move onto the states presenter (#26 slice 4).
 * `npm run check:boundaries` holds it to that (`states-global`, `states-import`).
 */

/**
 * The view states, in #26's order: nothing asked or a capability off, a first read or an `unknown`
 * command checked by its key, a newer read under data shown, a complete read or a committed command
 * (the only place "Saved" appears), a complete read that found nothing, data past its revision or
 * its verification, a destination out of reach, waiting on a change, some units committed, nothing
 * changed, and a restore, replay, rollback, repair or reindex running
 */
export const STATES = Object.freeze(
  /** @type {const} */ ([
    'idle', 'loading', 'refreshing', 'ready', 'empty', 'stale', 'offline', 'blocked', 'partial', 'failed', 'recovering',
  ]),
);

/** What a `blocked` state waits on: it can't run until this changes */
export const BLOCKED_REASONS = Object.freeze(
  /** @type {const} */ ([
    'permission', 'authentication', 'vault-locked', 'quota', 'policy', 'conflict', 'migration-pending', 'coordinator',
    'update-required', 'not-found',
  ]),
);

/** How a cause retries: on its own after bounded backoff, when the person asks, or never */
export const RETRY = Object.freeze(/** @type {const} */ (['auto', 'user', 'never']));

/**
 * The reasons that never retry on their own: quota, permission, policy, and an unsupported version,
 * which waits as `update-required`. A validation cause never does either, as its own cause says.
 */
export const NO_AUTO_RETRY = Object.freeze(/** @type {const} */ (['quota', 'permission', 'policy', 'update-required']));

/**
 * The closed list of primary actions, in #26's order. New note is for a valid empty only, Continue
 * for incomplete AI output, and Open goes to a named destination. The rest serve #4 and #5 (Save to
 * Inbox), #3 (Save as new note), #6 and #25 (Keep mine), #25 (View previous value), #20 (Resume,
 * Roll back), #18 (Create verified backup) and #14's placeholders (Load).
 */
export const ACTIONS = Object.freeze(
  /** @type {const} */ ([
    'retry', 'reconnect', 'grant', 'unlock', 'free-space', 'restore', 'recover', 'export', 'copy-text', 'clear-filters',
    'new-note', 'continue', 'open', 'reopen', 'save-to-inbox', 'save-as-new-note', 'keep-mine', 'view-previous-value',
    'resume', 'roll-back', 'create-verified-backup', 'load',
  ]),
);

/** Inspect, which every state offers and which is always secondary, so nothing names it as its action */
export const INSPECT = 'inspect';

/**
 * Who brings causes, as #26 names them, in browse order: #12's kernel, #13's transport, #17's
 * storage, #35's coordinator, #21's security, #11's providers and #14's blocks. An issue with
 * causes of another kind adds its group.
 */
export const CAUSE_GROUPS = Object.freeze(
  /** @type {const} */ (['kernel', 'transport', 'storage', 'coordinator', 'security', 'providers', 'blocks']),
);

/** A message key: two or more dotted segments in lowercase kebab case, as #12's `rejected.<code>` */
const MESSAGE_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/;

/**
 * Whether `value` is a message key, 80 characters at most
 * @param {unknown} value
 * @returns {value is string}
 */
export const isMessageKey = value => typeof value === 'string' && value.length <= 80 && MESSAGE_KEY.test(value);

/** A settings page, `settings/<section>` */
const SETTINGS_PAGE = /^settings\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Whether Open may go to `value`: Archive, Recovery Center, or a settings page
 * @param {unknown} value
 * @returns {value is string}
 */
export const isOpenDestination = value =>
  value === 'archive' || value === 'recovery-center' || (typeof value === 'string' && SETTINGS_PAGE.test(value));
