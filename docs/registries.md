# Registries

#15 gives each platform capability (commands, navigation, inspectors, settings, codecs, search, sync, intelligence) its own typed registry, all built on one kit in `js/kernel/registry/`. This page covers the kit, which slice 1 adds. No family exists yet and nothing in a shipped page imports the kit. Slices 2 to 4 add the families in `js/registries/<family>/` and wire them to the pages.

## What the kit does

The kit is the one registry primitive. Families share only what it provides: identity, versions, validation, ordering, lifecycle, availability, and diagnostics. There's no universal plugin object. A family adds its own fields and nothing else.

| Module | What it holds |
| --- | --- |
| `ids.js` | The id rule, refs (`<family>:<id>`), and parsing `requires` entries |
| `vocabulary.js` | Hosts, AI scopes, and the limits that keep resolution bounded |
| `chords.js` | Chord spelling, per-platform chords, and Chrome's reserved chords |
| `reasons.js` | The states and every reason code, with code-owned text |
| `family.js` | `defineFamily`, a family contract |
| `validate.js` | The checks on one descriptor |
| `resolve.js` | Resolution across descriptors and families |
| `root.js` | `createRegistryRoot`, which registers built-ins and locks |
| `runtime.js` | `createRuntime`: probes and loaders, after resolution |
| `report.js` | `resolutionReport`, why each contribution is in its state |

The kit is host-neutral like `js/kernel/core/`: no `chrome.*`, DOM, `indexedDB`, `fetch`, timers, or legacy globals, and imports only from itself and `js/lib/valibot/`. `npm run check:boundaries` enforces both (`registry-global` and `registry-import`), and the ledger has no rows for them. A composition root is the only code that touches `chrome.*`. It hands the kit what it needs through injected ports.

## Declaring a family

```js
import { defineFamily } from '../../kernel/registry/family.js';

export const commands = defineFamily({
  id: 'commands',
  apiVersion: 1,
  groups: ['navigate', 'create', 'edit', 'view', 'trust'],
  ceilings: { chromePermissions: ['contextMenus'] },
  chords: true,
  requireDescription: true,
  fields: { contexts: value => Array.isArray(value) && value.length > 0 },
});
```

- `apiVersion` is the contract's major version. A contribution targets exactly one, and any other is `incompatible-api-version`.
- `groups` are the family's semantic groups in browse order. Browse order is group, then integer `rank`.
- `hosts` limits where its contributions may run. Leave it out for all six: `moment`, `workspace`, `popup`, `sidepanel`, `background`, and `pip`.
- `ceilings` cap what contributions may ask for (see below). Each defaults to nothing.
- `pathIds` lets ids join segments with `/`, as navigation's `settings/general` does.
- `chords` lets contributions bind keyboard chords.
- `loader` is `required`, `optional` (the default), or `none`.
- `requireDescription` makes a description mandatory, as palette entries need.
- `fixtures` names the conformance fixtures every contribution has to declare.
- `fields` are the family's own descriptor fields, each with a check of its value. A check gets `undefined` when the field is left out, so it decides whether the field is required.
- `reasons` are the family's own probe reasons, with code-owned text, such as `offline`.

`defineFamily` throws on a contract that breaks a rule, since that's a programming error.

## Declaring a contribution

A descriptor is static data:

```js
{
  id: 'new-note',            // today's string; never derived from the label
  version: 1,                // the contribution's own version
  apiVersion: 1,             // the family contract it targets
  group: 'create',
  rank: 10,                  // an integer, unique within its group
  hosts: ['workspace'],
  requires: ['open-palette', 'navigation:notes'],
  label: 'New note',
  description: 'Start a blank note.',
  keywords: ['create'],
  icon: 'plus',
  accessibility: { keyboard: 'Works from anywhere but text fields.' },
  chords: { default: ['Alt+N'] },
  contexts: ['global'],      // a field the commands family defines
  load: () => import('./new-note.js'),
}
```

- Ids match `^[a-z][A-Za-z0-9-]*(\.[a-z][A-Za-z0-9-]*)*$`, 64 characters at most. camelCase is allowed so today's settings keys stay valid. Ids reuse the strings already in use, so no stored preference needs migrating.
- `requires` entries are ids in the same family, or `<family>:<id>` in another.
- `load` is a lazy loader, usually an `import()`. A contribution may instead carry a statically imported `implementation`, never both. A `background` contribution can't have `load`: #12's module worker has no `import()` and registers its listeners synchronously, so it imports its implementations statically.
- `probe` answers whether a resolved contribution can run (see Availability).
- `notImplemented: true` marks a placeholder. It's `not-implemented` forever: no probe runs, nothing loads, and turning it on changes nothing.
- `fixtures` lists the conformance fixtures it declares.

### Chords

A chord is modifiers and one key joined by `+`, such as `Mod+Shift+K`. `Mod` is Cmd on macOS and Ctrl elsewhere. Keys are `KeyboardEvent.code` names without the `Key` and `Digit` prefixes (`K`, `1`, `Backslash`, `F11`), so a chord means the same physical key on every layout. Each modifier appears once, in the order Mod (or Ctrl), Meta, Alt, Shift, and `Mod` never sits beside the Ctrl or Meta it stands for, so a chord names exactly one modifier set.

`chords` lists them per platform (`mac`, `windows`, `linux`, `chromeos`), with `default` for every platform that lists none. Chords are compared as each platform presses them, so `Mod+W` and a Windows `Ctrl+W` are the same chord. The validator rejects Chrome's reserved chords from #24: `Mod+T`, `Mod+N`, `Mod+W`, and `Mod+Tab`, each with or without Shift, `Mod+Shift+Q`, `Mod+PageUp`, and `Mod+PageDown`. Two contributions in a family that bind one chord on a platform, on a host they share, are both unresolved. `Mod+K` on `workspace` and `Mod+K` on `popup` never fire together, so they don't conflict. Which contexts a chord fires in, and matching keydowns (AltGraph, dead keys, editable text), are the commands family's, in slice 2.

## Roots and resolution

```js
const root = createRegistryRoot({ host: 'workspace' });
root.register(commands, commandDescriptors);
root.register(navigation, navigationDescriptors);
const resolution = root.resolve({ disabled: { commands: ['toggle-ai'] } });
```

A root takes each family's built-ins at startup and then locks. The first `resolve` locks it, as does `lock()`, and registering after that throws. `register` keeps a deep frozen copy of each descriptor's data (its loader, implementation, and probe by reference), and each descriptor is checked once, so changing a registered descriptor afterwards changes nothing a root resolves. Entries from user data (installed models, user destinations, prompt templates) aren't descriptors. Their family resolves them as records, so the lock doesn't cover them.

Resolution is synchronous, does no I/O, and calls no loader or probe. The same descriptors and input give the same states and browse order whatever order they were registered in, so a root can rerun it on every service worker wake. A resolution is frozen. `resolution.list(family)` gives a family's contributions in browse order, `resolution.get(ref)` one contribution, and `resolution.problems` everything wrong with any descriptor. Projections hold frozen copies of the static fields, never the loader, implementation, or probe.

One bad contribution never takes a root down. It resolves as `unresolved` with a reason, and its family's conformance run fails `npm test` until it's fixed.

## States

| State | Ordinary flows | On invoke | Reached by |
| --- | --- | --- | --- |
| `enabled` | shown | runs | resolution, then probes |
| `disabled-by-user` | hidden | nothing | an id in `disabled` |
| `not-applicable` | disabled or hidden | nothing | another host, a requirement turned off or elsewhere, or a probe |
| `needs-permission` | shown | asks in the same gesture | a declared Chrome permission not held, or a probe |
| `needs-setup` | shown | setup | a probe |
| `temporarily-unavailable` | disabled with a reason | nothing | a probe not answered yet, failed, or saying so, or a requirement unavailable |
| `not-implemented` | hidden, explained in the report | can't be enabled | `notImplemented: true` |
| `unresolved` | hidden, explained in the report with remediation | nothing | any rule below, or a load that failed twice |

A contribution is `unresolved` when:

- its descriptor breaks a rule: a malformed id, version, group, rank, host list, `requires` list, label, description, keyword, icon, accessibility field, permission field, loader, probe, chord, or family field, a field its family doesn't define, or a required fixture it doesn't declare;
- it targets another `apiVersion`;
- it asks for more than its family's ceilings (`unauthorized`);
- another contribution in its family has its id (both are unresolved, so neither wins), its group and rank, or one of its chords;
- it's on a `requires` cycle, requires something missing, or requires something unresolved or not implemented;
- its loader failed twice.

`reasons.js` holds the full list of reason codes, with a message and a remediation for each.

## Availability

Availability comes only from what a contribution declares, and only after resolution:

```js
const runtime = createRuntime(resolution, {
  context: { notes: notesClient },                      // what probes get
  permissions: { contains: names => chrome.permissions.contains({ permissions: [...names] }) },
});
await runtime.probe();
runtime.status('sync:webdav'); // { state: 'needs-setup', reason: 'needs-server' }
```

A contribution that declares Chrome permissions or a probe is `temporarily-unavailable` (`probe-pending`) until they answer. Chrome permissions are checked first, through the root's `permissions.contains`. Without that port they count as missing. Then the probe runs with the root's injected context and nothing else. It may answer `enabled`, `not-applicable`, `needs-permission`, `needs-setup`, or `temporarily-unavailable`, with a reason code from the kit or its family whose state matches. Anything else, a throw included, is `probe-failed`. A probe can't enable what resolution didn't. Probing again keeps the last answer until the new one arrives. A contribution whose requirement isn't available is `temporarily-unavailable` too.

## Loaders

`runtime.load(ref)` loads a contribution's implementation once, and only while `runtime.status(ref)` says it's `enabled`. While its probe hasn't answered or says no, or something it requires is unavailable, `load` answers with that status and loads nothing. A second call while it's loading gets the same promise. A load that throws, rejects, or resolves to nothing is tried once more. If that fails too, the contribution is `unresolved` (`load-failed`) for the rest of the runtime. `runtime.loaderState(ref)` is `not-loaded`, `loading`, `loaded`, or `load-failed`. A static `implementation` starts `loaded`. Nothing loads during resolution or registration, so optional panels, codecs, and providers stay out of a page until something asks for them.

## The resolution report

`resolutionReport(resolution)` explains every contribution, for advanced settings and the Trust Center. Pass `runtime.snapshot()` to include what probes and loaders have answered. It's a pure function of the resolution. Each row has:

| Field | Holds |
| --- | --- |
| `family`, `id`, `version` | which contribution; `id` is null for a malformed id with characters no id has, so free text never gets in |
| `state`, `reason` | its state and reason code |
| `message`, `remediation` | the code-owned text for that reason |
| `privileged` | whether it reaches a destination or an AI scope beyond `metadata` |
| `related` | the refs a conflict or requirement is about |

A row holds nothing else: no label, no family field, no probe answer beyond its code, and no error message. So no note content can reach the report, whatever a probe, loader, or context carries. #20 exposes it as a kernel query with its first consumer.

## Permissions, scopes, and destinations

Every family contract sets a ceiling, and a contribution that asks for more is `unauthorized`:

- `chromePermissions`: manifest permissions, checked with `chrome.permissions.contains` by the root that runs the contribution. Only a contribution whose hosts are all `background` may declare any, and a family may allow them only if it has the `background` host. A family's ceiling lists only permissions in `manifest.json`. The kit can't read the manifest, so the conformance suite checks it with `chromePermissionsOutsideManifest`.
- `aiScopes`: how much note data an AI contribution may read, from `metadata`, `selected-block`, `current-note`, `linked-context`, and `workspace`. Only intelligence and the `ai` inspector allow more than `metadata`. #21 takes this constant over and enforces it.
- `destinations`: where data may go. Only the sync family and #9's and #11's families allow any.
- `authorization`: the #12 use-case policy a contribution runs under, which #12 and #21 enforce.

The kit validates these declarations. Enforcement belongs to #12 and #21. Contributions get no ambient access: probes and loaders get the root's injected context and nothing else, and slices 2 to 4 give implementations an injected context with #12 clients and declared projections. Only composition roots touch `chrome.*`, and legacy wrappers reach `Storage`, `fetch`, and `LLM` only through adapters the root injects. A settings contribution touches only its own keys, and codec and settings input is schema-validated, with codec input over `maxBytes` rejected before parsing (slices 3 and 4).

## Conformance

`test/kernel/registry-conformance.mjs` is the suite every family runs against its own contributions:

```js
describeRegistryConformance('commands', { family: commands, builtIns, sample, fixtures });
```

It covers the approved cases, listed in `CONFORMANCE_CASES`: valid, disabled, duplicate, cyclic, missing, incompatible, unauthorized, and lazy. The valid case asserts that every built-in is valid on every host its family has, so a built-in that breaks any rule fails `npm test`. `sample(id, rank)` gives the suite a valid descriptor to derive the other cases from, and `fixtures` has a runner for each fixture the family requires, run on every built-in. `alongside` lists the other families, with their built-ins, that this family's built-ins require, so they resolve as they will in a root. `context` and `permissions` are what the root would inject, and the valid case runs every built-in's probe once against them and fails on `probe-failed`. It also checks the family's Chrome permission ceiling against `manifest.json`. `CONFORMANCE_RUNS` records which families ran it, for #28's coverage inventory.

`assertRootValid(entries)` checks a whole root's built-ins on every host its families have, which is what finds a `requires` cycle that crosses families. Each composition root's test should run it on what that root registers.

`test/kernel/registry-fixtures.mjs` holds five made-up families that between them use every rule, and `registry-conformance-fixtures.test.mjs` runs the suite on them. `test/kernel/registry.test.mjs` tests the kit itself.

## In the build

Since #27 slice 2 the bundler ships only what an entry imports, inside that context's chunks. No page or worker imports the kit yet, so it isn't in `dist/` until the first family does. Then a module of the kit the import needs that's missing fails the build (`build/bundle`), and until then the kit's tests import it from the sources.
