'use strict';

// #300 slice 5a: the e2e harness starts the build's service worker through a bootstrap that
// installs its hooks first (e2e/harness/worker-hooks.js). The bootstrap takes the path the
// build's manifest names, and the worker moves beside it, so the worker runs at production's URL,
// the one the offscreen document's sender check reads (js/kernel/composition/api-request.js's
// workerScriptUrl). e2e/harness.spec.js checks that URL in a browser.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareExtension } = require('../e2e/harness/extension.js');

const temps = [];
after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/**
 * A build in a temp dir, `files` mapping each path in it to its text, and where to prepare its copy
 * @param {Record<string, string>} files
 */
function build(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-harness-extension-'));
  temps.push(root);
  const dist = path.join(root, 'dist');
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dist, file)), { recursive: true });
    fs.writeFileSync(path.join(dist, file), text);
  }
  return { dist, dir: path.join(root, 'extension') };
}

const read = (/** @type {string} */ dir, /** @type {string} */ file) => fs.readFileSync(path.join(dir, file), 'utf8');
const MODULE = JSON.stringify({ manifest_version: 3, name: 'x', version: '1.0.0', background: { service_worker: 'js/background.js', type: 'module' } });
const WORKER = "import { loaded } from './dependency.js';\nself.loaded = loaded;\n";

describe('e2e/harness/extension.js (#300)', () => {
  it("writes its bootstrap at the path the build's manifest names, and leaves the manifest as it is, so the worker runs at production's URL", () => {
    const { dist, dir } = build({ 'manifest.json': MODULE, 'js/background.js': WORKER, 'js/dependency.js': 'export const loaded = 1;\n' });
    prepareExtension(dist, dir);
    assert.equal(read(dir, 'manifest.json'), MODULE);
    // The hooks first, then the build's worker, moved beside the bootstrap so its relative imports resolve as before
    assert.equal(read(dir, 'js/background.js'), "import './ntn-harness-hooks.js';\nimport './ntn-harness-worker.js';\n");
    assert.equal(read(dir, 'js/ntn-harness-worker.js'), WORKER);
    assert.match(read(dir, 'js/ntn-harness-hooks.js'), /^\(/);
  });

  it('starts a classic worker with importScripts, and changes only the version when an update names one', () => {
    const manifest = { manifest_version: 3, name: 'x', version: '1.0.0', background: { service_worker: 'background.js' } };
    const { dist, dir } = build({ 'manifest.json': JSON.stringify(manifest), 'background.js': 'self.loaded = 1;\n' });
    prepareExtension(dist, dir, { version: '9.9.9' });
    assert.deepEqual(JSON.parse(read(dir, 'manifest.json')), { ...manifest, version: '9.9.9' });
    assert.equal(read(dir, 'background.js'), "importScripts('ntn-harness-hooks.js', 'ntn-harness-worker.js');\n");
    assert.equal(read(dir, 'ntn-harness-worker.js'), 'self.loaded = 1;\n');
  });

  it("refuses a build that holds a file by one of the harness's names, or no worker where its manifest says", () => {
    const taken = build({ 'manifest.json': MODULE, 'js/background.js': WORKER, 'js/ntn-harness-worker.js': '' });
    assert.throws(() => prepareExtension(taken.dist, taken.dir), /js\/ntn-harness-worker\.js already exists/);
    const missing = build({ 'manifest.json': MODULE });
    assert.throws(() => prepareExtension(missing.dist, missing.dir), /js\/background\.js, the manifest's background\.service_worker, isn't in the build/);
  });
});
