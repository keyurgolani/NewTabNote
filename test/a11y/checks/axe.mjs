/**
 * axe over a page (#24, "Check library"): @axe-core/playwright, pinned at 4.14.0, with #29's tags. It
 * injects axe through Playwright evaluation, which an extension page's CSP doesn't apply to, so nothing
 * is added to the extension under test. Each node a rule fails is a finding: the rule, and the node's
 * target, its selectors through frames and shadow roots joined by ` >>> `.
 */

import { AxeBuilder } from '@axe-core/playwright';

/** #29's tags (PR CI, "test/a11y/baseline.json") */
export const TAGS = Object.freeze(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);

/**
 * @param {{violations: readonly {id: string, nodes: readonly {target: readonly unknown[]}[]}[]}} results
 * @returns {{rule: string, target: string}[]}
 */
export function axeFindings(results) {
  return results.violations.flatMap(({ id, nodes }) => nodes.map(({ target }) => ({ rule: id, target: target.flat(Infinity).join(' >>> ') })));
}

/**
 * axe's findings on `page` as it is now
 * @param {import('@playwright/test').Page} page
 */
export async function axeOn(page) {
  return axeFindings(await new AxeBuilder({ page }).withTags([...TAGS]).analyze());
}
