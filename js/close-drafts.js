/**
 * Close-time drafts (#33, 1.4.3). A tab that closes while it holds an edit it hasn't seen
 * commit writes that edit here, to this extension's localStorage, which a closing page writes
 * at once, whatever IndexedDB is doing. Chrome aborts the IndexedDB writes a closing page
 * hasn't committed, and another page's transaction over the blocks holds the close's own commit
 * back (#142), so without the draft the edit can be lost.
 *
 * The next start of the new tab, Popup or Side Panel applies the drafts, on the notes database
 * that root has open, before it reads a note. Its apply holds the Web Lock `ntn-close-drafts`
 * across reading the drafts, applying each, and removing it, so two roots starting together
 * take turns and the second finds the drafts gone. Each draft, in the order the tabs closed:
 * 1. A note that's gone (deleted for good since): the draft is removed, writing nothing.
 * 2. Content first: when the stored blocks already equal the draft's, the times aside, with none
 *    of its deleted blocks left, and the stored name equals the draft's when it carries one,
 *    the edit is already in. The draft is removed, writing nothing.
 * 3. The newer-note rule: when another writer saved the note after the draft's base, the
 *    draft becomes one recovered note beside it, and never overwrites it (recoveredNote()).
 *    The stored `updatedAt` says who wrote last: the draft's base (the save the editor last
 *    saw commit) or one of the saves the editor issued since, in flight included
 *    (`base.issued`), is the editor's own; anything else past the base is another writer.
 *    A draft that only deleted blocks has no text to recover, so it's removed, writing
 *    nothing, and the blocks it meant to delete stay.
 * 4. Otherwise the save: the draft's blocks are put and its deleted blocks deleted, only the
 *    note's own, and the note gets the draft's title, preview and to-do progress, with its
 *    search entry's name and its links, as the editor's save writes them.
 * Each draft is one readwrite transaction over the notes and their blocks, which every editor
 * save also takes, so nothing writes the note between the read and the write. A transaction that
 * fails keeps its draft for the next start.
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
 * (PRIVACY_POLICY.md says so). Deleting a note for good removes its drafts
 * (Storage.permanentlyDeleteNote). NewTabNote has no locked or encrypted notes, so no draft
 * skips one; a feature that adds them has to make the writer skip them.
 */

const CloseDrafts = (function initCloseDrafts() {
  'use strict';

  const PREFIX = 'ntn-close-draft:';
  const LOCK = 'ntn-close-drafts';
  const VERSION = 1;
  /** The recovered notes no new tab has told the user about yet: their IDs, never their text */
  const UNTOLD_KEY = 'ntn-close-drafts:recovered';
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
   * written while their note is there: those content first found already in, and those that
   * only deleted blocks of a note saved elsewhere since. `gone` holds the notes deleted for
   * good since. Both are for #33's rebuild and sweep at the same start.
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
    return String(text).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
  }

  // ─── The recovered note: its look, words and placement, in one place ───
  //
  // Working text from R's Design gate mockup (artifacts/ntn-143-recovered-mockup), until the
  // design director rules on it. Dates are en-US, as every date 1.4.x shows on a note.

  /**
   * @param {number} at
   * @returns {string} "Oct 31, 9:41 PM", as a block's metadata reads (blocks.js)
   */
  function shortTime(at) {
    return new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
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
   * The first block's words, which say what the recovered note is
   * @param {any} original - the stored note
   * @param {CloseDraft} draft
   * @param {number} stillThere - how many of the blocks the draft deleted the original still has
   * @param {number} trashDays - the Trash's keeping time, 0 for Never
   * @returns {string}
   */
  function explanation(original, draft, stillThere, trashDays) {
    const title = `“${titleOf(original)}”`;
    const sentences = [`These changes to ${title} are from a tab that closed on ${longTime(draft.at)}, before they were saved.`];
    if (original.trashed) {
      sentences.push(`${title} is in the Trash, so NewTabNote kept the changes here and put this note in the Trash too.`);
    } else if (original.isTemplate) {
      sentences.push(`${title} was saved elsewhere too, so NewTabNote kept the changes here as a regular note and left the template as it is.`);
    } else if (original.isDaily) {
      sentences.push(`${title} was saved elsewhere too, so NewTabNote kept the changes here as a regular note and left it as it is.`);
    } else {
      sentences.push(`${title} was saved elsewhere too, so NewTabNote kept the changes here and left it as it is.`);
    }
    sentences.push('Below are only the blocks that tab changed.');
    if (stillThere === 1) sentences.push(`That tab also deleted a block. It's still in ${title}.`);
    else if (stillThere > 1) sentences.push(`That tab also deleted ${stillThere} blocks. They're still in ${title}.`);
    if (typeof draft.name === 'string' && draft.name !== original.name) sentences.push(`That tab also renamed it “${draft.name}”.`);
    if (original.trashed) {
      sentences.push(trashDays > 0
        ? `Restore this note to keep them. Otherwise the Trash deletes it in ${trashDays} ${trashDays === 1 ? 'day' : 'days'}.`
        : 'Restore this note to keep them.');
    } else {
      sentences.push(`Copy what you need into ${title}, then delete this note.`);
    }
    return sentences.join(' ');
  }

  /**
   * The note's preview and to-do progress from its blocks, as SidebarUtils'
   * buildNoteSaveMetadata derives them, which Popup and the Side Panel don't load
   * @param {Array<any>} blocks
   * @returns {{preview: string, todoProgress: ({completed: number, total: number}|null)}}
   */
  function derived(blocks) {
    let preview = '';
    let completed = 0;
    let total = 0;
    for (const block of blocks) {
      if (!preview) {
        preview = String(block.content || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')
          .replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
      }
      if (block.type === 'todo') {
        total += 1;
        if (block.checked) completed += 1;
      }
    }
    if (preview.length > PREVIEW_LENGTH) preview = `${preview.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…`;
    return { preview, todoProgress: total > 0 ? { completed, total } : null };
  }

  /**
   * The recovered note for `draft`, whose note `original` another writer saved after the
   * draft's base: an ordinary note, as Storage.createNote makes one, which says what it is in its
   * title and its first block, followed by the draft's blocks under new IDs. It sits beside the
   * original: in its folder, with its pin, and with its times less 1 ms, so it sorts right under
   * it by Recent and by Created. It's archived with an archived original, and in the Trash with
   * a trashed one, on top, with the Trash's whole keeping time from this start. It's never a
   * Daily Note or a template itself.
   * @param {any} original - the stored note
   * @param {CloseDraft} draft
   * @param {{now: number, stillThere: number, trashDays: number}} context
   * @returns {{note: any, blocks: Array<any>}}
   */
  function recoveredNote(original, draft, { now, stillThere, trashDays }) {
    const id = newId();
    const trashed = Boolean(original.trashed);
    const archived = !trashed && Boolean(original.archived);
    const created = typeof original.createdAt === 'number' ? original.createdAt - 1 : now;
    const updated = typeof original.updatedAt === 'number' ? original.updatedAt - 1 : now;
    const first = {
      id: newId(),
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
      .map((block, index) => ({ ...block, id: newId(), canvasId: id, order: index + 1 }));
    const blocks = [first, ...changed];
    const note = {
      id,
      name: `Recovered: ${titleOf(original)} (${shortTime(draft.at)})`,
      createdAt: created,
      updatedAt: updated,
      archived,
      archivedAt: archived && typeof original.archivedAt === 'number' ? original.archivedAt - 1 : null,
      // Set as a title, so auto-title, which names only an untitled note, leaves it
      titleManuallySet: true,
      lastAutoTitleAt: null,
      insights: null,
      lastInsightsExtractedAt: null,
      ...derived(blocks),
      pinned: !trashed && Boolean(original.pinned),
      isDaily: false,
      dateStr: null,
      isTemplate: false,
      folderId: original.folderId || null,
      viewport: { scale: 1, offsetX: 0, offsetY: 0 },
      settings: { gridType: 'dots', backgroundColor: '#fafafa' },
    };
    if (trashed) Object.assign(note, { trashed: true, trashedAt: now });
    return { note, blocks };
  }

  /**
   * @param {string} title
   * @returns {string} `title` cut at 40 characters for the toast
   */
  function toastTitle(title) {
    return title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title;
  }

  /** What the new tab says when its start made recovered notes */
  const TEXT = Object.freeze({
    /**
     * @param {Array<{title: string, trashed: boolean}>} recovered - each note's original's title
     *   and whether both are in the Trash
     * @returns {string}
     */
    toast(recovered) {
      if (recovered.length !== 1) return `Kept your changes from closed tabs in ${recovered.length} recovered notes.`;
      const [{ title, trashed }] = recovered;
      const kept = `Kept your changes to “${toastTitle(title)}” from a closed tab in a recovered note.`;
      return trashed ? `${kept} Both are in the Trash.` : kept;
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
   * Remove what `noteIds` left here, as a note's permanent delete does: their drafts, and their
   * IDs among the recovered notes no new tab has told about. Never throws.
   * @param {Storage|undefined} storage
   * @param {Array<string>} noteIds
   * @returns {number} how many drafts it removed
   */
  function clearNotes(storage, noteIds) {
    const ids = new Set(noteIds);
    let removed = 0;
    for (const { key, draft } of list(storage)) {
      if (!ids.has(draft.noteId)) continue;
      remove(storage, key);
      removed += 1;
    }
    const entries = untold(storage);
    const kept = entries.filter((entry) => !ids.has(entry.id));
    if (kept.length !== entries.length) setUntold(storage, kept);
    return removed;
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
   * Rule 2, content first: the draft's edit is already stored
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
      const copy = stored.get(id);
      if (copy && copy.canvasId === draft.noteId) return false;
    }
    return typeof draft.name !== 'string' || original.name === draft.name;
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
   * Rule 3's exception: the draft holds no text to recover. It changed no block and didn't
   * rename the note, so all it did was delete blocks.
   * @param {any} original
   * @param {CloseDraft} draft
   * @returns {boolean}
   */
  function onlyDeletes(original, draft) {
    return draft.blocks.length === 0 && !renamed(original, draft);
  }

  /**
   * Apply one draft, in one readwrite transaction (rules 1 to 4)
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
      if (indexed) scope.push('search_index');
      if (linked) scope.push('links');
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
        let waiting = 1 + ids.length + (linked ? 1 : 0);

        const decide = () => {
          if (!original) {
            outcome = { kind: 'gone' };
            return;
          }
          if (alreadyIn(original, stored, draft)) {
            outcome = { kind: 'dropped' };
            return;
          }
          if (savedElsewhere(original, draft)) {
            // Only deletes: there's no text to recover, and the blocks it meant to delete stay
            if (onlyDeletes(original, draft)) {
              outcome = { kind: 'dropped' };
              return;
            }
            const stillThere = draft.deletedBlockIds.filter((id) => {
              const copy = stored.get(id);
              return copy && copy.canvasId === draft.noteId;
            }).length;
            const { note, blocks } = recoveredNote(original, draft, { now, stillThere, trashDays });
            notes.add(note);
            for (const block of blocks) elements.add(block);
            if (indexed) tx.objectStore('search_index').put({ noteId: note.id, name: note.name, content: '', updatedAt: now });
            outcome = { kind: 'recovered', recoveredId: note.id };
            return;
          }
          const note = savedNote(original, draft, now);
          notes.put(note);
          for (const block of draft.blocks) {
            const copy = stored.get(block.id);
            // No block moves notes: one stored under another note stays there
            if (copy && copy.canvasId !== draft.noteId) continue;
            elements.put({ ...block, canvasId: draft.noteId });
          }
          for (const id of draft.deletedBlockIds) {
            const copy = stored.get(id);
            if (copy && copy.canvasId === draft.noteId) elements.delete(id);
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
        const { kind, recoveredId } = await applyOne(db, draft, { now: now(), trashDays: days });
        if (kind === 'kept') {
          result.kept.push(draft.noteId);
          continue;
        }
        if (kind === 'recovered') {
          const entry = { noteId: draft.noteId, recoveredId: String(recoveredId) };
          result.recovered.push(entry);
          setUntold(drafts, [...untold(drafts), { id: entry.recoveredId, of: entry.noteId }]);
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
    takeUntold,
    fingerprint,
    digest,
    recoveredNote,
    apply,
    pageStorage,
  });
})();

/** @type {any} */ (globalThis).CloseDrafts = CloseDrafts;
