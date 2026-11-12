# Conformance table

One row per surface, Workspace route, and workflow, each against [the interaction contract](interaction-contract.md). A row's owner fills it as its surface ships: landmarks, headings, where focus lands on entry, the keys it takes, its layers, how it maps at narrow widths, its drag alternatives, and what it announces. A filled row names its one `test:a11y` spec, which runs at every point of [the matrix](matrix.json). A row stays empty until all of it holds, and #24 closes when every row is filled and its spec passes.

The surfaces are the registry kit's hosts but `background`, whose notifications are browser UI. The routes are #1's Workspace routes, so a route added there needs a row here. The workflows are the ones #24's AC1 names that aren't a surface or a route, and #24's completion pass fills the retained ones: the formatting toolbar, the table menu, the multi-block selection bar, focus-mode dimming, and the Picture-in-Picture window.

| Surface or route | Owner | Landmarks | Headings | Entry focus | Keys | Layers | Narrow mapping | Drag alternatives | Announcements | Spec |
|---|---|---|---|---|---|---|---|---|---|---|
| Moment (`moment`) | #2 | | | | | | | | | |
| Workspace (`workspace`) | #3 | | | | | | | | | |
| Popup (`popup`) | #4 | | | | | | | | | |
| Side Panel (`sidepanel`) | #5 | | | | | | | | | |
| Picture-in-Picture window (`pip`) | this issue | | | | | | | | | |
| Recovery page (`recovery`) | #20 | | | | | | | | | |
| Inbox (`workspace/inbox`) | #3 | | | | | | | | | |
| Daily (`workspace/daily`) | #3 | | | | | | | | | |
| Projects (`workspace/projects`) | #3 | | | | | | | | | |
| Templates (`workspace/templates`) | #3 | | | | | | | | | |
| Search (`workspace/search`) | #3, #22 | | | | | | | | | |
| Insights (`workspace/insights`) | #3, #8 | | | | | | | | | |
| Trust (`workspace/trust`) | #20 | | | | | | | | | |
| Settings (`workspace/settings`) | #25 | | | | | | | | | |
| Graph (`workspace/graph`) | #3, #22 | | | | | | | | | |
| Analytics (`workspace/analytics`) | #3, #22 | | | | | | | | | |
| Archive (`workspace/archive`) | #3 | | | | | | | | | |
| Trash (`workspace/trash`) | #3 | | | | | | | | | |
| Formatting toolbar (`toolbar`) | this issue | | | | | | | | | |
| Table menu (`table-menu`) | this issue | | | | | | | | | |
| Multi-block selection bar (`selection-bar`) | this issue | | | | | | | | | |
| Focus-mode dimming (`focus-dimming`) | this issue | | | | | | | | | |
| Split view (`split-view`) | #3 | | | | | | | | | |
| Tables (`tables`) | #14 | | | | | | | | | |
| Block reorder (`block-reorder`) | #14 | | | | | | | | | |
| Folders (`folders`) | #3 | | | | | | | | | |
| Calendar (`calendar`) | #3 | | | | | | | | | |
| Cues (`cues`) | #23 | | | | | | | | | |
