/**
 * How a part of the new tab that loads at its first use says how its load went, where the part
 * goes (#27 slice 3b). The parts are slice 3's lazy boundaries: the stats charts (Chart.js),
 * search (Fuse.js, in the sidebar and in the AI chat's All Notes tab), the Markdown export
 * (JSZip), and the embedding model (transformers.js, under search's results and in Related
 * Notes). The page's loader (js/runtime/lazy.js) answers each load loaded, or failed with a
 * reason and a retry, and never rejects; the call site holds a PartState for its place, runs its
 * loads through it, and puts its element where the part goes (`place`).
 *
 *   loading      a load still running LOADING_AFTER_MS in shows the part's status line, which
 *                then stays at least LOADING_HOLD_MS, so it never flashes
 *   failed       "Failed to load the charts. Please try again." with Try again
 *   again        a Try again that failed: "Failed to load the charts again." over the reload
 *                line, with Reload beside Try again. A new search, a reopened view, or a failure
 *                the loader holds shows the first failure's words until Try again is pressed.
 *   threw        the file loaded and threw (evaluation-failed), or build-info.json is another
 *                build's (build-mismatch, which only a dev build written over an open tab makes):
 *                its words over the reload line, with Reload alone, since trying again can't help
 *   save-failed  Reload didn't reload, because a save failed with no notice of its own: the
 *                save's words, with Try again (the reload again) and Reload anyway
 *
 * Try again keeps its place and its focus while it runs, aria-disabled, and past
 * LOADING_AFTER_MS its line reads the part's loading words with the arc where the cross was. A part
 * shown in two places (the model's, in search and Related Notes) is one PartGroup: one Try again
 * runs one load, and its answer draws in both.
 * Reload runs the page's save guards first (the loader's reloadAfterGuards) and reads "Saving…"
 * at the same width meanwhile; when an open editor shows its own notice for what it couldn't
 * save, that notice speaks, and focus goes to its button. Everything is said once, through a
 * polite live region the PartState puts on the page when it's made, before any words go in.
 * The styles are the page's own (css/editor.css), since they draw when a chunk didn't load.
 */

/** A load still running this long shows its status line (the scope's 400 ms) */
const LOADING_AFTER_MS = 400;

/** Once shown, the status line stays at least this long, so it never flashes (300 ms) */
const LOADING_HOLD_MS = 300;

const RELOAD_LINE = "Reloading the page may fix it, and doesn't delete your notes.";

/**
 * Each part's words: the first failure, a Try again that failed, a file that threw or another
 * build on disk, and the loading line (none for the export, whose button says Exporting…)
 * @typedef {{failed: string, again: string, threw: string, loading: string | null}} PartWords
 */

/** @type {Readonly<Record<string, PartWords>>} */
const PART_WORDS = Object.freeze({
  charts: {
    failed: 'Failed to load the charts. Please try again.',
    again: 'Failed to load the charts again.',
    threw: 'Failed to load the charts.',
    loading: 'Loading charts…',
  },
  search: {
    failed: 'Failed to load search. Please try again.',
    again: 'Failed to load search again.',
    threw: 'Failed to load search.',
    loading: 'Loading search…',
  },
  export: {
    failed: 'Failed to export your notes as Markdown. Please try again.',
    again: 'Failed to export your notes as Markdown again. Export JSON still works.',
    threw: 'Failed to export your notes as Markdown. Export JSON still works.',
    loading: null,
  },
  semantic: {
    failed: 'Failed to load semantic search. Please try again.',
    again: 'Failed to load semantic search again.',
    threw: 'Failed to load semantic search.',
    loading: 'Loading semantic search…',
  },
});

/** The lines a place puts under its part's words, and the save's */
const PART_NOTES = Object.freeze({
  keywordOnly: 'These results match the words you typed.',
  relatedKeywordOnly: 'Until it loads, related notes match words only.',
  meaningOnly: 'These results match by meaning only.',
  firstDownload: 'The model downloads the first time, which can take a minute.',
  saving: 'Saving your changes before reloading.',
  saveFailed: "Failed to save your changes, so the page didn't reload.",
  saveFailedNote: 'Please try again. If it keeps failing, copy anything you need, then reload.',
});

const BUTTONS = Object.freeze({ tryAgain: 'Try again', reload: 'Reload', saving: 'Saving…', reloadAnyway: 'Reload anyway' });

/** #20's glyph shapes, so a state reads in grayscale too: a cross for a failure, an arc while loading */
const GLYPHS = Object.freeze({
  failed: '<circle cx="8" cy="8" r="6.4"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/>',
  loading: '<path d="M14.4 8A6.4 6.4 0 1 1 8 1.6"/>',
});

/**
 * Run `work`, and while it runs past LOADING_AFTER_MS show its status (`show`), which then stays
 * at least LOADING_HOLD_MS before `hide`. Answers what `work` answers, once the status, if it
 * showed, has held. The one timing every part's status uses.
 * @template T
 * @param {Promise<T> | (() => Promise<T>)} work
 * @param {{show: () => (void | boolean), hide?: () => void}} status - `show` answers false when
 *   it drew nothing (a load a newer one replaced, or a part with no status line), which holds nothing
 * @returns {Promise<T>}
 */
async function whileLoading(work, { show, hide = () => {} }) {
  let shown = false;
  /** @type {Promise<void>} */
  let held = Promise.resolve();
  const timer = setTimeout(() => {
    if (show() === false) return;
    shown = true;
    held = new Promise((resolve) => { setTimeout(resolve, LOADING_HOLD_MS); });
  }, LOADING_AFTER_MS);
  try {
    return await (typeof work === 'function' ? work() : work);
  } finally {
    clearTimeout(timer);
    if (shown) {
      await held;
      hide();
    }
  }
}

/**
 * What a part's Reload uses: the page loader's guarded reload, its reload without the guards,
 * and the button of a notice an open editor shows for what it couldn't save, if one does
 * @typedef {object} PartReload
 * @property {() => Promise<{reloaded: boolean}>} guarded
 * @property {() => void} now
 * @property {() => (HTMLElement | null)} ownNotice
 */

/**
 * The page's Reload without a loader: a plain reload, which nothing guards
 * @type {PartReload}
 */
const PLAIN_RELOAD = {
  guarded: async () => {
    location.reload();
    return { reloaded: true };
  },
  now: () => location.reload(),
  ownNotice: () => null,
};

class PartState {
  /**
   * @param {object} options
   * @param {Document} options.doc
   * @param {PartWords} options.words - PART_WORDS for the part
   * @param {Element | null} options.live - where its live region goes, which is on the page from the
   *   start; null in a place that is a live region already (the AI chat's messages), which says it
   * @param {(element: HTMLElement | null) => void} options.place - put the element where the part
   *   goes, or take it away (null) so the part draws there
   * @param {'card' | 'narrow' | 'flat'} [options.form] - a card; a card whose buttons go under its
   *   words (a 260 px sidebar); or a row of a section that is a card already
   * @param {PartReload | null} [options.reload]
   * @param {(failure: any) => Promise<any>} [options.tryAgain] - the load again; by default the
   *   failure's own retry, which a held library failure needs
   * @param {(result: any, how: {pressed: boolean, focus: boolean}) => (void | Promise<void>)} [options.loaded] -
   *   draws the part once its load worked: `pressed` when a Try again ran it, and `focus` when it
   *   was this place's
   * @param {() => (HTMLElement | null)} [options.focusAfter] - where focus goes when Try again worked
   * @param {() => string} [options.note] - the line the place puts under its failure's words
   * @param {(failure: any) => boolean} [options.again] - whether a failure after Try again takes
   *   the second failure's words (default: always; the export's take them only for JSZip)
   * @param {PartGroup | null} [options.group] - the other places that show this part's state
   */
  constructor({ doc, words, live, place, form = 'card', reload = null, tryAgain, loaded = () => {}, focusAfter = () => null, note = () => '', again = () => true, group = null }) {
    this.doc = doc;
    this.words = words;
    this.place = place;
    this.form = form;
    this.reload = reload || PLAIN_RELOAD;
    this.tryAgainLoad = tryAgain || ((failure) => failure.retry());
    this.loaded = loaded;
    this.focusAfter = focusAfter;
    this.note = note;
    this.takesAgain = again;
    /** @type {'idle' | 'loading' | 'failed' | 'again' | 'threw' | 'saving' | 'save-failed'} */
    this.state = 'idle';
    /** @type {any} The last failure, whose retry Try again runs */
    this.failure = null;
    /** Whether Try again ran the load that answered it */
    this._pressed = false;
    /** The line under the loading words while the load runs long, if one does */
    this._loadingNote = '';
    /** Each load's turn: an answer that isn't the newest load's draws nothing */
    this._turn = 0;
    /** @type {HTMLElement | null} */
    this.element = null;
    /** @type {string} What the live region last said */
    this._said = '';
    /** @type {HTMLElement | null} */
    this.liveRegion = null;
    if (live) {
      this.liveRegion = doc.createElement('p');
      this.liveRegion.className = 'part-state-live';
      this.liveRegion.setAttribute('role', 'status');
      live.appendChild(this.liveRegion);
    }
    this.group = group;
    if (group) group.add(this);
  }

  /**
   * Run a load of the part: its status line once it has run LOADING_AFTER_MS (in the panel's
   * place when Try again started it), then the part, or its failure
   * @param {() => Promise<any>} run - answers the loader's Result
   * @param {{pressed?: boolean, focus?: boolean}} [options] - Try again started it; `focus`
   *   false where another place's Try again did, so focus stays where it is
   * @returns {Promise<any>} the Result
   */
  async load(run, { pressed = false, focus = pressed } = {}) {
    const turn = this._turn + 1;
    const result = await this.loading(run, { pressed });
    if (turn !== this._turn) return result;
    if (result && result.status === 'loaded') {
      this.clear();
      await this.loaded(result, { pressed, focus });
      if (focus) this._focus(this.focusAfter());
    } else {
      this.fail(result, { pressed, focus });
    }
    return result;
  }

  /**
   * Run a load with its status line past LOADING_AFTER_MS, and answer the loader's Result without
   * drawing it, for a place that draws it with clear or fail once it has what goes beside it
   * (search, whose failure's line says what the list holds)
   * @param {() => Promise<any>} run
   * @param {{pressed?: boolean}} [options]
   * @returns {Promise<any>} the Result
   */
  async loading(run, { pressed = false } = {}) {
    const turn = ++this._turn;
    if (pressed) this._busy(this.tryButton, true);
    let result;
    try {
      result = await whileLoading(run, { show: () => turn === this._turn && this._showLoading(pressed) });
    } catch {
      // The place's own step threw: trying again would throw again
      result = { status: 'failed', reason: 'evaluation-failed', retry: null };
    }
    // Try again is pressable again, even when a newer load draws in its place
    if (pressed) this._busy(this.tryButton, false);
    return result;
  }

  /**
   * Show the failure the loader answered: the first failure's words, a second failure's after
   * Try again, or the reload's alone when trying again can't help
   * @param {any} failure - the loader's failed Result
   * @param {{pressed?: boolean, focus?: boolean}} [options]
   * @returns {void}
   */
  fail(failure, { pressed = false, focus = pressed } = {}) {
    this.failure = failure;
    this._pressed = pressed;
    const reason = failure && failure.reason;
    const cantRetry = reason === 'evaluation-failed' || reason === 'build-mismatch' || !failure || typeof failure.retry !== 'function';
    if (cantRetry) {
      this._draw('threw', this.words.threw, this._withReloadLine(this.note()), ['reload']);
      if (focus) this._focus(this.reloadButton);
      return;
    }
    if (pressed && this.takesAgain(failure)) {
      this._draw('again', this.words.again, this._withReloadLine(this.note()), ['try', 'reload']);
      return;
    }
    this._draw('failed', this.words.failed, this.note(), ['try']);
  }

  /**
   * Draw the failure shown again, with the line under it as the place's note now reads (search's,
   * once the model's matches are listed under it)
   * @returns {void}
   */
  redraw() {
    if (this.state === 'failed' || this.state === 'again' || this.state === 'threw') {
      this.fail(this.failure, { pressed: this._pressed, focus: false });
    }
  }

  /**
   * Whether it shows a failure, which another place's Try again draws over
   * @returns {boolean}
   */
  showsFailure() {
    return this.state === 'failed' || this.state === 'again' || this.state === 'threw';
  }

  /**
   * Nothing to say: the element goes, and the part draws in its place
   * @returns {void}
   */
  clear() {
    this.state = 'idle';
    this.failure = null;
    if (this.element) this.place(null);
  }

  /**
   * The place is gone for now, as search's when the list leaves search: a load still running
   * draws nothing there, and the element goes
   * @returns {void}
   */
  stop() {
    this._turn += 1;
    this.clear();
  }

  /**
   * Say `text` through the live region, as a place says what Try again drew ("3 notes match.")
   * @param {string} text
   * @returns {void}
   */
  announce(text) {
    this._say(text, true);
  }

  // ───────── Drawing ─────────

  /**
   * The panel, made once and kept, so the button that has focus stays the same element
   * @returns {HTMLElement}
   */
  _panel() {
    if (this.element) return this.element;
    const doc = this.doc;
    const element = doc.createElement('div');
    element.className = 'part-state';
    const text = doc.createElement('p');
    text.className = 'part-state-text';
    this.glyph = doc.createElement('span');
    this.glyph.className = 'part-state-glyph';
    this.glyph.setAttribute('aria-hidden', 'true');
    const words = doc.createElement('span');
    this.line = doc.createElement('span');
    this.lineNote = doc.createElement('span');
    this.lineNote.className = 'part-state-note';
    words.appendChild(this.line);
    // Read as two sentences, where the note is a line of its own
    words.appendChild(doc.createTextNode(' '));
    words.appendChild(this.lineNote);
    text.appendChild(this.glyph);
    text.appendChild(words);
    this.actions = doc.createElement('div');
    this.actions.className = 'part-state-actions';
    this.tryButton = this._button(BUTTONS.tryAgain, () => this._onTryAgain());
    this.reloadButton = this._button(BUTTONS.reload, () => this._onReload(), BUTTONS.saving);
    this.anywayButton = this._button(BUTTONS.reloadAnyway, () => this.reload.now());
    element.appendChild(text);
    element.appendChild(this.actions);
    this.element = element;
    return element;
  }

  /**
   * @param {string} label
   * @param {() => void} act
   * @param {string} [busyLabel] - a second label it may show, which it keeps the width of
   * @returns {HTMLButtonElement}
   */
  _button(label, act, busyLabel) {
    const doc = this.doc;
    const button = /** @type {HTMLButtonElement} */ (doc.createElement('button'));
    button.type = 'button';
    button.className = 'secondary-btn part-state-btn';
    if (busyLabel) {
      // Both labels sit in one cell, so it's as wide as the wider one in both states
      button.classList.add('part-state-swap');
      const shown = doc.createElement('span');
      const reserved = doc.createElement('span');
      reserved.setAttribute('data-reserved', '');
      reserved.setAttribute('aria-hidden', 'true');
      reserved.textContent = busyLabel;
      shown.textContent = label;
      button.appendChild(shown);
      button.appendChild(reserved);
    } else {
      button.textContent = label;
    }
    button.hidden = true;
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      act();
    });
    this.actions.appendChild(button);
    return button;
  }

  /**
   * Draw a state: its glyph, words, and buttons. Buttons it doesn't show are hidden, not taken
   * out, so the one with focus never moves.
   * @param {'failed' | 'again' | 'threw' | 'save-failed'} state
   * @param {string} words
   * @param {string} note
   * @param {Array<'try' | 'reload' | 'anyway'>} buttons
   * @returns {void}
   */
  _draw(state, words, note, buttons) {
    const element = this._panel();
    element.className = `part-state${this.form === 'card' ? '' : ` is-${this.form}`}`;
    this.state = state;
    this._glyph('failed');
    this.line.textContent = words;
    this.lineNote.textContent = note;
    this.tryButton.hidden = !buttons.includes('try');
    this.reloadButton.hidden = !buttons.includes('reload');
    this.anywayButton.hidden = !buttons.includes('anyway');
    this.place(element);
    this._say([words, note].filter(Boolean).join(' '));
  }

  /**
   * The loading line: in the panel, under Try again's press, or a line of its own for a load
   * nobody pressed for. The export has none: its own button says Exporting….
   * @param {boolean} pressed
   * @returns {boolean} whether it drew the line
   */
  _showLoading(pressed) {
    if (!this.words.loading) return false;
    const element = this._panel();
    this.state = 'loading';
    this._glyph('loading');
    this.line.textContent = this.words.loading;
    // The model's first download says so; otherwise, under Try again's press, the place's own line
    // stays, and the reload line goes
    this.lineNote.textContent = this._loadingNote || (pressed ? this.note() : '');
    if (!pressed) {
      element.className = 'part-state is-line';
      for (const button of [this.tryButton, this.reloadButton, this.anywayButton]) button.hidden = true;
    }
    this.place(element);
    this._say([this.words.loading, this._loadingNote].filter(Boolean).join(' '));
    return true;
  }

  /**
   * A line under the loading words while a load takes longer than the page, as the model's
   * first download does (PART_NOTES.firstDownload); '' takes it away
   * @param {string} note
   * @returns {void}
   */
  loadingNote(note) {
    this._loadingNote = note;
    if (this.state !== 'loading' || !this.lineNote) return;
    this.lineNote.textContent = note;
    if (note) this._say(note);
  }

  /**
   * @param {'failed' | 'loading'} kind
   * @returns {void}
   */
  _glyph(kind) {
    const glyph = /** @type {HTMLElement} */ (this.glyph);
    glyph.innerHTML = `<svg${kind === 'loading' ? ' class="part-state-spin"' : ''} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">${GLYPHS[kind]}</svg>`;
  }

  /**
   * @param {string} note
   * @returns {string}
   */
  _withReloadLine(note) {
    return [note, RELOAD_LINE].filter(Boolean).join(' ');
  }

  /**
   * @param {string} text
   * @param {boolean} [again] - say it even when it's what was said last
   * @returns {void}
   */
  _say(text, again = false) {
    if (!text || (text === this._said && !again)) return;
    this._said = text;
    if (!this.liveRegion) return;
    // Emptied first, so the same words said again are announced again
    this.liveRegion.textContent = '';
    this.liveRegion.textContent = text;
  }

  // ───────── Buttons ─────────

  /** Try again: the part's load again, or, after a failed save, the reload again */
  _onTryAgain() {
    if (this.state === 'save-failed') {
      this._onReload();
      return;
    }
    const failure = this.failure;
    if (!failure) return;
    if (this.group) {
      this.group.tryAgain(this, failure);
      return;
    }
    this.load(() => this.tryAgainLoad(failure), { pressed: true });
  }

  /** Reload, after the page's save guards. It stays when a save failed, and says why. */
  async _onReload() {
    const button = /** @type {HTMLButtonElement} */ (this.state === 'save-failed' ? this.tryButton : this.reloadButton);
    this._busy(button, true, button === this.reloadButton);
    let answer;
    try {
      answer = await this.reload.guarded();
    } catch {
      answer = { reloaded: false };
    }
    this._busy(button, false, button === this.reloadButton);
    if (answer && answer.reloaded) return;
    // An open editor's own notice says what it couldn't save: it speaks, the row stays as it is,
    // and focus goes to the notice's button
    const notice = this.reload.ownNotice();
    if (notice) {
      this._focus(notice);
      return;
    }
    this._draw('save-failed', PART_NOTES.saveFailed, PART_NOTES.saveFailedNote, ['try', 'anyway']);
    this._focus(this.tryButton);
  }

  /**
   * Mark a button busy, or not: aria-disabled keeps it focusable and in its place, where
   * disabled would drop focus to the page. Reload swaps to its "Saving…" label.
   * @param {HTMLElement | undefined} button
   * @param {boolean} busy
   * @param {boolean} [swap]
   * @returns {void}
   */
  _busy(button, busy, swap = false) {
    if (!button) return;
    if (busy) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
    if (swap && button.children.length === 2) {
      const [shown, reserved] = button.children;
      shown.textContent = busy ? BUTTONS.saving : BUTTONS.reload;
      reserved.textContent = busy ? BUTTONS.reload : BUTTONS.saving;
      if (busy) this._say(PART_NOTES.saving);
    }
  }

  /**
   * @param {HTMLElement | null | undefined} target
   * @returns {void}
   */
  _focus(target) {
    if (target && typeof target.focus === 'function') target.focus();
  }
}

/**
 * The places that show one part's state: the embedding model's, under search's results and in
 * Related Notes (#27 slice 3b, change 12). One Try again runs one load for all of them; each place
 * that shows the failure shows it running, with the second failure's words if it fails, and draws
 * the part if it loads. Focus stays in the place whose Try again was pressed.
 */
class PartGroup {
  constructor() {
    /** @type {Set<PartState>} */
    this.members = new Set();
  }

  /**
   * @param {PartState} member
   * @returns {void}
   */
  add(member) {
    this.members.add(member);
  }

  /**
   * @param {PartState} from - the place whose Try again was pressed
   * @param {any} failure
   * @returns {void}
   */
  tryAgain(from, failure) {
    const once = from.tryAgainLoad(failure);
    for (const member of this.members) {
      if (member === from || member.showsFailure()) member.load(() => once, { pressed: true, focus: member === from });
    }
  }

  /**
   * A line under every place's loading words while the load runs long (the model's first download)
   * @param {string} note
   * @returns {void}
   */
  loadingNote(note) {
    for (const member of this.members) member.loadingNote(note);
  }
}

if (typeof window !== 'undefined') {
  /** @type {any} */ (window).PartState = PartState;
  /** @type {any} */ (window).PartGroup = PartGroup;
  /** @type {any} */ (window).PART_WORDS = PART_WORDS;
  /** @type {any} */ (window).PART_NOTES = PART_NOTES;
  /** @type {any} */ (window).whileLoading = whileLoading;
}
