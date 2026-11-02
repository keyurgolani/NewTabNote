// #14 slice 3, isMeaningful (the opaque rule's empty-note check): a block holds nothing only
// when decode reads it as a known text block, every field its type's own or the envelope's,
// whose content is only spaces, line breaks and non-breaking spaces. Every other block holds
// something: every other type, as before, a block in a safe state, and a block holding a field
// its type doesn't own. The check runs on the Popup's, the Side Panel's and the worker's
// command module too, so it reads no model; these tests hold it to the built-ins' catalog.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { BUILT_IN_TYPES } from '../../js/kernel/core/blocks/builtins.js';
import { builtInCatalog } from '../../js/kernel/core/blocks/index.js';
import { TEXT_VERSION, isBlankText, isMeaningful } from '../../js/kernel/core/blocks/meaningful.js';
import { MODELS } from '../../js/kernel/core/blocks/models.js';
import { isEmpty } from '../../js/kernel/core/domain/note.js';

const requireCommonJs = createRequire(import.meta.url);
const { CASES } = requireCommonJs('../fixtures/blocks/corpus.cjs');
const STORAGE = path.join(import.meta.dirname, '..', 'fixtures', 'storage');

/**
 * A text block as 1.4.x's editor saved it
 * @param {unknown} content
 * @param {Record<string, unknown>} [fields]
 * @returns {any} a stored block, as the store gives it to isEmpty
 */
const text = (content, fields = {}) => ({
  id: '1730000000000-a1b2c3d4e',
  type: 'text',
  content,
  indentLevel: 0,
  checked: false,
  imageUrl: null,
  calloutIcon: '💡',
  createdAt: 1730000000000,
  updatedAt: 1730000000000,
  canvasId: '1730000000000-n0te',
  order: 0,
  ...fields,
});

/**
 * What the empty-note check means, read through the built-ins' catalog: a block holds nothing
 * only when it decodes as a known text block with no field its type doesn't own, no image in
 * its imageUrl, and blank text
 * @param {unknown} record
 */
function meaningfulByCatalog(record) {
  const decoded = builtInCatalog().decode(record);
  if (decoded.state !== 'current' && decoded.state !== 'upcast') return true;
  if (Object.keys(decoded.extra).length > 0) return true;
  if (decoded.type !== 'text') return true;
  // An image in its imageUrl: an address, or a data URL with something after its comma
  const image = decoded.block.imageUrl;
  if (typeof image === 'string' && image.trim() !== '' && !/^data:[^,]*,$/i.test(image.trim())) return true;
  return !isBlankText(decoded.block.content);
}

/** Every block record the storage fixtures hold, recorded and synthesized */
function fixtureBlocks() {
  const blocks = [];
  for (const kind of ['recorded', 'synthesized']) {
    const dir = path.join(STORAGE, kind);
    for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.json'))) {
      const fixture = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      for (const database of fixture.databases || []) {
        for (const store of database.stores || []) {
          if (store.name === 'elements') for (const { value } of store.records) blocks.push([`${kind}/${file}`, value]);
        }
      }
    }
  }
  return blocks;
}

describe('isMeaningful, the empty-note check (#14 slice 3)', () => {
  it('counts an empty text block as nothing, at version 0 and at the version this build saves', { timeout: 30_000 }, () => {
    for (const content of ['', '   ', '<br>', '<br/>', ' <br>&nbsp;<BR/>\n&NBSP;<br />', null, undefined]) {
      assert.equal(isMeaningful(text(content)), false, JSON.stringify(content));
      assert.equal(isMeaningful(text(content, { schemaVersion: TEXT_VERSION })), false, JSON.stringify(content));
    }
    // A text block holding only its own fields, empty ones included, holds nothing
    assert.equal(isMeaningful({ id: 'b', type: 'text' }), false);
    assert.equal(isMeaningful(text('', { imageUrl: 'data:,' })), false, "an image field the text type owns doesn't count, as before");
  });

  it('counts a text block with any text or markup in it as something, as before', { timeout: 30_000 }, () => {
    for (const content of ['x', '<b></b>', '<img src="data:,">', '<p> </p>', '&amp;']) {
      assert.equal(isMeaningful(text(content)), true, content);
    }
  });

  it('counts every other built-in type as something, empty or not, as before', { timeout: 30_000 }, () => {
    for (const type of BUILT_IN_TYPES.filter(type => type !== 'text')) {
      assert.equal(isMeaningful({ ...MODELS[type].model.examples.legacy, type, content: '' }), true, type);
      assert.equal(isMeaningful({ id: 'b', type }), true, type);
    }
  });

  it('counts a block in a safe state as something: newer, of a type this build lacks, or one it can\'t read', { timeout: 30_000 }, () => {
    assert.equal(isMeaningful(text('', { schemaVersion: TEXT_VERSION + 1 })), true, 'newer');
    assert.equal(isMeaningful({ ...text(''), type: 'kanban' }), true, 'unknown');
    assert.equal(isMeaningful(text('', { schemaVersion: 'x' })), true, "a version that isn't one");
    assert.equal(isMeaningful(text('', { schemaVersion: -1 })), true, 'a negative version');
    assert.equal(isMeaningful(text('', { indentLevel: 'deep' })), true, "a field that isn't its kind");
    assert.equal(isMeaningful(text({ not: 'text' })), true, "content that isn't text");
    const { type, ...typeless } = text('');
    assert.equal(isMeaningful(typeless), true, 'no type');
    assert.equal(isMeaningful({ ...text(''), type: '' }), true, 'an empty type');
    for (const value of [null, undefined, 5, 'text', [text('')]]) assert.equal(isMeaningful(value), true, String(value));
  });

  it('counts a text block holding a field its type doesn\'t own as something, another type\'s or one no type has', { timeout: 30_000 }, () => {
    for (const fields of [
      { futureField: 'kept' },
      { tableData: [['Header 1', ' ']] },
      { url: 'https://example.test', title: 'Example' },
      { children: '<p>child</p>' },
      { equation: ' ' },
      { source: 'https://example.test' },
    ]) {
      assert.equal(isMeaningful(text('', fields)), true, JSON.stringify(Object.keys(fields)));
    }
    // A field named __proto__, as JSON.parse makes one, is a field like any other
    assert.equal(isMeaningful({ ...text(''), ...JSON.parse('{"__proto__": "kept"}') }), true, '__proto__');
  });

  it('counts a block whose imageUrl holds an image as something: an address, or a data URL with data in it', { timeout: 30_000 }, () => {
    for (const imageUrl of ['data:image/png;base64,iVBORw0KGgo=', 'https://example.test/i.png', 'blob:chrome-extension://x/1', 'images/a.png']) {
      assert.equal(isMeaningful(text('', { imageUrl })), true, imageUrl);
    }
    // No image in it: none, an empty string, white space, or a data URL with nothing after its comma
    for (const imageUrl of [null, undefined, '', '  ', 'data:,', 'data:image/png;base64,', ' data:image/png, ']) {
      assert.equal(isMeaningful(text('', { imageUrl })), false, String(imageUrl));
    }
  });

  it("reads every record as the built-ins' catalog does: the corpus, each model's examples, and every storage fixture", { timeout: 60_000 }, () => {
    const examples = BUILT_IN_TYPES.flatMap(type =>
      Object.entries(MODELS[type].model.examples).map(([state, record]) => [`${type} ${state}`, record]),
    );
    const differ = [];
    for (const [name, record] of [...CASES, ...examples, ...fixtureBlocks()]) {
      if (isMeaningful(record) !== meaningfulByCatalog(record)) differ.push(name);
      if (differ.length === 10) break;
    }
    assert.deepEqual(differ, []);
  });

  it("keeps the text model's version, which it can't read from the models it doesn't load", { timeout: 30_000 }, () => {
    assert.equal(TEXT_VERSION, builtInCatalog().definition('text')?.version);
  });

  it('decides isEmpty: no block meaningful, or none at all', { timeout: 30_000 }, () => {
    assert.equal(isEmpty([]), true);
    assert.equal(isEmpty([text(''), text('<br>', { schemaVersion: 1 })]), true);
    assert.equal(isEmpty([text(''), text('', { futureField: 'kept' })]), false);
    assert.equal(isEmpty([text(''), { ...text(''), type: 'divider' }]), false);
  });
});
