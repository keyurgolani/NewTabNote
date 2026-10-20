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

  it("encodes another realm's plain objects and objects with no prototype", () => {
    const foreign = vm.runInNewContext('({ list: [1, 2], nested: { ok: true } })');
    assert.equal(encode(foreign), '{"list":[1,2],"nested":{"ok":true}}');
    const bare = Object.assign(Object.create(null), { a: 1 });
    assert.equal(encode(bare), '{"a":1}');
  });

  it('refuses undefined wherever it is, and every value JSON would change or drop', () => {
    assertRefused(() => encode(undefined), 'a value of type undefined', '');
    assertRefused(() => encode({ title: undefined }), 'a value of type undefined', '/title');
    assertRefused(() => encode([1, undefined]), 'a value of type undefined', '/1');
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
    // The same object twice isn't a cycle
    const shared = { x: 1 };
    assert.equal(encode({ a: shared, b: [shared] }), '{"a":{"x":1},"b":[{"x":1}]}');
  });

  it('escapes the keys in a path as a JSON Pointer does', () => {
    assertRefused(() => encode({ 'a/b': { 'c~d': undefined } }), 'a value of type undefined', '/a~1b/c~0d');
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
    assertRefused(() => canonicalJson({ title: undefined }), 'a value of type undefined', '/title');
  });
});
