/**
 * The in-memory intelligence repository (intelligence/repository.js): signals, decisions,
 * and corrections, each in its own map and never beside a note. Transactions run one at a
 * time, in the order they open, as IndexedDB runs readwrite transactions over the same stores.
 * A transaction's writes are staged and commit together, or none do, and everything goes in and
 * out as a copy.
 *
 * Every record is checked against its schema when it's written, and again when it's read, as
 * #17's repositories check what comes off disk. One that fails on read is moved to quarantine,
 * counted, and reads as absent, so a damaged record is never shown and never used to decide.
 * `initial` loads records as storage would hold them, unchecked, so a test can plant one.
 *
 * Given #13's in-memory commit log (memory/commit-log.js), a commit that writes appends one
 * change per signal it touched, with `entityType: 'intelligence'` and the signal's entity
 * revision, and the commitSeq it gets back is the commit's. Without one it counts its own.
 */

import { clone } from '../contracts/clone.js';
import { correctionRecord, decisionRecord, signalRecord } from '../intelligence/records.js';
import * as v from '../../../lib/valibot/index.mjs';

/** @typedef {import('../intelligence/records.js').IntelligenceSignal} IntelligenceSignal */
/** @typedef {import('../intelligence/records.js').SignalDecision} SignalDecision */
/** @typedef {import('../intelligence/records.js').SignalCorrection} SignalCorrection */
/** @typedef {import('../intelligence/repository.js').IntelligenceRepository} IntelligenceRepository */
/** @typedef {import('../intelligence/repository.js').IntelligenceTx} IntelligenceTx */
/** @typedef {import('../intelligence/repository.js').KeptOutcome} KeptOutcome */
/** @typedef {import('../intelligence/repository.js').PendingNote} PendingNote */
/** @typedef {import('../intelligence/operations.js').IntelligenceOutcome} IntelligenceOutcome */
/** @typedef {import('../intelligence/events.js').IntelligenceEvent} IntelligenceEvent */
/** @typedef {import('../intelligence/events.js').EventType} EventType */
/** @typedef {import('./commit-log.js').MemoryCommitLog} MemoryCommitLog */

/**
 * @typedef {object} MemoryIntelligenceOptions
 * @property {MemoryCommitLog} [commitLog] - #17's change log, shared with the note adapter
 * @property {{signals?: unknown[], decisions?: unknown[], corrections?: unknown[]}} [initial]
 *   Records as storage holds them, which are checked only when read
 * @property {() => void} [beforeCommit] - runs before a commit that writes; a throw fails it
 */

/**
 * @typedef {IntelligenceRepository & {
 *   quarantinedRecords: () => {signals: unknown[], decisions: unknown[], corrections: unknown[]},
 * }} MemoryIntelligenceRepository
 */

/**
 * @param {unknown} record
 * @returns {string | null}
 */
const keyOf = (record, field = 'id') => {
  if (record === null || typeof record !== 'object') return null;
  const key = /** @type {Record<string, unknown>} */ (record)[field];
  return typeof key === 'string' ? key : null;
};

/**
 * @param {MemoryIntelligenceOptions} [options]
 * @returns {MemoryIntelligenceRepository}
 */
export function createMemoryIntelligenceRepository({ commitLog, initial = {}, beforeCommit = () => {} } = {}) {
  /** @type {Map<string, unknown>} */
  const signals = new Map();
  /** @type {Map<string, unknown>} */
  const decisions = new Map();
  /** @type {Map<string, unknown[]>} */
  const corrections = new Map();
  /** @type {Map<string, KeptOutcome>} */
  const outcomes = new Map();
  /** @type {Map<string, PendingNote>} */
  const pendingNotes = new Map();
  /** @type {Map<string, number>} each signal id's entity revision, which its hints carry */
  const entityRevisions = new Map();
  const quarantine = {
    signals: /** @type {unknown[]} */ ([]),
    decisions: /** @type {unknown[]} */ ([]),
    corrections: /** @type {unknown[]} */ ([]),
  };
  let lastSeq = 0;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  for (const record of initial.signals ?? []) signals.set(keyOf(record) ?? `unkeyed-${signals.size}`, clone(record));
  for (const record of initial.decisions ?? []) {
    decisions.set(keyOf(record, 'signalId') ?? `unkeyed-${decisions.size}`, clone(record));
  }
  for (const record of initial.corrections ?? []) {
    const key = keyOf(record, 'signalId') ?? 'unkeyed';
    corrections.set(key, [...(corrections.get(key) ?? []), clone(record)]);
  }

  /**
   * The stored signal under `key`, checked, or null; one that fails is quarantined
   * @param {string} key
   * @returns {IntelligenceSignal | null}
   */
  const storedSignal = key => {
    if (!signals.has(key)) return null;
    const record = signals.get(key);
    if (v.is(signalRecord, record) && record.id === key) return clone(record);
    signals.delete(key);
    quarantine.signals.push(record);
    return null;
  };

  /**
   * @param {string} key
   * @returns {SignalDecision | null}
   */
  const storedDecision = key => {
    if (!decisions.has(key)) return null;
    const record = decisions.get(key);
    if (v.is(decisionRecord, record) && record.signalId === key) return clone(record);
    decisions.delete(key);
    quarantine.decisions.push(record);
    return null;
  };

  /**
   * @param {string} key
   * @returns {SignalCorrection[]}
   */
  const storedCorrections = key => {
    const list = corrections.get(key);
    if (!list) return [];
    /** @type {SignalCorrection[]} */
    const valid = [];
    const kept = [];
    for (const record of list) {
      if (v.is(correctionRecord, record) && record.signalId === key) {
        valid.push(clone(record));
        kept.push(record);
      } else {
        quarantine.corrections.push(record);
      }
    }
    if (kept.length === 0) corrections.delete(key);
    else corrections.set(key, kept);
    return valid;
  };

  /**
   * Run `task` after every transaction opened before it
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  const serial = task => {
    const result = queue.then(task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return Object.freeze({
    transact(work) {
      return serial(async () => {
        /** @type {Map<string, IntelligenceSignal | null>} */
        const stagedSignals = new Map();
        /** @type {Map<string, SignalDecision | null>} */
        const stagedDecisions = new Map();
        /** @type {Map<string, SignalCorrection[]>} */
        const appended = new Map();
        /** @type {Set<string>} */
        const clearedCorrections = new Set();
        /** @type {Map<string, {fingerprint: string, outcome: (commitSeq: number | null) => IntelligenceOutcome}>} */
        const stagedOutcomes = new Map();
        /** @type {Map<string, PendingNote>} */
        const stagedPending = new Map();
        /** @type {Map<string, Set<EventType>>} */
        const touched = new Map();
        /**
         * @param {string} signalId
         * @param {EventType} type
         */
        const touch = (signalId, type) => {
          const types = touched.get(signalId) ?? new Set();
          types.add(type);
          touched.set(signalId, types);
        };

        /** @param {string} key */
        const signalNow = key => (stagedSignals.has(key) ? clone(stagedSignals.get(key) ?? null) : storedSignal(key));
        /** @param {string} key */
        const decisionNow = key =>
          stagedDecisions.has(key) ? clone(stagedDecisions.get(key) ?? null) : storedDecision(key);
        /** @param {string} key */
        const correctionsNow = key => [
          ...(clearedCorrections.has(key) ? [] : storedCorrections(key)),
          ...clone(appended.get(key) ?? []),
        ];
        const signalKeys = () => [...new Set([...signals.keys(), ...stagedSignals.keys()])];

        /** @type {IntelligenceTx} */
        const tx = {
          signal: signalNow,
          signalsOfNote: noteId =>
            signalKeys()
              .map(signalNow)
              .filter(
                /** @returns {signal is IntelligenceSignal} */ signal =>
                  signal !== null && signal.identity.noteId === noteId,
              ),
          signalsCiting: noteId =>
            signalKeys()
              .map(signalNow)
              .filter(
                /** @returns {signal is IntelligenceSignal} */ signal =>
                  signal !== null &&
                  signal.identity.noteId !== noteId &&
                  signal.sourceRefs.some(source => source.noteId === noteId),
              ),
          everySignal: () =>
            signalKeys()
              .map(signalNow)
              .filter(/** @returns {signal is IntelligenceSignal} */ signal => signal !== null),
          decision: decisionNow,
          decisionsOfNote: noteId =>
            [...new Set([...decisions.keys(), ...stagedDecisions.keys()])]
              .map(decisionNow)
              .filter(
                /** @returns {decision is SignalDecision} */ decision =>
                  decision !== null && decision.identity.noteId === noteId,
              ),
          corrections: correctionsNow,
          correctedSignalsOfNote: noteId =>
            [...new Set([...corrections.keys(), ...appended.keys()])].filter(key =>
              correctionsNow(key).some(correction => correction.identity.noteId === noteId),
            ),
          kept: commandId => {
            const kept = outcomes.get(commandId);
            return kept ? clone(kept) : null;
          },
          putSignal: signal => {
            if (!v.is(signalRecord, signal)) throw new TypeError('not a valid signal');
            stagedSignals.set(signal.id, clone(signal));
            touch(signal.id, 'intelligence.signalChanged');
          },
          deleteSignal: signalId => {
            if (signalNow(signalId) === null) return;
            stagedSignals.set(signalId, null);
            touch(signalId, 'intelligence.signalRemoved');
          },
          putDecision: decision => {
            if (!v.is(decisionRecord, decision)) throw new TypeError('not a valid decision');
            stagedDecisions.set(decision.signalId, clone(decision));
            touch(decision.signalId, 'intelligence.decisionChanged');
          },
          deleteDecision: signalId => {
            if (decisionNow(signalId) === null) return;
            stagedDecisions.set(signalId, null);
            touch(signalId, 'intelligence.decisionRemoved');
          },
          appendCorrection: correction => {
            if (!v.is(correctionRecord, correction)) throw new TypeError('not a valid correction');
            appended.set(correction.signalId, [...(appended.get(correction.signalId) ?? []), clone(correction)]);
            touch(correction.signalId, 'intelligence.correctionAppended');
          },
          deleteCorrections: signalId => {
            if (correctionsNow(signalId).length === 0) return;
            clearedCorrections.add(signalId);
            appended.delete(signalId);
            touch(signalId, 'intelligence.correctionsRemoved');
          },
          pendingNote: commandId => {
            const pending = stagedPending.get(commandId) ?? pendingNotes.get(commandId);
            return pending ? clone(pending) : null;
          },
          keepPendingNote: (commandId, pending) => {
            if (!pendingNotes.has(commandId)) stagedPending.set(commandId, clone(pending));
          },
          keep: (commandId, fingerprint, outcome) => {
            if (!outcomes.has(commandId) && !stagedOutcomes.has(commandId)) {
              stagedOutcomes.set(commandId, { fingerprint, outcome });
            }
          },
        };

        const result = work(tx);
        if (touched.size === 0 && stagedOutcomes.size === 0 && stagedPending.size === 0)
          return { result, commitSeq: null, asOf: lastSeq, events: [] };

        /** @type {number | null} */
        let commitSeq = null;
        /** @type {Map<string, number>} */
        const revisions = new Map();
        if (touched.size > 0) {
          beforeCommit();
          for (const signalId of touched.keys()) revisions.set(signalId, (entityRevisions.get(signalId) ?? 0) + 1);
          const changes = [...revisions].map(([entityId, revision]) => ({
            entityType: /** @type {const} */ ('intelligence'),
            entityId,
            revision,
          }));
          commitSeq = commitLog ? commitLog.append(changes) : lastSeq + 1;
        }
        // Everything below only copies what's staged, so the commit can't stop part way
        const kept = [...stagedOutcomes].map(([commandId, { fingerprint, outcome }]) => [
          commandId,
          { fingerprint, outcome: clone(outcome(commitSeq)) },
        ]);
        for (const [key, signal] of stagedSignals) {
          if (signal === null) signals.delete(key);
          else signals.set(key, signal);
        }
        for (const [key, decision] of stagedDecisions) {
          if (decision === null) decisions.delete(key);
          else decisions.set(key, decision);
        }
        for (const key of clearedCorrections) corrections.delete(key);
        for (const [key, list] of appended) corrections.set(key, [...(corrections.get(key) ?? []), ...list]);
        for (const [commandId, record] of kept)
          outcomes.set(/** @type {string} */ (commandId), /** @type {KeptOutcome} */ (record));
        for (const [commandId, pending] of stagedPending) pendingNotes.set(commandId, pending);
        for (const [signalId, revision] of revisions) entityRevisions.set(signalId, revision);
        if (commitSeq !== null) lastSeq = commitSeq;

        /** @type {IntelligenceEvent[]} */
        const events = [];
        for (const [signalId, types] of touched) {
          for (const type of types) {
            events.push({
              type,
              entityType: 'intelligence',
              entityId: signalId,
              revision: /** @type {number} */ (revisions.get(signalId)),
              commitSeq: /** @type {number} */ (commitSeq),
            });
          }
        }
        return { result, commitSeq, asOf: lastSeq, events };
      });
    },
    quarantined: () => ({
      signals: quarantine.signals.length,
      decisions: quarantine.decisions.length,
      corrections: quarantine.corrections.length,
    }),
    quarantinedRecords: () => clone(quarantine),
  });
}
