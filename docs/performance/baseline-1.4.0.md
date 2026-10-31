# Performance baseline: 1.4.0 and `next`

#27 slice 4a. The owner approved the numbers on 2026-10-31, with option 2 for heap (4.45 MiB); [budgets.md](budgets.md) has them as `build/budgets.json` holds them, and how each gate runs. #27's budgets need numbers the owner approves after a measurement of the 1.4.0 package. This is that measurement, with `next` beside it, and the numbers it proposes. Nothing here is a budget yet: slice 4b writes `build/budgets.json` with the numbers the owner approves, and no script writes that file.

`baseline-1.4.0.json` holds the probe's report as `npm run perf:probe` wrote it, every run's value and every file included, the fixtures' digests, and the proposal below.

## How it was measured

One run of the probe on `ref-desktop` (docs/testing.md, "The performance probe"), from outside each package, with three packages interleaved:

- **1.4.0**: the `v1.4.0` tag (`e93b21e`), exported with `git archive` into a scratch directory, installed with `npm ci --ignore-scripts` from its own lockfile, and built with its own `npm run build`. Its build reports 773 type warnings and goes on, as 1.4.0's always did.
- **1.4.0 again**: the same package a second time, so the run measures 1.4.0 against itself. That's what the timing tolerance is sized from.
- **next**: `next` at `6ddb4e1`, plus this PR's `ntn:interaction-ready` mark, built with `npm run build -- --strict`.

Each profile had 12 rounds. Every round ran each package once, on a fresh profile with the network off in Chromium and 4x CPU throttling. The order rotated each round (ABC, BCA, CAB), so over 12 rounds each package ran in each position four times. Each package's time is also given as its ratio to 1.4.0's in the same round, and that ratio is the comparison. The run was on 2026-10-31 on an Apple M5 Pro (18 cores, 48 GiB) with macOS on arm64, Node 24.18.0, and Playwright's Chromium 156.

The Mac is shared, and the machine lock has no exclusive mode this weekend. Another stream's run (`ntn27s2-r6`) held the other slot for the whole probe, and the 1-minute load averaged 32 (51 at most). The interleaving and the ratio cancel the drift between sessions. The load and the wider spread it brings stay in the numbers, which is why a gate machine sizes its own tolerance from its own run of 1.4.0 against itself.

An earlier version of this report timed each package in its own session, so the machine's drift between sessions landed on one side. It said `next` was 17% slower on `typical`, which was mostly the method. Its harness also blocked the network with a route, which sent each of the page's own requests through Playwright's process: 49 per new tab on 1.4.0 and 90 on `next`, so it charged `next` for its file count. Both are fixed here.

## Bytes

What each page loads before it runs. KiB, raw / gzip at level 9. The bytes come out the same on every run.

| Page | Package | HTML | JS | CSS | Fonts | Total | JS files (modules + classic) | Lazy | Workers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| New tab | 1.4.0 | 65.3 / 10.0 | 1,651.1 / 427.1 | 93.1 / 16.9 | 0 | 1,809.6 / 454.0 | 46 (42 + 4) | 0 | 0 (indexer missing) |
| New tab | next | 68.8 / 10.6 | 1,769.6 / 473.3 | 94.8 / 17.3 | 0 | 1,933.2 / 501.1 | 87 (83 + 4) | 256.0 / 46.7 (20 files) | 1.0 / 0.5 (the indexer) |
| Popup | 1.4.0 | 11.7 / 2.9 | 5.7 / 1.9 | 0 | 0 | 17.3 / 4.7 | 1 (0 + 1) | 0 | 0 |
| Popup | next | 15.2 / 3.5 | 103.1 / 36.0 | 0 | 0 | 118.4 / 39.5 | 37 (37 + 0) | 0 | 0 |
| Side Panel | 1.4.0 | 5.2 / 1.7 | 3.7 / 1.6 | 0 | 0 | 8.9 / 3.3 | 2 (0 + 2) | 0 | 0 |
| Side Panel | next | 8.8 / 2.3 | 101.6 / 35.8 | 0 | 0 | 110.4 / 38.1 | 38 (37 + 1) | 0 | 0 |

- On both, the new tab's four classic scripts are the vendored libraries (`fuse.js`, `jszip.min.js`, `chart.js`, `transformers.js`). They are 1,137.1 / 293.5 KiB of 1.4.0's JS and 1,156.4 / 296.0 KiB of next's. Without them the rest is 514.0 / 133.6 KiB on 1.4.0 and 613.2 / 177.3 KiB on next. Slice 3 moves all four behind `loadChunk`.
- next's lazy bucket is the trust code #81 loads with `import()` after a page's first failure. Its worker is the indexer #89 ships. 1.4.0 names the same worker and its package lacks the file.
- The Popup and the Side Panel are an 18x jump over 1.4.0's 5.7 and 3.7 KiB of JS. That's the kernel client (`storage.js`, the kernel's notes application, domain and legacy adapter), by design (#12).
- The Popup's 10.2 KiB and the Side Panel's 5.0 KiB of inline `<style>` count as HTML today. Slice 2 moves them into CSS files.
- No page loads a font file.

## Install-cold timing and heap

Interaction-ready is from `chrome.tabs.create` to the first typed key in the editor's text. Ratios are each round's time over 1.4.0's in that round, as the median of 12 rounds: against the first 1.4.0 copy with the middle half and the full range, and against the mean of both copies, the comparison the proposed gate makes, with its resampled 95% band. Heap is CDP `usedSize` after a GC at interaction-ready.

| Profile | Package | Interaction-ready ms, median (min to max) | Ratio to the first 1.4.0 copy, median (middle half; range) | Ratio to both 1.4.0 copies, median (95% band) | Heap MiB, median (min to max) | Heap ratio, median |
| --- | --- | --- | --- | --- | --- | --- |
| typical | 1.4.0 | 993.2 (889.4 to 1,067.7) | | | 3.94 (3.93 to 3.99) | |
| typical | 1.4.0 again | 996.0 (964.8 to 1,105.7) | -0.4% (-1.8 to +5.9; -9.3 to +14.7) | | 3.94 (3.93 to 4.11) | -0.1% |
| typical | next | 1,084.2 (988.1 to 1,162.3) | +10.4% (+5.9 to +12.7; -3.7 to +13.6) | **+7.7%** (+3.6 to +10.5) | 4.41 (4.35 to 4.42) | +11.8% |
| maximal | 1.4.0 | 858.7 (831.1 to 1,071.7) | | | 3.97 (3.95 to 3.99) | |
| maximal | 1.4.0 again | 869.3 (835.0 to 1,005.2) | 0.0% (-3.1 to +3.3; -9.9 to +11.4) | | 3.98 (3.96 to 3.99) | 0.0% |
| maximal | next | 898.9 (855.7 to 1,001.0) | +3.2% (+1.2 to +6.3; -15.3 to +18.9) | **+2.2%** (-0.6 to +5.1) | 4.44 (4.35 to 4.62) | +11.6% |
| first-run | 1.4.0 | 949.8 (860.3 to 1,149.8) | | | 4.01 (4.01 to 4.02) | |
| first-run | 1.4.0 again | 902.4 (842.8 to 1,266.7) | -1.6% (-8.0 to +6.5; -17.4 to +19.9) | | 4.01 (4.01 to 4.02) | 0.0% |
| first-run | next | 974.5 (880.8 to 1,151.9) | +3.3% (-2.4 to +5.9; -14.3 to +17.5) | +2.6% (-3.3 to +6.9) | 4.39 (4.38 to 4.40) | +9.4% |

- No run failed, and every `typical` and `maximal` run echoed the first key. `first-run` took a second key in some runs, because the 1.4.0 walkthrough moves focus to its button as it opens. Each retype costs at most about 50 ms. `first-run` is reported, not budgeted: the refinement leaves it untimed.
- next's mark comes 11.6 ms before its key echo on `typical`, and within 5 ms on `maximal`.
- About 330 to 345 ms of each time passes before the new tab's document exists: creating the tab, starting its renderer, and Playwright attaching to it. It's the same for every package, so it stays in the number. Throttling starts 10 to 27 ms after the document exists, well before `DOMContentLoaded`.
- 1.4.0 against itself stays within 1.6% at the median on every profile. Resampling its 12 rounds puts its median ratio between -1.9% and +6.8% on `typical`, and between -4.1% and +3.6% on `maximal` (2.5th to 97.5th percentile of 10,000 resamples).
- The table's ratios are against the first 1.4.0 copy only. Against the second copy, next is +7.0% on `typical`. Against the mean of both copies in each round it's **+7.7%** (resampled 95% band +3.6% to +10.5%). So next is **about 8% slower on `typical`** (band 3.6% to 10.5%). On `maximal` it's +2.2% against both copies (band -0.6% to +5.1%), and +2.6% on `first-run`.
- Its heap is about 0.45 MiB (11%) larger on every profile, whichever copy it's compared with.
- On `typical` the gap is above zero across the whole band, so it's real, and where `next` lost that time is being bisected with this probe. This report doesn't say which code costs it.

## Proposed budgets

For slice 4b's `build/budgets.json`. Bytes are absolute: the gate fails above them. Timing is a paired ratio against the frozen 1.4.0 package, and heap is absolute with its own small tolerance.

### Timing: a paired ratio against 1.4.0

- **Rule**: each gate run times the frozen 1.4.0 package twice and the candidate once a round, interleaved and rotated, on one machine, for at least 12 rounds per profile and a multiple of the package count (12, 15, 18 for three), so each package runs in each position equally often. The frozen package is the build this report measured; its SHA-256 over its sorted files is in the JSON's `reference`, and `perf:probe --baseline` refuses a run whose first or second package isn't it, or whose rounds are fewer than 12 or not a multiple of the package count.
- It fails when the median of the candidate's per-round ratio to the mean of the two 1.4.0 runs is above 1 + `tolerancePct`. It's **invalid**, not a pass, when 1.4.0 against itself is more than `tolerancePct` off; `--baseline` reports that. That check catches only gross noise: 1.4.0 against itself sat within 1.6% here. The absolute milliseconds go in the report beside it, for reference, not as the gate.
- **The interleaving cancels drift between sessions, not load or hardware.** 4x throttling is relative to the host, and this run went at a load of 32 (51 at most) beside another stream's run, which widened the spread. A gate machine sizes its own tolerance from its own run of 1.4.0 against itself, and this number is this machine's.
- **`tolerancePct`: 7**, on `typical` and `maximal`. That's the top of 1.4.0's own resampled band on `typical`, 6.8%, rounded up, so 1.4.0 against one copy of itself passes 39 times in 40. The gate compares against the mean of two copies, which is less noisy, so 7 is slightly loose for the gate's own comparison, and "39 times in 40" describes the single-copy one.
- **What 7 lets through.** With 12 rounds the median ratio moves about ±3.5% from run to run, so a true +7% regression passes about half the time, and only about +10% fails reliably. The line is "no more than about 7% slower than 1.4.0". 24 rounds narrow the band, and so does the second reference copy each round that this rule already asks for.
- **Today**: next is borderline on `typical`: +7.7% against both copies, with a band of +3.6% to +10.5% that straddles the line. It passes `maximal` (+2.2%). Slice 3's lazy boundaries take 1,156.4 KiB of libraries out of the start, which may or may not cover the gap.

### Heap: absolute MiB, the owner's choice

`tolerancePct` 3 for heap. 1.4.0 against itself stays within 0.1% at the median, and within 3.0% on any single round. The budget is one of:

1. **4.0 MiB, 1.4.0's heap** (3.94 to 4.01 across the profiles). With the tolerance it fails above 4.12 MiB, so next fails it at 4.39 to 4.44 until the kernel's extra comes off.
2. **4.45 MiB, next's heap** (its highest median, 4.44), accepting the kernel's extra of about 0.45 MiB (11% over 1.4.0) as the cost of #12's kernel. With the tolerance it fails above 4.58 MiB, so it lets heap grow to about 0.6 MiB over 1.4.0 before anything fails.

### Bytes: absolute

| Row | New tab | New tab on next | Popup | Popup on next | Side Panel | Side Panel on next |
| --- | --- | --- | --- | --- | --- | --- |
| JS | 700 / 200 KiB | 1,769.6 / 473.3 | 115 / 40 | 103.1 / 36.0 | 112 / 40 | 101.6 / 35.8 |
| CSS | 100 / 19 KiB | 94.8 / 17.3 | 12 / 4 | 0 | 6 / 2.5 | 0 |
| HTML | 72 / 12 KiB | 68.8 / 10.6 | 16 / 4 | 15.2 / 3.5 | 10 / 3 | 8.8 / 2.3 |
| Fonts | 0 | 0 | 0 | 0 | 0 | 0 |
| JS files | 90 | 87 | 40 | 37 | 40 | 38 |

- **New tab JS**: slice 3 takes the four vendored libraries out of the initial closure, which leaves 613.2 / 177.3 KiB on next. About 13% above that leaves room for slice 2 and 3's loader and boot code, and it's under half of 1.4.0's 1,651.1 / 427.1. next fails it today on purpose: 4b lands after slice 3.
- **New tab CSS and HTML**: today's plus about 5%. Slice 3's lazy chunks bring their own CSS, in the lazy bucket.
- **Fonts**: no page loads one. Adding one should take a reviewed budget change.
- **JS files**: the probe counts files the page loads. A bundle loads far fewer, so this only catches an explosion of tiny chunks. The analyzer's module count per chunk is 4b's row, and gets its number once slice 2 builds.
- **Popup and Side Panel**: JS is next's plus about 10%. Nothing in #27 makes either page smaller, and #4 and #5 own them after that. CSS has room for the inline `<style>` slice 2 moves out of the HTML. HTML stays at today's size plus a little, so the limit fits before and after that move. Their timing and heap rows stay `null` until #4 and #5 define a ready mark.
- **Lazy and workers** have no proposed limits here. They're reported so slices 2 and 3 land on the same ruler, and 4b's forbidden list guards what may go in them.

## What this doesn't cover

- Zip bytes, update size, the dependency allowlist and the forbidden list. Those are 4b's, from the analyzer.
- The scenario matrix (browser-cold, post-update, warm, p90) and the IndexedDB read and off-origin request counts. Those are deferred to the backlog.
- `maximal` is generated from the tree's own code (`generate.mjs`), so a later commit can change it. `fixtureDigests` records the one measured here, and `perf:probe --baseline docs/performance/baseline-1.4.0.json` fails a run whose fixture differs.
