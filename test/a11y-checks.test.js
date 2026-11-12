'use strict';

// #24 slice 2: the check library's pure parts, which run under npm test with no browser:
// - hit boxes against 44 by 44, with the contract's three exemptions;
// - the focus ring's contrast against each plane beside it, with alpha composited first and a
//   two-tone ring measured as #16 measures one;
// - the chords Chrome keeps for itself;
// - what reduced motion forbids.
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
      box('subpixel', 43.995, 44),
      box('todo-checkbox', 20, 20),
      box('inline-link', 30, 18, 'inline-link'),
      box('editor', 600, 20, 'editing-area'),
      box('decorated', 20, 20, 'decorative'),
    ]);
    assert.deepEqual(short.map((/** @type {any} */ t) => t.id), ['narrow', 'short', 'todo-checkbox', 'decorated']);
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
    assert.deepEqual(moves({ scrollBehavior: 'auto', chartAnimation: false }), []);
    assert.deepEqual(motion.REDUCED_MOTION_RULES, ['transform-transition', 'smooth-scroll', 'chart-animation']);
  });
});
