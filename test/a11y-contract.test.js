'use strict';

// #24 slice 1 (AC10): docs/accessibility/interaction-contract.md holds every rule and table of
// #24's Product and interaction requirements, so #16, #14, #3, #2, #4 and #5 build to one
// contract. It also names what's already code, the registry kit's reserved chords and #16's
// thresholds, so a change to either has to change the contract in the same PR.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

/**
 * A markdown page's `## ` sections, by heading, in order
 * @param {string} text
 * @returns {Map<string, string>}
 */
function sections(text) {
  const found = new Map();
  let name = null;
  for (const line of text.split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) found.set((name = heading[1]), []);
    else if (name) found.get(name).push(line);
  }
  return new Map([...found].map(([key, lines]) => [key, lines.join('\n')]));
}

/**
 * The body rows of the markdown table in `text`, as trimmed cells
 * @param {string} text
 * @returns {string[][]}
 */
const rows = text =>
  text
    .split('\n')
    .filter(line => line.startsWith('|'))
    .slice(2)
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));

let text;
let doc;
let tokens;
let chords;
before(async () => {
  text = read('docs/accessibility/interaction-contract.md');
  doc = sections(text);
  tokens = JSON.parse(read('design/quiet-atlas.tokens.json'));
  chords = await import('../js/kernel/registry/chords.js');
});

describe('the interaction contract (#24 slice 1, AC10)', () => {
  it("has each part of #24's Product and interaction requirements, and the baseline's gates", () => {
    assert.deepEqual(
      [...doc.keys()],
      [
        ...['Criteria and owners', 'Patterns', 'Focus and layers', 'Announcements', 'Keyboard map', 'Targets'],
        ...['Drag alternatives', 'Responsive', 'Conformance table', 'Baseline gates'],
      ],
    );
  });

  it('maps each WCAG 2.2 criterion #24 names to its owners, with target size beside them', () => {
    const table = rows(doc.get('Criteria and owners'));
    assert.deepEqual(
      table.map(([criterion]) => criterion.replace(/ [A-Z].*$/, '')),
      [
        ...['1.1.1', '1.4.1', '1.4.3, 1.4.11', '1.4.10', '1.4.12', '1.4.13', '2.1.4', '2.2.2', '2.4.11', '2.5.3'],
        ...['2.5.5, 2.5.8', '2.5.7', '3.2.6', '3.3.7', '3.3.8', '4.1.3'],
      ],
    );
    for (const [criterion, here, owner] of table) {
      assert.ok(here, criterion);
      assert.match(owner, /#\d+|this issue/, criterion);
    }
  });

  it('has the 11 patterns and the 5 drags, each drag with its alternative and owner', () => {
    assert.deepEqual(
      rows(doc.get('Patterns')).map(([pattern]) => pattern),
      [
        ...['View tabs', 'Document tabs', 'Rail', 'Calendar', 'Collections', 'Menus (item, folder, block, table)'],
        ...['Palette; slash, `[[`, template menus', 'Formatting toolbar', 'Dialogs', 'Cards', 'Graph, charts'],
      ],
    );
    const drags = rows(doc.get('Drag alternatives'));
    assert.deepEqual(
      drags.map(([drag]) => drag),
      [
        ...['Block reorder, mouse or long-press', 'Block onto the note list', 'Note or folder into a folder'],
        ...['Panel resize', 'Graph pan and zoom'],
      ],
    );
    for (const [drag, alternative, owner] of drags) {
      assert.ok(alternative, drag);
      assert.match(owner, /^#\d+(, #\d+)*$/, drag);
    }
  });

  it("lists the registry kit's reserved chords, and gives Help Mod+/ outside a block's text", () => {
    const keys = doc.get('Keyboard map');
    const rule = keys.split('\n').find(line => line.includes('Chrome keeps for itself'));
    assert.ok(rule, 'the reserved-chord rule');
    const named = [...rule.matchAll(/`(Mod\+[^`]+)`/g)].map(match => match[1]);
    assert.deepEqual(named.sort(), [...chords.CHROME_RESERVED_CHORDS].sort());
    assert.match(keys, /Mod\+\/ opens Help .*except while the caret is in a block's text/);
  });

  it("states #16's thresholds as its token source holds them", () => {
    const { rules } = tokens;
    const target = Number.parseInt(rules.targets.minimum, 10);
    const targets = doc.get('Targets');
    assert.ok(targets.includes(`${target} by ${target} CSS px`) && targets.includes('`--target-min`'));
    assert.ok(targets.includes(`(${7 * target}px, ${(7 * target) / 16}rem)`), 'the month grid fits seven targets');
    assert.ok(text.includes(`${rules.ratios.text}:1`) && text.includes(`${rules.ratios['non-text']}:1`));
    const widths = ['--layout-min-width', '--breakpoint-narrow', '--breakpoint-recompose', '--breakpoint-compact-shell'];
    for (const token of widths) {
      const width = Number.parseInt(tokens.tokens[token].values.default, 10);
      assert.ok(doc.get('Responsive').includes(`${width}, `) && text.includes(`\`${token}\``), token);
    }
  });

  it('exempts links in running text inside a text block, and keeps `#16-dark` the only baseline gate', () => {
    const targets = doc.get('Targets');
    assert.match(targets, /links in running text inside a text block, as WCAG's target-size criteria \(2\.5\.5 and 2\.5\.8\)/);
    assert.match(targets, /neither are bookmark cards/);
    assert.deepEqual([...new Set(text.match(/`#16-dark`|`owner-[a-z0-9-]+`/g))], ['`#16-dark`']);
  });
});
