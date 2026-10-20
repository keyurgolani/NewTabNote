/**
 * What every use case module shares: the context a use case runs with, the shape of a use
 * case, and how its units become the adapter's work.
 */

/** @typedef {import('../contracts/commands.js').Command} Command */
/** @typedef {import('../contracts/commands.js').CommandType} CommandType */
/** @typedef {import('../contracts/queries.js').QueryType} QueryType */
/** @typedef {import('../contracts/queries.js').QueryData} QueryData */
/** @typedef {import('../contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../contracts/outcomes.js').BulkOutcome} BulkOutcome */
/** @typedef {import('../contracts/outcomes.js').Committed} Committed */
/** @typedef {import('../ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../ports/repository.js').Unit} Unit */
/** @typedef {import('../ports/repository.js').Work} Work */
/** @typedef {import('../ports/repository.js').StoreName} StoreName */
/** @typedef {import('../ports/runtime.js').Clock} Clock */
/** @typedef {import('../ports/runtime.js').Ids} Ids */

/**
 * @template {CommandType} T
 * @typedef {import('../contracts/commands.js').CommandOf<T>} CommandOf
 */

/**
 * @template {QueryType} T
 * @typedef {import('../contracts/queries.js').QueryOf<T>} QueryOf
 */

/**
 * @template T
 * @typedef {import('../contracts/outcomes.js').QueryState<T>} QueryState
 */

/**
 * @typedef {object} UseCaseContext
 * @property {KernelAdapter} adapter
 * @property {Clock} clock
 * @property {Ids} ids
 * @property {(command: Command) => Promise<Outcome>} run
 *   Runs another command the way execute() does, policy check included (bulk commands use it)
 */

/** @typedef {Work | Outcome | BulkOutcome} UseCaseResult */

/**
 * A command's use case. It checks the command's shape, then returns the work for the
 * adapter, or an outcome when there's nothing to commit. A use case that has to read
 * outside the stores first, such as a setting, returns a promise. Any other use case
 * returns synchronously, so the adapter opens its transaction in the calling task.
 * @template {CommandType} T
 * @typedef {(command: CommandOf<T>, context: UseCaseContext) => UseCaseResult | Promise<UseCaseResult>} CommandHandler
 */

/**
 * @template {QueryType} T
 * @typedef {(query: QueryOf<T>, context: UseCaseContext) => Promise<QueryState<QueryData[T]>>} QueryHandler
 */

/**
 * The adapter's work for a command made of units.
 * @param {Command} command
 * @param {Unit[]} units
 * @param {() => Committed} done
 * @param {() => {store: StoreName, key: string} | undefined} [primary]
 * @returns {Work}
 */
export function unitsWork(command, units, done, primary) {
  /** @type {Work} */
  const work = { commandId: command.commandId, command, effect: { kind: 'units', units }, done };
  if (primary) work.primary = primary;
  return work;
}
