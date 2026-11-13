// #24 slice 2: the matrix runner, on pages set in plain Chromium. atPoints() declares one test of a
// surface at each of its points from docs/accessibility/matrix.json, on a test whose `pointPage`
// fixture opens the page each one checks, as a page's own spec opens its surface through #34's
// harness. Each test puts the page at its point through CDP and checks it. Each one here reads back
// what the page sees at its point: its width at its zoom and device scale, its default font size, the
// text-spacing override, a coarse pointer, and the scheme, contrast, forced colors and motion media.
// Popup's twelve points include its zoom, at min(800, W·Z)/Z CSS px. The setup leaves the pointer on a
// row whose pin shows only while the row is hovered, as a setup's click would, and the layers check
// still finds the pin hidden: a point's checks see the page with nothing hovered. The row heads the page
// and the pointer rests by its top left corner, so the row stays under it at every point's viewport.
// The spec is the library's own, so its tests are no page's.

const { test: base, expect } = require('@playwright/test');
const points = require('./points.js');

const PAGE = `<!doctype html><html lang="en"><head><title>A point</title><style>
  #pin { opacity: 0; transition: opacity 0.2s; }
  #row:hover #pin { opacity: 1; }
</style></head><body><main><div id="row">A note <button id="pin" type="button">Pin</button></div><p id="text">Text</p></main></body></html>`;

const test = base.extend({
  pointPage: async ({ page }, use) => {
    await page.setContent(PAGE);
    await page.hover('#row', { position: { x: 4, y: 4 } });
    await use(page);
  },
});

points.atPoints(test, 'popup', {
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
    const layers = await import('./layers.mjs');
    expect(await layers.layerFindings(page)).toEqual([{ rule: layers.HIDDEN_RULE, target: '#pin' }]);
    return [];
  },
});
