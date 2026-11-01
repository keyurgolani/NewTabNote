/**
 * An AI reply's text is shown as text. The replies kept in the note chat's and the All Notes
 * chat's history render when the new tab starts. The markup a reply's text holds shows as text,
 * nothing it points to loads, and the page's style, base address and location stay as they were.
 * A reply in plain Markdown renders as it did. The spec answers the remote host itself, so
 * nothing leaves the machine, and a parse in the page's own document shows it sees a fetch. Each
 * test ends with the uncaught-exception check.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/** Where the replies' markup points */
const HOST = 'https://images.example.test';

/** A 1x1 transparent GIF */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Answer HOST, recording each path asked for, in order */
async function answer(extension) {
  const fetched = [];
  await extension.context.route(`${HOST}/**`, route => {
    const { pathname } = new URL(route.request().url());
    fetched.push(pathname.slice(1));
    const type = pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.html') ? 'text/html' : 'image/gif';
    return route.fulfill({ status: 200, contentType: type, body: type === 'image/gif' ? PIXEL : '' });
  });
  return fetched;
}

/** Keep `note` and `global` as the assistant replies in the two chats' history */
async function keepReplies(extension, note, global) {
  await extension.worker.evaluate(([noteReply, globalReply]) => chrome.storage.local.set({
    setting_noteChatMessages: [{ content: 'Hello', type: 'user' }, { content: noteReply, type: 'assistant' }],
    setting_globalChatMessages: [{ content: 'Hello', type: 'user' }, { content: globalReply, type: 'assistant' }],
  }), [note, global]);
}

/**
 * A new tab whose two chats' history holds `note` and `global` as the assistant replies. They're
 * kept once the first start has written its own settings, and a new start reads them.
 */
async function openWithReplies(extension, note, global) {
  const page = await driver.openNewTab(extension);
  await keepReplies(extension, note, global);
  await driver.reload(page);
  return page;
}

/** The assistant replies the page shows */
const shownReplies = page => page.locator('.ai-chat-message.assistant .ai-message-content');

/** Parse an image in the page's own document and wait for its fetch, so every fetch before it has been seen */
async function fetchControl(page, fetched) {
  await page.evaluate(host => {
    document.createElement('div').innerHTML = `<img src="${host}/page-document.gif">`;
  }, HOST);
  await expect.poll(() => fetched).toContain('page-document.gif');
}

test('a stored chat reply shows its markup as text and loads nothing', async ({ extension }) => {
  const fetched = await answer(extension);
  await extension.seedOnboarded();
  const markup = scope => `<img src="${HOST}/${scope}.gif"> <link rel="stylesheet" href="${HOST}/${scope}.css">`
    + `<style>@import url("${HOST}/${scope}-import.css"); #page-title { outline: 7px solid rgb(1, 2, 3); }</style>`
    + `<a href="${HOST}/${scope}.html">a link</a> <input value="${scope} field"> <button>${scope} button</button>`;
  const page = await openWithReplies(extension, `Sure.\n\n${markup('note')}`, `Sure.\n\n${markup('global')}`);
  await expect(shownReplies(page)).toHaveCount(2);

  const shown = await page.evaluate(() => ({
    outline: getComputedStyle(document.getElementById('page-title')).outlineColor,
    tags: [...document.querySelectorAll('.ai-chat-message.assistant .ai-message-content *')].map(el => el.tagName.toLowerCase()),
    texts: [...document.querySelectorAll('.ai-chat-message.assistant .ai-message-content')].map(el => el.textContent),
  }));
  expect(shown.outline).not.toBe('rgb(1, 2, 3)');
  expect(shown.tags).toEqual(['p', 'p', 'p', 'p']);
  expect(shown.texts).toEqual([`Sure.\n${markup('note')}`, `Sure.\n${markup('global')}`]);

  await fetchControl(page, fetched);
  expect(fetched).toEqual(['page-document.gif']);
  await expectNoUncaught(extension, page);
});

test("a stored chat reply's base and refresh markup show as text and change nothing", async ({ extension }) => {
  const fetched = await answer(extension);
  await extension.seedOnboarded();
  const reply = `Ok <base href="${HOST}/based/"> <meta http-equiv="refresh" content="1;url=${HOST}/elsewhere.html">`;
  const page = await openWithReplies(extension, reply, 'Ok');
  /** A URL without its query and fragment */
  const place = url => `${new URL(url).origin}${new URL(url).pathname}`;
  const address = place(page.url());
  await expect(shownReplies(page)).toHaveCount(2);
  expect(await shownReplies(page).first().textContent()).toBe(reply);
  expect(place(await page.evaluate(() => document.baseURI))).toBe(address);

  // Past the refresh's second
  await page.waitForTimeout(2500);
  expect(place(page.url())).toBe(address);
  await fetchControl(page, fetched);
  expect(fetched).toEqual(['page-document.gif']);
  await expectNoUncaught(extension, page);
});

test('a stored chat reply in plain Markdown renders as before', async ({ extension }) => {
  await extension.seedOnboarded();
  const markdown = [
    '# Plan', '## This week', '- **milk** and *eggs*\n- `bread`', '1. first\n2. second', '> a quote',
    '```js\nconst a = b < c && d;\n```', '| Name | Count |\n| :--- | ---: |\n| Milk | 2 |',
    'See [the docs](https://example.test/docs), [mail](mailto:team@example.test) and [[Groceries]].', '---',
  ].join('\n\n');
  const page = await openWithReplies(extension, markdown, markdown);
  await expect(shownReplies(page)).toHaveCount(2);

  const { shown, before } = await page.evaluate(text => ({
    shown: [...document.querySelectorAll('.ai-chat-message.assistant .ai-message-content')].map(el => el.innerHTML),
    // What the history rendered before: the same Markdown reader, without the reply text's escapes
    before: sanitizeHtml(Utils.parseMarkdown(text)),
  }), markdown);
  expect(before).toContain('<table>');
  expect(shown).toEqual([before, before]);
  await expectNoUncaught(extension, page);
});

/** Every link address the assistant replies show, reply by reply */
const shownAddresses = page => page.evaluate(() => [...document.querySelectorAll('.ai-chat-message.assistant .ai-message-content')]
  .map(reply => [...reply.querySelectorAll('a[href]')].map(link => link.getAttribute('href'))));

test('a link in a stored reply keeps its address only when the link rule allows it', async ({ extension }) => {
  test.setTimeout(60_000);
  await extension.seedOnboarded();
  const reply = [
    'One [a](x:a.test/```js\ncode\n```) link.',
    'Then [b](https://example.test/ok), [c](mailto:team@example.test), [d](x:y) and [[Groceries]].',
  ].join('\n\n');
  const page = await openWithReplies(extension, reply, reply);
  await expect(shownReplies(page)).toHaveCount(2);
  const kept = ['https://example.test/ok', 'mailto:team@example.test', '#'];
  expect(await shownAddresses(page)).toEqual([kept, kept]);
  await expectNoUncaught(extension, page);
});

test('the link rule reads each address as the sanitized HTML holds it', async ({ extension }) => {
  test.setTimeout(60_000);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  const html = await page.evaluate(() => sanitizeHtml([
    '<a href="x:y">s</a>',
    '<a href="https://example.test/y">h</a>',
    '<a href="MAILTO:team@example.test">m</a>',
    '<a href="#" class="wiki-link" data-note-name="Groceries">w</a>',
    '<a href="x:y" class="wiki-link" data-note-name="Groceries">k</a>',
    '<a href="#">p</a>',
    '<a href="other.html">r</a>',
  ].join(' ')));
  expect(html).toBe([
    '<a>s</a>',
    '<a href="https://example.test/y">h</a>',
    '<a href="MAILTO:team@example.test">m</a>',
    '<a href="#" class="wiki-link" data-note-name="Groceries">w</a>',
    '<a class="wiki-link" data-note-name="Groceries">k</a>',
    '<a>p</a>',
    '<a>r</a>',
  ].join(' '));
  await expectNoUncaught(extension, page);
});

test('a reply whose links already pass the link rule renders exactly as before', async ({ extension }) => {
  test.setTimeout(120_000);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  const result = await page.evaluate(() => {
    // Before: the reply's Markdown as the page parses it, which is what sanitizing gave a reply
    // holding nothing the sanitizer strips
    const parsed = text => new DOMParser().parseFromString(Utils.parseMarkdownText(text), 'text/html').body;
    const passes = link => /^(?:https?|mailto):/i.test(link.getAttribute('href'))
      || (link.getAttribute('href') === '#' && link.classList.contains('wiki-link'));
    const PIECES = [
      'x', 'a b', ' ', '\n', '\n\n', '# ', '- ', '1. ', '> ', '**', '*', '_', '`', '```', '```js\n', '|a|b|\n', '|-|-|\n',
      '[a](https://example.test/x)', '[b](http://example.test/?q=1&r=2)', '[c](mailto:team@example.test)', '[d](HTTPS://EXAMPLE.TEST)',
      '[[Groceries]]', '[[Tom & Jerry]]', '[', ']', '(', ')', '&', '"', "'", '>',
    ];
    let seed = 0x143b;
    const random = n => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    let compared = 0;
    const differences = [];
    for (let k = 0; k < 3000; k++) {
      let text = '';
      for (let j = 1 + random(12); j > 0; j--) text += PIECES[random(PIECES.length)];
      const body = parsed(text);
      // Only replies whose every link address already passes the rule
      if (![...body.querySelectorAll('a[href]')].every(passes)) continue;
      compared += 1;
      if (sanitizeHtml(Utils.parseMarkdownText(text)) !== body.innerHTML && differences.length < 3) differences.push(text);
    }
    return { compared, differences };
  });
  expect(result.compared).toBeGreaterThan(2000);
  expect(result.differences).toEqual([]);
  await expectNoUncaught(extension, page);
});
