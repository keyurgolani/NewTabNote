/**
 * The fixed words every registry family shares (#15, "Kit"): the hosts a contribution can run
 * on, the AI scopes it can ask for, and the limits that keep resolution bounded. Families pick
 * from these and never add to them.
 */

/**
 * Where a contribution can run. `workspace` (today's new tab) and `pip` run inside #12's
 * `newtab` root until #2 (Moment) and #3 (Workspace regions) split them. `recovery` is
 * recovery.html, the Trust Center and Recovery Center's page (#20 slice 4b).
 * @typedef {'moment' | 'workspace' | 'popup' | 'sidepanel' | 'background' | 'pip' | 'recovery'} Host
 */

/** @type {readonly Host[]} */
export const HOSTS = Object.freeze(['moment', 'workspace', 'popup', 'sidepanel', 'background', 'pip', 'recovery']);

/**
 * How much note data an AI contribution may read, narrowest first. #21 (security) takes this
 * constant over and enforces it; the kit only checks that a contribution stays within its
 * family's ceiling.
 * @typedef {'metadata' | 'selected-block' | 'current-note' | 'linked-context' | 'workspace'} AiScope
 */

/** @type {readonly AiScope[]} */
export const AI_SCOPES = Object.freeze(['metadata', 'selected-block', 'current-note', 'linked-context', 'workspace']);

/**
 * Bounds that keep resolution linear and small. A root throws when a family registers more
 * contributions than this, and a descriptor with more `requires`, keywords, chords, or
 * fixtures than this is unresolved.
 */
export const LIMITS = Object.freeze({
  contributionsPerFamily: 512,
  requires: 32,
  keywords: 32,
  chordsPerPlatform: 4,
  fixtures: 16,
  textLength: 200,
});
