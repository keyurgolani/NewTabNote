/**
 * The new tab's workers (#27 AC2, "Entries"): each a module worker started with
 * `new Worker(new URL('…', import.meta.url), {type: 'module'})`, the one form the bundler
 * builds as an entry of its own and writes the built file's URL into. A specifier built at
 * run time fails the build (closure/non-literal). The legacy files load as classic scripts in
 * the tests, where import.meta is a syntax error, so the composition root hands App these.
 */

/**
 * Start the search indexer, js/workers/indexer.js
 * @returns {Worker}
 */
export function startIndexer() {
  return new Worker(new URL('../../workers/indexer.js', import.meta.url), { type: 'module' });
}
