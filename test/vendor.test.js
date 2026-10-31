'use strict';

// #27 AC9 and "Third-party code": js/lib/vendor.json, which records every vendored file, and
// the notice, source-map, and vendor checks (scripts/build/notices.js) the build and
// npm run check:notices run on what ships.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readVendor, checkNoticeFiles, checkBanners, checkSourceMaps, checkVendor } = require('../scripts/build/notices.js');
const { sourcePackage, packageOf, filesUnder, ROOT } = require('./helpers/source-package.js');

const LIB = path.join(ROOT, 'js', 'lib');
const record = JSON.parse(fs.readFileSync(path.join(LIB, 'vendor.json'), 'utf8'));
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** The codes and subjects a check reported, sorted */
function found(problems) {
  return problems.map(({ code, subject }) => `${code} ${subject}`).sort();
}

describe('js/lib/vendor.json', () => {
  it('covers every file in js/lib/, through its own rows or the record a directory has', () => {
    const covered = new Set(['README.md', 'vendor.json', ...Object.keys(record.files)]);
    for (const [dir, entry] of Object.entries(record.records)) {
      const nested = JSON.parse(fs.readFileSync(path.join(LIB, entry.record), 'utf8'));
      covered.add(entry.record);
      Object.keys(nested.files).forEach((name) => covered.add(`${dir}${name}`));
    }
    const files = filesUnder('js/lib').map((file) => file.slice('js/lib/'.length)).sort();
    assert.deepEqual(files, [...covered].sort());
  });

  it('gives each file its package, exact version, license, source, notice heading, and the SHA-256 of the file as committed', () => {
    const notices = fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES'), 'utf8');
    for (const [name, file] of Object.entries(record.files)) {
      assert.match(file.version, /^\d+\.\d+\.\d+$/, name);
      assert.ok(file.package && file.license && file.page && file.from, name);
      assert.match(file.source, /^https:\/\/(cdn\.jsdelivr\.net|registry\.npmjs\.org)\//, name);
      assert.equal(sha256(fs.readFileSync(path.join(LIB, name))), file.sha256, `${name} differs from its record`);
      assert.match(notices, new RegExp(`^\\d+\\. ${file.notice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?$`, 'm'), `${name}'s notice heading`);
    }
  });

  it('keeps each license banner in its file, and records that transformers.js has none upstream', () => {
    for (const [name, file] of Object.entries(record.files)) {
      if (file.banner === null) continue;
      assert.ok(fs.readFileSync(path.join(LIB, name), 'utf8').includes(file.banner), `${name} lost its banner`);
    }
    assert.deepEqual(Object.entries(record.files).filter(([, file]) => file.banner === null).map(([name]) => name), ['transformers.js']);
  });

  it('records the two deleted sourceMappingURL lines with the SHA-256 before each, and no file names a map', () => {
    for (const name of ['chart.js', 'transformers.js']) {
      const edit = record.files[name].edits.find((entry) => /sourceMappingURL/.test(entry.change));
      assert.ok(edit, `${name} records its sourceMappingURL edit`);
      assert.equal(edit.by, '#27 slice 1');
      assert.match(edit.sha256Before, /^[0-9a-f]{64}$/);
      assert.notEqual(edit.sha256Before, record.files[name].sha256);
    }
    assert.deepEqual(record.files['fuse.js'].edits, []);
    assert.deepEqual(record.files['jszip.min.js'].edits, []);
    for (const file of filesUnder('js/lib').filter((name) => /\.m?js$/.test(name))) {
      assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /[#@]\s*sourceMappingURL\s*=/, file);
    }
  });

  it('js/lib/README.md no longer calls chart.js or transformers.js unmodified, and points at the record', () => {
    const readme = fs.readFileSync(path.join(LIB, 'README.md'), 'utf8');
    assert.doesNotMatch(readme, /The other files are unmodified/);
    assert.match(readme, /closing `\/\/# sourceMappingURL` line deleted/);
    assert.match(readme, /`vendor\.json` records/);
  });

  it('readVendor reads every shipped vendored file by its package path, Valibot\'s from its own record', () => {
    assert.deepEqual([...readVendor().keys()].sort(), [
      'js/lib/chart.js', 'js/lib/fuse.js', 'js/lib/jszip.min.js', 'js/lib/transformers.js',
      'js/lib/valibot/LICENSE.md', 'js/lib/valibot/index.mjs',
    ]);
  });
});

describe('the notice, source-map, and vendor checks (AC9)', () => {
  it('pass the package the build lists describe', () => {
    const pkg = sourcePackage();
    assert.deepEqual([...checkNoticeFiles(pkg), ...checkBanners(pkg), ...checkSourceMaps(pkg), ...checkVendor(pkg)], []);
  });

  it('fail on a missing notice file, a stripped banner, a missing notice heading, and a vendored file that changed or has no record', () => {
    const fuse = fs.readFileSync(path.join(LIB, 'fuse.js'), 'utf8');
    const notices = fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES'), 'utf8');
    const pkg = sourcePackage({
      edits: {
        LICENSE: null,
        'js/lib/fuse.js': fuse.replace(/^\/\*\*[\s\S]*?\*\/\n/, ''),
        THIRD_PARTY_NOTICES: notices.replace('\n4. JSZip 3.10.1\n', '\n4. JSZip\n'),
        'js/lib/extra.js': 'window.extra = 1;',
      },
    });
    assert.deepEqual(found([...checkNoticeFiles(pkg), ...checkBanners(pkg), ...checkVendor(pkg)]), [
      'notices/banner js/lib/fuse.js',
      'notices/missing-file LICENSE',
      'notices/no-entry js/lib/jszip.min.js',
      'vendor/mismatch js/lib/fuse.js',
      'vendor/unlisted js/lib/extra.js',
    ]);
  });

  it('fail on a source map in the package and a sourceMappingURL comment in a script, stylesheet, or page', () => {
    const pkg = packageOf({
      'js/a.js': 'run();\n//# sourceMappingURL=a.js.map\n',
      'js/a.js.map': '{}',
      'css/a.css': 'a{}\n/*# sourceMappingURL=a.css.map */\n',
      'page.html': '<p>page</p>',
      'notes.txt': '//# sourceMappingURL=not-shipped-code.map',
    });
    assert.deepEqual(found(checkSourceMaps(pkg)), [
      'source-map/comment css/a.css:2:3',
      'source-map/comment js/a.js:2:3',
      'source-map/file js/a.js.map',
    ]);
  });
});
