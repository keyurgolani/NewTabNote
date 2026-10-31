/**
 * The settings client (#12 slices 6 and 7, "State ownership"): the new tab's settings port,
 * over its kernel client. Its controllers read and write their preferences, the workspace
 * session, AI chat's conversations and prompt templates, custom themes, the first run's end,
 * and the backup bookkeeping through it, make the export file, and run the legacy auto-backup
 * and import. Each write is a command, and each settings write one chrome.storage.local set
 * under the keys 1.4.x used, so every other open tab still hears of it through
 * chrome.storage's onChanged, as before, and `onChanged` hears of each other tab's.
 *
 * A write answers its committed outcome. Anything else rejects with a SettingsWriteError,
 * which carries the outcome and a message of its kind and code only, never what was being
 * saved, as Storage.setSetting rejected when chrome.storage failed. So a caller that let a
 * failed setSetting reach the page's unhandled-rejection toast still does.
 *
 * A read rejects when it fails, as Storage.readSetting did. preferencesOr and workspaceDataOr
 * answer as Storage.getSetting did instead: each key's default where nothing is stored, and
 * every default when the read fails.
 */

/** @typedef {import('./host.js').Client} Client */
/** @typedef {import('../core/contracts/outcomes.js').Outcome} Outcome */
/** @typedef {import('../core/contracts/outcomes.js').Committed} Committed */
/** @typedef {import('../core/contracts/settings.js').PreferenceValues} PreferenceValues */
/** @typedef {import('../core/contracts/settings.js').WorkspaceDataValues} WorkspaceDataValues */
/** @typedef {import('../core/contracts/entities.js').ThemeEntity} ThemeEntity */
/** @typedef {import('../core/domain/session.js').WorkspaceSession} WorkspaceSession */

/**
 * #13's settings.changed notice, as js/storage.js's onSettingsChange gives it: which settings
 * changed, by key name only, never a value
 * @typedef {Readonly<{type: 'settings.changed', keys: readonly string[]}>} SettingsChanged
 */

/**
 * Where the page hears of a settings change another tab, or this one, made: js/storage.js's
 * onSettingsChange, which answers the function that stops it
 * @typedef {(listener: (notice: SettingsChanged) => void) => () => void} SettingsChanges
 */

/**
 * @template {import('../core/contracts/commands.js').CommandType} T
 * @typedef {Omit<import('../core/contracts/commands.js').CommandOf<T>, 'type' | 'commandId'>} Fields
 */

/**
 * A settings write that didn't commit. Its message names the command, kind, and code only. It
 * is named SettingsWriteError, or for the storage exception the outcome names, when it names one.
 */
export class SettingsWriteError extends Error {
  /**
   * @param {string} type - the command's
   * @param {Outcome} outcome
   */
  constructor(type, outcome) {
    super(`NewTabNote didn't save ${type} (${outcome.kind}: ${outcome.code})`);
    this.name = 'SettingsWriteError';
    /** @type {Outcome} */
    this.outcome = outcome;
    // The outcome's code, cause, and whether a retry can work, which #20's failure events read
    // as evidence; codes only, never what was being saved
    /** @type {string} */
    this.code = outcome.code;
    if (outcome.kind === 'unavailable') {
      /** @type {string | undefined} */
      this.unavailableCause = outcome.cause;
      /** @type {boolean | undefined} */
      this.retryable = outcome.retryable;
      // Named for the storage exception the write failed with, when the outcome names one
      // (`exception`), so the failure events keep it as the error's name
      if (outcome.exception) this.name = outcome.exception;
    }
  }
}

/**
 * What a committed import did, from its outcome and the backup it read
 * @typedef {object} ImportSummary
 * @property {'merge' | 'replace'} mode
 * @property {number} notes
 * @property {number} blocks
 * @property {number} folders - the folders it added; a package folder whose id is already here isn't
 * @property {number} media
 * @property {number} skippedMedia - media rows whose note isn't in the backup
 * @property {string[]} importedIds - the notes it added, in backup order
 * @property {string[]} trashedIds - the notes Replace all moved to trash
 */

/**
 * @typedef {object} SettingsClient
 * @property {(keys?: Array<keyof PreferenceValues>) => Promise<PreferenceValues>} preferences
 *   The stored preferences of `keys`, all of them unless given; one with nothing stored is
 *   left out, for its caller's default. Rejects when the read fails.
 * @property {<D extends PreferenceValues>(defaults: D) => Promise<D>} preferencesOr
 *   Each preference `defaults` names, as stored, or its default where nothing is, and every
 *   default when the read fails, as Storage.getSetting answered
 * @property {(keys?: Array<keyof WorkspaceDataValues>) => Promise<WorkspaceDataValues>} workspaceData
 *   What the new tab keeps beside its preferences, of `keys`, all of it unless given; a key with
 *   nothing stored is left out. Rejects when the read fails.
 * @property {<D extends WorkspaceDataValues>(defaults: D) => Promise<D>} workspaceDataOr
 *   Each key `defaults` names, as stored, or its default where nothing is, and every default
 *   when the read fails, as Storage.getSetting answered
 * @property {() => Promise<ThemeEntity[]>} themes - the custom themes, the last saved first
 * @property {(file: {backup: boolean}) => Promise<Blob>} exportBackup
 *   The Export JSON file, or with `backup` the Create Backup one. Rejects when it can't be made.
 * @property {() => Promise<boolean>} holdsContent
 *   Whether a note outside trash has a title or a block that holds something
 * @property {SettingsChanges} onChanged
 *   Runs `listener` with the keys of each settings change, and answers the function that stops it
 * @property {(values: PreferenceValues) => Promise<Committed>} setPreferences
 * @property {() => Promise<Partial<WorkspaceSession>>} session
 *   The stored workspace session; a key with nothing stored is left out. Rejects when the read
 *   fails, so a caller can tell nothing stored from a read it couldn't make.
 * @property {(session: Partial<WorkspaceSession>) => Promise<Committed>} saveSession
 * @property {(chat: 'note' | 'global', history: unknown[], messages: unknown[]) => Promise<Committed>} saveChatHistory
 * @property {(templates: unknown[]) => Promise<Committed>} savePromptTemplates
 * @property {(theme: {name: string, properties: Record<string, string>}) => Promise<string>} saveTheme
 *   Saves a new custom theme, under an id taken now, and answers the id
 * @property {() => Promise<Committed>} completeOnboarding
 * @property {(what: {fullExport: boolean, backup: boolean}) => Promise<Committed>} recordBackup
 * @property {(version: number, outcome: 'exported' | 'dismissed' | 'not-needed') => Promise<Committed>} recordExportNotice
 * @property {() => Promise<Committed>} snoozeSpaceNotice - puts the space notice off, from the kernel clock's now
 * @property {() => Promise<Committed>} createAutoBackup
 * @property {(backup: Record<string, unknown>, mode: 'merge' | 'replace', counts: {notes: number, blocks: number,
 *   media: number, skippedMedia: number}) => Promise<ImportSummary>} importBackup
 *   Imports a backup Storage.validateImport passed, whose `counts` it gave. It commits all of
 *   it or nothing, so the counts are what committed, folders as the import added them.
 */

/**
 * Each key `defaults` names, as `read` answers it, or its default where nothing is stored, and
 * every default when the read fails, as Storage.getSetting answered, warning as it did
 * @template {Record<string, unknown>} D
 * @param {(keys: string[]) => Promise<Record<string, unknown>>} read
 * @param {D} defaults
 * @returns {Promise<D>}
 */
async function storedOr(read, defaults) {
  try {
    const stored = await read(Object.keys(defaults));
    return /** @type {D} */ ({ ...defaults, ...stored });
  } catch (error) {
    console.warn('Error getting setting:', error);
    return { ...defaults };
  }
}

/** A page that hears of no settings change */
const noChanges = () => () => {};

/**
 * @param {Client} client - the page's kernel client
 * @param {{onSettingsChange?: SettingsChanges}} [changes] - where the page hears of settings
 *   changes, js/storage.js's onSettingsChange in the new tab
 * @returns {SettingsClient}
 */
export function createSettingsClient(client, { onSettingsChange = noChanges } = {}) {
  /**
   * Runs a command, and answers its committed outcome
   * @template {import('../core/contracts/commands.js').CommandType} T
   * @param {T} type
   * @param {Fields<T>} fields
   * @returns {Promise<Committed>}
   */
  const write = async (type, fields) => {
    const outcome = await client.execute(
      /** @type {import('../core/contracts/commands.js').CommandOf<T>} */ ({
        ...fields,
        type,
        commandId: client.ids.next(),
      }),
    );
    if (outcome.kind !== 'committed') throw new SettingsWriteError(type, /** @type {Outcome} */ (outcome));
    return outcome;
  };

  /**
   * A query's data, `none` when nothing is stored. Rejects when it fails.
   * @template {'getPreferences' | 'getWorkspaceSession' | 'getWorkspaceData' | 'listThemes' | 'exportBackup'
   *   | 'profileHoldsContent'} T
   * @template N
   * @param {import('../core/contracts/queries.js').QueryOf<T>} query
   * @param {N} none
   * @returns {Promise<import('../core/contracts/queries.js').QueryData[T] | N>}
   */
  const read = async (query, none) => {
    await client.whenReady();
    const state = await client.query(query);
    if (state.kind === 'ready' || state.kind === 'stale') return state.data;
    if (state.kind === 'empty') return none;
    const why = state.kind === 'failed' ? `${state.cause}: ${state.code}` : 'not ready';
    throw new Error(`NewTabNote couldn't read ${/** @type {{type: string}} */ (query).type} (${why})`);
  };

  /** @param {Array<keyof PreferenceValues>} [keys] */
  const preferences = keys => read({ type: 'getPreferences', ...(keys ? { keys } : {}) }, {});

  /** @param {Array<keyof WorkspaceDataValues>} [keys] */
  const workspaceData = keys => read({ type: 'getWorkspaceData', ...(keys ? { keys } : {}) }, {});

  return Object.freeze({
    preferences,

    preferencesOr: defaults =>
      storedOr(keys => preferences(/** @type {Array<keyof PreferenceValues>} */ (keys)), defaults),

    workspaceData,

    workspaceDataOr: defaults =>
      storedOr(keys => workspaceData(/** @type {Array<keyof WorkspaceDataValues>} */ (keys)), defaults),

    themes: () => read({ type: 'listThemes' }, []),

    async exportBackup({ backup }) {
      const file = await read({ type: 'exportBackup', backup }, null);
      if (!file) throw new Error("NewTabNote couldn't make the export file");
      return file;
    },

    holdsContent: () => read({ type: 'profileHoldsContent' }, false),

    onChanged: listener => onSettingsChange(listener),

    setPreferences: values => write('setPreferences', { values }),

    session: () => read({ type: 'getWorkspaceSession' }, {}),

    saveSession: session => write('saveWorkspaceSession', { session }),

    saveChatHistory: (chat, history, messages) => write('saveChatHistory', { chat, history, messages }),

    savePromptTemplates: templates => write('savePromptTemplates', { templates }),

    async saveTheme({ name, properties }) {
      const themeId = client.ids.next();
      await write('saveTheme', { themeId, name, properties });
      return themeId;
    },

    completeOnboarding: () => write('completeOnboarding', {}),

    recordBackup: ({ fullExport, backup }) => write('recordBackup', { fullExport, backup }),

    recordExportNotice: (version, outcome) => write('recordExportNotice', { version, outcome }),

    snoozeSpaceNotice: () => write('snoozeSpaceNotice', {}),

    createAutoBackup: () => write('createAutoBackup', {}),

    async importBackup(backup, mode, counts) {
      const { changedIds } = await write('importBackup', { backup, mode });
      // The notes it added come first, in backup order, then the folders it added, then the
      // notes it trashed
      const importedIds = changedIds.slice(0, counts.notes);
      const packageFolders = new Set(
        (Array.isArray(backup.folders) ? backup.folders : []).map(folder => folder && folder.id),
      );
      const rest = changedIds.slice(counts.notes);
      const folders = rest.filter(id => packageFolders.has(id)).length;
      return {
        mode,
        notes: importedIds.length,
        blocks: counts.blocks,
        folders,
        media: counts.media,
        skippedMedia: counts.skippedMedia,
        importedIds,
        trashedIds: rest.slice(folders),
      };
    },
  });
}
