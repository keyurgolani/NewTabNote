/**
 * The focus ring against each plane beside it (#24, "Focus and layers"), at #16's 3:1 for focus
 * (design/quiet-atlas.tokens.json). A translucent ring composites onto its plane, and a translucent
 * plane onto what's under it, before anything is measured. A two-tone ring is measured as #16
 * measures its pairs, through js/design/contrast.js's measure(): the outer ring's contrast, or the
 * inner ring's against both the outer and the plane, whichever is better. #16's inner ring fills the
 * offset between the control and the outline, so it's painted on the plane beside the outer ring,
 * never over it, and a translucent inner ring composites onto the plane. A plane on a translucent
 * backdrop can't be measured, so it's a TypeError that names the plane.
 */

import { measure, parseColor } from '../../../js/design/contrast.js';

/** The least contrast a focus ring may have against a plane beside it */
export const RING_MIN = 3;

/** What a plane is drawn over when nothing else is said: the page's white */
const WHITE = '#ffffff';

/**
 * @param {string} text
 * @returns {{r: number, g: number, b: number, a: number}}
 */
function color(text) {
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
