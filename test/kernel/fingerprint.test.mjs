// fingerprint.js's digest (#13, "Idempotency and catch-up"), which #17's ledger rows and the
// in-memory adapter's records hold: the SHA-256 of a command's canonical JSON. #17 PR 4a's perf
// commit rewrote its UTF-8 and its hash to allocate less at the new tab's first save, and each
// digest is still the one the file gave before (fingerprint-frozen.mjs) and node:crypto's: on
// SHA-256's own vectors, on each kind of character, lone surrogates among them, at each length
// around a block's padding, and on 3,001 canonical JSONs of mixed text.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { digestOf, textDigest } from '../../js/kernel/core/memory/fingerprint.js';
import { digestOf as frozenDigestOf, textDigest as frozenTextDigest } from './fingerprint-frozen.mjs';

/**
 * node:crypto's SHA-256, in hex, of `text` as UTF-8, which writes a lone surrogate as U+FFFD
 * @param {string} text
 */
const nodeDigest = text => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * `value` with every object's keys sorted, as its canonical JSON has them
 * @param {unknown} value
 * @returns {unknown}
 */
const sorted = value => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  const record = /** @type {Record<string, unknown>} */ (value);
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map(key => [key, sorted(record[key])]),
  );
};

/**
 * Asserts the file and the file before hash `text` alike: to `expected`, a published vector's
 * digest, which node:crypto gives too, or else to node:crypto's
 * @param {string} text
 * @param {string} [expected]
 */
const sameHash = (text, expected) => {
  const want = expected ?? nodeDigest(text);
  const shown =
    text.length > 40 ? `${JSON.stringify(text.slice(0, 40))}... (${text.length} units)` : JSON.stringify(text);
  assert.equal(textDigest(text), want, `the file, on ${shown}`);
  assert.equal(frozenTextDigest(text), want, `the file before, on ${shown}`);
  if (expected) assert.equal(nodeDigest(text), expected, `node:crypto, on ${shown}`);
};

/**
 * `count` commands whose strings mix ASCII, two- and three-byte characters, astral ones and lone
 * surrogates, from a fixed seed, so each run hashes the same ones
 * @param {number} count
 */
function mixedCommands(count) {
  let seed = 17;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pieces = [
    'a',
    'Z',
    ' ',
    '"',
    '\\',
    '\n',
    'é',
    'ß',
    'Ω',
    '€',
    '中',
    '\u{1F680}',
    '\u{1F4A1}',
    '\ud800',
    '\udfff',
    '\u0000',
    '<b>',
  ];
  const text = () =>
    Array.from({ length: Math.floor(next() * 200) }, () => pieces[Math.floor(next() * pieces.length)]).join('');
  return Array.from({ length: count }, (_, i) => ({
    type: 'saveNoteContent',
    noteId: `n-${i}`,
    blocks: [{ content: text(), order: i, nested: { z: text(), a: [text(), next()] } }],
  }));
}

describe("fingerprint.js's digest, rewritten to allocate less (#17 PR 4a), is each digest it was", () => {
  it("hashes SHA-256's own test vectors (FIPS 180-2) as published", () => {
    for (const [text, expected] of [
      ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      // 448 bits, which padding takes a second block for
      [
        'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
      ],
      // 896 bits
      [
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
        'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
      ],
      ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
    ]) {
      sameHash(text, expected);
    }
  });

  it('encodes each kind of character as before: one to four bytes, astral pairs, and a lone surrogate as U+FFFD', () => {
    for (const text of [
      // Each length of encoding's first and last code point
      '\u0000',
      '\u007f',
      '\u0080',
      '\u07ff',
      '\u0800',
      '\ud7ff',
      '\ue000',
      '\uffff',
      '\u{10000}',
      '\u{10ffff}',
      'é',
      'ß',
      '€',
      '中',
      '😀',
      '🚀💡',
      'a😀b',
      `${'😀'.repeat(30)}é`,
      // Lone surrogates: high and low, alone, at either end, doubled, a pair reversed, and a
      // pair cut short at the end
      '\ud800',
      '\udbff',
      '\udc00',
      '\udfff',
      'a\ud800',
      '\ud800a',
      'a\udc00b',
      '\ud800\ud800',
      '\udc00\ud800',
      'x\ud83d',
      '\ude00x',
      '😀\ud83d',
    ]) {
      sameHash(text);
      // And as digestOf has them, inside a command's canonical JSON, which escapes a lone one
      const value = { text, list: [text, { [text]: text }] };
      assert.equal(digestOf(value), frozenDigestOf(value), JSON.stringify(text));
      assert.equal(digestOf(value), nodeDigest(JSON.stringify(sorted(value))), JSON.stringify(text));
    }
  });

  it("pads each length around a block's 55, 56 and 64 bytes as before, in one-, two- and three-byte characters", () => {
    for (let length = 0; length <= 200; length += 1) {
      sameHash('y'.repeat(length));
      sameHash('é'.repeat(length));
      sameHash('中'.repeat(length));
    }
  });

  it('gives 3,001 canonical JSONs of mixed text the digests they had', () => {
    for (const command of mixedCommands(3001)) {
      const expected = nodeDigest(JSON.stringify(sorted(command)));
      assert.equal(digestOf(command), expected, command.noteId);
      assert.equal(frozenDigestOf(command), expected, command.noteId);
    }
  });
});
