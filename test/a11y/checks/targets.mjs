/**
 * Hit boxes against #24's Targets (docs/accessibility/interaction-contract.md): every functional
 * pointer target is at least 44 by 44 CSS px, #16's `--target-min`, by its hit area. Three things are
 * exempt: the text-editing area as a whole, browser-owned UI, and a link in running text inside a
 * text block, as WCAG 2.5.5 and 2.5.8 exempt inline targets. A control inside a block isn't. The
 * browser check measures each target's box and says which exemption it has, if any.
 */

/** The smallest a target may be either way, in CSS px */
export const TARGET_MIN = 44;

/** The contract's exemptions */
export const EXEMPTIONS = Object.freeze(['editing-area', 'browser-ui', 'inline-link']);

/**
 * What a box may fall short by and still count as 44: floating-point error and nothing more. Layout
 * sizes boxes in 1/64 px steps and the matrix zooms by whole multiples, so a 44px box measures 44, give
 * or take float error, and the nearest box under it measures 43.984375, which fails.
 */
const FLOAT_ERROR = 1e-6;

/**
 * The targets that fall short: smaller than `min` either way, unless they carry one of the contract's
 * exemptions. An exemption the contract doesn't name exempts nothing.
 * @param {readonly {id: string, width: number, height: number, exempt?: string}[]} boxes
 * @param {number} [min]
 * @returns {{id: string, width: number, height: number}[]}
 */
export function smallTargets(boxes, min = TARGET_MIN) {
  return boxes
    .filter(box => !(box.exempt !== undefined && EXEMPTIONS.includes(box.exempt)))
    .filter(box => box.width < min - FLOAT_ERROR || box.height < min - FLOAT_ERROR)
    .map(({ id, width, height }) => ({ id, width, height }));
}

/** The rule a small hit box fails, apart from axe's own `target-size` at 24px */
export const RULE = 'ntn-target-size';

/**
 * In the page: a stable selector for `el`, its id if it has one, else its place under the nearest
 * ancestor with one. It runs through Playwright evaluation, so it closes over nothing.
 * @param {Element} el
 */
export function selectorOf(el) {
  const parts = [];
  for (let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    const twins = node.parentElement ? [...node.parentElement.children].filter(child => child.localName === node.localName) : [node];
    parts.unshift(twins.length > 1 ? `${node.localName}:nth-of-type(${twins.indexOf(node) + 1})` : node.localName);
  }
  return parts.join(' > ');
}

/**
 * In the page: each pointer target that's rendered and not hidden or inert, with its box (the label
 * that wraps a form control is its hit area), and its exemption, if it's the editing host as a whole
 * or a link in running text inside a text block. A target is a control by its tag, role or tab stop,
 * or an element that only takes clicks, which the pointer's cursor shows: the one the cursor starts
 * at, not a part that inherits it, and not one inside a target already counted. aria-hidden leaves
 * a target one, since the contract builds its pointer-only controls that way.
 * @param {(el: Element) => string} selectorOf
 */
function collectTargets(selectorOf) {
  const POINTER =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [tabindex]:not([tabindex="-1"])';
  const CLICKS = ['pointer', 'grab', 'grabbing'];
  const clicks = (/** @type {Element} */ el) => {
    const { cursor } = getComputedStyle(el);
    if (!CLICKS.includes(cursor) || el.localName === 'label' || el.parentElement?.closest(POINTER)) return false;
    return !el.parentElement || getComputedStyle(el.parentElement).cursor !== cursor;
  };
  return [...document.querySelectorAll('*')].filter(el => el.matches(POINTER) || clicks(el)).flatMap(el => {
    const style = getComputedStyle(el);
    if (el.closest('[inert], [hidden]') || style.visibility !== 'visible' || el.getClientRects().length === 0) return [];
    const { width, height } = (el.matches('input, select, textarea') ? (el.closest('label') ?? el) : el).getBoundingClientRect();
    let exempt;
    if (el instanceof HTMLElement && el.isContentEditable && !el.parentElement?.isContentEditable) exempt = 'editing-area';
    else if (el.matches('a[href]') && style.display === 'inline') {
      // Its text block is the nearest box that isn't inline: a p or li, or a note's div, its editing host
      let block = el.parentElement;
      while (block && ['inline', 'contents'].includes(getComputedStyle(block).display)) block = block.parentElement;
      if (block && block.textContent?.trim() !== el.textContent?.trim()) exempt = 'inline-link';
    }
    return [{ id: selectorOf(el), width, height, ...(exempt ? { exempt } : {}) }];
  });
}

/**
 * The hit boxes on `page` that fall short, as findings
 * @param {import('@playwright/test').Page} page
 */
export async function targetFindings(page) {
  /** @type {{id: string, width: number, height: number, exempt?: string}[]} */
  const boxes = await page.evaluate(`(${collectTargets})(${selectorOf})`);
  return smallTargets(boxes).map(({ id }) => ({ rule: RULE, target: id }));
}
