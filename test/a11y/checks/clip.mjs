/**
 * Clipping and reflow (#24's Targets and Responsive): every action stays whole and reachable, so
 * none is cut off by an overflow: hidden or clip parent or placed where scrolling can't reach, and at
 * 320 CSS px wide the page doesn't scroll sideways (WCAG 1.4.10). The browser half reads each pointer
 * target's box in page coordinates and, on each axis, the parents around it: each one that clips it
 * there, and each scroll container with the area it scrolls, the page last. The pure part judges
 * whether some scroll of each brings every part of the action into view. An action wholly before the
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
 * @typedef {{start: number, end: number}} Span
 * @typedef {{visible: Span, area?: Span}} Parent - on one axis, a parent's visible part, and if it scrolls there, the area it scrolls
 */

/**
 * Whether some scroll of each container around a point brings it into view, through `parents` from
 * it out. It tracks where the point can be: each parent that clips it, before any container, keeps it
 * inside, and each container lets it move as far as the container scrolls, and then keeps it inside
 * the part of its own visible part that the parents up to the next container leave.
 * @param {number} at
 * @param {readonly Parent[]} parents
 */
function reaches(at, parents) {
  let [low, high] = [at, at];
  /** @type {Span | null} */
  let shown = null;
  const inside = (/** @type {Span} */ part) => {
    [low, high] = [Math.max(low, part.start - SLACK), Math.min(high, part.end + SLACK)];
    return low <= high;
  };
  for (const { visible, area } of parents) {
    if (area === undefined) {
      if (shown) shown = { start: Math.max(shown.start, visible.start), end: Math.min(shown.end, visible.end) };
      else if (!inside(visible)) return false;
      continue;
    }
    if (shown && !inside(shown)) return false;
    [low, high] = [low - (area.end - visible.end), high + (visible.start - area.start)];
    shown = visible;
  }
  return shown === null || inside(shown);
}

/**
 * Whether an action is cut off: on either axis some part of it no scroll brings into view, while some
 * of it is on the page. The points a scroll can bring in on an axis run unbroken, so with both of its
 * ends in reach every part of it is, though not every part at once.
 * @param {{box: Box, parents: {x: readonly Parent[], y: readonly Parent[]}}} action - in page coordinates
 */
export function cutOff({ box, parents }) {
  if (box.right <= 0 || box.bottom <= 0) return false;
  const inReach = (/** @type {number[]} */ ends, /** @type {readonly Parent[]} */ around) => ends.every(at => reaches(at, around));
  return !inReach([box.left, box.right], parents.x) || !inReach([box.top, box.bottom], parents.y);
}

/**
 * In the page: each pointer target's box and its parents on each axis, and at `narrow` CSS px wide,
 * the outermost elements that make the page scroll sideways. A parent counts on an axis where it hides
 * overflow, by its visible part, or scrolls, with the area it scrolls too: its padding box less its
 * scroll offset, as far as its scroll extent. The page comes last, by what the viewport shows and how
 * far it scrolls, unless it hides overflow there or the action is fixed, which its scroll doesn't
 * move. A parent holds an element unless the element's position takes it out: fixed escapes every
 * parent, and absolute each one up to the nearest positioned one. It closes over nothing, since it runs
 * through evaluation.
 * @param {(el: Element) => string} selectorOf
 * @param {() => Element[]} pointerTargets
 * @param {number} narrow
 */
function readClips(selectorOf, pointerTargets, narrow) {
  const root = document.scrollingElement ?? document.documentElement;
  const hides = (/** @type {string} */ value) => value === 'hidden' || value === 'clip';
  const scrolls = (/** @type {string} */ value) => value === 'auto' || value === 'scroll';
  const [page, body] = [getComputedStyle(document.documentElement), getComputedStyle(document.body)];
  // Each axis's start and the properties that read it
  const axes = /** @type {const} */ ([
    { name: 'x', start: 'left', overflow: 'overflowX', border: 'clientLeft', size: 'clientWidth', scrolled: 'scrollLeft', extent: 'scrollWidth', viewStart: () => scrollX },
    { name: 'y', start: 'top', overflow: 'overflowY', border: 'clientTop', size: 'clientHeight', scrolled: 'scrollTop', extent: 'scrollHeight', viewStart: () => scrollY },
  ]);
  const inPage = (/** @type {Element} */ el) => {
    const { left, top, right, bottom } = el.getBoundingClientRect();
    return { left: left + scrollX, top: top + scrollY, right: right + scrollX, bottom: bottom + scrollY };
  };
  const actions = pointerTargets().flatMap(el => {
    const box = inPage(el);
    if (box.right - box.left === 0 || box.bottom - box.top === 0) return [];
    /** @type {{x: {visible: {start: number, end: number}, area?: {start: number, end: number}}[], y: {visible: {start: number, end: number}, area?: {start: number, end: number}}[]}} */
    const parents = { x: [], y: [] };
    for (const axis of axes) {
      let position = getComputedStyle(el).position;
      for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement && position !== 'fixed'; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (position === 'absolute' && style.position === 'static') continue;
        position = style.position;
        const overflow = style[axis.overflow];
        if (!hides(overflow) && !scrolls(overflow)) continue;
        const from = inPage(node)[axis.start] + node[axis.border];
        const visible = { start: from, end: from + node[axis.size] };
        const origin = from - node[axis.scrolled];
        parents[axis.name].push(hides(overflow) ? { visible } : { visible, area: { start: origin, end: origin + node[axis.extent] } });
      }
      const view = { start: axis.viewStart(), end: axis.viewStart() + root[axis.size] };
      const still = position === 'fixed' || hides(page[axis.overflow]) || hides(body[axis.overflow]);
      parents[axis.name].push({ visible: view, area: still ? view : { start: 0, end: root[axis.extent] } });
    }
    return [{ id: selectorOf(el), box, parents }];
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
  /** @type {{actions: {id: string, box: Box, parents: {x: Parent[], y: Parent[]}}[], sideways: string[]}} */
  const { actions, sideways } = await page.evaluate(`(${readClips})(${selectorOf}, ${pointerTargets}, ${REFLOW_WIDTH})`);
  return [
    ...actions.filter(action => cutOff(action)).map(({ id }) => ({ rule: CLIP_RULE, target: id })),
    ...sideways.map(target => ({ rule: REFLOW_RULE, target })),
  ];
}
