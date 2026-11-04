// The new tab's close-time draft writer (#33, the stack's close-time PR): the draft it writes,
// field by field, as 1.4.3's v1 plus the stack's fields, under `ntn-close-draft:<id>`; a draft
// that doesn't fit skipped, with nothing thrown; and the document client's revision, commandId
// and writer, which the editor reads and writes through.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { closeDraftWriter } from '../../js/kernel/composition/close-draft-writer.js';
import { createDocumentClient } from '../../js/kernel/composition/document.js';
import { createNewTabDocumentClient } from '../../js/kernel/composition/newtab.js';
import { blockDigest, decide, isCloseDraft, isStackDraft } from '../../js/kernel/core/domain/close-draft.js';
import { legacyEnv } from './legacy-fixture.mjs';

const AT = Date.UTC(2026, 9, 31, 21, 41);
const PREFIX = 'ntn-close-draft:';

/** @returns {() => string} ids in order, as a page's id source gives them */
const idsFrom = (/** @type {string[]} */ ids) => () => /** @type {string} */ (ids.shift());

/** A changed block, as the editor serializes one */
const typed = { id: 'b1', type: 'text', content: 'typed as the tab closed', canvasId: 'n1', order: 1 };

/** @returns {import('../../js/kernel/composition/close-draft-writer.js').DraftFields} */
const fieldsOf = (/** @type {Partial<import('../../js/kernel/composition/close-draft-writer.js').DraftFields>} */ more = {}) => ({
  id: 'cmd-1',
  noteId: 'n1',
  base: {
    revision: 4,
    updatedAt: AT - 60_000,
    name: 'Plan',
    blocks: { b1: blockDigest({ ...typed, content: 'before' }, 'n1') },
    issuedSaves: [],
  },
  blocks: [typed],
  deletedBlockIds: ['b9'],
  preview: 'typed as the tab closed',
  todoProgress: null,
  linkedNames: ['Elsewhere'],
  ...more,
});

/** The drafts in `storage`, by key */
const draftsIn = (/** @type {any} */ storage) =>
  Object.fromEntries(
    Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter(key => key.startsWith(PREFIX))
      .map(key => [key, JSON.parse(storage.getItem(key))]),
  );

describe("the new tab's close-time draft writer", () => {
  it("writes 1.4.3's v1 plus the stack's fields, under the draft's id, and the applier reads it as a stack draft", () => {
    const storage = legacyEnv.createLocalStorage();
    const writer = closeDraftWriter({ storage, newId: idsFrom(['page-1']), now: () => AT });
    assert.equal(writer.page, 'page-1');
    assert.equal(writer.write(fieldsOf()), true);
    const drafts = draftsIn(storage);
    assert.deepEqual(Object.keys(drafts), [`${PREFIX}cmd-1`]);
    const draft = drafts[`${PREFIX}cmd-1`];
    assert.deepEqual(draft, {
      v: 1,
      id: 'cmd-1',
      page: 'page-1',
      noteId: 'n1',
      at: AT,
      base: {
        revision: 4,
        updatedAt: AT - 60_000,
        issued: [],
        name: 'Plan',
        blocks: { b1: blockDigest({ ...typed, content: 'before' }, 'n1') },
        issuedSaves: [],
      },
      blocks: [typed],
      deletedBlockIds: ['b9'],
      preview: 'typed as the tab closed',
      todoProgress: null,
      linkedNames: ['Elsewhere'],
    });
    assert.equal(isCloseDraft(draft), true);
    assert.equal(isStackDraft(/** @type {any} */ (draft)), true);
  });

  it("carries the pane's moves, with each moved block's order in the base and in the page's issued saves, only when the editor gives them (#6)", () => {
    const storage = legacyEnv.createLocalStorage();
    const writer = closeDraftWriter({ storage, newId: idsFrom(['page-1']), now: () => AT });
    const base = { ...fieldsOf().base, orders: { b2: 1 }, issuedSaves: [{ blocks: {}, orders: { b2: 2 } }] };
    writer.write(fieldsOf({ id: 'moved', base, orders: [{ id: 'b2', order: 0 }] }));
    writer.write(fieldsOf({ id: 'still' }));
    const drafts = draftsIn(storage);
    const moved = drafts[`${PREFIX}moved`];
    assert.deepEqual([moved.orders, moved.base.orders, moved.base.issuedSaves], [[{ id: 'b2', order: 0 }], { b2: 1 }, [{ blocks: {}, orders: { b2: 2 } }]]);
    assert.equal(isCloseDraft(moved), true);
    assert.equal('orders' in drafts[`${PREFIX}still`], false);
    assert.equal('orders' in drafts[`${PREFIX}still`].base, false);
  });

  it("names the pane of the base it was made on when the editor gives one, and is byte for byte as before when it doesn't (#6)", () => {
    const storage = legacyEnv.createLocalStorage();
    const writer = closeDraftWriter({ storage, newId: idsFrom(['page-1']), now: () => AT });
    const paned = { ...fieldsOf({ id: 'paned' }), pane: 'pane-1' };
    writer.write(paned);
    writer.write(fieldsOf({ id: 'bare' }));
    const draft = JSON.parse(/** @type {string} */ (storage.getItem(`${PREFIX}paned`)));
    assert.equal(draft.pane, 'pane-1');
    assert.equal(isCloseDraft(draft), true, "1.5.0's check reads none of it");
    // In the order the writer has always written its fields, with no pane
    const bare = {
      v: 1,
      id: 'bare',
      page: 'page-1',
      noteId: 'n1',
      at: AT,
      base: {
        revision: 4,
        updatedAt: AT - 60_000,
        issued: [],
        name: 'Plan',
        blocks: { b1: blockDigest({ ...typed, content: 'before' }, 'n1') },
        issuedSaves: [],
      },
      blocks: [typed],
      deletedBlockIds: ['b9'],
      preview: 'typed as the tab closed',
      todoProgress: null,
      linkedNames: ['Elsewhere'],
    };
    assert.equal(storage.getItem(`${PREFIX}bare`), JSON.stringify(bare));
  });

  it('carries a title, typed unless it says generated, and only when the editor gives one', () => {
    const storage = legacyEnv.createLocalStorage();
    const writer = closeDraftWriter({ storage, newId: idsFrom(['page-1']), now: () => AT });
    writer.write(fieldsOf({ id: 'typed', name: 'Plan, retitled' }));
    writer.write(fieldsOf({ id: 'generated', name: 'Plan, by the AI', titleOrigin: 'generated' }));
    writer.write(fieldsOf({ id: 'untitled' }));
    const drafts = draftsIn(storage);
    assert.deepEqual([drafts[`${PREFIX}typed`].name, drafts[`${PREFIX}typed`].titleOrigin], ['Plan, retitled', 'typed']);
    assert.deepEqual([drafts[`${PREFIX}generated`].name, drafts[`${PREFIX}generated`].titleOrigin], ['Plan, by the AI', 'generated']);
    assert.equal('name' in drafts[`${PREFIX}untitled`], false);
    assert.equal('titleOrigin' in drafts[`${PREFIX}untitled`], false);
  });

  it("a draft with no known revision is still a stack draft, read by its digests and saved over the page's own later save (d20)", () => {
    const storage = legacyEnv.createLocalStorage();
    const writer = closeDraftWriter({ storage, newId: idsFrom(['page-1']), now: () => AT });
    // The page's own save committed after the base, as 'stored', which reports no revision
    const own = { ...typed, content: 'saved, its revision unknown' };
    writer.write(fieldsOf({ base: { ...fieldsOf().base, revision: null, blocks: { b1: blockDigest(own, 'n1') } } }));
    const draft = draftsIn(storage)[`${PREFIX}cmd-1`];
    assert.equal(isStackDraft(draft), true);
    const note = { id: 'n1', name: 'Plan', updatedAt: AT - 1_000 };
    const decision = decide({
      draft,
      note: /** @type {any} */ (note),
      madeBefore: false,
      stored: new Map([['b1', own]]),
      versions: { revision: 5, placementVersion: 0, sourceRevision: 0 },
    });
    // Read as 1.4.3's, by updatedAt with no issued stamps, it would be a recovered note
    assert.equal(decision.kind, 'save');
  });

  it("a draft that doesn't fit is skipped: write answers false, throws nothing, stores nothing, and logs the error's name alone", () => {
    const storage = legacyEnv.createLocalStorage({ quota: 100 });
    /** @type {Array<[string, Record<string, unknown>]>} */
    const warned = [];
    const writer = closeDraftWriter({
      storage,
      newId: idsFrom(['page-1']),
      now: () => AT,
      logger: { warn: (event, detail) => warned.push([event, detail]) },
    });
    assert.equal(writer.write(fieldsOf({ blocks: [{ ...typed, content: 'x'.repeat(300) }] })), false);
    assert.deepEqual(draftsIn(storage), {});
    assert.deepEqual(warned, [['close-draft-skipped', { name: 'QuotaExceededError' }]]);
  });

  it('a page without localStorage writes nothing', () => {
    const writer = closeDraftWriter({ storage: undefined, newId: idsFrom(['page-1']) });
    assert.equal(writer.write(fieldsOf()), false);
  });

  it("digests a block as the note stores it, the applier's blockDigest", () => {
    const writer = closeDraftWriter({ storage: undefined, newId: idsFrom(['page-1']) });
    assert.equal(writer.digest({ ...typed, canvasId: undefined }, 'n1'), blockDigest(typed, 'n1'));
  });

  it("leaves a block's times and its schema version out of its digest, so a copy a later save wrote a version on is the same block", () => {
    assert.equal(blockDigest({ ...typed, schemaVersion: 1, createdAt: AT, updatedAt: AT + 5 }, 'n1'), blockDigest(typed, 'n1'));
    assert.equal(blockDigest({ ...typed, schemaVersion: 0 }, 'n1'), blockDigest({ ...typed, schemaVersion: 1 }, 'n1'));
    assert.notEqual(blockDigest({ ...typed, content: 'typed again' }, 'n1'), blockDigest(typed, 'n1'));
  });

  it('a stored block a later save wrote its schema version on is still the one the base names: the draft saves, with no recovered note', () => {
    const storage = legacyEnv.createLocalStorage();
    const writer = closeDraftWriter({ storage, newId: idsFrom(['page-1']), now: () => AT });
    const before = { ...typed, content: 'before' };
    writer.write(fieldsOf({ base: { ...fieldsOf().base, revision: 4, blocks: { b1: blockDigest(before, 'n1') } } }));
    const draft = draftsIn(storage)[`${PREFIX}cmd-1`];
    // Another page's save since the base moved the revision and wrote b1 again, as it was, with its schema version
    const decision = decide({
      draft,
      note: /** @type {any} */ ({ id: 'n1', name: 'Plan', updatedAt: AT - 1_000 }),
      madeBefore: false,
      stored: new Map([['b1', { ...before, schemaVersion: 1, updatedAt: AT - 1_000 }]]),
      versions: { revision: 5, placementVersion: 0, sourceRevision: 0 },
    });
    assert.equal(decision.kind, 'save');
  });
});

describe("the document client's revision, commandId and writer", () => {
  /** A page's kernel client that answers getNote with `revision` and records each command */
  const clientOf = (/** @type {number | undefined} */ revision) => {
    /** @type {any[]} */
    const executed = [];
    const client = /** @type {any} */ ({
      whenReady: async () => null,
      query: async (/** @type {any} */ query) => {
        if (query.type === 'getNote') {
          const data = revision === undefined ? { note: { id: 'n1' } } : { note: { id: 'n1' }, revision, placementVersion: 0 };
          return { kind: 'ready', data };
        }
        return { kind: 'ready', data: [{ id: 'b1', canvasId: 'n1', order: 0 }] };
      },
      execute: async (/** @type {any} */ command) => {
        executed.push(command);
        return { kind: 'committed', code: 'content-saved', changedIds: [command.noteId] };
      },
      ids: { next: idsFrom(['fresh-1', 'fresh-2']) },
    });
    return { client, executed };
  };

  it("openNote answers the note's content revision as getNote read it, and null when it gives none", async () => {
    assert.equal((await createDocumentClient(clientOf(7).client).openNote('n1'))?.revision, 7);
    assert.equal((await createDocumentClient(clientOf(undefined).client).openNote('n1'))?.revision, null);
  });

  it('saveContent sends the commandId the editor gives, and a fresh one otherwise', async () => {
    const { client, executed } = clientOf(1);
    const documents = createDocumentClient(client);
    await documents.saveContent({ noteId: 'n1', blocks: [] }, { commandId: 'draft-id' });
    await documents.saveContent({ noteId: 'n1', blocks: [] });
    assert.deepEqual(
      executed.map(command => [command.type, command.commandId]),
      [
        ['saveNoteContent', 'draft-id'],
        ['saveNoteContent', 'fresh-1'],
      ],
    );
  });

  it("hands the editors the writer its root gives, and none otherwise; the new tab's writes to the page's localStorage", async () => {
    assert.equal(createDocumentClient(clientOf(1).client).closeDrafts, null);
    const storage = legacyEnv.createLocalStorage();
    const { client } = clientOf(1);
    const adapter = /** @type {any} */ ({ beforeClose: () => () => {}, openState: () => 'open' });
    const documents = createNewTabDocumentClient(client, adapter, { storage });
    const writer = /** @type {import('../../js/kernel/composition/close-draft-writer.js').CloseDraftWriter} */ (documents.closeDrafts);
    assert.equal(writer.page, 'fresh-1', "the page's id, from its id source");
    assert.equal(writer.write(fieldsOf()), true);
    assert.deepEqual(Object.keys(draftsIn(storage)), [`${PREFIX}cmd-1`]);
  });
});
