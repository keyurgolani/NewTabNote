/**
 * Job bookkeeping use cases and queries (#12 slice 4): when the auto-title and insights jobs
 * last ran, and which notes have insights being extracted. They live in the `jobs` settings
 * area, under the keys 1.4.x's Storage.setSetting wrote, each in one chrome.storage.local
 * set, as before. The kernel's clock stamps them.
 *
 * #35 moves the jobs to the background coordinator and #8 rebuilds them as recipes; until
 * then each open new tab runs both, as 1.4.x did.
 */

import { isId } from '../contracts/checks.js';
import { committed, failed, ready, rejected } from '../contracts/outcomes.js';

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/**
 * @template {import('../contracts/queries.js').QueryType} T
 * @typedef {import('./work.js').QueryHandler<T>} QueryHandler
 */

/** @typedef {'autoTitle' | 'insights'} Job */

/**
 * The setting each job's last run is kept under
 * @type {Readonly<Record<Job, 'lastAutoTitleRun' | 'lastInsightsRun'>>}
 */
export const JOB_RUN_KEYS = Object.freeze({ autoTitle: 'lastAutoTitleRun', insights: 'lastInsightsRun' });

/**
 * The setting that says a note's insights are being extracted, and since when, as
 * NotesManager.extractInsightsForNote has kept it
 * @param {string} noteId
 * @returns {string}
 */
export const insightsPendingKey = noteId => `insightsExtracting_${noteId}`;

/**
 * @param {unknown} value
 * @returns {number | null} a stored time, or null for none (0 and null included, as 1.4.x read them)
 */
const timeOrNull = value => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null);

/** @type {{setInsightsPending: CommandHandler<'setInsightsPending'>, recordJobRun: CommandHandler<'recordJobRun'>}} */
export const jobCommands = {
  setInsightsPending(command, { clock }) {
    const { noteId, pending } = command;
    if (!isId(noteId) || typeof pending !== 'boolean') return rejected('validation', 'invalid-command');
    // Cleared with null, as 1.4.x cleared it, so the key stays where it always was
    const values = { [insightsPendingKey(noteId)]: pending ? clock.now() : null };
    return {
      commandId: command.commandId,
      command,
      effect: { kind: 'settings', area: 'jobs', values },
      done: () => committed(pending ? 'insights-pending' : 'insights-pending-cleared', [noteId]),
    };
  },

  recordJobRun(command, { clock }) {
    const { job } = command;
    if (job !== 'autoTitle' && job !== 'insights') return rejected('validation', 'invalid-command');
    return {
      commandId: command.commandId,
      command,
      effect: { kind: 'settings', area: 'jobs', values: { [JOB_RUN_KEYS[job]]: clock.now() } },
      done: () => committed('job-run-recorded', [job]),
    };
  },
};

/** @type {{getInsightsPending: QueryHandler<'getInsightsPending'>, getJobRuns: QueryHandler<'getJobRuns'>}} */
export const jobQueries = {
  async getInsightsPending({ noteId }, { adapter, clock }) {
    if (!isId(noteId)) return failed('validation', 'invalid-query');
    const key = insightsPendingKey(noteId);
    const stored = await adapter.readSettings('jobs', [key]);
    return ready(clock.now(), { since: timeOrNull(stored[key]) });
  },

  // A job that never ran reads 0, as Storage.getSetting's default and first run gave it
  async getJobRuns(query, { adapter, clock }) {
    const { lastAutoTitleRun, lastInsightsRun } = await adapter.readSettings('jobs', Object.values(JOB_RUN_KEYS));
    return ready(clock.now(), {
      lastAutoTitleRun: timeOrNull(lastAutoTitleRun) ?? 0,
      lastInsightsRun: timeOrNull(lastInsightsRun) ?? 0,
    });
  },
};
