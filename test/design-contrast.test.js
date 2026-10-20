'use strict';

// Quiet Atlas validator (#16 slice 1): js/design/contrast.js against the generated
// js/design/tokens.generated.js. Both are ES modules, so this CommonJS suite
// imports them.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

/** @type {typeof import('../js/design/contrast.js')} */
let C;
/** @type {import('../js/design/contrast.js').DesignTokenData} */
let DATA;

before(async () => {
  C = await import('../js/design/contrast.js');
  DATA = (await import('../js/design/tokens.generated.js')).DESIGN_TOKENS;
});

const ratio = (fg, bg) => C.contrastRatio(C.parseColor(fg), C.parseColor(bg));
const round = value => Math.round(value * 100) / 100;

/** A fixture: the generated data, unfrozen, after `change` */
function fixture(change) {
  const data = structuredClone(DATA);
  change(data);
  return data;
}

describe('colors', () => {
  it('parses the theme grammar: #rgb, #rrggbb, #rrggbbaa, and numeric rgb() and rgba()', () => {
    assert.deepEqual(C.parseColor('#abc'), { r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
    assert.deepEqual(C.parseColor('#253443'), { r: 37, g: 52, b: 67, a: 1 });
    assert.deepEqual(C.parseColor('#25344366'), { r: 37, g: 52, b: 67, a: 0x66 / 255 });
    assert.deepEqual(C.parseColor('rgb(37, 52, 67)'), { r: 37, g: 52, b: 67, a: 1 });
    assert.deepEqual(C.parseColor('rgba(37, 52, 67, 0.5)'), { r: 37, g: 52, b: 67, a: 0.5 });
    assert.deepEqual(C.parseColor('rgb(37 52 67 / 12%)'), { r: 37, g: 52, b: 67, a: 0.12 });
    assert.deepEqual(C.parseColor(' RGB(100% 0% 0%) '), { r: 255, g: 0, b: 0, a: 1 });
  });

  it('rejects everything else, url() and var() included', () => {
    for (const value of ['#abcd', '#12345', 'red', 'transparent', 'Canvas', 'hsl(0 0% 0%)', 'rgb(0 0 0 0)', 'rgb(256, 0, 0)',
      'rgba(0, 0, 0, 1.5)', 'rgb(var(--x), 0, 0)', 'var(--surface-paper)', 'url(https://example.test/x.png)',
      'rgb(0, 0, 0); color: red', '', null, 42, undefined]) {
      assert.equal(C.parseColor(value), null, String(value));
    }
  });

  it('formats lowercase hex, with alpha only when the color isn\'t opaque', () => {
    assert.equal(C.formatHex({ r: 37, g: 52, b: 67, a: 1 }), '#253443');
    assert.equal(C.formatHex({ r: 113, g: 132, b: 163, a: 0.3 }), '#7184a34d');
    assert.equal(C.formatHex(C.parseColor('RGB(255 255 255 / 0%)')), '#ffffff00');
  });

  it('composites source-over in sRGB', () => {
    const mist30 = C.parseColor('#7184A34D');
    const paper = C.parseColor('#FFFFFF');
    assert.equal(C.formatHex(C.compositeOver(mist30, paper)), '#d4dae3');
    assert.deepEqual(C.compositeOver(paper, mist30), paper);
  });

  it('computes WCAG 2.x ratios, matching every figure the issue gives', () => {
    assert.equal(round(ratio('#000000', '#FFFFFF')), 21);
    assert.equal(round(ratio('#FFFFFF', '#FFFFFF')), 1);
    assert.equal(round(ratio('#315F8A', '#191919')), 2.62);
    assert.equal(round(ratio('#253443', '#B78E76')), 4.33);
    assert.equal(round(ratio('#253443', '#7184A3')), 3.35);
    assert.equal(round(ratio('#FFFFFF', '#7184A3')), 3.8);
    assert.deepEqual(['#191919', '#252525', '#2F2F2F'].map(bg => round(ratio('#9B9B9B', bg))), [6.33, 5.51, 4.82]);
    assert.deepEqual(['#E0E0E0', '#9B9B9B', '#7089A2', '#536C86'].map(fg => round(ratio(fg, '#191919'))), [13.32, 6.33, 4.85, 3.23]);
    for (const surface of ['#FFFFFF', '#F4F6F3', '#E7EDEB', '#E9EDF3', '#E8ECEA']) {
      // The issue rounds to two decimals: 3.3876 on --surface-muted is its 3.39
      assert.ok(round(ratio('#778179', surface)) >= 3.39, `--control-boundary on ${surface}`);
    }
    for (const step of ['#253443', '#3B5065', '#536C86', '#7089A2']) {
      assert.ok(ratio(step, '#FFFFFF') >= 3, `chart step ${step} on paper`);
    }
  });

  it('composites a translucent foreground first and refuses a translucent background', () => {
    assert.equal(round(ratio('#00000000', '#FFFFFF')), 1);
    assert.throws(() => ratio('#000000', '#FFFFFF80'), /opaque background/);
  });

  it('knows the CSS system colors', () => {
    assert.ok(C.isSystemColor('Highlight'));
    assert.ok(C.isSystemColor('canvastext'));
    assert.ok(!C.isSystemColor('white'));
    assert.ok(!C.isSystemColor('#000000'));
  });
});

describe('validate passes Quiet Atlas (AC4)', () => {
  const named = [
    ['light', {}],
    ['contrast-more', { contrast: 'more' }],
    ['forced colors', { forcedColors: 'active' }],
    ['reduced motion', { motion: 'reduce' }],
    ['compact', { density: 'compact' }],
    ['narrow', { canvasWidth: 'narrow' }],
  ];
  for (const [what, variant] of named) {
    it(`passes the default in ${what}, in every declared state`, () => {
      const report = C.validate(DATA, { variant });
      assert.deepEqual(report.failures, []);
      assert.equal(report.ok, true);
      assert.deepEqual(report.reported, []);
    });
  }

  it('checks pairs in every state the matrix declares', () => {
    const states = [...new Set(DATA.pairs.map(pair => pair.state))].sort();
    assert.deepEqual(states, ['active', 'checked', 'disabled', 'error', 'focus', 'hover', 'rest']);
    // Break every pair of each state at once and see each one rejected
    for (const state of states.filter(s => s !== 'disabled')) {
      const data = fixture(d => {
        d.pairs = d.pairs.filter(pair => pair.state === state).map(pair => ({ ...pair, fg: pair.bg, inner: pair.inner ? pair.bg : undefined }));
      });
      const report = C.validate(data);
      assert.equal(report.failures.length, data.pairs.length, state);
      assert.ok(report.failures.every(f => f.state === state), state);
    }
  });

  it('passes every combination of every axis, reporting legacy pairs in dark only', () => {
    const legacy = new Set(DATA.legacyDark.pairs);
    const variants = C.allVariants(DATA);
    assert.equal(variants.length, 2 * 2 * 2 * 2 * 2 * 3 * 4);
    for (const variant of variants) {
      const report = C.validate(DATA, { variant });
      assert.deepEqual(report.failures, [], report.variant);
      if (variant.scheme === 'dark' && variant.forcedColors === 'none') {
        assert.deepEqual(new Set(report.reported.map(r => r.pair)), legacy, report.variant);
      } else {
        assert.deepEqual(report.reported, [], report.variant);
      }
    }
  });

  it('passes dark, compact, contrast-more, and serif together, with every axis applied', () => {
    const variant = { scheme: 'dark', density: 'compact', contrast: 'more', readingFont: 'serif' };
    const report = C.validate(DATA, { variant });
    assert.equal(report.ok, true);
    assert.equal(report.variant, 'dark, contrast=more, density=compact, readingFont=serif');
    assert.deepEqual(report.reported.map(r => r.pair).sort(), [...DATA.legacyDark.pairs].sort());
    const { values } = C.resolveTokens(DATA, { ...DATA.variants.default, ...variant });
    assert.equal(values['--surface-paper'], '#191919');
    assert.equal(values['--text-secondary'], '#e0e0e0');
    assert.equal(values['--space-region'], '0.75rem');
    assert.equal(values['--font-reading'], 'Georgia, \'Times New Roman\', serif');
    assert.equal(values['--focus-width'], '3px');
  });
});

describe('validate rejects inaccessible and incomplete combinations (AC4)', () => {
  it('names the token, pair, variant, state, rule, measured ratio, and required ratio', () => {
    const report = C.validate(DATA, { overrides: { '--text-secondary': '#A0A8AD' } });
    assert.equal(report.ok, false);
    const rejection = report.failures.find(f => f.pair === 'plane-muted/rest/text-secondary');
    assert.ok(rejection);
    assert.equal(rejection.token, '--text-secondary');
    assert.equal(rejection.background, '--surface-muted');
    assert.equal(rejection.variant, 'light');
    assert.equal(rejection.state, 'rest');
    assert.equal(rejection.rule, 'text-contrast');
    assert.equal(rejection.required, 4.5);
    assert.equal(rejection.measured, Math.floor(ratio('#A0A8AD', '#E8ECEA') * 100) / 100);
    assert.match(rejection.message, /--text-secondary on --surface-muted \(plane-muted\/rest\/text-secondary\) in light, rest fails text contrast: \d\.\d+:1, needs 4\.5:1/);
    for (const failure of report.failures) {
      for (const field of ['token', 'pair', 'variant', 'state', 'rule', 'measured', 'required']) {
        assert.notEqual(failure[field], null, `${failure.pair} ${field}`);
      }
    }
  });

  it('rejects a non-text pair below 3:1', () => {
    const report = C.validate(DATA, { variant: { canvasWidth: 'wide' }, overrides: { '--state-danger': '#E8A39C' } });
    const boundary = report.failures.find(f => f.pair === 'input-text/error/boundary');
    assert.equal(boundary.rule, 'non-text-contrast');
    assert.equal(boundary.required, 3);
    assert.ok(boundary.measured < 3);
  });

  it('rejects a token with no value in the variant', () => {
    const data = fixture(d => { delete d.tokens['--surface-paper'].values.darkMore; });
    const report = C.validate(data, { variant: { scheme: 'dark', contrast: 'more' } });
    const missing = report.failures.find(f => f.rule === 'complete');
    assert.equal(missing.token, '--surface-paper');
    assert.equal(missing.variant, 'dark, contrast=more');
    assert.equal(C.validate(data).ok, true, 'light still has its value');
  });

  it('rejects a variant value or dimension that doesn\'t exist', () => {
    const report = C.validate(DATA, { variant: { density: 'ultra', theme: 'dark' } });
    assert.equal(report.ok, false);
    assert.deepEqual(report.failures.map(f => [f.rule, f.measured]), [['variant', 'ultra'], ['variant', 'theme']]);
  });

  it('rejects overrides outside the grammar or the overridable tokens', () => {
    const report = C.validate(DATA, {
      overrides: {
        '--surface-paper': 'url(https://example.test/a.png)',
        '--surface-app': 'var(--surface-paper)',
        '--surface-muted': 'white',
        '--focus-ring': '#000000',
        '--not-a-token': '#000000',
      },
    });
    assert.deepEqual(report.failures.map(f => [f.rule, f.token]), [
      ['invalid-value', '--surface-paper'],
      ['invalid-value', '--surface-app'],
      ['invalid-value', '--surface-muted'],
      ['not-overridable', '--focus-ring'],
      ['unknown-token', '--not-a-token'],
    ]);
  });

  it('applies a valid override everywhere but forced colors', () => {
    const overrides = { '--surface-paper': 'rgb(250, 250, 250)' };
    assert.equal(C.resolveTokens(DATA, { ...DATA.variants.default, scheme: 'dark' }, overrides).values['--surface-paper'], '#fafafa');
    assert.equal(C.resolveTokens(DATA, { ...DATA.variants.default, forcedColors: 'active' }, overrides).values['--surface-paper'], 'Canvas');
  });
});

describe('dark on legacy values (AC7)', () => {
  it('reports today\'s failing legacy pairs without blocking', () => {
    const report = C.validate(DATA, { variant: { scheme: 'dark' } });
    assert.equal(report.ok, true);
    assert.deepEqual(report.reported.map(r => r.pair).sort(), [...DATA.legacyDark.pairs].sort());
    for (const entry of report.reported) {
      assert.ok(entry.measured < entry.required, entry.pair);
      assert.match(entry.message, /legacy dark pair/);
    }
  });

  it('blocks a new dark pair below its required ratio', () => {
    const data = fixture(d => {
      d.pairs.push({ id: 'chip-urgent/hover/danger', component: 'chip-urgent', state: 'hover', part: 'danger', kind: 'text', fg: '--state-danger', bg: '--tint-urgent' });
    });
    assert.equal(C.validate(data).ok, true, 'it passes in light');
    const report = C.validate(data, { variant: { scheme: 'dark' } });
    assert.equal(report.ok, false);
    assert.deepEqual(report.failures.map(f => f.pair), ['chip-urgent/hover/danger']);
    assert.equal(report.failures[0].required, 4.5);
  });

  it('blocks a dark non-text or focus pair under 3:1', () => {
    const data = fixture(d => {
      d.tokens['--focus-ring-inner'].values.dark = d.tokens['--focus-ring'].values.dark;
      d.tokens['--chart-4'].values.dark = '#3a3a3a';
    });
    const report = C.validate(data, { variant: { scheme: 'dark' } });
    const rules = new Set(report.failures.map(f => f.rule));
    assert.deepEqual([...rules].sort(), ['focus-contrast', 'non-text-contrast']);
    assert.ok(report.failures.find(f => f.pair === 'chart/rest/step-4'));
  });

  it('doesn\'t excuse a listed pair outside dark', () => {
    const report = C.validate(DATA, { overrides: { '--state-danger': '#E03E3E' } });
    assert.ok(report.failures.find(f => f.pair === 'error-text/rest/on-paper'));
    assert.deepEqual(report.reported, []);
  });

  it('blocks a listed pair once an override makes it worse than its legacy ratio, and keeps reporting one that improves', () => {
    const variant = { scheme: 'dark' };
    const id = 'error-text/rest/on-paper';
    const legacy = C.validate(DATA, { variant }).reported.find(r => r.pair === id);
    assert.ok(legacy);

    // A lighter paper drops danger text further below 4.5:1
    const worse = C.validate(DATA, { variant, overrides: { '--surface-paper': '#3A3A3A' } });
    const failure = worse.failures.find(f => f.pair === id);
    assert.ok(failure, 'the worse override is blocked');
    assert.equal(failure.rule, 'text-contrast');
    assert.ok(failure.measured < legacy.measured);
    assert.match(failure.message, new RegExp(`below its legacy ${legacy.measured.toFixed(2)}:1`));
    assert.ok(!worse.reported.find(r => r.pair === id));

    // A darker paper still misses 4.5:1 but beats legacy, so it stays reported
    const better = C.validate(DATA, { variant, overrides: { '--surface-paper': '#101010' } });
    assert.ok(!better.failures.find(f => f.pair === id));
    const reported = better.reported.find(r => r.pair === id);
    assert.ok(reported && reported.measured > legacy.measured && reported.measured < 4.5);
  });
});

describe('forced colors', () => {
  const forced = { forcedColors: 'active' };
  const forcedPair = (data, id) => {
    const { values } = C.resolveTokens(data, { ...data.variants.default, ...forced });
    const pair = data.pairs.find(p => p.id === id);
    return `${values[pair.fg]} on ${values[pair.bg]}`;
  };

  it('puts each text-bearing fill on its CSS Color 4 partner', () => {
    assert.equal(forcedPair(DATA, 'nav-item/active/label'), 'SelectedItemText on SelectedItem');
    assert.equal(forcedPair(DATA, 'nav-item/active/marker'), 'SelectedItemText on SelectedItem');
    assert.equal(forcedPair(DATA, 'button-primary/rest/label'), 'ButtonText on ButtonFace');
    assert.equal(forcedPair(DATA, 'button-destructive/rest/label'), 'ButtonText on ButtonFace');
    assert.equal(forcedPair(DATA, 'mark/rest/text'), 'MarkText on Mark');
    assert.equal(forcedPair(DATA, 'selection/rest/on-paper'), 'HighlightText on Highlight');
    assert.equal(forcedPair(DATA, 'link/rest/on-paper'), 'LinkText on Canvas');
    assert.equal(forcedPair(DATA, 'error-text/rest/on-paper'), 'CanvasText on Canvas');
  });

  it('rejects a pair that isn\'t a legible system pair, naming the token, pair, variant, state, and both colors', () => {
    const data = fixture(d => {
      d.tokens['--state-local'].values.forced = 'CanvasText';
      d.tokens['--text-on-sage'].values.forced = 'CanvasText';
      d.tokens['--surface-muted'].values.forced = 'ButtonFace';
    });
    const failures = C.validate(data, { variant: forced }).failures.filter(f => f.rule === 'forced-colors-pair');
    assert.deepEqual(failures.map(f => [f.pair, f.measured]), [
      ['plane-muted/rest/text-primary', 'CanvasText on ButtonFace'],
      ['plane-muted/rest/text-secondary', 'CanvasText on ButtonFace'],
      ['nav-item/active/label', 'CanvasText on CanvasText'],
      ['nav-item/active/marker', 'CanvasText on CanvasText'],
      ['button-quiet/hover/label', 'CanvasText on ButtonFace'],
      ['chip-neutral/rest/label', 'CanvasText on ButtonFace'],
      ['chip-neutral/rest/marker', 'CanvasText on ButtonFace'],
      ['chip-danger/rest/label', 'CanvasText on ButtonFace'],
      ['chip-danger/rest/marker', 'CanvasText on ButtonFace'],
    ]);
    const nav = failures.find(f => f.pair === 'nav-item/active/label');
    assert.deepEqual([nav.token, nav.background, nav.variant, nav.state], ['--text-on-sage', '--state-local', 'light, forcedColors=active', 'active']);
    assert.match(nav.message, /isn't a background in CSS Color 4's legible pairs/);
    const quiet = failures.find(f => f.pair === 'button-quiet/hover/label');
    assert.equal(quiet.required, 'ButtonText on ButtonFace');
  });

  it('needs the focus ring unregistered, so Highlight reaches outline-color as a keyword', () => {
    assert.equal(DATA.tokens['--focus-ring'].registered, false);
    const data = fixture(d => { d.tokens['--focus-ring'].registered = true; });
    const failure = C.validate(data, { variant: forced }).failures.find(f => f.rule === 'forced-colors' && f.token === '--focus-ring');
    assert.ok(failure, 'a registered focus ring is rejected');
    assert.match(failure.message, /registered as <color>/);
    assert.equal(C.validate(data).ok, true, 'registration only matters in forced colors');
  });

  it('draws Highlight focus against Canvas: a Canvas surface, or a Canvas inner ring on any other', () => {
    assert.equal(forcedPair(DATA, 'focus-ring/focus/on-sage'), 'Highlight on SelectedItem');
    assert.equal(C.validate(DATA, { variant: forced }).ok, true);
    const data = fixture(d => { d.tokens['--focus-ring-inner'].values.forced = 'SelectedItem'; });
    const failures = C.validate(data, { variant: forced }).failures.filter(f => f.rule === 'forced-colors-pair');
    assert.deepEqual(failures.map(f => [f.pair, f.measured, f.required]), [
      ['focus-ring/focus/on-sage', 'Highlight on SelectedItem, inner ring SelectedItem', 'Highlight on Canvas, or an inner ring in Canvas'],
    ]);
  });
});

describe('focus', () => {
  it('passes dark focus through the inner ring where Focus Blue alone is under 3:1', () => {
    assert.ok(ratio('#315F8A', '#191919') < 3);
    const report = C.validate(DATA, { variant: { scheme: 'dark' } });
    assert.equal(report.failures.filter(f => f.rule === 'focus-contrast').length, 0);
  });

  it('fails when neither the outer ring nor the inner ring reaches 3:1, and says which ring measured what', () => {
    const data = fixture(d => { d.tokens['--focus-ring-inner'].values.light = d.tokens['--surface-navigation'].values.light; });
    const failure = C.validate(data).failures.find(f => f.pair === 'focus-ring/focus/on-navigation');
    assert.equal(failure.rule, 'focus-contrast');
    assert.equal(failure.required, 3);
    assert.match(failure.message, /outer ring \d\.\d+:1 on the surface, inner ring \d\.\d+:1 on the outer ring and \d\.\d+:1 on the surface/);
  });

  it('needs a 3px focus outline in contrast-more and 2px otherwise', () => {
    const data = fixture(d => { d.tokens['--focus-width'].values.more = '2px'; });
    const failure = C.validate(data, { variant: { contrast: 'more' } }).failures.find(f => f.rule === 'focus-width');
    assert.deepEqual([failure.token, failure.measured, failure.required], ['--focus-width', '2px', '3px']);
    assert.equal(C.validate(data).ok, true);
  });
});

describe('static checks', () => {
  it('rejects a font size that isn\'t rem', () => {
    const data = fixture(d => { d.tokens['--type-title-size'].values.sans = '24px'; });
    const failure = C.validate(data).failures.find(f => f.rule === 'type-unit');
    assert.deepEqual([failure.token, failure.measured], ['--type-title-size', '24px']);
  });

  it('rejects a font size that can drop below the label floor, clamp() included', () => {
    const data = fixture(d => {
      d.tokens['--type-title-size'].values.serif = '0.7rem';
      d.tokens['--type-headline-size'].values.serif = 'clamp(0.6rem, 3vw, 3rem)';
    });
    const failures = C.validate(data, { variant: { readingFont: 'serif' } }).failures.filter(f => f.rule === 'type-floor');
    assert.deepEqual(failures.map(f => [f.token, f.measured, f.required]), [
      ['--type-headline-size', '0.6rem', '0.8rem'],
      ['--type-title-size', '0.7rem', '0.8rem'],
    ]);
  });

  it('keeps 44 by 44 CSS px targets in compact', () => {
    const data = fixture(d => { d.tokens['--target-min'].values.compact = '40px'; });
    assert.equal(C.validate(data).ok, true);
    const failure = C.validate(data, { variant: { density: 'compact' } }).failures.find(f => f.rule === 'target');
    assert.deepEqual([failure.token, failure.measured, failure.required], ['--target-min', '40px', '44px']);
  });

  it('needs 1ms durations and no transform under reduced motion', () => {
    const data = fixture(d => {
      d.tokens['--motion-layer'].values.reduce = '0ms';
      d.tokens['--ease-out'].values.reduce = 'translateY(8px)';
    });
    const failures = C.validate(data, { variant: { motion: 'reduce' } }).failures.filter(f => f.rule === 'reduced-motion');
    assert.deepEqual(failures.map(f => f.token), ['--motion-layer', '--ease-out']);
    assert.equal(C.validate(data).ok, true, 'standard motion has no such rule');
  });

  it('needs system colors, Highlight focus, and visible boundaries in forced colors', () => {
    const data = fixture(d => {
      d.tokens['--surface-paper'].values.forced = '#ffffff';
      d.tokens['--focus-ring'].values.forced = 'CanvasText';
      d.tokens['--control-boundary'].values.forced = 'Canvas';
    });
    const failures = C.validate(data, { variant: { forcedColors: 'active' } }).failures.filter(f => f.rule === 'forced-colors');
    assert.deepEqual(failures.map(f => [f.token, f.measured]), [
      ['--surface-paper', '#ffffff'],
      ['--focus-ring', 'CanvasText'],
      ['--control-boundary', 'Canvas'],
    ]);
  });

  it('reports disabled pairs as advisories, composited at the disabled opacity over their backdrop', () => {
    const report = C.validate(DATA);
    const disabled = report.advisories.filter(a => a.rule === 'disabled-contrast');
    assert.deepEqual(disabled.map(a => a.pair).sort(), DATA.pairs.filter(p => p.state === 'disabled').map(p => p.id).sort());
    const opacity = Number(DATA.tokens['--disabled-opacity'].values.light);
    const pair = DATA.pairs.find(p => p.id === 'button-primary/disabled/label');
    const light = token => C.parseColor(DATA.tokens[token].values.light);
    const fade = color => C.compositeOver({ ...color, a: opacity }, light(pair.over));
    const expected = C.contrastRatio(fade(light(pair.fg)), fade(light(pair.bg)));
    const primary = disabled.find(a => a.pair === 'button-primary/disabled/label');
    assert.equal(primary.measured, Math.floor(expected * 100) / 100);
    assert.ok(primary.measured < 4.5, 'disabled labels fade below active contrast');
  });

  it('flags wide and full canvas widths as advisories', () => {
    for (const canvasWidth of ['wide', 'full']) {
      const report = C.validate(DATA, { variant: { canvasWidth } });
      assert.equal(report.ok, true);
      assert.ok(report.advisories.find(a => a.rule === 'canvasWidth-advisory'), canvasWidth);
    }
    assert.ok(!C.validate(DATA, { variant: { canvasWidth: 'narrow' } }).advisories.find(a => a.rule === 'canvasWidth-advisory'));
  });

  it('lists what only rendered checks can see', () => {
    const { limits } = C.validate(DATA);
    assert.ok(limits.length >= 4);
    assert.ok(limits.some(limit => /44 by 44/.test(limit)));
    assert.ok(limits.some(limit => /forced colors/i.test(limit)));
    assert.ok(limits.some(limit => /reduced motion/i.test(limit)));
  });

  it('leaves its input untouched', () => {
    const data = structuredClone(DATA);
    const before = JSON.stringify(data);
    C.validate(data, { variant: { scheme: 'dark' }, overrides: { '--surface-paper': '#fafafa' } });
    assert.equal(JSON.stringify(data), before);
  });
});
