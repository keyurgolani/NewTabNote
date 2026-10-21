/**
 * The one-time notice that asks a profile with notes to export a copy before
 * the next update changes how notes are stored (#17's first schema change).
 *
 * It fills the #export-notice markup between the note's title and its blocks:
 * a region, not a dialog, so it takes no focus, covers nothing, and the editor
 * stays writable. Below the title, the title stays the first stop after the
 * header. Its heading and text go into a live region that's on the page from
 * the start, so they're announced; its buttons sit outside it.
 *
 * Export JSON downloads the file, and since the browser may still ask where to
 * save it or block it, the notice then asks to check that the file saved: Done
 * records `exported`, Export again downloads again. An Export JSON or Create
 * Backup from Settings, in any tab, moves a showing notice to that step too,
 * and a tab opened after one starts there. Not now records `dismissed`. A profile with nothing of its own to export when
 * this version first decides records `not-needed`. The record is
 * `setting_preMigrationNotice` ({version, outcome, at}) in
 * chrome.storage.local, and once it exists no tab shows the notice. Nothing
 * here changes a note.
 */

/** Storage.getSetting key of the recorded outcome */
const EXPORT_NOTICE_SETTING = 'preMigrationNotice';

/** Storage.getSetting key that Export JSON and Create Backup write once the browser has the file */
const EXPORT_RECEIPT_SETTING = 'lastFullExportAt';

/** This notice's version. A later notice bumps it, so a profile sees that one once too. */
const EXPORT_NOTICE_VERSION = 1;

/** Stores Export JSON reads besides the core ones, whose loss already shows #33's guard instead */
const EXPORT_AUX_STORES = ['media', 'folders'];

/** What Export JSON and Create Backup hold, said once for the notice and the Data & Backup hint */
const EXPORT_CONTENTS = {
  included: 'active and archived notes, templates, folders, and media',
  excluded: 'Not included: trash, themes, version history, AI chat history, and settings.',
  backlinks: 'Backlinks rebuild when each note is next saved.',
};

const EXPORT_NOTICE_TEXT = Object.freeze({
  title: 'Save a copy before the next update',
  body: 'The next NewTabNote update changes how notes are stored on this device. Exporting now gives you a copy to keep.',
  confirm: 'Check that the file saved, then choose Done.',
  contents: `Export JSON includes ${EXPORT_CONTENTS.included}. ${EXPORT_CONTENTS.excluded} ${EXPORT_CONTENTS.backlinks}`,
  // Not now is for good, so the notice says where exporting stays
  anyTime: 'You can export any time from Settings > Data & Backup.',
  hint: `Export JSON and Create Backup include ${EXPORT_CONTENTS.included}. ${EXPORT_CONTENTS.excluded} `
    + `The Markdown ZIP holds active notes only. ${EXPORT_CONTENTS.backlinks}`,
  export: 'Export JSON',
  exportAgain: 'Export again',
  done: 'Done',
  dismiss: 'Not now',
  recordFailed: "Couldn't save your choice. Try again.",
});

/**
 * @typedef {Object} ReturnFocus
 * @property {Element|null} element - What had focus before it moved into the notice
 * @property {Range|null} range - The selection then, to put the caret back
 */

class ExportNotice {
  /**
   * @param {Object} deps
   * @param {DatabaseManager} deps.storage
   * @param {() => Promise<boolean>} deps.onExport - Export JSON; resolves true once the browser has the file
   * @param {((returnFocus: ReturnFocus|null) => void)|null} [deps.onClose] - Runs when the notice
   *   closes while it holds focus, with where focus was before it moved into the notice
   */
  constructor({ storage, onExport, onClose = null }) {
    this.storage = storage;
    this.onExport = onExport;
    this.onClose = onClose;
    /** @type {HTMLElement|null} #export-notice, while the notice shows */
    this.card = null;
    /** @type {ReturnFocus|null} */
    this.returnFocus = null;
    /** @type {(() => void)|null} Stops listening to settings changes */
    this.unsubscribe = null;
    /** Whether a full export already happened (its receipt is there), so the notice starts at the check step */
    this.exportedEarlier = false;
    /** @param {FocusEvent} event */
    this.onFocusIn = (event) => this._noteReturnFocus(event);
  }

  /** The notice's text, which the Data & Backup hint uses too */
  static get TEXT() {
    return EXPORT_NOTICE_TEXT;
  }

  /**
   * Whether this new tab shows the notice: the database opened (#33's guard
   * stops startup before this), no store Export JSON reads is missing, and
   * nothing is recorded yet. A profile with no note that holds anything, an
   * untitled empty note counting as nothing, records `not-needed` instead, so
   * its own first notes never bring the notice. A failed read of the record
   * rejects. When it's due after a full export (only 1.4.1 writes the
   * receipt), it starts at the check step.
   * @returns {Promise<boolean>}
   */
  async isDue() {
    const storage = this.storage;
    if (storage.openState !== 'open') return false;
    if (EXPORT_AUX_STORES.some((store) => storage.missingStores.includes(store))) return false;
    if (ExportNotice.isRecorded(await storage.readSetting(EXPORT_NOTICE_SETTING))) return false;
    if (await this._holdsSomething()) {
      this.exportedEarlier = Boolean(await storage.getSetting(EXPORT_RECEIPT_SETTING, null));
      return true;
    }
    await this.record('not-needed');
    return false;
  }

  /**
   * Whether the profile has a note outside trash with a title or a block that
   * holds something, by the rule trash goes by (Storage.isNoteEmpty). Stops at
   * the first.
   * @returns {Promise<boolean>}
   */
  async _holdsSomething() {
    const storage = this.storage;
    const notes = [...(await storage.getAllNotes(true)), ...(await storage.getTemplates())];
    for (const note of notes) {
      if (!storage.isNoteUntitled(note)) return true;
      if (!(await storage.isNoteEmpty(note.id))) return true;
    }
    return false;
  }

  /**
   * @param {*} record - The stored setting
   * @returns {boolean} True when it records an outcome of this notice, or of a later one
   */
  static isRecorded(record) {
    return Boolean(record) && typeof record === 'object' && Number(record.version) >= EXPORT_NOTICE_VERSION;
  }

  /**
   * Record the outcome, under a Web Lock so tabs take turns. A recorded
   * outcome stands, except that `exported` replaces `dismissed`, so an export
   * that finishes after another tab's Not now still counts. When the read
   * fails it rejects and writes nothing over what may be there.
   * @param {'exported'|'dismissed'|'not-needed'} outcome
   * @returns {Promise<void>}
   */
  async record(outcome) {
    const write = async () => {
      const current = await this.storage.readSetting(EXPORT_NOTICE_SETTING);
      if (ExportNotice.isRecorded(current) && !(outcome === 'exported' && current.outcome === 'dismissed')) return;
      await this.storage.setSetting(EXPORT_NOTICE_SETTING, { version: EXPORT_NOTICE_VERSION, outcome, at: Date.now() });
    };
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks || typeof locks.request !== 'function') {
      await write();
      return;
    }
    await locks.request('ntn-pre-migration-notice', write);
  }

  /**
   * Fill `card`, the #export-notice markup, and show it, at the check step
   * when a full export already happened. Another tab recording an outcome
   * closes it here, and an export from Settings moves it to the check step.
   * @param {HTMLElement} card
   * @returns {void}
   */
  show(card) {
    if (this.card) return;
    this.card = card;
    const doc = card.ownerDocument;
    const text = /** @type {HTMLElement} */ (card.querySelector('.export-notice-text'));
    const title = doc.createElement('h2');
    title.id = 'export-notice-title';
    title.className = 'export-notice-title';
    title.textContent = EXPORT_NOTICE_TEXT.title;
    const body = doc.createElement('p');
    body.className = 'export-notice-body';
    body.textContent = EXPORT_NOTICE_TEXT.body;
    const contents = doc.createElement('p');
    contents.className = 'export-notice-contents';
    contents.textContent = EXPORT_NOTICE_TEXT.contents;
    const anyTime = doc.createElement('p');
    anyTime.className = 'export-notice-contents';
    anyTime.textContent = EXPORT_NOTICE_TEXT.anyTime;
    text.appendChild(title);
    text.appendChild(body);
    text.appendChild(contents);
    text.appendChild(anyTime);

    const actions = doc.createElement('div');
    actions.className = 'export-notice-actions';
    actions.appendChild(this._button(doc, EXPORT_NOTICE_TEXT.export, 'primary-btn', 'export', () => this._export()));
    actions.appendChild(this._button(doc, EXPORT_NOTICE_TEXT.dismiss, 'secondary-btn', 'dismiss', () => this._decide('dismissed')));
    card.appendChild(actions);
    if (this.exportedEarlier) this._askToConfirm();
    // Named by its heading, now that the heading is there
    card.setAttribute('aria-labelledby', 'export-notice-title');
    card.classList.add('is-shown');

    card.addEventListener('focusin', this.onFocusIn);
    this.unsubscribe = this.storage.onSettingsChange((changes) => {
      const recorded = changes[EXPORT_NOTICE_SETTING];
      if (recorded && ExportNotice.isRecorded(recorded.newValue)) this.close();
      else if (changes[EXPORT_RECEIPT_SETTING]) this._askToConfirm();
    });
  }

  /**
   * @param {Document} doc
   * @param {string} label
   * @param {string} style - The app's button class
   * @param {string} action - What the button does, as data-action
   * @param {() => Promise<void>} run
   * @returns {HTMLButtonElement}
   */
  _button(doc, label, style, action, run) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `${style} export-notice-btn`;
    button.dataset.action = action;
    button.textContent = label;
    button.addEventListener('click', () => this._run(run));
    return button;
  }

  /**
   * Run a choice with the notice marked busy (aria-busy), which is what makes
   * clicks meanwhile do nothing.
   * @param {() => Promise<void>} run
   * @returns {Promise<void>}
   */
  async _run(run) {
    const card = this.card;
    if (!card || card.getAttribute('aria-busy') === 'true') return;
    card.setAttribute('aria-busy', 'true');
    try {
      await run();
    } finally {
      card.removeAttribute('aria-busy');
    }
  }

  /**
   * Export JSON, or Export again. Once the browser has the file the notice
   * asks to check that it saved; a failed export's own toast says so.
   * @returns {Promise<void>}
   */
  async _export() {
    if (await this.onExport()) this._askToConfirm();
  }

  /**
   * Record a choice and close. A choice that fails to save keeps the notice
   * and says so.
   * @param {'exported'|'dismissed'} outcome
   * @returns {Promise<void>}
   */
  async _decide(outcome) {
    try {
      await this.record(outcome);
      this.close();
    } catch (error) {
      console.error('Export notice: the choice was not saved', error);
      Utils.showToast(EXPORT_NOTICE_TEXT.recordFailed, 'error');
    }
  }

  /**
   * The step after an export: check that the file saved, then Done. Export JSON
   * becomes Export again in place, so focus on it stays there.
   * @returns {void}
   */
  _askToConfirm() {
    const card = this.card;
    if (!card || card.querySelector('[data-action="done"]')) return;
    /** @type {HTMLElement} */ (card.querySelector('.export-notice-body')).textContent = EXPORT_NOTICE_TEXT.confirm;
    const exportButton = /** @type {HTMLElement} */ (card.querySelector('[data-action="export"]'));
    exportButton.textContent = EXPORT_NOTICE_TEXT.exportAgain;
    exportButton.className = 'secondary-btn export-notice-btn';
    const done = this._button(card.ownerDocument, EXPORT_NOTICE_TEXT.done, 'primary-btn', 'done', () => this._decide('exported'));
    /** @type {HTMLElement} */ (exportButton.parentNode).insertBefore(done, exportButton);
  }

  /**
   * Where focus was before it first moved into the notice.
   * @param {FocusEvent} event
   * @returns {void}
   */
  _noteReturnFocus(event) {
    const card = /** @type {HTMLElement} */ (this.card);
    const from = /** @type {Element|null} */ (event.relatedTarget);
    if (from && card.contains(from)) return;
    const selection = card.ownerDocument.getSelection();
    this.returnFocus = {
      element: from,
      range: selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null,
    };
  }

  /**
   * Take the notice off the page and stop listening. When it held focus,
   * onClose puts focus back where it was.
   * @returns {void}
   */
  close() {
    const card = this.card;
    if (!card) return;
    this.card = null;
    /** @type {() => void} */ (this.unsubscribe)();
    this.unsubscribe = null;
    card.removeEventListener('focusin', this.onFocusIn);
    const heldFocus = card.contains(card.ownerDocument.activeElement);
    card.classList.remove('is-shown');
    card.removeAttribute('aria-labelledby');
    /** @type {HTMLElement} */ (card.querySelector('.export-notice-text')).textContent = '';
    /** @type {HTMLElement} */ (card.querySelector('.export-notice-actions')).remove();
    if (heldFocus && this.onClose) this.onClose(this.returnFocus);
  }
}

if (typeof window !== 'undefined') {
  /** @type {any} */ (window).ExportNotice = ExportNotice;
}
