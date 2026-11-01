# Budgets

#27 slice 4b. `build/budgets.json` holds the numbers the owner approved on 2026-10-31 from [baseline-1.4.0.md](baseline-1.4.0.md). No script writes it. A row changes only in a reviewed PR, with its reason and evidence, and a number over a row goes back to the owner through the lead. The lane never raises it.

## The rows

| Entry | Row | Limit | On `next` at `7489d7b3` (headroom) |
| --- | --- | --- | --- |
| New tab | start JS, raw / gzip | 700 / 200 KiB | 629.3 / 171.4 KiB (70.7 / 28.6) |
| New tab | start CSS, raw / gzip | 105 / 19 KiB | 102.0 / 16.4 KiB (3.0 / 2.6) |
| New tab | start HTML, raw / gzip | 72 / 12 KiB | 65.9 / 10.3 KiB (6.1 / 1.7) |
| Popup | start JS, raw / gzip | 115 / 40 KiB | 108.4 / 30.8 KiB (6.6 / 9.2) |
| Side Panel | start JS, raw / gzip | 112 / 40 KiB | 106.9 / 30.6 KiB (5.1 / 9.4) |
| Offscreen | start JS, raw / gzip | 29 / 9 KiB | 27.5 / 8.6 KiB (1.5 / 0.4) |
| Offscreen | start HTML, raw / gzip | 1 / 1 KiB | 230 / 174 bytes (794 / 850 bytes) |
| New tab | interaction-ready against 1.4.0 | median ratio at most +7% | gates the `perf` job since 2026-10-31 |
| New tab | heap once the probe key's writes have committed | 3.10 MiB, +3% (fails above 3.19) | 2.95 / 2.68 MiB on `typical` / `maximal`, CI's three readings with the fixed probe at `2ae3f528` and `ecc401a7`; gates the `perf` job since 2026-11-01 |

- **Start** is everything a page loads before it can run: the HTML, its module scripts with what they import, its module preloads, its stylesheets with the CSS its chunks inject, its classic scripts, and the fonts those stylesheets name. A loader chunk the page boots at its start counts as start too, with what it imports: a row's `startChunks` names it. Today that's the new tab's `workspace` chunk, which is still the whole tab until #2 builds Moment. Its root, boot guard and loader are 7.1 KiB; the workspace chunk and the host chunk it imports are the other 541.4. Counting the root alone, the 700 KiB row would check nothing. So every chunk the page's own start loads with `import()` has to be named in its row: in `startChunks` when it loads at boot, or in `lazyChunks` when it loads later. A chunk named in neither fails the build with `budget/entry`, and so does a name the build has no loader chunk for, or one nothing on the page's start loads. Emptying `startChunks`, or dropping a renamed chunk's name from it, fails rather than shrinking the row to the root. Taking the workspace out of start takes a reviewed row change that names it in `lazyChunks`, and `test/budgets.test.js` pins today's `startChunks: ["workspace"]`.
- `npm run perf:probe`'s byte mode files every chunk behind an `import()` as lazy, the workspace too, so its start number for the new tab is the root's. The build's number, and `dist-report/chunk-graph.json`, are the start the row holds.
- Bytes are raw and gzip at level 9, the way `npm run perf:probe` measures them.
- Every other byte row is `null`: no approved number yet. That covers the Popup's and Side Panel's CSS and HTML, every page's fonts, and the service worker. Offscreen loads no stylesheet, so its CSS row is `null` too.
- Offscreen's rows are today's size plus about 5%, set on 2026-11-01 from `7489d7b3`: start JS 28,150 / 8,818 bytes (the page's module and `js/network-guard.js`), and HTML 230 / 174. Its HTML row is 1 KiB, the smallest round row, since 5% of 230 bytes is 12. The workspace coordinator decided them for the owner, who can reverse it. The service worker's start is the whole of its one self-contained module, and its cold-start time is #35's.
- The new tab's CSS row was first 100 KiB raw, sized from CSS CleanCSS minified, before #99 moved the build to lightningcss, which doesn't merge rules that aren't next to each other: the same sources minify about 5 KiB larger raw, while gzip went down. On 2026-10-31 the raw row went to 105 KiB, today's size plus about 5%, the rule the owner set for these rows: 102,274 bytes on `next` (126 under the old row), 103,744 with #27 slice 3b's failure and status states, and about 103,860 with #20 slice 4b's Settings section. The gzip row stays 19 KiB (16,672 bytes with 3b). The workspace coordinator decided it for the owner, who can reverse it. CSS beyond the row still needs the owner's call first.

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
- `scripts/perf/gate-report.js` writes the job summary, even when the probe exits 1 for an invalid run. For each profile it shows whether the run is valid, the candidate's median ratio to both 1.4.0 runs against the 7% row, its heap against 3.10 MiB plus 3%, and the absolute milliseconds beside them. A profile is invalid when 1.4.0 against itself is more than 7% off, when any round of any package failed, when the probe reported a problem (a fixture that isn't the recorded one, for one), or when it ran fewer than 12 rounds. A package that measured nothing, say because every candidate round failed, makes it invalid too, rather than stopping the summary. Then its timing and heap both say `invalid`, with the reasons listed.

Both rows say `mode: gate`. A timing fail, a heap fail, or a run the summary calls invalid fails the `perf` job.

- **Timing became a gate** on 2026-10-31, under the rule it reported by until then: gate after 10 CI runs if 1.4.0 against itself stayed within 7% on at least 9 and the invalid-run check would have passed. The workflow had run on 14 pushes to `next`, `f7a17e5e` to `7489d7b3`, and all 14 were valid. The worst 1.4.0-against-itself median was +2.6% on `typical` and -2.2% on `maximal`, and the candidate was 43 to 53% faster than 1.4.0 on every run.
- **Heap became a gate** on 2026-11-01, at today's heap plus about 5%, the rule the owner set for the byte rows. The workspace coordinator decided it for the owner, who can reverse it. CI's 1.4.0 heap is 3.94 to 3.98 MiB over 14 runs on `next`, and the Mac's is 3.94 to 4.01, so a MiB number means the same on both. The candidate measured 2.68 MiB on `typical` and 2.56 on `maximal` on `7489d7b3` (perf run 41280346766), so the row is 2.81 MiB (2.68 × 1.05), failing above 2.89 with its 3%. One number gates both profiles, so `maximal` has more room. The row it replaces, 4.45 MiB, was `next`'s heap on the Mac before slice 3 made the libraries lazy, 66% above today, and wouldn't have caught #106's 0.31 MiB.

- **The heap row was set again** on 2026-11-01, when #152 made the probe read the heap once the writes its own key sets off have committed. The old probe read it at the echo, while the key's save was still in flight, so a round landed in one of three modes about 0.8 MiB apart by where the save started against the collection. On the same tree, `next` at `2ae3f528`, CI's old probe read 2.685 MiB on `typical` (perf run 41354479082) and the fixed one 2.96 and 2.95, so the row moved for the probe, not for code. With the fixed probe, CI read `next` three times on `typical`, 2.96 and 2.95 MiB at `2ae3f528` and 2.94 at `ecc401a7` (perf runs 41355105542, 41357548903 and 41359820583), and 2.68, 2.68 and 2.66 on `maximal`. The row is their median, 2.95, × 1.05 = 3.0975: 3.10 MiB, failing above 3.19 with its 3%. The 2.81 it replaces came from the old probe's 2.68 on `7489d7b3`.

A flip changes the row's `mode` to `gate` in its own reviewed PR. From then on `gate-report.js` exits 1 on a fail or an invalid run, which fails the `perf` job. That alone blocks nothing: `perf` isn't a required check. `pr-gate` needs only `unit`, `typecheck`, `kernel`, `build` and `extension`, and the rulesets require only `pr-gate` (`test/budgets.test.js` holds both). Timing blocks a merge only once `pr-gate` needs it (a `perf` job in `.github/workflows/pr-checks.yml`, in `pr-gate`'s needs), or once a ruleset requires the `perf` check. Either is the owner's call, in the same PR as the flip.

## Changing a number

1. Measure it: `npm run build` prints each entry's start, and `dist-report/chunk-graph.json` has the rest. For timing, use `npm run perf:probe` interleaved against 1.4.0.
2. Take the number and its evidence to the owner through the lead.
3. Change the row in a PR that says why and links the evidence, and get it reviewed. Nothing else writes the file.
