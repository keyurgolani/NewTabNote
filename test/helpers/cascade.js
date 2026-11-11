'use strict';

// A small cascade for the stylesheet contrast tests (#267). It reads the new tab's sheets through
// scripts/css-parser.js, the built-in themes' custom properties, and the value that wins a
// property on an element given as its path from the root, with the colors and ratios of
// js/design/contrast.js. A selector it reads is compounds of a tag, #id, .classes,
// [attribute] or [attribute="value"], :hover, and :not() of one simple selector, joined by spaces
// or `>`. It leaves out any other selector, and the rules inside at-rules.

const fs = require('node:fs');
const path = require('node:path');
const { parse, splitTopLevel } = require('../../scripts/css-parser.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (/** @type {string} */ file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
// The new tab's sheets in newtab.html's order
const NEW_TAB = ['css/editor.css', 'css/premium-chat.css', 'css/stats.css'];
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const SIMPLE = /^(?:(\*|[a-z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|:hover|:not\(([^()]*)\))/i;

/**
 * One compound, `div.row:hover` or `[data-type="file"]`, as tag, id, classes, attributes, hover and
 * the compounds :not() rules out, or null when it holds anything else
 * @param {string} text
 */
function compound(text) {
  const out = { tag: '', id: '', classes: /** @type {string[]} */ ([]), attrs: /** @type {[string, string | null][]} */ ([]), hover: false, not: /** @type {any[]} */ ([]) };
  let rest = text;
  while (rest) {
    const m = SIMPLE.exec(rest);
    if (!m) return null;
    if (m[1]) out.tag = m[1] === '*' ? '' : m[1].toLowerCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) out.attrs.push([m[4].toLowerCase(), m[5] === undefined ? null : m[5]]);
    else if (m[6] !== undefined) {
      const inner = compound(m[6].trim());
      if (!inner || inner.not.length) return null;
      out.not.push(inner);
    } else out.hover = true;
    rest = rest.slice(m[0].length);
  }
  return out;
}

/** A selector as its compounds, each with the combinator before it, or null */
function selector(/** @type {string} */ text) {
  const parts = text.replace(/\s*>\s*/g, ' > ').trim().split(/\s+/);
  const out = [];
  let combinator = ' ';
  for (const part of parts) {
    if (part === '>') { combinator = '>'; continue; }
    const c = compound(part);
    if (!c) return null;
    out.push({ ...c, combinator });
    combinator = ' ';
  }
  return out.length ? out : null;
}

/** [ids, classes, attributes, :hover and :not()'s argument, types] */
function specificity(/** @type {any[]} */ sel) {
  const add = (s, c) => [s[0] + (c.id ? 1 : 0), s[1] + c.classes.length + c.attrs.length + (c.hover ? 1 : 0), s[2] + (c.tag ? 1 : 0)];
  return sel.reduce((s, c) => c.not.reduce(add, add(s, c)), [0, 0, 0]);
}

/**
 * An element on a path, written as a compound: `div.sidebar-note-item.active:hover`
 * @param {string} text
 */
function el(text) {
  const c = compound(text);
  if (!c || c.not.length) throw new Error(`el: ${text} isn't one element`);
  return { tag: c.tag, id: c.id, classes: c.classes, attrs: new Map(c.attrs.map(([k, v]) => [k, v === null ? '' : v])), hover: c.hover };
}

const one = (e, c) => (!c.tag || e.tag === c.tag) && (!c.id || e.id === c.id) && c.classes.every((x) => e.classes.includes(x))
  && c.attrs.every(([k, v]) => e.attrs.has(k) && (v === null || e.attrs.get(k) === v)) && (!c.hover || e.hover) && !c.not.some((n) => one(e, n));

/** Whether `sel` matches the last element of `p`, its ancestors before it */
function matches(/** @type {any[]} */ p, /** @type {any[]} */ sel) {
  let at = p.length - 1;
  if (!one(p[at], sel[sel.length - 1])) return false;
  for (let k = sel.length - 2; k >= 0; k--) {
    const child = sel[k + 1].combinator === '>';
    let j = at - 1;
    if (child) { if (j < 0 || !one(p[j], sel[k])) return false; } else { while (j >= 0 && !one(p[j], sel[k])) j--; if (j < 0) return false; }
    at = j;
  }
  return true;
}

/**
 * The sheets' top-level rules in order, each selector read once, and the custom properties the
 * built-in themes give the page: :root's, and in dark the dark blocks' too, in cascade order
 * @param {string[]} [files]
 */
function sheets(files = NEW_TAB) {
  const rules = [];
  const tokens = { light: /** @type {Record<string, string>} */ ({}), dark: /** @type {Record<string, string>} */ ({}) };
  for (const file of files) {
    for (const node of parse(read(file))) {
      if (node.type !== 'rule') continue;
      const texts = splitTopLevel(node.prelude).map((s) => s.trim());
      const selectors = texts.map((text) => ({ text, sel: selector(text) })).filter((s) => s.sel).map((s) => ({ ...s, spec: specificity(s.sel) }));
      rules.push({ file, line: node.line, texts, selectors, declarations: node.declarations, order: rules.length });
      for (const { property, value } of node.declarations) {
        if (!property.startsWith('--')) continue;
        if (texts.includes(':root')) tokens.light[property] = tokens.dark[property] = value;
        if (texts.includes('[data-theme="dark"]')) tokens.dark[property] = value;
      }
    }
  }
  /**
   * The value that wins `property` on the last element of `p`, and the rule it's in; `background`
   * reads `background-color` too
   */
  const winner = (/** @type {any[]} */ p, /** @type {string} */ property) => {
    const names = property === 'background' ? ['background', 'background-color'] : [property];
    const later = (a, b) => a.spec[0] - b.spec[0] || a.spec[1] - b.spec[1] || a.spec[2] - b.spec[2] || a.order - b.order;
    let best = null;
    for (const rule of rules) {
      const decl = rule.declarations.filter((d) => names.includes(d.property)).pop();
      if (!decl) continue;
      for (const s of rule.selectors) {
        const found = { value: decl.value.trim(), spec: s.spec, order: rule.order, rule, text: s.text };
        if (matches(p, s.sel) && (!best || later(found, best) > 0)) best = found;
      }
    }
    return best;
  };
  /** The custom properties in `names` that the last element of `p` inherits or sets, by the rules alone */
  const vars = (/** @type {any[]} */ p, /** @type {string[]} */ names) => {
    /** @type {Record<string, string>} */
    const out = {};
    for (const name of names) {
      for (let i = p.length; i > 0 && !(name in out); i--) {
        const w = winner(p.slice(0, i), name);
        if (w) out[name] = w.value;
      }
    }
    return out;
  };
  return { rules, tokens, winner, vars, rule: (/** @type {string} */ text) => rules.find((r) => r.texts.includes(text)) };
}

/**
 * Colors on the themes' tokens with `C`, js/design/contrast.js
 * @param {any} C
 * @param {{light: Record<string, string>, dark: Record<string, string>}} tokens
 */
function colors(C, tokens) {
  /** `value` with each var() replaced by `inline`'s value, else the theme's, else its fallback */
  const resolve = (/** @type {string} */ value, /** @type {'light' | 'dark'} */ theme, inline = {}, depth = 0) => {
    if (depth > 8) throw new Error(`${value} nests too deep`);
    const out = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*(?:\([^()]*\))*[^()]*\))*))?\)/g, (_, name, fallback) => {
      const found = name in inline ? inline[name] : tokens[theme][name];
      if (found !== undefined && found !== 'initial') return found;
      if (fallback === undefined) throw new Error(`${name} has no ${theme} value and no fallback`);
      return fallback.trim();
    });
    return out.includes('var(') ? resolve(out, theme, inline, depth + 1) : out.trim();
  };
  /** A resolved color: hex, rgb(), white, transparent, or color-mix() in srgb, mixed premultiplied as CSS does */
  const colorOf = (/** @type {string} */ text) => {
    const value = text.trim().toLowerCase();
    if (value === 'transparent' || value === 'none') return { r: 0, g: 0, b: 0, a: 0 };
    if (value === 'white') return { ...WHITE };
    const mix = /^color-mix\(\s*in\s+srgb\s*,(.*)\)$/.exec(value);
    if (mix) {
      const [first, second] = splitTopLevel(mix[1]).map((s) => s.trim());
      const share = /^(.*?)\s+(\d*\.?\d+)%$/.exec(first);
      if (!share) throw new Error(`${value} names no share for its first color`);
      const p = Number(share[2]) / 100;
      const [x, y] = [colorOf(share[1]), colorOf(second)];
      const a = x.a * p + y.a * (1 - p);
      const ch = (/** @type {'r' | 'g' | 'b'} */ k) => (a === 0 ? 0 : (x[k] * x.a * p + y[k] * y.a * (1 - p)) / a);
      return { r: ch('r'), g: ch('g'), b: ch('b'), a };
    }
    const color = C.parseColor(value);
    if (!color) throw new Error(`${value} isn't a color this reads`);
    return color;
  };
  const token = (/** @type {string} */ name, /** @type {'light' | 'dark'} */ theme) => colorOf(resolve(`var(${name})`, theme));
  /** The ratio of `fg` on `bg`, with `bg` over `under` where it's translucent */
  const ratio = (fg, bg, under = WHITE) => C.contrastRatio(fg, C.compositeOver(bg, under));
  return { resolve, colorOf, token, ratio };
}

// Floored, as js/design/contrast.js prints ratios, so a failing one never prints as the bar
const shown = (/** @type {number} */ value) => (Math.floor(value * 100) / 100).toFixed(2);

module.exports = { ROOT, NEW_TAB, WHITE, read, sheets, colors, el, selector, matches, shown };
