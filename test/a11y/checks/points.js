'use strict';

/**
 * #24's matrix runner. A surface's points come from docs/accessibility/matrix.json, which holds the
 * sizes until #301's table does: its default point, the widths it's also checked at, and each axis
 * every surface is checked at, one change from the default. A point's id is `default` or the axis and
 * value it changes, as `width-320` or `scheme-dark`. The point the matrix gates, dark, carries its
 * gate, which a contrast finding there takes. emulate() puts a page at a point through its own CDP
 * session, so the harness's launch stays as it is. atPoints() declares a surface's tests, one a point,
 * each setting the point option withPoint() gives a spec's test. That test's pointPage fixture puts
 * its page at the point before it opens it, so the page loads there, and sets the text spacing on
 * what opened. It's CommonJS so a spec can declare them as it loads, and a test's page is its spec's
 * whichever file declares it.
 */

const fs = require('node:fs');
const path = require('node:path');

const MATRIX_FILE = 'docs/accessibility/matrix.json';
const MATRIX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', MATRIX_FILE), 'utf8'));

/** The rules that measure contrast, which a gated point's gate holds */
const CONTRAST_RULES = Object.freeze(['color-contrast', 'ntn-focus-ring']);

/** A viewport's height in device px, which the matrix leaves open */
const HEIGHT = 800;

/** WCAG 1.4.12's text spacing, which the spacing override sets */
const SPACING = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }';

/**
 * @typedef {{id: string, width: number, zoom: number, fontSize: number, spacing: string, pointer: string,
 *   scheme: string, contrast: string, forcedColors: string, motion: string, gate?: string}} Point
 */

/**
 * The points `surface` is checked at, in the matrix's order
 * @param {string} surface
 * @param {any} [matrix]
 * @returns {Point[]}
 */
function pointsOf(surface, matrix = MATRIX) {
  const spec = matrix.surfaces[surface];
  if (!spec) throw new TypeError(`${JSON.stringify(surface)} is no surface ${MATRIX_FILE} names`);
  const changes = [{}, ...spec.widths.map((/** @type {number} */ width) => ({ width })), ...matrix.everySurface];
  return changes.map(change => {
    const [axis, value] = Object.entries(change)[0] ?? [];
    const gate = axis === undefined ? undefined : matrix.gated?.[axis]?.[value];
    return { id: axis === undefined ? 'default' : `${axis}-${value}`, ...matrix.defaults[spec.default], ...change, ...(gate ? { gate } : {}) };
  });
}

/**
 * A point's viewport: at zoom Z, W/Z CSS px wide at device scale Z, and on a surface with a
 * maxWidth, min(maxWidth, W·Z)/Z, as the matrix has it
 * @param {Point} point
 * @param {string} surface
 * @param {any} [matrix]
 */
function viewportOf(point, surface, matrix = MATRIX) {
  const scale = point.zoom / 100;
  const { maxWidth } = matrix.surfaces[surface];
  const device = maxWidth === undefined ? point.width : Math.min(maxWidth, point.width * scale);
  return { width: Math.round(maxWidth === undefined ? point.width / scale : device / scale), height: Math.round(HEIGHT / scale), deviceScaleFactor: scale };
}

/**
 * What a test at `point` attaches as a11y-findings: its point, how many points its page has, and its
 * findings, a contrast one at a gated point carrying the gate
 * @param {Point} point
 * @param {number} points
 * @param {readonly {rule: string, target: string}[]} findings
 */
function recordAt(point, points, findings) {
  const gate = point.gate;
  return { point: point.id, points, findings: findings.map(finding => (gate && CONTRAST_RULES.includes(finding.rule) ? { ...finding, gate } : finding)) };
}

/** Each page's CDP session, opened once with the DOM and CSS domains on for the spacing sheet */
const sessions = new WeakMap();

/** @param {import('@playwright/test').Page} page */
async function sessionOf(page) {
  if (!sessions.has(page)) {
    const session = await page.context().newCDPSession(page);
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    sessions.set(page, session);
  }
  return sessions.get(page);
}

/**
 * Sets the text-spacing override on the page's document, or takes it off, through CDP's inspector
 * style sheet, which a style-src without 'unsafe-inline' doesn't block, as it would a style tag. A new
 * document needs it again.
 * @param {import('@playwright/test').Page} page
 * @param {Point} point
 */
async function spaceText(page, point) {
  const session = await sessionOf(page);
  const { frameTree } = await session.send('Page.getFrameTree');
  const { styleSheetId } = await session.send('CSS.createStyleSheet', { frameId: frameTree.frame.id });
  await session.send('CSS.setStyleSheetText', { styleSheetId, text: point.spacing === 'override' ? SPACING : '' });
}

/**
 * Puts `page` at `point`: its viewport and device scale, touch for a coarse pointer, the default font
 * size, and the scheme, contrast, forced colors and motion media. A spec's pointPage calls it before
 * it opens its page, so the page loads at its point, and then spaceText() on what opened.
 * @param {import('@playwright/test').Page} page
 * @param {Point} point
 * @param {string} surface
 */
async function emulate(page, point, surface) {
  const session = await sessionOf(page);
  await session.send('Emulation.setDeviceMetricsOverride', { ...viewportOf(point, surface), mobile: false });
  await session.send('Emulation.setTouchEmulationEnabled', point.pointer === 'coarse' ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await session.send('Page.setFontSizes', { fontSizes: { standard: point.fontSize } });
  const media = { colorScheme: point.scheme, contrast: point.contrast, forcedColors: point.forcedColors, reducedMotion: point.motion };
  await page.emulateMedia(/** @type {any} */ (media));
}

/** Settles once every transition running on the page has ended */
const TRANSITIONS_ENDED = `Promise.all(document.getAnimations().filter(animation => animation instanceof CSSTransition)
  .map(animation => animation.finished.catch(() => {}))).then(() => {})`;

/**
 * Takes the pointer off `page` and waits out the transitions that starts, so the checks see the page
 * as a keyboard user has it, with nothing hovered: a setup's click leaves the pointer on its control
 * @param {import('@playwright/test').Page} page
 */
async function offPointer(page) {
  await page.mouse.move(-1, -1);
  await page.evaluate(TRANSITIONS_ENDED);
}

/**
 * `test` with the option each point's test sets, `point`, which a spec's pointPage fixture reads
 * @template T, W
 * @param {import('@playwright/test').TestType<T, W>} test
 * @returns {import('@playwright/test').TestType<T & {point: Point}, W>}
 */
function withPoint(test) {
  return /** @type {any} */ (test.extend({ point: [undefined, { option: true }] }));
}

/**
 * Declares one test of `surface` at each of its points, on `test`, a withPoint() test that defines
 * `pointPage`: the page each one checks, opened as the spec opens its surface, through #34's harness
 * for the extension's own. Playwright reads a test's fixtures from its own function, so the spec
 * names how to open the page there, after it emulate()s the point the test sets, and spaceText()s
 * what opened. Each test takes the pointer off the page, checks it, and attaches what it found with
 * its point.
 * @param {import('@playwright/test').TestType<{point: Point, pointPage: import('@playwright/test').Page}, any>} test
 * @param {string} surface
 * @param {{check: (page: import('@playwright/test').Page, point: Point) => Promise<{rule: string, target: string}[]>}} steps
 */
function atPoints(test, surface, { check }) {
  const all = pointsOf(surface);
  for (const point of all) {
    test.describe(() => {
      test.use({ point });
      test(`${surface} at ${point.id}`, async ({ pointPage }, testInfo) => {
        await offPointer(pointPage);
        const findings = await check(pointPage, point);
        await testInfo.attach('a11y-findings', { body: JSON.stringify(recordAt(point, all.length, findings)), contentType: 'application/json' });
      });
    });
  }
}

module.exports = { CONTRAST_RULES, pointsOf, viewportOf, recordAt, emulate, spaceText, offPointer, withPoint, atPoints };
