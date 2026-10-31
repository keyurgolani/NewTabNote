/**
 * The extension pages' CSP on Chromium (#21 slice 1b, PR 3): written out with default-src
 * 'self' and the declared fixes, and nothing a user sees changes. Each page loads with no
 * securitypolicyviolation and its stylesheets applied; a favicon image and a YouTube embed
 * load, on routed responses; and a frame from anywhere else is blocked. The network guard
 * wraps a page's own realm only, so another realm's requests are the CSP's: a frame's own fetch
 * to an origin connect-src doesn't name is blocked by it, with no request made.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/** A 1 by 1 PNG */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/** Each page records the CSP violations it raises from its first script on */
const recordViolations = context => context.addInitScript(() => {
  /** @type {any} */ (window).__cspViolations = [];
  document.addEventListener('securitypolicyviolation', event => {
    /** @type {any} */ (window).__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
  });
});

const violations = page => page.evaluate(() => /** @type {any} */ (window).__cspViolations);

/** Every stylesheet the page loaded has its rules, and the body isn't in the browser's default font */
const stylesApplied = page => page.evaluate(() => ({
  sheets: [...document.styleSheets].length > 0 && [...document.styleSheets].every(sheet => sheet.cssRules.length > 0),
  font: !/^"?Times/.test(getComputedStyle(document.body).fontFamily),
}));

test('each page loads under the CSP with no violation, its stylesheets applied', async ({ extension }) => {
  await recordViolations(extension.context);
  await extension.seedOnboarded();
  const pages = { newtab: await driver.openNewTab(extension) };
  for (const surface of ['popup', 'sidepanel']) pages[surface] = await extension.openSurface(surface);
  // The offscreen document's entry, opened as a tab
  pages.offscreen = await extension.context.newPage();
  await pages.offscreen.goto(extension.url('offscreen.html'));
  for (const [name, page] of Object.entries(pages)) {
    expect(await violations(page), name).toEqual([]);
    if (name !== 'offscreen') expect(await stylesApplied(page), name).toEqual({ sheets: true, font: true });
  }
  await expectNoUncaught(extension, pages.newtab);
});

test('a favicon image and a YouTube embed load, and a frame from anywhere else is blocked', async ({ extension }) => {
  const asked = [];
  await extension.context.route('https://www.google.com/s2/favicons**', route => {
    asked.push('favicon');
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  await extension.context.route('https://www.youtube.com/embed/**', route => {
    asked.push('youtube');
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>player</title>' });
  });
  extension.context.on('request', request => {
    if (request.url().startsWith('https://example.test/')) asked.push('elsewhere');
  });
  await recordViolations(extension.context);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  const outcome = await page.evaluate(async () => {
    const image = await new Promise(resolve => {
      const img = document.createElement('img');
      img.onload = () => resolve(img.naturalWidth);
      img.onerror = () => resolve('error');
      img.src = 'https://www.google.com/s2/favicons?domain=example.test&sz=16';
      document.body.appendChild(img);
    });
    const frame = src => new Promise(resolve => {
      const element = document.createElement('iframe');
      element.onload = () => resolve('load');
      element.src = src;
      document.body.appendChild(element);
      setTimeout(() => resolve('no load'), 3000);
    });
    return { image, video: await frame('https://www.youtube.com/embed/aaaaaaaaaaa'), elsewhere: await frame('https://example.test/frame') };
  });
  expect(outcome.image).toBe(1);
  expect(outcome.video).toBe('load');
  expect(asked).toEqual(['favicon', 'youtube']);
  // Chromium may report a blocked frame by its origin alone, so the directive and the origin are
  // what's compared
  const byOrigin = (await violations(page)).map(entry => entry.replace(/^(\S+ https?:\/\/[^/]+).*$/, '$1'));
  expect(byOrigin).toEqual(['frame-src https://example.test']);
  await expectNoUncaught(extension, page);
});

test("another realm's request is the CSP's to stop: a frame's own fetch to an origin connect-src doesn't name makes no request", async ({ extension }) => {
  const leaked = [];
  extension.context.on('request', request => {
    if (request.url().startsWith('https://unregistered.example.test/')) leaked.push(request.url());
  });
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  const outcome = await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const realm = /** @type {any} */ (frame.contentWindow);
    const seen = [];
    realm.document.addEventListener('securitypolicyviolation', event => seen.push(`${event.violatedDirective} ${event.blockedURI}`));
    // The frame's own fetch, which the page's guard doesn't wrap
    const wrapped = realm.fetch[Symbol.for('ntn.networkGuard')] === true;
    const result = await realm.fetch('https://unregistered.example.test/x').then(() => 'sent', error => error.name);
    await new Promise(resolve => setTimeout(resolve, 200));
    return { wrapped, result, seen };
  });
  expect(outcome).toEqual({ wrapped: false, result: 'TypeError', seen: ['connect-src https://unregistered.example.test/x'] });
  expect(leaked).toEqual([]);
  await expectNoUncaught(extension, page);
});
