/**
 * What the kernel takes from its host besides storage: the time, timers, new ids, and a place
 * to report a commit-feed listener that threw. Core reads no browser API, so the composition
 * root passes these in.
 */

/** @typedef {{now(): number}} Clock */
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

/** @type {Clock} */
export const systemClock = Object.freeze({ now: () => Date.now() });

/**
 * Ids in the format Utils.generateId has always made.
 * @type {Ids}
 */
export const legacyIds = Object.freeze({ next: () => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}` });

/** @type {Logger} */
export const silentLogger = Object.freeze({ warn: () => {} });
