// #17 PR 1a, "Security and privacy": the canary scan. The AI key a v1.0.0 to v1.1.2 profile
// keeps in plaintext in IndexedDB `settings`, and the one later profiles keep in
// chrome.storage.local, never reach a recovery point, a receipt, an outcome, or a log line,
// on a clean run, a stopped one, or a failing one. And no note content reaches a receipt, a
// point's record or manifest, an outcome, or a log line, for any fixture.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Killed, dump, profileWith, recordsIn, run, stringsIn, synthesized } from './migration-support.mjs';

const FIXTURES = synthesized();
const CANARY = 'canary-llm-api-key';
const SMALL = Object.freeze({ records: 2, bytes: 2 * 1024 * 1024 });

/**
 * Everything a run leaves that must hold no secret: the recovery database whole, the
 * receipts, the outcomes, and the log lines
 * @param {import('./migration-support.mjs').Profile} of
 * @param {unknown[]} outcomes
 */
async function leftBehind(of, outcomes) {
  const dumped = await dump(of);
  return JSON.stringify({
    recovery: dumped.databases.filter(db => db.name === 'NewTabNoteRecovery'),
    receipts: recordsIn(dumped, 'CanvasTabDB', 'migrations'),
    meta: recordsIn(dumped, 'CanvasTabDB', 'meta'),
    outcomes,
    logs: of.logs,
  });
}

describe('the canary scan', () => {
  for (const id of ['v2-idb-settings.idb-settings-secret', 'v2-local-settings.basic']) {
    it(`${id}: the key stays where it was and reaches no point, receipt, outcome, or log line`, async () => {
      const of = await profileWith(/** @type {any} */ (FIXTURES.get(id)));
      const before = await dump(of);
      assert.ok(JSON.stringify(before).includes(CANARY), 'the fixture holds its canary');
      const outcomes = [await run(of), await run(of)];
      assert.equal(outcomes[0].status, 'migrated');
      assert.equal((await leftBehind(of, outcomes)).includes(CANARY), false);
      // Still where it was, untouched
      const after = await dump(of);
      assert.deepStrictEqual(recordsIn(after, 'CanvasTabDB', 'settings'), recordsIn(before, 'CanvasTabDB', 'settings'));
      assert.deepStrictEqual(after.chromeStorageLocal, before.chromeStorageLocal);
    });
  }

  it('stopped at every step and failing on space or verification, the key reaches nothing either', async () => {
    const fixture = /** @type {any} */ (FIXTURES.get('v2-idb-settings.idb-settings-secret'));
    for (let at = 1; at < 40; at++) {
      const of = await profileWith(fixture);
      let stops = 0;
      const outcomes = [
        await run(of, {
          limits: SMALL,
          hooks: {
            between: () => {
              if (++stops === at) throw new Killed();
            },
          },
        }),
      ];
      outcomes.push(await run(of, { limits: SMALL }));
      assert.equal((await leftBehind(of, outcomes)).includes(CANARY), false, `stopped at ${at}`);
      if (stops < at) break;
    }
    const short = await profileWith(fixture);
    const blocked = await run(short, { estimate: async () => ({ quota: 1, usage: 0 }) });
    assert.equal(blocked.status, 'space-blocked');
    assert.equal((await leftBehind(short, [blocked])).includes(CANARY), false);
  });
});

describe('no content in receipts, manifests, outcomes, or logs', () => {
  for (const [id, fixture] of FIXTURES) {
    it(id, async () => {
      // Every text a note, block, folder, or snapshot holds, long enough to mean something
      const content = new Set(
        fixture.databases
          .flatMap((/** @type {any} */ db) => db.stores)
          .filter((/** @type {any} */ store) => !['meta', 'migrations'].includes(store.name))
          .flatMap((/** @type {any} */ store) => store.records.map((/** @type {any} */ record) => record.value))
          .flatMap((/** @type {any} */ value) =>
            ['name', 'content', 'title', 'imageUrl', 'fileData', 'url'].map(field => value && value[field]),
          )
          .filter((/** @type {unknown} */ text) => typeof text === 'string' && text.length >= 4),
      );
      const of = await profileWith(fixture);
      const outcomes = [await run(of), await run(of)];
      const dumped = await dump(of);
      const points = recordsIn(dumped, 'NewTabNoteRecovery', 'points').map(record => record.value);
      const said = stringsIn({
        receipts: recordsIn(dumped, 'CanvasTabDB', 'migrations'),
        points,
        progress: recordsIn(dumped, 'NewTabNoteRecovery', 'progress'),
        outcomes,
        logs: of.logs,
      });
      for (const text of said) assert.equal(content.has(text), false, `"${text}" left the notes`);
    });
  }
});
