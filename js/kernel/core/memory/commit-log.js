/**
 * The in-memory CommitLog (ports/commit-log.js). The in-memory adapter appends to it when it's
 * given one (memory/adapter.js), in the task that commits, and tests keep it outside a fake
 * worker, as #17's change log outlives the worker. `prune` stands in for #19's retention.
 */

import { isId } from '../contracts/checks.js';
import { ENTITY_TYPES } from '../contracts/fields.js';
import { UnavailableError } from '../contracts/outcomes.js';

/** @typedef {import('../ports/commit-log.js').Change} Change */
/** @typedef {import('../ports/commit-log.js').ChangeEntry} ChangeEntry */
/** @typedef {import('../ports/commit-log.js').CommitLog} CommitLog */

/**
 * @typedef {CommitLog & {
 *   append: (changes: readonly Change[]) => number,
 *   prune: (through: number) => void,
 * }} MemoryCommitLog
 *   `append` adds one commit's changes and answers its commitSeq. `prune` drops every commit
 *   up to `through`, which becomes the floor.
 */

/**
 * @param {unknown} value
 * @param {number} from
 */
const isCount = (value, from) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= from;

/**
 * @param {unknown} change
 * @returns {change is Change}
 */
const isChange = change => {
  if (change === null || typeof change !== 'object') return false;
  const { entityType, entityId, revision } = /** @type {Record<string, unknown>} */ (change);
  return (
    ENTITY_TYPES.includes(/** @type {Change['entityType']} */ (entityType)) && isId(entityId) && isCount(revision, 0)
  );
};

/**
 * @param {{beforeRead?: () => void}} [options] - `beforeRead` runs before each read, and a
 *   throw fails it
 * @returns {MemoryCommitLog}
 */
export function createMemoryCommitLog({ beforeRead = () => {} } = {}) {
  /** @type {ChangeEntry[][]} each commit's entries, oldest first, from just past the floor */
  let commits = [];
  let head = 0;
  let floor = 0;

  return Object.freeze({
    async readChangesSince(cursor, limit) {
      if (!isCount(cursor, 0)) throw new UnavailableError('adapter', 'invalid-cursor', false);
      if (!isCount(limit, 1)) throw new UnavailableError('adapter', 'invalid-limit', false);
      beforeRead();
      if (cursor < floor || cursor > head) return { kind: 'resync-required', floor, head };
      const after = commits.filter(entries => entries[0].commitSeq > cursor);
      const page = after.slice(0, limit);
      return {
        kind: 'changes',
        entries: page.flat().map(entry => ({ ...entry })),
        cursor: page.length > 0 ? page[page.length - 1][0].commitSeq : cursor,
        more: after.length > page.length,
      };
    },
    async head() {
      beforeRead();
      return head;
    },
    append(changes) {
      if (!Array.isArray(changes) || changes.length === 0 || !changes.every(isChange)) {
        throw new TypeError('a commit appends one change or more, each to an entity');
      }
      head += 1;
      commits.push(
        changes.map(({ entityType, entityId, revision }) => ({ commitSeq: head, entityType, entityId, revision })),
      );
      return head;
    },
    prune(through) {
      if (!isCount(through, 0)) throw new TypeError('prune takes a commitSeq');
      floor = Math.max(floor, Math.min(through, head));
      commits = commits.filter(entries => entries[0].commitSeq > floor);
    },
  });
}
