'use strict';

// test/helpers/page-module.js loads a page's lazy chunk as Chrome does (#237): a module's
// import() gets the module it names through the same modules and the same relative-only rule as
// its static imports, linked and evaluated before it's handed back. A test of a failed load
// passes `dynamicImports: false`, and each import() rejects.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, plain } = require('./helpers/legacy-env');
const { loadPageModule } = require('./helpers/page-module');

const PAGE = 'test/fixtures/page-module/entry.mjs';

describe("a page module's import() under test/helpers/page-module.js", () => {
  it('gets the module it names, evaluated once, on the modules its page imports statically', async () => {
    const page = await loadPageModule(createLegacyEnv(), PAGE);
    assert.deepEqual(plain(page.evaluated), ['shared']);
    const lazy = await page.loadLazy();
    // lazy.mjs ran before its exports came back, on the shared.mjs the page has
    assert.equal(lazy.answer, 42);
    assert.equal(lazy.evaluated, page.evaluated);
    assert.deepEqual(plain(page.evaluated), ['shared', 'lazy']);
    // Another import() of it, or of a module the page imports statically, evaluates nothing again
    assert.equal(await page.loadLazy(), lazy);
    assert.equal((await page.loadShared()).evaluated, page.evaluated);
    assert.deepEqual(plain(page.evaluated), ['shared', 'lazy']);
  });

  it('refuses a bare specifier, as a static import of one is refused', async () => {
    const page = await loadPageModule(createLegacyEnv(), PAGE);
    await assert.rejects(page.loadBare(), /imports "node:path"; pages resolve only relative specifiers/);
  });

  it('rejects in a test that passes dynamicImports: false, so the test can fail a load on purpose', async () => {
    const page = await loadPageModule(createLegacyEnv(), PAGE, { dynamicImports: false });
    await assert.rejects(page.loadLazy(), { code: 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING' });
    assert.deepEqual(plain(page.evaluated), ['shared']);
  });
});
