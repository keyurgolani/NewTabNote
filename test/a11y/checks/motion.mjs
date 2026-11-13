/**
 * What #24 allows under `prefers-reduced-motion: reduce`: no transition or keyframed animation that
 * moves an element, as #16's motion rule drops translation and scaling, no smooth scroll, and no chart
 * animation. The browser check reads each element's computed style, its animations from
 * getAnimations() (each one's keyframed properties and its duration), and whether a chart animates,
 * and hands one element's reading here. motionFindings() is that browser half: a chart animates when
 * its canvas is redrawn while a short wait passes.
 */

import { selectorOf } from './targets.mjs';

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

/**
 * In the page, under reduced motion: each element with something that may move, with its computed
 * transition and scroll behavior, its keyframed animations, a transition's own aside, and for a
 * canvas whether it was redrawn while `settle` ms passed. All but the redrawing is read at the
 * start, as the step before left the page, so an animation the step started is read before it can
 * end. It closes over nothing, since it runs through evaluation.
 * @param {(el: Element) => string} selectorOf
 * @param {number} settle
 */
async function readMotion(selectorOf, settle) {
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    throw new TypeError('motionFindings() runs under prefers-reduced-motion: reduce, where nothing may move');
  }
  const canvases = [...document.querySelectorAll('canvas')];
  const pixels = (/** @type {HTMLCanvasElement} */ canvas) => {
    try {
      return canvas.toDataURL();
    } catch {
      return null;
    }
  };
  const before = canvases.map(pixels);
  const drawn = new Set(canvases);
  const TIMING = new Set(['offset', 'computedOffset', 'easing', 'composite']);
  const reads = [...document.querySelectorAll('*')].flatMap(el => {
    const style = getComputedStyle(el);
    const animations = el
      .getAnimations()
      .filter(animation => !(animation instanceof CSSTransition) && animation.effect instanceof KeyframeEffect && animation.effect.target === el)
      .map(animation => {
        const effect = /** @type {KeyframeEffect} */ (animation.effect);
        const properties = [...new Set(effect.getKeyframes().flatMap(frame => Object.keys(frame).filter(key => !TIMING.has(key))))];
        return { properties, duration: Number(effect.getComputedTiming().duration) || 0 };
      });
    const transitions = style.transitionDuration.split(',').some(duration => parseFloat(duration) > 0);
    const moves = transitions || style.scrollBehavior === 'smooth' || animations.length > 0;
    if (!moves && !drawn.has(el)) return [];
    const id = el === document.documentElement ? 'html' : el === document.body ? 'body' : selectorOf(el);
    const { transitionProperty, transitionDuration, scrollBehavior } = style;
    return [{ el, moves, read: { id, transitionProperty, transitionDuration, scrollBehavior, animations } }];
  });
  await new Promise(resolve => setTimeout(resolve, settle));
  const redrawn = new Set(canvases.filter((canvas, i) => before[i] !== null && pixels(canvas) !== before[i]));
  return reads.filter(({ el, moves }) => moves || redrawn.has(el)).map(({ el, read }) => ({ ...read, chartAnimation: redrawn.has(el) }));
}

/**
 * Under reduced motion, what moves on `page`, as findings with their elements. A chart counts as
 * animating when its canvas is redrawn while `settle` ms pass, so a spec checks it right after the
 * step that draws it.
 * @param {Pick<import('@playwright/test').Page, 'evaluate'>} page
 * @param {{settle?: number}} [options]
 */
export async function motionFindings(page, { settle = 150 } = {}) {
  /** @type {({id: string} & Parameters<typeof motionProblems>[0])[]} */
  const reads = await page.evaluate(`(${readMotion})(${selectorOf}, ${settle})`);
  return reads.flatMap(read => motionProblems(read).map(rule => ({ rule, target: read.id })));
}
