/**
 * Clipping and reflow (#24's Targets and Responsive): every action stays whole and reachable, so
 * none is cut off by an overflow: hidden or clip parent or placed where scrolling can't reach, and at
 * 320 CSS px wide the page doesn't scroll sideways (WCAG 1.4.10). The browser half reads each pointer
 * target's box in page coordinates, the parents that clip it, and how far the page scrolls; the pure
 * part judges them. An action wholly before the page's start is hidden, the layers check's, as a skip
 * link is until it's focused.
 */

import { markListened, pointerTargets, selectorOf } from './targets.mjs';

/** The rule an action that's cut off fails */
export const CLIP_RULE = 'ntn-clipped-action';

/** The rule a page that scrolls sideways at a narrow width fails */
export const REFLOW_RULE = 'ntn-reflow';

/** The widest a page is held to reflow at, in CSS px */
export const REFLOW_WIDTH = 320;

/** What a box may stick out by: rounding, and nothing more */
const SLACK = 0.5;

/**
 * @typedef {{left: number, top: number, right: number, bottom: number}} Box
 */

/**
 * Whether an action is cut off: part of it past a parent that clips it, past where the page scrolls
 * to, or before the page's start, while some of it is on the page
 * @param {{box: Box, clips: readonly Box[], reach: {right: number, bottom: number}}} action - in page coordinates
 */
export function cutOff({ box, clips, reach }) {
  if (box.right <= 0 || box.bottom <= 0) return false;
  const past = (/** @type {Box} */ edge) =>
    box.left < edge.left - SLACK || box.top < edge.top - SLACK || box.right > edge.right + SLACK || box.bottom > edge.bottom + SLACK;
  return past({ left: 0, top: 0, ...reach }) || clips.some(past);
}

/**
 * In the page: each pointer target's box and the parents that clip it, how far the page scrolls, and
 * at `narrow` CSS px or less, the outermost elements that make it scroll sideways. A parent clips an
 * element unless the element's position takes it out: fixed escapes every parent, and absolute each
 * one up to the nearest positioned one. It closes over nothing, since it runs through evaluation.
 * @param {(el: Element) => string} selectorOf
 * @param {() => Element[]} pointerTargets
 * @param {number} narrow
 */
function readClips(selectorOf, pointerTargets, narrow) {
  const FAR = 1e9;
  const root = document.scrollingElement ?? document.documentElement;
  const hides = (/** @type {string} */ value) => value === 'hidden' || value === 'clip';
  const [page, body] = [getComputedStyle(document.documentElement), getComputedStyle(document.body)];
  const reach = {
    right: hides(page.overflowX) || hides(body.overflowX) ? innerWidth : root.scrollWidth,
    bottom: hides(page.overflowY) || hides(body.overflowY) ? innerHeight : root.scrollHeight,
  };
  const inPage = (/** @type {Element} */ el) => {
    const { left, top, right, bottom } = el.getBoundingClientRect();
    return { left: left + scrollX, top: top + scrollY, right: right + scrollX, bottom: bottom + scrollY };
  };
  const actions = pointerTargets().flatMap(el => {
    const box = inPage(el);
    if (box.right - box.left === 0 || box.bottom - box.top === 0) return [];
    /** @type {{left: number, top: number, right: number, bottom: number}[]} */
    const clips = [];
    let position = getComputedStyle(el).position;
    for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement && position !== 'fixed'; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (position === 'absolute' && style.position === 'static') continue;
      if (hides(style.overflowX) || hides(style.overflowY)) {
        const outer = inPage(node);
        const [left, top] = [outer.left + node.clientLeft, outer.top + node.clientTop];
        clips.push({
          left: hides(style.overflowX) ? left : -FAR,
          right: hides(style.overflowX) ? left + node.clientWidth : FAR,
          top: hides(style.overflowY) ? top : -FAR,
          bottom: hides(style.overflowY) ? top + node.clientHeight : FAR,
        });
      }
      position = style.position;
    }
    return [{ id: selectorOf(el), box, clips }];
  });
  /** @type {Element[]} */
  const sideways = [];
  if (innerWidth <= narrow && root.scrollWidth > root.clientWidth + 0.5) {
    for (const el of document.body.querySelectorAll('*')) {
      if (sideways.some(outer => outer.contains(el)) || inPage(el).right <= root.clientWidth + 0.5) continue;
      let contained = false;
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).overflowX !== 'visible') contained = true;
      }
      if (!contained) sideways.push(el);
    }
  }
  const wide = root.scrollWidth > root.clientWidth + 0.5 && innerWidth <= narrow;
  return { actions, reach, sideways: sideways.length > 0 ? sideways.map(selectorOf) : wide ? ['html'] : [] };
}

/**
 * The actions on `page` that are cut off, and at 320 CSS px or less what makes it scroll sideways, as
 * findings
 * @param {import('@playwright/test').Page} page
 */
export async function clipFindings(page) {
  await markListened(page);
  /** @type {{actions: {id: string, box: Box, clips: Box[]}[], reach: {right: number, bottom: number}, sideways: string[]}} */
  const { actions, reach, sideways } = await page.evaluate(`(${readClips})(${selectorOf}, ${pointerTargets}, ${REFLOW_WIDTH})`);
  return [
    ...actions.filter(action => cutOff({ ...action, reach })).map(({ id }) => ({ rule: CLIP_RULE, target: id })),
    ...sideways.map(target => ({ rule: REFLOW_RULE, target })),
  ];
}
