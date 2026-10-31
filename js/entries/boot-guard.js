/**
 * The new tab's boot guard (#27 slice 3, "Entries"), a classic script newtab.html runs before
 * its one module, the boot root. It watches for a start that fails before the app takes over:
 * the root's <script> firing error, the root's load of the workspace chunk failing
 * (`ntn:boot-failed`), or an error going uncaught or a rejection unhandled before the root
 * calls boot() (`ntn:boot`), when its listeners come off. A later error is the app's.
 *
 * A failure goes to showBootFailure, state 1's seam. #27 slice 3b shows "NewTabNote couldn't
 * start. Reloading doesn't delete your notes." with Reload there; in slice 3 it logs one line,
 * with the build ID, what didn't start, and why, and the page stays the shell it is today.
 */

/**
 * @typedef {object} BootFailure
 * @property {string | null} buildId - the build, which the boot root knows and this doesn't
 * @property {string} chunk - newtab for the root, or the chunk the root loads
 * @property {string} reason - the loader's (js/runtime/lazy.js), or uncaught or unhandled
 */

(function bootGuard() {
  'use strict';

  /**
   * State 1's seam: today, the line in the console, and nothing on the page
   * @param {BootFailure} failure
   */
  function showBootFailure(failure) {
    console.error('NewTabNote: the new tab did not start', failure);
  }

  let watching = true;

  /** @param {BootFailure} failure */
  function fail(failure) {
    if (!watching) return;
    stop();
    showBootFailure(failure);
  }

  /**
   * A script that doesn't load fires error at its element, which doesn't bubble, so the listener
   * captures. The page's one module script is the root; other elements' errors aren't the start's.
   * @param {Event} event
   */
  function onError(event) {
    if (event.target instanceof HTMLScriptElement) {
      if (event.target.type === 'module') fail({ buildId: null, chunk: 'newtab', reason: 'chunk-missing' });
      return;
    }
    if (event.target instanceof Element) return;
    fail({ buildId: null, chunk: 'newtab', reason: 'uncaught' });
  }

  function onRejection() {
    fail({ buildId: null, chunk: 'newtab', reason: 'unhandled' });
  }

  /** @param {Event} event */
  function onBootFailed(event) {
    const detail = /** @type {CustomEvent} */ (event).detail || {};
    fail({
      buildId: typeof detail.buildId === 'string' ? detail.buildId : null,
      chunk: typeof detail.chunk === 'string' ? detail.chunk : 'workspace',
      reason: typeof detail.reason === 'string' ? detail.reason : 'chunk-missing',
    });
  }

  function stop() {
    watching = false;
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('ntn:boot', stop);
    window.removeEventListener('ntn:boot-failed', onBootFailed);
  }

  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('ntn:boot', stop);
  window.addEventListener('ntn:boot-failed', onBootFailed);
})();
