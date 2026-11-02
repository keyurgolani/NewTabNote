// #14 slice 3, lossless conversions: what a block keeps when it turns into another type, and the
// structure that goes, which the editor asks about first. A conversion never deletes text the
// user wrote: a table's cells, a bookmark's title, link and description, an equation's source,
// a file's name and a video's address become the new block's text, escaped, and a toggle's
// hidden content becomes a new text block after it. A block in a safe state never converts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { BUILT_IN_TYPES } from '../../js/kernel/core/blocks/builtins.js';
import { conversionOf } from '../../js/kernel/core/blocks/index.js';
import { MODELS } from '../../js/kernel/core/blocks/models.js';

const requireCommonJs = createRequire(import.meta.url);
const { CASES } = requireCommonJs('../fixtures/blocks/corpus.cjs');

/** The types Turn into offers, as the editor lists them (getTurnIntoTypes) */
const TARGETS = ['text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'quote', 'code', 'callout', 'divider', 'toggle'];

/**
 * A block of `type` as 1.4.x's editor saved it, with `fields`
 * @param {string} type
 * @param {Record<string, unknown>} [fields]
 * @returns {Record<string, unknown>}
 */
const block = (type, fields = {}) => ({ ...MODELS[type].model.examples.legacy, type, content: '', ...fields });

/** @param {unknown} record @param {string} target */
const plan = (record, target) => {
  const conversion = conversionOf(record, target);
  assert.ok(conversion !== null, 'converts');
  return { content: conversion.content, removes: [...conversion.removes], after: conversion.after.map(added => ({ ...added })) };
};

describe('what a conversion keeps and removes (#14 slice 3)', () => {
  it('a text-like block keeps its text and removes nothing', { timeout: 30_000 }, () => {
    for (const type of ['text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'quote', 'code', 'callout', 'divider']) {
      const target = type === 'text' ? 'h1' : 'text';
      assert.deepEqual(plan(block(type, { content: 'Some <b>text</b>' }), target), { content: 'Some <b>text</b>', removes: [], after: [] }, type);
    }
  });

  it("a table keeps its text and its cells, a row per line, escaped, and removes its grid", { timeout: 30_000 }, () => {
    const table = block('table', { tableData: [['<b>x</b>', 'a & b'], ['', ' '], ['c', '']], rows: 3, cols: 2 });
    assert.deepEqual(plan(table, 'text'), { content: '&lt;b&gt;x&lt;/b&gt; a &amp; b<br>c', removes: ['grid'], after: [] });
    assert.deepEqual(plan({ ...table, content: 'Above' }, 'h2').content, 'Above<br>&lt;b&gt;x&lt;/b&gt; a &amp; b<br>c');
    // A new table, its grid not drawn yet, still has a grid to remove
    assert.deepEqual(plan(block('table', { tableData: null }), 'text'), { content: '', removes: ['grid'], after: [] });
  });

  it('a bookmark keeps its title as a link to its address, and its description, and removes nothing', { timeout: 30_000 }, () => {
    const bookmark = block('bookmark', { url: 'https://a.test/?a&b', title: '<i>t</i>', description: 'd & e', favicon: 'https://a.test/icon.png' });
    assert.deepEqual(plan(bookmark, 'text'), {
      content: '<a href="https://a.test/?a&amp;b">&lt;i&gt;t&lt;/i&gt;</a><br>d &amp; e',
      removes: [],
      after: [],
    });
    // With no title, the address is the link's text
    assert.equal(plan(block('bookmark', { url: 'https://a.test/', title: '', description: '' }), 'text').content, '<a href="https://a.test/">https://a.test/</a>');
    // An address whose scheme a link may not have stays text
    assert.equal(plan(block('bookmark', { url: 'ftp://a.test/f', title: 'F', description: '' }), 'text').content, 'F ftp://a.test/f');
    // One with nothing in it keeps nothing
    assert.deepEqual(plan(block('bookmark', { url: '', title: '', description: '' }), 'text'), { content: '', removes: [], after: [] });
  });

  it("an equation keeps its source, and a file its name, escaped; the file's data goes, and asks first", { timeout: 30_000 }, () => {
    assert.deepEqual(plan(block('equation', { equation: 'a < b > c' }), 'text'), { content: 'a &lt; b &gt; c', removes: [], after: [] });
    assert.deepEqual(plan(block('file', { fileName: '<x>.txt', fileSize: 5, fileData: 'data:,' }), 'text'), {
      content: '&lt;x&gt;.txt',
      removes: ['file'],
      after: [],
    });
    assert.deepEqual(plan(block('file', { fileName: '', fileData: null }), 'text'), { content: '', removes: [], after: [] });
  });

  it('a video keeps its address as a link and removes the embed; an image removes the image', { timeout: 30_000 }, () => {
    assert.deepEqual(plan(block('video', { videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk' }), 'text'), {
      content: '<a href="https://www.youtube.com/watch?v=abcdefghijk">https://www.youtube.com/watch?v=abcdefghijk</a>',
      removes: ['video'],
      after: [],
    });
    assert.deepEqual(plan(block('video', { videoUrl: '' }), 'text'), { content: '', removes: [], after: [] });
    assert.deepEqual(plan(block('image', { imageUrl: 'data:image/png;base64,iVBORw0KGgo=' }), 'text'), { content: '', removes: ['image'], after: [] });
    assert.deepEqual(plan(block('image', { imageUrl: null }), 'text'), { content: '', removes: [], after: [] });
  });

  it('a toggle keeps its heading, its hidden content goes to a new text block after it, and its arrow goes', { timeout: 30_000 }, () => {
    assert.deepEqual(plan(block('toggle', { content: 'Heading', children: 'Inside <i>it</i>' }), 'h1'), {
      content: 'Heading',
      removes: ['arrow'],
      after: [{ type: 'text', content: 'Inside <i>it</i>' }],
    });
    // Hidden content of only line breaks and spaces is nothing to move
    assert.deepEqual(plan(block('toggle', { content: 'Heading', children: ' <br>&nbsp;' }), 'text'), {
      content: 'Heading',
      removes: [],
      after: [],
    });
  });

  it('a block in a safe state, a block turned into its own type, or a target this build lacks converts to nothing', { timeout: 30_000 }, () => {
    assert.equal(conversionOf({ ...block('text'), schemaVersion: 9 }, 'h1'), null, 'newer');
    assert.equal(conversionOf({ ...block('text'), type: 'kanban' }, 'text'), null, 'unknown');
    assert.equal(conversionOf(block('text', { content: { not: 'text' } }), 'h1'), null, 'invalid');
    assert.equal(conversionOf(block('h1'), 'h1'), null, 'its own type');
    assert.equal(conversionOf(block('h1'), 'kanban'), null, 'a target with no definition');
    assert.equal(conversionOf(null, 'text'), null);
  });

  it("every built-in's examples, and every corpus block, convert into every target to rich text, or to nothing", { timeout: 60_000 }, () => {
    const records = [
      ...BUILT_IN_TYPES.flatMap(type => Object.values(MODELS[type].model.examples)),
      ...CASES.map(([, record]) => record),
    ];
    for (const record of records) {
      for (const target of TARGETS) {
        const conversion = conversionOf(record, target);
        if (conversion === null) continue;
        assert.equal(typeof conversion.content, 'string');
        assert.ok(conversion.after.every(added => added.type === 'text' && typeof added.content === 'string'));
        assert.ok(conversion.removes.every(part => ['grid', 'image', 'video', 'file', 'arrow'].includes(part)));
      }
    }
  });
});
