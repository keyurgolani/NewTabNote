'use strict';

// #267's dark values, in the new tab's sheets and in Quiet Atlas's (css/design-tokens.css, built
// from design/quiet-atlas.tokens.json): the status tones keep their hue in dark, the row hover is
// the same step from the sidebar in both themes, Quiet Atlas's hover fill follows the hover while
// its tone and attention tints keep their own #2f2f2f, and the seam on a tinted row stays a seam.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../scripts/css-parser.js');
const { sheets, colors, read, shown } = require('./helpers/cascade');
const { createLegacyEnv } = require('./helpers/legacy-env');

const S = sheets();
const RECOVERY = sheets(['css/recovery.css']);
/** @type {any} */
let C;
/** @type {ReturnType<typeof colors>} */
let K;
before(async () => {
  C = await import('../js/design/contrast.js');
  K = colors(C, S.tokens);
});

/** design-tokens.css's :root, its data-scheme dark block, and the system copy under prefers-color-scheme: dark */
function quietAtlas() {
  const nodes = parse(read('css/design-tokens.css'));
  const of = (/** @type {any} */ rule) => Object.fromEntries(rule.declarations.filter((d) => d.property.startsWith('--')).map((d) => [d.property, d.value.trim().toLowerCase()]));
  const top = (/** @type {string} */ prelude) => nodes.find((n) => n.type === 'rule' && n.prelude.trim() === prelude);
  const media = nodes.find((n) => n.type === 'at-rule' && n.name === 'media' && n.prelude.trim() === '(prefers-color-scheme: dark)');
  const system = media && media.children.find((n) => n.type === 'rule' && n.prelude.trim() === ':root[data-scheme="system"]');
  assert.ok(top(':root') && top(':root[data-scheme="dark"]') && system, 'the light block and both dark blocks');
  return { light: of(top(':root')), dark: of(top(':root[data-scheme="dark"]')), system: of(system) };
}

/** Hue in degrees and saturation, as HSL reads an sRGB color */
function hsl(/** @type {{r: number, g: number, b: number}} */ { r, g, b }) {
  const [R, G, B] = [r, g, b].map((v) => v / 255);
  const [max, min] = [Math.max(R, G, B), Math.min(R, G, B)];
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  const h = 60 * (max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4);
  return { h, s: d / (1 - Math.abs(max + min - 1)) };
}

describe('the status tones in dark (css/editor.css, css/design-tokens.css)', () => {
  it("keeps each tone's hue within 10° and half its saturation, at 4.5:1 on the dark page, sidebar and tint", () => {
    const QA = quietAtlas();
    const tones = [
      ['editor.css --trust-ok', S.tokens.light['--trust-ok'], S.tokens.dark['--trust-ok']],
      ['editor.css --trust-action', S.tokens.light['--trust-action'], S.tokens.dark['--trust-action']],
      ...['--ink-local', '--ink-urgent'].flatMap((name) => [
        [`design-tokens.css ${name}, data-scheme dark`, QA.light[name], QA.dark[name]],
        [`design-tokens.css ${name}, the system copy`, QA.light[name], QA.system[name]],
      ]),
    ];
    const misses = [];
    for (const [name, lightValue, darkValue] of tones) {
      const [light, dark] = [K.colorOf(K.resolve(lightValue, 'light')), K.colorOf(K.resolve(darkValue, 'dark'))];
      const [a, b] = [hsl(light), hsl(dark)];
      const turn = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h));
      if (b.s < a.s / 2 || turn > 10) misses.push(`${name}: ${darkValue} turns ${turn.toFixed(1)}° at saturation ${b.s.toFixed(2)}, from ${a.s.toFixed(2)}`);
      for (const under of ['#191919', '#252525', '#2f2f2f']) {
        const value = K.ratio(dark, K.colorOf(under));
        if (value < 4.5) misses.push(`${name}: ${darkValue} on ${under} ${shown(value)}`);
      }
    }
    assert.deepEqual(misses, []);
  });
});

describe('the row hover in dark (css/editor.css, js/theme-engine.js)', () => {
  it('steps the hover from the sidebar as far in dark as in light, and the engine injects the same', () => {
    const step = (/** @type {'light' | 'dark'} */ theme) => K.ratio(K.token('--bg-hover', theme), K.token('--bg-secondary', theme));
    assert.ok(Math.abs(step('dark') - step('light')) <= 0.01, `the step is ${step('light').toFixed(3)} in light and ${step('dark').toFixed(3)} in dark`);
    const env = createLegacyEnv();
    env.load('js/theme-engine.js');
    assert.equal(env.get('Themes').darkProperties['--bg-hover'], S.tokens.dark['--bg-hover']);
  });

  it("gives Quiet Atlas's tone and attention tints their own dark #2f2f2f with no tie to the hover, while the hover moves", () => {
    const source = JSON.parse(read('design/quiet-atlas.tokens.json'));
    const QA = quietAtlas();
    const misses = [];
    for (const name of ['--tint-urgent', '--tint-local', '--tint-info', '--tint-pending']) {
      const dark = source.tokens[name].values.dark;
      const value = typeof dark === 'string' ? dark : dark.value;
      if (value.toLowerCase() !== '#2f2f2f') misses.push(`${name}'s dark value is ${value}`);
      if (typeof dark !== 'string' && dark.legacy) misses.push(`${name} is tied to ${dark.legacy}`);
      for (const [block, values] of [['data-scheme dark', QA.dark], ['the system copy', QA.system]]) {
        if (values[name] !== '#2f2f2f') misses.push(`${name} is ${values[name]} in ${block}`);
      }
    }
    if (S.tokens.dark['--bg-hover'] !== '#2a2a2a') misses.push(`the dark hover is ${S.tokens.dark['--bg-hover']}`);
    assert.deepEqual(misses, []);
  });

  it("draws the Trust Center's view links and quiet button on the dark hover (css/recovery.css)", () => {
    const misses = [];
    for (const text of ['.trust-views a:hover', '.trust-views a[aria-current="page"]', '.secondary-btn.trust-btn:hover']) {
      const rule = RECOVERY.rule(text);
      assert.ok(rule, text);
      const bg = rule.declarations.filter((d) => d.property === 'background' || d.property === 'background-color').pop();
      if (!bg || bg.value.trim() !== 'var(--surface-muted)') misses.push(`${text}: ${bg ? bg.value : 'no background'}`);
    }
    const QA = quietAtlas();
    for (const [block, values] of [['data-scheme dark', QA.dark], ['the system copy', QA.system]]) {
      if (values['--surface-muted'] !== '#2a2a2a') misses.push(`--surface-muted is ${values['--surface-muted']} in ${block}`);
    }
    assert.deepEqual(misses, []);
  });
});

describe('the seam on a tinted row (css/recovery.css, css/design-tokens.css)', () => {
  it('draws the divider above Also checked in --seam-tint, at least light\'s step from the attention tint in dark', () => {
    const rule = RECOVERY.rule('.trust-also');
    assert.ok(rule, '.trust-also');
    const border = rule.declarations.filter((d) => d.property === 'border-top').pop();
    assert.match(border ? border.value : '', /var\(--seam-tint\)/);
    const QA = quietAtlas();
    const step = (/** @type {Record<string, string>} */ values, /** @type {string} */ block) => {
      assert.ok(values['--seam-tint'], `--seam-tint is set in ${block}`);
      return K.ratio(K.colorOf(values['--seam-tint']), K.colorOf(values['--tint-urgent']));
    };
    const light = step(QA.light, 'the light block');
    for (const [block, values] of [['data-scheme dark', QA.dark], ['the system copy', QA.system]]) {
      const value = step(values, block);
      assert.ok(value >= light, `${block}: ${value.toFixed(3)}, under light's ${light.toFixed(3)}`);
    }
  });
});
