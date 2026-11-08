'use strict';

// #268: the accent is two blues. The ink draws text, icons, rings and marks, and the fill sits
// under white text and white marks. In the built-in light and dark themes each meets WCAG 2.2 AA
// where it's drawn, judged unrounded: the ink at 4.5:1 on the four surfaces and on any accent tint
// under it, the focus ring at 3:1 on the surfaces, and white at 4.5:1 on the fill and on its
// hover. Every rule that paints white over the accent paints it on the fill.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parse, splitTopLevel } = require('../scripts/css-parser.js');
const { createLegacyEnv } = require('./helpers/legacy-env');

const ROOT = path.join(__dirname, '..');
const read = (/** @type {string} */ file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** @type {typeof import('../js/design/contrast.js')} */
let C;
before(async () => {
  C = await import('../js/design/contrast.js');
});

const THEMES = /** @type {const} */ (['light', 'dark']);
const SURFACES = ['--bg-primary', '--bg-secondary', '--bg-hover', '--bg-active'];
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
// The new tab loads editor.css, then premium-chat.css (newtab.html)
const SHEETS = ['css/editor.css', 'css/premium-chat.css'];

/**
 * A sheet's style rules, each with its selectors, and whether an at-rule holds it
 * @param {string} text
 */
function rulesOf(text) {
  /** @type {{selectors: string[], declarations: {property: string, value: string}[], nested: boolean}[]} */
  const out = [];
  const visit = (/** @type {any[]} */ nodes, /** @type {boolean} */ nested) => {
    for (const node of nodes) {
      if (node.type === 'rule') out.push({ selectors: splitTopLevel(node.prelude).map((s) => s.trim()), declarations: node.declarations, nested });
      visit(node.children || [], true);
    }
  };
  visit(parse(text), false);
  return out;
}

/** The last value a rule gives a property, `background` reading `background-color` too */
function valueOf(/** @type {{declarations: {property: string, value: string}[]}} */ rule, /** @type {string} */ property) {
  const names = property === 'background' ? ['background', 'background-color'] : [property];
  const found = rule.declarations.filter((d) => names.includes(d.property));
  return found.length ? found[found.length - 1].value.trim() : undefined;
}

const RULES = Object.fromEntries(SHEETS.map((file) => [file, rulesOf(read(file))]));
const TOP = Object.fromEntries(SHEETS.map((file) => [file, RULES[file].filter((r) => !r.nested)]));
const ruleFor = (/** @type {string} */ file, /** @type {string} */ selector) => TOP[file].find((r) => r.selectors.includes(selector));

/** The custom properties the built-in themes give the page: :root's, and in dark the dark blocks' too, in cascade order */
const PAGE = { light: /** @type {Record<string, string>} */ ({}), dark: /** @type {Record<string, string>} */ ({}) };
for (const file of SHEETS) {
  for (const rule of TOP[file]) {
    for (const { property, value } of rule.declarations) {
      if (!property.startsWith('--')) continue;
      if (rule.selectors.includes(':root')) PAGE.light[property] = PAGE.dark[property] = value;
      if (rule.selectors.includes('[data-theme="dark"]')) PAGE.dark[property] = value;
    }
  }
}

/**
 * `value` with each var() replaced by `inline`'s value, else the page's for the theme, else its fallback
 * @param {string} value
 * @param {'light' | 'dark'} theme
 * @param {Record<string, string>} [inline]
 * @returns {string}
 */
function resolve(value, theme, inline = {}, depth = 0) {
  assert.ok(depth < 8, `${value} nests too deep`);
  const out = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (_, name, fallback) => {
    const found = name in inline ? inline[name] : PAGE[theme][name];
    if (found !== undefined) return found;
    assert.ok(fallback !== undefined, `${name} has no ${theme} value and no fallback`);
    return fallback.trim();
  });
  return out.includes('var(') ? resolve(out, theme, inline, depth + 1) : out.trim();
}

/**
 * A resolved color: hex, rgb(), white, transparent, or a color-mix() of those in srgb, which
 * mixes premultiplied as CSS does
 * @param {string} text
 * @returns {{r: number, g: number, b: number, a: number}}
 */
function colorOf(text) {
  const value = text.trim().toLowerCase();
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (value === 'white') return { ...WHITE };
  const mix = /^color-mix\(\s*in\s+srgb\s*,(.*)\)$/.exec(value);
  if (mix) {
    const [first, second] = splitTopLevel(mix[1]).map((part) => part.trim());
    const share = /^(.*?)\s+(\d*\.?\d+)%$/.exec(first);
    assert.ok(share, `${value} names no share for its first color`);
    const p = Number(share[2]) / 100;
    const [x, y] = [colorOf(share[1]), colorOf(second)];
    const a = x.a * p + y.a * (1 - p);
    const channel = (/** @type {'r' | 'g' | 'b'} */ k) => (a === 0 ? 0 : (x[k] * x.a * p + y[k] * y.a * (1 - p)) / a);
    return { r: channel('r'), g: channel('g'), b: channel('b'), a };
  }
  const color = C.parseColor(value);
  assert.ok(color, `${value} isn't a color this reads`);
  return color;
}

/** The ratio of `fg` on `bg`, with `bg` over `under` where it's translucent */
const ratio = (fg, bg, under = WHITE) => C.contrastRatio(fg, C.compositeOver(bg, under));
const token = (/** @type {string} */ name, /** @type {'light' | 'dark'} */ theme) => colorOf(resolve(`var(${name})`, theme));
const sameColor = (a, b) => ['r', 'g', 'b', 'a'].every((k) => Math.abs(a[k] - b[k]) < 1e-6);
// Floored, as js/design/contrast.js prints ratios, so a failing one never prints as the bar
const shown = (/** @type {number} */ value) => (Math.floor(value * 100) / 100).toFixed(2);

/** The strongest tint of `ink` that keeps `ink` at 4.5:1 on it over `under`: 0 when the ink fails bare */
function ceiling(ink, under) {
  let [lo, hi] = [0, 1];
  if (ratio(ink, under) < 4.5) return 0;
  for (let i = 0; i < 40; i++) {
    const p = (lo + hi) / 2;
    if (ratio(ink, { ...ink, a: p }, under) >= 4.5) lo = p;
    else hi = p;
  }
  return lo;
}

// A tint of the accent: its token, the selection, or the ink mixed with transparent or at an alpha
const TINT = /^(?:var\(--(?:accent-tint|selection-bg)\)|color-mix\(in srgb, var\(--accent-color\) [\d.]+%, transparent\)|rgba\(var\(--accent-rgb\), ?[\d.]+\))$/;
// Accent text: the ink, by its token or its channels
const INK = /^(?:var\(--accent-color(?:, ?#[\da-f]+)?\)|rgb\(var\(--accent-rgb\)\))$/i;
// The states the census reads: a state rule takes what it doesn't set from the rules it qualifies
const STATE = /:(?:hover|active|focus-visible|focus-within|focus)(?![\w-])|\.(?:active|selected|checked|today|pinned)(?![\w-])|\[aria-selected="?true"?\]/g;

/** The selector with some of its states taken off, each with how many it keeps, most first */
function qualified(/** @type {string} */ selector) {
  const states = [...selector.matchAll(STATE)];
  const out = [];
  for (let keep = (1 << states.length) - 2; keep >= 0; keep--) {
    let text = selector;
    for (let i = states.length - 1; i >= 0; i--) {
      if (!(keep & (1 << i))) text = text.slice(0, states[i].index) + text.slice(states[i].index + states[i][0].length);
    }
    out.push({ kept: keep.toString(2).split('1').length - 1, selector: text.replace(/\s+/g, ' ').trim() });
  }
  return out.filter((c) => c.selector).sort((a, b) => b.kept - a.kept);
}

/** Every rule in the sheets that draws accent text on an accent tint, at rest or in a state */
function accentTextOnTints() {
  const pairs = [];
  for (const file of SHEETS) {
    // What a state rule leaves unset comes from the nearest rule it qualifies: the most states
    // kept, then the last in the sheet, as the cascade picks between them
    const inherited = (/** @type {string} */ selector, /** @type {string} */ property) => {
      let best;
      for (const { kept, selector: rest } of qualified(selector)) {
        if (best && kept < best.kept) break;
        TOP[file].forEach((r, at) => {
          const value = r.selectors.includes(rest) ? valueOf(r, property) : undefined;
          if (value && (!best || at > best.at)) best = { kept, at, value };
        });
      }
      return best && best.value;
    };
    for (const rule of TOP[file]) {
      const [background, color] = [valueOf(rule, 'background'), valueOf(rule, 'color')];
      if (!background && !color) continue;
      for (const selector of rule.selectors) {
        const pair = { file, selector, background: background || inherited(selector, 'background'), color: color || inherited(selector, 'color') };
        if (pair.background && pair.color && TINT.test(pair.background) && INK.test(pair.color)) pairs.push(pair);
      }
    }
  }
  return pairs;
}

describe('the accent on the built-in themes (css/editor.css, css/premium-chat.css)', () => {
  it('carries white at 4.5:1 on the fill and on its hover, in light and dark', () => {
    const misses = [];
    for (const theme of THEMES) {
      // A page with no fill token draws its fills with the ink
      const fill = '--accent-fill' in PAGE[theme] ? '--accent-fill' : '--accent-color';
      for (const name of [fill, '--accent-hover']) {
        const value = ratio(WHITE, token(name, theme));
        if (value < 4.5) misses.push(`${theme}: white on ${name} ${shown(value)}`);
      }
    }
    assert.deepEqual(misses, []);
  });

  it('draws the ink at 4.5:1 on each of the four surfaces, in light and dark', () => {
    const misses = [];
    for (const theme of THEMES) {
      for (const surface of SURFACES) {
        const value = ratio(token('--accent-color', theme), token(surface, theme));
        if (value < 4.5) misses.push(`${theme}: the ink on ${surface} ${shown(value)}`);
      }
    }
    assert.deepEqual(misses, []);
  });

  it('draws the focus ring at 3:1 on each of the four surfaces, in light and dark', () => {
    const ring = ruleFor('css/editor.css', ':focus-visible');
    assert.ok(ring, 'the :focus-visible rule');
    const color = splitTopLevel(valueOf(ring, 'outline') || '', ' ').map((s) => s.trim()).find((part) => /^(?:var\(|#|rgb)/.test(part));
    assert.ok(color, "the ring's color");
    const misses = [];
    for (const theme of THEMES) {
      for (const surface of SURFACES) {
        const value = ratio(colorOf(resolve(color, theme)), token(surface, theme));
        if (value < 3) misses.push(`${theme}: the ring on ${surface} ${shown(value)}`);
      }
    }
    assert.deepEqual(misses, []);
  });

  it('keeps the fill and its hover at 3:1 from the dark surfaces under them', () => {
    const misses = [];
    for (const name of ['--accent-fill', '--accent-hover'].filter((n) => n in PAGE.dark)) {
      for (const surface of ['--bg-primary', '--bg-secondary']) {
        const value = ratio(token(name, 'dark'), token(surface, 'dark'));
        if (value < 3) misses.push(`dark: ${name}'s edge on ${surface} ${shown(value)}`);
      }
    }
    assert.deepEqual(misses, []);
  });

  it('keeps accent text at 4.5:1 on every accent tint under it, at rest and in each state, over the sidebar', () => {
    const pairs = accentTextOnTints();
    // Today's three, so the walker can't pass by finding none
    for (const [file, selector] of [['css/editor.css', '.settings-nav-item.active'], ['css/editor.css', '.sidebar-drop-zone-new'], ['css/premium-chat.css', '.user-avatar']]) {
      assert.ok(pairs.some((p) => p.file === file && p.selector === selector), `${file}: ${selector} draws accent text on a tint`);
    }
    const misses = [];
    for (const theme of THEMES) {
      const under = token('--bg-secondary', theme);
      const most = ceiling(token('--accent-color', theme), under);
      for (const { file, selector, color, background } of pairs) {
        const tint = colorOf(resolve(background, theme));
        const value = ratio(colorOf(resolve(color, theme)), tint, under);
        if (value < 4.5) misses.push(`${theme}: ${file} ${selector}, the ink on a ${tint.a.toFixed(3)} tint ${shown(value)}, above the ${most.toFixed(3)} the ink holds`);
      }
    }
    assert.deepEqual(misses, []);
  });

  it("gives --accent-rgb the ink's channels in both themes, on the page and in each sheet's copies", () => {
    for (const theme of THEMES) {
      const ink = token('--accent-color', theme);
      const want = `${ink.r}, ${ink.g}, ${ink.b}`;
      assert.equal(PAGE[theme]['--accent-rgb'], want, `the page, ${theme}`);
      for (const file of SHEETS) {
        const copies = TOP[file].filter((r) => r.selectors.includes(theme === 'light' ? ':root' : '[data-theme="dark"]')).map((r) => valueOf(r, '--accent-rgb')).filter(Boolean);
        for (const value of copies) assert.equal(value, want, `${file}, ${theme}`);
      }
    }
  });
});

// The rules that paint white text or a white mark over the accent: each paints it on the fill
const FILLS = [
  ['css/editor.css', '.skip-to-content'],
  ['css/editor.css', '.block[data-type="todo"].checked .todo-checkbox'],
  ['css/editor.css', '.toggle-switch input:checked+.toggle-slider'],
  ['css/editor.css', '.block[data-type="file"] .file-download:hover'],
  ['css/editor.css', '.primary-btn'],
  ['css/editor.css', '.width-selector-header .width-option.active'],
  ['css/editor.css', '.calendar-day.selected'],
  ['css/editor.css', '.sidebar-tab-badge'],
  ['css/editor.css', '.ai-chat-message.user'],
  ['css/editor.css', '.ai-retry-btn'],
  ['css/editor.css', '.ai-chat-send-btn'],
  ['css/editor.css', '.ai-floating-btn'],
  ['css/editor.css', '.onboarding-btn-next'],
  ['css/editor.css', '.global-chat-source-tag:hover'],
  ['css/editor.css', '.note-insights-tag:hover'],
  ['css/editor.css', '.sidebar-note-checkbox.checked'],
  ['css/editor.css', '.export-notice .primary-btn.export-notice-btn'],
  ['css/premium-chat.css', '.scroll-fab-badge'],
];
// The ink as a background, by its token or its channels, or today's blue
const ON_INK = /var\(--accent-color\b|rgb\(var\(--accent-rgb\)\)|#2383e2/i;
const isWhite = (/** @type {string | undefined} */ value) => /^(?:white|#fff|#ffffff)$/i.test(value || '');

describe('white over the accent sits on the fill', () => {
  it('paints each fill that carries white with --accent-fill, edges included', () => {
    const misses = [];
    for (const [file, selector] of FILLS) {
      const rule = ruleFor(file, selector);
      assert.ok(rule, `${file}: ${selector}`);
      for (const { property, value } of rule.declarations) {
        if (/^(?:background(?:-color)?|border-color)$/.test(property) && !/^var\(--accent-fill\b/.test(value)) misses.push(`${file}: ${selector} ${property}: ${value}`);
      }
    }
    assert.deepEqual(misses, []);
  });

  it('has no other rule that paints white on the ink', () => {
    const listed = new Set(FILLS.map(([file, selector]) => `${file} ${selector}`));
    const found = [];
    for (const file of SHEETS) {
      for (const rule of RULES[file]) {
        if (isWhite(valueOf(rule, 'color')) && ON_INK.test(valueOf(rule, 'background') || '') && !rule.selectors.some((s) => listed.has(`${file} ${s}`))) found.push(`${file}: ${rule.selectors.join(', ')}`);
      }
    }
    assert.deepEqual(found, []);
  });

  it("draws the continue button as the app's filled button, its rules painting none of it", () => {
    const classes = /continueBtn\.className = '([^']*)'/.exec(read('js/controllers/ai-chat-controller.js'));
    assert.ok(classes, "the continue button's classes");
    assert.ok(classes[1].split(' ').includes('primary-btn'), `the continue button's classes are ${classes[1]}`);
    const own = TOP['css/premium-chat.css'].filter((r) => r.selectors.some((s) => s.startsWith('.response-incomplete .continue-btn')));
    assert.ok(own.length, "the continue button's rules");
    const painted = own.flatMap((r) => r.declarations.filter((d) => /^(?:background(?:-color)?|color|border(?:-color)?)$/.test(d.property)).map((d) => `${r.selectors.join(', ')} ${d.property}: ${d.value}`));
    assert.deepEqual(painted, []);
  });

  it("paints the confirm dialog's and the toolbar's white on the fill, each fallback the light theme's value", () => {
    const env = createLegacyEnv();
    env.load('js/ui/confirm-dialog.js', 'js/ui/formatting-toolbar.js');
    const misses = [];
    for (const id of ['confirm-dialog-styles', 'formatting-toolbar-styles']) {
      const sheet = env.document.getElementById(id);
      assert.ok(sheet, id);
      for (const rule of rulesOf(sheet.textContent)) {
        const where = `${id}: ${rule.selectors.join(', ')}`;
        if (isWhite(valueOf(rule, 'color')) && ON_INK.test(valueOf(rule, 'background') || '')) misses.push(`${where} paints white on ${valueOf(rule, 'background')}`);
        for (const { value } of rule.declarations) {
          for (const [, name, fallback] of value.matchAll(/var\((--accent-[\w-]+),\s*([^)]+)\)/g)) {
            if (!(name in PAGE.light)) misses.push(`${where}: ${name} has no light value`);
            else if (!sameColor(colorOf(fallback), token(name, 'light'))) misses.push(`${where}: ${name} falls back to ${fallback.trim()}, light's is ${PAGE.light[name]}`);
          }
        }
      }
    }
    assert.deepEqual(misses, []);
  });
});
