# Write paths

Every mutating persistence call in `js/` outside `js/storage.js` (and outside `js/lib/` and `js/kernel/`), the intent-level kernel command it becomes, and when. #12's acceptance criteria need each row to go through a kernel command or stay ledgered to #11, #19, or #22. #12 slice 2 mapped them.

Network writes (sync uploads, AI provider requests) aren't listed. They go through `fetch`, which the kernel boundary rules ledger to #19 and #11.

Written by `npm run check:write-paths -- --write` from `scripts/write-paths.js`, which says what counts as a mutating call and holds the rules below. `npm test` fails when a call is added, removed, moved to another function, or reclassified until this file is rewritten. Line numbers are where the calls were when it was last written.

## Statuses

| Status | Rows | Meaning |
| --- | --- | --- |
| kernel command, slice 4 | 0 | #12 slice 4 (notes and blocks) routes it through the command. |
| kernel command, slice 5 | 0 | #12 slice 5 (folders, templates, trash) routes it through the command. |
| kernel command, slice 6 | 0 | #12 slice 6 (preferences and session) routes it through the command. |
| no live caller | 0 | Nothing in `js/` refers to the method or function the write sits in, so the write never runs. Deleting it drops the row. The command is what the call would become. |
| ledgered to #11 | 6 | Provider settings and keys, which #11's provider registry takes over (#21 reviews the key rows). |
| ledgered to #19 | 9 | The sync service, which #19's sync engine replaces. |
| ledgered to #22 | 4 | The search index and vectors, which #22's pipelines own. |
| UI-only | 0 | Persists nothing a kernel aggregate or the settings port owns. |
| Total | 19 | |

No row is UI-only. Presentation state (panels, the palette index, selection mode, the calendar month) isn't persisted, and every persisted preference goes through the settings port.

## Commands

| Command | Status | Rows |
| --- | --- | --- |
| `runStartupMaintenance` | kernel command, slice 4 | 0 |
| `createNote` | kernel command, slice 4 | 0 |
| `ensureDailyNote` | kernel command, slice 4 | 0 |
| `captureToDailyNote` | kernel command, slice 4 | 0 |
| `saveNoteContent` | kernel command, slice 4 | 0 |
| `insertBlocks` | kernel command, slice 4 | 0 |
| `deleteBlocks` | kernel command, slice 4 | 0 |
| `saveSnapshot` | kernel command, slice 4 | 0 |
| `restoreSnapshot` | kernel command, slice 4 | 0 |
| `renameNote` | kernel command, slice 4 | 0 |
| `setPinned` | kernel command, slice 4 | 0 |
| `archiveNote` | kernel command, slice 4 | 0 |
| `unarchiveNote` | kernel command, slice 4 | 0 |
| `applyDerivedTitle` | kernel command, slice 4 | 0 |
| `attachInsights` | kernel command, slice 4 | 0 |
| `setInsightsPending` | kernel command, slice 4 | 0 |
| `recordJobRun` | kernel command, slice 4 | 0 |
| `createFolder` | kernel command, slice 5 | 0 |
| `renameFolder` | kernel command, slice 5 | 0 |
| `moveFolder` | kernel command, slice 5 | 0 |
| `setFolderCollapsed` | kernel command, slice 5 | 0 |
| `deleteFolder` | kernel command, slice 5 | 0 |
| `moveNoteToFolder` | kernel command, slice 5 | 0 |
| `convertNoteToTemplate` | kernel command, slice 5 | 0 |
| `convertTemplateToNote` | kernel command, slice 5 | 0 |
| `trashNote` | kernel command, slice 5 | 0 |
| `restoreNote` | kernel command, slice 5 | 0 |
| `deleteNotePermanently` | kernel command, slice 5 | 0 |
| `emptyTrash` | kernel command, slice 5 | 0 |
| `runTrashCleanup` | kernel command, slice 5 | 0 |
| `runBulkAction` | kernel command, slice 5 | 0 |
| `setPreferences` | kernel command, slice 6 | 0 |
| `saveWorkspaceSession` | kernel command, slice 6 | 0 |
| `saveChatHistory` | kernel command, slice 6 | 0 |
| `savePromptTemplates` | kernel command, slice 6 | 0 |
| `saveTheme` | kernel command, slice 6 | 0 |
| `completeOnboarding` | kernel command, slice 6 | 0 |
| `recordBackup` | kernel command, slice 6 | 0 |
| `recordExportNotice` | kernel command, slice 6 | 0 |
| `createAutoBackup` | kernel command, slice 6 | 0 |
| `importBackup` | kernel command, slice 6 | 0 |
| `saveProviderSettings` | ledgered to #11 | 6 |
| `saveSyncSettings` | ledgered to #19 | 6 |
| `applyRemoteChanges` | ledgered to #19 | 3 |
| `updateSearchIndex` | ledgered to #22 | 3 |
| `saveVector` | ledgered to #22 | 1 |

Rows marked "no live caller" are counted under the command the call would become.

Routed ahead of their slice: the sidebar folder menu's Add Note to Folder files its new note with `createNote`'s `folderId` (#12 slice 4c2), so the slice 5 `moveNoteToFolder` row that set the folder after the create went with the slice 4 `createNote` row.

## Calls

Method is the class method or function the call sits in. After `>` comes the anonymous or nested function inside it, when where it sits says what it's for: a listener, a callback property such as `onResizeEnd`, or a menu item's `action`. An update's Call lists the fields it sets.

| File | Line | Method | Call | Command | Status |
| --- | --- | --- | --- | --- | --- |
| `js/controllers/notes-manager.js` | [1167](../../js/controllers/notes-manager.js#L1167) | `NotesManager.initIndexer > onmessage` | `this.storage.setSearchIndex(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1177](../../js/controllers/notes-manager.js#L1177) | `NotesManager.initIndexer > onmessage` | `this.storage.setSearchIndexEntry(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1181](../../js/controllers/notes-manager.js#L1181) | `NotesManager.initIndexer > onmessage` | `this.storage.removeSearchIndexEntry(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1307](../../js/controllers/notes-manager.js#L1307) | `NotesManager.updateMissingEmbeddings` | `this.storage.saveVector(…)` | `saveVector` | ledgered to #22 |
| `js/llm.js` | [138](../../js/llm.js#L138) | `LLMService.init` | `Storage.setSetting('llmApiKeyProvider', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [756](../../js/llm.js#L756) | `LLMService.setProvider` | `Storage.setSetting('llmProvider', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [775](../../js/llm.js#L775) | `LLMService.setApiKey` | `Storage.setSetting('llmApiKey', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [776](../../js/llm.js#L776) | `LLMService.setApiKey` | `Storage.setSetting('llmApiKeyProvider', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [784](../../js/llm.js#L784) | `LLMService.setModel` | `Storage.setSetting('llmModel', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [789](../../js/llm.js#L789) | `LLMService.setOllamaUrl` | `Storage.setSetting('ollamaUrl', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/services/sync-service.js` | [293](../../js/services/sync-service.js#L293) | `SyncService.connect` | `this.storage.setSetting('syncWebdavConfig', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [307](../../js/services/sync-service.js#L307) | `SyncService.connect` | `this.storage.setSetting('syncProvider', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [325](../../js/services/sync-service.js#L325) | `SyncService.disconnect` | `this.storage.setSetting('syncProvider', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [326](../../js/services/sync-service.js#L326) | `SyncService.disconnect` | `this.storage.setSetting('syncWebdavConfig', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [327](../../js/services/sync-service.js#L327) | `SyncService.disconnect` | `this.storage.setSetting('syncLastSyncAt', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [417](../../js/services/sync-service.js#L417) | `SyncService.sync` | `this.storage.setSetting('syncLastSyncAt', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [488](../../js/services/sync-service.js#L488) | `SyncService._applyResolution` | `this.storage.importNote(…)` | `applyRemoteChanges` | ledgered to #19 |
| `js/services/sync-service.js` | [494](../../js/services/sync-service.js#L494) | `SyncService._applyResolution` | `this.storage.saveElement(…)` | `applyRemoteChanges` | ledgered to #19 |
| `js/services/sync-service.js` | [512](../../js/services/sync-service.js#L512) | `SyncService._applyRemoteData` | `this.storage.importAll(…)` | `applyRemoteChanges` | ledgered to #19 |
