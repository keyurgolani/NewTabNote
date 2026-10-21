// The schema walk the contract tests and the router share (contracts/schema-walk.js). Every
// rule the lint and the catalog test hold schemas to, and every entity id the router checks,
// sees only what walk() reaches, so it fails closed: a schema holding another schema
// somewhere walk() doesn't follow is an error, not a part left unread.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as v from '../../js/lib/valibot/index.mjs';
import { content, entityId } from '../../js/kernel/core/contracts/fields.js';
import { entityTypesIn, walk } from '../../js/kernel/core/contracts/schema-walk.js';

const bounded = v.pipe(v.string(), v.maxLength(64));

describe('walk', () => {
  it('reaches entries, items, wrapped schemas, and options, each at its path', () => {
    const schema = v.strictObject({
      id: entityId('note'),
      tags: v.optional(v.array(content(bounded))),
      capture: v.variant('type', [v.strictObject({ type: v.literal('a'), folderId: entityId('folder') })]),
    });
    const paths = walk(schema).map(visit => visit.path.join('.'));
    assert.deepEqual([...new Set(paths)], ['', 'id', 'tags', 'tags.[]', 'capture', 'capture.type', 'capture.folderId']);
    assert.deepEqual(entityTypesIn(schema), ['folder', 'note']);
  });

  it("refuses a schema it can't see into rather than leave it unread", () => {
    for (const [name, inner] of /** @type {Array<[string, v.GenericSchema]>} */ ([
      ['a lazy schema', v.lazy(() => v.strictObject({ password: bounded }))],
      ['a custom schema', v.custom(() => true)],
      ['a tuple', v.tuple([v.strictObject({ title: bounded })])],
      ['a strict tuple', v.strictTuple([v.object({ noteId: entityId('note') })])],
      ['a loose tuple', v.looseTuple([bounded])],
      ['a tuple with rest', v.tupleWithRest([bounded], v.strictObject({ secret: bounded }))],
      ['an object with rest', v.objectWithRest({ id: entityId('note') }, bounded)],
      [
        'a record',
        v.record(
          bounded,
          v.lazy(() => bounded),
        ),
      ],
      ['a map', v.map(bounded, bounded)],
      ['a set', v.set(bounded)],
      ['a schema later in a pipe', v.pipe(v.unknown(), v.transform(String), v.strictObject({ title: bounded }))],
    ])) {
      // At the root and nested in a field, so no depth hides one
      assert.throws(() => walk(inner), /walk\(\)/, `${name} at the root`);
      assert.throws(() => walk(v.strictObject({ field: v.optional(inner) })), /field/, `${name} in a field`);
    }
  });
});
