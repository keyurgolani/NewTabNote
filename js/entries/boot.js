/**
 * The new tab's start (#27 slice 3, "Entries"), which the boot root (js/entries/newtab.js) runs.
 * It holds the shared Web Lock ntn-boot while the tab starts, for #35's job boot guard, and
 * loads the workspace chunk, today's whole new tab, through the page's loader, then calls the
 * chunk's boot(). The boot guard (js/entries/boot-guard.js) watches for a failure until boot()
 * has returned: `ntn:boot` tells it the app owns its failures from then on, and
 * `ntn:boot-failed` that the start failed, with the build, what didn't start, and why.
 */

/** @typedef {import('../runtime/lazy.js').Loader} Loader */

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
 * @typedef {object} StartOptions
 * @property {Loader} loader - the page's
 * @property {EventTarget} target - where the boot guard listens: the page's window
 * @property {() => Promise<any>} load - the root's `() => import('../workspace.js')`
 */

/**
 * Tell the boot guard on `target` the start failed: `ntn:boot-failed`, with the build, what
 * didn't start, and why. Answers false, App not having taken over.
 * @param {EventTarget} target
 * @param {{buildId: string | null, chunk: string, reason: string}} failure
 * @returns {false}
 */
function startFailed(target, failure) {
  target.dispatchEvent(new CustomEvent('ntn:boot-failed', { detail: failure }));
  return false;
}

/**
 * Load the workspace chunk through `loader` and call its boot() with the loader. The boot guard
 * on `target` hears `ntn:boot` once boot() has returned, when App owns its failures, or
 * `ntn:boot-failed` with the build, the chunk, and the reason: the loader's when the chunk
 * didn't load, and evaluation-failed when boot() threw before App took over, as for a chunk that
 * throws as it evaluates. Answers whether App took over.
 * @param {StartOptions} options
 * @returns {Promise<boolean>}
 */
export async function bootWorkspace({ loader, target, load }) {
  const result = await loader.loadChunk('workspace', load);
  if (result.status !== 'loaded') return startFailed(target, { buildId: loader.buildId, chunk: 'workspace', reason: result.reason });
  try {
    result.module.boot(loader);
  } catch {
    // Only the reason: what threw is the chunk's, and the loader's lines never carry it either
    return startFailed(target, { buildId: loader.buildId, chunk: 'workspace', reason: 'evaluation-failed' });
  }
  target.dispatchEvent(new CustomEvent('ntn:boot'));
  return true;
}

/**
 * The boot root's start: bootWorkspace, whose own failure, such as a loader seam that throws,
 * the boot guard on `target` hears as `ntn:boot-failed` for the root, so no rejection of the
 * start goes unhandled. Answers whether App took over, and never rejects.
 * @param {StartOptions} options
 * @returns {Promise<boolean>}
 */
export function startWorkspace(options) {
  return bootWorkspace(options).catch(() => startFailed(options.target, { buildId: options.loader.buildId, chunk: 'newtab', reason: 'uncaught' }));
}
