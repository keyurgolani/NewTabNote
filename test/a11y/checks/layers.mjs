/**
 * Focus and layers (#24, "Focus and layers"): hidden, collapsed, off-screen and transparent layers are
 * inert, with focus moved out first, so Tab never lands where nobody sees it. The browser half tabs
 * through the page and reads each stop: whether the page shows any of it where it sits, by what's on
 * top at the middle and near the corners of each of its line boxes, and its opacity with its parents'. A stop under aria-hidden
 * is axe's aria-hidden-focus. Tab order follows the order the page reads in, left to right as the
 * extension's pages run: a stop Tab reaches back along a line, up a column, or up to the column
 * before, from the stop before is out of it. No scripted action leaves focus on body either:
 * focusLost() reads where a step left it.
 */

import { tabWalk } from './ring.mjs';

/** @typedef {{x: number, y: number, width: number, height: number}} Box */

/** The rule a tab stop nobody sees fails */
export const HIDDEN_RULE = 'ntn-hidden-focus';

/** The rule a tab stop out of the page's reading order fails */
export const ORDER_RULE = 'ntn-tab-order';

/** The rule a step that leaves focus on body fails */
export const LOST_RULE = 'ntn-focus-lost';

/**
 * The stops nobody sees: the page shows none of one where it sits, or it's transparent
 * @param {readonly {id: string, shown: boolean, opacity: number}[]} stops
 * @returns {string[]}
 */
export function hiddenStops(stops) {
  return stops.filter(({ shown, opacity }) => !shown || opacity === 0).map(({ id }) => id);
}

/**
 * The stops Tab reaches out of reading order: back along the line the stop before sits on, up the
 * column it sits in, or up and back to the left with neither shared, as a step up to the column before
 * is, which no reading left to right takes. A step up and right, to the top of the next column, reads
 * in order. Two boxes share a line when they overlap by half the shorter one's height, and a column
 * when they overlap by half the narrower one's width. A stop that wraps starts at its `box`
 * and ends at its `end`, so the next stop is read from where it ends. A stop read in the page carries
 * `before`, the stop before's last line box as the same read measured it, so each step compares in one
 * frame whatever scrolled between the two reads; null when there's none to measure.
 * @param {readonly {id: string, box: Box, end?: Box, before?: Box | null}[]} stops - in tab order
 * @returns {string[]}
 */
export function orderProblems(stops) {
  const overlap = (/** @type {number} */ a, /** @type {number} */ aSize, /** @type {number} */ b, /** @type {number} */ bSize) =>
    Math.min(a + aSize, b + bSize) - Math.max(a, b) >= Math.min(aSize, bSize) / 2;
  return stops
    .filter((stop, i) => {
      if (i === 0) return false;
      const [a, b] = [stop.before === undefined ? (stops[i - 1].end ?? stops[i - 1].box) : stop.before, stop.box];
      if (a === null) return false;
      const line = overlap(a.y, a.height, b.y, b.height);
      if (line) return b.x + b.width / 2 < a.x + a.width / 2;
      if (overlap(a.x, a.width, b.x, b.width)) return b.y + b.height <= a.y;
      return b.y + b.height <= a.y && b.x + b.width / 2 < a.x + a.width / 2;
    })
    .map(({ id }) => id);
}

/**
 * In the page: the focused element, with whether the page shows any of it and its opacity with its
 * parents', or null when focus is on the page itself. It's read by its line boxes, so a link that wraps
 * is shown if the page shows it where either part sits, and its box is its first part, with its last
 * as its end. A stop the pointer passes through is shown if any of it is on screen. Chrome scrolls each
 * stop it tabs to into view, so the read also measures the last stop the walk saw shown, kept on the
 * window, by its last line box: `before`, in the same frame as this stop's boxes.
 * @param {(el: Element) => string} selectorOf
 * @param {boolean} first - whether it's the walk's first read, which has no stop before it
 */
function readStop(selectorOf, first) {
  const scope = /** @type {any} */ (window);
  if (first) scope.__ntnShownStop = null;
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const parts = [...el.getClientRects()].filter(({ width, height }) => width > 0 && height > 0);
  const passes = getComputedStyle(el).pointerEvents === 'none';
  const seen = (/** @type {DOMRect} */ { left, top, width, height }) =>
    left < innerWidth &&
    top < innerHeight &&
    left + width > 0 &&
    top + height > 0 &&
    (passes ||
      [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]].some(([x, y]) => {
        const hit = document.elementFromPoint(left + width * x, top + height * y);
        return hit !== null && (hit === el || el.contains(hit));
      }));
  const shown = parts.some(seen);
  let opacity = 1;
  for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
  const at = (/** @type {DOMRect} */ { left, top, width, height }) => ({ x: left, y: top, width, height });
  /** @type {Element | null} */
  const prior = scope.__ntnShownStop ?? null;
  const priorParts = prior && prior.isConnected ? [...prior.getClientRects()].filter(({ width, height }) => width > 0 && height > 0) : [];
  const before = priorParts.length > 0 ? at(priorParts[priorParts.length - 1]) : null;
  if (shown && opacity !== 0) scope.__ntnShownStop = el;
  const [start = el.getBoundingClientRect()] = parts;
  return { id: selectorOf(el), shown, opacity, box: at(start), ...(parts.length > 1 ? { end: at(parts[parts.length - 1]) } : {}), before };
}

/**
 * Tabs through `page` from where focus is, and finds each stop nobody sees, then each stop the others
 * reach out of reading order, with where the walk stopped short, if it did
 * @param {Pick<import('@playwright/test').Page, 'keyboard' | 'evaluate'>} page
 * @param {{max?: number}} [options] - the most Tab presses
 */
export async function layerFindings(page, options = {}) {
  const { reads, stopped } = await tabWalk(page, readStop, options);
  const hidden = hiddenStops(reads);
  const findings = [
    ...hidden.map(target => ({ rule: HIDDEN_RULE, target })),
    ...orderProblems(reads.filter(({ id }) => !hidden.includes(id))).map(target => ({ rule: ORDER_RULE, target })),
  ];
  return stopped ? [...findings, stopped] : findings;
}

/**
 * After a step, whether it left focus on body: a finding named for the step, or none
 * @param {Pick<import('@playwright/test').Page, 'evaluate'>} page
 * @param {string} step - what the step did
 */
export async function focusLost(page, step) {
  /** @type {boolean} */
  const lost = await page.evaluate('[null, document.body, document.documentElement].includes(document.activeElement)');
  return lost ? [{ rule: LOST_RULE, target: step }] : [];
}
