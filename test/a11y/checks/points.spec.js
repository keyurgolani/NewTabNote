// #24 slice 2: the matrix runner, on pages set in plain Chromium. atPoints() declares one test of a
// surface at each of its points from docs/accessibility/matrix.json, on a test whose `pointPage`
// fixture puts its page at the test's point through CDP, opens it, as a page's own spec opens its
// surface through #34's harness, and sets the text spacing on what opened. Each one here reads back
// what the page sees at its point: its width at its zoom and device scale, its default font size, the
// text-spacing override, a coarse pointer, and the scheme, contrast, forced colors and motion media.
// Popup's twelve points include its zoom, at min(800, W·Z)/Z CSS px. The setup leaves the pointer on a
// row whose pin shows only while the row is hovered, as a setup's click would, and the layers check
// still finds the pin hidden: a point's checks see the page with nothing hovered. The row heads the page
// and the pointer rests by its top left corner, so the row stays under it at every point's viewport.
// The page reads its width, its scheme and whether it's touched as it loads, as the legacy tab sets
// itself up once from them, and each point's test finds those readings at its point, so the page
// opened there. It opens through page.route() as a document of its own, after emulate(). A pointPage
// that opens its page and skips emulate() fails at every point, since the runner reads each page back
// at its point before its checks.
// The text-spacing override gets past a style-src without 'unsafe-inline', which keeps a style tag
// out, as the extension's will once security/unsafe-inline takes that out.
// The spec is the library's own, so its tests are no page's.

const { test: base, expect } = require('@playwright/test');
const points = require('./points.js');

const PAGE = `<!doctype html><html lang="en"><head><title>A point</title><style>
  #pin { opacity: 0; transition: opacity 0.2s; }
  #row:hover #pin { opacity: 1; }
</style></head><body><main><div id="row">A note <button id="pin" type="button">Pin</button></div><p id="text">Text</p></main>
<script>
  Object.assign(document.body.dataset, {
    width: String(innerWidth),
    dark: String(matchMedia('(prefers-color-scheme: dark)').matches),
    touch: String(navigator.maxTouchPoints > 0),
  });
</script></body></html>`;

/** Where the spec serves its pages, through page.route(), so each opens as a document of its own */
const POINT_URL = 'https://ntn.test/point.html';

/** @param {import('@playwright/test').Page} page */
const serve = page => page.route(POINT_URL, route => route.fulfill({ contentType: 'text/html', body: PAGE }));

const test = points.withPoint(base).extend({
  pointPage: async ({ page, point }, use) => {
    await serve(page);
    await points.emulate(page, point, 'popup');
    await page.goto(POINT_URL);
    await points.spaceText(page, point);
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
    expect(await page.evaluate('({ ...document.body.dataset })')).toEqual({
      width: String(width),
      dark: String(point.scheme === 'dark'),
      touch: String(point.pointer === 'coarse'),
    });
    const layers = await import('./layers.mjs');
    expect(await layers.layerFindings(page)).toEqual([{ rule: layers.HIDDEN_RULE, target: '#pin' }]);
    return [];
  },
});

// A pointPage that opens its page and never puts it at its point
const skipping = points.withPoint(base).extend({
  pointPage: async ({ page }, use) => {
    await serve(page);
    await page.goto(POINT_URL);
    await use(page);
  },
});

skipping.describe('a pointPage that skips emulate()', () => {
  skipping.fail(() => true, 'the runner reads its page back at each point and finds it at none');
  points.atPoints(skipping, 'popup', { check: async () => [] });
});

/** A page whose own sheet is a file, which a style-src of 'self' lets in */
const STRICT = `<!doctype html><html lang="en"><head><title>A strict page</title><link rel="stylesheet" href="/strict.css"></head>
<body><main><p id="text">Text</p></main></body></html>`;

test("the text-spacing override gets past a style-src without 'unsafe-inline', which keeps a style tag out", async ({ page }) => {
  const point = points.pointsOf('popup').find((/** @type {{id: string}} */ { id }) => id === 'spacing-override');
  await page.route('https://ntn.test/**', route =>
    route.fulfill(
      route.request().url().endsWith('.css')
        ? { contentType: 'text/css', body: '#text { color: rgb(1, 2, 3); }' }
        : { contentType: 'text/html', headers: { 'Content-Security-Policy': "style-src 'self'" }, body: STRICT },
    ),
  );
  await points.emulate(page, point, 'popup');
  await page.goto('https://ntn.test/strict.html');
  await points.spaceText(page, point);
  await page.evaluate(`document.head.append(Object.assign(document.createElement('style'), { textContent: '#text { text-transform: uppercase; }' }))`);
  const read = await page.evaluate(`(() => {
    const text = getComputedStyle(document.getElementById('text'));
    return [text.color, text.letterSpacing, text.textTransform];
  })()`);
  expect(read).toEqual(['rgb(1, 2, 3)', `${0.12 * point.fontSize}px`, 'none']);
});
