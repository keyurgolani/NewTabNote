/**
 * What the service worker and a context that restores the notes say to each other (#35 slice 7):
 * #304's restore and reset command. The restorer takes Web Lock RESTORE_LOCK, sends
 * RESTORING_MESSAGE, restores, lets the lock go, and sends RESTORED_MESSAGE. recovery.html's
 * fallback (slice 8) holds the lock alone: it commits only while the coordinator can't run what it
 * commits, and the coordinator checks the lock before each turn. While another context holds the
 * lock, the worker's coordinator dequeues nothing, closes its adapter once its running command is
 * in, and says RESTORING. It resumes once it can take the lock itself, so a restorer that dies
 * mid-restore holds it no longer than its context lives, and each message only makes it check at
 * once.
 *
 * Only the worker and recovery.html load this module (js/background.js, the coordinator, and the
 * router, which recovery.html's root loads too), never the new tab, the Popup or the Side Panel, so
 * js/kernel/composition/host.js doesn't carry these names. It touches no browser API.
 */

/** The Web Lock a restore holds for as long as it runs */
export const RESTORE_LOCK = 'storage.restore';

/** What the restorer sends once it holds RESTORE_LOCK */
export const RESTORING_MESSAGE = 'storage.restoring';

/** What the restorer sends once it has let RESTORE_LOCK go */
export const RESTORED_MESSAGE = 'storage.restored';

/**
 * The reason a welcome gives while another context restores, and the code a command still waiting
 * at its deadline answers then, `unavailable {cause: 'coordinator', retryable: true}`
 */
export const RESTORING = 'restoring';
