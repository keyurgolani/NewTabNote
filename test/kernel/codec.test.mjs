// #13's one JSON codec (contracts/codec.js), which every transport, the in-process one
// included, encodes and decodes messages with.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { CodecError, canonicalJson, decode, encode, encodedBytes } from '../../js/kernel/core/contracts/codec.js';
import { MAX_DEPTH } from '../../js/kernel/core/contracts/limits.js';

/**
 * `levels` arrays, each inside the last
 * @param {number} levels
 * @returns {unknown}
 */
function nested(levels) {
  /** @type {unknown} */
  let value = 1;
  for (let level = 0; level < levels; level++) value = [value];
  return value;
}

/**
 * @param {() => unknown} run
 * @param {string} problem
 * @param {string} [path]
 */
function assertRefused(run, problem, path) {
  assert.throws(run, error => {
    assert.ok(error instanceof CodecError, String(error));
    assert.equal(error.code, 'invalid-payload');
    assert.equal(error.problem, problem);
    if (path !== undefined) assert.equal(error.path, path);
    return true;
  });
}

describe('codec', () => {
  it('round-trips what JSON carries, nested, and turns -0 into 0', () => {
    const value = {
      text: 'Plan é € 😀',
      count: 3,
      ratio: -0.25,
      flags: [true, false, null],
      nested: { deep: { list: [{ at: 1_700_000_000_000 }, []] } },
      empty: {},
    };
    assert.deepEqual(decode(encode(value)), value);
    assert.equal(encode({ zero: -0 }), '{"zero":0}');
    assert.equal(Object.is(/** @type {{zero: number}} */ (decode(encode({ zero: -0 }))).zero, 0), true);
  });

  it('encodes objects with no prototype', () => {
    const bare = Object.assign(Object.create(null), { a: 1, list: [Object.assign(Object.create(null), { b: 2 })] });
    assert.equal(encode(bare), '{"a":1,"list":[{"b":2}]}');
  });

  it('refuses an object or array that inherits from anything else, which would change what JSON writes', () => {
    /** @param {object} fields */
    const inheriting = fields => Object.create(Object.assign(Object.create(null), fields));
    // A toJSON it inherits replaces it: a Date would go as {}, and undefined would drop the field
    assertRefused(() => encode({ at: inheriting({ toJSON: () => new Date(0) }) }), "an object that isn't plain", '/at');
    assertRefused(() => encode({ at: inheriting({ toJSON: () => undefined }) }), "an object that isn't plain", '/at');
    // A field it inherits reads as its own, but JSON leaves it out
    assertRefused(() => encode(inheriting({ title: 'Plan' })), "an object that isn't plain", '');
    const listed = Object.setPrototypeOf([1], { toJSON: () => 'x' });
    assertRefused(() => encode(listed), "an array that isn't plain", '');
    class List extends Array {}
    assertRefused(() => encode({ ids: List.from(['n1']) }), "an array that isn't plain", '/ids');
    // Another realm's prototypes can't be told from an object like these, so its objects and
    // arrays are refused, and a sender in another realm encodes there
    assertRefused(() => encode(vm.runInNewContext('({ ok: true })')), "an object that isn't plain", '');
    assertRefused(() => encode({ list: vm.runInNewContext('[1, 2]') }), "an array that isn't plain", '/list');
  });

  it('leaves out an object field whose value is undefined, as JSON does, so it arrives absent', () => {
    // 1.4.x captures a page with no URL or title as a bookmark with both fields undefined
    const block = { id: 'b1', type: 'bookmark', content: '', url: undefined, title: undefined, canvasId: 'd1' };
    assert.equal(encode(block), '{"id":"b1","type":"bookmark","content":"","canvasId":"d1"}');
    const back = /** @type {Record<string, unknown>} */ (decode(encode({ blocks: [block], at: undefined })));
    assert.deepEqual(back, { blocks: [{ id: 'b1', type: 'bookmark', content: '', canvasId: 'd1' }] });
    const [item] = /** @type {Array<Record<string, unknown>>} */ (back.blocks);
    assert.equal(Object.hasOwn(item, 'url') || Object.hasOwn(item, 'title') || Object.hasOwn(back, 'at'), false);
    assert.equal(encode({ only: undefined }), '{}');
  });

  it('refuses undefined as the whole message or an array item, where JSON would send nothing or null', () => {
    assertRefused(() => encode(undefined), 'a value of type undefined', '');
    assertRefused(() => encode([1, undefined]), 'a value of type undefined', '/1');
    assertRefused(() => encode({ ids: [undefined] }), 'a value of type undefined', '/ids/0');
  });

  it('refuses every value JSON would change or drop', () => {
    assertRefused(() => encode({ run: () => 1 }), 'a value of type function', '/run');
    assertRefused(() => encode({ s: Symbol('s') }), 'a value of type symbol', '/s');
    assertRefused(() => encode({ big: 10n }), 'a value of type bigint', '/big');
    for (const number of [NaN, Infinity, -Infinity]) {
      assertRefused(() => encode({ n: number }), "a number JSON can't hold", '/n');
    }
    for (const value of [
      new Date(5),
      vm.runInNewContext('new Date(5)'),
      new Map(),
      new Set(),
      new ArrayBuffer(4),
      new Uint8Array(4),
      new Blob(['x']),
      Promise.resolve(),
      new (class Note {})(),
    ]) {
      assertRefused(() => encode({ at: value }), "an object that isn't plain", '/at');
    }
  });

  it('refuses cycles, symbol keys, getters, hidden properties, holes, and array extras', () => {
    const cycle = /** @type {Record<string, unknown>} */ ({ a: {} });
    /** @type {Record<string, unknown>} */ (cycle.a).back = cycle;
    assertRefused(() => encode(cycle), 'a cycle', '/a/back');
    assertRefused(() => encode({ [Symbol('k')]: 1 }), 'a symbol key', '');
    assertRefused(
      () =>
        encode(
          Object.defineProperty({}, 'name', {
            get: () => 'x',
            enumerable: true,
          }),
        ),
      'a getter or setter',
      '/name',
    );
    assertRefused(() => encode(Object.defineProperty({}, 'secret', { value: 1 })), 'a hidden property', '/secret');
    assertRefused(() => encode([1, , 3]), 'an array with a hole', '/1');
    assertRefused(() => encode(Object.assign([1], { extra: true })), 'an array with keys besides its items', '');
    // An array's items and keys are held to the same: a getter could give the check one value
    // and JSON another, and JSON writes a hidden item but drops a hidden or symbol key
    /** @param {PropertyDescriptor} descriptor */
    const second = descriptor => Object.defineProperty([1, 2], 1, descriptor);
    assertRefused(() => encode(second({ get: () => 2, enumerable: true })), 'a getter or setter', '/1');
    assertRefused(() => encode(second({ value: 2, enumerable: false })), 'a hidden property', '/1');
    assertRefused(() => encode(Object.assign([1], { [Symbol('k')]: 1 })), 'an array with keys besides its items', '');
    const hiddenKey = Object.defineProperty([1], 'extra', { value: true });
    assertRefused(() => encode(hiddenKey), 'an array with keys besides its items', '');
    // The same object twice isn't a cycle
    const shared = { x: 1 };
    assert.equal(encode({ a: shared, b: [shared] }), '{"a":{"x":1},"b":[{"x":1}]}');
  });

  it('escapes the keys in a path as a JSON Pointer does', () => {
    assertRefused(() => encode({ 'a/b': { 'c~d': 10n } }), 'a value of type bigint', '/a~1b/c~0d');
  });

  it('nests up to MAX_DEPTH objects and arrays, both ways, and no deeper', () => {
    assert.equal(MAX_DEPTH, 64);
    assert.deepEqual(decode(encode(nested(MAX_DEPTH))), nested(MAX_DEPTH));
    assertRefused(() => encode(nested(MAX_DEPTH + 1)), 'nesting too deep');
    assertRefused(() => decode(JSON.stringify(nested(MAX_DEPTH + 1))), 'nesting too deep');
    // A message far deeper than the call stack allows fails as too deep, not as a stack overflow
    assertRefused(() => decode(`${'['.repeat(200_000)}${']'.repeat(200_000)}`), 'nesting too deep');
  });

  it("decodes only text that's JSON, and keeps a __proto__ key as data", () => {
    assertRefused(() => decode(/** @type {any} */ ({})), "a message that isn't text", '');
    assertRefused(() => decode('{"a":'), "text that isn't JSON", '');
    assertRefused(() => decode(''), "text that isn't JSON", '');
    const text = '{"__proto__":{"polluted":true}}';
    const value = /** @type {Record<string, unknown>} */ (decode(text));
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.equal(/** @type {Record<string, unknown>} */ ({}).polluted, undefined);
    assert.equal(encode(value), text);
  });

  it('measures text in UTF-8 bytes, a lone surrogate as the three bytes it becomes', () => {
    assert.equal(encodedBytes(''), 0);
    assert.equal(encodedBytes('abc'), 3);
    assert.equal(encodedBytes('é'), 2);
    assert.equal(encodedBytes('€'), 3);
    assert.equal(encodedBytes('😀'), 4);
    assert.equal(encodedBytes('\ud83d'), 3);
    assert.equal(encodedBytes('\ude00x'), 4);
    // The same count Node's encoder gives, for well-formed and lone surrogates alike
    let seed = 13;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 200; round++) {
      const units = Array.from({ length: 1 + Math.floor(random() * 40) }, () => Math.floor(random() * 0x10000));
      const text = String.fromCharCode(...units);
      assert.equal(encodedBytes(text), Buffer.byteLength(text, 'utf8'), `seed round ${round}`);
    }
  });

  it('writes canonical JSON with every key sorted, so two copies of a command read the same', () => {
    const one = { type: 'createNote', commandId: 'c1', blocks: [{ id: 'b', canvasId: 'n' }], noteId: 'n' };
    const two = { noteId: 'n', blocks: [{ canvasId: 'n', id: 'b' }], commandId: 'c1', type: 'createNote' };
    assert.equal(canonicalJson(one), canonicalJson(two));
    assert.equal(
      canonicalJson(two),
      '{"blocks":[{"canvasId":"n","id":"b"}],"commandId":"c1","noteId":"n","type":"createNote"}',
    );
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
    // An undefined field is left out, as encode() leaves it out
    assert.equal(canonicalJson({ title: undefined, id: 'n1' }), '{"id":"n1"}');
    assertRefused(() => canonicalJson([undefined]), 'a value of type undefined', '/0');
  });

  it('sorts keys as RFC 8785 does, by UTF-16 code units, integer-like keys included', () => {
    // JavaScript lists integer-like keys first, in numeric order, which RFC 8785 doesn't
    assert.equal(canonicalJson({ 10: 1, 2: 2, a: 3 }), '{"10":1,"2":2,"a":3}');
    assert.equal(canonicalJson({ list: [{ 1: 'x', '01': 'y', 0: 'z' }] }), '{"list":[{"0":"z","01":"y","1":"x"}]}');
    // The keys of RFC 8785's sorting sample (section 3.2.3): an emoji's surrogate pair sorts
    // by its first code unit, before U+FB33
    const sample = { '\u20ac': 1, '\r': 2, '\ufb33': 3, 1: 4, '\ud83d\ude00': 5, '\u0080': 6, '\u00f6': 7 };
    assert.equal(canonicalJson(sample), '{"\\r":2,"1":4,"\u0080":6,"\u00f6":7,"\u20ac":1,"\ud83d\ude00":5,"\ufb33":3}');
  });

  it('writes numbers and strings as RFC 8785 does, as ECMAScript writes them', () => {
    // RFC 8785's sample (section 3.2.2), from its JSON text
    const sample = decode(
      String.raw`{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/","literals":[null,true,false]}`,
    );
    assert.equal(
      canonicalJson(sample),
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    );
    for (const [number, text] of /** @type {const} */ ([
      [-0, '0'],
      [5e-324, '5e-324'],
      [-1.7976931348623157e308, '-1.7976931348623157e+308'],
      [9007199254740992, '9007199254740992'],
      [999999999999999900000, '999999999999999900000'],
      [1e21, '1e+21'],
      [0.000001, '0.000001'],
      [1e-7, '1e-7'],
    ])) {
      assert.equal(canonicalJson([number]), `[${text}]`, text);
    }
    // A lone surrogate, which RFC 8785's I-JSON input rules out, is escaped as JSON.stringify
    // escapes it, so text holding one still reads the same each time
    assert.equal(canonicalJson({ text: 'a\ud800' }), '{"text":"a\\ud800"}');
  });
});
