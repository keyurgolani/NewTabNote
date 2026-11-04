/**
 * The service worker's capture (js/background.js): a page, or selected text and the page it came
 * from, added to the Daily Note of the day it was made, which this command finds or makes in the
 * same transaction. Only the worker sends it, so only its table holds this handler
 * (handlers-worker.js), and no page's start loads it (the lead's call for #182). It shares how
 * a Daily Note is found or made, and its template's first blocks, with ensureDailyNote
 * (notes.js).
 */

import { isId, isRecord } from '../contracts/checks.js';
import { committed, rejected } from '../contracts/outcomes.js';
import { captureBlock, dailyDateStr, dailyNoteName, newSearchEntry } from '../domain/note.js';
import { zoneOf } from '../ports/runtime.js';
import { dailyTemplateBlocks, findOrMakeDailyNote, invalid } from './notes.js';
import { contentChanged, unitsWork } from './work.js';

/** @typedef {import('../ports/repository.js').Unit} Unit */

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/**
 * @param {unknown} value
 * @returns {value is undefined | string}
 */
const isOptionalString = value => value === undefined || typeof value === 'string';

/**
 * @param {unknown} value
 * @returns {value is import('../domain/note.js').Capture}
 */
function isCapture(value) {
  if (!isRecord(value)) return false;
  if (value.type === 'bookmark') return isOptionalString(value.url) && isOptionalString(value.title);
  if (value.type === 'text') return typeof value.content === 'string' && isOptionalString(value.source);
  return false;
}

/** @type {{captureToDailyNote: CommandHandler<'captureToDailyNote'>}} */
export const captureCommands = {
  async captureToDailyNote(command, { adapter, clock, ids }) {
    const { noteId, blockId, capture, at } = command;
    if (!isId(noteId) || !isId(blockId) || !isCapture(capture)) return invalid();
    if (at !== undefined && !(Number.isSafeInteger(at) && at >= 0)) return invalid();
    // The template setting lives outside the note stores, so it's read before any unit runs
    const { dailyNoteTemplate: templateId } = await adapter.readSettings('preferences', ['dailyNoteTemplate']);
    const now = clock.now();
    // Today's, keyed and named by its local date in the clock's zone (#17 PR 3b), where 1.4.x's
    // background.js keyed it by the UTC date. Today is the day of `at`, the instant the capture
    // was made, when it says one, so a capture the drain replays later lands in its own day's
    // note (#35 slice 3); its block's times are the commit's, as any write's are
    const zone = zoneOf(clock);
    const today = at === undefined ? now : at;
    const dailyName = dailyNoteName(today, zone);
    const dailyKey = dailyDateStr(today, zone);
    let dailyId = noteId;
    let created = false;
    /** @type {Unit[]} */
    const units = [
      {
        stores: ['notes', 'dailyIndex'],
        async run(tx) {
          // The later units follow what this one decides, and each run decides afresh, since
          // an adapter may run the units again (ports/repository.js, Unit)
          dailyId = noteId;
          created = false;
          const daily = await findOrMakeDailyNote(tx, { noteId, dailyKey, name: dailyName, now, zone });
          if ('kind' in daily) return daily;
          ({ dailyId, created } = daily);
        },
      },
      {
        stores: ['searchIndex'],
        when: () => created,
        async run(tx) {
          tx.put('searchIndex', newSearchEntry({ id: noteId, name: dailyName }, now));
        },
      },
      {
        stores: ['blocks'],
        async run(tx) {
          // A capture adds a block under an id of its own, so one that's stored is refused, as
          // insertBlocks refuses it: today's Daily Note's own, or another note's, which a capture
          // never takes (R131). The record says which note holds it, where its key alone wouldn't.
          const stored = await tx.get('blocks', blockId);
          if (stored && stored.canvasId !== dailyId) return rejected('validation', 'block-of-another-note');
          if (stored) return rejected('validation', 'duplicate-block');
          // A new Daily Note starts with the Daily Note template's blocks, as in Storage.ensureDailyNote
          if (created) {
            const copies = await dailyTemplateBlocks(tx, templateId, {
              noteId,
              title: dailyName,
              now,
              nextId: () => ids.next(),
            });
            for (const block of copies) tx.put('blocks', block);
          }
          tx.put('blocks', captureBlock({ id: blockId, noteId: dailyId, capture, now }));
        },
      },
    ];
    return unitsWork(command, units, () => committed('capture-saved', [dailyId]), {
      primary: () => ({ store: 'notes', key: dailyId }),
      revised: contentChanged,
    });
  },
};
