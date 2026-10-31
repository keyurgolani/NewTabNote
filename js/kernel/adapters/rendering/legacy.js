/**
 * The trusted-rendering port's legacy adapter (#14 slice 2): what block code did with rich
 * text in 1.4.x, now in one place. It renders by assigning the markup as it is and normalizes
 * nothing, so every block shows what 1.4.x showed, byte for byte. #21 slice 2 replaces it with
 * the inline schema's sanitizer (js/kernel/composition/rendering.js picks the implementation).
 */

import { escapePlainText, isLinkHref } from '../../core/blocks/rich-text.js';

/** @typedef {import('../../core/ports/rendering.js').RenderingPort} RenderingPort */

/** @returns {RenderingPort} */
export function legacyRendering() {
  return Object.freeze({
    render(el, richText) {
      el.innerHTML = richText;
    },
    normalize: input => input,
    escapePlainText,
    isLinkHref,
  });
}
