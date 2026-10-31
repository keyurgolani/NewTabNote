/**
 * Blobs as data URLs and back, the way 1.4.x's files and copies hold them: its export file,
 * automatic backup, and recovery copies write each Blob as a data URL, so the file is plain
 * JSON, and its import turns a media row's data URL back into a Blob before it writes. The
 * pre-update copy (legacy-export.js), #20's salvage file (salvage-reader.js), and since #17 PR
 * 4a the new tab's backups (backups.js) and recovery copies (recovery-copies.js), go through
 * these.
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

/**
 * A data URL as a Blob, decoded without fetch, which the extension's CSP doesn't allow for
 * data: URLs, as Storage._dataUrlToBlob decodes a media row's. Throws for one without a comma.
 * @param {string} dataUrl
 * @returns {Blob}
 */
export function blobOf(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) throw new Error('malformed data URL in media');
  const meta = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  const isBase64 = /;base64$/i.test(meta);
  const type = meta.replace(/;base64$/i, '').split(';')[0] || '';
  if (!isBase64) return new Blob([decodeURIComponent(payload)], { type });
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}
