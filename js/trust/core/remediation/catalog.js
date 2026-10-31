/**
 * Slice 3's remediations (#20, "Remediation pipeline"), each a `remediation` contribution on
 * #15's kit (families.js) with its class, the providers it applies to, and its three steps.
 * The pipeline (pipeline.js) runs them: it plans, takes the preview, holds the class's gates,
 * protects, applies, verifies, and records, so a step here only says what it changes and does
 * it.
 *
 * - `safe-disable` (non-destructive): turns semantic search's embeddings off while local
 *   inference fails, through the preferences, and reads the setting back. Nothing is deleted:
 *   the vectors stay, and turning it on again in Settings brings them back into use.
 * - `retry-open` (non-destructive): opens storage again, then runs the providers it applies to
 *   and passes only when each one's receipt reads `verified`.
 * - `rebuild-index` (regenerable): writes the search entry of each note the app indexes (not
 *   trashed, archived, or a template) again from its blocks, as js/workers/indexer.js builds
 *   one, in batches of 100 notes, and reads back each one it planned. It removes no entry, so
 *   a search entry whose note is gone (the last trace of its title) stays.
 * - `recover-orphans` (reversible): "Recover N blocks into a new Inbox note". Blocks whose note
 *   is gone move, in one transaction, to a new untitled root note, which is where Inbox lists
 *   it (js/product/placement.js's placementOf), after a verified `pre-repair` point that holds
 *   each of them. Only their `canvasId` changes; nothing is deleted.
 * - `save-recovery-file` (non-destructive): Save as file for a restore point, a legacy copy or
 *   a verified #17 point, the `pre-repair` points a repair makes included, by its id.
 * - `save-salvage-file` (non-destructive): the salvage file (salvage-file.js).
 * - `export-diagnostics` (non-destructive, slice 4a): the diagnostic report the user
 *   previewed (diagnostics.export's answer, which the view holds), never built again, so the
 *   file is exactly what they read. With no previewed report it doesn't run.
 * All three save through the picker and verify by reading the file back (saved-file.js), and
 * answer how much they saved.
 * - `remove-saved-key` (secret-removal, slice 4a): "Remove saved keys". Its preview lists each
 *   place a legacy plaintext secret is kept and what stops working without it, it waits for
 *   the confirmation of that preview, and it removes only the entries it lists (the AI key,
 *   the WebDAV password, the 1.1 `settings` row), never a note or a row the user made. No
 *   typed phrase and no recovery file: a secret never goes into a file. It verifies by asking
 *   the reader again.
 *
 * Nothing shipped registers these: no root has a `recovery.run` handler until slice 4.
 */

import { UnavailableError, committed, rejected } from '../../../kernel/core/contracts/outcomes.js';
import { newNoteRecord, newSearchEntry } from '../../../kernel/core/domain/note.js';
import * as v from '../../../lib/valibot/index.mjs';
import { reportSchema } from '../diagnostics.js';
import { PROVIDERS } from '../providers/catalog.js';
import { SECRET_PLACES, SECRET_STOPS } from './preview.js';
import { buildRestorePointFile, buildSalvage } from './salvage-file.js';
import { readBack, readBackText, writeFile, writeText } from './saved-file.js';

/** @typedef {import('./ports.js').RemediationPorts} RemediationPorts */
/** @typedef {import('./preview.js').Preview} Preview */
/** @typedef {import('../records.js').Incident} Incident */
/** @typedef {import('../../../kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../../kernel/core/ports/repository.js').Work} Work */
/** @typedef {import('../../../kernel/core/domain/note.js').NoteRecord} NoteRecord */
/** @typedef {import('../../../kernel/core/domain/note.js').BlockRecord} BlockRecord */

/**
 * What every step gets: the ports, the time and new ids, the run, the incident it answers,
 * and what it acts on
 * @typedef {object} RemediationContext
 * @property {RemediationPorts} ports
 * @property {{now(): number}} clock
 * @property {{next(): string}} ids
 * @property {string} runId
 * @property {Incident | null} incident
 * @property {string | null} subjectId
 */

/**
 * What preview answers: the preview the user sees, the plan apply takes, and whether there's
 * nothing to do
 * @typedef {{preview: Preview, plan: unknown, nothingToDo?: boolean}} Previewed
 */

/**
 * A remediation's steps. `protects` names the records a reversible run's recovery point must
 * hold, by store, and `phrase` the words an irreversible one is confirmed by.
 * @typedef {object} RemediationSteps
 * @property {(context: RemediationContext) => Promise<Previewed>} preview
 * @property {(context: RemediationContext, plan: any) => Promise<unknown>} apply
 * @property {(context: RemediationContext, applied: any) => Promise<Verdict>} verify
 * @property {(plan: any) => Readonly<Record<string, readonly string[]>>} [protects]
 * @property {string} [phrase]
 * @property {boolean} [recordOptional] - a non-destructive run that changes no stored record goes on when its run record won't write
 * @property {boolean} [takesSubject] - it acts on one subject the payload names, which keys its lock; no other remediation takes one
 * @property {(context: RemediationContext, plan: any) => string | readonly string[] | null} [destroys]
 *   What it destroys, which the pipeline holds it to: for an irreversible one, the legacy
 *   copy's key, the point's id, or the record's id, whose rows its recovery file must hold;
 *   for a secret removal, the saved-key places it removes, which its preview must list
 */

/**
 * What verify answers: passed, passed short of everything (`saved-partial`, naming what
 * couldn't be read), or failed with its code. A pass may say how much a saved file holds
 * (`saved`), and name the note the run made (`noteId`).
 * A secret removal names the places it removed and kept, either way.
 * @typedef {{ok: true, outcome?: 'saved-partial', unreadable?: import('./salvage-file.js').Unreadable[], saved?: import('../records.js').Saved, noteId?: string, removed?: string[], kept?: string[], unknown?: string[]}
 *   | {ok: false, code: string, unreadable?: import('./salvage-file.js').Unreadable[], fileMayBeEmpty?: boolean, removed?: string[], kept?: string[], unknown?: string[]}} Verdict
 */

/** What an apply answers when the user closed the picker: not a failure, and nothing changed */
export const CANCELLED_BY_USER = Object.freeze({ cancelledByUser: true });

/** How many notes one rebuild transaction writes the entries of */
export const REBUILD_BATCH = 100;

/**
 * A port the run needs, or `not-applicable` when its root didn't pass it
 * @template {keyof RemediationPorts} K
 * @param {RemediationContext} context
 * @param {K} name
 * @returns {NonNullable<RemediationPorts[K]>}
 */
function port(context, name) {
  const value = context.ports[name];
  if (!value) throw new UnavailableError('adapter', 'not-applicable', false);
  return /** @type {NonNullable<RemediationPorts[K]>} */ (value);
}

/**
 * Commits `work`, or throws its outcome's code
 * @param {KernelAdapter} adapter
 * @param {Work} work
 */
async function commitOrThrow(adapter, work) {
  const { outcome } = await adapter.commit(work);
  if (outcome.kind === 'committed') return outcome;
  if (outcome.kind === 'unavailable') throw new UnavailableError(outcome.cause, outcome.code, outcome.retryable);
  if (outcome.kind === 'rejected' && outcome.code === 'preview-changed') {
    throw new UnavailableError('storage', 'preview-changed', true);
  }
  throw new UnavailableError('storage', 'apply-failed', true);
}

/** @param {number} n */
const one = n => ({ creates: 0, updates: n, deletes: 0 });

// ============ safe-disable ============

/** The preferences each provider's safe-disable turns off */
const SWITCHES = Object.freeze({ 'local-inference': Object.freeze({ embeddingsEnabled: false }) });

/** @param {RemediationContext} context */
const switchesFor = context => {
  const providerId = context.incident ? context.incident.providerId : 'local-inference';
  const values = /** @type {Record<string, Readonly<Record<string, boolean>>>} */ (SWITCHES)[providerId];
  if (!values) throw new UnavailableError('adapter', 'not-applicable', false);
  return values;
};

/** @type {RemediationSteps} */
const safeDisable = {
  async preview(context) {
    const adapter = port(context, 'adapter');
    const values = switchesFor(context);
    const stored = await adapter.readSettings('preferences', Object.keys(values));
    const changing = Object.keys(values).filter(key => stored[key] !== values[key]);
    return {
      preview: { changes: [{ target: 'preferences', ...one(changing.length) }] },
      plan: Object.fromEntries(changing.map(key => [key, values[key]])),
      nothingToDo: changing.length === 0,
    };
  },
  async apply(context, plan) {
    const adapter = port(context, 'adapter');
    const commandId = context.ids.next();
    const values = /** @type {Record<string, boolean>} */ (plan);
    await commitOrThrow(adapter, {
      commandId,
      command: /** @type {any} */ ({ type: 'setPreferences', commandId, values }),
      effect: { kind: 'settings', area: 'preferences', values },
      done: () => committed('preferences-saved', Object.keys(values)),
    });
    return values;
  },
  async verify(context, applied) {
    const values = /** @type {Record<string, boolean>} */ (applied);
    const stored = await port(context, 'adapter').readSettings('preferences', Object.keys(values));
    return Object.keys(values).every(key => stored[key] === values[key]) ? { ok: true } : { ok: false, code: 'not-verified' };
  },
};

// ============ retry-open ============

/** The providers a retry of storage runs again */
const RETRY_PROVIDERS = Object.freeze(['storage', 'capture']);

/** @type {RemediationSteps} */
const retryOpen = {
  recordOptional: true,
  async preview(context) {
    port(context, 'storage');
    return { preview: { changes: [] }, plan: null };
  },
  async apply(context) {
    const reopened = await port(context, 'storage').reopen();
    if (reopened.ok === false) throw new UnavailableError('storage', reopened.code, true);
    return null;
  },
  async verify(context) {
    const checks = context.ports.checks;
    if (!checks) return { ok: false, code: 'not-verified' };
    const providerIds = context.incident ? [context.incident.providerId] : [...RETRY_PROVIDERS];
    const statuses = await checks(providerIds);
    return providerIds.every(id => statuses[id] === 'verified') ? { ok: true } : { ok: false, code: 'not-verified' };
  },
};

// ============ rebuild-index ============

/**
 * A note's search entry, as js/workers/indexer.js's buildNoteEntry makes it from the note and
 * its blocks in the order the `canvasId` index gives them
 * @param {NoteRecord} note
 * @param {readonly BlockRecord[]} blocks
 */
export function searchEntryOf(note, blocks) {
  const content = blocks
    .map(block => block.content || '')
    .join(' ')
    .replace(/<[^>]*>?/gm, '');
  const text = `${content} ${note.name || ''}`;
  const tags = new Set();
  for (const match of text.matchAll(/#([\w-]+)/g)) tags.add(match[1].toLowerCase());
  return {
    noteId: note.id,
    name: note.name || 'Untitled',
    content,
    tags: Array.from(tags),
    updatedAt: note.updatedAt,
  };
}

/**
 * Whether a stored entry is the one `expected` would write
 * @param {unknown} stored
 * @param {ReturnType<typeof searchEntryOf>} expected
 */
const sameEntry = (stored, expected) => JSON.stringify(stored) === JSON.stringify(expected);

/**
 * Whether the app's indexer indexes `note`: the notes its list holds, outside trash and the
 * archive and not templates, so a rebuild and the indexer's own setSearchIndex never undo
 * each other
 * @param {NoteRecord} note
 */
const indexed = note => !note.trashed && !note.archived && !note.isTemplate;

/**
 * The entry of each note the indexer indexes, or of each of `only`, as stored and as it
 * should be
 * @param {KernelAdapter} adapter
 * @param {ReadonlySet<string>} [only]
 */
const indexState = (adapter, only) =>
  adapter.read(['notes', 'blocks', 'searchIndex'], async tx => {
    const notes = (await tx.getAll('notes')).filter(note => indexed(note) && (!only || only.has(note.id)));
    const rows = [];
    for (const note of notes) {
      const blocks = await tx.getAllByIndex('blocks', 'canvasId', note.id);
      rows.push({ noteId: note.id, stored: await tx.get('searchIndex', note.id), expected: searchEntryOf(note, blocks) });
    }
    return rows;
  });

/** @type {RemediationSteps} */
const rebuildIndex = {
  async preview(context) {
    const rows = await indexState(port(context, 'adapter'));
    const creates = rows.filter(row => row.stored === undefined).length;
    const updates = rows.filter(row => row.stored !== undefined && !sameEntry(row.stored, row.expected)).length;
    return {
      preview: { changes: [{ target: 'search_index', creates, updates, deletes: 0 }] },
      plan: rows.map(row => row.noteId),
      nothingToDo: creates + updates === 0,
    };
  },
  async apply(context, plan) {
    const adapter = port(context, 'adapter');
    const noteIds = /** @type {string[]} */ (plan);
    for (let start = 0; start < noteIds.length; start += REBUILD_BATCH) {
      const batch = noteIds.slice(start, start + REBUILD_BATCH);
      const commandId = context.ids.next();
      await commitOrThrow(adapter, {
        commandId,
        command: /** @type {any} */ ({ type: 'rebuildSearchIndex', commandId }),
        // Content scope with no `revised`: it writes only search entries, so no note's revision moves
        effect: {
          kind: 'units',
          units: [
            {
              stores: ['notes', 'blocks', 'searchIndex'],
              async run(tx) {
                for (const noteId of batch) {
                  const note = await tx.get('notes', noteId);
                  // A note deleted, trashed, archived, or made a template since the preview
                  // gets nothing written, and its old entry stays
                  if (!note || !indexed(note)) continue;
                  const blocks = await tx.getAllByIndex('blocks', 'canvasId', noteId);
                  tx.put('searchIndex', searchEntryOf(note, blocks));
                }
              },
            },
          ],
        },
        done: () => committed('search-index-rebuilt', batch),
      });
    }
    return noteIds;
  },
  async verify(context, applied) {
    // Only the notes it planned and the app still indexes: one made since has the entry its own
    // command wrote, and one trashed since kept its old entry
    const rows = await indexState(port(context, 'adapter'), new Set(/** @type {string[]} */ (applied)));
    return rows.every(row => row.stored !== undefined && sameEntry(row.stored, row.expected))
      ? { ok: true }
      : { ok: false, code: 'not-verified' };
  },
};

// ============ recover-orphans ============

/**
 * The blocks whose note isn't in the notes store, by id
 * @param {KernelAdapter} adapter
 * @returns {Promise<string[]>}
 */
const orphanIds = adapter =>
  adapter.read(['notes', 'blocks'], async tx => {
    const notes = new Set((await tx.getAll('notes')).map(note => note.id));
    return (await tx.getAll('blocks'))
      .filter(block => !notes.has(block.canvasId))
      .map(block => block.id)
      .sort();
  });

/** @type {RemediationSteps} */
const recoverOrphans = {
  async preview(context) {
    const blockIds = await orphanIds(port(context, 'adapter'));
    const notes = blockIds.length > 0 ? 1 : 0;
    return {
      preview: {
        changes: [
          { target: 'canvases', creates: notes, updates: 0, deletes: 0 },
          { target: 'elements', ...one(blockIds.length) },
          { target: 'search_index', creates: notes, updates: 0, deletes: 0 },
        ],
      },
      plan: blockIds,
      nothingToDo: blockIds.length === 0,
    };
  },
  protects: plan => ({ elements: /** @type {string[]} */ (plan) }),
  async apply(context, plan) {
    const adapter = port(context, 'adapter');
    const blockIds = /** @type {string[]} */ (plan);
    const noteId = context.ids.next();
    const commandId = context.ids.next();
    const now = context.clock.now();
    // An untitled note outside every folder, not a Daily Note or a template: Inbox lists it
    const note = newNoteRecord({ id: noteId, name: 'Untitled', now });
    await commitOrThrow(adapter, {
      commandId,
      command: /** @type {any} */ ({ type: 'recoverOrphanBlocks', commandId, noteId }),
      effect: {
        kind: 'units',
        units: [
          {
            stores: ['notes', 'blocks', 'searchIndex'],
            async run(tx) {
              if (await tx.get('notes', noteId)) return rejected('validation', 'note-exists');
              const notes = new Set((await tx.getAll('notes')).map(stored => stored.id));
              const still = (await tx.getAll('blocks'))
                .filter(block => !notes.has(block.canvasId))
                .map(block => block.id)
                .sort();
              // The blocks the user saw counted, and the recovery point holds, and no others
              if (still.length !== blockIds.length || still.some((id, index) => id !== blockIds[index])) {
                return rejected('validation', 'preview-changed');
              }
              tx.put('notes', note);
              tx.put('searchIndex', newSearchEntry(note, now));
              for (const blockId of blockIds) {
                const block = await tx.get('blocks', blockId);
                if (block) tx.put('blocks', { ...block, canvasId: noteId });
              }
            },
          },
        ],
      },
      done: () => committed('orphans-recovered', [noteId, ...blockIds]),
    });
    return { noteId, blockIds };
  },
  async verify(context, applied) {
    const { noteId, blockIds } = /** @type {{noteId: string, blockIds: string[]}} */ (applied);
    return port(context, 'adapter').read(['notes', 'blocks'], async tx => {
      const note = await tx.get('notes', noteId);
      const inbox =
        note && !note.folderId && !note.isDaily && !note.isTemplate && !note.trashed && !note.archived;
      if (!inbox) return { ok: false, code: 'not-verified' };
      for (const blockId of blockIds) {
        const block = await tx.get('blocks', blockId);
        if (!block || block.canvasId !== noteId) return { ok: false, code: 'not-verified' };
      }
      return { ok: true, noteId };
    });
  },
};

// ============ Save as file and the salvage file ============

/**
 * A file's suggested name, with the time it was saved to the second (UTC), so a second save
 * never suggests replacing the first: `newtabnote-salvage-2026-10-30T21-10-35.json`
 * @param {string} kind
 * @param {number} now
 */
export const fileName = (kind, now) =>
  `newtabnote-${kind}-${new Date(now).toISOString().slice(0, 19).replace(/:/g, '-')}.json`;

/**
 * What an apply answers when a save failed after the user picked the file: the run fails
 * with `code`, and says the chosen file may be empty
 * @param {string} code
 */
export const failedAfterPick = code => Object.freeze({ failedAfterPick: true, code });

/**
 * Apply and verify for a remediation whose action is saving the file `build` makes: the
 * picker first, inside the click's activation, then the build, the write, and the read-back
 * (saved-file.js). Verify passes `verified` only when every source read, `saved-partial` when
 * some didn't but the file holds records, and fails `nothing-readable` when it holds none
 * while any source didn't read, naming each source that didn't.
 * @param {string} kind
 * @param {(context: RemediationContext) => Promise<Record<string, unknown> & {counts: import('./salvage-file.js').FileCounts}>} build
 */
const saving = (kind, build) => ({
  /**
   * @param {RemediationContext} context
   */
  async apply(context) {
    const written = await writeFile({
      files: context.ports.files,
      suggestedName: fileName(kind, context.clock.now()),
      build: () => build(context),
    });
    if (written.status === 'cancelled') return CANCELLED_BY_USER;
    if (written.status === 'failed') {
      if (written.picked) return failedAfterPick(written.code);
      throw new UnavailableError('storage', written.code, true);
    }
    return written;
  },
  /**
   * @param {RemediationContext} context
   * @param {any} written
   * @returns {Promise<Verdict>}
   */
  async verify(context, written) {
    const read = await readBack({ files: context.ports.files, written });
    if (read.status !== 'saved') return { ok: false, code: read.code, fileMayBeEmpty: true };
    const { unreadable, held } = read.read;
    if (unreadable.length > 0 && held === 0) {
      return { ok: false, code: 'nothing-readable', unreadable, fileMayBeEmpty: true };
    }
    const saved = savedOf(read.counts, read.characters);
    if (unreadable.length > 0) return { ok: true, outcome: 'saved-partial', unreadable, saved };
    return { ok: true, saved };
  },
});

/**
 * How much a saved file holds, from its counts as it read back
 * @param {import('./salvage-file.js').FileCounts} counts
 * @param {number} characters
 * @returns {import('../records.js').Saved}
 */
export function savedOf(counts, characters) {
  return {
    notes: counts.canvases || 0,
    blocks: counts.elements || 0,
    media: counts.media || 0,
    folders: counts.folders || 0,
    legacyCopies: counts.legacyCopies || 0,
    recoveryPoints: counts.recoveryPoints || 0,
    characters,
  };
}

/** @type {RemediationSteps} */
const saveRecoveryFile = {
  recordOptional: true,
  takesSubject: true,
  // Only whether the point is there: reading it waits until the user picked where it goes
  async preview(context) {
    const salvage = port(context, 'salvage');
    if (!context.subjectId) throw new UnavailableError('adapter', 'not-applicable', false);
    if (!(await salvage.has(context.subjectId))) throw new UnavailableError('storage', 'no-recovery-point', false);
    return { preview: { changes: [{ target: 'file', creates: 1, updates: 0, deletes: 0 }] }, plan: null };
  },
  ...saving('restore-point', async context => {
    const read = await port(context, 'salvage').restorePoint(/** @type {string} */ (context.subjectId));
    if (!read) throw new UnavailableError('storage', 'no-recovery-point', false);
    if (read.kind === 'recovery-point' && !read.point.verified) {
      throw new UnavailableError('storage', 'recovery-point-unverified', false);
    }
    return buildRestorePointFile(read, { now: context.clock.now() });
  }),
};

/** @type {RemediationSteps} */
const saveSalvageFile = {
  recordOptional: true,
  // Nothing is read before the picker: a profile can take longer than the click's activation
  async preview(context) {
    port(context, 'salvage');
    return { preview: { changes: [{ target: 'file', creates: 1, updates: 0, deletes: 0 }] }, plan: null };
  },
  ...saving('salvage', async context => buildSalvage(await port(context, 'salvage').collect(), { now: context.clock.now() })),
};

// ============ export-diagnostics ============

/**
 * The diagnostic report's suggested name, as diagnostics.export names it, from the time alone,
 * since the picker opens before the report is built
 * @param {number} now
 */
const diagnosticsName = now => `newtabnote-diagnostics-${new Date(now).toISOString().slice(0, 10)}.json`;

/** @type {RemediationSteps} */
const exportDiagnostics = {
  recordOptional: true,
  // The previewed report, taken once here and carried to apply, so nothing built later reaches the file
  async preview(context) {
    const exported = /** @type {{kind?: unknown, serialized?: unknown} | null} */ (
      await port(context, 'diagnostics')()
    );
    if (!exported || exported.kind !== 'diagnostics' || typeof exported.serialized !== 'string') {
      throw new UnavailableError('adapter', 'not-applicable', false);
    }
    // Only a diagnostic report goes in this file: one that parses, holding its schema's fields
    // and nothing else
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(exported.serialized);
    } catch {
      parsed = null;
    }
    if (!v.is(reportSchema, parsed)) throw new UnavailableError('adapter', 'preview-invalid', false);
    return {
      preview: { changes: [{ target: 'file', creates: 1, updates: 0, deletes: 0 }] },
      plan: exported.serialized,
    };
  },
  async apply(context, plan) {
    const text = /** @type {string} */ (plan);
    const written = await writeText({
      files: context.ports.files,
      suggestedName: diagnosticsName(context.clock.now()),
      build: async () => text,
    });
    if (written.status === 'cancelled') return CANCELLED_BY_USER;
    if (written.status === 'failed') {
      if (written.picked) return failedAfterPick(written.code);
      throw new UnavailableError('storage', written.code, true);
    }
    return written;
  },
  async verify(context, written) {
    const read = await readBackText({ files: context.ports.files, written });
    if (read.status !== 'saved') return { ok: false, code: read.code, fileMayBeEmpty: true };
    return { ok: true, saved: { characters: read.characters } };
  },
};

// ============ remove-saved-key ============

/**
 * The places the reader answers, each a known one once, in SECRET_PLACES order, or a throw:
 * anything else verified nothing
 * @param {unknown} answer
 * @returns {import('./preview.js').SecretPlace[]}
 */
const placesOf = answer => {
  if (!Array.isArray(answer) || !answer.every(place => /** @type {readonly unknown[]} */ (SECRET_PLACES).includes(place))) {
    throw new UnavailableError('storage', 'unreadable', true);
  }
  return SECRET_PLACES.filter(place => answer.includes(place));
};

/** @type {RemediationSteps} */
const removeSavedKey = {
  async preview(context) {
    const places = placesOf(await port(context, 'secrets').present());
    return {
      preview: {
        changes: [{ target: 'saved-keys', creates: 0, updates: 0, deletes: places.length }],
        places: places.map(place => ({ place, stops: [...SECRET_STOPS[place]] })),
      },
      plan: places,
      nothingToDo: places.length === 0,
    };
  },
  destroys: (_context, plan) => [.../** @type {string[]} */ (plan)],
  // A removal that fails partway still goes to verify, which reads the places again and names
  // what went and what's still there, never a value
  async apply(context, plan) {
    const places = /** @type {string[]} */ (plan);
    /** @type {string | null} */
    let code = null;
    try {
      await port(context, 'secrets').remove(places);
    } catch (error) {
      const given = error && typeof error === 'object' ? /** @type {{code?: unknown}} */ (error).code : undefined;
      code = typeof given === 'string' ? given : 'apply-failed';
    }
    return { places, code };
  },
  async verify(context, applied) {
    const { places, code } = /** @type {{places: string[], code: string | null}} */ (applied);
    /** @type {readonly string[]} */
    let left;
    try {
      left = placesOf(await port(context, 'secrets').present());
    } catch {
      // The re-read failed: whether each place went is unknown, and says so
      return { ok: false, code: code || 'verify-failed', removed: [], kept: [], unknown: [...places] };
    }
    const removed = places.filter(place => !left.includes(place));
    const kept = places.filter(place => left.includes(place));
    if (kept.length > 0) return { ok: false, code: code || 'not-verified', removed, kept };
    return { ok: true, removed, kept };
  },
};

/**
 * A contribution's static fields
 * @param {string} id
 * @param {'retry' | 'repair' | 'export' | 'safe-disable'} group
 * @param {number} rank
 * @param {string} label
 * @param {import('../vocabulary.js').RemediationClass} remediationClass
 * @param {string[]} appliesTo
 * @param {RemediationSteps} implementation
 */
const contribution = (id, group, rank, label, remediationClass, appliesTo, implementation) =>
  Object.freeze({
    id,
    version: 1,
    apiVersion: 1,
    group,
    rank,
    hosts: Object.freeze(['workspace']),
    label,
    owner: 20,
    class: remediationClass,
    appliesTo: Object.freeze(appliesTo),
    fixtures: Object.freeze(['remediation-steps']),
    implementation: Object.freeze(implementation),
  });

/** Slice 3's remediations, as `remediation` contributions */
export const REMEDIATIONS = Object.freeze([
  contribution('safe-disable', 'safe-disable', 10, 'Turn off semantic search', 'non-destructive', ['local-inference'], safeDisable),
  contribution('retry-open', 'retry', 10, 'Retry', 'non-destructive', ['storage', 'capture'], retryOpen),
  contribution('rebuild-index', 'repair', 10, 'Rebuild the search index', 'regenerable', ['index'], rebuildIndex),
  contribution('recover-orphans', 'repair', 20, 'Recover blocks into a new Inbox note', 'reversible', ['storage'], recoverOrphans),
  contribution(
    'save-recovery-file',
    'export',
    10,
    'Save as file',
    'non-destructive',
    ['recovery-readiness', 'backup'],
    saveRecoveryFile,
  ),
  contribution(
    'save-salvage-file',
    'export',
    20,
    'Save a salvage file',
    'non-destructive',
    ['storage', 'capture', 'recovery-readiness'],
    saveSalvageFile,
  ),
  contribution(
    'export-diagnostics',
    'export',
    30,
    'Save the diagnostic report',
    'non-destructive',
    PROVIDERS.map(descriptor => /** @type {string} */ (descriptor.id)),
    exportDiagnostics,
  ),
  contribution('remove-saved-key', 'repair', 30, 'Remove saved keys', 'secret-removal', ['credentials'], removeSavedKey),
]);
