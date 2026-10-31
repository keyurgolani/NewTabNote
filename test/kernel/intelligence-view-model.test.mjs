// #7 slice 1, the view model (approved AC2): every provenance type in text and as a typed
// discriminator, category and confidence text, the reason rendered from a rule code, actions
// per kind with accessible names and confirmation text, #16's role, and nothing but plain data,
// with Open reaching only a stored source reference.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toSignalViewModel } from '../../js/kernel/core/intelligence/view-model.js';
import { ZONE, asSignal, connectionDraft, inferredDraft, pinDraft, taskDraft } from './intelligence-fixtures.mjs';
import { NOW } from './support.mjs';

/** @typedef {import('../../js/kernel/core/intelligence/records.js').IntelligenceSignal} IntelligenceSignal */
/** @typedef {import('../../js/kernel/core/intelligence/records.js').SignalDecision} SignalDecision */
/** @typedef {import('../../js/kernel/core/intelligence/view-model.js').SignalViewModel} SignalViewModel */

const DAY = 86_400_000;
const PREFS = Object.freeze({ timeZone: ZONE });

/**
 * @param {IntelligenceSignal} signal
 * @param {SignalDecision | null} [decision]
 */
const view = (signal, decision = null) => toSignalViewModel(signal, decision, [], NOW, PREFS);

/**
 * @param {SignalViewModel} model
 */
const actionsOf = model => model.actions.map(action => action.accessibleName);

/**
 * @param {IntelligenceSignal} signal
 * @param {Partial<SignalDecision>} fields
 * @returns {SignalDecision}
 */
const decided = (signal, fields) => ({
  recordVersion: 1,
  signalId: signal.id,
  identity: signal.identity,
  status: 'active',
  snoozedUntil: null,
  dismissReason: null,
  completedAt: null,
  decisionRevision: 1,
  updatedAt: NOW,
  history: [],
  tombstone: null,
  ...fields,
});

/**
 * Every value in `value` is plain data: strings, numbers, booleans, null, arrays, and plain objects
 * @param {unknown} value
 * @returns {boolean}
 */
const isPlain = value => {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isPlain);
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(/** @type {object} */ (value)).every(isPlain);
};

describe('toSignalViewModel (#7, "Contracts")', () => {
  it('says what every provenance type is in text, apart from its typed discriminator', () => {
    const cases = /** @type {Array<[IntelligenceSignal, 'objective' | 'inferred', string]>} */ ([
      [asSignal(taskDraft()), 'objective', 'Objective'],
      [asSignal(inferredDraft({ executionClass: 'local-model' })), 'inferred', 'Generated locally'],
      [asSignal(inferredDraft({ executionClass: 'remote' })), 'inferred', 'Remote model'],
      [asSignal(inferredDraft({ executionClass: 'local-endpoint' })), 'inferred', 'Local app'],
      [
        asSignal(
          inferredDraft({ executionClass: 'local-endpoint', location: { kind: 'network-endpoint', id: 'lan-box' } }),
        ),
        'inferred',
        'Network endpoint',
      ],
      [
        asSignal({
          ...inferredDraft(),
          identity: { producerId: 'legacy-insights', noteId: 'n1', anchorBlockId: null, subjectKey: 'todos:call' },
          executionClass: 'unrecorded',
          sourceRefs: [{ kind: 'note', noteId: 'n1', revision: null }],
          confidence: null,
          derivationRef: null,
          model: null,
          providerId: null,
          scopeId: null,
        }),
        'inferred',
        'From an earlier AI extraction (model unknown)',
      ],
    ]);
    for (const [signal, provenance, text] of cases) {
      const model = view(signal);
      assert.equal(model.provenance, provenance);
      assert.equal(model.provenanceText, text);
      assert.equal(model.executionClass, signal.executionClass);
    }
    const named = toSignalViewModel(
      asSignal(
        inferredDraft({ executionClass: 'local-endpoint', location: { kind: 'network-endpoint', id: 'lan-box' } }),
      ),
      null,
      [],
      NOW,
      { timeZone: ZONE, locationNames: { 'lan-box': 'studio.local' } },
    );
    assert.equal(named.provenanceText, 'Network endpoint (studio.local)');
  });

  it('shows confidence for an inference only, and says when it was never recorded', () => {
    assert.equal(view(asSignal(taskDraft())).confidenceText, null);
    assert.equal(view(asSignal(taskDraft())).confidence, null);
    const inferred = view(asSignal(inferredDraft({ band: 'high' })));
    assert.equal(inferred.confidence, 'high');
    assert.equal(inferred.confidenceText, 'High confidence');
    assert.equal(inferred.confidenceReason, 'The note names a date for it');
    const legacy = view(
      asSignal({
        ...inferredDraft(),
        identity: { producerId: 'legacy-insights', noteId: 'n1', anchorBlockId: null, subjectKey: 'todos:call' },
        executionClass: 'unrecorded',
        sourceRefs: [{ kind: 'note', noteId: 'n1', revision: null }],
        confidence: null,
        derivationRef: null,
        model: null,
        providerId: null,
        scopeId: null,
      }),
    );
    assert.equal(legacy.confidenceText, 'Confidence not recorded');
  });

  it('names the category in text and renders the reason from its rule', () => {
    const cases = /** @type {Array<[IntelligenceSignal, string, string]>} */ ([
      [asSignal(taskDraft({ time: { dueDate: '2026-10-16' } })), 'Now', 'Overdue since Oct 16'],
      [asSignal(taskDraft({ time: { dueAt: NOW + 60 * 60_000 } })), 'Now', 'Due at 9:00 AM'],
      [asSignal(taskDraft({ time: { dueAt: NOW + 6 * 60 * 60_000 } })), 'Today', 'Due today at 2:00 PM'],
      [asSignal(taskDraft({ time: { dueDate: '2026-10-20' } })), 'Today', 'Due today'],
      [asSignal(taskDraft({ time: { dueDate: '2026-11-30' } })), 'Soon', 'Due Nov 30'],
      [asSignal(taskDraft({ context: { dailyNoteDate: '2026-10-20' } })), 'Today', "Open task in today's Daily Note"],
      [asSignal(taskDraft()), 'Soon', 'Open task'],
      [
        asSignal(pinDraft({ context: { lastEditAt: Date.UTC(2026, 9, 1, 15) } })),
        'Resurface',
        'Not edited since Oct 1',
      ],
      [asSignal(pinDraft()), 'Soon', 'Pinned note'],
      [asSignal(inferredDraft()), 'Soon', 'Mentioned in your note'],
      [asSignal(connectionDraft()), 'Connection', 'Linked across 3 notes'],
    ]);
    for (const [signal, category, reason] of cases) {
      const model = view(signal);
      assert.equal(model.categoryText, category, reason);
      assert.equal(model.reason, reason);
    }
    // Due beyond the Soon window, it's inactive until its window opens, and still says when
    const later = view(asSignal(taskDraft({ time: { dueDate: '2026-11-30' } })));
    assert.equal(later.active, false);
    assert.ok(typeof later.activeFrom === 'number');
  });

  it('gives each kind its actions, with accessible names and confirmation text', () => {
    assert.deepEqual(actionsOf(view(asSignal(taskDraft()))), [
      'Complete: Call vendor',
      'Snooze: Call vendor',
      'Dismiss: Call vendor',
      'Edit in note: Call vendor',
      'Inspect: Call vendor',
      'Open: Call vendor',
    ]);
    assert.deepEqual(actionsOf(view(asSignal(pinDraft()))), [
      'Snooze: Roadmap',
      'Dismiss: Roadmap',
      'Inspect: Roadmap',
      'Open: Roadmap',
    ]);
    const deadline = view(asSignal(inferredDraft({ title: 'Call vendor' })));
    assert.deepEqual(actionsOf(deadline), [
      'Mark done: Call vendor',
      'Snooze: Call vendor',
      'Dismiss: Call vendor',
      'Correct: Call vendor',
      'Inspect: Call vendor',
      'Open: Call vendor',
    ]);
    assert.equal(deadline.actions[0].confirmation, 'Your note is unchanged.');
    assert.deepEqual(actionsOf(view(asSignal(inferredDraft({ kind: 'inferred-highlight', title: 'Q3 numbers' })))), [
      'Snooze: Q3 numbers',
      'Dismiss: Q3 numbers',
      'Correct: Q3 numbers',
      'Inspect: Q3 numbers',
      'Open: Q3 numbers',
    ]);
    const connection = view(asSignal(connectionDraft()));
    assert.deepEqual(actionsOf(connection), [
      'Not related: Notes that link to each other',
      'Remove a source: Notes that link to each other',
      'Inspect: Notes that link to each other',
      'Open source 1 of 3: Notes that link to each other',
      'Open source 2 of 3: Notes that link to each other',
      'Open source 3 of 3: Notes that link to each other',
    ]);
    // Once done, the way back is Reopen
    const task = asSignal(taskDraft(), { checked: true });
    assert.equal(view(task).status, 'completed');
    assert.deepEqual(actionsOf(view(task)).slice(0, 1), ['Reopen: Call vendor']);
    const dismissed = asSignal(inferredDraft({ title: 'Call vendor' }));
    assert.deepEqual(actionsOf(view(dismissed, decided(dismissed, { status: 'dismissed' }))).slice(0, 1), [
      'Reopen: Call vendor',
    ]);
  });

  it('opens only stored source references', () => {
    const task = view(asSignal(taskDraft()));
    const targets = task.actions.filter(action => action.target !== null).map(action => action.target);
    assert.deepEqual(targets, [
      { kind: 'block', noteId: 'n1', blockId: 'b1' },
      { kind: 'block', noteId: 'n1', blockId: 'b1' },
    ]);
    const pin = view(asSignal(pinDraft()));
    assert.deepEqual(pin.actions.find(action => action.id === 'open')?.target, { kind: 'note', noteId: 'n1' });
  });

  it('takes #16’s role from the signal: urgency, private, linked, supporting, or neutral', () => {
    assert.equal(view(asSignal(taskDraft({ time: { dueDate: '2026-10-21' } }))).role, 'urgency');
    assert.equal(view(asSignal(inferredDraft({ executionClass: 'local-model' }))).role, 'private');
    assert.equal(view(asSignal(inferredDraft({ executionClass: 'local-endpoint' }))).role, 'private');
    assert.equal(view(asSignal(connectionDraft())).role, 'linked');
    assert.equal(view(asSignal(pinDraft({ context: { lastEditAt: NOW - 30 * DAY } }))).role, 'supporting');
    assert.equal(view(asSignal(taskDraft())).role, 'neutral');
    assert.equal(view(asSignal(inferredDraft({ executionClass: 'remote' }))).role, 'neutral');
  });

  it('says why a signal is stale, hides a suspended one, and marks a corrected one', () => {
    const signal = asSignal(inferredDraft());
    for (const [cause, text] of /** @type {const} */ ([
      ['source-edited', 'Source changed since this was generated'],
      ['recipe-version', 'From an older recipe version'],
      ['model-changed', 'Model or route changed since this was generated'],
      ['route-changed', 'Model or route changed since this was generated'],
    ])) {
      const model = view({
        ...signal,
        freshness: { state: 'stale', cause, since: NOW, invalidatedAt: null, resumeTo: null },
      });
      assert.equal(model.freshnessText, text);
      assert.ok(model.active);
    }
    const suspended = view({
      ...signal,
      freshness: {
        state: 'suspended',
        cause: 'note-trashed',
        since: NOW,
        invalidatedAt: null,
        resumeTo: { state: 'current', cause: null, invalidatedAt: null },
      },
    });
    assert.equal(suspended.hidden, true);
    assert.deepEqual(
      suspended.actions.map(action => action.id),
      ['inspect', 'open'],
    );
    const corrected = toSignalViewModel(
      signal,
      null,
      [
        {
          recordVersion: 1,
          entryId: 'e1',
          signalId: signal.id,
          identity: signal.identity,
          change: { field: 'category', before: null, after: 'today' },
          note: null,
          at: NOW,
          commandId: 'c1',
        },
      ],
      NOW,
      PREFS,
    );
    assert.equal(corrected.categoryText, 'Today');
    assert.equal(corrected.correctedText, 'Corrected');
    assert.equal(view(signal).correctedText, null);
  });

  it('answers plain data only: a title that looks like HTML stays text, and a cleared title has a name', () => {
    const html = asSignal(taskDraft({ title: '<img src=x onerror=alert(1)> Call vendor' }));
    const model = view(html);
    assert.ok(isPlain(model));
    assert.equal(model.title, '<img src=x onerror=alert(1)> Call vendor');
    assert.equal(model.actions[0].accessibleName, 'Complete: <img src=x onerror=alert(1)> Call vendor');
    const revoked = asSignal(inferredDraft(), {
      title: '',
      freshness: { state: 'invalidated', cause: 'scope-revoked', since: NOW, invalidatedAt: NOW, resumeTo: null },
    });
    const cleared = view(revoked);
    assert.equal(cleared.title, '');
    assert.equal(cleared.freshnessText, 'Access to its source was removed');
    assert.ok(cleared.actions.every(action => action.accessibleName.endsWith(': Untitled item')));
    for (const signal of [asSignal(taskDraft()), asSignal(inferredDraft()), asSignal(connectionDraft())]) {
      assert.ok(isPlain(view(signal)));
      assert.ok(view(signal).reason.length <= 280);
    }
  });
});
