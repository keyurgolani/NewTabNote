# Release plan

How NewTabNote ships while the 1.4.x code is rebuilt. [#34] added this file and the interim release gate in [`release.yml`](../.github/workflows/release.yml), and [#31] takes both over.

## Milestones

| Milestone | Contents | Gate |
|---|---|---|
| R0 | `v1.4.1`<br>[#33] Stop live data-loss paths and restore license notices in a 1.4.x maintenance release<br>[#18] Implement complete validated atomic backup, export, import, restore, and rollback (slice 0, the pre-migration export notice)<br>[#34] Add a pre-rewrite safety net with required PR checks, legacy characterization tests, and gated publishing (the release gate) | Live in the store before the first schema change from [#17] |
| R1 | [#12] Replace the god application and duplicate controller state with a typed application kernel<br>[#13] Introduce versioned command, query, domain-event, and cross-surface RPC contracts<br>[#17] Replace ad hoc IndexedDB access with transactional repositories and sequential migrations (additive schema)<br>[#27] Introduce route-level builds, strict failure behavior, tree shaking, and enforced Moment budgets<br>[#14] Replace scattered block switches with a complete versioned block registry (internal slices)<br>[#15] Add registries for commands, inspectors, navigation, settings, codecs, search, sync, and intelligence (internal slices)<br>[#16] Establish semantic design tokens and Quiet Atlas component primitives across all surfaces (slice 1)<br>[#20] Build Trust Center and Recovery Center with inspectable health and remediation (internal slices)<br>[#28] Replace self-reimplemented tests with production-contract, migration, integrity, and adversarial tests (internal slices) | No visible change, every legacy store kept, characterization green |
| R2 | [#1] Establish the Continuity Canvas product and navigation model<br>[#2] Build the instant, lazy-loaded Moment shell and durable capture lifecycle<br>[#3] Rebuild Workspace around rail, collection, canvas, and inspector regions<br>[#6] Preserve editor, cursor, selection, undo, and save continuity across apertures<br>[#14] Replace scattered block switches with a complete versioned block registry (core)<br>[#15] Add registries for commands, inspectors, navigation, settings, codecs, search, sync, and intelligence (slices 2 to 4)<br>[#16] Establish semantic design tokens and Quiet Atlas component primitives across all surfaces (slices 2 to 5)<br>[#20] Build Trust Center and Recovery Center with inspectable health and remediation (slice 4, the views)<br>[#23] Replace blocking onboarding with progressive contextual activation<br>[#35] Build the MV3 background coordinator and scheduled-job host<br>[#7] Introduce the explainable intelligence domain and cross-surface state model (slices 1 and 2)<br>[#21] Secure credentials, AI scopes, network authority, rich content, and extension messaging (the sanitizer) | Moment ships only with Workspace and continuity |
| R3 | [#4] Rebuild Popup as the shared Daily Pulse and quick-capture surface<br>[#5] Rebuild Side Panel as the Intelligence Stream and webpage-context surface<br>[#7] Introduce the explainable intelligence domain and cross-surface state model (the rest)<br>[#8] Create the model-independent intelligence recipe and structured-output registry<br>[#36] Author tasks, due dates, reminders, and priority as structured local data<br>[#22] Rebuild search, indexing, embeddings, graph, and RAG as lazy revision-aware pipelines<br>[#18] Implement complete validated atomic backup, export, import, restore, and rollback (the rest)<br>[#21] Secure credentials, AI scopes, network authority, rich content, and extension messaging (the rest) | Daily Pulse works with no AI configured |
| R4 | [#9] Build the local inference runtime broker and capability contract<br>[#10] Build the signed Local Model Library, installer, benchmarker, lifecycle, and resource controls<br>[#11] Decouple remote AI providers, capability routing, transport, prompts, RAG, and model metadata<br>[#19] Build a provider-neutral encrypted synchronization engine with real transport adapters<br>[#25] Rebuild settings, Theme Builder, import, confirmation, and error flows as responsive Workspace routes | WebDAV first. Drive and Dropbox stay hidden until conformance passes. |
| Closure | [#24] Complete keyboard, screen-reader, touch, contrast, focus, motion, and narrow-screen behavior<br>[#26] Establish explicit loading, empty, stale, offline, permission, quota, partial-success, and recovery states<br>[#29] Add pull-request CI for formatting, strict types, tests, builds, accessibility, security, and budgets<br>[#30] Add real Chrome-extension end-to-end coverage for every product surface<br>[#31] Make releases deterministic, fail-closed, provenance-bearing, and store-consistent<br>[#32] Complete public licensing, notices, contribution guidance, and release documentation | [#31] replaces this gate |

## Rules

- `main` is tagged only for a milestone release. Patches to a published milestone come from `release/R<n>`, cut at its tag, and `preflight` fails a tag whose commit is on neither. Only the Repository admin role can create a `release/**` branch (`.github/rulesets/release-branches.json`). The owner creates each `release/R<n>` at a commit whose `push` run on `main` already reported `pr-gate` green (the milestone tag's commit, or `main`'s head when `release/R0` is cut before its tag), so the required check passes when the branch is created.
- R0 is tagged from `main` before the first [#12] PR that changes a shipped file. If #12 has to merge one first, cut `release/R0` just before it, point every remaining R0 PR there (#33, #18 slice 0, and #34 slice 2), and merge them forward. `release/R0` must contain #34's release gate (`.github/workflows/release.yml`, `scripts/release/check-version.mjs`, and `scripts/release/publish-store.mjs`) before `v1.4.1` is tagged.
- [#17]'s data transforms (placement, `dailyKey`, media, and the rest of its step 3) and [#14]'s v2 document migration and ID links run only in the service worker, batched and resumable, on [#17]'s worker runner, which [#35]'s start sequence adopts in its slice 2. This rule is about safety, and [#17]'s runner meets it, so they don't wait for [#35].
- Work that merges before an earlier milestone's tag but belongs to a later milestone stays off in release builds behind its own row in [#27]'s `build/define-allowlist.json`. That milestone's release PR turns it on, as [#18]'s `backup` row does for R3. The characterization suite runs on the release build, and its node tier loads the worker through `test/helpers/load-background.js` with every row at its release-build value. So in both tiers, an assertion that flagged work changes moves in the release PR that turns its row on.

## Integration branch

Work merges into `next`. Nothing publishes from `next`. Tags go only on `main` and `release/R<n>` commits, `preflight` fails any other tag, and `publish-store` runs only from `main` or `release/**`. The owner promotes `next`, or a milestone SHA recorded on it, to `main` and tags that commit. In the rules above, work that merges before a milestone's tag is on `next` at or before that milestone's recorded SHA.

## Publishing a release

1. Bump the version in one PR. `npm version 1.4.1 --no-git-tag-version` sets `package.json` and both `version` fields in `package-lock.json`, and `manifest.json` gets the same version by hand. `npm test` fails while the four disagree.
2. Tag the milestone commit on `main`, or the patch commit on `release/R<n>`, and push the tag.
3. Wait for the Release run to go green. `preflight` checks the tag against all four version fields and that its commit is on `main` or a `release/**` branch. `checks` runs the PR checks on the tagged commit, and `package` builds `new-tab-note-<tag>.zip` and its `.sha256` from the `dist/` that `checks` built and tested. `attest` signs the zip's build provenance in a job that checks out and installs nothing, so no npm code ever holds the signing token. `release` then creates the GitHub Release with that same zip and `.sha256`, marked Latest only when no published release has a higher version. Only `release` can write to the repository, and it runs no npm. Nothing in this run reads a store secret.
4. To dispatch `publish-store`, open Release in Actions, click Run workflow, pick `main` (or `release/R<n>` for a patch), and enter the tag. `gh workflow run release.yml --ref main -f tag=v1.4.1` does the same. The job checks the tag is on that branch, downloads the release's zip, and checks it against its `.sha256`, its build provenance attestation, and the tag before it calls the store. The attestation is what proves the zip is the one the tag's Release run built, since anyone who can write to the repository can replace a release's files.
5. Approve the `chrome-web-store` deployment when GitHub asks, and only for a run on `main` or the `release/R<n>` you expect.
6. Confirm in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) that the new version is pending review or published. The job prints "Submitted, pending store review" when the store queued it for review.

A failed publish is fixed and dispatched again for the same tag. A run cancelled while it waited in the queue is re-run. Neither gets a new tag, and a tag with a GitHub Release never moves.

When `preflight`, `checks`, `package`, `attest`, or `release` fails, nothing was published and the tag has no published GitHub Release. Re-run a job that failed by chance. Otherwise promote the fix to `main` (or merge it into `release/R<n>`), delete any draft release `release` left on the tag, then delete the tag and tag the fixed commit. Under this program the fix merges into `next` first and the owner promotes it.

### When publish-store fails

The job names the call that failed and prints the API's error. It makes no store call until the tag and the zip pass every check before it.

| The job printed | What to do |
|---|---|
| `isn't on` followed by the branch | The tag's commit isn't on the branch you dispatched from. Dispatch from the branch it was tagged on. |
| `There is no tag` | Check the tag you entered. |
| `gh attestation verify` fails | If it couldn't reach GitHub or Sigstore, dispatch again. Otherwise the zip on the release isn't one the tag's Release run built and attested, so don't upload it by hand. See who uploaded each file with `gh api repos/keyurgolani/NewTabNote/releases/tags/<tag> --jq '.assets[] \| [.name, .uploader.login, .updated_at]'`. With immutable releases on, that release can't be repaired: ship the fix as the next patch version under a new tag. With them off, re-run that Release run to replace its files. |
| `Missing CHROME_...` | Add that secret to the `chrome-web-store` environment, not to the repository. |
| `has leading or trailing whitespace` | Save that secret again without the stray space or newline. |
| `OAuth token request` with `invalid_grant` | The refresh token expired or was revoked. Mint a new one as [Rotating the refresh token](#rotating-the-refresh-token) describes. |
| `OAuth token request` with `invalid_client` | `CHROME_CLIENT_ID` or `CHROME_CLIENT_SECRET` is wrong, or the OAuth client was deleted. |
| `:upload failed with HTTP 4xx` | The message says why. If a submission is pending review, wait for the review or cancel it in the Developer Dashboard, then dispatch again. If this version already sits in the dashboard, submit it there. |
| `:upload ended with uploadState FAILED`, or `:fetchStatus` reports `FAILED` or `NOT_FOUND` | The store refused the package, and the Developer Dashboard says why. A fix that changes the package ships as a new version with its own tag. |
| `:fetchStatus still reports IN_PROGRESS` | The store was still processing the upload after 10 minutes. If the package shows up in the Developer Dashboard, submit it there. Otherwise dispatch again. |
| `:publish failed with HTTP 4xx` | Usually a listing requirement the Developer Dashboard flags, such as the privacy fields. Fix it there and dispatch again. |
| `:publish returned state REJECTED`, `STAGED`, or another state | The Developer Dashboard has the review result or the staged submission. |
| A timeout, an `HTTP 5xx`, or a body that isn't JSON | Google had a problem. Dispatch again. |
| A field the job reads shows as `(missing)` | Google's response didn't match the V2 reference the script follows. Upload the release zip in the Developer Dashboard by hand, and file a bug with the printed response. |

## Rotating the refresh token

`publish-store` trades `CHROME_REFRESH_TOKEN` for an access token on every run. Google blocked the out-of-band redirect (`urn:ietf:wg:oauth:2.0:oob`) that the old workflow's instructions used, so mint the token in the OAuth 2.0 Playground instead.

1. In the Google Cloud project that has the Chrome Web Store API enabled, set the OAuth consent screen's publishing status to In production. While it's in Testing, every refresh token expires after 7 days.
2. Use an OAuth client of type Web application whose authorized redirect URIs include `https://developers.google.com/oauthplayground`. If the current client is a Desktop app, create a Web application client and update `CHROME_CLIENT_ID` and `CHROME_CLIENT_SECRET` with it.
3. Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), open its settings, check "Use your own OAuth credentials", and enter the client ID and secret.
4. In step 1, enter the scope `https://www.googleapis.com/auth/chromewebstore`, click Authorize APIs, and sign in with the Google account that owns the store item. If Google warns that the app isn't verified, it's your own client, so continue.
5. In step 2, click "Exchange authorization code for tokens" and copy the refresh token.
6. Save it as `CHROME_REFRESH_TOKEN` in Settings, Environments, `chrome-web-store`. Don't paste it anywhere else.

A refresh token that goes unused for six months stops working, so rotate it before a release that follows a long gap.

## Store setup

The owner sets this up once, before the first dispatch.

1. Create the environment `chrome-web-store` with deployment branches `main` and `release/**`, and the maintainer as required reviewer with self-review allowed. Create it before the first dispatch, because GitHub creates a missing environment on first use with no reviewers. If you'd rather, list each deployment branch by exact name (`main`, `release/R0`, and so on) and add one when you cut it.
2. Move `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`, and `CHROME_EXTENSION_ID` into it, and add `CHROME_PUBLISHER_ID` from the Developer Dashboard's publisher settings. Then delete the repository copies, so only an approved `publish-store` run reads them.
3. Import the three rulesets in `.github/rulesets/`: `main.json`, `tags.json`, and `release-branches.json`. The last one lets only the Repository admin role create a `release/**` branch, so no other writer can make a branch the environment admits and run an edited `release.yml` there.
4. Turn on immutable releases in the repository settings, so a published release's files and tag can't change. Publishing doesn't depend on it, since `publish-store` verifies the zip's attestation either way, but it stops a swap before anyone has to catch it.
5. Before R0, confirm the refresh token still works or rotate it, and resolve whatever 1.4.0 left in the Developer Dashboard (a pending review, a rejection, or a draft that was never submitted), so the store doesn't refuse the 1.4.1 upload.

[#1]: https://github.com/keyurgolani/NewTabNote/issues/1
[#2]: https://github.com/keyurgolani/NewTabNote/issues/2
[#3]: https://github.com/keyurgolani/NewTabNote/issues/3
[#4]: https://github.com/keyurgolani/NewTabNote/issues/4
[#5]: https://github.com/keyurgolani/NewTabNote/issues/5
[#6]: https://github.com/keyurgolani/NewTabNote/issues/6
[#7]: https://github.com/keyurgolani/NewTabNote/issues/7
[#8]: https://github.com/keyurgolani/NewTabNote/issues/8
[#9]: https://github.com/keyurgolani/NewTabNote/issues/9
[#10]: https://github.com/keyurgolani/NewTabNote/issues/10
[#11]: https://github.com/keyurgolani/NewTabNote/issues/11
[#12]: https://github.com/keyurgolani/NewTabNote/issues/12
[#13]: https://github.com/keyurgolani/NewTabNote/issues/13
[#14]: https://github.com/keyurgolani/NewTabNote/issues/14
[#15]: https://github.com/keyurgolani/NewTabNote/issues/15
[#16]: https://github.com/keyurgolani/NewTabNote/issues/16
[#17]: https://github.com/keyurgolani/NewTabNote/issues/17
[#18]: https://github.com/keyurgolani/NewTabNote/issues/18
[#19]: https://github.com/keyurgolani/NewTabNote/issues/19
[#20]: https://github.com/keyurgolani/NewTabNote/issues/20
[#21]: https://github.com/keyurgolani/NewTabNote/issues/21
[#22]: https://github.com/keyurgolani/NewTabNote/issues/22
[#23]: https://github.com/keyurgolani/NewTabNote/issues/23
[#24]: https://github.com/keyurgolani/NewTabNote/issues/24
[#25]: https://github.com/keyurgolani/NewTabNote/issues/25
[#26]: https://github.com/keyurgolani/NewTabNote/issues/26
[#27]: https://github.com/keyurgolani/NewTabNote/issues/27
[#28]: https://github.com/keyurgolani/NewTabNote/issues/28
[#29]: https://github.com/keyurgolani/NewTabNote/issues/29
[#30]: https://github.com/keyurgolani/NewTabNote/issues/30
[#31]: https://github.com/keyurgolani/NewTabNote/issues/31
[#32]: https://github.com/keyurgolani/NewTabNote/issues/32
[#33]: https://github.com/keyurgolani/NewTabNote/issues/33
[#34]: https://github.com/keyurgolani/NewTabNote/issues/34
[#35]: https://github.com/keyurgolani/NewTabNote/issues/35
[#36]: https://github.com/keyurgolani/NewTabNote/issues/36
