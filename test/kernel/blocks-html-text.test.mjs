// #14 slice 1 ("Projections": a tokenizer, never DOMParser or innerHTML): html-text.js gives the
// text a div holds after `div.innerHTML = html`, on every rule it lists and every character
// reference case, and reads in linear time. e2e/block-projections.spec.js runs the same
// fixtures through Chromium, so what these expect is what the browser gives, except where a
// case declares a difference and records Chromium's reading beside the tokenizer's.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { LONGEST_REFERENCE, namedReferences } from '../../js/kernel/core/blocks/entities.js';
import { textContent } from '../../js/kernel/core/blocks/html-text.js';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'blocks');

/** @param {string} name */
const fixture = name => /** @type {unknown} */ (JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')));

/** @typedef {{rule: string, html: string, text: string, scripting?: boolean, chromium?: string, declared?: string}} Case */
const { cases: RULES } = /** @type {{cases: Case[]}} */ (fixture('html-text-cases.json'));
const REFERENCES = /** @type {[string, string][]} */ (fixture('character-references.json'));

/**
 * How long one read of `html` takes, the fastest of three
 * @param {string} html
 */
const timeOf = html => {
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k < 3; k++) {
    const start = performance.now();
    textContent(html);
    best = Math.min(best, performance.now() - start);
  }
  return best;
};

/**
 * Whether reading grows linearly: four times the input takes well under the sixteen times a
 * quadratic read would, with room for timer noise on small inputs. A busy machine can stall a
 * measurement, so it measures up to three times; a quadratic read grows too fast every time.
 * @param {(n: number) => string} make
 */
const readsLinearly = make => {
  const small = make(20_000);
  const large = make(80_000);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (timeOf(large) < Math.max(timeOf(small) * 8, 50)) return true;
  }
  return false;
};

describe("html-text.js reads markup's text as a div's textContent does (#14 slice 1)", () => {
  for (const { rule, html, text, scripting = true } of RULES) {
    it(rule, () => {
      assert.equal(textContent(html, { scripting }), text);
    });
  }

  it("declares each difference from Chromium it has, beside Chromium's reading", () => {
    const declared = RULES.filter(({ chromium }) => chromium !== undefined);
    assert.deepEqual(
      declared.map(({ declared: reason, chromium, text }) => [typeof reason === 'string' && reason.length > 0, chromium !== text]),
      declared.map(() => [true, true]),
    );
    // Foster parenting, a hex reference with no digits, a `<` before a NUL, an end tag inside a
    // select (for an svg and a math), and a foreignObject end tag for an HTML element
    assert.equal(declared.length, 6);
  });

  it('reads with scripting on unless told otherwise, as a div of the page does', () => {
    const html = '<noscript><b>n</b></noscript>';
    assert.equal(textContent(html), textContent(html, { scripting: true }));
    assert.notEqual(textContent(html), textContent(html, { scripting: false }));
  });

  it('decodes every character reference case as the tokenizer does', () => {
    const wrong = REFERENCES.filter(([html, text]) => textContent(html) !== text);
    assert.deepEqual(wrong, []);
  });

  it("reads a value that isn't a string as its String(), as the innerHTML setter does", () => {
    assert.equal(textContent(/** @type {any} */ (5)), '5');
    assert.equal(textContent(/** @type {any} */ (['<b>a</b>', 'b'])), 'a,b');
  });

  it('is deterministic: the same markup always gives the same text', () => {
    for (const { html, scripting } of RULES) assert.equal(textContent(html, { scripting }), textContent(html, { scripting }));
  });
});

describe('html-text.js reads in linear time (#14 slice 1)', () => {
  it('a long run of comments reads in linear time', () => {
    assert.ok(readsLinearly(n => '<!--x'.repeat(n / 5)));
    assert.ok(readsLinearly(n => '<!--x--!>'.repeat(n / 9)));
    assert.ok(readsLinearly(n => '<!---->'.repeat(n / 7)));
  });

  it('deep foreign content with many end tags reads in linear time', () => {
    assert.ok(readsLinearly(n => `<svg>${'<g>'.repeat(n / 7)}${'</x>'.repeat(n / 7)}`));
    assert.ok(readsLinearly(n => `<div><svg>${'<g>'.repeat(n / 7)}${'</div>'.repeat(n / 7)}`));
  });

  it('deep HTML with many end tags reads in linear time', () => {
    assert.ok(readsLinearly(n => `${'<div>'.repeat(n / 11)}<table>${'</div>'.repeat(n / 11)}`));
    assert.ok(readsLinearly(n => `${'<span>'.repeat(n / 10)}${'</b>'.repeat(n / 10)}`));
    assert.ok(readsLinearly(n => '<li><b>'.repeat(n / 7)));
  });
});

describe("the named character references (the HTML Standard's table, CC BY 4.0)", () => {
  const names = namedReferences();

  it("has all 2231 of the standard's names, 106 of them legacy ones that also match without `;`", () => {
    assert.equal(names.size, 2231);
    const legacy = [...names.keys()].filter(name => !name.endsWith(';'));
    assert.equal(legacy.length, 106);
    for (const name of legacy) assert.equal(names.get(name), names.get(`${name};`), `${name} decodes as ${name};`);
  });

  it('knows its longest name', () => {
    assert.equal(Math.max(...[...names.keys()].map(name => name.length)), LONGEST_REFERENCE);
  });

  it('unpacks once', () => {
    assert.equal(namedReferences(), names);
  });
});
