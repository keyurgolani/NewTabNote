/**
 * The note names a text's `[[wiki links]]` hold, as 1.4.x read them with
 * `/\[\[([^\]]+)\]\]/g`, in one pass: from a `[[`, the name runs to the first `]`, which another
 * `]` must follow. The first `]` ahead only moves forward as the search does, so it's found
 * once, and the read takes time linear in the text. The editor's save reads it through
 * `BlockProjections`, and the note domain's AI insert through js/kernel/core/domain/note.js.
 */

/**
 * The names, trimmed, each once, in the order they first appear. Its input is a string, or
 * anything falsy, which reads as none; anything else throws, as 1.4.x's `matchAll` did.
 * @param {string} text
 * @returns {string[]}
 */
export function wikiLinkNames(text) {
  if (!text) return [];
  // 1.4.x called the value's own matchAll: a String object has one, and nothing else does
  if (typeof text !== 'string') /** @type {any} */ (text).matchAll(/(?:)/g);
  const source = String(text);
  /** @type {Set<string>} */
  const names = new Set();
  let close = -1;
  for (let at = source.indexOf('[['); at !== -1; at = source.indexOf('[[', at + 1)) {
    if (close < at + 2) close = source.indexOf(']', at + 2);
    // No `]` after this one means none after any later one either
    if (close === -1) break;
    if (close === at + 2 || source[close + 1] !== ']') continue;
    names.add(source.slice(at + 2, close).trim());
    at = close + 1;
  }
  return [...names];
}
