/**
 * The browser host for the storage fixture format (#28 slice 3): loadFixture and dumpFixture
 * from test/fixtures/storage/load-fixture.mjs, the same file and the same options, run inside
 * an extension page or the service worker, on its own indexedDB and chrome.storage.local.
 *
 *   const host = fixtureHost(extension.worker);   // or a Page the harness opened
 *   await host.loadFixture(fixture, { names, canaries });
 *   const dumped = await host.dumpFixture({ header });
 *
 * The factory is always the target's indexedDB, so `factory` isn't an option here. `storage`
 * is the target's chrome.storage.local unless it's false. The loader's source is evaluated in
 * the target through Playwright, which an extension page's CSP doesn't apply to, so nothing is
 * added to the extension under test. Fixtures and dumps cross as JSON, which the format is.
 */

const fs = require('fs');
const path = require('path');

const LOADER = path.join(__dirname, '..', '..', 'test', 'fixtures', 'storage', 'load-fixture.mjs');

let body = null;

/**
 * The loader's source as a script body: its `export` keywords dropped, so its functions are
 * in scope. It imports nothing at the top level, which this checks.
 */
function loaderBody() {
  if (body !== null) return body;
  const source = fs.readFileSync(LOADER, 'utf8');
  if (/^import\s/m.test(source)) throw new Error(`${LOADER} has a static import, which the browser host can't run`);
  body = source.replace(/^export (?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm, '');
  if (/^export\s/m.test(body)) throw new Error(`${LOADER} has an export the browser host doesn't know how to drop`);
  return body;
}

/**
 * Runs `call` (an expression over the loader's functions and `args`) in `target`
 */
function runIn(target, call, args) {
  const expression = `(async () => {\n${loaderBody()}\nconst args = ${JSON.stringify(args)};\nreturn await (${call});\n})()`;
  return target.evaluate(expression);
}

/**
 * @param {{evaluate: Function}} target a Playwright Page or Worker of the extension
 */
function fixtureHost(target) {
  const refuseFactory = options => {
    if (options && (Object.hasOwn(options, 'factory') || (options.storage && options.storage !== true))) {
      throw new Error("fixtureHost: the factory and storage are the target's own; pass storage: false to leave chrome.storage.local out");
    }
  };
  return {
    async loadFixture(fixture, options = {}) {
      refuseFactory(options);
      const { names = {}, canaries, storage = true } = options;
      return runIn(
        target,
        'loadFixture(args.fixture, { factory: indexedDB, names: args.names, canaries: args.canaries, storage: args.storage ? chrome.storage.local : undefined })',
        { fixture, names, canaries, storage },
      );
    },
    async dumpFixture(options = {}) {
      refuseFactory(options);
      const { names = {}, header = {}, storage = true } = options;
      return runIn(
        target,
        'dumpFixture({ factory: indexedDB, names: args.names, header: args.header, storage: args.storage ? chrome.storage.local : undefined })',
        { names, header, storage },
      );
    },
  };
}

module.exports = { fixtureHost };
