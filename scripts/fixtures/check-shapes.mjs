#!/usr/bin/env node
// Checks test/fixtures/storage/shapes.json against the release tags themselves (#17 plan
// section 2): for each tag a shape lists, loads that tag's own js/utils.js and js/storage.js
// (`git show <tag>:<path>`) into test/helpers/legacy-env.js on a fresh fake-indexeddb, runs
// its Storage.init(), reads the database it made, and fails on any store, key path, key
// generator, index, or version that differs from the shape. Run by hand after
// `git fetch --tags`; CI never needs the tags:
//
//   node scripts/fixtures/check-shapes.mjs --tags
//
// A tag whose code won't run under legacy-env is reported and keeps its hand-transcribed row.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const ROOT = path.join(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const legacyEnv = require('../../test/helpers/legacy-env.js');
const SHAPES = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'storage', 'shapes.json'), 'utf8')).shapes;

if (!process.argv.includes('--tags')) {
  console.error('usage: node scripts/fixtures/check-shapes.mjs --tags');
  process.exit(2);
}

/** A file as `tag` has it */
const atTag = (tag, file) => execFileSync('git', ['show', `${tag}:${file}`], { cwd: ROOT, encoding: 'utf8' });

/** The schema a factory's CanvasTabDB has */
async function schemaOf(factory) {
  const dump = await legacyEnv.dumpDatabase(factory);
  return {
    version: dump.version,
    stores: Object.keys(dump.stores)
      .sort()
      .map(name => {
        const { keyPath, autoIncrement, indexes } = dump.stores[name];
        return {
          name,
          keyPath,
          autoIncrement,
          indexes: [...indexes].sort((a, b) => (a.name < b.name ? -1 : 1)),
        };
      }),
  };
}

const plain = store => ({
  name: store.name,
  keyPath: store.keyPath,
  autoIncrement: store.autoIncrement,
  indexes: store.indexes.map(({ name, keyPath, unique, multiEntry }) => ({ name, keyPath, unique, multiEntry })),
});

let failed = 0;
const unchecked = [];
for (const [shape, { releases, idbVersion, stores }] of Object.entries(SHAPES)) {
  for (const tag of releases) {
    const env = legacyEnv.createLegacyEnv();
    try {
      vm.runInContext(atTag(tag, 'js/utils.js'), env.context, { filename: `${tag}/js/utils.js` });
      vm.runInContext(atTag(tag, 'js/storage.js'), env.context, { filename: `${tag}/js/storage.js` });
      const Storage = env.get('Storage');
      await legacyEnv.runUntil(env, Storage.init());
    } catch (error) {
      unchecked.push(`${tag} (${shape}): its Storage.init() didn't run under legacy-env: ${error && error.message}`);
      continue;
    }
    const actual = await schemaOf(env.indexedDB);
    const want = { version: idbVersion, stores: stores.map(plain) };
    if (JSON.stringify(actual) === JSON.stringify(want)) {
      console.log(`ok   ${tag}: ${shape}, version ${actual.version}, ${actual.stores.length} stores`);
    } else {
      failed += 1;
      console.log(`FAIL ${tag}: made ${JSON.stringify(actual)}\n     shapes.json ${shape} has ${JSON.stringify(want)}`);
    }
  }
}
for (const line of unchecked) console.log(`skip ${line}`);
process.exit(failed > 0 ? 1 : 0);
