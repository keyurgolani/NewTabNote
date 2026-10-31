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
| deleted in slice 7 | 0 | App's copy of a controller path. It runs only after an `if (this.<controller>)` check has handed off to that controller and returned, or in that check's else branch, or nothing reaches it from App's bootstrap and the methods `js/editor.js` calls. Slice 7 deletes it with App's fallback bodies. The command is the one the controller path becomes. |
| no live caller | 0 | Nothing in `js/` refers to the method or function the write sits in, so the write never runs. Deleting it drops the row. The command is what the call would become. |
| ledgered to #11 | 4 | Provider settings and keys, which #11's provider registry takes over (#21 reviews the key rows). |
| ledgered to #19 | 9 | The sync service, which #19's sync engine replaces. |
| ledgered to #22 | 4 | The search index and vectors, which #22's pipelines own. |
| UI-only | 0 | Persists nothing a kernel aggregate or the settings port owns. |
| Total | 17 | |

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
| `saveProviderSettings` | ledgered to #11 | 4 |
| `saveSyncSettings` | ledgered to #19 | 6 |
| `applyRemoteChanges` | ledgered to #19 | 3 |
| `updateSearchIndex` | ledgered to #22 | 3 |
| `saveVector` | ledgered to #22 | 1 |

Rows marked "deleted in slice 7" or "no live caller" are counted under the command the call would become.

Routed ahead of their slice: the sidebar folder menu's Add Note to Folder files its new note with `createNote`'s `folderId` (#12 slice 4c2), so the slice 5 `moveNoteToFolder` row that set the folder after the create went with the slice 4 `createNote` row.

## Calls

Method is the class method or function the call sits in. After `>` comes the anonymous or nested function inside it, when where it sits says what it's for: a listener, a callback property such as `onResizeEnd`, or a menu item's `action`. An update's Call lists the fields it sets.

| File | Line | Method | Call | Command | Status |
| --- | --- | --- | --- | --- | --- |
| `js/controllers/notes-manager.js` | [1194](../../js/controllers/notes-manager.js#L1194) | `NotesManager.initIndexer > onmessage` | `this.storage.setSearchIndex(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1198](../../js/controllers/notes-manager.js#L1198) | `NotesManager.initIndexer > onmessage` | `this.storage.setSearchIndexEntry(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1202](../../js/controllers/notes-manager.js#L1202) | `NotesManager.initIndexer > onmessage` | `this.storage.removeSearchIndexEntry(…)` | `updateSearchIndex` | ledgered to #22 |
| `js/controllers/notes-manager.js` | [1320](../../js/controllers/notes-manager.js#L1320) | `NotesManager.updateMissingEmbeddings` | `this.storage.saveVector(…)` | `saveVector` | ledgered to #22 |
| `js/llm.js` | [659](../../js/llm.js#L659) | `LLMService.setProvider` | `Storage.setSetting('llmProvider', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [671](../../js/llm.js#L671) | `LLMService.setApiKey` | `Storage.setSetting('llmApiKey', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [679](../../js/llm.js#L679) | `LLMService.setModel` | `Storage.setSetting('llmModel', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/llm.js` | [684](../../js/llm.js#L684) | `LLMService.setOllamaUrl` | `Storage.setSetting('ollamaUrl', …)` | `saveProviderSettings` | ledgered to #11 |
| `js/services/sync-service.js` | [299](../../js/services/sync-service.js#L299) | `SyncService.connect` | `this.storage.setSetting('syncProvider', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [301](../../js/services/sync-service.js#L301) | `SyncService.connect` | `this.storage.setSetting('syncWebdavConfig', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [325](../../js/services/sync-service.js#L325) | `SyncService.disconnect` | `this.storage.setSetting('syncProvider', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [326](../../js/services/sync-service.js#L326) | `SyncService.disconnect` | `this.storage.setSetting('syncWebdavConfig', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [327](../../js/services/sync-service.js#L327) | `SyncService.disconnect` | `this.storage.setSetting('syncLastSyncAt', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [418](../../js/services/sync-service.js#L418) | `SyncService.sync` | `this.storage.setSetting('syncLastSyncAt', …)` | `saveSyncSettings` | ledgered to #19 |
| `js/services/sync-service.js` | [489](../../js/services/sync-service.js#L489) | `SyncService._applyResolution` | `this.storage.importNote(…)` | `applyRemoteChanges` | ledgered to #19 |
| `js/services/sync-service.js` | [495](../../js/services/sync-service.js#L495) | `SyncService._applyResolution` | `this.storage.saveElement(…)` | `applyRemoteChanges` | ledgered to #19 |
| `js/services/sync-service.js` | [513](../../js/services/sync-service.js#L513) | `SyncService._applyRemoteData` | `this.storage.importAll(…)` | `applyRemoteChanges` | ledgered to #19 |
