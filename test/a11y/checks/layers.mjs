/**
 * Focus and layers (#24, "Focus and layers"): hidden, collapsed, off-screen and transparent layers are
 * inert, with focus moved out first, so Tab never lands where nobody sees it. The browser half tabs
 * through the page and reads each stop: whether the page shows any of it where it sits, by what's on
 * top at its middle and near its corners, and its opacity with its parents'. A stop under aria-hidden
 * is axe's aria-hidden-focus. Tab order follows the order the page reads in, left to right as the
 * extension's pages run: a stop Tab reaches back along a line, or up a column, from the stop before
 * is out of it. No scripted action leaves focus on body either: focusLost() reads where a step left it.
 */

import { tabWalk } from './ring.mjs';

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
 * The stops Tab reaches out of reading order: back along the line the stop before sits on, or up the
 * column it sits in. Two boxes share a line when they overlap by half the shorter one's height, and a
 * column when they overlap by half the narrower one's width.
 * @param {readonly {id: string, box: {x: number, y: number, width: number, height: number}}[]} stops - in tab order
 * @returns {string[]}
 */
export function orderProblems(stops) {
  const overlap = (/** @type {number} */ a, /** @type {number} */ aSize, /** @type {number} */ b, /** @type {number} */ bSize) =>
    Math.min(a + aSize, b + bSize) - Math.max(a, b) >= Math.min(aSize, bSize) / 2;
  return stops
    .filter((stop, i) => {
      if (i === 0) return false;
      const [a, b] = [stops[i - 1].box, stop.box];
      const line = overlap(a.y, a.height, b.y, b.height);
      if (line) return b.x + b.width / 2 < a.x + a.width / 2;
      return overlap(a.x, a.width, b.x, b.width) && b.y + b.height <= a.y;
    })
    .map(({ id }) => id);
}

/**
 * In the page: the focused element, with whether the page shows any of it and its opacity with its
 * parents', or null when focus is on the page itself. A stop the pointer passes through is shown if
 * any of it is on screen. Its box is where it sits with nothing scrolled, each scrolled box around it
 * up to a fixed one added back, since Chrome scrolls each stop it tabs to into view and order compares
 * stops read at different scroll positions. A sticky box isn't followed.
 * @param {(el: Element) => string} selectorOf
 */
function readStop(selectorOf) {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const { left, top, width, height } = el.getBoundingClientRect();
  const onScreen = width > 0 && height > 0 && left < innerWidth && top < innerHeight && left + width > 0 && top + height > 0;
  const hits = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]].map(([x, y]) => document.elementFromPoint(left + width * x, top + height * y));
  const shown = onScreen && (getComputedStyle(el).pointerEvents === 'none' || hits.some(hit => hit !== null && (hit === el || el.contains(hit))));
  let opacity = 1;
  for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
  let dx = 0;
  let dy = 0;
  for (let node = el; node.parentElement && getComputedStyle(node).position !== 'fixed'; node = node.parentElement) {
    dx += node.parentElement.scrollLeft;
    dy += node.parentElement.scrollTop;
  }
  return { id: selectorOf(el), shown, opacity, box: { x: left + dx, y: top + dy, width, height } };
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
