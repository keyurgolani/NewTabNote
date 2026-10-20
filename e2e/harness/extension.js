/**
 * Packaged-extension harness. Loads a built extension into Playwright's Chromium on a
 * fresh profile, takes the extension ID from its service worker, and opens its pages.
 * It holds no product logic: specs make the assertions.
 *
 * A session aborts every request outside chrome-extension:// and records, in order, the
 * console output and uncaught exceptions of every page and the service worker, plus the
 * requests it blocked or that failed. The `extension` fixture (index.js) attaches that
 * log to a failed test.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SURFACES = ['newtab', 'popup', 'sidepanel'];
const VIEWPORT = { width: 1280, height: 800 };
const WORKER_TIMEOUT_MS = 10_000;
const LOCALE = 'en-US';
const TIME_ZONE = 'UTC';
// Playwright doesn't report a service worker's uncaught exceptions, so the harness hooks
// the worker, which logs each one as a console error starting with this tag
const WORKER_UNCAUGHT_TAG = '[ntn-harness:uncaught]';

/**
 * The built extension under test: NTN_DIST, or dist/ at the repository root
 */
function resolveDist() {
  return process.env.NTN_DIST ? path.resolve(process.env.NTN_DIST) : path.join(REPO_ROOT, 'dist');
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

class ExtensionSession {
  constructor(context, { dist, profileDir }) {
    this.context = context;
    this.dist = dist;
    this.extensionId = null;
    this._profileDir = profileDir;
    this._startedAt = Date.now();
    this._lines = [];
    this._uncaught = [];
    this._blocked = new WeakSet();
    this._workers = new WeakSet();
    this._worker = null;
    this._hooking = null;
    // The about:blank page a persistent context opens with, reused for the first surface
    this._blankPage = context.pages().find(page => page.url() === 'about:blank') || null;
    this._surfaceOpened = false;
  }

  /**
   * The extension's running service worker (a new one after a restart)
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
   * Uncaught exceptions so far, from every page and the worker, as { source, message, stack }
   */
  uncaught() {
    return this._uncaught.map(error => ({ ...error }));
  }

  log() {
    return [`dist: ${this.dist}`, `extension: ${this.extensionId || '(not found)'}`, '', ...this._lines, ''].join('\n');
  }

  /**
   * Attach the log as a file. Playwright copies it under the test's output directory,
   * which CI uploads; the source goes away with the profile.
   */
  async attachLog(testInfo) {
    const file = path.join(this._profileDir, 'extension-log.txt');
    await fs.promises.writeFile(file, this.log());
    await testInfo.attach('extension-log', { path: file, contentType: 'text/plain' });
  }

  async close() {
    try {
      await this.context.unrouteAll({ behavior: 'ignoreErrors' });
      await this.context.close();
    } finally {
      fs.rmSync(this._profileDir, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  async _start() {
    this._watch();
    await this._blockNetwork();

    this.context.serviceWorkers().forEach(worker => this._adoptWorker(worker));
    if (!this._worker) {
      await this.context.waitForEvent('serviceworker', { predicate: isExtensionWorker, timeout: WORKER_TIMEOUT_MS }).catch(() => {});
    }
    if (!this._worker) {
      throw new Error(`No extension service worker started within ${WORKER_TIMEOUT_MS / 1000} seconds of loading ${this.dist}. `
        + "Check that the build is complete and that its manifest's background.service_worker loads.");
    }
    this.extensionId = new URL(this._worker.url()).host;
    await this._hooking;

    const [language, timeZone] = await this._worker.evaluate(() => [navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone]);
    if (language !== LOCALE || timeZone !== TIME_ZONE) {
      throw new Error(`The service worker runs with locale ${language} in time zone ${timeZone}; the harness expects ${LOCALE} in ${TIME_ZONE}`);
    }
  }

  _record(line) {
    const seconds = ((Date.now() - this._startedAt) / 1000).toFixed(3);
    this._lines.push(`[+${seconds}s] ${line}`);
  }

  _recordUncaught(source, message, stack) {
    this._uncaught.push({ source, message, stack });
    this._record(`${source} uncaught: ${stack || message}`);
  }

  _watch() {
    this.context.on('console', message => {
      const worker = message.worker();
      const text = message.text();
      if (worker && text.startsWith(WORKER_UNCAUGHT_TAG)) {
        try {
          const error = JSON.parse(text.slice(WORKER_UNCAUGHT_TAG.length));
          this._recordUncaught('service worker', error.message, error.stack);
        } catch {
          this._recordUncaught('service worker', text, undefined);
        }
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

  /**
   * Track a newly started extension worker and hook its uncaught exceptions. Exceptions
   * it throws while starting, before the hook is in, are missed; one thrown at the top
   * level stops it from registering, which _start reports.
   */
  _adoptWorker(worker) {
    if (!isExtensionWorker(worker) || this._workers.has(worker)) return;
    this._workers.add(worker);
    this._worker = worker;
    this._record(`service worker running: ${worker.url()}`);
    this._hooking = worker.evaluate(tag => {
      if (self.__ntnHarnessHooked) return;
      self.__ntnHarnessHooked = true;
      const report = (error, fallback) => console.error(tag, JSON.stringify(error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { message: fallback === undefined ? String(error) : fallback }));
      self.addEventListener('error', event => report(event.error, event.message));
      self.addEventListener('unhandledrejection', event => report(event.reason));
    }, WORKER_UNCAUGHT_TAG);
    // The first worker's hook is awaited by _start; a restarted worker's failure is logged
    this._hooking.catch(error => this._record(`could not hook the service worker: ${error.message}`));
  }
}

/**
 * Launch Chromium with the built extension on a fresh profile. Resolves once the
 * extension's service worker is running and hooked.
 *
 *   dist      the built extension directory (default: resolveDist())
 *   headless  default true
 *   chromium  the Playwright browser type; the fixture passes its own
 */
async function launchExtension({ dist = resolveDist(), headless = true, chromium = require('@playwright/test').chromium } = {}) {
  if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
    throw new Error(`No built extension at ${dist} (no manifest.json). npm run test:extension tests a build and `
      + 'never makes one: run `npm run build` first, or set NTN_DIST to a built extension directory.');
  }

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-e2e-profile-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      // Branded Chrome ignores --load-extension since Chrome 137, and the headless shell
      // can't run extensions, so headless runs use Playwright's own Chromium build
      ...(headless ? { channel: 'chromium' } : {}),
      headless,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, `--lang=${LOCALE}`],
      // Pages get locale and timezoneId emulation; the worker takes the process's TZ and,
      // on Linux, LANGUAGE
      env: { ...process.env, TZ: TIME_ZONE, LANGUAGE: LOCALE.replace('-', '_') },
      locale: LOCALE,
      timezoneId: TIME_ZONE,
      viewport: VIEWPORT,
    });
  } catch (error) {
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }

  const session = new ExtensionSession(context, { dist, profileDir });
  try {
    await session._start();
  } catch (error) {
    await session.close().catch(() => {});
    throw error;
  }
  return session;
}

module.exports = { launchExtension, resolveDist, SURFACES, VIEWPORT };
