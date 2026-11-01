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
  await keepReplies(extension, `Sure.\n\n${markup('note')}`, `Sure.\n\n${markup('global')}`);
  const page = await driver.openNewTab(extension);
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
  await keepReplies(extension, reply, 'Ok');
  const page = await driver.openNewTab(extension);
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
  await keepReplies(extension, markdown, markdown);
  const page = await driver.openNewTab(extension);
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
