'use strict';

/**
 * The pages pass's two named chunks (#35 slice 4b-2), each a list of the modules it holds, by
 * their paths from the root. The new tab's, Popup's and Side Panel's starts share most of the
 * kernel. Once Popup's writes go through its send chunk, the bundler's own split cuts what the
 * pages share into a chunk for each set of entries that reaches a module: host, runtime,
 * op-fields, codec, Vite's preload helper, and the half of #17's adapter that only the new tab
 * and Side Panel import. Each was a file on the new tab's start, and together they put it over
 * its row. The pages pass writes two chunks in their place (scripts/build/vite-config.js), and
 * test/page-chunks.test.js holds both lists to the pages' import graphs.
 *   host     the first five merged: what the three starts share, and the helper they preload
 *            through. So it holds codec.js, which Popup and Side Panel import only in their send
 *            chunks, and op-fields.js, which Popup imports only in its send chunk too: merged,
 *            the new tab's start measured about 1,350 bytes gzip under the bundler's own split.
 *            The group names the helper itself, since no host module calls import(). Left out,
 *            it went with the adapter's group, whose close-drafts-on-demand.js does call
 *            import(), and Popup loaded the adapter chunk for it.
 *   adapter  the rest of #17's adapter, adapter.js and what it imports that host doesn't hold,
 *            and close-drafts-on-demand.js, applyCloseDraft's handler. Once Popup and Side Panel
 *            read through the reader (#35 slices 4b-2 and 4c), only the new tab's start loads it
 *            (ADAPTER_PAGES).
 * Three modules stay in chunks of the bundler's own:
 *   - preferences.js, the domain's and the application's. Only the new tab's and Popup's starts
 *     import them, so in host Side Panel's start would carry them.
 *   - close-draft-format.js. Popup and Side Panel import it only through import(), so in host
 *     their starts would carry it.
 * Each group takes its modules' static imports with it, as the bundler's groups do by default.
 * Host's group comes first, so a module both would take is host's. budget/layout holds where
 * the built chunks load (scripts/build/budgets.js).
 */

const fs = require('node:fs');
const path = require('node:path');

const HOST_MODULES = Object.freeze([
  'js/kernel/adapters/indexeddb/connection.js',
  'js/kernel/adapters/indexeddb/daily-answer.js',
  'js/kernel/adapters/indexeddb/failures.js',
  'js/kernel/adapters/indexeddb/ledger.js',
  'js/kernel/adapters/indexeddb/reads.js',
  'js/kernel/adapters/indexeddb/registry-names.js',
  'js/kernel/adapters/indexeddb/requests.js',
  'js/kernel/adapters/indexeddb/schema.js',
  'js/kernel/adapters/indexeddb/settings.js',
  'js/kernel/adapters/indexeddb/shapes.js',
  'js/kernel/composition/close-drafts.js',
  'js/kernel/composition/host.js',
  'js/kernel/composition/ids.js',
  'js/kernel/core/application/feed.js',
  'js/kernel/core/application/handlers.js',
  'js/kernel/core/application/kernel.js',
  'js/kernel/core/application/notes.js',
  'js/kernel/core/application/scopes.js',
  'js/kernel/core/application/work.js',
  'js/kernel/core/blocks/fields.js',
  'js/kernel/core/blocks/meaningful.js',
  'js/kernel/core/blocks/previews.js',
  'js/kernel/core/blocks/rich-text.js',
  'js/kernel/core/blocks/strip-tags.js',
  'js/kernel/core/blocks/wiki-links.js',
  'js/kernel/core/contracts/checks.js',
  'js/kernel/core/contracts/clone.js',
  'js/kernel/core/contracts/codec.js',
  'js/kernel/core/contracts/commands.js',
  'js/kernel/core/contracts/limits.js',
  'js/kernel/core/contracts/op-fields.js',
  'js/kernel/core/contracts/outcomes.js',
  'js/kernel/core/contracts/queries.js',
  'js/kernel/core/contracts/surfaces.js',
  'js/kernel/core/contracts/system.js',
  'js/kernel/core/domain/close-draft-keys.js',
  'js/kernel/core/domain/daily.js',
  'js/kernel/core/domain/note.js',
  'js/kernel/core/domain/placement.js',
  'js/kernel/core/domain/tombstone.js',
  'js/kernel/core/memory/fingerprint.js',
  'js/kernel/core/ports/policy.js',
  'js/kernel/core/ports/repository.js',
  'js/kernel/core/ports/runtime.js',
]);

const ADAPTER_MODULES = Object.freeze([
  'js/kernel/adapters/indexeddb/adapter.js',
  'js/kernel/adapters/indexeddb/backup-file.js',
  'js/kernel/adapters/indexeddb/backups.js',
  'js/kernel/adapters/indexeddb/changes.js',
  'js/kernel/adapters/indexeddb/conflicts.js',
  'js/kernel/adapters/indexeddb/copy-reads.js',
  'js/kernel/adapters/indexeddb/data-urls.js',
  'js/kernel/adapters/indexeddb/deletion.js',
  'js/kernel/adapters/indexeddb/recovery-copies.js',
  'js/kernel/adapters/indexeddb/versions.js',
  'js/kernel/core/application/close-drafts-on-demand.js',
  'js/kernel/core/domain/changes.js',
]);

/** Vite's preload helper, which it adds to each module that calls import(), by the bundler's id */
const PRELOAD_HELPER = '\0vite/preload-helper.js';

/** The chunks' names, which no chunk of recovery.html's own pass takes */
const PAGE_CHUNKS = Object.freeze(['host', 'adapter']);

/** The pages whose start loads the adapter chunk */
const ADAPTER_PAGES = Object.freeze(['newtab']);

/**
 * The pages pass's groups for the two chunks. Each knows its modules by the sources' path and
 * their real path, as a temporary directory's is on macOS (/var is /private/var), and host knows
 * the helper too.
 * @param {string} root
 * @returns {Array<{name: string, test: (id: string) => boolean}>}
 */
function pageChunkGroups(root) {
  const roots = [root];
  try {
    roots.push(fs.realpathSync(root));
  } catch {
    // Sources that aren't there, as a test's, have no real path
  }
  const ids = (/** @type {readonly string[]} */ files) => new Set(roots.flatMap((at) => files.map((file) => path.join(at, file))));
  const host = ids(HOST_MODULES);
  const adapter = ids(ADAPTER_MODULES);
  return [
    { name: 'host', test: (id) => id === PRELOAD_HELPER || host.has(id) },
    { name: 'adapter', test: (id) => adapter.has(id) },
  ];
}

module.exports = { HOST_MODULES, ADAPTER_MODULES, PRELOAD_HELPER, PAGE_CHUNKS, ADAPTER_PAGES, pageChunkGroups };
