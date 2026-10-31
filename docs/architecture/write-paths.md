# Write paths

Every mutating persistence call in `js/` outside `js/storage.js` (and outside `js/lib/` and `js/kernel/`), the intent-level kernel command it becomes, and when. #12's acceptance criteria need each row to go through a kernel command or stay ledgered to #11, #19, or #22. #12 slice 2 mapped them.

Network writes (sync uploads, AI provider requests) aren't listed. They go through `fetch`, which the kernel boundary rules ledger to #19 and #11.

Written by `npm run check:write-paths -- --write` from `scripts/write-paths.js`, which says what counts as a mutating call and holds the rules below. `npm test` fails when a call is added, removed, moved to another function, or reclassified until this file is rewritten. Line numbers are where the calls were when it was last written.

## Statuses

| Status | Rows | Meaning |
| --- | --- | --- |
| kernel command, slice 4 | 0 | #12 slice 4 (notes and blocks) routes it through the command. |
| kernel command, slice 5 | 0 | #12 slice 5 (folders, templates, trash) routes it through the command. |
| kernel command, slice 6 | 37 | #12 slice 6 (preferences and session) routes it through the command. |
| deleted in slice 7 | 40 | App's copy of a controller path. It runs only after an `if (this.<controller>)` check has handed off to that controller and returned, or in that check's else branch, or nothing reaches it from App's bootstrap and the methods `js/editor.js` calls. Slice 7 deletes it with App's fallback bodies. The command is the one the controller path becomes. |
| no live caller | 5 | Nothing in `js/` refers to the method or function the write sits in, so the write never runs. Deleting it drops the row. The command is what the call would become. |
| ledgered to #11 | 4 | Provider settings and keys, which #11's provider registry takes over (#21 reviews the key rows). |
| ledgered to #19 | 9 | The sync service, which #19's sync engine replaces. |
| ledgered to #22 | 4 | The search index and vectors, which #22's pipelines own. |
| UI-only | 0 | Persists nothing a kernel aggregate or the settings port owns. |
| Total | 99 | |

No row is UI-only. Presentation state (panels, the palette index, selection mode, the calendar month) isn't persisted, and every persisted preference goes through the settings port.

## Commands

| Command | Status | Rows |
| --- | --- | --- |
| `runStartupMaintenance` | kernel command, slice 4 | 0 |
| `createNote` | kernel command, slice 4 | 7 |
| `ensureDailyNote` | kernel command, slice 4 | 3 |
| `captureToDailyNote` | kernel command, slice 4 | 0 |
| `saveNoteContent` | kernel command, slice 4 | 0 |
| `insertBlocks` | kernel command, slice 4 | 3 |
| `deleteBlocks` | kernel command, slice 4 | 0 |
| `saveSnapshot` | kernel command, slice 4 | 0 |
| `restoreSnapshot` | kernel command, slice 4 | 0 |
| `renameNote` | kernel command, slice 4 | 1 |
| `setPinned` | kernel command, slice 4 | 1 |
| `archiveNote` | kernel command, slice 4 | 0 |
| `unarchiveNote` | kernel command, slice 4 | 1 |
| `applyDerivedTitle` | kernel command, slice 4 | 2 |
| `attachInsights` | kernel command, slice 4 | 2 |
| `setInsightsPending` | kernel command, slice 4 | 2 |
| `recordJobRun` | kernel command, slice 4 | 2 |
| `createFolder` | kernel command, slice 5 | 0 |
| `renameFolder` | kernel command, slice 5 | 1 |
| `moveFolder` | kernel command, slice 5 | 2 |
| `setFolderCollapsed` | kernel command, slice 5 | 1 |
| `deleteFolder` | kernel command, slice 5 | 1 |
| `moveNoteToFolder` | kernel command, slice 5 | 2 |
| `convertNoteToTemplate` | kernel command, slice 5 | 1 |
| `convertTemplateToNote` | kernel command, slice 5 | 1 |
| `trashNote` | kernel command, slice 5 | 0 |
| `restoreNote` | kernel command, slice 5 | 1 |
| `deleteNotePermanently` | kernel command, slice 5 | 1 |
| `emptyTrash` | kernel command, slice 5 | 1 |
| `runTrashCleanup` | kernel command, slice 5 | 0 |
| `runBulkAction` | kernel command, slice 5 | 0 |
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

Routed ahead of their slice: the sidebar folder menu's Add Note to Folder files its new note with `createNote`'s `folderId` (#12 slice 4c2), so the slice 5 `moveNoteToFolder` row that set the folder after the create went with the slice 4 `createNote` row.

## Calls

Method is the class method or function the call sits in. After `>` comes the anonymous or nested function inside it, when where it sits says what it's for: a listener, a callback property such as `onResizeEnd`, or a menu item's `action`. An update's Call lists the fields it sets.

| File | Line | Method | Call | Command | Status |
| --- | --- | --- | --- | --- | --- |
| `js/app.js` | [1262](../../js/app.js#L1262) | `App.createCalendarDay > click listener` | `Storage.ensureDailyNoteForDate(…)` | `ensureDailyNote` | deleted in slice 7 |
| `js/app.js` | [1774](../../js/app.js#L1774) | `App.generateTitleForNote` | `Storage.updateNote({lastAutoTitleAt, name})` | `renameNote` | deleted in slice 7 |
| `js/app.js` | [1824](../../js/app.js#L1824) | `App.extractInsightsForNote` | `Storage.setSetting('insightsExtracting_${…}', …)` | `setInsightsPending` | deleted in slice 7 |
| `js/app.js` | [1870](../../js/app.js#L1870) | `App.extractInsightsForNote` | `Storage.updateNote({insights, lastInsightsContentHash, lastInsightsExtractedAt})` | `attachInsights` | deleted in slice 7 |
| `js/app.js` | [1894](../../js/app.js#L1894) | `App.extractInsightsForNote` | `Storage.setSetting('insightsExtracting_${…}', …)` | `setInsightsPending` | deleted in slice 7 |
| `js/app.js` | [1965](../../js/app.js#L1965) | `App.unarchiveNote` | `Storage.unarchiveNote(…)` | `unarchiveNote` | deleted in slice 7 |
| `js/app.js` | [1985](../../js/app.js#L1985) | `App.restoreNoteById` | `Storage.restoreNote(…)` | `restoreNote` | deleted in slice 7 |
| `js/app.js` | [2002](../../js/app.js#L2002) | `App.permanentlyDeleteNoteById` | `Storage.permanentlyDeleteNote(…)` | `deleteNotePermanently` | deleted in slice 7 |
| `js/app.js` | [2019](../../js/app.js#L2019) | `App.convertNoteToTemplate` | `Storage.updateNote({folderId, isTemplate})` | `convertNoteToTemplate` | deleted in slice 7 |
| `js/app.js` | [2036](../../js/app.js#L2036) | `App.convertTemplateToNote` | `Storage.updateNote({isTemplate})` | `convertTemplateToNote` | deleted in slice 7 |
| `js/app.js` | [2058](../../js/app.js#L2058) | `App.emptyTrash` | `Storage.emptyTrash()` | `emptyTrash` | deleted in slice 7 |
| `js/app.js` | [2111](../../js/app.js#L2111) | `App.toggleSidebar` | `Storage.setSetting('sidebarOpen', …)` | `setPreferences` | deleted in slice 7 |
| `js/app.js` | [2368](../../js/app.js#L2368) | `App.renderFolderTree > click listener` | `Storage.updateFolder({collapsed})` | `setFolderCollapsed` | deleted in slice 7 |
| `js/app.js` | [2393](../../js/app.js#L2393) | `App.renderFolderTree > drop listener` | `Storage.moveNoteToFolder(…)` | `moveNoteToFolder` | deleted in slice 7 |
| `js/app.js` | [2402](../../js/app.js#L2402) | `App.renderFolderTree > drop listener` | `Storage.updateFolder({parentId})` | `moveFolder` | deleted in slice 7 |
| `js/app.js` | [2590](../../js/app.js#L2590) | `App.toggleNotePin` | `Storage.updateNote({pinned})` | `setPinned` | deleted in slice 7 |
| `js/app.js` | [3050](../../js/app.js#L3050) | `App.executeCommandPaletteItem` | `Storage.ensureDailyNote()` | `ensureDailyNote` | deleted in slice 7 |
| `js/app.js` | [3129](../../js/app.js#L3129) | `App.loadAIPromptTemplates` | `Storage.setSetting('aiPromptTemplates', …)` | `saveAIPromptTemplates` | deleted in slice 7 |
| `js/app.js` | [3358](../../js/app.js#L3358) | `App.refreshNoteMetadataAfterInsert` | `Storage.updateNote({preview, todoProgress})` | `insertBlocks` | deleted in slice 7 |
| `js/app.js` | [3366](../../js/app.js#L3366) | `App.refreshNoteMetadataAfterInsert` | `Storage.updateNoteLinks(…)` | `insertBlocks` | deleted in slice 7 |
| `js/app.js` | [3590](../../js/app.js#L3590) | `App.appendAIResponseToNote` | `Storage.saveElements(…)` | `insertBlocks` | deleted in slice 7 |
| `js/app.js` | [3610](../../js/app.js#L3610) | `App.createNoteFromAIResponse` | `Storage.createNote(…)` | `createNote` | deleted in slice 7 |
| `js/app.js` | [3613](../../js/app.js#L3613) | `App.createNoteFromAIResponse` | `Storage.saveElements(…)` | `createNote` | deleted in slice 7 |
| `js/app.js` | [3646](../../js/app.js#L3646) | `App.generateTitleForNewNote` | `Storage.updateNote({lastAutoTitleAt, name})` | `applyDerivedTitle` | deleted in slice 7 |
| `js/app.js` | [3929](../../js/app.js#L3929) | `App.importNote` | `Storage.createNote(…)` | `createNote` | deleted in slice 7 |
| `js/app.js` | [3940](../../js/app.js#L3940) | `App.importNote` | `Storage.saveElement(…)` | `createNote` | deleted in slice 7 |
| `js/app.js` | [3962](../../js/app.js#L3962) | `App.importNote` | `Storage.createNote(…)` | `createNote` | deleted in slice 7 |
| `js/app.js` | [3973](../../js/app.js#L3973) | `App.importNote` | `Storage.saveElement(…)` | `createNote` | deleted in slice 7 |
| `js/app.js` | [4110](../../js/app.js#L4110) | `App.runAutoTitle` | `Storage.setSetting('lastAutoTitleRun', …)` | `recordJobRun` | deleted in slice 7 |
| `js/app.js` | [4182](../../js/app.js#L4182) | `App.runAutoTitle` | `Storage.updateNote({lastAutoTitleAt, lastTitleContentHash, name})` | `applyDerivedTitle` | deleted in slice 7 |
| `js/app.js` | [4413](../../js/app.js#L4413) | `App.runInsightsExtraction` | `Storage.setSetting('lastInsightsRun', …)` | `recordJobRun` | deleted in slice 7 |
| `js/app.js` | [4456](../../js/app.js#L4456) | `App.runInsightsExtraction` | `Storage.updateNote({insights, lastInsightsContentHash, lastInsightsExtractedAt})` | `attachInsights` | deleted in slice 7 |
| `js/app.js` | [4563](../../js/app.js#L4563) | `App.showFolderContextMenu > action` | `Storage.updateFolder({name})` | `renameFolder` | deleted in slice 7 |
| `js/app.js` | [4573](../../js/app.js#L4573) | `App.showFolderContextMenu > action` | `Storage.deleteFolder(…)` | `deleteFolder` | deleted in slice 7 |
| `js/app.js` | [4582](../../js/app.js#L4582) | `App.showFolderContextMenu > action` | `Storage.createNote(…)` | `createNote` | deleted in slice 7 |
| `js/app.js` | [4584](../../js/app.js#L4584) | `App.showFolderContextMenu > action` | `Storage.updateNote({folderId})` | `moveNoteToFolder` | deleted in slice 7 |
| `js/app.js` | [4595](../../js/app.js#L4595) | `App.showFolderContextMenu > action` | `Storage.updateFolder({parentId})` | `moveFolder` | deleted in slice 7 |
| `js/app.js` | [4701](../../js/app.js#L4701) | `App.initIndexer > onmessage` | `Storage.setSearchIndex(…)` | `updateSearchIndex` | deleted in slice 7 |
| `js/app.js` | [4762](../../js/app.js#L4762) | `App.updateMissingEmbeddings` | `Storage.saveVector(…)` | `saveVector` | deleted in slice 7 |
| `js/app.js` | [5012](../../js/app.js#L5012) | `App.setupShortcuts > keydown listener` | `Storage.ensureDailyNote()` | `ensureDailyNote` | deleted in slice 7 |
| `js/controllers/ai-chat-controller.js` | [278](../../js/controllers/ai-chat-controller.js#L278) | `AIChatController.setupAISidebarResize > onResizeEnd` | `this.storage.setSetting('aiSidebarWidth', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [373](../../js/controllers/ai-chat-controller.js#L373) | `AIChatController.saveNoteChatHistory` | `this.storage.setSetting('aiChatHistory', …)` | `saveChatHistory` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [374](../../js/controllers/ai-chat-controller.js#L374) | `AIChatController.saveNoteChatHistory` | `this.storage.setSetting('noteChatMessages', …)` | `saveChatHistory` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [378](../../js/controllers/ai-chat-controller.js#L378) | `AIChatController.saveGlobalChatHistory` | `this.storage.setSetting('globalChatHistory', …)` | `saveChatHistory` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [379](../../js/controllers/ai-chat-controller.js#L379) | `AIChatController.saveGlobalChatHistory` | `this.storage.setSetting('globalChatMessages', …)` | `saveChatHistory` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [2473](../../js/controllers/ai-chat-controller.js#L2473) | `AIChatController.loadAIPromptTemplates` | `this.storage.setSetting('aiPromptTemplates', …)` | `saveAIPromptTemplates` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [2487](../../js/controllers/ai-chat-controller.js#L2487) | `AIChatController.persistAIPromptTemplates` | `this.storage.setSetting('aiPromptTemplates', …)` | `saveAIPromptTemplates` | kernel command, slice 6 |
| `js/controllers/notes-manager.js` | [933](../../js/controllers/notes-manager.js#L933) | `NotesManager.updateAutoTitleSettings` | `this.storage.setSetting('autoTitleEnabled', …)` | `setPreferences` | no live caller |
| `js/controllers/notes-manager.js` | [934](../../js/controllers/notes-manager.js#L934) | `NotesManager.updateAutoTitleSettings` | `this.storage.setSetting('autoTitleInterval', …)` | `setPreferences` | no live caller |
| `js/controllers/notes-manager.js` | [1097](../../js/controllers/notes-manager.js#L1097) | `NotesManager.updateInsightsSettings` | `this.storage.setSetting('insightsEnabled', …)` | `setPreferences` | no live caller |
| `js/controllers/notes-manager.js` | [1098](../../js/controllers/notes-manager.js#L1098) | `NotesManager.updateInsightsSettings` | `this.storage.setSetting('insightsInterval', …)` | `setPreferences` | no live caller |
| `js/controllers/notes-manager.js` | [1193](../../js/controllers/notes-manager.js#L1193) | `NotesManager.initIndexer > onmessage` | `this.storage.setSearchIndex(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1197](../../js/controllers/notes-manager.js#L1197) | `NotesManager.initIndexer > onmessage` | `this.storage.setSearchIndexEntry(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1201](../../js/controllers/notes-manager.js#L1201) | `NotesManager.initIndexer > onmessage` | `this.storage.removeSearchIndexEntry(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1319](../../js/controllers/notes-manager.js#L1319) | `NotesManager.updateMissingEmbeddings` | `this.storage.saveVector(…)` | `saveVector` | ledgered to #22 |
| `js/controllers/settings-controller.js` | [93](../../js/controllers/settings-controller.js#L93) | `SettingsController.setupSettings > change listener` | `this.storage.setSetting('theme', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [103](../../js/controllers/settings-controller.js#L103) | `SettingsController.setupSettings > change listener` | `this.storage.setSetting('font', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [112](../../js/controllers/settings-controller.js#L112) | `SettingsController.setupSettings > change listener` | `this.storage.setSetting('width', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [181](../../js/controllers/settings-controller.js#L181) | `SettingsController.setupSettings > change listener` | `this.storage.setSetting('trashRetention', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [189](../../js/controllers/settings-controller.js#L189) | `SettingsController.setupSettings > change listener` | `this.storage.setSetting('dailyNoteTemplate', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [197](../../js/controllers/settings-controller.js#L197) | `SettingsController.setupSettings > change listener` | `this.storage.setSetting('autoBackupEnabled', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [204](../../js/controllers/settings-controller.js#L204) | `SettingsController.setupSettings > change listener` | `this.storage.setSetting('autoBackupFrequency', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [552](../../js/controllers/settings-controller.js#L552) | `SettingsController.setupWidthSelectorPill > click listener` | `this.storage.setSetting('width', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [641](../../js/controllers/settings-controller.js#L641) | `SettingsController._afterFullExport` | `this.storage.setSetting('lastFullExportAt', …)` | `recordBackup` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [642](../../js/controllers/settings-controller.js#L642) | `SettingsController._afterFullExport` | `this.storage.setSetting('lastBackupAt', …)` | `recordBackup` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [686](../../js/controllers/settings-controller.js#L686) | `SettingsController.exportAllAsMarkdown` | `this.storage.setSetting('lastBackupAt', …)` | `recordBackup` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [799](../../js/controllers/settings-controller.js#L799) | `SettingsController.importFromFile` | `this.storage.importData(…)` | `importBackup` | kernel command, slice 6 |
| `js/controllers/settings-controller.js` | [1083](../../js/controllers/settings-controller.js#L1083) | `SettingsController.checkBackupStatus` | `this.storage.createAutoBackup()` | `createAutoBackup` | kernel command, slice 6 |
| `js/controllers/sidebar-controller.js` | [284](../../js/controllers/sidebar-controller.js#L284) | `SidebarController._bindSidebarListeners > change listener` | `this.storage.setSetting('sidebarSortMode', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/sidebar-controller.js` | [567](../../js/controllers/sidebar-controller.js#L567) | `SidebarController.toggleSidebar` | `this.storage.setSetting('sidebarOpen', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/sidebar-controller.js` | [624](../../js/controllers/sidebar-controller.js#L624) | `SidebarController.setupSidebarResize > onResizeEnd` | `this.storage.setSetting('sidebarWidth', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/sidebar-controller.js` | [639](../../js/controllers/sidebar-controller.js#L639) | `SidebarController.setupSidebarViewToggle > click listener` | `this.storage.setSetting('sidebarViewMode', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/sidebar-controller.js` | [644](../../js/controllers/sidebar-controller.js#L644) | `SidebarController.setupSidebarViewToggle > click listener` | `this.storage.setSetting('sidebarViewMode', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/tab-controller.js` | [689](../../js/controllers/tab-controller.js#L689) | `TabController.saveTabs` | `this.storage.setSetting('openTabs', …)` | `saveWorkspaceSession` | kernel command, slice 6 |
| `js/controllers/tab-controller.js` | [690](../../js/controllers/tab-controller.js#L690) | `TabController.saveTabs` | `this.storage.setSetting('activeTabIndex', …)` | `saveWorkspaceSession` | kernel command, slice 6 |
| `js/controllers/tab-controller.js` | [691](../../js/controllers/tab-controller.js#L691) | `TabController.saveTabs` | `this.storage.setSetting('splitViewEnabled', …)` | `saveWorkspaceSession` | kernel command, slice 6 |
| `js/controllers/tab-controller.js` | [693](../../js/controllers/tab-controller.js#L693) | `TabController.saveTabs` | `this.storage.setSetting('secondaryNoteId', …)` | `saveWorkspaceSession` | kernel command, slice 6 |
| `js/controllers/tab-controller.js` | [704](../../js/controllers/tab-controller.js#L704) | `TabController.cacheLastOpenedNoteId` | `chrome.storage.local.set({lastOpenedNoteId})` | `saveWorkspaceSession` | kernel command, slice 6 |
| `js/controllers/theme-builder-controller.js` | [68](../../js/controllers/theme-builder-controller.js#L68) | `ThemeBuilderController.setupThemeBuilder > click listener` | `this.storage.saveCustomTheme(…)` | `saveTheme` | kernel command, slice 6 |
| `js/controllers/theme-builder-controller.js` | [69](../../js/controllers/theme-builder-controller.js#L69) | `ThemeBuilderController.setupThemeBuilder > click listener` | `this.storage.setSetting('theme', …)` | `setPreferences` | kernel command, slice 6 |
| `js/llm.js` | [130](../../js/llm.js#L130) | `LLMService.setEndpoint` | `Storage.setSetting('llmEndpoint', …)` | `saveProviderSettings` | no live caller |
| `js/llm.js` | [669](../../js/llm.js#L669) | `LLMService.setProvider` | `Storage.setSetting('llmProvider', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [681](../../js/llm.js#L681) | `LLMService.setApiKey` | `Storage.setSetting('llmApiKey', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [689](../../js/llm.js#L689) | `LLMService.setModel` | `Storage.setSetting('llmModel', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [694](../../js/llm.js#L694) | `LLMService.setOllamaUrl` | `Storage.setSetting('ollamaUrl', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/onboarding.js` | [48](../../js/onboarding.js#L48) | `OnboardingManager.setupFirstRun` | `Storage.setSetting('embeddingsEnabled', …)` | `setPreferences` | kernel command, slice 6 |
| `js/onboarding.js` | [49](../../js/onboarding.js#L49) | `OnboardingManager.setupFirstRun` | `Storage.setSetting('autoTitleEnabled', …)` | `setPreferences` | kernel command, slice 6 |
| `js/onboarding.js` | [50](../../js/onboarding.js#L50) | `OnboardingManager.setupFirstRun` | `Storage.setSetting('insightsEnabled', …)` | `setPreferences` | kernel command, slice 6 |
| `js/onboarding.js` | [66](../../js/onboarding.js#L66) | `OnboardingManager.markComplete` | `Storage.setSetting('hasCompletedOnboarding', …)` | `completeOnboarding` | kernel command, slice 6 |
| `js/services/sync-service.js` | [299](../../js/services/sync-service.js#L299) | `SyncService.connect` | `this.storage.setSetting('syncProvider', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [301](../../js/services/sync-service.js#L301) | `SyncService.connect` | `this.storage.setSetting('syncWebdavConfig', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [325](../../js/services/sync-service.js#L325) | `SyncService.disconnect` | `this.storage.setSetting('syncProvider', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [326](../../js/services/sync-service.js#L326) | `SyncService.disconnect` | `this.storage.setSetting('syncWebdavConfig', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [327](../../js/services/sync-service.js#L327) | `SyncService.disconnect` | `this.storage.setSetting('syncLastSyncAt', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [418](../../js/services/sync-service.js#L418) | `SyncService.sync` | `this.storage.setSetting('syncLastSyncAt', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [489](../../js/services/sync-service.js#L489) | `SyncService._applyResolution` | `this.storage.importNote(…)` | `applyRemoteChanges` | ledgered to #19 |
| `js/services/sync-service.js` | [495](../../js/services/sync-service.js#L495) | `SyncService._applyResolution` | `this.storage.saveElement(…)` | `applyRemoteChanges` | ledgered to #19 |
| `js/services/sync-service.js` | [513](../../js/services/sync-service.js#L513) | `SyncService._applyRemoteData` | `this.storage.importAll(…)` | `applyRemoteChanges` | ledgered to #19 |
| `js/ui/export-notice.js` | [151](../../js/ui/export-notice.js#L151) | `ExportNotice.record > write` | `this.storage.setSetting('preMigrationNotice', …)` | `recordExportNotice` | kernel command, slice 6 |
