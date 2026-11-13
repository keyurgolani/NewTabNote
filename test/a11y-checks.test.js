'use strict';

// #24 slice 2: the check library's pure parts, which run under npm test with no browser:
// - hit boxes against 44 by 44, with the contract's three exemptions;
// - the focus ring's contrast against each plane beside it, with alpha composited first and a
//   two-tone ring measured as #16 measures one;
// - the chords Chrome keeps for itself;
// - what reduced motion forbids;
// - a tab stop nobody sees, in a collapsed, off-screen or transparent layer, a step that leaves
//   focus on body, and tab order that runs back along a line or up a column;
// - how a live region announces, for the announcement recorder, which won't read a page it isn't
//   recording;
// - an action that a parent cuts off or that scrolling can't reach;
// - the matrix runner's points, their viewports, and what a test at one records.
// The browser checks read the page and hand these what they measured.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

/** @type {any} */ let targets;
/** @type {any} */ let ring;
/** @type {any} */ let chords;
/** @type {any} */ let motion;
/** @type {any} */ let contrast;
before(async () => {
  targets = await import('./a11y/checks/targets.mjs');
  ring = await import('./a11y/checks/ring.mjs');
  chords = await import('./a11y/checks/chords.mjs');
  motion = await import('./a11y/checks/motion.mjs');
  contrast = await import('../js/design/contrast.js');
});

describe("the accessibility checks' pure parts (#24 slice 2)", () => {
  it('finds a hit box under 44 by 44 either way, unless the contract exempts it', () => {
    const box = (/** @type {string} */ id, /** @type {number} */ width, /** @type {number} */ height, exempt = '') => ({
      id,
      width,
      height,
      ...(exempt ? { exempt } : {}),
    });
    const short = targets.smallTargets([
      box('fits', 44, 44),
      box('narrow', 43, 44),
      box('short', 44, 43.5),
      // Only floating-point error is spared: layout's nearest box under 44 is 43.984375
      box('subpixel', 43.995, 44),
      box('layout-step', 44 - 1 / 64, 44),
      box('just-under', 43.98, 44),
      box('float-error', 44 - 1e-9, 44),
      box('todo-checkbox', 20, 20),
      box('inline-link', 30, 18, 'inline-link'),
      box('editor', 600, 20, 'editing-area'),
      box('decorated', 20, 20, 'decorative'),
    ]);
    assert.deepEqual(short.map((/** @type {any} */ t) => t.id), ['narrow', 'short', 'subpixel', 'layout-step', 'just-under', 'todo-checkbox', 'decorated']);
    assert.deepEqual(targets.EXEMPTIONS, ['editing-area', 'browser-ui', 'inline-link']);
    assert.equal(targets.TARGET_MIN, 44);
  });

  it('measures the focus ring against each plane beside it, alpha first, and a two-tone ring as #16 does', () => {
    const short = (/** @type {object} */ r, /** @type {object[]} */ planes) =>
      ring.ringShortfalls(r, planes).map((/** @type {any} */ s) => s.plane);
    const paper = [{ id: 'paper', color: '#ffffff' }];
    assert.deepEqual(short({ outer: '#000000' }, paper), []);
    assert.deepEqual(short({ outer: '#cccccc' }, paper), ['paper']);
    // A translucent ring composites onto the plane first
    assert.deepEqual(short({ outer: 'rgba(0, 0, 0, 0.2)' }, paper), ['paper']);
    // A translucent plane composites onto what's under it
    const glass = [{ id: 'glass', color: 'rgba(255, 255, 255, 0.5)', over: '#000000' }];
    assert.deepEqual(short({ outer: '#000000' }, glass), []);
    assert.deepEqual(short({ outer: '#777777' }, glass), ['glass']);
    // The inner ring carries an outer ring too close to the plane, as #16's two-tone rule has it
    const dark = [{ id: 'slate', color: '#444444' }, { id: 'ink', color: '#333333' }];
    assert.deepEqual(short({ outer: '#555555' }, dark), ['slate', 'ink']);
    assert.deepEqual(short({ outer: '#555555', inner: '#ffffff' }, dark), []);
    // #16's inner ring fills the offset, so it's painted on the plane beside the outer ring: half
    // white on slate is #999, under 3:1 against the outer ring, where over the outer ring it'd pass
    assert.deepEqual(short({ outer: '#555555', inner: 'rgba(255, 255, 255, 0.5)' }, [{ id: 'slate', color: '#333333' }]), ['slate']);
    // A translucent plane on a translucent backdrop can't be measured, and the check names the plane
    const veil = [{ id: 'veil', color: 'rgba(255, 255, 255, 0.5)', over: 'rgba(0, 0, 0, 0.5)' }];
    assert.throws(() => short({ outer: '#000000' }, veil), { name: 'TypeError', message: /plane veil: what's under it, "rgba\(0, 0, 0, 0\.5\)", isn't opaque/ });
    // The bar is 3:1: #959595 on white is 2.995:1 and falls short, #949494 is 3.034:1 and passes
    assert.equal(ring.RING_MIN, 3);
    assert.deepEqual(short({ outer: '#959595' }, paper), ['paper']);
    assert.deepEqual(short({ outer: '#949494' }, paper), []);
    // Focus Blue alone on dark paper is 2.624:1, the case #16's inner ring is for
    const darkPaper = [{ id: 'dark-paper', color: '#191919' }];
    assert.deepEqual(short({ outer: '#315F8A' }, darkPaper), ['dark-paper']);
    assert.deepEqual(short({ outer: '#315F8A', inner: '#ffffff' }, darkPaper), []);
    // Chrome computes a color-mix() in sRGB as color(srgb …), with its alpha after a slash
    const mixed = [{ id: 'active-row', color: 'color(srgb 0.897255 0.885961 0.942902)' }, { id: 'tint', color: 'color(srgb 0.431373 0.337255 0.811765 / 0.1)' }];
    assert.deepEqual(short({ outer: '#000000' }, mixed), []);
    // A white ring on the tint falls short only with its alpha applied: 1.145:1, where an opaque tint gives 5.391:1
    const onTint = ring.ringShortfalls({ outer: '#ffffff' }, [mixed[1]]);
    assert.deepEqual(onTint.map((/** @type {any} */ s) => [s.plane, s.ratio.toFixed(3)]), [['tint', '1.145']]);
    assert.deepEqual(short({ outer: 'color(srgb 0.4 0.4 1)' }, paper), []);
    assert.deepEqual(short({ outer: 'color(srgb 0.6 0.6 0.6)' }, paper), ['paper']);
    // A color in another space is a TypeError that names the space
    assert.throws(() => short({ outer: 'color(display-p3 0.2 0.3 0.9)' }, paper), { name: 'TypeError', message: /"color\(display-p3 0\.2 0\.3 0\.9\)" is in display-p3, not sRGB/ });
    assert.throws(() => short({ outer: '#000000' }, [{ id: 'deep', color: 'oklch(0.3 0.1 250)' }]), { name: 'TypeError', message: /"oklch\(0\.3 0\.1 250\)" is in oklch, not sRGB/ });
    assert.equal(typeof contrast.measure, 'function');
  });

  it('finds a binding on a chord Chrome keeps for itself on any platform, and one it cannot read', () => {
    const found = chords.reservedBindings([
      { id: 'new-note', chord: 'Mod+Shift+K' },
      { id: 'steals-new-tab', chord: 'Mod+T' },
      { id: 'garbled', chord: 'Mod++' },
    ]);
    assert.deepEqual([...new Set(found.map((/** @type {any} */ f) => f.id))], ['steals-new-tab', 'garbled']);
    assert.deepEqual(found.find((/** @type {any} */ f) => f.id === 'garbled').reason, 'unreadable');
  });

  it('finds what moves under reduced motion: a transform transition, smooth scroll, a chart that animates', () => {
    const moves = (/** @type {object} */ style) => motion.motionProblems(style);
    assert.deepEqual(moves({ transitionProperty: 'transform', transitionDuration: '0.2s' }), ['transform-transition']);
    assert.deepEqual(moves({ transitionProperty: 'all', transitionDuration: '150ms' }), ['transform-transition']);
    assert.deepEqual(moves({ transitionProperty: 'opacity', transitionDuration: '0.2s' }), []);
    // Durations pair with properties by place, and repeat when there are fewer of them
    assert.deepEqual(moves({ transitionProperty: 'transform, opacity', transitionDuration: '0s, 0.3s' }), []);
    assert.deepEqual(moves({ transitionProperty: 'opacity, transform', transitionDuration: '0.3s' }), ['transform-transition']);
    assert.deepEqual(moves({ scrollBehavior: 'smooth' }), ['smooth-scroll']);
    assert.deepEqual(moves({ chartAnimation: true }), ['chart-animation']);
    // translate, rotate and scale move an element just as transform does
    for (const property of ['translate', 'rotate', 'scale']) {
      assert.deepEqual(moves({ transitionProperty: property, transitionDuration: '0.2s' }), ['transform-transition'], property);
    }
    assert.deepEqual(moves({ transitionProperty: 'opacity, scale', transitionDuration: '0s, 0.2s' }), ['transform-transition']);
    // Keyframed movement too, as #16's motion rule drops translation and scaling
    assert.deepEqual(moves({ animations: [{ properties: ['opacity', 'translate'], duration: 300 }] }), ['transform-animation']);
    assert.deepEqual(moves({ animations: [{ properties: ['transform'], duration: 300 }] }), ['transform-animation']);
    assert.deepEqual(moves({ animations: [{ properties: ['opacity'], duration: 300 }, { properties: ['scale'], duration: 0 }] }), []);
    assert.deepEqual(moves({ scrollBehavior: 'auto', chartAnimation: false }), []);
    assert.deepEqual(motion.REDUCED_MOTION_RULES, ['transform-transition', 'transform-animation', 'smooth-scroll', 'chart-animation']);
  });
});

// The browser halves' pure parts: axe's results as findings, one per node a rule fails, with #29's
// tags, and the rule IDs the custom checks report under. test/a11y/checks/checks.spec.js runs the
// halves themselves in Chromium.
describe("the browser halves' pure parts (#24 slice 2)", () => {
  /** @type {any} */ let axe;
  before(async () => {
    axe = await import('./a11y/checks/axe.mjs');
  });

  it("runs axe with #29's tags and makes each node a rule fails a finding, through frames and shadow roots", () => {
    assert.deepEqual(axe.TAGS, ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
    const results = {
      violations: [
        { id: 'button-name', nodes: [{ target: ['#save'] }, { target: ['iframe.preview', '#close'] }] },
        { id: 'label', nodes: [{ target: [['#editor-host', 'input.title']] }] },
      ],
      passes: [{ id: 'region', nodes: [{ target: ['main'] }] }],
    };
    assert.deepEqual(axe.axeFindings(results), [
      { rule: 'button-name', target: '#save' },
      { rule: 'button-name', target: 'iframe.preview >>> #close' },
      { rule: 'label', target: '#editor-host >>> input.title' },
    ]);
    assert.deepEqual(axe.axeFindings({ violations: [] }), []);
  });

  it("composites a box-shadow ring's inner ring onto the outer one it's stacked on, not onto the plane", () => {
    const slate = [{ id: 'slate', color: '#333333' }];
    const halfWhite = { outer: '#555555', inner: 'rgba(255, 255, 255, 0.5)' };
    assert.deepEqual(ring.ringShortfalls({ ...halfWhite, innerOn: 'outer' }, slate), []);
    assert.deepEqual(ring.ringShortfalls(halfWhite, slate).map((/** @type {any} */ s) => s.plane), ['slate']);
  });

  it('fades a ring by the opacity it shows at over a plane, as on a control with opacity or under a parent with it', () => {
    const blue = { outer: '#1869ba' };
    const white = { id: 'around', color: '#ffffff' };
    assert.deepEqual(ring.ringShortfalls(blue, [white]), []);
    const faded = ring.ringShortfalls(blue, [{ ...white, ringOpacity: 0.6 }]);
    assert.deepEqual(faded.map((/** @type {any} */ s) => s.plane), ['around']);
    assert.equal(faded[0].ratio.toFixed(2), '2.59');
  });

  it('reports where the focus walk stops short, at a control that keeps focus on Tab, leaves it on body before a tab stop, or at its cap, and ends quietly otherwise', async () => {
    const strong = (/** @type {string} */ id) => ({ id, ring: { outer: '#000000' }, planes: [{ id: 'around', color: '#ffffff' }] });
    /** A page whose Tab presses read `reads` in turn, then nothing, as when focus leaves the page */
    const walk = (/** @type {any[]} */ reads, /** @type {object} */ options = {}) =>
      ring.ringFindings({ keyboard: { press: async () => {} }, evaluate: async () => reads.shift() ?? null }, options);
    assert.deepEqual(await walk([strong('#a'), strong('#b')]), []);
    assert.deepEqual(await walk([strong('#a'), strong('#b'), strong('#a')]), []);
    assert.deepEqual(await walk([strong('#a'), { ...strong('#cell'), followed: true }]), [{ rule: 'ntn-focus-walk', target: '#cell' }]);
    assert.deepEqual(await walk([strong('#a'), strong('#indent'), strong('#indent')]), [{ rule: 'ntn-focus-walk', target: '#indent' }]);
    assert.deepEqual(await walk([strong('#a'), strong('#b'), strong('#c')], { max: 2 }), [{ rule: 'ntn-focus-walk', target: '#b' }]);
  });

  it('reports the custom checks under their own rule IDs, apart from axe\'s', () => {
    assert.equal(targets.RULE, 'ntn-target-size');
    assert.equal(ring.RULE, 'ntn-focus-ring');
  });
});

describe("the layers checks' pure parts (#24 slice 2)", () => {
  /** @type {any} */ let layers;
  before(async () => {
    layers = await import('./a11y/checks/layers.mjs');
  });

  it('finds a tab stop nobody sees: one the page shows none of where it sits, or a transparent one', () => {
    const stop = (/** @type {string} */ id, /** @type {boolean} */ shown, opacity = 1) => ({ id, shown, opacity });
    assert.deepEqual(layers.hiddenStops([stop('#seen', true), stop('#collapsed', false), stop('#clear', true, 0), stop('#faded', true, 0.4)]), ['#collapsed', '#clear']);
    assert.equal(layers.HIDDEN_RULE, 'ntn-hidden-focus');
  });

  it('finds a step that leaves focus on body, named for the step, and passes one that leaves it on a control', async () => {
    const page = (/** @type {boolean} */ lost) => ({ evaluate: async () => lost });
    assert.deepEqual(await layers.focusLost(page(true), 'close the menu'), [{ rule: 'ntn-focus-lost', target: 'close the menu' }]);
    assert.deepEqual(await layers.focusLost(page(false), 'close the menu'), []);
  });

  it('finds a tab stop out of the order the page reads in: back along a line, up a column, or up to an earlier column, from the stop before', () => {
    const at = (/** @type {string} */ id, /** @type {number} */ x, /** @type {number} */ y) => ({ id, box: { x, y, width: 44, height: 44 } });
    // Along a line, down to the next, then up to the top of the next column
    assert.deepEqual(layers.orderProblems([at('#a', 0, 0), at('#b', 52, 0), at('#c', 0, 52), at('#d', 200, 0)]), []);
    assert.deepEqual(layers.orderProblems([at('#b', 52, 0), at('#a', 0, 0)]), ['#a']);
    assert.deepEqual(layers.orderProblems([at('#low', 0, 52), at('#high', 0, 0)]), ['#high']);
    // A row of two-stop columns that CSS reversed: the step up and back to the column before
    assert.deepEqual(layers.orderProblems([at('#a', 60, 8), at('#b', 60, 60), at('#c', 8, 8), at('#d', 8, 60)]), ['#c']);
    // A stop read after a scroll is held to the stop before it as the same read measured it
    assert.deepEqual(layers.orderProblems([at('#a', 0, 400), { ...at('#b', 0, 300), before: { x: 0, y: 200, width: 44, height: 44 } }]), []);
    assert.equal(layers.ORDER_RULE, 'ntn-tab-order');
  });

  it("reports where its walk stops short, as the ring's does, and keeps a hidden stop out of the order", async () => {
    const stop = (/** @type {string} */ id, /** @type {number} */ x, shown = true) => ({ id, shown, opacity: 1, box: { x, y: 0, width: 44, height: 44 } });
    /** A page whose Tab presses read `reads` in turn, then nothing, as when focus leaves the page */
    const walk = (/** @type {any[]} */ reads, /** @type {object} */ options = {}) =>
      layers.layerFindings({ keyboard: { press: async () => {} }, evaluate: async () => reads.shift() ?? null }, options);
    const short = [{ rule: 'ntn-focus-walk', target: '#b' }];
    assert.deepEqual(await walk([stop('#a', 0), stop('#b', 52), stop('#b', 52)]), short);
    assert.deepEqual(await walk([stop('#a', 0), { ...stop('#b', 52), followed: true }]), short);
    assert.deepEqual(await walk([stop('#a', 0), stop('#b', 52), stop('#c', 104)], { max: 2 }), short);
    // A hidden stop back along the line is hidden, and the stops around it read in order
    assert.deepEqual(await walk([stop('#a', 52), stop('#gone', 0, false), stop('#b', 104)]), [{ rule: 'ntn-hidden-focus', target: '#gone' }]);
  });
});

describe("the announcement recorder's pure part (#24 slice 2)", () => {
  /** @type {any} */ let announce;
  before(async () => {
    announce = await import('./a11y/checks/announce.mjs');
  });

  it("reads how a live region announces from its aria-live, else its role, and nothing from one that's off", () => {
    const how = (/** @type {string | null} */ live, /** @type {string | null} */ role, tag = 'div') => announce.politenessOf({ live, role, tag });
    assert.equal(how(null, 'status'), 'polite');
    assert.equal(how(null, 'log'), 'polite');
    assert.equal(how(null, 'alert'), 'assertive');
    assert.equal(how(null, null, 'output'), 'polite');
    assert.equal(how('assertive', 'status'), 'assertive');
    assert.equal(how('off', 'log'), null);
    assert.equal(how(null, null), null);
  });

  it("refuses to read a page that isn't recording, as after a navigation, rather than hear nothing", async () => {
    const page = (/** @type {unknown} */ said) => ({ evaluate: async () => said });
    const saved = [{ region: '#status', politeness: 'polite', text: 'Saved' }];
    assert.deepEqual(await announce.readAnnouncements(page(saved)), saved);
    assert.deepEqual(await announce.readAnnouncements(page([])), []);
    await assert.rejects(announce.readAnnouncements(page(null)), /^TypeError: the page isn't recording/);
  });
});

describe("the clipping check's pure part (#24 slice 2)", () => {
  /** @type {any} */ let clip;
  before(async () => {
    clip = await import('./a11y/checks/clip.mjs');
  });

  it("finds an action cut off by a parent that clips it, or past where the page scrolls to, and leaves one wholly before the page's start to the layers check", () => {
    const FAR = 1e9;
    const reach = { right: 400, bottom: 800 };
    const box = (/** @type {number} */ left, /** @type {number} */ top) => ({ left, top, right: left + 44, bottom: top + 44 });
    const bar = { left: 0, top: -FAR, right: 100, bottom: FAR };
    const cut = (/** @type {object} */ action) => clip.cutOff({ clips: [], reach, ...action });
    assert.equal(cut({ box: box(8, 8) }), false);
    assert.equal(cut({ box: box(50, 8), clips: [bar] }), false);
    assert.equal(cut({ box: box(88, 8), clips: [bar] }), true);
    assert.equal(cut({ box: box(88, 900), clips: [bar] }), true);
    assert.equal(cut({ box: box(370, 8) }), true);
    assert.equal(cut({ box: box(-22, 8) }), true);
    assert.equal(cut({ box: box(-9999, 8) }), false);
    assert.deepEqual([clip.CLIP_RULE, clip.REFLOW_RULE, clip.REFLOW_WIDTH], ['ntn-clipped-action', 'ntn-reflow', 320]);
  });
});

describe("the matrix runner's pure parts (#24 slice 2)", () => {
  /** @type {any} */ let points;
  before(() => {
    points = require('./a11y/checks/points.js');
  });
  const find = (/** @type {string} */ surface, /** @type {string} */ id) => points.pointsOf(surface).find((/** @type {{id: string}} */ point) => point.id === id);

  it("reads each surface's points from matrix.json: its default, its widths, and each axis every surface changes, with dark gated", () => {
    const workspace = points.pointsOf('workspace');
    assert.deepEqual(
      workspace.map((/** @type {{id: string}} */ point) => point.id),
      ['default', 'width-320', 'width-390', 'width-720', 'width-1100', 'zoom-200', 'zoom-400', 'fontSize-20', 'fontSize-24', 'spacing-override', 'pointer-coarse', 'scheme-dark', 'contrast-more', 'forcedColors-active', 'motion-reduce'],
    );
    assert.equal(points.pointsOf('popup').length, 12);
    assert.deepEqual(workspace.filter((/** @type {{gate?: string}} */ point) => point.gate).map((/** @type {{id: string, gate: string}} */ point) => [point.id, point.gate]), [['scheme-dark', '#16-dark']]);
    assert.deepEqual(find('workspace', 'zoom-400'), {
      id: 'zoom-400', width: 1280, zoom: 400, fontSize: 16, spacing: 'default', pointer: 'fine', scheme: 'light', contrast: 'no-preference', forcedColors: 'none', motion: 'no-preference',
    });
    assert.throws(() => points.pointsOf('gallery'), /^TypeError: "gallery" is no surface docs\/accessibility\/matrix\.json names$/);
  });

  it('sizes a point at zoom Z as W/Z CSS px at device scale Z, and Popup at min(800, W·Z)/Z', () => {
    const at = (/** @type {string} */ surface, /** @type {string} */ id) => points.viewportOf(find(surface, id), surface);
    assert.deepEqual(at('workspace', 'default'), { width: 1280, height: 800, deviceScaleFactor: 1 });
    assert.deepEqual(at('workspace', 'zoom-400'), { width: 320, height: 200, deviceScaleFactor: 4 });
    assert.deepEqual(at('popup', 'zoom-200'), { width: 360, height: 400, deviceScaleFactor: 2 });
    assert.deepEqual(at('popup', 'zoom-400'), { width: 200, height: 200, deviceScaleFactor: 4 });
    assert.deepEqual(at('sidepanel', 'width-320'), { width: 320, height: 800, deviceScaleFactor: 1 });
  });

  it("records a test's point and how many its page has with its findings, a contrast one at the dark point carrying #16-dark", () => {
    const findings = [{ rule: 'color-contrast', target: '#a' }, { rule: 'ntn-focus-ring', target: '#b' }, { rule: 'button-name', target: '#c' }];
    assert.deepEqual(points.recordAt(find('workspace', 'scheme-dark'), 15, findings), {
      point: 'scheme-dark',
      points: 15,
      findings: [{ rule: 'color-contrast', target: '#a', gate: '#16-dark' }, { rule: 'ntn-focus-ring', target: '#b', gate: '#16-dark' }, { rule: 'button-name', target: '#c' }],
    });
    assert.deepEqual(points.recordAt(find('workspace', 'default'), 15, findings), { point: 'default', points: 15, findings });
  });
});
