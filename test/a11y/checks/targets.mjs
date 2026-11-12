/**
 * Hit boxes against #24's Targets (docs/accessibility/interaction-contract.md): every functional
 * pointer target is at least 44 by 44 CSS px, #16's `--target-min`, by its hit area. Three things are
 * exempt: the text-editing area as a whole, browser-owned UI, and a link in running text inside a
 * text block, as WCAG 2.5.5 and 2.5.8 exempt inline targets. A control inside a block isn't. The
 * browser check measures each target's box and says which exemption it has, if any.
 */

/** The smallest a target may be either way, in CSS px */
export const TARGET_MIN = 44;

/** The contract's exemptions */
export const EXEMPTIONS = Object.freeze(['editing-area', 'browser-ui', 'inline-link']);

/**
 * What a box may fall short by and still count as 44: floating-point error and nothing more. Layout
 * sizes boxes in 1/64 px steps and the matrix zooms by whole multiples, so a 44px box measures 44, give
 * or take float error, and the nearest box under it measures 43.984375, which fails.
 */
const FLOAT_ERROR = 1e-6;

/**
 * The targets that fall short: smaller than `min` either way, unless they carry one of the contract's
 * exemptions. An exemption the contract doesn't name exempts nothing.
 * @param {readonly {id: string, width: number, height: number, exempt?: string}[]} boxes
 * @param {number} [min]
 * @returns {{id: string, width: number, height: number}[]}
 */
export function smallTargets(boxes, min = TARGET_MIN) {
  return boxes
    .filter(box => !(box.exempt !== undefined && EXEMPTIONS.includes(box.exempt)))
    .filter(box => box.width < min - FLOAT_ERROR || box.height < min - FLOAT_ERROR)
    .map(({ id, width, height }) => ({ id, width, height }));
}
