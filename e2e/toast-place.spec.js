/**
 * Where the new tab's toasts show (#33, the design director's V4): 92 px up and 24 px in, in every
 * state, so a toast sits above the AI chat's button and clear of the chat's input row. At 1440 and
 * 800 px wide, with the AI button showing, with the AI panel open, and in focus mode, a toast's box
 * meets neither. The tests also fail on an uncaught exception that test/known-defects.json
 * doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 800, height: 800 },
];

const WORDS = 'Kept your changes to “Shared” from a closed tab in a recovered note.';

/** A toast, as App shows the close-time drafts' ones, and the boxes that matter around it */
async function toastAmong(page) {
  return page.evaluate(words => {
    Utils.showToast(words, 'info', 6000);
    const box = element => {
      if (!element) return null;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return null;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
    };
    const toasts = document.querySelectorAll('.toast-container .toast');
    const sidebar = document.getElementById('ai-sidebar');
    const inputRow = sidebar && !sidebar.classList.contains('hidden')
      ? [...sidebar.querySelectorAll('.ai-chat-panel.active .ai-chat-input-area')].find(Boolean)
      : null;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      container: box(document.querySelector('.toast-container')),
      toast: box(toasts[toasts.length - 1]),
      button: box(document.getElementById('ai-floating-btn')),
      inputRow: box(inputRow || null),
    };
  }, WORDS);
}

/** Whether two boxes share any point */
const meet = (a, b) => Boolean(a && b) && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** The toast sits 92 px up and 24 px in, and meets neither the button nor the chat's input row */
function expectClear(placed, state) {
  expect(placed.toast, `${state}: the toast shows`).not.toBeNull();
  expect(Math.round(placed.viewport.width - placed.container.right), `${state}: 24 px in`).toBe(24);
  expect(Math.round(placed.viewport.height - placed.container.bottom), `${state}: 92 px up`).toBe(92);
  expect(meet(placed.toast, placed.button), `${state}: clear of the AI button`).toBe(false);
  expect(meet(placed.toast, placed.inputRow), `${state}: clear of the chat's input row`).toBe(false);
}

for (const size of WIDTHS) {
  test(`at ${size.width} px wide a toast sits above the AI button and clear of the chat, in every state`, async ({ extension }) => {
    await extension.seedOnboarded();
    await driver.seedNotes(extension, [{ name: 'Shared', blocks: [{ type: 'text', content: 'start' }] }]);
    const page = await driver.openNewTab(extension);
    await page.setViewportSize(size);
    await driver.openNote(page, 'Shared');

    const withButton = await toastAmong(page);
    expect(withButton.button, 'the AI button shows').not.toBeNull();
    expectClear(withButton, 'with the AI button');

    // The chat's input row shows once a provider is set up. This stands one in, as ai-jobs.spec.js
    // does, every call answered here and counted, and none is made
    await page.evaluate(() => {
      window.__aiCalls = [];
      const answer = (name, value) => async () => {
        window.__aiCalls.push(name);
        return value;
      };
      Object.assign(LLM, {
        isConfigured: () => true,
        generateTitle: answer('generateTitle', null),
        extractInsights: answer('extractInsights', null),
        chat: answer('chat', ''),
      });
    });
    await page.locator('#ai-floating-btn').click();
    await expect(page.locator('#ai-sidebar')).toBeVisible();
    const withPanel = await toastAmong(page);
    expect(withPanel.inputRow, "the chat's input row shows").not.toBeNull();
    expectClear(withPanel, 'with the AI panel open');
    await page.locator('#ai-sidebar-close').click();

    await page.evaluate(() => app.toggleFocusMode(true));
    await expect(page.locator('body')).toHaveClass(/focus-mode/);
    expectClear(await toastAmong(page), 'in focus mode');
    expect(await page.evaluate(() => window.__aiCalls), 'no provider call').toEqual([]);
    await expectNoUncaught(extension, page);
  });
}
