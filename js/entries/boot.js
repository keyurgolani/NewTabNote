/**
 * The new tab's start (#27 slice 3, "Entries"), which the boot root (js/entries/newtab.js) runs.
 * It holds the shared Web Lock ntn-boot while the tab starts, for #35's job boot guard, and
 * loads the workspace chunk, today's whole new tab, through the page's loader, then calls the
 * chunk's boot(). The boot guard (js/entries/boot-guard.js) watches for a failure until then:
 * `ntn:boot` tells it the root is calling boot(), and `ntn:boot-failed` that the chunk didn't
 * load. From boot() on, the app owns its failures.
 */

/** @typedef {import('../runtime/lazy.js').Loader} Loader */
/** @typedef {import('../runtime/lazy.js').Result} Result */

/** The lock #35's job boot guard waits on while a new tab starts */
export const BOOT_LOCK = 'ntn-boot';

/** The longest the root holds it */
export const BOOT_LOCK_MS = 10_000;

/** #27's interaction-ready mark (js/app.js), which ends the start */
export const INTERACTION_READY = 'ntn:interaction-ready';

/**
 * Call `callback` once the page has the interaction-ready mark, there already or made later.
 * Answers what stops watching.
 * @param {() => void} callback
 * @returns {() => void}
 */
export function whenInteractionReady(callback) {
  const observer = new PerformanceObserver((list) => {
    if (list.getEntriesByName(INTERACTION_READY, 'mark').length === 0) return;
    observer.disconnect();
    callback();
  });
  // buffered: a mark made before this runs comes too
  observer.observe({ type: 'mark', buffered: true });
  return () => observer.disconnect();
}

/**
 * @typedef {object} BootLockHost
 * @property {LockManager | undefined} locks - navigator.locks, which a page always has
 * @property {(callback: () => void) => () => void} whenReady - calls back at interaction-ready
 * @property {(callback: () => void, ms: number) => unknown} setTimeout
 * @property {(timer: any) => void} clearTimeout
 */

/**
 * Hold ntn-boot, shared, from now until the page is interaction-ready or BOOT_LOCK_MS have
 * passed, whichever comes first. Answers once it's released, or at once without Web Locks.
 * @param {BootLockHost} host
 * @returns {Promise<void>}
 */
export function holdBootLock({ locks, whenReady, setTimeout: schedule, clearTimeout: cancel }) {
  if (!locks) return Promise.resolve();
  return locks.request(BOOT_LOCK, { mode: 'shared' }, () => new Promise((release) => {
    let stop = () => {};
    const done = () => {
      cancel(timer);
      stop();
      release(undefined);
    };
    const timer = schedule(done, BOOT_LOCK_MS);
    stop = whenReady(done);
  })).then(() => {}, (error) => {
    // A lock the page can't take holds nothing up, and the start goes on without it
    console.warn('NewTabNote: ntn-boot not held', error && error.name);
  });
}

/**
 * Load the workspace chunk through `loader` and call its boot() with the loader, telling the
 * boot guard on `target` first: `ntn:boot`, or `ntn:boot-failed` with the build, the chunk, and
 * the reason when it didn't load
 * @param {{loader: Loader, target: EventTarget, load: () => Promise<any>}} options - `load` is
 *   the root's `() => import('../workspace.js')`
 * @returns {Promise<Result>}
 */
export async function bootWorkspace({ loader, target, load }) {
  const result = await loader.loadChunk('workspace', load);
  if (result.status !== 'loaded') {
    target.dispatchEvent(new CustomEvent('ntn:boot-failed', {
      detail: { buildId: loader.buildId, chunk: 'workspace', reason: result.reason },
    }));
    return result;
  }
  target.dispatchEvent(new CustomEvent('ntn:boot'));
  result.module.boot(loader);
  return result;
}
