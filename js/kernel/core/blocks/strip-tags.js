/**
 * The note list's way of reading markup without a DOM, as 1.4.x's `stripHtml` read it
 * (SidebarUtils and the kernel's note domain), which the block previews keep byte for byte
 * until slice 4 unifies the readers (#14 scope, answer 5). It's a module of its own so the
 * Popup and the Side Panel, which read only previews, load nothing else of the model layer.
 *
 * 1.4.x wrote it as a chain of regular expressions; here the one step that read in more than
 * linear time is a single pass (replaceTags), and the rest are the same expressions.
 * test/kernel/blocks-markup.test.mjs holds it to the chain.
 */

/**
 * `<[^>]*>` (or `<[^>]+>`, with `nonEmpty`) replaced by `by`: each `<` through the first `>`
 * after it, when there's one, in one pass
 * @param {string} text
 * @param {string} by
 * @param {boolean} nonEmpty
 */
export function replaceTags(text, by, nonEmpty) {
  let out = '';
  let from = 0;
  let lt = text.indexOf('<');
  while (lt !== -1) {
    const gt = text.indexOf('>', lt + 1);
    if (gt === -1) break;
    if (nonEmpty && gt === lt + 1) {
      // `<>` isn't a tag; the next `<` may start one
      lt = text.indexOf('<', lt + 1);
      continue;
    }
    out += text.slice(from, lt) + by;
    from = gt + 1;
    lt = text.indexOf('<', from);
  }
  return out + text.slice(from);
}

/**
 * Markup as the note list's preview reads it: line breaks and tags become spaces, `&nbsp;`
 * a space, runs of white space one, trimmed. Only `undefined` reads as empty: `null` is the
 * text "null", as `String(null)` has it.
 * @param {unknown} [value]
 * @returns {string}
 */
export function stripTags(value = '') {
  const text = String(value).replace(/<br\s*\/?>/gi, ' ');
  return replaceTags(text, ' ', false)
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
