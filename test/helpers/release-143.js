'use strict';

/**
 * 1.4.3's close-time drafts and start catch-up in the stack's tests (the stack's close-time PR,
 * #17 and #33): 1.4.3's own js/close-drafts.js and js/start-catch-up.js, frozen under
 * test/fixtures/storage/releases/v1.4.3/ (its SOURCE.json says where from), run in a page of
 * their own beside the page a test starts, as 1.4.3's new tab, Popup or Side Panel ran them. That
 * page shares the test page's IndexedDB, chrome.*, Web Locks and localStorage, as the
 * extension's pages share them.
 *
 * What 1.4.3 leaves for the stack is what its own code wrote: its drafts under
 * `ntn-close-draft:`, a recovered note under its draft's ID, the untold list, and the note IDs a
 * Popup or Side Panel start passed on for the catch-up. The stack's applier reads them at its
 * first start after the update.
 */

const { createLegacyEnv, requestToPromise, plain, DB_NAME } = require('./legacy-env');

/** Where 1.4.3's frozen files are */
const RELEASE_143 = 'test/fixtures/storage/releases/v1.4.3';

/**
 * A 1.4.3 page on `env`'s profile, with 1.4.3's own close-time drafts and start catch-up loaded
 * @param {ReturnType<typeof createLegacyEnv>} env - a page, whose localStorage and Web Locks it shares
 */
function release143(env) {
  if (!env.global.localStorage) throw new Error('release143: the page has no localStorage to share');
  const page = createLegacyEnv({
    indexedDB: env.indexedDB,
    chrome: env.chrome,
    localStorage: env.global.localStorage,
    locks: env.global.navigator.locks,
    document: null,
  });
  page.load(`${RELEASE_143}/js/close-drafts.js`, `${RELEASE_143}/js/start-catch-up.js`);
  const CloseDrafts = page.get('CloseDrafts');
  const StartCatchUp = page.get('StartCatchUp');
  const storage = page.global.localStorage;

  return {
    page,
    CloseDrafts,
    StartCatchUp,
    storage,

    /**
     * Write a draft as 1.4.3's editor writes one at its page's close: 1.4.3's own draftOf and
     * write. Answers the draft, as this realm's copy.
     * @param {Object} fields - what 1.4.3's editor gives draftOf
     */
    write(fields) {
      const draft = CloseDrafts.draftOf(fields);
      if (!CloseDrafts.write(storage, draft)) throw new Error('release143: the draft was skipped');
      return plain(draft);
    },

    /**
     * Put a draft back under its key as it was stored, as a page that closed between an apply's
     * commit and its remove leaves it
     * @param {{id: string}} draft
     * @param {string} stored - its JSON as 1.4.3 stored it
     */
    putBack(draft, stored) {
      storage.setItem(CloseDrafts.PREFIX + draft.id, stored);
    },

    /**
     * 1.4.3's own apply, on a connection of its own to the profile at the version it has, closed
     * once it's done, so a later upgrade isn't blocked
     * @param {{now?: number, trashDays?: number}} [options]
     */
    async apply({ now, trashDays = 30 } = {}) {
      if (!(await env.indexedDB.databases()).some((db) => db.name === DB_NAME)) {
        throw new Error('release143: there is no profile to apply the drafts on');
      }
      const db = await requestToPromise(env.indexedDB.open(DB_NAME));
      try {
        return plain(await CloseDrafts.apply({
          db,
          storage,
          locks: page.global.navigator.locks,
          ...(now === undefined ? {} : { now: () => now }),
          trashDays: () => trashDays,
        }));
      } finally {
        db.close();
      }
    },

    /** Every key and value in the shared localStorage, in order */
    entries() {
      return Array.from({ length: storage.length }, (_, index) => {
        const key = storage.key(index);
        return [key, storage.getItem(key)];
      });
    },
  };
}

/**
 * What 1.4.3 leaves on `release`'s profile for the stack's first start after the update, each
 * made by 1.4.3's own code. Each is optional:
 * - `elsewhere`: a draft whose note another writer saved since its base. 1.4.3's apply makes its
 *   recovered note and puts it on the untold list, and the draft is then put back under its key,
 *   as a page that closed between that apply's commit and its remove leaves it. It runs first, so
 *   that apply sees no other draft.
 * - `own` and `issued`: drafts left for the next start, written as 1.4.3's editor writes them.
 * - `catchUp`: the note IDs a 1.4.3 Popup or Side Panel start's apply named, which it passes on
 *   for the next new tab's catch-up (StartCatchUp.remember).
 * Answers the drafts as written, and what the first apply did.
 * @param {ReturnType<typeof release143>} release
 * @param {{elsewhere?: Object, own?: Object, issued?: Object, catchUp?: {dropped?: string[], gone?: string[]}, now?: number}} spec
 */
async function leave143(release, { elsewhere, own, issued, catchUp, now } = {}) {
  const drafts = {};
  let first = null;
  if (elsewhere) {
    drafts.elsewhere = release.write(elsewhere);
    const stored = release.storage.getItem(release.CloseDrafts.PREFIX + drafts.elsewhere.id);
    first = await release.apply({ now });
    release.putBack(drafts.elsewhere, stored);
  }
  if (own) drafts.own = release.write(own);
  if (issued) drafts.issued = release.write(issued);
  if (catchUp) release.StartCatchUp.remember({ dropped: catchUp.dropped || [], gone: catchUp.gone || [] }, release.storage);
  return { drafts, first };
}

/**
 * A draft in the stack's format, as the lead settled it for the close-time PR (Q1, 2026-11-01):
 * every field of 1.4.3's v1 under its own name, type and meaning, so 1.4.3's reader takes it,
 * plus the stack's own. `base.revision` is the content revision the editor last saw commit (null
 * on 1.4.x), and `base.issued` stays the `updatedAt` stamps of the saves its editor issued since.
 * The stack adds `page`, a per-load ID, and in `base` the name and each block's digest as the
 * editor last saw them commit, and `issuedSaves`, what each save the page issued since wrote.
 * Until the stack's writer builds them, the tests build them here, field by field.
 * @param {Object} fields
 * @param {(block: Object) => string} digest - the block digest the editor keeps
 */
function stackDraft(fields, digest) {
  const {
    id, page, noteId, at, base = {}, blocks = [], deletedBlockIds = [], preview = '', todoProgress = null,
    linkedNames = [], name, titleOrigin,
  } = fields;
  const draft = {
    v: 1,
    id,
    page,
    noteId,
    at,
    base: {
      revision: base.revision ?? null,
      updatedAt: base.updatedAt ?? null,
      issued: base.issued || [],
      name: base.name,
      blocks: Object.fromEntries((base.blocks || []).map((block) => [block.id, digest(block)])),
      issuedSaves: (base.issuedSaves || []).map((save) => ({
        name: save.name,
        blocks: Object.fromEntries(save.blocks.map((block) => [block.id, digest(block)])),
      })),
    },
    blocks,
    deletedBlockIds,
    preview,
    todoProgress,
    linkedNames,
  };
  if (name !== undefined) Object.assign(draft, { name, titleOrigin: titleOrigin || 'typed' });
  return draft;
}

module.exports = { RELEASE_143, release143, leave143, stackDraft };
