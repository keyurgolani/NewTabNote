// #14 slice 2 ("Rendering boundary"): the trusted-rendering port. Its legacy adapter renders
// 1.4.x's markup as it is and normalizes nothing; escapePlainText writes plain text into rich
// text so it shows exactly that text; the link rule refuses only schemes outside http, https
// and mailto; and a block a producer built is refused, with a code the journal takes, unless it
// decodes as a known block.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { legacyRendering } from '../../js/kernel/adapters/rendering/legacy.js';
import { decodeBlock, pageReaders, builtInCatalog, producedBlockRefusal, refusalOf } from '../../js/kernel/core/blocks/index.js';
import { escapeAttributeText, escapePlainText, isLinkHref, LINK_SCHEMES } from '../../js/kernel/core/blocks/rich-text.js';
import { textContent } from '../../js/kernel/core/blocks/html-text.js';
import { ERROR_CODES } from '../../js/trust/core/codes.js';
import { EVENT_CODES } from '../../js/trust/core/event-codes.js';

/**
 * How long one call takes, the fastest of three
 * @param {(value: string) => unknown} fn
 * @param {string} value
 */
const timeOf = (fn, value) => {
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k < 3; k++) {
    const start = performance.now();
    fn(value);
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

/**
 * Whether `fn` grows linearly on inputs `make` builds: four times the input takes well under
 * the sixteen times a quadratic read would. A busy machine can stall a measurement, so it
 * measures up to three times; a quadratic read grows too fast every time.
 * @param {(value: string) => unknown} fn
 * @param {(n: number) => string} make
 */
const linear = (fn, make) => {
  const small = make(20_000);
  const large = make(80_000);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (timeOf(fn, large) < Math.max(timeOf(fn, small) * 8, 50)) return true;
  }
  return false;
};

describe('the legacy rendering adapter (#14 slice 2)', () => {
  it("renders by assigning the markup as it is, and normalizes nothing", () => {
    const port = legacyRendering();
    const el = { innerHTML: 'old' };
    for (const markup of ['<b>x</b>', '<a class="wiki-link" data-note-name="N">[[N]]</a>', 'a &amp; b', '<script>x</script>', '']) {
      port.render(el, markup);
      assert.equal(el.innerHTML, markup);
      assert.equal(port.normalize(markup), markup);
    }
  });

  it("carries the model layer's plain-text escape and link rule", () => {
    const port = legacyRendering();
    assert.equal(port.escapePlainText, escapePlainText);
    assert.equal(port.escapeAttributeText, escapeAttributeText);
    assert.equal(port.isLinkHref, isLinkHref);
    assert.ok(Object.isFrozen(port));
  });
});

describe('plain text into rich text (#14 slice 2)', () => {
  it('escapes what markup would read: &, <, > and the no-break space, as a text node serializes', () => {
    assert.equal(escapePlainText('a & b < c > d\u00a0e "f" \'g\''), 'a &amp; b &lt; c &gt; d&nbsp;e "f" \'g\'');
    assert.equal(escapePlainText('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(escapePlainText('&amp; &#60; &lt'), '&amp;amp; &amp;#60; &amp;lt');
    assert.equal(escapePlainText('line\nbreak\ttab'), 'line\nbreak\ttab');
  });

  it("reads as the text it was given, through the tokenizer that reads markup's text", () => {
    const pieces = ['<', '>', '&', 'amp;', '&lt', '#', ';', 'x', ' ', '\u00a0', '\n', '"', "'", '<b>', '</b>', '<!--', '-->', '<script>', '&copy', '&notin;', '\u2028'];
    let seed = 0x14a2;
    const random = (/** @type {number} */ n) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    for (let k = 0; k < 5000; k++) {
      let text = '';
      for (let j = 1 + random(10); j > 0; j--) text += pieces[random(pieces.length)];
      assert.equal(textContent(escapePlainText(text)), text, JSON.stringify(text));
    }
  });

  it('escapes both quotes too for text that may land inside an attribute, and shows the same in text', () => {
    const text = 'a "b" \'c\' & <d>\u00a0';
    assert.equal(escapeAttributeText(text), 'a &quot;b&quot; &#39;c&#39; &amp; &lt;d&gt;&nbsp;');
    assert.equal(textContent(escapeAttributeText(text)), text);
  });

  it('reads null and undefined as empty, and anything else as its string', () => {
    assert.equal(escapePlainText(null), '');
    assert.equal(escapePlainText(undefined), '');
    assert.equal(escapePlainText(5), '5');
  });
});

describe("the inline schema's link rule (#14 slice 2)", () => {
  it('links to http, https and mailto, in any case', () => {
    assert.deepEqual(LINK_SCHEMES, ['http', 'https', 'mailto']);
    for (const href of ['http://a.test', 'https://a.test/p?q=1', 'mailto:me@a.test', 'HTTPS://A.TEST', 'Http:a.test']) {
      assert.equal(isLinkHref(href), true, href);
    }
  });

  it('links to a reference with no scheme, as 1.4.x did', () => {
    for (const href of ['example.com', '/path', '#top', '?q=1', '//a.test', 'a/b:c', '']) assert.equal(isLinkHref(href), true, href);
  });

  it('refuses every other scheme, read as the URL parser reads it', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      '\u0000javascript:x',
      'java\tscript:x',
      'java\nscript:x',
      'jav\rascript:x',
      'data:text/html,x',
      'vbscript:x',
      'file:///etc/passwd',
      'chrome-extension://id/x',
      'blob:https://a.test/x',
      'c:/x',
    ]) {
      assert.equal(isLinkHref(href), false, JSON.stringify(href));
    }
  });

  it('reads an address in linear time', () => {
    for (const run of [' ', '\t', '\u0001']) {
      for (const make of [(/** @type {number} */ n) => `a${run.repeat(n)}b`, (/** @type {number} */ n) => `javascript:${run.repeat(n)}x`, (/** @type {number} */ n) => run.repeat(n)]) {
        assert.ok(linear(isLinkHref, make), JSON.stringify(run));
      }
    }
  });

  it('refuses what isn\'t a string', () => {
    for (const href of [null, undefined, 5, {}, ['https://a.test']]) assert.equal(isLinkHref(href), false);
  });
});

describe("a producer's blocks (#14 slice 2, one way in)", () => {
  it('may write a block of a known type at its version or an older one', () => {
    assert.equal(producedBlockRefusal({ id: 'a', type: 'text', content: 'x' }), null);
    assert.equal(producedBlockRefusal({ id: 'a', type: 'todo', content: 'x', checked: true, schemaVersion: 1 }), null);
  });

  it('may not write one decode reads as unknown, newer or invalid, and says what decode found', () => {
    assert.equal(producedBlockRefusal({ id: 'a', type: 'nope' }), 'block-unknown-type');
    assert.equal(producedBlockRefusal({ id: 'a', type: 'text', schemaVersion: 99 }), 'block-newer-version');
    assert.equal(producedBlockRefusal(null), 'block-not-a-record');
    assert.equal(producedBlockRefusal({ id: 'a', type: '' }), 'block-invalid-type');
    assert.equal(producedBlockRefusal({ id: 'a', type: 'text', schemaVersion: -1 }), 'block-invalid-version');
    assert.equal(producedBlockRefusal({ id: 'a', type: 'text', content: { x: 1 } }), 'block-invalid-field');
  });

  it("names only codes the journal's block.refused event takes", () => {
    const states = [
      decodeBlock({ id: 'a', type: 'nope' }),
      decodeBlock({ id: 'a', type: 'text', schemaVersion: 99 }),
      ...['not-a-record', 'invalid-type', 'invalid-version', 'upcast-failed', 'invalid-field'].map(reason => ({ state: 'invalid', reason })),
    ];
    for (const decoded of states) {
      const code = refusalOf(/** @type {any} */ (decoded));
      assert.ok(code !== null && ERROR_CODES.includes(code), String(code));
    }
    assert.deepEqual(EVENT_CODES['block.refused'].fields, ['surface', 'errorCode']);
    assert.equal(EVENT_CODES['block.refused'].incident, undefined);
  });

  it("is what the new tab's BlockProjections refuses, through the catalog's decode", () => {
    const readers = pageReaders(builtInCatalog());
    assert.equal(readers.decodeBlock, builtInCatalog().decode);
    for (const record of [{ id: 'a', type: 'text' }, { id: 'a', type: 'nope' }, 7]) {
      assert.equal(readers.producedBlockRefusal(record), producedBlockRefusal(record));
    }
  });
});
