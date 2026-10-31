// #7 slice 1, records and identity (approved AC1): a signal's id is the SHA-256 of its identity
// tuple and nothing else, every record holds to its schema and bounds, nothing that looks like
// a credential, prompt text, a page URL, or raw model output fits any field, and a record that
// fails its schema on read is quarantined and counted, never returned.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as v from '../../js/lib/valibot/index.mjs';
import { SIGNAL_ID, signalIdOf } from '../../js/kernel/core/intelligence/identity.js';
import {
  HISTORY_MAX,
  KINDS,
  REASON_MAX,
  SOURCES_MAX,
  SUBJECT_KEY_MAX,
  TITLE_MAX,
  correctionRecord,
  decisionRecord,
  plainTitle,
  signalRecord,
  signalRefusal,
} from '../../js/kernel/core/intelligence/records.js';
import { createIntelligence } from '../../js/kernel/core/intelligence/service.js';
import { createMemoryIntelligenceRepository } from '../../js/kernel/core/memory/intelligence.js';
import {
  RECIPE,
  TASKS,
  ZONE,
  asSignal,
  connectionDraft,
  idOf,
  inferredDraft,
  pinDraft,
  taskDraft,
} from './intelligence-fixtures.mjs';
import { staticImports } from './import-graph.mjs';
import { NOW, testClock } from './support.mjs';

/** @typedef {import('../../js/kernel/core/intelligence/service.js').SignalDraft} SignalDraft */
/** @typedef {import('../../js/kernel/core/intelligence/records.js').IntelligenceSignal} IntelligenceSignal */
/** @typedef {import('../../js/kernel/core/intelligence/records.js').SignalDecision} SignalDecision */
/** @typedef {import('../../js/kernel/core/intelligence/records.js').SignalCorrection} SignalCorrection */

/**
 * @param {IntelligenceSignal} signal
 * @returns {SignalDecision}
 */
const decisionFor = signal => ({
  recordVersion: 1,
  signalId: signal.id,
  identity: { ...signal.identity },
  status: 'dismissed',
  snoozedUntil: null,
  dismissReason: 'not-actionable',
  completedAt: null,
  decisionRevision: 1,
  updatedAt: NOW,
  history: [{ decisionRevision: 1, action: 'dismiss', status: 'dismissed', at: NOW, commandId: 'c1' }],
  tombstone: null,
});

/**
 * @param {IntelligenceSignal} signal
 * @returns {SignalCorrection}
 */
const correctionFor = signal => ({
  recordVersion: 1,
  entryId: 'e1',
  signalId: signal.id,
  identity: { ...signal.identity },
  change: { field: 'category', before: null, after: 'today' },
  note: 'It is for this afternoon',
  at: NOW,
  commandId: 'c2',
});

const DRAFTS = /** @type {Array<[string, SignalDraft]>} */ ([
  ['task', taskDraft()],
  ['pin', pinDraft()],
  ['inferred-task', inferredDraft({ kind: 'inferred-task' })],
  ['inferred-deadline', inferredDraft({ kind: 'inferred-deadline', time: { dueDate: '2026-10-22' } })],
  ['inferred-reminder', inferredDraft({ kind: 'inferred-reminder', executionClass: 'remote' })],
  ['inferred-highlight', inferredDraft({ kind: 'inferred-highlight', executionClass: 'local-endpoint' })],
  ['inferred-resurface', inferredDraft({ kind: 'inferred-resurface', category: 'resurface' })],
  ['connection', connectionDraft()],
]);

describe('signal identity (#7, "Records and identity")', () => {
  it('is the SHA-256 hex of the UTF-8 JSON array [producerId, noteId, anchorBlockId or null, subjectKey]', () => {
    for (const tuple of /** @type {Array<[string, string, string | null, string]>} */ ([
      [TASKS, 'n1', 'b1', 'task'],
      ['pins', 'n1', null, 'pinned'],
      [RECIPE, 'n1', 'b2', 'café — réunion 東京 🗓'],
    ])) {
      const expected = createHash('sha256')
        .update(Buffer.from(JSON.stringify(tuple), 'utf8'))
        .digest('hex');
      assert.equal(signalIdOf(tuple), expected);
      assert.match(signalIdOf(tuple), SIGNAL_ID);
    }
    assert.notEqual(signalIdOf(['pins', 'n1', null, 'pinned']), signalIdOf(['pins', 'n1', 'null', 'pinned']));
  });

  it('leaves version, model, and source revision out, so an edit or an upgrade keeps the id', async () => {
    const repository = createMemoryIntelligenceRepository();
    const intelligence = createIntelligence({
      repository,
      noteCommands: { setTodoChecked: async () => assert.fail('no note command') },
      timeZone: ZONE,
      clock: testClock(),
    });
    const first = inferredDraft({ version: 1, modelId: 'gemma-3n', revision: 3 });
    const later = inferredDraft({ version: 4, modelId: 'gemma-4', revision: 9, title: 'Send the Q3 report today' });
    const a = await intelligence.upsertSignals(RECIPE, [first]);
    const b = await intelligence.upsertSignals(RECIPE, [later]);
    assert.deepEqual(a.changed, b.changed);
    assert.equal(a.changed[0], idOf(first));
    const read = await intelligence.readSignal(a.changed[0]);
    assert.equal(read.kind, 'ready');
    if (read.kind === 'ready') {
      assert.equal(read.signal.producerVersion, 4);
      assert.equal(read.signal.revision, 2);
    }
  });

  it('refuses a tuple that is not four parts, or has an empty part', () => {
    assert.throws(() => signalIdOf(/** @type {any} */ (['tasks', 'n1', 'b1'])), TypeError);
    assert.throws(() => signalIdOf(['tasks', '', 'b1', 'task']), TypeError);
    assert.throws(() => signalIdOf(['tasks', 'n1', '', 'task']), TypeError);
    assert.throws(() => signalIdOf(/** @type {any} */ (['tasks', 'n1', undefined, 'task'])), TypeError);
  });
});

describe('the records (#7, approved AC1)', () => {
  it('takes a signal of every kind, with its decision and its correction', () => {
    assert.deepEqual(
      DRAFTS.map(([kind]) => kind),
      [...KINDS],
    );
    for (const [kind, draft] of DRAFTS) {
      const signal = asSignal(draft);
      assert.equal(signalRefusal(signal), null, kind);
      assert.ok(v.is(signalRecord, signal), kind);
      assert.ok(v.is(decisionRecord, decisionFor(signal)), kind);
      assert.ok(v.is(correctionRecord, correctionFor(signal)), kind);
    }
  });

  it('holds title, reason, note, subject key, sources, and history to their bounds', () => {
    const at = (/** @type {number} */ n) => 'a'.repeat(n);
    const base = asSignal(inferredDraft());
    const withId = (/** @type {IntelligenceSignal} */ signal) => ({ ...signal, id: idOf(signal) });
    assert.ok(v.is(signalRecord, { ...base, title: at(TITLE_MAX) }));
    assert.ok(!v.is(signalRecord, { ...base, title: at(TITLE_MAX + 1) }));
    const confidence = /** @type {{band: 'medium', reason: string}} */ (base.confidence);
    assert.ok(v.is(signalRecord, { ...base, confidence: { ...confidence, reason: at(REASON_MAX) } }));
    assert.ok(!v.is(signalRecord, { ...base, confidence: { ...confidence, reason: at(REASON_MAX + 1) } }));
    const subject = (/** @type {number} */ n) => withId({ ...base, identity: { ...base.identity, subjectKey: at(n) } });
    assert.ok(v.is(signalRecord, subject(SUBJECT_KEY_MAX)));
    assert.ok(!v.is(signalRecord, subject(SUBJECT_KEY_MAX + 1)));
    const cited = (/** @type {number} */ n) =>
      asSignal({
        ...connectionDraft({ others: Array.from({ length: n - 1 }, (_, index) => `other-${index}`) }),
      });
    assert.ok(v.is(signalRecord, cited(SOURCES_MAX)));
    assert.ok(!v.is(signalRecord, cited(SOURCES_MAX + 1)));

    const decision = decisionFor(base);
    const entry = decision.history[0];
    const history = (/** @type {number} */ n) => ({
      ...decision,
      history: Array.from({ length: n }, (_, index) => ({ ...entry, decisionRevision: index + 1 })),
    });
    assert.ok(v.is(decisionRecord, history(HISTORY_MAX)));
    assert.ok(!v.is(decisionRecord, history(HISTORY_MAX + 1)));

    const correction = correctionFor(base);
    assert.ok(v.is(correctionRecord, { ...correction, note: at(REASON_MAX) }));
    assert.ok(!v.is(correctionRecord, { ...correction, note: at(REASON_MAX + 1) }));
  });

  it('has nowhere for a credential, prompt text, a page URL, or raw model output to go', () => {
    const canaries = {
      prompt: 'Summarize the following note: SECRET-CANARY',
      apiKey: 'sk-canary-0000',
      authorization: 'Bearer canary',
      headers: { Authorization: 'Bearer canary' },
      pageUrl: 'https://example.com/private/page?token=canary',
      url: 'https://example.com/private/page',
      rawOutput: '{"todos":["canary"]}',
      html: '<img src=x onerror=alert(1)>',
    };
    const signal = asSignal(inferredDraft());
    const records = /** @type {Array<[v.GenericSchema, Record<string, unknown>]>} */ ([
      [signalRecord, signal],
      [decisionRecord, decisionFor(signal)],
      [correctionRecord, correctionFor(signal)],
    ]);
    for (const [schema, record] of records) {
      assert.ok(v.is(schema, record));
      for (const [field, value] of Object.entries(canaries)) {
        assert.ok(!v.is(schema, { ...record, [field]: value }), field);
      }
    }
    const confidence = /** @type {{band: 'medium', reason: string}} */ (signal.confidence);
    for (const text of [
      'Read https://example.com/private/page',
      'See www.example.com/a',
      'chrome-extension://abc/x',
      'line\nbreak',
    ]) {
      assert.ok(!v.is(signalRecord, { ...signal, title: text }), text);
      assert.ok(!v.is(signalRecord, { ...signal, confidence: { ...confidence, reason: text } }), text);
      assert.ok(!v.is(correctionRecord, { ...correctionFor(signal), note: text }), text);
    }
    // A source names a note or block by id and revision, and nothing else
    assert.ok(!v.is(signalRecord, { ...signal, sourceRefs: [{ ...signal.sourceRefs[0], url: canaries.url }] }));
    assert.ok(!v.is(signalRecord, { ...signal, model: { id: 'gemma-3n', version: '1', prompt: canaries.prompt } }));
  });

  it('keeps the cross-field rules: id, provenance, inference fields, location, sources, and freshness', () => {
    const task = asSignal(taskDraft());
    const inferred = asSignal(inferredDraft());
    const pin = asSignal(pinDraft());
    const confidence = /** @type {NonNullable<IntelligenceSignal['confidence']>} */ (inferred.confidence);
    /** @type {Array<[string, unknown]>} */
    const broken = [
      ['id-not-identity', { ...task, id: idOf(pinDraft()) }],
      ['kind-is-objective', { ...task, provenance: 'inferred' }],
      ['kind-is-inferred', { ...inferred, provenance: 'objective' }],
      ['objective-is-deterministic', { ...task, executionClass: 'remote' }],
      ['objective-has-no-inference', { ...task, confidence }],
      ['inferred-is-not-deterministic', { ...inferred, executionClass: 'deterministic' }],
      ['inferred-needs-derivation', { ...inferred, confidence: null }],
      ['inferred-needs-derivation', { ...inferred, model: null }],
      ['unrecorded-has-no-inference', { ...inferred, executionClass: 'unrecorded' }],
      ['location-for-local-endpoint', { ...inferred, executionClass: 'local-endpoint' }],
      ['location-for-local-endpoint', { ...inferred, location: { kind: 'local-app', id: 'ollama' } }],
      ['anchored-cites-blocks', { ...task, sourceRefs: [{ kind: 'note', noteId: 'n1', revision: 0 }] }],
      ['cites-own-anchor', { ...task, sourceRefs: [{ kind: 'block', noteId: 'n1', blockId: 'b9', revision: 0 }] }],
      [
        'anchor-null-cites-notes',
        { ...pin, sourceRefs: [{ kind: 'block', noteId: 'n1', blockId: 'b1', revision: 0 }] },
      ],
      ['cites-own-note', { ...pin, sourceRefs: [{ kind: 'note', noteId: 'n9', revision: 0 }] }],
      ['objective-category-is-computed', { ...task, category: 'today' }],
      ['connection-category', { ...asSignal(connectionDraft()), category: 'soon' }],
      ['checked-for-tasks', { ...task, checked: null }],
      ['checked-for-tasks', { ...pin, checked: true }],
      ['title-cleared-only-on-revoke', { ...inferred, title: '' }],
    ];
    for (const [problem, record] of broken) {
      assert.equal(signalRefusal(record), problem, problem);
      assert.ok(!v.is(signalRecord, record), problem);
    }
    const fresh = task.freshness;
    for (const freshness of [
      { ...fresh, state: 'stale' },
      { ...fresh, cause: 'source-edited' },
      { ...fresh, state: 'invalidated', cause: 'anchor-deleted' },
      { ...fresh, state: 'suspended', cause: 'note-trashed' },
    ]) {
      assert.ok(!v.is(signalRecord, { ...task, freshness }), JSON.stringify(freshness));
    }
    const decision = decisionFor(task);
    assert.ok(!v.is(decisionRecord, { ...decision, status: 'snoozed' }));
    assert.ok(!v.is(decisionRecord, { ...decision, status: 'completed' }));
    assert.ok(!v.is(decisionRecord, { ...decision, status: 'active' }));
    assert.ok(!v.is(decisionRecord, { ...decision, signalId: idOf(pinDraft()) }));
    assert.ok(!v.is(correctionRecord, { ...correctionFor(task), signalId: idOf(pinDraft()) }));
  });

  it('plainTitle drops URLs and control characters and clips to the bound without splitting a character', () => {
    assert.equal(
      plainTitle('Read  https://example.com/a?b=c\nand www.example.org/x  today'),
      'Read (link) and (link) today',
    );
    const long = plainTitle(`${'🗓'.repeat(100)}`);
    assert.ok(long.length <= TITLE_MAX);
    assert.ok(long.endsWith('…'));
    assert.ok(!/[\ud800-\udbff]…$/.test(long));
    assert.ok(v.is(signalRecord, asSignal(taskDraft({ title: `Call https://vendor.example/${'x'.repeat(300)}` }))));
  });
});

describe('quarantine on read (#7, "Required states and failure behavior")', () => {
  it('refuses a damaged record, counts it, and never returns or acts on it', async () => {
    const good = asSignal(taskDraft({ blockId: 'good' }));
    const damaged = { ...asSignal(taskDraft({ blockId: 'bad' })), title: 'x'.repeat(TITLE_MAX + 1) };
    const loose = { ...asSignal(pinDraft({ noteId: 'n2' })), prompt: 'canary' };
    const decided = asSignal(inferredDraft());
    const repository = createMemoryIntelligenceRepository({
      initial: {
        signals: [good, damaged, loose, decided],
        decisions: [{ ...decisionFor(decided), status: 'snoozed' }],
        corrections: [
          { ...correctionFor(decided), change: { field: 'category', after: 'later' } },
          correctionFor(decided),
        ],
      },
    });
    const intelligence = createIntelligence({
      repository,
      noteCommands: { setTodoChecked: async () => assert.fail('no note command') },
      timeZone: ZONE,
      clock: testClock(),
    });
    assert.equal((await intelligence.readSignal(good.id)).kind, 'ready');
    assert.equal((await intelligence.readSignal(damaged.id)).kind, 'not-found');
    assert.equal((await intelligence.readSignal(loose.id)).kind, 'not-found');
    const read = await intelligence.readSignal(decided.id);
    assert.equal(read.kind, 'ready');
    if (read.kind === 'ready') {
      // The damaged decision reads as absent, and only the valid correction is returned
      assert.equal(read.decision, null);
      assert.equal(read.corrections.length, 1);
    }
    assert.deepEqual(repository.quarantined(), { signals: 2, decisions: 1, corrections: 1 });
    // A command on a quarantined signal finds nothing to act on
    const outcome = await intelligence.execute({
      type: 'intelligence.dismiss',
      commandId: 'c1',
      signalId: damaged.id,
      expectedDecisionRevision: 0,
    });
    assert.equal(outcome.kind, 'rejected');
    assert.equal(outcome.code, 'signal-not-found');
  });
});

describe('unshipped (#7 slice 1, R1)', () => {
  it('is imported by nothing outside the domain, so no shipped page or worker loads it', () => {
    const root = path.join(import.meta.dirname, '..', '..');
    const domain = path.join(root, 'js', 'kernel', 'core', 'intelligence');
    const memory = path.join(root, 'js', 'kernel', 'core', 'memory', 'intelligence.js');
    const isDomain = (/** @type {string} */ file) => file.startsWith(`${domain}${path.sep}`) || file === memory;
    /** @type {string[]} */
    const modules = [];
    /** @param {string} dir */
    const collect = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (file !== path.join(root, 'js', 'lib')) collect(file);
        } else if (/\.m?js$/.test(entry.name)) {
          modules.push(file);
        }
      }
    };
    collect(path.join(root, 'js'));
    assert.ok(modules.some(isDomain));
    const importers = modules
      .filter(file => !isDomain(file))
      .filter(file => staticImports(file).some(isDomain))
      .map(file => path.relative(root, file));
    assert.deepEqual(importers, []);
  });
});
