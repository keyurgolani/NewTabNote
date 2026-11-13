/**
 * The focus ring against each plane beside it (#24, "Focus and layers"), at #16's 3:1 for focus
 * (design/quiet-atlas.tokens.json). A translucent ring composites onto its plane, and a translucent
 * plane onto what's under it, before anything is measured. A two-tone ring is measured as #16
 * measures its pairs, through js/design/contrast.js's measure(): the outer ring's contrast, or the
 * inner ring's against both the outer and the plane, whichever is better. #16's inner ring fills the
 * offset between the control and the outline, so it's painted on the plane beside the outer ring,
 * never over it, and a translucent inner ring composites onto the plane. Opacity on the control or a
 * parent fades the ring against the plane around it before it's measured. A plane on a translucent
 * backdrop can't be measured, so it's a TypeError that names the plane. A color is #16's theme
 * grammar, or color(srgb …), the form Chrome computes a color-mix() in sRGB to; a color in another
 * space is a TypeError that names the space.
 */

import { compositeOver, measure, parseColor } from '../../../js/design/contrast.js';
import { selectorOf } from './targets.mjs';

/** The least contrast a focus ring may have against a plane beside it */
export const RING_MIN = 3;

/** What a plane is drawn over when nothing else is said: the page's white */
const WHITE = '#ffffff';

/** color(srgb r g b), with `/ a` when it isn't opaque, each a number or a percentage */
const SRGB = /^color\(\s*srgb\s+([^\s/]+)\s+([^\s/]+)\s+([^\s/)]+)\s*(?:\/\s*([^\s/)]+)\s*)?\)$/i;

/** A color in a space other than sRGB, which the check doesn't measure */
const OTHER_SPACE = /^(?:color\(\s*([\w-]+)|(lab|lch|oklab|oklch)\()/i;

/**
 * @param {string} text
 * @returns {{r: number, g: number, b: number, a: number}}
 */
function color(text) {
  const srgb = SRGB.exec(text.trim());
  if (srgb) {
    const [r, g, b, a] = srgb
      .slice(1)
      .map((part, i) => (part === undefined ? 1 : part.endsWith('%') ? Number(part.slice(0, -1)) / 100 : Number(part)) * (i < 3 ? 255 : 1));
    if ([r, g, b, a].every(Number.isFinite)) return { r, g, b, a };
  }
  const space = srgb ? null : OTHER_SPACE.exec(text.trim());
  if (space) throw new TypeError(`${JSON.stringify(text)} is in ${space[1] ?? space[2]}, not sRGB, which the check measures`);
  const parsed = parseColor(text);
  if (!parsed) throw new TypeError(`not a color: ${JSON.stringify(text)}`);
  return parsed;
}

/**
 * The planes the ring falls short on, each with its ratio
 * @param {{outer: string, inner?: string, innerOn?: 'outer'}} ring - CSS colors, with `innerOn: 'outer'`
 *   for a ring of box-shadows, whose inner ring is stacked on the outer one rather than beside it
 * @param {readonly {id: string, color: string, over?: string, ringOpacity?: number}[]} planes - each
 *   plane's color, what's under it, and the opacity the ring shows at over it, which fades the ring
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
      if (ring.innerOn === 'outer' && colors.inner) {
        colors.inner = compositeOver(colors.inner, compositeOver(colors.fg, colors.bg.a < 1 ? compositeOver(colors.bg, colors.over) : colors.bg));
      }
      // Opacity fades the ring as it's painted, its inner ring flattened onto the outer one first
      const fade = plane.ringOpacity ?? 1;
      colors.fg = { ...colors.fg, a: colors.fg.a * fade };
      if (colors.inner) colors.inner = { ...colors.inner, a: colors.inner.a * fade };
      return { plane: plane.id, ratio: measure(colors, 1).ratio };
    })
    .filter(({ ratio }) => ratio < min);
}

/** The rule a faint or missing focus ring fails */
export const RULE = 'ntn-focus-ring';

/**
 * In the page: the focused element's ring and the planes beside it, or null when focus is on the page
 * itself. The outline is the outer ring, and the top box-shadow the inner where the outline's offset
 * leaves room for it, as #16 draws a two-tone ring. With no outline, the rings are the shadows that
 * show past every one listed before them: the widest is the outer ring and the next the inner,
 * stacked on it, so it composites onto the outer ring. A shadow that's painted over is no ring. A
 * plane is the first background that isn't transparent, around the control and on it, with the first
 * opaque one under it when it's translucent.
 * @param {(el: Element) => string} selectorOf
 */
function readRing(selectorOf) {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const style = getComputedStyle(el);
  // Chrome computes rgb(), rgba(), or color(srgb … / a) for a color-mix(), its alpha after the slash
  const alpha = (/** @type {string} */ color) => {
    const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
    if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
    return color.startsWith('rgba') ? Number(color.slice(color.lastIndexOf(',') + 1, -1)) : 1;
  };
  const COLOR = /rgba?\([^)]*\)|color\([^)]*\)/;
  // Box-shadows paint in the order they're listed, the first on top
  const shadows = (style.boxShadow === 'none' ? [] : style.boxShadow.split(/,(?![^(]*\))/))
    .filter(shadow => !shadow.includes('inset'))
    .map(shadow => ({ color: (shadow.match(COLOR) ?? ['rgba(0, 0, 0, 0)'])[0], spread: parseFloat(shadow.replace(COLOR, '').match(/-?[\d.]+px/g)?.[3] ?? '0') }));
  // So a shadow shows only past every one listed before it
  const shown = shadows.filter((shadow, i) => shadows.slice(0, i).every(({ spread }) => spread < shadow.spread));
  const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 ? style.outlineColor : null;
  // An outline paints over every shadow, so the top one shows only in the offset the outline leaves
  const [outer, inner] = outline
    ? [outline, parseFloat(style.outlineOffset) > 0 ? shadows[0]?.color : undefined]
    : [shown.at(-1)?.color, shown.at(-2)?.color];
  /** @param {Element | null} start */
  const plane = start => {
    let color = null;
    for (let node = start; node; node = node.parentElement) {
      const background = getComputedStyle(node).backgroundColor;
      if (alpha(background) === 0) continue;
      color ??= background;
      if (alpha(background) === 1) return color === background ? { color } : { color, over: background };
    }
    return { color: color ?? 'rgb(255, 255, 255)' };
  };
  // The ring shows at the opacity of the control and each parent up to the plane around it. A known
  // limit: opacity on the parent that carries that plane, or above it, isn't measured, and neither is
  // the control's own fill under the control's opacity, though each composites over what's under the
  // faded box. No legacy box with a background fades a focusable control (#327's review, drop 4).
  let ringOpacity = 1;
  for (let node = el; node && (node === el || alpha(getComputedStyle(node).backgroundColor) === 0); node = node.parentElement) {
    ringOpacity *= Number(getComputedStyle(node).opacity);
  }
  const planes = [{ id: 'around', ...plane(el.parentElement), ...(ringOpacity < 1 ? { ringOpacity } : {}) }];
  if (alpha(style.backgroundColor) > 0) planes.push({ id: 'control', ...plane(el) });
  const stacked = !outline && inner ? { innerOn: 'outer' } : {};
  return { id: selectorOf(el), ring: outer ? { outer, ...(inner ? { inner } : {}), ...stacked } : null, planes };
}

/** The rule a focus walk that stops short fails: Tab left focus where it was, or on body with a tab stop to come, or the walk hit its cap */
export const WALK_RULE = 'ntn-focus-walk';

/**
 * In the page: whether a tab stop follows the focused control in the document, so that a Tab from it
 * that leaves focus on body hasn't reached the page's end, as a script that drops focus mid-page has
 * it. A stop is rendered, visible and enabled, outside any inert subtree, and in the tab order by its
 * tabindex, its tag or as an editing host. It runs through Playwright evaluation, so it closes over
 * nothing.
 */
export function tabStopFollows() {
  const focused = document.activeElement;
  if (!focused || focused === document.body) return false;
  const STOPS = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [contenteditable]:not([contenteditable="false"]), [tabindex]';
  return [...document.querySelectorAll(STOPS)].some(el => {
    if (el === focused || !(focused.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
    if (!(el instanceof HTMLElement) || el.matches(':disabled') || el.closest('[inert]')) return false;
    const host = el.isContentEditable && !el.parentElement?.isContentEditable;
    if (el.isContentEditable && !host) return false;
    if (!(el.hasAttribute('tabindex') ? el.tabIndex >= 0 : host || el.tabIndex >= 0)) return false;
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
  });
}

/**
 * Tabs through `page` from where focus is, reading each stop with `read`, until focus leaves the page
 * or comes back round. A walk that stops short says where: at a control that keeps focus on Tab, as
 * an editor does that indents on it, at one whose Tab leaves focus on body though a tab stop follows
 * it, as a table's last cell does when it re-renders its block, or at the last stop it read when it
 * hits its cap.
 * @param {Pick<import('@playwright/test').Page, 'keyboard' | 'evaluate'>} page
 * @param {(selectorOf: (el: Element) => string, first: boolean) => {id: string} | null} read - in the
 *   page: the focused element's reading, or null when focus is on the page itself, told whether it's
 *   the walk's first
 * @param {{max?: number}} [options] - the most Tab presses
 * @returns {Promise<{reads: any[], stopped: {rule: string, target: string} | null}>}
 */
export async function tabWalk(page, read, { max = 200 } = {}) {
  /** @type {any[]} */
  const reads = [];
  const seen = new Set();
  /** @type {string | null} */
  let last = null;
  let followed = false;
  for (let press = 0; press < max; press += 1) {
    await page.keyboard.press('Tab');
    /** @type {{id: string, followed?: boolean} | null} */
    const stop = await page.evaluate(`((stop) => stop && { ...stop, followed: (${tabStopFollows})() })((${read})(${selectorOf}, ${press === 0}))`);
    if (stop !== null && stop.id === last) return { reads, stopped: { rule: WALK_RULE, target: stop.id } };
    if (stop === null) return { reads, stopped: followed && last !== null ? { rule: WALK_RULE, target: last } : null };
    if (seen.has(stop.id)) return { reads, stopped: null };
    seen.add(stop.id);
    last = stop.id;
    followed = stop.followed === true;
    reads.push(stop);
  }
  return { reads, stopped: last === null ? null : { rule: WALK_RULE, target: last } };
}

/**
 * Tabs through `page` from where focus is, and finds each control whose ring is under 3:1 against a
 * plane beside it, or that shows none, with where the walk stopped short, if it did
 * @param {Pick<import('@playwright/test').Page, 'keyboard' | 'evaluate'>} page
 * @param {{max?: number}} [options] - the most Tab presses
 */
export async function ringFindings(page, options = {}) {
  const { reads, stopped } = await tabWalk(page, readRing, options);
  /** @type {{rule: string, target: string}[]} */
  const findings = reads.filter(read => read.ring === null || ringShortfalls(read.ring, read.planes).length > 0).map(({ id }) => ({ rule: RULE, target: id }));
  return stopped ? [...findings, stopped] : findings;
}
