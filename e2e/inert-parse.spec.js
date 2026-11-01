/**
 * Reading a note's stored HTML for its text or its Markdown fetches nothing the HTML points to.
 * The text readers (the editor's, App's, the notes manager's and the AI chat's) and the two
 * Markdown readers the export falls back to parse it in a document of its own, so a stored
 * remote image doesn't load while they read, and what they return is unchanged. The same HTML
 * parsed in the page's own document does load its image, which shows the check sees a fetch.
 * The spec answers the image host itself, so nothing leaves the machine. It ends with the
 * uncaught-exception check.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/** Where the stored images point */
const HOST = 'https://images.example.test';

/** A 1x1 transparent GIF */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

test("reading a note's stored HTML for its text or Markdown fetches nothing it points to", async ({ extension }) => {
  /** The image names fetched, in order */
  const fetched = [];
  await extension.context.route(`${HOST}/**`, route => {
    fetched.push(new URL(route.request().url()).pathname.replace(/^\/|\.gif$/g, ''));
    return route.fulfill({ status: 200, contentType: 'image/gif', body: PIXEL });
  });
  await extension.seedOnboarded();
  const page = await driver.openNewTab(extension);

  const read = await page.evaluate(host => {
    const stored = name => `<b>Milk</b> and <i>eggs</i><img src="${host}/${name}.gif">`;
    const readers = {
      'editor text': html => app.editor.stripHtmlTags(html),
      'App text': html => app.stripHtml(html),
      'App Markdown': html => app.htmlToMarkdown(html),
      'notes manager text': html => app.notesManager.stripHtml(html),
      'notes manager Markdown': html => app.notesManager.htmlToMarkdown(html),
      'AI chat text': html => app.aiChatController.stripHtml(html),
    };
    return Object.fromEntries(Object.entries(readers).map(([name, reader]) => [name, reader(stored(name.replace(/ /g, '-')))]));
  }, HOST);
  expect(read).toEqual({
    'editor text': 'Milk and eggs',
    'App text': 'Milk and eggs',
    'App Markdown': '**Milk** and *eggs*',
    'notes manager text': 'Milk and eggs',
    'notes manager Markdown': '**Milk** and *eggs*',
    'AI chat text': 'Milk and eggs',
  });

  // The same HTML parsed in the page's own document loads its image
  await page.evaluate(host => {
    document.createElement('div').innerHTML = `<img src="${host}/page-document.gif">`;
  }, HOST);
  await expect.poll(() => fetched).toContain('page-document');
  expect(fetched).toEqual(['page-document']);
  await expectNoUncaught(extension, page);
});
