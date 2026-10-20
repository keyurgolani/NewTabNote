# Continuity Canvas: product and navigation model

- Status: Accepted ([#1][i1] slice 1). The owner questions are open, and each proposed default ships until the owner answers.
- Date: 2026-10-20
- Browser check: run headless on Chrome for Testing 156 in place of #1's manual stable-Chrome check, a recorded deviation, since stable Chrome ignores `--load-extension` and can't be automated. Every engine row that decides slice 2's contracts passed. Four UI rows stay open as manual checks in stable Chrome, carried by [#30][i30] ([Browser check](#browser-check)).

This record defines the topology every surface builds on: Moment and Workspace as two apertures of one document, entry points, URLs and history, note placement, and the rules no aperture may break. #1 ships as this record, pure tested modules (slice 2), versioned preference records, and a feature-parity inventory (slice 3). Nothing here changes what users see until [#2][i2] (Moment shell) and [#3][i3] (Workspace shell) load the modules.

## Starting point

At `3706d84` (1.4.0):

- `newtab.html` is the single new-tab override ([`manifest.json` L6-L8][m-override]), and [`App.init`][app-init] loads every note list and starts eight controllers before it loads a note.
- First-party `js/` has no `pushState`, `location.hash`, or `document.title`, and every tab keeps the static title "New Tab Note" ([`newtab.html` L7][newtab-title]).
- Every new tab opens the cached `lastOpenedNoteId` (`App.init` above) and restores the one shared tab set, which [`saveTabs`][save-tabs] overwrites from any tab.
- The toolbar click opens the Side Panel, with `popup.html` only as a fallback tab ([`background.js` L24-L36][bg-action]), and Side Panel "Open" opens a bare `newtab.html` ([`sidepanel.js` L52-L54][sp-open]).

## Decisions

1. A brand-new tab opens a pristine, writable Moment by default. Workspace and last-used are explicit user choices, and features are reorganized, never removed. This is the owner's decision from the 2026-10-18 direction review.
2. Open Workspace unfolds the rail, collection, and inspector around the same canvas, and Return to Moment folds them away, with no navigation, reload, or new tab. Moment and Workspace tabs coexist, each with its own aperture, route, and layout, over one repository.
3. The rail and destinations follow the approved review board: Inbox, Daily, Projects, and Templates, then Search, Insights, Trust, and Settings. This replaces the rail in the owner's earlier topology (Inbox, Daily Notes, Library, Folders, Templates, Graph, Insights, Archive, Trash). Folders become Projects collections (nesting and Unfiled: open, Q2), notes list by placement under Inbox, Daily, and Projects instead of a separate Library, Graph and Analytics sit under Insights, Archive is a collection view, and so is Trash (open, Q4). No feature is dropped.
4. Every baseline feature keeps exactly one home. The onboarding tour is the only one replaced (owner decision), by three Moment tips from [#23][i23].

## Owner questions

All six are open. The proposed default ships until the owner answers, and the rest of this record tags each one where it applies, as (open, Q1) and so on.

| | Question | Proposed default |
| --- | --- | --- |
| Q1 | Toolbar click, for new and upgraded installs | The Popup, as `action.default_popup`, with Open Workspace and Open Side Panel. Built by [#4][i4] and [#5][i5]. The other answer, the Side Panel as today, only flips the default of #4's `toolbarAction` record. |
| Q2 | Titled root notes, and folders | Titled root notes in Unfiled under Projects, and folders as nested Projects collections |
| Q3 | Note titles in tab titles | No |
| Q4 | Homes for Picture-in-Picture, Trash, and global chat | PiP as a canvas action, Trash as a collection view beside Archive, and global RAG chat as "Ask across notes" under Search |
| Q5 | Touch or tablet-mode Chrome in scope | Google Chrome stable on desktop (rule 12) |
| Q6 | Incognito capture | Typed text only, with a private-window label, no automatic page URL or title, and no context-menu or command capture. The other answer is no incognito capture at all. |

## Vocabulary

- `Aperture`: `moment` or `workspace`.
- `DefaultAperture`: an `Aperture` or `last-used`, stored as `defaultAperture`.
- `ProductSession`: one per `newtab.html` document, IDs only.
- `EditorSession` ([#6][i6]): live document state (working revision, caret, selection, undo).
- `Placement`: where a note is listed. Filing changes placement, never identity.

## Rules

1. A brand-new tab follows the default. `moment`, or a missing or invalid value, opens a pristine Moment with no note ID until the first meaningful input, never `lastOpenedNoteId` or another tab's capture. `workspace` acts like Open Workspace from a pristine Moment. `last-used` opens the stored aperture, else Moment.
2. A URL with a valid route (deep link, history entry, pinned Workspace tab) wins over the default.
3. Reload restores the tab's own `ProductSession`. A `reload`, or a `boot` with no valid URL, that finds a valid saved session restores it in full: aperture, route, note, and layout. A `boot` from a new navigation (`PerformanceNavigationTiming.type` `navigate`: a typed or bookmarked deep link, a `resolveOpenNote` tab) applies a valid URL even when a saved session exists, as `popstate` does. A cross-document Back or Forward (`back_forward`) applies the entry's URL with the `popstate` rules. Duplicated tabs and tabs restored after a browser restart report `back_forward` ([Browser check](#browser-check)), and they restore the session either way, since the current entry's URL tracks the session ([Routes and history](#routes-and-history)). With no valid session, a load applies a valid URL, else follows rule 1. On `popstate`, a valid URL with no `?note=` means no note, and a Moment URL keeps the session's route and layout. An unknown aperture counts as no URL. A new tab booting into Workspace from the default uses `replaceState` (no Back entry).
4. Last used is the aperture of the most recent explicit Open Workspace or Return to Moment in any tab, last write wins. A default change never changes an open tab.
5. Moment shows a labelled Open Workspace action, and Workspace shows Return to Moment in its top line. Neither is a modal.
6. From a Moment with a capture, Open Workspace keeps that note in the canvas as the active tab of the restored layout. From a pristine Moment it creates no note and shows the restored layout with its saved active document, or Inbox beside a pristine canvas when nothing is saved.
7. Return to Moment keeps the focused editor's note. From a route destination it keeps `ProductSession.noteId` (the last canvas note), or opens a pristine Moment when that is null. Document tabs, split view, inspector, and route wait in the `ProductSession`. The next Open Workspace restores the route only for a note destination (`inbox`, `daily`, `projects`, `templates`, `search`, `archive`, `trash`), since #3's route outlet covers the canvas, and otherwise opens the canvas note's home collection, or `inbox` with no note. Nothing closes, and Picture-in-Picture stays bound to its note.
8. Registration. The canvas element and editor root stay the same DOM nodes, and only canvas width and horizontal position change. The top line and tab strip sit outside the editor root, and the caret block's viewport offset stays within #6's tolerance.
9. Regions by width. At 1100 px (compact-shell width) and up, Workspace shows rail, collection, and canvas, with the inspector open or closed. From 720 px to below 1100 px, it shows rail plus canvas, with the collection one action away. Below 720 px, it uses the one-pane flow, with the canvas as the current pane.
10. `excerptVisibility` applies in Moment peeks (#2), Popup (#4), and Side Panel (#5). [#25][i25] (settings routes) renders it.
11. Titles. Moment is "NewTabNote", and Workspace is "<route label> · NewTabNote". No note title goes in the tab title (open, Q3).
12. Platforms. Google Chrome stable on desktop (open, Q5). [#27][i27] (route builds) sets `minimum_chrome_version` from the APIs in use. Other Chromium browsers are untested and not blocked.

## Moment and transition contracts

- Moment renders no Workspace navigation or administration.
- Whenever the Moment document has focus and no menu, open listbox, dialog, or other text control does, the first printable key reaches the editor once, except Space and Enter on a focused button or link, which activate it.
- Open Workspace and Return to Moment are in-place transitions of one document that keep note ID, working revision, content, cursor, selection, active block, undo history, scroll, and save state, under rules 8 and 9. #3 verifies the regions, and #6 verifies preservation and the same DOM node.
- Tabs stay independent. A brand-new Moment tab never gets another tab's note, and a new Workspace instance starts from a copy of the persisted layout snapshot, never from another open tab's live session. Open Workspace changes only the current tab, and any number of Workspace tabs may exist. Slice 2 tests this through `resolveLaunch` with fake open sessions, and #30 runs one Workspace tab beside two Moment tabs.

## Feature parity

Every baseline feature keeps exactly one home.

| Baseline feature | Home | Owner |
| --- | --- | --- |
| Document tabs, split view | Canvas tab strip with one or two panes | #3 |
| Picture-in-Picture | Canvas action; the window views the same `EditorSession` (open, Q4) | #3, #6 |
| Focus mode | Workspace canvas mode. Moment does not replace it | #3 |
| Templates; daily notes, calendar; daily-note template | Templates; Daily Notes, the only place the calendar shows; `settings/general` | #3; #25 |
| Command palette; shortcuts list | Workspace top line on `Mod+Shift+A`; shortcuts as a settings route | #3, [#15][i15] (registries); #25 |
| Folders; pin, sort, list or cards, bulk actions; drag a block to the sidebar | Projects collection; collection headers and item actions; drops use the two verbs | #3 |
| Resizable sidebar, AI sidebar | Collection width; inspector width | #3 |
| Archive; Trash, retention, empty trash | Collection views (Trash: open, Q4); retention is a job | #3, [#35][i35] (job host) |
| Version history, backlinks; graph, analytics | Inspectors; Workspace routes | #3, [#22][i22] (search) |
| Keyword search; local semantic search | Search destination; its "Similar meaning" group | #3; #22 |
| Note chat, context-window indicator, block AI, insert preview, insights panel | AI inspector. Moment has no AI commands (#2) | [#11][i11] (remote AI) |
| Global RAG chat | "Ask across notes" route under Search (open, Q4) | #11, #22 |
| Auto-title and insights schedulers | `background` jobs | #35, [#8][i8] (recipes) |
| AI provider settings, prompt-template editor | `settings/intelligence` | #11, #25 |
| Themes (light, dark, system), font, editor width; Theme Builder | `settings/appearance`; the `theme-builder` route | [#16][i16] (design tokens), #25 |
| Settings navigation and search | `settings/<section>` routes and their search | #25 |
| Full export (JSON, Markdown ZIP, backup), full import, auto-backup | `settings/data` route | [#18][i18] (backup), #25 |
| Partial WebDAV sync | `settings/sync` route | [#19][i19] (sync), #25 |
| Single-note export; single-note import | Note menu; collection header | #3 |
| Onboarding walkthrough, quick-start prompt | Three Moment tips | #23 (activation) |
| Popup [`quickNoteInput`][popup-quick], [`renderDailySummary`][popup-daily], [`renderRecentNotes`][popup-recent]; Side Panel [`renderSummary`][sp-summary]; [context menus][bg-menus] and [`Alt+P`/`Alt+S`][m-commands] ([handler][bg-commands]) | `popup`: `popup-quick-note`, `popup-daily-summary`, `popup-recent-notes`; `side-panel`: `sidepanel-insights`; `background`: `capture-page`, `capture-selection` | #4; #5; #5, #35 |

Smart paste and the rest of the editor core from [#14][i14] (block registry) work in both apertures. The offscreen Ollama proxy ([`background.js` L114-L130][bg-ollama]) is transport and gets no entry, since `settings/intelligence` covers Ollama. The capture notification belongs to the capture entries, and its click is new.

## Routes and history

- `newtab.html#/moment[?note=<id>]` and `newtab.html#/workspace/<route>[?note=<id>]`. `<route>` comes from #15's navigation registry. Until then the module lists `inbox`, `daily`, `projects`, `templates`, `search`, `insights`, `trust`, `settings`, `graph`, `analytics`, `archive`, `trash`.
- URLs carry aperture, route, and an encoded note ID only. Never content, titles, search text, or page URLs.
- A fresh Moment never touches the URL, so the address bar stays empty for search. Open Workspace, Return to Moment, and Workspace route changes each push one history entry. Same-document Back and Forward apply it in place through `resolveLaunch` with trigger `popstate`, with no reload.
- Every pushed entry carries the canvas note as `?note=` when there is one. A canvas-note change outside a transition (document-tab switch, collection open, Continue, first input) rewrites the current entry's `?note=` with `replaceState`, except in a Moment whose URL is still bare (no hash), and except a one-pane stack step below 720 px, which pushes. So only a Moment whose URL has a hash (Return to Moment, a deep link, a `resolveOpenNote` tab) carries `?note=`, and `resolveOpenNote` never matches a bare one.
- Below 720 px, each step deeper into #3's one-pane stack (collection to note, note to inspector) pushes one entry with the same URL plus the new `?note=` and `{pane}` in `history.state`, which `resolveLaunch` takes and returns as `pane`. A `popstate` between entries that differ only in `pane` or `?note=` within one route restores that pane and note and keeps aperture, route, and layout.
- `ProductSession` is `{version: 1, aperture, route, noteId, layout}`, written to `sessionStorage` key `ntn.productSession` on change. [#12][i12]'s kernel holds the live instance.

From the browser check: a tab that started as a new tab keeps `chrome://newtab/` as its visible URL after these pushes, so its address bar most likely stays empty even in Workspace. Manual check 1 covers this in stable Chrome.

## Opening a note in a tab

`resolveOpenNote` takes a note ID or none (Workspace target), the two aperture records, and the tabs from #2's `readOpenTabs()` (`lastAccessed` needs Chrome 121, which raises #27's `minimum_chrome_version`). A current-window tab whose note matches is activated with `chrome.tabs.update`, aperture unchanged, else a new tab opens in the resolved default aperture. #6's slice 4 adds a `leaseHolder` input that supersedes the note match and activates the holder's tab in its own window. With no note, the current window's Workspace tab with the latest `lastAccessed` is activated, else a new tab opens at `#/workspace/inbox`.

From the browser check: of the worker APIs probed (`chrome.runtime.getContexts`, `chrome.tabs.get`, `chrome.tabs.query`, `chrome.tabs.update`), only `getContexts` shows a new tab's hash (in `documentUrl`), and `chrome.tabs.query` gives `lastAccessed` without the `tabs` permission.

## Entry points

| Entry | Opens | Built in |
| --- | --- | --- |
| New tab | `resolveLaunch` | #2 |
| Toolbar action | Recommended (open, Q1): an `action.default_popup` Popup with Open Workspace and Open Side Panel (`chrome.sidePanel.open` in the click handler). #4's `toolbarAction` record (`popup` or `side-panel`) switches it; until then the click opens the Side Panel. #23 tells upgraded installs once | #4 |
| Keyboard commands | New `open-side-panel` (#5) and `open-workspace` (#4, `resolveOpenNote` with no note), with no suggested key. `Alt+P` and `Alt+S` keep theirs | #4, #5 |
| Context menus | Append verb into today's Daily Note | #5, #35 (job host) |
| Note in Popup or Side Panel; capture notification click | `resolveOpenNote` | #4, #5 |

## Placement and capture verbs

[#17][i17] (repositories) implements these atomically, and #2, #3, #4, #5, and background capture call them.

- `Placement` is `{kind: 'inbox'}`, `{kind: 'collection', folderId}`, or `{kind: 'daily', dateKey}` with a local `YYYY-MM-DD` key. Template, archived, trashed, and pinned stay separate states, as the baseline flags are ([`createNote`][create-note], [`trashNote`][trash-note]).
- `placementOf`. A `folderId` naming a live folder becomes that collection, even for a Daily Note, which keeps its date as #17's `dailyKey`. Otherwise `isDaily` with `dateStr` becomes daily, `dateStr` copied as `dateKey` for #17's migration to re-key. Otherwise a stale `folderId` becomes Unfiled plus a #17 migration finding. A root note untitled by the [`isNoteUntitled`][untitled] rule becomes inbox, and a titled one becomes `{kind: 'collection', folderId: null}` (Unfiled) so the upgrade doesn't flood Inbox. Folders become Projects collections with nesting kept, and Unfiled sits under Projects (open, Q2). Templates take placement like any note, and Inbox and Projects views exclude `isTemplate`, as [`getAllNotes`][get-all-notes] does today.
- `placementOf` returns exactly one `Placement` plus the separate states for every baseline flag combination, including a Daily Note in a folder and a stale `folderId`.
- Create. A new note placed in a destination, Inbox for Moment captures. Identity is allocated at the first meaningful input. An untitled capture still empty when its `EditorSession` ends, or a create undone in the creating surface, moves to Trash, never a hard delete: Moment through #2's journaled `discardCapture`, Popup and Side Panel through #4's `capture.undo`. Restore, or typing again in a restored tab, keeps the same ID.
- Append. The blocks of one capture added to an existing note, or to today's Daily Note found or created by local date key in one transaction. The target's ID and placement never change. Undo in the appending surface removes exactly the blocks of that append. An open target receives it as an external operation (#6).

## Required states

| State | Behavior |
| --- | --- |
| New tab where the address bar owns focus | Chrome focuses the address bar first. Moment is writable, and keys reach the editor once the page has focus. "Open new tab, type immediately" stays the target, through the focus strategy the owner picks from #2's spike (an owner question #2 owns) |
| Moment with a locally saved capture | Reload restores it. A duplicated tab restores the same session; the second editor follows #6's single-editor rule |
| Persistent Workspace tab beside Moment tabs | Each tab keeps its own session. A capture committed in a Moment tab appears in the Workspace tab's Inbox without reload ([#13][i13] events) |
| Workspace code slow or failing | The canvas stays editable. Regions show labelled loading text, then "Workspace could not load" with Retry. No reload, no lost input, no last-used write |
| Bound note trashed, archived, or deleted elsewhere | The tab keeps showing it with a notice (Restore when trashed) and never rebinds |
| Deep link to a missing, trashed, or archived note | The [#26][i26] (recovery states) state over a pristine canvas, naming the case, with Restore or Open in Archive. No note is created with that ID |
| Unknown route or invalid stored preference | The aperture's default destination with a notice |
| Storage unavailable at boot | Moment-level recovery message with Retry, never a partial Workspace |

## Data and migration

- New records in `chrome.storage.local` through `getSetting` and `setSetting`:
  - `defaultAperture`: `{version: 1, value: 'moment' | 'workspace' | 'last-used'}`, default `moment`.
  - `lastUsedAperture`: `{version: 1, value: 'moment' | 'workspace', at}`. Device-local, never synced or exported.
  - `excerptVisibility`: `{version: 1, value: 'excerpts' | 'titles' | 'none'}`, default `excerpts`.
  - None of them is seeded in [`initializeDefaultSettings`][default-settings], which runs once per profile.
- All three records are versioned. `readAperturePreferences` maps missing, malformed, or unknown-version input to the defaults and returns no write. `nextLastUsed` returns a record only for `open-workspace` and `return-to-moment`.
- The layout snapshot `{version: 1, documentTabs, activeIndex, split: {enabled, secondaryNoteId}, inspector}`, with `documentTabs` as note IDs, lives in `workspaceLayout` (stored as `setting_workspaceLayout`), last writer wins, and only seeds new instances. `seedWorkspaceLayout` builds it once from the legacy `openTabs`, `activeTabIndex`, `splitViewEnabled`, and `secondaryNoteId`, dropping the legacy `name` and missing notes as [`loadSavedTabs`][load-saved-tabs] does. It never writes the legacy keys, which stay untouched until #17 moves per-tab state. #3 verifies that the first Open Workspace after the upgrade shows those tabs and split view.
- `lastOpenedNoteId` stops routing tabs, stays stored, and becomes the first recent-context entry in #2.
- Existing installs have no records, so they read as Moment. No note, folder, theme, or setting is rewritten.

## Security and privacy

- The Moment page makes no network or model request of its own. Content-driven requests (favicons, embeds) follow #14's privacy-safe rendering, and title suggestions are local.
- Auto-title, insights, indexing, embeddings, sync, trash retention, and the backup check run only through #35's job host, with the legacy auto-title and insights page timers going through its `jobs.runInPage` lease until #8. No transition starts, stops, or widens a job, permission, AI scope, network destination, or storage location. Open Workspace alone loads no model runtime, and a restored AI inspector stays idle until the user acts (#3 AC11).
- Incognito has no new-tab override, so no Moment, and an allowed extension saves to the regular store there. Proposed (open, Q6): private-window capture takes typed text only, with a private-window label, no automatic page URL or title, and no context-menu or command capture. #5 and [#21][i21] (security) implement the answer.

## Accessibility and performance

- One `main`: the canvas, the same node in both apertures, or #3's route outlet while a route destination shows. Workspace adds `banner` (top line), `nav` "Workspace destinations", and named Collection and Inspector regions. Hidden regions are `inert`.
- After a pointer or shortcut transition, focus stays in the editor at the preserved caret. Keyboard activation of the Open Workspace or Return to Moment control keeps focus on that control, which flips its label (#6). Before a region turns `inert`, focus inside it moves to the editor.
- One polite announcement per transition: "Workspace opened" or "Back in Moment".
- One 240 ms registered layer motion. Reduced motion swaps immediately with opacity feedback only.
- `aperture.openWorkspace` and `aperture.returnToMoment` register with #15. Of today's two sidebar toggles ([`shortcut-utils.js` L36-L58][shortcuts]), `Mod+Backslash` moves to these commands (shown in `aria-keyshortcuts`), and `Mod+Shift+E` keeps toggling the collection in Workspace.
- Moment cold start loads no Workspace code. #27 owns the excluded-module list, budgets, and prefetch rule.

## Module contracts (slice 2)

Pure modules with `node:test` suites and no I/O. Callers pass in reads and write any record returned.

- `js/product/topology.js`: types, `parseRoute`, `formatRoute`, `resolveLaunch`, `resolveTransition`, `resolveOpenNote`, `validateProductSession`, `readAperturePreferences`, `nextLastUsed`, `seedWorkspaceLayout`, `documentTitle`.
- `resolveLaunch({trigger: 'boot' | 'reload' | 'back-forward' | 'popstate', url, pane, savedSession, defaultAperture, lastUsedAperture, layoutSnapshot, homeRoute})` returns `{session, pane, history: 'none' | 'replace', url?}`. `replace` carries `formatRoute(session)` for rule 3's default-Workspace boot and whenever the resulting session differs from the URL, except a Moment session over a bare URL, which stays bare. The page maps `PerformanceNavigationTiming.type` `navigate`, `reload`, and `back_forward` to the first three triggers. `reload`, and `boot` with no valid URL, restore a valid saved session. `boot` with a valid URL, `back-forward`, and `popstate` apply a valid URL under rule 3, and `back-forward` and `popstate` with no URL return Moment on `session.noteId` with layout and route kept in the session. With no valid session, a load applies a valid URL, else follows the default.
- `resolveLaunch` gives a brand-new tab a pristine Moment session (no note ID, no route) when the default is missing, invalid, or `moment`.
- `resolveTransition(session, event, layoutSnapshot, homeRoute)` applies rules 6 and 7 to `open-workspace` and `return-to-moment`. In both, `layoutSnapshot` is the parsed `workspaceLayout` record or `null`. A session entering Workspace with no `layout` takes a copy of it, and one with no `noteId` takes that layout's active document. `homeRoute` is that note's home collection from `placementOf`, else `inbox`.
- `nextLastUsed(event, now)` returns `{version: 1, value, at}` for the two transitions and `null` for `boot`, `reload`, `back-forward`, `deep-link`, `popstate`, and `default-change`.
- `validateProductSession` rejects any field beyond `version`, `aperture`, `route`, `noteId`, and `layout`. `formatRoute` emits only aperture, route, and an encoded note ID. `resolveOpenNote` returns `{action: 'activate', tabId}` (#6 adds `windowId`) or `{action: 'open', url}`. `documentTitle` never contains note text.
- `js/product/placement.js`: `Placement`, `placementOf`, and the verb contracts.
- Module format follows #12's stack ADR (`docs/adr/0001-kernel-stack.md`) once it lands, else [`js/sidebar-utils.js`][sidebar-utils]. The first page to load the modules adds them to [`JS_FILES`][js-files] until #27 replaces it.

Tests:

- `npm test` picks up `test/topology.test.js`, `test/placement.test.js`, and `test/feature-parity.test.js` through its `node --test test/*.test.js` glob ([`package.json` L6-L14][npm-scripts]).
- `resolveLaunch` is table-driven over trigger, default, last used, URL, saved session, and snapshot, and `resolveTransition` covers both transitions from a saved `settings` route and Open Workspace from a pristine Moment. #1's test plan lists the rows.
- Edge fixtures: "Untitled 2" and whitespace-only names, `activeTabIndex` past the end, split view with no `secondaryNoteId`, and `openTabs: null`.
- `npm run typecheck 2>&1 | grep '^js/product/'` prints nothing. The full command already fails on legacy files.

## Feature-parity inventory (slice 3)

`docs/product/feature-parity.json` holds one `{id, home: {kind, id}, owner, status}` entry per baseline feature, and `test/feature-parity.test.js` checks it against a fixed `requiredIds` list: `editor-core` and one ID per feature in the parity table, with one per format for the export and import rows.

- The format IDs, from [`export-import-service.js`][export-import] and the [file inputs][file-inputs], are `export-json` (`exportAll`), `export-backup` (`createBackup`), `export-markdown-zip` (`exportAllAsMarkdown`), `export-note-json` (`exportCurrentNote`), `export-note-markdown` (`exportNoteById`), `import-json` (`importFromFile`), `import-note-json`, and `import-note-markdown` (`.md` and `.txt`, both through `importNote`).
- `home.kind` is one of `rail`, `collection-view`, `inspector`, `canvas-mode`, `canvas-action`, `route`, `settings-route`, `top-line`, `moment`, `both-apertures` (editor core), `popup`, `side-panel`, `background`.
- `status` is `mapped` or `owner-question`.
- The test fails on an absent `requiredIds` entry, a missing or duplicate home, an unknown home kind, a missing owner, or a `removed` status.

## Browser check

#1 needs this before slice 2 merges. It ran on 2026-10-20.

Setup:

- Chrome for Testing 156.0.8078.4 (Playwright's Chromium build 1248) in new headless mode on macOS arm64, driven by Playwright 1.64.1 from a throwaway script kept outside the repo. Stable Chrome ignores `--load-extension`, which is why it ran on Chrome for Testing.
- The 1.4.0 build (`npm run build` at `3706d84`), loaded unpacked into a fresh profile with `--disable-extensions-except` and `--load-extension`. Permissions were 1.4.0's: `activeTab`, `contextMenus`, `notifications`, `offscreen`, `sidePanel`, `storage`, `unlimitedStorage`, the new-tab override, and the AI host origins. No `tabs`, no `sessions`.
- Playwright's default `--disable-back-forward-cache` was removed, so Back behaves as it does in stable Chrome.
- Two kinds of tab. A new tab is a page navigated to `chrome://newtab`, or `chrome.tabs.create({})` from the worker. A direct tab is `chrome-extension://<id>/newtab.html#...` opened with `page.goto` or `chrome.tabs.create({url})`, the way `resolveOpenNote` will open one.
- Page APIs were evaluated in the page, and `chrome.runtime.getContexts` and `chrome.tabs` in the service worker.

History on the override page. `pushState` and `replaceState` ran in both kinds of tab, and the other rows in a new tab:

| Check | Result |
| --- | --- |
| `pushState` | Works. `location.href` gets the hash, `history.length` grows by one, `history.state` is set, and the page doesn't reload |
| `replaceState` | Works. The URL and `history.state` change, and `history.length` doesn't |
| Same-document Back and Forward | `popstate` fires with the entry's state and URL, with no reload. Back to the first entry gives `state: null` and the bare `newtab.html` URL |
| Reload | Reloads the current entry with its hash and `history.state`, and `history.length` stays the same |
| Cross-document Back (to `about:blank`, then Back) | The page loads again with its hash and `history.state`, and `pageshow.persisted` is `false`. Chrome reports it ineligible for the back/forward cache (`SchemeNotHTTPOrHTTPS`, `EmbedderExtensionFrame`, `BrowsingInstanceNotSwapped`), so the extension page loads fresh instead of coming back from the cache |
| Back from that reloaded entry to the bare first entry | Same-document `popstate`, no load |
| Address bar | Not visible in headless mode. A new tab's visible URL stays `chrome://newtab/` through `pushState`, `replaceState`, reload, duplication, and restore, per its DevTools target URL. A separate diagnostic run with `tabs` added to a copy of the manifest got the same `chrome://newtab/` from `chrome.tabs.get`. A direct tab's visible URL is the full extension URL and follows `pushState` and `replaceState`. Manual check 1 |

Navigation types:

| Load | `PerformanceNavigationTiming.type` |
| --- | --- |
| New tab (`chrome://newtab`, `chrome.tabs.create({})`) | `navigate` |
| Deep link (`page.goto`, `chrome.tabs.create({url})`) | `navigate` |
| Reload | `reload` |
| Cross-document Back | `back_forward` |
| Duplicated tab (`chrome.tabs.duplicate` of a bare new tab, a new tab with a pushed hash, and a direct tab) | `back_forward` |
| Restored tab after a browser restart (same profile, relaunched with `--restore-last-session`) | `back_forward` |
| Reopened closed tab | Not testable here. `chrome.sessions` isn't available under 1.4.0's permissions, and headless mode has no Reopen Closed Tab. Manual check 2 |

Duplicated and restored tabs open on the source tab's current entry with its hash, the same `history.length` and `history.state`, and the source's `sessionStorage`. A value written before duplicating, or before the restart, was there, so `ntn.productSession` carries over in both cases.

Worker APIs under 1.4.0's permissions:

| API | Result |
| --- | --- |
| `chrome.runtime.getContexts({contextTypes: ['TAB']})` | Lists every override tab, both kinds, with `tabId`, `windowId`, `frameId: 0`, and `documentUrl` set to the current URL with its hash. `documentUrl` follows `pushState`, `replaceState`, and `popstate` |
| `chrome.tabs.get`, `chrome.tabs.query` | `url` and `title` are missing for new tabs and present for direct tabs. `lastAccessed` is present on every tab |
| `chrome.tabs.update(tabId, {active: true})` | Activates a new tab and a direct tab in the same window, with no error. `chrome.tabs.query({active: true, windowId})` returns the target afterwards |

What this means for slice 2 and the consumers:

- `pushState`, `replaceState`, and `popstate` work as [Routes and history](#routes-and-history) assumes, so the `replaceState`-only fallback isn't needed.
- `getContexts` gives each override tab's `tabId` and current hash, and `tabs.update` activates it, so the always-a-new-tab fallback isn't needed. #2's `readOpenTabs()` can take the note from `documentUrl` and `lastAccessed` from `chrome.tabs.query`.
- Duplicated and restored tabs report `back_forward`, so `resolveLaunch` handles them with trigger `back-forward`.
- If a manual check finds history or activation broken in stable Chrome, the fallbacks are #1's: `replaceState` only (no Back entries), and always a new tab.

Manual checks, still open. None of them changes slice 2's contracts, so slice 2 doesn't wait on them. #30 (extension end-to-end) carries them as manual rows, and the owner can run them in stable Chrome with `dist/` loaded through Load unpacked:

1. Address bar. Open a new tab, run `history.pushState(null, '', '#/workspace/inbox')` from DevTools on that tab, and look at the address bar, then reload and press Back. The probe predicts the address bar stays empty. While there, bookmark the tab and see which URL the bookmark saves.
2. Reopen a closed tab (Ctrl+Shift+T, or Cmd+Shift+T on macOS) after a `pushState`. Check `performance.getEntriesByType('navigation')[0].type`, the hash, `history.state`, and `sessionStorage`.
3. Session restore through "Continue where you left off" after quitting Chrome. The probe relaunched a headless profile with `--restore-last-session` instead.
4. `chrome.tabs.update` with real windows. Check that the activated tab gets focus and its `document.visibilityState` changes. Headless mode reported `visible` for every tab.

## Risks

1. Users lose "new tab shows my last note", so #2's Notes peek and #23's upgrade cue ship together.
2. The browser check above retires the unverified-API risk for slice 2. The four manual rows stay open with #30.

## Consumers

#1 has no dependencies. It's a wave-0 root beside #12 (kernel) and #16 (design tokens), and its consumers carry the integrated checks:

- #2 (Moment shell): `resolveLaunch` with its navigation-type triggers, the `?note=` replace rule, `resolveOpenNote`'s tab reader, the Moment contracts, the Moment privacy rule, and the interim preference controls in Settings General until #25.
- #3 (Workspace shell): `resolveTransition`, the `?note=` replace rule, the one-pane push rule and `pane`, rule 9, Placement collections, `seedWorkspaceLayout`.
- #4 (Popup): the toolbar switch, `open-workspace`, `resolveOpenNote`, capture verbs, `excerptVisibility`.
- #5 (Side Panel): `open-side-panel`, the incognito answer, `excerptVisibility`.
- #6 (editor continuity): preservation, mid-transition keys arriving once, and the `leaseHolder` input to `resolveOpenNote`.
- #17 (repositories): `Placement` and both verbs.
- #23 (activation): `defaultAperture` in the upgrade notice, and `aperture.openWorkspace` as `tip.workspace`'s completion signal.
- [#30][i30] (extension end-to-end): restart, multi-tab, history, deep links, focus, and a spec whose `parity` annotation names each entry ID.

Shell, settings, toolbar, and storage code are out of scope here. The consumers above build them.

[i1]: https://github.com/keyurgolani/NewTabNote/issues/1
[i2]: https://github.com/keyurgolani/NewTabNote/issues/2
[i3]: https://github.com/keyurgolani/NewTabNote/issues/3
[i4]: https://github.com/keyurgolani/NewTabNote/issues/4
[i5]: https://github.com/keyurgolani/NewTabNote/issues/5
[i6]: https://github.com/keyurgolani/NewTabNote/issues/6
[i8]: https://github.com/keyurgolani/NewTabNote/issues/8
[i11]: https://github.com/keyurgolani/NewTabNote/issues/11
[i12]: https://github.com/keyurgolani/NewTabNote/issues/12
[i13]: https://github.com/keyurgolani/NewTabNote/issues/13
[i14]: https://github.com/keyurgolani/NewTabNote/issues/14
[i15]: https://github.com/keyurgolani/NewTabNote/issues/15
[i16]: https://github.com/keyurgolani/NewTabNote/issues/16
[i17]: https://github.com/keyurgolani/NewTabNote/issues/17
[i18]: https://github.com/keyurgolani/NewTabNote/issues/18
[i19]: https://github.com/keyurgolani/NewTabNote/issues/19
[i21]: https://github.com/keyurgolani/NewTabNote/issues/21
[i22]: https://github.com/keyurgolani/NewTabNote/issues/22
[i23]: https://github.com/keyurgolani/NewTabNote/issues/23
[i25]: https://github.com/keyurgolani/NewTabNote/issues/25
[i26]: https://github.com/keyurgolani/NewTabNote/issues/26
[i27]: https://github.com/keyurgolani/NewTabNote/issues/27
[i30]: https://github.com/keyurgolani/NewTabNote/issues/30
[i35]: https://github.com/keyurgolani/NewTabNote/issues/35
[m-override]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/manifest.json#L6-L8
[app-init]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/app.js#L100-L229
[newtab-title]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/newtab.html#L7
[save-tabs]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/controllers/tab-controller.js#L194-L202
[bg-action]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/background.js#L24-L36
[sp-open]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/sidepanel.js#L52-L54
[popup-quick]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/popup.js#L358-L377
[popup-daily]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/popup.js#L194-L282
[popup-recent]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/popup.js#L289-L316
[sp-summary]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/sidepanel.js#L103-L127
[bg-menus]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/background.js#L180-L191
[m-commands]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/manifest.json#L18-L31
[bg-commands]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/background.js#L223-L242
[bg-ollama]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/background.js#L114-L130
[create-note]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/storage.js#L632-L676
[trash-note]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/storage.js#L962-L982
[untitled]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/storage.js#L952-L956
[get-all-notes]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/storage.js#L688-L691
[default-settings]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/storage.js#L1624-L1678
[load-saved-tabs]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/controllers/tab-controller.js#L136-L189
[shortcuts]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/shortcut-utils.js#L36-L58
[export-import]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/controllers/export-import-service.js#L46-L126
[file-inputs]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/newtab.html#L1238-L1239
[sidebar-utils]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/sidebar-utils.js#L210-L215
[js-files]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/scripts/build.js#L21-L73
[npm-scripts]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/package.json#L6-L14
