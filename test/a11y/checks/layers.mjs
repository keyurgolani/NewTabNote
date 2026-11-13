/**
 * Focus and layers (#24, "Focus and layers"): hidden, collapsed, off-screen and transparent layers are
 * inert, with focus moved out first, so Tab never lands where nobody sees it. The browser half tabs
 * through the page and reads each stop: whether the page shows any of it where it sits, by what's on
 * top at its middle and near its corners, and its opacity with its parents'. A stop under aria-hidden
 * is axe's aria-hidden-focus.
 */

import { tabWalk } from './ring.mjs';

/** The rule a tab stop nobody sees fails */
export const HIDDEN_RULE = 'ntn-hidden-focus';

/**
 * The stops nobody sees: the page shows none of one where it sits, or it's transparent
 * @param {readonly {id: string, shown: boolean, opacity: number}[]} stops
 * @returns {string[]}
 */
export function hiddenStops(stops) {
  return stops.filter(({ shown, opacity }) => !shown || opacity === 0).map(({ id }) => id);
}

/**
 * In the page: the focused element, with whether the page shows any of it and its opacity with its
 * parents', or null when focus is on the page itself. A stop the pointer passes through is shown if
 * any of it is on screen.
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
  return { id: selectorOf(el), shown, opacity };
}

/**
 * Tabs through `page` from where focus is, and finds each stop nobody sees, with where the walk
 * stopped short, if it did
 * @param {Pick<import('@playwright/test').Page, 'keyboard' | 'evaluate'>} page
 * @param {{max?: number}} [options] - the most Tab presses
 */
export async function layerFindings(page, options = {}) {
  const { reads, stopped } = await tabWalk(page, readStop, options);
  const findings = hiddenStops(reads).map(target => ({ rule: HIDDEN_RULE, target }));
  return stopped ? [...findings, stopped] : findings;
}
