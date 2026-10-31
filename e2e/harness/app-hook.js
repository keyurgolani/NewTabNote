/**
 * The new tab's App instance as window.app in the test page, and its init() promise as
 * window.__ntnAppInit, so specs and the characterization driver can read the app and know when
 * it has started. extension.js adds it to every page of the session, before the page's own
 * scripts, so each new tab gets it however a spec opens it.
 *
 * The product never puts the instance on the page (#12 slice 7c): app.js publishes the App
 * class as window.App, and the new tab's composition root constructs it and calls init.
 * Wrapping App.prototype.init as window.App is set catches that call, and gives its instance
 * to window.app. 1.4.x's app.js sets `window.app = app` and calls app.init(), so wrapping init
 * as window.app is set catches that one, and the characterization suite still runs on a 1.4.x
 * build.
 */

/** Runs in the page: it can use nothing from this file but itself */
function hookApp() {
  let app;
  let App;
  const record = started => {
    window.__ntnAppInit = Promise.resolve(started).then(() => 'done', error => `failed: ${error}`);
  };
  Object.defineProperty(window, 'app', {
    configurable: true,
    enumerable: true,
    get: () => app,
    set(value) {
      app = value;
      const init = value && value.init;
      if (typeof init !== 'function') return;
      value.init = function recordedInit(...args) {
        const started = init.apply(this, args);
        record(started);
        return started;
      };
    },
  });
  Object.defineProperty(window, 'App', {
    configurable: true,
    enumerable: true,
    get: () => App,
    set(value) {
      App = value;
      const prototype = value && value.prototype;
      const init = prototype && prototype.init;
      if (typeof init !== 'function') return;
      prototype.init = function recordedInit(...args) {
        app = this;
        const started = init.apply(this, args);
        record(started);
        return started;
      };
    },
  });
}

module.exports = { hookApp };
