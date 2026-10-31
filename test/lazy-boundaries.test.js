'use strict';

// #27 slice 3, "Lazy boundaries": js/runtime/lazy.js. loadChunk and loadLibrary load what a
// page needs only at first use and say how it went, loaded or failed with a reason, after one
// retry; the reload guards; the extra documents a lazy chunk's stylesheets also reach; the
// two seams #27 slice 3b replaces (states 2 and 4), which show nothing in slice 3; and the
// boundary rules the loader keeps.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lazy = () => import('../js/runtime/lazy.js');

const fetchFailure = (url) => new TypeError(`Failed to fetch dynamically imported module: ${url}`);

/**
 * A page for createLoader, and what each call did. Its build is build-a, and its packaged
 * build-info.json says so, with the workspace chunk at assets/workspace-A1.js.
 */
function fakeHost(overrides = {}) {
  const calls = { imported: [], fetched: [], warned: [], reloads: 0, timers: [] };
  const host = {
    buildId: 'build-a',
    getURL: (file) => `chrome-extension://ntn/${file}`,
    fetchJson: async (url) => {
      calls.fetched.push(url);
      return { buildId: 'build-a', chunks: { workspace: 'assets/workspace-A1.js' } };
    },
    importUrl: async (url) => {
      calls.imported.push(url);
      return { retried: true };
    },
    document: null,
    global: {},
    warn: (message, detail) => calls.warned.push([message, detail]),
    reload: () => { calls.reloads += 1; },
    // A timer runs only when a test fires it
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; },
    clearTimeout: () => {},
    libraries: { chart: { url: () => 'chrome-extension://ntn/js/lib/chart.js', global: 'Chart' } },
    ...overrides,
  };
  return { host, calls };
}

/**
 * A document with a head, enough for classic scripts and stylesheets. `onScript(script)` runs
 * a microtask after each script goes in, so a test plays its load or error.
 */
function fakeDocument({ onScript = () => {} } = {}) {
  const head = {
    children: [],
    appendChild(element) {
      this.children.push(element);
      if (element.tagName === 'SCRIPT') queueMicrotask(() => onScript(element));
      return element;
    },
  };
  const document = {
    head,
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        remove() { head.children = head.children.filter((child) => child !== this); },
      };
    },
    // A copy of another document's element, as the browser's: its attributes and its text, and a
    // link's href as written, which may be relative
    importNode(node) {
      const copy = this.createElement(node.tagName.toLowerCase());
      for (const field of ['rel', 'textContent']) if (node[field] !== undefined) copy[field] = node[field];
      if (node.href !== undefined) copy.href = `relative:${node.href}`;
      return copy;
    },
    querySelectorAll() {
      return head.children.filter((child) => (child.tagName === 'LINK' && /\bstylesheet\b/.test(child.rel)) || child.tagName === 'STYLE');
    },
  };
  return document;
}

describe('loadChunk (js/runtime/lazy.js)', () => {
  it('answers loaded with the module, and reads nothing else', async () => {
    const { createLoader } = await lazy();
    const { host, calls } = fakeHost();
    const loader = createLoader(host);
    const module = { boot() {} };
    assert.deepEqual(await loader.loadChunk('workspace', async () => module), { status: 'loaded', module });
    assert.deepEqual([calls.fetched, calls.imported, calls.warned], [[], [], []]);
  });

  it("doesn't retry a chunk that loaded and threw, and logs the build, the chunk, and the reason, never what it threw", async () => {
    const { createLoader } = await lazy();
    const { host, calls } = fakeHost();
    const result = await createLoader(host).loadChunk('workspace', async () => { throw new Error('secret note text'); });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'evaluation-failed');
    assert.equal(typeof result.retry, 'function');
    assert.deepEqual([calls.fetched, calls.imported], [[], []]);
    assert.deepEqual(calls.warned.map(([, detail]) => detail), [{ buildId: 'build-a', chunk: 'workspace', reason: 'evaluation-failed' }]);
    assert.doesNotMatch(JSON.stringify(calls.warned), /secret note text/);
  });

  it("reads build-info.json once a fetch fails, uncached, and retries once at the chunk's own path with ?r=1", async () => {
    const { createLoader } = await lazy();
    const { host, calls } = fakeHost();
    const result = await createLoader(host).loadChunk('workspace', async () => { throw fetchFailure('chrome-extension://ntn/assets/workspace-A1.js'); });
    assert.deepEqual(result, { status: 'loaded', module: { retried: true } });
    assert.deepEqual(calls.fetched, ['chrome-extension://ntn/build-info.json']);
    assert.deepEqual(calls.imported, ['chrome-extension://ntn/assets/workspace-A1.js?r=1']);
    assert.deepEqual(calls.warned, []);
  });

  it('is chunk-missing when the retry fails too, or build-info.json is unreadable or names no such chunk', async () => {
    const { createLoader } = await lazy();
    const failing = async () => { throw fetchFailure('x'); };
    for (const overrides of [
      { importUrl: async (url) => { throw fetchFailure(url); } },
      { fetchJson: async () => { throw new TypeError('Failed to fetch'); } },
      { fetchJson: async () => null },
      { fetchJson: async () => ({ buildId: 'build-a', chunks: {} }) },
    ]) {
      const { host, calls } = fakeHost(overrides);
      const result = await createLoader(host).loadChunk('workspace', failing);
      assert.equal(result.reason, 'chunk-missing', JSON.stringify(Object.keys(overrides)));
      assert.deepEqual(calls.warned.map(([, detail]) => detail.reason), ['chunk-missing']);
    }
  });

  it("is build-mismatch when build-info.json is another build's: it calls the update seam, state 2, and doesn't retry", async () => {
    const { createLoader } = await lazy();
    const { host, calls } = fakeHost({ fetchJson: async () => ({ buildId: 'build-b', chunks: { workspace: 'assets/workspace-B2.js' } }) });
    const loader = createLoader(host);
    const updated = [];
    loader.seams.updated = (name) => updated.push(name);
    const result = await loader.loadChunk('workspace', async () => { throw fetchFailure('x'); });
    assert.equal(result.reason, 'build-mismatch');
    assert.deepEqual(updated, ['workspace']);
    assert.deepEqual(calls.imported, []);
    assert.deepEqual(calls.warned.map(([, detail]) => detail), [{ buildId: 'build-a', chunk: 'workspace', reason: 'build-mismatch' }]);
  });

  it("calls the loading seam, state 4, as a load starts and when it settles, and shows nothing by default", async () => {
    const { createLoader, seams } = await lazy();
    const { host } = fakeHost();
    const loader = createLoader(host);
    const events = [];
    loader.seams.loading = (name) => {
      events.push(`start ${name}`);
      return () => events.push(`settled ${name}`);
    };
    await loader.loadChunk('workspace', async () => ({}));
    await loader.loadChunk('workspace', async () => { throw new Error('x'); });
    assert.deepEqual(events, ['start workspace', 'settled workspace', 'start workspace', 'settled workspace']);
    // The page's seams are no-ops until #27 slice 3b
    assert.equal(typeof seams.loading('workspace'), 'function');
    assert.equal(seams.updated('workspace'), undefined);
  });

  it("gives a failure's retry, which loads it again", async () => {
    const { createLoader } = await lazy();
    const { host } = fakeHost();
    let calls = 0;
    const result = await createLoader(host).loadChunk('workspace', async () => {
      calls += 1;
      if (calls === 1) throw new Error('first');
      return { second: true };
    });
    assert.equal(result.reason, 'evaluation-failed');
    assert.deepEqual(await result.retry(), { status: 'loaded', module: { second: true } });
  });

  it('hands a failure to the failed seam, state 3, with its retry, and a mismatch to the update seam alone', async () => {
    const { createLoader, seams } = await lazy();
    const { host } = fakeHost();
    const loader = createLoader(host);
    const seen = [];
    loader.seams.failed = (name, failure) => seen.push(['failed', name, failure.reason, typeof failure.retry]);
    loader.seams.updated = (name) => seen.push(['updated', name]);
    await loader.loadChunk('workspace', async () => { throw new Error('x'); });
    const other = createLoader(fakeHost({ fetchJson: async () => ({ buildId: 'build-b', chunks: {} }) }).host);
    other.seams.failed = loader.seams.failed;
    other.seams.updated = loader.seams.updated;
    await other.loadChunk('workspace', async () => { throw fetchFailure('x'); });
    assert.deepEqual(seen, [['failed', 'workspace', 'evaluation-failed', 'function'], ['updated', 'workspace']]);
    assert.equal(seams.failed('workspace', /** @type {any} */ ({})), undefined);
    // Each loader starts with the page's seams, and replacing its own leaves those
    assert.notEqual(loader.seams, seams);
    assert.equal(createLoader(fakeHost().host).seams.failed, seams.failed);
  });

  /**
   * A chunk's load as Vite 8's preload runs it (preloadOnce in its helper): it puts in each of the
   * chunk's stylesheets it hasn't put in before, waits for it, and imports the chunk's code only
   * once every one loaded. It remembers every URL it put in, one that failed included, and passes
   * over it on any later load, so a stylesheet never goes in twice. `plays` says how each
   * stylesheet it puts in goes: 'error', or anything else for a load.
   */
  function preloading(document, href, plays) {
    const runs = [];
    const seen = new Set();
    const load = async () => {
      if (seen.has(href)) {
        runs.push('passed over');
      } else {
        seen.add(href);
        document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
        const play = plays.shift();
        runs.push(play);
        if (play === 'error') throw new Error(`Unable to preload CSS for ${href}`);
      }
      return { workspace: true };
    };
    return { load, runs };
  }

  const sheet = 'chrome-extension://ntn/assets/workspace-A1.css';
  const links = (document) => document.head.children.filter((child) => child.href === sheet);

  // No lazy chunk has a stylesheet today. The first one that does has to bring the loader's own
  // retry of its stylesheet, and this case changes with it.
  it("answers loaded without a stylesheet that didn't load: the retry imports the chunk's code alone, and no later load puts the stylesheet in", async () => {
    const { createLoader } = await lazy();
    const document = fakeDocument();
    const { host, calls } = fakeHost({ document });
    const { load, runs } = preloading(document, sheet, ['error', 'load']);
    const loader = createLoader(host);
    assert.deepEqual(await loader.loadChunk('workspace', load), { status: 'loaded', module: { retried: true } });
    assert.deepEqual(calls.imported, ['chrome-extension://ntn/assets/workspace-A1.js?r=1'], 'the code alone, at its own path');
    assert.deepEqual(runs, ['error']);
    assert.equal(links(document).length, 1, 'the failed link stays');
    assert.deepEqual(calls.warned, []);

    assert.deepEqual(await loader.loadChunk('workspace', load), { status: 'loaded', module: { workspace: true } });
    assert.deepEqual(runs, ['error', 'passed over'], 'the preload remembers the URL, so the stylesheet never goes in again');
    assert.equal(links(document).length, 1);
  });

  it("is build-mismatch, with no retry, when a stylesheet didn't load under another build's build-info.json", async () => {
    const { createLoader } = await lazy();
    const document = fakeDocument();
    const { host, calls } = fakeHost({ document, fetchJson: async () => ({ buildId: 'build-b', chunks: {} }) });
    const { load, runs } = preloading(document, sheet, ['error', 'load']);
    assert.equal((await createLoader(host).loadChunk('workspace', load)).reason, 'build-mismatch');
    assert.deepEqual(runs, ['error']);
    assert.deepEqual(calls.imported, []);
  });

  it('never rejects, whatever the load throws', async () => {
    const { createLoader } = await lazy();
    const { host } = fakeHost({ importUrl: async () => { throw new SyntaxError('Unexpected token'); } });
    const loader = createLoader(host);
    for (const thrown of [undefined, null, 'a string', { message: 'Failed to fetch dynamically imported module' }, new SyntaxError('x')]) {
      const result = await loader.loadChunk('workspace', () => Promise.reject(thrown));
      assert.equal(result.reason, 'evaluation-failed', String(thrown));
    }
    // A retry whose file loads and throws is the module's own failure
    assert.equal((await loader.loadChunk('workspace', async () => { throw fetchFailure('x'); })).reason, 'evaluation-failed');
  });
});

describe('loadLibrary (js/runtime/lazy.js)', () => {
  const scripted = (plays) => {
    const seen = [];
    const document = fakeDocument({
      onScript: (script) => {
        seen.push(script.src);
        const play = plays.shift();
        if (play === 'error') script.onerror();
        else {
          if (play === 'define') host.global.Chart = class Chart {};
          script.onload();
        }
      },
    });
    const { host, calls } = fakeHost({ document });
    return { host, calls, seen, document };
  };

  it("checks build-info.json is the page's build, then puts the vendored file in as a classic script and answers its global, once", async () => {
    const { createLoader } = await lazy();
    const { host, seen, calls } = scripted(['define']);
    const loader = createLoader(host);
    const result = await loader.loadLibrary('chart');
    assert.equal(result.status, 'loaded');
    assert.equal(result.module, host.global.Chart);
    assert.deepEqual(seen, ['chrome-extension://ntn/js/lib/chart.js']);
    assert.deepEqual(calls.fetched, ['chrome-extension://ntn/build-info.json']);
    assert.equal((await loader.loadLibrary('chart')).module, host.global.Chart);
    assert.deepEqual(seen, ['chrome-extension://ntn/js/lib/chart.js'], 'the second call puts in no script');
    assert.equal(calls.fetched.length, 1, 'and reads nothing');
  });

  it("answers failed, and never rejects, when the library's URL can't be built because the extension's context is gone", async () => {
    const { createLoader } = await lazy();
    const { host, seen, calls } = scripted(['define']);
    host.libraries = { chart: { url: () => { throw new TypeError('chrome.runtime.getURL is not a function'); }, global: 'Chart' } };
    const loader = createLoader(host);
    const result = await loader.loadLibrary('chart');
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'chunk-missing');
    assert.equal(typeof result.retry, 'function');
    assert.deepEqual(seen, [], 'no script goes in');
    assert.deepEqual(calls.warned.map(([message]) => message), ['NewTabNote loader: chunk-missing']);
  });

  it("doesn't run a library under another build's build-info.json: it's build-mismatch before any script goes in", async () => {
    const { createLoader } = await lazy();
    const { host, seen, calls } = scripted(['define']);
    host.fetchJson = async (url) => {
      calls.fetched.push(url);
      return { buildId: 'build-b', chunks: {} };
    };
    const loader = createLoader(host);
    const updated = [];
    loader.seams.updated = (name) => updated.push(name);
    const result = await loader.loadLibrary('chart');
    assert.equal(result.reason, 'build-mismatch');
    assert.deepEqual(seen, [], 'no script');
    assert.equal(host.global.Chart, undefined);
    assert.deepEqual(calls.fetched, ['chrome-extension://ntn/build-info.json']);
    assert.deepEqual(updated, ['chart']);
    assert.deepEqual(calls.warned.map(([, detail]) => detail), [{ buildId: 'build-a', chunk: 'chart', reason: 'build-mismatch' }]);
  });

  it('loads it once for calls that overlap', async () => {
    const { createLoader } = await lazy();
    const { host, seen } = scripted(['define']);
    const loader = createLoader(host);
    const [first, second] = await Promise.all([loader.loadLibrary('chart'), loader.loadLibrary('chart')]);
    assert.equal(first.module, second.module);
    assert.deepEqual(seen, ['chrome-extension://ntn/js/lib/chart.js']);
  });

  it('retries once with ?r=1 after the script fails to load, and is chunk-missing when that fails too', async () => {
    const { createLoader } = await lazy();
    const retried = scripted(['error', 'define']);
    assert.equal((await createLoader(retried.host).loadLibrary('chart')).status, 'loaded');
    assert.deepEqual(retried.seen, ['chrome-extension://ntn/js/lib/chart.js', 'chrome-extension://ntn/js/lib/chart.js?r=1']);
    assert.deepEqual(retried.document.head.children.map((child) => child.src), ['chrome-extension://ntn/js/lib/chart.js?r=1'], 'the failed script is gone');

    const missing = scripted(['error', 'error']);
    const result = await createLoader(missing.host).loadLibrary('chart');
    assert.equal(result.reason, 'chunk-missing');
    assert.deepEqual(missing.calls.warned.map(([, detail]) => detail), [{ buildId: 'build-a', chunk: 'chart', reason: 'chunk-missing' }]);
  });

  it("answers a library's failure again without loading it, as a missing one stayed missing, until its retry", async () => {
    const { createLoader } = await lazy();
    const { host, seen, calls } = scripted(['error', 'error', 'define']);
    const loader = createLoader(host);
    const first = await loader.loadLibrary('chart');
    assert.equal(first.reason, 'chunk-missing');
    assert.equal(await loader.loadLibrary('chart'), first);
    assert.equal(seen.length, 2, 'no script for the second call');
    assert.equal(calls.warned.length, 1);
    const retried = await first.retry();
    assert.equal(retried.status, 'loaded');
    assert.equal(seen.length, 3);
    assert.equal(await loader.loadLibrary('chart'), retried);
  });

  it("is build-mismatch when the script fails and build-info.json has turned another build's since the check, with no second script", async () => {
    const { createLoader } = await lazy();
    const { host, seen } = scripted(['error']);
    const answers = [{ buildId: 'build-a', chunks: {} }, { buildId: 'build-b', chunks: {} }];
    host.fetchJson = async () => answers.shift();
    const result = await createLoader(host).loadLibrary('chart');
    assert.equal(result.reason, 'build-mismatch');
    assert.equal(seen.length, 1);
  });

  it("runs one load for a failure's retry that's called again while it runs: no second script", async () => {
    const { createLoader } = await lazy();
    const { host, seen } = scripted(['error', 'error', 'define']);
    const loader = createLoader(host);
    const first = await loader.loadLibrary('chart');
    assert.equal(first.reason, 'chunk-missing');
    const [one, two] = await Promise.all([first.retry(), first.retry()]);
    assert.equal(one.status, 'loaded');
    assert.equal(two, one);
    assert.equal(seen.length, 3, 'one script for both');
    assert.equal(await loader.loadLibrary('chart'), one);
  });

  it('is chunk-missing for a name it has no library for', async () => {
    const { createLoader } = await lazy();
    const { host, seen } = scripted([]);
    assert.equal((await createLoader(host).loadLibrary('graph')).reason, 'chunk-missing');
    assert.deepEqual(seen, []);
  });

  it('is evaluation-failed when the script ran and left no global, without a retry', async () => {
    const { createLoader } = await lazy();
    const { host, seen } = scripted(['nothing']);
    const result = await createLoader(host).loadLibrary('chart');
    assert.equal(result.reason, 'evaluation-failed');
    assert.equal(seen.length, 1);
  });

  it('answers a global the page already has without a script', async () => {
    const { createLoader } = await lazy();
    const { host, seen } = scripted([]);
    host.global.Chart = class Chart {};
    assert.equal((await createLoader(host).loadLibrary('chart')).module, host.global.Chart);
    assert.deepEqual(seen, []);
  });

  it('names the four vendored libraries, each by a literal chrome.runtime.getURL the closure check follows, and its global', async () => {
    const { LIBRARIES } = await lazy();
    assert.deepEqual(Object.keys(LIBRARIES).sort(), ['chart', 'fuse', 'jszip', 'transformers']);
    assert.deepEqual(Object.fromEntries(Object.entries(LIBRARIES).map(([name, { global }]) => [name, global])), {
      chart: 'Chart', fuse: 'Fuse', jszip: 'JSZip', transformers: 'transformers',
    });
    const source = fs.readFileSync(path.join(ROOT, 'js/runtime/lazy.js'), 'utf8');
    for (const file of ['js/lib/chart.js', 'js/lib/fuse.js', 'js/lib/jszip.min.js', 'js/lib/transformers.js']) {
      assert.ok(source.includes(`chrome.runtime.getURL('${file}')`), file);
    }
    // It imports nothing, so the bundler gives it a chunk of its own (scripts/build/vite-config.js)
    assert.doesNotMatch(source, /^\s*import\s/m);
  });
});

describe('the reload guards (js/runtime/lazy.js)', () => {
  it('reloads once every guard answers that it saved, and not before', async () => {
    const { createLoader } = await lazy();
    const { host, calls } = fakeHost();
    const loader = createLoader(host);
    let finish;
    const order = [];
    loader.registerReloadGuard(() => new Promise((resolve) => { finish = () => { order.push('flushed'); resolve(true); }; }));
    loader.registerReloadGuard(() => true);
    const reloading = loader.reloadAfterGuards();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.reloads, 0, 'it waits for the guard');
    finish();
    assert.deepEqual(await reloading, { reloaded: true });
    assert.deepEqual(order, ['flushed']);
    assert.equal(calls.reloads, 1);
  });

  it("doesn't reload when a guard answers that it failed, throws, or answers anything but true, and answers the failure", async () => {
    const { createLoader } = await lazy();
    for (const guard of [() => false, async () => { throw new Error('a guard that fails'); }, () => undefined, async () => 'saved']) {
      const { host, calls } = fakeHost();
      const loader = createLoader(host);
      loader.registerReloadGuard(() => true);
      loader.registerReloadGuard(guard);
      assert.deepEqual(await loader.reloadAfterGuards(), { reloaded: false }, String(guard));
      assert.equal(calls.reloads, 0, String(guard));
    }
  });

  it("counts a guard that hasn't answered in 10 seconds as failed, and runs none once it is unregistered", async () => {
    const { createLoader, RELOAD_GUARD_MS } = await lazy();
    assert.equal(RELOAD_GUARD_MS, 10_000);
    const { host, calls } = fakeHost();
    const loader = createLoader(host);
    let ran = 0;
    const stop = loader.registerReloadGuard(() => { ran += 1; return true; });
    stop();
    loader.registerReloadGuard(() => new Promise(() => {}));
    const reloading = loader.reloadAfterGuards();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.reloads, 0, 'it waits for the guard');
    assert.deepEqual(calls.timers.map(({ ms }) => ms), [RELOAD_GUARD_MS]);
    calls.timers[0].fn();
    assert.deepEqual(await reloading, { reloaded: false });
    assert.equal(ran, 0);
    assert.equal(calls.reloads, 0, 'no timer reloads over a guard still running');
  });

  it('answers once, however many ways it finishes', async () => {
    const { createLoader } = await lazy();
    const { host, calls } = fakeHost();
    const loader = createLoader(host);
    assert.deepEqual(await loader.reloadAfterGuards(), { reloaded: true }, 'no guards: nothing to save');
    calls.timers[0].fn();
    assert.equal(calls.reloads, 1);
  });

  it('reloadNow reloads without the guards, for "Reload anyway"', async () => {
    const { createLoader } = await lazy();
    const { host, calls } = fakeHost();
    const loader = createLoader(host);
    let ran = 0;
    loader.registerReloadGuard(() => { ran += 1; return false; });
    loader.reloadNow();
    assert.equal(calls.reloads, 1);
    assert.equal(ran, 0);
  });
});

describe('the extra documents (js/runtime/lazy.js)', () => {
  it("gives each open extra document the stylesheets a chunk adds while it loads, until it's unregistered", async () => {
    const { createLoader } = await lazy();
    const document = fakeDocument();
    const { host } = fakeHost({ document });
    const loader = createLoader(host);
    const pip = fakeDocument();
    const stop = loader.registerExtraDocument(pip);
    const add = (tag, fields) => document.head.appendChild(Object.assign(document.createElement(tag), fields));
    add('link', { rel: 'stylesheet', href: 'chrome-extension://ntn/assets/before.css' });
    await loader.loadChunk('stats', async () => {
      add('link', { rel: 'stylesheet', href: 'chrome-extension://ntn/assets/stats-A1.css' });
      add('style', { textContent: '.stats { color: inherit }' });
      return {};
    });
    assert.deepEqual(pip.head.children.map((child) => [child.tagName, child.rel || null, child.href || child.textContent]), [
      ['LINK', 'stylesheet', 'chrome-extension://ntn/assets/stats-A1.css'],
      ['STYLE', null, '.stats { color: inherit }'],
    ]);
    stop();
    await loader.loadChunk('later', async () => {
      add('link', { rel: 'stylesheet', href: 'chrome-extension://ntn/assets/later-A1.css' });
      return {};
    });
    assert.equal(pip.head.children.length, 2);
  });

  it("gives them nothing from a load that failed", async () => {
    const { createLoader } = await lazy();
    const document = fakeDocument();
    const { host } = fakeHost({ document });
    const loader = createLoader(host);
    const pip = fakeDocument();
    loader.registerExtraDocument(pip);
    await loader.loadChunk('stats', async () => {
      document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'x.css' }));
      throw new Error('x');
    });
    assert.deepEqual(pip.head.children, []);
  });
});

describe("the loader's boundary rules (eslint.config.mjs)", () => {
  it("are a legacy file's but two: the fetch ban, for its read of build-info.json, and the import rule, for its retry", async () => {
    const { ESLint } = require('eslint');
    const eslint = new ESLint({ cwd: ROOT });
    const [legacy, loader] = await Promise.all(['js/search.js', 'js/runtime/lazy.js'].map((file) => eslint.calculateConfigForFile(file)));
    const on = (config) => Object.keys(config.rules).filter((name) => [].concat(config.rules[name])[0] !== 0).sort();
    assert.deepEqual(on(loader), on(legacy).filter((name) => name !== 'kernel/imports'));
    const banned = (config) => config.rules['no-restricted-globals'][1].globals.map(({ name }) => name);
    assert.deepEqual(banned(loader), banned(legacy).filter((name) => name !== 'fetch'));
    for (const name of ['no-restricted-syntax', 'kernel/this-member']) assert.deepEqual(loader.rules[name], legacy.rules[name], name);
  });
});
