/**
 * The workspace session use case and query. TabController owns the session while its page
 * is open, and this persists the keys it hands over.
 */

import { isRecord } from '../contracts/checks.js';
import { committed, empty, ready, rejected } from '../contracts/outcomes.js';
import { WORKSPACE_SESSION_KEYS, sessionIssue } from '../domain/session.js';

/**
 * @template {import('../contracts/commands.js').CommandType} T
 * @typedef {import('./work.js').CommandHandler<T>} CommandHandler
 */

/**
 * @template {import('../contracts/queries.js').QueryType} T
 * @typedef {import('./work.js').QueryHandler<T>} QueryHandler
 */

/** @type {{saveWorkspaceSession: CommandHandler<'saveWorkspaceSession'>}} */
export const sessionCommands = {
  saveWorkspaceSession(command) {
    const { session } = command;
    if (!isRecord(session) || Object.keys(session).length === 0) return rejected('validation', 'invalid-command');
    if (sessionIssue(session) !== null) return rejected('validation', 'invalid-session');
    const keys = Object.keys(session);
    return {
      commandId: command.commandId,
      command,
      effect: { kind: 'settings', area: 'session', values: session },
      done: () => committed('session-saved', keys),
    };
  },
};

/** @type {{getWorkspaceSession: QueryHandler<'getWorkspaceSession'>}} */
export const sessionQueries = {
  async getWorkspaceSession(query, { adapter, clock }) {
    const session = await adapter.readSettings('session', WORKSPACE_SESSION_KEYS);
    return Object.keys(session).length > 0 ? ready(clock.now(), session) : empty(clock.now());
  },
};
