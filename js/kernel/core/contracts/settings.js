/**
 * Schemas for the settings the kernel writes: the preferences (domain/preferences.js), each
 * with the type the legacy settings code writes, the workspace session (domain/session.js),
 * and the workspace data getWorkspaceData reads back (domain/workspace-data.js). #25
 * (settings routes) owns the preference schemas from here on. Only
 * the keys listed here are accepted, so no command names a setting it doesn't own.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { content, count, entityId, timestamp } from './fields.js';

const text = v.pipe(v.string(), v.maxLength(256));

export const preferenceValues = v.strictObject({
  theme: v.optional(text),
  font: v.optional(text),
  width: v.optional(text),
  trashRetention: v.optional(count),
  dailyNoteTemplate: v.optional(v.nullable(v.union([v.literal(''), entityId('note')]))),
  autoBackupEnabled: v.optional(v.boolean()),
  autoBackupFrequency: v.optional(count),
  sidebarOpen: v.optional(v.boolean()),
  sidebarWidth: v.optional(v.number()),
  sidebarViewMode: v.optional(text),
  sidebarSortMode: v.optional(text),
  aiSidebarWidth: v.optional(v.number()),
  autoTitleEnabled: v.optional(v.boolean()),
  autoTitleInterval: v.optional(count),
  insightsEnabled: v.optional(v.boolean()),
  insightsInterval: v.optional(count),
  embeddingsEnabled: v.optional(v.boolean()),
});

/** A tab TabController saves: the note it shows, with whatever else it keeps, a title included */
const openTab = content(v.looseObject({ noteId: entityId('note') }));

export const workspaceSession = v.strictObject({
  openTabs: v.optional(v.nullable(v.array(openTab))),
  activeTabIndex: v.optional(v.pipe(v.number(), v.safeInteger())),
  splitViewEnabled: v.optional(v.boolean()),
  secondaryNoteId: v.optional(v.nullable(entityId('note'))),
  lastOpenedNoteId: v.optional(v.nullable(entityId('note'))),
});

/**
 * What the new tab keeps beside its preferences (domain/workspace-data.js), as slice 6's
 * commands write it: AI chat's two conversations and its prompt templates, as the chat saved
 * them, whether the first run finished, the last full export and backup, and the export
 * notice's outcome; and since #17 PR 1b the worker's record of its last migration run, a
 * status, a failure code, and when, and when the space notice was last put off
 */
export const workspaceDataValues = v.strictObject({
  aiChatHistory: v.optional(content(v.array(v.unknown()))),
  noteChatMessages: v.optional(content(v.array(v.unknown()))),
  globalChatHistory: v.optional(content(v.array(v.unknown()))),
  globalChatMessages: v.optional(content(v.array(v.unknown()))),
  aiPromptTemplates: v.optional(content(v.array(v.unknown()))),
  hasCompletedOnboarding: v.optional(v.boolean()),
  lastFullExportAt: v.optional(timestamp),
  lastBackupAt: v.optional(timestamp),
  preMigrationNotice: v.optional(
    v.looseObject({
      version: v.optional(v.number()),
      outcome: v.optional(v.string()),
      at: v.optional(v.number()),
    }),
  ),
  storageUpgrade: v.optional(
    v.looseObject({
      status: v.optional(v.string()),
      code: v.optional(v.nullable(v.string())),
      at: v.optional(v.number()),
    }),
  ),
  spaceNoticeSnoozedAt: v.optional(timestamp),
});

/**
 * The preferences a getPreferences answer holds and a setPreferences command sets
 * @typedef {v.InferOutput<typeof preferenceValues>} PreferenceValues
 */
/**
 * What a getWorkspaceData answer holds
 * @typedef {v.InferOutput<typeof workspaceDataValues>} WorkspaceDataValues
 */
