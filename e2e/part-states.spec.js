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
  'u5-trying-again': ['Saving…', 'Reload anyway'],
  'u5-notice': ['Reload'],
  'u5-from-again': ['Try again', 'Reload anyway'],
  'u5-from-again-failed-again': ['Try again', 'Reload anyway'],
  'm5-related-first-download': [],
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
        // On Stats it wraps inside the view, which is as wide with it as without it
        const widens = await panel.evaluate((element) => {
          const view = element.closest('.stats-container');
          if (!view) return 0;
          const withIt = view.getBoundingClientRect().width;
          // Over the panel's own display: flex, which [hidden] doesn't beat
          element.style.display = 'none';
          const without = view.getBoundingClientRect().width;
          element.style.display = '';
          return withIt - without;
        });
        expect(widens, 'how much wider the stats view is with the panel').toBe(0);
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
    const reload = panel.locator('button.part-state-reload');
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

/** Whether a part's buttons sit beside its words, at the row's end, rather than under them */
const beside = (panel) => panel.locator('.part-state-actions').evaluate((actions) => getComputedStyle(actions).flexDirection === 'row-reverse');

for (const width of WIDTHS) {
  test(`at ${width}, the charts' button pressed stays where it was, and nothing riskier lands under the pointer`, async ({ playwright, headless }, testInfo) => {
    await onTab({ playwright, headless }, testInfo, states.missing('chart'), { width }, async (extension, page) => {
      await states.failingSaves(page);
      await states.typeLine(page, ' and a line never stored');
      await states.openStats(page);
      const panel = page.locator(states.PLACES.charts);
      const tryAgain = panel.locator('button.part-state-try');
      const reload = panel.locator('button.part-state-reload');
      await expect(panel).toContainText('Failed to load the charts. Please try again.');
      // The second failure fits beside the words at both widths, as the view keeps its width
      expect(await beside(panel)).toBe(true);
      const first = await states.boxOf(tryAgain);
      // Try again failed: it stays where it was, and Reload goes on the far side, to its left
      await tryAgain.click();
      await expect(panel).toContainText('Failed to load the charts again.');
      const again = await states.boxOf(tryAgain);
      expect(states.same(again, first), `Try again stays where it was: ${JSON.stringify({ first, again })}`).toBe(true);
      const pressed = await states.boxOf(reload);
      expect(pressed.x + pressed.width).toBeLessThanOrEqual(first.x);
      // Reload's save failed: Try again takes its place, and Reload anyway lands clear of it
      await reload.click();
      await expect(panel).toContainText("Failed to save your changes, so the page didn't reload.", { timeout: 15_000 });
      // Measured as soon as the words are there: a place drawn a frame late is a place missed
      const taken = await states.boxOf(tryAgain);
      const anyway = await states.boxOf(panel.locator('button.part-state-anyway'));
      expect(states.holds(taken, pressed), `Try again takes the place of the Reload pressed: ${JSON.stringify({ pressed, taken })}`).toBe(true);
      expect(states.overlaps(anyway, pressed), `Reload anyway lands clear of it: ${JSON.stringify({ pressed, anyway })}`).toBe(false);
      // With Try again's own place kept empty beside the words, Reload anyway takes a line of its
      // own under the buttons, at the row's end, and the words keep the room they have beside a
      // single Reload's u5 (about 210 px at 800)
      const spacer = await states.boxOf(panel.locator('button.part-state-spacer'));
      expect(anyway.y, 'Reload anyway is under the buttons').toBeGreaterThanOrEqual(taken.y + taken.height);
      expect(Math.abs((anyway.x + anyway.width) - (spacer.x + spacer.width)), "Reload anyway ends where the row's buttons do").toBeLessThanOrEqual(1);
      const room = await panel.locator('.part-state-text > span:last-child').evaluate((words) => words.getBoundingClientRect().width);
      expect(room, 'the words keep their room').toBeGreaterThanOrEqual(210);
      // and keep to the row's top, level with Try again, so they don't drop as the row grows a line
      const words = await states.boxOf(panel.locator('.part-state-text'));
      expect(Math.abs(words.y - taken.y), `the words keep to the row's top: ${JSON.stringify({ taken, words })}`).toBeLessThanOrEqual(1);
      await expect(tryAgain).toBeFocused();
      // Its Try again, failing again, keeps every button where it is
      const buttons = [tryAgain, panel.locator('button.part-state-anyway')];
      const placed = await Promise.all(buttons.map(states.boxOf));
      await tryAgain.click();
      await expect(panel).toContainText("Failed to save your changes again, so the page didn't reload.", { timeout: 15_000 });
      const after = await Promise.all(buttons.map(states.boxOf));
      expect(after.every((box, i) => states.same(box, placed[i])), 'every button stays where it was').toBe(true);
      await expectNoUncaught(extension, page);
    });
  });

  test(`at ${width}, the export's Try again stays where it was when it fails again, with Reload on the far side`, async ({ playwright, headless }, testInfo) => {
    await onTab({ playwright, headless }, testInfo, states.missing('jszip'), { width }, async (extension, page) => {
      await states.exportMarkdown(page);
      const row = page.locator(states.PLACES.export);
      const tryAgain = row.locator('button.part-state-try');
      await expect(row).toContainText('Failed to export your notes as Markdown. Please try again.');
      // Where the second failure can't fit beside the words, the first already puts Try again under them
      const besideWords = await beside(row);
      expect(besideWords).toBe(width === 1440);
      const first = await states.boxOf(tryAgain);
      await tryAgain.click();
      await expect(row).toContainText('Failed to export your notes as Markdown again. Export JSON still works.');
      const after = await states.boxOf(tryAgain);
      // Under the words, the longer words may push the buttons down a line, never sideways
      const kept = besideWords ? states.same(after, first) : states.same({ ...after, y: first.y, height: first.height }, first);
      expect(kept, 'Try again stays where it was').toBe(true);
      const reloadBox = await states.boxOf(row.locator('button.part-state-reload'));
      if (besideWords) expect(reloadBox.x + reloadBox.width).toBeLessThanOrEqual(first.x);
      else expect(reloadBox.x).toBeGreaterThanOrEqual(first.x + first.width);
      await expectNoUncaught(extension, page);
    });
  });
}

test("on Stats, where the editor is hidden, a failed save its notice explains stays in the row, with focus on Try again", async ({ playwright, headless }, testInfo) => {
  await onTab({ playwright, headless }, testInfo, states.threw('chart'), { width: 1440 }, async (extension, page) => {
    await states.failingSaves(page, 'reload-required');
    await states.typeLine(page, ' and a line never stored');
    await expect(page.locator('.reload-notice')).toBeVisible();
    await states.openStats(page);
    const panel = page.locator(states.PLACES.charts);
    await panel.locator('button.part-state-reload').click();
    await expect(panel).toContainText("Failed to save your changes, so the page didn't reload.", { timeout: 15_000 });
    await expect(panel.locator('button.part-state-try')).toBeFocused();
    await expectNoUncaught(extension, page);
  });
});
