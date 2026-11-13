/**
 * Clipping and reflow (#24's Targets and Responsive): every action stays whole and reachable, so
 * none is cut off by an overflow: hidden or clip parent or placed where scrolling can't reach, and at
 * 320 CSS px wide the page doesn't scroll sideways (WCAG 1.4.10). The browser half reads each pointer
 * target's box in page coordinates and, on each axis, what it's held inside: each parent that clips
 * it, the area its scroll container scrolls, with that container's visible part held in its place
 * further up, and the page's own scroll extent. The pure part judges them. An action wholly before the
 * page's start is hidden, the layers check's, as a skip link is until it's focused.
 */

import { markListened, pointerTargets, selectorOf } from './targets.mjs';

/** The rule an action that's cut off fails */
export const CLIP_RULE = 'ntn-clipped-action';

/** The rule a page that scrolls sideways at a narrow width fails */
export const REFLOW_RULE = 'ntn-reflow';

/** The width a page is held to reflow at, in CSS px, as WCAG 1.4.10 asks. A narrower page may scroll sideways, as long as nothing's cut off. */
export const REFLOW_WIDTH = 320;

/** What a box may stick out by: rounding, and nothing more */
const SLACK = 0.5;

/**
 * @typedef {{left: number, top: number, right: number, bottom: number}} Box
 * @typedef {{box: Box, edge: Box}} Hold - a box and the edge it stays inside, open far out on the axis it isn't held on
 */

/**
 * Whether an action is cut off: a box it's held to reaches past the edge it's held inside, while some
 * of the action is on the page
 * @param {{box: Box, holds: readonly Hold[]}} action - in page coordinates
 */
export function cutOff({ box, holds }) {
  if (box.right <= 0 || box.bottom <= 0) return false;
  return holds.some(
    ({ box: held, edge }) =>
      held.left < edge.left - SLACK || held.top < edge.top - SLACK || held.right > edge.right + SLACK || held.bottom > edge.bottom + SLACK,
  );
}

/**
 * In the page: each pointer target's box and what it's held inside, and at `narrow` CSS px wide, the
 * outermost elements that make the page scroll sideways. On each axis an action is held inside
 * each parent that clips it there, up to the first that scrolls there, and inside the area that one
 * scrolls. Above it, the container's visible part takes the action's place and is held the same way,
 * and what's held last, inside the page's scroll extent. A parent holds an element unless the
 * element's position takes it out: fixed escapes every parent, and absolute each one up to the nearest
 * positioned one. It closes over nothing, since it runs through evaluation.
 * @param {(el: Element) => string} selectorOf
 * @param {() => Element[]} pointerTargets
 * @param {number} narrow
 */
function readClips(selectorOf, pointerTargets, narrow) {
  const FAR = 1e9;
  const OPEN = { left: -FAR, top: -FAR, right: FAR, bottom: FAR };
  const root = document.scrollingElement ?? document.documentElement;
  const hides = (/** @type {string} */ value) => value === 'hidden' || value === 'clip';
  const scrolls = (/** @type {string} */ value) => value === 'auto' || value === 'scroll';
  const [page, body] = [getComputedStyle(document.documentElement), getComputedStyle(document.body)];
  const reach = {
    right: hides(page.overflowX) || hides(body.overflowX) ? innerWidth : root.scrollWidth,
    bottom: hides(page.overflowY) || hides(body.overflowY) ? innerHeight : root.scrollHeight,
  };
  // Each axis's sides and the properties that read it
  const axes = /** @type {const} */ ([
    { start: 'left', end: 'right', overflow: 'overflowX', border: 'clientLeft', size: 'clientWidth', scrolled: 'scrollLeft', extent: 'scrollWidth' },
    { start: 'top', end: 'bottom', overflow: 'overflowY', border: 'clientTop', size: 'clientHeight', scrolled: 'scrollTop', extent: 'scrollHeight' },
  ]);
  const inPage = (/** @type {Element} */ el) => {
    const { left, top, right, bottom } = el.getBoundingClientRect();
    return { left: left + scrollX, top: top + scrollY, right: right + scrollX, bottom: bottom + scrollY };
  };
  const actions = pointerTargets().flatMap(el => {
    const box = inPage(el);
    if (box.right - box.left === 0 || box.bottom - box.top === 0) return [];
    /** @type {{box: typeof box, edge: typeof box}[]} */
    const holds = [];
    for (const axis of axes) {
      // What's held on this axis: the action, then the visible part of each scroll container it's in
      let held = box;
      let position = getComputedStyle(el).position;
      for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement && position !== 'fixed'; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (position === 'absolute' && style.position === 'static') continue;
        position = style.position;
        const overflow = style[axis.overflow];
        if (!hides(overflow) && !scrolls(overflow)) continue;
        const from = inPage(node)[axis.start] + node[axis.border];
        const visible = { ...OPEN, [axis.start]: from, [axis.end]: from + node[axis.size] };
        if (hides(overflow)) {
          holds.push({ box: held, edge: visible });
          continue;
        }
        const origin = from - node[axis.scrolled];
        holds.push({ box: held, edge: { ...OPEN, [axis.start]: origin, [axis.end]: origin + node[axis.extent] } });
        held = visible;
      }
      holds.push({ box: held, edge: { ...OPEN, [axis.start]: 0, [axis.end]: reach[axis.end] } });
    }
    return [{ id: selectorOf(el), box, holds }];
  });
  /** @type {Element[]} */
  const sideways = [];
  if (innerWidth === narrow && root.scrollWidth > root.clientWidth + 0.5) {
    for (const el of document.body.querySelectorAll('*')) {
      if (sideways.some(outer => outer.contains(el)) || inPage(el).right <= root.clientWidth + 0.5) continue;
      let contained = false;
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).overflowX !== 'visible') contained = true;
      }
      if (!contained) sideways.push(el);
    }
  }
  const wide = root.scrollWidth > root.clientWidth + 0.5 && innerWidth === narrow;
  return { actions, sideways: sideways.length > 0 ? sideways.map(selectorOf) : wide ? ['html'] : [] };
}

/**
 * The actions on `page` that are cut off at any width, and at 320 CSS px wide what makes it scroll
 * sideways, as findings
 * @param {import('@playwright/test').Page} page
 */
export async function clipFindings(page) {
  await markListened(page);
  /** @type {{actions: {id: string, box: Box, holds: Hold[]}[], sideways: string[]}} */
  const { actions, sideways } = await page.evaluate(`(${readClips})(${selectorOf}, ${pointerTargets}, ${REFLOW_WIDTH})`);
  return [
    ...actions.filter(action => cutOff(action)).map(({ id }) => ({ rule: CLIP_RULE, target: id })),
    ...sideways.map(target => ({ rule: REFLOW_RULE, target })),
  ];
}
