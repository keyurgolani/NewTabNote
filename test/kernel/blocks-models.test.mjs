// #14 slice 1 (approved AC1 to AC3, "Data and migration", the opaque rule): the 18 built-in
// models with their current, legacy, newer, and invalid fixtures and an unknown type's; decode
// and encode, which keep every record they can't own verbatim; createBlock; and a model layer
// that's pure, deterministic, DOM-free, and in the worker's static graph.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { BUILT_IN_BLOCKS, BUILT_IN_TYPES } from '../../js/kernel/core/blocks/builtins.js';
import { ENVELOPE_FIELDS, FIELD_KINDS, invalidField, isFieldMap } from '../../js/kernel/core/blocks/fields.js';
import { MODELS } from '../../js/kernel/core/blocks/models.js';
import {
  PROJECTION_VERSION,
  aiContextText,
  createBlock,
  decodeBlock,
  encodeBlock,
  markdownOf,
  plainText,
  previewText,
  searchText,
} from '../../js/kernel/core/blocks/index.js';

const ROOT = path.join(import.meta.dirname, '..', '..');
const BLOCKS_DIR = path.join(ROOT, 'js', 'kernel', 'core', 'blocks');

/** What 1.4.x's Block constructor gives a new block of each type, as serialize() writes it */
const CONSTRUCTOR_DEFAULTS = {
  content: '',
  indentLevel: 0,
  checked: false,
  imageUrl: null,
  calloutIcon: '💡',
};
const TYPE_DEFAULTS = {
  toggle: { collapsed: true, children: '' },
  table: { rows: 2, cols: 2, tableData: null, hasHeaderRow: true },
  bookmark: { url: '', title: '', description: '', favicon: '' },
  video: { videoUrl: '' },
  file: { fileName: '', fileSize: 0, fileData: null },
  equation: { equation: '' },
};

/** An unknown type's record, as a newer build or a future plugin could have saved it */
const UNKNOWN = Object.freeze({
  id: '1730000000000-zzzz',
  type: 'kanban',
  schemaVersion: 3,
  columns: [{ title: 'To do', cards: ['a'] }],
  content: '<b>board</b>',
  canvasId: '1730000000000-n0te',
  order: 4,
});

describe('the 18 built-in models and their fixtures (#14, approved test plan)', () => {
  for (const type of BUILT_IN_TYPES) {
    const { model, fields } = MODELS[type];
    const { current, legacy, newer, invalid } = model.examples;

    describe(type, () => {
      it("owns the fields 1.4.x's serialize() writes for it, with the Block constructor's defaults", () => {
        assert.ok(isFieldMap(fields));
        assert.deepEqual(model.defaults, { ...CONSTRUCTOR_DEFAULTS, ...(TYPE_DEFAULTS[/** @type {keyof typeof TYPE_DEFAULTS} */ (type)] ?? {}) });
        assert.deepEqual(Object.keys(fields).sort(), Object.keys(model.defaults).sort());
        for (const name of Object.keys(fields)) assert.ok(!ENVELOPE_FIELDS.includes(name));
      });

      it('current: decodes as current at version 1, and encodes as the same record', () => {
        const decoded = decodeBlock(current);
        assert.equal(decoded.state, 'current');
        assert.equal(encodeBlock(decoded), current);
        if (decoded.state !== 'current') return;
        assert.equal(decoded.version, 1);
        assert.deepEqual(decoded.extra, { futureField: 'kept' });
        for (const name of Object.keys(decoded.fields)) assert.ok(Object.hasOwn(fields, name));
      });

      it('legacy: a record with no schemaVersion is version 0, upcast to 1 with every field kept in place', () => {
        assert.equal('schemaVersion' in legacy, false);
        const decoded = decodeBlock(legacy);
        assert.equal(decoded.state, 'upcast');
        if (decoded.state !== 'upcast') return;
        assert.equal(decoded.from, 0);
        assert.equal(decoded.record, legacy);
        const encoded = /** @type {Record<string, unknown>} */ (encodeBlock(decoded));
        assert.deepEqual(Object.keys(encoded), [...Object.keys(legacy), 'schemaVersion']);
        assert.deepEqual(encoded, { ...legacy, schemaVersion: 1 });
        // Upcasting is idempotent: the upcast record decodes as current and encodes as itself
        const again = decodeBlock(encoded);
        assert.equal(again.state, 'current');
        assert.equal(encodeBlock(again), encoded);
        // The upcaster is pure: the record it read is unchanged
        assert.equal('schemaVersion' in legacy, false);
        assert.equal(decodeBlock({ ...legacy, schemaVersion: 0 }).state, 'upcast');
      });

      it('newer: a version above the model\'s is kept verbatim and read-only, never downgraded', () => {
        const decoded = decodeBlock(newer);
        assert.deepEqual([decoded.state, decoded.type], ['newer', type]);
        assert.equal(encodeBlock(decoded), newer);
      });

      it('invalid: an owned field of the wrong kind is kept verbatim and named', () => {
        const decoded = decodeBlock(invalid);
        assert.equal(decoded.state, 'invalid');
        if (decoded.state !== 'invalid') return;
        assert.equal(decoded.reason, 'invalid-field');
        assert.ok(decoded.field !== null && Object.hasOwn(fields, decoded.field));
        assert.equal(encodeBlock(decoded), invalid);
      });

      it('projects and encodes each example the same every time, and never changes it', () => {
        for (const example of [current, legacy, newer]) {
          const copy = structuredClone(example);
          const once = [previewText(example), searchText(example), plainText(example), aiContextText(example), markdownOf(example)];
          const twice = [previewText(example), searchText(example), plainText(example), aiContextText(example), markdownOf(example)];
          assert.deepEqual(twice, once);
          assert.deepEqual(example, copy);
          assert.equal(searchText(example), previewText(example));
        }
      });

      it('createBlock makes a valid version 1 record of it, and decodes back as current', () => {
        const created = createBlock(type, { id: 'new-block', canvasId: 'note', order: 2 });
        assert.equal(created.ok, true);
        if (!created.ok) return;
        assert.deepEqual(created.record, { id: 'new-block', type, ...model.defaults, canvasId: 'note', order: 2, schemaVersion: 1 });
        assert.equal(decodeBlock(created.record).state, 'current');
      });
    });
  }

  it('unknown: a type no definition has is kept verbatim, with every field it holds', () => {
    const decoded = decodeBlock(UNKNOWN);
    assert.ok(decoded.state === 'unknown', decoded.state);
    assert.deepEqual([decoded.type, decoded.version], ['kanban', 3]);
    assert.equal(encodeBlock(decoded), UNKNOWN);
    // A type matches exactly, and never through the prototype
    for (const type of ['Text', 'TEXT', ' text', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal(decodeBlock({ id: 'a', type }).state, 'unknown', type);
    }
  });
});

describe('decode keeps what it can\'t read (#14, the opaque rule)', () => {
  it('reads anything that isn\'t a block record as invalid, kept as it is', () => {
    for (const [value, reason] of /** @type {const} */ ([
      [null, 'not-a-record'],
      [undefined, 'not-a-record'],
      ['text', 'not-a-record'],
      [5, 'not-a-record'],
      [[{ type: 'text' }], 'not-a-record'],
      [{ content: 'no type' }, 'invalid-type'],
      [{ type: '' }, 'invalid-type'],
      [{ type: 5 }, 'invalid-type'],
      [{ type: 'text', schemaVersion: -1 }, 'invalid-version'],
      [{ type: 'text', schemaVersion: 1.5 }, 'invalid-version'],
      [{ type: 'text', schemaVersion: '1' }, 'invalid-version'],
      [{ type: 'text', schemaVersion: null }, 'invalid-version'],
      [{ type: 'text', content: { html: 'x' } }, 'invalid-field'],
      [{ type: 'table', tableData: [['a'], 'b'] }, 'invalid-field'],
      [{ type: 'file', fileSize: Infinity }, 'invalid-field'],
      [{ type: 'todo', checked: {} }, 'invalid-field'],
    ])) {
      const decoded = decodeBlock(value);
      assert.equal(decoded.state, 'invalid', JSON.stringify(value));
      if (decoded.state === 'invalid') assert.equal(decoded.reason, reason, JSON.stringify(value));
      assert.equal(encodeBlock(decoded), value);
    }
  });

  it('takes what 1.4.x saved: null text, any primitive flag, and fields it doesn\'t own', () => {
    for (const record of [
      { id: 'a', type: 'text', content: null, imageUrl: null },
      { id: 'b', type: 'todo', checked: 'yes' },
      { id: 'c', type: 'todo', checked: 0 },
      { id: 'd', type: 'table', tableData: null },
      { id: 'e', type: 'table', tableData: [] },
      { id: 'f', type: 'text', content: 'x', tableData: 'a field text doesn\'t own' },
      { id: 'g', type: 'image', imageUrl: 'data:image/png;base64,AA==', caption: 'a caption', src: 'x' },
    ]) {
      const decoded = decodeBlock(record);
      assert.equal(decoded.state, 'upcast', JSON.stringify(record));
    }
    const decoded = decodeBlock({ id: 'f', type: 'text', content: 'x', tableData: 'kept', canvasId: 'n' });
    assert.ok(decoded.state === 'upcast');
    if (decoded.state === 'upcast') {
      assert.deepEqual(decoded.extra, { tableData: 'kept' });
      assert.deepEqual(decoded.fields, { content: 'x' });
    }
  });

  it('freezes what it makes, and leaves what it was given alone', () => {
    const record = { id: 'a', type: 'text', content: 'x' };
    const decoded = decodeBlock(record);
    assert.ok(Object.isFrozen(decoded));
    assert.equal(Object.isFrozen(record), false);
    assert.deepEqual(record, { id: 'a', type: 'text', content: 'x' });
  });

  it("keeps a field named __proto__, as JSON can give one, as an own field and not a prototype", () => {
    const record = JSON.parse('{"id":"a","type":"text","content":"x","__proto__":{"kept":true}}');
    const decoded = decodeBlock(record);
    assert.ok(decoded.state === 'upcast', decoded.state);
    assert.ok(Object.hasOwn(decoded.extra, '__proto__'));
    assert.deepEqual(Object.getOwnPropertyDescriptor(decoded.extra, '__proto__')?.value, { kept: true });
    assert.equal(Object.getPrototypeOf(decoded.extra), Object.prototype);
    assert.equal(/** @type {Record<string, unknown>} */ (decoded.extra).kept, undefined);
    assert.equal(encodeBlock(decoded), decoded.block);
  });
});

describe('createBlock, the one way to make a block (#14, "One way in")', () => {
  it('refuses an unknown type, a missing id, a field the type doesn\'t own, and a field of the wrong kind', () => {
    assert.deepEqual(createBlock('kanban', { id: 'a' }), { ok: false, code: 'unknown-type', field: null });
    assert.deepEqual(createBlock('text', /** @type {any} */ ({})), { ok: false, code: 'invalid-id', field: 'id' });
    assert.deepEqual(createBlock('text', { id: '' }), { ok: false, code: 'invalid-id', field: 'id' });
    assert.deepEqual(createBlock('text', { id: 'a', tableData: [] }), { ok: false, code: 'unknown-field', field: 'tableData' });
    assert.deepEqual(createBlock('text', { id: 'a', type: 'h1' }), { ok: false, code: 'unknown-field', field: 'type' });
    assert.deepEqual(createBlock('text', { id: 'a', schemaVersion: 0 }), { ok: false, code: 'unknown-field', field: 'schemaVersion' });
    assert.deepEqual(createBlock('table', { id: 'a', tableData: 'x' }), { ok: false, code: 'invalid-field', field: 'tableData' });
  });

  it('takes the fields the type owns over its defaults', () => {
    const created = createBlock('table', { id: 't', tableData: [['a', 'b']], rows: 1 });
    assert.ok(created.ok);
    if (!created.ok) return;
    assert.deepEqual(created.record, {
      id: 't',
      type: 'table',
      ...MODELS.table.model.defaults,
      tableData: [['a', 'b']],
      rows: 1,
      schemaVersion: 1,
    });
    assert.ok(Object.isFrozen(created.record));
  });
});

describe('field kinds (#14, "Data and migration")', () => {
  it('has the seven kinds, each taking null and absent', () => {
    assert.deepEqual([...FIELD_KINDS], ['richText', 'plainText', 'url', 'data', 'number', 'flag', 'grid']);
    for (const kind of FIELD_KINDS) {
      assert.equal(invalidField({ a: kind }, { a: null }), null, kind);
      assert.equal(invalidField({ a: kind }, {}), null, kind);
      assert.equal(invalidField({ a: kind }, { a: undefined }), null, kind);
    }
    assert.equal(invalidField({ a: 'number' }, { a: NaN }), 'a');
    assert.equal(invalidField({ a: 'grid' }, { a: [[1], []] }), null);
    assert.equal(invalidField({ a: 'flag' }, { a: () => true }), 'a');
  });

  it('refuses a field map with an envelope field, an unknown kind, or none at all', () => {
    assert.equal(isFieldMap({}), false);
    assert.equal(isFieldMap({ order: 'number' }), false);
    assert.equal(isFieldMap({ a: 'html' }), false);
    assert.equal(isFieldMap({ 'a-b': 'plainText' }), false);
    assert.equal(isFieldMap(['plainText']), false);
    assert.equal(isFieldMap({ a: 'plainText' }), true);
  });
});

describe('the model layer is pure, DOM-free, and static (#14, "Projections", code fact 12)', () => {
  const sources = fs
    .readdirSync(BLOCKS_DIR)
    .filter(name => name.endsWith('.js'))
    .map(name => [name, fs.readFileSync(path.join(BLOCKS_DIR, name), 'utf8')]);

  it('reads no DOM, browser API, or global, and loads nothing lazily', () => {
    assert.ok(sources.length >= 9);
    const banned = /\b(?:innerHTML|outerHTML|DOMParser|document|window|globalThis|self|fetch|chrome|indexedDB|localStorage|navigator|XMLHttpRequest|setTimeout|Date\.now|Math\.random)\b|\bimport\s*\(/;
    for (const [name, source] of sources) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const found = banned.exec(code);
      assert.equal(found, null, `${name} has ${found?.[0]}`);
    }
  });

  it("loads statically, and each surface loads what it reads: the new tab all of it, the others only previews, wiki-link names and the plain-text escape", () => {
    /** @param {string} file @param {Set<string>} seen */
    const walk = (file, seen) => {
      if (seen.has(file)) return seen;
      seen.add(file);
      // Type imports in JSDoc load nothing
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const imports = [
        ...source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/gm),
        ...source.matchAll(/^\s*import\s+['"](\.[^'"]+)['"]/gm),
        // What a page loads later still loads there
        ...source.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g),
      ];
      for (const match of imports) walk(path.resolve(path.dirname(file), match[1]), seen);
      return seen;
    };
    /** @param {string[]} entries - a surface's scripts, every one its page or manifest names */
    const blocksIn = entries => {
      /** @type {Set<string>} */
      const seen = new Set();
      for (const entry of entries) walk(path.join(ROOT, 'js', entry), seen);
      return [...seen]
        .filter(file => path.dirname(file) === BLOCKS_DIR)
        .map(file => path.basename(file))
        .sort();
    };
    // Each page's scripts, as its HTML names them, and the service worker
    const scriptsOf = (/** @type {string} */ page) =>
      [...fs.readFileSync(path.join(ROOT, page), 'utf8').matchAll(/<script\b[^>]*\bsrc="js\/([^"]+)"/g)].map(match => match[1]);
    // The network guard first (#21 slice 1b), which reads no block
    assert.deepEqual(scriptsOf('sidepanel.html').sort(), ['insights-summary.js', 'network-guard.js', 'sidepanel.js']);
    // The new tab's bridge reads every projection and the codec
    assert.deepEqual(blocksIn(scriptsOf('newtab.html').filter(name => !name.startsWith('lib/'))), sources.map(([name]) => name).sort());
    // The Popup, the Side Panel and the service worker read only previews, wiki-link names and
    // capture's escape of plain text into rich text, through the note domain, so the tokenizer
    // and its table of character references stay off them
    for (const entries of [scriptsOf('popup.html'), scriptsOf('sidepanel.html'), ['background.js']]) {
      assert.deepEqual(blocksIn(entries), ['previews.js', 'rich-text.js', 'strip-tags.js', 'wiki-links.js'], entries.join(', '));
    }
  });

  it('has a projection version for caches to key on', () => {
    assert.equal(PROJECTION_VERSION, 1);
  });

  it('describes each built-in once, in BlockTypes order', () => {
    assert.deepEqual(BUILT_IN_BLOCKS.map(descriptor => descriptor.id), Object.keys(MODELS));
  });
});
