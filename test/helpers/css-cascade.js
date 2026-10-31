'use strict';

/**
 * The cascade on the root element, for the design token tests: which value each
 * custom property (and color-scheme) gets for a set of root attributes and media
 * features. Covers what css/design-tokens.css uses, before and after lightningcss:
 * :root with attribute and :not() selectors, @media with `and`, specificity,
 * source order, and !important. Anything else throws, so a generator change that
 * outgrows this model fails loudly instead of passing.
 */

const { parse, splitTopLevel } = require('../../scripts/css-parser.js');

const MEDIA_FEATURES = ['prefers-color-scheme', 'prefers-contrast', 'forced-colors', 'prefers-reduced-motion'];

/**
 * [attribute, value or null] for `[a]`, `[a="v"]`, `[a='v']`, `[a=v]`
 */
function attributeSelector(text) {
  const match = /^\[\s*([a-z][\w-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]$/i.exec(text);
  if (!match) throw new Error(`css-cascade: unsupported attribute selector ${text}`);
  const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4];
  return { name: match[1].toLowerCase(), value: value === undefined ? null : value };
}

/**
 * A compound selector on :root, as tests on the root's attributes plus a specificity
 */
function compileSelector(selector) {
  let rest = selector.trim();
  if (!rest.startsWith(':root')) throw new Error(`css-cascade: selector ${selector} isn't on :root`);
  rest = rest.slice(':root'.length);
  const tests = [];
  let specificity = 1;
  while (rest.length) {
    if (rest.startsWith('[')) {
      const end = rest.indexOf(']');
      const { name, value } = attributeSelector(rest.slice(0, end + 1));
      tests.push(attrs => (value === null ? name in attrs : attrs[name] === value));
      specificity += 1;
      rest = rest.slice(end + 1);
    } else if (rest.startsWith(':not(')) {
      const end = rest.indexOf(')');
      const { name, value } = attributeSelector(rest.slice(':not('.length, end).trim());
      tests.push(attrs => !(value === null ? name in attrs : attrs[name] === value));
      specificity += 1;
      rest = rest.slice(end + 1);
    } else {
      throw new Error(`css-cascade: unsupported selector ${selector}`);
    }
  }
  return { matches: attrs => tests.every(test => test(attrs)), specificity };
}

/**
 * A media query as a test on media features: `(feature: value)` terms joined by `and`
 */
function compileMedia(prelude) {
  const terms = prelude.split(/\s+and\s+/i).map(term => {
    const match = /^\(\s*([a-z-]+)\s*:\s*([a-z-]+)\s*\)$/i.exec(term.trim());
    if (!match || !MEDIA_FEATURES.includes(match[1].toLowerCase())) throw new Error(`css-cascade: unsupported media query ${prelude}`);
    return { feature: match[1].toLowerCase(), value: match[2].toLowerCase() };
  });
  return media => terms.every(({ feature, value }) => media[feature] === value);
}

/**
 * Compile a stylesheet into the declarations that can reach :root
 * @param {string} text
 */
function compileSheet(text) {
  const declarations = [];
  let order = 0;
  const visit = (nodes, mediaTests) => {
    for (const node of nodes) {
      if (node.type === 'at-rule') {
        if (node.name === 'media') visit(node.children, [...mediaTests, compileMedia(node.prelude)]);
        else if (node.name !== 'property' && node.name !== 'font-face') throw new Error(`css-cascade: unsupported @${node.name}`);
        continue;
      }
      if (node.children.length) throw new Error('css-cascade: nested rules aren\'t supported');
      const selectors = splitTopLevel(node.prelude).map(compileSelector);
      for (const declaration of node.declarations) {
        order += 1;
        declarations.push({ ...declaration, selectors, mediaTests, order });
      }
    }
  };
  visit(parse(text), []);
  return declarations;
}

/**
 * The computed value of every property the sheet sets on :root
 * @param {ReturnType<typeof compileSheet>} sheet
 * @param {Record<string, string>} attrs Root attributes
 * @param {Record<string, string>} media Media feature values
 * @returns {Record<string, string>}
 */
function computeRoot(sheet, attrs, media) {
  const winners = {};
  for (const declaration of sheet) {
    if (!declaration.mediaTests.every(test => test(media))) continue;
    const matching = declaration.selectors.filter(selector => selector.matches(attrs));
    if (matching.length === 0) continue;
    const specificity = Math.max(...matching.map(selector => selector.specificity));
    const rank = [declaration.important ? 1 : 0, specificity, declaration.order];
    const current = winners[declaration.property];
    const beats = !current || rank[0] > current.rank[0]
      || (rank[0] === current.rank[0] && (rank[1] > current.rank[1] || (rank[1] === current.rank[1] && rank[2] > current.rank[2])));
    if (beats) winners[declaration.property] = { rank, value: declaration.value };
  }
  const out = {};
  for (const [property, { value }] of Object.entries(winners)) out[property] = value;
  return out;
}

module.exports = { compileSheet, computeRoot, compileSelector, compileMedia };
