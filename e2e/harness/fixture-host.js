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
 *
 * A database the target already holds at a version past the fixture's is deleted before the
 * load (deleteNewer): since #17 PR 1b the worker makes CanvasTabDB at 9 as the extension
 * installs, and a 1.4.x fixture holds it at 8. It's deleted only once the worker's run at install
 * migrated, and after the load the harness updates the extension in place, so the new worker
 * upgrades the fixture as an update to this build does, and that run has to migrate too
 * (upgradeAsUpdated). A spec then opens its pages on the upgraded database.
 */

const fs = require('fs');
const path = require('path');
const { harnessFor } = require('./extension');

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
 * Deletes each database `wanted` names that `target` already holds at a version past the one
 * wanted, once the worker's migration run at install is in (test code only: nothing under js/
 * deletes a database). Since #17 PR 1b that run makes CanvasTabDB at 9, and indexedDB.open
 * refuses a 1.4.x fixture's 8 with a VersionError. It deletes only what a run that migrated
 * made: after any other run, or with no run to read (a page), it rejects and deletes nothing,
 * so the spec fails where it seeded. One at the wanted version or below is loaded into, as
 * before, so a 1.4.x package is seeded as it was. Answers the names it deleted.
 * @param {{evaluate: Function}} target
 * @param {Array<{name: string, version: number}>} wanted
 * @returns {Promise<string[]>}
 */
function deleteNewer(target, wanted) {
  return target.evaluate(async list => {
    // The worker's run at install (#17 PR 1b); a page, and a 1.4.x worker, have none
    const run = self.storageUpgrade ? await self.storageUpgrade : null;
    const held = new Map((await indexedDB.databases()).map(db => [db.name, db.version]));
    const newer = list.filter(({ name, version }) => held.has(name) && held.get(name) > version).map(({ name }) => name);
    if (newer.length === 0) return [];
    const status = run ? run.status : null;
    if (status !== 'migrated') {
      throw new Error(`the worker's migration run at install answered ${JSON.stringify(status)}, not "migrated", so ${newer.join(', ')} stays`);
    }
    for (const name of newer) {
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
    return newer;
  }, wanted);
}

/**
 * Has the worker upgrade what was loaded over the install's database, as an update to this
 * build does: the harness loads the extension again in place, at the version it has
 * (ExtensionSession.update), and the new worker's run has to answer `migrated`
 * @param {{evaluate: Function}} target - the worker deleteNewer ran in
 */
async function upgradeAsUpdated(target) {
  const session = harnessFor(target);
  if (!session) throw new Error("fixtureHost: a load over the install's database needs the harness's worker, to update the extension in place");
  await session.update({ version: await target.evaluate(() => chrome.runtime.getManifest().version) });
  const status = await session.worker.evaluate(async () => {
    const run = await self.storageUpgrade;
    return run ? run.status : null;
  });
  if (status !== 'migrated') throw new Error(`fixtureHost: the updated worker's migration run answered ${JSON.stringify(status)}, not "migrated"`);
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
      const databases = Array.isArray(fixture && fixture.databases) ? fixture.databases : [];
      const deleted = await deleteNewer(target, databases.map(db => ({ name: names[db.name] ?? db.name, version: db.version })));
      const loaded = await runIn(
        target,
        'loadFixture(args.fixture, { factory: indexedDB, names: args.names, canaries: args.canaries, storage: args.storage ? chrome.storage.local : undefined })',
        { fixture, names, canaries, storage },
      );
      if (deleted.length > 0) await upgradeAsUpdated(target);
      return loaded;
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
