'use strict';

// #267: the muted grays. In the built-in light and dark themes, judged unrounded, muted text holds
// 4.5:1 and a muted icon 3:1 where it's drawn: Settings' section headings and the sidebar
// footer's icons, which take the secondary gray; muted text on the page and on the sidebar; and
// the two muted labels on a bg-hover chip, which take secondary.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { sheets, colors, el, shown } = require('./helpers/cascade');

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
