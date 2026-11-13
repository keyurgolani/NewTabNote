// #24 slice 2: the check library's browser halves, on pages set in plain Chromium. Each check has to
// find a planted fault and pass its clean twin:
// - axe, with #29's tags, finds a button with no name and passes one with a name;
// - the hit boxes find a 43 by 43 button, and pass a 44 by 44 one, a link in running text, and a
//   checkbox whose label is its hit area. They measure a control that only takes clicks, and a
//   pointer-only one under aria-hidden: a 24 by 24 handle, an 18 by 18 checkbox and a 20 by 20 Close
//   are found, and a 44 by 44 one and a shape inside a button pass. A pointer-only control is also one
//   by its own click listener or a resize cursor: a 16 by 16 Close inside a tab's button, a 4px
//   col-resize strip and an 18 by 18 checkbox under a row with the same cursor are found, and a toggle's
//   slider is part of its label, so the toggle is one finding. A link in running text is exempt
//   in any text block, a note's div and its editing host included, however deep in inline boxes it
//   sits, under a note's bold or a wrapper with no box of its own, and a link alone in one isn't;
// - the focus ring finds a ring under 3:1 against the page and a control with no ring, and passes a
//   strong ring and two two-tone rings on a dark plane whose inner ring carries the contrast: one
//   outlined, its inner ring beside the outline, and one of box-shadows, its inner ring stacked on
//   the outer one. An inner ring that's painted over doesn't count: a white shadow under an outline
//   with no offset, or under a wider shadow listed before it, leaves a #555555 ring on slate, found,
//   and the same shadows listed the other way round pass. A ring fades with opacity on the control
//   or a parent: a #1869ba ring at 0.6 on white is found, and the same ring at full opacity passes.
//   The walk reports where it stops short, at a control that keeps focus on Tab, at one whose Tab
//   leaves focus on body with a tab stop still to come, as a table's last cell does, or at its cap, as
//   ntn-focus-walk, with a faint ring past it unread;
// - each half's boundary has a planted fault of its own: a small link alone in its list item is a
//   target, and a white ring at no offset on a white button in a #333333 toolbar clears the toolbar
//   but fails against the button's fill;
// - it reads what Chrome computes a color-mix() in sRGB to, color(srgb …): a plane mixed in sRGB, a
//   translucent mix on slate whose alpha decides it, and a stacked ring whose inner shadow is a mix;
// - the layers check finds a tab stop nobody sees, in a collapsed, off-screen or transparent layer,
//   and passes one in an inert layer, which Tab skips, and a skip link that shows on focus. A step
//   that leaves focus on body is found, and one that returns it to its invoker passes. Tab order
//   that runs back along a row or up a column, as CSS reversed them, or up to the column before, as in
//   a reversed row of two-stop columns, is found, and a row read left to right passes, and so does a
//   column read top to bottom that's taller than the page, where the walk scrolls. Each step is read in
//   the frame it's read in, so the steps out of a scroller and onto a fixed bar read in order, and a
//   column read back up after a scroll is found. A link that wraps is read by its line boxes, so it
//   shows where either part sits and a link after it on its second line reads in order;
// - the announcement recorder reads back what a step makes the live regions say: a status and a
//   polite region politely, an alert assertively, and nothing from a log that's off or from text
//   outside any region. A region that isn't atomic says what was added, so a count reads `3`, and an
//   atomic one its whole text, `3 notes`. Each toast added to a toast region is read alone, and one
//   leaving says nothing. An alert added with its text is heard as its own region, once, as the legacy
//   tab's note-gone notice is added: inside a log that's off too, and not again as part of a polite
//   region it lands in. It keeps hearing after setContent() writes
//   a new document into the page, which keeps the window, and refuses a page that never started
//   recording, or that a reload has replaced since;
// - under reduced motion, the motion check finds a transform transition, a keyframed rotation,
//   smooth scroll and a canvas that keeps redrawing, and passes a fade and a canvas drawn once;
// - the clipping check finds an action a hidden-overflow bar cuts off and one partly before the
//   page's start, and at 320 CSS px a block that makes the page scroll sideways, and passes a bar
//   that scrolls. At 1280 only the cut-off actions stay.
// These tests are the library's own, so they attach no findings, and no baseline line holds them.

const { test, expect } = require('@playwright/test');

/** @type {any} */ let axe;
/** @type {any} */ let targets;
/** @type {any} */ let ring;
test.beforeAll(async () => {
  axe = await import('./axe.mjs');
  targets = await import('./targets.mjs');
  ring = await import('./ring.mjs');
});

/** A page with `body` in its main landmark, and nothing else axe's tags would flag */
const html = (/** @type {string} */ body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A check's page</title></head><body><main>${body}</main></body></html>`;

test('axe finds a button with no name, and passes one with a name', async ({ page }) => {
  await page.setContent(html('<button id="nameless"></button>'));
  expect(await axe.axeOn(page)).toEqual([{ rule: 'button-name', target: '#nameless' }]);
  await page.setContent(html('<button id="named">Save</button>'));
  expect(await axe.axeOn(page)).toEqual([]);
});

test('the hit boxes find a 43 by 43 button, and pass a 44 by 44 one, a link in running text, and a checkbox its label carries', async ({ page }) => {
  await page.setContent(
    html(`<style>button { width: 44px; height: 44px; padding: 0; } #small { width: 43px; height: 43px; }
      label { display: inline-block; min-width: 44px; min-height: 44px; }</style>
      <button id="fits">A</button><button id="small">B</button>
      <p>Read <a href="#guide" id="inline">the guide</a> first.</p>
      <label><input type="checkbox" id="done"> Done</label>`),
  );
  expect(await targets.targetFindings(page)).toEqual([{ rule: 'ntn-target-size', target: '#small' }]);
});

test("the hit boxes measure a control that only takes clicks, and a pointer-only one under aria-hidden, as the contract's handle, checkbox and Close are", async ({ page }) => {
  await page.setContent(
    html(`<style>button { width: 44px; height: 44px; padding: 0; } #close { width: 20px; height: 20px; }
      .handle { width: 24px; height: 24px; cursor: grab; } .check { width: 18px; height: 18px; cursor: pointer; }
      .roomy { width: 44px; height: 44px; cursor: pointer; } svg { width: 12px; height: 12px; }</style>
      <div class="handle" id="handle" aria-hidden="true"></div>
      <div class="check" id="check"><svg viewBox="0 0 24 24"></svg></div>
      <div class="roomy" id="roomy" aria-hidden="true"><svg viewBox="0 0 24 24"></svg></div>
      <button id="close" tabindex="-1" aria-hidden="true">×</button>
      <button id="fits"><svg viewBox="0 0 24 24" style="cursor: pointer"></svg></button>`),
  );
  expect(await targets.targetFindings(page)).toEqual([
    { rule: 'ntn-target-size', target: '#handle' },
    { rule: 'ntn-target-size', target: '#check' },
    { rule: 'ntn-target-size', target: '#close' },
  ]);
});

test("the hit boxes find a pointer-only control by its own click listener or a resize cursor, and count a label's slider as its control", async ({ page }) => {
  await page.setContent(
    html(`<style>.tab { width: 120px; height: 44px; padding: 0; } #tab-close { display: inline-block; width: 16px; height: 16px; }
      #resize { width: 4px; height: 200px; cursor: col-resize; } #row { width: 300px; height: 48px; cursor: pointer; }
      #select { width: 18px; height: 18px; } #toggle { display: inline-block; width: 40px; height: 22px; }
      #toggle input { opacity: 0; width: 0; height: 0; margin: 0; } .slider { display: inline-block; width: 40px; height: 22px; cursor: pointer; }</style>
      <button class="tab" id="tab">Note <span id="tab-close">×</span></button>
      <div id="resize"></div>
      <div id="row"><div id="select"></div> A note</div>
      <label id="toggle"><input type="checkbox" id="toggle-input"><span class="slider"></span></label>
      <script>for (const id of ['tab-close', 'select']) document.getElementById(id).addEventListener('click', () => {});</script>`),
  );
  expect(await targets.targetFindings(page)).toEqual([
    { rule: 'ntn-target-size', target: '#tab-close' },
    { rule: 'ntn-target-size', target: '#resize' },
    { rule: 'ntn-target-size', target: '#select' },
    { rule: 'ntn-target-size', target: '#toggle-input' },
  ]);
});

test("the hit boxes pass a link in running text in any text block, a note's editing host and its wiki links included, under bold or a box-less wrapper too, and find one alone in its block", async ({ page }) => {
  await page.setContent(
    html(`<div class="block"><div class="block-content" contenteditable="true">Read <a href="https://example.com/guide" id="guide">the guide</a> first, then <a href="#" class="wiki-link" id="wiki">Note</a>.</div></div>
      <div class="block"><div class="block-content" contenteditable="true">Read <b><a href="#bold" id="bold">the guide</a></b> first.</div></div>
      <div class="note-text">See <a href="#more" id="more">more</a> below.</div>
      <p>See <span style="display: contents"><a href="#wrapped" id="wrapped">this</a></span> too.</p>
      <div><a href="#solo" id="solo">Solo</a></div>`),
  );
  expect(await targets.targetFindings(page)).toEqual([{ rule: 'ntn-target-size', target: '#solo' }]);
});

test('the focus ring finds a faint ring and a missing one, and passes a strong ring and two-tone rings, outlined or stacked, on a dark plane', async ({ page }) => {
  await page.setContent(
    html(`<style>button { outline: none; }
      #faint:focus-visible { outline: 2px solid #cccccc; outline-offset: 2px; }
      #strong:focus-visible { outline: 2px solid #000000; outline-offset: 2px; }
      .slate { background: #333333; padding: 8px; }
      #two-tone:focus-visible { outline: 2px solid #555555; outline-offset: 2px; box-shadow: 0 0 0 2px #ffffff; }
      #stacked:focus-visible { box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.5), 0 0 0 4px #555555; }</style>
      <button id="faint">A</button><button id="strong">B</button>
      <div class="slate"><button id="two-tone">C</button><button id="stacked">E</button></div><button id="none">D</button>`),
  );
  expect(await ring.ringFindings(page)).toEqual([
    { rule: 'ntn-focus-ring', target: '#faint' },
    { rule: 'ntn-focus-ring', target: '#none' },
  ]);
});

test("the focus ring reads planes and rings Chrome computes as color(srgb …), a translucent mix's alpha included", async ({ page }) => {
  await page.setContent(
    html(`<style>button { outline: none; }
      .tinted { background: color-mix(in srgb, #6c5ce7 10%, white); padding: 8px; }
      #on-mix:focus-visible { outline: 2px solid #000000; outline-offset: 2px; }
      .slate { background: #333333; padding: 8px; }
      .haze { background: color-mix(in srgb, white 10%, transparent); padding: 8px; }
      #through-haze:focus-visible { outline: 2px solid #555555; outline-offset: 2px; }
      #mixed-stack:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, white 50%, transparent), 0 0 0 4px #555555; }</style>
      <div class="tinted"><button id="on-mix">A</button></div>
      <div class="slate"><div class="haze"><button id="through-haze">B</button></div><button id="mixed-stack">C</button></div>`),
  );
  expect(await ring.ringFindings(page)).toEqual([{ rule: 'ntn-focus-ring', target: '#through-haze' }]);
});

test('the focus ring finds an inner ring that is painted over: under an outline with no offset, or under a wider shadow listed before it', async ({ page }) => {
  await page.setContent(
    html(`<style>button { outline: none; } .slate { background: #333333; padding: 8px; }
      #covered:focus-visible { outline: 2px solid #555555; box-shadow: 0 0 0 2px #ffffff; }
      #buried:focus-visible { box-shadow: 0 0 0 4px #555555, 0 0 0 2px #ffffff; }
      #shown:focus-visible { box-shadow: 0 0 0 2px #ffffff, 0 0 0 4px #555555; }</style>
      <div class="slate"><button id="covered">A</button><button id="buried">B</button><button id="shown">C</button></div>`),
  );
  expect(await ring.ringFindings(page)).toEqual([
    { rule: 'ntn-focus-ring', target: '#covered' },
    { rule: 'ntn-focus-ring', target: '#buried' },
  ]);
});

test('the focus ring finds a ring faded by opacity on the control or on a parent', async ({ page }) => {
  await page.setContent(
    html(`<style>button { outline: none; background: transparent; border: 0; }
      button:focus-visible { outline: 2px solid #1869ba; outline-offset: 2px; } #busy, .dim { opacity: 0.6; }</style>
      <button id="busy">A</button><div class="dim"><button id="in-dim">B</button></div><button id="clear">C</button>`),
  );
  expect(await ring.ringFindings(page)).toEqual([
    { rule: 'ntn-focus-ring', target: '#busy' },
    { rule: 'ntn-focus-ring', target: '#in-dim' },
  ]);
});

test('the focus walk reports where it stops short: at a control that keeps focus on Tab, at one that leaves it on body before a tab stop, or at its cap', async ({ page }) => {
  const rings = `<style>button { outline: none; } button:focus-visible { outline: 2px solid #000000; outline-offset: 2px; }
    .faint:focus-visible { outline-color: #cccccc; }</style>`;
  await page.setContent(
    html(`${rings}<button id="first">A</button><button id="indent">B</button><button class="faint">C</button>
      <script>document.getElementById('indent').addEventListener('keydown', event => { if (event.key === 'Tab') event.preventDefault(); });</script>`),
  );
  expect(await ring.ringFindings(page)).toEqual([{ rule: 'ntn-focus-walk', target: '#indent' }]);
  await page.setContent(
    html(`${rings}<button id="gone">A</button><button class="faint">B</button>
      <script>document.getElementById('gone').addEventListener('keydown', event => { if (event.key === 'Tab') { event.preventDefault(); event.target.remove(); } });</script>`),
  );
  expect(await ring.ringFindings(page)).toEqual([{ rule: 'ntn-focus-walk', target: '#gone' }]);
  await page.setContent(html(`${rings}<button id="one">1</button><button id="two">2</button><button id="three">3</button><button class="faint">4</button>`));
  expect(await ring.ringFindings(page, { max: 2 })).toEqual([{ rule: 'ntn-focus-walk', target: '#two' }]);
});

test("the hit boxes find a small link alone in its list item, and the ring finds one that clears the plane around it but not the control's own fill", async ({ page }) => {
  await page.setContent(html('<ul><li><a href="#settings" id="settings">Settings</a></li></ul>'));
  expect(await targets.targetFindings(page)).toEqual([{ rule: 'ntn-target-size', target: '#settings' }]);
  await page.setContent(
    html(`<style>.toolbar { background: #333333; padding: 8px; } #on-fill { background: #ffffff; border: 0; outline: none; }
      #on-fill:focus-visible { outline: 2px solid #ffffff; outline-offset: 0; }</style>
      <div class="toolbar"><button id="on-fill">A</button></div>`),
  );
  expect(await ring.ringFindings(page)).toEqual([{ rule: 'ntn-focus-ring', target: '#on-fill' }]);
});

test('the layers check finds a tab stop nobody sees, in a collapsed, off-screen or transparent layer, and passes an inert layer and a skip link that shows on focus', async ({ page }) => {
  const layers = await import('./layers.mjs');
  await page.setContent(
    html(`<style>button { width: 44px; height: 44px; } .collapsed { width: 0; overflow: hidden; } .off { position: absolute; left: -9999px; }
      .clear { opacity: 0; } .skip { position: absolute; left: -9999px; } .skip:focus { left: 0; top: 0; }</style>
      <a href="#shown" class="skip" id="skip">Skip</a><button id="shown">A</button>
      <div class="collapsed"><button id="in-collapsed">B</button></div>
      <div class="off"><button id="off-screen">C</button></div>
      <div class="clear"><button id="transparent">D</button></div>
      <div class="collapsed" inert><button id="in-inert">E</button></div>`),
  );
  expect(await layers.layerFindings(page)).toEqual([
    { rule: 'ntn-hidden-focus', target: '#in-collapsed' },
    { rule: 'ntn-hidden-focus', target: '#off-screen' },
    { rule: 'ntn-hidden-focus', target: '#transparent' },
  ]);
});

test('the layers check finds a step that leaves focus on body, and passes one that returns it to its invoker', async ({ page }) => {
  const layers = await import('./layers.mjs');
  await page.setContent(
    html(`<button id="open">Menu</button>
      <script>
        document.getElementById('open').addEventListener('click', () => {
          const close = Object.assign(document.createElement('button'), { id: 'close', textContent: 'Close' });
          close.addEventListener('click', () => { if (window.returnFocus) document.getElementById('open').focus(); close.remove(); });
          document.querySelector('main').append(close);
          close.focus();
        });
      </script>`),
  );
  const openAndClose = async () => {
    await page.focus('#open');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
  };
  await openAndClose();
  expect(await layers.focusLost(page, 'close the menu')).toEqual([{ rule: 'ntn-focus-lost', target: 'close the menu' }]);
  await page.evaluate('window.returnFocus = true');
  await openAndClose();
  expect(await layers.focusLost(page, 'close the menu')).toEqual([]);
});

test('the layers check finds a tab stop out of the order the page reads in, back along a row, up a column or up to the column before, and passes a row in order', async ({ page }) => {
  const layers = await import('./layers.mjs');
  await page.setContent(
    html(`<style>button { width: 44px; height: 44px; } .row { display: flex; gap: 8px; } .reversed { flex-direction: row-reverse; justify-content: flex-end; }
      .column { display: flex; flex-direction: column-reverse; align-items: flex-start; } .stack { display: flex; flex-direction: column; gap: 8px; }</style>
      <div class="row"><button id="a1">1</button><button id="a2">2</button></div>
      <div class="row reversed"><button id="b1">1</button><button id="b2">2</button></div>
      <div class="column"><button id="c1">1</button><button id="c2">2</button></div>
      <div class="row reversed"><div class="stack"><button id="d1">1</button><button id="d2">2</button></div><div class="stack"><button id="d3">3</button><button id="d4">4</button></div></div>`),
  );
  expect(await layers.layerFindings(page)).toEqual([
    { rule: 'ntn-tab-order', target: '#b2' },
    { rule: 'ntn-tab-order', target: '#c2' },
    { rule: 'ntn-tab-order', target: '#d3' },
  ]);
});

test('the layers check reads tab order in one frame, so a column read top to bottom passes though the walk scrolls down it', async ({ page }) => {
  const layers = await import('./layers.mjs');
  await page.setContent(
    html(`<style>button { display: block; width: 44px; height: 44px; } .gap { height: 520px; } .room { height: 1200px; }</style>
      <button id="top">1</button><div class="gap"></div><button id="middle">2</button><div class="gap"></div><button id="bottom">3</button>
      <div class="room"></div>`),
  );
  // The room below lets Chrome scroll the last stop it tabs to into the middle of the page, above where
  // the stop before it was read
  expect(await layers.layerFindings(page)).toEqual([]);
});

test('the layers check reads a step out of a scroller in the frame it is read in, so a button after the scroller reads in order', async ({ page }) => {
  const layers = await import('./layers.mjs');
  await page.setContent(
    html(`<style>button { display: block; width: 44px; height: 44px; } .scroller { height: 200px; overflow-y: auto; } .gap { height: 150px; }</style>
      <div class="scroller"><button id="in1">1</button><div class="gap"></div><button id="in2">2</button><div class="gap"></div><button id="in3">3</button></div>
      <button id="after">After</button>`),
  );
  expect(await layers.layerFindings(page)).toEqual([]);
});

test('the layers check reads a step onto a fixed bar in the frame it is read in, so the bar after a scrolled page reads in order', async ({ page }) => {
  const layers = await import('./layers.mjs');
  await page.setContent(
    html(`<style>button { display: block; width: 44px; height: 44px; } .gap { height: 900px; } .room { height: 1200px; } .bar { position: fixed; bottom: 0; left: 0; }</style>
      <button id="first">1</button><div class="gap"></div><button id="last">2</button><div class="room"></div>
      <div class="bar"><button id="bar">Bar</button></div>`),
  );
  expect(await layers.layerFindings(page)).toEqual([]);
});

test('the layers check still finds a column read back up after a scroll, in the frame each step is read in', async ({ page }) => {
  const layers = await import('./layers.mjs');
  // CSS order shows the column top, mid, low, where Tab reads it top, low, mid
  await page.setContent(
    html(`<style>main { display: flex; flex-direction: column; } button { width: 44px; height: 44px; } .short { height: 300px; } .long { height: 900px; } .room { height: 1200px; }</style>
      <button id="top" style="order: 1">1</button><div class="short" style="order: 2"></div><button id="low" style="order: 5">2</button>
      <div class="long" style="order: 4"></div><button id="mid" style="order: 3">3</button><div class="room" style="order: 6"></div>`),
  );
  expect(await layers.layerFindings(page)).toEqual([{ rule: 'ntn-tab-order', target: '#mid' }]);
});

test('the layers check reads a link that wraps by its line boxes: shown where either part sits, and a stop after it on its second line in order', async ({ page }) => {
  const layers = await import('./layers.mjs');
  await page.setContent(
    html(`<style>p { font: 16px/24px monospace; margin: 0 0 24px; } .wide { width: 40ch; } .narrow { width: 20ch; }</style>
      <p class="wide">aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa <a href="#wrapped" id="wrapped">bb cc</a> <a href="#help" id="help">help</a></p>
      <p class="narrow">aaaa <a href="#long" id="long">bbbbbbbbbbbbbbb cc</a> <a href="#more" id="more">more</a></p>`),
  );
  expect(await layers.layerFindings(page)).toEqual([]);
});

test("the announcement recorder reads back what a step makes the live regions say: what was added, or the whole text of an atomic one, and nothing from a region that's off or from no region", async ({ page }) => {
  const announce = await import('./announce.mjs');
  await page.setContent(
    html(`<div id="status" role="status"></div><div id="alert" role="alert"></div><div id="log" role="log" aria-live="off"></div>
      <div id="count" aria-live="polite"><span id="number">0</span> notes</div><div id="plain"></div>
      <div id="total" aria-live="polite" aria-atomic="true"><span id="sum">0</span> notes</div>`),
  );
  await announce.recordAnnouncements(page);
  await page.evaluate(`document.getElementById('status').textContent = 'Saved';
    document.getElementById('alert').textContent = "Couldn't save";
    document.getElementById('log').textContent = 'Responding';
    document.getElementById('plain').textContent = 'Not a region';
    document.getElementById('number').textContent = '3';
    document.getElementById('sum').textContent = '3';`);
  expect(await announce.readAnnouncements(page)).toEqual([
    { region: '#status', politeness: 'polite', text: 'Saved' },
    { region: '#alert', politeness: 'assertive', text: "Couldn't save" },
    { region: '#count', politeness: 'polite', text: '3' },
    { region: '#total', politeness: 'polite', text: '3 notes' },
  ]);
  expect(await announce.readAnnouncements(page)).toEqual([]);
});

test('the announcement recorder hears an alert added with its text as its own region, once, inside a log that is off or a polite region alike', async ({ page }) => {
  const announce = await import('./announce.mjs');
  await page.setContent(html('<div id="log" role="log" aria-live="off"></div><div id="feed" aria-live="polite"></div>'));
  await announce.recordAnnouncements(page);
  await page.evaluate(`const alert = (id, text) => {
      const el = Object.assign(document.createElement('div'), { id, textContent: text });
      el.setAttribute('role', 'alert');
      return el;
    };
    document.querySelector('main').append(alert('gone', "This note was deleted, so these changes aren't saved."));
    document.getElementById('log').append(alert('stopped', 'The answer stopped'));
    document.getElementById('feed').append(alert('error', "Couldn't reach the model"));`);
  expect(await announce.readAnnouncements(page)).toEqual([
    { region: '#gone', politeness: 'assertive', text: "This note was deleted, so these changes aren't saved." },
    { region: '#stopped', politeness: 'assertive', text: 'The answer stopped' },
    { region: '#error', politeness: 'assertive', text: "Couldn't reach the model" },
  ]);
});

test('the announcement recorder keeps hearing after setContent() writes a new document into the same window', async ({ page }) => {
  const announce = await import('./announce.mjs');
  await page.setContent(html('<div id="status" role="status"></div>'));
  await announce.recordAnnouncements(page);
  await page.setContent(html('<div id="status" role="status"></div>'));
  await announce.recordAnnouncements(page);
  await page.evaluate(`document.getElementById('status').textContent = "Couldn't save"`);
  expect(await announce.readAnnouncements(page)).toEqual([{ region: '#status', politeness: 'polite', text: "Couldn't save" }]);
});

test('the announcement recorder reads each toast a region adds alone, and nothing when one leaves, as a screen reader says them', async ({ page }) => {
  const announce = await import('./announce.mjs');
  await page.setContent(html('<div id="toasts" role="status" aria-live="polite" aria-atomic="false"></div>'));
  await announce.recordAnnouncements(page);
  const toast = (/** @type {string} */ text) =>
    page.evaluate(`document.getElementById('toasts').append(Object.assign(document.createElement('div'), { textContent: ${JSON.stringify(text)} }))`);
  await toast('Copied');
  expect(await announce.readAnnouncements(page)).toEqual([{ region: '#toasts', politeness: 'polite', text: 'Copied' }]);
  await toast('Exported');
  expect(await announce.readAnnouncements(page)).toEqual([{ region: '#toasts', politeness: 'polite', text: 'Exported' }]);
  await page.evaluate("document.querySelector('#toasts > div').remove()");
  expect(await announce.readAnnouncements(page)).toEqual([]);
});

test("the announcement recorder refuses a page that never started recording, and one a reload has replaced since", async ({ page }) => {
  const announce = await import('./announce.mjs');
  await page.setContent(html('<div id="status" role="status"></div>'));
  await expect(announce.readAnnouncements(page)).rejects.toThrow(/^the page isn't recording/);
  await announce.recordAnnouncements(page);
  await page.reload();
  await expect(announce.readAnnouncements(page)).rejects.toThrow(/^the page isn't recording/);
});

test('under reduced motion, the motion check finds a transform transition, a keyframed one, smooth scroll and a canvas that keeps redrawing, and passes a fade', async ({ page }) => {
  const motion = await import('./motion.mjs');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setContent(
    html(`<style>#slide { transition: transform 200ms; } #fade { transition: opacity 200ms; }
      @keyframes spin { to { transform: rotate(1turn); } } #spin { animation: spin 1s infinite; }
      #scroller { scroll-behavior: smooth; height: 40px; overflow: auto; }</style>
      <div id="slide">A</div><div id="fade">B</div><div id="spin">C</div><div id="scroller"><p>D</p></div>
      <canvas id="chart" width="40" height="40"></canvas><canvas id="still" width="40" height="40"></canvas>
      <script>
        const chart = document.getElementById('chart').getContext('2d');
        let x = 0;
        (function draw() { chart.clearRect(0, 0, 40, 40); chart.fillRect((x = (x + 1) % 40), 0, 4, 40); requestAnimationFrame(draw); })();
        document.getElementById('still').getContext('2d').fillRect(0, 0, 10, 10);
      </script>`),
  );
  expect(await motion.motionFindings(page)).toEqual([
    { rule: 'transform-transition', target: '#slide' },
    { rule: 'transform-animation', target: '#spin' },
    { rule: 'smooth-scroll', target: '#scroller' },
    { rule: 'chart-animation', target: '#chart' },
  ]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(motion.motionFindings(page)).rejects.toThrow(/prefers-reduced-motion: reduce/);
});

test("the clipping check finds an action a parent cuts off or scrolling can't reach, and at 320 CSS px a page that scrolls sideways", async ({ page }) => {
  const clip = await import('./clip.mjs');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.setContent(
    html(`<style>button { flex: none; width: 44px; height: 44px; } .bar { display: flex; width: 100px; overflow: hidden; }
      .scroller { display: flex; width: 100px; overflow-x: auto; } #early { position: relative; left: -30px; } #wide { width: 400px; height: 10px; }</style>
      <div class="bar"><button id="a">A</button><button id="b">B</button><button id="cut">C</button></div>
      <div class="scroller"><button id="d">D</button><button id="e">E</button><button id="f">F</button></div>
      <button id="early">G</button><div id="wide"></div>`),
  );
  const cut = [
    { rule: 'ntn-clipped-action', target: '#cut' },
    { rule: 'ntn-clipped-action', target: '#early' },
  ];
  expect(await clip.clipFindings(page)).toEqual([...cut, { rule: 'ntn-reflow', target: '#wide' }]);
  await page.setViewportSize({ width: 1280, height: 640 });
  expect(await clip.clipFindings(page)).toEqual(cut);
});
