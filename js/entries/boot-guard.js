/**
 * The new tab's boot guard (#27 slice 3, "Entries"), a classic script newtab.html runs before
 * its one module, the boot root. It watches for a start that fails before the app takes over:
 * the root's <script> firing error, the root telling it `ntn:boot-failed` (the workspace chunk
 * didn't load, its boot() threw, or the root's own start failed), or an error going uncaught
 * before boot() has returned. Then the root tells it `ntn:boot`, its listeners come off, and a
 * later error is the app's. A rejection on the page doesn't count: one may not stop the start,
 * and the root reports a failure of its own start itself.
 *
 * A failure logs one line, with the build ID, what didn't start, and why, and shows the boot
 * failure (#27 slice 3b): "NewTabNote couldn't start." and "Reloading doesn't delete your notes."
 * with Reload, in #20's storage guard's geometry, so the two screens are one. The shell behind it
 * is hidden and inert, and nothing says to reinstall, which deletes the notes database.
 *
 * It draws without the page's CSS, which may be what failed: in a shadow root, from a constructed
 * stylesheet, in the system's colours (Canvas and CanvasText under `color-scheme: light dark`),
 * which follow the OS's dark setting and stay readable whatever loaded, with Chrome's own focus
 * ring. The words go out as an alert, Reload takes focus with the two sentences as its
 * description, and the tab's title says it, since a new tab keeps keyboard focus in the address
 * bar.
 */

/**
 * @typedef {object} BootFailure
 * @property {string | null} buildId - the build, which the boot root knows and this doesn't
 * @property {string} chunk - newtab for the root, or the chunk the root loads
 * @property {string} reason - the loader's (js/runtime/lazy.js), or uncaught
 */

(function bootGuard() {
  'use strict';

  const TITLE = "NewTabNote couldn't start.";
  const BODY = "Reloading doesn't delete your notes.";
  const DOCUMENT_TITLE = "NewTabNote couldn't start";

  /**
   * #20's storage guard's geometry (css/editor.css .storage-guard), in the system's colours: a
   * column up to 560 px wide, centred on the window, its title at 22 px
   */
  const STYLES = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  color-scheme: light dark;
  background: Canvas;
  color: CanvasText;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
  font-size: 1rem;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.failure {
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 24px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 12px;
}
h1 {
  margin: 0;
  font-size: 1.375rem;
  font-weight: 600;
  line-height: 1.3;
}
p {
  margin: 0;
  font-size: 0.9375rem;
  line-height: 1.6;
  color: color-mix(in srgb, CanvasText 64%, Canvas);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
button {
  min-width: 44px;
  min-height: 44px;
  padding: 10px 20px;
  border: 1px solid ButtonBorder;
  border-radius: 6px;
  background: ButtonFace;
  color: ButtonText;
  font: 500 0.875rem/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
  cursor: pointer;
}
`;

  /**
   * State 1: the line in the console, and the boot failure in place of the shell
   * @param {BootFailure} failure
   */
  function showBootFailure(failure) {
    console.error('NewTabNote: the new tab did not start', failure);
    try {
      drawBootFailure();
    } catch (error) {
      // The page stays the shell it is, as before 3b, and the line above says why
      console.error('NewTabNote: the boot failure could not be drawn', error);
    }
  }

  function drawBootFailure() {
    // Nothing to draw on, as in a context with no page
    if (typeof document === 'undefined' || !document.body) return;
    if (document.getElementById('ntn-boot-failure')) return;
    // Everything the page had stops taking focus and input: a shell that looks like an editor
    // but can't save anything
    for (const child of Array.from(document.body.children)) {
      if (child.tagName === 'SCRIPT') continue;
      const shell = /** @type {HTMLElement} */ (child);
      shell.inert = true;
      shell.hidden = true;
      // Over the page's own display rules, such as #app's flex, when its CSS loaded
      shell.style.display = 'none';
    }
    document.title = DOCUMENT_TITLE;

    const host = document.createElement('div');
    host.id = 'ntn-boot-failure';
    const root = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLES);
    root.adoptedStyleSheets = [sheet];

    const column = document.createElement('div');
    column.className = 'failure';
    column.setAttribute('role', 'alert');
    const title = document.createElement('h1');
    title.id = 'title';
    title.textContent = TITLE;
    const body = document.createElement('p');
    body.id = 'body';
    body.textContent = BODY;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Reload';
    reload.setAttribute('aria-describedby', 'title body');
    reload.addEventListener('click', () => location.reload());
    actions.appendChild(reload);
    column.appendChild(title);
    column.appendChild(body);
    column.appendChild(actions);
    root.appendChild(column);
    document.body.appendChild(host);
    reload.focus();
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
    window.removeEventListener('ntn:boot', stop);
    window.removeEventListener('ntn:boot-failed', onBootFailed);
  }

  window.addEventListener('error', onError, true);
  window.addEventListener('ntn:boot', stop);
  window.addEventListener('ntn:boot-failed', onBootFailed);
})();
