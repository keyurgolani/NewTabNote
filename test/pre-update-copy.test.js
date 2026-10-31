'use strict';

// #17 PR 1b (Q8): Settings > Data & Backup's "Copy From Before the Update"
// (js/ui/pre-update-copy.js) in each of its six states: waiting for space, available with the
// day the copy was made, exporting (aria-busy, the button aria-disabled but focusable),
// exported, damaged (the button stays disabled), and none. Each time Settings opens it reads
// its state again, so "Exported" never outlives it. Its markup is newtab.html's.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLegacyEnv, settle, FakeDocument } = require('./helpers/legacy-env');

const FILES = ['js/utils.js', 'js/ui/pre-update-copy.js'];
const MADE = Date.UTC(2026, 9, 31, 12);
const TEXT = {
  available: 'NewTabNote saved this copy of your notes on Oct 31, 2026, before it changed how they\'re stored. '
    + 'If you go back to NewTabNote 1.4.1, export it and import the file there. '
    + "It doesn't include notes or changes made since; Export JSON above does.",
  exporting: 'Checking the copy, then preparing the file…',
  done: 'Exported. Check that the file saved.',
  failed: "This copy is damaged, so NewTabNote didn't export it. Your current notes aren't affected; "
    + 'Export JSON above saves them as they are now.',
  none: 'This device has no copy from before the update. NewTabNote saves one only when an update changes '
    + 'how notes are stored and there are notes to copy. To save your notes now, use Export JSON above.',
  waiting: 'NewTabNote will save a copy here before it changes how your notes are stored. '
    + "It's waiting for enough free space on this device.",
};

/** The section as newtab.html has it */
function sectionMarkup(env) {
  const doc = env.document;
  const { 'pre-update-copy': section } = doc.stub([{ id: 'pre-update-copy' }]);
  section.className = 'settings-section pre-update-copy';
  const h3 = doc.createElement('h3');
  h3.textContent = 'Copy From Before the Update';
  const row = doc.createElement('div');
  row.className = 'setting-row pre-update-copy-row';
  row.hidden = true;
  const button = doc.createElement('button');
  button.id = 'export-pre-update-btn';
  button.className = 'secondary-btn pre-update-copy-btn';
  button.textContent = 'Export Pre-Update Copy';
  row.appendChild(button);
  const guidance = doc.createElement('p');
  guidance.className = 'setting-hint pre-update-copy-guidance';
  const status = doc.createElement('p');
  status.className = 'setting-hint pre-update-copy-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  for (const el of [h3, row, guidance, status]) section.appendChild(el);
  return { section, row, button, guidance, status };
}

/**
 * The section over a port: `point` is what find gives, `upgrade` the worker's record, and
 * `exports` what each export does in turn
 */
function setup({ point = { id: 'pre-migration-1', createdAt: MADE }, upgrade = { status: 'migrated' }, exports = [] } = {}) {
  const env = createLegacyEnv({ document: new FakeDocument(), worker: false });
  env.load(...FILES);
  const toasts = [];
  const downloads = [];
  env.get('Utils').showToast = (message, kind) => toasts.push({ message, kind });
  env.get('Utils').downloadFile = (data, filename) => downloads.push({ data, filename });
  const calls = { exports: 0, finds: 0 };
  const copy = {
    find: async () => {
      calls.finds++;
      return point;
    },
    export: (id) => {
      const next = exports[calls.exports++];
      return typeof next === 'function' ? next(id) : Promise.resolve(next || { version: 1, canvases: [], id });
    },
  };
  const els = sectionMarkup(env);
  const section = new (env.get('PreUpdateCopySection'))({ copy, readUpgrade: async () => upgrade });
  section.mount(els.section);
  return { env, section, els, toasts, downloads, calls };
}

const coded = (code) => Object.assign(new Error(code), { code });
const state = ({ section, row, button, guidance, status }) => ({
  state: section.getAttribute('data-state'),
  button: !row.hidden,
  disabled: button.getAttribute('aria-disabled') === 'true',
  busy: section.getAttribute('aria-busy') === 'true',
  guidance: guidance.textContent,
  status: status.textContent,
});

describe('Settings > Data & Backup: Copy From Before the Update', () => {
  it('available: the day the copy was made, and Export Pre-Update Copy', async () => {
    const { section, els } = setup();
    await section.refresh();
    assert.deepEqual(state(els), { state: 'available', button: true, disabled: false, busy: false, guidance: TEXT.available, status: '' });
  });

  it('waiting: while the upgrade waits for space, no button, and nothing read from the copy', async () => {
    const { section, els, calls } = setup({ point: null, upgrade: { status: 'space-blocked', code: 'space-short' } });
    await section.refresh();
    assert.deepEqual(state(els), { state: 'waiting', button: false, disabled: false, busy: false, guidance: TEXT.waiting, status: '' });
    assert.equal(calls.finds, 0);
  });

  it('none: no copy on this device, no button, a fresh install included', async () => {
    for (const upgrade of [{ status: 'migrated' }, undefined]) {
      const { section, els } = setup({ point: null, upgrade });
      await section.refresh();
      assert.deepEqual(state(els), { state: 'none', button: false, disabled: false, busy: false, guidance: TEXT.none, status: '' });
    }
  });

  it('exporting, then exported: busy and aria-disabled while it runs, a click meanwhile does nothing, then the file', async () => {
    let finish;
    const { section, els, toasts, downloads, calls } = setup({ exports: [() => new Promise((resolve) => { finish = resolve; })] });
    await section.refresh();
    els.button.click();
    await settle();
    assert.deepEqual(state(els), { state: 'exporting', button: true, disabled: true, busy: true, guidance: TEXT.available, status: TEXT.exporting });
    // The button is never `disabled`, so focus on it stays
    assert.equal(els.button.disabled, false);
    els.button.click();
    await settle();
    assert.equal(calls.exports, 1, 'a click while it exports does nothing');
    // Settings opening again meanwhile leaves the export as it is
    await section.refresh();
    assert.equal(state(els).state, 'exporting');

    finish({ version: 1, canvases: [{ id: 'n1' }], elements: [] });
    await settle();
    assert.deepEqual(state(els), { state: 'done', button: true, disabled: false, busy: false, guidance: TEXT.available, status: TEXT.done });
    assert.deepEqual(toasts, [{ message: 'Pre-update copy exported', kind: 'success' }]);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].filename, 'new-tab-note-pre-update-copy-2026-10-31.json');
    assert.deepEqual(JSON.parse(downloads[0].data).canvases, [{ id: 'n1' }]);
  });

  it('"Exported" clears when Settings opens again, and the copy can be exported again', async () => {
    const { section, els, downloads } = setup();
    await section.refresh();
    els.button.click();
    await settle();
    assert.equal(state(els).status, TEXT.done);
    await section.refresh();
    assert.deepEqual(state(els), { state: 'available', button: true, disabled: false, busy: false, guidance: TEXT.available, status: '' });
    els.button.click();
    await settle();
    assert.equal(downloads.length, 2);
  });

  it("damaged: a copy that doesn't verify isn't exported, says so, and its button stays disabled", async () => {
    const { section, els, toasts, downloads, calls } = setup({ exports: [() => Promise.reject(coded('recovery-point-unverified'))] });
    await section.refresh();
    els.button.click();
    await settle();
    assert.deepEqual(state(els), { state: 'failed', button: true, disabled: true, busy: false, guidance: TEXT.failed, status: '' });
    assert.deepEqual(toasts, [{ message: 'Pre-update copy not exported', kind: 'error' }]);
    assert.deepEqual(downloads, []);
    els.button.click();
    await settle();
    assert.equal(calls.exports, 1, 'a damaged copy is never tried again from here');
  });

  it('a copy gone since Settings opened shows none, and any other failure goes back to available', async () => {
    const gone = setup({ exports: [() => Promise.reject(coded('no-recovery-point'))] });
    await gone.section.refresh();
    gone.els.button.click();
    await settle();
    assert.equal(state(gone.els).state, 'none');

    const flaky = setup({ exports: [() => Promise.reject(new Error('the read failed'))] });
    await flaky.section.refresh();
    flaky.els.button.click();
    await settle();
    assert.deepEqual(state(flaky.els), { state: 'available', button: true, disabled: false, busy: false, guidance: TEXT.available, status: '' });
    assert.deepEqual(flaky.toasts, [{ message: 'Pre-update copy not exported', kind: 'error' }]);
  });

  it("newtab.html has the section after Export & Import, its status line a polite live region from the start", () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'newtab.html'), 'utf8');
    const exportImport = html.indexOf('<h3>Export &amp; Import</h3>');
    const section = html.indexOf('id="pre-update-copy"');
    const autoBackup = html.indexOf('<h3>Auto Backup</h3>');
    assert.ok(exportImport > 0 && exportImport < section && section < autoBackup);
    assert.match(html, /<p class="setting-hint pre-update-copy-status" role="status" aria-live="polite"><\/p>/);
    assert.match(html, /<button id="export-pre-update-btn" class="secondary-btn pre-update-copy-btn" type="button">Export Pre-Update Copy<\/button>/);
  });
});
