# Testing

How the tests are set up, what they're allowed to fake, and the three records that keep them honest: the known-defect ledger, the conformance inventory, and the mutant catalog.

## What runs where

| Command | What it runs | Where |
| --- | --- | --- |
| `npm test` | `test/*.test.js` and `test/kernel/*.test.mjs` under `node --test` | every PR (`pr-checks.yml`) |
| `npm run test:kernel` | `test/kernel/*.test.mjs` alone | every PR |
| `npm run test:extension` | the Playwright specs in `e2e/`, on the built extension in Chromium. A self-test that edits a module edits each chunk `dist-report/modules.json` says holds it | every PR, and locally only through the machine lock |
| `npm run verify:fixtures` | one build per build failure rule, each a copy of the tree with the defect `test/build-fixtures/<rule>/fixture.json` writes, which has to fail with its `[code]` and leave no `dist/` | every PR's build job, and locally only through the machine lock |
| `npm run verify:reproducible` | two clean builds of `HEAD`, in different directories at different times, which have to package the same zip, `buildId`, and `outputDigest` | every PR's build job, and locally only through the machine lock |
| `npm run perf:probe` | a package's bytes and, with `--timing`, its interaction-ready time and heap on `ref-desktop` ("The performance probe") | by hand, and through the machine lock with `--timing`; `e2e/perf-probe.spec.js` runs one timed run on every PR |
| `npm run test:mutants` | the mutant catalog, `scripts/mutants.js` | by hand, when reviewing a test PR that touches a protected behavior |

`test/test-files-run.test.js` fails `npm test` when a `*.test.js` or `*.test.mjs` under `test/` isn't reached by a script the workflow runs, so a test file in a new folder can't sit there unrun.

## Fixture rules

1. Tests load the production files. No copy of a production method, no reimplementation of what it does. `test/helpers/legacy-env.js` loads the legacy 1.4.x scripts unmodified into a `node:vm` context, as classic scripts, the way 1.4.x loaded them. The bundler folds them into chunks since #27 slice 2, so a legacy file holds nothing a classic script can't parse, such as `import.meta`, and the composition root hands it what needs one (the indexer's starter, `js/kernel/composition/workers.js`). Kernel tests import the modules under `js/kernel/` directly.
2. Fakes stand in for the browser only: `fake-indexeddb` (pinned) for IndexedDB, and `legacy-env.js`'s stubs for `chrome.*`, timers, `navigator.locks`, `BroadcastChannel`, and a small DOM. Nothing in `js/` has a test-only branch.
3. A fake of a browser API is held to the real one. The `chrome.storage.local` stub runs `test/helpers/chrome-storage-suite.js` in Node, and the same suite runs in Chromium in `e2e/chrome-storage.spec.js`. Where they differ, the stub changes.
4. Databases are built with raw `indexedDB.open` calls (`createDatabase` in `legacy-env.js`), so a test sees what a 1.4.0 or newer build would have left on disk, not what app startup would make of it.
5. Failures are injected at the boundary. `test/kernel/storage-faults.mjs` wraps the IndexedDB factory and can make the next write throw, let it succeed and then abort its transaction, or fail the next read. It never changes the adapter under test.
6. The contract suites run on every implementation through their fixtures: `test/kernel/legacy-fixture.mjs` for the legacy adapter, `test/kernel/storage-fixture.mjs` for the IndexedDB adapter, and the memory adapter directly. `test/kernel/support.mjs` has the clock the test moves, counting ids, and a caller per surface.
7. Test data is synthetic. No real notes, keys, passwords, or tokens. A secret a test needs is a made-up canary, and no assertion message prints it.
8. The extension harness (`e2e/harness/`) launches the built extension on a fresh profile per test. Characterization specs act through `e2e/characterization/driver.js` and assert on what it returns, never on app state.

## Storage fixtures

`test/fixtures/storage/` holds profiles in one declarative format, `ntn-storage-fixture/1`: a header, each IndexedDB database with its stores, indexes, and records, and the `chrome.storage.local` entries. Values JSON can't hold are tagged (`{$type: 'Blob', ...}`), and a secret is only ever a `{{CANARY:<slot>}}` placeholder. #61 (#17 PR 1a) added the format, `loadFixture` and `dumpFixture` in `load-fixture.mjs`, `shapes.json`, the synthesized fixtures, and their expected outputs. #28 slice 3 added the rest.

| Where | What | Made by |
| --- | --- | --- |
| `synthesized/` | one fixture per shape and degraded variant in #17's support matrix | `scripts/fixtures/synthesize-storage.mjs` |
| `recorded/` | what each release from v1.0.0 to v1.4.0 wrote for a synthetic seed, through its own code | `scripts/fixtures/record-release.mjs` |
| `expected/` | each synthesized and recorded fixture after the registry runs to 9, derived without the runner | `scripts/fixtures/derive-expected.mjs` |
| `generate.mjs` | the maximal profile and the corrupt ones (truncated, mistyped, dangling, oversized, duplicate Daily Notes), made at test time and never committed | the tests |

`npm test` checks every committed file: the format, under 256 KiB, key order, its shape, no secret outside a canary, an expected file for each, and a recorded fixture's fields covered by the synthesized one of its shape. That last check is how a recording shows a field #17's synthesizer missed. Fix the synthesizer, then rerun both scripts.

`loadFixture` writes a fixture without running app code, 100 records per transaction. It's atomic per transaction, not per store: a load cut off partway leaves the cut transaction's writes out and keeps the ones before it. `dumpFixture` rejects rather than hand back a store it didn't read to the end. Both run in Node and, through `e2e/harness/fixture-host.js`, in an extension page or the service worker with the same options.

The maximal profile takes its block types from `js/blocks.js`, its serializer from production's `Block`, and its settings from `initializeDefaultSettings` (`test/kernel/generated-inputs.mjs`), so a new block type or default setting is covered with no edit. `maximalProblems` fails on a missing store, key, block type, or setting. Expected outcomes for the generated profiles come from the generator's `roles`, never from what the code under test answers. Where production is wrong, the test is an expected failure in the ledger.

To re-record a release, one tag per run (each is a Playwright run, so locally it goes through the machine lock):

```
git fetch --tags origin
node scripts/fixtures/record-release.mjs v1.4.0
node scripts/fixtures/derive-expected.mjs
```

The recorder `git archive`s the tag into a scratch directory, loads it unpacked in the harness, headless, writes the seed through the release's own `Storage`, Popup, and settings, and dumps it with each canary back to its placeholder. A canary the release changed fails the run. The header pins the tag's commit and tree, and lists the write paths that ran. `test/kernel/storage-recorded.test.mjs` checks those pins against the tags. CI's unit job fetches the tags and sets `NTN_RELEASE_TAGS=required`, so a missing tag fails there; a local clone without them shows the check as skipped. Nothing is downloaded, and a release Chromium won't load falls back to #17's synthesized fixture for its row, listed in the test's `FALLBACKS`.

## The performance probe

`npm run perf:probe` (#27 slice 4a) measures a built extension from the outside: its pages, its marks, and CDP. It never reads how the package was built, so it runs the same on the legacy build, the 1.4.0 package, and a bundler's output. It writes JSON to `dist-report/`, which git ignores.

- **Bytes** (always, no browser): for the new tab, the Popup and the Side Panel, the JS, CSS, HTML and font bytes, raw and gzip at level 9, of what each page loads before it runs, and its module count. That's its `<script src>` and `<link rel="modulepreload">` files and every static import reached from them, its stylesheets and their `@import`s, and the fonts they name. Two buckets sit outside that total: `lazy`, what a literal `import()` in it loads, and `workers`, what a `new Worker()` in it starts (a literal path, or `new URL(..., import.meta.url)`), each with what they import in turn. A non-literal `import()` is only counted. A reference in the page's own closure to a file the package lacks fails the probe, and a lazy chunk or worker the package lacks is listed as `missing` (1.4.0's indexer). `scripts/perf/package-bytes.js` reads them, and slice 4b's analyzer reuses its `sizesOf`.
- **Timing** (`--timing`, a Playwright run, so locally it goes through the machine lock): for each fixture profile, `--runs` rounds of install-cold runs (11 by default), each on `ref-desktop`, reported as the median, quartiles, minimum and maximum. `scripts/perf/timing.js` runs them. With two or more `--dist`s the runs interleave: every round runs each package once, the order rotated each round (AB, BA for two; ABC, BCA, CAB for three), and each package also gets its per-round ratio to the first. When the second package is the first one again, each later one also gets its ratio to the mean of the two copies. The machine drifts by up to 10% between sessions, so compare packages only within one run of the probe, by that ratio. `--baseline <file>` makes it a gate run: it refuses to start unless the first two packages are the baseline's reference package (by a SHA-256 over its sorted files) and the rounds are at least 12 and a multiple of the package count (12, 15, 18 for three), so each package runs in each position equally often, and it fails when a profile's fixture isn't the one that baseline measured (`maximal` comes from this tree's code, so a later commit can change it) or when the reference against itself is off by more than the tolerance, which makes the run invalid.

`ref-desktop`, the reference environment:

- #34's harness (`e2e/harness/`): Playwright's pinned Chromium, headless, a fresh profile per run, a 1280 by 800 viewport, and `en-US` in UTC.
- The network is off in Chromium itself (the harness's `network: 'offline'`: a dead proxy and no host resolution), from pages and the service worker alike. The functional e2e block the network with a route instead, which sends every one of the extension's own requests through Playwright's process, 49 per new tab on 1.4.0 and 90 on `next`, so it would charge a package for its file count. `e2e/perf-probe.spec.js` checks that the offline mode still stops requests outside the extension.
- 4x CPU throttling (CDP `Emulation.setCPUThrottlingRate`) on the new tab, from when the harness first sees the page: 10 to 27 ms after its document exists in the baseline's runs, the same for every package. Playwright can't throttle a page before it has one. The report gives both times on the page's clock (`throttledAtMs`, `documentAtMs`).
- Install-cold: the package installs, the profile is seeded through the fixture host into the service worker, the probe waits 1 s, and then the service worker opens the new tab with `chrome.tabs.create`.
- Interaction-ready runs from that `chrome.tabs.create` to the first printable key echoed in the focused editor. The driver waits for an editable block in the editor, focuses it, types one key, and stops the clock when the key is in the block's text. So the time includes how long the driver took to see the editor, which the report gives as `driverMs`. The page's own `performance.mark('ntn:interaction-ready')` is read too where the package has one. The legacy app marks when the first `editor.loadNote` on any `App.init` path resolves (the welcome note, a first note, the restored or first listed note), or, with no note to load, once the start updates its empty state. `e2e/interaction-ready.spec.js` pins each path. 1.4.0 has no mark.
- JS heap is CDP `Runtime.getHeapUsage`'s `usedSize` after `HeapProfiler.collectGarbage`, at interaction-ready.

The fixture profiles (`scripts/perf/profiles.js`), each recorded in the report by its SHA-256:

| Profile | What it holds |
| --- | --- |
| `first-run` | nothing, not onboarded: the new tab runs the 1.4.0 walkthrough over the welcome note |
| `typical` | `recorded/v8.v1.4.0.json`, what 1.4.0's own code wrote for a synthetic seed (eight notes in a folder, archived, trashed, a Daily Note and a template, media, a snapshot, backups and settings, the welcome note last opened), onboarded |
| `maximal` | #73's maximal profile from `generate.mjs`, every record type past #17's copy bounds, from this tree's block types and default settings, onboarded |

```
npm run perf:probe                                      # bytes for dist/
npm run perf:probe -- --dist <dir> --label 1.4.0        # another package
npm run perf:probe -- --dist <1.4.0> --label 1.4.0 --dist dist --label next --timing --profiles typical,maximal
```

`docs/performance/baseline-1.4.0.md` is the first report: 1.4.0 against itself and against `next`, interleaved, on every profile, and the budget numbers proposed from it. The browser-cold, post-update and warm scenarios, and IndexedDB read and off-origin request counts, are deferred to the backlog.

## The known-defect ledger

`test/known-defects.json` lists what fails at the legacy 1.4.x code. Each entry has an `id` (`KD-` and three digits), the `ownerIssue` whose fix removes it, `evidence` (a GitHub link pinned to a full commit SHA, with a line anchor), the `tests` that fail because of it, and optionally `uncaught`, the exact exception messages the smoke tests tolerate. `e2e/harness/known-defects.js` has the format.

A ledgered test is a real test of the right behavior that fails today:

- in Node, `expectFailure(title, body)` from `test/helpers/expect-failure.js`;
- in the harness, `test.fail(title, body)`.

The title starts with the id and stays a string literal. `test/known-defects.test.js` checks titles and entries match both ways, and a listed test that passes fails the run.

To add an entry: confirm the defect on `next`, write the test against production code, declare it with `expectFailure` or `test.fail`, and add the entry with the next free id and a pinned evidence link.

To remove one: the PR that fixes the defect deletes the entry, turns each of its tests into a plain `test()` or `it()`, and drops the id from the titles. The run fails until it does, since the expected failure starts passing.

## The conformance inventory

`test/kernel/conformance-inventory.mjs` lists every port that has a shared conformance suite, the suite, each implementation, and the test file where that run happens. `test/kernel/conformance-coverage.test.mjs` fails `npm test` when an implementation has no run, a suite has no implementation, a contract in `js/kernel/core/ports/` is unlisted, or a run doesn't really run the suite. `test/kernel/conformance-coverage.mjs` says how each is found: by where a module is, by its type against the port's typedef, and by its shape (a `connect` method, a `defineFamily` call, a `local` key with `get` and `set`).

A new module under `js/kernel/`, or a new fake of a port anywhere, fails the check until it's classified. Pick the one that's true:

1. It implements a port in `PORTS`: add it to that port's `implementations` with its run, and make that test file call the suite's runner with something made from the module.
2. It implements a contract with no shared suite yet: list it under that contract in `WITHOUT_SUITE`. A second implementation of the same contract means the contract gets a suite and moves to `PORTS`.
3. It's part of an implementation that loads it: `HELPERS`, naming the implementations.
4. It hands out implementations without being one, like a composition root or a test fixture: `COMPOSERS`.
5. It's the only implementation of an interface no port defines: `UNSHARED`, with the test that covers it.
6. It's in an area that isn't an implementation by where it is (`NOT_IMPLEMENTATIONS`). It still has to be classified if its type or shape says it implements a port.

`EXEMPT` holds an implementation that runs no suite, with its owner and why it can wait. The check fails once the exempt code is gone, so the entry leaves with it.

## The mutation review

`test/mutants/catalog.json` proves the critical tests fail when the behavior they protect breaks (#28, AC4). Each mutant is one exact edit to one file and the test that has to fail once it's made:

| Field | What it holds |
| --- | --- |
| `id` | kebab-case, unique |
| `behavior` | the approved test plan's behavior it samples: commit waits, schema fields, backup inclusion, placeholder health, auth checks, conflict branches, plus the #33 save fixes, the #46 note-leave rules, and the conformance runs |
| `protects` | the protected behavior, in a sentence |
| `file` | the file it edits, from the repository root: production code, or test infrastructure when that test protects a gate |
| `find` | text that occurs exactly once in `file` |
| `replace` | what takes its place |
| `test` | the test file that has to fail |
| `name` | the test in it that has to fail: its own name, or `Suite > name` where its own isn't unique in the file |

`pending` lists behaviors whose code hasn't landed, each with `waitsFor`, the issue that lands it. The sanitizer rules wait for #21.

Most mutants edit production code. A mutant may edit test infrastructure when that code is itself a gate that protects a behavior, as the conformance runs' two mutants edit #64's inventory and its coverage check.

`npm run test:mutants` copies the tree to a scratch directory (`node_modules` is linked) and never touches the working tree. It runs each named test file once as it is, with the flags `npm test` uses, and stops if a named test fails there. Then it makes each mutant in the copy, checks the mutated file still parses (`node --check`), runs its test file, and puts the file back. A mutant is:

- killed when its named test fails and at least one other test in the file still passes;
- survived when its named test passes, or doesn't run. The report lists any other test that failed, which usually means the catalog names the wrong test;
- stale when its `find` doesn't occur exactly once, or its `name` matches no test or more than one;
- invalid when the mutated file doesn't parse, or every test in the file failed. `legacy-env.js` loads the legacy scripts into each test, so a mutant that makes one of them throw as it loads fails every test, the named one included, and proves nothing about the behavior.

Anything but killed fails the run. The report records what else failed for every mutant, killed ones included. `--only <id>` runs one mutant, `--json` prints the report as JSON, and `--keep` leaves the scratch copy and prints where it is. Ctrl-C (SIGINT) or SIGTERM stops the run, removes the scratch copy, and exits 130 or 143. The script only runs `node --test` files today, so every mutant names a unit test.

### Adding a mutant

1. Pick the smallest edit that breaks the behavior the way a real bug would: drop a check, flip a condition, answer before a wait, leave a record type out. Not a syntax error or a throw at load, which the run reports as invalid.
2. Copy `find` from the file exactly, with enough context to occur once. `\n` in JSON is a line break.
3. Name the test that should catch it, and run `npm run test:mutants -- --only <id>`.
4. If it survives, the test is missing or weak. Write the test, check it passes on the real code and fails with the mutant (the script does both), and keep the mutant as it was. Don't weaken a mutant to make it die.
5. When a refactor moves the protected code, the mutant goes stale. Update its `find` in the same PR.

Mutants that drive the extension suite would need a build of the scratch copy first. None do yet. When one does, run the review through the machine lock.
