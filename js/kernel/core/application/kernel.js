/**
 * One context's kernel (#12, "Where the kernel runs"). A composition root builds it from that
 * context's adapter, policy, and caller, and hands out its client. Every new tab, Popup, Side
 * Panel, and the service worker builds its own, and none holds authoritative state in memory:
 * queries read the adapter, and the commit feed tells this context's projections what its
 * own commands changed. Calls are async and take and return structured-clone-safe values, so
 * #35 can point the client at the background coordinator without changing a caller.
 *
 * Each kernel has one fixed caller, its composition root's, and the policy checks it on every
 * command and query. Nothing a payload says changes it, so #35's coordinator builds one kernel
 * per principal #13 verified rather than one that takes the caller from a message.
 *
 * execute() runs every command the same way: copy it, ask the policy, recall the outcome an
 * earlier run of its commandId got, run its use case, commit, and publish what changed. Once
 * the kernel is ready nothing before the commit is awaited, so saveNoteContent opens its
 * transaction in the task that calls it.
 */

import { isId, isRecord } from '../contracts/checks.js';
import { clone } from '../contracts/clone.js';
import { COMMANDS, isCommandType } from '../contracts/commands.js';
import { failed, failedFrom, loading, rejected, unavailableFrom } from '../contracts/outcomes.js';
import { isQueryType } from '../contracts/queries.js';
import { silentLogger, systemClock } from '../ports/runtime.js';
import { createCommitFeed } from './feed.js';
import { folderCommands, folderQueries } from './folders.js';
import { maintenanceCommands } from './maintenance.js';
import { noteCommands, noteQueries } from './notes.js';
import { preferenceCommands, preferenceQueries } from './preferences.js';
import { sessionCommands, sessionQueries } from './session.js';

/** @typedef {import('../contracts/commands.js').Command} Command */
/** @typedef {import('../contracts/commands.js').CommandType} CommandType */
/** @typedef {import('../contracts/commands.js').Aggregate} Aggregate */
/** @typedef {import('../contracts/queries.js').Query} Query */
/** @typedef {import('../contracts/queries.js').QueryType} QueryType */
/** @typedef {import('../contracts/queries.js').QueryData} QueryData */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../contracts/outcomes.js').Unavailable} Unavailable */
/** @typedef {import('../ports/policy.js').PolicyPort} PolicyPort */
/** @typedef {import('../ports/policy.js').Caller} Caller */
/** @typedef {import('../ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../ports/repository.js').AdapterFlags} AdapterFlags */
/** @typedef {import('../ports/repository.js').Work} Work */
/** @typedef {import('../ports/runtime.js').Clock} Clock */
/** @typedef {import('../ports/runtime.js').Ids} Ids */
/** @typedef {import('../ports/runtime.js').Logger} Logger */
/** @typedef {import('./feed.js').CommitListener} CommitListener */
/** @typedef {import('./work.js').UseCaseContext} UseCaseContext */
/** @typedef {import('./work.js').UseCaseResult} UseCaseResult */

/**
 * @template {QueryType} T
 * @typedef {import('../contracts/queries.js').QueryOf<T>} QueryOf
 */

/**
 * @template T
 * @typedef {import('../contracts/outcomes.js').QueryState<T>} QueryState
 */

/**
 * @template {CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/**
 * @template {QueryType} T
 * @typedef {import('./work.js').QueryHandler<T>} QueryHandler
 */

/** @type {Readonly<{[T in CommandType]: CommandHandler<T>}>} */
const COMMAND_HANDLERS = Object.freeze({
  ...noteCommands,
  ...folderCommands,
  ...preferenceCommands,
  ...sessionCommands,
  ...maintenanceCommands,
});

/** @type {Readonly<{[T in QueryType]: QueryHandler<T>}>} */
const QUERY_HANDLERS = Object.freeze({ ...noteQueries, ...folderQueries, ...preferenceQueries, ...sessionQueries });

/**
 * @typedef {object} KernelOptions
 * @property {KernelAdapter} adapter
 * @property {PolicyPort} policy
 * @property {Caller} caller - this context's, from its composition root
 * @property {Ids} ids
 * @property {Clock} [clock]
 * @property {Logger} [logger]
 * @property {PromiseLike<unknown>} [ready]
 *   The adapter opening. Until it settles a query is `loading` and a command waits. If it
 *   fails, every command is `unavailable` and every query `failed`, with its cause.
 */

/**
 * A bulk command's BulkOutcome, or any other command's Outcome
 * @template C
 * @typedef {C extends {type: 'runBulkAction'} ? BulkOutcome : Outcome} OutcomeOf
 */

/**
 * The client a composition root hands out.
 * @typedef {object} KernelClient
 * @property {<C extends Command>(command: C) => Promise<OutcomeOf<C>>} execute
 * @property {<T extends QueryType>(query: QueryOf<T>) => Promise<QueryState<QueryData[T]>>} query
 * @property {(listener: CommitListener) => () => void} subscribe
 */

/** @typedef {KernelClient & {flags: Readonly<AdapterFlags>, caller: Readonly<Caller>}} Kernel */

/**
 * @param {unknown} value
 * @returns {value is PromiseLike<unknown>}
 */
function isThenable(value) {
  return (
    value !== null && typeof value === 'object' && typeof (/** @type {{then?: unknown}} */ (value).then) === 'function'
  );
}

/**
 * @param {UseCaseResult} result
 * @returns {result is Work}
 */
function isWork(result) {
  return 'effect' in result;
}

/**
 * @param {KernelOptions} options
 * @returns {Kernel}
 */
export function createKernel({ adapter, policy, caller, ids, clock = systemClock, logger = silentLogger, ready }) {
  const feed = createCommitFeed(logger);
  /** @type {'opening' | 'ready' | 'failed'} */
  let status = ready === undefined ? 'ready' : 'opening';
  /** @type {Unavailable} */
  let failure = unavailableFrom(null);
  const opened = Promise.resolve(ready).then(
    () => {
      status = 'ready';
    },
    error => {
      status = 'failed';
      failure = unavailableFrom(error);
    },
  );

  /** @type {UseCaseContext} */
  const context = {
    adapter,
    clock,
    ids,
    run: command => /** @type {Promise<Outcome>} */ (runCommand(command)),
  };

  /**
   * @param {Aggregate} aggregate
   * @param {Outcome | BulkOutcome} outcome
   */
  const publish = (aggregate, outcome) => {
    if (outcome.kind === 'committed' && outcome.changedIds.length > 0) {
      feed.publish({ aggregate, ids: outcome.changedIds });
    }
  };

  /**
   * The policy's answer. A policy that throws denies, so a broken policy fails closed.
   * @param {() => import('../ports/policy.js').Decision} ask
   * @returns {import('../ports/policy.js').Decision}
   */
  const decide = ask => {
    try {
      return ask();
    } catch {
      return { allowed: false, code: 'policy-failed' };
    }
  };

  /**
   * A use case's work committed, or the outcome it answered with itself.
   * @param {UseCaseResult} result
   * @returns {Promise<{outcome: Outcome | BulkOutcome, replayed: boolean}>}
   */
  const commitResult = result =>
    isWork(result) ? adapter.commit(result) : Promise.resolve({ outcome: result, replayed: false });

  /**
   * @param {unknown} input
   * @returns {Promise<Outcome | BulkOutcome>}
   */
  function runCommand(input) {
    /** @type {unknown} */
    let copy;
    try {
      copy = clone(input);
    } catch {
      return Promise.resolve(rejected('validation', 'not-cloneable'));
    }
    if (!isRecord(copy)) return Promise.resolve(rejected('validation', 'invalid-command'));
    if (!isCommandType(copy.type)) return Promise.resolve(rejected('policy', 'unknown-command'));
    const request = copy;
    const decision = decide(() => policy.authorize(request, caller));
    if (!decision.allowed) return Promise.resolve(rejected('policy', decision.code));
    if (!isId(copy.commandId)) return Promise.resolve(rejected('validation', 'invalid-command'));
    const command = /** @type {Command} */ (copy);

    const handler =
      /** @type {(command: Command, context: UseCaseContext) => UseCaseResult | PromiseLike<UseCaseResult>} */ (
        COMMAND_HANDLERS[command.type]
      );
    /** @type {Promise<{outcome: Outcome | BulkOutcome, replayed: boolean}>} */
    let pending;
    try {
      const remembered = adapter.recall(command);
      if (remembered) return Promise.resolve(remembered);
      const result = handler(command, context);
      pending = isThenable(result) ? Promise.resolve(result).then(commitResult) : commitResult(result);
    } catch (error) {
      pending = Promise.reject(error);
    }
    const { aggregate } = COMMANDS[command.type];
    return pending.then(
      ({ outcome, replayed }) => {
        // A send of the same command that committed first already published it
        if (!replayed) publish(aggregate, outcome);
        return outcome;
      },
      // A use case or an adapter that throws still answers with an outcome
      error => unavailableFrom(error),
    );
  }

  /**
   * @param {Command} command
   * @returns {Promise<Outcome | BulkOutcome>}
   */
  function execute(command) {
    if (status === 'ready') return runCommand(command);
    if (status === 'failed') return Promise.resolve(clone(failure));
    return opened.then(() => execute(command));
  }

  /**
   * @template {QueryType} T
   * @param {QueryOf<T>} input
   * @returns {Promise<QueryState<QueryData[T]>>}
   */
  function query(input) {
    if (status === 'opening') return Promise.resolve(loading());
    if (status === 'failed') return Promise.resolve(failed(failure.cause, failure.code));
    /** @type {unknown} */
    let copy;
    try {
      copy = clone(input);
    } catch {
      return Promise.resolve(failed('validation', 'not-cloneable'));
    }
    if (!isRecord(copy)) return Promise.resolve(failed('validation', 'invalid-query'));
    if (!isQueryType(copy.type)) return Promise.resolve(failed('policy', 'unknown-query'));
    const request = copy;
    const decision = decide(() => policy.authorize(request, caller));
    if (!decision.allowed) return Promise.resolve(failed('policy', decision.code));
    const handler = /** @type {(query: Query, context: UseCaseContext) => Promise<QueryState<QueryData[T]>>} */ (
      QUERY_HANDLERS[copy.type]
    );
    const accepted = /** @type {Query} */ (copy);
    return Promise.resolve()
      .then(() => handler(accepted, context))
      .catch(failedFrom);
  }

  return Object.freeze({
    execute: /** @type {KernelClient['execute']} */ (execute),
    query,
    subscribe: feed.subscribe,
    flags: adapter.flags,
    caller: Object.freeze({ ...caller }),
  });
}
