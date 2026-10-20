// The vendored Valibot (docs/adr/0001-kernel-stack.md, decision 2): each file is the one its
// record says the npm tarball holds, and neither it nor a contract module compiles code at
// run time, which the extension's CSP refuses (#13, AC7).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const VALIBOT = path.join(ROOT, 'js/lib/valibot');
const CONTRACTS = path.join(ROOT, 'js/kernel/core/contracts');

/**
 * @typedef {object} VendorRecord
 * @property {string} package
 * @property {string} version
 * @property {string} tarball
 * @property {string} integrity
 * @property {Record<string, {from: string, sha256: string, ships: boolean}>} files
 */

/** @type {VendorRecord} */
const record = JSON.parse(fs.readFileSync(path.join(VALIBOT, 'vendor.json'), 'utf8'));

/**
 * @param {string} dir
 * @returns {string[]} every file under `dir`, as paths
 */
function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

describe('vendored Valibot', () => {
  it('is one exact release, 1.2 or later, from its npm tarball', () => {
    assert.equal(record.package, 'valibot');
    assert.match(record.version, /^\d+\.\d+\.\d+$/);
    const [major, minor] = record.version.split('.').map(Number);
    assert.ok(major > 1 || (major === 1 && minor >= 2), record.version);
    assert.equal(record.tarball, `https://registry.npmjs.org/valibot/-/valibot-${record.version}.tgz`);
    assert.match(record.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  });

  it('holds exactly the files its record lists, each with the SHA-256 recorded', () => {
    assert.deepEqual(fs.readdirSync(VALIBOT).sort(), [...Object.keys(record.files), 'vendor.json'].sort());
    for (const [name, file] of Object.entries(record.files)) {
      const digest = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(VALIBOT, name)))
        .digest('hex');
      assert.equal(digest, file.sha256, name);
    }
    assert.deepEqual(
      Object.entries(record.files).map(([name, file]) => [name, file.from, file.ships]),
      [
        ['index.mjs', 'package/dist/index.mjs', true],
        ['index.d.mts', 'package/dist/index.d.mts', false],
        ['LICENSE.md', 'package/LICENSE.md', true],
      ],
    );
  });

  it('loads as an ES module in node --test', async () => {
    const v = await import('../../js/lib/valibot/index.mjs');
    assert.equal(v.safeParse(v.string(), 'text').success, true);
  });

  it('neither Valibot nor any contract module calls eval or the Function constructor', () => {
    const compiles = /\beval\s*\(|\bnew\s+Function\b|(?<![\w$.])Function\s*\(/;
    const files = [path.join(VALIBOT, 'index.mjs'), ...filesUnder(CONTRACTS)];
    assert.ok(files.includes(path.join(CONTRACTS, 'outcomes.js')), 'the scan reaches the contract modules');
    for (const file of files) {
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), compiles, path.relative(ROOT, file));
    }
  });
});
