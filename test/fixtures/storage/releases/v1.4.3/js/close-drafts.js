/**
 * Close-time drafts (#33, 1.4.3). A tab that closes while it holds an edit it hasn't seen
 * commit writes that edit here, to this extension's localStorage, which a closing page writes
 * at once, whatever IndexedDB is doing. Chrome aborts the IndexedDB writes a closing page
 * hasn't committed, and another page's transaction over the blocks holds the close's own commit
 * back (#33), so without the draft the edit can be lost.
 *
 * The next start of the new tab, Popup or Side Panel applies the drafts, on the notes database
 * that root has open, before it reads a note. Its apply holds the Web Lock `ntn-close-drafts`
 * across reading the drafts, applying each, and removing it, so two roots starting together
 * take turns and the second finds the drafts gone. It reads each draft's key again right before
 * applying it, so a permanent delete that cleared the draft meanwhile wins. Each draft, in the
 * order the tabs closed:
 * 0. Its recovered note is already stored: an earlier start made it, and its page went before
 *    removing the draft. The draft is removed, writing nothing.
 * 1. A note that's gone (deleted for good since): the draft is removed, writing nothing.
 * 2. Content first: when the stored blocks already equal the draft's, the times aside, with none
 *    of its deleted blocks left, and the stored name equals the draft's wherever the save would
 *    write it, the edit is already in. The draft is removed, writing nothing.
 * 3. The newer-note rule: when another writer saved the note after the draft's base, the
 *    draft becomes one recovered note beside it, and never overwrites it (recoveredNote()).
 *    The stored `updatedAt` says who wrote last: the draft's base (the save the editor last
 *    saw commit) or one of the saves the editor issued since, in flight included
 *    (`base.issued`), is the editor's own; anything else past the base is another writer, a
 *    change to the record alone included. A draft that only deleted blocks, maybe with an AI
 *    title, has no text to recover, so it's removed, writing nothing, and the blocks it meant to
 *    delete stay. A draft holding a block that another note's stored copy has becomes a
 *    recovered note too, since that block can't be saved in place.
 * 4. Otherwise the save: the draft's blocks are put and its deleted blocks deleted, only the
 *    note's own, and the note gets the draft's title, preview and to-do progress, with its
 *    search entry's name and its links, as the editor's save writes them. A stored copy with no
 *    note ID belongs to no note, so it's taken as this note's and put back under it.
 * Each draft is one readwrite transaction over the notes and their blocks, which every editor
 * save also takes, so nothing writes the note between the read and the write. A transaction that
 * fails keeps its draft for the next start, and every start after that, until one applies it.
 *
 * A draft is JSON under `ntn-close-draft:<id>`:
 *   {v: 1, id, noteId, base: {revision, updatedAt, issued}, at, blocks, deletedBlockIds,
 *    name?, titleOrigin?, preview, todoProgress, linkedNames}
 * `base.updatedAt` is the note's `updatedAt` as the editor last saw it stored, and
 * `base.issued` every `updatedAt` its saves stamped since. `blocks` holds only the blocks
 * changed since that save, as the editor serializes them, and `deletedBlockIds` the blocks it
 * deleted since. `name` is there only when the title changed since, with `titleOrigin` 'typed'
 * (the user) or 'generated' (the AI). 1.4.x has no revisions, so `base.revision` is null, and
 * the stack's applier reads the same format.
 *
 * The draft is a second place a note's text sits outside IndexedDB, until the next start
 * (PRIVACY_POLICY.md says so). A draft in a format this build doesn't know is removed, since
 * nothing could apply it. Deleting a note for good removes its drafts, and the drafts whose
 * recovered note it is, and puts them back if the delete fails (Storage.permanentlyDeleteNote).
 * NewTabNote has no locked or encrypted notes, so no draft skips one; a feature that adds them
 * has to make the writer skip them.
 */

const CloseDrafts = (function initCloseDrafts() {
  'use strict';

  const PREFIX = 'ntn-close-draft:';
  const LOCK = 'ntn-close-drafts';
  const VERSION = 1;
  /**
   * The recovered notes no new tab has told the user about yet: their IDs, never their text. Far
   * from PREFIX, so no draft key can be taken for it.
   */
  const UNTOLD_KEY = 'ntn-recovered-untold';
  // A block's times change on every edit, so content first compares the blocks without them
  const TIMES = ['createdAt', 'updatedAt'];
  const PREVIEW_LENGTH = 120;
  const TRASH_DAYS_DEFAULT = 30;

  /**
   * @typedef {{
   *   v: number, id: string, noteId: string,
   *   base: {revision: (number|null), updatedAt: (number|null), issued: Array<number>},
   *   at: number, blocks: Array<any>, deletedBlockIds: Array<string>,
   *   name?: string, titleOrigin?: ('typed'|'generated'),
   *   preview: string, todoProgress: (Object|null), linkedNames: Array<string>
   * }} CloseDraft
   */

  /**
   * What a start's apply did, by note ID. `dropped` holds the drafts removed with nothing
   * written while their note is there: those content first found already in, and those with no
   * text to recover over a note saved elsewhere since. `gone` holds the notes deleted for good
   * since. Both are for #33's rebuild and sweep at the same start. `recovered` also has a draft
   * whose recovered note an earlier start made.
   * @typedef {{
   *   saved: Array<string>, recovered: Array<{noteId: string, recoveredId: string}>,
   *   dropped: Array<string>, gone: Array<string>, kept: Array<string>
   * }} ApplyResult
   */

  /** An ID in Utils.generateId's format, which Popup and the Side Panel don't load */
  function newId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * @param {string} text
   * @returns {string} `text` as a block's HTML content, which shows it as it is
   */
  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
  }

  // ─── The recovered note: its look, words and placement, in one place ───
  //
  // As the Design gate approved it: R's mockup with the design director's three edits (the
  // toast is text only, the title's date wraps as one unit, and the first block names the
  // original once). Dates are en-US, as every date 1.4.x shows on a note.

  /** A new note's viewport and grid, as Storage.createNote gives them */
  const VIEWPORT = Object.freeze({ scale: 1, offsetX: 0, offsetY: 0 });
  const SETTINGS = Object.freeze({ gridType: 'dots', backgroundColor: '#fafafa' });

  /**
   * @param {number} at
   * @returns {string} "Oct 31, 9:41 PM", as a block's metadata reads (blocks.js), with no-break
   *   spaces, so the title's date wraps as one unit
   */
  function shortTime(at) {
    return new Date(at)
      .toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
      .replace(/\s/g, '\u00a0');
  }

  /**
   * @param {number} at
   * @returns {string} "Oct 31, 2026 at 9:41 PM", as Utils.formatTimestamp writes it
   */
  function longTime(at) {
    const date = new Date(at);
    const day = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
    const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
    return `${day} at ${time}`;
  }

  /**
   * A note's title as the sidebar names it
   * @param {any} note
   * @returns {string}
   */
  function titleOf(note) {
    return (note && note.name) || 'Untitled';
  }

  /**
   * Whether the draft renamed the note: a title that isn't empty and isn't the one the list
   * shows for it
   * @param {any} original - the stored note
   * @param {CloseDraft} draft
   * @returns {boolean}
   */
  function renamed(original, draft) {
    return typeof draft.name === 'string' && draft.name !== '' && draft.name !== titleOf(original);
  }

  /**
   * @param {number} count
   * @returns {string} "1 day" or "7 days"
   */
  function days(count) {
    return `${count} ${count === 1 ? 'day' : 'days'}`;
  }

  /**
   * The first block's words, which say what the recovered note is. They name the original once,
   * in the first sentence, and call it that note, that template or that Daily Note after it. A
   * draft that changed no block is a typed new name, the only one rule 3 recovers, and gets the
   * words for that.
   * @param {any} original - the stored note
   * @param {CloseDraft} draft
   * @param {number} stillThere - how many of the blocks the draft deleted the original still has
   * @param {number} trashDays - the Trash's keeping time, 0 for Never
   * @returns {string}
   */
  function explanation(original, draft, stillThere, trashDays) {
    let kind = 'note';
    if (original.isTemplate) kind = 'template';
    else if (original.isDaily) kind = 'Daily Note';
    const deletes = [];
    if (stillThere === 1) deletes.push('That tab also deleted a block, which is still in that note.');
    else if (stillThere > 1) deletes.push(`That tab also deleted ${stillThere} blocks, which are still in that note.`);
    // The Trash's own keeping time from this start; none when it keeps notes until it's emptied
    const keeping = trashDays > 0 ? ` Otherwise the Trash deletes it in ${days(trashDays)}.` : '';
    if (draft.blocks.length === 0) {
      return [
        `A tab that closed on ${longTime(draft.at)} renamed “${titleOf(original)}” to “${draft.name}” before the new name was saved.`,
        original.trashed
          ? 'That note is in the Trash, so NewTabNote kept the new name here and put this note in the Trash too.'
          : `That ${kind} was saved elsewhere too, so NewTabNote kept the new name here and left it as it is.`,
        ...deletes,
        original.trashed ? `Restore this note to keep the new name.${keeping}` : `To use the new name, rename that ${kind}, then delete this one.`,
      ].join(' ');
    }
    const sentences = [`These changes to “${titleOf(original)}” are from a tab that closed on ${longTime(draft.at)}, before they were saved.`];
    if (original.trashed) {
      sentences.push('That note is in the Trash, so NewTabNote kept the changes here and put this note in the Trash too.');
    } else if (kind === 'note') {
      sentences.push('That note was saved elsewhere too, so NewTabNote kept the changes here and left it as it is.');
    } else {
      sentences.push(`That ${kind} was saved elsewhere too, so NewTabNote kept the changes here as a regular note and left it as it is.`);
    }
    sentences.push('Below are only the blocks that tab changed.', ...deletes);
    if (renamed(original, draft)) sentences.push(`That tab also renamed it “${draft.name}”.`);
    sentences.push(original.trashed ? `Restore this note to keep them.${keeping}` : `Copy what you need into that ${kind}, then delete this one.`);
    return sentences.join(' ');
  }

  /**
   * The recovered note's preview and to-do progress, as SidebarUtils' buildNoteSaveMetadata
   * derives them from its blocks, which Popup and the Side Panel don't load. The preview is the
   * first block's text: the callout's, escaped, so it holds no tag.
   * @param {any} first - the callout
   * @param {Array<any>} changed - the copies of the draft's blocks
   * @returns {{preview: string, todoProgress: ({completed: number, total: number}|null)}}
   */
  function derived(first, changed) {
    let preview = first.content.replace(/\s+/g, ' ').trim();
    if (preview.length > PREVIEW_LENGTH) preview = `${preview.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…`;
    const todos = changed.filter((block) => block.type === 'todo');
    const completed = todos.filter((block) => block.checked).length;
    return { preview, todoProgress: todos.length > 0 ? { completed, total: todos.length } : null };
  }

  /**
   * The ID of `draft`'s recovered note, the same at every start, so a start that finds the note
   * already made (rule 0) makes no second one
   * @param {CloseDraft} draft
   * @returns {string}
   */
  function recoveredIdOf(draft) {
    return `${draft.id}-recovered`;
  }

  /**
   * The recovered note for `draft`, whose note `original` another writer saved after the
   * draft's base: an ordinary note, as Storage.createNote makes one, which says what it is in its
   * title and its first block, followed by copies of the draft's blocks under new IDs, made at
   * this start. Its ID and its blocks' come from the draft's (recoveredIdOf). It sits beside the
   * original, with its viewport and grid: in its folder while that folder exists, with its pin,
   * and with its times less 1 ms, so it sorts right under it by Recent and by Created. It's
   * archived with an archived original, 1 ms before it, and in the Trash with a trashed one,
   * unpinned and on top, with the Trash's whole keeping time from this start. It's never a Daily
   * Note or a template itself, and a template's pin stays the template's.
   * @param {any} original - the stored note
   * @param {CloseDraft} draft
   * @param {{now: number, stillThere: number, trashDays: number, inFolder: boolean}} context -
   *   `inFolder`: whether the original's folder exists
   * @returns {{note: any, blocks: Array<any>}}
   */
  function recoveredNote(original, draft, { now, stillThere, trashDays, inFolder }) {
    const id = recoveredIdOf(draft);
    const trashed = Boolean(original.trashed);
    const archived = !trashed && Boolean(original.archived);
    const first = {
      id: `${id}-0`,
      type: 'callout',
      content: escapeHtml(explanation(original, draft, stillThere, trashDays)),
      indentLevel: 0,
      checked: false,
      imageUrl: null,
      calloutIcon: 'ℹ️',
      createdAt: now,
      updatedAt: now,
      canvasId: id,
      order: 0,
    };
    const changed = [...draft.blocks]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((block, index) => ({ ...block, id: `${id}-${index + 1}`, createdAt: now, updatedAt: now, canvasId: id, order: index + 1 }));
    const note = {
      id,
      name: `Recovered: ${titleOf(original)} (${shortTime(draft.at)})`,
      createdAt: typeof original.createdAt === 'number' ? original.createdAt - 1 : now,
      updatedAt: typeof original.updatedAt === 'number' ? original.updatedAt - 1 : now,
      archived,
      archivedAt: archived && typeof original.archivedAt === 'number' ? original.archivedAt - 1 : null,
      // Set as a title, so auto-title, which names only an untitled note, leaves it
      titleManuallySet: true,
      lastAutoTitleAt: null,
      insights: null,
      lastInsightsExtractedAt: null,
      ...derived(first, changed),
      pinned: !trashed && !original.isTemplate && Boolean(original.pinned),
      isDaily: false,
      dateStr: null,
      isTemplate: false,
      folderId: inFolder ? original.folderId : null,
      viewport: { ...(original.viewport || VIEWPORT) },
      settings: { ...(original.settings || SETTINGS) },
    };
    if (trashed) Object.assign(note, { trashed: true, trashedAt: now });
    return { note, blocks: [first, ...changed] };
  }

  /**
   * @param {string} title
   * @returns {string} `title` cut at 40 characters for the toast
   */
  function toastTitle(title) {
    return title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title;
  }

  /** What the new tab says when its start made recovered notes, in 1.4.x's text-only toast */
  const TEXT = Object.freeze({
    /**
     * @param {Array<{title: string, archived: boolean, trashed: boolean}>} recovered - each
     *   note's original's title, and whether both are in Archive or in the Trash
     * @returns {string}
     */
    toast(recovered) {
      if (recovered.length !== 1) return `Kept your changes from closed tabs in ${recovered.length} recovered notes.`;
      const [{ title, archived, trashed }] = recovered;
      const kept = `Kept your changes to “${toastTitle(title)}” from a closed tab in a recovered note.`;
      if (trashed) return `${kept} Both are in the Trash.`;
      if (archived) return `${kept} Both are in Archive.`;
      return kept;
    },
  });

  // ─── The draft in localStorage ───

  /**
   * Build a draft from what the editor knows of the edit
   * @param {Omit<CloseDraft, 'v'|'id'|'at'> & {at?: number}} fields
   * @returns {CloseDraft}
   */
  function draftOf(fields) {
    return /** @type {CloseDraft} */ ({ v: VERSION, id: newId(), at: Date.now(), ...fields });
  }

  /**
   * Write `draft` synchronously. A draft that doesn't fit, typically QuotaExceededError, is
   * skipped: the IndexedDB attempt stands, and nothing throws out of pagehide.
   * @param {Storage|undefined} storage - the page's localStorage
   * @param {CloseDraft} draft
   * @returns {boolean} whether it was written
   */
  function write(storage, draft) {
    try {
      storage.setItem(PREFIX + draft.id, JSON.stringify(draft));
      return true;
    } catch (error) {
      console.warn('The close-time draft was skipped:', error && error.name);
      return false;
    }
  }

  /**
   * The keys of the drafts in `storage`
   * @param {Storage|undefined} storage
   * @returns {Array<string>}
   */
  function keysOf(storage) {
    const keys = [];
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key && key.startsWith(PREFIX)) keys.push(key);
      }
    } catch {
      // No localStorage here, or no access to it: no drafts
      return [];
    }
    return keys;
  }

  /**
   * Whether `storage` holds a draft. Synchronous, so a start with none waits for nothing.
   * @param {Storage|undefined} storage
   * @returns {boolean}
   */
  function has(storage) {
    return keysOf(storage).length > 0;
  }

  /**
   * @param {unknown} value
   * @returns {value is CloseDraft}
   */
  function isDraft(value) {
    const draft = /** @type {any} */ (value);
    return Boolean(draft) && typeof draft === 'object' && draft.v === VERSION && typeof draft.id === 'string'
      && typeof draft.noteId === 'string' && Boolean(draft.base) && typeof draft.base === 'object'
      && typeof draft.at === 'number' && Array.isArray(draft.blocks) && Array.isArray(draft.deletedBlockIds)
      && draft.blocks.every((/** @type {any} */ block) => block && typeof block === 'object' && typeof block.id === 'string')
      && draft.deletedBlockIds.every((/** @type {unknown} */ id) => typeof id === 'string');
  }

  /**
   * The drafts in `storage`, in the order their tabs closed. One that can't be read, or is of
   * a format this build doesn't know, is removed: nothing could apply it.
   * @param {Storage|undefined} storage
   * @returns {Array<{key: string, draft: CloseDraft}>}
   */
  function list(storage) {
    const found = [];
    for (const key of keysOf(storage)) {
      let draft;
      try {
        draft = JSON.parse(storage.getItem(key) || 'null');
      } catch {
        draft = null;
      }
      if (isDraft(draft)) {
        found.push({ key, draft });
      } else {
        remove(storage, key);
      }
    }
    return found.sort((a, b) => a.draft.at - b.draft.at);
  }

  /**
   * @param {Storage|undefined} storage
   * @param {string} key
   * @returns {boolean} whether `key` is still stored
   */
  function present(storage, key) {
    try {
      return storage.getItem(key) !== null;
    } catch {
      return false;
    }
  }

  /**
   * @param {Storage|undefined} storage
   * @param {string} key
   */
  function remove(storage, key) {
    try {
      storage.removeItem(key);
    } catch {
      // Nothing to remove it from
    }
  }

  /**
   * The recovered notes no new tab has told about: each one's ID and its original's
   * @param {Storage|undefined} storage
   * @returns {Array<{id: string, of: string}>}
   */
  function untold(storage) {
    try {
      const value = JSON.parse(storage.getItem(UNTOLD_KEY) || '[]');
      return Array.isArray(value)
        ? value.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.of === 'string')
        : [];
    } catch {
      return [];
    }
  }

  /**
   * @param {Storage|undefined} storage
   * @param {Array<{id: string, of: string}>} entries
   */
  function setUntold(storage, entries) {
    try {
      if (entries.length > 0) storage.setItem(UNTOLD_KEY, JSON.stringify(entries));
      else storage.removeItem(UNTOLD_KEY);
    } catch {
      // Without it the next new tab says nothing; the note is in the list either way
    }
  }

  /**
   * Take the recovered notes no new tab has told about, for the new tab's toast, and clear them
   * @param {Storage|undefined} storage
   * @returns {Array<{id: string, of: string}>}
   */
  function takeUntold(storage) {
    const entries = untold(storage);
    setUntold(storage, []);
    return entries;
  }

  /**
   * What clearNotes removed, for putBack
   * @typedef {{drafts: Array<{key: string, value: string}>, untold: Array<{id: string, of: string}>}} Cleared
   */

  /**
   * Remove what `noteIds` left here, as a note's permanent delete does: their drafts, the drafts
   * whose recovered note one of them is, and the entries among the recovered notes no new tab has
   * told about that are one of them or whose original is. Never throws.
   * @param {Storage|undefined} storage
   * @param {Array<string>} noteIds
   * @returns {Cleared} what it removed
   */
  function clearNotes(storage, noteIds) {
    const ids = new Set(noteIds);
    /** @type {Cleared} */
    const cleared = { drafts: [], untold: [] };
    for (const { key, draft } of list(storage)) {
      if (!ids.has(draft.noteId) && !ids.has(recoveredIdOf(draft))) continue;
      cleared.drafts.push({ key, value: JSON.stringify(draft) });
      remove(storage, key);
    }
    const entries = untold(storage);
    const kept = entries.filter((entry) => !ids.has(entry.id) && !ids.has(entry.of));
    cleared.untold = entries.filter((entry) => !kept.includes(entry));
    if (kept.length !== entries.length) setUntold(storage, kept);
    return cleared;
  }

  /**
   * Put back what clearNotes removed, for a permanent delete that failed. Never throws.
   * @param {Storage|undefined} storage
   * @param {Cleared} cleared
   */
  function putBack(storage, cleared) {
    for (const { key, value } of cleared.drafts) {
      try {
        storage.setItem(key, value);
      } catch {
        // The draft doesn't fit back; the note keeps what IndexedDB has
      }
    }
    if (cleared.untold.length > 0) {
      const entries = untold(storage);
      setUntold(storage, [...entries, ...cleared.untold.filter((entry) => !entries.some((e) => e.id === entry.id))]);
    }
  }

  // ─── The applier ───

  /**
   * `block`'s fields without its times, as a stable string
   * @param {Object} block
   * @returns {string}
   */
  function fingerprint(block) {
    const fields = Object.keys(block).filter((key) => !TIMES.includes(key)).sort();
    return JSON.stringify(fields.map((key) => [key, /** @type {any} */ (block)[key]]));
  }

  /**
   * A short digest of `block`'s fingerprint (53-bit cyrb53), which the editor keeps for each
   * block of the last save it saw commit, so it holds no second copy of a note's images
   * @param {Object} block
   * @returns {string}
   */
  function digest(block) {
    const text = fingerprint(block);
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  /**
   * Whether a stored block is the note's own: under its ID, or under none, which no note shows,
   * so the draft takes it back
   * @param {any} copy - the stored block, if any
   * @param {string} noteId
   * @returns {boolean}
   */
  function ownCopy(copy, noteId) {
    return Boolean(copy) && (!copy.canvasId || copy.canvasId === noteId);
  }

  /**
   * Whether the draft's title is one the save writes: not a generated title over one set by hand
   * @param {any} original - the stored note
   * @param {CloseDraft} draft
   * @returns {boolean}
   */
  function writesName(original, draft) {
    return typeof draft.name === 'string' && !(draft.titleOrigin === 'generated' && original.titleManuallySet);
  }

  /**
   * Rule 2, content first: the draft's edit is already stored, as far as the save would write it
   * @param {any} original - the stored note
   * @param {Map<string, any>} stored - the stored blocks the draft names, by ID
   * @param {CloseDraft} draft
   * @returns {boolean}
   */
  function alreadyIn(original, stored, draft) {
    for (const block of draft.blocks) {
      const copy = stored.get(block.id);
      if (!copy || copy.canvasId !== draft.noteId || fingerprint(copy) !== fingerprint({ ...block, canvasId: draft.noteId })) {
        return false;
      }
    }
    for (const id of draft.deletedBlockIds) {
      if (ownCopy(stored.get(id), draft.noteId)) return false;
    }
    return !writesName(original, draft) || original.name === draft.name;
  }

  /**
   * Rule 3: another writer saved the note after the draft's base
   * @param {any} original
   * @param {CloseDraft} draft
   * @returns {boolean}
   */
  function savedElsewhere(original, draft) {
    const stored = original.updatedAt;
    const base = draft.base.updatedAt;
    // A draft that can't say what it was based on never overwrites anything
    if (typeof base !== 'number') return true;
    if (typeof stored !== 'number' || stored <= base) return false;
    const issued = Array.isArray(draft.base.issued) ? draft.base.issued : [];
    return !issued.includes(stored);
  }

  /**
   * Rule 4: the note as the save writes it. Its other fields, pin, folder, trash and archive
   * included, stay as stored.
   * @param {any} original
   * @param {CloseDraft} draft
   * @param {number} now
   * @returns {any}
   */
  function savedNote(original, draft, now) {
    const note = { ...original, updatedAt: now };
    if (typeof draft.preview === 'string') note.preview = draft.preview;
    if (draft.todoProgress !== undefined) note.todoProgress = draft.todoProgress;
    if (typeof draft.name === 'string') {
      if (draft.titleOrigin === 'generated') {
        // A generated title never replaces one set by hand
        if (!note.titleManuallySet) {
          note.name = draft.name;
          note.lastAutoTitleAt = draft.at;
        }
      } else {
        note.name = draft.name;
        note.titleManuallySet = true;
      }
    }
    return note;
  }

  /**
   * The note's links from its wiki links' names, replacing the ones it had, as
   * Storage.updateNoteLinks does: a name matches an active or archived note, not a template,
   * case aside, never the note itself.
   * @param {IDBTransaction} tx
   * @param {string} noteId
   * @param {Array<string>} names
   * @param {Array<any>} notes - every stored note
   * @param {number} now
   */
  function replaceLinks(tx, noteId, names, notes, now) {
    const links = tx.objectStore('links');
    const targets = new Set();
    for (const name of names) {
      const wanted = String(name).toLowerCase();
      const target = notes.find((note) => !note.trashed && !note.isTemplate && note.name && String(note.name).toLowerCase() === wanted);
      if (target && target.id !== noteId) targets.add(target.id);
    }
    const old = links.index('fromNoteId').getAll(noteId);
    old.onsuccess = () => {
      for (const link of old.result) links.delete(link.id);
      for (const toNoteId of targets) links.add({ id: newId(), fromNoteId: noteId, toNoteId, createdAt: now });
    };
  }

  /**
   * Rule 3's exception: the draft holds no text to recover. It changed no block and gave the note
   * no typed name, so all it did was delete blocks, or take an AI title, which the save treats as
   * replaceable too.
   * @param {any} original
   * @param {CloseDraft} draft
   * @returns {boolean}
   */
  function onlyDeletes(original, draft) {
    return draft.blocks.length === 0 && !(renamed(original, draft) && draft.titleOrigin !== 'generated');
  }

  /**
   * Apply one draft, in one readwrite transaction (rules 0 to 4)
   * @param {IDBDatabase} db
   * @param {CloseDraft} draft
   * @param {{now: number, trashDays: number}} context
   * @returns {Promise<{kind: 'saved'|'recovered'|'dropped'|'gone'|'kept', recoveredId?: string}>}
   */
  function applyOne(db, draft, { now, trashDays }) {
    return new Promise((resolve) => {
      const scope = ['canvases', 'elements'];
      const indexed = db.objectStoreNames.contains('search_index');
      const linked = db.objectStoreNames.contains('links');
      const foldered = db.objectStoreNames.contains('folders');
      if (indexed) scope.push('search_index');
      if (linked) scope.push('links');
      if (foldered) scope.push('folders');
      /** @type {{kind: 'saved'|'recovered'|'dropped'|'gone'|'kept', recoveredId?: string}} */
      let outcome = { kind: 'kept' };
      /** @type {IDBTransaction} */
      let tx;
      try {
        tx = db.transaction(scope, 'readwrite');
      } catch (error) {
        console.warn('A close-time draft was kept for the next start:', error && error.name);
        resolve({ kind: 'kept' });
        return;
      }
      tx.oncomplete = () => resolve(outcome);
      tx.onabort = () => {
        console.warn('A close-time draft was kept for the next start:', tx.error && tx.error.name);
        resolve({ kind: 'kept' });
      };
      const fail = (/** @type {unknown} */ error) => {
        console.warn('A close-time draft was kept for the next start:', error);
        outcome = { kind: 'kept' };
        try {
          tx.abort();
        } catch {
          // It's ending already
        }
      };

      try {
        const notes = tx.objectStore('canvases');
        const elements = tx.objectStore('elements');
        /** @type {Map<string, any>} */
        const stored = new Map();
        const ids = [...new Set([...draft.blocks.map((block) => block.id), ...draft.deletedBlockIds])];
        /** @type {any} */
        let original;
        /** @type {Array<any>} */
        let everyNote = [];
        /** @type {Set<unknown>} */
        let folderIds = new Set();
        /** @type {any} */
        let madeBefore;
        let waiting = 2 + ids.length + (linked ? 1 : 0) + (foldered ? 1 : 0);

        const decide = () => {
          // Rule 0: an earlier start made this draft's recovered note and went before removing it
          if (madeBefore) {
            outcome = { kind: 'recovered', recoveredId: madeBefore.id };
            return;
          }
          if (!original) {
            outcome = { kind: 'gone' };
            return;
          }
          if (alreadyIn(original, stored, draft)) {
            outcome = { kind: 'dropped' };
            return;
          }
          const elsewhere = savedElsewhere(original, draft);
          // Only deletes, maybe with an AI title: there's no text to recover, and the blocks it
          // meant to delete stay
          if (elsewhere && onlyDeletes(original, draft)) {
            outcome = { kind: 'dropped' };
            return;
          }
          // No block moves notes, so one whose stored copy is another note's can't be saved here
          const foreign = draft.blocks.some((block) => {
            const copy = stored.get(block.id);
            return Boolean(copy) && !ownCopy(copy, draft.noteId);
          });
          if (elsewhere || foreign) {
            const stillThere = draft.deletedBlockIds.filter((id) => {
              const copy = stored.get(id);
              return copy && copy.canvasId === draft.noteId;
            }).length;
            const inFolder = Boolean(original.folderId) && folderIds.has(original.folderId);
            const { note, blocks } = recoveredNote(original, draft, { now, stillThere, trashDays, inFolder });
            // With its own times set, as import's commit writes a note
            notes.add(note);
            for (const block of blocks) elements.add(block);
            // The entry Storage.createNote gives a new note; the new tab's indexer fills it in
            if (indexed) tx.objectStore('search_index').put({ noteId: note.id, name: note.name, content: '', updatedAt: note.updatedAt });
            outcome = { kind: 'recovered', recoveredId: note.id };
            return;
          }
          const note = savedNote(original, draft, now);
          notes.put(note);
          // Every block here is the note's own, new, or under no note, which it takes back
          for (const block of draft.blocks) elements.put({ ...block, canvasId: draft.noteId });
          for (const id of draft.deletedBlockIds) {
            if (ownCopy(stored.get(id), draft.noteId)) elements.delete(id);
          }
          if (indexed) {
            const searchIndex = tx.objectStore('search_index');
            const entry = searchIndex.get(draft.noteId);
            entry.onsuccess = () => {
              if (entry.result) searchIndex.put({ ...entry.result, name: note.name, updatedAt: now });
            };
          }
          if (linked && Array.isArray(draft.linkedNames)) replaceLinks(tx, draft.noteId, draft.linkedNames, everyNote, now);
          outcome = { kind: 'saved' };
        };
        const arrived = () => {
          waiting -= 1;
          if (waiting > 0) return;
          try {
            decide();
          } catch (error) {
            fail(error);
          }
        };

        const prior = notes.get(recoveredIdOf(draft));
        prior.onsuccess = () => {
          madeBefore = prior.result;
          arrived();
        };
        const read = notes.get(draft.noteId);
        read.onsuccess = () => {
          original = read.result;
          arrived();
        };
        for (const id of ids) {
          const request = elements.get(id);
          request.onsuccess = () => {
            if (request.result) stored.set(id, request.result);
            arrived();
          };
        }
        if (linked) {
          const all = notes.getAll();
          all.onsuccess = () => {
            everyNote = all.result;
            arrived();
          };
        }
        if (foldered) {
          const keys = tx.objectStore('folders').getAllKeys();
          keys.onsuccess = () => {
            folderIds = new Set(keys.result);
            arrived();
          };
        }
      } catch (error) {
        fail(error);
      }
    });
  }

  /**
   * The Trash's keeping time in days, 0 for Never, from the setting Settings writes
   * @returns {Promise<number>}
   */
  function readTrashDays() {
    return new Promise((resolve) => {
      try {
        const api = /** @type {any} */ (globalThis).chrome;
        api.storage.local.get(['setting_trashRetention'], (/** @type {any} */ result) => {
          const days = Number(result && result.setting_trashRetention);
          resolve(Number.isFinite(days) && days >= 0 ? days : TRASH_DAYS_DEFAULT);
        });
      } catch {
        resolve(TRASH_DAYS_DEFAULT);
      }
    });
  }

  /**
   * Apply every draft in `storage` to `db`, one at a time across pages, and remove each one
   * applied, recovered, dropped, or for a note that's gone. A root calls it once its
   * database is open, before it reads a note. Each recovered note's ID also goes on the list
   * the next new tab's toast tells (takeUntold), whichever root made it.
   * @param {{db: IDBDatabase, storage?: Storage, locks?: (LockManager|null), now?: () => number,
   *   trashDays?: () => Promise<number>}} options
   * @returns {Promise<ApplyResult>}
   */
  async function apply({ db, storage, locks, now = Date.now, trashDays = readTrashDays }) {
    /** @type {ApplyResult} */
    const result = { saved: [], recovered: [], dropped: [], gone: [], kept: [] };
    const drafts = storage === undefined ? pageStorage() : storage;
    // Nearly every start: no draft, so no lock and no transaction
    if (!has(drafts)) return result;
    if (!db || !db.objectStoreNames.contains('canvases') || !db.objectStoreNames.contains('elements')) return result;

    const run = async () => {
      const found = list(drafts);
      if (found.length === 0) return result;
      const days = await trashDays();
      for (const { key, draft } of found) {
        // A permanent delete may have cleared it since the list, and then the delete wins
        if (!present(drafts, key)) continue;
        const { kind, recoveredId } = await applyOne(db, draft, { now: now(), trashDays: days });
        if (kind === 'kept') {
          result.kept.push(draft.noteId);
          continue;
        }
        if (kind === 'recovered') {
          const entry = { noteId: draft.noteId, recoveredId: String(recoveredId) };
          result.recovered.push(entry);
          // Once, even when an earlier start made the note and listed it before its page went
          const told = untold(drafts);
          if (!told.some((e) => e.id === entry.recoveredId)) setUntold(drafts, [...told, { id: entry.recoveredId, of: entry.noteId }]);
        } else if (kind === 'saved') {
          result.saved.push(draft.noteId);
        } else if (kind === 'dropped') {
          result.dropped.push(draft.noteId);
        } else {
          result.gone.push(draft.noteId);
        }
        remove(drafts, key);
      }
      return result;
    };
    const manager = locks === undefined ? pageLocks() : locks;
    if (manager && typeof manager.request === 'function') return manager.request(LOCK, { mode: 'exclusive' }, run);
    return run();
  }

  /** @returns {Storage|undefined} this page's localStorage, when it has one */
  function pageStorage() {
    try {
      return typeof localStorage === 'undefined' ? undefined : localStorage;
    } catch {
      return undefined;
    }
  }

  /** @returns {LockManager|null} */
  function pageLocks() {
    return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
  }

  return Object.freeze({
    PREFIX,
    LOCK,
    UNTOLD_KEY,
    VERSION,
    TEXT,
    newId,
    draftOf,
    write,
    has,
    list,
    clearNotes,
    putBack,
    takeUntold,
    fingerprint,
    digest,
    recoveredIdOf,
    recoveredNote,
    apply,
    pageStorage,
  });
})();

/** @type {any} */ (globalThis).CloseDrafts = CloseDrafts;
