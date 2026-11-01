'use strict';

// The stack's close-time PR (#17 and #33), set up before its applier: 1.4.3's own close-time
// drafts and start catch-up, frozen under test/fixtures/storage/releases/v1.4.3/.
// - 1.4.3 reads a draft in the stack's format, v1 plus the stack's fields (the lead's Q1). On a
//   profile at version 8 its own apply saves it or makes a recovered note, and never removes it as
//   a format it doesn't know, so a rollback to 1.4.3 that finds a stack draft loses no edit.
// - What 1.4.3 leaves for the stack's first start after the update, made by 1.4.3's own code:
//   drafts, a recovered note whose draft an apply cut short left behind, the untold list, and the
//   note IDs a Popup or Side Panel start passed on for the catch-up.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyEnv, createDatabase, dumpDatabase, recordsOf, note, block, plain } = require('./helpers/legacy-env');
const { release143, leave143, stackDraft } = require('./helpers/release-143');

const T0 = 1700000000000;
const AT = Date.UTC(2026, 10, 1, 13, 30);
const UNTOLD = 'ntn-recovered-untold';
const CATCH_UP = 'ntn-start-catch-up:notes';
const NOTHING = { saved: [], recovered: [], dropped: [], gone: [], kept: [] };

/**
 * A page with a profile at version 8, as 1.4.x left it: notes A (blocks a1, a2), B (b1) and C
 * (c1), each with the times `times` gives it, and 1.4.3 beside it
 * @param {Object<string, Object>} [times] - fields for each note, by ID
 */
async function profileAt8(times = {}) {
  const env = createLegacyEnv({ document: null });
  await createDatabase(env.indexedDB, {
    records: {
      canvases: [
        note('A', { name: 'Alpha plan', ...times.A }),
        note('B', { name: 'Bravo', ...times.B }),
        note('C', { name: 'Charlie', ...times.C }),
      ],
      elements: [
        block('a1', 'A', 0, 'alpha'),
        block('a2', 'A', 1, 'alpha two'),
        block('b1', 'B', 0, 'bravo'),
        block('c1', 'C', 0, 'charlie'),
      ],
      search_index: [{ noteId: 'A', name: 'Alpha plan', content: 'alpha alpha two', updatedAt: T0 }],
    },
  });
  return { env, release: release143(env) };
}

/** The stored notes and blocks, by ID */
async function stored(env) {
  const dump = await dumpDatabase(env.indexedDB);
  return { notes: recordsOf(dump, 'canvases'), blocks: recordsOf(dump, 'elements') };
}

/** The keys of the drafts in localStorage, as 1.4.3 names them */
const draftKeys = (release) => release.entries().map(([key]) => key).filter((key) => key.startsWith(release.CloseDrafts.PREFIX));

describe("1.4.3 reads a draft in the stack's format (the lead's Q1)", () => {
  /** A stack draft of A's edit, a1 changed, on `base` */
  const stackDraftOfA = (release, base) =>
    stackDraft(
      {
        id: 'stack-draft-a',
        page: 'page-1',
        noteId: 'A',
        at: AT,
        base: { revision: 3, name: 'Alpha plan', blocks: [block('a1', 'A', 0, 'alpha'), block('a2', 'A', 1, 'alpha two')], ...base },
        blocks: [block('a1', 'A', 0, 'alpha, edited in the stack', { updatedAt: T0 + 5 })],
        preview: 'alpha, edited in the stack',
      },
      release.CloseDrafts.digest,
    );
  const write = (release, draft) => release.storage.setItem(release.CloseDrafts.PREFIX + draft.id, JSON.stringify(draft));

  it('lists it as a draft it can apply', async () => {
    const { release } = await profileAt8();
    write(release, stackDraftOfA(release, { updatedAt: T0 }));
    assert.deepEqual(plain(release.CloseDrafts.list(release.storage)).map(({ draft }) => draft.id), ['stack-draft-a']);
    assert.deepEqual(draftKeys(release), ['ntn-close-draft:stack-draft-a'], 'still stored, not removed as a format it doesn\'t know');
  });

  it('saves one whose note is as its editor last saw it', async () => {
    const { env, release } = await profileAt8();
    write(release, stackDraftOfA(release, { updatedAt: T0 }));
    assert.deepEqual(await release.apply({ now: T0 + 100 }), { ...NOTHING, saved: ['A'] });
    const after = await stored(env);
    assert.equal(after.blocks.a1.content, 'alpha, edited in the stack');
    assert.equal(after.notes.A.preview, 'alpha, edited in the stack');
    assert.deepEqual(draftKeys(release), []);
  });

  it("saves one whose note's stored updatedAt is a stamp its editor's own save made", async () => {
    const { env, release } = await profileAt8({ A: { updatedAt: T0 + 50 } });
    write(release, stackDraftOfA(release, { updatedAt: T0, issued: [T0 + 50] }));
    assert.deepEqual(await release.apply({ now: T0 + 100 }), { ...NOTHING, saved: ['A'] });
    assert.equal((await stored(env)).blocks.a1.content, 'alpha, edited in the stack');
  });

  it('makes one recovered note of one whose note another writer saved since', async () => {
    const { env, release } = await profileAt8({ A: { updatedAt: T0 + 70 } });
    write(release, stackDraftOfA(release, { updatedAt: T0 }));
    assert.deepEqual(await release.apply({ now: T0 + 100 }), {
      ...NOTHING,
      recovered: [{ noteId: 'A', recoveredId: 'stack-draft-a-recovered' }],
    });
    const after = await stored(env);
    assert.equal(after.blocks.a1.content, 'alpha', 'the original is as the other writer left it');
    const copies = Object.values(after.blocks).filter((row) => row.canvasId === 'stack-draft-a-recovered');
    assert.ok(copies.some((row) => row.content === 'alpha, edited in the stack'), 'the edit is in the recovered note');
    assert.deepEqual(draftKeys(release), []);
  });
});

/**
 * What 1.4.3 leaves on a profile at version 8, made by its own code: A's draft from the base its
 * editor last saw, B's put back beside the recovered note 1.4.3's own apply made of it (B was
 * saved elsewhere after its draft's base), C's from a base whose stored stamp its editor's own
 * save made, the untold list, and the IDs a Popup or Side Panel start passed on for the catch-up
 */
async function leftovers() {
  const { env, release } = await profileAt8({ B: { updatedAt: T0 + 70 }, C: { updatedAt: T0 + 50 } });
  const base = (updatedAt, issued = []) => ({ revision: null, updatedAt, issued });
  const { drafts, first } = await leave143(release, {
    now: T0 + 90,
    elsewhere: {
      noteId: 'B', base: base(T0), at: AT, blocks: [block('b1', 'B', 0, 'bravo, edited')], deletedBlockIds: [],
      preview: 'bravo, edited', todoProgress: null, linkedNames: [],
    },
    own: {
      noteId: 'A', base: base(T0), at: AT + 1, blocks: [block('a1', 'A', 0, 'alpha, edited')], deletedBlockIds: ['a2'],
      preview: 'alpha, edited', todoProgress: null, linkedNames: [],
    },
    issued: {
      noteId: 'C', base: base(T0, [T0 + 50]), at: AT + 2, blocks: [block('c1', 'C', 0, 'charlie, edited')], deletedBlockIds: [],
      preview: 'charlie, edited', todoProgress: null, linkedNames: [],
    },
    catchUp: { dropped: ['A'], gone: ['Z'] },
  });
  return { env, release, drafts, first, recoveredId: `${drafts.elsewhere.id}-recovered` };
}

describe("what 1.4.3 leaves for the stack's first start after the update", () => {
  it('drafts, a recovered note whose draft is still there, the untold list and the catch-up IDs, each as 1.4.3 wrote it', async () => {
    const { env, release, first, recoveredId } = await leftovers();
    assert.deepEqual(first, { ...NOTHING, recovered: [{ noteId: 'B', recoveredId }] });
    // Every draft still there, in the order their tabs closed, B's put back after its apply
    assert.deepEqual(
      plain(release.CloseDrafts.list(release.storage)).map(({ draft }) => [draft.noteId, draft.v]),
      [['B', 1], ['A', 1], ['C', 1]],
    );
    assert.deepEqual(JSON.parse(release.storage.getItem(UNTOLD)), [{ id: recoveredId, of: 'B' }]);
    assert.deepEqual(JSON.parse(release.storage.getItem(CATCH_UP)), { dropped: ['A'], gone: ['Z'] });

    const after = await stored(env);
    assert.ok(after.notes[recoveredId].name.startsWith('Recovered: Bravo'), "1.4.3's recovered note, beside B");
    assert.ok(Object.values(after.blocks).some((row) => row.canvasId === recoveredId && row.content === 'bravo, edited'));
    assert.equal(after.blocks.b1.content, 'bravo', 'B as the other writer left it');
    assert.equal(after.blocks.a1.content, 'alpha', 'A waits for the next start');
    assert.deepEqual(
      ['A', 'B', 'C'].map((id) => after.notes[id].updatedAt),
      [T0, T0 + 70, T0 + 50],
      "the stamps the stack's applier reads 1.4.3's bases against",
    );
  });
});

describe("the stack's first start after the update, on what 1.4.3 left", () => {
  const { webcrypto } = require('node:crypto');
  const { IDBKeyRange } = require('fake-indexeddb');

  /** The stack's roots: the worker's, and the new tab's */
  const roots = async () => ({
    worker: await import('../js/kernel/composition/background.js'),
    newTab: await import('../js/kernel/composition/newtab.js'),
  });

  /** The worker's host on the page's profile */
  const workerHost = (env) => ({
    indexedDB: env.indexedDB,
    keyRange: IDBKeyRange,
    settings: env.chrome.api.storage.local,
    locks: env.global.navigator.locks,
    estimate: null,
    crypto: webcrypto,
  });

  /** The new tab on the page, opening the database as it finds it, without waiting for the worker */
  const openNewTab = ({ newTab }, env) =>
    newTab.createNewTabPageClient(
      newTab.createNewTabAdapter({
        indexedDB: env.indexedDB,
        settings: env.chrome.api.storage.local,
        awaitUpgrade: async () => {},
        locks: env.global.navigator.locks,
      }),
      { drafts: { storage: env.global.localStorage, locks: env.global.navigator.locks }, wake: () => {} },
    );

  /** Each draft as the stack applies it: A's and C's saved, B's already recovered by 1.4.3 */
  const appliedOf = (recoveredId) => ({
    ...NOTHING,
    saved: ['A', 'C'],
    savedInTrash: [],
    recovered: [{ noteId: 'B', recoveredId }],
    caughtUp: [],
    catchUp: { dropped: ['A'], gone: ['Z'] },
  });

  /** What every run leaves: the edits in, one recovered note, told once, and nothing in localStorage */
  async function assertApplied({ env, release, recoveredId }) {
    const after = await stored(env);
    assert.equal(after.blocks.a1.content, 'alpha, edited');
    assert.equal(after.blocks.a2, undefined, "A's draft deleted a2");
    assert.equal(after.blocks.c1.content, 'charlie, edited', "C's stored stamp is its own editor's save");
    assert.equal(after.blocks.b1.content, 'bravo', 'B as the other writer left it');
    assert.deepEqual(
      Object.keys(after.notes).filter((id) => id.endsWith('-recovered')),
      [recoveredId],
      "one recovered note of B's draft, 1.4.3's",
    );
    assert.deepEqual(JSON.parse(release.storage.getItem(UNTOLD)), [{ id: recoveredId, of: 'B' }]);
    assert.deepEqual(draftKeys(release), []);
    assert.equal(release.storage.getItem(CATCH_UP), null);
  }

  it("run 1: the worker upgrades the profile and runs its transforms, then the new tab applies 1.4.3's drafts", async () => {
    const left = await leftovers();
    const stack = await roots();
    const worker = stack.worker.createWorkerClient(workerHost(left.env));
    assert.equal((await worker.migration.done).status, 'migrated');
    assert.equal((await worker.transforms.done)?.status, 'transformed');
    assert.equal((await worker.recordsCatchUp.done)?.status, 'done');

    const tab = openNewTab(stack, left.env);
    assert.deepEqual(plain(await tab.applied()), appliedOf(left.recoveredId));
    await assertApplied(left);
  });

  it('run 2: the new tab opens at 8 before the worker runs and applies them there, and the upgrade then closes its connection', async () => {
    const left = await leftovers();
    const stack = await roots();
    const tab = openNewTab(stack, left.env);
    assert.deepEqual(plain(await tab.applied()), appliedOf(left.recoveredId));
    assert.equal((await dumpDatabase(left.env.indexedDB)).version, 8, 'applied at 8');
    await assertApplied(left);

    const worker = stack.worker.createWorkerClient(workerHost(left.env));
    assert.equal((await worker.migration.done).status, 'migrated', 'the tab held up no upgrade');
    const after = await tab.execute({ type: 'setPinned', commandId: 'after-the-upgrade', noteId: 'A', pinned: true });
    assert.equal(after.code, 'reload-required');
    await assertApplied(left);
  });
});
