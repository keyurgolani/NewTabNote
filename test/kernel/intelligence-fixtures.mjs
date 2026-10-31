// Shared by the intelligence tests (#7 slice 1): signal drafts for each kind, fake producers,
// and a world that puts the domain beside a real in-memory kernel, so a task's completion goes
// through the kernel's block command (saveNoteContent) and the tests can check that nothing
// else ever writes a note.

import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { createIntelligence } from '../../js/kernel/core/intelligence/service.js';
import { SUBJECT_KEYS, signalIdOf } from '../../js/kernel/core/intelligence/identity.js';
import { plainTitle } from '../../js/kernel/core/intelligence/records.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createMemoryCommitLog } from '../../js/kernel/core/memory/commit-log.js';
import { createMemoryIntelligenceRepository } from '../../js/kernel/core/memory/intelligence.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { CALLERS, NOW, testClock, testIds } from './support.mjs';

/** @typedef {import('../../js/kernel/core/intelligence/service.js').SignalDraft} SignalDraft */
/** @typedef {import('../../js/kernel/core/intelligence/service.js').ProducerDescriptor} ProducerDescriptor */
/** @typedef {import('../../js/kernel/core/intelligence/service.js').NoteCommandPort} NoteCommandPort */
/** @typedef {import('../../js/kernel/core/intelligence/records.js').IntelligenceSignal} IntelligenceSignal */
/** @typedef {import('../../js/kernel/core/intelligence/records.js').TimeBasis} TimeBasis */
/** @typedef {import('../../js/kernel/core/intelligence/invalidation.js').RegenerationRequest} RegenerationRequest */
/** @typedef {import('../../js/kernel/core/intelligence/events.js').IntelligenceEvent} IntelligenceEvent */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../js/kernel/core/domain/note.js').BlockRecord} BlockRecord */

export const TASKS = 'tasks';
export const PINS = 'pins';
export const RECIPE = 'actions.extract';
export const LINKS = 'links';

/**
 * The host's timers, which a composition root passes in
 * @type {import('../../js/kernel/core/ports/runtime.js').Timers}
 */
export const realTimers = Object.freeze({
  set: (/** @type {() => void} */ callback, /** @type {number} */ ms) => setTimeout(callback, ms),
  clear: (/** @type {unknown} */ handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
});

/**
 * Timers a test fires by hand
 */
export function manualTimers() {
  /** @type {Map<number, () => void>} */
  const pending = new Map();
  let next = 0;
  return {
    set: (/** @type {() => void} */ callback) => {
      next += 1;
      pending.set(next, callback);
      return next;
    },
    clear: (/** @type {unknown} */ handle) => {
      pending.delete(/** @type {number} */ (handle));
    },
    /** Fires every timer set so far */
    fireAll() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    size: () => pending.size,
  };
}

/** A time zone that is neither UTC nor, on most machines, the machine's own */
export const ZONE = 'America/New_York';

/**
 * @typedef {object} DraftContext
 * @property {number | null} [lastEditAt]
 * @property {string | null} [dailyNoteDate]
 * @property {boolean} [notePinned]
 */

/**
 * @param {DraftContext} [context]
 */
const contextOf = (context = {}) => ({
  lastEditAt: context.lastEditAt === undefined ? NOW : context.lastEditAt,
  dailyNoteDate: context.dailyNoteDate ?? null,
  notePinned: context.notePinned ?? false,
});

/**
 * An objective task for a todo block
 * @param {{noteId?: string, blockId?: string, title?: string, checked?: boolean, revision?: number | null,
 *   time?: TimeBasis | null, context?: DraftContext, version?: number}} [fields]
 * @returns {SignalDraft}
 */
export function taskDraft({
  noteId = 'n1',
  blockId = 'b1',
  title = 'Call vendor',
  checked = false,
  revision = 0,
  time = null,
  context,
  version = 1,
} = {}) {
  return {
    identity: { producerId: TASKS, noteId, anchorBlockId: blockId, subjectKey: SUBJECT_KEYS.task },
    kind: 'task',
    provenance: 'objective',
    executionClass: 'deterministic',
    location: null,
    producerVersion: version,
    sourceRefs: [{ kind: 'block', noteId, blockId, revision }],
    title: plainTitle(title),
    reason: { code: 'open-task', params: {} },
    time,
    category: null,
    context: contextOf(context),
    checked,
    checkedAt: null,
    confidence: null,
    derivationRef: null,
    model: null,
    providerId: null,
    scopeId: null,
  };
}

/**
 * An objective pin for a note
 * @param {{noteId?: string, title?: string, revision?: number | null, context?: DraftContext}} [fields]
 * @returns {SignalDraft}
 */
export function pinDraft({ noteId = 'n1', title = 'Roadmap', revision = 0, context } = {}) {
  return {
    identity: { producerId: PINS, noteId, anchorBlockId: null, subjectKey: SUBJECT_KEYS.pinned },
    kind: 'pin',
    provenance: 'objective',
    executionClass: 'deterministic',
    location: null,
    producerVersion: 1,
    sourceRefs: [{ kind: 'note', noteId, revision }],
    title,
    reason: { code: 'pinned-note', params: {} },
    time: null,
    category: null,
    context: contextOf({ notePinned: true, ...context }),
    checked: null,
    checkedAt: null,
    confidence: null,
    derivationRef: null,
    model: null,
    providerId: null,
    scopeId: null,
  };
}

/**
 * An inferred signal from a fake recipe
 * @param {{kind?: 'inferred-task' | 'inferred-deadline' | 'inferred-reminder' | 'inferred-highlight' | 'inferred-resurface',
 *   noteId?: string, blockId?: string, subject?: string, title?: string, revision?: number | null,
 *   time?: TimeBasis | null, context?: DraftContext, executionClass?: 'local-model' | 'local-endpoint' | 'remote',
 *   location?: {kind: 'local-app' | 'network-endpoint', id: string} | null, version?: number, modelId?: string,
 *   providerId?: string, scopeId?: string, band?: 'low' | 'medium' | 'high', category?: 'now' | 'today' | 'soon' | 'resurface' | null}} [fields]
 * @returns {SignalDraft}
 */
export function inferredDraft({
  kind = 'inferred-deadline',
  noteId = 'n1',
  blockId = 'b2',
  subject = 'send the q3 report',
  title = 'Send the Q3 report',
  revision = 0,
  time = null,
  context,
  executionClass = 'local-model',
  location = null,
  version = 1,
  modelId = 'gemma-3n',
  providerId = 'local-runtime',
  scopeId = 'scope-notes',
  band = 'medium',
  category = null,
} = {}) {
  return {
    identity: { producerId: RECIPE, noteId, anchorBlockId: blockId, subjectKey: subject },
    kind,
    provenance: 'inferred',
    executionClass,
    location: executionClass === 'local-endpoint' ? (location ?? { kind: 'local-app', id: 'ollama' }) : null,
    producerVersion: version,
    sourceRefs: [{ kind: 'block', noteId, blockId, revision }],
    title,
    reason: { code: 'mentioned-in-note', params: {} },
    time,
    category,
    context: contextOf(context),
    checked: null,
    checkedAt: null,
    confidence: { band, reason: 'The note names a date for it' },
    derivationRef: 'derivation-1',
    model: { id: modelId, version: '1' },
    providerId,
    scopeId,
  };
}

/**
 * A link-based connection between notes, objective
 * @param {{noteId?: string, others?: string[]}} [fields]
 * @returns {SignalDraft}
 */
export function connectionDraft({ noteId = 'n1', others = ['n2', 'n3'] } = {}) {
  return {
    identity: { producerId: LINKS, noteId, anchorBlockId: null, subjectKey: `links:${others.join(',')}` },
    kind: 'connection',
    provenance: 'objective',
    executionClass: 'deterministic',
    location: null,
    producerVersion: 1,
    sourceRefs: [noteId, ...others].map(id => ({ kind: /** @type {const} */ ('note'), noteId: id, revision: 0 })),
    title: 'Notes that link to each other',
    reason: { code: 'linked-notes', params: { count: others.length + 1 } },
    time: null,
    category: 'connection',
    context: contextOf(),
    checked: null,
    checkedAt: null,
    confidence: null,
    derivationRef: null,
    model: null,
    providerId: null,
    scopeId: null,
  };
}

/**
 * The id a draft's signal gets
 * @param {SignalDraft} draft
 */
export const idOf = draft => {
  const { producerId, noteId, anchorBlockId, subjectKey } = draft.identity;
  return signalIdOf([producerId, noteId, anchorBlockId, subjectKey]);
};

/**
 * The stored signal a draft becomes, current and at revision 1
 * @param {SignalDraft} draft
 * @param {Partial<IntelligenceSignal>} [fields]
 * @returns {IntelligenceSignal}
 */
export const asSignal = (draft, fields = {}) => ({
  recordVersion: 1,
  id: idOf(draft),
  ...draft,
  generatedAt: NOW,
  freshness: { state: 'current', cause: null, since: null, invalidatedAt: null, resumeTo: null },
  unavailableNotes: [],
  revision: 1,
  ...fields,
});

/**
 * A todo block
 * @param {string} id
 * @param {string} text
 * @param {boolean} [checked]
 */
export const todo = (id, text, checked = false) => ({ id, type: 'todo', content: text, checked });

/**
 * The domain beside a real in-memory kernel, sharing #17's change log: the kernel's block
 * command completes tasks, and a fake `tasks` producer derives task signals from the kernel's
 * blocks. Every regeneration request and event is recorded.
 * @param {{timeZone?: string, start?: number, producers?: ProducerDescriptor[], recipeVersion?: number,
 *   timers?: import('../../js/kernel/core/ports/runtime.js').Timers, noteCommandTimeoutMs?: number, checkSources?: boolean}} [options]
 *   `checkSources` gives the port `sourceStates`, so an upsert checks the notes and blocks it cites
 */
export async function intelligenceWorld({
  timeZone = ZONE,
  start = NOW,
  producers = [],
  recipeVersion = 1,
  timers = realTimers,
  noteCommandTimeoutMs = undefined,
  checkSources = false,
} = {}) {
  const clock = testClock(start);
  const ids = testIds('cmd');
  const commitLog = createMemoryCommitLog();
  const adapter = createMemoryAdapter({ commitLog });
  const kernel = createKernel({ adapter, policy: createBaselinePolicy(), caller: CALLERS.newtab, ids, clock });
  const repository = createMemoryIntelligenceRepository({ commitLog });
  /** @type {IntelligenceEvent[]} */
  const events = [];
  /** @type {RegenerationRequest[]} */
  const requests = [];
  /** @type {Array<Parameters<NoteCommandPort['setTodoChecked']>[0]>} */
  const noteCalls = [];

  /**
   * The note's blocks and revision, as the kernel answers them
   * @param {string} noteId
   */
  const readNote = async noteId => {
    const note = await kernel.query({ type: 'getNote', noteId });
    const blocks = await kernel.query({ type: 'getNoteBlocks', noteId });
    if (note.kind !== 'ready' || (blocks.kind !== 'ready' && blocks.kind !== 'empty')) return null;
    return {
      note: note.data.note,
      revision: note.data.revision ?? null,
      blocks: blocks.kind === 'ready' ? /** @type {BlockRecord[]} */ (blocks.data) : [],
    };
  };

  /** @type {NonNullable<NoteCommandPort['sourceStates']>} */
  const sourceStates = async sourceRefs =>
    Promise.all(
      sourceRefs.map(async source => {
        const read = await readNote(source.noteId);
        if (!read) return 'missing';
        if (source.kind === 'block' && !read.blocks.some(block => block.id === source.blockId)) return 'missing';
        if (read.note.trashed === true) return 'note-trashed';
        if (read.note.archived === true) return 'note-archived';
        if (read.note.isTemplate === true) return 'template';
        return 'available';
      }),
    );

  /** @type {NoteCommandPort} */
  const noteCommands = {
    ...(checkSources ? { sourceStates } : {}),
    async setTodoChecked(command) {
      noteCalls.push({ ...command });
      const read = await readNote(command.noteId);
      const block = read?.blocks.find(candidate => candidate.id === command.blockId);
      if (!read || !block)
        return {
          kind: 'rejected',
          reason: 'not-found',
          code: 'block-not-found',
          messageKey: 'rejected.block-not-found',
          severity: 'warning',
        };
      return kernel.execute({
        type: 'saveNoteContent',
        commandId: command.commandId,
        noteId: command.noteId,
        blocks: [{ ...block, checked: command.checked }],
        ...(command.expectedRevision === null ? {} : { expectedRevision: command.expectedRevision }),
      });
    },
  };

  /** @type {ProducerDescriptor} */
  /**
   * The fake `tasks` producer. A test can make it throw (`fail`), or hold its answer after it
   * has read the note (`hold`), as a slow derive does
   * @type {ProducerDescriptor & {fail: ((identity: import('../../js/kernel/core/intelligence/identity.js').Identity) => boolean) | null, hold: Promise<unknown> | null}}
   */
  const tasks = {
    id: TASKS,
    version: 1,
    provenance: 'objective',
    kinds: ['task'],
    fail: null,
    hold: null,
    async derive(identity) {
      if (tasks.fail?.(identity)) throw new Error('derive failed');
      const read = await readNote(identity.noteId);
      if (tasks.hold) await tasks.hold;
      const block = read?.blocks.find(candidate => candidate.id === identity.anchorBlockId);
      if (!read || !block || block.type !== 'todo') return null;
      return taskDraft({
        noteId: identity.noteId,
        blockId: /** @type {string} */ (identity.anchorBlockId),
        title: String(block.content ?? ''),
        checked: block.checked === true,
        revision: read.revision,
        // The latest block edit, never the note's updatedAt
        context: {
          notePinned: read.note.pinned === true,
          lastEditAt: read.blocks.reduce(
            (latest, candidate) =>
              typeof candidate.updatedAt === 'number' && candidate.updatedAt > (latest ?? -1)
                ? candidate.updatedAt
                : latest,
            /** @type {number | null} */ (null),
          ),
          dailyNoteDate: read.note.isDaily === true && typeof read.note.dateStr === 'string' ? read.note.dateStr : null,
        },
        version: tasks.version,
      });
    },
  };

  /** @type {ProducerDescriptor} */
  const recipe = {
    id: RECIPE,
    version: recipeVersion,
    provenance: 'inferred',
    kinds: ['inferred-task', 'inferred-deadline'],
  };

  const intelligence = createIntelligence({
    repository,
    noteCommands,
    timeZone,
    clock,
    timers,
    ...(noteCommandTimeoutMs === undefined ? {} : { noteCommandTimeoutMs }),
    producers: [tasks, recipe, ...producers],
    events: { publish: event => events.push(event) },
    regeneration: { request: request => requests.push(request) },
  });

  /**
   * Makes a note with blocks through the kernel, and derives its task signals
   * @param {string} noteId
   * @param {Array<Record<string, unknown>>} blocks
   * @param {{pinned?: boolean}} [options]
   */
  const addNote = async (noteId, blocks, { pinned = false } = {}) => {
    const outcome = await kernel.execute({
      type: 'createNote',
      commandId: ids.next(),
      noteId,
      name: noteId,
      blocks: /** @type {any} */ (blocks),
      pinned,
    });
    if (outcome.kind !== 'committed') throw new Error(`createNote ${outcome.kind} ${outcome.code}`);
    /** @type {SignalDraft[]} */
    const drafts = [];
    for (const block of blocks) {
      if (block.type !== 'todo') continue;
      const draft = await tasks.derive?.({
        producerId: TASKS,
        noteId,
        anchorBlockId: String(block.id),
        subjectKey: 'task',
      });
      if (draft) drafts.push(draft);
    }
    return intelligence.upsertSignals(TASKS, drafts);
  };

  /**
   * Edits a block through the kernel
   * @param {string} noteId
   * @param {Record<string, unknown>} block
   */
  const editBlock = async (noteId, block) =>
    kernel.execute({ type: 'saveNoteContent', commandId: ids.next(), noteId, blocks: [/** @type {any} */ (block)] });

  /**
   * What the kernel holds of `noteIds`, and every note or block change in #17's change log, to
   * compare before and after
   * @param {string[]} noteIds
   */
  const noteSnapshot = async noteIds => {
    const read = await commitLog.readChangesSince(0, 10000);
    const noteChanges =
      read.kind === 'changes' ? read.entries.filter(entry => entry.entityType !== 'intelligence') : [];
    return { notes: await Promise.all(noteIds.map(readNote)), noteChanges };
  };

  /**
   * The domain as another context (a second tab) builds it, over the same repository and
   * kernel, with its own note-command port when given one
   * @param {NoteCommandPort} [port]
   */
  const anotherContext = (port = noteCommands) =>
    createIntelligence({
      repository,
      noteCommands: port,
      timeZone,
      clock,
      timers,
      ...(noteCommandTimeoutMs === undefined ? {} : { noteCommandTimeoutMs }),
      producers: [tasks, recipe, ...producers],
      events: { publish: event => events.push(event) },
      regeneration: { request: request => requests.push(request) },
    });

  return {
    clock,
    ids,
    commitLog,
    adapter,
    kernel,
    repository,
    intelligence,
    noteCommands,
    anotherContext,
    tasks,
    recipe,
    events,
    requests,
    noteCalls,
    addNote,
    editBlock,
    readNote,
    noteSnapshot,
  };
}
