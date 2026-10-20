/**
 * The one-time notice that asks a profile with notes to export a copy before
 * the next update changes how notes are stored (#17's first schema change).
 *
 * It's a region at the top of the writing column, not a dialog: it takes no
 * focus and covers nothing, so the editor stays writable, and its buttons come
 * before the note in the tab order. Export JSON runs Settings > Data & Backup >
 * Export JSON. Either button records the outcome once, as
 * `setting_preMigrationNotice` ({version, outcome, at}) in chrome.storage.local,
 * and no tab shows the notice again. Neither changes a note.
 */

/** Storage.getSetting key of the recorded outcome */
const EXPORT_NOTICE_SETTING = 'preMigrationNotice';

/** This notice's version. A later notice bumps it, so a profile sees that one once too. */
const EXPORT_NOTICE_VERSION = 1;

/** The notice's text. `contents` matches the Data & Backup hint in newtab.html. */
const EXPORT_NOTICE_TEXT = {
  title: 'Save a copy before the next update',
  body: 'The next NewTabNote update changes how notes are stored on this device. Exporting now gives you a copy to keep.',
  contents: 'Export JSON includes active and archived notes, templates, folders, and media. '
    + 'Not included: trash, themes, version history, AI chat history, and settings.',
  export: 'Export JSON',
  dismiss: 'Not now',
  recordFailed: "Couldn't save your choice. Try again.",
};

class ExportNotice {
  /**
   * @param {Object} deps
   * @param {DatabaseManager} deps.storage
   * @param {() => Promise<boolean>} deps.onExport - Runs Export JSON; resolves true once the file is handed to the browser
   * @param {(() => void)|null} [deps.onClose] - Runs when the notice leaves the page while it holds focus
   */
  constructor({ storage, onExport, onClose = null }) {
    this.storage = storage;
    this.onExport = onExport;
    this.onClose = onClose;
    /** @type {HTMLElement|null} The region, while it's on the page */
    this.element = null;
    /** True while a choice is being carried out */
    this.busy = false;
  }

  /**
   * Whether a new tab shows the notice: the notes database opened with every
   * store (not #33's guard or degraded states), the profile had a note outside
   * trash when the tab started, the tab didn't run onboarding, and no outcome
   * is recorded yet.
   * @param {DatabaseManager} storage
   * @param {{hadNotes: boolean, ranOnboarding: boolean}} startup
   * @returns {Promise<boolean>}
   */
  static async isDue(storage, { hadNotes, ranOnboarding }) {
    if (storage.openState !== 'open' || storage.missingStores.length > 0) return false;
    if (!hadNotes || ranOnboarding) return false;
    return !ExportNotice.isRecorded(await storage.getSetting(EXPORT_NOTICE_SETTING, null));
  }

  /**
   * @param {*} record - The stored setting
   * @returns {boolean} True when it records an outcome of this notice, or of a later one
   */
  static isRecorded(record) {
    return Boolean(record) && typeof record === 'object' && Number(record.version) >= EXPORT_NOTICE_VERSION;
  }

  /**
   * Record the outcome, unless one is recorded already: when two tabs show the
   * notice, the first choice stands.
   * @param {DatabaseManager} storage
   * @param {'exported'|'dismissed'} outcome
   * @returns {Promise<boolean>} True when this call wrote the record
   */
  static async record(storage, outcome) {
    if (ExportNotice.isRecorded(await storage.getSetting(EXPORT_NOTICE_SETTING, null))) return false;
    await storage.setSetting(EXPORT_NOTICE_SETTING, { version: EXPORT_NOTICE_VERSION, outcome, at: Date.now() });
    return true;
  }

  /**
   * Put the notice at the top of `column`, the writing column (#editor). The
   * region goes in empty and is filled a moment later, since screen readers
   * don't announce a live region that arrives with its content. Another tab
   * recording an outcome takes it away here too.
   * @param {HTMLElement} column
   * @returns {void}
   */
  show(column) {
    if (this.element) return;
    const region = column.ownerDocument.createElement('section');
    region.className = 'export-notice';
    region.setAttribute('aria-labelledby', 'export-notice-title');
    region.setAttribute('aria-live', 'polite');
    column.insertBefore(region, column.firstChild);
    this.element = region;
    setTimeout(() => this._fill(region), 0);

    this.storage.onSettingsChange((changes) => {
      const change = changes[EXPORT_NOTICE_SETTING];
      if (change && ExportNotice.isRecorded(change.newValue)) this._close();
    });
  }

  /**
   * @param {HTMLElement} region
   * @returns {void}
   */
  _fill(region) {
    if (this.element !== region) return;
    const doc = region.ownerDocument;
    const card = doc.createElement('div');
    card.className = 'export-notice-card';

    const text = doc.createElement('div');
    text.className = 'export-notice-text';
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
    text.appendChild(title);
    text.appendChild(body);
    text.appendChild(contents);

    const actions = doc.createElement('div');
    actions.className = 'export-notice-actions';
    actions.appendChild(this._button(doc, EXPORT_NOTICE_TEXT.export, 'primary-btn', 'exported'));
    actions.appendChild(this._button(doc, EXPORT_NOTICE_TEXT.dismiss, 'secondary-btn', 'dismissed'));

    card.appendChild(text);
    card.appendChild(actions);
    region.appendChild(card);
  }

  /**
   * @param {Document} doc
   * @param {string} label
   * @param {string} style - The app's button class
   * @param {'exported'|'dismissed'} outcome
   * @returns {HTMLButtonElement}
   */
  _button(doc, label, style, outcome) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `${style} export-notice-btn`;
    button.textContent = label;
    button.addEventListener('click', () => this._choose(outcome));
    return button;
  }

  /**
   * Carry out a choice. Export JSON records `exported` only once the file is
   * handed to the browser; when the export fails, its own toast says so and
   * the notice stays. A record that fails to save keeps the notice too.
   * @param {'exported'|'dismissed'} outcome
   * @returns {Promise<void>}
   */
  async _choose(outcome) {
    if (this.busy || !this.element) return;
    this._setBusy(true);
    try {
      if (outcome === 'exported' && !(await this.onExport())) return;
      await ExportNotice.record(this.storage, outcome);
      this._close();
    } catch (error) {
      console.error('Export notice: the choice was not saved', error);
      Utils.showToast(EXPORT_NOTICE_TEXT.recordFailed, 'error');
    } finally {
      this._setBusy(false);
    }
  }

  /**
   * Ignore clicks while a choice runs. aria-disabled rather than disabled, so a
   * keyboard user's focus stays on the button.
   * @param {boolean} busy
   * @returns {void}
   */
  _setBusy(busy) {
    this.busy = busy;
    if (!this.element) return;
    this.element.querySelectorAll('.export-notice-btn').forEach((button) => {
      if (busy) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    });
  }

  /**
   * Take the notice off the page. When it held focus, onClose puts focus back
   * in the note.
   * @returns {void}
   */
  _close() {
    const region = this.element;
    if (!region) return;
    this.element = null;
    let node = region.ownerDocument.activeElement;
    while (node && node !== region) node = /** @type {Element|null} */ (node.parentNode);
    region.remove();
    if (node === region && this.onClose) this.onClose();
  }
}

if (typeof window !== 'undefined') {
  /** @type {any} */ (window).ExportNotice = ExportNotice;
}
