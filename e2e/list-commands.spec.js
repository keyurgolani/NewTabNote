/**
 * #12 slice 4c2 on the built extension: the note-list writes go through kernel commands, and
 * each shows in the sidebar from the tab's note list with no refresh. New notes from the
 * sidebar, the header, the command palette, and a folder's menu; the calendar's Daily Note
 * and today's, each clicked twice at once, make one note; a Markdown file and a single-note
 * JSON export import as one note each; an open note archives and comes back; a block dropped on
 * a sidebar note goes after its last block, and keeps its markup only when this page's editor
 * started the drag; and a pin made mid-typing survives the save. Each test also fails on an uncaught exception that
 * test/known-defects.json doesn't list.
 */

const { test, expect, expectNoUncaught } = require('./harness');
const driver = require('./characterization/driver');

/** Every note but templates and trash, as stored */
function storedNotes(page) {
  return page.evaluate(async () => (await Storage.getAllNotes(true)).map(note => ({
    id: note.id,
    name: note.name,
    folderId: note.folderId,
    pinned: Boolean(note.pinned),
    archived: Boolean(note.archived),
    dateStr: note.isDaily ? note.dateStr : null,
  })));
}

/**
 * Count the full reloads of the note lists from here on: the note list's reload, the one way
 * the page reads every list again, whoever asks for it (the sidebar, another tab's change,
 * Settings, Stats). None of these writes should need one.
 */
async function countReloads(page) {
  await page.evaluate(() => {
    window.__ntnReloads = 0;
    const list = app.noteList;
    const counted = Object.create(list, {
      reload: {
        value: (...args) => {
          window.__ntnReloads += 1;
          return list.reload(...args);
        },
      },
    });
    // The note list as each holder reads it. The sidebar's setter would subscribe it again.
    for (const holder of [app, app.tabController, app.settingsController, app.aiChatController, app.notesManager, app.analyticsController]) {
      holder.noteList = counted;
    }
    app.sidebarController._noteList = counted;
  });
}

const reloads = page => page.evaluate(() => window.__ntnReloads);
const lastOpened = page => page.evaluate(() => app.tabController.openTabs[app.tabController.activeTabIndex]?.noteId);
const sidebarItem = (page, name) => page.locator('#sidebar-notes-list .sidebar-note-item')
  .filter({ has: page.locator('.sidebar-note-name', { hasText: new RegExp(`^${name}$`) }) });

/** Wait until the active tab is a note other than `before` and the editor has settled on it */
async function openedAfter(page, before) {
  await expect.poll(() => lastOpened(page)).not.toBe(before);
  await driver.afterEditorFocus(page);
  return lastOpened(page);
}

/** Record each toast's text from here on, in window.__ntnToasts */
function recordToasts(page) {
  return page.evaluate(() => {
    const toasts = [];
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('toast')) toasts.push({ text: node.textContent });
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    window.__ntnToasts = toasts;
  });
}

async function startOn(extension, notes) {
  await extension.seedOnboarded();
  await driver.seedNotes(extension, notes);
  const page = await driver.openNewTab(extension);
  await driver.openNote(page, notes[0].name);
  await recordToasts(page);
  return page;
}

test('new notes from the sidebar, the header, the palette, and a folder show in the list with no reload', async ({ extension }) => {
  const page = await startOn(extension, [{ name: 'Alpha', blocks: [{ type: 'text', content: 'Alpha body' }] }]);
  // A folder made the 1.4.x way, then shown, before counting
  const folderId = await page.evaluate(async () => (await Storage.createFolder('Work')).id);
  await page.evaluate(() => app.sidebarController.reloadLists());
  await countReloads(page);

  let before = await lastOpened(page);
  await page.getByRole('button', { name: 'Create New Note' }).click();
  const fromSidebar = await openedAfter(page, before);

  before = fromSidebar;
  await page.locator('#new-tab-btn').click();
  const fromHeader = await openedAfter(page, before);

  before = fromHeader;
  await page.keyboard.press('ControlOrMeta+Shift+KeyA');
  await page.locator('#command-palette-input').fill('New Note');
  await page.locator('#command-palette-input').press('Enter');
  const fromPalette = await openedAfter(page, before);

  before = fromPalette;
  await page.locator('#sidebar-notes-list .sidebar-folder-header', { hasText: 'Work' }).click({ button: 'right' });
  await page.locator('.context-menu-item', { hasText: 'Add Note to Folder' }).click();
  const inFolder = await openedAfter(page, before);

  const notes = await storedNotes(page);
  const byId = Object.fromEntries(notes.map(note => [note.id, note]));
  expect([fromSidebar, fromHeader, fromPalette].map(id => byId[id]?.name)).toEqual(['Untitled', 'Untitled', 'Untitled']);
  expect(byId[inFolder]).toMatchObject({ name: 'New Note', folderId });
  expect(new Set([fromSidebar, fromHeader, fromPalette, inFolder]).size).toBe(4);
  await expect(page.locator('#sidebar-notes-list .sidebar-note-name', { hasText: /^Untitled$/ })).toHaveCount(3);
  await expect(page.locator('#sidebar-notes-list .sidebar-note-name', { hasText: /^New Note$/ })).toHaveCount(1);
  await expect(page.locator('#note-tabs .note-tab')).toHaveCount(5);
  expect(await reloads(page)).toBe(0);
  await expectNoUncaught(extension, page);
});

test("the calendar's Daily Note and today's, each clicked twice at once, make one note each, and open it", async ({ extension }) => {
  const page = await startOn(extension, [{ name: 'Alpha', blocks: [{ type: 'text', content: 'Alpha body' }] }]);
  await countReloads(page);
  const { local } = await page.evaluate(() => {
    const now = new Date();
    const pad = value => String(value).padStart(2, '0');
    return { local: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` };
  });
  const daily = async dateStr => (await storedNotes(page)).filter(note => note.dateStr === dateStr);

  let before = await lastOpened(page);
  await page.locator(`#calendar-days .calendar-day[data-date="${local}"]`).click({ clickCount: 2 });
  await expect.poll(async () => (await daily(local)).length).toBe(1);
  const fromCalendar = await openedAfter(page, before);
  expect((await daily(local))[0].id).toBe(fromCalendar);
  await expect(page.locator('#page-title')).toHaveText(/^Daily Note - /);

  before = fromCalendar;
  await page.getByRole('button', { name: "Today's Daily Note" }).click({ clickCount: 2 });
  // Today's is keyed by the local date since #17 PR 3b, as the calendar's day is, so it's the same note
  await expect.poll(async () => (await daily(local)).length).toBe(1);
  const today = (await daily(local))[0].id;
  expect(today).toBe(fromCalendar);
  expect(await lastOpened(page)).toBe(today);
  await expect(sidebarItem(page, (await storedNotes(page)).find(note => note.id === today).name)).toHaveCount(1);
  expect(await reloads(page)).toBe(0);
  await expectNoUncaught(extension, page);
});

test('a Markdown file and a single-note JSON export each import as one note, and open', async ({ extension }) => {
  const page = await startOn(extension, [{ name: 'Alpha', blocks: [{ type: 'text', content: 'Alpha body' }] }]);
  await countReloads(page);
  const importFile = async file => {
    const before = await lastOpened(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import Note' }).click();
    await (await chooser).setFiles(file);
    return openedAfter(page, before);
  };

  await importFile({ name: 'trip.md', mimeType: 'text/markdown', buffer: Buffer.from('# Trip plan\n\nPack the bags\n\n- tickets\n') });
  await expect(page.locator('#page-title')).toHaveText('Trip plan');
  await expect.poll(() => driver.blocks(page)).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Pack the bags' })]));

  const exported = {
    exportType: 'single-note',
    note: { id: 'exported-id', name: 'Exported plan' },
    blocks: [
      { id: 'x1', canvasId: 'exported-id', type: 'text', content: 'From the export', order: 0 },
      { id: 'x2', canvasId: 'exported-id', type: 'todo', content: 'Ship it', checked: true, order: 1 },
    ],
  };
  await importFile({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await expect(page.locator('#page-title')).toHaveText('Exported plan');
  await expect.poll(() => driver.blocks(page)).toEqual([
    { type: 'text', text: 'From the export' },
    { type: 'todo', text: 'Ship it', checked: true },
  ]);

  const names = (await storedNotes(page)).map(note => note.name).sort();
  expect(names).toEqual(['Alpha', 'Exported plan', 'Trip plan']);
  await expect(sidebarItem(page, 'Trip plan')).toHaveCount(1);
  await expect(sidebarItem(page, 'Exported plan')).toHaveCount(1);
  const toasts = await page.evaluate(() => window.__ntnToasts.map(toast => toast.text));
  expect(toasts.filter(text => text === 'Note imported')).toHaveLength(2);
  expect(await reloads(page)).toBe(0);
  await expectNoUncaught(extension, page);
});

test('an open note archives with what was typed in it, and comes back from the archive', async ({ extension }) => {
  const page = await startOn(extension, [
    { name: 'Alpha', blocks: [{ type: 'text', content: 'Alpha body' }] },
    { name: 'Beta', blocks: [{ type: 'text', content: 'Beta body' }] },
  ]);
  await driver.openNote(page, 'Alpha');
  await countReloads(page);
  await page.locator('#blocks-container > .block .block-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' typed before archiving');
  await driver.openNoteMenu(page, 'Alpha');
  await page.locator('#ctx-archive-note').click();

  const alphaId = await page.evaluate(async () => (await Storage.getAllNotes(true)).find(note => note.name === 'Alpha').id);
  await expect.poll(async () => (await storedNotes(page)).find(note => note.id === alphaId).archived).toBe(true);
  const kept = await page.evaluate(async id => (await Storage.getElementsByNote(id)).map(block => block.content), alphaId);
  expect(kept.join(' ')).toContain('typed before archiving');
  await expect(page.locator('#page-title')).not.toHaveText('Alpha');
  await expect(sidebarItem(page, 'Alpha')).toHaveCount(0);

  await page.locator('#sidebar-tab-archive').click();
  await expect(sidebarItem(page, 'Alpha')).toHaveCount(1);
  await sidebarItem(page, 'Alpha').click({ button: 'right' });
  await page.locator('#ctx-unarchive-note').click();
  await expect.poll(async () => (await storedNotes(page)).find(note => note.id === alphaId).archived).toBe(false);
  await expect(sidebarItem(page, 'Alpha')).toHaveCount(0);
  await driver.showNotes(page);
  await expect(sidebarItem(page, 'Alpha')).toHaveCount(1);
  const toasts = await page.evaluate(() => window.__ntnToasts.map(toast => toast.text));
  expect(toasts).toEqual(expect.arrayContaining(['Note archived', 'Note restored from archive']));
  await expectNoUncaught(extension, page);
});

/** Drop a block carrying `text` on the sidebar note named `name`, or on the list's empty space */
function dropBlock(page, { name = null, text }) {
  return page.evaluate(({ name, text }) => {
    const list = document.getElementById('sidebar-notes-list');
    const target = name
      ? [...list.querySelectorAll('.sidebar-note-item')].find(item => item.querySelector('.sidebar-note-name').textContent === name)
      : list;
    const data = new DataTransfer();
    data.setData('application/x-block-content', text);
    data.setData('application/x-block-type', 'text');
    data.setData('application/x-block-html', text);
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  }, { name, text });
}

test("a block dropped on a sidebar note goes after its last block, and one dropped on the list makes a note", async ({ extension }) => {
  const page = await startOn(extension, [
    { name: 'Alpha', blocks: [{ type: 'text', content: 'Alpha body' }] },
    { name: 'Beta', blocks: [{ type: 'text', content: 'Beta one' }, { type: 'text', content: 'Beta two' }] },
  ]);
  await driver.openNote(page, 'Alpha');
  await countReloads(page);
  const betaId = await page.evaluate(async () => (await Storage.getAllNotes(true)).find(note => note.name === 'Beta').id);
  await dropBlock(page, { name: 'Beta', text: 'Dropped on Beta' });
  await expect.poll(() => page.evaluate(() => window.__ntnToasts.map(toast => toast.text))).toContain('Block appended to note');
  const betaBlocks = await page.evaluate(async id => (await Storage.getElementsByNote(id))
    .sort((a, b) => a.order - b.order).map(block => block.content), betaId);
  expect(betaBlocks).toEqual(['Beta one', 'Beta two', 'Dropped on Beta']);
  // Beta reads as just changed, so it lists first
  await expect(page.locator('#sidebar-notes-list .sidebar-note-item .sidebar-note-name').first()).toHaveText('Beta');

  const before = await lastOpened(page);
  await dropBlock(page, { text: 'A brand new note' });
  await openedAfter(page, before);
  await expect(page.locator('#page-title')).toHaveText('A brand new note');
  await expect.poll(() => driver.blocks(page)).toEqual([{ type: 'text', text: 'A brand new note' }]);
  await expect(sidebarItem(page, 'A brand new note')).toHaveCount(1);
  expect(await reloads(page)).toBe(0);
  await expectNoUncaught(extension, page);
});

test("a dropped block keeps its markup only when this page's editor started the drag", async ({ extension }) => {
  const page = await startOn(extension, [
    { name: 'Alpha', blocks: [{ type: 'text', content: '<b>Bold</b> body' }] },
    { name: 'Beta', blocks: [{ type: 'text', content: 'Beta one' }] },
  ]);
  await driver.openNote(page, 'Alpha');
  const betaId = await page.evaluate(async () => (await Storage.getAllNotes(true)).find(note => note.name === 'Beta').id);
  const betaBlocks = () => page.evaluate(async id => (await Storage.getElementsByNote(id))
    .sort((a, b) => a.order - b.order).map(block => block.content), betaId);
  // The editor's own drag of its block, dropped on Beta while it lasts
  await page.evaluate(() => {
    const block = document.querySelector('#blocks-container > .block');
    const data = new DataTransfer();
    block.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
    const beta = [...document.querySelectorAll('#sidebar-notes-list .sidebar-note-item')]
      .find(item => item.querySelector('.sidebar-note-name').textContent === 'Beta');
    beta.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    block.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
  });
  await expect.poll(betaBlocks).toEqual(['Beta one', '<b>Bold</b> body']);
  // A drag from anywhere else
  await dropBlock(page, { name: 'Beta', text: '<b>Foreign</b> body' });
  await expect.poll(betaBlocks).toEqual(['Beta one', '<b>Bold</b> body', '&lt;b&gt;Foreign&lt;/b&gt; body']);

  await driver.openNote(page, 'Beta');
  const contents = page.locator('#blocks-container > .block .block-content');
  await expect(contents).toHaveCount(3);
  await expect(contents.nth(1).locator('b')).toHaveText('Bold');
  await expect(contents.nth(2)).toHaveText('<b>Foreign</b> body');
  await expect(contents.nth(2).locator('b')).toHaveCount(0);
  await expectNoUncaught(extension, page);
});

test('a pin made mid-typing survives the save, and the sidebar shows it pinned with no reload', async ({ extension }) => {
  const page = await startOn(extension, [
    { name: 'Alpha', blocks: [{ type: 'text', content: 'Alpha body' }] },
    { name: 'Beta', blocks: [{ type: 'text', content: 'Beta body' }] },
  ]);
  await driver.openNote(page, 'Beta');
  await countReloads(page);
  await page.locator('#blocks-container > .block .block-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' before the pin');
  // The save is still waiting on its debounce when the pin lands
  await sidebarItem(page, 'Beta').hover();
  await sidebarItem(page, 'Beta').locator('.sidebar-note-pin').click();
  await page.locator('#blocks-container > .block .block-content').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' and after');
  await page.evaluate(() => app.editor.flushSave());

  const betaId = await page.evaluate(() => app.editor.noteId);
  await expect.poll(async () => (await storedNotes(page)).find(note => note.id === betaId).pinned).toBe(true);
  const kept = await page.evaluate(async id => (await Storage.getElementsByNote(id)).map(block => block.content), betaId);
  expect(kept.join(' ')).toContain('before the pin and after');
  await expect(sidebarItem(page, 'Beta').locator('.sidebar-note-pin')).toHaveClass(/pinned/);
  await expect(page.locator('#sidebar-notes-list .sidebar-note-item .sidebar-note-name').first()).toHaveText('Beta');
  expect(await reloads(page)).toBe(0);
  await expectNoUncaught(extension, page);
});
