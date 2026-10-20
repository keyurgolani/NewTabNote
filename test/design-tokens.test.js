'use strict';

// Quiet Atlas token source and generator (#16 slice 1): design/quiet-atlas.tokens.json,
// scripts/build-design-tokens.js, and its committed outputs css/design-tokens.css and
// js/design/tokens.generated.js. js/design/ holds ES modules, so this CommonJS suite
// imports them.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CleanCSS = require('clean-css');
const generator = require('../scripts/build-design-tokens.js');
const build = require('../scripts/build.js');
const { parse, walk } = require('../scripts/css-parser.js');
const { compileSheet, computeRoot } = require('./helpers/css-cascade.js');

const ROOT = path.join(__dirname, '..');

/** @type {typeof import('../js/design/contrast.js')} */
let design;
/** @type {import('../js/design/contrast.js').DesignTokenData} */
let DATA;
let output;
let committedCss;
let committedJs;

before(async () => {
  design = await import('../js/design/contrast.js');
  DATA = (await import('../js/design/tokens.generated.js')).DESIGN_TOKENS;
  output = generator.generate(generator.readSource(), design);
  committedCss = fs.readFileSync(path.join(ROOT, generator.CSS_PATH), 'utf8');
  committedJs = fs.readFileSync(path.join(ROOT, generator.JS_PATH), 'utf8');
});

const lower = value => (/^#/.test(value) ? value.toLowerCase() : value);

// Every value #16 states as settled: the owner-approved table, type, radii, spacing,
// padding, shadows, motion, breakpoints, the contrast-more swaps, compact density,
// reduced motion, focus, and canvas widths. A string pins every approved cell of the
// token; an object pins named cells. Candidate cells are left out, and dark colors
// are all candidates until owner input 2.
const PINNED = {
  '--surface-app': '#F4F6F3',
  '--surface-navigation': '#253443',
  '--text-primary': '#253443',
  '--action-primary': '#253443',
  '--state-local': '#526F69',
  '--state-info': '#7184A3',
  '--state-urgent': '#B78E76',
  '--state-pending': '#DED7BA',
  '--surface-paper': '#FFFFFF',
  '--surface-collection': '#E7EDEB',
  '--surface-intelligence': '#E9EDF3',
  '--surface-muted': '#E8ECEA',
  '--text-secondary': { light: '#52616A', more: '#253443' },
  '--text-on-dark': '#F7F9F8',
  '--text-on-sage': '#FFFFFF',
  '--seam': { light: '#CBD5D1' },
  '--seam-strong': '#AAB9B4',
  '--focus-ring': '#315F8A',
  '--state-danger': '#934F47',
  '--focus-ring-inner': '#FFFFFF',
  '--focus-width': { light: '2px', dark: '2px', more: '3px', darkMore: '3px' },
  '--focus-offset': '2px',
  '--font-sans': '"Source Sans 3 Variable", system-ui, sans-serif',
  '--font-reading': {
    sans: '"Source Sans 3 Variable", system-ui, sans-serif',
    serif: 'Georgia, \'Times New Roman\', serif',
    mono: '\'SF Mono\', \'Fira Code\', \'Consolas\', monospace',
  },
  '--font-mono': '\'SF Mono\', \'Fira Code\', \'Consolas\', monospace',
  '--type-display-size': 'clamp(2.2rem, 4vw, 4.8rem)',
  '--type-display-weight': '720',
  '--type-display-line-height': '0.98',
  '--type-display-letter-spacing': '-0.04em',
  '--type-headline-size': 'clamp(1.8rem, 3vw, 3rem)',
  '--type-headline-weight': '720',
  '--type-headline-line-height': '1.02',
  '--type-headline-letter-spacing': '-0.035em',
  '--type-title-size': '1.55rem',
  '--type-title-weight': '700',
  '--type-title-line-height': '1.2',
  '--type-body-size': '1rem',
  '--type-body-weight': '400',
  '--type-body-line-height': '1.6',
  '--type-label-size': '0.8rem',
  '--type-label-weight': '700',
  '--type-label-line-height': '1',
  '--space-compact': '0.45rem',
  '--space-control': '0.75rem',
  '--space-region': { comfortable: '1rem', compact: '0.75rem' },
  '--space-layer': { comfortable: '1.5rem', compact: '1rem' },
  '--padding-button': '0.68rem 1rem',
  '--padding-chip': '0.3rem 0.6rem',
  '--padding-card': '0.85rem',
  '--padding-canvas': 'clamp(1.5rem, 4vw, 3.25rem)',
  '--target-min': '44px',
  '--radius-control': '10px',
  '--radius-card': '14px',
  '--radius-shell': '20px',
  '--radius-pill': '999px',
  '--shadow-layer': '0 14px 38px rgb(37 52 67 / 12%)',
  '--shadow-card': '0 5px 18px rgb(37 52 67 / 8%)',
  '--motion-standard': { 'no-preference': '180ms', reduce: '1ms' },
  '--motion-layer': { 'no-preference': '240ms', reduce: '1ms' },
  '--ease-out': 'cubic-bezier(0.22, 1, 0.36, 1)',
  '--canvas-width': { narrow: '540px', default: '72ch', wide: '900px' },
  '--reading-measure': '72ch',
  '--layout-min-width': '320px',
  '--breakpoint-narrow': '390px',
  '--breakpoint-recompose': '720px',
  '--breakpoint-compact-shell': '1100px',
};

// Owner input 1: candidates ship with the body's value
const CANDIDATES = {
  '--ink-local': '#526F69',
  '--ink-info': '#425B7D',
  '--ink-urgent': '#604C34',
  '--ink-pending': '#68624B',
  '--tint-local': '#EDF2EF',
  '--tint-info': '#F2F4F8',
  '--tint-urgent': '#F6EEE9',
  '--tint-pending': '#F7F4E8',
  '--control-boundary': '#778179',
  '--selection-bg': '#7184A34D',
  '--mark-bg': '#DED7BA',
  '--surface-code': '#F4F6F3',
  '--text-link': '#253443',
  '--scrim': '#25344366',
  '--chart-1': '#253443',
  '--chart-2': '#3B5065',
  '--chart-3': '#536C86',
  '--chart-4': '#7089A2',
};

// "Required states": until owner input 2, each dark token takes the legacy dark
// value for its role, anchors stay fills, and dark charts use this order
const DARK = {
  '--surface-paper': '#191919',
  '--surface-app': '#252525',
  '--surface-collection': '#252525',
  '--surface-intelligence': '#252525',
  '--surface-muted': '#2F2F2F',
  '--tint-local': '#2F2F2F',
  '--tint-info': '#2F2F2F',
  '--tint-urgent': '#2F2F2F',
  '--tint-pending': '#2F2F2F',
  '--surface-code': '#2A2A2A',
  '--text-primary': '#E0E0E0',
  '--ink-local': '#E0E0E0',
  '--ink-info': '#E0E0E0',
  '--ink-urgent': '#E0E0E0',
  '--ink-pending': '#E0E0E0',
  '--text-on-dark': '#E0E0E0',
  '--seam': '#333333',
  '--control-boundary': '#9B9B9B',
  '--focus-ring': '#315F8A',
  '--focus-ring-inner': '#E0E0E0',
  '--surface-navigation': '#253443',
  '--action-primary': '#253443',
  '--state-local': '#526F69',
  '--state-info': '#7184A3',
  '--state-urgent': '#B78E76',
  '--state-pending': '#DED7BA',
  '--chart-1': '#E0E0E0',
  '--chart-2': '#9B9B9B',
  '--chart-3': '#7089A2',
  '--chart-4': '#536C86',
};

function cellStatus(record, cell) {
  if (record.status === 'candidate') return 'candidate';
  return record.candidateCells && record.candidateCells.includes(cell) ? 'candidate' : 'approved';
}

describe('design/quiet-atlas.tokens.json and its generated output', () => {
  it('regenerates to exactly the committed css/design-tokens.css and js/design/tokens.generated.js', () => {
    assert.equal(output.css, committedCss, `${generator.CSS_PATH} is stale: run \`npm run design-tokens\` and commit it`);
    assert.equal(output.js, committedJs, `${generator.JS_PATH} is stale: run \`npm run design-tokens\` and commit it`);
    assert.deepEqual(JSON.parse(JSON.stringify(DATA)), output.model);
  });

  it('passes the generator\'s own check: every variant validates and every legacy dark pair still fails', () => {
    assert.deepEqual(generator.check(output.model, design), []);
  });

  it('is versioned and puts every token in exactly one of the six axes', () => {
    assert.equal(DATA.version, 1);
    assert.deepEqual(Object.keys(DATA.axes), ['color', 'typography', 'density', 'shape', 'motion', 'layout']);
    for (const [name, record] of Object.entries(DATA.tokens)) {
      assert.ok(DATA.axes[record.axis], `${name} axis ${record.axis}`);
      assert.ok(['approved', 'candidate'].includes(record.status), `${name} status`);
      assert.equal(typeof record.overridable, 'boolean', `${name} overridable`);
      assert.ok(record.type, `${name} type`);
    }
  });

  it('pins every approved value, and every approved value is pinned', () => {
    for (const [name, pin] of Object.entries(PINNED)) {
      const record = DATA.tokens[name];
      assert.ok(record, `${name} is missing`);
      if (typeof pin === 'object') {
        for (const [cell, value] of Object.entries(pin)) {
          assert.equal(record.values[cell], lower(value), `${name} ${cell}`);
          assert.equal(cellStatus(record, cell), 'approved', `${name} ${cell} is pinned but not approved`);
        }
      }
    }
    for (const [name, record] of Object.entries(DATA.tokens)) {
      for (const [cell, value] of Object.entries(record.values)) {
        if (cell === 'forced' || cellStatus(record, cell) !== 'approved') continue;
        const pin = PINNED[name];
        const expected = typeof pin === 'string' ? pin : pin && pin[cell];
        assert.ok(expected !== undefined, `${name} ${cell} is approved (${value}) but the contract doesn't pin it`);
        assert.equal(value, lower(expected), `${name} ${cell}`);
      }
    }
  });

  it('declares every approved base value in the :root block of the generated CSS', () => {
    const rootBlock = /\n:root \{\n([\s\S]*?)\n\}/.exec(committedCss)[1];
    for (const [name, pin] of Object.entries(PINNED)) {
      const record = DATA.tokens[name];
      const base = record.axis === 'color' ? 'light' : (DATA.variants.axisDimension[record.axis] ? DATA.variants.default[DATA.variants.axisDimension[record.axis]] : 'default');
      const value = typeof pin === 'string' ? pin : pin[base];
      if (value === undefined) continue;
      assert.ok(rootBlock.includes(`  ${name}: ${lower(value)};`), `:root lacks ${name}: ${lower(value)}`);
    }
    assert.match(rootBlock, /^ {2}color-scheme: light;$/m);
  });

  it('ships every owner candidate as a candidate with the body\'s value', () => {
    for (const [name, value] of Object.entries(CANDIDATES)) {
      assert.equal(DATA.tokens[name].status, 'candidate', name);
      assert.equal(DATA.tokens[name].values.light, lower(value), name);
    }
    const source = generator.readSource();
    assert.deepEqual(source.tokens['--ink-local'].alternatives, ['#315B52']);
    assert.equal(DATA.tokens['--canvas-width'].values.full, '100%');
    assert.deepEqual(DATA.tokens['--canvas-width'].candidateCells, ['full']);
  });

  it('keeps the shipped plane names: a sage-tinted collection plane and a mist-tinted intelligence plane', () => {
    assert.equal(DATA.tokens['--surface-collection'].values.light, '#e7edeb');
    assert.equal(DATA.tokens['--surface-intelligence'].values.light, '#e9edf3');
  });

  it('runs dark on the legacy fallbacks, as candidates, with anchors kept as fills', () => {
    for (const [name, value] of Object.entries(DARK)) {
      assert.equal(DATA.tokens[name].values.dark, lower(value), name);
    }
    for (const [name, record] of Object.entries(DATA.tokens)) {
      if (record.type !== 'color') continue;
      assert.equal(cellStatus(record, 'dark'), 'candidate', `${name} dark`);
      assert.equal(cellStatus(record, 'darkMore'), 'candidate', `${name} darkMore`);
    }
    const source = generator.readSource();
    for (const [name, token] of Object.entries(source.tokens)) {
      if (token.type !== 'color') continue;
      const dark = typeof token.values.dark === 'string' ? { value: token.values.dark } : token.values.dark;
      assert.ok(dark.legacy || dark.note || dark.ref, `${name}: its dark value names where it comes from`);
    }
  });

  it('swaps the seam and secondary text in contrast-more, in both schemes, and widens focus to 3px', () => {
    for (const scheme of [['light', 'more'], ['dark', 'darkMore']]) {
      const [base, more] = scheme;
      assert.equal(DATA.tokens['--seam'].values[more], DATA.tokens['--control-boundary'].values[base]);
      assert.equal(DATA.tokens['--text-secondary'].values[more], DATA.tokens['--text-primary'].values[base]);
      assert.equal(DATA.tokens['--focus-width'].values[more], '3px');
    }
  });

  it('gives forced colors system colors only, Highlight focus, and visible boundaries', () => {
    for (const [name, record] of Object.entries(DATA.tokens)) {
      if (record.type === 'color') assert.ok(design.isSystemColor(record.values.forced), `${name} forced ${record.values.forced}`);
    }
    assert.equal(DATA.tokens['--focus-ring'].values.forced, 'Highlight');
    for (const name of DATA.rules.forcedColors.boundaries) assert.notEqual(DATA.tokens[name].values.forced, 'Canvas', name);
  });

  it('registers every color with @property: <color>, inherited, the light value as its initial value', () => {
    const registered = {};
    walk(parse(committedCss), node => {
      if (node.type === 'at-rule' && node.name === 'property') {
        registered[node.prelude] = Object.fromEntries(node.declarations.map(d => [d.property, d.value]));
      }
    });
    const colors = Object.entries(DATA.tokens).filter(([, record]) => record.type === 'color');
    assert.equal(Object.keys(registered).length, colors.length);
    for (const [name, record] of colors) {
      assert.deepEqual(registered[name], { syntax: '"<color>"', inherits: 'true', 'initial-value': record.values.light }, name);
    }
  });

  it('records each legacy alias once, sorted, and none of them is a token', () => {
    const { aliases } = generator.readSource().legacy;
    assert.deepEqual([...aliases].sort(), aliases);
    assert.equal(new Set(aliases).size, aliases.length);
    assert.ok(aliases.every(name => !DATA.tokens[name]));
    assert.ok(!aliases.includes('--primary-gradient'));
  });
});

describe('axes are independent (AC1)', () => {
  const axisOf = dimension => Object.keys(DATA.axes).find(axis => DATA.axes[axis].dimensions.includes(dimension));

  function changedTokens(from, to) {
    const a = design.resolveTokens(DATA, from).values;
    const b = design.resolveTokens(DATA, to).values;
    return Object.keys(a).filter(name => a[name] !== b[name]);
  }

  const bases = () => [
    DATA.variants.default,
    { ...DATA.variants.default, scheme: 'dark', contrast: 'more', density: 'compact', readingFont: 'serif', canvasWidth: 'narrow', motion: 'reduce' },
  ];

  it('changing one dimension changes tokens of its own axis and no other, from any starting variant', () => {
    for (const base of bases()) {
      for (const [dimension, values] of Object.entries(DATA.variants.dimensions)) {
        for (const value of values) {
          if (value === base[dimension]) continue;
          const changed = changedTokens(base, { ...base, [dimension]: value });
          assert.ok(changed.length > 0, `${dimension}=${value} changes nothing`);
          const strays = changed.filter(name => DATA.tokens[name].axis !== axisOf(dimension));
          assert.deepEqual(strays, [], `${dimension}=${value} changed tokens outside the ${axisOf(dimension)} axis`);
        }
      }
    }
  });

  it('changing one axis in a fixture source changes only that token in the output', () => {
    const source = generator.readSource();
    const fixture = structuredClone(source);
    fixture.tokens['--space-region'].values.compact = '0.6rem';
    const before = generator.compile(source, design).tokens;
    const after = generator.compile(fixture, design).tokens;
    const changed = Object.keys(before).filter(name => JSON.stringify(before[name]) !== JSON.stringify(after[name]));
    assert.deepEqual(changed, ['--space-region']);
    assert.deepEqual(after['--space-region'].values, { comfortable: '1rem', compact: '0.6rem' });
  });

  it('every variant block in the CSS sets only tokens of the axis its attributes and media belong to', () => {
    const attributeAxis = {};
    const mediaAxis = {};
    for (const [dimension, definition] of Object.entries(DATA.dimensions)) {
      if (definition.attribute) attributeAxis[definition.attribute] = axisOf(dimension);
      const query = definition.system ? definition.system.media : definition.media && definition.media.query;
      if (query) mediaAxis[query.replace(/\s+/g, '')] = axisOf(dimension);
    }
    let checked = 0;
    walk(parse(committedCss), (node, ancestors) => {
      if (node.type !== 'rule') return;
      const axes = new Set();
      for (const match of node.prelude.matchAll(/\[(data-[a-z-]+)/g)) axes.add(attributeAxis[match[1]]);
      for (const at of ancestors) {
        if (at.name !== 'media') continue;
        for (const term of at.prelude.split(/\s+and\s+/)) axes.add(mediaAxis[term.replace(/\s+/g, '')]);
      }
      if (axes.size === 0) return;
      assert.equal(axes.size, 1, `${node.prelude} mixes axes ${[...axes].join(', ')}`);
      const [axis] = axes;
      assert.ok(axis, `${node.prelude} uses an attribute or media query no dimension declares`);
      for (const declaration of node.declarations) {
        if (declaration.property === 'color-scheme') continue;
        assert.equal(DATA.tokens[declaration.property].axis, axis, `${node.prelude} sets ${declaration.property}`);
      }
      checked++;
    });
    assert.ok(checked >= 10, `only ${checked} variant blocks found`);
  });
});

// The variant the body says each set of root attributes and media features gets.
// Written from the issue, not from the generator.
function expectedVariant(attrs, media) {
  const systemDark = attrs['data-scheme'] === 'system' && media['prefers-color-scheme'] === 'dark';
  return {
    scheme: attrs['data-scheme'] === 'dark' || systemDark ? 'dark' : 'light',
    contrast: attrs['data-contrast'] === 'more' || media['prefers-contrast'] === 'more' ? 'more' : 'no-preference',
    forcedColors: media['forced-colors'] === 'active' ? 'active' : 'none',
    motion: attrs['data-motion'] === 'reduce' || media['prefers-reduced-motion'] === 'reduce' ? 'reduce' : 'no-preference',
    density: attrs['data-density'] === 'compact' ? 'compact' : 'comfortable',
    readingFont: attrs['data-reading-font'] || 'sans',
    canvasWidth: attrs['data-canvas-width'] || 'default',
  };
}

const ATTRIBUTES = {
  'data-scheme': [null, 'light', 'dark', 'system'],
  'data-contrast': [null, 'system', 'more'],
  'data-motion': [null, 'system', 'reduce'],
  'data-density': [null, 'comfortable', 'compact'],
  'data-reading-font': [null, 'sans', 'serif', 'mono'],
  'data-canvas-width': [null, 'narrow', 'default', 'wide', 'full'],
};

function mediaCombinations() {
  const out = [];
  for (const scheme of ['light', 'dark']) {
    for (const contrast of ['no-preference', 'more']) {
      for (const forced of ['none', 'active']) {
        for (const motion of ['no-preference', 'reduce']) {
          out.push({ 'prefers-color-scheme': scheme, 'prefers-contrast': contrast, 'forced-colors': forced, 'prefers-reduced-motion': motion });
        }
      }
    }
  }
  return out;
}

// Every scheme and contrast attribute pair with the other attributes absent, each
// other attribute value alone, and the scheme and contrast pairs with every other
// axis off its default. All of them under every media combination.
function attributeCombinations() {
  const strip = attrs => Object.fromEntries(Object.entries(attrs).filter(([, value]) => value !== null));
  const out = [];
  for (const scheme of ATTRIBUTES['data-scheme']) {
    for (const contrast of ATTRIBUTES['data-contrast']) {
      out.push(strip({ 'data-scheme': scheme, 'data-contrast': contrast }));
      out.push(strip({ 'data-scheme': scheme, 'data-contrast': contrast, 'data-motion': 'reduce', 'data-density': 'compact', 'data-reading-font': 'mono', 'data-canvas-width': 'full' }));
    }
  }
  for (const name of ['data-motion', 'data-density', 'data-reading-font', 'data-canvas-width']) {
    for (const value of ATTRIBUTES[name]) if (value !== null) out.push({ [name]: value });
  }
  return out;
}

// Whitespace around commas carries no meaning in these values; CleanCSS drops it
const compact = value => (value === undefined ? value : value.replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').trim());

function assertCascadeMatches(cssText, label, normalize = value => value) {
  const sheet = compileSheet(cssText);
  let checked = 0;
  for (const attrs of attributeCombinations()) {
    for (const media of mediaCombinations()) {
      const variant = expectedVariant(attrs, media);
      const expected = design.resolveTokens(DATA, variant).values;
      const actual = computeRoot(sheet, attrs, media);
      const where = `${label} with ${JSON.stringify(attrs)} under ${JSON.stringify(media)}`;
      assert.equal(actual['color-scheme'], variant.scheme, `${where}: color-scheme`);
      for (const [name, value] of Object.entries(expected)) {
        assert.equal(normalize(actual[name]), normalize(value), `${where}: ${name}`);
      }
      checked++;
    }
  }
  return checked;
}

describe('the generated CSS applies each variant', () => {
  it('lands every root attribute and media combination on the variant the issue describes', () => {
    const checked = assertCascadeMatches(committedCss, generator.CSS_PATH);
    assert.ok(checked > 500, `${checked} combinations`);
  });

  it('applies light with no attribute whatever the OS, and only data-scheme="system" follows prefers-color-scheme', () => {
    const sheet = compileSheet(committedCss);
    const dark = { 'prefers-color-scheme': 'dark', 'prefers-contrast': 'no-preference', 'forced-colors': 'none', 'prefers-reduced-motion': 'no-preference' };
    assert.equal(computeRoot(sheet, {}, dark)['--surface-paper'], '#ffffff');
    assert.equal(computeRoot(sheet, { 'data-scheme': 'light' }, dark)['--surface-paper'], '#ffffff');
    assert.equal(computeRoot(sheet, { 'data-scheme': 'system' }, dark)['--surface-paper'], '#191919');
  });

  it('lets an OS reduce-motion setting win over the in-app choice', () => {
    const sheet = compileSheet(committedCss);
    const reduce = { 'prefers-color-scheme': 'light', 'prefers-contrast': 'no-preference', 'forced-colors': 'none', 'prefers-reduced-motion': 'reduce' };
    for (const motion of ['system', undefined]) {
      const attrs = motion ? { 'data-motion': motion } : {};
      assert.equal(computeRoot(sheet, attrs, reduce)['--motion-standard'], '1ms');
    }
  });
});

describe('the build\'s CSS minifier keeps the token output intact', () => {
  let minified;
  before(() => {
    // CleanCSS level 2 with scripts/build.js's options, as the build runs a CSS_FILES
    // entry that isn't in CSS_LEVEL_1
    assert.ok(!build.CSS_LEVEL_1.includes(generator.CSS_PATH));
    const result = new CleanCSS(build.CLEANCSS_OPTIONS).minify(committedCss);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    minified = result.styles;
  });

  function inventory(cssText) {
    const out = { properties: {}, fontFaces: [], media: new Set(), declarations: new Set() };
    walk(parse(cssText), (node, ancestors) => {
      const context = ancestors.filter(at => at.name === 'media').map(at => at.prelude.replace(/\s+/g, '')).join(' & ');
      if (node.type === 'at-rule' && node.name === 'property') {
        out.properties[node.prelude] = node.declarations.map(d => `${d.property}:${d.value.replace(/'/g, '"')}`).join(';');
      }
      if (node.type === 'at-rule' && node.name === 'font-face') out.fontFaces.push(node.declarations.map(d => `${d.property}:${d.value}`).join(';'));
      if (node.type === 'at-rule' && node.name === 'media') out.media.add(node.prelude.replace(/\s+/g, ''));
      if (node.type === 'rule') {
        for (const selector of node.prelude.split(',')) {
          for (const d of node.declarations) {
            out.declarations.add(`${context} ${selector.replace(/"/g, '').trim()} ${d.property}:${compact(d.value)}${d.important ? '!' : ''}`);
          }
        }
      }
    });
    return out;
  }

  it('keeps every @property, @font-face, media query, and token declaration', () => {
    const source = inventory(committedCss);
    const after = inventory(minified);
    assert.deepEqual(after.properties, source.properties);
    assert.deepEqual(after.fontFaces, source.fontFaces);
    assert.deepEqual([...after.media].sort(), [...source.media].sort());
    const lost = [...source.declarations].filter(declaration => !after.declarations.has(declaration));
    assert.deepEqual(lost, []);
  });

  it('applies every variant exactly as the source does', () => {
    assertCascadeMatches(minified, 'the minified CSS', compact);
  });
});

describe('scripts/build-design-tokens.js refuses a malformed source', () => {
  /** Compile a changed copy of the source and return the error message */
  function errorFor(change) {
    const fixture = structuredClone(generator.readSource());
    change(fixture);
    try {
      generator.compile(fixture, design);
    } catch (e) {
      return e.message;
    }
    return null;
  }

  const cases = [
    ['a token in an unknown axis', s => { s.tokens['--space-region'].axis = 'spacing'; }, /--space-region: unknown axis spacing/],
    ['a color with no forced value', s => { delete s.tokens['--seam'].values.forced; }, /--seam: forced value missing/],
    ['a forced value that isn\'t a system color', s => { s.tokens['--seam'].values.forced = '#000000'; }, /isn't a system color/],
    ['a light color that isn\'t hex', s => { s.tokens['--seam'].values.light = 'red'; }, /isn't #rrggbb or #rrggbbaa/],
    ['a ref to a missing token', s => { s.tokens['--seam'].values.more = { ref: '--nope' }; }, /ref --nope isn't a token/],
    ['a ref cycle', s => {
      s.tokens['--text-link'].values.light = { ref: '--focus-ring-inner' };
      s.tokens['--focus-ring-inner'].values.light = { ref: '--text-link' };
    }, /ref cycle through --text-link@light -> --focus-ring-inner@light -> --text-link@light/],
    ['a ref cycle through a pair\'s background, without crashing on the pairs', s => {
      s.tokens['--surface-paper'].values.dark = { ref: '--text-primary' };
      s.tokens['--text-primary'].values.dark = { ref: '--surface-paper' };
    }, /^tokens\.--surface-paper: ref cycle through --surface-paper@dark -> --text-primary@dark -> --surface-paper@dark$/m],
    ['a scheme with no values', s => { delete s.dimensions.scheme.values; }, /dimensions\.scheme: values missing/],
    ['a dark and contrast-more literal with no darkMore', s => { s.tokens['--seam-strong'].values.more = '#778179'; }, /needs a darkMore value/],
    ['a pair naming a missing token', s => { s.pairs[0].fg = '--nope'; }, /fg --nope isn't a color token/],
    ['a duplicate pair id', s => { s.pairs[1].id = s.pairs[0].id; }, /duplicate id/],
    ['a translucent background with no backdrop', s => { delete s.pairs.find(p => p.id === 'selection/rest/on-paper').over; }, /needs an opaque over/],
    ['a focus pair with no inner ring', s => { delete s.pairs.find(p => p.kind === 'focus').inner; }, /focus pairs name their inner ring/],
    ['a legacy dark pair whose colors aren\'t legacy', s => { s.legacyDark.pairs.push('chart/rest/step-3'); }, /chart\/rest\/step-3 fg --chart-3 doesn't take a legacy dark value/],
    ['an unsorted alias list', s => { s.legacy.aliases.reverse(); }, /keep it sorted and unique/],
    ['an alias that\'s a token', s => { s.legacy.aliases = ['--surface-paper']; }, /--surface-paper is a token/],
    ['an overridable non-color', s => { s.tokens['--space-region'].overridable = true; }, /only colors can be overridable/],
  ];
  for (const [what, change, pattern] of cases) {
    it(`rejects ${what}`, () => {
      const message = errorFor(change);
      assert.ok(message, 'compiled without an error');
      assert.match(message, pattern);
    });
  }
});
