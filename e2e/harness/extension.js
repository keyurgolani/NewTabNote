/**
 * Packaged-extension harness. Loads a built extension into Playwright's Chromium on a
 * fresh profile, takes the extension ID from its service worker, and opens its pages.
 * It holds no product logic: specs make the assertions.
 *
 * It loads a temporary copy of the build whose manifest starts the service worker through
 * a bootstrap that installs worker-hooks.js before the extension's own worker script, so
 * the worker's uncaught exceptions are seen from its first line, after every restart, and
 * inside chrome.* listeners and callbacks. The extension ID follows the copy's path, so it
 * changes from one launch to the next, and stays the same across update(), which loads a new
 * version in place, as a store update does.
 *
 * A session aborts every request outside chrome-extension:// and records, in order, the
 * console output and uncaught exceptions of every page and the service worker, plus the
 * requests it blocked or that failed. With `network: 'offline'` (the performance probe's,
 * scripts/perf/timing.js) Chromium itself has no network instead, a dead proxy and no host
 * resolution, so no request waits on a route in this process; the log then has no blocked
 * requests. The `extension` fixture (index.js) attaches that log
 * to a failed test. Every page it opens has the new tab's App as window.app, and its start
 * as window.__ntnAppInit, which the product doesn't publish (app-hook.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { installWorkerHooks } = require('./worker-hooks');
const { hookApp } = require('./app-hook');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SURFACES = ['newtab', 'popup', 'sidepanel'];
const VIEWPORT = { width: 1280, height: 800 };
const WORKER_TIMEOUT_MS = 10_000;
const ACTIVATION_TIMEOUT_MS = 10_000;
const WORKER_READ_TIMEOUT_MS = 5_000;
const LOCALE = 'en-US';
const TIME_ZONE = 'UTC';
// worker-hooks.js logs each report as a console error that starts with this
const WORKER_UNCAUGHT_TAG = '[ntn-harness:uncaught]';
// Written next to the worker script, so its relative imports resolve as before. Chrome
// refuses extension files whose names start with "_".
const BOOTSTRAP_FILE = 'ntn-harness-worker.js';
const HOOKS_FILE = 'ntn-harness-hooks.js';
// A page's chrome.* listener or callback that throws doesn't reach pageerror: Chrome catches
// it and logs a console error with one of these prefixes
const BINDING_ERRORS = [
  ['Error in event handler: ', 'chrome.* event listener'],
  ['Error handling response: ', 'chrome.* API callback'],
];

/**
 * The built extension under test: NTN_DIST, or dist/ at the repository root
 */
function resolveDist() {
  return process.env.NTN_DIST ? path.resolve(process.env.NTN_DIST) : path.join(REPO_ROOT, 'dist');
}

/**
 * Copy the build to `dir` and start its service worker through the harness bootstrap, which
 * loads the hooks and then the worker script the manifest names, the way the manifest would:
 * importScripts for a classic worker, import for "type": "module". `version`, when given,
 * replaces the manifest's.
 */
function prepareExtension(dist, dir, { version } = {}) {
  fs.cpSync(dist, dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (version !== undefined) manifest.version = version;
  const script = manifest.background && manifest.background.service_worker;
  if (typeof script !== 'string') {
    throw new Error(`${path.join(dist, 'manifest.json')} names no background.service_worker for the harness to hook`);
  }
  const folder = path.posix.dirname(script);
  for (const file of [BOOTSTRAP_FILE, HOOKS_FILE]) {
    if (fs.existsSync(path.join(dir, folder, file))) {
      throw new Error(`${path.posix.join(folder, file)} already exists in ${dist}; the harness writes a file by that name`);
    }
  }
  const entry = `./${path.posix.basename(script)}`;
  fs.writeFileSync(path.join(dir, folder, HOOKS_FILE), `(${installWorkerHooks})(${JSON.stringify(WORKER_UNCAUGHT_TAG)});\n`);
  fs.writeFileSync(path.join(dir, folder, BOOTSTRAP_FILE), manifest.background.type === 'module'
    ? `import './${HOOKS_FILE}';\nimport ${JSON.stringify(entry)};\n`
    : `importScripts('${HOOKS_FILE}', ${JSON.stringify(entry)});\n`);
  manifest.background.service_worker = path.posix.join(folder, BOOTSTRAP_FILE);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function isExtensionWorker(worker) {
  return worker.url().startsWith('chrome-extension://');
}

/**
 * A page as the log names it: the file of an extension page, or the URL of any other
 */
function pageLabel(page) {
  if (!page) return 'unknown page';
  const url = page.url();
  return url.startsWith('chrome-extension://') ? new URL(url).pathname.slice(1) : url;
}

function requestSource(request) {
  if (request.serviceWorker()) return 'service worker';
  try {
    return pageLabel(request.frame().page());
  } catch {
    return 'unknown page';
  }
}

/**
 * The exception in a console error Chrome logs when a page's chrome.* listener or callback
 * throws, as { where, message, stack }, or null for any other text. After the prefix comes
 * the exception's stack ("TypeError: message" and its frames), or "Uncaught <value>" for a
 * thrown non-Error; the message drops that name or "Uncaught " so it reads as error.message.
 */
function bindingError(text) {
  const binding = BINDING_ERRORS.find(([prefix]) => text.startsWith(prefix));
  if (!binding) return null;
  const [prefix, where] = binding;
  const stack = text.slice(prefix.length);
  const frames = stack.search(/\n\s+at /);
  const header = frames < 0 ? stack : stack.slice(0, frames);
  const named = header.match(/^(?:[A-Za-z_$][\w$]*: |Uncaught )([\s\S]*)$/);
  return { where, message: named ? named[1] : header, stack };
}

/**
 * Settle a promise within `ms`, or reject with `message`
 */
function withTimeout(promise, ms, message) {
  let timer;
  promise.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The state a newly started worker settles in: 'activated', or 'redundant' when its script
 * threw while starting. A redundant worker still shows up and still runs what Playwright
 * evaluates in it, but it never handles an event.
 */
function activationState(worker) {
  const settled = worker.evaluate(ms => new Promise(resolve => {
    const current = self.serviceWorker;
    if (!current) {
      resolve('unknown');
      return;
    }
    const settle = () => {
      if (current.state === 'activated' || current.state === 'redundant') resolve(current.state);
    };
    current.addEventListener('statechange', settle);
    settle();
    setTimeout(() => resolve(current.state), ms);
  }), ACTIVATION_TIMEOUT_MS);
  return withTimeout(settled, ACTIVATION_TIMEOUT_MS + WORKER_READ_TIMEOUT_MS, 'The service worker stopped answering while it started');
}

/** The sessions launched and not yet closed, which harnessFor looks through */
const OPEN_SESSIONS = new Set();

class ExtensionSession {
  constructor(context, { dist, root, extensionDir, network = 'route' }) {
    this.context = context;
    this.dist = dist;
    this._network = network;
    this.extensionId = null;
    this._root = root;
    this._extensionDir = extensionDir;
    this._startedAt = Date.now();
    this._lines = [];
    this._uncaught = [];
    this._workerReports = new Set();
    this._blocked = new WeakSet();
    this._workers = new WeakSet();
    this._worker = null;
    OPEN_SESSIONS.add(this);
    // The about:blank page a persistent context opens with, reused for the first surface
    this._blankPage = context.pages().find(page => page.url() === 'about:blank') || null;
    this._surfaceOpened = false;
  }

  /**
   * The extension's service worker. Playwright keeps the same Worker across a restart of
   * the worker; the bootstrap reinstalls the hooks in the new global.
   */
  get worker() {
    return this._worker;
  }

  url(file) {
    return `chrome-extension://${this.extensionId}/${file}`;
  }

  /**
   * Open newtab.html, popup.html, or sidepanel.html as an extension page at 1280 by 800
   */
  async openSurface(name) {
    if (!SURFACES.includes(name)) {
      throw new Error(`openSurface: unknown surface "${name}"; expected one of ${SURFACES.join(', ')}`);
    }
    this._surfaceOpened = true;
    const blank = this._blankPage;
    this._blankPage = null;
    const page = blank && !blank.isClosed() && blank.url() === 'about:blank' ? blank : await this.context.newPage();
    await page.goto(this.url(`${name}.html`));
    return page;
  }

  /**
   * Mark onboarding complete so the new tab skips the walkthrough (app.js reads
   * setting_hasCompletedOnboarding on load). Runs before the first page opens.
   */
  async seedOnboarded() {
    if (this._surfaceOpened) throw new Error('seedOnboarded() has to run before the first openSurface()');
    await this.worker.evaluate(() => chrome.storage.local.set({ setting_hasCompletedOnboarding: true }));
  }

  /**
   * Uncaught exceptions so far, from every page and the worker, as { source, where, message,
   * stack }. Reads the worker's own record first (see _readWorker), and fails if the worker
   * runs without the hooks or doesn't answer.
   */
  async uncaught() {
    await this._readWorker();
    return this._uncaught.map(error => ({ ...error }));
  }

  log() {
    return [
      `dist: ${this.dist}`,
      `loaded from: ${this._extensionDir}`,
      `extension: ${this.extensionId || '(not found)'}`,
      '',
      ...this._lines,
      '',
    ].join('\n');
  }

  /**
   * Attach the log as a file. Playwright copies it under the test's output directory,
   * which CI uploads; the source goes away with the session's temp directory.
   */
  async attachLog(testInfo) {
    const file = path.join(this._root, 'extension-log.txt');
    await fs.promises.writeFile(file, this.log());
    await testInfo.attach('extension-log', { path: file, contentType: 'text/plain' });
  }

  async close() {
    OPEN_SESSIONS.delete(this);
    try {
      await this.context.unrouteAll({ behavior: 'ignoreErrors' });
      await this.context.close();
    } finally {
      fs.rmSync(this._root, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  /**
   * Update the extension in place, as a store update does: write `dist` (by default the
   * same build) into the loaded copy with manifest version `version`, and load it again
   * while the browser runs. Chromium unloads the old version, its service worker
   * registration included, and loads the new one, whose onInstalled runs with reason
   * "update". The profile and the extension ID stay. Resolves once the updated worker has
   * activated. (chrome.runtime.reload() can't do this: Chromium unloads an extension loaded
   * with --load-extension and never loads it back. Restarting the browser on new files
   * isn't the same either: the new version starts over the old registration, and a classic
   * worker that turns into a module one waits as installed until the next restart.)
   */
  async update({ version, dist = this.dist }) {
    if (typeof version !== 'string' || version === '') throw new Error('update() needs the version to update to');
    const browser = this.context.browser();
    if (!browser) throw new Error('update() needs the browser behind the context, to load the update over CDP');
    // Keep the old worker's reports, including any its console lines never carried
    await this._readWorker();
    const previous = this._worker;
    fs.rmSync(this._extensionDir, { recursive: true, force: true, maxRetries: 3 });
    prepareExtension(dist, this._extensionDir, { version });
    this.dist = dist;
    this._record(`updating to ${version} from ${dist}`);

    const started = this.context.waitForEvent('serviceworker', {
      predicate: worker => isExtensionWorker(worker) && worker !== previous,
      timeout: WORKER_TIMEOUT_MS,
    }).catch(() => null);
    const cdp = await browser.newBrowserCDPSession();
    let loaded;
    try {
      loaded = await cdp.send('Extensions.loadUnpacked', { path: this._extensionDir });
    } finally {
      await cdp.detach().catch(() => {});
    }
    if (loaded.id !== this.extensionId) {
      throw new Error(`The update loaded as extension ${loaded.id}, not ${this.extensionId}, so it isn't the same install`);
    }
    await started;
    if (this._worker === previous) {
      throw new Error(`No updated service worker started within ${WORKER_TIMEOUT_MS / 1000} seconds of loading version ${version}`);
    }
    await this._checkWorker();
  }

  async _start() {
    this._watch();
    if (this._network === 'route') await this._blockNetwork();
    // Every page's new tab App as window.app, and its start as window.__ntnAppInit (app-hook.js)
    await this.context.addInitScript(hookApp);

    this.context.serviceWorkers().forEach(worker => this._adoptWorker(worker));
    if (!this._worker) {
      await this.context.waitForEvent('serviceworker', { predicate: isExtensionWorker, timeout: WORKER_TIMEOUT_MS }).catch(() => {});
    }
    if (!this._worker) {
      throw new Error(`No extension service worker started within ${WORKER_TIMEOUT_MS / 1000} seconds of loading ${this.dist}. `
        + "Check that the build is complete and that its manifest's background.service_worker exists.");
    }
    this.extensionId = new URL(this._worker.url()).host;
    await this._checkWorker();
  }

  /**
   * Wait for the current worker to activate, then read its reports and check it runs with
   * the harness's locale and time zone
   */
  async _checkWorker() {
    const state = await activationState(this._worker);
    await this._readWorker();
    if (state !== 'activated') {
      const thrown = this._uncaught.filter(error => error.source === 'service worker').map(error => error.stack || error.message);
      throw new Error(`The service worker never activated (state: ${state}); its script probably threw while starting`
        + (thrown.length > 0 ? `:\n${thrown.join('\n')}` : ''));
    }

    const [language, timeZone] = await this._worker.evaluate(() => [navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone]);
    if (language !== LOCALE || timeZone !== TIME_ZONE) {
      throw new Error(`The service worker runs with locale ${language} in time zone ${timeZone}; the harness expects ${LOCALE} in ${TIME_ZONE}`);
    }
  }

  /**
   * Collect the reports the worker holds. Its console lines usually arrive too, but one it
   * logs before the harness subscribes (the worker normally starts just after the launch
   * resolves) would be lost. Fails when the worker runs without the hooks, or doesn't answer
   * (stopped).
   */
  async _readWorker() {
    let harness;
    try {
      harness = await withTimeout(
        this._worker.evaluate(() => (self.__ntnHarness ? { instance: self.__ntnHarness.instance, reports: self.__ntnHarness.reports } : null)),
        WORKER_READ_TIMEOUT_MS,
        `it didn't answer within ${WORKER_READ_TIMEOUT_MS / 1000} seconds, so it may be stopped`,
      );
    } catch (error) {
      throw new Error(`Could not read the service worker's uncaught exceptions: ${error.message}`);
    }
    if (!harness) {
      throw new Error('The service worker is running without the harness hooks (no self.__ntnHarness), so its uncaught exceptions would go unseen');
    }
    harness.reports.forEach(report => this._recordWorkerReport({ instance: harness.instance, ...report }));
  }

  _record(line) {
    const seconds = ((Date.now() - this._startedAt) / 1000).toFixed(3);
    this._lines.push(`[+${seconds}s] ${line}`);
  }

  _recordUncaught(source, message, stack, where = '') {
    this._uncaught.push({ source, where, message, stack });
    this._record(`${source} uncaught${where ? ` (${where})` : ''}: ${stack || message}`);
  }

  // A worker report arrives as a console error and again when _readWorker reads the worker
  _recordWorkerReport({ instance, seq, where, message, stack }) {
    const key = `${instance}:${seq}`;
    if (this._workerReports.has(key)) return;
    this._workerReports.add(key);
    this._recordUncaught('service worker', message, stack, where);
  }

  _watch() {
    this.context.on('console', message => {
      const worker = message.worker();
      const text = message.text();
      if (worker && text.startsWith(WORKER_UNCAUGHT_TAG)) {
        try {
          this._recordWorkerReport(JSON.parse(text.slice(WORKER_UNCAUGHT_TAG.length)));
        } catch {
          this._recordUncaught('service worker', text, undefined);
        }
        return;
      }
      const caught = !worker && message.type() === 'error' ? bindingError(text) : null;
      if (caught) {
        this._recordUncaught(pageLabel(message.page()), caught.message, caught.stack, caught.where);
        return;
      }
      this._record(`${worker ? 'service worker' : pageLabel(message.page())} console.${message.type()}: ${text}`);
    });
    this.context.on('weberror', webError => {
      const error = webError.error();
      this._recordUncaught(pageLabel(webError.page()), error.message, error.stack);
    });
    this.context.on('requestfailed', request => {
      if (this._blocked.has(request)) return;
      const reason = request.failure() ? request.failure().errorText : 'unknown error';
      this._record(`${requestSource(request)} request failed: ${request.method()} ${request.url()} (${reason})`);
    });
    this.context.on('serviceworker', worker => this._adoptWorker(worker));
  }

  async _blockNetwork() {
    // Specs may add routes; Playwright runs the last one added first, so this one only
    // sees what theirs pass on
    await this.context.route('**/*', route => {
      const request = route.request();
      if (request.url().startsWith('chrome-extension://')) return route.fallback();
      this._blocked.add(request);
      this._record(`blocked ${request.method()} ${request.url()} from ${requestSource(request)}`);
      return route.abort('blockedbyclient');
    });
    await this.context.routeWebSocket(/.*/, webSocket => {
      this._record(`blocked WebSocket ${webSocket.url()}`);
      return webSocket.close({ code: 1008, reason: 'Blocked by the e2e harness' });
    });
  }

  _adoptWorker(worker) {
    if (!isExtensionWorker(worker) || this._workers.has(worker)) return;
    this._workers.add(worker);
    this._worker = worker;
    this._record(`service worker running: ${worker.url()}`);
  }
}

// The 'offline' network: every request outside the extension fails in Chromium's own network
// stack, from pages and the service worker alike, IP literals included (the proxy), and names
// never resolve
const OFFLINE_ARGS = ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND'];

/**
 * Launch Chromium with a hooked copy of the built extension on a fresh profile. Resolves
 * once the extension's service worker has activated.
 *
 *   dist      the built extension directory (default: resolveDist()); never modified
 *   headless  default true
 *   chromium  the Playwright browser type; the fixture passes its own
 *   network   'route' (default): every request outside the extension is aborted through a
 *             route, and logged. 'offline': Chromium runs with a dead proxy and no host
 *             resolution, so nothing outside the extension loads, and no extension request
 *             passes through a route here, which would cost each one a round trip to this
 *             process (the performance probe's timing depends on that)
 *   sources   repository paths, files or directories, to copy into the extension copy at their
 *             own paths, for a spec that imports source modules the bundle doesn't ship there
 *             (#27 slice 2; default none)
 */
async function launchExtension({ dist = resolveDist(), headless = true, chromium = require('@playwright/test').chromium, network = 'route', sources = [] } = {}) {
  if (network !== 'route' && network !== 'offline') throw new Error(`launchExtension: network is 'route' or 'offline', not ${JSON.stringify(network)}`);
  if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
    throw new Error(`No built extension at ${dist} (no manifest.json). npm run test:extension tests a build and `
      + 'never makes one: run `npm run build` first, or set NTN_DIST to a built extension directory.');
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-e2e-'));
  const extensionDir = path.join(root, 'extension');
  let context;
  try {
    prepareExtension(dist, extensionDir);
    for (const source of sources) fs.cpSync(path.join(REPO_ROOT, source), path.join(extensionDir, source), { recursive: true });
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
      // Branded Chrome ignores --load-extension since Chrome 137, and the headless shell
      // can't run extensions, so headless runs use Playwright's own Chromium build
      ...(headless ? { channel: 'chromium' } : {}),
      headless,
      // --enable-unsafe-extension-debugging turns on the CDP Extensions domain update() uses
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, `--lang=${LOCALE}`, '--enable-unsafe-extension-debugging', ...(network === 'offline' ? OFFLINE_ARGS : [])],
      // Pages get locale and timezoneId emulation; the worker takes the process's TZ and,
      // on Linux, LANGUAGE
      env: { ...process.env, TZ: TIME_ZONE, LANGUAGE: LOCALE.replace('-', '_') },
      locale: LOCALE,
      timezoneId: TIME_ZONE,
      viewport: VIEWPORT,
    });
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }

  const session = new ExtensionSession(context, { dist, root, extensionDir, network });
  try {
    await session._start();
  } catch (error) {
    await session.close().catch(() => {});
    throw error;
  }
  return session;
}

/**
 * The open session whose service worker `worker` is, or was before an update, or null: for
 * fixture-host.js, which a spec hands only the worker
 * @param {unknown} worker
 */
function harnessFor(worker) {
  for (const session of OPEN_SESSIONS) if (session.worker === worker || session._workers.has(worker)) return session;
  return null;
}

module.exports = { launchExtension, resolveDist, harnessFor, SURFACES, VIEWPORT };
