/**
 * #27 slice 3b's states on the packaged build, at 1440 and 800 wide: the boot failure, and each
 * part that loads at its first use saying how its load went where the part goes (the charts,
 * search, the Markdown export, the embedding model in search and Related Notes, the AI chat's All
 * Notes), with Try again, then the second failure with Reload, or Reload alone for a file that
 * loaded and threw or another build on disk. A part's Reload runs the save guards first and says
 * when a save stopped it, a guard that never answers included, and the Try again after that says
 * it's saving while the guards run. The status line shows only past 400 ms and holds 300 ms. No
 * toast says any of it, and typing still saves. The states themselves are in
 * e2e/part-states/states.js.
 */

const fs = require('fs');
const path = require('path');
const { test, expect, expectNoUncaught, resolveDist } = require('./harness');
const driver = require('./characterization/driver');
const states = require('./part-states/states');

const WIDTHS = [1440, 800];

/** Run `body(extension, page, dist)` on a tab of `build` at `width`, and close the session */
async function onTab({ playwright, headless }, testInfo, build, open, body) {
  await states.withBuild(build, async (dist) => {
    const { extension, page } = await states.openTab({ playwright, headless }, dist, open);
    try {
      await body(extension, page, dist);
    } catch (error) {
      await testInfo.attach('part-states-extension-log', { body: extension.log(), contentType: 'text/plain' }).catch(() => {});
      throw error;
    } finally {
      await extension.close();
    }
  });
}

/** The labels of the buttons a part shows, in order */
function buttons(panel) {
  return panel.locator('.part-state-actions button:visible').evaluateAll((list) => list.map((button) => (
    button.children.length === 2 ? button.children[0].textContent : button.textContent
  )));
}

const BUTTONS = {
  'c1-charts-failed': ['Try again'],
  'c3-charts-loading': [],
  'c5-charts-failed-again': ['Try again', 'Reload'],
  'c7-charts-threw': ['Reload'],
  'c8-charts-other-build': ['Reload'],
  's1-search-failed': ['Try again'],
  's4-search-failed-again': ['Try again', 'Reload'],
  's6-search-threw': ['Reload'],
  'e1-export-failed': ['Try again'],
  'e4-export-failed-again': ['Try again', 'Reload'],
  'e6-export-threw': ['Reload'],
  'm1-semantic-failed': ['Try again'],
  'm3-semantic-failed-again': ['Try again', 'Reload'],
  'm4-related-failed': ['Try again'],
  'a1-all-notes-failed': ['Try again'],
  'u5-save-failed': ['Try again', 'Reload anyway'],
  'u5-trying-again': ['Try again', 'Reload anyway'],
};

for (const width of WIDTHS) {
  for (const state of states.STATES) {
    test(`${state.name} at ${width}: ${state.about}`, async ({ playwright, headless }, testInfo) => {
      await onTab({ playwright, headless }, testInfo, state.build(), { width, ...state.open }, async (extension, page) => {
        if (state.open && state.open.wait === false) {
          const failure = await state.reach(page);
          // The shell is hidden and inert, Reload has focus with the two sentences as its
          // description, and the tab's title says it
          await expect(failure.getByRole('button', { name: 'Reload' })).toBeFocused();
          await expect(failure.getByRole('button', { name: 'Reload' })).toHaveAccessibleDescription("NewTabNote couldn't start. Reloading doesn't delete your notes.");
          expect(await page.title()).toBe("NewTabNote couldn't start");
          expect(await page.locator('#app').evaluate((app) => [app.hidden, app.inert])).toEqual([true, true]);
          await expect(page.getByText(/reinstall/i)).toHaveCount(0);
          await expectNoUncaught(extension, page);
          return;
        }
        await driver.recordToasts(page);
        const panel = await state.reach(page);
        expect(await buttons(panel)).toEqual(BUTTONS[state.name]);
        // Its words are said through a live region on the page before them
        const said = await panel.evaluate((element) => {
          const regions = [...document.querySelectorAll('.part-state-live')].map((region) => region.textContent);
          return { regions, inMessages: Boolean(element.closest('[aria-live]')) };
        });
        const words = (await panel.locator('.part-state-text').textContent()).trim();
        if (said.inMessages) expect(said.regions.join(' ')).not.toContain(words);
        else expect(said.regions.join(' | ')).toContain(state.said || words.split('.')[0]);
        // Each button is a 44 px target
        for (const box of await panel.locator('.part-state-actions button:visible').evaluateAll((list) => list.map((b) => b.getBoundingClientRect().toJSON()))) {
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.width).toBeGreaterThanOrEqual(44);
        }
        // It fits the window
        const rect = await panel.evaluate((element) => element.getBoundingClientRect().toJSON());
        expect(rect.right).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => window.__ntnToasts.filter(({ success }) => !success).map(({ text }) => text))).toEqual([]);
        await expectNoUncaught(extension, page);
      });
    });
  }
}

for (const width of WIDTHS) {
  test(`at ${width}, a Try again that finds the file draws the charts and moves focus to the first chart's heading`, async ({ playwright, headless }, testInfo) => {
    await onTab({ playwright, headless }, testInfo, states.missing('chart'), { width }, async (extension, page, dist) => {
      await states.openStats(page);
      const panel = page.locator(states.PLACES.charts);
      await expect(panel).toContainText('Failed to load the charts. Please try again.');
      // The file is back, as a repaired install puts it
      states.restoreLibrary(extension, 'chart');
      await panel.getByRole('button', { name: 'Try again' }).focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => Object.keys(app.analyticsController.charts).length)).toBe(4);
      await expect(panel).toHaveCount(0);
      await expect(page.locator('.charts-grid h3').first()).toBeFocused();
      // The counts stayed, and the header kept its height through it (change 15)
      expect(await page.locator('#header').evaluate((header) => header.getBoundingClientRect().height)).toBe(48);
      await expectNoUncaught(extension, page);
    });
  });

  test(`at ${width}, a Try again that finds Fuse.js lists the matches, moves focus to the search field, and says how many`, async ({ playwright, headless }, testInfo) => {
    await onTab({ playwright, headless }, testInfo, states.missing('fuse'), { width }, async (extension, page, dist) => {
      await driver.searchNotes(page, 'plan');
      const panel = page.locator(states.PLACES.search);
      await expect(panel).toContainText('Failed to load search. Please try again.');
      states.restoreLibrary(extension, 'fuse');
      await panel.getByRole('button', { name: 'Try again' }).click();
      await expect.poll(() => driver.listedNoteNames(page)).toEqual(['Beta plan', 'Alpha plan']);
      await expect(page.getByPlaceholder('Search notes...')).toBeFocused();
      await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#sidebar > .part-state-live')].map((region) => region.textContent))).toContain('2 notes match.');
      await expectNoUncaught(extension, page);
    });
  });
}

test('the status line shows only past 400 ms, and holds at least 300 ms once it shows', async ({ playwright, headless }, testInfo) => {
  for (const [delay, shows] of [[150, false], [450, true], [1200, true]]) {
    await onTab({ playwright, headless }, testInfo, {}, { width: 1440 }, async (extension, page) => {
      await states.slowLibrary(page, 'chart', delay);
      // When the line went in and out, from the press
      await page.evaluate(() => {
        window.__line = { in: null, out: null };
        const grid = document.querySelector('.charts-grid');
        new MutationObserver(() => {
          const shown = Boolean(grid.querySelector(':scope > .part-state'));
          if (shown && window.__line.in === null) window.__line.in = performance.now() - window.__pressed;
          if (!shown && window.__line.in !== null && window.__line.out === null) window.__line.out = performance.now() - window.__pressed;
        }).observe(grid, { childList: true });
        document.getElementById('sidebar-stats').addEventListener('click', () => { window.__pressed = performance.now(); }, { capture: true });
      });
      await states.openStats(page);
      await expect.poll(() => page.evaluate(() => Object.keys(app.analyticsController.charts).length)).toBe(4);
      const line = await page.evaluate(() => window.__line);
      if (!shows) {
        expect(line, `a ${delay} ms load`).toEqual({ in: null, out: null });
        return;
      }
      expect(line.in, `a ${delay} ms load`).toBeGreaterThanOrEqual(400);
      expect(line.out - line.in, `a ${delay} ms load`).toBeGreaterThanOrEqual(300);
      // A load that ends at 450 ms draws inside a second
      if (delay === 450) expect(line.out).toBeLessThan(1000);
    });
  }
});

test("a part's Reload whose save guard never answers stays after 10 s, and says the save failed", async ({ playwright, headless }, testInfo) => {
  await onTab({ playwright, headless }, testInfo, states.threw('chart'), { width: 1440 }, async (extension, page) => {
    await page.evaluate(() => { app.tabController.saveOpenEditors = () => new Promise(() => {}); });
    await driver.markPage(page);
    await states.openStats(page);
    const panel = page.locator(states.PLACES.charts);
    // Reload, which keeps its place as it reads Saving…
    const reload = panel.locator('button.part-state-swap');
    await reload.click();
    // Saving… at Reload's width, aria-disabled, with focus kept
    await expect(reload).toHaveAttribute('aria-disabled', 'true');
    await expect(reload).toContainText('Saving…');
    await expect(panel).toContainText("Failed to save your changes, so the page didn't reload.", { timeout: 15_000 });
    await expect(panel.getByRole('button', { name: 'Try again' })).toBeFocused();
    expect(await driver.wasReloaded(page)).toBe(false);
    await expectNoUncaught(extension, page);
  });
});

test("a part's Reload whose save guard fails stays, the editor's header says Error saving, and no toast says it twice", async ({ playwright, headless }, testInfo) => {
  await onTab({ playwright, headless }, testInfo, states.threw('chart'), { width: 1440 }, async (extension, page) => {
    await driver.recordToasts(page);
    await driver.markPage(page);
    const panel = await states.STATES.find((state) => state.name === 'u5-save-failed').reach(page);
    expect(await driver.wasReloaded(page)).toBe(false);
    await expect(page.locator('#save-status')).toHaveText('Error saving');
    expect(await page.evaluate(() => window.__ntnToasts.map(({ text }) => text))).not.toContain('Failed to save note. Please try again.');
    // Reload anyway reloads without the guards
    await panel.getByRole('button', { name: 'Reload anyway' }).click();
    await expect.poll(() => driver.wasReloaded(page).catch(() => true)).toBe(true);
  });
});
