# Testing

How the tests are set up, what they're allowed to fake, and the three records that keep them honest: the known-defect ledger, the conformance inventory, and the mutant catalog.

## What runs where

| Command | What it runs | Where |
| --- | --- | --- |
| `npm test` | `test/*.test.js` and `test/kernel/*.test.mjs` under `node --test` | every PR (`pr-checks.yml`) |
| `npm run test:kernel` | `test/kernel/*.test.mjs` alone | every PR |
| `npm run test:extension` | the Playwright specs in `e2e/`, on the built extension in Chromium | every PR, and locally only through the machine lock |
| `npm run verify:fixtures` | one build per build failure rule, each a copy of the tree with the defect `test/build-fixtures/<rule>/fixture.json` writes, which has to fail with its `[code]` and leave no `dist/` | every PR's build job, and locally only through the machine lock |
| `npm run verify:reproducible` | two clean builds of `HEAD`, in different directories at different times, which have to package the same zip, `buildId`, and `outputDigest` | every PR's build job, and locally only through the machine lock |
| `npm run test:mutants` | the mutant catalog, `scripts/mutants.js` | by hand, when reviewing a test PR that touches a protected behavior |

`test/test-files-run.test.js` fails `npm test` when a `*.test.js` or `*.test.mjs` under `test/` isn't reached by a script the workflow runs, so a test file in a new folder can't sit there unrun.

## Fixture rules

1. Tests load the production files. No copy of a production method, no reimplementation of what it does. `test/helpers/legacy-env.js` loads the legacy 1.4.x scripts unmodified into a `node:vm` context, the way the extension loads them as classic scripts. Kernel tests import the modules under `js/kernel/` directly.
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
