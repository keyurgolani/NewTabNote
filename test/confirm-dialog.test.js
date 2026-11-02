'use strict';

// choiceDialog, and confirmDialog's initialFocus and doc, driven through a minimal DOM.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, FakeDocument } = require('./helpers/legacy-env');

function openOverlay(env) {
  return env.document.querySelector('.confirm-dialog-overlay');
}

function buttons(env) {
  return openOverlay(env).querySelectorAll('button');
}

describe('choiceDialog', () => {
  let env;
  let choiceDialog;
  const options = {
    title: 'Import backup',
    message: 'This backup has 2 notes.',
    choices: [
      { id: 'merge', label: 'Merge', variant: 'primary' },
      { id: 'replace', label: 'Replace all' },
      { id: 'cancel', label: 'Cancel' },
    ],
    cancelId: 'cancel',
  };

  beforeEach(() => {
    env = createLegacyEnv();
    env.load('js/ui/confirm-dialog.js');
    choiceDialog = env.get('choiceDialog');
  });

  it('is a labelled modal dialog with focus on the first choice', () => {
    choiceDialog(options);
    const overlay = openOverlay(env);
    assert.equal(overlay.getAttribute('role'), 'dialog');
    assert.equal(overlay.getAttribute('aria-modal'), 'true');
    assert.equal(overlay.getAttribute('aria-label'), 'Import backup');
    assert.deepEqual(buttons(env).map((b) => b.textContent), ['Merge', 'Replace all', 'Cancel']);
    assert.ok(buttons(env).every((b) => b.tagName === 'BUTTON' && b.type === 'button'), 'native text buttons');
    assert.equal(env.document.activeElement.textContent, 'Merge');
  });

  for (const [how, dismiss] of [
    ['Escape', (overlay) => overlay.dispatchEvent({ type: 'keydown', key: 'Escape' })],
    ['a backdrop click', (overlay) => overlay.dispatchEvent({ type: 'mousedown', target: overlay })],
    ['Cancel', (overlay) => overlay.querySelector('[data-choice="cancel"]').click()],
  ]) {
    it(`resolves cancelId on ${how} and removes itself`, async () => {
      const result = choiceDialog(options);
      dismiss(openOverlay(env));
      assert.equal(await result, 'cancel');
      assert.ok(openOverlay(env) === null, 'the dialog is gone');
    });
  }

  it('a click inside the dialog is not a backdrop click', async () => {
    const result = choiceDialog(options);
    const overlay = openOverlay(env);
    overlay.dispatchEvent({ type: 'mousedown', target: overlay.querySelector('.confirm-dialog') });
    assert.ok(openOverlay(env) !== null, 'the dialog stays open');
    overlay.querySelector('[data-choice="merge"]').click();
    assert.equal(await result, 'merge');
  });

  it('Tab cycles focus and Enter activates the focused choice', async () => {
    const result = choiceDialog(options);
    const overlay = openOverlay(env);
    overlay.dispatchEvent({ type: 'keydown', key: 'Tab' });
    assert.equal(env.document.activeElement.textContent, 'Replace all');
    overlay.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true });
    overlay.dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true });
    assert.equal(env.document.activeElement.textContent, 'Cancel', 'wraps around');
    overlay.dispatchEvent({ type: 'keydown', key: 'Tab' });
    overlay.dispatchEvent({ type: 'keydown', key: 'Tab' });
    overlay.dispatchEvent({ type: 'keydown', key: 'Enter' });
    assert.equal(await result, 'replace');
  });

  it('dialog buttons are at least 44 by 44 px', () => {
    const css = env.document.getElementById('confirm-dialog-styles').textContent;
    const rule = css.slice(css.indexOf('.confirm-dialog-btn {'), css.indexOf('}', css.indexOf('.confirm-dialog-btn {')));
    assert.match(rule, /min-width: 44px/);
    assert.match(rule, /min-height: 44px/);
  });
});

describe('confirmDialog initialFocus', () => {
  let env;
  let confirmDialog;

  beforeEach(() => {
    env = createLegacyEnv();
    env.load('js/ui/confirm-dialog.js');
    confirmDialog = env.get('confirmDialog');
  });

  it('keeps focus on the confirm button by default', async () => {
    const result = confirmDialog({ title: 'Trash Note', message: 'Move this note to trash?' });
    assert.equal(env.document.activeElement.textContent, 'Confirm');
    openOverlay(env).dispatchEvent({ type: 'keydown', key: 'Enter' });
    assert.equal(await result, true);
  });

  it("initialFocus: 'cancel' focuses Cancel, so Enter cancels", async () => {
    const result = confirmDialog({ title: 'Replace all notes?', message: 'x', danger: true, initialFocus: 'cancel' });
    assert.equal(env.document.activeElement.textContent, 'Cancel');
    assert.ok(openOverlay(env).querySelector('.confirm-dialog-danger'), 'danger-styled confirm button');
    openOverlay(env).dispatchEvent({ type: 'keydown', key: 'Enter' });
    assert.equal(await result, false);
  });
});

describe('confirmDialog doc', () => {
  it('opens in the document it is given, as a pop-out editor gives its own window, and leaves the page alone (#14 slice 3)', async () => {
    const env = createLegacyEnv();
    env.load('js/ui/confirm-dialog.js');
    const confirmDialog = env.get('confirmDialog');
    const pip = new FakeDocument();
    const result = confirmDialog({ title: 'Turn into Text?', message: 'x', initialFocus: 'cancel', doc: pip });
    assert.ok(env.document.querySelector('.confirm-dialog-overlay') === null, 'not on the page');
    const overlay = pip.querySelector('.confirm-dialog-overlay');
    assert.ok(overlay !== null, 'in the pop-out');
    assert.equal(pip.activeElement.textContent, 'Cancel');
    overlay.dispatchEvent({ type: 'keydown', key: 'Enter' });
    assert.equal(await result, false, 'Enter on the pop-out\'s focused Cancel cancels');
    assert.ok(pip.querySelector('.confirm-dialog-overlay') === null, 'gone once answered');
  });
});
