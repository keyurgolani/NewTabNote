'use strict';

// #268: the accent is two blues. The ink draws text, icons, rings and marks, and the fill sits
// under white text and white marks. In the built-in light and dark themes each meets WCAG 2.2 AA
// where it's drawn, judged unrounded: the ink at 4.5:1 on the four surfaces and on any accent tint
// under it, over each surface that tint sits on, the focus ring at 3:1 on the surfaces, and white
// at 4.5:1 on the fill and on its hover. Every rule that paints white over the accent paints it on
// the fill. On a sidebar row, in each state the row takes, its grey preview holds 4.5:1 and a
// checked box's edge 3:1 (#268).

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

// A tint of the accent: its token, the selection, or the ink mixed with transparent or at an
// alpha, or made opaque on a surface, mixed into it or stacked over it
const TINT =
  /^(?:var\(--(?:accent-tint|selection-bg)\)|color-mix\(in srgb, var\(--accent-color\) [\d.]+%, (?:transparent|var\(--bg-[\w-]+\))\)|rgba\(var\(--accent-rgb\), ?[\d.]+\)|linear-gradient\(var\(--accent-tint\), var\(--accent-tint\)\), var\(--bg-[\w-]+\))$/;
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

/**
 * A background as it paints: a tint stacked on a surface (`linear-gradient(T, T), S`) is T over S,
 * and anything else its resolved color, translucent or not
 * @param {string} background
 * @param {'light' | 'dark'} theme
 */
function paintOf(background, theme) {
  const layered = /^linear-gradient\((.*)\),\s*(.+)$/.exec(background.trim());
  if (!layered) return colorOf(resolve(background, theme));
  const [top] = splitTopLevel(layered[1]).map((part) => part.trim());
  return C.compositeOver(colorOf(resolve(top, theme)), colorOf(resolve(layered[2], theme)));
}

/**
 * A sidebar row in each state it takes, over the sidebar, as editor.css paints it
 * @param {'light' | 'dark'} theme
 */
function rowStates(theme) {
  const sidebar = token('--bg-secondary', theme);
  const states = [{ name: 'a plain row', color: sidebar }];
  for (const [name, selector] of [
    ['a hovered row', '.sidebar-note-item:hover'],
    ['the active row', '.sidebar-note-item.active'],
    ['a drop target', '.sidebar-note-item.sidebar-drop-target'],
  ]) {
    const rule = ruleFor('css/editor.css', selector);
    const background = rule && valueOf(rule, 'background');
    assert.ok(background, `css/editor.css: ${selector}'s background`);
    states.push({ name, selector, color: C.compositeOver(paintOf(background, theme), sidebar) });
  }
  return states;
}

/**
 * What a pair sits on: the avatar on the user card's tint over the chat, a part of a sidebar row
 * on each state of its row, and the rest on the sidebar
 * @param {string} file
 * @param {string} selector
 * @param {'light' | 'dark'} theme
 */
function surfacesUnder(file, selector, theme) {
  const sidebar = token('--bg-secondary', theme);
  if (file === 'css/premium-chat.css' && /^\.user-avatar(?![\w-])/.test(selector)) {
    const card = ruleFor('css/premium-chat.css', '.user-request-card');
    const background = card && valueOf(card, 'background');
    assert.ok(background, "css/premium-chat.css: .user-request-card's background");
    return [{ name: 'the user card', color: C.compositeOver(paintOf(background, theme), sidebar) }];
  }
  if (/^\.sidebar-note-(?!item)/.test(selector)) return rowStates(theme);
  return [{ name: 'the sidebar', color: sidebar }];
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

  it('keeps accent text at 4.5:1 on every accent tint under it, at rest and in each state, on each surface it sits on', () => {
    const pairs = accentTextOnTints();
    // Today's four, so the walker can't pass by finding none
    for (const [file, selector] of [
      ['css/editor.css', '.settings-nav-item.active'],
      ['css/editor.css', '.sidebar-drop-zone-new'],
      ['css/editor.css', '.sidebar-note-progress'],
      ['css/premium-chat.css', '.user-avatar'],
    ]) {
      assert.ok(pairs.some((p) => p.file === file && p.selector === selector), `${file}: ${selector} draws accent text on a tint`);
    }
    const misses = [];
    for (const theme of THEMES) {
      const ink = token('--accent-color', theme);
      for (const { file, selector, color, background } of pairs) {
        const text = colorOf(resolve(color, theme));
        const tint = paintOf(background, theme);
        for (const surface of surfacesUnder(file, selector, theme)) {
          const value = C.contrastRatio(text, C.compositeOver(tint, surface.color));
          if (value >= 4.5) continue;
          const how = tint.a < 1 ? `a ${tint.a.toFixed(3)} tint ${shown(value)}, above the ${ceiling(ink, surface.color).toFixed(3)} the ink holds` : `its opaque mix ${shown(value)}`;
          misses.push(`${theme}: ${file} ${selector} on ${surface.name}, the ink on ${how}`);
        }
      }
    }
    assert.deepEqual(misses, []);
  });

  it("keeps a sidebar row's grey preview at 4.5:1 on the active row and on a drop target", () => {
    const misses = [];
    const rest = ruleFor('css/editor.css', '.sidebar-note-preview');
    assert.ok(rest && valueOf(rest, 'color'), "css/editor.css: .sidebar-note-preview's color");
    for (const theme of THEMES) {
      for (const row of rowStates(theme).filter((state) => state.selector && !state.selector.endsWith(':hover'))) {
        const own = ruleFor('css/editor.css', `${row.selector} .sidebar-note-preview`);
        const color = (own && valueOf(own, 'color')) || valueOf(rest, 'color');
        const value = C.contrastRatio(colorOf(resolve(color, theme)), row.color);
        if (value < 4.5) misses.push(`${theme}: .sidebar-note-preview on ${row.name}, ${color} ${shown(value)}`);
      }
    }
    assert.deepEqual(misses, []);
  });

  it("keeps a checked box's edge at 3:1 on each state of its row", () => {
    const rule = ruleFor('css/editor.css', '.sidebar-note-checkbox.checked');
    const edge = rule && valueOf(rule, 'border-color');
    assert.ok(edge, "css/editor.css: .sidebar-note-checkbox.checked's border-color");
    const misses = [];
    for (const theme of THEMES) {
      // Selection mode turns dragging off, so a checked box never sits on a drop target
      for (const row of rowStates(theme).filter((state) => state.name !== 'a drop target')) {
        const value = C.contrastRatio(colorOf(resolve(edge, theme)), row.color);
        if (value < 3) misses.push(`${theme}: the checked box's edge, ${edge}, on ${row.name} ${shown(value)}`);
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

// The engine injects the built-in themes' values inline. A switch takes off what it set for the
// theme before, so the root reads as on a page opened on the new theme, and leaves the inline
// styles other code set. A theme saved before the split has no fill, and draws its fills in its
// own accent.
describe("the theme engine's switch (js/theme-engine.js)", () => {
  /**
   * The engine on a page whose root records its inline properties
   * @param {object[]} [themes] the custom themes the settings port holds
   */
  function page(themes = []) {
    const env = createLegacyEnv();
    env.load('js/theme-engine.js');
    /** @type {Map<string, string>} */
    const inline = new Map();
    const root = env.document.documentElement;
    // Listed as a CSSStyleDeclaration lists them, so an engine that cleared every inline property would run here
    root.style = {
      get length() { return inline.size; },
      item: (/** @type {number} */ index) => [...inline.keys()][index] || '',
      setProperty: (/** @type {string} */ key, /** @type {string} */ value) => { inline.set(key, String(value)); },
      removeProperty: (/** @type {string} */ key) => { const value = inline.get(key) || ''; inline.delete(key); return value; },
      getPropertyValue: (/** @type {string} */ key) => inline.get(key) || '',
    };
    const Themes = env.get('Themes');
    Themes.connect({ settings: { themes: async () => themes, preferencesOr: async (/** @type {object} */ fallback) => fallback } });
    // The theme the stylesheets draw: the data-theme the engine left on the root
    const scheme = () => /** @type {'light' | 'dark'} */ (root.attributes['data-theme'] === 'dark' ? 'dark' : 'light');
    return { Themes, inline, scheme };
  }
  const EMBER = { id: 'custom-ember', name: 'Ember', properties: { '--bg-primary': '#fffaf5', '--accent-color': '#b5442b', '--sidebar-tint': '#f3e9e0' } };
  const MOSS = { id: 'custom-moss', name: 'Moss', properties: { '--bg-primary': '#1b1f1a', '--accent-color': '#8fbf7a', '--accent-fill': '#2f6b3a' } };

  it("injects the stylesheets' own value for each key, in light and dark", () => {
    const { Themes } = page();
    const misses = [];
    for (const [theme, set] of /** @type {const} */ ([['light', Themes.defaultProperties], ['dark', Themes.darkProperties]])) {
      for (const [key, value] of Object.entries(set)) {
        const sheet = PAGE[theme][key];
        if (sheet === undefined || !sameColor(colorOf(value), colorOf(resolve(sheet, theme)))) misses.push(`${theme}: ${key} is ${value}, the stylesheets' ${sheet}`);
      }
    }
    assert.deepEqual(misses, []);
  });

  it('leaves the root as a page opened on the new theme has it, with the inline styles other code set', async () => {
    const misses = [];
    for (const [from, to] of [['light', 'dark'], ['dark', 'light'], [EMBER.id, 'light'], ['light', EMBER.id], [EMBER.id, MOSS.id]]) {
      const { Themes, inline } = page([EMBER, MOSS]);
      inline.set('--set-before', '12px');
      await Themes.applyTheme(from);
      inline.set('--set-between', '1.25');
      await Themes.applyTheme(to);
      const opened = page([EMBER, MOSS]);
      await opened.Themes.applyTheme(to);
      const want = new Map([...opened.inline, ['--set-before', '12px'], ['--set-between', '1.25']]);
      const left = [...inline.keys()].filter((key) => !want.has(key));
      const lost = [...want.keys()].filter((key) => inline.get(key) !== want.get(key));
      if (left.length || lost.length) misses.push(`${from} then ${to}: left ${left.join(', ') || 'nothing'}; lost or changed ${lost.join(', ') || 'nothing'}`);
    }
    assert.deepEqual(misses, []);
  });

  it('draws the fills of a saved theme without --accent-fill in its own accent, and keeps a saved fill', async () => {
    const button = ruleFor('css/editor.css', '.primary-btn');
    assert.ok(button, '.primary-btn');
    const misses = [];
    for (const [theme, want] of /** @type {const} */ ([[EMBER, '#b5442b'], [MOSS, '#2f6b3a']])) {
      const saved = JSON.stringify(theme);
      const { Themes, inline, scheme } = page([theme]);
      await Themes.applyTheme(theme.id);
      const drawn = colorOf(resolve(valueOf(button, 'background') || '', scheme(), Object.fromEntries(inline)));
      if (inline.get('--accent-fill') !== want) misses.push(`${theme.name}: --accent-fill is ${inline.get('--accent-fill')} inline, not ${want}`);
      if (!sameColor(drawn, colorOf(want))) misses.push(`${theme.name}: .primary-btn draws rgb(${drawn.r}, ${drawn.g}, ${drawn.b}), not ${want}`);
      if (JSON.stringify(theme) !== saved) misses.push(`${theme.name}: the saved theme changed`);
    }
    assert.deepEqual(misses, []);
  });
});
