/**
 * The start-time catch-up (#33, 1.4.3): a note's record and what a deleted note left, brought
 * in line with the blocks at a new tab's start.
 *
 * - A closing tab saves its last edit's blocks without the note's record (the editor's closing
 *   write, js/storage.js saveNoteWithBlocks), so the record's preview, to-do progress and links
 *   can lag the blocks. The catch-up gives such a record what its blocks give, as the editor's
 *   save derives it: the preview and to-do progress (SidebarUtils.buildNoteSaveMetadata) and the
 *   links (Utils.extractWikiLinks over the editor's text). It never writes the name, and never
 *   moves updatedAt, which the close-time drafts' newer-note rule reads.
 * - A note deleted for good can leave records that name it: blocks, media, its vector and
 *   snapshots, each naming exactly one note. The catch-up removes those, in readwrite
 *   transactions that first read each note's record and remove nothing of a note that's there.
 *   Its link rows stay, as the delete itself leaves them, and its search entry goes at the next
 *   new tab's index rebuild.
 *
 * It runs twice:
 * - right after the close-time drafts (js/close-drafts.js), for the notes their apply named:
 *   a draft already in the blocks (dropped) and a note deleted for good (gone). Popup and the
 *   Side Panel apply drafts too, and pass those note IDs to the next new tab (remember), which
 *   catches them up with its own. Only IDs are kept, never text;
 * - at idle, as a full pass over every note: at the first start with it, then once its last
 *   run is more than seven days old (recordsCheckedAt). It catches what no draft named. An
 *   orphan whose blocks changed in the last ten minutes waits for a later pass.
 *
 * What it writes is a record's preview and to-do progress, a note's links, and the deletes. It
 * logs counts, never text.
 */
const StartCatchUp = (function initStartCatchUp() {
  'use strict';

  /** The note IDs a Popup or Side Panel start's drafts named, for the next new tab */
  const PENDING_KEY = 'ntn-start-catch-up:notes';
  /** The setting that holds when the full pass last ran */
  const CHECKED_SETTING = 'recordsCheckedAt';
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  /** How recently an orphan's blocks may have changed and still wait for a later full pass */
  const GRACE_MS = 10 * 60 * 1000;
  /** Notes read, and deleted notes swept, per transaction in the full pass, so no one holds the blocks long */
  const BATCH = 50;
  /** The stores that name one note each, besides its blocks: [store, index or null for the key] */
  const NAMED = [['media', 'canvasId'], ['vectors', null], ['snapshots', 'noteId']];

  // ─── The pending IDs ───

  /** @returns {Storage|undefined} this page's localStorage, when it has one */
  function pageStorage() {
    try {
      return typeof localStorage === 'undefined' ? undefined : localStorage;
    } catch {
      return undefined;
    }
  }

  /**
   * The note IDs waiting for a new tab's catch-up
   * @param {Storage|undefined} storage
   * @returns {{dropped: Array<string>, gone: Array<string>}}
   */
  function pending(storage) {
    try {
      const value = JSON.parse((storage && storage.getItem(PENDING_KEY)) || '{}');
      const strings = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []);
      return { dropped: strings(value.dropped), gone: strings(value.gone) };
    } catch {
      return { dropped: [], gone: [] };
    }
  }

  /**
   * @param {Storage|undefined} storage
   * @param {{dropped: Array<string>, gone: Array<string>}} ids
   */
  function setPending(storage, { dropped, gone }) {
    try {
      if (dropped.length > 0 || gone.length > 0) storage.setItem(PENDING_KEY, JSON.stringify({ dropped, gone }));
      else storage.removeItem(PENDING_KEY);
    } catch {
      // Without it the weekly pass catches these notes up
    }
  }

  /**
   * Keep the notes a Popup or Side Panel start's drafts named for the next new tab. Never throws.
   * @param {any} result - CloseDrafts.apply's, or nothing when it failed
   * @param {Storage|undefined} [storage]
   */
  function remember(result, storage = pageStorage()) {
    if (!result || !storage) return;
    const dropped = Array.isArray(result.dropped) ? result.dropped : [];
    const gone = Array.isArray(result.gone) ? result.gone : [];
    if (dropped.length === 0 && gone.length === 0) return;
    const now = pending(storage);
    setPending(storage, {
      dropped: [...new Set([...now.dropped, ...dropped])],
      gone: [...new Set([...now.gone, ...gone])],
    });
  }

  /**
   * Drop `noteIds` from the waiting IDs: once a new tab caught them up, and on a note's
   * permanent delete, as its drafts are. Never throws.
   * @param {Storage|undefined} storage
   * @param {Array<string>} noteIds
   */
  function forget(storage, noteIds) {
    if (!storage) return;
    const drop = new Set(noteIds);
    const now = pending(storage);
    const left = { dropped: now.dropped.filter((id) => !drop.has(id)), gone: now.gone.filter((id) => !drop.has(id)) };
    if (left.dropped.length !== now.dropped.length || left.gone.length !== now.gone.length) setPending(storage, left);
  }

  // ─── Reading and writing ───

  /** @param {IDBRequest} request */
  const answer = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  /** @param {IDBTransaction} tx */
  const finished = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('The catch-up transaction was aborted'));
  });

  /**
   * The editor's text of a note's blocks, as its save reads wiki links from it (BlockEditor
   * getAllBlocksTextContent), or null where the page has no editor
   * @returns {((blocks: Array<any>) => string)|null}
   */
  function editorText() {
    const Editor = /** @type {any} */ (globalThis).BlockEditor;
    if (typeof Editor !== 'function' || typeof document === 'undefined') return null;
    const proto = Editor.prototype;
    const reader = { doc: document, stripHtmlTags: proto.stripHtmlTags, extractBlockTextContent: proto.extractBlockTextContent };
    return (blocks) => proto.getAllBlocksTextContent.call(reader, blocks);
  }

  /**
   * The notes a wiki link can point at, as updateNoteLinks finds them (getAllNotes(true)):
   * neither trashed nor a template, the newest first
   * @param {Array<any>} notes
   */
  function linkTargets(notes) {
    return notes
      .filter((n) => !n.trashed && !n.isTemplate)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || (String(b.id) < String(a.id) ? -1 : 1));
  }

  /**
   * What `blocks` give `note`, and whether its record and links differ from it. A note whose
   * blocks can't be read (a block import let in that the editor can't read, say) is `failed`,
   * and nothing of it is written.
   * @param {any} note
   * @param {Array<any>} blocks
   * @param {Array<any>} links - its stored links
   * @param {{textOf: ((blocks: Array<any>) => string)|null, targets: Array<any>}} context
   * @returns {{record: any, links: Array<string>|null, failed?: boolean}}
   */
  function derive(note, blocks, links, context) {
    try {
      return deriveFrom(note, blocks, links, context);
    } catch {
      return { record: null, links: null, failed: true };
    }
  }

  /**
   * derive's work, which throws on blocks it can't read
   * @param {any} note
   * @param {Array<any>} blocks
   * @param {Array<any>} links
   * @param {{textOf: ((blocks: Array<any>) => string)|null, targets: Array<any>}} context
   * @returns {{record: any, links: Array<string>|null}}
   */
  function deriveFrom(note, blocks, links, { textOf, targets }) {
    const ordered = blocks.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const derived = { record: null, links: null };
    const Sidebar = /** @type {any} */ (globalThis).SidebarUtils;
    if (Sidebar) {
      const meta = Sidebar.buildNoteSaveMetadata(ordered);
      const todo = note.todoProgress === undefined ? null : note.todoProgress;
      if (meta.preview !== (note.preview || '') || JSON.stringify(meta.todoProgress) !== JSON.stringify(todo)) {
        derived.record = { ...note, preview: meta.preview, todoProgress: meta.todoProgress };
      }
    }
    if (textOf && links && typeof Utils !== 'undefined') {
      const wanted = new Set();
      for (const name of Utils.extractWikiLinks(textOf(ordered))) {
        const lower = String(name).toLowerCase();
        const target = targets.find((n) => n.name && String(n.name).toLowerCase() === lower);
        if (target && target.id !== note.id) wanted.add(target.id);
      }
      const stored = new Set(links.map((link) => link.toNoteId));
      if (wanted.size !== stored.size || [...wanted].some((id) => !stored.has(id))) derived.links = [...wanted];
    }
    return derived;
  }

  /**
   * Catch one note's record and links up with its blocks, in one readwrite transaction that
   * reads them all first. A note that's gone is left to the sweep.
   * @param {IDBDatabase} db
   * @param {string} noteId
   * @param {{textOf: ((blocks: Array<any>) => string)|null, targets: Array<any>, now: () => number}} context
   * @returns {Promise<'wrote'|'unchanged'|'skipped'>} whether it wrote anything, or skipped a
   *   note whose blocks it can't read
   */
  async function rebuildNote(db, noteId, context) {
    const linked = Boolean(context.textOf) && db.objectStoreNames.contains('links');
    const tx = db.transaction(linked ? ['canvases', 'elements', 'links'] : ['canvases', 'elements'], 'readwrite');
    const done = finished(tx);
    const noteRead = tx.objectStore('canvases').get(noteId);
    const blocksRead = tx.objectStore('elements').index('canvasId').getAll(noteId);
    const linksRead = linked ? tx.objectStore('links').index('fromNoteId').getAll(noteId) : null;
    /** @type {'wrote'|'unchanged'|'skipped'} */
    let outcome = 'unchanged';
    // Requests in one transaction answer in order, so all three are in when the last is
    (linksRead || blocksRead).addEventListener('success', () => {
      const note = noteRead.result;
      if (!note) return;
      const textOf = linked ? context.textOf : null;
      const derived = derive(note, blocksRead.result, linksRead ? linksRead.result : null, { ...context, textOf });
      if (derived.failed) {
        outcome = 'skipped';
        return;
      }
      if (derived.record) {
        tx.objectStore('canvases').put(derived.record);
        outcome = 'wrote';
      }
      if (derived.links) {
        // The targets are from before this transaction: resolve against the notes as stored
        // now, read in it, so a note made or renamed since counts as it would for a save
        const notesRead = tx.objectStore('canvases').getAll();
        notesRead.addEventListener('success', () => {
          const current = derive(note, blocksRead.result, linksRead.result, { textOf, targets: linkTargets(notesRead.result) });
          if (!current.links) return;
          const store = tx.objectStore('links');
          for (const link of linksRead.result) store.delete(link.id);
          for (const toNoteId of current.links) {
            store.add({ id: Utils.generateId(), fromNoteId: noteId, toNoteId, createdAt: context.now() });
          }
          outcome = 'wrote';
        });
      }
    });
    await done;
    return outcome;
  }

  /**
   * rebuildNote, counted into `result`. A note whose rebuild fails is skipped and counted, and
   * the rest go on.
   * @param {IDBDatabase} db
   * @param {string} noteId
   * @param {{textOf: ((blocks: Array<any>) => string)|null, targets: Array<any>, now: () => number}} context
   * @param {{rebuilt: number, skipped: number}} result
   */
  async function rebuildCounted(db, noteId, context, result) {
    try {
      const outcome = await rebuildNote(db, noteId, context);
      if (outcome === 'wrote') result.rebuilt += 1;
      else if (outcome === 'skipped') result.skipped += 1;
    } catch {
      result.skipped += 1;
    }
  }

  /**
   * Remove what notes deleted for good left: their blocks, media, vectors and snapshots. One
   * readwrite transaction reads each note's record first and removes nothing of a note that's
   * there. With `graceMs`, a note whose blocks changed that recently is left for later.
   * @param {IDBDatabase} db
   * @param {Array<string>} noteIds
   * @param {{now: () => number, graceMs?: number}} options
   * @returns {Promise<number>} how many records it removed
   */
  async function sweep(db, noteIds, { now, graceMs = 0 }) {
    if (noteIds.length === 0) return 0;
    const named = NAMED.filter(([store]) => db.objectStoreNames.contains(store));
    const tx = db.transaction(['canvases', 'elements', ...named.map(([store]) => store)], 'readwrite');
    const done = finished(tx);
    const cutoff = graceMs > 0 ? now() - graceMs : Infinity;
    let removed = 0;
    for (const noteId of noteIds) {
      const noteRead = tx.objectStore('canvases').get(noteId);
      const blocksRead = tx.objectStore('elements').index('canvasId').getAll(noteId);
      blocksRead.addEventListener('success', () => {
        if (noteRead.result) return;
        const blocks = blocksRead.result;
        if (blocks.some((b) => typeof b.updatedAt === 'number' && b.updatedAt > cutoff)) return;
        const elements = tx.objectStore('elements');
        for (const b of blocks) elements.delete(b.id);
        removed += blocks.length;
        for (const [name, index] of named) {
          const store = tx.objectStore(name);
          const keysRead = index ? store.index(index).getAllKeys(noteId) : store.getAllKeys(noteId);
          keysRead.addEventListener('success', () => {
            for (const key of keysRead.result) store.delete(key);
            removed += keysRead.result.length;
          });
        }
      });
    }
    await done;
    return removed;
  }

  /** @param {IDBDatabase} db */
  async function everyNote(db) {
    return answer(db.transaction('canvases', 'readonly').objectStore('canvases').getAll());
  }

  /**
   * Catch up the notes a start's drafts named: rebuild the dropped ones, sweep the gone ones
   * @param {{db: IDBDatabase, dropped?: Array<string>, gone?: Array<string>,
   *   textOf?: ((blocks: Array<any>) => string)|null, now?: () => number}} options
   * @returns {Promise<{rebuilt: number, removed: number, skipped: number}>}
   */
  async function catchUp({ db, dropped = [], gone = [], textOf = editorText(), now = Date.now }) {
    const result = { rebuilt: 0, removed: 0, skipped: 0 };
    if (!db || !db.objectStoreNames.contains('canvases') || !db.objectStoreNames.contains('elements')) return result;
    const rebuild = [...new Set(dropped)];
    if (rebuild.length > 0) {
      const targets = linkTargets(await everyNote(db));
      for (const noteId of rebuild) await rebuildCounted(db, noteId, { textOf, targets, now }, result);
    }
    result.removed = await sweep(db, [...new Set(gone)], { now });
    if (result.rebuilt > 0 || result.removed > 0 || result.skipped > 0) {
      console.info(`Start catch-up: ${result.rebuilt} note(s) caught up, ${result.skipped} skipped, ${result.removed} record(s) of deleted notes removed`);
    }
    return result;
  }

  /** Distinct note IDs the orphan scan reads per transaction, so no one read holds a store long */
  const SCAN_BATCH = 500;

  /**
   * The distinct note IDs a store's records name, by its index, or its keys, SCAN_BATCH per
   * readonly transaction. A note made between two of them is safe: the sweep reads every
   * candidate's record again in its own transaction.
   * @param {IDBDatabase} db
   * @param {string} name
   * @param {string|null} index
   * @returns {Promise<Array<IDBValidKey>>}
   */
  async function namedIds(db, name, index) {
    const keys = [];
    let after = null;
    for (;;) {
      const store = db.transaction(name, 'readonly').objectStore(name);
      const range = after === null ? null : IDBKeyRange.lowerBound(after, true);
      const batch = await new Promise((resolve, reject) => {
        const found = [];
        const cursor = index ? store.index(index).openKeyCursor(range, 'nextunique') : store.openKeyCursor(range);
        cursor.onsuccess = () => {
          if (!cursor.result || found.length >= SCAN_BATCH) {
            resolve(found);
            return;
          }
          found.push(cursor.result.key);
          cursor.result.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
      keys.push(...batch);
      if (batch.length < SCAN_BATCH) return keys;
      after = batch[batch.length - 1];
    }
  }

  /**
   * The full pass: every note's record and links against its blocks, read BATCH notes per
   * transaction, then what no note's record names any more, scanned SCAN_BATCH IDs and swept
   * BATCH notes per transaction. A note whose blocks can't be read is skipped and counted.
   * @param {{db: IDBDatabase, textOf?: ((blocks: Array<any>) => string)|null, now?: () => number}} options
   * @returns {Promise<{rebuilt: number, removed: number, skipped: number, notes: number}>}
   */
  async function fullPass({ db, textOf = editorText(), now = Date.now }) {
    const result = { rebuilt: 0, removed: 0, skipped: 0, notes: 0 };
    if (!db || !db.objectStoreNames.contains('canvases') || !db.objectStoreNames.contains('elements')) return result;
    const notes = await everyNote(db);
    result.notes = notes.length;
    const targets = linkTargets(notes);
    const linked = Boolean(textOf) && db.objectStoreNames.contains('links');

    const lagging = [];
    for (let at = 0; at < notes.length; at += BATCH) {
      const batch = notes.slice(at, at + BATCH);
      const tx = db.transaction(linked ? ['elements', 'links'] : ['elements'], 'readonly');
      const reads = batch.map((n) => Promise.all([
        answer(tx.objectStore('elements').index('canvasId').getAll(n.id)),
        linked ? answer(tx.objectStore('links').index('fromNoteId').getAll(n.id)) : Promise.resolve(null),
      ]));
      const answered = await Promise.all(reads);
      batch.forEach((n, i) => {
        const [blocks, links] = answered[i];
        const derived = derive(n, blocks, links, { textOf: linked ? textOf : null, targets });
        if (derived.failed) result.skipped += 1;
        else if (derived.record || derived.links) lagging.push(n.id);
      });
    }
    for (const noteId of lagging) await rebuildCounted(db, noteId, { textOf, targets, now }, result);

    const known = new Set(notes.map((n) => n.id));
    const named = NAMED.filter(([store]) => db.objectStoreNames.contains(store));
    const lists = [await namedIds(db, 'elements', 'canvasId')];
    for (const [store, index] of named) lists.push(await namedIds(db, store, index));
    const orphans = /** @type {Array<string>} */ ([...new Set(lists.flat())].filter((id) => typeof id === 'string' && !known.has(id)));
    // A deleting transaction per BATCH orphans too, for the same reason
    for (let at = 0; at < orphans.length; at += BATCH) {
      result.removed += await sweep(db, orphans.slice(at, at + BATCH), { now, graceMs: GRACE_MS });
    }

    console.info(`Start catch-up, full pass: ${result.notes} note(s) read, ${result.rebuilt} caught up, ${result.skipped} skipped, ${result.removed} record(s) of deleted notes removed`);
    return result;
  }

  /**
   * Whether the full pass is due: never run, last run more than seven days ago, or last run in
   * the future, as a clock set back would have it
   * @param {unknown} checkedAt
   * @param {number} now
   */
  function due(checkedAt, now) {
    return typeof checkedAt !== 'number' || now - checkedAt > WEEK_MS || checkedAt > now;
  }

  return Object.freeze({
    PENDING_KEY,
    CHECKED_SETTING,
    pageStorage,
    pending,
    remember,
    forget,
    catchUp,
    fullPass,
    due,
  });
})();

/** @type {any} */ (globalThis).StartCatchUp = StartCatchUp;
