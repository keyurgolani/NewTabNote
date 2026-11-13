/**
 * The announcement recorder (#24, "Announcements"): what a step makes the live regions say, read back
 * after it. It watches each region that announces, by its aria-live, else its role (a status or log
 * politely, an alert assertively) or an output, and when a region's text changes it records the
 * region's whole text, with the region and how it's announced. A region with aria-live="off", as the
 * AI transcript's log is, says nothing, and neither does text outside every region. It starts through
 * Playwright evaluation, which the extension's CSP doesn't apply to, and lasts until the page
 * navigates. A change that comes after the step resolves, from a timer say, needs the spec to wait.
 */

import { selectorOf } from './targets.mjs';

/**
 * How a live region announces, from its aria-live, else its role or tag, or null when it doesn't
 * @param {{live: string | null, role: string | null, tag: string}} region
 * @returns {'polite' | 'assertive' | null}
 */
export function politenessOf({ live, role, tag }) {
  if (live === 'polite' || live === 'assertive') return live;
  if (live === 'off') return null;
  if (role === 'alert') return 'assertive';
  return role === 'status' || role === 'log' || tag === 'output' ? 'polite' : null;
}

/**
 * In the page: starts recording into window.__ntnAnnouncements, once per document. It closes over
 * nothing, since it runs through evaluation.
 * @param {(el: Element) => string} selectorOf
 * @param {typeof politenessOf} politenessOf
 */
function install(selectorOf, politenessOf) {
  const scope = /** @type {any} */ (window);
  if (scope.__ntnAnnouncements) return;
  /** @type {{region: string, politeness: string, text: string}[]} */
  const said = (scope.__ntnAnnouncements = []);
  // The nearest region around a node that says something, or null when the nearest one is off
  const regionOf = (/** @type {Node} */ node) => {
    for (let el = node instanceof Element ? node : node.parentElement; el; el = el.parentElement) {
      const live = el.getAttribute('aria-live');
      const politeness = politenessOf({ live, role: el.getAttribute('role'), tag: el.localName });
      if (politeness !== null) return { el, politeness };
      if (live === 'off') return null;
    }
    return null;
  };
  new MutationObserver(records => {
    /** @type {Map<Element, string>} */
    const changed = new Map();
    for (const record of records) {
      const region = regionOf(record.target);
      if (region) changed.set(region.el, region.politeness);
    }
    for (const [el, politeness] of changed) {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) said.push({ region: selectorOf(el), politeness, text });
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
}

/**
 * Starts recording what the live regions on `page` say
 * @param {Pick<import('@playwright/test').Page, 'evaluate'>} page
 */
export async function recordAnnouncements(page) {
  await page.evaluate(`(${install})(${selectorOf}, ${politenessOf})`);
}

/**
 * What the live regions said since recording started or was last read, which it clears
 * @param {Pick<import('@playwright/test').Page, 'evaluate'>} page
 * @returns {Promise<{region: string, politeness: 'polite' | 'assertive', text: string}[]>}
 */
export async function readAnnouncements(page) {
  return page.evaluate('(window.__ntnAnnouncements ?? []).splice(0)');
}
