// The CommitLog port suite on the in-memory log, and what only the in-memory one does:
// refusing a commit with no changes, and a change of a type no entity has.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UnavailableError } from '../../js/kernel/core/contracts/outcomes.js';
import { createMemoryCommitLog } from '../../js/kernel/core/memory/commit-log.js';
import { describeCommitLog } from './commit-log-suite.mjs';

describeCommitLog({
  name: 'in-memory',
  async start() {
    let failing = false;
    const log = createMemoryCommitLog({
      beforeRead() {
        if (!failing) return;
        failing = false;
        throw new UnavailableError('storage', 'read-failed', true);
      },
    });
    return {
      log,
      append: async changes => log.append(changes),
      prune: async through => log.prune(through),
      failNextRead: async () => {
        failing = true;
      },
      close: async () => {},
    };
  },
});

describe('the in-memory CommitLog', () => {
  it("appends only a commit with changes, each to an entity of a type hints name, and doesn't move its head otherwise", async () => {
    const log = createMemoryCommitLog();
    assert.throws(() => log.append([]), TypeError);
    assert.throws(
      () => log.append([/** @type {any} */ ({ entityType: 'setting', entityId: 'theme', revision: 0 })]),
      TypeError,
    );
    assert.throws(
      () => log.append([/** @type {any} */ ({ entityType: 'note', entityId: '', revision: 0 })]),
      TypeError,
    );
    assert.throws(
      () => log.append([/** @type {any} */ ({ entityType: 'note', entityId: 'n1', revision: -1 })]),
      TypeError,
    );
    assert.equal(await log.head(), 0);
  });
});
