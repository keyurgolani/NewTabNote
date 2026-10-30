// #15's registry conformance suite (approved test plan): one set of tests every family runs
// against its own contributions, for valid, disabled, duplicate, cyclic, missing,
// incompatible, unauthorized, and lazy contributions. A family's test file calls
// describeRegistryConformance with its family, its built-ins, and a sample descriptor, so a
// built-in that breaks any rule fails `npm test`. The fixture families run it in
// registry-conformance-fixtures.test.mjs, and slices 2 to 4 run it on each real family.
// #28's coverage inventory reads CONFORMANCE_CASES and the families that ran.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { refOf } from '../../js/kernel/registry/ids.js';
import { resolutionReport } from '../../js/kernel/registry/report.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';

/** @typedef {import('../../js/kernel/registry/family.js').Family} Family */
/** @typedef {import('../../js/kernel/registry/validate.js').Descriptor} Descriptor */
/** @typedef {import('../../js/kernel/registry/resolve.js').Resolution} Resolution */
/** @typedef {import('../../js/kernel/registry/vocabulary.js').Host} Host */

/** The cases every family's conformance run covers, in the approved test plan's order */
export const CONFORMANCE_CASES = Object.freeze([
  'valid',
  'disabled',
  'duplicate',
  'cyclic',
  'missing',
  'incompatible',
  'unauthorized',
  'lazy',
]);

/** The families that ran the suite in this process, by id, with the cases each covered */
export const CONFORMANCE_RUNS = new Map();

/**
 * @typedef {object} ConformanceOptions
 * @property {Family} family
 * @property {readonly Descriptor[]} builtIns
 * @property {(id: string, rank: number) => Descriptor} sample a valid descriptor that isn't a
 *   placeholder, for one of the family's non-background hosts if it has any, with this id and
 *   a rank that orders it among other samples
 * @property {Readonly<Record<string, (contribution: import('../../js/kernel/registry/resolve.js').Contribution, implementation: unknown) => unknown>>} [fixtures]
 *   a runner for each conformance fixture the family requires, run on every built-in that
 *   declares it
 */

/**
 * Resolve `descriptors` in `family` on a fresh root
 * @param {Family} family
 * @param {readonly Descriptor[]} descriptors
 * @param {Host} host
 * @param {Readonly<Record<string, readonly string[]>>} [disabled]
 */
export function resolveOne(family, descriptors, host, disabled = {}) {
  const root = createRegistryRoot({ host });
  root.register(family, descriptors);
  return root.resolve({ disabled });
}

/**
 * What's wrong with a family's built-ins, on every host it has: the resolution's problems,
 * and any built-in unresolved for any reason. Empty when they're all valid.
 * @param {Family} family
 * @param {readonly Descriptor[]} builtIns
 * @returns {string[]}
 */
export function builtInProblems(family, builtIns) {
  const found = new Set();
  for (const host of family.hosts) {
    const resolution = resolveOne(family, builtIns, host);
    for (const problem of resolution.problems) {
      found.add(
        `${problem.family}:${problem.id ?? '(no id)'} ${problem.code}${problem.field ? ` (${problem.field})` : ''}`,
      );
    }
    for (const contribution of resolution.contributions) {
      if (contribution.state === 'unresolved')
        found.add(`${contribution.ref ?? contribution.rawId} ${contribution.reason}`);
    }
  }
  return [...found].sort();
}

/**
 * Fail when any built-in breaks a rule
 * @param {Family} family
 * @param {readonly Descriptor[]} builtIns
 */
export function assertBuiltInsValid(family, builtIns) {
  const problems = builtInProblems(family, builtIns);
  assert.deepEqual(problems, [], `${family.id} built-ins break registry rules:\n  ${problems.join('\n  ')}`);
}

/**
 * @param {Resolution} resolution
 * @param {string} ref
 */
const stateOf = (resolution, ref) => {
  const contribution = resolution.get(ref);
  assert.ok(contribution, `${ref} isn't in the resolution`);
  return [contribution.state, contribution.reason];
};

/**
 * @param {Resolution} resolution
 * @param {string} family
 * @param {string} id
 */
const statesOfId = (resolution, family, id) =>
  resolution.contributions
    .filter(contribution => contribution.family === family && contribution.rawId === id)
    .map(contribution => [contribution.state, contribution.reason]);

/**
 * Run the conformance suite on one family
 * @param {string} name
 * @param {ConformanceOptions} options
 */
export function describeRegistryConformance(name, { family, builtIns, sample, fixtures = {} }) {
  const host = /** @type {Host} */ (family.hosts.find(candidate => candidate !== 'background') ?? 'background');
  const ref = (/** @type {string} */ id) => refOf(family.id, id);
  /** @param {string} id @param {number} rank @returns {Descriptor} */
  const at = (id, rank) => ({ ...sample(id, rank), hosts: [host] });
  CONFORMANCE_RUNS.set(family.id, { name, cases: CONFORMANCE_CASES });

  describe(`registry conformance: ${name}`, () => {
    it('valid: every built-in is valid on every host, and resolves in browse order the same however it was registered', () => {
      assertBuiltInsValid(family, builtIns);
      for (const candidate of family.hosts) {
        const resolution = resolveOne(family, builtIns, candidate);
        const reversed = resolveOne(family, [...builtIns].reverse(), candidate);
        assert.deepEqual(
          reversed.contributions.map(contribution => [contribution.ref, contribution.state, contribution.reason]),
          resolution.contributions.map(contribution => [contribution.ref, contribution.state, contribution.reason]),
        );
        for (const contribution of resolution.contributions) {
          const expected = contribution.hosts.includes(candidate) ? ['enabled', 'not-implemented'] : ['not-applicable'];
          assert.ok(
            expected.includes(contribution.state),
            `${contribution.ref} on ${candidate}: ${contribution.state} (${contribution.reason})`,
          );
        }
        const order = resolution
          .list(family.id)
          .map(contribution => [family.groups.indexOf(/** @type {string} */ (contribution.group)), contribution.rank]);
        const sorted = [...order].sort(
          (a, b) =>
            /** @type {number} */ (a[0]) - /** @type {number} */ (b[0]) ||
            /** @type {number} */ (a[1]) - /** @type {number} */ (b[1]),
        );
        assert.deepEqual(order, sorted);
      }
      const samples = resolveOne(family, [at('conformance-b', 2), at('conformance-a', 1)], host);
      assert.deepEqual(
        samples.list(family.id).map(contribution => [contribution.id, contribution.state]),
        [
          ['conformance-a', 'enabled'],
          ['conformance-b', 'enabled'],
        ],
      );
    });

    it('valid: the report has a row per built-in with code-owned text, and no label or family field', () => {
      const resolution = resolveOne(family, builtIns, host);
      const report = resolutionReport(resolution);
      assert.equal(report.length, builtIns.length);
      const text = JSON.stringify(report);
      for (const descriptor of builtIns) {
        assert.ok(!text.includes(JSON.stringify(descriptor.label)), `the report holds ${descriptor.id}'s label`);
      }
      for (const row of report) {
        assert.deepEqual(Object.keys(row).sort(), [
          'family',
          'id',
          'message',
          'privileged',
          'reason',
          'related',
          'remediation',
          'state',
          'version',
        ]);
        assert.notEqual(row.message, '', `${row.id} has no reason text for ${row.reason}`);
      }
    });

    it('valid: every built-in declares the fixtures its family requires, and each one passes', async () => {
      for (const fixture of family.fixtures) {
        assert.equal(
          typeof fixtures[fixture],
          'function',
          `${family.id} requires the ${fixture} fixture, but the suite has no runner for it`,
        );
      }
      for (const candidate of family.hosts) {
        const resolution = resolveOne(family, builtIns, candidate);
        const runtime = createRuntime(resolution);
        for (const contribution of resolution.contributions) {
          if (contribution.state !== 'enabled') continue;
          const declared = /** @type {readonly string[]} */ (contribution.data.fixtures ?? []);
          for (const fixture of family.fixtures)
            assert.ok(declared.includes(fixture), `${contribution.ref} lacks ${fixture}`);
          const loaded = await runtime.load(/** @type {string} */ (contribution.ref));
          assert.equal(loaded.ok, true, `${contribution.ref} didn't load on ${candidate}`);
          for (const fixture of declared) {
            await fixtures[fixture](contribution, loaded.ok ? loaded.implementation : null);
          }
        }
      }
    });

    it("disabled: an id the user turned off is disabled-by-user, others aren't, and an unknown id is ignored", () => {
      const resolution = resolveOne(family, [at('conformance-a', 1), at('conformance-b', 2)], host, {
        [family.id]: ['conformance-a', 'conformance-unknown'],
      });
      assert.deepEqual(stateOf(resolution, ref('conformance-a')), ['disabled-by-user', 'disabled-by-user']);
      assert.deepEqual(stateOf(resolution, ref('conformance-b')), ['enabled', 'ok']);
      assert.equal(resolution.get(ref('conformance-unknown')), undefined);
      if (builtIns.length > 0) {
        const first = builtIns[0];
        const off = resolveOne(family, builtIns, first.hosts[0], { [family.id]: [first.id] });
        assert.ok(['disabled-by-user', 'not-implemented'].includes(stateOf(off, ref(first.id))[0]));
      }
    });

    it('duplicate: two contributions with one id are both unresolved, and so are two with one group and rank', () => {
      const ids = resolveOne(family, [at('conformance-a', 1), at('conformance-a', 2)], host);
      assert.deepEqual(statesOfId(ids, family.id, 'conformance-a'), [
        ['unresolved', 'duplicate-id'],
        ['unresolved', 'duplicate-id'],
      ]);
      assert.equal(ids.get(ref('conformance-a')), undefined);
      const ranks = resolveOne(family, [at('conformance-a', 1), at('conformance-b', 1), at('conformance-c', 2)], host);
      assert.deepEqual(stateOf(ranks, ref('conformance-a')), ['unresolved', 'ordering-conflict']);
      assert.deepEqual(stateOf(ranks, ref('conformance-b')), ['unresolved', 'ordering-conflict']);
      assert.deepEqual(stateOf(ranks, ref('conformance-c')), ['enabled', 'ok']);
      if (builtIns.length > 0) {
        const copy = { ...builtIns[0], rank: builtIns[0].rank + 100_000 };
        assert.ok(builtInProblems(family, [...builtIns, copy]).some(problem => problem.endsWith('duplicate-id')));
      }
    });

    it('cyclic: every member of a requires cycle is unresolved, and so is what requires one', () => {
      const resolution = resolveOne(
        family,
        [
          { ...at('conformance-a', 1), requires: ['conformance-b'] },
          { ...at('conformance-b', 2), requires: ['conformance-a'] },
          { ...at('conformance-c', 3), requires: ['conformance-c'] },
          { ...at('conformance-d', 4), requires: ['conformance-a'] },
        ],
        host,
      );
      assert.deepEqual(stateOf(resolution, ref('conformance-a')), ['unresolved', 'dependency-cycle']);
      assert.deepEqual(stateOf(resolution, ref('conformance-b')), ['unresolved', 'dependency-cycle']);
      assert.deepEqual(stateOf(resolution, ref('conformance-c')), ['unresolved', 'dependency-cycle']);
      assert.deepEqual(stateOf(resolution, ref('conformance-d')), ['unresolved', 'dependency-unresolved']);
      assert.deepEqual(resolution.get(ref('conformance-a'))?.related, [ref('conformance-a'), ref('conformance-b')]);
    });

    it('missing: something that requires a missing contribution is unresolved and names it', () => {
      const resolution = resolveOne(
        family,
        [
          { ...at('conformance-a', 1), requires: ['conformance-absent'] },
          { ...at('conformance-b', 2), requires: ['conformance-a'] },
          { ...at('conformance-c', 3), requires: ['fixture-elsewhere:anything'] },
        ],
        host,
      );
      assert.deepEqual(stateOf(resolution, ref('conformance-a')), ['unresolved', 'missing-dependency']);
      assert.deepEqual(resolution.get(ref('conformance-a'))?.related, [ref('conformance-absent')]);
      assert.deepEqual(stateOf(resolution, ref('conformance-b')), ['unresolved', 'dependency-unresolved']);
      assert.deepEqual(stateOf(resolution, ref('conformance-c')), ['unresolved', 'missing-dependency']);
    });

    it('incompatible: a contribution for another contract version is unresolved', () => {
      const resolution = resolveOne(
        family,
        [
          { ...at('conformance-a', 1), apiVersion: family.apiVersion + 1 },
          { ...at('conformance-b', 2), apiVersion: 0 },
          at('conformance-c', 3),
        ],
        host,
      );
      assert.deepEqual(stateOf(resolution, ref('conformance-a')), ['unresolved', 'incompatible-api-version']);
      assert.deepEqual(stateOf(resolution, ref('conformance-b')), ['unresolved', 'invalid-version']);
      assert.deepEqual(stateOf(resolution, ref('conformance-c')), ['enabled', 'ok']);
    });

    it("unauthorized: asking for more than the family's ceiling is unresolved", () => {
      const tooWide = family.ceilings.aiScopes.includes('workspace')
        ? { destinations: ['conformance-elsewhere'] }
        : { aiScopes: /** @type {const} */ (['workspace']) };
      const resolution = resolveOne(
        family,
        [
          { ...at('conformance-a', 1), ...tooWide },
          { ...at('conformance-b', 2), chromePermissions: ['conformance-permission'] },
        ],
        host,
      );
      assert.deepEqual(stateOf(resolution, ref('conformance-a')), ['unresolved', 'unauthorized']);
      assert.deepEqual(stateOf(resolution, ref('conformance-b')), ['unresolved', 'unauthorized']);
    });

    it('lazy: resolution never loads; a load runs once, a failure retries once and then is unresolved', async () => {
      const lazy = (/** @type {string} */ id, /** @type {number} */ rank, /** @type {() => unknown} */ load) => {
        const { implementation, ...rest } = at(id, rank);
        return { ...rest, load };
      };
      if (family.loader === 'none') {
        const resolution = resolveOne(family, [lazy('conformance-a', 1, async () => ({}))], host);
        assert.deepEqual(stateOf(resolution, ref('conformance-a')), ['unresolved', 'invalid-loader']);
        return;
      }
      let loads = 0;
      let failures = 0;
      const resolution = resolveOne(
        family,
        [
          lazy('conformance-a', 1, async () => {
            loads++;
            return { ok: true };
          }),
          lazy('conformance-b', 2, async () => {
            failures++;
            throw new Error('chunk failed');
          }),
        ],
        host,
      );
      assert.equal(loads + failures, 0, 'resolution called a loader');
      assert.equal(resolution.get(ref('conformance-a'))?.lazy, true);
      const runtime = createRuntime(resolution);
      assert.equal(runtime.loaderState(ref('conformance-a')), 'not-loaded');
      const [first, second] = await Promise.all([
        runtime.load(ref('conformance-a')),
        runtime.load(ref('conformance-a')),
      ]);
      assert.deepEqual(
        [first, second],
        [
          { ok: true, implementation: { ok: true } },
          { ok: true, implementation: { ok: true } },
        ],
      );
      assert.equal(loads, 1);
      assert.equal(runtime.loaderState(ref('conformance-a')), 'loaded');
      assert.deepEqual(await runtime.load(ref('conformance-b')), {
        ok: false,
        state: 'unresolved',
        reason: 'load-failed',
      });
      assert.equal(failures, 2);
      assert.deepEqual(await runtime.load(ref('conformance-b')), {
        ok: false,
        state: 'unresolved',
        reason: 'load-failed',
      });
      assert.equal(failures, 2);
      assert.deepEqual(runtime.status(ref('conformance-b')), { state: 'unresolved', reason: 'load-failed' });
      if (family.hosts.includes('background')) {
        const background = resolveOne(
          family,
          [{ ...lazy('conformance-c', 3, async () => ({})), hosts: ['background'] }],
          'background',
        );
        assert.deepEqual(stateOf(background, ref('conformance-c')), ['unresolved', 'dynamic-loader-on-background']);
      }
    });
  });
}
