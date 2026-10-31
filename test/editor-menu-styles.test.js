// The editor's five menus keep the box #102 gave them: each fits the window, and scrolls in one
// shorter than it (Utils.placeMenu keeps its top in view). The CSS shares their rules; this
// cascades every rule that names a menu by its class alone, in source order, and checks each
// menu still ends with the same values (#27, the new tab's start CSS row).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parse, walk, splitTopLevel } = require('../scripts/css-parser.js');

const CSS_DIR = path.join(__dirname, '..', 'css');
const MENUS = ['slash-menu', 'table-context-menu', 'context-menu', 'block-action-menu', 'turn-into-menu'];

/**
 * Every declaration that applies to an element with the menu's class and no other, by file and
 * source order, with the at-rules around it
 * @param {string} menu
 */
function cascade(menu) {
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const conditional = [];
  for (const file of fs.readdirSync(CSS_DIR).filter(name => name.endsWith('.css')).sort()) {
    walk(parse(fs.readFileSync(path.join(CSS_DIR, file), 'utf8')), (node, ancestors) => {
      if (node.type !== 'rule') return;
      const selectors = splitTopLevel(node.prelude).map(selector => selector.trim());
      if (!selectors.includes(`.${menu}`)) return;
      if (ancestors.length > 0) {
        conditional.push(`${file}:${node.line}`);
        return;
      }
      if (!files.includes(file)) files.push(file);
      for (const { property, value, important } of node.declarations) values[property] = important ? `${value} !important` : value;
    });
  }
  return { values, files, conditional };
}

describe("the editor menus' box (css/editor.css)", () => {
  it('ends each menu with the max-height and overflow-y #102 set', () => {
    const got = Object.fromEntries(MENUS.map(menu => {
      const { values } = cascade(menu);
      return [menu, { 'max-height': values['max-height'], 'overflow-y': values['overflow-y'] }];
    }));
    assert.deepEqual(got, {
      'slash-menu': { 'max-height': 'min(320px, calc(100vh - 16px))', 'overflow-y': 'auto' },
      'table-context-menu': { 'max-height': 'calc(100vh - 16px)', 'overflow-y': 'auto' },
      'context-menu': { 'max-height': 'calc(100vh - 16px)', 'overflow-y': 'auto' },
      'block-action-menu': { 'max-height': 'calc(100vh - 16px)', 'overflow-y': 'auto' },
      'turn-into-menu': { 'max-height': 'min(360px, calc(100vh - 16px))', 'overflow-y': 'auto' },
    });
  });

  it('keeps every other value of the context and block action menus, which share one rule', () => {
    const box = {
      position: 'fixed',
      background: 'var(--bg-primary)',
      border: '1px solid var(--border-color)',
      'border-radius': '8px',
      'box-shadow': 'var(--shadow-lg)',
      'min-width': '160px',
      'max-height': 'calc(100vh - 16px)',
      'overflow-y': 'auto',
      padding: '6px',
      'z-index': '1100',
    };
    assert.deepEqual(cascade('context-menu').values, box);
    assert.deepEqual(cascade('block-action-menu').values, box);
    assert.deepEqual(cascade('table-context-menu').values, {
      background: 'var(--bg-primary)',
      border: '1px solid var(--border-color)',
      'border-radius': '8px',
      padding: '4px 0',
      'min-width': '180px',
      'max-height': 'calc(100vh - 16px)',
      'overflow-y': 'auto',
      'box-shadow': '0 4px 12px rgba(0, 0, 0, 0.15)',
      'z-index': '1000',
    });
  });

  it('styles the menus in css/editor.css only, with no rule under a media query or other at-rule', () => {
    for (const menu of MENUS) {
      const { files, conditional } = cascade(menu);
      assert.deepEqual(files, ['editor.css'], menu);
      assert.deepEqual(conditional, [], menu);
    }
  });
});
