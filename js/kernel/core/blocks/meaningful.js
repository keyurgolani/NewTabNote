/**
 * Whether a block holds something, for the empty-note check (#14 slice 3, the opaque rule's
 * `isMeaningful`): trash deletes an untitled note for good only when none of its blocks does,
 * and the export notice counts notes by the same rule (domain/note.js, isEmpty).
 *
 * It fails safe. A block holds nothing only when decode (catalog.js) would read it as a known
 * `text` block, at version 0 or this build's, every field its type's own or the envelope's and
 * of its kind, no image in its `imageUrl` (holdsImage), with content of only spaces, line
 * breaks and non-breaking spaces, which is 1.4.x's Storage.isEmptyTextBlock rule for content.
 * Every other block holds something: every other type, as before, and now a block in a safe
 * state (newer, of a type this build lacks, or one it can't read), a block holding a field its
 * type doesn't own, and one holding an image.
 *
 * Trash's command module runs on the Popup, the Side Panel and the worker too, so this reads
 * only fields.js, never the models, the tokenizer or its table of character references
 * (test/kernel/blocks-models.test.mjs). test/kernel/blocks-meaningful.test.mjs holds it to the
 * built-ins' catalog on the corpus, each model's examples and every storage fixture.
 */

import { ENVELOPE_FIELDS, SHARED_FIELDS, invalidField } from './fields.js';

/** The text model's version (builtins.js), which the test holds to the catalog's */
export const TEXT_VERSION = 1;

/**
 * Whether rich text holds nothing: only spaces, line breaks and non-breaking spaces, as
 * Storage.isEmptyTextBlock read content
 * @param {unknown} content
 * @returns {boolean}
 */
export function isBlankText(content) {
  return (
    String(content || '')
      .replace(/<br\s*\/?>|&nbsp;/gi, '')
      .trim() === ''
  );
}

/**
 * Whether a block's `imageUrl` holds an image: an address, or a data URL with something after
 * its comma. None, white space, and a data URL with no data hold none.
 * @param {unknown} value
 * @returns {boolean}
 */
export function holdsImage(value) {
  if (typeof value !== 'string') return false;
  const url = value.trim();
  return url !== '' && !/^data:[^,]*,$/i.test(url);
}

/**
 * Whether `record`, a stored block, holds anything
 * @param {unknown} record
 * @returns {boolean}
 */
export function isMeaningful(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return true;
  const block = /** @type {Record<string, unknown>} */ (record);
  // Every type but text holds something, and a block with no type, or one this build lacks, is kept
  if (block.type !== 'text') return true;
  const version = block.schemaVersion === undefined ? 0 : block.schemaVersion;
  // A version that isn't one, or a newer one, is a safe state
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0 || version > TEXT_VERSION) return true;
  // A field its type doesn't own, whatever it holds
  for (const name of Object.keys(block)) {
    if (!Object.hasOwn(SHARED_FIELDS, name) && !ENVELOPE_FIELDS.includes(name)) return true;
  }
  // A field that isn't its kind is a payload this build can't read
  if (invalidField(SHARED_FIELDS, block) !== null) return true;
  // An image is something, whatever its block's type (every type has an imageUrl)
  if (holdsImage(block.imageUrl)) return true;
  return !isBlankText(block.content);
}
