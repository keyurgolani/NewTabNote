// Shared by the kernel tests: a clock the test moves, counting ids, a caller per surface,
// and the fixture shape the contract suite runs against.

/** @typedef {import('../../js/kernel/core/ports/policy.js').Caller} Caller */
/** @typedef {import('../../js/kernel/core/ports/policy.js').Surface} Surface */
/** @typedef {import('../../js/kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../js/kernel/core/ports/repository.js').AdapterFlags} AdapterFlags */
/** @typedef {import('../../js/kernel/core/ports/repository.js').StoreName} StoreName */
/** @typedef {import('../../js/kernel/core/ports/repository.js').SettingsArea} SettingsArea */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */

/** 2026-10-20 12:00 UTC */
export const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

/**
 * @typedef {{now(): number, advance(ms?: number): number}} TestClock
 */

/**
 * @param {number} [start]
 * @returns {TestClock}
 */
export function testClock(start = NOW) {
  let now = start;
  return {
    now: () => now,
    advance(ms = 1000) {
      now += ms;
      return now;
    },
  };
}

/**
 * @param {string} [prefix]
 * @returns {{next(): string}}
 */
export function testIds(prefix = 'id') {
  let count = 0;
  return { next: () => `${prefix}-${++count}` };
}

/** @type {Readonly<Record<Surface, Caller>>} */
export const CALLERS = Object.freeze({
  newtab: Object.freeze({ surface: 'newtab', contextId: 'newtab-1' }),
  popup: Object.freeze({ surface: 'popup', contextId: 'popup-1' }),
  sidepanel: Object.freeze({ surface: 'sidepanel', contextId: 'sidepanel-1' }),
  offscreen: Object.freeze({ surface: 'offscreen', contextId: 'offscreen-1' }),
  'worker-internal': Object.freeze({ surface: 'worker-internal', contextId: 'worker-1' }),
  recovery: Object.freeze({ surface: 'recovery', contextId: 'recovery-1' }),
});

/**
 * One run of the contract suite against one adapter.
 * @typedef {object} ContractContext
 * @property {KernelAdapter} adapter
 * @property {TestClock} clock
 * @property {{next(): string}} ids
 * @property {(caller?: Caller) => Kernel} kernel - a kernel over this adapter, for the new tab unless `caller` names another surface
 * @property {() => Promise<{kernel: (caller?: Caller) => Kernel}>} secondContext
 *   Another context, such as a second tab, with its own adapter over the same storage
 * @property {(target: StoreName | SettingsArea) => void} failNextWrite - make the next write to `target` fail
 * @property {() => Promise<Array<{commandId: string}>>} [conflicts]
 *   The commands the adapter kept when they conflicted, read however the adapter stores them.
 *   A fixture whose adapter has revisions provides it, so the adapter itself needs no test method.
 * @property {() => Promise<void>} close
 */

/**
 * @typedef {object} ContractFixture
 * @property {string} name
 * @property {Readonly<AdapterFlags>} flags - what the adapter is documented to guarantee
 * @property {() => Promise<ContractContext>} start
 * @property {(stores: StoreName[]) => Promise<ContractContext>} [startWithout]
 *   A context over a database that lacks `stores`, as one an older or damaged 1.x profile
 *   can. Only a fixture over that storage can make one.
 */
