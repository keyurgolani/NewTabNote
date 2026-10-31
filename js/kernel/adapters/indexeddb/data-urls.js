/**
 * Blobs as data URLs, the way 1.4.x's files and copies hold them, so a file is plain JSON:
 * the pre-update copy's export (legacy-export.js) and #20's salvage file (salvage-reader.js)
 * write each Blob a store holds this way. #17 PR 1b took #33's missing-stores copy, which kept
 * these, back to js/storage.js, so they live here.
 */

/** How deep a value is searched for a Blob, as Storage searches it */
const MAX_DEPTH = 32;

/**
 * Whether `value` holds a Blob anywhere within MAX_DEPTH levels
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {boolean}
 */
export function hasBlob(value, depth = 0) {
  if (value instanceof Blob) return true;
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH || ArrayBuffer.isView(value)) return false;
  const items = Array.isArray(value) ? value : Object.values(value);
  return items.some(item => hasBlob(item, depth + 1));
}

/**
 * A Blob as the data URL FileReader.readAsDataURL gives for it
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function dataUrlOf(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // In pieces, so a large image can't overflow the call stack
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

/**
 * A copy of a stored value with each Blob in it as a data URL
 * @param {unknown} value
 * @returns {Promise<unknown>}
 */
export async function withDataUrls(value) {
  if (value instanceof Blob) return dataUrlOf(value);
  if (!hasBlob(value, 0)) return value;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await withDataUrls(item));
    return out;
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    out[key] = await withDataUrls(item);
  }
  return out;
}
