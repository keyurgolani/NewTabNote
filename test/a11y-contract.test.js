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

describe('the conformance table and the matrix (#24 slice 1)', () => {
  let table;
  let header;
  let matrix;
  let hosts;
  let routes;
  before(async () => {
    const lines = read('docs/accessibility/conformance.md');
    header = lines.split('\n').find(line => line.startsWith('|'));
    table = rows(lines);
    matrix = JSON.parse(read('docs/accessibility/matrix.json'));
    ({ HOSTS: hosts } = await import('../js/kernel/registry/vocabulary.js'));
    ({ WORKSPACE_ROUTES: routes } = await import('../js/product/topology.js'));
  });

  it("has #24's columns, with an owner for every row", () => {
    assert.deepEqual(
      header.split('|').slice(1, -1).map(cell => cell.trim()),
      [
        ...['Surface or route', 'Owner', 'Landmarks', 'Headings', 'Entry focus', 'Keys', 'Layers'],
        ...['Narrow mapping', 'Drag alternatives', 'Announcements', 'Spec'],
      ],
    );
    for (const [row, owner] of table) assert.match(owner, /#\d+|this issue/, row);
  });

  it('has a row for every surface but background, every Workspace route, and each workflow #24 names', () => {
    const ids = table.map(([row]) => /\(`([^`]+)`\)$/.exec(row)?.[1]);
    const workflows = [
      ...['toolbar', 'table-menu', 'selection-bar', 'focus-dimming', 'split-view', 'tables', 'block-reorder'],
      ...['folders', 'calendar', 'cues'],
    ];
    assert.deepEqual(ids, [
      ...hosts.filter(host => host !== 'background'),
      ...routes.map(route => `workspace/${route}`),
      ...workflows,
    ]);
  });

  it('keeps a row empty until its spec passes, and a filled row names one spec under test/a11y/', () => {
    for (const [row, , ...cells] of table) {
      if (cells.every(cell => cell === '')) continue;
      assert.ok(cells.every(cell => cell !== ''), `${row} is filled in part`);
      const spec = /^`(test\/a11y\/[^`]+)`$/.exec(cells.at(-1))?.[1];
      assert.ok(spec && fs.existsSync(path.join(ROOT, spec)), `${row} names no spec that exists`);
    }
  });

  it("changes one axis at a time from each surface's default, at the widths #16's tokens hold", () => {
    const width = token => Number.parseInt(tokens.tokens[token].values.default, 10);
    const wide = ['--layout-min-width', '--breakpoint-narrow', '--breakpoint-recompose', '--breakpoint-compact-shell'];
    assert.equal(matrix.defaults.wide.width, 1280);
    assert.ok(read('docs/testing.md').includes('a 1280 by 800 viewport'), "the reference viewport's width");
    assert.equal(matrix.defaults.narrow.width, 360);
    for (const surface of ['moment', 'workspace']) assert.deepEqual(matrix.surfaces[surface].widths, wide.map(width));
    for (const surface of ['popup', 'sidepanel']) assert.deepEqual(matrix.surfaces[surface].widths, [width(wide[0])]);
    for (const { default: name } of Object.values(matrix.surfaces)) {
      const base = matrix.defaults[name];
      for (const point of matrix.everySurface) {
        const [axis, ...more] = Object.keys(point);
        assert.ok(more.length === 0 && axis in base && point[axis] !== base[axis], JSON.stringify(point));
      }
    }
    assert.equal(new Set(matrix.everySurface.map(point => JSON.stringify(point))).size, matrix.everySurface.length);
  });
});
