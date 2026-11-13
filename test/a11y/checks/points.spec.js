// #24 slice 2: the matrix runner, on pages set in plain Chromium. atPoints() declares one test of a
// surface at each of its points from docs/accessibility/matrix.json, puts the page there through CDP,
// opens it, and checks it. Each test here reads back what the page sees at its point: its width at
// its zoom and device scale, its default font size, the text-spacing override, a coarse pointer, and
// the scheme, contrast, forced colors and motion media. Popup's twelve points include its zoom, at
// min(800, W·Z)/Z CSS px. The spec is the library's own, so its tests are no page's.

const { test, expect } = require('@playwright/test');
const points = require('./points.js');

points.atPoints(test, 'popup', {
  open: page => page.setContent('<!doctype html><html lang="en"><head><title>A point</title></head><body><main><p id="text">Text</p></main></body></html>'),
  check: async (page, point) => {
    const read = await page.evaluate(`(() => {
      const text = getComputedStyle(document.getElementById('text'));
      const on = query => matchMedia(query).matches;
      return {
        width: innerWidth, scale: devicePixelRatio, fontSize: text.fontSize, spacing: text.letterSpacing,
        pointer: on('(pointer: coarse)') && on('(any-pointer: coarse)') ? 'coarse' : 'fine',
        scheme: on('(prefers-color-scheme: dark)') ? 'dark' : 'light',
        contrast: on('(prefers-contrast: more)') ? 'more' : 'no-preference',
        forcedColors: on('(forced-colors: active)') ? 'active' : 'none',
        motion: on('(prefers-reduced-motion: reduce)') ? 'reduce' : 'no-preference',
      };
    })()`);
    const { width, deviceScaleFactor } = points.viewportOf(point, 'popup');
    expect(read).toEqual({
      width,
      scale: deviceScaleFactor,
      fontSize: `${point.fontSize}px`,
      spacing: point.spacing === 'override' ? `${0.12 * point.fontSize}px` : 'normal',
      pointer: point.pointer,
      scheme: point.scheme,
      contrast: point.contrast,
      forcedColors: point.forcedColors,
      motion: point.motion,
    });
    return [];
  },
});
