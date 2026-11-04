/**
 * What the coordinator's journal drain asks of the worker's kernel (#35 slice 3,
 * application/journal-drain.js), beside the journaled commands it replays: which of the notes
 * its entries name were deleted for good (findTombstones), and keeping an entry it can't replay
 * as a #17 conflict record (keepJournalEntry), so nothing the user typed is lost. Only the
 * worker runs either (`worker-internal`).
 *
 * A kept entry's record has the conflict record's shape (adapters/indexeddb/conflicts.js),
 * `{id, noteId, scope, expected, current, at, command}`: under the entry's opId, its note's id
 * or null, `content`, no version it expected, the note's content revision now (0 for none),
 * and the command the entry held. #6's conflict view shows it with the rest, an export holds it
 * with its note's, and deleting that note for good deletes it (#17 PR 2b). A record already
 * kept under that opId stays as it is.
 */

import { isId, isIdList, isRecord } from '../contracts/checks.js';
import { committed, empty, failed, ready, rejected } from '../contracts/outcomes.js';
import { invalid } from './notes.js';
import { unitsWork } from './work.js';

/** @typedef {import('../ports/repository.js').Unit} Unit */

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/**
 * @template {import('../contracts/queries.js').QueryType} T
 * @typedef {import('./work.js').QueryHandler<T>} QueryHandler
 */

/** @type {{keepJournalEntry: CommandHandler<'keepJournalEntry'>}} */
export const journalCommands = {
  keepJournalEntry(command, { clock }) {
    const { opId, noteId, command: entry } = command;
    if (!isId(opId) || (noteId !== undefined && !isId(noteId)) || !isRecord(entry)) return invalid();
    const now = clock.now();
    let kept = false;
    /** @type {Unit} */
    const keep = {
      stores: ['notes', 'conflicts'],
      async run(tx) {
        // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
        kept = false;
        // Below version 10 there's nowhere to keep it, so the entry stays in the journal
        if (!tx.has('conflicts')) return rejected('not-found', 'conflicts-unavailable');
        if (await tx.get('conflicts', opId)) return;
        let current = 0;
        if (noteId !== undefined && (await tx.get('notes', noteId))) {
          current = tx.versions('notes', noteId)?.revision ?? 0;
        }
        tx.put('conflicts', {
          id: opId,
          noteId: noteId ?? null,
          scope: 'content',
          expected: null,
          current,
          at: now,
          command: entry,
        });
        kept = true;
      },
    };
    return unitsWork(command, [keep], () =>
      kept ? committed('journal-entry-kept', []) : committed('journal-entry-kept-before', [], { severity: 'info' }),
    );
  },
};

/** @type {{findTombstones: QueryHandler<'findTombstones'>}} */
export const journalQueries = {
  // The tombstones the notes' deletes for good left (domain/tombstone.js), ids and reasons only.
  // A database below version 10 has none, so none of its notes reads as deleted.
  async findTombstones({ noteIds }, { adapter, clock }) {
    if (!isIdList(noteIds)) return failed('validation', 'invalid-query');
    const wanted = [...new Set(noteIds)];
    // Each read is asked for before any answers, so a long list costs one round of requests
    const found = await adapter.read(['tombstones'], tx =>
      Promise.all(
        wanted.map(async id => ({
          id,
          tombstone: await tx.get('tombstones', /** @type {string} */ (/** @type {unknown} */ (['note', id]))),
        })),
      ),
    );
    /** @type {Array<{id: string, reason: string}>} */
    const tombstones = [];
    for (const { id, tombstone } of found) {
      if (tombstone && typeof tombstone.reason === 'string') tombstones.push({ id, reason: tombstone.reason });
    }
    return tombstones.length > 0 ? ready(clock.now(), { tombstones }) : empty(clock.now());
  },
};
