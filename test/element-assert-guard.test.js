'use strict';

// The element-assert guard, test/helpers/element-assert-guard.mjs (#28). `npm test` and
// `test:kernel` load it first. node:assert's comparisons then refuse a DOM node, a document or a
// window, or a value that directly holds one, because a failing one's diff prints whole documents.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLegacyEnv } = require('./helpers/legacy-env');

const ROOT = path.join(__dirname, '..');
const COMPARISONS = ['equal', 'notEqual', 'strictEqual', 'notStrictEqual', 'deepEqual', 'notDeepEqual', 'deepStrictEqual', 'notDeepStrictEqual'];

/** What a refused comparison throws, naming the side that held the node */
const refused = (side = 'actual') => ({
  name: 'TypeError',
  message: new RegExp(`^assert\\.\\w+ got a DOM node, document or window as ${side}: compare elements by identity`),
});

/** Two elements of one page, the second on it */
function page() {
  const env = createLegacyEnv();
  const element = env.document.createElement('div');
  const other = env.document.body.appendChild(env.document.createElement('div'));
  return { env, element, other };
}

describe('the element-assert guard (#28)', () => {
  before(async () => {
    // npm test has loaded it already, so this changes nothing there; it lets the file run alone
    await import('./helpers/element-assert-guard.mjs');
  });

  it('is loaded first by npm test and test:kernel', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    for (const name of ['test', 'test:kernel']) {
      assert.ok(scripts[name].startsWith('node --import=./test/helpers/element-assert-guard.mjs '), `${name} loads the guard first`);
    }
  });

  it("refuses an element in every comparison of node:assert and node:assert/strict, as either side, before it compares", () => {
    const { element, other } = page();
    for (const [module, target] of [['node:assert', require('node:assert')], ['node:assert/strict', require('node:assert/strict')]]) {
      for (const name of COMPARISONS) {
        assert.throws(() => target[name](element, other), refused('actual'), `${module} ${name}`);
        assert.throws(() => target[name](null, other), refused('expected'), `${module} ${name}`);
        // A comparison that would pass is refused too, so an element can't be compared at all
        assert.throws(() => target[name](element, element), refused('actual'), `${module} ${name}`);
      }
    }
  });

  it('refuses a document and a window', () => {
    const { env } = page();
    assert.throws(() => assert.deepEqual(env.document, env.document), refused());
    assert.throws(() => assert.equal(env.get('window'), null), refused());
    // The page's global, which holds its document
    assert.throws(() => assert.notEqual(env.global, null), refused());
  });

  it('refuses an element an array, a list, a map, a set or an object holds directly', () => {
    const { element, other } = page();
    assert.throws(() => assert.deepEqual([element], [other]), refused());
    assert.throws(() => assert.deepEqual([1, 'two'], [1, element]), refused('expected'));
    assert.throws(() => assert.deepEqual(other.parentNode.children, []), refused());
    assert.throws(() => assert.deepEqual(new Map([['focus', element]]), new Map()), refused());
    assert.throws(() => assert.deepEqual(new Map([[element, 'focus']]), new Map()), refused());
    assert.throws(() => assert.deepEqual(new Set([element]), new Set()), refused());
    assert.throws(() => assert.deepEqual({ focus: element }, { focus: null }), refused());
  });

  it('is what named imports get too', async () => {
    const { element } = page();
    const loose = await import('node:assert');
    const strict = await import('node:assert/strict');
    assert.throws(() => loose.strictEqual(element, null), refused());
    assert.throws(() => loose.deepStrictEqual([element], []), refused());
    assert.throws(() => strict.equal(element, null), refused());
    assert.throws(() => strict.default.notDeepEqual({ element }, {}), refused());
  });

  it('leaves every other comparison as it was', () => {
    const { element } = page();
    assert.equal(1, 1);
    assert.notEqual('a', 'b');
    assert.deepEqual({ notes: [{ id: 'A', tags: ['x'] }] }, { notes: [{ id: 'A', tags: ['x'] }] });
    assert.notDeepEqual(new Map([['a', 1]]), new Map([['a', 2]]));
    assert.deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]));
    // Records that name an element's fields aren't elements
    assert.deepEqual({ tagName: 'DIV' }, { tagName: 'DIV' });
    assert.deepEqual({ nodeType: 1, parentId: null }, { nodeType: 1, parentId: null });
    // An element compared by identity, as the guard asks
    assert.ok(element === element, 'the same element');
    // A failing comparison still says what differs, and its stack starts at the test's line
    assert.throws(() => assert.deepEqual({ count: 1 }, { count: 2 }, 'the counts'), (error) => {
      assert.equal(error.name, 'AssertionError');
      assert.match(error.message, /^the counts\n\+ actual - expected/);
      assert.match(error.stack.split('\n').find((line) => line.trim().startsWith('at ')), /element-assert-guard\.test\.js:\d+:\d+/);
      assert.doesNotMatch(error.stack, /helpers\/element-assert-guard\.mjs/);
      return true;
    });
  });

  it('runs none of a value\'s code: no getter, and no trap of a proxy that throws', () => {
    let reads = 0;
    const counted = { get element() { reads += 1; return null; } };
    assert.equal(counted, counted);
    assert.equal(reads, 0, 'the getter never ran');
    const sealed = new Proxy({}, { has() { throw new Error('asked'); } });
    assert.equal(sealed, sealed);
  });
});
