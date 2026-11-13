/**
 * The focus ring against each plane beside it (#24, "Focus and layers"), at #16's 3:1 for focus
 * (design/quiet-atlas.tokens.json). A translucent ring composites onto its plane, and a translucent
 * plane onto what's under it, before anything is measured. A two-tone ring is measured as #16
 * measures its pairs, through js/design/contrast.js's measure(): the outer ring's contrast, or the
 * inner ring's against both the outer and the plane, whichever is better. #16's inner ring fills the
 * offset between the control and the outline, so it's painted on the plane beside the outer ring,
 * never over it, and a translucent inner ring composites onto the plane. A plane on a translucent
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
 * @param {readonly {id: string, color: string, over?: string}[]} planes - each plane's color, and what's under it
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
  const planes = [{ id: 'around', ...plane(el.parentElement) }];
  if (alpha(style.backgroundColor) > 0) planes.push({ id: 'control', ...plane(el) });
  const stacked = !outline && inner ? { innerOn: 'outer' } : {};
  return { id: selectorOf(el), ring: outer ? { outer, ...(inner ? { inner } : {}), ...stacked } : null, planes };
}

/**
 * Tabs through `page` from where focus is, and finds each control whose ring is under 3:1 against a
 * plane beside it, or that shows none, until focus leaves the page or comes back round
 * @param {import('@playwright/test').Page} page
 * @param {{max?: number}} [options] - the most Tab presses
 */
export async function ringFindings(page, { max = 200 } = {}) {
  /** @type {{rule: string, target: string}[]} */
  const findings = [];
  const seen = new Set();
  for (let press = 0; press < max; press += 1) {
    await page.keyboard.press('Tab');
    /** @type {{id: string, ring: {outer: string, inner?: string} | null, planes: {id: string, color: string, over?: string}[]} | null} */
    const read = await page.evaluate(`(${readRing})(${selectorOf})`);
    if (read === null || seen.has(read.id)) break;
    seen.add(read.id);
    if (read.ring === null || ringShortfalls(read.ring, read.planes).length > 0) findings.push({ rule: RULE, target: read.id });
  }
  return findings;
}
