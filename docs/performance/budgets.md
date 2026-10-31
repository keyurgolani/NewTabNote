# Budgets

#27 slice 4b. `build/budgets.json` holds the numbers the owner approved on 2026-10-31 from [baseline-1.4.0.md](baseline-1.4.0.md). No script writes it. A row changes only in a reviewed PR, with its reason and evidence, and a number over a row goes back to the owner through the lead. The lane never raises it.

## The rows

| Entry | Row | Limit | On `next` at `10fdade` (headroom) |
| --- | --- | --- | --- |
| New tab | start JS, raw / gzip | 700 / 200 KiB | 548.5 / 142.1 KiB (151.5 / 57.9) |
| New tab | start CSS, raw / gzip | 100 / 19 KiB | 99.9 / 16.0 KiB (126 bytes / 3.0 KiB) |
| New tab | start HTML, raw / gzip | 72 / 12 KiB | 65.9 / 10.3 KiB (6.1 / 1.7) |
| Popup | start JS, raw / gzip | 115 / 40 KiB | 95.5 / 25.9 KiB (19.5 / 14.1) |
| Side Panel | start JS, raw / gzip | 112 / 40 KiB | 94.0 / 25.7 KiB (18.0 / 14.3) |
| New tab | interaction-ready against 1.4.0 | median ratio at most +7% | reported, not gated yet |
| New tab | heap at interaction-ready | 4.45 MiB, +3% (fails above 4.58) | reported, not gated yet |

- **Start** is everything a page loads before it can run: the HTML, its module scripts with what they import, its module preloads, its stylesheets with the CSS its chunks inject, its classic scripts, and the fonts those stylesheets name. A loader chunk the page boots at its start counts as start too, with what it imports: a row's `startChunks` names it. Today that's the new tab's `workspace` chunk, which is still the whole tab until #2 builds Moment. Its root, boot guard and loader are 7.1 KiB; the workspace chunk and the host chunk it imports are the other 541.4. Counting the root alone, the 700 KiB row would check nothing. So every chunk the page's own start loads with `import()` has to be named in its row: in `startChunks` when it loads at boot, or in `lazyChunks` when it loads later. A chunk named in neither fails the build with `budget/entry`, and so does a name the build has no loader chunk for, or one nothing on the page's start loads. Emptying `startChunks`, or dropping a renamed chunk's name from it, fails rather than shrinking the row to the root. Taking the workspace out of start takes a reviewed row change that names it in `lazyChunks`, and `test/budgets.test.js` pins today's `startChunks: ["workspace"]`.
- `npm run perf:probe`'s byte mode files every chunk behind an `import()` as lazy, the workspace too, so its start number for the new tab is the root's. The build's number, and `dist-report/chunk-graph.json`, are the start the row holds.
- Bytes are raw and gzip at level 9, the way `npm run perf:probe` measures them.
- Every other byte row is `null`: no approved number yet. That covers the Popup's and Side Panel's CSS and HTML, every page's fonts, the offscreen document, and the service worker. The service worker's start is the whole of its one self-contained module, and its cold-start time is #35's.
- The new tab's CSS is 126 bytes under its row, after #112 took back what #102 added. The row was sized from CSS CleanCSS minified, before #99 moved the build to lightningcss, which doesn't merge rules that aren't next to each other: the same sources minify about 5 KiB larger. Whatever adds CSS to the start path needs the owner's call on the row first.

## The forbidden list

`build/budgets.json`'s `forbidden` has the scope's whole list as categories, each with the paths that are it. An entry gates the categories it names, on its start path only:

- **New tab**: the four libraries and the trust code. That's `chart-library` (Chart.js), `search-library` (Fuse.js), `zip-library` (JSZip), `model-runtime` (transformers.js), and `trust` (`js/trust/**`). Slice 3 made all five lazy, so this is what today's new tab can be held to.
- **Popup and Side Panel**: the full list. Both pass it today.
- **Moment** (`planned`): the full list. It switches on the day #2 builds a `moment` chunk: a built planned row fails until its numbers are set and `planned` is false, and from then on the full list holds on its start (`test/budgets.test.js`).

Today's new tab still imports these modules of the full list at its start, through the workspace chunk:

- `js/analytics.js` and `js/controllers/analytics-controller.js`
- `js/ui/graph-view.js`
- `js/search.js` (the wrapper; Fuse.js itself is lazy)
- `js/controllers/export-import-service.js`
- `js/controllers/settings-controller.js` and `js/controllers/theme-builder-controller.js`
- `js/services/sync-service.js`
- `js/llm.js`
- `js/embeddings.js` (the wrapper; transformers.js is lazy)
- `js/onboarding.js`
- `js/workspace.js` itself

#2's Moment starts from that list.

`model-runtime` has no `.wasm` path. The package ships no `.wasm` today, and the analyzer lists only chunks, classic scripts, stylesheets and fonts, so a `.wasm` pattern would match nothing. One gets a path together with the analyzer support to see it.

Three categories have no paths yet: `archive-trash` (no module of its own until #3 splits it out of the sidebar), `recipes` (#8), and `ai-policy` (#21). Each gets its paths with its owner's module.

## Dependencies

Each entry lists the third-party packages its whole graph may hold: start, lazy and workers. A package found in `node_modules/`, or a vendored file under `js/lib/` by its `vendor.json` record, has to be on its entry's list. An allowed package the graph no longer holds fails too, so the list stays exact.

| Entry | Allowed |
| --- | --- |
| New tab | `@xenova/transformers`, `chart.js`, `fuse.js`, `jszip` (lazy, through the loader), `valibot` (lazy, in the trust chunk) |
| Service worker | `valibot` |
| Popup, Side Panel, offscreen, Moment | none |

## How each gate runs

**Bytes, forbidden modules and dependencies** run in every production build (`npm run build`, step 5), so they fail closed in CI's `build` job on every PR. A budget problem exits 1 and leaves no `dist/`. A development build isn't checked: budgets hold for what ships. The analyzer writes what it read to `dist-report/chunk-graph.json`: per entry, the start, lazy and workers files with their bytes, modules and packages. The build fails on:

| Code | When |
| --- | --- |
| `budget/bytes` | an entry's start JS, CSS, HTML or fonts is over its row, raw or gzip |
| `budget/forbidden` | a module or file a gated category names is on an entry's start path |
| `budget/dependency` | an entry's graph holds a package its row doesn't allow, or its row allows one the graph no longer holds |
| `budget/entry` | a page or the service worker the build has with no row, a row for an entry it doesn't have that isn't `planned`, a `planned` row for one it has, a `startChunks` or `lazyChunks` name the build has no loader chunk for or the page's start doesn't `import()`, or a chunk the page's start `import()`s that its row names in neither |
| `budget/file` | `build/budgets.json` is missing, doesn't parse, or doesn't read as a budget file: an entry or forbidden category of the wrong shape, a `start` row that isn't `html`, `js`, `css` or `fonts`, or a limit that isn't whole bytes |

`npm run verify:fixtures` breaks each rule on purpose and checks that the build fails with its code (`test/build-fixtures/budget-*`). `budget-start-chunk` sets the new tab's JS row to 20 KiB, over the root and under the tab, and the build fails: the workspace chunk is counted. `budget-start-missing` points `startChunks` at a chunk that isn't built, and `budget-start-empty` empties it. `budget-library-classic` puts Fuse.js back on the new tab's start as a classic script, and `budget-background-dependency` bundles an unlisted package into the service worker.

**Timing and heap** run in CI's `perf` workflow (`.github/workflows/perf.yml`), on every PR push and every push to `next`. It's its own workflow, not part of `pr-gate`, so it never blocks a merge.

- It builds the candidate.
- It builds 1.4.0 from the `v1.4.0` tag with v1.4.0's own lockfile and build (`npm run perf:reference`) and checks it against the digest pinned in `build/budgets.json`. A mismatch fails the job: a run against any other package would compare against the wrong one.
- It runs `npm run perf:probe` with 1.4.0, 1.4.0 again and the candidate: 12 rounds each on `typical` and `maximal`, with `--baseline build/budgets.json`.
- `scripts/perf/gate-report.js` writes the job summary, even when the probe exits 1 for an invalid run. For each profile it shows whether the run is valid, the candidate's median ratio to both 1.4.0 runs against the 7% row, its heap against 4.45 MiB plus 3%, and the absolute milliseconds beside them. A profile is invalid when 1.4.0 against itself is more than 7% off, when any round of any package failed, when the probe reported a problem (a fixture that isn't the recorded one, for one), or when it ran fewer than 12 rounds. A package that measured nothing, say because every candidate round failed, makes it invalid too, rather than stopping the summary. Then its timing and heap both say `invalid`, with the reasons listed.

Both rows say `mode: report`, so nothing in the summary fails the job.

- **Timing becomes a gate** after 10 CI runs, if 1.4.0 against itself stayed within 7% on at least 9 and the invalid-run check would have passed. If it didn't, the timing gate moves to a release gate on `ref-desktop` through the machine lock, which the lead approves before it's built.
- **Heap becomes a gate** once CI's runs sit within its 3% of a stable value. 4.45 MiB was measured on the Mac, and a Linux Chromium's heap can differ.

Either flip changes the row's `mode` to `gate` in its own reviewed PR, or in #27 slice 3b. From then on `gate-report.js` exits 1 on a fail or an invalid run, which fails the `perf` job. That alone blocks nothing: `perf` isn't a required check. Timing blocks a merge only once `pr-gate` needs it (a `perf` job in `.github/workflows/pr-checks.yml`, in `pr-gate`'s needs), or once a ruleset requires the `perf` check. Either is the owner's call, in the same PR as the flip.

## Changing a number

1. Measure it: `npm run build` prints each entry's start, and `dist-report/chunk-graph.json` has the rest. For timing, use `npm run perf:probe` interleaved against 1.4.0.
2. Take the number and its evidence to the owner through the lead.
3. Change the row in a PR that says why and links the evidence, and get it reviewed. Nothing else writes the file.
