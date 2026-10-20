# ADR 0001: Kernel stack

- Status: Accepted
- Date: 2026-10-20
- Issue: [#12][i12] (application kernel), slice 0

#12 replaces the `App` object, and the copies of state its controllers keep, with one typed kernel that every surface calls through commands and queries. This record fixes what the kernel is written in, how it's checked, loaded, and tested, where its files live, and where it runs. It merges before any kernel code.

## Starting point

At `3706d84` (1.4.0):

- `newtab.html` boots from one module, [`js/main.js`][main], which is 41 side-effect imports that each publish a `window` global. Vendored libraries load before it as classic scripts ([`newtab.html` L1243-L1247][newtab-scripts]).
- Popup and Side Panel load classic scripts ([`popup.html` L486][popup-script], [`sidepanel.html` L239-L240][sidepanel-scripts]). The service worker loads `utils.js` and `storage.js` with `importScripts` inside a try/catch ([`background.js` L7-L11][bg-import]).
- `scripts/build.js` minifies each file in [`JS_FILES`][build-list] on its own, with no bundler. A listed file that's missing is skipped with a warning ([L278-L281][build-skip]), and a file nobody listed never reaches `dist/`.
- [`jsconfig.json`][jsconfig] checks `js/` with `strict: false`, and the build only warns about the result ([L362-L379][build-tsc]). It reports 773 diagnostics.
- There's no linter or formatter. [`npm test`][npm-test] runs `node --test test/*.test.js` over 118 tests in CommonJS files, some of which stub browser globals.
- Extension pages run under `script-src 'self' 'wasm-unsafe-eval'` ([`manifest.json` L68-L70][csp]), so there's no `eval`, no `new Function`, and no remote code.

## Layout

```text
js/kernel/
  core/                host-neutral, no browser API or legacy global
    domain/
    application/       one module per aggregate, no barrel file
    contracts/         command and query catalog, outcome type
    ports/
    memory/            in-memory adapter
  adapters/
    legacy/            ports over DatabaseManager and chrome.storage.local
  composition/
    newtab.js
    popup.js
    sidepanel.js
    background.js
  package.json         "type": "module" for Node, not shipped
js/lib/valibot/        vendored ESM build, .d.ts, and license
test/kernel/           *.test.mjs
tsconfig.kernel.json   strict check over js/kernel and test/kernel
eslint.config.mjs      lint and boundary rules
docs/architecture/kernel-ledger.json
```

- `js/kernel/core/**` imports only from itself and `js/lib/valibot/`.
- Each composition root builds one context's kernel and hands out clients. It also supplies the caller (`{surface, contextId}`) that the policy port checks, so a payload can't claim a surface. The new-tab root replaces the [bootstrap][bootstrap] at the end of `js/app.js` and constructs `App`.
- Nothing outside `js/kernel/` imports from `js/kernel/adapters/`.

## Where the kernel runs

Every new tab, the Popup, the Side Panel, and the service worker each host their own in-process kernel. No instance holds authoritative in-memory aggregates. Projections load from the repository and update from their own context's commits. Client calls are async, and payloads and outcomes are structured-clone safe, so [#35][i35] (background coordinator) can repoint the client at the coordinator without touching callers.

The owner's spec (section 7.1) says a background coordinator serializes durable writes, and that stands. #35 builds it. Until it lands, each context commits on its own, and the gap is handled like this:

1. Each command's field-scoped read and write run in one IndexedDB readwrite transaction per store, with no other `await` in between. `saveNoteContent` writes the note's fields and blocks in one transaction over `canvases` and `elements`.
2. Two contexts writing one note's blocks can still race. That's a `declared-gap` row in the ledger, owned by [#17][i17] (repositories and migrations).
3. A projection sees another context's commits on its next repository read, until [#13][i13] (message contracts) adds events. Nothing in `js/` uses `BroadcastChannel` today, so notes behave as they do in 1.4.0. Preferences keep their cross-tab propagation through `chrome.storage.local`.
4. Startup maintenance runs from the new-tab and service-worker roots only, as today. Popup and Side Panel open the database unversioned, with no repair, upgrade, or maintenance, and a newer on-disk version returns `unavailable`.

#35's acceptance criteria require every repository write to commit through the coordinator, with an architecture test that also covers the roots [#2][i2] (Moment) and [#3][i3] (Workspace) add later. Per-context kernels are the step before that.

## Decisions

### 1. JavaScript ES modules with JSDoc types, checked strictly in the kernel

**Context.** The kernel's catalog, outcome union, and ports need checked types from the first PR. The legacy run isn't strict and only warns, and 184 of its 773 diagnostics are reads of the legacy `Storage` global that TypeScript takes for the DOM's `Storage` interface. `.ts` sources would need a compile step the build doesn't have.

**Decision.** Kernel code is JavaScript ES modules with JSDoc types. A new `tsconfig.kernel.json` (`checkJs`, `strict`, `noEmit`) covers `js/kernel` and `test/kernel` with the existing `typescript` devDependency, and `npm run typecheck:kernel` must report zero diagnostics. `jsconfig.json` stays non-strict for the legacy files.

**Alternatives considered.**

- TypeScript sources now. They need a compile step. Emitting the kernel alone with `tsc` adds a second pipeline that [#27][i27] (route builds) would replace, and #27 owns the `.ts` question along with its bundler.
- Turning on `strict` in `jsconfig.json`. Legacy files fail it today, so it couldn't be a required check until the rewrite is done.
- Untyped kernel code. The outcome union and the catalog would be conventions, and #12 requires every surface to consume outcomes without reinterpreting them.

**Consequences.**

- The browser loads kernel files as they are, so no kernel slice needs a compile step.
- No legacy file enters the strict program. Kernel code reaches legacy objects through hand-written declarations, and has to type the legacy `Storage` global explicitly, since TypeScript otherwise reads it as the DOM's `Storage`. #27 later applies the same rule to every strict project.
- `typecheck:kernel` runs in [#34][i34]'s required PR check until [#29][i29] (PR CI) takes it over.

### 2. Valibot for schemas, vendored under `js/lib/valibot/`

**Context.** #13, [#14][i14] (block registry), #17, [#18][i18] (backup and restore), and [#25][i25] (settings routes) validate data where it crosses a trust boundary: messages between contexts, repository reads, imports, and settings. The library has to run under the extension CSP, load without a bundler in pages and in the service worker, and give JSDoc-visible types from the schema itself.

**Decision.** Valibot. Its ESM build, `.d.ts`, and license are vendored under `js/lib/valibot/` at one exact version, recorded in the PR that adds them. Types come from the schemas through JSDoc, with nothing generated. It's the only thing outside `js/kernel/core/` that core may import. The build ships the ESM build and the license, not the `.d.ts`.

**Alternatives considered.**

- Ajv with JSON Schema. Ajv compiles each schema with `new Function`, which the CSP refuses, and its precompiled standalone validators need a build step.
- Zod. Zod 4 tries `new Function` for a faster object parser unless `jitless` is set before any schema exists, and the CSP reports that attempt as a violation even though Zod catches it. Valibot never generates code, and with one function per export, #27's bundler can keep only the validators each chunk uses.
- Hand-written validators. Five issues would each write their own, and the checks and the JSDoc types would drift apart.
- The npm package imported as `valibot`. A bare specifier needs a bundler or an import map. There's no bundler until #27, and the service worker has no document to declare an import map in.

**Consequences.**

- One schema library across #13, #14, #17, #18, and #25.
- `js/lib/` stays third-party code that lint and format rules skip.
- `scripts/build.js` walks `js/lib/valibot/` instead of listing it in `JS_FILES`, and `check:dist` covers it.
- #27's bundler swap replaces the vendored copy with the exact-pinned npm package. The kernel-core boundary rule then allows `valibot` in place of `js/lib/valibot/`, and the license stays in the notice inputs.

### 3. ESLint and Prettier, pinned

**Context.** The repo has no linter or formatter, and #12's boundaries need a checker that understands scope. `js/kernel/core/**` can't touch a browser API or a legacy global. Outside `js/kernel/`, `js/lib/`, and `js/storage.js`, files may not use `indexedDB`, `Storage`, `this.storage`, `chrome.storage`, `window.app`, `window.opener`, `LLM`, or `fetch`, or import from `js/kernel/adapters/`, and the ledger counts the legacy uses that remain. Most of those are free identifiers, not imports. Reformatting every legacy file now would bury the rewrite's diffs.

**Decision.** ESLint with a flat config in `eslint.config.mjs`, and Prettier, both as exact-pinned devDependencies. Prettier formats only `js/kernel` and `test/kernel`. ESLint runs the boundary rules (`no-restricted-globals`, `no-restricted-syntax`, and import restrictions) across `js/`, and `check:boundaries` counts their hits per file and rule against `docs/architecture/kernel-ledger.json`.

**Alternatives considered.**

- A grep script for the banned names. It can't tell a free identifier from a property, a string, or a shadowed local, so its counts would be wrong both ways.
- An import-graph checker such as dependency-cruiser. The legacy coupling runs through globals (`window.app`, `Storage`, `LLM`), which an import graph doesn't show.
- Prettier across the repo now. That reformats every file in the middle of the rewrite and conflicts with every open PR. #29 does it once, as one mechanical commit, when no PR is mid-review.

**Consequences.**

- Legacy hits go into the ledger and come out as the slices remove them. Slice 1 seeds it with `npm run check:boundaries -- --write-baseline`, the only automatic writer, and the check fails on a hit no row covers or a count that rises. #12 has the full ledger rules.
- #29 extends both configs. Its `format` check covers all first-party files, and its `lint` runs `--max-warnings 0` with the boundary rules left to `check:boundaries`.

### 4. Native ES modules, no bundler until #27

**Context.** `newtab.html` already boots from a module, but Popup and Side Panel load classic scripts and the worker uses `importScripts`. #27 brings a bundler, but it builds on this issue's seam and composition roots, so the kernel ships first in a form the browser loads directly.

**Decision.** The kernel is native ES modules with no bundler.

- `popup.html` and `sidepanel.html` load their entries as `type="module"`.
- The manifest's `background` entry gets `"type": "module"`. The worker statically imports `utils.js`, `storage.js`, and its composition root in place of `importScripts`.
- `js/kernel/package.json` sets `"type": "module"` so Node loads kernel files as modules. It isn't shipped.
- `scripts/build.js` walks `js/kernel/` and `js/lib/valibot/` instead of listing their files in `JS_FILES`.
- Exports and message payloads depend on nothing a bundler provides, so #27 can swap one in without contract changes. #27 also decides whether sources move to `.ts`. Its body currently keeps JavaScript with JSDoc.

**Alternatives considered.**

- Bringing #27's bundler forward. #27 builds on this seam, and its own slices (verifiers, the swap, lazy boundaries, budgets) would hold back every kernel slice.
- Classic scripts publishing `window` globals, like the legacy code. That's the coupling #12 removes. There's no import graph to check, and Node tests have to stub globals.
- A stopgap bundler for the kernel only. Two build pipelines until #27, then a second migration onto #27's.

**Consequences and risks.**

- The worker can use static imports only, because `import()` doesn't work in a service worker.
- A throw while any module the worker imports is evaluating stops the worker before its listeners register, and context menus and Alt+P/Alt+S disappear with no visible error. A static import has no try/catch around it the way today's `importScripts` does. Slice 1 is done only when `dist/` loads and the menus and commands register after install and after an update. It also updates #34's `test/helpers/load-background.js` so the characterization test loads the module worker.
- A module worker's top-level functions aren't globals, so `js/background.js` sets `self.captureToDailyNote` for #34's harness, and slice 4 points that name at the kernel's `captureToDailyNote` command.
- A kernel file missing from `dist/` breaks the module graph, and the new tab boots blank. The build walks the directories, so no hand-kept list can miss a file, and `check:dist` resolves every static import, `<script src>`, and the manifest's `service_worker` inside `dist/`. Removing a kernel file from `dist/` has to fail it.

### 5. Plain DOM

**Context.** The legacy UI is hand-written DOM, and the repo has no UI framework. The kernel hands out plain-data projections with no rendering dependency. Moment's critical allowlist in #27 is the storage client, the editor kernel, save status, and essential commands, and [#1][i1] keeps the canvas and editor root as the same DOM nodes when Workspace opens and closes.

**Decision.** Surfaces render kernel projections with plain DOM. A Workspace framework later needs an amendment to this record, and the amendment has to keep the framework out of the Moment chunk.

**Alternatives considered.**

- React, Preact, Lit, or Svelte now. Each adds a runtime or a compile step while there's no bundler, and puts a second UI model beside the legacy one for the whole migration. It would also have to leave the editor's DOM untouched when the aperture changes.

**Consequences.**

- No framework code loads on any capture path.
- Projections don't depend on a framework, so a later amendment can add one to Workspace without changing the kernel.

### 6. `node:test`

**Context.** `npm test` runs `node --test test/*.test.js` over CommonJS files. Kernel core is host-neutral by rule, so Node can run it unchanged.

**Decision.** Kernel tests use `node:test` and `node:assert/strict`, as ES modules in `test/kernel/*.test.mjs`. `npm run test:kernel` runs them, and so does `npm test`. One contract suite runs every use case against the in-memory adapter and the legacy adapter. The legacy run loads the production `js/utils.js` and `js/storage.js` through [#33][i33]'s `test/helpers/legacy-env.js` on exact-pinned `fake-indexeddb`.

**Alternatives considered.**

- Vitest or Jest. Another dependency and config, and their resolvers accept extensionless imports that Chrome rejects. Node's ESM loader requires the extension, as Chrome does.
- A browser runner for kernel tests. Kernel core can't touch browser APIs by rule, so Node covers it. Browser coverage comes from #34's harness and later [#30][i30] (extension end-to-end tests).

**Consequences.**

- No new test runner. `fake-indexeddb` arrives with #33, or with the first kernel PR that needs it, exact-pinned.
- The `.mjs` suffix makes kernel tests ES modules without changing the root `package.json`, so the legacy tests stay CommonJS.
- Node can't cover the editor save, the hottest write. Until #30, its browser coverage is #34's note-switch-and-save spec plus the manual pass on `dist/` that each #12 slice PR records.

## Scripts

Each exits nonzero on failure and runs in #34's required PR check until #29 takes it.

| Script | What it runs |
| --- | --- |
| `test:kernel` | `node --test test/kernel/*.test.mjs`, also run by `npm test` |
| `typecheck:kernel` | `tsc -p tsconfig.kernel.json` |
| `check:boundaries` | ESLint boundary rules against `docs/architecture/kernel-ledger.json` |
| `check:dist` | Resolves every static import, `<script src>`, and the manifest `service_worker` inside `dist/` |

## Changing this record

Change a decision by amending this file in a PR that merges before the code that depends on it. #27's bundler swap and any Workspace framework are the amendments already expected.

[i1]: https://github.com/keyurgolani/NewTabNote/issues/1
[i2]: https://github.com/keyurgolani/NewTabNote/issues/2
[i3]: https://github.com/keyurgolani/NewTabNote/issues/3
[i12]: https://github.com/keyurgolani/NewTabNote/issues/12
[i13]: https://github.com/keyurgolani/NewTabNote/issues/13
[i14]: https://github.com/keyurgolani/NewTabNote/issues/14
[i17]: https://github.com/keyurgolani/NewTabNote/issues/17
[i18]: https://github.com/keyurgolani/NewTabNote/issues/18
[i25]: https://github.com/keyurgolani/NewTabNote/issues/25
[i27]: https://github.com/keyurgolani/NewTabNote/issues/27
[i29]: https://github.com/keyurgolani/NewTabNote/issues/29
[i30]: https://github.com/keyurgolani/NewTabNote/issues/30
[i33]: https://github.com/keyurgolani/NewTabNote/issues/33
[i34]: https://github.com/keyurgolani/NewTabNote/issues/34
[i35]: https://github.com/keyurgolani/NewTabNote/issues/35
[main]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/main.js#L15-L67
[newtab-scripts]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/newtab.html#L1243-L1247
[popup-script]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/popup.html#L486
[sidepanel-scripts]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/sidepanel.html#L239-L240
[bg-import]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/background.js#L7-L11
[build-list]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/scripts/build.js#L21-L73
[build-skip]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/scripts/build.js#L278-L281
[build-tsc]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/scripts/build.js#L362-L379
[jsconfig]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/jsconfig.json#L5
[npm-test]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/package.json#L10
[csp]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/manifest.json#L68-L70
[bootstrap]: https://github.com/keyurgolani/NewTabNote/blob/3706d84938aa3102261eacb0b89351f3752da0ea/js/app.js#L6797-L6803
