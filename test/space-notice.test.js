'use strict';

// #17 PR 1b (Q9): the space-blocked variant of #47's notice, in the same #export-notice region
// and form. It's due while the worker's last run stopped short of space, unless Not now or
// Done put it off in the last 7 days; Export JSON leads to #47's check step, without the
// Export JSON sentence; it closes once the worker records another outcome, or another tab
// puts it off. And #47's own notice never shows on a database the update has upgraded.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, createDatabase, workerRun, settle, note, block, FakeDocument } = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/core/storage-error.js', 'js/storage.js', 'js/ui/export-notice.js'];
const UPGRADE = 'setting_storageUpgrade';
const SNOOZED = 'setting_spaceNoticeSnoozedAt';
const DAY = 24 * 60 * 60 * 1000;

const TEXT = {
  title: 'The update is waiting for free space',
  body: "Before NewTabNote changes how your notes are stored, it saves a copy of them. This device doesn't "
    + 'have enough free space for that copy yet, so nothing has changed: your notes are stored as they were.',
  contents: 'Free up some space on this device and NewTabNote will try again on its own. '
    + 'Export JSON saves a copy of your notes now.',
  confirmContents: 'Free up some space on this device and NewTabNote will try again on its own.',
  confirm: 'Check that the file saved, then choose Done.',
};

/** A version-8 profile with a note, its upgrade recorded as `status` */
async function setup({ status = 'space-blocked', snoozedAt, upgraded = false } = {}) {
  const env = createLegacyEnv({ document: new FakeDocument(), worker: false });
  if (upgraded) await workerRun(env.indexedDB);
  else await createDatabase(env.indexedDB, { records: { canvases: [note('A', { name: 'Groceries' })], elements: [block('a1', 'A', 0, 'eggs')] } });
  if (status) env.chrome.local[UPGRADE] = { status, code: status === 'space-blocked' ? 'space-short' : null, at: Date.now() };
  if (snoozedAt !== undefined) env.chrome.local[SNOOZED] = snoozedAt;
  env.load(...FILES);
  const Storage = env.get('Storage');
  await Storage.init();
  const toasts = [];
  env.get('Utils').showToast = (message, kind) => toasts.push({ message, kind });
  return { env, Storage, toasts };
}

/** A space notice as App makes it, over `Storage` */
function spaceNotice(env, Storage, { exports = [true] } = {}) {
  const calls = { exports: 0 };
  return new (env.get('SpaceNotice'))({
    storage: Storage,
    onExport: async () => exports[calls.exports++],
    settings: {
      read: (key) => Storage.readSetting(key),
      snooze: () => Storage.setSetting('spaceNoticeSnoozedAt', Date.now()),
      upgraded: () => Storage.isUpgraded(),
    },
  });
}

/** #export-notice as newtab.html has it */
function noticeMarkup(env) {
  const { editor } = env.document.stub([{ id: 'editor' }]);
  const card = env.document.createElement('section');
  card.id = 'export-notice';
  card.className = 'export-notice';
  const text = env.document.createElement('div');
  text.className = 'export-notice-text';
  text.setAttribute('aria-live', 'polite');
  card.appendChild(text);
  editor.appendChild(card);
  return card;
}

const texts = (card) => [...card.querySelector('.export-notice-text').children].map((el) => el.textContent);
const buttons = (card) => card.querySelectorAll('.export-notice-btn').map((b) => [b.textContent, b.className.split(' ')[0]]);
const button = (card, label) => card.querySelectorAll('.export-notice-btn').find((b) => b.textContent === label);
const shown = (card) => card.classList.contains('is-shown');
const fire = (env, changes) => env.chrome.api.storage.onChanged.listeners.slice().forEach((listener) => listener(changes, 'local'));

describe('SpaceNotice.isDue', () => {
  it('is due while the upgrade waits for space, and not otherwise', async () => {
    for (const [status, due] of [['space-blocked', true], ['migrated', false], ['failed', false], [null, false]]) {
      const { env, Storage } = await setup({ status });
      assert.equal(await spaceNotice(env, Storage).isDue(), due, String(status));
    }
  });

  it('Not now or Done puts it off for 7 days, and after that it shows again', async () => {
    const recent = await setup({ snoozedAt: Date.now() - 6 * DAY });
    assert.equal(await spaceNotice(recent.env, recent.Storage).isDue(), false);
    const old = await setup({ snoozedAt: Date.now() - 8 * DAY });
    assert.equal(await spaceNotice(old.env, old.Storage).isDue(), true);
  });
});

describe('the space notice', () => {
  it("shows in #47's region and form, with Export JSON and Not now", async () => {
    const { env, Storage } = await setup();
    const card = noticeMarkup(env);
    spaceNotice(env, Storage).show(card);
    assert.equal(shown(card), true);
    assert.equal(card.getAttribute('data-notice'), 'space-blocked');
    assert.equal(card.getAttribute('aria-labelledby'), 'export-notice-title');
    assert.deepEqual(texts(card), [TEXT.title, TEXT.body, TEXT.contents]);
    assert.deepEqual(buttons(card), [['Export JSON', 'primary-btn'], ['Not now', 'secondary-btn']]);
  });

  it('Export JSON leads to the check step without the Export JSON sentence, and Done puts it off', async () => {
    const { env, Storage } = await setup();
    const card = noticeMarkup(env);
    spaceNotice(env, Storage).show(card);
    button(card, 'Export JSON').click();
    await settle();
    assert.deepEqual(texts(card), [TEXT.title, TEXT.confirm, TEXT.confirmContents]);
    assert.deepEqual(buttons(card), [['Done', 'primary-btn'], ['Export again', 'secondary-btn'], ['Not now', 'secondary-btn']]);
    button(card, 'Done').click();
    await settle();
    assert.equal(shown(card), false);
    assert.equal(typeof env.chrome.local[SNOOZED], 'number');
    assert.equal(env.chrome.local.setting_preMigrationNotice, undefined, "#47's record stays its own");
  });

  it('Not now puts it off, and a failed save of that keeps it and says so', async () => {
    const { env, Storage, toasts } = await setup();
    const card = noticeMarkup(env);
    spaceNotice(env, Storage).show(card);
    env.chrome.failNextSet();
    button(card, 'Not now').click();
    await settle();
    assert.equal(shown(card), true);
    assert.deepEqual(toasts, [{ message: "Couldn't save your choice. Try again.", kind: 'error' }]);
    button(card, 'Not now').click();
    await settle();
    assert.equal(shown(card), false);
    assert.equal(typeof env.chrome.local[SNOOZED], 'number');
  });

  it('closes once the worker records another outcome, or another tab puts it off', async () => {
    const first = await setup();
    const card = noticeMarkup(first.env);
    spaceNotice(first.env, first.Storage).show(card);
    first.env.chrome.local[UPGRADE] = { status: 'migrated', code: null, at: Date.now() };
    fire(first.env, { [UPGRADE]: { newValue: first.env.chrome.local[UPGRADE] } });
    await settle();
    assert.equal(shown(card), false);

    const second = await setup();
    const other = noticeMarkup(second.env);
    spaceNotice(second.env, second.Storage).show(other);
    fire(second.env, { [SNOOZED]: { newValue: Date.now() } });
    await settle();
    assert.equal(shown(other), false);
  });
});

describe('a space-blocked record the worker could not replace (review R79)', () => {
  it('says nothing once the database is at 9: the notice is not due', async () => {
    const { env, Storage } = await setup({ status: 'space-blocked', upgraded: true });
    assert.equal(Storage.isUpgraded(), true);
    assert.equal(await spaceNotice(env, Storage).isDue(), false);
  });
});

describe("#47's notice after the upgrade", () => {
  it('is never due on a database the worker has upgraded to 9, and records nothing', async () => {
    const { env, Storage } = await setup({ status: 'migrated', upgraded: true });
    await Storage.createNote('Holds something');
    assert.equal(Storage.isUpgraded(), true);
    const notice = new (env.get('ExportNotice'))({ storage: Storage, onExport: async () => true });
    assert.equal(await notice.isDue(), false);
    assert.equal(env.chrome.local.setting_preMigrationNotice, undefined);
  });
});
