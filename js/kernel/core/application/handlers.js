/**
 * The handlers a context's kernel runs (#17 PR 4b, the lead's ruling on Popup's and Side
 * Panel's start). Each composition root hands its kernel the table of the commands and
 * queries its page sends, and no others, so a page loads only the handler modules it runs:
 * Popup's and Side Panel's start holds no remote apply or index command while #19 isn't live.
 * The new tab's table is every handler the catalog allows there (handlers-all.js), Popup's,
 * Side Panel's and the worker's their own files. test/kernel/handlers.test.mjs holds each
 * table to what its page's code sends.
 *
 * A command or query the policy allows that a table doesn't hold is refused as
 * `not-registered` and logged as an error (kernel.js), never run and never dropped.
 */

import { COMMANDS } from '../contracts/commands.js';
import { QUERIES } from '../contracts/queries.js';

/** @typedef {import('../contracts/commands.js').CommandType} CommandType */
/** @typedef {import('../contracts/queries.js').QueryType} QueryType */
/** @typedef {import('../contracts/surfaces.js').Surface} Surface */
/** @typedef {import('../contracts/outcomes.js').Rejected} Rejected */

/**
 * @template {CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/**
 * @template {QueryType} T
 * @typedef {import('./work.js').QueryHandler<T>} QueryHandler
 */

/**
 * What a context's kernel runs: its commands' and queries' handlers, and what refuses each bulk
 * command it holds for its payload before the adapter recalls it, which reserves its key
 * @typedef {object} HandlerTable
 * @property {Readonly<Partial<{[T in CommandType]: CommandHandler<T>}>>} commands
 * @property {Readonly<Partial<{[T in QueryType]: QueryHandler<T>}>>} queries
 * @property {Readonly<Partial<Record<CommandType, (command: any) => Rejected | undefined>>>} refusals
 */

/**
 * A frozen table
 * @param {{commands?: HandlerTable['commands'], queries?: HandlerTable['queries'], refusals?: HandlerTable['refusals']}} parts
 * @returns {HandlerTable}
 */
export function handlerTable({ commands = {}, queries = {}, refusals = {} }) {
  return Object.freeze({
    commands: Object.freeze({ ...commands }),
    queries: Object.freeze({ ...queries }),
    refusals: Object.freeze({ ...refusals }),
  });
}

/**
 * The part of `table` the catalog allows on `surface`
 * @param {HandlerTable} table
 * @param {Surface} surface
 * @returns {HandlerTable}
 */
export function forSurface(table, surface) {
  /**
   * @template {Record<string, unknown>} R
   * @param {R} handlers
   * @param {Readonly<Record<string, {surfaces: readonly string[]}>>} catalog
   * @returns {R}
   */
  const allowed = (handlers, catalog) =>
    /** @type {R} */ (
      Object.fromEntries(
        Object.entries(handlers).filter(
          ([type]) => Object.hasOwn(catalog, type) && catalog[type].surfaces.includes(surface),
        ),
      )
    );
  return handlerTable({
    commands: allowed(table.commands, COMMANDS),
    queries: allowed(table.queries, QUERIES),
    refusals: allowed(table.refusals, COMMANDS),
  });
}
