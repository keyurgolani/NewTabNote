/**
 * What the kernel takes from its host besides storage: the time, timers, new ids, and a place
 * to report a commit-feed listener that threw. Core reads no browser API, so the composition
 * root passes these in.
 */

/**
 * The time, and the IANA time zone the user's dates are in, which decides the local date a
 * Daily Note is found by (#17 PR 3b, domain/daily.js). A clock without `zone` is UTC's, so a
 * test that names no zone keys Daily Notes as 1.4.x did.
 * @typedef {{now(): number, zone?(): string}} Clock
 */
/** @typedef {{next(): string}} Ids */

/**
 * Timers, for the deadlines and waits #13's router and client keep. `set` runs `callback`
 * once, `ms` from now, unless `clear` is given the handle it returned first.
 * @typedef {{set(callback: () => void, ms: number): unknown, clear(handle: unknown): void}} Timers
 */

/**
 * Never given a command payload: a detail holds codes, aggregates, ids, and errors only.
 * @typedef {{warn(event: string, detail: Record<string, unknown>): void}} Logger
 */

/**
 * The host's zone, as the browser resolves it now, else UTC
 * @returns {string}
 */
const hostZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** @type {Clock & {zone(): string}} */
export const systemClock = Object.freeze({ now: () => Date.now(), zone: hostZone });

/**
 * The zone `clock` gives, or UTC for one that gives none
 * @param {Clock} clock
 * @returns {string}
 */
export const zoneOf = clock => (typeof clock.zone === 'function' && clock.zone()) || 'UTC';

/**
 * Ids in the format Utils.generateId has always made.
 * @type {Ids}
 */
export const legacyIds = Object.freeze({ next: () => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}` });

/** @type {Logger} */
export const silentLogger = Object.freeze({ warn: () => {} });
