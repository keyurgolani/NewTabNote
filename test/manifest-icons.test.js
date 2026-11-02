'use strict';

// The extension's icon (a 1.4.x change, #150, ported). The manifest names the icon at 16, 32, 48
// and 128 px, and the toolbar's at 16, 32 and 48: Chrome draws the toolbar icon at 16 px, which is
// 32 px on a 2x screen, and without a 32 it scales the 48 down. Each one the manifest names is a
// PNG of the size its key says, and one of the files the build copies (scripts/build/vite-config.js
// STATIC_FILES), so it ships.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STATIC_FILES } = require('../scripts/build/vite-config.js');
const { ROOT } = require('./helpers/source-package.js');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/** Every icon the manifest names, as [where, size key, path] */
const NAMED = [
  ...Object.entries(MANIFEST.icons || {}).map(([size, file]) => ['icons', size, file]),
  ...Object.entries((MANIFEST.action && MANIFEST.action.default_icon) || {}).map(([size, file]) => ['action.default_icon', size, file]),
];

/** A PNG's width and height, from its IHDR chunk, or null when the file isn't a PNG */
function pngSize(file) {
  const bytes = fs.readFileSync(path.join(ROOT, file));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("the extension's icon", () => {
  it('the manifest names the icon at 16, 32, 48 and 128 px, and the toolbar its icon at 16, 32 and 48', () => {
    assert.deepEqual(Object.keys(MANIFEST.icons || {}).sort((a, b) => a - b), ['16', '32', '48', '128']);
    assert.deepEqual(Object.keys((MANIFEST.action && MANIFEST.action.default_icon) || {}).sort((a, b) => a - b), ['16', '32', '48']);
  });

  it('each icon the manifest names is a PNG of the size its key says, and ships', () => {
    for (const [where, size, file] of NAMED) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${where}.${size}: ${file} is in the repo`);
      assert.deepEqual(pngSize(file), { width: Number(size), height: Number(size) }, `${where}.${size}: ${file}`);
      assert.ok(STATIC_FILES.includes(file), `${where}.${size}: ${file} is one of the files the build copies`);
    }
  });
});
