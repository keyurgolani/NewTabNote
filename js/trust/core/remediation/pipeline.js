/**
 * The remediation pipeline (#20, "Remediation pipeline"; approved AC4): recovery.run's use
 * case, in-process. No root registers a handler for it yet; slice 4's views do, on the new tab
 * and recovery.html.
 *
 * Every run goes plan, preview, protect, apply, verify, record, and its RemediationRun names
 * the step it's on, written before that step starts:
 * - plan: the run's record is written first, before anything else happens, so the first
 *   mutation always comes after it. A run whose record won't write stops there, unavailable
 *   `not-recorded`, having changed nothing. The one exception is a non-destructive run that
 *   changes no stored record (`recordOptional`: Save as file, the salvage file, a retry), which
 *   goes on and answers `recorded: false`, so the salvage file still saves while IndexedDB,
 *   NewTabNoteTrust included, won't take writes. The incident it answers, when it names one,
 *   must be open and from a provider the remediation applies to.
 * - preview: what applying would change, counts per target (preview.js). A non-destructive or
 *   regenerable preview that changes a user-owned store at all is refused, a reversible one
 *   that deletes from one is refused, and one with nothing to do ends the run `cancelled`. A
 *   class that needs the user's confirmation stops here, `awaiting-confirmation`, with the
 *   preview and its digest, until the view sends the same remediation again with the run's
 *   id, the decision, and that digest. The preview is taken again then, and one whose digest
 *   isn't the one confirmed goes back to the user (`preview-changed`) rather than apply what
 *   they didn't see, however often the confirmation is sent.
 * - What it destroys (`destroys`), checked once the preview is taken: an irreversible run
 *   must name the one legacy copy, point, or record it destroys, and a secret removal the
 *   saved-key places it removes, the same its preview lists, while its preview changes nothing
 *   but deleting those. A run that names nothing, or anything else, fails `destroys-unnamed` or
 *   `changes-user-records` before anything is saved or changed. No other class touches the
 *   saved keys.
 * - protect: what the class needs before apply (gates.js): a verified #17 `pre-repair` point
 *   that holds every record the run changes, for a reversible run; a salvage file saved
 *   through the picker, read back verified, holding all of CanvasTabDB and the rows of what
 *   the run destroys (salvage-file.js's readOf), in this run, for an irreversible one. Either
 *   failing ends the run before apply; a cancelled picker goes back to the preview.
 * - apply, then verify: the remediation's own steps. A run is `succeeded` only once verify
 *   passed, `verified`, or `saved-partial` (a warning) for a saved file that couldn't read
 *   every source, which the answer's `unreadable` names; everything else is `failed`,
 *   `cancelled`, or still `awaiting-confirmation`, with its outcome code, and never answers as
 *   committed. A saved file's answer says how much it holds (`saved`), and a run that made a
 *   note names it (`noteId`).
 * - record: the last write, of how it ended, and a `remediation.finished` journal event.
 * A step's record that won't write after apply has begun doesn't stop the run (what it changed
 * is changed), but the answer says `recorded: false`.
 *
 * Each remediation key runs once across tabs and the worker: the run holds Web Lock
 * `recovery.run.<id>`, or `recovery.run.<id>.<subject>` for a remediation that declares it
 * takes a subject (`takesSubject`, Save as file), with `ifAvailable`, and a second run of the
 * key answers unavailable `coordinator` `remediation-running`. Any other remediation refuses a
 * subject, so no subject splits its lock. A host without Web Locks runs nothing (`no-locks`),
 * since nothing else would keep a run to one context. A commandId sent again answers what it
 * answered the first time. On the next start, reconcile() reads each `running` run again under
 * its lock and, when it's still running there, marks it `interrupted` at the step it stopped
 * at; it cancels a run left awaiting confirmation past PENDING_MS.
 *
 * Nothing here deletes a user-owned record, and no remediation in catalog.js does either. Nor
 * does the pipeline resolve an incident: a verified run never resolves its incident, which
 * resolves only when its provider's check passes again (recovery.check after a repair, or
 * trust.verify), as #80's contract has it.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { rejected, unavailable, unavailableFrom } from '../../../kernel/core/contracts/outcomes.js';
import { effectiveStatus } from '../checks.js';
import { RUN_OUTCOMES } from '../codes.js';
import { payload as runPayload } from '../operations/recovery-run.js';
import { CANCELLED_BY_USER, fileName, savedOf } from './catalog.js';
import { CLASS_PROTECTIONS, checkConsent, checkProtected, needsConfirmation } from './gates.js';
import {
  changesUserRecords,
  deletesUserRecords,
  digestOf,
  previewSchema,
  secretRemovalRefusal,
  touchesSavedKeys,
} from './preview.js';
import { MAX_UNREADABLE, buildSalvage } from './salvage-file.js';
import { saveVerified } from './saved-file.js';

/** @typedef {import('../trust-records.js').TrustRecords} TrustRecords */
/** @typedef {import('../journal.js').DiagnosticJournal} DiagnosticJournal */
/** @typedef {import('../ports.js').Clock} Clock */
/** @typedef {import('../ports.js').Ids} Ids */
/** @typedef {import('../records.js').RemediationRun} RemediationRun */
/** @typedef {import('../records.js').Incident} Incident */
/** @typedef {import('../vocabulary.js').RemediationClass} RemediationClass */
/** @typedef {import('../vocabulary.js').RunState} RunState */
/** @typedef {import('../vocabulary.js').RunStep} RunStep */
/** @typedef {import('../vocabulary.js').ProviderStatus} ProviderStatus */
/** @typedef {import('./ports.js').RunLocks} RunLocks */
/** @typedef {import('./ports.js').RemediationPorts} RemediationPorts */
/** @typedef {import('./ports.js').ProviderChecks} ProviderChecks */
/** @typedef {import('./preview.js').Preview} Preview */
/** @typedef {import('./catalog.js').RemediationSteps} RemediationSteps */
/** @typedef {import('./catalog.js').RemediationContext} RemediationContext */
/** @typedef {import('./catalog.js').Verdict} Verdict */
/** @typedef {import('./salvage-file.js').Unreadable} Unreadable */
/** @typedef {import('../records.js').Saved} Saved */
/** @typedef {import('../operations/recovery-run.js').RecoveryRun} RecoveryRun */
/** @typedef {import('../operations/recovery-run.js').RemediationAnswer} RemediationAnswer */
/** @typedef {import('../../../kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../../kernel/registry/resolve.js').Resolution} Resolution */
/** @typedef {import('../../../kernel/registry/runtime.js').Runtime} Runtime */

/** How long a run waits for its confirmation before reconcile() cancels it */
export const PENDING_MS = 30 * 60 * 1000;

/** How many commandIds' answers are kept for a resend */
export const REPLAYS = 100;

/**
 * The Web Lock a remediation key's run holds
 * @param {string} remediationId
 * @param {string | null | undefined} subjectId - only a remediation that takes a subject has one
 */
export function lockName(remediationId, subjectId) {
  return `recovery.run.${remediationId}${subjectId ? `.${subjectId}` : ''}`;
}

/**
 * `code` when it's a registered run outcome, or `fallback`
 * @param {unknown} code
 * @param {string} fallback
 * @returns {string}
 */
const outcomeCode = (code, fallback) =>
  typeof code === 'string' && /** @type {readonly string[]} */ (RUN_OUTCOMES).includes(code) ? code : fallback;

/**
 * The registered code a step's error carries, or `fallback`, never its message
 * @param {unknown} error
 * @param {string} fallback
 */
const codeOf = (error, fallback) =>
  outcomeCode(error && typeof error === 'object' ? /** @type {{code?: unknown}} */ (error).code : undefined, fallback);

/**
 * Whether an apply answered that its save failed after the user picked the file
 * @param {unknown} applied
 * @returns {applied is {failedAfterPick: true, code: string}}
 */
const isFailedAfterPick = applied =>
  applied !== null && typeof applied === 'object' && /** @type {{failedAfterPick?: unknown}} */ (applied).failedAfterPick === true;

/** @type {Readonly<Record<RunState, RemediationAnswer['severity']>>} */
const SEVERITY = Object.freeze({
  planned: 'info',
  'awaiting-confirmation': 'info',
  running: 'info',
  succeeded: 'success',
  failed: 'error',
  cancelled: 'info',
  interrupted: 'warning',
});

/**
 * A provider-checks port over the trust use cases: runs the providers' checks with
 * `verify-now`, and reads each one's status from a receipt made since, so a check whose
 * receipt didn't land never reads as the older receipt's `verified`
 * @param {{verify: (payload: unknown) => Promise<unknown>, records: TrustRecords, clock: Clock, ids: Ids}} options
 * @returns {ProviderChecks}
 */
export function providerChecks({ verify, records, clock, ids }) {
  return async providerIds => {
    const since = clock.now();
    await verify({ type: 'trust.verify', commandId: ids.next(), providerIds: [...providerIds], trigger: 'verify-now' });
    const latest = await records.latestReceipts();
    const now = clock.now();
    /** @type {Record<string, ProviderStatus>} */
    const statuses = {};
    for (const id of providerIds) {
      const receipt = latest.find(candidate => candidate.providerId === id);
      statuses[id] = receipt && receipt.verifiedAt >= since ? effectiveStatus(receipt, now) : 'unverified';
    }
    return statuses;
  };
}

/**
 * @param {{
 *   records: TrustRecords,
 *   journal: DiagnosticJournal,
 *   clock: Clock,
 *   ids: Ids,
 *   locks: RunLocks | null,
 *   registry: {resolution: Resolution, runtime: Runtime},
 *   ports?: RemediationPorts,
 *   hooks?: {between?: (step: RunStep) => void | Promise<void>},
 * }} options - `locks` is navigator.locks; `hooks` in tests only, to stop a run between steps
 *   as a closed tab stops it
 */
export function createRemediationPipeline({ records, journal, clock, ids, locks, registry, ports = {}, hooks = {} }) {
  /** The lock names this context holds now */
  const active = new Set();
  /**
   * Runs awaiting confirmation here, with when they started waiting
   * @type {Map<string, {at: number}>}
   */
  const pending = new Map();
  /** @type {Map<string, Promise<Outcome | RemediationAnswer>>} */
  const replays = new Map();

  /** @param {RunStep} step */
  const between = async step => {
    if (hooks.between) await hooks.between(step);
  };

  /** @param {Record<string, unknown>} fields */
  const note = fields => {
    if (records.state() !== 'fallback') journal.event('remediation.finished', fields);
  };

  /**
   * Runs `body` holding the key's lock, or answers null when another run holds it
   * @template T
   * @param {RunLocks} held - the host's Web Locks
   * @param {string} name
   * @param {() => Promise<T>} body
   * @returns {Promise<{value: T} | null>}
   */
  const exclusive = async (held, name, body) => {
    if (active.has(name)) return null;
    return held.request(name, { ifAvailable: true }, async lock => {
      if (!lock || active.has(name)) return null;
      active.add(name);
      try {
        return { value: await body() };
      } finally {
        active.delete(name);
      }
    });
  };

  /**
   * The enabled remediation contribution with `id`, and its steps, or null
   * @param {string} id
   * @returns {Promise<{remediationClass: RemediationClass, appliesTo: string[], steps: RemediationSteps} | null>}
   */
  const remediationOf = async id => {
    const contribution = registry.resolution
      .list('remediation')
      .find(item => item.id === id && item.ref !== null && item.state === 'enabled');
    if (!contribution) return null;
    const loaded = await registry.runtime.load(/** @type {string} */ (contribution.ref));
    const steps = loaded.ok ? /** @type {Record<string, unknown>} */ (loaded.implementation) : null;
    if (!steps || ['preview', 'apply', 'verify'].some(step => typeof steps[step] !== 'function')) return null;
    const data = /** @type {Record<string, any>} */ (contribution.data);
    return { remediationClass: data.class, appliesTo: [...data.appliesTo], steps: /** @type {any} */ (steps) };
  };

  /**
   * The open incident `incidentId` names, when the remediation applies to its provider
   * @param {string | null} incidentId
   * @param {readonly string[]} appliesTo
   * @returns {Promise<{ok: true, incident: Incident | null} | {ok: false}>}
   */
  const incidentFor = async (incidentId, appliesTo) => {
    if (!incidentId) return { ok: true, incident: null };
    const incident = (await records.incidents()).find(item => item.id === incidentId);
    if (!incident || incident.state === 'resolved' || !appliesTo.includes(incident.providerId)) return { ok: false };
    return { ok: true, incident };
  };

  /**
   * Why `preview` can't run in `remediationClass`, or null: nothing deletes user-owned records
   * on its own, a class that takes no recovery point changes none, and only a secret removal
   * touches the saved keys
   * @param {RemediationClass} remediationClass
   * @param {Preview} preview
   */
  const refusalOf = (remediationClass, preview) => {
    if (remediationClass === 'secret-removal') return null;
    if (touchesSavedKeys(preview)) return 'changes-user-records';
    if (remediationClass === 'irreversible') return null;
    if (remediationClass === 'reversible') return deletesUserRecords(preview) ? 'deletes-user-records' : null;
    if (deletesUserRecords(preview)) return 'deletes-user-records';
    return changesUserRecords(preview) ? 'changes-user-records' : null;
  };

  /**
   * One run, from its record to its answer
   * @param {RemediationRun} first
   * @param {{remediationClass: RemediationClass, appliesTo: string[], steps: RemediationSteps}} remediation
   */
  const runner = (first, { remediationClass, appliesTo, steps }) => {
    let run = first;
    let recorded = true;
    // Only a non-destructive run that changes no stored record (a file saved, a retry) goes on
    // when its record won't write, so the salvage file still saves while IndexedDB is down;
    // every other run stops before it changes anything
    const mustRecord = !(remediationClass === 'non-destructive' && steps.recordOptional === true);
    /** @type {Preview | null} */
    let shown = null;
    // What a saved file couldn't read (the first MAX_UNREADABLE), how many, and whether the file
    // the user picked may be empty: from the stored run, so a resend answers as it finished
    /** @type {Unreadable[]} */
    let unreadable = first.unreadable ? [...first.unreadable] : [];
    let unreadableCount = first.unreadableCount ?? unreadable.length;
    let fileMayBeEmpty = first.fileMayBeEmpty === true;
    // How much a file it saved holds, and the note it made, from the stored run too
    /** @type {Saved | undefined} */
    let saved = first.saved;
    /** @type {string | undefined} */
    let noteId = first.noteId;
    /** @param {readonly Unreadable[]} list */
    const setUnreadable = list => {
      unreadable = list.slice(0, MAX_UNREADABLE);
      unreadableCount = list.length;
    };
    /** @type {RemediationContext | null} */
    let context = null;

    /** @param {Partial<RemediationRun>} changes */
    const save = async changes => {
      run = { ...run, ...changes, updatedAt: clock.now() };
      const stored = await records.putRun(run);
      if (!stored.recorded) recorded = false;
      return stored.recorded;
    };

    /** @returns {RemediationAnswer} */
    const answer = () => ({
      kind: 'remediation',
      runId: run.id,
      remediationId: run.commandId,
      class: remediationClass,
      state: run.state,
      step: run.step ?? null,
      outcome: run.outcome,
      needs: [...CLASS_PROTECTIONS[remediationClass]],
      impact: shown,
      previewDigest: shown ? digestOf(shown) : null,
      unreadable,
      unreadableCount,
      fileMayBeEmpty,
      ...(saved ? { saved: { ...saved } } : {}),
      ...(noteId ? { noteId } : {}),
      ...(run.recoveryPointId ? { recoveryPointId: run.recoveryPointId } : {}),
      recorded,
      messageKey: `remediation.${run.state}`,
      severity: run.state === 'succeeded' && run.outcome === 'saved-partial' ? 'warning' : SEVERITY[run.state],
    });

    /** What a run whose record wouldn't write answers, before it changed anything */
    const notRecorded = () => unavailable('storage', 'not-recorded', true);

    /**
     * Ends the run: the last write, and its journal event
     * @param {'succeeded' | 'failed' | 'cancelled'} state
     * @param {string} outcome
     */
    const finish = async (state, outcome) => {
      pending.delete(run.id);
      await save({
        state,
        outcome: /** @type {RemediationRun['outcome']} */ (outcome),
        ...(state === 'succeeded' ? { step: /** @type {RunStep} */ ('record') } : {}),
        ...(unreadableCount > 0 ? { unreadable, unreadableCount } : {}),
        ...(fileMayBeEmpty ? { fileMayBeEmpty } : {}),
        ...(saved ? { saved } : {}),
        ...(noteId ? { noteId } : {}),
      });
      note({
        runId: run.id,
        remediationId: run.commandId,
        state,
        outcome,
        durationMs: Math.max(0, clock.now() - run.startedAt),
        ...(run.recoveryPointId ? { recoveryPointId: run.recoveryPointId } : {}),
        ...(unreadableCount > 0 ? { count: unreadableCount } : {}),
      });
      return answer();
    };

    /**
     * Stops at the preview for the user's decision
     * @param {Preview} preview
     * @param {string | null} code - why it's back, when it is
     */
    const hold = async (preview, code) => {
      pending.set(run.id, { at: clock.now() });
      shown = preview;
      const stored = await save({
        state: 'awaiting-confirmation',
        step: 'preview',
        outcome: /** @type {RemediationRun['outcome']} */ (code),
      });
      if (!stored) {
        pending.delete(run.id);
        return notRecorded();
      }
      return answer();
    };

    /**
     * What the class needs before apply, made now
     * @param {unknown} plan
     * @param {unknown} destroyed - what an irreversible run destroys, as its destroys step named it
     * @returns {Promise<{ok: true, pointId?: string, pointVerified?: boolean, fileSavedAt?: number} | {ok: false, code: string, back?: boolean}>}
     */
    const protect = async (plan, destroyed) => {
      const needs = CLASS_PROTECTIONS[remediationClass];
      if (needs.includes('recovery-point')) {
        const points = ports.recoveryPoints;
        if (!points) return { ok: false, code: 'no-recovery-point' };
        const made = await points.make({ holds: steps.protects ? steps.protects(plan) : {} });
        if (made.ok === false) return { ok: false, code: outcomeCode(made.code, 'protect-failed') };
        if (!(await points.verify(made.pointId))) return { ok: false, code: 'recovery-point-unverified' };
        return { ok: true, pointId: made.pointId, pointVerified: true };
      }
      if (needs.includes('recovery-file')) {
        const salvage = ports.salvage;
        if (!salvage) return { ok: false, code: 'build-failed' };
        // The picker first, in the click's activation; the profile is read once it's picked.
        // The file must hold the rows of what the action destroys.
        const file = await saveVerified({
          files: ports.files,
          suggestedName: fileName('salvage', clock.now()),
          build: async () => buildSalvage(await salvage.collect(), { now: clock.now() }),
          subjectId: /** @type {string} */ (destroyed),
        });
        if (file.status === 'cancelled') return { ok: false, code: 'file-not-saved', back: true };
        if (file.status === 'failed') {
          // Past the picker, the file the user chose may now be empty
          if (file.code !== 'picker-unavailable') fileMayBeEmpty = true;
          return { ok: false, code: outcomeCode(file.code, 'file-not-saved') };
        }
        setUnreadable(file.read.unreadable);
        saved = savedOf(file.counts, file.characters);
        // The save's own rule: no user record held while a source didn't read saved nothing
        if (file.read.held === 0 && file.read.unreadable.length > 0) {
          fileMayBeEmpty = true;
          return { ok: false, code: 'nothing-readable' };
        }
        // A recovery file that didn't read all of CanvasTabDB, or doesn't hold the rows of what
        // the action destroys, isn't the path back
        if (!file.read.readCanvas || !file.read.holdsSubject) return { ok: false, code: 'salvage-incomplete' };
        return { ok: true, fileSavedAt: clock.now() };
      }
      return { ok: true };
    };

    /**
     * From the preview on
     * @param {{confirming: string | null, decision?: 'confirm' | 'cancel', typedPhrase?: string}} given
     *   `confirming` is the digest of the preview the user confirmed, null on a run's first call
     */
    const fromPreview = async given => {
      if (!(await save({ state: 'running', step: 'preview', outcome: null })) && mustRecord) return notRecorded();
      await between('preview');
      const ctx = /** @type {RemediationContext} */ (context);
      /** @type {Awaited<ReturnType<RemediationSteps['preview']>>} */
      let previewed;
      try {
        previewed = await steps.preview(ctx);
      } catch (error) {
        return finish('failed', codeOf(error, 'preview-failed'));
      }
      if (!previewed || !v.is(previewSchema, previewed.preview)) return finish('failed', 'preview-invalid');
      const { preview, plan } = previewed;
      shown = preview;
      const refused = refusalOf(remediationClass, preview);
      if (refused) return finish('failed', refused);
      if (previewed.nothingToDo === true) return finish('cancelled', 'nothing-to-do');
      // What it destroys, which an irreversible run and a secret removal must name
      /** @type {unknown} */
      let destroyed = null;
      if (remediationClass === 'irreversible' || remediationClass === 'secret-removal') {
        try {
          destroyed = steps.destroys ? steps.destroys(ctx, plan) : null;
        } catch {
          destroyed = null;
        }
        const unnamed =
          remediationClass === 'irreversible'
            ? typeof destroyed === 'string' && destroyed !== ''
              ? null
              : 'destroys-unnamed'
            : secretRemovalRefusal(preview, destroyed);
        if (unnamed) return finish('failed', unnamed);
      }
      if (needsConfirmation(remediationClass)) {
        if (given.confirming === null) return hold(preview, null);
        if (given.decision !== 'confirm') return hold(preview, 'not-confirmed');
        if (digestOf(preview) !== given.confirming) return hold(preview, 'preview-changed');
        const consent = checkConsent(remediationClass, given, steps.phrase);
        if (consent.ok === false) return hold(preview, consent.code);
        pending.delete(run.id);
      }

      if (!(await save({ step: 'protect' })) && mustRecord) return notRecorded();
      await between('protect');
      /** @type {Awaited<ReturnType<typeof protect>>} */
      let made;
      try {
        made = await protect(plan, destroyed);
      } catch (error) {
        return finish('failed', codeOf(error, 'protect-failed'));
      }
      if (made.ok === false) return made.back ? hold(preview, made.code) : finish('failed', made.code);
      const gate = checkProtected(remediationClass, made);
      if (gate.ok === false) return finish('failed', gate.code);

      // The last write before the first mutation: a run that can't record it changes nothing
      const protection = {
        ...(made.pointId ? { recoveryPointId: made.pointId } : {}),
        ...(made.fileSavedAt !== undefined ? { fileSavedAt: made.fileSavedAt } : {}),
      };
      if (!(await save({ step: 'apply', ...protection })) && mustRecord) return notRecorded();
      await between('apply');
      /** @type {unknown} */
      let applied;
      try {
        applied = await steps.apply(ctx, plan);
      } catch (error) {
        return finish('failed', codeOf(error, 'apply-failed'));
      }
      if (applied === CANCELLED_BY_USER) return finish('cancelled', 'cancelled-by-user');
      if (isFailedAfterPick(applied)) {
        fileMayBeEmpty = true;
        return finish('failed', outcomeCode(applied.code, 'file-not-saved'));
      }

      await save({ step: 'verify' });
      await between('verify');
      /** @type {Verdict} */
      let verdict;
      try {
        verdict = await steps.verify(ctx, applied);
      } catch (error) {
        verdict = { ok: false, code: codeOf(error, 'verify-failed') };
      }
      if (verdict && Array.isArray(verdict.unreadable)) setUnreadable(verdict.unreadable);
      if (verdict && verdict.ok === false && verdict.fileMayBeEmpty === true) fileMayBeEmpty = true;
      if (verdict && verdict.ok === true && verdict.saved) saved = verdict.saved;
      if (verdict && verdict.ok === true && typeof verdict.noteId === 'string') noteId = verdict.noteId;
      if (!verdict || verdict.ok !== true) {
        return finish('failed', outcomeCode(verdict && /** @type {{code?: unknown}} */ (verdict).code, 'not-verified'));
      }
      // A saved file short of a source, or an irreversible run whose recovery file was
      return finish(
        'succeeded',
        verdict.outcome === 'saved-partial' || (remediationClass === 'irreversible' && unreadableCount > 0)
          ? 'saved-partial'
          : 'verified',
      );
    };

    /**
     * The context the steps get
     * @param {RecoveryRun} request
     * @param {Incident | null} incident
     */
    const contextOf = (request, incident) =>
      Object.freeze({ ports, clock, ids, runId: run.id, incident, subjectId: request.subjectId ?? null });

    return {
      /**
       * A new run: its record, then the plan, then on
       * @param {RecoveryRun} request
       */
      async start(request) {
        if (!(await save({})) && mustRecord) return notRecorded();
        await between('plan');
        const found = await incidentFor(request.incidentId ?? null, appliesTo);
        if (!found.ok) return finish('failed', 'not-applicable');
        context = contextOf(request, found.incident);
        return fromPreview({ confirming: null });
      },

      /**
       * A run awaiting confirmation, confirmed or cancelled
       * @param {RecoveryRun} request
       */
      async resume(request) {
        const held = pending.get(run.id);
        if (request.decision === 'cancel') return finish('cancelled', 'cancelled-by-user');
        if (!held || clock.now() - held.at > PENDING_MS) return finish('cancelled', 'run-expired');
        const found = await incidentFor(request.incidentId ?? null, appliesTo);
        if (!found.ok) return finish('failed', 'not-applicable');
        context = contextOf(request, found.incident);
        return fromPreview({
          confirming: request.previewDigest ?? '',
          decision: request.decision,
          typedPhrase: request.typedPhrase,
        });
      },

      /** @returns {RemediationAnswer} what the stored run says, as it is */
      asStored: answer,
    };
  };

  /**
   * @param {RunLocks} held
   * @param {RecoveryRun} request
   * @returns {Promise<Outcome | RemediationAnswer>}
   */
  const execute = async (held, request) => {
    // A confirmation names the preview it confirms
    if (request.decision === 'confirm' && request.previewDigest === undefined) {
      return rejected('validation', 'invalid-payload');
    }
    const remediation = await remediationOf(request.remediationId);
    if (!remediation) return rejected('not-found', 'remediation-not-registered');
    const takesSubject = remediation.steps.takesSubject === true;
    const subjectId = takesSubject ? (request.subjectId ?? null) : null;
    if (!takesSubject && request.subjectId) return rejected('validation', 'subject-not-allowed');
    const incidentId = request.incidentId ?? null;
    const ran = await exclusive(held, lockName(request.remediationId, subjectId), async () => {
      if (request.runId === undefined) {
        const now = clock.now();
        /** @type {RemediationRun} */
        const run = {
          id: ids.next(),
          commandId: request.remediationId,
          incidentId,
          subjectId,
          state: 'planned',
          step: 'plan',
          outcome: null,
          startedAt: now,
          updatedAt: now,
        };
        return runner(run, remediation).start(request);
      }
      const stored = (await records.runs()).find(item => item.id === request.runId);
      if (
        !stored ||
        stored.commandId !== request.remediationId ||
        (stored.subjectId ?? null) !== subjectId ||
        stored.incidentId !== incidentId
      ) {
        return rejected('not-found', 'run-not-found');
      }
      const resumed = runner(stored, remediation);
      // A run that already ended, or isn't waiting on the user, answers as it stands
      if (stored.state !== 'awaiting-confirmation') return resumed.asStored();
      return resumed.resume(request);
    });
    if (ran === null) return unavailable('coordinator', 'remediation-running', true);
    return ran.value;
  };

  return Object.freeze({
    /**
     * recovery.run
     * @param {unknown} payload
     * @returns {Promise<Outcome | RemediationAnswer>}
     */
    run(payload) {
      const checked = v.safeParse(runPayload, payload);
      if (!checked.success) return Promise.resolve(rejected('validation', 'invalid-payload'));
      // Without Web Locks nothing keeps a run to one context, so nothing runs
      if (!locks) return Promise.resolve(unavailable('coordinator', 'no-locks', false));
      const request = checked.output;
      const replay = replays.get(request.commandId);
      if (replay) return replay;
      const answered = execute(locks, request).catch(error => unavailableFrom(error));
      replays.set(request.commandId, answered);
      while (replays.size > REPLAYS) replays.delete(/** @type {string} */ (replays.keys().next().value));
      return answered;
    },

    /**
     * On a start: each `running` run whose lock no context holds, read again under that lock
     * and still running, becomes `interrupted` at the step it stopped at, and each run awaiting
     * a confirmation nobody here holds, past PENDING_MS, is cancelled. Answers how many it
     * changed. Without Web Locks it can't tell a cut-off run from one another context holds,
     * so it changes none.
     * @returns {Promise<number>}
     */
    async reconcile() {
      if (!locks) return 0;
      let changed = 0;
      for (const listed of await records.runs()) {
        const now = clock.now();
        if (listed.state === 'running' || listed.state === 'planned') {
          const marked = await exclusive(locks, lockName(listed.commandId, listed.subjectId), async () => {
            // The list is from before the lock: the run may have finished since
            const stored = (await records.runs()).find(item => item.id === listed.id);
            if (!stored || (stored.state !== 'running' && stored.state !== 'planned')) return false;
            /** @type {RemediationRun} */
            const interrupted = { ...stored, state: 'interrupted', outcome: 'interrupted', updatedAt: now };
            const put = await records.putRun(interrupted);
            if (put.recorded) {
              note({
                runId: stored.id,
                remediationId: stored.commandId,
                state: 'interrupted',
                outcome: 'interrupted',
                durationMs: Math.max(0, now - stored.startedAt),
                ...(stored.recoveryPointId ? { recoveryPointId: stored.recoveryPointId } : {}),
              });
            }
            return put.recorded;
          });
          if (marked && marked.value) changed++;
        } else if (
          listed.state === 'awaiting-confirmation' &&
          !pending.has(listed.id) &&
          now - listed.updatedAt > PENDING_MS
        ) {
          const expired = await exclusive(locks, lockName(listed.commandId, listed.subjectId), async () => {
            const stored = (await records.runs()).find(item => item.id === listed.id);
            if (!stored || stored.state !== 'awaiting-confirmation' || now - stored.updatedAt <= PENDING_MS) return false;
            const put = await records.putRun({ ...stored, state: 'cancelled', outcome: 'run-expired', updatedAt: now });
            return put.recorded;
          });
          if (expired && expired.value) changed++;
        }
      }
      return changed;
    },
  });
}

/** @typedef {ReturnType<typeof createRemediationPipeline>} RemediationPipeline */
