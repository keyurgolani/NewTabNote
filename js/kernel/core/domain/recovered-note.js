/**
 * The recovered note (#33, the stack's close-time PR): where a close-time draft's residue goes
 * when it can't be saved into its note (close-draft.js, rule 3). Its look, words and placement
 * are 1.4.3's, as the Design gate approved them (R0's js/close-drafts.js: recoveredNote,
 * explanation and TEXT), in one place:
 * - its title, "Recovered: {title} ({date})", with no-break spaces in the date, stored as set by
 *   hand, so auto-title leaves it;
 * - a callout first, which says what it is and names the original once, in its first sentence,
 *   then copies of the residue's blocks under `${recoveredId}-1` onward, in their order;
 * - the rename-only words for a residue that's only a name (V6), the deletes sentence, and the
 *   Trash's words with its keeping time;
 * - beside the original: in its folder while that folder exists, with its pin unless the
 *   original is a template or in the Trash, archived with an archived original and in the Trash
 *   with a trashed one, and with the original's times less 1 ms, so it sorts right under it by
 *   Recent and by Created. It's never a Daily Note or a template itself.
 * The dates are en-US, as every date the stack shows on a note is until one PR localizes them
 * all (the lead's Q8), in the clock's zone.
 *
 * The words the new tab's toast says once a start made recovered notes, or saved closing edits
 * into notes in the Trash (V3), are here too, for the toast to show.
 */

import { newNoteRecord, noteSaveMetadata } from './note.js';
import { withNewPlacement } from './placement.js';
import { recoveredIdOf, renames, titleOf } from './close-draft.js';

/** @typedef {import('./note.js').NoteRecord} NoteRecord */
/** @typedef {import('./note.js').BlockRecord} BlockRecord */
/** @typedef {import('./close-draft.js').CloseDraft} CloseDraft */
/** @typedef {import('./close-draft.js').Residue} Residue */

/**
 * `text` as a block's HTML content that shows it as it is, as 1.4.3 escapes the callout
 * @param {string} text
 * @returns {string}
 */
const escapeHtml = text =>
  String(text).replace(/[&<>"]/g, char => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

/**
 * "Oct 31, 9:41 PM", as a block's metadata reads, with no-break spaces, so the title's date
 * wraps as one unit
 * @param {number} at
 * @param {string} timeZone
 * @returns {string}
 */
export const shortTime = (at, timeZone) =>
  new Date(at)
    .toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone })
    .replace(/\s/g, '\u00a0');

/**
 * "Oct 31, 2026 at 9:41 PM", as Utils.formatTimestamp writes it
 * @param {number} at
 * @param {string} timeZone
 * @returns {string}
 */
export function longTime(at, timeZone) {
  const date = new Date(at);
  const day = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone }).format(date);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).format(date);
  return `${day} at ${time}`;
}

/** @param {number} count */
const days = count => `${count} ${count === 1 ? 'day' : 'days'}`;

/**
 * What the recovered note is made from, besides the residue
 * @typedef {object} Making
 * @property {number} now
 * @property {string} zone - the clock's time zone
 * @property {number} trashDays - the Trash's keeping time from this start, 0 for Never
 * @property {boolean} inFolder - whether the original's folder exists
 */

/**
 * The callout's words, as HTML. They name the original once, in the first sentence, and call it
 * that note, that template or that Daily Note after it. A residue that's only a name gets the
 * words for a new name the note never saved.
 * @param {NoteRecord} original
 * @param {Residue} residue
 * @param {CloseDraft} draft
 * @param {Making} making
 * @returns {string}
 */
function explanation(original, residue, draft, { zone, trashDays }) {
  let kind = 'note';
  if (original.isTemplate) kind = 'template';
  else if (original.isDaily) kind = 'Daily Note';
  const stillThere = residue.deletedBlockIds.length;
  const deletes = [];
  if (stillThere === 1) deletes.push('That tab also deleted a block, which is still in that note.');
  else if (stillThere > 1) deletes.push(`That tab also deleted ${stillThere} blocks, which are still in that note.`);
  // The Trash's own keeping time from this start, none when it keeps notes until it's emptied
  const keeping = trashDays > 0 ? ` Otherwise the Trash deletes it in ${days(trashDays)}.` : '';
  const title = `“${titleOf(original)}”`;
  const closed = longTime(draft.at, zone);
  if (residue.blocks.length === 0) {
    return escapeHtml(
      [
        `A tab that closed on ${closed} renamed ${title} to “${residue.name}” before the new name was saved.`,
        original.trashed
          ? 'That note is in the Trash, so NewTabNote kept the new name here and put this note in the Trash too.'
          : `That ${kind} was saved elsewhere too, so NewTabNote kept the new name here and left it as it is.`,
        ...deletes,
        original.trashed
          ? `Restore this note to keep the new name.${keeping}`
          : `To use the new name, rename that ${kind}, then delete this one.`,
      ].join(' '),
    );
  }
  const sentences = [`These changes to ${title} are from a tab that closed on ${closed}, before they were saved.`];
  if (original.trashed) {
    sentences.push('That note is in the Trash, so NewTabNote kept the changes here and put this note in the Trash too.');
  } else if (kind === 'note') {
    sentences.push('That note was saved elsewhere too, so NewTabNote kept the changes here and left it as it is.');
  } else {
    sentences.push(`That ${kind} was saved elsewhere too, so NewTabNote kept the changes here as a regular note and left it as it is.`);
  }
  sentences.push('Below are only the blocks that tab changed.', ...deletes);
  if (renames(original, residue.name)) sentences.push(`That tab also renamed it “${residue.name}”.`);
  sentences.push(
    original.trashed ? `Restore this note to keep them.${keeping}` : `Copy what you need into that ${kind}, then delete this one.`,
  );
  return escapeHtml(sentences.join(' '));
}

/**
 * The recovered note for `draft`'s residue over `original`, and its blocks: an ordinary note, as
 * createNote makes one, under recoveredIdOf(draft), with its preview and to-do progress made
 * from its blocks, as a save makes them
 * @param {NoteRecord} original - the draft's note, as stored
 * @param {Residue} residue
 * @param {CloseDraft} draft
 * @param {Making} making
 * @returns {{note: NoteRecord, blocks: BlockRecord[]}}
 */
export function recoveredNote(original, residue, draft, making) {
  const { now, inFolder } = making;
  const id = recoveredIdOf(draft);
  const trashed = Boolean(original.trashed);
  const archived = !trashed && Boolean(original.archived);
  /** @type {BlockRecord} */
  const first = {
    id: `${id}-0`,
    type: 'callout',
    content: explanation(original, residue, draft, making),
    indentLevel: 0,
    checked: false,
    imageUrl: null,
    calloutIcon: 'ℹ️',
    createdAt: now,
    updatedAt: now,
    canvasId: id,
    order: 0,
  };
  const changed = [...residue.blocks]
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    .map((block, index) => ({ ...block, id: `${id}-${index + 1}`, createdAt: now, updatedAt: now, canvasId: id, order: index + 1 }));
  const blocks = [first, ...changed];
  /** @param {unknown} at */
  const before = at => (typeof at === 'number' ? at - 1 : now);
  const made = newNoteRecord({
    id,
    name: `Recovered: ${titleOf(original)} (${shortTime(draft.at, making.zone)})`,
    now,
    folderId: inFolder && typeof original.folderId === 'string' ? original.folderId : null,
    pinned: !trashed && !original.isTemplate && Boolean(original.pinned),
    titleManuallySet: true,
  });
  // Its group follows the flags it ends with: Archive's or the Trash's beside the original's
  const note = /** @type {NoteRecord} */ (withNewPlacement({
    ...made,
    createdAt: before(original.createdAt),
    updatedAt: before(original.updatedAt),
    archived,
    archivedAt: archived && typeof original.archivedAt === 'number' ? original.archivedAt - 1 : null,
    ...noteSaveMetadata(blocks),
    viewport: { ...(original.viewport || made.viewport) },
    settings: { ...(original.settings || made.settings) },
    ...(trashed ? { trashed: true, trashedAt: now } : {}),
  }));
  return { note, blocks };
}

/**
 * @param {string} title
 * @returns {string} `title` cut at 40 characters for the toast
 */
const toastTitle = title => (title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title);

/** What the new tab's toast says of what a start's drafts did, as 1.4.3's text-only toast says it */
export const TEXT = Object.freeze({
  /**
   * The recovered notes a start made
   * @param {Array<{title: string, archived: boolean, trashed: boolean}>} recovered - each one's
   *   original's title, and whether both are in Archive or in the Trash
   * @returns {string}
   */
  recovered(recovered) {
    if (recovered.length !== 1) return `Kept your changes from closed tabs in ${recovered.length} recovered notes.`;
    const [{ title, archived, trashed }] = recovered;
    const kept = `Kept your changes to “${toastTitle(title)}” from a closed tab in a recovered note.`;
    if (trashed) return `${kept} Both are in the Trash.`;
    if (archived) return `${kept} Both are in Archive.`;
    return kept;
  },

  /**
   * The notes in the Trash a start saved closing edits into (V3): no recovered note, so the
   * toast says where the edit went
   * @param {string[]} titles
   * @returns {string}
   */
  savedInTrash(titles) {
    if (titles.length !== 1) return `Saved your changes from closed tabs to ${titles.length} notes in the Trash.`;
    return `Saved your changes to “${toastTitle(titles[0])}” from a closed tab. It's in the Trash.`;
  },
});
