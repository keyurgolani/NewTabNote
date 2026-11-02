/**
 * What a close-time draft's writer and its applier share (#33, the stack's close-time PR): the
 * format's version, and the digest a draft names a block by. The new tab's writer holds this at
 * its start, since it takes a note's digests at every load and every committed save, and writes
 * its drafts in `pagehide` (composition/close-draft-writer.js). The rules that apply a draft stay
 * apart, in close-draft.js, which re-exports these, and only a page with drafts loads it.
 *
 * Nothing here reads a store or a browser API.
 */

/** The format both 1.4.3 and the stack write */
export const CLOSE_DRAFT_VERSION = 1;

/** A block's times, which change on every edit, so content first leaves them out */
const TIMES = Object.freeze(['createdAt', 'updatedAt']);

/**
 * A block's fields but its times, as a stable string, as 1.4.3 compares them
 * @param {Record<string, unknown>} block
 * @returns {string}
 */
export function fingerprint(block) {
  const fields = Object.keys(block)
    .filter(key => !TIMES.includes(key))
    .sort();
  return JSON.stringify(fields.map(key => [key, block[key]]));
}

/**
 * A short digest of a block's fingerprint, 1.4.3's 53-bit cyrb53, so a draft names a block as
 * the page saw it without holding a second copy of the note's text or images
 * @param {Record<string, unknown>} block
 * @returns {string}
 */
export function digest(block) {
  const text = fingerprint(block);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The digest of `block` as note `noteId` stores it, which is what a stack draft's base and
 * issued saves hold, so the applier compares it with the stored copy's own
 * @param {Record<string, unknown>} block
 * @param {string} noteId
 * @returns {string}
 */
export const blockDigest = (block, noteId) => digest({ ...block, canvasId: noteId });
