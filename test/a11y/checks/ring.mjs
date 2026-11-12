/**
 * The focus ring against each plane beside it (#24, "Focus and layers"), at #16's 3:1 for focus
 * (design/quiet-atlas.tokens.json). A translucent ring composites onto its plane, and a translucent
 * plane onto what's under it, before anything is measured. A two-tone ring is measured as #16
 * measures its pairs, through js/design/contrast.js's measure(): the outer ring's contrast, or the
 * inner ring's against both the outer and the plane, whichever is better. #16's inner ring fills the
 * offset between the control and the outline, so it's painted on the plane beside the outer ring,
 * never over it, and a translucent inner ring composites onto the plane. A plane on a translucent
 * backdrop can't be measured, so it's a TypeError that names the plane. A color is #16's theme
 * grammar, or color(srgb …), the form Chrome computes a color-mix() in sRGB to; a color in another
 * space is a TypeError that names the space.
 */

import { measure, parseColor } from '../../../js/design/contrast.js';

/** The least contrast a focus ring may have against a plane beside it */
export const RING_MIN = 3;

/** What a plane is drawn over when nothing else is said: the page's white */
const WHITE = '#ffffff';

/** color(srgb r g b), with `/ a` when it isn't opaque, each a number or a percentage */
const SRGB = /^color\(\s*srgb\s+([^\s/]+)\s+([^\s/]+)\s+([^\s/)]+)\s*(?:\/\s*([^\s/)]+)\s*)?\)$/i;

/** A color in a space other than sRGB, which the check doesn't measure */
const OTHER_SPACE = /^(?:color\(\s*([\w-]+)|(lab|lch|oklab|oklch)\()/i;

/**
 * @param {string} text
 * @returns {{r: number, g: number, b: number, a: number}}
 */
function color(text) {
  const srgb = SRGB.exec(text.trim());
  if (srgb) {
    const [r, g, b, a] = srgb
      .slice(1)
      .map((part, i) => (part === undefined ? 1 : part.endsWith('%') ? Number(part.slice(0, -1)) / 100 : Number(part)) * (i < 3 ? 255 : 1));
    if ([r, g, b, a].every(Number.isFinite)) return { r, g, b, a };
  }
  const space = srgb ? null : OTHER_SPACE.exec(text.trim());
  if (space) throw new TypeError(`${JSON.stringify(text)} is in ${space[1] ?? space[2]}, not sRGB, which the check measures`);
  const parsed = parseColor(text);
  if (!parsed) throw new TypeError(`not a color: ${JSON.stringify(text)}`);
  return parsed;
}

/**
 * The planes the ring falls short on, each with its ratio
 * @param {{outer: string, inner?: string}} ring - CSS colors
 * @param {readonly {id: string, color: string, over?: string}[]} planes - each plane's color, and what's under it
 * @param {number} [min]
 * @returns {{plane: string, ratio: number}[]}
 */
export function ringShortfalls(ring, planes, min = RING_MIN) {
  return planes
    .map(plane => {
      const colors = {
        fg: color(ring.outer),
        bg: color(plane.color),
        over: color(plane.over ?? WHITE),
        inner: ring.inner === undefined ? null : color(ring.inner),
      };
      if (colors.bg.a < 1 && colors.over.a < 1) {
        throw new TypeError(`plane ${plane.id}: what's under it, ${JSON.stringify(plane.over)}, isn't opaque`);
      }
      return { plane: plane.id, ratio: measure(colors, 1).ratio };
    })
    .filter(({ ratio }) => ratio < min);
}
