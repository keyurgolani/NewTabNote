/**
 * Settings > Data & Backup's "Copy From Before the Update" (#17 PR 1b, Q8): the one action
 * that exports the pinned pre-migration recovery point the service worker made before it
 * changed how notes are stored, as the file NewTabNote 1.4.1's Import reads. It fills the
 * #pre-update-copy section, which is always on the page, and reads its state again each time
 * Settings opens, so a finished export's "Exported" never outlives it:
 * - waiting: the worker's last run stopped short of space, so there's no copy yet. No button.
 * - available: a verified copy, with the day it was made, and Export Pre-Update Copy.
 * - exporting: the copy is being checked and the file prepared. The button stays focusable,
 *   marked aria-disabled, and the section aria-busy, as #47's notice marks itself busy.
 * - done: the browser has the file. The status line asks to check that it saved.
 * - failed: the copy didn't verify, so nothing was exported. The button stays disabled, since
 *   a damaged copy doesn't mend.
 * - none: no copy on this device. No button.
 * The guidance line and the status line, a polite live region, take the status color, which
 * meets 4.5:1 where the settings hint doesn't (#24 and #16 own that token). Nothing here
 * writes to the notes database or the copy.
 */

/** chrome.storage.local key, through Storage.readSetting, of the worker's recorded run */
const PRE_UPDATE_UPGRADE_SETTING = 'storageUpgrade';

const PRE_UPDATE_COPY_TEXT = Object.freeze({
  /** @param {string} date */
  available: date =>
    `NewTabNote saved this copy of your notes on ${date}, before it changed how they're stored. `
    + 'If you go back to NewTabNote 1.4.1, export it and import the file there. '
    + "It doesn't include notes or changes made since; Export JSON above does.",
  exporting: 'Checking the copy, then preparing the file…',
  done: 'Exported. Check that the file saved.',
  doneToast: 'Pre-update copy exported',
  failed: "This copy is damaged, so NewTabNote didn't export it. Your current notes aren't affected; "
    + 'Export JSON above saves them as they are now.',
  failedToast: 'Pre-update copy not exported',
  none: 'This device has no copy from before the update. NewTabNote saves one only when an update changes '
    + 'how notes are stored and there are notes to copy. To save your notes now, use Export JSON above.',
  waiting: 'NewTabNote will save a copy here before it changes how your notes are stored. '
    + "It's waiting for enough free space on this device.",
});

/**
 * What the new tab's composition root hands over for the copy (js/kernel/composition/newtab.js)
 * @typedef {object} PreUpdateCopyPort
 * @property {() => Promise<{id: string, createdAt: number} | null>} find - the copy to export, or none
 * @property {(id: string) => Promise<object>} export
 *   The copy as 1.4.1's import file. Rejects with code `recovery-point-unverified` when it
 *   doesn't verify, and `no-recovery-point` when it's gone.
 */

/** @typedef {'waiting'|'available'|'exporting'|'done'|'failed'|'none'} PreUpdateCopyState */

class PreUpdateCopySection {
  /**
   * @param {Object} deps
   * @param {DatabaseManager} deps.storage - for the worker's recorded run
   * @param {PreUpdateCopyPort} deps.copy
   */
  constructor({ storage, copy }) {
    this.storage = storage;
    this.copy = copy;
    /** @type {HTMLElement|null} */
    this.section = null;
    /** @type {PreUpdateCopyState} */
    this.state = 'none';
    /** @type {{id: string, createdAt: number}|null} */
    this.point = null;
    /** Counts reads, so a refresh that finishes after a newer one changes nothing */
    this.reads = 0;
  }

  /** The section's words, which tests and the mockup read */
  static get TEXT() {
    return PRE_UPDATE_COPY_TEXT;
  }

  /**
   * The day a copy was made, as the note's own timestamps show a date
   * @param {number} at
   * @returns {string}
   */
  static dateOf(at) {
    return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /**
   * Take over `section`, the #pre-update-copy markup, and wire its button
   * @param {HTMLElement} section
   * @returns {void}
   */
  mount(section) {
    this.section = section;
    this._button().addEventListener('click', () => {
      this.exportCopy().catch((error) => console.error('Pre-update copy: export failed', error));
    });
  }

  /** @returns {HTMLButtonElement} */
  _button() {
    return /** @type {HTMLButtonElement} */ (/** @type {HTMLElement} */ (this.section).querySelector('.pre-update-copy-btn'));
  }

  /**
   * Read the state again, as Settings opens: what was exported before is no longer said. An
   * export running now keeps its state.
   * @returns {Promise<void>}
   */
  async refresh() {
    if (!this.section || this.state === 'exporting') return;
    const read = ++this.reads;
    /** @type {PreUpdateCopyState} */
    let state = 'none';
    /** @type {{id: string, createdAt: number}|null} */
    let point = null;
    try {
      const record = await this.storage.readSetting(PRE_UPDATE_UPGRADE_SETTING);
      if (record && typeof record === 'object' && record.status === 'space-blocked') {
        state = 'waiting';
      } else {
        point = await this.copy.find();
        state = point ? 'available' : 'none';
      }
    } catch (error) {
      console.warn('Pre-update copy: could not read whether there is one', error);
    }
    if (read !== this.reads || this.state === 'exporting') return;
    this.point = point;
    this.show(state);
  }

  /**
   * Show `state`
   * @param {PreUpdateCopyState} state
   * @returns {void}
   */
  show(state) {
    const section = this.section;
    if (!section) return;
    this.state = state;
    const text = PRE_UPDATE_COPY_TEXT;
    const guidance = /** @type {HTMLElement} */ (section.querySelector('.pre-update-copy-guidance'));
    const status = /** @type {HTMLElement} */ (section.querySelector('.pre-update-copy-status'));
    const row = /** @type {HTMLElement} */ (section.querySelector('.pre-update-copy-row'));
    const button = this._button();
    const withButton = state !== 'waiting' && state !== 'none';
    row.hidden = !withButton;
    section.dataset.state = state;
    if (state === 'exporting') section.setAttribute('aria-busy', 'true');
    else section.removeAttribute('aria-busy');
    if (state === 'exporting' || state === 'failed') button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');

    if (state === 'waiting') guidance.textContent = text.waiting;
    else if (state === 'none') guidance.textContent = text.none;
    else if (state === 'failed') guidance.textContent = text.failed;
    else guidance.textContent = text.available(PreUpdateCopySection.dateOf(/** @type {{createdAt: number}} */ (this.point).createdAt));

    if (state === 'exporting') status.textContent = text.exporting;
    else if (state === 'done') status.textContent = text.done;
    else status.textContent = '';
  }

  /**
   * Export Pre-Update Copy: check the copy, prepare the file, and hand it to the browser.
   * Clicks while it runs, or on a damaged copy, do nothing.
   * @returns {Promise<void>}
   */
  async exportCopy() {
    if (!this.point || (this.state !== 'available' && this.state !== 'done')) return;
    const point = this.point;
    this.show('exporting');
    let data;
    try {
      data = await this.copy.export(point.id);
    } catch (error) {
      const code = error && error.code;
      console.error('Pre-update copy: not exported', code || error);
      Utils.showToast(PRE_UPDATE_COPY_TEXT.failedToast, 'error');
      if (code === 'recovery-point-unverified') this.show('failed');
      else if (code === 'no-recovery-point') this.show('none');
      else this.show('available');
      return;
    }
    const day = new Date(point.createdAt).toISOString().slice(0, 10);
    Utils.downloadFile(JSON.stringify(data, null, 2), `new-tab-note-pre-update-copy-${day}.json`);
    Utils.showToast(PRE_UPDATE_COPY_TEXT.doneToast, 'success');
    this.show('done');
  }
}

if (typeof window !== 'undefined') {
  /** @type {any} */ (window).PreUpdateCopySection = PreUpdateCopySection;
}
