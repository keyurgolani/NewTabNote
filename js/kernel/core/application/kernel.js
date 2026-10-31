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
 * execute() copies a command as it's called, then runs it the same way every time: ask the
 * policy, recall the outcome an earlier send of its commandId got, run its use case, commit,
 * and publish what changed. Once the kernel is ready nothing before the commit is awaited, so
 * saveNoteContent opens its transaction in the task that calls it. Whatever a policy, a use
 * case, an adapter, a listener, or the logger does, execute() answers with an outcome.
 */

import { isId, isRecord } from '../contracts/checks.js';
import { clone } from '../contracts/clone.js';
import { COMMANDS, isCommandType } from '../contracts/commands.js';
import {
  UnavailableError,
  failed,
  failedFrom,
  isOutcome,
  loading,
  rejected,
  unavailable,
  unavailableFrom,
} from '../contracts/outcomes.js';
import { isQueryType } from '../contracts/queries.js';
import { silentLogger, systemClock } from '../ports/runtime.js';
import { createCommitFeed } from './feed.js';
import { folderCommands, folderQueries } from './folders.js';
import { jobCommands, jobQueries } from './jobs.js';
import { maintenanceCommands } from './maintenance.js';
import { bulkRefusal, noteCommands, noteQueries } from './notes.js';
import { preferenceCommands, preferenceQueries } from './preferences.js';
import { sessionCommands, sessionQueries } from './session.js';
import { snapshotCommands, snapshotQueries } from './snapshots.js';
import { workspaceDataCommands } from './workspace-data.js';

/** @typedef {import('../contracts/commands.js').Command} Command */
/** @typedef {import('../contracts/commands.js').CommandType} CommandType */
/** @typedef {import('../contracts/commands.js').Aggregate} Aggregate */
/** @typedef {import('../contracts/commands.js').RunBulkAction} RunBulkAction */
/** @typedef {import('../contracts/queries.js').Query} Query */
/** @typedef {import('../contracts/queries.js').QueryType} QueryType */
/** @typedef {import('../contracts/queries.js').QueryData} QueryData */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../contracts/outcomes.js').Unavailable} Unavailable */
/** @typedef {import('../ports/policy.js').PolicyPort} PolicyPort */
/** @typedef {import('../ports/policy.js').Caller} Caller */
/** @typedef {import('../ports/policy.js').Decision} Decision */
/** @typedef {import('../ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../ports/repository.js').AdapterFlags} AdapterFlags */
/** @typedef {import('../ports/repository.js').CommitResult} CommitResult */
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
  ...jobCommands,
  ...snapshotCommands,
  ...workspaceDataCommands,
});

/** @type {Readonly<{[T in QueryType]: QueryHandler<T>}>} */
const QUERY_HANDLERS = Object.freeze({
  ...noteQueries,
  ...folderQueries,
  ...preferenceQueries,
  ...sessionQueries,
  ...jobQueries,
  ...snapshotQueries,
});

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
 *   fails, every command is `unavailable` and every query `failed`, with its cause and code.
 *   Nothing opens it again before the page reloads, so no such answer is retryable, whatever
 *   the adapter's error said: sending a command again can't get past it.
 * @property {boolean} [maintainOnOpen]
 *   Run startup maintenance once `ready` settles, before any command or query, as
 *   Storage.init() did before the app ran anything. The new-tab and service-worker roots set
 *   it, and Popup and Side Panel never do. Until it's done queries are `loading` and commands
 *   wait. If storage fails it, they're `unavailable` and `failed` with its cause and code, and
 *   if anything else stops it, with cause storage, `maintenance-failed`. Nothing runs it again
 *   before the page reloads, so neither is retryable, as when opening fails.
 */

/**
 * What execute() answers. A bulk command that ran answers with a BulkOutcome, and one that
 * didn't (the policy refused it, its action was unknown, storage failed to open, or #13 lost
 * the reply) with a plain Outcome. Every other command answers with an Outcome.
 * @typedef {object} Execute
 * @property {{
 *   (command: RunBulkAction): Promise<BulkOutcome | Outcome>,
 *   (command: Exclude<Command, RunBulkAction>): Promise<Outcome>,
 *   (command: Command): Promise<BulkOutcome | Outcome>,
 * }} execute
 */

/**
 * The client a composition root hands out. `whenReady` resolves once storage has opened, and
 * startup maintenance has run for a root that sets maintainOnOpen: with null when the kernel
 * is ready, or with the `unavailable` outcome every command answers from then on, so a page
 * can show why it can't start.
 * @typedef {Execute & {
 *   query: <T extends QueryType>(query: QueryOf<T>) => Promise<QueryState<QueryData[T]>>,
 *   subscribe: (listener: CommitListener) => () => void,
 *   whenReady: () => Promise<Unavailable | null>,
 * }} KernelClient
 */

/** @typedef {KernelClient & {flags: Readonly<AdapterFlags>, caller: Readonly<Caller>}} Kernel */

/** @type {Decision} */
const ALLOW = Object.freeze({ allowed: true });

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
 * A commit's answer as the adapter port describes it, or a throw for anything else.
 * @param {unknown} value
 * @returns {CommitResult}
 */
function commitResultOf(value) {
  const outcome = isRecord(value) ? value.outcome : undefined;
  if (!isOutcome(outcome)) throw new TypeError('commit answered without an outcome');
  return { outcome, replayed: /** @type {Record<string, unknown>} */ (value).replayed === true };
}

/**
 * @param {KernelOptions} options
 * @returns {Kernel}
 */
export function createKernel({
  adapter,
  policy,
  caller,
  ids,
  clock = systemClock,
  logger = silentLogger,
  ready,
  maintainOnOpen = false,
}) {
  const feed = createCommitFeed(logger);
  /** @type {'opening' | 'ready' | 'failed'} */
  let status = ready === undefined && !maintainOnOpen ? 'ready' : 'opening';
  /** @type {Unavailable} */
  let failure = unavailableFrom(null);

  /**
   * Startup maintenance, run as the command the policy checks, before anything else. When
   * storage fails it, its cause and code are what every command and query answer with from
   * then on. Nothing runs it again before the page reloads, so no answer is retryable: sending
   * a command again can't get past it.
   * @returns {Promise<void>}
   */
  const maintain = async () => {
    const outcome = await dispatch({ type: 'runStartupMaintenance', commandId: ids.next() });
    if (outcome.kind === 'committed') return;
    if (outcome.kind === 'unavailable') throw new UnavailableError(outcome.cause, outcome.code, false);
    throw new UnavailableError('storage', 'maintenance-failed', false);
  };

  const opened = Promise.resolve(ready)
    .then(() => (maintainOnOpen ? maintain() : undefined))
    .then(
      () => {
        status = 'ready';
      },
      error => {
        status = 'failed';
        // Its cause and code, and never retryable, since nothing opens or maintains storage
        // again before the page reloads
        const { cause, code } = unavailableFrom(error);
        failure = unavailable(cause, code, false);
        // The outcome keeps only the cause and code, so what was thrown is reported here, once
        try {
          logger.warn('storage-unavailable', { cause, code, error });
        } catch {
          // A logger that throws changes nothing the kernel answers
        }
      },
    );

  /** @type {UseCaseContext} */
  const context = {
    adapter,
    clock,
    ids,
    // A bulk command's items are note commands, never another bulk command
    run: command => /** @type {Promise<Outcome>} */ (dispatch(clone(command))),
  };

  /**
   * Tells this context's projections what a commit changed. The feed reports a listener
   * that fails, and nothing it does reaches the outcome.
   * @param {Aggregate} aggregate
   * @param {Outcome | BulkOutcome} outcome
   */
  const publish = (aggregate, outcome) => {
    if (outcome.kind !== 'committed' || outcome.changedIds.length === 0) return;
    try {
      feed.publish({ aggregate, ids: outcome.changedIds });
    } catch {
      // The commit landed, so its outcome stands
    }
  };

  /**
   * The policy's answer, which allows only when it says `allowed: true`. A policy that throws,
   * or answers anything else, denies, so a broken policy fails closed.
   * @param {Record<string, unknown>} request
   * @returns {Decision}
   */
  const decide = request => {
    try {
      const decision = /** @type {unknown} */ (policy.authorize(request, caller));
      if (isRecord(decision) && decision.allowed === true) return ALLOW;
      const code = isRecord(decision) && decision.allowed === false && isId(decision.code) ? decision.code : null;
      return { allowed: false, code: code || 'policy-failed' };
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
    isWork(result)
      ? Promise.resolve(adapter.commit(result)).then(commitResultOf)
      : Promise.resolve({ outcome: result, replayed: false });

  /**
   * Runs a command the caller can no longer change.
   * @param {unknown} copy
   * @returns {Promise<Outcome | BulkOutcome>}
   */
  function dispatch(copy) {
    if (!isRecord(copy)) return Promise.resolve(rejected('validation', 'invalid-command'));
    if (!isCommandType(copy.type)) return Promise.resolve(rejected('policy', 'unknown-command'));
    const decision = decide(copy);
    if (!decision.allowed) return Promise.resolve(rejected('policy', decision.code));
    if (!isId(copy.commandId)) return Promise.resolve(rejected('validation', 'invalid-command'));
    const command = /** @type {Command} */ (copy);

    const handler =
      /** @type {(command: Command, context: UseCaseContext) => UseCaseResult | PromiseLike<UseCaseResult>} */ (
        COMMAND_HANDLERS[command.type]
      );
    const { aggregate, bulk } = COMMANDS[command.type];
    // recall reserves a bulk command's key, so one refused for its action or notes is refused
    // first, and leaves no record
    const refused = bulk ? bulkRefusal(/** @type {RunBulkAction} */ (command)) : undefined;
    if (refused) return Promise.resolve(refused);
    /** @type {Promise<{outcome: Outcome | BulkOutcome, replayed: boolean}>} */
    let pending;
    try {
      const remembered = adapter.recall(command);
      if (remembered !== undefined) {
        if (!isOutcome(remembered)) throw new TypeError('recall answered without an outcome');
        return Promise.resolve(remembered);
      }
      const result = handler(command, context);
      pending = isThenable(result) ? Promise.resolve(result).then(commitResult) : commitResult(result);
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(
      ({ outcome, replayed }) => {
        if (!replayed) publish(aggregate, outcome);
        return outcome;
      },
      // A use case or an adapter that throws still answers with an outcome
      error => unavailableFrom(error),
    );
  }

  /**
   * @param {() => Promise<Outcome | BulkOutcome>} run
   * @returns {Promise<Outcome | BulkOutcome>}
   */
  function whenOpen(run) {
    if (status === 'ready') return run();
    if (status === 'failed') return Promise.resolve(clone(failure));
    return opened.then(() => whenOpen(run));
  }

  /**
   * @overload
   * @param {RunBulkAction} command
   * @returns {Promise<BulkOutcome | Outcome>}
   */
  /**
   * @overload
   * @param {Exclude<Command, RunBulkAction>} command
   * @returns {Promise<Outcome>}
   */
  /**
   * @overload
   * @param {Command} command
   * @returns {Promise<BulkOutcome | Outcome>}
   */
  /**
   * @param {unknown} input
   * @returns {Promise<Outcome | BulkOutcome>}
   */
  function execute(input) {
    // The copy is taken now, so what the caller changes later can't reach the command, even
    // while it waits for storage to open
    /** @type {unknown} */
    let copy;
    try {
      copy = clone(input);
    } catch {
      return Promise.resolve(rejected('validation', 'not-cloneable'));
    }
    return whenOpen(() => dispatch(copy));
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
    const decision = decide(copy);
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
    execute,
    query,
    subscribe: feed.subscribe,
    whenReady: () => opened.then(() => (status === 'ready' ? null : { ...failure })),
    flags: adapter.flags,
    caller: Object.freeze({ ...caller }),
  });
}
