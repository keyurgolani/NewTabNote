/**
 * The page's loader (#27 slice 3, "Lazy boundaries"). What a page needs only at its first use
 * loads through it, and the answer says how that went:
 *   loadChunk(name, () => import('./literal.js'))   a chunk: the boot root's workspace
 *   loadLibrary(name)                               a vendored library of LIBRARIES, put in as
 *                                                   the classic script it is
 * Each answers {status: 'loaded', module} or {status: 'failed', reason, retry}, and never
 * rejects. The reasons:
 *   chunk-missing      its file didn't load, the one retry included
 *   evaluation-failed  it loaded and threw, or a library's script ran and left no global. No
 *                      retry: the same file would throw again.
 *   build-mismatch     build-info.json is another build's, so the extension was updated under
 *                      the page: a chunk's file didn't load, or a library's is about to run.
 *                      No retry: only a reload helps.
 * A file that doesn't load sends the loader to build-info.json, read uncached. For the same
 * build it retries once with ?r=1, a URL the module map hasn't cached as failed: a chunk at
 * build-info.json's chunks[name], a library at its own path. A chunk whose stylesheet didn't
 * load still answers loaded: the retry imports its code alone, and Vite's preload never puts a
 * URL in twice, so a later load runs the chunk's code without the stylesheet too. No lazy chunk
 * has a stylesheet today. The first one that does has to bring the fix: the loader puts the
 * failed stylesheet in itself with ?r=1 and waits for it, and answers chunk-missing when that
 * fails too. A library keeps its path from build to build, so the loader reads build-info.json
 * before it puts one in, and under another build's it runs none. Each failure logs one line with
 * the build ID, the name, and the reason, never what threw. A library that failed stays failed
 * until its retry runs, as a missing one did before, and a retry called again while one runs
 * answers that one; a chunk's next load tries again.
 *
 * It also keeps the page's reload guards, which reloadAfterGuards waits on before it reloads
 * (App's writes what every open editor has pending), and its extra documents, the
 * Picture-in-Picture editor's, which get each stylesheet a load adds, since they copy the
 * page's only when they open.
 *
 * Three states #27 slice 3b gives words and an element have a seam each here, which shows
 * nothing in slice 3 (seams): loading, updated, and failed.
 *
 * It imports nothing, and the bundler gives it a chunk of its own at this path
 * (scripts/build/vite-config.js): the one file the closure check lets build a path at run
 * time, for the retry's URL, and the one outside js/kernel/ and js/storage.js the boundary
 * check lets fetch, for its read of the packaged build-info.json (eslint.config.mjs).
 */

/** @typedef {'chunk-missing' | 'evaluation-failed' | 'build-mismatch'} Reason */

/**
 * @typedef {object} Loaded
 * @property {'loaded'} status
 * @property {any} module - the chunk's module, or the library's global
 */

/**
 * @typedef {object} Failed
 * @property {'failed'} status
 * @property {Reason} reason
 * @property {() => Promise<Result>} retry - loads it again
 */

/** @typedef {Loaded | Failed} Result */

/**
 * A vendored library: its file's URL, and the global its script defines
 * @typedef {object} Library
 * @property {() => string} url
 * @property {string} global
 */

/**
 * What the loader does its work through: the page's, or a test's
 * @typedef {object} Host
 * @property {string | null} buildId - the build the page's code is from; null in the sources
 * @property {(file: string) => string} getURL - a package path's URL
 * @property {(url: string) => Promise<any>} fetchJson - JSON, read uncached
 * @property {(url: string) => Promise<any>} importUrl - import() of a URL
 * @property {Document | null} document
 * @property {any} global - where a library's script puts its global
 * @property {(message: string, detail: object) => void} warn
 * @property {() => void} reload
 * @property {(callback: () => void, ms: number) => unknown} setTimeout
 * @property {(timer: any) => void} clearTimeout
 * @property {Readonly<Record<string, Library>>} libraries
 */

/**
 * The seams of the states #27 slice 3b shows, one per state, which 3b replaces on the page's
 * loader. Each shows nothing in slice 3, where every state lands on what the page did before.
 * @typedef {object} Seams
 * @property {(name: string) => () => void} loading - state 4: a load at a lazy boundary
 *   starts; answers what to call once it settles. 3b: an indeterminate role="status" after 400 ms.
 * @property {(name: string) => void} updated - state 2: a load found the extension updated
 *   under the page. 3b: "NewTabNote was updated. Save and reload.", whose Reload is
 *   reloadAfterGuards.
 * @property {(name: string, failure: Failed) => void} failed - state 3: an optional chunk or
 *   library didn't load, and its call site's own failure path runs. 3b: a labelled failure with
 *   Retry (failure.retry).
 */

/** How long reloadAfterGuards waits for the guards before it reloads anyway */
export const RELOAD_GUARD_MS = 2000;

/**
 * The vendored libraries, by loader name: each file, which this literal names to the closure
 * check, and the global its script defines
 * @type {Readonly<Record<string, Library>>}
 */
export const LIBRARIES = Object.freeze({
  chart: Object.freeze({ url: () => chrome.runtime.getURL('js/lib/chart.js'), global: 'Chart' }),
  fuse: Object.freeze({ url: () => chrome.runtime.getURL('js/lib/fuse.js'), global: 'Fuse' }),
  jszip: Object.freeze({ url: () => chrome.runtime.getURL('js/lib/jszip.min.js'), global: 'JSZip' }),
  transformers: Object.freeze({ url: () => chrome.runtime.getURL('js/lib/transformers.js'), global: 'transformers' }),
});

/** The seams as slice 3 has them, which every loader starts with */
export const seams = Object.freeze(/** @type {Seams} */ ({
  loading: () => () => {},
  updated: () => {},
  failed: () => {},
}));

/**
 * How Chrome says an import()'s file, or one it imports, didn't load, and how Vite's preload of a
 * chunk's stylesheets does. Anything else a load throws is the module's own.
 */
const NOT_LOADED = /dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/**
 * Whether a load threw because a file didn't load
 * @param {unknown} error
 * @returns {boolean}
 */
function didNotLoad(error) {
  return error instanceof Error && NOT_LOADED.test(error.message);
}

/**
 * @param {any} module
 * @returns {Loaded}
 */
function loaded(module) {
  return { status: 'loaded', module };
}

/**
 * @param {Reason} reason
 * @param {() => Promise<Result>} retry
 * @returns {Failed}
 */
function failed(reason, retry) {
  return { status: 'failed', reason, retry };
}

/**
 * A copy of the page's stylesheet link or style element, for another document. A link's href
 * goes over as the absolute URL, since the other document's base isn't the page's.
 * @param {Document} target
 * @param {Element} sheet
 * @returns {Element}
 */
function copyOf(target, sheet) {
  const copy = /** @type {Element} */ (target.importNode(sheet, true));
  if (sheet.tagName === 'LINK') /** @type {HTMLLinkElement} */ (copy).href = /** @type {HTMLLinkElement} */ (sheet).href;
  return copy;
}

/**
 * A loader over `host`
 * @param {Host} host
 */
export function createLoader(host) {
  /** @type {Set<() => unknown>} */
  const guards = new Set();
  /** @type {Set<Document>} */
  const extraDocuments = new Set();
  /** @type {WeakSet<Element>} */
  const mirrored = new WeakSet();
  /** @type {Map<string, Promise<Result>>} each library's load, kept once it starts */
  const libraries = new Map();

  const loader = {
    buildId: host.buildId,
    seams: /** @type {Seams} */ ({ ...seams }),
    loadChunk,
    loadLibrary,
    registerReloadGuard,
    reloadAfterGuards,
    registerExtraDocument,
  };

  /**
   * Load a chunk. `load` is `() => import('./literal.js')`, so the bundler sees the chunk and
   * its name is the module's file name, which build-info.json's chunks maps to its file.
   * @param {string} name
   * @param {() => Promise<any>} load
   * @returns {Promise<Result>}
   */
  function loadChunk(name, load) {
    const again = () => loadChunk(name, load);
    return settle(name, async () => {
      try {
        return loaded(await load());
      } catch (error) {
        if (!didNotLoad(error)) return failed('evaluation-failed', again);
      }
      const info = await buildInfo();
      if (isOtherBuild(info)) return failed('build-mismatch', again);
      const file = info && info.chunks && typeof info.chunks[name] === 'string' ? info.chunks[name] : null;
      if (file === null) return failed('chunk-missing', again);
      try {
        return loaded(await host.importUrl(`${host.getURL(file)}?r=1`));
      } catch (error) {
        return failed(didNotLoad(error) ? 'chunk-missing' : 'evaluation-failed', again);
      }
    });
  }

  /**
   * Load a vendored library by its name in host.libraries: its script once, then its global
   * @param {string} name
   * @returns {Promise<Result>}
   */
  function loadLibrary(name) {
    const known = libraries.get(name);
    if (known) return known;
    const library = host.libraries[name];
    const again = () => {
      // Only this failed load's entry goes: a retry that's running already is the one to answer
      if (libraries.get(name) === loading) libraries.delete(name);
      return loadLibrary(name);
    };
    const loading = settle(name, async () => {
      if (!library) return failed('chunk-missing', again);
      if (host.global[library.global]) return loaded(host.global[library.global]);
      // Its path is the same in every build, so a newer build's file would run in this page
      if (isOtherBuild(await buildInfo())) return failed('build-mismatch', again);
      if (!(await script(library.url()))) {
        if (isOtherBuild(await buildInfo())) return failed('build-mismatch', again);
        if (!(await script(`${library.url()}?r=1`))) return failed('chunk-missing', again);
      }
      const module = host.global[library.global];
      return module ? loaded(module) : failed('evaluation-failed', again);
    });
    libraries.set(name, loading);
    return loading;
  }

  /**
   * Put in a classic script and wait for it: true once it ran, false when its file didn't load,
   * and then it's taken out again
   * @param {string} url
   * @returns {Promise<boolean>}
   */
  function script(url) {
    return new Promise((resolve) => {
      const page = /** @type {Document} */ (host.document);
      const element = page.createElement('script');
      element.src = url;
      element.onload = () => resolve(true);
      element.onerror = () => {
        element.remove();
        resolve(false);
      };
      page.head.appendChild(element);
    });
  }

  /**
   * Run a load between the loading seam's start and its settle. Then the extra documents get the
   * stylesheets a load that worked added, or a failure is logged and goes to its state's seam.
   * @param {string} name
   * @param {() => Promise<Result>} run
   * @returns {Promise<Result>}
   */
  async function settle(name, run) {
    const settled = loader.seams.loading(name);
    const before = stylesheets();
    const result = await run();
    settled();
    if (result.status === 'loaded') {
      mirror(before);
    } else {
      host.warn(`NewTabNote loader: ${result.reason}`, { buildId: host.buildId, chunk: name, reason: result.reason });
      if (result.reason === 'build-mismatch') loader.seams.updated(name);
      else loader.seams.failed(name, result);
    }
    return result;
  }

  /**
   * The packaged build-info.json, read uncached, or null when it can't be read
   * @returns {Promise<any>}
   */
  async function buildInfo() {
    try {
      return await host.fetchJson(host.getURL('build-info.json'));
    } catch {
      return null;
    }
  }

  /**
   * Whether build-info.json is another build's than the page's code
   * @param {any} info
   * @returns {boolean}
   */
  function isOtherBuild(info) {
    return host.buildId !== null && info !== null && typeof info === 'object'
      && typeof info.buildId === 'string' && info.buildId !== host.buildId;
  }

  /**
   * The page's stylesheets: its stylesheet links and its style elements
   * @returns {Element[]}
   */
  function stylesheets() {
    return host.document ? Array.from(host.document.querySelectorAll('link[rel~="stylesheet"], style')) : [];
  }

  /**
   * Give every extra document a copy of each stylesheet the page has now that it didn't have
   * `before` a load
   * @param {Element[]} before
   */
  function mirror(before) {
    const had = new Set(before);
    for (const sheet of stylesheets()) {
      if (had.has(sheet) || mirrored.has(sheet)) continue;
      mirrored.add(sheet);
      for (const extra of extraDocuments) extra.head.appendChild(copyOf(extra, sheet));
    }
  }

  /**
   * Have reloadAfterGuards wait for `guard`, which may answer a promise
   * @param {() => unknown} guard
   * @returns {() => void} what unregisters it
   */
  function registerReloadGuard(guard) {
    guards.add(guard);
    return () => {
      guards.delete(guard);
    };
  }

  /**
   * Reload the page once every reload guard has finished, one that fails included, or once
   * RELOAD_GUARD_MS have passed, whichever comes first
   * @returns {Promise<void>}
   */
  function reloadAfterGuards() {
    return new Promise((resolve) => {
      let reloaded = false;
      const finish = () => {
        if (reloaded) return;
        reloaded = true;
        host.clearTimeout(timer);
        host.reload();
        resolve();
      };
      const timer = host.setTimeout(finish, RELOAD_GUARD_MS);
      Promise.allSettled([...guards].map((guard) => Promise.resolve().then(guard))).then(finish);
    });
  }

  /**
   * Have each stylesheet a load adds reach `target` too, until the answer is called
   * @param {Document} target
   * @returns {() => void}
   */
  function registerExtraDocument(target) {
    extraDocuments.add(target);
    return () => {
      extraDocuments.delete(target);
    };
  }

  return loader;
}

/** @typedef {ReturnType<typeof createLoader>} Loader */

/**
 * The build the page's code is from, which the build writes in place of __NTN_BUILD_ID__
 * (scripts/build/vite-config.js). In the sources, which no build wrote, the name is undefined.
 * @returns {string | null}
 */
function inlinedBuildId() {
  try {
    return __NTN_BUILD_ID__;
  } catch {
    return null;
  }
}

/**
 * The page's host: chrome.runtime's URLs, an uncached fetch, import(), and its document
 * @returns {Host}
 */
function pageHost() {
  return {
    buildId: inlinedBuildId(),
    getURL: (file) => chrome.runtime.getURL(file),
    fetchJson: async (url) => {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      return response.json();
    },
    importUrl: (url) => import(/* @vite-ignore */ url),
    document,
    global: globalThis,
    warn: (message, detail) => console.warn(message, detail),
    reload: () => location.reload(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    libraries: LIBRARIES,
  };
}

/** @type {Loader | null} */
let page = null;

/**
 * The page's one loader, made at the first call: the boot root makes it and hands it on
 * @returns {Loader}
 */
export function pageLoader() {
  if (page === null) page = createLoader(pageHost());
  return page;
}
