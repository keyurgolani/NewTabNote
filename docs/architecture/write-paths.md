# Write paths

Every mutating persistence call in `js/` outside `js/storage.js` (and outside `js/lib/` and `js/kernel/`), the intent-level kernel command it becomes, and when. #12's acceptance criteria need each row to go through a kernel command or stay ledgered to #11, #19, or #22. #12 slice 2 mapped them.

Network writes (sync uploads, AI provider requests) aren't listed. They go through `fetch`, which the kernel boundary rules ledger to #19 and #11.

Written by `npm run check:write-paths -- --write` from `scripts/write-paths.js`, which says what counts as a mutating call and holds the rules below. `npm test` fails when a call is added, removed, moved to another function, or reclassified until this file is rewritten. Line numbers are where the calls were when it was last written.

## Statuses

| Status | Rows | Meaning |
| --- | --- | --- |
| kernel command, slice 4 | 45 | #12 slice 4 (notes and blocks) routes it through the command. |
| kernel command, slice 5 | 17 | #12 slice 5 (folders, templates, trash) routes it through the command. |
| kernel command, slice 6 | 37 | #12 slice 6 (preferences and session) routes it through the command. |
| deleted in slice 7 | 43 | App's copy of a controller path. It runs only after an `if (this.<controller>)` check has handed off to that controller and returned, or in that check's else branch, or nothing reaches it from App's bootstrap and the methods `js/editor.js` calls. Slice 7 deletes it with App's fallback bodies. The command is the one the controller path becomes. |
| no live caller | 5 | Nothing in `js/` refers to the method or function the write sits in, so the write never runs. Deleting it drops the row. The command is what the call would become. |
| ledgered to #11 | 4 | Provider settings and keys, which #11's provider registry takes over (#21 reviews the key rows). |
| ledgered to #19 | 9 | The sync service, which #19's sync engine replaces. |
| ledgered to #22 | 4 | The search index and vectors, which #22's pipelines own. |
| UI-only | 0 | Persists nothing a kernel aggregate or the settings port owns. |
| Total | 164 | |

No row is UI-only. Presentation state (panels, the palette index, selection mode, the calendar month) isn't persisted, and every persisted preference goes through the settings port.

## Commands

| Command | Status | Rows |
| --- | --- | --- |
| `runStartupMaintenance` | kernel command, slice 4 | 0 |
| `createNote` | kernel command, slice 4 | 13 |
| `importNote` | kernel command, slice 4 | 8 |
| `ensureDailyNote` | kernel command, slice 4 | 7 |
| `captureToDailyNote` | kernel command, slice 4 | 0 |
| `saveNoteContent` | kernel command, slice 4 | 0 |
| `insertBlocks` | kernel command, slice 4 | 9 |
| `deleteBlocks` | kernel command, slice 4 | 0 |
| `saveSnapshot` | kernel command, slice 4 | 1 |
| `restoreSnapshot` | kernel command, slice 4 | 4 |
| `renameNote` | kernel command, slice 4 | 3 |
| `setPinned` | kernel command, slice 4 | 2 |
| `archiveNote` | kernel command, slice 4 | 2 |
| `unarchiveNote` | kernel command, slice 4 | 2 |
| `applyDerivedTitle` | kernel command, slice 4 | 4 |
| `attachInsights` | kernel command, slice 4 | 6 |
| `setInsightsPending` | kernel command, slice 4 | 5 |
| `recordJobRun` | kernel command, slice 4 | 4 |
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
| `js/app.js` | [522](../../js/app.js#L522) | `App.createFirstNote` | `Storage.createNote(…)` | `createNote` | kernel command, slice 4 |
| `js/app.js` | [536](../../js/app.js#L536) | `App.runOnboarding` | `Storage.createNote(…)` | `createNote` | kernel command, slice 4 |
| `js/app.js` | [540](../../js/app.js#L540) | `App.runOnboarding` | `Storage.saveElement(…)` | `createNote` | kernel command, slice 4 |
| `js/app.js` | [665](../../js/app.js#L665) | `App.initTabController > onCreateNote` | `Storage.createNote(…)` | `createNote` | kernel command, slice 4 |
| `js/app.js` | [1008](../../js/app.js#L1008) | `App.initShortcutsManager > onEnsureDailyNote` | `Storage.ensureDailyNote()` | `ensureDailyNote` | kernel command, slice 4 |
| `js/app.js` | [1133](../../js/app.js#L1133) | `App.createCalendarDay > click listener` | `Storage.ensureDailyNoteForDate(…)` | `ensureDailyNote` | deleted in slice 7 |
| `js/app.js` | [1645](../../js/app.js#L1645) | `App.generateTitleForNote` | `Storage.updateNote({lastAutoTitleAt, name})` | `renameNote` | deleted in slice 7 |
| `js/app.js` | [1695](../../js/app.js#L1695) | `App.extractInsightsForNote` | `Storage.setSetting('insightsExtracting_${…}', …)` | `setInsightsPending` | deleted in slice 7 |
| `js/app.js` | [1741](../../js/app.js#L1741) | `App.extractInsightsForNote` | `Storage.updateNote({insights, lastInsightsContentHash, lastInsightsExtractedAt})` | `attachInsights` | deleted in slice 7 |
| `js/app.js` | [1765](../../js/app.js#L1765) | `App.extractInsightsForNote` | `Storage.setSetting('insightsExtracting_${…}', …)` | `setInsightsPending` | deleted in slice 7 |
| `js/app.js` | [1829](../../js/app.js#L1829) | `App.archiveNote` | `Storage.archiveNote(…)` | `archiveNote` | deleted in slice 7 |
| `js/app.js` | [1844](../../js/app.js#L1844) | `App.unarchiveNote` | `Storage.unarchiveNote(…)` | `unarchiveNote` | deleted in slice 7 |
| `js/app.js` | [1857](../../js/app.js#L1857) | `App.trashNoteById` | `Storage.trashNote(…)` | `trashNote` | deleted in slice 7 |
| `js/app.js` | [1877](../../js/app.js#L1877) | `App.restoreNoteById` | `Storage.restoreNote(…)` | `restoreNote` | deleted in slice 7 |
| `js/app.js` | [1894](../../js/app.js#L1894) | `App.permanentlyDeleteNoteById` | `Storage.permanentlyDeleteNote(…)` | `deleteNotePermanently` | deleted in slice 7 |
| `js/app.js` | [1925](../../js/app.js#L1925) | `App.convertNoteToTemplate` | `Storage.updateNote({folderId, isTemplate})` | `convertNoteToTemplate` | deleted in slice 7 |
| `js/app.js` | [1942](../../js/app.js#L1942) | `App.convertTemplateToNote` | `Storage.updateNote({isTemplate})` | `convertTemplateToNote` | deleted in slice 7 |
| `js/app.js` | [1985](../../js/app.js#L1985) | `App.emptyTrash` | `Storage.emptyTrash()` | `emptyTrash` | deleted in slice 7 |
| `js/app.js` | [1998](../../js/app.js#L1998) | `App.runTrashCleanup` | `Storage.cleanupTrash(…)` | `runTrashCleanup` | deleted in slice 7 |
| `js/app.js` | [2056](../../js/app.js#L2056) | `App.toggleSidebar` | `Storage.setSetting('sidebarOpen', …)` | `setPreferences` | deleted in slice 7 |
| `js/app.js` | [2363](../../js/app.js#L2363) | `App.renderFolderTree > click listener` | `Storage.updateFolder({collapsed})` | `setFolderCollapsed` | deleted in slice 7 |
| `js/app.js` | [2387](../../js/app.js#L2387) | `App.renderFolderTree > drop listener` | `Storage.moveNoteToFolder(…)` | `moveNoteToFolder` | deleted in slice 7 |
| `js/app.js` | [2395](../../js/app.js#L2395) | `App.renderFolderTree > drop listener` | `Storage.updateFolder({parentId})` | `moveFolder` | deleted in slice 7 |
| `js/app.js` | [2583](../../js/app.js#L2583) | `App.toggleNotePin` | `Storage.updateNote({pinned})` | `setPinned` | deleted in slice 7 |
| `js/app.js` | [3043](../../js/app.js#L3043) | `App.executeCommandPaletteItem` | `Storage.ensureDailyNote()` | `ensureDailyNote` | deleted in slice 7 |
| `js/app.js` | [3122](../../js/app.js#L3122) | `App.loadAIPromptTemplates` | `Storage.setSetting('aiPromptTemplates', …)` | `saveAIPromptTemplates` | deleted in slice 7 |
| `js/app.js` | [3351](../../js/app.js#L3351) | `App.refreshNoteMetadataAfterInsert` | `Storage.updateNote({preview, todoProgress})` | `insertBlocks` | deleted in slice 7 |
| `js/app.js` | [3359](../../js/app.js#L3359) | `App.refreshNoteMetadataAfterInsert` | `Storage.updateNoteLinks(…)` | `insertBlocks` | deleted in slice 7 |
| `js/app.js` | [3545](../../js/app.js#L3545) | `App.openNoteByName` | `Storage.createNote(…)` | `createNote` | kernel command, slice 4 |
| `js/app.js` | [3589](../../js/app.js#L3589) | `App.appendAIResponseToNote` | `Storage.saveElements(…)` | `insertBlocks` | deleted in slice 7 |
| `js/app.js` | [3609](../../js/app.js#L3609) | `App.createNoteFromAIResponse` | `Storage.createNote(…)` | `createNote` | deleted in slice 7 |
| `js/app.js` | [3612](../../js/app.js#L3612) | `App.createNoteFromAIResponse` | `Storage.saveElements(…)` | `createNote` | deleted in slice 7 |
| `js/app.js` | [3645](../../js/app.js#L3645) | `App.generateTitleForNewNote` | `Storage.updateNote({lastAutoTitleAt, name})` | `applyDerivedTitle` | deleted in slice 7 |
| `js/app.js` | [3928](../../js/app.js#L3928) | `App.importNote` | `Storage.createNote(…)` | `importNote` | deleted in slice 7 |
| `js/app.js` | [3939](../../js/app.js#L3939) | `App.importNote` | `Storage.saveElement(…)` | `importNote` | deleted in slice 7 |
| `js/app.js` | [3961](../../js/app.js#L3961) | `App.importNote` | `Storage.createNote(…)` | `importNote` | deleted in slice 7 |
| `js/app.js` | [3972](../../js/app.js#L3972) | `App.importNote` | `Storage.saveElement(…)` | `importNote` | deleted in slice 7 |
| `js/app.js` | [4109](../../js/app.js#L4109) | `App.runAutoTitle` | `Storage.setSetting('lastAutoTitleRun', …)` | `recordJobRun` | deleted in slice 7 |
| `js/app.js` | [4181](../../js/app.js#L4181) | `App.runAutoTitle` | `Storage.updateNote({lastAutoTitleAt, lastTitleContentHash, name})` | `applyDerivedTitle` | deleted in slice 7 |
| `js/app.js` | [4412](../../js/app.js#L4412) | `App.runInsightsExtraction` | `Storage.setSetting('lastInsightsRun', …)` | `recordJobRun` | deleted in slice 7 |
| `js/app.js` | [4455](../../js/app.js#L4455) | `App.runInsightsExtraction` | `Storage.updateNote({insights, lastInsightsContentHash, lastInsightsExtractedAt})` | `attachInsights` | deleted in slice 7 |
| `js/app.js` | [4561](../../js/app.js#L4561) | `App.showFolderContextMenu > action` | `Storage.updateFolder({name})` | `renameFolder` | deleted in slice 7 |
| `js/app.js` | [4571](../../js/app.js#L4571) | `App.showFolderContextMenu > action` | `Storage.deleteFolder(…)` | `deleteFolder` | deleted in slice 7 |
| `js/app.js` | [4580](../../js/app.js#L4580) | `App.showFolderContextMenu > action` | `Storage.createNote(…)` | `createNote` | deleted in slice 7 |
| `js/app.js` | [4582](../../js/app.js#L4582) | `App.showFolderContextMenu > action` | `Storage.updateNote({folderId})` | `moveNoteToFolder` | deleted in slice 7 |
| `js/app.js` | [4592](../../js/app.js#L4592) | `App.showFolderContextMenu > action` | `Storage.updateFolder({parentId})` | `moveFolder` | deleted in slice 7 |
| `js/app.js` | [4698](../../js/app.js#L4698) | `App.initIndexer > onmessage` | `Storage.setSearchIndex(…)` | `updateSearchIndex` | deleted in slice 7 |
| `js/app.js` | [4759](../../js/app.js#L4759) | `App.updateMissingEmbeddings` | `Storage.saveVector(…)` | `saveVector` | deleted in slice 7 |
| `js/app.js` | [5009](../../js/app.js#L5009) | `App.setupShortcuts > keydown listener` | `Storage.ensureDailyNote()` | `ensureDailyNote` | deleted in slice 7 |
| `js/controllers/ai-chat-controller.js` | [158](../../js/controllers/ai-chat-controller.js#L158) | `AIChatController.setupAI > keydown listener` | `this.storage.ensureDailyNote()` | `ensureDailyNote` | kernel command, slice 4 |
| `js/controllers/ai-chat-controller.js` | [275](../../js/controllers/ai-chat-controller.js#L275) | `AIChatController.setupAISidebarResize > onResizeEnd` | `this.storage.setSetting('aiSidebarWidth', …)` | `setPreferences` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [370](../../js/controllers/ai-chat-controller.js#L370) | `AIChatController.saveNoteChatHistory` | `this.storage.setSetting('aiChatHistory', …)` | `saveChatHistory` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [371](../../js/controllers/ai-chat-controller.js#L371) | `AIChatController.saveNoteChatHistory` | `this.storage.setSetting('noteChatMessages', …)` | `saveChatHistory` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [375](../../js/controllers/ai-chat-controller.js#L375) | `AIChatController.saveGlobalChatHistory` | `this.storage.setSetting('globalChatHistory', …)` | `saveChatHistory` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [376](../../js/controllers/ai-chat-controller.js#L376) | `AIChatController.saveGlobalChatHistory` | `this.storage.setSetting('globalChatMessages', …)` | `saveChatHistory` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [1447](../../js/controllers/ai-chat-controller.js#L1447) | `AIChatController.extractInsightsFromChat` | `this.storage.updateNote({insights, lastInsightsExtractedAt})` | `attachInsights` | kernel command, slice 4 |
| `js/controllers/ai-chat-controller.js` | [1860](../../js/controllers/ai-chat-controller.js#L1860) | `AIChatController.applyGeneratedTitle` | `this.storage.updateNote({lastAutoTitleAt, name})` | `renameNote` | kernel command, slice 4 |
| `js/controllers/ai-chat-controller.js` | [2075](../../js/controllers/ai-chat-controller.js#L2075) | `AIChatController.refreshNoteMetadataAfterInsert` | `this.storage.updateNote({preview, todoProgress})` | `insertBlocks` | kernel command, slice 4 |
| `js/controllers/ai-chat-controller.js` | [2083](../../js/controllers/ai-chat-controller.js#L2083) | `AIChatController.refreshNoteMetadataAfterInsert` | `this.storage.updateNoteLinks(…)` | `insertBlocks` | kernel command, slice 4 |
| `js/controllers/ai-chat-controller.js` | [2113](../../js/controllers/ai-chat-controller.js#L2113) | `AIChatController.appendAIResponseToNote` | `this.storage.saveElement(…)` | `insertBlocks` | kernel command, slice 4 |
| `js/controllers/ai-chat-controller.js` | [2124](../../js/controllers/ai-chat-controller.js#L2124) | `AIChatController.appendAIResponseToNote` | `this.storage.saveElements(…)` | `insertBlocks` | kernel command, slice 4 |
| `js/controllers/ai-chat-controller.js` | [2141](../../js/controllers/ai-chat-controller.js#L2141) | `AIChatController.createNoteFromAIResponse` | `this.storage.createNote(…)` | `createNote` | kernel command, slice 4 |
| `js/controllers/ai-chat-controller.js` | [2144](../../js/controllers/ai-chat-controller.js#L2144) | `AIChatController.createNoteFromAIResponse` | `this.storage.saveElements(…)` | `createNote` | kernel command, slice 4 |
| `js/controllers/ai-chat-controller.js` | [2171](../../js/controllers/ai-chat-controller.js#L2171) | `AIChatController.generateTitleForNewNote` | `this.storage.updateNote({lastAutoTitleAt, name})` | `applyDerivedTitle` | kernel command, slice 4 |
| `js/controllers/ai-chat-controller.js` | [2456](../../js/controllers/ai-chat-controller.js#L2456) | `AIChatController.loadAIPromptTemplates` | `this.storage.setSetting('aiPromptTemplates', …)` | `saveAIPromptTemplates` | kernel command, slice 6 |
| `js/controllers/ai-chat-controller.js` | [2470](../../js/controllers/ai-chat-controller.js#L2470) | `AIChatController.persistAIPromptTemplates` | `this.storage.setSetting('aiPromptTemplates', …)` | `saveAIPromptTemplates` | kernel command, slice 6 |
| `js/controllers/notes-manager.js` | [96](../../js/controllers/notes-manager.js#L96) | `NotesManager.archiveNote` | `this.storage.archiveNote(…)` | `archiveNote` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [118](../../js/controllers/notes-manager.js#L118) | `NotesManager.unarchiveNote` | `this.storage.unarchiveNote(…)` | `unarchiveNote` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [128](../../js/controllers/notes-manager.js#L128) | `NotesManager.trashNoteById` | `this.storage.trashNote(…)` | `trashNote` | kernel command, slice 5 |
| `js/controllers/notes-manager.js` | [143](../../js/controllers/notes-manager.js#L143) | `NotesManager.restoreNoteById` | `this.storage.restoreNote(…)` | `restoreNote` | kernel command, slice 5 |
| `js/controllers/notes-manager.js` | [157](../../js/controllers/notes-manager.js#L157) | `NotesManager.permanentlyDeleteNoteById` | `this.storage.permanentlyDeleteNote(…)` | `deleteNotePermanently` | kernel command, slice 5 |
| `js/controllers/notes-manager.js` | [178](../../js/controllers/notes-manager.js#L178) | `NotesManager.convertNoteToTemplate` | `this.storage.updateNote({folderId, isTemplate})` | `convertNoteToTemplate` | kernel command, slice 5 |
| `js/controllers/notes-manager.js` | [191](../../js/controllers/notes-manager.js#L191) | `NotesManager.convertTemplateToNote` | `this.storage.updateNote({isTemplate})` | `convertTemplateToNote` | kernel command, slice 5 |
| `js/controllers/notes-manager.js` | [336](../../js/controllers/notes-manager.js#L336) | `NotesManager.importNote` | `this.storage.createNote(…)` | `importNote` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [347](../../js/controllers/notes-manager.js#L347) | `NotesManager.importNote` | `this.storage.saveElement(…)` | `importNote` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [369](../../js/controllers/notes-manager.js#L369) | `NotesManager.importNote` | `this.storage.createNote(…)` | `importNote` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [380](../../js/controllers/notes-manager.js#L380) | `NotesManager.importNote` | `this.storage.saveElement(…)` | `importNote` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [459](../../js/controllers/notes-manager.js#L459) | `NotesManager.generateTitleForNote` | `this.storage.updateNote({lastAutoTitleAt, name})` | `renameNote` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [508](../../js/controllers/notes-manager.js#L508) | `NotesManager.extractInsightsForNote` | `this.storage.setSetting('insightsExtracting_${…}', …)` | `setInsightsPending` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [555](../../js/controllers/notes-manager.js#L555) | `NotesManager.extractInsightsForNote` | `this.storage.updateNote({insights, lastInsightsContentHash, lastInsightsExtractedAt})` | `attachInsights` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [579](../../js/controllers/notes-manager.js#L579) | `NotesManager.extractInsightsForNote` | `this.storage.setSetting('insightsExtracting_${…}', …)` | `setInsightsPending` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [707](../../js/controllers/notes-manager.js#L707) | `NotesManager.runAutoTitle` | `this.storage.setSetting('lastAutoTitleRun', …)` | `recordJobRun` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [762](../../js/controllers/notes-manager.js#L762) | `NotesManager.runAutoTitle` | `this.storage.updateNote({lastAutoTitleAt, lastTitleContentHash, name})` | `applyDerivedTitle` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [806](../../js/controllers/notes-manager.js#L806) | `NotesManager.updateAutoTitleSettings` | `this.storage.setSetting('autoTitleEnabled', …)` | `setPreferences` | no live caller |
| `js/controllers/notes-manager.js` | [807](../../js/controllers/notes-manager.js#L807) | `NotesManager.updateAutoTitleSettings` | `this.storage.setSetting('autoTitleInterval', …)` | `setPreferences` | no live caller |
| `js/controllers/notes-manager.js` | [888](../../js/controllers/notes-manager.js#L888) | `NotesManager.runInsightsExtraction` | `this.storage.setSetting('lastInsightsRun', …)` | `recordJobRun` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [918](../../js/controllers/notes-manager.js#L918) | `NotesManager.runInsightsExtraction` | `this.storage.updateNote({insights, lastInsightsContentHash, lastInsightsExtractedAt})` | `attachInsights` | kernel command, slice 4 |
| `js/controllers/notes-manager.js` | [978](../../js/controllers/notes-manager.js#L978) | `NotesManager.updateInsightsSettings` | `this.storage.setSetting('insightsEnabled', …)` | `setPreferences` | no live caller |
| `js/controllers/notes-manager.js` | [979](../../js/controllers/notes-manager.js#L979) | `NotesManager.updateInsightsSettings` | `this.storage.setSetting('insightsInterval', …)` | `setPreferences` | no live caller |
| `js/controllers/notes-manager.js` | [1022](../../js/controllers/notes-manager.js#L1022) | `NotesManager.initIndexer > onmessage` | `this.storage.setSearchIndex(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1026](../../js/controllers/notes-manager.js#L1026) | `NotesManager.initIndexer > onmessage` | `this.storage.setSearchIndexEntry(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1030](../../js/controllers/notes-manager.js#L1030) | `NotesManager.initIndexer > onmessage` | `this.storage.removeSearchIndexEntry(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1137](../../js/controllers/notes-manager.js#L1137) | `NotesManager.updateMissingEmbeddings` | `this.storage.saveVector(…)` | `saveVector` | ledgered to #22 |
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
| `js/editor.js` | [526](../../js/editor.js#L526) | `BlockEditor.renderInsights` | `Storage.setSetting('insightsExtracting_${…}', …)` | `setInsightsPending` | kernel command, slice 4 |
| `js/editor.js` | [817](../../js/editor.js#L817) | `BlockEditor.refreshInsights` | `Storage.updateNote({insights, lastInsightsExtractedAt})` | `attachInsights` | kernel command, slice 4 |
| `js/editor.js` | [5202](../../js/editor.js#L5202) | `BlockEditor._autoSnapshot` | `Storage.saveSnapshot(…)` | `saveSnapshot` | kernel command, slice 4 |
| `js/editor.js` | [5400](../../js/editor.js#L5400) | `BlockEditor._revertToSnapshot` | `Storage.saveSnapshot(…)` | `restoreSnapshot` | kernel command, slice 4 |
| `js/editor.js` | [5409](../../js/editor.js#L5409) | `BlockEditor._revertToSnapshot` | `Storage.deleteElements(…)` | `restoreSnapshot` | kernel command, slice 4 |
| `js/editor.js` | [5422](../../js/editor.js#L5422) | `BlockEditor._revertToSnapshot` | `Storage.saveElement(…)` | `restoreSnapshot` | kernel command, slice 4 |
| `js/editor.js` | [5429](../../js/editor.js#L5429) | `BlockEditor._revertToSnapshot` | `Storage.updateNote({name})` | `restoreSnapshot` | kernel command, slice 4 |
| `js/llm.js` | [130](../../js/llm.js#L130) | `LLMService.setEndpoint` | `Storage.setSetting('llmEndpoint', …)` | `saveProviderSettings` | no live caller |
| `js/llm.js` | [662](../../js/llm.js#L662) | `LLMService.setProvider` | `Storage.setSetting('llmProvider', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [674](../../js/llm.js#L674) | `LLMService.setApiKey` | `Storage.setSetting('llmApiKey', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [682](../../js/llm.js#L682) | `LLMService.setModel` | `Storage.setSetting('llmModel', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [687](../../js/llm.js#L687) | `LLMService.setOllamaUrl` | `Storage.setSetting('ollamaUrl', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/onboarding.js` | [48](../../js/onboarding.js#L48) | `OnboardingManager.setupFirstRun` | `Storage.setSetting('embeddingsEnabled', …)` | `setPreferences` | kernel command, slice 6 |
| `js/onboarding.js` | [49](../../js/onboarding.js#L49) | `OnboardingManager.setupFirstRun` | `Storage.setSetting('autoTitleEnabled', …)` | `setPreferences` | kernel command, slice 6 |
| `js/onboarding.js` | [50](../../js/onboarding.js#L50) | `OnboardingManager.setupFirstRun` | `Storage.setSetting('insightsEnabled', …)` | `setPreferences` | kernel command, slice 6 |
| `js/onboarding.js` | [66](../../js/onboarding.js#L66) | `OnboardingManager.markComplete` | `Storage.setSetting('hasCompletedOnboarding', …)` | `completeOnboarding` | kernel command, slice 6 |
| `js/services/sync-service.js` | [300](../../js/services/sync-service.js#L300) | `SyncService.connect` | `this.storage.setSetting('syncProvider', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [302](../../js/services/sync-service.js#L302) | `SyncService.connect` | `this.storage.setSetting('syncWebdavConfig', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [326](../../js/services/sync-service.js#L326) | `SyncService.disconnect` | `this.storage.setSetting('syncProvider', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [327](../../js/services/sync-service.js#L327) | `SyncService.disconnect` | `this.storage.setSetting('syncWebdavConfig', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [328](../../js/services/sync-service.js#L328) | `SyncService.disconnect` | `this.storage.setSetting('syncLastSyncAt', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [419](../../js/services/sync-service.js#L419) | `SyncService.sync` | `this.storage.setSetting('syncLastSyncAt', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [490](../../js/services/sync-service.js#L490) | `SyncService._applyResolution` | `this.storage.importNote(…)` | `applyRemoteChanges` | ledgered to #19 |
| `js/services/sync-service.js` | [496](../../js/services/sync-service.js#L496) | `SyncService._applyResolution` | `this.storage.saveElement(…)` | `applyRemoteChanges` | ledgered to #19 |
| `js/services/sync-service.js` | [514](../../js/services/sync-service.js#L514) | `SyncService._applyRemoteData` | `this.storage.importAll(…)` | `applyRemoteChanges` | ledgered to #19 |
| `js/ui/export-notice.js` | [151](../../js/ui/export-notice.js#L151) | `ExportNotice.record > write` | `this.storage.setSetting('preMigrationNotice', …)` | `recordExportNotice` | kernel command, slice 6 |
