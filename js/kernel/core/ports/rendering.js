/**
 * The trusted-rendering port (#14, "Rendering boundary"). Block code puts rich text into the
 * DOM, and takes rich text in from outside, only through it, and writes plain text into rich
 * text only through its `escapePlainText`. Its one implementation today is the legacy adapter
 * (js/kernel/adapters/rendering/legacy.js), which renders 1.4.x's markup byte for byte; #21
 * slice 2 replaces it behind the same port, in js/kernel/composition/rendering.js, with the
 * schema's sanitizer.
 *
 * - `render(el, richText)`: show rich text in an element, replacing what it held
 * - `normalize(input)`: rich text from outside (an import, a drop, an AI insert) as a field
 *   holds it
 * - `escapePlainText(text)`: plain text as rich text that shows exactly that text
 * - `escapeAttributeText(text)`: the same, read as that text inside a quoted attribute too
 * - `isLinkHref(href)`: whether a link may point there (the inline schema's rule)
 *
 * The last three are the model layer's (js/kernel/core/blocks/rich-text.js), DOM-free, so the
 * worker runs the same rules without the port.
 */

/**
 * @typedef {object} RenderingPort
 * @property {(el: {innerHTML: string}, richText: string) => void} render
 * @property {(input: string) => string} normalize
 * @property {(text: unknown) => string} escapePlainText
 * @property {(text: unknown) => string} escapeAttributeText
 * @property {(href: unknown) => boolean} isLinkHref
 */

export {};
