/**
 * What tells one command from another under the same commandId, for the in-memory adapter and
 * ledger: the SHA-256, in hex, of the command's canonical JSON, every object's keys sorted, so
 * two copies of one command compare alike. It's what #17 keeps too (#13, "Idempotency and
 * catch-up"): a digest, never the JSON, so no note content sits in an idempotency record.
 *
 * Core reads no host API (no crypto.subtle, which is async anyway, and no TextEncoder), so the
 * hash is computed here, from the JSON's UTF-8 bytes. test/kernel/idempotency-ledger.test.mjs
 * holds it to node:crypto's.
 *
 * #17's adapter digests every command it keeps a ledger row for, the new tab's first save
 * among them, so this allocates little (#17 PR 4a): the UTF-8 goes by index into one buffer,
 * and the hash keeps its words as int32, which V8 boxes as a heap number only outside
 * [-2^30, 2^30) where the code isn't optimized yet, where a uint32 is boxed from 2^30 up. On a
 * 6 KB save the first digest allocated 1.6 MiB that way and allocates 0.4 MiB this way.
 * test/kernel/fingerprint.test.mjs holds every digest to node:crypto's and to the one this file
 * gave before (fingerprint-frozen.mjs), which the ledger rows already written hold.
 */

/**
 * @param {string} a
 * @param {string} b
 */
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `value` with every object's keys in sorted order
 * @param {unknown} value
 * @returns {unknown}
 */
const sortedKeys = value => {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  const record = /** @type {Record<string, unknown>} */ (value);
  return Object.fromEntries(
    Object.keys(record)
      .sort(byKey)
      .map(key => [key, sortedKeys(record[key])]),
  );
};

/**
 * `text` as UTF-8 bytes, written by index into one buffer sized for the most a UTF-16 unit
 * takes: 3 bytes, since a surrogate pair's 4 span two units. A lone surrogate, which
 * JSON.stringify writes as an escape, never reaches here from digestOf, and one that did
 * encodes as U+FFFD, as TextEncoder does.
 * @param {string} text
 * @returns {Uint8Array}
 */
const utf8 = text => {
  const bytes = new Uint8Array(text.length * 3);
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    let point = text.charCodeAt(i);
    if (point >= 0xd800 && point <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        point = 0x10000 + ((point - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
    if (point < 0x80) {
      bytes[n++] = point;
    } else if (point < 0x800) {
      bytes[n++] = 0xc0 | (point >> 6);
      bytes[n++] = 0x80 | (point & 63);
    } else if (point < 0x10000) {
      bytes[n++] = 0xe0 | (point >> 12);
      bytes[n++] = 0x80 | ((point >> 6) & 63);
      bytes[n++] = 0x80 | (point & 63);
    } else {
      bytes[n++] = 0xf0 | (point >> 18);
      bytes[n++] = 0x80 | ((point >> 12) & 63);
      bytes[n++] = 0x80 | ((point >> 6) & 63);
      bytes[n++] = 0x80 | (point & 63);
    }
  }
  return bytes.subarray(0, n);
};

/** SHA-256's round constants, each as the int32 with its bits */
const K = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

/**
 * The SHA-256 of `bytes`, in lowercase hex. Each word is an int32: a sum wraps with `| 0`, bit
 * for bit as a uint32's would, and each rotation is its two shifts, written out.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const sha256 = bytes => {
  const length = bytes.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  // The bit length, as a 64-bit big-endian integer
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  const h = Int32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Int32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getInt32(block + t * 4);
    for (let t = 16; t < 64; t += 1) {
      const x = w[t - 15];
      const y = w[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let k = h[7];
    for (let t = 0; t < 64; t += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (k + s1 + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += k;
  }
  return Array.from(h, word => (word >>> 0).toString(16).padStart(8, '0')).join('');
};

/**
 * The SHA-256, in hex, of `text` as UTF-8: what digestOf takes of the canonical JSON
 * @param {string} text
 * @returns {string}
 */
export const textDigest = text => sha256(utf8(text));

/**
 * The SHA-256, in hex, of `value`'s canonical JSON
 * @param {unknown} value
 * @returns {string}
 */
export const digestOf = value => textDigest(JSON.stringify(sortedKeys(value)));

/**
 * A kept conflict, as both adapters keep one
 * @typedef {{noteId?: unknown, scope?: unknown, expected?: unknown, command?: unknown}} KeptConflictLike
 */

/**
 * Whether two kept conflicts hold one change: the same note, scope, and version expected, and
 * the same command but its commandId, as a stale change sent again under a new commandId is
 * (R131). A resend under the same commandId answers from the ledger, so it never gets this far.
 * @param {KeptConflictLike} a
 * @param {KeptConflictLike} b
 * @returns {boolean}
 */
export function sameConflict(a, b) {
  /** @param {KeptConflictLike} record */
  const key = ({ noteId, scope, expected, command }) => {
    const { commandId: _, ...rest } = /** @type {Record<string, unknown>} */ (command ?? {});
    return digestOf([noteId ?? null, scope ?? null, expected ?? null, rest]);
  };
  return key(a) === key(b);
}
