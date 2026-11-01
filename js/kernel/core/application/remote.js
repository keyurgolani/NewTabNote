/**
 * Remote changes (#17 PR 4b, the lead's Q2): notes as another profile has them, which #19's
 * sync engine sends. Sync has never applied one: DatabaseManager never defined importNote or
 * importAll, so Keep both throws at its first importNote, before its saveElement, and a remote
 * apply finds no importAll and logs a skip (scripts/write-paths.js, UNDEFINED_WRITES). Those
 * paths stay as they are, and nothing sends these commands until #19 does.
 *
 * applyRemoteChanges takes a note at a time, so one note's conflict leaves the others to land,
 * and answers with an outcome per note, which says what each part did (noteOutcome). Each
 * note's two parts go apart, each guarded by its own version (#17, "Versions"):
 * - its content, its title and blocks (applyRemoteContent), lands only while the note is at the
 *   revision the change was made from;
 * - its placement, pinned, archived, trashed, a template, and its folder (applyRemotePlacement),
 *   only while the note is at that placement version. A trash also needs the text to be the
 *   one the change was made from, since trash leads to deletion, and a remote delete over a
 *   newer local edit keeps the note (the lead's Q2, condition 1; R131).
 * A change that says nothing it was made from counts as made from version 0, so it never lands
 * over an edit made here since #17. Otherwise that part is a conflict, which the adapter keeps
 * in `conflicts` with the part as the remote had it, the remote's text included, and the note
 * stays as it is. One that lands on a note at version 0, as 1.4.x stored it, keeps the title
 * and blocks it replaced there instead, since neither side saw the other's text. A part the
 * note already has changes nothing, whatever its version, so no resend moves a version or keeps
 * a conflict.
 *
 * A note this profile doesn't have is made as the remote has it, unless it was deleted here for
 * good: then it stays deleted, and nothing of it is kept, since a conflict record would hold its
 * text again. Nothing is deleted, since sync carries no deletes.
 */

import { isId, isIdOrNull, isRecord } from '../contracts/checks.js';
import { bulk, committed, conflict, rejected } from '../contracts/outcomes.js';
import {
  inBlockOrder,
  insertLinkText,
  isIndexKey,
  newSearchEntry,
  noteSaveMetadata,
  wikiLinkNames,
} from '../domain/note.js';
import { withNewPlacement, withPlacementGroup, withoutPlacement } from '../domain/placement.js';
import { canonical } from './scopes.js';
import {
  blockRecords,
  invalid,
  isOptionalVersion,
  noteNotFound,
  noteRecord,
  renameSearchEntry,
  replaceLinks,
  versionConflict,
} from './notes.js';
import { unitsWork } from './work.js';

/** @typedef {import('../domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../domain/note.js').BlockRecord} BlockRecord */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../contracts/outcomes.js').BulkItem} BulkItem */
/** @typedef {import('../contracts/outcomes.js').Rejected} Rejected */
/** @typedef {import('../ports/repository.js').Unit} Unit */

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/** @typedef {'applyRemoteChanges' | 'applyRemoteContent' | 'applyRemotePlacement'} RemoteCommandType */

/** The versions another profile's note carries, which are that profile's and mean nothing here */
const REMOTE_VERSIONS = Object.freeze(['revision', 'placementVersion', 'sourceRevision']);

/**
 * The fields a note's placement is, which placement commands write: each flag, with the time
 * it was set, and its folder
 */
const REMOTE_PLACEMENT_FIELDS = Object.freeze([
  'pinned',
  'archived',
  'archivedAt',
  'trashed',
  'trashedAt',
  'isTemplate',
  'folderId',
]);

/** @type {ReadonlySet<string>} */
const FLAGS = new Set(['pinned', 'archived', 'trashed', 'isTemplate']);

const noteDeleted = () => rejected('not-found', 'note-deleted');

/**
 * What a remote change is refused for before any of it runs: changes that aren't a list of
 * notes, or two changes of one note. The kernel asks before the adapter recalls the command,
 * which reserves a bulk command's key, so a refused one leaves no record (notes.js,
 * bulkRefusal).
 * @param {{changes: unknown}} command
 * @returns {Rejected | undefined}
 */
export function remoteChangesRefusal({ changes }) {
  if (!Array.isArray(changes) || changes.length === 0) return invalid();
  /** @type {Set<string>} */
  const seen = new Set();
  for (const change of changes) {
    if (!isRecord(change) || !isRecord(change.note) || !isId(change.note.id)) return invalid();
    // One change a note, so each of its parts' commandIds names one change
    if (seen.has(change.note.id)) return rejected('validation', 'duplicate-note');
    seen.add(change.note.id);
  }
  return undefined;
}

/**
 * Whether two lists of records hold the same records, by id, field for field. A record JSON
 * can't write out whole compares as different, so a part that holds one always applies.
 * @param {readonly Record<string, unknown>[]} a
 * @param {readonly Record<string, unknown>[]} b
 */
function sameRecords(a, b) {
  if (a.length !== b.length) return false;
  /** @param {readonly Record<string, unknown>[]} records */
  const byId = records => new Map(records.map(record => [record.id, canonical(record)]));
  const theirs = byId(b);
  return [...byId(a)].every(([id, text]) => text !== null && theirs.get(id) === text);
}

/**
 * A placement field's value as a note holds it: a flag a 1.4.x record lacks is false, and a
 * time or folder it lacks is null, as placement commands read them
 * @param {string} field
 * @param {unknown} value
 */
const placementValue = (field, value) => (FLAGS.has(field) ? Boolean(value) : (value ?? null));

/**
 * The placement fields `fields` names, or null for anything but a placement: another field, a
 * flag that isn't a boolean, a time that isn't one, or a folder that isn't an id or null
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, unknown> | null}
 */
function placementOf(fields) {
  for (const [field, value] of Object.entries(fields)) {
    if (!REMOTE_PLACEMENT_FIELDS.includes(field)) return null;
    if (FLAGS.has(field) && typeof value !== 'boolean') return null;
    if (field === 'folderId' && !isIdOrNull(value)) return null;
    if ((field === 'archivedAt' || field === 'trashedAt') && value !== null && !Number.isSafeInteger(value)) {
      return null;
    }
  }
  return { ...fields };
}

/**
 * The content part's code when it replaced the title and blocks of a note at version 0, as
 * 1.4.x stored it, under a change that says nothing it was made from, and kept them as a
 * conflict record (R131): a legacy replacement, which #6's conflict view tells from a conflict
 */
const REPLACED_LEGACY = 'remote-content-replaced-legacy';

/**
 * What a part's outcome adds to its note's code: `<part>-applied` for a part that changed the
 * note, `content-replaced-legacy` for a legacy replacement, `<part>-<kind>` for one that didn't
 * commit, and nothing for one that changed nothing
 * @param {'content' | 'placement'} part
 * @param {Outcome} outcome
 * @returns {string | null}
 */
function partCode(part, outcome) {
  if (outcome.kind !== 'committed') return `${part}-${outcome.kind}`;
  if (outcome.changedIds.length === 0) return null;
  return outcome.code === REPLACED_LEGACY ? 'content-replaced-legacy' : `${part}-applied`;
}

/**
 * The note's outcome in a remote change, which says what each part did (R131). With nothing
 * landed, it's the first part's that didn't commit, else the content part's. A part that landed
 * with the other doing nothing answers as itself. A part that landed beside another that did
 * something answers `committed`, so the list counts the note, with a code naming each part's in
 * order, `remote-content-conflict-placement-applied` for a pin that landed beside text that
 * didn't, say. It's a warning when part of the note went to `conflicts`.
 * @param {Outcome} content
 * @param {Outcome | undefined} placement
 * @returns {Outcome}
 */
function noteOutcome(content, placement) {
  if (!placement) return content;
  /** @type {import('../contracts/outcomes.js').Committed[]} */
  const landed = [];
  for (const part of [content, placement])
    if (part.kind === 'committed' && part.changedIds.length > 0) landed.push(part);
  if (landed.length === 0) {
    if (content.kind !== 'committed') return content;
    return placement.kind !== 'committed' ? placement : content;
  }
  const codes = [partCode('content', content), partCode('placement', placement)].filter(Boolean);
  if (codes.length === 1) return landed[0];
  const last = landed[landed.length - 1];
  const setAside = content.kind !== 'committed' || placement.kind !== 'committed' || content.code === REPLACED_LEGACY;
  return committed(`remote-${codes.join('-')}`, last.changedIds, {
    revision: last.revision,
    commitSeq: last.commitSeq,
    severity: setAside ? 'warning' : 'success',
  });
}

/** @type {{[T in RemoteCommandType]: CommandHandler<T>}} */
export const remoteCommands = {
  async applyRemoteChanges(command, { run }) {
    const refused = remoteChangesRefusal(command);
    if (refused) return refused;
    /** @type {BulkItem[]} */
    const items = [];
    for (const change of command.changes) {
      const { note, blocks, expectedRevision, expectedPlacementVersion = 0 } = change;
      const noteId = note.id;
      /** @type {Record<string, unknown>} */
      const placement = {};
      for (const field of REMOTE_PLACEMENT_FIELDS) if (note[field] !== undefined) placement[field] = note[field];
      // A note whose placement isn't one is refused whole, before either part writes anything
      if (!placementOf(placement)) {
        items.push({ id: noteId, outcome: invalid() });
        continue;
      }
      const base = `${command.commandId}:${noteId}`;
      const content = await run({
        type: 'applyRemoteContent',
        commandId: `${base}:content`,
        noteId,
        note,
        blocks,
        // None said, which counts as version 0 (applyRemoteContent)
        expectedRevision: expectedRevision ?? null,
      });
      // A note it made has the remote's placement already, and one it couldn't write has none
      // to change. Its placement is applied whatever its content met, each on its own version.
      const placing =
        content.kind === 'conflict' || (content.kind === 'committed' && content.code !== 'remote-note-created');
      // The text revision a trash lands on: the one the content part left, which holds the
      // remote's text or text the same, or, when that part conflicted, the one the change was
      // made from, which the note has moved past
      const textRevision = content.kind === 'committed' ? content.revision : (expectedRevision ?? 0);
      const placed = placing
        ? await run({
            type: 'applyRemotePlacement',
            commandId: `${base}:placement`,
            noteId,
            placement,
            expectedPlacementVersion,
            ...(textRevision === undefined ? {} : { expectedRevision: textRevision }),
          })
        : undefined;
      items.push({ id: noteId, outcome: noteOutcome(content, placed) });
    }
    return bulk('remote-changes', items);
  },

  applyRemoteContent(command, { clock, ids }) {
    const { noteId, note: remote, blocks, expectedRevision } = command;
    if (!isId(noteId) || !isRecord(remote) || remote.id !== noteId) return invalid();
    if (remote.name !== undefined && typeof remote.name !== 'string') return invalid();
    // Each part says the version it was made from, null when the change said none, which
    // counts as version 0 (applyRemoteChanges)
    if (expectedRevision === undefined) return invalid();
    if (expectedRevision !== null && !isOptionalVersion(expectedRevision)) return invalid();
    const records = blockRecords(blocks, noteId);
    if (!Array.isArray(records)) return records;
    const now = clock.now();
    /** @type {'created' | 'replaced' | 'unchanged'} */
    let result = 'unchanged';
    // Whether the text it replaced went to `conflicts`, as a legacy replacement's does
    let keptLocal = false;
    /** The names the note's wiki links hold once its blocks are the remote's */
    const linkedNames = /** @type {string[]} */ ([]);
    /** @type {Unit} */
    const apply = {
      stores: ['notes', 'blocks', 'folders', 'searchIndex', 'tombstones', 'conflicts'],
      async run(tx) {
        // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
        result = 'unchanged';
        keptLocal = false;
        linkedNames.length = 0;
        const local = await tx.get('notes', noteId);
        if (!local) {
          // Deleted here for good: its tombstone is all that's left of it, and stays so (#17 PR 2b)
          const key = /** @type {string} */ (/** @type {unknown} */ (['note', noteId]));
          if (tx.has('tombstones') && (await tx.get('tombstones', key))) return noteDeleted();
        }
        const stored = local ? await tx.getAllByIndex('blocks', 'canvasId', noteId) : [];
        const own = new Set(stored.map(block => block.id));
        for (const block of records) {
          if (own.has(block.id)) continue;
          // A block id another note's block has would take that block from it
          const found = await tx.get('blocks', block.id);
          if (found && found.canvasId !== noteId) return rejected('validation', 'block-of-another-note');
        }
        const linked = () => linkedNames.push(...wikiLinkNames(insertLinkText(inBlockOrder(records))));
        if (!local) {
          // Made as the remote has it, with this profile's versions and group, filed at the root
          // when its folder isn't here, and with a time a list can sort it by when it has none
          const { folderId } = remote;
          const filed = isId(folderId) && (await tx.get('folders', folderId)) ? folderId : null;
          const fields = withoutPlacement(/** @type {NoteRecord} */ (remote));
          for (const field of REMOTE_VERSIONS) delete fields[field];
          const createdAt = isIndexKey(fields.createdAt) ? fields.createdAt : now;
          const updatedAt = isIndexKey(fields.updatedAt) ? fields.updatedAt : now;
          const made = withNewPlacement({ ...fields, id: noteId, folderId: filed, createdAt, updatedAt });
          tx.put('notes', made);
          tx.put('searchIndex', newSearchEntry(made, now));
          for (const block of records) tx.put('blocks', block);
          linked();
          result = 'created';
          return;
        }
        const name = typeof remote.name === 'string' ? remote.name : local.name;
        // Already the note's title and blocks: nothing to apply, so no version moves
        if (name === local.name && sameRecords(stored, records)) return;
        const stale = versionConflict(tx, noteId, { expectedRevision: expectedRevision ?? 0 });
        if (stale) return stale;
        if (expectedRevision === null) {
          // A change that says nothing it was made from lands only on a note at version 0, as
          // 1.4.x stored it, though neither side saw the other's text. So the title and blocks
          // it replaces are kept as a conflict record, as a stale save's are, under this part's
          // commandId (R131). With no `conflicts` to keep them in, the change is the conflict.
          const current = tx.versions('notes', noteId)?.revision ?? 0;
          if (!tx.has('conflicts')) return conflict('revision-conflict', current);
          const mine = {
            type: 'saveNoteContent',
            commandId: command.commandId,
            noteId,
            name: local.name,
            blocks: stored,
          };
          tx.put('conflicts', {
            id: command.commandId,
            noteId,
            scope: 'content',
            expected: null,
            current,
            at: now,
            command: /** @type {any} */ (mine),
          });
          keptLocal = true;
        }
        const kept = new Set(records.map(block => block.id));
        for (const block of stored) if (!kept.has(block.id)) tx.delete('blocks', block.id);
        for (const block of records) tx.put('blocks', block);
        const { preview, todoProgress } = noteSaveMetadata(inBlockOrder(records));
        /** @type {NoteRecord} */
        const next = { ...local, name, preview, todoProgress, updatedAt: now };
        if (typeof remote.titleManuallySet === 'boolean') next.titleManuallySet = remote.titleManuallySet;
        tx.put('notes', next);
        linked();
        result = 'replaced';
      },
    };
    const changed = () => result !== 'unchanged';
    return unitsWork(
      command,
      [
        apply,
        // A replaced title goes to the search entry, as a save's does
        {
          ...renameSearchEntry(noteId, typeof remote.name === 'string' ? remote.name : '', now),
          when: () => result === 'replaced' && typeof remote.name === 'string',
        },
        // And the wiki links follow the blocks, as an insert's do
        ...replaceLinks(noteId, linkedNames, { now, nextId: () => ids.next() }).map(unit => ({
          ...unit,
          when: () => changed() && (!unit.when || unit.when()),
        })),
      ],
      () => {
        if (result === 'created') return committed('remote-note-created', [noteId]);
        if (result === 'replaced' && keptLocal) return committed(REPLACED_LEGACY, [noteId], { severity: 'warning' });
        if (result === 'replaced') return committed('remote-content-applied', [noteId]);
        return committed('remote-content-unchanged', [], { severity: 'info' });
      },
      { primary: noteRecord(noteId), revised: changed },
    );
  },

  applyRemotePlacement(command, { clock }) {
    const { noteId, placement, expectedPlacementVersion, expectedRevision } = command;
    if (!isId(noteId) || !isRecord(placement)) return invalid();
    if (expectedPlacementVersion === undefined || !isOptionalVersion(expectedPlacementVersion)) return invalid();
    if (!isOptionalVersion(expectedRevision)) return invalid();
    const fields = placementOf(placement);
    if (!fields) return invalid();
    const now = clock.now();
    let placed = false;
    /** @type {Unit} */
    const place = {
      stores: ['notes', 'folders'],
      async run(tx) {
        // Each run decides afresh, since an adapter may run the unit again (ports/repository.js, Unit)
        placed = false;
        const local = await tx.get('notes', noteId);
        if (!local) return noteNotFound();
        const wanted = { ...fields };
        // A folder this profile doesn't have, or deleted, files the note at the root
        if (isId(wanted.folderId) && !(await tx.get('folders', wanted.folderId))) wanted.folderId = null;
        const same = Object.entries(wanted).every(
          ([field, value]) => placementValue(field, local[field]) === placementValue(field, value),
        );
        // Already placed as the remote has it: nothing to apply, so no version moves
        if (same) return;
        // A trash needs the text revision the change was made from too, none said counting as
        // 0, since trash leads to deletion (the lead's Q2, condition 1; R131). A pin, an archive,
        // a template, and a folder need only the placement version.
        const trashes = wanted.trashed === true && !local.trashed;
        const stale = versionConflict(
          tx,
          noteId,
          trashes
            ? { expectedRevision: expectedRevision ?? 0, expectedPlacementVersion }
            : { expectedPlacementVersion },
        );
        if (stale) return stale;
        tx.put('notes', withPlacementGroup(local, { ...local, ...wanted, updatedAt: now }));
        placed = true;
      },
    };
    return unitsWork(
      command,
      [place],
      () =>
        placed
          ? committed('remote-placement-applied', [noteId])
          : committed('remote-placement-unchanged', [], { severity: 'info' }),
      { primary: noteRecord(noteId), scope: 'placement' },
    );
  },
};
