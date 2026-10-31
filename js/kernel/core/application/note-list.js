/**
 * The note-list projection (#12, "State ownership"): one per new tab, in place of the copies
 * of the note lists App and its controllers kept. It loads every note, folder, and search
 * entry with one getNoteList read, then follows this tab's commit feed: the notes each
 * commit names are read again with getNotesByIds, and a folder commit reads the folders
 * again, with any notes it names. Other contexts' changes reach it only through reload(), as 1.4.x's lists reached
 * them only through a refresh.
 *
 * A note filed in a folder that isn't stored is listed at the root: 1.4.x's deleteFolder left
 * trashed notes and templates on the folders it deleted, so once restored no list showed them.
 * The stored record keeps its folderId; the list hands out a copy with null.
 *
 * Reads run one at a time, in the order they were asked for, so an older reload never lands
 * over a newer change, and the note ids commits publish within one task are read together.
 * Its views list notes in the order Storage lists them (domain/note.js notesInView). Every
 * record, view, and list it hands out is frozen, and stays as it was when handed out: a
 * change replaces records, it never edits one. A reader that needs to change one changes a
 * copy.
 *
 * It's host-neutral: it takes the kernel client's query, subscribe, and whenReady, and
 * nothing else, so the node tests run it over the memory and legacy adapters.
 */

import { isId, isRecord } from '../contracts/checks.js';
import { failed } from '../contracts/outcomes.js';
import { NOTE_VIEWS, notesInView } from '../domain/note.js';
import { silentLogger } from '../ports/runtime.js';

/** @typedef {import('../domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../domain/note.js').NoteView} NoteView */
/** @typedef {import('../domain/note.js').SearchEntry} SearchEntry */
/** @typedef {import('../domain/folder.js').FolderRecord} FolderRecord */
/** @typedef {import('../contracts/outcomes.js').Failed} Failed */
/** @typedef {import('../ports/runtime.js').Logger} Logger */
/** @typedef {import('./kernel.js').KernelClient} KernelClient */
/** @typedef {import('./feed.js').CommitEvent} CommitEvent */

/**
 * What the projection reads through: the kernel client's calls, as a composition root hands
 * them out
 * @typedef {object} NoteListPorts
 * @property {KernelClient['query']} query
 * @property {KernelClient['subscribe']} subscribe
 * @property {KernelClient['whenReady']} whenReady
 * @property {Logger} [logger] - told when a read or a listener fails, with codes and never content
 */

/**
 * What a change says. `reload` read everything again. `commit` read what this tab's commits
 * changed, the notes in `ids` and maybe the folders. `search` read search entries again for
 * #22's indexer, which writes them outside the kernel: the notes in `ids`, or every entry
 * and nothing else when `ids` is empty.
 * @typedef {Readonly<{version: number, reason: 'reload' | 'commit' | 'search', ids: readonly string[]}>} NoteListChange
 */

/**
 * - loading: the kernel isn't ready, or the first read hasn't answered
 * - ready / empty: the lists as of `asOf`; empty when there's no note and no folder
 * - stale: the lists as of `asOf`, while a commit waits to be read or after a read failed
 * - failed: the first read failed, or the kernel didn't start, so there are no lists
 * @typedef {{kind: 'loading'} | {kind: 'ready', asOf: number} | {kind: 'empty', asOf: number}
 *   | {kind: 'stale', asOf: number} | Failed} NoteListState
 */

/** @typedef {(change: NoteListChange) => unknown} NoteListListener */

/**
 * @typedef {object} NoteList
 * @property {() => NoteListState} state
 * @property {(name: NoteView) => readonly Readonly<NoteRecord>[]} view
 *   A view's notes, in the order Storage lists it: `active` as getAllNotes, `withArchived` as
 *   getAllNotes(true), `archived`, `trashed`, and `templates` as their Storage reads
 * @property {(noteId: string) => Readonly<NoteRecord> | undefined} note - whatever list the note is in
 * @property {() => readonly Readonly<FolderRecord>[]} folders - in key order, as Storage.getAllFolders
 * @property {(noteId: string) => Readonly<SearchEntry> | undefined} searchEntry
 * @property {() => readonly Readonly<SearchEntry>[]} searchEntries
 * @property {(listener: NoteListListener) => () => void} subscribe
 *   Calls `listener` once per change, after the change applies. Returns the unsubscribe function.
 * @property {() => Promise<NoteListState>} reload
 *   Reads everything again, after any read already asked for, for a write made outside the
 *   kernel or another tab's change. Listeners hear of it only when it found something the
 *   list didn't hold. Resolves once the read applied and those listeners settled. A listener
 *   must not wait for it.
 * @property {(ids: readonly string[] | 'all') => Promise<void>} searchEntriesChanged
 *   #22's indexer wrote these notes' search entries, or all of them, outside the kernel: they
 *   are read again, the notes with them for ids, and every entry with listSearchEntries for
 *   'all', which reads no note. Resolves once the read applied, without waiting for
 *   listeners, so a listener may call it.
 * @property {() => Promise<void>} settled
 *   Resolves once no read is waiting or running and every change's listeners settled. A
 *   listener must not wait for it.
 */

/** @type {readonly never[]} */
const NONE = Object.freeze(/** @type {never[]} */ ([]));

/** @type {NoteListState} */
const LOADING = Object.freeze({ kind: 'loading' });

/**
 * @param {unknown} value
 * @returns {boolean} whether it's an array or a plain object, from any realm
 */
function isPlain(value) {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/**
 * `value`, with it and every array and plain object in it frozen. A read's answer is a copy
 * nothing else holds, so freezing it changes no one else's object.
 * @template T
 * @param {T} value
 * @returns {Readonly<T>}
 */
function deepFreeze(value) {
  if (!isPlain(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const field of Object.values(/** @type {object} */ (value))) deepFreeze(field);
  return value;
}

/** How many times in a row a failed read of changes is tried again before it waits for the next commit */
const MAX_RETRIES = 3;

/**
 * Whether two values a read answered hold the same data: the same primitives, and arrays and
 * plain objects with the same entries, in any realm
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (!isPlain(a) || !isPlain(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = /** @type {Record<string, unknown>} */ (a);
  const right = /** @type {Record<string, unknown>} */ (b);
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/**
 * @param {unknown} value
 * @returns {value is NoteRecord}
 */
const isNote = value => isRecord(value) && isId(value.id);

/**
 * @param {unknown} value
 * @returns {value is SearchEntry}
 */
const isEntry = value => isRecord(value) && isId(value.noteId);

/**
 * @param {NoteListPorts} ports
 * @returns {NoteList}
 */
export function createNoteList({ query, subscribe, whenReady, logger = silentLogger }) {
  /** @type {Map<string, Readonly<NoteRecord>>} */
  const notes = new Map();
  /** @type {Map<string, Readonly<SearchEntry>>} */
  const entries = new Map();
  /** @type {readonly Readonly<FolderRecord>[]} */
  let folders = NONE;
  let version = 0;
  let asOf = 0;
  let loaded = false;
  /** @type {Failed | null} The first read's failure, until a read succeeds */
  let failure = null;
  // A reload that failed after the first read: the lists are stale until a reload succeeds
  let reloadFailed = false;
  // A read of changes that failed: what it was to read waits, and is read again
  let changesFailed = false;
  let retries = 0;

  // What commits and the indexer changed, waiting for the next read of changes
  /** @type {Set<string>} */
  const changedNotes = new Set();
  /** @type {Set<string>} */
  const changedEntries = new Set();
  let foldersChanged = false;
  // A read of changes taken from those sets is running
  let readingCommits = false;

  /** The one read queue: every read starts after the one before it has applied */
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  let queued = 0;
  let drainScheduled = false;
  /** @type {Promise<void> | null} A read of changes that's queued and hasn't started */
  let changesQueued = null;

  /** @type {Set<NoteListListener>} */
  const listeners = new Set();
  /** @type {Set<Promise<unknown>>} */
  const notifying = new Set();

  /** @type {Map<NoteView, readonly Readonly<NoteRecord>[]>} */
  let views = new Map();
  /** @type {Map<string, Readonly<NoteRecord>> | null} The notes as listed, by id: filed at the root when their folder is gone */
  let listed = null;
  /** @type {readonly Readonly<SearchEntry>[] | null} */
  let entryList = null;

  /**
   * @param {string} event
   * @param {Record<string, unknown>} detail
   */
  const report = (event, detail) => {
    try {
      logger.warn(event, detail);
    } catch {
      // A logger that fails changes nothing the list holds
    }
  };

  /**
   * Run `job` after every read asked for before it.
   * @template T
   * @param {() => Promise<T>} job
   * @returns {Promise<T | undefined>}
   */
  const enqueue = job => {
    queued += 1;
    const run = tail.then(job).then(
      result => {
        queued -= 1;
        return result;
      },
      error => {
        queued -= 1;
        report('note-list-read-failed', { error });
        return undefined;
      },
    );
    tail = run;
    return run;
  };

  /**
   * A new version, and each listener told of it. Answers a promise of the listeners settling,
   * which no queued read waits for: a listener may ask for a read, and that read must not wait
   * for the listener (see Settling).
   * @param {NoteListChange['reason']} reason
   * @param {readonly string[]} ids
   * @returns {Promise<unknown>}
   */
  const changed = (reason, ids) => {
    version += 1;
    views = new Map();
    listed = null;
    entryList = null;
    /** @type {NoteListChange} */
    const change = Object.freeze({ version, reason, ids: Object.freeze([...ids]) });
    /** @type {unknown[]} */
    const results = [];
    for (const listener of [...listeners]) {
      try {
        results.push(listener(change));
      } catch (error) {
        report('note-list-listener-failed', { reason, error });
      }
    }
    const done = Promise.allSettled(results).then(settledResults => {
      for (const result of settledResults) {
        if (result.status === 'rejected') report('note-list-listener-failed', { reason, error: result.reason });
      }
    });
    notifying.add(done);
    done.then(() => notifying.delete(done));
    return done;
  };

  /**
   * A read that didn't answer with data. Before the first read succeeds there are no lists;
   * after, the last good ones stay, as stale.
   * @param {import('../contracts/outcomes.js').QueryState<unknown>} state
   * @param {string} type
   */
  const readDidNotAnswer = (state, type) => {
    const why = state.kind === 'failed' ? state : failed('storage', 'not-ready');
    report('note-list-read-failed', { query: type, cause: why.cause, code: why.code });
    if (!loaded) failure = why;
  };

  /**
   * What a queued read answers: whether it changed the lists, and its listeners settling,
   * wrapped so the queue never waits for them
   * @typedef {{changed: boolean, done: Promise<unknown> | null}} Settling
   */

  /** @type {Settling} */
  const UNCHANGED = Object.freeze({ changed: false, done: null });

  /**
   * Read every note, folder, and search entry. What commits named before it started is in
   * what it finds. When it finds what the list already holds, nothing changes and no
   * listener hears of it, so a reload that finds nothing new renders nothing.
   * @returns {Promise<Settling>}
   */
  const readAll = async () => {
    const takenNotes = [...changedNotes];
    const takenEntries = [...changedEntries];
    const takenFolders = foldersChanged;
    changedNotes.clear();
    changedEntries.clear();
    foldersChanged = false;
    const state = await query({ type: 'getNoteList' });
    if (state.kind !== 'ready' && state.kind !== 'stale' && state.kind !== 'empty') {
      // What it was to read waits for the next read
      for (const id of takenNotes) changedNotes.add(id);
      for (const id of takenEntries) changedEntries.add(id);
      foldersChanged = foldersChanged || takenFolders;
      readDidNotAnswer(state, 'getNoteList');
      if (loaded) reloadFailed = true;
      return UNCHANGED;
    }
    const data = state.kind === 'empty' ? { notes: [], folders: [], searchEntries: [] } : state.data;
    const wasLoaded = loaded;
    asOf = state.asOf;
    loaded = true;
    failure = null;
    reloadFailed = false;
    // What it took, from commits or the indexer, is in what it read, so a read of changes that
    // failed on it has nothing left to read
    if (takenNotes.length > 0 || takenEntries.length > 0 || takenFolders) {
      changesFailed = false;
      retries = 0;
    }
    const readNotes = data.notes.filter(isNote);
    const readEntries = data.searchEntries.filter(isEntry);
    if (wasLoaded && sameAsHeld(readNotes, data.folders, readEntries)) return UNCHANGED;
    notes.clear();
    for (const note of readNotes) notes.set(note.id, deepFreeze(note));
    entries.clear();
    for (const entry of readEntries) entries.set(entry.noteId, deepFreeze(entry));
    folders = deepFreeze([...data.folders]);
    return { changed: true, done: changed('reload', NONE) };
  };

  /**
   * Whether a full read found exactly what the list holds
   * @param {NoteRecord[]} readNotes
   * @param {FolderRecord[]} readFolders
   * @param {SearchEntry[]} readEntries
   * @returns {boolean}
   */
  const sameAsHeld = (readNotes, readFolders, readEntries) =>
    readNotes.length === notes.size &&
    readEntries.length === entries.size &&
    readNotes.every(note => sameValue(note, notes.get(note.id))) &&
    readEntries.every(entry => sameValue(entry, entries.get(entry.noteId))) &&
    sameValue(readFolders, folders);

  /**
   * Read every search entry again, and nothing else, for #22's indexer, which wrote them
   * outside the kernel
   * @returns {Promise<Settling>}
   */
  const readSearchEntries = async () => {
    if (!loaded) return UNCHANGED;
    const state = await query({ type: 'listSearchEntries' });
    if (state.kind !== 'ready' && state.kind !== 'stale' && state.kind !== 'empty') {
      readDidNotAnswer(state, 'listSearchEntries');
      return UNCHANGED;
    }
    const read = (state.kind === 'empty' ? [] : state.data).filter(isEntry);
    if (read.length === entries.size && read.every(entry => sameValue(entry, entries.get(entry.noteId)))) {
      return UNCHANGED;
    }
    entries.clear();
    for (const entry of read) entries.set(entry.noteId, deepFreeze(entry));
    return { changed: true, done: changed('search', NONE) };
  };

  /**
   * Read what commits and the indexer named since the last read, if anything: the notes with
   * getNotesByIds, and the folders with listFolders. A read that fails puts what it was to
   * read back, and is tried again, up to MAX_RETRIES times in a row; after that the next
   * commit or reload reads it.
   * @returns {Promise<Settling>}
   */
  const readChanges = async () => {
    changesQueued = null;
    const fromCommits = changedNotes.size > 0 || foldersChanged;
    const takenNotes = [...changedNotes];
    const takenEntries = [...changedEntries];
    const noteIds = [...new Set([...takenNotes, ...takenEntries])];
    const withFolders = foldersChanged;
    changedNotes.clear();
    changedEntries.clear();
    foldersChanged = false;
    if (noteIds.length === 0 && !withFolders) return UNCHANGED;
    // Before the first read there's nothing to change; the first read finds all of it
    if (!loaded) return UNCHANGED;
    readingCommits = fromCommits;
    let applied = false;
    let failedRead = false;
    try {
      if (noteIds.length > 0) {
        const state = await query({ type: 'getNotesByIds', noteIds });
        if (state.kind === 'ready' || state.kind === 'stale' || state.kind === 'empty') {
          const found = state.kind === 'empty' ? { notes: [], searchEntries: [] } : state.data;
          /** @type {Set<string>} */
          const foundIds = new Set();
          for (const note of found.notes) {
            if (!isNote(note)) continue;
            notes.set(note.id, deepFreeze(note));
            foundIds.add(note.id);
          }
          /** @type {Set<string>} */
          const withEntry = new Set();
          for (const entry of found.searchEntries) {
            if (!isEntry(entry)) continue;
            entries.set(entry.noteId, deepFreeze(entry));
            withEntry.add(entry.noteId);
          }
          // A note that's gone leaves the lists, and one with no entry has none
          for (const id of noteIds) {
            if (!foundIds.has(id)) notes.delete(id);
            if (!withEntry.has(id)) entries.delete(id);
          }
          asOf = state.asOf;
          applied = true;
        } else {
          // What it was to read waits for the next read
          for (const id of takenNotes) changedNotes.add(id);
          for (const id of takenEntries) changedEntries.add(id);
          readDidNotAnswer(state, 'getNotesByIds');
          failedRead = true;
        }
      }
      if (withFolders) {
        const state = await query({ type: 'listFolders' });
        if (state.kind === 'ready' || state.kind === 'stale' || state.kind === 'empty') {
          folders = deepFreeze(state.kind === 'empty' ? [] : [...state.data]);
          asOf = state.asOf;
          applied = true;
        } else {
          foldersChanged = true;
          readDidNotAnswer(state, 'listFolders');
          failedRead = true;
        }
      }
    } finally {
      readingCommits = false;
    }
    if (failedRead) {
      changesFailed = true;
      if (retries < MAX_RETRIES) {
        retries += 1;
        queueChanges();
      }
    } else {
      changesFailed = false;
      retries = 0;
    }
    if (!applied) return UNCHANGED;
    return { changed: true, done: changed(fromCommits ? 'commit' : 'search', noteIds) };
  };

  /**
   * A read of changes, queued unless one is queued and hasn't started, which takes what's
   * named by then
   * @returns {Promise<void>}
   */
  const queueChanges = () => {
    if (!changesQueued) changesQueued = enqueue(readChanges).then(() => undefined);
    return /** @type {Promise<void>} */ (changesQueued);
  };

  /**
   * The ids one task's commits publish are read together: the read is queued in a microtask,
   * once the task's own code has run
   */
  const scheduleDrain = () => {
    if (drainScheduled) return;
    drainScheduled = true;
    Promise.resolve().then(() => {
      drainScheduled = false;
      queueChanges();
    });
  };

  subscribe(({ aggregate, ids }) => {
    if (aggregate === 'note') {
      for (const id of ids) if (isId(id)) changedNotes.add(id);
      if (changedNotes.size === 0) return;
    } else if (aggregate === 'folder') {
      foldersChanged = true;
      // A folder commit can name notes too: deleteFolder names the notes it filed at the root.
      // The lists hold every stored note, so an id they hold no note under is a folder's.
      for (const id of ids) if (isId(id) && notes.has(id)) changedNotes.add(id);
    } else {
      // Snapshots, jobs, preferences, and the session aren't in the lists
      return;
    }
    scheduleDrain();
  });

  // The first read, once the kernel is ready. Commits before it are in what it finds.
  enqueue(async () => {
    const unavailable = await whenReady();
    if (unavailable) {
      failure = failed(unavailable.cause, unavailable.code);
      return;
    }
    await readAll();
  });

  /**
   * The notes as the lists show them: each as stored, except one whose folder isn't stored,
   * which is listed at the root
   * @returns {Map<string, Readonly<NoteRecord>>}
   */
  const shown = () => {
    if (!listed) {
      const filedIn = new Set(folders.map(folder => folder.id));
      listed = new Map();
      for (const [id, note] of notes) {
        const lost = typeof note.folderId === 'string' && !filedIn.has(note.folderId);
        listed.set(id, lost ? deepFreeze({ ...note, folderId: null }) : note);
      }
    }
    return listed;
  };

  /** @returns {NoteListState} */
  const state = () => {
    if (!loaded) return failure ? { ...failure } : LOADING;
    if (reloadFailed || changesFailed || readingCommits || changedNotes.size > 0 || foldersChanged || drainScheduled) {
      return { kind: 'stale', asOf };
    }
    return notes.size === 0 && folders.length === 0 ? { kind: 'empty', asOf } : { kind: 'ready', asOf };
  };

  return Object.freeze({
    state,

    view(name) {
      if (!NOTE_VIEWS.includes(name)) throw new TypeError(`No note view is called ${String(name)}`);
      let inView = views.get(name);
      if (!inView) {
        inView = Object.freeze(notesInView([...shown().values()], name));
        views.set(name, inView);
      }
      return inView;
    },

    note: noteId => shown().get(noteId),

    folders: () => folders,

    searchEntry: noteId => entries.get(noteId),

    searchEntries() {
      if (!entryList) entryList = Object.freeze([...entries.values()]);
      return entryList;
    },

    subscribe(listener) {
      const entry = /** @type {NoteListListener} */ (change => listener(change));
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },

    async reload() {
      const settling = await enqueue(readAll);
      // Outside the queue, so a listener that asks for a read doesn't wait on itself
      if (settling && settling.done) await settling.done;
      return state();
    },

    async searchEntriesChanged(ids) {
      if (ids === 'all') {
        await enqueue(readSearchEntries);
        return;
      }
      for (const id of ids) if (isId(id)) changedEntries.add(id);
      if (changedEntries.size === 0) return;
      await queueChanges();
    },

    async settled() {
      for (;;) {
        const last = tail;
        await last;
        await Promise.allSettled([...notifying]);
        // A drain a listener scheduled queues its read in a microtask
        await Promise.resolve();
        if (last === tail && queued === 0 && !drainScheduled && notifying.size === 0) return;
      }
    },
  });
}
