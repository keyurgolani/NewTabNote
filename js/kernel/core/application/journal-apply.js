/**
 * The pages' apply of editor saves (#35 slice 3b, the lead's S1 call on #182): each
 * `saveNoteContent` entry a closed page left in `NewTabNoteJournal` (domain/journal.js), sent
 * through this page's kernel as the close-time draft it holds, `applyCloseDraft` under
 * `<opId>-apply`, oldest first, so #33's rules decide it as they decide a draft from localStorage
 * (close-drafts.js): dropped when the note holds it already, saved where its blocks are as the
 * page saw them commit, and one recovered note where another writer changed them since. The key
 * is the one #33's applier uses, so an apply under way stays idempotent and #17's ledger answers
 * one that committed already. It runs under DRAFTS_LOCK, which every delete for good takes too,
 * so of two pages starting together the second finds each entry the first applied gone.
 *
 * It runs at a page's start once the journal's chunk (composition/journal-chunk.js) finds an
 * entry for it, from the `close-drafts-chunk` chunk, which the page's start loads anyway to apply
 * its close-time drafts (composition/close-drafts-applier.js), so a start with nothing to apply
 * loads none of it.
 *
 * - It takes the entries of pages whose owner lock is free, and leaves its own page's, a live
 *   page's, every one when it can't tell which pages are alive, and each that isn't an editor
 *   save with a draft at this build's version: those are the worker's to replay or keep
 *   (journal-drain.js), or a newer build's. It leaves one the worker holds, under a tombstone the
 *   sweep keeps for, by the code on its mark (the lead's answer to Q6).
 * - It leaves an entry that a close-time draft still to apply names, by its page, pane and note
 *   (#6). That draft holds everything the pane changed within its load of the note, and its apply
 *   takes the pane's entries for it (close-drafts.js, `forget`), so the entry waits for it. A page
 *   already open when the closing page went runs this before any start applies the draft, and the
 *   entry, applied first, could only make a recovered note of its older text. Once no draft names
 *   it, it's applied as before.
 * - A pane's save carries everything the pane changed since its last commit within its load of
 *   the note, and a pane's id lasts one load, so an entry a later one from the same page's pane,
 *   of the same note, covers is removed first, unapplied (R182's S2): its older text could only
 *   make a recovered note. Later is by the page's own count of its entries, which a clock
 *   stepped back doesn't change.
 * - What each answer does with its entry: committed, it goes, and a recovered note, or a save
 *   into a note in the Trash, is told for the next new tab's toast, as a draft's is. The note gone
 *   (`close-draft-gone`): it stays for the worker's sweep, which tells a tombstone it deletes for
 *   from one it keeps for, as a page can't (the lead's yes on 3b's plan). A refusal,
 *   `unavailable`, or no answer: it stays for the next start.
 * - An entry whose draft the applier can't read is written back without it, so the worker keeps
 *   the save it travels beside as a conflict record, with its text (the lead's pick on 3b's plan).
 *
 * Once it leaves an entry to the worker, it wakes the drain (`wake`). Nothing here touches a
 * browser API: the ports come in.
 */

import { isId, isRecord } from '../contracts/checks.js';
import { DRAFTS_LOCK, recoveredIdOf } from '../domain/close-draft-keys.js';
import { isCloseDraft } from '../domain/close-draft.js';
import { isPagesSave } from '../domain/journal.js';

/** @typedef {import('../domain/journal.js').JournalRecord} JournalRecord */
/** @typedef {import('../domain/close-draft.js').CloseDraft} CloseDraft */
/** @typedef {import('../ports/journal.js').JournalStore} JournalStore */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('./close-drafts.js').DraftClient} DraftClient */
/** @typedef {import('./close-drafts.js').DraftLocks} DraftLocks */
/** @typedef {import('./close-drafts.js').DraftStore} DraftStore */

/**
 * What a start's apply of the journal's editor saves did, by note id
 * @typedef {object} JournalApplyResult
 * @property {string[]} saved - saved into their notes
 * @property {string[]} savedInTrash - saved into notes in the Trash, told about by the next new tab
 * @property {Array<{noteId: string, recoveredId: string}>} recovered - each entry's recovered note
 * @property {string[]} dropped - nothing to write
 * @property {string[]} caughtUp - nothing to write but the record's preview and to-do progress
 * @property {string[]} gone - deleted for good since, whose entries stay for the worker's sweep
 * @property {string[]} kept - not applied at this start, so the entry stays for the next
 */

/**
 * @typedef {object} JournalApplyPorts
 * @property {JournalStore} journal
 * @property {DraftClient} client - the page's kernel, once it's ready
 * @property {() => Promise<ReadonlySet<string> | null>} liveOwners
 *   The sessions whose owner lock is held now, or null when that can't be told
 * @property {string} sessionId - this page's own, whose entries its journaling removes
 * @property {DraftLocks | null} [locks]
 * @property {Pick<DraftStore, 'list' | 'tell' | 'tellSaved'>} store - the close-time drafts still to
 *   apply, and the untold lists the new tab's toasts read
 * @property {() => void} wake - wakes the worker's drain
 */

/**
 * Whether `later` covers `entry`: one the same page's pane wrote of the same note after it, by the
 * page's own count of its entries rather than the journal's order, which goes by the page's clock
 * first, with a draft the applier reads
 * @param {JournalRecord} later
 * @param {JournalRecord} entry
 */
const covers = (later, entry) =>
  later.pane !== undefined &&
  later.pane === entry.pane &&
  later.ownerSessionId === entry.ownerSessionId &&
  later.noteId === entry.noteId &&
  later.seq > entry.seq &&
  isCloseDraft(later.draft);

/**
 * Whether `draft` names `entry`: an editor save of the draft's note from its page's pane, which
 * the draft's apply takes (forgetCovered, by the same fields)
 * @param {CloseDraft} draft - one that names its page and pane
 * @param {JournalRecord} entry
 */
const names = (draft, entry) =>
  entry.noteId === draft.noteId &&
  entry.pane === draft.pane &&
  isRecord(entry.draft) &&
  entry.draft.page === draft.page;

/**
 * Applies the editor saves closed pages left in `journal`. It rejects only when the journal does,
 * and an entry it hadn't removed then stays for the next start.
 * @param {JournalApplyPorts} ports
 * @returns {Promise<JournalApplyResult>}
 */
export async function applyJournalSaves({ journal, client, liveOwners, sessionId, locks = null, store, wake }) {
  /** @type {JournalApplyResult} */
  const result = { saved: [], savedInTrash: [], recovered: [], dropped: [], caughtUp: [], gone: [], kept: [] };
  const run = async () => {
    const live = await liveOwners();
    // Without them, any entry could be an open page's
    if (!live) return result;
    const listed = (await journal.list()).filter(
      entry => isPagesSave(entry) && entry.ownerSessionId !== sessionId && !live.has(entry.ownerSessionId),
    );
    // An entry that a close-time draft still to apply names waits for that draft, whose apply takes it
    const pending = listed.length > 0 ? store.list().filter(({ draft }) => isId(draft.page) && isId(draft.pane)) : [];
    const saves = listed.filter(entry => !pending.some(({ draft }) => names(draft, entry)));
    /** @type {string[]} */
    const covered = [];
    /** @type {JournalRecord[]} */
    const unreadable = [];
    /** @type {Array<{entry: JournalRecord, draft: CloseDraft}>} */
    const applying = [];
    saves.forEach(entry => {
      const { draft } = entry;
      if (!isCloseDraft(draft)) unreadable.push(entry);
      else if (saves.some(later => covers(later, entry))) covered.push(entry.opId);
      else applying.push({ entry, draft });
    });
    if (covered.length > 0) await journal.remove(covered);
    let woke = false;
    for (const entry of unreadable) {
      const bare = { ...entry };
      delete bare.draft;
      await journal.put(bare);
      woke = true;
    }
    for (const { entry, draft } of applying) {
      const outcome = /** @type {Outcome} */ (
        await client.execute({ type: 'applyCloseDraft', commandId: `${entry.opId}-apply`, draft })
      );
      const { noteId } = draft;
      if (outcome.kind !== 'committed') {
        result.kept.push(noteId);
        continue;
      }
      if (outcome.code === 'close-draft-gone') {
        result.gone.push(noteId);
        woke = true;
        continue;
      }
      if (outcome.code === 'close-draft-recovered') {
        const recoveredId = recoveredIdOf(draft);
        result.recovered.push({ noteId, recoveredId });
        store.tell({ id: recoveredId, of: noteId });
      } else if (outcome.code === 'close-draft-saved-in-trash') {
        result.savedInTrash.push(noteId);
        store.tellSaved(noteId);
      } else if (outcome.code === 'close-draft-saved') result.saved.push(noteId);
      else if (outcome.code === 'close-draft-caught-up') result.caughtUp.push(noteId);
      else result.dropped.push(noteId);
      await journal.remove([entry.opId]);
    }
    if (woke) wake();
    return result;
  };
  return locks ? locks.request(DRAFTS_LOCK, { mode: 'exclusive' }, run) : run();
}
