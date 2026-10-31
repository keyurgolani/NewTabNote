# Write paths

Every mutating persistence call in `js/` outside `js/storage.js` (and outside `js/lib/` and `js/kernel/`), the intent-level kernel command it becomes, and when. #12's acceptance criteria need each row to go through a kernel command or stay ledgered to #11, #19, or #22. #12 slice 2 mapped them.

Network writes (sync uploads, AI provider requests) aren't listed. They go through `fetch`, which the kernel boundary rules ledger to #19 and #11.

Written by `npm run check:write-paths -- --write` from `scripts/write-paths.js`, which says what counts as a mutating call and holds the rules below. `npm test` fails when a call is added, removed, moved to another function, or reclassified until this file is rewritten. Line numbers are where the calls were when it was last written.

## Statuses

| Status | Rows | Meaning |
| --- | --- | --- |
| kernel command, slice 4 | 21 | #12 slice 4 (notes and blocks) routes it through the command. |
| kernel command, slice 5 | 17 | #12 slice 5 (folders, templates, trash) routes it through the command. |
| kernel command, slice 6 | 37 | #12 slice 6 (preferences and session) routes it through the command. |
| deleted in slice 7 | 43 | App's copy of a controller path. It runs only after an `if (this.<controller>)` check has handed off to that controller and returned, or in that check's else branch, or nothing reaches it from App's bootstrap and the methods `js/editor.js` calls. Slice 7 deletes it with App's fallback bodies. The command is the one the controller path becomes. |
| no live caller | 5 | Nothing in `js/` refers to the method or function the write sits in, so the write never runs. Deleting it drops the row. The command is what the call would become. |
| ledgered to #11 | 4 | Provider settings and keys, which #11's provider registry takes over (#21 reviews the key rows). |
| ledgered to #19 | 9 | The sync service, which #19's sync engine replaces. |
| ledgered to #22 | 4 | The search index and vectors, which #22's pipelines own. |
| UI-only | 0 | Persists nothing a kernel aggregate or the settings port owns. |
| Total | 140 | |

No row is UI-only. Presentation state (panels, the palette index, selection mode, the calendar month) isn't persisted, and every persisted preference goes through the settings port.

## Commands

| Command | Status | Rows |
| --- | --- | --- |
| `runStartupMaintenance` | kernel command, slice 4 | 0 |
| `createNote` | kernel command, slice 4 | 11 |
| `importNote` | kernel command, slice 4 | 8 |
| `ensureDailyNote` | kernel command, slice 4 | 7 |
| `captureToDailyNote` | kernel command, slice 4 | 0 |
| `saveNoteContent` | kernel command, slice 4 | 0 |
| `insertBlocks` | kernel command, slice 4 | 5 |
| `deleteBlocks` | kernel command, slice 4 | 0 |
| `saveSnapshot` | kernel command, slice 4 | 0 |
| `restoreSnapshot` | kernel command, slice 4 | 0 |
| `renameNote` | kernel command, slice 4 | 1 |
| `setPinned` | kernel command, slice 4 | 2 |
| `archiveNote` | kernel command, slice 4 | 2 |
| `unarchiveNote` | kernel command, slice 4 | 2 |
| `applyDerivedTitle` | kernel command, slice 4 | 2 |
| `attachInsights` | kernel command, slice 4 | 2 |
| `setInsightsPending` | kernel command, slice 4 | 2 |
| `recordJobRun` | kernel command, slice 4 | 2 |
| `createFolder` | kernel command, slice 5 | 1 |
| `renameFolder` | kernel command, slice 5 | 2 |
| `moveFolder` | kernel command, slice 5 | 4 |
| `setFolderCollapsed` | kernel command, slice 5 | 2 |
| `deleteFolder` | kernel command, slice 5 | 2 |
| `moveNoteToFolder` | kernel command, slice 5 | 4 |
| `convertNoteToTemplate` | kernel command, slice 5 | 2 |
| `convertTemplateToNote` | kernel command, slice 5 | 2 |
| `trashNote` | kernel command, slice 5 | 3 |
| `restoreNote` | kernel command, slice 5 | 2 |
| `deleteNotePermanently` | kernel command, slice 5 | 2 |
| `emptyTrash` | kernel command, slice 5 | 2 |
| `runTrashCleanup` | kernel command, slice 5 | 2 |
| `runBulkAction` | kernel command, slice 5 | 1 |
| `setPreferences` | kernel command, slice 6 | 23 |
| `saveWorkspaceSession` | kernel command, slice 6 | 5 |
| `saveChatHistory` | kernel command, slice 6 | 4 |
| `saveAIPromptTemplates` | kernel command, slice 6 | 3 |
| `saveTheme` | kernel command, slice 6 | 1 |
| `completeOnboarding` | kernel command, slice 6 | 1 |
| `recordBackup` | kernel command, slice 6 | 3 |
| `recordExportNotice` | kernel command, slice 6 | 1 |
| `createAutoBackup` | kernel command, slice 6 | 1 |
| `importBackup` | kernel command, slice 6 | 1 |
| `saveProviderSettings` | ledgered to #11 | 5 |
| `saveSyncSettings` | ledgered to #19 | 6 |
| `applyRemoteChanges` | ledgered to #19 | 3 |
| `updateSearchIndex` | ledgered to #22 | 4 |
| `saveVector` | ledgered to #22 | 2 |

Rows marked "deleted in slice 7" or "no live caller" are counted under the command the call would become.

## Calls

Method is the class method or function the call sits in. After `>` comes the anonymous or nested function inside it, when where it sits says what it's for: a listener, a callback property such as `onResizeEnd`, or a menu item's `action`. An update's Call lists the fields it sets.

| File | Line | Method | Call | Command | Status |
| --- | --- | --- | --- | --- | --- |
| `js/app.js` | [526](../../js/app.js#L526) | `App.createFirstNote` | `Storage.createNote(…)` | `createNote` | kernel command, slice 4 |
| `js/app.js` | [540](../../js/app.js#L540) | `App.runOnboarding` | `Storage.createNote(…)` | `createNote` | kernel command, slice 4 |
| `js/app.js` | [544](../../js/app.js#L544) | `App.runOnboarding` | `Storage.saveElement(…)` | `createNote` | kernel command, slice 4 |
| `js/app.js` | [669](../../js/app.js#L669) | `App.initTabController > onCreateNote` | `Storage.createNote(…)` | `createNote` | kernel command, slice 4 |
| `js/app.js` | [1014](../../js/app.js#L1014) | `App.initShortcutsManager > onEnsureDailyNote` | `Storage.ensureDailyNote()` | `ensureDailyNote` | kernel command, slice 4 |
| `js/app.js` | [1139](../../js/app.js#L1139) | `App.createCalendarDay > click listener` | `Storage.ensureDailyNoteForDate(…)` | `ensureDailyNote` | deleted in slice 7 |
| `js/app.js` | [1651](../../js/app.js#L1651) | `App.generateTitleForNote` | `Storage.updateNote({lastAutoTitleAt, name})` | `renameNote` | deleted in slice 7 |
| `js/app.js` | [1701](../../js/app.js#L1701) | `App.extractInsightsForNote` | `Storage.setSetting('insightsExtracting_${…}', …)` | `setInsightsPending` | deleted in slice 7 |
| `js/app.js` | [1747](../../js/app.js#L1747) | `App.extractInsightsForNote` | `Storage.updateNote({insights, lastInsightsContentHash, lastInsightsExtractedAt})` | `attachInsights` | deleted in slice 7 |
| `js/app.js` | [1771](../../js/app.js#L1771) | `App.extractInsightsForNote` | `Storage.setSetting('insightsExtracting_${…}', …)` | `setInsightsPending` | deleted in slice 7 |
| `js/app.js` | [1835](../../js/app.js#L1835) | `App.archiveNote` | `Storage.archiveNote(…)` | `archiveNote` | deleted in slice 7 |
| `js/app.js` | [1850](../../js/app.js#L1850) | `App.unarchiveNote` | `Storage.unarchiveNote(…)` | `unarchiveNote` | deleted in slice 7 |
| `js/app.js` | [1863](../../js/app.js#L1863) | `App.trashNoteById` | `Storage.trashNote(…)` | `trashNote` | deleted in slice 7 |
| `js/app.js` | [1883](../../js/app.js#L1883) | `App.restoreNoteById` | `Storage.restoreNote(…)` | `restoreNote` | deleted in slice 7 |
| `js/app.js` | [1900](../../js/app.js#L1900) | `App.permanentlyDeleteNoteById` | `Storage.permanentlyDeleteNote(…)` | `deleteNotePermanently` | deleted in slice 7 |
| `js/app.js` | [1931](../../js/app.js#L1931) | `App.convertNoteToTemplate` | `Storage.updateNote({folderId, isTemplate})` | `convertNoteToTemplate` | deleted in slice 7 |
| `js/app.js` | [1948](../../js/app.js#L1948) | `App.convertTemplateToNote` | `Storage.updateNote({isTemplate})` | `convertTemplateToNote` | deleted in slice 7 |
| `js/app.js` | [1991](../../js/app.js#L1991) | `App.emptyTrash` | `Storage.emptyTrash()` | `emptyTrash` | deleted in slice 7 |
| `js/app.js` | [2004](../../js/app.js#L2004) | `App.runTrashCleanup` | `Storage.cleanupTrash(…)` | `runTrashCleanup` | deleted in slice 7 |
| `js/app.js` | [2062](../../js/app.js#L2062) | `App.toggleSidebar` | `Storage.setSetting('sidebarOpen', …)` | `setPreferences` | deleted in slice 7 |
| `js/app.js` | [2369](../../js/app.js#L2369) | `App.renderFolderTree > click listener` | `Storage.updateFolder({collapsed})` | `setFolderCollapsed` | deleted in slice 7 |
| `js/app.js` | [2393](../../js/app.js#L2393) | `App.renderFolderTree > drop listener` | `Storage.moveNoteToFolder(…)` | `moveNoteToFolder` | deleted in slice 7 |
| `js/app.js` | [2401](../../js/app.js#L2401) | `App.renderFolderTree > drop listener` | `Storage.updateFolder({parentId})` | `moveFolder` | deleted in slice 7 |
| `js/app.js` | [2589](../../js/app.js#L2589) | `App.toggleNotePin` | `Storage.updateNote({pinned})` | `setPinned` | deleted in slice 7 |
| `js/app.js` | [3049](../../js/app.js#L3049) | `App.executeCommandPaletteItem` | `Storage.ensureDailyNote()` | `ensureDailyNote` | deleted in slice 7 |
| `js/app.js` | [3128](../../js/app.js#L3128) | `App.loadAIPromptTemplates` | `Storage.setSetting('aiPromptTemplates', …)` | `saveAIPromptTemplates` | deleted in slice 7 |
| `js/app.js` | [3357](../../js/app.js#L3357) | `App.refreshNoteMetadataAfterInsert` | `Storage.updateNote({preview, todoProgress})` | `insertBlocks` | deleted in slice 7 |
| `js/app.js` | [3365](../../js/app.js#L3365) | `App.refreshNoteMetadataAfterInsert` | `Storage.updateNoteLinks(…)` | `insertBlocks` | deleted in slice 7 |
| `js/app.js` | [3551](../../js/app.js#L3551) | `App.openNoteByName` | `Storage.createNote(…)` | `createNote` | kernel command, slice 4 |
| `js/app.js` | [3595](../../js/app.js#L3595) | `App.appendAIResponseToNote` | `Storage.saveElements(…)` | `insertBlocks` | deleted in slice 7 |
| `js/app.js` | [3615](../../js/app.js#L3615) | `App.createNoteFromAIResponse` | `Storage.createNote(…)` | `createNote` | deleted in slice 7 |
| `js/app.js` | [3618](../../js/app.js#L3618) | `App.createNoteFromAIResponse` | `Storage.saveElements(…)` | `createNote` | deleted in slice 7 |
| `js/app.js` | [3651](../../js/app.js#L3651) | `App.generateTitleForNewNote` | `Storage.updateNote({lastAutoTitleAt, name})` | `applyDerivedTitle` | deleted in slice 7 |
| `js/app.js` | [3934](../../js/app.js#L3934) | `App.importNote` | `Storage.createNote(…)` | `importNote` | deleted in slice 7 |
| `js/app.js` | [3945](../../js/app.js#L3945) | `App.importNote` | `Storage.saveElement(…)` | `importNote` | deleted in slice 7 |
| `js/app.js` | [3967](../../js/app.js#L3967) | `App.importNote` | `Storage.createNote(…)` | `importNote` | deleted in slice 7 |
| `js/app.js` | [3978](../../js/app.js#L3978) | `App.importNote` | `Storage.saveElement(…)` | `importNote` | deleted in slice 7 |
| `js/app.js` | [4115](../../js/app.js#L4115) | `App.runAutoTitle` | `Storage.setSetting('lastAutoTitleRun', …)` | `recordJobRun` | deleted in slice 7 |
| `js/app.js` | [4187](../../js/app.js#L4187) | `App.runAutoTitle` | `Storage.updateNote({lastAutoTitleAt, lastTitleContentHash, name})` | `applyDerivedTitle` | deleted in slice 7 |
| `js/app.js` | [4418](../../js/app.js#L4418) | `App.runInsightsExtraction` | `Storage.setSetting('lastInsightsRun', …)` | `recordJobRun` | deleted in slice 7 |
| `js/app.js` | [4461](../../js/app.js#L4461) | `App.runInsightsExtraction` | `Storage.updateNote({insights, lastInsightsContentHash, lastInsightsExtractedAt})` | `attachInsights` | deleted in slice 7 |
| `js/app.js` | [4567](../../js/app.js#L4567) | `App.showFolderContextMenu > action` | `Storage.updateFolder({name})` | `renameFolder` | deleted in slice 7 |
| `js/app.js` | [4577](../../js/app.js#L4577) | `App.showFolderContextMenu > action` | `Storage.deleteFolder(…)` | `deleteFolder` | deleted in slice 7 |
| `js/app.js` | [4586](../../js/app.js#L4586) | `App.showFolderContextMenu > action` | `Storage.createNote(…)` | `createNote` | deleted in slice 7 |
| `js/app.js` | [4588](../../js/app.js#L4588) | `App.showFolderContextMenu > action` | `Storage.updateNote({folderId})` | `moveNoteToFolder` | deleted in slice 7 |
| `js/app.js` | [4598](../../js/app.js#L4598) | `App.showFolderContextMenu > action` | `Storage.updateFolder({parentId})` | `moveFolder` | deleted in slice 7 |
| `js/app.js` | [4704](../../js/app.js#L4704) | `App.initIndexer > onmessage` | `Storage.setSearchIndex(…)` | `updateSearchIndex` | deleted in slice 7 |
| `js/app.js` | [4765](../../js/app.js#L4765) | `App.updateMissingEmbeddings` | `Storage.saveVector(…)` | `saveVector` | deleted in slice 7 |
| `js/app.js` | [5015](../../js/app.js#L5015) | `App.setupShortcuts > keydown listener` | `Storage.ensureDailyNote()` | `ensureDailyNote` | deleted in slice 7 |
| `js/controllers/ai-chat-controller.js` | [161](../../js/controllers/ai-chat-controller.js#L161) | `AIChatController.setupAI > keydown listener` | `this.storage.ensureDailyNote()` | `ensureDailyNote` | kernel command, slice 4 |
| `js/controllers/ai-chat-controller.js` | [278](../../js/controllers/ai-chat-controller.js#L278) | `AIChatController.setupAISidebarResize > onResizeEnd` | `this.storage.setSetting('aiSidebarWidth', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [373](../../js/controllers/ai-chat-controller.js#L373) | `AIChatController.saveNoteChatHistory` | `this.storage.setSetting('aiChatHistory', …)` | `saveChatHistory` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [374](../../js/controllers/ai-chat-controller.js#L374) | `AIChatController.saveNoteChatHistory` | `this.storage.setSetting('noteChatMessages', …)` | `saveChatHistory` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [378](../../js/controllers/ai-chat-controller.js#L378) | `AIChatController.saveGlobalChatHistory` | `this.storage.setSetting('globalChatHistory', …)` | `saveChatHistory` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [379](../../js/controllers/ai-chat-controller.js#L379) | `AIChatController.saveGlobalChatHistory` | `this.storage.setSetting('globalChatMessages', …)` | `saveChatHistory` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [2461](../../js/controllers/ai-chat-controller.js#L2461) | `AIChatController.loadAIPromptTemplates` | `this.storage.setSetting('aiPromptTemplates', …)` | `saveAIPromptTemplates` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [2475](../../js/controllers/ai-chat-controller.js#L2475) | `AIChatController.persistAIPromptTemplates` | `this.storage.setSetting('aiPromptTemplates', …)` | `saveAIPromptTemplates` | kernel command, slice 6 |
| `js/controllers/notes-manager.js` | [111](../../js/controllers/notes-manager.js#L111) | `NotesManager.archiveNote` | `this.storage.archiveNote(…)` | `archiveNote` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [133](../../js/controllers/notes-manager.js#L133) | `NotesManager.unarchiveNote` | `this.storage.unarchiveNote(…)` | `unarchiveNote` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [143](../../js/controllers/notes-manager.js#L143) | `NotesManager.trashNoteById` | `this.storage.trashNote(…)` | `trashNote` | kernel command, slice 5 |
| `js/controllers/notes-manager.js` | [158](../../js/controllers/notes-manager.js#L158) | `NotesManager.restoreNoteById` | `this.storage.restoreNote(…)` | `restoreNote` | kernel command, slice 5 |
| `js/controllers/notes-manager.js` | [172](../../js/controllers/notes-manager.js#L172) | `NotesManager.permanentlyDeleteNoteById` | `this.storage.permanentlyDeleteNote(…)` | `deleteNotePermanently` | kernel command, slice 5 |
| `js/controllers/notes-manager.js` | [193](../../js/controllers/notes-manager.js#L193) | `NotesManager.convertNoteToTemplate` | `this.storage.updateNote({folderId, isTemplate})` | `convertNoteToTemplate` | kernel command, slice 5 |
| `js/controllers/notes-manager.js` | [206](../../js/controllers/notes-manager.js#L206) | `NotesManager.convertTemplateToNote` | `this.storage.updateNote({isTemplate})` | `convertTemplateToNote` | kernel command, slice 5 |
| `js/controllers/notes-manager.js` | [351](../../js/controllers/notes-manager.js#L351) | `NotesManager.importNote` | `this.storage.createNote(…)` | `importNote` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [362](../../js/controllers/notes-manager.js#L362) | `NotesManager.importNote` | `this.storage.saveElement(…)` | `importNote` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [384](../../js/controllers/notes-manager.js#L384) | `NotesManager.importNote` | `this.storage.createNote(…)` | `importNote` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [395](../../js/controllers/notes-manager.js#L395) | `NotesManager.importNote` | `this.storage.saveElement(…)` | `importNote` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [902](../../js/controllers/notes-manager.js#L902) | `NotesManager.updateAutoTitleSettings` | `this.storage.setSetting('autoTitleEnabled', …)` | `setPreferences` | no live caller |
| `js/controllers/notes-manager.js` | [903](../../js/controllers/notes-manager.js#L903) | `NotesManager.updateAutoTitleSettings` | `this.storage.setSetting('autoTitleInterval', …)` | `setPreferences` | no live caller |
| `js/controllers/notes-manager.js` | [1066](../../js/controllers/notes-manager.js#L1066) | `NotesManager.updateInsightsSettings` | `this.storage.setSetting('insightsEnabled', …)` | `setPreferences` | no live caller |
| `js/controllers/notes-manager.js` | [1067](../../js/controllers/notes-manager.js#L1067) | `NotesManager.updateInsightsSettings` | `this.storage.setSetting('insightsInterval', …)` | `setPreferences` | no live caller |
| `js/controllers/notes-manager.js` | [1110](../../js/controllers/notes-manager.js#L1110) | `NotesManager.initIndexer > onmessage` | `this.storage.setSearchIndex(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1114](../../js/controllers/notes-manager.js#L1114) | `NotesManager.initIndexer > onmessage` | `this.storage.setSearchIndexEntry(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1118](../../js/controllers/notes-manager.js#L1118) | `NotesManager.initIndexer > onmessage` | `this.storage.removeSearchIndexEntry(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1225](../../js/controllers/notes-manager.js#L1225) | `NotesManager.updateMissingEmbeddings` | `this.storage.saveVector(…)` | `saveVector` | ledgered to #22 |
| `js/controllers/settings-controller.js` | [97](../../js/controllers/settings-controller.js#L97) | `SettingsController.setupSettings > change listener` | `this.storage.setSetting('theme', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [107](../../js/controllers/settings-controller.js#L107) | `SettingsController.setupSettings > change listener` | `this.storage.setSetting('font', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [116](../../js/controllers/settings-controller.js#L116) | `SettingsController.setupSettings > change listener` | `this.storage.setSetting('width', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [185](../../js/controllers/settings-controller.js#L185) | `SettingsController.setupSettings > change listener` | `this.storage.setSetting('trashRetention', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [193](../../js/controllers/settings-controller.js#L193) | `SettingsController.setupSettings > change listener` | `this.storage.setSetting('dailyNoteTemplate', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [201](../../js/controllers/settings-controller.js#L201) | `SettingsController.setupSettings > change listener` | `this.storage.setSetting('autoBackupEnabled', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [208](../../js/controllers/settings-controller.js#L208) | `SettingsController.setupSettings > change listener` | `this.storage.setSetting('autoBackupFrequency', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [556](../../js/controllers/settings-controller.js#L556) | `SettingsController.setupWidthSelectorPill > click listener` | `this.storage.setSetting('width', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [645](../../js/controllers/settings-controller.js#L645) | `SettingsController._afterFullExport` | `this.storage.setSetting('lastFullExportAt', …)` | `recordBackup` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [646](../../js/controllers/settings-controller.js#L646) | `SettingsController._afterFullExport` | `this.storage.setSetting('lastBackupAt', …)` | `recordBackup` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [690](../../js/controllers/settings-controller.js#L690) | `SettingsController.exportAllAsMarkdown` | `this.storage.setSetting('lastBackupAt', …)` | `recordBackup` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [803](../../js/controllers/settings-controller.js#L803) | `SettingsController.importFromFile` | `this.storage.importData(…)` | `importBackup` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [928](../../js/controllers/settings-controller.js#L928) | `SettingsController.deleteCurrentNote` | `this.storage.deleteNote(…)` | `trashNote` | kernel command, slice 5 |
| `js/controllers/settings-controller.js` | [1067](../../js/controllers/settings-controller.js#L1067) | `SettingsController.checkBackupStatus` | `this.storage.createAutoBackup()` | `createAutoBackup` | kernel command, slice 6 |
| `js/controllers/sidebar-controller.js` | [149](../../js/controllers/sidebar-controller.js#L149) | `SidebarController._bindSidebarListeners > click listener` | `this.storage.ensureDailyNote()` | `ensureDailyNote` | kernel command, slice 4 |
| `js/controllers/sidebar-controller.js` | [159](../../js/controllers/sidebar-controller.js#L159) | `SidebarController._bindSidebarListeners > click listener` | `this.storage.createFolder(…)` | `createFolder` | kernel command, slice 5 |
| `js/controllers/sidebar-controller.js` | [188](../../js/controllers/sidebar-controller.js#L188) | `SidebarController._bindSidebarListeners > change listener` | `this.storage.setSetting('sidebarSortMode', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/sidebar-controller.js` | [348](../../js/controllers/sidebar-controller.js#L348) | `SidebarController._createNoteFromBlock` | `this.storage.createNote(…)` | `createNote` | kernel command, slice 4 |
| `js/controllers/sidebar-controller.js` | [361](../../js/controllers/sidebar-controller.js#L361) | `SidebarController._createNoteFromBlock` | `this.storage.saveElement(…)` | `createNote` | kernel command, slice 4 |
| `js/controllers/sidebar-controller.js` | [396](../../js/controllers/sidebar-controller.js#L396) | `SidebarController._appendBlockToNote` | `this.storage.saveElement(…)` | `insertBlocks` | kernel command, slice 4 |
| `js/controllers/sidebar-controller.js` | [402](../../js/controllers/sidebar-controller.js#L402) | `SidebarController._appendBlockToNote` | `this.storage.updateNote({updatedAt})` | `insertBlocks` | kernel command, slice 4 |
| `js/controllers/sidebar-controller.js` | [439](../../js/controllers/sidebar-controller.js#L439) | `SidebarController.toggleSidebar` | `this.storage.setSetting('sidebarOpen', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/sidebar-controller.js` | [496](../../js/controllers/sidebar-controller.js#L496) | `SidebarController.setupSidebarResize > onResizeEnd` | `this.storage.setSetting('sidebarWidth', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/sidebar-controller.js` | [511](../../js/controllers/sidebar-controller.js#L511) | `SidebarController.setupSidebarViewToggle > click listener` | `this.storage.setSetting('sidebarViewMode', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/sidebar-controller.js` | [516](../../js/controllers/sidebar-controller.js#L516) | `SidebarController.setupSidebarViewToggle > click listener` | `this.storage.setSetting('sidebarViewMode', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/sidebar-controller.js` | [610](../../js/controllers/sidebar-controller.js#L610) | `SidebarController.createCalendarDay > click listener` | `this.storage.ensureDailyNoteForDate(…)` | `ensureDailyNote` | kernel command, slice 4 |
| `js/controllers/sidebar-controller.js` | [779](../../js/controllers/sidebar-controller.js#L779) | `SidebarController.emptyTrash` | `this.storage.emptyTrash()` | `emptyTrash` | kernel command, slice 5 |
| `js/controllers/sidebar-controller.js` | [790](../../js/controllers/sidebar-controller.js#L790) | `SidebarController.runTrashCleanup` | `this.storage.cleanupTrash(…)` | `runTrashCleanup` | kernel command, slice 5 |
| `js/controllers/sidebar-controller.js` | [975](../../js/controllers/sidebar-controller.js#L975) | `SidebarController.renderFolderTree > click listener` | `this.storage.updateFolder({collapsed})` | `setFolderCollapsed` | kernel command, slice 5 |
| `js/controllers/sidebar-controller.js` | [991](../../js/controllers/sidebar-controller.js#L991) | `SidebarController.renderFolderTree > drop listener` | `this.storage.moveNoteToFolder(…)` | `moveNoteToFolder` | kernel command, slice 5 |
| `js/controllers/sidebar-controller.js` | [998](../../js/controllers/sidebar-controller.js#L998) | `SidebarController.renderFolderTree > drop listener` | `this.storage.updateFolder({parentId})` | `moveFolder` | kernel command, slice 5 |
| `js/controllers/sidebar-controller.js` | [1147](../../js/controllers/sidebar-controller.js#L1147) | `SidebarController.toggleNotePin` | `this.storage.updateNote({pinned})` | `setPinned` | kernel command, slice 4 |
| `js/controllers/sidebar-controller.js` | [1190](../../js/controllers/sidebar-controller.js#L1190) | `SidebarController.showFolderContextMenu > action` | `this.storage.updateFolder({name})` | `renameFolder` | kernel command, slice 5 |
| `js/controllers/sidebar-controller.js` | [1196](../../js/controllers/sidebar-controller.js#L1196) | `SidebarController.showFolderContextMenu > action` | `this.storage.deleteFolder(…)` | `deleteFolder` | kernel command, slice 5 |
| `js/controllers/sidebar-controller.js` | [1201](../../js/controllers/sidebar-controller.js#L1201) | `SidebarController.showFolderContextMenu > action` | `this.storage.createNote(…)` | `createNote` | kernel command, slice 4 |
| `js/controllers/sidebar-controller.js` | [1203](../../js/controllers/sidebar-controller.js#L1203) | `SidebarController.showFolderContextMenu > action` | `this.storage.updateNote({folderId})` | `moveNoteToFolder` | kernel command, slice 5 |
| `js/controllers/sidebar-controller.js` | [1209](../../js/controllers/sidebar-controller.js#L1209) | `SidebarController.showFolderContextMenu > action` | `this.storage.updateFolder({parentId})` | `moveFolder` | kernel command, slice 5 |
| `js/controllers/sidebar-controller.js` | [1288](../../js/controllers/sidebar-controller.js#L1288) | `SidebarController.performBulkAction` | `this.storage.bulkNoteAction(…)` | `runBulkAction` | kernel command, slice 5 |
| `js/controllers/tab-controller.js` | [588](../../js/controllers/tab-controller.js#L588) | `TabController.saveTabs` | `this.storage.setSetting('openTabs', …)` | `saveWorkspaceSession` | kernel command, slice 6 |
| `js/controllers/tab-controller.js` | [589](../../js/controllers/tab-controller.js#L589) | `TabController.saveTabs` | `this.storage.setSetting('activeTabIndex', …)` | `saveWorkspaceSession` | kernel command, slice 6 |
| `js/controllers/tab-controller.js` | [590](../../js/controllers/tab-controller.js#L590) | `TabController.saveTabs` | `this.storage.setSetting('splitViewEnabled', …)` | `saveWorkspaceSession` | kernel command, slice 6 |
| `js/controllers/tab-controller.js` | [592](../../js/controllers/tab-controller.js#L592) | `TabController.saveTabs` | `this.storage.setSetting('secondaryNoteId', …)` | `saveWorkspaceSession` | kernel command, slice 6 |
| `js/controllers/tab-controller.js` | [603](../../js/controllers/tab-controller.js#L603) | `TabController.cacheLastOpenedNoteId` | `chrome.storage.local.set({lastOpenedNoteId})` | `saveWorkspaceSession` | kernel command, slice 6 |
| `js/controllers/theme-builder-controller.js` | [70](../../js/controllers/theme-builder-controller.js#L70) | `ThemeBuilderController.setupThemeBuilder > click listener` | `this.storage.saveCustomTheme(…)` | `saveTheme` | kernel command, slice 6 |
| `js/controllers/theme-builder-controller.js` | [71](../../js/controllers/theme-builder-controller.js#L71) | `ThemeBuilderController.setupThemeBuilder > click listener` | `this.storage.setSetting('theme', …)` | `setPreferences` | kernel command, slice 6 |
| `js/llm.js` | [130](../../js/llm.js#L130) | `LLMService.setEndpoint` | `Storage.setSetting('llmEndpoint', …)` | `saveProviderSettings` | no live caller |
| `js/llm.js` | [662](../../js/llm.js#L662) | `LLMService.setProvider` | `Storage.setSetting('llmProvider', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [674](../../js/llm.js#L674) | `LLMService.setApiKey` | `Storage.setSetting('llmApiKey', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [682](../../js/llm.js#L682) | `LLMService.setModel` | `Storage.setSetting('llmModel', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [687](../../js/llm.js#L687) | `LLMService.setOllamaUrl` | `Storage.setSetting('ollamaUrl', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/onboarding.js` | [48](../../js/onboarding.js#L48) | `OnboardingManager.setupFirstRun` | `Storage.setSetting('embeddingsEnabled', …)` | `setPreferences` | kernel command, slice 6 |
| `js/onboarding.js` | [49](../../js/onboarding.js#L49) | `OnboardingManager.setupFirstRun` | `Storage.setSetting('autoTitleEnabled', …)` | `setPreferences` | kernel command, slice 6 |
| `js/onboarding.js` | [50](../../js/onboarding.js#L50) | `OnboardingManager.setupFirstRun` | `Storage.setSetting('insightsEnabled', …)` | `setPreferences` | kernel command, slice 6 |
| `js/onboarding.js` | [66](../../js/onboarding.js#L66) | `OnboardingManager.markComplete` | `Storage.setSetting('hasCompletedOnboarding', …)` | `completeOnboarding` | kernel command, slice 6 |
| `js/services/sync-service.js` | [303](../../js/services/sync-service.js#L303) | `SyncService.connect` | `this.storage.setSetting('syncProvider', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [305](../../js/services/sync-service.js#L305) | `SyncService.connect` | `this.storage.setSetting('syncWebdavConfig', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [329](../../js/services/sync-service.js#L329) | `SyncService.disconnect` | `this.storage.setSetting('syncProvider', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [330](../../js/services/sync-service.js#L330) | `SyncService.disconnect` | `this.storage.setSetting('syncWebdavConfig', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [331](../../js/services/sync-service.js#L331) | `SyncService.disconnect` | `this.storage.setSetting('syncLastSyncAt', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [422](../../js/services/sync-service.js#L422) | `SyncService.sync` | `this.storage.setSetting('syncLastSyncAt', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [493](../../js/services/sync-service.js#L493) | `SyncService._applyResolution` | `this.storage.importNote(…)` | `applyRemoteChanges` | ledgered to #19 |
| `js/services/sync-service.js` | [499](../../js/services/sync-service.js#L499) | `SyncService._applyResolution` | `this.storage.saveElement(…)` | `applyRemoteChanges` | ledgered to #19 |
| `js/services/sync-service.js` | [517](../../js/services/sync-service.js#L517) | `SyncService._applyRemoteData` | `this.storage.importAll(…)` | `applyRemoteChanges` | ledgered to #19 |
| `js/ui/export-notice.js` | [151](../../js/ui/export-notice.js#L151) | `ExportNotice.record > write` | `this.storage.setSetting('preMigrationNotice', …)` | `recordExportNotice` | kernel command, slice 6 |
