/**
 * The service worker's half of the harness. launchExtension() writes installWorkerHooks
 * into its copy of the build as ntn-harness-hooks.js and loads it ahead of the extension's
 * own worker script, so it runs first on every start of the worker, restarts included.
 *
 * It reports each uncaught exception in the worker: errors, unhandled rejections, and what
 * chrome.* event listeners and API callbacks throw, which Chrome catches and logs where
 * Playwright can't see. Each report goes into self.__ntnHarness.reports and out as a
 * console error that starts with `tag`. Events on objects an API hands back later, such as
 * a Port's, aren't hooked.
 *
 * The function runs in the worker, not in Node, so it can only use its own body and `tag`.
 */
function installWorkerHooks(tag) {
  const harness = { instance: crypto.randomUUID(), reports: [] };
  self.__ntnHarness = harness;

  const report = (where, error, fallback) => {
    try {
      const entry = error instanceof Error
        ? { seq: harness.reports.length, where, message: error.message, stack: error.stack }
        : { seq: harness.reports.length, where, message: fallback === undefined ? String(error) : fallback };
      harness.reports.push(entry);
      console.error(tag, JSON.stringify({ instance: harness.instance, ...entry }));
    } catch {
      // Reporting never breaks the extension
    }
  };

  self.addEventListener('error', event => report('', event.error, event.message));
  self.addEventListener('unhandledrejection', event => report('unhandled rejection', event.reason));

  // Report what a chrome.* listener or callback throws, then rethrow, so Chrome handles it
  // as it would without the harness
  const guard = (fn, where) => function guarded(...args) {
    try {
      return fn.apply(this, args);
    } catch (error) {
      report(where, error);
      throw error;
    }
  };

  const hookEvent = (event, name) => {
    const { addListener, removeListener, hasListener } = event;
    if (typeof removeListener !== 'function' || typeof hasListener !== 'function') return;
    const guarded = new WeakMap();
    const wrap = fn => {
      if (typeof fn !== 'function') return fn;
      if (!guarded.has(fn)) guarded.set(fn, guard(fn, `${name} listener`));
      return guarded.get(fn);
    };
    event.addListener = function (fn, ...rest) {
      return addListener.call(this, wrap(fn), ...rest);
    };
    event.removeListener = function (fn, ...rest) {
      return removeListener.call(this, guarded.get(fn) || fn, ...rest);
    };
    event.hasListener = function (fn, ...rest) {
      return hasListener.call(this, guarded.get(fn) || fn, ...rest);
    };
  };

  const hookMethod = (owner, key, name) => {
    const method = owner[key];
    owner[key] = function (...args) {
      return method.apply(this, args.map(arg => (typeof arg === 'function' ? guard(arg, `${name} callback`) : arg)));
    };
  };

  // API namespaces and their methods and events are plain properties, so they can be
  // swapped; one level down covers objects such as chrome.storage.local
  const hookNamespace = (namespace, name, depth) => {
    for (const key of Object.keys(namespace)) {
      let value;
      try {
        value = namespace[key];
      } catch {
        continue;
      }
      if (typeof value === 'function') {
        hookMethod(namespace, key, `${name}.${key}`);
      } else if (value && typeof value === 'object') {
        if (typeof value.addListener === 'function') hookEvent(value, `${name}.${key}`);
        else if (depth > 0) hookNamespace(value, `${name}.${key}`, depth - 1);
      }
    }
  };

  for (const key of Object.keys(chrome)) {
    const namespace = chrome[key];
    if (namespace && typeof namespace === 'object') hookNamespace(namespace, `chrome.${key}`, 1);
  }
}

module.exports = { installWorkerHooks };
