/**
 * The blocks #14 slice 1's characterization tests run every caller over, old and new: each
 * built-in type, a type no definition has, and none, with each field 1.4.x reads given markup,
 * entities, white space, and values that aren't text, and things that aren't blocks at all.
 * A case is `[name, block]`; the tests compare each caller's output, or the class of what it
 * threw, on every case.
 *
 * Nothing in the extension loads this file.
 */

'use strict';

const TYPES = [
  'text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'toggle', 'quote', 'code', 'divider',
  'callout', 'image', 'table', 'bookmark', 'video', 'file', 'equation',
];

/** Markup as the editor stores it, and what isn't */
const TEXTS = [
  '',
  'plain words',
  'a <b>bold</b> &amp; <i>italic</i> word',
  '<br>line one<br/>line two<BR />three',
  '&nbsp;padded&nbsp;&NBSP;',
  'a&lt;b&gt;c &quot;q&quot; &#39;s&#39; &#x27;h&#x27;',
  '<a class="wiki-link" data-note-name="Other note">Other note</a> and on',
  '<a href="https://example.test/page">a link</a> after',
  '<code>c()</code> <del>d</del> <s>s</s> <strike>k</strike> <strong>st</strong> <em>em</em> <u>u</u>',
  '<script>alert(1)</script>after',
  '<!-- a comment -->visible',
  '  spaced\n\tout  ',
  'emoji 😀 &#128512; &hearts; &copy',
  '<div>block</div><p>para</p><ul><li>item</li></ul>',
  'x < y > z & w',
  '<b>unclosed',
  '&amp;lt;not a tag&amp;gt;',
  '<style>p { color: red }</style>styled',
  'line\r\nbreak\rhere',
  'nul\u0000char',
  '<span style="color: red">red</span><mark>m</mark><kbd>k</kbd>',
  '<img src="x.png" alt="pic">after image',
  '<textarea>&lt;raw&gt;</textarea>',
  '<pre>\nkept</pre>',
  '<svg><title>t</title><text>svg text</text></svg>',
  '<b><i>nested</b></i> tags',
  '&unknownentity; &amp &lt3',
  '1 &#0; 2 &#x80; 3 &#xD800; 4 &#1114112;',
  '<noscript><b>n</b>&amp;</noscript> after',
];

/** Values that aren't markup, for any field */
const ODD = [null, 0, 5, true, false, ['a', 'b'], { a: 1 }];

const GRIDS = [
  null,
  [],
  [['Name', 'Age'], ['Ada', '36']],
  [['<b>bold</b>', '&amp;'], ['', ' '], ['x<br>y', 'z']],
  [['only']],
  'not a grid',
  [[null, 1], [true, undefined]],
  [['a'], 'not a row'],
  [[['deep'], 'b']],
  { length: 1 },
  [],
];

/** @type {Array<[string, unknown]>} */
const CASES = [];

/** @param {string} name @param {unknown} block */
const add = (name, block) => CASES.push([name, block]);

const base = type => ({
  id: '1730000000000-a1b2c3d4e',
  type,
  content: 'Some <b>text</b>',
  indentLevel: 0,
  checked: false,
  imageUrl: null,
  calloutIcon: '💡',
  createdAt: 1730000000000,
  updatedAt: 1730000000500,
});

const ALL_TYPES = [...TYPES, 'unknown-type', 'Text', 'constructor', '__proto__', undefined, null, 5];

for (const type of ALL_TYPES) {
  const label = String(type);
  TEXTS.forEach((content, i) => add(`${label} content text ${i}`, { ...base(type), content }));
  ODD.forEach((content, i) => add(`${label} content odd ${i}`, { ...base(type), content }));
  add(`${label} no content`, { id: 'x', type });
  add(`${label} checked`, { ...base(type), checked: true });
  add(`${label} checked odd`, { ...base(type), checked: 'yes' });
  add(`${label} callout icon empty`, { ...base(type), calloutIcon: '' });
  add(`${label} callout icon`, { ...base(type), calloutIcon: '⚠️' });
  add(`${label} schema version 1`, { ...base(type), schemaVersion: 1 });
  add(`${label} schema version 9`, { ...base(type), schemaVersion: 9, newer: { x: 1 } });
  add(`${label} extra field`, { ...base(type), futureField: 'kept' });
  // Every type-specific field, so a type reading one it doesn't own shows up
  TEXTS.forEach((text, i) => {
    add(`${label} children text ${i}`, { ...base(type), collapsed: false, children: text });
    add(`${label} equation text ${i}`, { ...base(type), content: '', equation: text });
    add(`${label} file name text ${i}`, { ...base(type), content: '', fileName: text, fileSize: 3, fileData: null });
    add(`${label} video url text ${i}`, { ...base(type), content: '', videoUrl: text });
    add(`${label} bookmark text ${i}`, { ...base(type), content: '', url: 'https://example.test/', title: text, description: text });
    add(`${label} caption text ${i}`, { ...base(type), imageUrl: 'data:image/png;base64,AA==', caption: text });
  });
  ODD.forEach((value, i) => {
    add(`${label} children odd ${i}`, { ...base(type), children: value });
    add(`${label} equation odd ${i}`, { ...base(type), equation: value });
    add(`${label} file name odd ${i}`, { ...base(type), fileName: value });
    add(`${label} video url odd ${i}`, { ...base(type), videoUrl: value });
    add(`${label} bookmark odd ${i}`, { ...base(type), url: value, title: value, description: value });
    add(`${label} image odd ${i}`, { ...base(type), imageUrl: value, src: value, caption: value });
  });
  GRIDS.forEach((tableData, i) => add(`${label} grid ${i}`, { ...base(type), content: '', tableData, rows: 2, cols: 2 }));
  GRIDS.forEach((tableData, i) => add(`${label} grid with content ${i}`, { ...base(type), tableData }));
  add(`${label} bookmark empty`, { ...base(type), content: '', url: '', title: '', description: '' });
  add(`${label} bookmark url only`, { ...base(type), content: '', url: 'https://example.test/only' });
  add(`${label} bookmark title only`, { ...base(type), content: '', title: 'Only a title' });
  add(`${label} image src only`, { ...base(type), imageUrl: null, src: 'https://example.test/i.png' });
  add(`${label} image none`, { ...base(type), content: '', imageUrl: null });
}

// Things that aren't blocks
add('null', null);
add('undefined', undefined);
add('zero', 0);
add('empty string', '');
add('a string', '<b>not a block</b>');
add('a number', 5);
add('true', true);
add('false', false);
add('an empty array', []);
add('an array of a block', [{ type: 'text', content: 'x' }]);
add('an empty object', {});
add('a function', function block() {});

module.exports = { CASES, TYPES };
