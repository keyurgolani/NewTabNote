# Interaction contract

- Status: Accepted, [#24][i24] slice 1. Owner question 1 is answered (2026-11-11): links in running text are exempt from the 44 by 44 target. Owner question 2, who runs the manual matrix and on what hardware, is open.
- Source: #24's Product and interaction requirements, held here in full, with the target-size criteria and the baseline's gates from the same issue.

One interaction contract for every surface: how each control works by keyboard, screen reader, pointer, and touch, and the matrix it's checked at. The target is WCAG 2.2 AA plus the owner's stricter rules: 44 by 44 CSS px targets, focus that returns to its opener, and `inert` hidden panes. Text holds 4.5:1, and non-text and focus 3:1 against every adjacent plane, as #24's AC4 says. #16, #14, #3, #2, #4, and #5 build to it, #24's check library checks it, and [the conformance table](conformance.md) has a row for every surface and route.

Two parts of it are code already, and a change to either changes this page in the same PR. The registry kit's validator rejects the chords Chrome keeps for itself (`js/kernel/registry/chords.js`), and #16's token source holds the ratios, `--target-min`, and the layout widths (`design/quiet-atlas.tokens.json`).

## Criteria and owners

| WCAG 2.2 | Here | Owner |
|---|---|---|
| 1.1.1 Non-text | Image `alt` with an empty-alt flag, frame titles, chart tables, graph list | #14 (block registry), #3 |
| 1.4.1 Use of color | Text-led controls; nothing shown by color or icon alone | #16 (tokens and primitives); all surfaces |
| 1.4.3, 1.4.11 Contrast | Token pairs, two-tone ring on slate and sage, rendered states | #16 |
| 1.4.10 Reflow | 320 CSS px for Moment, Popup, Side Panel, Workspace panes | #2, #3, #4 (Popup), #5 (Side Panel) |
| 1.4.12 Text spacing | Nothing clips under the spacing override | this issue |
| 1.4.13 Hover or focus | Cues and formatting toolbar dismiss with Escape, stay while hovered | #23 (onboarding), this issue (toolbar) |
| 2.1.4 Character keys | No single-character shortcut | this issue, via #15's command registry |
| 2.2.2 Pause, stop, hide | Stop for streaming, queued "N new" for live signals | #9 (local runtime), #11 (providers), #5 |
| 2.4.11 Focus not obscured | `scroll-padding` under sticky regions | #25 (settings routes) sticky actions, #3 top line and peeks, #23 cues, #26 (states) toasts |
| 2.5.3 Label in name | Accessible name contains the visible label | #15; all |
| 2.5.5, 2.5.8 Target size | 44 by 44 CSS px for every functional target, links in running text exempt as inline targets (Targets below) | #16 (primitives); all surfaces |
| 2.5.7 Dragging | Drag table below | #14, #3, #22 (search and graph) |
| 3.2.6 Consistent help | Help and "learn more" in one place | #23 |
| 3.3.7 Redundant entry | Import, provider setup, and model install never ask twice | #18 (backup), #11, #10 (model library) |
| 3.3.8 Authentication | Vault unlock and credentials accept paste and password managers | #21 (security), #19 (sync) |
| 4.1.3 Status | Announcement rules below | #13 (contracts), #2 (Moment shell) |

## Patterns

| Pattern | Keyboard | Semantics |
|---|---|---|
| View tabs | Left, Right, Home, End, one Tab stop. Automatic activation if switching is synchronous, else Enter or Space | `aria-selected`, `aria-controls` in sync (#15) |
| Document tabs | Same keys, manual activation, Delete closes | Close is a pointer-only button outside the tab's accessible subtree (`tabindex="-1"`, `aria-hidden`, 44 by 44 hit area). The tab has `aria-keyshortcuts="Delete"` |
| Rail | Up, Down, Home, End; one Tab stop, roving focus | `nav` list with `aria-current="page"` |
| Calendar | Left and Right by day, Up and Down by week, Home and End to the week's first and last day, PageUp and PageDown by month | `grid`, one Tab stop, cells named with the full local date and "has note", `aria-current="date"` from #17's (repositories) local date |
| Collections | Arrows move focus, Enter opens, Shift+F10 or ContextMenu opens the row menu | Collections are lists: More actions button per row, real selection checkboxes. Projects is a `tree` (#3): folder `treeitem`s with `aria-expanded` (Right and Left expand and collapse), `aria-selected` selection, and a pointer-only More actions button (`tabindex="-1"`, `aria-hidden`) |
| Menus (item, folder, block, table) | Focus to the first item, arrows, type-ahead, Escape returns focus, Tab closes | `aria-haspopup` and `aria-expanded` on the button; top-layer menu anchored to it, never to the pointer |
| Palette; slash, `[[`, template menus | Arrows move the active option, Enter picks, Escape restores the caret | Combobox and listbox with `aria-activedescendant`, caret stays put (#14 owns the editor menus) |
| Formatting toolbar | Alt+F10 from a selection, arrows inside, Escape returns to the selection | `toolbar`, out of the tree while hidden, buttons act on click and keep the selection |
| Dialogs | First field, else the heading; destructive ones start on the least destructive action. In confirmations, Enter activates only the focused button, ignoring key repeat. In a form dialog, Enter in a single-line field submits the non-destructive primary action | Top-layer `dialog`, background `inert`, consequence in `aria-describedby`, focus back to the opener |
| Cards | Tab through the action buttons | `article` with a heading, no control nested in another |
| Graph, charts | List or table view with the same actions, pan and zoom buttons | Text alternative of the same data (#3, #22) |

## Focus and layers

- Hidden, collapsed, off-screen, and transparent layers are `inert` and out of the accessibility tree, with focus moved out first. A collapsed layer shows only its labelled peek, outside the `inert` subtree.
- Escape closes only the topmost layer, returns focus to its invoker, and never navigates.
- Re-renders keep the focused element. If another surface removes it, focus goes to the next item, else the previous, else the list heading, with one polite announcement through #7 (cross-surface state). Virtualized lists keep the focused row mounted with `aria-setsize` and `aria-posinset`. No scripted action leaves focus on `body`.
- The PiP window gets `lang`, a title from `documentTitle` in #1 (Continuity Canvas model), with no note title unless #1's owner input 3 allows it, the #16 focus ring, one `main`, and its own status region. Closing it returns focus to the PiP control.
- Focus-mode dimming keeps text at 4.5:1 and stops under contrast-more and forced colors.

## Announcements

- Each surface mounts #13's polite status region at load. `role="alert"` is only for failures that stop the current action.
- Routine saves are never announced. The only save announcements are #2's first-save confirmation per new note, plus failure, recovery, a recovered entry, and conflict from #2 and #6 (continuity).
- The AI transcript is a `log` with `aria-live="off"`. The status region says "Responding" when streaming starts and "Response ready" when it completes, and nothing else once a model is loaded; #9's load-phase announcements come only before "Responding" (#9, #11). That replaces both live transcripts and `_announceToScreenReader`.
- Background updates are batched (#5, #7). Error toasts stay until dismissed, and the failure state stays visible until resolved (#26).

## Keyboard map

- No default binding uses a chord Chrome keeps for itself: `Mod+T`, `Mod+Shift+T`, `Mod+N`, `Mod+Shift+N`, `Mod+W`, `Mod+Shift+W`, `Mod+Tab`, `Mod+Shift+Tab`, `Mod+Shift+Q`, `Mod+PageUp`, and `Mod+PageDown`. Close, next, and previous tab get no default chord and stay on the tab strip and palette. New note keeps Alt+N under #15's Alt rules.
- Mod+/ opens Help anywhere in NewTabNote except while the caret is in a block's text, where Mod+/ keeps opening the block menu, as it has since 1.6.0. #15's chord kit lists the two as one chord split by focus, not as a conflict. Help moves off `?`, and the slash trigger ignores modified keys. Editor input rules (`/`, `[[`, markdown triggers) are active only in the focused editor and aren't shortcuts. Moment's printable-key capture is typing and follows #2.
- Every command has a visible control or palette entry. Help lists every registry binding and the Chrome commands.
- Every entry point in #1 has a keyboard path, and one reached only through browser or OS UI (toolbar button, notification) has an in-product equivalent.

## Targets

- Every functional pointer target is at least 44 by 44 CSS px (`--target-min`), by hit area where the visual is smaller, at every density and for every pointer. Drop the `.touch-device` sniffing, and move the block handle inside the gutter at narrow widths.
- Exempt: the text-editing area as a whole, browser-owned UI, and links in running text inside a text block, as WCAG's target-size criteria (2.5.5 and 2.5.8) exempt inline targets. The controls inside blocks aren't exempt (todo checkbox, toggle, handle, file and embed buttons), and neither are bookmark cards. The toolbar's 44 by 44 Open and Edit buttons, shown while the caret is in a link, are the alternative to a small inline link.
- The month grid renders only when its container fits seven 44px columns with no gap (308px, 19.25rem). Below that it becomes a week list, a `listbox` of seven 44px day options with Previous and Next week. Up and Down move by day, PageUp and PageDown by week.

## Drag alternatives

| Drag | Alternative | Owner |
|---|---|---|
| Block reorder, mouse or long-press | Mod+Shift+Arrow and Move up or down in block actions, announced as "Moved to position 3 of 8" | #14 |
| Block onto the note list | Block actions: Move to note (picker) and New note from block | #14 |
| Note or folder into a folder | More actions: Move to, with a folder picker | #3 |
| Panel resize | `separator` with arrow steps, Home, and End | #3 |
| Graph pan and zoom | Buttons and the list view | #3, #22 |

## Responsive

- One DOM per surface. Popup, Side Panel, and each Workspace pane is a size container, and components recompose by container width.
- Breakpoints, thresholds, and region minimums are in rem (#16's px values over 16), so Chrome's font size recomposes layouts as zoom does.
- Drill-down focuses and announces the new pane's heading, and Back returns focus to the item it came from. Workspace Back mirrors browser history (#1, #3). Popup and Side Panel use in-app Back only.
- A breakpoint crossing keeps the focused pane visible and never remounts the editor or breaks a composition (#6). Saved widths clamp to the container.
- Matrix: Moment and Workspace at 320, 390, 720, 1100, and 1280 CSS px, the token source's `--layout-min-width`, `--breakpoint-narrow`, `--breakpoint-recompose`, and `--breakpoint-compact-shell`, and the reference viewport's width; Popup and Side Panel at 360 (default) and 320 CSS px, the `openSurface` sizes #28 names (#301). On every surface: 200% and 400% zoom; Chrome font size 16, 20, and 24px; the text-spacing override; coarse pointer (`hasTouch`, `any-pointer: coarse`); light, dark (gated against its `ownerGate` entries, #16), contrast-more, forced colors, and reduced motion. Each point changes one axis from the default (1280 or 360 CSS px, 100%, 16px, light, no preference). Zoom Z at width W is a W/Z CSS px viewport at `deviceScaleFactor` Z. Font size is the profile's `webkit.webprefs.default_font_size`. Popup at zoom Z is min(800, 360·Z)/Z CSS px wide.

## Conformance table

[`conformance.md`](conformance.md) has one row per surface and route (landmarks, headings, entry focus, keys, layers, narrow mapping, drag alternatives, announcements), each with one `test:a11y` spec.

## Baseline gates

Violations go in #29's shared, shrink-only `test/a11y/baseline.json` under check ID `a11y-rules`, which #24's slice 2 creates if #29 hasn't. The only entries that may stay are dark pairs, the token source's `legacyDark` list, until #16 has Quiet Atlas dark. Each carries the `ownerGate` field `#16-dark`, and slice 3's empty-baseline assertion ignores only those entries. Links in running text are an exemption, not a gate, so they take no entry.

[i24]: https://github.com/keyurgolani/NewTabNote/issues/24
