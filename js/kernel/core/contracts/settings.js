/**
 * Schemas for the settings the kernel writes: the preferences (domain/preferences.js), each
 * with the type the legacy settings code writes, and the workspace session
 * (domain/session.js). #25 (settings routes) owns the preference schemas from here on. Only
 * the keys listed here are accepted, so no command names a setting it doesn't own.
 */

import * as v from '../../../lib/valibot/index.mjs';
import { content, count, entityId } from './fields.js';

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
