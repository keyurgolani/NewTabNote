// upcastJournalEntry (contracts/upcast.js): a journal entry's command, from the catalog version
// it was written at to the current one, or a refusal #35 turns into a conflict record.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { COMMANDS } from '../../js/kernel/core/contracts/commands.js';
import { QUERIES } from '../../js/kernel/core/contracts/queries.js';
import { JOURNAL_UPCASTERS, upcastJournalEntry } from '../../js/kernel/core/contracts/upcast.js';

/** @typedef {import('../../js/kernel/core/contracts/validate.js').Operation} Operation */
/** @typedef {import('../../js/kernel/core/contracts/upcast.js').Upcasters} Upcasters */

const CATALOG_URL = new URL('../../js/kernel/core/contracts/commands.js', import.meta.url);

/** @type {Map<string, Operation>} */
const operations = new Map();
for (const [name, entry] of [...Object.entries(COMMANDS), ...Object.entries(QUERIES)]) {
  const { payload, result } = await import(new URL(entry.schema, CATALOG_URL).href);
  operations.set(name, { entry, payload, result });
}

/** @param {string} name */
const lookup = name => operations.get(name);

const rename = { type: 'renameNote', commandId: 'c1', noteId: 'n1', name: 'Plan', origin: 'typed' };

/**
 * A lookup in which renameNote's catalog entry is at `version`, with today's schema
 * @param {number} version
 * @returns {(name: string) => Operation | undefined}
 */
function renameAt(version) {
  const operation = /** @type {Operation} */ (lookup('renameNote'));
  const moved = { ...operation, entry: { ...operation.entry, version } };
  return name => (name === 'renameNote' ? moved : lookup(name));
}

/**
 * Two steps for renameNote: version 1 called the title `title`, and version 2 had no origin
 * @type {Upcasters}
 */
const steps = {
  renameNote: {
    1: ({ title, ...rest }) => ({ ...rest, name: title }),
    2: command => ({ ...command, origin: 'typed' }),
  },
};

describe('upcastJournalEntry (#13, "Handshake and compatibility")', () => {
  it('has a step for every version below each command its catalog has', () => {
    assert.ok(Object.isFrozen(JOURNAL_UPCASTERS));
    for (const [type, entry] of Object.entries(COMMANDS)) {
      for (let version = 1; version < entry.version; version++) {
        assert.equal(typeof JOURNAL_UPCASTERS[type]?.[version], 'function', `${type} ${version}`);
      }
    }
  });

  it('hands back a command at the current version as it is, once its schema accepts it', () => {
    assert.deepEqual(upcastJournalEntry({ v: 1, command: rename }, lookup), { ok: true, command: rename });
    const capture = {
      type: 'captureToDailyNote',
      commandId: 'c2',
      noteId: 'd1',
      blockId: 'b1',
      capture: { type: 'bookmark', url: 'https://example.test/' },
    };
    assert.deepEqual(upcastJournalEntry({ v: 1, command: capture }, lookup), { ok: true, command: capture });
  });

  it('runs each step from the version the entry was written at, and checks the result', () => {
    const fromOne = { type: 'renameNote', commandId: 'c1', noteId: 'n1', title: 'Plan' };
    assert.deepEqual(upcastJournalEntry({ v: 1, command: fromOne }, renameAt(3), steps), { ok: true, command: rename });
    const fromTwo = { type: 'renameNote', commandId: 'c1', noteId: 'n1', name: 'Plan' };
    assert.deepEqual(upcastJournalEntry({ v: 2, command: fromTwo }, renameAt(3), steps), { ok: true, command: rename });
    // A step that leaves the command short of today's schema is refused, with what failed
    const untitled = upcastJournalEntry({ v: 1, command: { ...fromOne, title: 7 } }, renameAt(3), steps);
    assert.deepEqual(untitled, { ok: false, code: 'invalid-payload', issues: [{ type: 'string', path: '/name' }] });
  });

  it('refuses an entry with no path to the current version', () => {
    // A newer build wrote it
    assert.deepEqual(upcastJournalEntry({ v: 2, command: rename }, lookup), {
      ok: false,
      code: 'unsupported-version',
      issues: [],
    });
    // A step is missing
    const gap = { renameNote: { 2: steps.renameNote[2] } };
    const fromOne = { type: 'renameNote', commandId: 'c1', noteId: 'n1', title: 'Plan' };
    assert.equal(upcastJournalEntry({ v: 1, command: fromOne }, renameAt(3), gap).ok, false);
    assert.equal(
      /** @type {{code: string}} */ (upcastJournalEntry({ v: 1, command: fromOne }, renameAt(3), gap)).code,
      'unsupported-version',
    );
  });

  it("refuses a step that throws, or that changes the command's type or commandId", () => {
    for (const step of [
      () => {
        throw new Error('bad step');
      },
      (/** @type {Record<string, unknown>} */ command) => ({ ...command, commandId: 'c9' }),
      (/** @type {Record<string, unknown>} */ command) => ({ ...command, type: 'trashNote' }),
      () => /** @type {any} */ (null),
    ]) {
      const result = upcastJournalEntry({ v: 1, command: rename }, renameAt(2), { renameNote: { 1: step } });
      assert.deepEqual(result, { ok: false, code: 'invalid-payload', issues: [] });
    }
  });

  it('refuses an entry that names no command, a query, or a version that is no positive integer', () => {
    for (const v of [0, -1, 1.5, '1', undefined, null]) {
      assert.deepEqual(upcastJournalEntry({ v, command: rename }, lookup), {
        ok: false,
        code: 'invalid-payload',
        issues: [],
      });
    }
    for (const command of [null, 'renameNote', [], { commandId: 'c1' }, { type: 5 }]) {
      assert.equal(
        /** @type {{code?: string}} */ (upcastJournalEntry({ v: 1, command }, lookup)).code,
        'invalid-payload',
      );
    }
    for (const type of ['dropDatabase', 'listNotes']) {
      assert.deepEqual(upcastJournalEntry({ v: 1, command: { type, commandId: 'c1' } }, lookup), {
        ok: false,
        code: 'unknown-operation',
        issues: [],
      });
    }
    // A command that doesn't pass its own schema, at the current version
    const result = upcastJournalEntry({ v: 1, command: { ...rename, extra: 'x' } }, lookup);
    assert.deepEqual(result, { ok: false, code: 'invalid-payload', issues: [{ type: 'strict_object', path: '/*' }] });
  });
});
