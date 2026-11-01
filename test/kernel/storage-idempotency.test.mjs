// #17 PR 2a on the IndexedDB adapter: retries answer from the `operations` ledger in the
// commit's own transaction, a stale command keeps only its conflict record and ledger row, a
// commit that aborts keeps nothing, and each commit moves its notes' versions and appends one
// change per note and folder it wrote. Then the declared limits, and the pin that no shipped
// path can answer `conflict` before #17 PR 4.

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { unitsWork } from '../../js/kernel/core/application/work.js';
import { COMMANDS } from '../../js/kernel/core/contracts/commands.js';
import { committed, conflict } from '../../js/kernel/core/contracts/outcomes.js';
import { digestOf } from '../../js/kernel/core/memory/fingerprint.js';
import { adapterOn, closeAll, kernelOn, legacyEnv, profile, recordsOf } from './storage-fixture.mjs';
import { CALLERS, NOW, testClock, testIds } from './support.mjs';

/** @typedef {import('./storage-fixture.mjs').Profile} Profile */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').Command} Command */
/** @typedef {import('../../js/kernel/core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../../js/kernel/core/application/kernel.js').Kernel} Kernel */

/** @type {Profile[]} */
const profiles = [];
after(() => profiles.forEach(closeAll));

const runtime = () => ({ ids: testIds(), clock: testClock() });

/**
 * A profile at this build's version with an open adapter, as the worker opens it, and a kernel
 * over it for `caller`
 * @param {import('./support.mjs').Caller} [caller]
 */
async function opened(caller = CALLERS.newtab) {
  const of = profile();
  profiles.push(of);
  const clock = testClock();
  const adapter = adapterOn(of, { clock });
  await adapter.open();
  return { of, adapter, kernel: kernelOn(adapter, { ids: testIds(), clock }, caller) };
}

/**
 * Another context's adapter and kernel over `of`, as a worker restart or a second page has
 * @param {Profile} of
 * @param {import('./support.mjs').Caller} [caller]
 */
async function another(of, caller = CALLERS.newtab) {
  const adapter = adapterOn(of, { clock: testClock() });
  await adapter.open();
  return { adapter, kernel: kernelOn(adapter, runtime(), caller) };
}

/** @param {Profile} of */
const dump = async of => JSON.stringify(await legacyEnv.dumpDatabase(of.real));

/**
 * @param {Outcome | import('../../js/kernel/core/contracts/outcomes.js').BulkOutcome} outcome
 * @param {string} kind
 */
const assertKind = (outcome, kind) => assert.equal(outcome.kind, kind, JSON.stringify(outcome));

/** @param {Profile} of */
const headOf = async of => (await recordsOf(of, 'meta')).find(record => record.key === 'changes')?.head ?? 0;

const block = (/** @type {string} */ id, /** @type {string} */ content) => ({ id, type: 'text', content, order: 0 });

describe("retries on #17's adapter answer from the ledger (#17 PR 2a)", () => {
  it('a reply lost after its commit: the resend replays, on a new adapter too, writes nothing, and the ledger reads it', async () => {
    const { of, kernel } = await opened();
    /** @type {Command} */
    const create = { type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'Plan', blocks: [block('b1', 'Milk')] };
    const first = await kernel.execute(create);
    assertKind(first, 'committed');
    const before = await dump(of);
    // The worker stopped before the reply reached the page: a new adapter over the same profile
    const restarted = await another(of);
    /** @type {string[]} */
    const published = [];
    restarted.kernel.subscribe(event => published.push(...event.ids));
    assert.deepEqual(await restarted.kernel.execute(create), first);
    assert.deepEqual(published, [], 'a replay publishes nothing');
    assert.equal(await dump(of), before, 'a replay writes nothing');
    assert.deepEqual(await restarted.adapter.ledger.read(/** @type {any} */ (create)), {
      status: 'committed',
      outcome: first,
    });
  });

  it('the same key with another command is key reuse and writes nothing, sent after it or at the same time', async () => {
    const { of, kernel } = await opened();
    /** @type {Command} */
    const create = { type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'Plan' };
    assertKind(await kernel.execute(create), 'committed');
    const before = await dump(of);
    const reused = await kernel.execute({ ...create, name: 'Other' });
    assert.deepEqual(reused.kind === 'rejected' && [reused.reason, reused.code], [
      'validation',
      'idempotency-key-reuse',
    ]);
    assert.equal(await dump(of), before);
    // Two contexts send one key with two commands at once: one commits, and the other is refused
    const second = await another(of);
    const [one, two] = await Promise.all([
      kernel.execute({ type: 'createNote', commandId: 'k1', noteId: 'a', name: 'A' }),
      second.kernel.execute({ type: 'createNote', commandId: 'k1', noteId: 'b', name: 'B' }),
    ]);
    assert.deepEqual(
      [one.kind, two.kind === 'rejected' && two.code],
      ['committed', 'idempotency-key-reuse'],
      JSON.stringify([one, two]),
    );
    const ids = (await recordsOf(of, 'canvases')).map(note => note.id).sort();
    assert.deepEqual(ids, ['a', 'n1']);
  });

  it('a stale save keeps a conflict record a reload reads, the text it tried included, and changes nothing else', async () => {
    const { of, kernel } = await opened();
    assertKind(
      await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1', blocks: [block('b1', 'One')] }),
      'committed',
    );
    const newer = await kernel.execute({
      type: 'saveNoteContent',
      commandId: 'c2',
      noteId: 'n1',
      blocks: [block('b1', 'Newer')],
    });
    assert.deepEqual(newer.kind === 'committed' && newer.revision, 2);
    const head = await headOf(of);
    /** @type {Command} */
    const stale = {
      type: 'saveNoteContent',
      commandId: 'c3',
      noteId: 'n1',
      blocks: [block('b1', 'A stale draft')],
      expectedRevision: 1,
    };
    const lost = await kernel.execute(stale);
    assert.deepEqual(lost.kind === 'conflict' && [lost.code, lost.currentRevision], ['revision-conflict', 2]);
    assert.ok(!JSON.stringify(lost).includes('stale draft'), 'the outcome carries no text');
    // A reload: another adapter over the profile reads what was kept
    const reloaded = await another(of);
    const [kept] = await recordsOf(of, 'conflicts');
    assert.deepEqual(
      { ...kept, at: 0 },
      { id: 'c3', noteId: 'n1', scope: 'content', expected: 1, current: 2, at: 0, command: stale },
    );
    assert.deepEqual(await reloaded.adapter.ledger.read(/** @type {any} */ (stale)), {
      status: 'conflict',
      outcome: lost,
    });
    const blocks = await recordsOf(of, 'elements');
    assert.deepEqual(
      blocks.map(stored => stored.content),
      ['Newer'],
    );
    assert.equal(await headOf(of), head, 'a conflict appends no change');
    // Its resend gets the same conflict, and keeps one record
    assert.deepEqual(await reloaded.kernel.execute(stale), lost);
    assert.equal((await recordsOf(of, 'conflicts')).length, 1);
  });

  it('a placement command that expects another placement version is a placement-conflict, with that version', async () => {
    const { of, kernel } = await opened();
    assertKind(await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'Plan' }), 'committed');
    const loaded = await kernel.query({ type: 'getNote', noteId: 'n1' });
    assert.deepEqual(loaded.kind === 'ready' && [loaded.data.revision, loaded.data.placementVersion], [1, 0]);
    assertKind(await kernel.execute({ type: 'setPinned', commandId: 'c2', noteId: 'n1', pinned: true }), 'committed');
    const lost = await kernel.execute({
      type: 'archiveNote',
      commandId: 'c3',
      noteId: 'n1',
      expectedPlacementVersion: 0,
    });
    assert.deepEqual(lost.kind === 'conflict' && [lost.code, lost.currentRevision], ['placement-conflict', 1]);
    const [note] = await recordsOf(of, 'canvases');
    assert.deepEqual([note.archived, note.pinned], [false, true]);
    const [kept] = await recordsOf(of, 'conflicts');
    assert.deepEqual([kept.scope, kept.expected, kept.current], ['placement', 0, 1]);
    // The version it reads now commits
    const archived = await kernel.execute({
      type: 'archiveNote',
      commandId: 'c4',
      noteId: 'n1',
      expectedPlacementVersion: 1,
    });
    assertKind(archived, 'committed');
  });
});

describe("a commit on #17's adapter that aborts keeps nothing (#17 PR 2a)", () => {
  for (const store of ['canvases', 'elements', 'operations', 'changes', 'meta']) {
    it(`a save whose transaction aborts after its write to ${store} leaves no ledger row, change, or note change`, async () => {
      const { of, kernel } = await opened();
      assertKind(
        await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1', blocks: [block('b1', 'One')] }),
        'committed',
      );
      const before = await dump(of);
      of.faults.abortAfterNextWrite(store, 'QuotaExceededError');
      const outcome = await kernel.execute({
        type: 'saveNoteContent',
        commandId: 'c2',
        noteId: 'n1',
        blocks: [block('b1', 'Two')],
      });
      assert.deepEqual(outcome.kind === 'unavailable' && outcome.cause, 'quota', JSON.stringify(outcome));
      assert.equal(await dump(of), before);
    });
  }

  it('a conflict whose transaction aborts after its record leaves no record and no ledger row, so a resend runs', async () => {
    const { of, kernel } = await opened();
    assertKind(
      await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1', blocks: [block('b1', 'One')] }),
      'committed',
    );
    assertKind(
      await kernel.execute({ type: 'saveNoteContent', commandId: 'c2', noteId: 'n1', blocks: [block('b1', 'Two')] }),
      'committed',
    );
    const before = await dump(of);
    /** @type {Command} */
    const stale = {
      type: 'saveNoteContent',
      commandId: 'c3',
      noteId: 'n1',
      blocks: [block('b1', 'Old')],
      expectedRevision: 1,
    };
    of.faults.abortAfterNextWrite('conflicts', 'QuotaExceededError');
    assertKind(await kernel.execute(stale), 'unavailable');
    assert.equal(await dump(of), before);
    assertKind(await kernel.execute(stale), 'conflict');
    assert.equal((await recordsOf(of, 'conflicts')).length, 1);
  });

  it('a unit that answers a conflict after it wrote is refused as conflict-after-write, and nothing commits', async () => {
    const { of, adapter } = await opened();
    const before = await dump(of);
    const command = /** @type {Command} */ ({ type: 'saveNoteContent', commandId: 'c1', noteId: 'n1', blocks: [] });
    const work = unitsWork(
      command,
      [
        {
          stores: ['notes', 'blocks'],
          async run(tx) {
            tx.put('blocks', { id: 'b1', canvasId: 'n1', content: 'Written first' });
            return conflict('revision-conflict', 3);
          },
        },
      ],
      () => committed('content-saved', ['n1']),
      { primary: () => ({ store: 'notes', key: 'n1' }) },
    );
    const { outcome } = await adapter.commit(work);
    assert.deepEqual(outcome.kind === 'unavailable' && [outcome.cause, outcome.code], [
      'adapter',
      'conflict-after-write',
    ]);
    assert.equal(await dump(of), before);
  });
});

describe("#17's adapter keeps each note's versions, its change log, and its tombstones (#17 PR 2a)", () => {
  it('a content change moves the revision, a placement one the placement version, and insights take their source revision', async () => {
    const { of, kernel } = await opened();
    /** @param {string} noteId */
    const versionsOf = async noteId => {
      const note = (await recordsOf(of, 'canvases')).find(record => record.id === noteId);
      return [note.revision, note.placementVersion, note.sourceRevision];
    };
    assertKind(await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'Plan' }), 'committed');
    assert.deepEqual(await versionsOf('n1'), [1, 0, 0]);
    assertKind(await kernel.execute({ type: 'setPinned', commandId: 'c2', noteId: 'n1', pinned: true }), 'committed');
    assert.deepEqual(await versionsOf('n1'), [1, 1, 0]);
    assertKind(
      await kernel.execute({ type: 'saveNoteContent', commandId: 'c3', noteId: 'n1', blocks: [block('b1', 'Milk')] }),
      'committed',
    );
    assert.deepEqual(await versionsOf('n1'), [2, 1, 0]);
    const attached = await kernel.execute({
      type: 'attachInsights',
      commandId: 'c4',
      noteId: 'n1',
      insights: { todos: ['Milk'] },
      sourceRevision: 2,
    });
    assert.deepEqual(attached.kind === 'committed' && [attached.code, attached.revision], ['insights-attached', 2]);
    assert.deepEqual(await versionsOf('n1'), [2, 1, 2]);
    // Insights from an older revision than the ones kept are dropped
    const stale = await kernel.execute({
      type: 'attachInsights',
      commandId: 'c5',
      noteId: 'n1',
      insights: { todos: [] },
      sourceRevision: 1,
    });
    assert.deepEqual(stale.kind === 'committed' && [stale.code, stale.changedIds, stale.severity], [
      'insights-stale',
      [],
      'info',
    ]);
    const note = (await recordsOf(of, 'canvases'))[0];
    assert.deepEqual(note.insights, { todos: ['Milk'] });
    // Deleting blocks is a content change the note's record didn't take, and moves it too
    const deleted = await kernel.execute({ type: 'deleteBlocks', commandId: 'c6', noteId: 'n1', blockIds: ['b1'] });
    assert.deepEqual(deleted.kind === 'committed' && deleted.revision, 3);
    assert.deepEqual(await versionsOf('n1'), [3, 1, 2]);
    assert.deepEqual(
      (await recordsOf(of, 'changes')).map(row => [row.seq, row.entityType, row.entityId, row.revision, row.opId]),
      [
        [1, 'note', 'n1', 1, 'c1'],
        [2, 'note', 'n1', 1, 'c2'],
        [3, 'note', 'n1', 2, 'c3'],
        [4, 'note', 'n1', 2, 'c4'],
        [5, 'note', 'n1', 3, 'c6'],
      ],
    );
  });

  it("types each change by the store it wrote: deleteFolder's filed notes go in as notes", async () => {
    const { of, kernel } = await opened();
    assertKind(
      await kernel.execute({ type: 'createFolder', commandId: 'c1', folderId: 'f1', name: 'Work', parentId: null }),
      'committed',
    );
    assertKind(
      await kernel.execute({ type: 'createNote', commandId: 'c2', noteId: 'n1', name: 'Filed', folderId: 'f1' }),
      'committed',
    );
    const removed = await kernel.execute({ type: 'deleteFolder', commandId: 'c3', folderId: 'f1' });
    assert.deepEqual(removed.kind === 'committed' && [removed.changedIds, removed.commitSeq], [['f1', 'n1'], 3]);
    assert.deepEqual(
      (await recordsOf(of, 'changes'))
        .filter(row => row.seq === 3)
        .map(row => [row.entityType, row.entityId, row.revision]),
      [
        ['folder', 'f1', 0],
        ['note', 'n1', 1],
      ],
    );
    const note = (await recordsOf(of, 'canvases'))[0];
    assert.deepEqual([note.folderId, note.placementVersion], [null, 1]);
  });

  it('a deleted note leaves a content-free tombstone, and one made again under its id carries on past it', async () => {
    const { of, kernel } = await opened();
    assertKind(await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' }), 'committed');
    const trashed = await kernel.execute({ type: 'trashNote', commandId: 'c2', noteId: 'n1' });
    assert.deepEqual(trashed.kind === 'committed' && [trashed.code, trashed.commitSeq], ['note-deleted', 2]);
    // Core's deletion puts it, with its reason and its purge pending, and the adapter gives it
    // the note's last revision and the commit's seq (#17 PR 2b)
    assert.deepEqual(await recordsOf(of, 'tombstones'), [
      {
        entityType: 'note',
        id: 'n1',
        deletedAt: NOW,
        reason: 'empty-note',
        purge: 'pending',
        lastRevision: 1,
        seq: 2,
      },
    ]);
    const again = await kernel.execute({ type: 'createNote', commandId: 'c3', noteId: 'n1', name: 'Again' });
    assert.deepEqual(again.kind === 'committed' && again.revision, 2);
  });

  it('leaves a note the legacy adapter wrote readable: versions it lacks read as 0', async () => {
    const of = profile();
    profiles.push(of);
    await legacyEnv.createDatabase(of.real, { records: { canvases: [legacyEnv.note('n1')] } });
    // A note 1.4.x wrote, opened as it is
    const adapter = adapterOn(of, { mode: 'existing' });
    await adapter.open();
    const kernel = kernelOn(adapter, runtime());
    const loaded = await kernel.query({ type: 'getNote', noteId: 'n1' });
    assert.deepEqual(loaded.kind === 'ready' && [loaded.data.revision, loaded.data.placementVersion], [0, 0]);
    const saved = await kernel.execute({
      type: 'saveNoteContent',
      commandId: 'c1',
      noteId: 'n1',
      blocks: [],
      expectedRevision: 0,
    });
    assert.deepEqual(saved.kind === 'committed' && saved.revision, 1);
  });
});

describe("#17's adapter's declared limits (#17 PR 2a)", () => {
  it('below version 10 it keeps no ledger, change, conflict, or tombstone, so a resend runs again', async () => {
    const of = profile();
    profiles.push(of);
    await legacyEnv.createDatabase(of.real, {});
    const adapter = adapterOn(of, { mode: 'existing' });
    await adapter.open();
    const kernel = kernelOn(adapter, runtime());
    /** @type {Command} */
    const create = { type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'Plan' };
    assertKind(await kernel.execute(create), 'committed');
    const again = await kernel.execute(create);
    assert.deepEqual(again.kind === 'rejected' && again.code, 'note-exists');
    const stores = Object.keys((await legacyEnv.dumpDatabase(of.real)).stores);
    for (const store of ['operations', 'changes', 'conflicts', 'tombstones']) assert.ok(!stores.includes(store), store);
    // Its notes still carry versions, which no store needs
    const [note] = await recordsOf(of, 'canvases');
    assert.deepEqual([note.revision, note.placementVersion], [1, 0]);
  });

  it('keeps no ledger row for a settings command, which writes outside IndexedDB, so a resend writes again', async () => {
    const { of, kernel } = await opened();
    /** @type {Command} */
    const prefer = { type: 'setPreferences', commandId: 'c1', values: { theme: 'dark' } };
    assertKind(await kernel.execute(prefer), 'committed');
    assertKind(await kernel.execute(prefer), 'committed');
    assert.deepEqual(await recordsOf(of, 'operations'), []);
  });

  it("reserves a bulk command's key in its adapter only: another context's resend with another selection runs", async () => {
    const { of, kernel } = await opened();
    for (const noteId of ['a', 'b']) {
      assertKind(
        await kernel.execute({ type: 'createNote', commandId: `c-${noteId}`, noteId, name: noteId }),
        'committed',
      );
    }
    /** @type {Command} */
    const archive = { type: 'runBulkAction', commandId: 'bulk', action: 'archive', noteIds: ['a'] };
    assertKind(await kernel.execute(archive), 'bulk');
    const here = await kernel.execute({ ...archive, noteIds: ['b'] });
    assert.deepEqual(here.kind === 'rejected' && here.code, 'idempotency-key-reuse');
    const elsewhere = await (await another(of)).kernel.execute({ ...archive, noteIds: ['b'] });
    assert.deepEqual(elsewhere.kind === 'bulk' && elsewhere.committedIds, ['b']);
  });
});

describe('no shipped path reaches a conflict before #17 PR 4 (#17 PR 2a, plan section 3)', () => {
  const VERSIONED = ['expectedRevision', 'expectedPlacementVersion', 'sourceRevision'];

  it('no command Popup, Side Panel, or the worker may run carries an expected version or a source revision', async () => {
    const shipped = Object.entries(COMMANDS).filter(([, entry]) =>
      entry.surfaces.some(surface => ['popup', 'sidepanel', 'worker-internal'].includes(surface)),
    );
    assert.deepEqual(shipped.map(([type]) => type).sort(), [
      // A closing tab's edit, whose base the command checks in its own transaction (#33)
      'applyCloseDraft',
      'captureToDailyNote',
      // The worker's one-time catch-up of 1.4.x's lagging records, a derived write with no source revision (#33)
      'catchUpNoteRecords',
      'createNote',
      // The worker's read-only check after an install or an update (#35 slice 1)
      'runIntegrityCheck',
      'runStartupMaintenance',
    ]);
    for (const [type, entry] of shipped) {
      const module = await import(
        new URL(entry.schema, new URL('../../js/kernel/core/contracts/commands.js', import.meta.url)).href
      );
      const fields = Object.keys(module.payload.entries);
      assert.deepEqual(
        fields.filter(field => VERSIONED.includes(field)),
        [],
        type,
      );
    }
  });

  it("the worker's capture commits into a Daily Note another command moved meanwhile, and Popup's create commits", async () => {
    const { of, kernel: worker } = await opened(CALLERS['worker-internal']);
    /** @param {string} id */
    const capture = id =>
      worker.execute({
        type: 'captureToDailyNote',
        commandId: `c-${id}`,
        noteId: 'd1',
        blockId: `b-${id}`,
        capture: { type: 'text', content: id },
      });
    const first = await capture('first');
    assertKind(first, 'committed');
    const tab = (await another(of)).kernel;
    assertKind(await tab.execute({ type: 'renameNote', commandId: 'r1', noteId: 'd1', name: 'Today' }), 'committed');
    const second = await capture('second');
    assert.deepEqual(second.kind === 'committed' && second.revision, 3);
    const popup = (await another(of, CALLERS.popup)).kernel;
    assertKind(await popup.execute({ type: 'createNote', commandId: 'p1', noteId: 'q1', name: 'Quick' }), 'committed');
  });
});

describe("the ledger's digest of a large command (for #17 PR 4's saves)", () => {
  it("is node:crypto's SHA-256 of its canonical JSON for a 1 MiB save, and how long it takes is reported", t => {
    const text = 'x'.repeat(1024);
    const blocks = Array.from({ length: 1024 }, (_, index) => ({
      id: `b${index}`,
      type: 'text',
      content: text,
      order: index,
    }));
    const command = { type: 'saveNoteContent', commandId: 'c1', noteId: 'n1', blocks };
    const started = performance.now();
    const digest = digestOf(command);
    const took = performance.now() - started;
    t.diagnostic(`digest of a ${Math.round(JSON.stringify(command).length / 1024)} KiB save: ${took.toFixed(1)} ms`);
    /** @param {unknown} value @returns {unknown} */
    const sorted = value =>
      Array.isArray(value)
        ? value.map(sorted)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map(key => [key, sorted(/** @type {any} */ (value)[key])]),
            )
          : value;
    assert.equal(
      digest,
      createHash('sha256')
        .update(JSON.stringify(sorted(command)))
        .digest('hex'),
    );
  });
});
