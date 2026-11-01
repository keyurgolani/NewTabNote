/**
 * Loaded first into every `npm test` and `npm run test:kernel` process (`--import`). The
 * comparisons of `node:assert` and `node:assert/strict` refuse an argument that is, or directly
 * holds, a DOM node, a document or a window, with a TypeError, before they build a diff. A failing
 * comparison's diff follows a node's document and parent links, so for an element it prints whole
 * documents, which once took a test process to 5 to 7 GB (#28). Compare elements by identity
 * instead, as in `assert.ok(actual === expected, message)`.
 */

import assert from 'node:assert';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';

const COMPARISONS = ['equal', 'notEqual', 'strictEqual', 'notStrictEqual', 'deepEqual', 'notDeepEqual', 'deepStrictEqual', 'notDeepStrictEqual'];
const GUARDED = Symbol.for('newtabnote.element-assert-guard');
const SIDES = ['actual', 'expected'];
// This file's frame in a stack, which a comparison's own failure shouldn't show
const OWN_FRAME = new RegExp(`\\n\\s*at [^\\n]*(?:${[import.meta.url, fileURLToPath(import.meta.url)].map((place) => place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}):\\d+:\\d+\\)?`, 'g');

/**
 * Whether a value is a DOM node, a document or a window: the browser's, legacy-env.js's, or
 * another fake in test/ that links its elements to each other
 * @param {unknown} value
 * @returns {boolean}
 */
function isDom(value) {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return 'ownerDocument' in value
      || ('nodeType' in value && 'nodeName' in value)
      || ('tagName' in value && 'parentNode' in value)
      || 'documentElement' in value
      || ('window' in value && /** @type {{window: unknown}} */ (value).window === value);
  } catch {
    // A proxy that refuses to be asked is no node
    return false;
  }
}

/**
 * Whether a value is a DOM node, document or window, or holds one as an item, a key or entry, or a
 * field's value. Only the first level: what the value directly holds. Getters aren't run.
 * @param {unknown} value
 * @returns {boolean}
 */
function domIn(value) {
  if (typeof value !== 'object' || value === null) return false;
  if (isDom(value)) return true;
  try {
    if (ArrayBuffer.isView(value) || types.isAnyArrayBuffer(value)) return false;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) if (isDom(value[index])) return true;
      return false;
    }
    if (types.isMap(value)) {
      for (const [key, item] of /** @type {Map<unknown, unknown>} */ (value)) if (isDom(key) || isDom(item)) return true;
      return false;
    }
    if (types.isSet(value)) {
      for (const item of /** @type {Set<unknown>} */ (value)) if (isDom(item)) return true;
      return false;
    }
    for (const key of Object.keys(value)) {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (field && 'value' in field && isDom(field.value)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Replaces `target[name]` with the same comparison behind the refusal
 * @param {Record<string, any>} target
 * @param {string} name
 */
function guard(target, name) {
  const compare = target[name];
  if (typeof compare !== 'function' || compare[GUARDED]) return;
  const guarded = {
    /** @param {unknown[]} args */
    [name](...args) {
      for (let index = 0; index < 2 && index < args.length; index += 1) {
        if (!domIn(args[index])) continue;
        const refusal = new TypeError(`assert.${name} got a DOM node, document or window as ${SIDES[index]}: compare elements by identity, as in assert.ok(actual === expected, message)`);
        Error.captureStackTrace(refusal, guarded);
        throw refusal;
      }
      try {
        return Reflect.apply(compare, this, args);
      } catch (error) {
        // The comparison cut its own frames from the stack; this takes the guard's too, so its
        // failure reads as it did without the guard
        if (error instanceof Error && typeof error.stack === 'string') error.stack = error.stack.replace(OWN_FRAME, '');
        throw error;
      }
    },
  }[name];
  Object.defineProperty(guarded, 'name', { value: compare.name });
  Object.defineProperty(guarded, 'length', { value: compare.length });
  Object.defineProperty(guarded, GUARDED, { value: true });
  target[name] = guarded;
}

// `node:assert/strict` is `assert.strict`, whose `equal` is `strictEqual`, so both get each name
for (const target of [assert, assert.strict]) for (const name of COMPARISONS) guard(target, name);
// So that named imports, as in `import { strictEqual } from 'node:assert'`, get the guarded ones too
syncBuiltinESMExports();
