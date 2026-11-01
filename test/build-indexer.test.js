'use strict';

// The build ships every worker script a page starts: the search indexer, which
// NotesManager.initIndexer starts with new Worker('js/workers/indexer.js').

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const build = require('../scripts/build.js');

const ROOT = path.join(__dirname, '..');

test('the build ships each worker script a page starts', () => {
  const started = new Set();
  for (const file of build.JS_FILES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of source.matchAll(/new Worker\('([^']+)'\)/g)) started.add(match[1]);
  }
  assert.ok(started.size > 0);
  for (const script of started) assert.ok(build.JS_FILES.includes(script), `${script} isn't in JS_FILES`);
});
