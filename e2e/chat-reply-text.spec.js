/**
 * #21 on the built extension: the AI chat shows plain text in a reply as text. A reply stored in
 * either chat's history, and one streamed in, renders the markup it holds as written, and the
 * page loads nothing for it: a request observer answers every request to the test host and
 * records it. A plain Markdown reply renders as 1.4.1 rendered it.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const HOST = 'https://assets.example.test';
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** A reply holding markup of each kind a page acts on, all of it shown as text */
const markupReply = scope => [
  'Sure.',
  '',
  `<img src="${HOST}/${scope}-img.gif"> <img srcset="${HOST}/${scope}-srcset.gif 1x"> <picture><source srcset="${HOST}/${scope}-picture.gif"><img alt=""></picture>`,
  `<link rel="stylesheet" href="${HOST}/${scope}-link.css"> <style>@import url("${HOST}/${scope}-import.css"); #page-title { outline: 7px solid rgb(1, 2, 3) !important; }</style>`,
  `<video poster="${HOST}/${scope}-poster.gif"></video> <svg><image href="${HOST}/${scope}-svg.gif" width="1" height="1"></image></svg> <iframe src="${HOST}/${scope}-frame.html"></iframe>`,
  `<object data="${HOST}/${scope}-object.gif"></object> <embed src="${HOST}/${scope}-embed.gif"> <div style="background-image:url(${HOST}/${scope}-bg.gif)">x</div>`,
  `<form action="${HOST}/${scope}-form"><input value="${scope}-field"><button>${scope}-button</button></form>`,
  `<a href="${HOST}/${scope}-a.html">a link</a> <base href="${HOST}/${scope}-base/"> <meta http-equiv="refresh" content="1;url=${HOST}/${scope}-refresh.html">`,
].join('\n');

/** The elements a reply's Markdown never makes */
const NOT_MARKDOWN = 'img, picture, source, link, style, video, svg, iframe, object, embed, form, input, button, base, meta, div';

/** A plain Markdown reply, and the HTML 1.4.1's Utils.parseMarkdown made of it */
const PLAIN = [
  '## Plan', '', '- **Milk** and *eggs*', '- `code <b> & c` here', '', '1. first', '2. second', '', '> quoted, 3 > 2', '',
  '```js', 'const a = 1 < 2 && "b";', '```', '', "See [docs](https://a.test/docs?a=1&b=2) and [[Tom & Jerry]], it's \"fine\".", '',
  '| Item | Qty |', '|:-|-:|', '| Milk | 2 |', '', '---', '', '### Done', '__bold__ _it_',
].join('\n');
const PLAIN_AS_141 = '<h2>Plan</h2>\n<ul><li><strong>Milk</strong> and <em>eggs</em></li>\n<li><code>code &lt;b&gt; &amp; c</code> here</li>\n</ul>\n<ol><li>first</li>\n<li>second</li>\n</ol>\n<blockquote>quoted, 3 > 2</blockquote>\n<pre><code class="language-js">const a = 1 &lt; 2 &amp;&amp; &quot;b&quot;;</code></pre>\n<p>See <a href="https://a.test/docs?a=1&b=2" target="_blank" rel="noopener noreferrer">docs</a> and <a href="#" class="wiki-link" data-note-name="Tom &amp; Jerry">[[Tom &amp; Jerry]]</a>, it\'s "fine".</p>\n<table><thead><tr><th style="text-align: left">Item</th><th style="text-align: right">Qty</th></tr></thead><tbody><tr><td style="text-align: left">Milk</td><td style="text-align: right">2</td></tr></tbody></table>\n<hr>\n<h3>Done</h3>\n<strong>bold</strong> <em>it</em>';

/** Answer the test host, recording each request's path */
async function observe(extension) {
  const fetched = [];
  await extension.context.route(`${HOST}/**`, route => {
    const url = new URL(route.request().url());
    fetched.push(url.pathname.slice(1));
    const css = url.pathname.endsWith('.css');
    const html = url.pathname.endsWith('.html');
    return route.fulfill({ status: 200, contentType: css ? 'text/css' : html ? 'text/html' : 'image/gif', body: css ? 'p{}' : html ? '<p>x</p>' : PIXEL });
  });
  return fetched;
}

/** What the page shows for the replies in `container`: their elements, text and the page's state */
function shown(page, container) {
  return page.evaluate(([container, notMarkdown]) => {
    const replies = [...document.querySelectorAll(`#${container} .ai-chat-message.assistant .ai-message-content`)];
    return {
      replies: replies.length,
      foreign: replies.flatMap(reply => [...reply.querySelectorAll(notMarkdown)].map(el => el.tagName.toLowerCase())),
      text: replies.map(reply => reply.textContent).join('\n'),
      titleOutline: getComputedStyle(document.getElementById('page-title')).outlineColor,
      baseURI: document.baseURI,
    };
  }, [container, NOT_MARKDOWN]);
}

test('a reply stored in either chat shows its markup as text, and the page loads nothing for it', async ({ extension }) => {
  const fetched = await observe(extension);
  await extension.seedOnboarded();
  await extension.worker.evaluate(([note, global]) => chrome.storage.local.set({
    setting_noteChatMessages: [{ content: 'Hello', type: 'user' }, { content: note, type: 'assistant' }],
    setting_globalChatMessages: [{ content: 'Hello', type: 'user' }, { content: global, type: 'assistant' }],
  }), [markupReply('note'), markupReply('global')]);
  const page = await driver.openNewTab(extension);
  const pageURL = page.url();
  await expect.poll(async () => (await shown(page, 'ai-chat-messages')).replies).toBe(1);
  await expect.poll(async () => (await shown(page, 'global-chat-messages')).replies).toBe(1);
  // Long enough for anything the page would do with markup to have happened
  await page.waitForTimeout(3000);
  for (const [container, scope] of [['ai-chat-messages', 'note'], ['global-chat-messages', 'global']]) {
    const seen = await shown(page, container);
    expect(seen.foreign).toEqual([]);
    expect(seen.text).toContain(`<img src="${HOST}/${scope}-img.gif">`);
    expect(seen.text).toContain(`<input value="${scope}-field">`);
    expect(seen.titleOutline).not.toBe('rgb(1, 2, 3)');
    expect(seen.baseURI).toBe(pageURL);
  }
  expect(page.url()).toBe(pageURL);
  expect(fetched).toEqual([]);
  await expectNoUncaught(extension, page);
});

test('a streamed reply shows its markup as text while it streams and once it ends, and the page loads nothing for it', async ({ extension }) => {
  const fetched = await observe(extension);
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);
  const pageURL = page.url();
  await page.evaluate(reply => {
    // A provider that streams the reply a block at a time, so each block is committed as it ends
    Object.assign(LLM, {
      isConfigured: () => true,
      chatStream: async function* chatStream() {
        for (const block of reply.split('\n')) {
          yield `${block}\n\n`;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      },
    });
  }, markupReply('stream'));
  await page.locator('#ai-floating-btn').click();
  await page.locator('#ai-tab-note').click();
  await page.locator('#ai-chat-input').fill('hello');
  await page.locator('#ai-chat-input').press('Enter');
  await expect(page.locator('#ai-chat-messages .ai-chat-message.assistant').last()).toContainText('stream-button');
  await expect(page.locator('#ai-chat-messages .ai-streaming')).toHaveCount(0);
  await page.waitForTimeout(3000);
  const seen = await shown(page, 'ai-chat-messages');
  expect(seen.foreign).toEqual([]);
  expect(seen.text).toContain(`<img src="${HOST}/stream-img.gif">`);
  expect(seen.titleOutline).not.toBe('rgb(1, 2, 3)');
  expect(seen.baseURI).toBe(pageURL);
  expect(page.url()).toBe(pageURL);
  expect(fetched).toEqual([]);
  await expectNoUncaught(extension, page);
});

test('a plain Markdown reply renders as 1.4.1 rendered it', async ({ extension }) => {
  await extension.seedOnboarded();
  await extension.worker.evaluate(reply => chrome.storage.local.set({
    setting_globalChatMessages: [{ content: 'Hello', type: 'user' }, { content: reply, type: 'assistant' }],
  }), PLAIN);
  const page = await driver.openNewTab(extension);
  await expect.poll(async () => (await shown(page, 'global-chat-messages')).replies).toBe(1);
  const [rendered, as141] = await page.evaluate(old => {
    const reply = document.querySelector('#global-chat-messages .ai-chat-message.assistant .ai-message-content');
    // 1.4.1's HTML as the chat put it in: sanitized, then parsed in the page
    const expected = document.createElement('div');
    expected.innerHTML = sanitizeHtml(old);
    return [reply.innerHTML, expected.innerHTML];
  }, PLAIN_AS_141);
  expect(rendered).toBe(as141);
  await expectNoUncaught(extension, page);
});
