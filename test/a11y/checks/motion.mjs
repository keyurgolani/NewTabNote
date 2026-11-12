/**
 * What #24 allows under `prefers-reduced-motion: reduce`: no transition or keyframed animation that
 * moves an element, as #16's motion rule drops translation and scaling, no smooth scroll, and no chart
 * animation. The browser check reads each element's computed style, its animations from
 * getAnimations() (each one's keyframed properties and its duration), and whether a chart animates,
 * and hands one element's reading here.
 */

/** The rules, by id */
export const REDUCED_MOTION_RULES = Object.freeze(['transform-transition', 'transform-animation', 'smooth-scroll', 'chart-animation']);

/** The properties that move an element: transform, and translate, rotate and scale, which move it as transform does */
const MOVES = Object.freeze(['transform', 'translate', 'rotate', 'scale']);

/**
 * A CSS time in milliseconds, or 0 when it isn't one
 * @param {string} text
 */
function milliseconds(text) {
  const match = /^(-?[\d.]+)(ms|s)$/.exec(text.trim());
  if (!match) return 0;
  return Number(match[1]) * (match[2] === 's' ? 1000 : 1);
}

/**
 * The rules one element breaks under reduced motion. Durations pair with transition properties by
 * place, and repeat when there are fewer of them, as CSS lists do.
 * @param {{transitionProperty?: string, transitionDuration?: string, scrollBehavior?: string,
 *   animations?: readonly {properties: readonly string[], duration: number}[], chartAnimation?: boolean}} style
 * @returns {string[]}
 */
export function motionProblems(style) {
  /** @type {string[]} */
  const broken = [];
  const properties = (style.transitionProperty ?? '').split(',').map(part => part.trim()).filter(Boolean);
  const durations = (style.transitionDuration ?? '0s').split(',').map(milliseconds);
  const moves = properties.some(
    (property, index) => [...MOVES, 'all'].includes(property) && durations[index % durations.length] > 0,
  );
  if (moves) broken.push('transform-transition');
  const animates = (style.animations ?? []).some(({ properties: keyframed, duration }) => duration > 0 && keyframed.some(property => MOVES.includes(property)));
  if (animates) broken.push('transform-animation');
  if (style.scrollBehavior === 'smooth') broken.push('smooth-scroll');
  if (style.chartAnimation === true) broken.push('chart-animation');
  return broken;
}
