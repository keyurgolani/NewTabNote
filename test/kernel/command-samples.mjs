// A payload for every catalog command (#13, AC1), which the catalog test and #17's AC1 test
// (write-guards.test.mjs) both run, so one sample set holds each schema and each use case.

import { NOW } from './support.mjs';

/** @typedef {import('../../js/kernel/core/contracts/commands.js').CommandType} CommandType */

/**
 * @template {CommandType} T
 * @typedef {import('../../js/kernel/core/contracts/commands.js').CommandOf<T>} CommandOf
 */

/**
 * A payload for every command, in an order the kernel commits them in, typed as the command
 * it is, so each schema's type and its runtime check are held to the same samples
 * @type {{[T in CommandType]: Omit<CommandOf<T>, 'type' | 'commandId'>}}
 */
export const COMMAND_SAMPLES = {
  runStartupMaintenance: {},
  runIntegrityCheck: {},
  createFolder: { folderId: 'f0', name: 'Work', parentId: null },
  createNote: {
    noteId: 'n1',
    name: 'Plan',
    folderId: 'f0',
    blocks: [{ id: 'b1', type: 'text', content: 'Line' }],
    pinned: false,
    titleManuallySet: false,
  },
  renameNote: { noteId: 'n1', name: 'Plan 2', origin: 'typed' },
  setPinned: { noteId: 'n1', pinned: true },
  saveNoteContent: {
    noteId: 'n1',
    blocks: [{ id: 'b1', type: 'text', content: 'Line', order: 0 }],
    preview: 'Line',
    todoProgress: { completed: 0, total: 1 },
    name: 'Plan 3',
    titleOrigin: 'typed',
    linkedNames: ['Plan 3', 'Elsewhere'],
    expectedRevision: 1,
  },
  deleteBlocks: { noteId: 'n1', blockIds: ['b1', 'never-saved'] },
  applyDerivedTitle: { noteId: 'n1', name: 'Derived', contentHash: 'h1' },
  attachInsights: { noteId: 'n1', insights: { todos: ['Call'] }, contentHash: 'h1' },
  updateSearchIndex: {
    entries: [{ noteId: 'n1', name: 'Plan', content: 'Line', tags: ['plan'], updatedAt: NOW, sourceRevision: 1 }],
    removed: ['gone'],
    replaceAll: false,
  },
  saveVector: { noteId: 'n1', vector: [0.25, 0.5], sourceRevision: 1 },
  applyRemoteChanges: {
    changes: [
      {
        note: { id: 'r1', name: 'From afar', createdAt: NOW, updatedAt: NOW, pinned: true, folderId: null },
        blocks: [{ id: 'rb1', type: 'text', content: 'Line', order: 0 }],
      },
      {
        note: { id: 'n1', name: 'Plan 4', pinned: false },
        blocks: [],
        expectedRevision: 9,
        expectedPlacementVersion: 9,
      },
    ],
  },
  applyRemoteContent: { noteId: 'r2', note: { id: 'r2', name: 'Remote' }, blocks: [], expectedRevision: 0 },
  applyRemotePlacement: { noteId: 'r2', placement: { pinned: true, folderId: null }, expectedPlacementVersion: 0 },
  saveSnapshot: {
    noteId: 'n1',
    snapshotId: 's1',
    blocks: [{ id: 'b1', type: 'text', content: 'Line' }],
    title: 'Plan',
  },
  restoreSnapshot: {
    noteId: 'n1',
    snapshotId: 's1',
    preSnapshotId: 's2',
    blocks: [{ id: 'b1', type: 'text', content: 'Line' }],
    name: 'Plan',
  },
  insertBlocks: { noteId: 'n1', blocks: [{ id: 'b2', type: 'text', content: 'From the chat' }], atOrder: 1 },
  // A closing tab's edit of b2, in 1.4.3's format, on n1 as the samples before it leave it
  applyCloseDraft: {
    draft: {
      v: 1,
      id: 'draft-1',
      noteId: 'n1',
      at: NOW,
      base: { revision: null, updatedAt: NOW, issued: [] },
      blocks: [{ id: 'b2', type: 'text', content: 'From the chat, edited as the tab closed', order: 1 }],
      deletedBlockIds: [],
      preview: 'Line',
      todoProgress: null,
      linkedNames: [],
    },
  },
  captureToDailyNote: {
    noteId: 'd1',
    blockId: 'b9',
    capture: { type: 'text', content: 'Quote', source: 'https://example.test/' },
  },
  ensureDailyNote: { noteId: 'd2', dateStr: '2026-10-19' },
  archiveNote: { noteId: 'n1' },
  unarchiveNote: { noteId: 'n1' },
  runBulkAction: { action: 'trash', noteIds: ['n1', 'gone'] },
  restoreNote: { noteId: 'n1' },
  trashNote: { noteId: 'd1' },
  moveFolder: { folderId: 'f0', parentId: null },
  renameFolder: { folderId: 'f0', name: 'Work' },
  setFolderCollapsed: { folderId: 'f0', collapsed: true },
  deleteFolder: { folderId: 'f0' },
  moveNoteToFolder: { noteId: 'n1', folderId: 'f0' },
  convertNoteToTemplate: { noteId: 'n1' },
  convertTemplateToNote: { noteId: 'n1' },
  deleteNotePermanently: { noteId: 'n1' },
  emptyTrash: {},
  runTrashCleanup: {},
  setPreferences: { values: { theme: 'dark', sidebarWidth: 300, dailyNoteTemplate: '' } },
  saveWorkspaceSession: { session: { openTabs: [{ noteId: 'n1', title: 'Plan' }], activeTabIndex: 0 } },
  setInsightsPending: { noteId: 'n1', pending: true },
  recordJobRun: { job: 'insights' },
  saveChatHistory: {
    chat: 'note',
    history: [{ role: 'user', content: 'Hi' }],
    messages: [{ type: 'user', content: 'Hi' }],
  },
  savePromptTemplates: { templates: [{ id: 't1', label: 'Sum', prompt: 'Summarize' }] },
  saveTheme: { themeId: 'th1', name: 'Dusk', properties: { '--bg-primary': '#101010' } },
  completeOnboarding: {},
  recordBackup: { fullExport: true, backup: true },
  recordExportNotice: { version: 1, outcome: 'exported' },
  snoozeSpaceNotice: {},
  createAutoBackup: {},
  importBackup: {
    mode: 'merge',
    backup: { version: 1, exportedAt: 1, canvases: [{ id: 'p1', name: 'Plan' }], elements: [] },
  },
};
