/**
 * The intelligence domain's use cases (#7, slice 1): the lifecycle commands, the producer
 * side that writes signals, the invalidation table and hook, and the regeneration requests a
 * stale inference sends. It runs on an injected repository, clock, and IANA time zone, and
 * reaches a note only through an injected note-command port, so nothing here touches a note
 * record. No shipped root builds one yet: a surface does, once it consumes the domain.
 *
 * Lifecycle commands (operations.js) run the same way every time: validate the payload,
 * answer a retry of a commandId from the outcome it kept, refuse a signal that's missing,
 * suspended, invalidated, or the wrong kind for the action, and compare the
 * `expectedDecisionRevision` with the decision's. The first commit for a revision wins and
 * every later one gets `SignalDecisionConflict` with the current state. A commit that writes
 * keeps its outcome under its commandId in the same transaction, so a retry is answered from
 * that and runs nothing.
 *
 * Completing or reopening an objective task goes through the note-command port (the kernel's
 * block command today, #14's `todo.complete` and `todo.reopen` later), and the signal follows
 * the `checked` that committed. A note revision conflict leaves the signal as it was and
 * answers `note-revision-conflict`. An inferred signal's completion writes only the decision.
 *
 * Producers here are descriptors with a `derive` (slice 2 brings `tasks` and `pins`; tests
 * bring fakes). Nothing here calls a model: a stale inference sends a RegenerationRequest.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { committed, rejected, unavailableFrom } from '../contracts/outcomes.js';
import { digestOf } from '../memory/fingerprint.js';
import { silentLogger, systemClock } from '../ports/runtime.js';
import { CATEGORY_ORDER, DEFAULT_WINDOWS, placeSignal } from './categories.js';
import { idOfIdentity } from './identity.js';
import {
  INVALIDATION_TABLE,
  REGENERATION_CAUSES,
  invalidateSchema,
  invalidated,
  matches,
  noteChangeSchema,
  regenerationRequestsFor,
  staled,
  suspensionOf,
  withAvailability,
  withNoteState,
  withoutNote,
} from './invalidation.js';
import {
  LIFECYCLE_ACTIONS,
  effectiveStatus,
  isObjectiveTask,
  latestCorrections,
  nextDecision,
  sourceKey,
} from './lifecycle.js';
import { payload as commandSchema, signalConflict } from './operations.js';
import { REASON_MAX, RECORD_VERSION, plainTitle, redactText, signalRefusal } from './records.js';
import { addLocalDays, isTimeZone, startOfLocalDay } from './time.js';

/** @typedef {import('./records.js').IntelligenceSignal} IntelligenceSignal */
/** @typedef {import('./records.js').SignalDecision} SignalDecision */
/** @typedef {import('./records.js').SignalCorrection} SignalCorrection */
/** @typedef {import('./records.js').Kind} Kind */
/** @typedef {import('./records.js').Provenance} Provenance */
/** @typedef {import('./records.js').FreshnessCause} FreshnessCause */
/** @typedef {import('./records.js').CorrectionChange} CorrectionChange */
/** @typedef {import('./lifecycle.js').DecisionChange} DecisionChange */
/** @typedef {import('./lifecycle.js').LifecycleAction} LifecycleAction */
/** @typedef {import('./operations.js').IntelligenceCommand} IntelligenceCommand */
/** @typedef {import('./operations.js').IntelligenceOutcome} IntelligenceOutcome */
/** @typedef {import('./operations.js').DecisionState} DecisionState */
/** @typedef {import('./operations.js').CorrectSignal} CorrectSignal */
/** @typedef {import('./invalidation.js').Invalidation} Invalidation */
/** @typedef {import('./invalidation.js').NoteChange} NoteChange */
/** @typedef {import('./invalidation.js').RegenerationRequest} RegenerationRequest */
/** @typedef {import('./invalidation.js').RegenerationCause} RegenerationCause */
/** @typedef {import('./categories.js').Windows} Windows */
/** @typedef {import('./events.js').IntelligenceEvent} IntelligenceEvent */
/** @typedef {import('./repository.js').IntelligenceRepository} IntelligenceRepository */
/** @typedef {import('./repository.js').IntelligenceTx} IntelligenceTx */
/** @typedef {import('./identity.js').Identity} Identity */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../ports/runtime.js').Clock} Clock */
/** @typedef {import('../ports/runtime.js').Logger} Logger */

/**
 * What a producer offers for one signal: everything but what the domain sets itself, which
 * is the id (from the identity), the record version, the entity's revision, freshness, which
 * of the notes it cites are unavailable, and when it was generated
 * @typedef {Omit<IntelligenceSignal, 'recordVersion' | 'id' | 'revision' | 'freshness' | 'generatedAt' | 'unavailableNotes'>} SignalDraft
 */

/**
 * A producer as the domain knows it. `derive` answers the signal it makes now for an identity
 * it made before, or null when the source no longer gives one, which the table uses to
 * re-derive an objective signal. Slice 2's `tasks` and `pins` implement it; tests use fakes.
 * @typedef {object} ProducerDescriptor
 * @property {string} id
 * @property {number} version
 * @property {Provenance} provenance
 * @property {readonly Kind[]} kinds
 * @property {(identity: Identity) => Promise<SignalDraft | null>} [derive]
 */

/**
 * The note-command port: the one way the domain changes a note, a todo block's `checked`.
 * It answers #12's outcome. `expectedRevision` is the revision the signal read its anchor at,
 * so a note that changed since conflicts.
 * @typedef {object} NoteCommandPort
 * @property {(command: {commandId: string, noteId: string, blockId: string, checked: boolean, expectedRevision: number | null}) => Promise<Outcome>} setTodoChecked
 */

/**
 * @typedef {object} IntelligenceOptions
 * @property {IntelligenceRepository} repository
 * @property {NoteCommandPort} noteCommands
 * @property {string} timeZone - the user's IANA time zone
 * @property {Clock} [clock]
 * @property {readonly ProducerDescriptor[]} [producers]
 * @property {{publish(event: IntelligenceEvent): void}} [events] - where typed events go after each commit
 * @property {{request(request: RegenerationRequest): void}} [regeneration] - #8's queue
 * @property {Windows} [windows]
 * @property {Logger} [logger]
 */

/**
 * What a read of one signal answers: `ready` with its records and the commitSeq they're as of,
 * or `not-found`. A record that failed validation reads as absent.
 * @typedef {{kind: 'ready', asOfCommitSeq: number, signal: IntelligenceSignal, decision: SignalDecision | null,
 *   corrections: SignalCorrection[], state: DecisionState}
 *   | {kind: 'not-found', asOfCommitSeq: number}} SignalRead
 */

/**
 * What a producer-side write or an invalidation answers
 * @typedef {{commitSeq: number | null, changed: string[], removed: string[], regeneration: RegenerationRequest[], refused: string[]}} DomainResult
 */

/**
 * @param {IntelligenceSignal} signal
 * @param {SignalDecision | null} decision
 * @param {number} now
 * @returns {DecisionState}
 */
export function decisionStateOf(signal, decision, now) {
  const status = effectiveStatus(signal, decision, now);
  return {
    signalId: signal.id,
    status,
    snoozedUntil: status === 'snoozed' ? (decision?.snoozedUntil ?? null) : null,
    dismissReason: status === 'dismissed' ? (decision?.dismissReason ?? null) : null,
    decisionRevision: decision?.decisionRevision ?? 0,
    checked: signal.checked,
  };
}

/** @type {Readonly<Record<IntelligenceCommand['type'], LifecycleAction>>} */
const ACTION_OF = Object.freeze({
  'intelligence.complete': 'complete',
  'intelligence.reopen': 'reopen',
  'intelligence.dismiss': 'dismiss',
  'intelligence.snooze': 'snooze',
  'intelligence.correct': 'correct',
});

/**
 * The instant `signal` is due, or null when undated: for a floating date, the end of that
 * local day, which `endOfDay` answers
 * @param {IntelligenceSignal} signal
 * @param {(date: string) => number} endOfDay
 */
const dueInstant = (signal, endOfDay) => {
  if (signal.time?.dueAt !== undefined) return signal.time.dueAt;
  if (signal.time?.dueDate !== undefined) return endOfDay(signal.time.dueDate);
  return null;
};

/**
 * A first phase's answer inside its transaction
 * @typedef {{outcome: IntelligenceOutcome}
 *   | {note: {signal: IntelligenceSignal, checked: boolean, current: DecisionState}}
 *   | {build: (commitSeq: number | null) => IntelligenceOutcome}} DecideStep
 */

/**
 * @param {IntelligenceOptions} options
 */
export function createIntelligence({
  repository,
  noteCommands,
  timeZone,
  clock = systemClock,
  producers = [],
  events = { publish: () => {} },
  regeneration = { request: () => {} },
  windows = DEFAULT_WINDOWS,
  logger = silentLogger,
}) {
  if (!isTimeZone(timeZone)) throw new TypeError('the intelligence domain needs an IANA time zone');
  /** @type {Map<string, ProducerDescriptor>} */
  const producerById = new Map(producers.map(producer => [producer.id, producer]));

  /** @param {IntelligenceEvent[]} made */
  const publish = made => {
    for (const event of made) {
      try {
        events.publish(event);
      } catch (error) {
        logger.warn('intelligence-event-listener-failed', { error });
      }
    }
  };

  /** @param {RegenerationRequest[]} requests */
  const send = requests => {
    for (const request of requests) {
      try {
        regeneration.request(request);
      } catch (error) {
        logger.warn('regeneration-request-failed', { error });
      }
    }
  };

  /**
   * The category order of `signal` now, which a regeneration request's priority reads
   * @param {IntelligenceTx} tx
   * @param {IntelligenceSignal} signal
   * @param {number} now
   */
  const priorityOf = (tx, signal, now) =>
    CATEGORY_ORDER.indexOf(
      placeSignal(signal, tx.decision(signal.id), tx.corrections(signal.id), { now, timeZone, windows }).category,
    );

  // ============ Lifecycle commands ============

  /**
   * The decision change and corrections a non-task lifecycle command makes, or the refusal
   * @param {IntelligenceCommand} command
   * @param {IntelligenceTx} tx
   * @param {IntelligenceSignal} signal
   * @param {SignalDecision | null} decision
   * @param {number} now
   * @returns {{change: DecisionChange, corrections: SignalCorrection[], code: string, severity?: 'warning'} | {refused: IntelligenceOutcome}}
   */
  const planOf = (command, tx, signal, decision, now) => {
    const status = effectiveStatus(signal, decision, now);
    switch (command.type) {
      case 'intelligence.complete':
        return { change: { action: 'complete', status: 'completed' }, corrections: [], code: 'signal-completed' };
      case 'intelligence.reopen':
        return { change: { action: 'reopen', status: 'active' }, corrections: [], code: 'signal-reopened' };
      case 'intelligence.dismiss':
        return {
          change: {
            action: 'dismiss',
            status: 'dismissed',
            dismissReason: command.reason ?? (signal.kind === 'connection' ? 'not-related' : null),
          },
          corrections: [],
          code: 'signal-dismissed',
        };
      case 'intelligence.snooze': {
        if (command.until <= now) return { refused: rejected('validation', 'snooze-not-future') };
        const due = dueInstant(signal, date => startOfLocalDay(addLocalDays(date, 1), timeZone));
        const pastDue = due !== null && due < command.until;
        return {
          change: { action: 'snooze', status: 'snoozed', snoozedUntil: command.until },
          corrections: [],
          code: pastDue ? 'signal-snoozed-past-due' : 'signal-snoozed',
          ...(pastDue ? { severity: /** @type {const} */ ('warning') } : {}),
        };
      }
      case 'intelligence.correct':
        return correctionPlan(command, tx, signal, decision, status, now);
      default:
        return { refused: rejected('validation', 'invalid-command') };
    }
  };

  /**
   * @param {CorrectSignal} command
   * @param {IntelligenceTx} tx
   * @param {IntelligenceSignal} signal
   * @param {SignalDecision | null} decision
   * @param {import('./records.js').DecisionStatus} status
   * @param {number} now
   * @returns {{change: DecisionChange, corrections: SignalCorrection[], code: string} | {refused: IntelligenceOutcome}}
   */
  const correctionPlan = (command, tx, signal, decision, status, now) => {
    const latest = latestCorrections(tx.corrections(signal.id));
    const ask = command.change;
    /** @type {CorrectionChange} */
    let change;
    /** @type {DecisionChange} */
    let decided = {
      action: 'correct',
      status,
      snoozedUntil: decision?.snoozedUntil ?? null,
      dismissReason: decision?.dismissReason ?? null,
    };
    if (ask.field === 'category') {
      change = {
        field: 'category',
        before: latest.category !== undefined ? latest.category : signal.category,
        after: ask.after,
      };
    } else if (ask.field === 'time') {
      change = { field: 'time', before: latest.time !== undefined ? latest.time : signal.time, after: ask.after };
    } else if (ask.field === 'actionable') {
      change = { field: 'actionable', before: latest.actionable ?? true, after: ask.after };
      if (!ask.after) decided = { action: 'correct', status: 'dismissed', dismissReason: 'not-actionable' };
      else if (status === 'dismissed' && decision?.dismissReason === 'not-actionable') {
        decided = { action: 'correct', status: 'active' };
      }
    } else {
      if (signal.kind !== 'connection') return { refused: rejected('validation', 'action-not-available') };
      const key = sourceKey(ask.sourceRef);
      if (!signal.sourceRefs.some(source => sourceKey(source) === key)) {
        return { refused: rejected('validation', 'source-not-cited') };
      }
      change = { field: 'source', sourceRef: ask.sourceRef, before: latest.sources.get(key) ?? true, after: ask.after };
      const included = signal.sourceRefs.filter(source => {
        const own = sourceKey(source);
        return own === key ? ask.after : latest.sources.get(own) !== false;
      });
      if (included.length <= 1) decided = { action: 'correct', status: 'dismissed', dismissReason: 'not-related' };
      else if (status === 'dismissed' && decision?.dismissReason === 'not-related') {
        decided = { action: 'correct', status: 'active' };
      }
    }
    if (decided.status === 'snoozed' && decided.snoozedUntil === null)
      decided = { action: 'correct', status: 'active' };
    /** @type {SignalCorrection} */
    const correction = {
      recordVersion: RECORD_VERSION,
      entryId: command.entryId,
      signalId: signal.id,
      identity: { ...signal.identity },
      change,
      note: command.note ?? null,
      at: now,
      commandId: command.commandId,
    };
    return { change: decided, corrections: [correction], code: 'signal-corrected' };
  };

  /**
   * The first phase of a command, in one transaction: a retry's kept outcome, a refusal, a
   * conflict, a committed decision, or an objective task's note command still to send. Every
   * answer but the last is kept under the command's key, refusals included, so the key can't
   * be reused for another command whatever its first one got.
   * @param {IntelligenceCommand} command
   * @param {string} fingerprint
   * @param {number} now
   * @returns {Promise<{outcome: IntelligenceOutcome} | {note: {signal: IntelligenceSignal, checked: boolean, current: DecisionState}}>}
   */
  const decide = async (command, fingerprint, now) => {
    const {
      result,
      commitSeq,
      events: made,
    } = await repository.transact(
      /** @returns {DecideStep} */ tx => {
        const kept = tx.kept(command.commandId);
        if (kept) {
          return kept.fingerprint === fingerprint
            ? { outcome: kept.outcome }
            : { outcome: rejected('validation', 'idempotency-key-reuse') };
        }
        /** @param {IntelligenceOutcome} outcome */
        const answer = outcome => {
          tx.keep(command.commandId, fingerprint, () => outcome);
          return { outcome };
        };
        const signal = tx.signal(command.signalId);
        if (!signal) return answer(rejected('not-found', 'signal-not-found'));
        const action = ACTION_OF[command.type];
        if (!LIFECYCLE_ACTIONS[signal.kind].includes(action)) {
          return answer(rejected('validation', 'action-not-available'));
        }
        if (signal.freshness.state === 'suspended' || signal.freshness.state === 'invalidated') {
          return answer(rejected('validation', 'signal-not-actionable'));
        }
        const decision = tx.decision(signal.id);
        const current = decisionStateOf(signal, decision, now);
        if (command.expectedDecisionRevision !== current.decisionRevision) {
          return answer(signalConflict('signal-decision-conflict', current));
        }
        if (isObjectiveTask(signal) && (action === 'complete' || (action === 'reopen' && signal.checked === true))) {
          return { note: { signal, checked: action === 'complete', current } };
        }
        const plan = planOf(command, tx, signal, decision, now);
        if ('refused' in plan) return answer(plan.refused);
        const next = nextDecision(decision, plan.change, {
          signalId: signal.id,
          identity: signal.identity,
          now,
          commandId: command.commandId,
        });
        tx.putDecision(next);
        for (const correction of plan.corrections) tx.appendCorrection(correction);
        /** @param {number | null} seq */
        const build = seq =>
          committed(plan.code, [signal.id], {
            revision: next.decisionRevision,
            ...(seq === null ? {} : { commitSeq: seq }),
            ...(plan.severity ? { severity: plan.severity } : {}),
          });
        tx.keep(command.commandId, fingerprint, build);
        return { build };
      },
    );
    publish(made);
    if ('build' in result) return { outcome: result.build(commitSeq) };
    return result;
  };

  /**
   * The second phase of an objective task's complete or reopen, once the note command
   * committed. The block's `checked` is the completion authority and it has changed, so this
   * phase never answers a conflict: the signal mirrors the committed `checked`, the decision
   * goes on top of whatever another context committed meanwhile (#35's coordinator will run
   * these one at a time; until then two contexts can interleave here), and the answer is
   * `committed`. A duplicate of the command that got here first is answered from the outcome
   * it kept.
   * @param {IntelligenceCommand} command
   * @param {string} fingerprint
   * @param {IntelligenceSignal} before
   * @param {boolean} checked
   * @param {Outcome} noteOutcome
   * @returns {Promise<IntelligenceOutcome>}
   */
  const followNote = async (command, fingerprint, before, checked, noteOutcome) => {
    const now = clock.now();
    const {
      result,
      commitSeq,
      events: made,
    } = await repository.transact(
      /** @returns {IntelligenceOutcome | ((seq: number | null) => IntelligenceOutcome)} */ tx => {
        const kept = tx.kept(command.commandId);
        if (kept) {
          return kept.fingerprint === fingerprint ? kept.outcome : rejected('validation', 'idempotency-key-reuse');
        }
        const signal = tx.signal(before.id);
        if (!signal) return rejected('not-found', 'signal-not-found');
        const anchor = signal.identity.anchorBlockId;
        const revision = noteOutcome.kind === 'committed' ? noteOutcome.revision : undefined;
        const sourceRefs = signal.sourceRefs.map(source =>
          source.kind === 'block' && source.blockId === anchor && revision !== undefined
            ? { ...source, revision }
            : source,
        );
        if (signal.checked !== checked || sourceRefs.some((source, index) => source !== signal.sourceRefs[index])) {
          tx.putSignal({ ...signal, checked, checkedAt: now, sourceRefs, revision: signal.revision + 1 });
        }
        // The decision never says completed for an objective task: the block's checked does
        const next = nextDecision(
          tx.decision(signal.id),
          { action: checked ? 'complete' : 'reopen', status: 'active' },
          { signalId: signal.id, identity: signal.identity, now, commandId: command.commandId },
        );
        tx.putDecision(next);
        const code = checked ? 'signal-completed' : 'signal-reopened';
        /** @param {number | null} seq */
        const build = seq =>
          committed(code, [signal.id], {
            revision: next.decisionRevision,
            ...(seq === null ? {} : { commitSeq: seq }),
          });
        tx.keep(command.commandId, fingerprint, build);
        return build;
      },
    );
    publish(made);
    return typeof result === 'function' ? result(commitSeq) : result;
  };

  /**
   * After a note revision conflict: re-derive the task through its producer, so the signal
   * reads the revision that stands and the next try can commit, and answer with the state
   * that stands then
   * @param {IntelligenceSignal} signal
   * @param {DecisionState} current
   * @returns {Promise<IntelligenceOutcome>}
   */
  const afterNoteConflict = async (signal, current) => {
    const drafts = await rederive([signal]);
    const now = clock.now();
    /** @type {string[]} */
    const changed = [];
    const { result, events: made } = await repository.transact(tx => {
      if (drafts.get(signal.id)) applyRederived(tx, drafts, now, changed);
      const latest = tx.signal(signal.id);
      return latest ? decisionStateOf(latest, tx.decision(signal.id), now) : current;
    });
    publish(made);
    return signalConflict('note-revision-conflict', result);
  };

  /** @type {Map<string, Promise<unknown>>} the last command running for each signal, here */
  const running = new Map();

  /**
   * Runs `task` after every command this context started for `signalId` before it, so in one
   * context a command never interleaves with another for the same signal: an objective task's
   * phases run back to back, a concurrent command conflicts before any note write, and a
   * duplicate waits for the first and gets its outcome
   * @template T
   * @param {string} signalId
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  const oneAtATime = (signalId, task) => {
    const previous = running.get(signalId) ?? Promise.resolve();
    const result = previous.then(task, task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    running.set(signalId, settled);
    settled.then(() => {
      if (running.get(signalId) === settled) running.delete(signalId);
    });
    return result;
  };

  /**
   * Runs one lifecycle command and answers its outcome, whatever the repository or the note
   * command does
   * @param {unknown} input
   * @returns {Promise<IntelligenceOutcome>}
   */
  async function execute(input) {
    const parsed = v.safeParse(commandSchema, input);
    if (!parsed.success) return rejected('validation', 'invalid-command');
    const command = parsed.output;
    const fingerprint = digestOf(command);
    return oneAtATime(command.signalId, async () => {
      try {
        const now = clock.now();
        const first = await decide(command, fingerprint, now);
        if ('outcome' in first) return first.outcome;
        const { signal, checked, current } = first.note;
        const anchorBlockId = /** @type {string} */ (signal.identity.anchorBlockId);
        const anchor = signal.sourceRefs.find(source => source.kind === 'block' && source.blockId === anchorBlockId);
        let noteOutcome;
        try {
          noteOutcome = await noteCommands.setTodoChecked({
            commandId: command.commandId,
            noteId: signal.identity.noteId,
            blockId: anchorBlockId,
            checked,
            expectedRevision: anchor?.revision ?? null,
          });
        } catch (error) {
          return unavailableFrom(error);
        }
        // The note changed since the signal read it: nothing of this command was written
        if (noteOutcome.kind === 'conflict') return afterNoteConflict(signal, current);
        if (noteOutcome.kind !== 'committed') return noteOutcome;
        return await followNote(command, fingerprint, signal, checked, noteOutcome);
      } catch (error) {
        return unavailableFrom(error);
      }
    });
  }

  // ============ Reads ============

  /**
   * One signal with its decision and corrections, as of a commitSeq read with them
   * @param {string} signalId
   * @returns {Promise<SignalRead>}
   */
  async function readSignal(signalId) {
    const now = clock.now();
    const { result, asOf } = await repository.transact(tx => {
      const signal = tx.signal(signalId);
      if (!signal) return null;
      const decision = tx.decision(signalId);
      return { signal, decision, corrections: tx.corrections(signalId) };
    });
    if (!result) return { kind: 'not-found', asOfCommitSeq: asOf };
    return {
      kind: 'ready',
      asOfCommitSeq: asOf,
      ...result,
      state: decisionStateOf(result.signal, result.decision, now),
    };
  }

  // ============ The producer side ============

  /**
   * What a producer offered, as a signal: its text redacted (records.js, redactText), current,
   * one revision past what it replaces, and still unavailable where the notes it cites are
   * @param {SignalDraft} draft
   * @param {IntelligenceSignal | null} existing
   * @param {number} now
   * @returns {IntelligenceSignal}
   */
  const signalFrom = (draft, existing, now) => {
    const cited = new Set([draft.identity.noteId, ...draft.sourceRefs.map(source => source.noteId)]);
    /** @type {IntelligenceSignal} */
    const signal = {
      recordVersion: RECORD_VERSION,
      id: idOfIdentity(draft.identity),
      ...draft,
      title: typeof draft.title === 'string' ? plainTitle(draft.title) : draft.title,
      confidence:
        draft.confidence && typeof draft.confidence.reason === 'string'
          ? { ...draft.confidence, reason: redactText(draft.confidence.reason, REASON_MAX) }
          : draft.confidence,
      generatedAt: now,
      freshness: { state: 'current', cause: null, since: null, invalidatedAt: null, resumeTo: null },
      unavailableNotes: (existing?.unavailableNotes ?? []).filter(entry => cited.has(entry.noteId)),
      revision: (existing?.revision ?? 0) + 1,
    };
    return withAvailability(signal, now);
  };

  /**
   * Writes what a producer made: each draft becomes a current signal under its identity's id,
   * so a re-derived or regenerated signal keeps the id, and its decision and corrections, it
   * had. A draft from another producer, or one that isn't a valid signal, is refused by id.
   * @param {string} producerId
   * @param {readonly SignalDraft[]} drafts
   * @returns {Promise<DomainResult>}
   */
  async function upsertSignals(producerId, drafts) {
    const now = clock.now();
    const {
      result,
      commitSeq,
      events: made,
    } = await repository.transact(tx => {
      /** @type {string[]} */
      const changed = [];
      /** @type {string[]} */
      const refused = [];
      for (const draft of drafts) {
        if (draft?.identity?.producerId !== producerId) {
          refused.push('wrong-producer');
          continue;
        }
        let id;
        try {
          id = idOfIdentity(draft.identity);
        } catch {
          refused.push('invalid-identity');
          continue;
        }
        const existing = tx.signal(id);
        let signal;
        try {
          signal = signalFrom(draft, existing, now);
        } catch {
          refused.push('invalid-signal');
          continue;
        }
        const problem = signalRefusal(signal);
        if (problem) {
          refused.push(problem);
          continue;
        }
        tx.putSignal(signal);
        changed.push(id);
      }
      return { changed, refused };
    });
    publish(made);
    return { commitSeq, changed: result.changed, removed: [], regeneration: [], refused: result.refused };
  }

  /**
   * Re-derives `signals` through their producers. A producer with no `derive`, or one that
   * gives nothing back, leaves the signal invalidated as `not-reproduced`.
   * @param {IntelligenceSignal[]} signals
   * @returns {Promise<Map<string, SignalDraft | null>>}
   */
  const rederive = async signals => {
    /** @type {Map<string, SignalDraft | null>} */
    const drafts = new Map();
    for (const signal of signals) {
      const producer = producerById.get(signal.identity.producerId);
      let draft = null;
      try {
        draft = producer?.derive ? await producer.derive({ ...signal.identity }) : null;
      } catch (error) {
        logger.warn('producer-derive-failed', { error });
      }
      drafts.set(signal.id, draft && idOfIdentity(draft.identity) === signal.id ? draft : null);
    }
    return drafts;
  };

  /**
   * Applies re-derived drafts inside a transaction: each draft replaces its signal, and a
   * missing one invalidates it. A signal whose notes are unavailable stays suspended, with the
   * new derivation to resume to.
   * @param {IntelligenceTx} tx
   * @param {Map<string, SignalDraft | null>} drafts
   * @param {number} now
   * @param {string[]} changed
   */
  const applyRederived = (tx, drafts, now, changed) => {
    for (const [id, draft] of drafts) {
      const existing = tx.signal(id);
      if (!existing || existing.freshness.state === 'invalidated') continue;
      let signal = null;
      try {
        signal = draft ? signalFrom(draft, existing, now) : null;
      } catch {
        signal = null;
      }
      tx.putSignal(signal && signalRefusal(signal) === null ? signal : invalidated(existing, 'not-reproduced', now));
      changed.push(id);
    }
  };

  /**
   * The regeneration requests for inferred signals that are stale now and weren't before, one
   * per note, recipe, and cause
   * @param {IntelligenceTx} tx
   * @param {Array<{before: IntelligenceSignal, after: IntelligenceSignal}>} moves
   * @param {number} now
   * @returns {RegenerationRequest[]}
   */
  const requestsFor = (tx, moves, now) => {
    /** @type {Map<RegenerationCause, Array<{signal: IntelligenceSignal, priority: number}>>} */
    const byCause = new Map();
    for (const { before, after } of moves) {
      if (after.provenance !== 'inferred' || after.freshness.state !== 'stale' || before.freshness.state === 'stale') {
        continue;
      }
      const cause = /** @type {RegenerationCause} */ (after.freshness.cause);
      if (!REGENERATION_CAUSES.includes(cause)) continue;
      byCause.set(cause, [...(byCause.get(cause) ?? []), { signal: after, priority: priorityOf(tx, after, now) }]);
    }
    return [...byCause].flatMap(([cause, signals]) => regenerationRequestsFor(signals, cause));
  };

  /**
   * Stales each inferred signal, and answers the requests that regenerate them. A suspended one
   * goes stale when it's restored, and its request goes then.
   * @param {IntelligenceTx} tx
   * @param {IntelligenceSignal[]} signals
   * @param {FreshnessCause & RegenerationCause} cause
   * @param {number} now
   * @param {string[]} changed
   * @returns {RegenerationRequest[]}
   */
  const staleAll = (tx, signals, cause, now, changed) => {
    /** @type {Array<{before: IntelligenceSignal, after: IntelligenceSignal}>} */
    const moves = [];
    for (const signal of signals) {
      const next = staled(signal, cause, now);
      if (next === signal) continue;
      tx.putSignal(next);
      changed.push(signal.id);
      moves.push({ before: signal, after: next });
    }
    return requestsFor(tx, moves, now);
  };

  /**
   * Applies a note-side change through the invalidation table, to the note's own signals and
   * to other notes' signals that cite it
   * @param {unknown} input
   * @returns {Promise<DomainResult>}
   */
  async function noteChanged(input) {
    const parsed = v.safeParse(noteChangeSchema, input);
    if (!parsed.success) throw new TypeError('not a note change the table knows');
    const change = parsed.output;
    const now = clock.now();
    /** @type {string[]} */
    const changed = [];
    /** @type {string[]} */
    const removed = [];

    if (change.type === 'block-edited') {
      const { result: own } = await repository.transact(tx => tx.signalsOfNote(change.noteId));
      // Until #17's block revisions, a block cites its note's revision, so every objective
      // signal of the note is re-derived, and only the edited block's inferences go stale
      const objective = own.filter(
        signal => signal.provenance === 'objective' && signal.identity.anchorBlockId !== null,
      );
      const drafts = await rederive(objective);
      const {
        result: requests,
        commitSeq,
        events: made,
      } = await repository.transact(tx => {
        applyRederived(tx, drafts, now, changed);
        // An inference read at the edit's revision already saw it, as when an edit is heard twice
        const sawEdit = (/** @type {IntelligenceSignal} */ signal) =>
          change.revision !== null &&
          signal.sourceRefs.some(
            source =>
              source.kind === 'block' && source.blockId === change.blockId && source.revision === change.revision,
          );
        const inferred = own
          .filter(signal => signal.provenance === 'inferred' && signal.identity.anchorBlockId === change.blockId)
          .map(signal => tx.signal(signal.id))
          .filter(/** @returns {signal is IntelligenceSignal} */ signal => signal !== null && !sawEdit(signal));
        return staleAll(tx, inferred, 'source-edited', now, changed);
      });
      publish(made);
      send(requests);
      return { commitSeq, changed, removed, regeneration: requests, refused: [] };
    }

    const {
      result: requests,
      commitSeq,
      events: made,
    } = await repository.transact(
      /** @returns {RegenerationRequest[]} */ tx => {
        if (change.type === 'block-deleted') {
          for (const signal of tx.signalsOfNote(change.noteId)) {
            if (signal.identity.anchorBlockId !== change.blockId) continue;
            const next = invalidated(signal, 'anchor-deleted', now);
            if (next !== signal) {
              tx.putSignal(next);
              changed.push(signal.id);
            }
            const decision = tx.decision(signal.id);
            if (
              decision &&
              decision.tombstone === null &&
              INVALIDATION_TABLE['anchor-deleted'].decision === 'tombstone'
            ) {
              tx.putDecision(
                nextDecision(
                  decision,
                  {
                    action: 'tombstone',
                    status: decision.status,
                    snoozedUntil: decision.snoozedUntil,
                    dismissReason: decision.dismissReason,
                  },
                  { signalId: signal.id, identity: signal.identity, now, commandId: null },
                ),
              );
            }
          }
          return [];
        }
        if (change.type === 'note-state') {
          const cause = suspensionOf(change);
          /** @type {Array<{before: IntelligenceSignal, after: IntelligenceSignal}>} */
          const moves = [];
          for (const signal of [...tx.signalsOfNote(change.noteId), ...tx.signalsCiting(change.noteId)]) {
            const next = withNoteState(signal, change.noteId, cause, now);
            if (next === signal) continue;
            tx.putSignal(next);
            changed.push(signal.id);
            moves.push({ before: signal, after: next });
          }
          // An inference that went stale while suspended asks to be regenerated now
          return requestsFor(tx, moves, now);
        }
        // Deleted for good: its signals, decisions, and corrections go in this one unit, and
        // other notes' signals stop citing it
        const ids = new Set([
          ...tx.signalsOfNote(change.noteId).map(signal => signal.id),
          ...tx.decisionsOfNote(change.noteId).map(decision => decision.signalId),
          ...tx.correctedSignalsOfNote(change.noteId),
        ]);
        for (const id of ids) {
          tx.deleteSignal(id);
          tx.deleteDecision(id);
          tx.deleteCorrections(id);
          removed.push(id);
        }
        for (const signal of tx.signalsCiting(change.noteId)) {
          tx.putSignal(withoutNote(signal, change.noteId, now));
          changed.push(signal.id);
        }
        return [];
      },
    );
    publish(made);
    send(requests);
    return { commitSeq, changed, removed, regeneration: requests, refused: [] };
  }

  /**
   * The invalidation hook #8 calls when a producer or recipe version, a model, a runtime, a
   * route, or a scope grant changes
   * @param {unknown} input - {cause, match}
   * @returns {Promise<DomainResult>}
   */
  async function invalidate(input) {
    const parsed = v.safeParse(invalidateSchema, input);
    if (!parsed.success) throw new TypeError('not an invalidation the hook knows');
    const invalidation = parsed.output;
    const now = clock.now();
    const effects = INVALIDATION_TABLE[invalidation.cause];
    /** @type {string[]} */
    const changed = [];
    const { result: matched } = await repository.transact(tx =>
      tx.everySignal().filter(signal => matches(signal, invalidation) && signal.freshness.state !== 'invalidated'),
    );
    const objective = matched.filter(signal => signal.provenance === 'objective');
    const drafts = effects.objective === 'rederive' ? await rederive(objective) : new Map();
    const {
      result: requests,
      commitSeq,
      events: made,
    } = await repository.transact(tx => {
      applyRederived(tx, drafts, now, changed);
      const inferred = matched
        .filter(signal => signal.provenance === 'inferred')
        .map(signal => tx.signal(signal.id))
        .filter(/** @returns {signal is IntelligenceSignal} */ signal => signal !== null);
      if (effects.inferred === 'invalidate-and-clear') {
        for (const signal of inferred) {
          tx.putSignal(invalidated(signal, 'scope-revoked', now, { clear: true }));
          changed.push(signal.id);
        }
        return [];
      }
      const cause = invalidation.cause === 'producer-version' ? 'recipe-version' : invalidation.cause;
      return staleAll(tx, inferred, /** @type {FreshnessCause & RegenerationCause} */ (cause), now, changed);
    });
    publish(made);
    send(requests);
    return { commitSeq, changed, removed: [], regeneration: requests, refused: [] };
  }

  return Object.freeze({ execute, readSignal, upsertSignals, noteChanged, invalidate });
}
