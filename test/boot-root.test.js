'use strict';

// #27 slice 3, "Entries": the new tab's boot root (js/entries/newtab.js, js/entries/boot.js),
// which holds ntn-boot while the tab starts and loads the workspace chunk through the loader,
// and the boot guard (js/entries/boot-guard.js), which watches for a start that fails before
// the workspace chunk's boot() has returned. State 1's seam, showBootFailure, logs one line and
// shows nothing.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { htmlTags } = require('../scripts/build/markup.js');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const boot = () => import('../js/entries/boot.js');
const lazy = () => import('../js/runtime/lazy.js');

/** A Web Locks stand-in that records each request and answers once the holder lets go */
function fakeLocks() {
  const requests = [];
  return {
    requests,
    request(name, options, callback) {
      const entry = { name, options, released: false };
      requests.push(entry);
      return Promise.resolve(callback({ name, mode: options.mode })).then((value) => {
        entry.released = true;
        return value;
      });
    },
  };
}

/** Timers that run only when a test fires them */
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimeout: (id) => { if (timers[id]) timers[id].cleared = true; },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('the boot root holds ntn-boot while the tab starts (js/entries/boot.js)', () => {
  it('shared, from script start until the page is interaction-ready', async () => {
    const { holdBootLock, BOOT_LOCK } = await boot();
    const locks = fakeLocks();
    const timers = fakeTimers();
    let ready;
    let stopped = 0;
    const held = holdBootLock({ locks, whenReady: (callback) => { ready = callback; return () => { stopped += 1; }; }, ...timers });
    assert.deepEqual(locks.requests.map(({ name, options }) => [name, options.mode]), [[BOOT_LOCK, 'shared']]);
    await tick();
    assert.equal(locks.requests[0].released, false);
    ready();
    await held;
    assert.equal(locks.requests[0].released, true);
    assert.equal(stopped, 1);
    assert.equal(timers.timers[0].cleared, true);
  });

  it('or for 10 seconds at most, when the mark never comes', async () => {
    const { holdBootLock, BOOT_LOCK_MS } = await boot();
    const locks = fakeLocks();
    const timers = fakeTimers();
    let stopped = 0;
    const held = holdBootLock({ locks, whenReady: () => () => { stopped += 1; }, ...timers });
    await tick();
    assert.deepEqual(timers.timers.map(({ ms }) => ms), [BOOT_LOCK_MS]);
    assert.equal(BOOT_LOCK_MS, 10_000);
    timers.timers[0].fn();
    await held;
    assert.equal(locks.requests[0].released, true);
    assert.equal(stopped, 1, 'it stops watching for the mark');
  });

  it('and starts the tab without it on a page with no Web Locks, or one that refuses the lock', async () => {
    const { holdBootLock } = await boot();
    await holdBootLock({ locks: undefined, whenReady: () => () => {}, ...fakeTimers() });
    const refusing = { request: async () => { throw new DOMException('no', 'SecurityError'); } };
    const warned = [];
    const { warn } = console;
    console.warn = (...args) => warned.push(args);
    try {
      await holdBootLock({ locks: refusing, whenReady: () => () => {}, ...fakeTimers() });
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(warned, [['NewTabNote: ntn-boot not held', 'SecurityError']]);
  });

  it('watches for the interaction-ready mark, the one js/app.js makes, and stops at the first', async () => {
    const { whenInteractionReady, INTERACTION_READY } = await boot();
    assert.match(read('js/app.js'), new RegExp(`const INTERACTION_READY_MARK = '${INTERACTION_READY}';`));
    const observers = [];
    const previous = globalThis.PerformanceObserver;
    globalThis.PerformanceObserver = class {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
      observe(options) { this.options = options; }
      disconnect() { this.disconnected = true; }
    };
    try {
      let calls = 0;
      whenInteractionReady(() => { calls += 1; });
      const [observer] = observers;
      assert.deepEqual(observer.options, { type: 'mark', buffered: true });
      const list = (names) => ({ getEntriesByName: (name, type) => (type === 'mark' ? names.filter((one) => one === name) : []) });
      observer.callback(list(['something else']));
      assert.equal(calls, 0);
      observer.callback(list([INTERACTION_READY]));
      assert.equal(calls, 1);
      assert.equal(observer.disconnected, true);
    } finally {
      globalThis.PerformanceObserver = previous;
    }
  });
});

describe('the boot root loads the workspace chunk and calls its boot() (js/entries/boot.js)', () => {
  function fakeHost(overrides = {}) {
    return {
      buildId: 'build-a',
      getURL: (file) => `chrome-extension://ntn/${file}`,
      fetchJson: async () => ({ buildId: 'build-a', chunks: { workspace: 'assets/workspace-A1.js' } }),
      importUrl: async (url) => { throw new TypeError(`Failed to fetch dynamically imported module: ${url}`); },
      document: null,
      global: {},
      warn: () => {},
      reload: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
      libraries: {},
      ...overrides,
    };
  }

  /** What the boot guard on `target` hears, in order: ntn:boot, and each ntn:boot-failed's detail */
  function listen(target) {
    const heard = [];
    target.addEventListener('ntn:boot', () => heard.push('ntn:boot'));
    target.addEventListener('ntn:boot-failed', (event) => heard.push(event.detail));
    return heard;
  }

  it('calls boot() with the loader once the chunk loaded, and tells the boot guard ntn:boot once boot() has returned', async () => {
    const { bootWorkspace } = await boot();
    const { createLoader } = await lazy();
    const loader = createLoader(fakeHost());
    const target = new EventTarget();
    const heard = listen(target);
    const booted = await bootWorkspace({ loader, target, load: async () => ({ boot: (handed) => heard.push(handed === loader ? 'boot(loader)' : 'boot(?)') }) });
    assert.equal(booted, true);
    assert.deepEqual(heard, ['boot(loader)', 'ntn:boot']);
  });

  it("tells it ntn:boot-failed with the build, the chunk, and the reason when the chunk didn't load, and calls nothing", async () => {
    const { bootWorkspace } = await boot();
    const { createLoader } = await lazy();
    for (const [host, reason] of [
      [fakeHost(), 'chunk-missing'],
      [fakeHost({ fetchJson: async () => ({ buildId: 'build-b', chunks: {} }) }), 'build-mismatch'],
    ]) {
      const target = new EventTarget();
      const heard = listen(target);
      const booted = await bootWorkspace({
        loader: createLoader(host),
        target,
        load: async () => { throw new TypeError('Failed to fetch dynamically imported module: chrome-extension://ntn/assets/workspace-A1.js'); },
      });
      assert.equal(booted, false);
      assert.deepEqual(heard, [{ buildId: 'build-a', chunk: 'workspace', reason }]);
    }
  });

  it('tells it ntn:boot-failed, as evaluation-failed, when boot() throws before App takes over, and never ntn:boot', async () => {
    const { bootWorkspace } = await boot();
    const { createLoader } = await lazy();
    const target = new EventTarget();
    const heard = listen(target);
    const booted = await bootWorkspace({
      loader: createLoader(fakeHost()),
      target,
      load: async () => ({ boot: () => { throw new TypeError('note text'); } }),
    });
    assert.equal(booted, false);
    assert.deepEqual(heard, [{ buildId: 'build-a', chunk: 'workspace', reason: 'evaluation-failed' }]);
    assert.doesNotMatch(JSON.stringify(heard), /note text/);
  });

  it("starts through startWorkspace, which tells the boot guard a failure of the root's own as ntn:boot-failed and never rejects", async () => {
    const { startWorkspace } = await boot();
    const { createLoader } = await lazy();
    const target = new EventTarget();
    const heard = listen(target);
    assert.equal(await startWorkspace({ loader: createLoader(fakeHost()), target, load: async () => ({ boot() {} }) }), true);
    assert.deepEqual(heard, ['ntn:boot']);

    // A loader whose own answer rejects
    const loader = { ...createLoader(fakeHost()), loadChunk: async () => { throw new Error('a loader that rejects'); } };
    const failing = new EventTarget();
    const failed = listen(failing);
    assert.equal(await startWorkspace({ loader, target: failing, load: async () => ({ boot() {} }) }), false);
    assert.deepEqual(failed, [{ buildId: 'build-a', chunk: 'newtab', reason: 'uncaught' }]);
  });

  it('is the one module newtab.html loads, after the classic boot guard, and loads js/workspace.js as the workspace chunk', () => {
    const scripts = htmlTags(read('newtab.html')).filter((tag) => tag.name === 'script');
    assert.deepEqual(scripts.map((tag) => [tag.attributes.get('src'), tag.attributes.get('type') || 'classic']), [
      ['js/entries/boot-guard.js', 'classic'],
      ['js/entries/newtab.js', 'module'],
    ]);
    const root = read('js/entries/newtab.js');
    // The root starts through startWorkspace, so no promise of its own goes unhandled
    assert.match(root, /^startWorkspace\(\{ loader: pageLoader\(\), target: window, load: \(\) => import\('\.\.\/workspace\.js'\) \}\);$/m);
    assert.doesNotMatch(root, /bootWorkspace/);
    // The loader names the chunk by its module's file, as build-info.json's chunks does
    assert.match(read('js/entries/boot.js'), /loader\.loadChunk\('workspace', load\)/);
    assert.match(read('js/workspace.js'), /^export \{ boot \} from '\.\/main\.js';$/m);
    assert.match(read('js/main.js'), /export function boot\(loader\) \{\n {2}return startNewTab\(\{ loader \}\);\n\}/);
    assert.doesNotMatch(read('js/main.js'), /^startNewTab\(\);$/m);
  });
});

describe("the composition root, which the workspace chunk's boot() runs (js/kernel/composition/newtab.js)", () => {
  const { createLegacyEnv, FakeDocument } = require('./helpers/legacy-env');
  const { loadPageModule } = require('./helpers/page-module');

  /** The root over the sandbox's Storage, with a stand-in App that records what it's handed */
  async function root(readyState) {
    const document = new FakeDocument();
    if (readyState) document.readyState = readyState;
    const env = createLegacyEnv({ document });
    env.load('js/utils.js', 'js/core/storage-error.js', 'js/storage.js');
    const built = [];
    env.global.App = class {
      constructor(options) { this.options = options; built.push(this); }
      init() { return Promise.resolve('started'); }
    };
    const { startNewTab } = await loadPageModule(env, 'js/kernel/composition/newtab.js');
    return { env, built, startNewTab };
  }

  it("starts at once, since a chunk the boot root loads misses DOMContentLoaded, and hands App the page's loader", async () => {
    const { env, built, startNewTab } = await root('interactive');
    const loader = { loadLibrary() {} };
    const started = startNewTab({ loader });
    assert.equal(built.length, 1);
    assert.equal(built[0].options.loader, loader);
    await started;
    assert.deepEqual(env.document.listeners.DOMContentLoaded || [], []);
  });

  it('waits for DOMContentLoaded while the document still loads, and hands App no loader without one', async () => {
    const { env, built, startNewTab } = await root('loading');
    assert.equal(startNewTab(), null);
    assert.equal(built.length, 0);
    await Promise.all(env.document.fire('DOMContentLoaded'));
    assert.equal(built.length, 1);
    assert.equal(built[0].options.loader, null);
  });
});

describe('the boot guard (js/entries/boot-guard.js)', () => {
  /**
   * The guard run as the classic script it is, on a window that records its listeners, with the
   * console line it logs
   */
  function guard() {
    const listeners = new Map();
    const logged = [];
    class Element {}
    class HTMLScriptElement extends Element {
      constructor(type) {
        super();
        this.type = type;
      }
    }
    const window = {
      addEventListener(type, fn, capture) { listeners.set(`${type}${capture ? ' capture' : ''}`, fn); },
      removeEventListener(type, fn, capture) {
        const key = `${type}${capture ? ' capture' : ''}`;
        if (listeners.get(key) === fn) listeners.delete(key);
      },
    };
    const context = vm.createContext({ window, Element, HTMLScriptElement, console: { error: (...args) => logged.push(args) } });
    vm.runInContext(read('js/entries/boot-guard.js'), context, { filename: 'js/entries/boot-guard.js' });
    const fire = (type, event = {}, capture = false) => {
      const fn = listeners.get(`${type}${capture ? ' capture' : ''}`);
      if (fn) fn({ type, ...event });
    };
    return { listeners, logged, fire, Element, HTMLScriptElement };
  }

  const lines = (logged) => logged.map(([message, failure]) => [message, { ...failure }]);

  it("listens from script start: errors at capture, and the root's two events", () => {
    const { listeners } = guard();
    assert.deepEqual([...listeners.keys()].sort(), ['error capture', 'ntn:boot', 'ntn:boot-failed']);
  });

  it("logs a line and shows nothing when the root's module script doesn't load", () => {
    const { fire, logged, HTMLScriptElement, listeners } = guard();
    fire('error', { target: new HTMLScriptElement('') }, true);
    assert.deepEqual(logged, [], 'a classic script is no root');
    fire('error', { target: new HTMLScriptElement('module') }, true);
    assert.deepEqual(lines(logged), [['NewTabNote: the new tab did not start', { buildId: null, chunk: 'newtab', reason: 'chunk-missing' }]]);
    assert.equal(listeners.size, 0, 'its listeners come off at the first failure');
  });

  it("logs the build, the chunk, and the reason the root's ntn:boot-failed carries", () => {
    const { fire, logged } = guard();
    fire('ntn:boot-failed', { detail: { buildId: 'build-a', chunk: 'workspace', reason: 'build-mismatch' } });
    assert.deepEqual(lines(logged), [['NewTabNote: the new tab did not start', { buildId: 'build-a', chunk: 'workspace', reason: 'build-mismatch' }]]);
  });

  it("counts an uncaught error before boot() has returned, and no other element's error", () => {
    const uncaught = guard();
    uncaught.fire('error', { target: new uncaught.Element() }, true);
    assert.deepEqual(uncaught.logged, [], "an image's or a stylesheet's error isn't the start's");
    uncaught.fire('error', { target: {}, message: 'note text' }, true);
    assert.deepEqual(lines(uncaught.logged), [['NewTabNote: the new tab did not start', { buildId: null, chunk: 'newtab', reason: 'uncaught' }]]);
    assert.doesNotMatch(JSON.stringify(uncaught.logged), /note text/);
  });

  it("doesn't count a rejection on the page, which may not stop the start: the root tells it of its own (startWorkspace)", () => {
    const { fire, logged, listeners } = guard();
    fire('unhandledrejection', { reason: new Error('x') });
    assert.deepEqual(logged, []);
    assert.equal(listeners.size, 3, 'it still watches the start');
  });

  it("takes its listeners off once boot() has returned (ntn:boot), so a later error is the app's", () => {
    const { fire, logged, listeners } = guard();
    fire('ntn:boot');
    assert.equal(listeners.size, 0);
    fire('error', { target: {}, message: 'x' }, true);
    fire('ntn:boot-failed', { detail: {} });
    assert.deepEqual(logged, []);
  });

  it('is a classic script newtab.html loads before its module, which the build minifies and no page bundles', () => {
    const { CLASSIC_SCRIPTS } = require('../scripts/build/vite-config.js');
    assert.equal(CLASSIC_SCRIPTS['js/entries/boot-guard.js'], 'minify');
    const { scanScript } = require('../scripts/build/js-scan.js');
    assert.deepEqual(scanScript('js/entries/boot-guard.js', read('js/entries/boot-guard.js')).moduleSyntax, []);
  });
});
