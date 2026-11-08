'use strict';

// #267: the muted grays. In the built-in light and dark themes, judged unrounded, muted text holds
// 4.5:1 and a muted icon 3:1 where it's drawn: Settings' section headings and the sidebar
// footer's icons, which take the secondary gray; muted text on the page and on the sidebar; and
// the two muted labels on a bg-hover chip, which take secondary.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { sheets, colors, el, read, shown } = require('./helpers/cascade');

const THEMES = /** @type {const} */ (['light', 'dark']);
const S = sheets();
/** @type {any} */
let C;
/** @type {ReturnType<typeof colors>} */
let K;
before(async () => {
  C = await import('../js/design/contrast.js');
  K = colors(C, S.tokens);
});

/** A path from the root in `theme`, each element written as a compound */
const at = (/** @type {'light' | 'dark'} */ theme, /** @type {string[]} */ elements) =>
  [el(theme === 'dark' ? 'html[data-theme="dark"]' : 'html'), el('body'), ...elements.map(el)];

/** The last element's color and the background under it, each element's own composited from the page up */
function drawn(/** @type {string[]} */ elements, /** @type {'light' | 'dark'} */ theme) {
  const p = at(theme, elements);
  const color = S.winner(p, 'color');
  assert.ok(color, `${elements.join(' ')} has a color`);
  let under = K.token('--bg-primary', theme);
  for (let i = 1; i <= p.length; i++) {
    const bg = S.winner(p.slice(0, i), 'background');
    if (bg && !/gradient|url\(/.test(bg.value)) under = C.compositeOver(K.colorOf(K.resolve(bg.value, theme)), under);
  }
  return { ratio: K.ratio(K.colorOf(K.resolve(color.value, theme)), under), rule: color.text };
}

/** Each pair under its bar, as a list of misses */
function misses(/** @type {[string, string[], number][]} */ pairs) {
  const out = [];
  for (const theme of THEMES) {
    for (const [name, elements, need] of pairs) {
      const { ratio, rule } = drawn(elements, theme);
      if (ratio < need) out.push(`${theme}: ${name} ${shown(ratio)} (${rule})`);
    }
  }
  return out;
}

const SECTION = ['div.settings-section'];

describe('the muted grays where Settings and the sidebar draw them (css/editor.css)', () => {
  it("draws Settings' section headings at 4.5:1 on their section, and the footer's icons at 3:1 on the sidebar", () => {
    assert.deepEqual(misses([
      ['.settings-section h3', [...SECTION, 'h3'], 4.5],
      ['.sidebar-footer-btn', ['aside#sidebar.sidebar', 'div.sidebar-footer', 'button.sidebar-footer-btn'], 3],
    ]), []);
  });

  it('draws muted text at 4.5:1 on the page and on the sidebar', () => {
    const out = [];
    for (const theme of THEMES) {
      for (const surface of ['--bg-primary', '--bg-secondary']) {
        const value = K.ratio(K.token('--text-muted', theme), K.token(surface, theme));
        if (value < 4.5) out.push(`${theme}: --text-muted on ${surface} ${shown(value)}`);
      }
    }
    assert.deepEqual(out, []);
  });

  it('draws the two labels on a bg-hover chip at 4.5:1', () => {
    assert.deepEqual(misses([
      ['.ai-prompt-template-badge', [...SECTION, 'div.ai-prompt-template-list', 'div.ai-prompt-template-item', 'div.ai-prompt-template-meta', 'span.ai-prompt-template-badge'], 4.5],
      ['.deadline-date', ['div.block[data-type="todo"]', 'div.block-content', 'span.deadline-date'], 4.5],
    ]), []);
  });
});

// Muted text holds in each state its row takes (hover, active, selected), where it turns
// secondary. The active rows take a tint of their own, light enough to hold secondary text, and the
// progress chip turns opaque on every row.
const SIDEBAR = ['aside#sidebar.sidebar', 'div#sidebar-notes-list.sidebar-notes-list'];
const CARDS = ['aside#sidebar.sidebar', 'div#sidebar-notes-list.sidebar-notes-list.cards-view'];
const TIME = ['div.sidebar-note-content', 'div.sidebar-note-header', 'div.sidebar-note-time'];

// The 17 places muted text or a muted icon sits in a state of its row, each row as the code that
// builds it lays it out: the note row (sidebar-controller.js), a slash item and a version item
// (editor.js), a file card and a bookmark (blocks.js), a page item (settings-controller.js), and
// the calendar's days
const STATES = /** @type {[string, string[], number][]} */ ([
  ['a hovered note row\'s time', [...SIDEBAR, 'div.sidebar-note-item:hover', ...TIME], 4.5],
  ['an active note row\'s time', [...SIDEBAR, 'div.sidebar-note-item.active', ...TIME], 4.5],
  ['a drop target\'s time', [...SIDEBAR, 'div.sidebar-note-item.sidebar-drop-target', ...TIME], 4.5],
  ['an active card\'s time', [...CARDS, 'div.sidebar-note-item.active', ...TIME], 4.5],
  ['an active note row\'s pin, hovered', [...SIDEBAR, 'div.sidebar-note-item.active:hover', 'button.sidebar-note-pin'], 3],
  ['a drop target\'s pin, hovered', [...SIDEBAR, 'div.sidebar-note-item.sidebar-drop-target:hover', 'button.sidebar-note-pin'], 3],
  ['an active card\'s pin, hovered', [...CARDS, 'div.sidebar-note-item.active:hover', 'button.sidebar-note-pin'], 3],
  ...[['hovered', ':hover'], ['active', '.active'], ['selected', '[aria-selected="true"]']].map(
    ([state, item]) => /** @type {[string, string[], number]} */ ([`a slash item's description, ${state}`, ['div.slash-menu', `div.slash-menu-item${item}`, 'div.slash-menu-item-text', 'div.slash-menu-item-desc'], 4.5]),
  ),
  ['another month\'s day, hovered', ['aside#sidebar.sidebar', 'div.calendar-days', 'div.calendar-day.other-month:hover'], 4.5],
  ['a hovered version\'s time', ['div.version-history-list', 'div.version-history-item:hover', 'div.version-history-item-info', 'span.version-history-item-time'], 4.5],
  ['a hovered file card\'s size', ['div.block[data-type="file"]', 'div.file-card:hover', 'div.file-info', 'div.file-size'], 4.5],
  ['a hovered page item\'s date', [...SECTION, 'div#pages-list', 'div.page-item:hover', 'span.page-item-date'], 4.5],
  ['the active page item\'s date', [...SECTION, 'div#pages-list', 'div.page-item.active', 'span.page-item-date'], 4.5],
  ['a checked to-do in a selected block', ['div.block.block-selected.checked[data-type="todo"]', 'div.block-content'], 4.5],
  ['a bookmark\'s URL in a selected block', ['div.block.block-selected[data-type="bookmark"]', 'a.bookmark-card', 'div.bookmark-content', 'div.bookmark-url'], 4.5],
]);

describe('muted text in the states of its row', () => {
  it('holds 4.5:1, and a muted icon 3:1, on each of the 17', () => {
    assert.equal(STATES.length, 17);
    assert.deepEqual(misses(STATES), []);
  });

  it("holds the active row's preview and the progress chip at 4.5:1 on a resting, hovered and active row", () => {
    const CHIP = ['div.sidebar-note-content', 'div.sidebar-note-footer', 'span.sidebar-note-progress'];
    assert.deepEqual(misses([
      ['an active row\'s preview', [...SIDEBAR, 'div.sidebar-note-item.active', 'div.sidebar-note-content', 'div.sidebar-note-preview'], 4.5],
      ['the chip on a resting row', [...SIDEBAR, 'div.sidebar-note-item', ...CHIP], 4.5],
      ['the chip on a hovered row', [...SIDEBAR, 'div.sidebar-note-item:hover', ...CHIP], 4.5],
      ['the chip on an active row', [...SIDEBAR, 'div.sidebar-note-item.active', ...CHIP], 4.5],
      ['the chip on an active card', [...CARDS, 'div.sidebar-note-item.active', ...CHIP], 4.5],
    ]), []);
  });
});

// Settings' secondary buttons rest on a surface other than the bg-secondary under them: the
// sections' and the AI sidebar's panel's set --button-rest, and a card in a section resets it.

/** Each element of newtab.html whose classes hold secondary-btn or secondary-btn-small, with its ancestors, from a walk of its tags */
function secondaryButtons() {
  const html = read('newtab.html').replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const stack = [];
  const found = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g)) {
    const [, close, name, attrs, self] = m;
    if (close) {
      const open = stack.map((e) => e.tag).lastIndexOf(name.toLowerCase());
      if (open >= 0) stack.length = open;
      continue;
    }
    const attr = (/** @type {string} */ key) => (new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(attrs) || [])[1] || '';
    const e = { tag: name.toLowerCase(), id: attr('id'), classes: attr('class').split(/\s+/).filter(Boolean), attrs: new Map(), hover: false };
    if (e.classes.includes('secondary-btn') || e.classes.includes('secondary-btn-small')) found.push([...stack, e]);
    if (!VOID.has(e.tag) && !self) stack.push(e);
  }
  return found;
}

describe("Settings' secondary buttons on their sections", () => {
  /** Where `p`'s last element rests and hovers, and the painted container under it, resolved in `theme` */
  function button(/** @type {any[]} */ p, /** @type {'light' | 'dark'} */ theme) {
    const inline = S.vars(p, ['--button-rest']);
    const paint = (/** @type {any[]} */ q) => { const w = S.winner(q, 'background'); return w ? K.resolve(w.value, theme, inline) : null; };
    const container = p.slice(0, -1).map((_, i) => paint(p.slice(0, i + 1))).filter((v) => v && v !== 'none' && v !== 'transparent').pop();
    const hovered = [...p.slice(0, -1).map((e) => ({ ...e, hover: true })), { ...p[p.length - 1], hover: true }];
    return { rest: paint(p), hover: paint(hovered), container };
  }
  const name = (/** @type {any[]} */ p) => { const e = p[p.length - 1]; return `${e.tag}${e.id ? `#${e.id}` : ''}.${e.classes.join('.')}`; };
  const inSettings = (/** @type {any[]} */ p) => p.some((e) => e.classes.includes('settings-section') || e.classes.includes('ai-not-configured-sidebar'));
  // The export part's state (js/ui/part-state.js) in its section, its buttons as part-state.js builds them
  const part = (/** @type {string} */ kind) => [el('html'), el('body'), el('div.settings-section'), el('div.part-state.is-flat'), el('div.part-state-actions'), el(`button.secondary-btn.part-state-btn.part-state-${kind}`)];
  // A template's card in its section (js/controllers/ai-chat-controller.js), each of its four buttons
  const CARD = [el('html'), el('body'), el('div.settings-section'), el('div.ai-prompt-template-list'), el('div.ai-prompt-template-item'), el('div.ai-prompt-template-actions'), el('button.secondary-btn-small')];

  it('rests the 13 flat ones on bg-primary, each keeping its hover, and leaves the 37 on cards and Reload anyway as they are', () => {
    const { DEFAULT_AI_PROMPT_TEMPLATES } = require('../js/ai-prompt-templates.js');
    const perCard = (read('js/controllers/ai-chat-controller.js').match(/\w+Btn\.className = 'secondary-btn-small';/g) || []).length;
    const statics = secondaryButtons().filter(inSettings);
    const flat = [...statics.filter((p) => button(p, 'light').container === K.resolve('var(--bg-secondary)', 'light')), part('try'), part('reload')];
    const cards = statics.filter((p) => !flat.includes(p));
    assert.equal(flat.length, 13, flat.map(name).join(', '));
    assert.equal(cards.length + DEFAULT_AI_PROMPT_TEMPLATES.length * perCard, 37, `${cards.map(name).join(', ')}, and ${DEFAULT_AI_PROMPT_TEMPLATES.length} cards of ${perCard}`);
    const misses = [];
    for (const theme of THEMES) {
      const token = (/** @type {string} */ t) => K.resolve(`var(${t})`, theme);
      for (const p of flat) {
        const small = p[p.length - 1].classes.includes('secondary-btn-small');
        const { rest, hover } = button(p, theme);
        if (rest !== token('--bg-primary')) misses.push(`${theme}: ${name(p)} rests on ${rest}`);
        if (hover !== token(small ? '--bg-active' : '--bg-hover')) misses.push(`${theme}: ${name(p)} hovers on ${hover}`);
      }
      for (const p of [...cards, CARD]) {
        const small = p[p.length - 1].classes.includes('secondary-btn-small');
        const { rest } = button(p, theme);
        if (rest !== token(small ? '--bg-hover' : '--bg-secondary')) misses.push(`${theme}: ${name(p)} on a card rests on ${rest}`);
      }
      const quiet = button(part('anyway'), theme);
      if (quiet.rest !== 'none' || quiet.hover !== 'none') misses.push(`${theme}: Reload anyway rests on ${quiet.rest} and hovers on ${quiet.hover}`);
    }
    assert.deepEqual(misses, []);
  });
});
