// Only the coordinator listens on chrome.runtime for contract traffic (#13, "Topology" and
// AC4): the runtime-port adapter is the one module that names onConnect, and only the
// worker's composition root installs it, so no page can take another page's port, and nothing listens for another extension, so none can connect.
// `externally_connectable` stays #21's (security boundaries).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const ADAPTER = 'js/kernel/adapters/messaging/runtime-port.js';

/**
 * Every script under `dir`, relative to the repository root, js/lib/ left out
 * @param {string} dir
 * @returns {string[]}
 */
function scripts(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return file === 'js/lib' ? [] : scripts(file);
    return /\.m?js$/.test(entry.name) ? [file] : [];
  });
}

/**
 * The scripts whose text matches `pattern`
 * @param {RegExp} pattern
 */
const naming = pattern => scripts('js').filter(file => pattern.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));

describe('chrome.runtime listeners (#13, AC4)', () => {
  it('leaves onConnect to the runtime-port adapter alone', () => {
    assert.ok(scripts('js').length > 100);
    assert.deepEqual(naming(/\bonConnect\b/), [ADAPTER]);
  });

  it("is installed by the worker's composition root alone, which only the worker calls", () => {
    // Who names it in an import or a call, the module that defines it left out
    const importing = /** @param {string} name */ name =>
      naming(new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`));
    assert.deepEqual(importing('installRuntimePort'), ['js/kernel/composition/background.js']);
    assert.deepEqual(importing('installWorkerRouter'), ['js/background.js']);
    assert.deepEqual(
      naming(/\binstallRuntimePort\s*\(/).filter(file => file !== ADAPTER),
      ['js/kernel/composition/background.js'],
    );
  });

  it('listens for no other extension', () => {
    assert.deepEqual(naming(/\bon(?:ConnectExternal|MessageExternal)\b/), []);
  });
});
