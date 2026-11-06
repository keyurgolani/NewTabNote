// #17's read half (#35 slice 4b-0b): a tracker for a read alone answers a read's versions as the
// tracker for a commit does (versions.js), so a context that only reads CanvasTabDB reads a note's
// versions as #17's adapter does, and keeps nothing a commit's ops need.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createReadTracker } from '../../js/kernel/adapters/indexeddb/reads.js';
import { createVersionTracker } from '../../js/kernel/adapters/indexeddb/versions.js';

/** @typedef {import('../../js/kernel/adapters/indexeddb/reads.js').ReadTracker} ReadTracker */

/**
 * What `tracker` answers for the note `key`, or the code it throws
 * @param {ReadTracker} tracker
 * @param {IDBValidKey} key
 */
const versionsAnswer = (tracker, key) => {
  try {
    return tracker.versions(key);
  } catch (error) {
    return { threw: /** @type {{code?: unknown}} */ (error).code };
  }
};

/** @type {Array<[IDBValidKey, Record<string, unknown> | undefined]>} */
const READS = [
  ['n1', { id: 'n1', revision: 3, placementVersion: 1, sourceRevision: 2 }],
  // A later read of the same note keeps the first one's versions
  ['n1', { id: 'n1', revision: 9, placementVersion: 9, sourceRevision: 9 }],
  // A read that found none
  ['n2', undefined],
  // None of the fields, and fields that aren't counts, read as 0
  ['n3', { id: 'n3' }],
  ['n4', { id: 'n4', revision: -1, placementVersion: 1.5, sourceRevision: '2' }],
  // An array key, as #20's storage probe writes under, is a note of its own
  [['k', 1], { id: 'k', revision: 4 }],
];

/** The read tracker and the tracker for a commit, each told the same reads */
const trackers = () => {
  const read = createReadTracker();
  const write = createVersionTracker();
  for (const [key, record] of READS) {
    read.saw(key, record);
    write.saw(key, record);
  }
  return { read, write };
};

describe("#17's read half (#35 slice 4b-0b)", () => {
  it("keeps each note's versions as its first read found them, as the tracker for a commit does", () => {
    const { read, write } = trackers();
    for (const key of ['n1', 'n2', 'n3', 'n4', ['k', 1]]) {
      assert.deepEqual(versionsAnswer(read, key), versionsAnswer(write, key), JSON.stringify(key));
    }
    assert.deepEqual(versionsAnswer(read, 'n1'), { revision: 3, placementVersion: 1, sourceRevision: 2 });
    assert.equal(versionsAnswer(read, 'n2'), undefined);
    assert.deepEqual(versionsAnswer(read, 'n4'), { revision: 0, placementVersion: 0, sourceRevision: 0 });
  });

  it('refuses a note no read found with revision-before-get, as the tracker for a commit does', () => {
    const { read, write } = trackers();
    for (const key of ['k', ['k', 1, 2], 'never-read']) {
      assert.deepEqual(versionsAnswer(read, key), versionsAnswer(write, key), JSON.stringify(key));
      assert.deepEqual(versionsAnswer(read, key), { threw: 'revision-before-get' }, JSON.stringify(key));
    }
  });

  it("keeps nothing of blocks or folders, which only a commit's ops read", async () => {
    const read = createReadTracker();
    read.sawBlock('b1', { id: 'b1', canvasId: 'n1' });
    read.sawFolder('f1', { id: 'f1' });
    read.coverBlocks('n1', Promise.resolve([{ id: 'b1', canvasId: 'n1' }]));
    await Promise.resolve();
    for (const key of ['b1', 'f1', 'n1'])
      assert.deepEqual(versionsAnswer(read, key), { threw: 'revision-before-get' }, key);
    assert.deepEqual(Object.keys(read).sort(), ['coverBlocks', 'saw', 'sawBlock', 'sawFolder', 'versions']);
  });
});
