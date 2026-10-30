// #15's registry kit (slice 1): identity, chords, family contracts, the root's lock,
// resolution across families, every state in the required-states table, probes, loaders
// behind their error boundary, and a report that never holds note content

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHROME_RESERVED_CHORDS,
  checkChords,
  isReserved,
  parseChord,
  pressedOn,
} from '../../js/kernel/registry/chords.js';
import { defineFamily, isFamily } from '../../js/kernel/registry/family.js';
import { isId, parseRef, refOf } from '../../js/kernel/registry/ids.js';
import { REASONS, STATES } from '../../js/kernel/registry/reasons.js';
import { resolutionReport } from '../../js/kernel/registry/report.js';
import { createRegistryRoot } from '../../js/kernel/registry/root.js';
import { createRuntime } from '../../js/kernel/registry/runtime.js';
import { LIMITS } from '../../js/kernel/registry/vocabulary.js';
import {
  commandBuiltIns,
  commands,
  navigation,
  navigationBuiltIns,
  providerBuiltIns,
  providers,
  producerBuiltIns,
  producers,
} from './registry-fixtures.mjs';

/** @typedef {import('../../js/kernel/registry/validate.js').Descriptor} Descriptor */
/** @typedef {import('../../js/kernel/registry/family.js').Family} Family */
/** @typedef {import('../../js/kernel/registry/vocabulary.js').Host} Host */

/** A family with nothing optional, for rule-by-rule checks */
const plain = defineFamily({
  id: 'fixture-plain',
  apiVersion: 1,
  groups: ['main', 'more'],
  hosts: ['workspace', 'popup', 'background'],
});

/**
 * A valid plain descriptor, with `extra` over it, which may break any rule
 * @param {string} id
 * @param {number} rank
 * @param {Partial<Descriptor> | Record<string, unknown>} [extra]
 * @returns {Descriptor}
 */
const item = (id, rank, extra = {}) =>
  /** @type {Descriptor} */ ({
    id,
    version: 1,
    apiVersion: 1,
    group: 'main',
    rank,
    hosts: ['workspace'],
    label: `Item ${id}`,
    ...extra,
  });

/**
 * Resolve families on a fresh root
 * @param {Host} host
 * @param {[Family, readonly unknown[]][]} entries
 * @param {Readonly<Record<string, readonly string[]>>} [disabled]
 */
function resolveAll(host, entries, disabled = {}) {
  const root = createRegistryRoot({ host });
  for (const [family, descriptors] of entries) root.register(family, descriptors);
  return root.resolve({ disabled });
}

/**
 * @param {import('../../js/kernel/registry/resolve.js').Resolution} resolution
 * @param {string} ref
 */
const stateOf = (resolution, ref) => {
  const contribution = resolution.get(ref);
  assert.ok(contribution, `${ref} isn't resolved`);
  return [contribution.state, contribution.reason];
};

describe('registry ids', () => {
  it('follows the id rule: camelCase allowed, 64 characters at most, dots between segments, never a label', () => {
    for (const id of ['new-note', 'autoBackupFrequency', 'capture-page', 'ai.chat', 'a', 'x'.repeat(64)])
      assert.ok(isId(id), id);
    for (const id of [
      'New note',
      'NewNote',
      '1st',
      '-x',
      'a..b',
      'a.',
      '',
      'x'.repeat(65),
      'settings/general',
      'a:b',
      null,
      3,
    ]) {
      assert.ok(!isId(id), String(id));
    }
    assert.ok(isId('settings/general', { paths: true }));
    assert.ok(!isId('settings//general', { paths: true }));
  });

  it('names contributions across families as <family>:<id>, and a bare requires entry in its own family', () => {
    assert.equal(refOf('fixture-commands', 'new-note'), 'fixture-commands:new-note');
    assert.deepEqual(parseRef('new-note', 'fixture-commands'), { family: 'fixture-commands', id: 'new-note' });
    assert.deepEqual(parseRef('fixture-navigation:settings/general', 'fixture-commands'), {
      family: 'fixture-navigation',
      id: 'settings/general',
    });
    for (const entry of ['', 'Bad Id', ':x', 'fixture-commands:', 'A:b', 7])
      assert.equal(parseRef(entry, 'fixture-commands'), null);
  });
});

describe('registry chords', () => {
  it('parses exact chords: each modifier once, in order, Mod never beside Ctrl or Meta', () => {
    assert.deepEqual(parseChord('Mod+Shift+K'), { modifiers: ['Mod', 'Shift'], key: 'K' });
    assert.deepEqual(parseChord('Ctrl+Meta+Alt+Shift+F12'), {
      modifiers: ['Ctrl', 'Meta', 'Alt', 'Shift'],
      key: 'F12',
    });
    assert.deepEqual(parseChord('Escape'), { modifiers: [], key: 'Escape' });
    for (const chord of [
      'Shift+Mod+K',
      'Mod+Mod+K',
      'Mod+Ctrl+K',
      'Mod+Meta+K',
      'Mod+k',
      'Mod+KeyK',
      'Mod+',
      'Mod++',
      'Hyper+K',
      'Mod+F25',
      '',
      7,
    ]) {
      assert.equal(parseChord(chord), null, String(chord));
    }
  });

  it('compares chords as each platform presses them', () => {
    const chord = /** @type {{modifiers: string[], key: string}} */ (parseChord('Mod+Alt+1'));
    assert.equal(pressedOn(chord, 'mac'), 'Meta+Alt+1');
    assert.equal(pressedOn(chord, 'windows'), 'Ctrl+Alt+1');
  });

  it("rejects every chord on #24's Chrome-reserved list, however a platform spells it", () => {
    assert.equal(CHROME_RESERVED_CHORDS.length, 11);
    for (const chord of CHROME_RESERVED_CHORDS) {
      assert.deepEqual(checkChords({ default: [chord] }, 4), { ok: false, code: 'reserved-chord' }, chord);
    }
    assert.ok(isReserved('Meta+W', 'mac'));
    assert.ok(isReserved('Ctrl+Shift+Tab', 'linux'));
    assert.ok(!isReserved('Ctrl+W', 'mac'));
    assert.deepEqual(checkChords({ windows: ['Ctrl+T'] }, 4), { ok: false, code: 'reserved-chord' });
    assert.deepEqual(checkChords({ mac: ['Meta+Shift+Q'] }, 4), { ok: false, code: 'reserved-chord' });
    // Ctrl+W on macOS isn't Cmd+W, so it's no reserved chord there
    assert.equal(checkChords({ mac: ['Ctrl+W'] }, 4).ok, true);
  });

  it('lists chords per platform, with default where a platform lists none, and rejects malformed lists', () => {
    const result = checkChords({ default: ['Mod+Backslash'], mac: ['Mod+Alt+Backslash'] }, 4);
    assert.ok(result.ok);
    assert.deepEqual(result.pressed, {
      mac: ['Meta+Alt+Backslash'],
      windows: ['Ctrl+Backslash'],
      linux: ['Ctrl+Backslash'],
      chromeos: ['Ctrl+Backslash'],
    });
    for (const chords of [
      [],
      null,
      { ios: ['Mod+K'] },
      { default: 'Mod+K' },
      { default: ['Mod+K', 'Mod+K'] },
      { default: ['A', 'B', 'C', 'D', 'E'] },
    ]) {
      assert.deepEqual(checkChords(chords, 4), { ok: false, code: 'invalid-chord' }, JSON.stringify(chords));
    }
  });
});

describe('registry family contracts', () => {
  it('freezes a valid contract, and only defineFamily makes one', () => {
    assert.ok(isFamily(commands));
    assert.ok(Object.isFrozen(commands) && Object.isFrozen(commands.ceilings) && Object.isFrozen(commands.groups));
    assert.ok(!isFamily({ ...commands }));
    assert.deepEqual(plain.ceilings, { chromePermissions: [], aiScopes: [], destinations: [] });
    assert.equal(plain.loader, 'optional');
  });

  it('throws on a contract that breaks a rule', () => {
    const base = { id: 'fixture-x', apiVersion: 1, groups: ['main'] };
    for (const [spec, why] of /** @type {[any, RegExp][]} */ ([
      [{ ...base, id: 'Fixture X' }, /needs an id/],
      [{ ...base, apiVersion: 0 }, /apiVersion/],
      [{ ...base, groups: [] }, /at least one group/],
      [{ ...base, groups: ['a', 'a'] }, /group twice/],
      [{ ...base, hosts: ['desktop'] }, /needs hosts/],
      [{ ...base, ceilings: { aiScopes: ['everything'] } }, /AI scopes/],
      [{ ...base, ceilings: { network: [] } }, /ceiling the kit doesn't define/],
      [{ ...base, hosts: ['workspace'], ceilings: { chromePermissions: ['tabs'] } }, /only background contributions/],
      [{ ...base, loader: 'sometimes' }, /loader/],
      [{ ...base, fields: { label: () => true } }, /redefines the shared field label/],
      [{ ...base, fields: { placement: 'rail' } }, /check function/],
      [
        { ...base, reasons: { ok: { state: 'needs-setup', message: 'x', remediation: '' } } },
        /redefines the kit's reason ok/,
      ],
      [{ ...base, reasons: { fine: { state: 'enabled', message: 'x', remediation: '' } } }, /other than enabled/],
      [{ ...base, reasons: { gone: { state: 'unresolved', message: 'x', remediation: '' } } }, /other than enabled/],
      [
        { ...base, reasons: { quiet: { state: 'needs-setup', message: '', remediation: '' } } },
        /message and a remediation/,
      ],
      [{ ...base, fixtures: ['Round Trip'] }, /fixture ids/],
    ])) {
      assert.throws(() => defineFamily(spec), why);
    }
  });
});

describe('registry roots', () => {
  it('lock after the first resolve, or lock(): registering later throws', () => {
    const root = createRegistryRoot({ host: 'workspace' });
    root.register(plain, [item('a', 1)]);
    root.register(plain, [item('b', 2)]);
    assert.equal(root.locked, false);
    const first = root.resolve();
    assert.equal(root.locked, true);
    assert.throws(() => root.register(plain, [item('c', 3)]), /is locked/);
    assert.deepEqual(
      first.list('fixture-plain').map(contribution => contribution.id),
      ['a', 'b'],
    );
    // Resolving again with other input is allowed and gives a new resolution
    const second = root.resolve({ disabled: { 'fixture-plain': ['a'] } });
    assert.deepEqual(stateOf(second, 'fixture-plain:a'), ['disabled-by-user', 'disabled-by-user']);
    assert.deepEqual(stateOf(first, 'fixture-plain:a'), ['enabled', 'ok']);

    const locked = createRegistryRoot({ host: 'popup' });
    locked.lock();
    assert.throws(() => locked.register(plain, []), /is locked/);
  });

  it('throw on a host, family, or list they cannot take, and past the contribution limit', () => {
    assert.throws(() => createRegistryRoot({ host: /** @type {any} */ ('desktop') }), /host must be one of/);
    const root = createRegistryRoot({ host: 'workspace' });
    assert.throws(() => root.register(/** @type {any} */ ({ ...plain }), []), /family from defineFamily/);
    assert.throws(() => root.register(plain, /** @type {any} */ (item('a', 1))), /list of descriptors/);
    root.register(plain, []);
    const impostor = defineFamily({ id: 'fixture-plain', apiVersion: 1, groups: ['main'] });
    assert.throws(() => root.register(impostor, []), /two families are named fixture-plain/);
    const many = Array.from({ length: LIMITS.contributionsPerFamily + 1 }, (_, i) => item(`item-${i}`, i));
    assert.throws(() => createRegistryRoot({ host: 'workspace' }).register(plain, many), /more than 512 contributions/);
  });

  it('copy each descriptor, and hand out frozen projections', () => {
    const descriptor = { ...item('a', 1), keywords: ['first'] };
    const root = createRegistryRoot({ host: 'workspace' });
    root.register(plain, [descriptor]);
    descriptor.rank = 99;
    descriptor.label = 'Changed';
    const resolution = root.resolve();
    const contribution = /** @type {import('../../js/kernel/registry/resolve.js').Contribution} */ (
      resolution.get('fixture-plain:a')
    );
    assert.equal(contribution.rank, 1);
    assert.equal(contribution.data.label, 'Item a');
    assert.ok(
      Object.isFrozen(resolution) && Object.isFrozen(resolution.contributions) && Object.isFrozen(contribution),
    );
    assert.ok(Object.isFrozen(contribution.data) && Object.isFrozen(contribution.data.keywords));
    assert.throws(() => {
      /** @type {any} */ (contribution).state = 'disabled-by-user';
    }, TypeError);
    // The projection carries no loader, implementation, or probe
    const lazy = resolveAll('workspace', [
      [plain, [item('b', 2, { load: async () => ({}), probe: () => ({ state: 'enabled' }) })]],
    ]);
    const projected = /** @type {import('../../js/kernel/registry/resolve.js').Contribution} */ (
      lazy.get('fixture-plain:b')
    );
    assert.deepEqual(Object.keys(projected.data).sort(), [
      'apiVersion',
      'group',
      'hosts',
      'id',
      'label',
      'rank',
      'version',
    ]);
    assert.equal(projected.lazy, true);
    assert.equal(projected.probed, true);
  });
});

describe('registry resolution', () => {
  it('is synchronous and calls no loader or probe', () => {
    let calls = 0;
    const resolution = resolveAll('workspace', [
      [
        plain,
        [
          item('a', 1, {
            load: () => {
              calls++;
              return {};
            },
            probe: () => {
              calls++;
              return { state: 'enabled' };
            },
          }),
        ],
      ],
    ]);
    assert.equal(typeof (/** @type {any} */ (resolution).then), 'undefined');
    assert.equal(calls, 0);
  });

  it('gives the same states and browse order however descriptors and families were registered', () => {
    const descriptors = [
      item('c', 3, { group: 'more' }),
      item('b', 2),
      item('a', 1),
      item('d', 1, { group: 'more', requires: ['a'] }),
    ];
    const one = resolveAll('workspace', [
      [plain, descriptors],
      [navigation, navigationBuiltIns],
    ]);
    const two = resolveAll('workspace', [
      [navigation, [...navigationBuiltIns].reverse()],
      [plain, [...descriptors].reverse()],
    ]);
    const shape = (/** @type {typeof one} */ resolution) =>
      resolution.contributions.map(contribution => [contribution.ref, contribution.state]);
    assert.deepEqual(shape(one), shape(two));
    assert.deepEqual(
      one.list('fixture-plain').map(contribution => contribution.id),
      ['a', 'b', 'd', 'c'],
    );
    assert.deepEqual(
      one.families.map(family => family.id),
      ['fixture-navigation', 'fixture-plain'],
    );
    assert.deepEqual(one.list('fixture-unknown'), []);
  });

  it('resolves requires across families, and finds cycles that cross them', () => {
    const resolution = resolveAll('workspace', [
      [navigation, navigationBuiltIns],
      [
        plain,
        [
          item('a', 1, { requires: ['fixture-navigation:settings/general'] }),
          item('b', 2, { requires: ['fixture-navigation:missing'] }),
        ],
      ],
    ]);
    assert.deepEqual(stateOf(resolution, 'fixture-plain:a'), ['enabled', 'ok']);
    assert.deepEqual(stateOf(resolution, 'fixture-plain:b'), ['unresolved', 'missing-dependency']);

    const cyclic = resolveAll('workspace', [
      [navigation, [{ ...navigationBuiltIns[2], requires: ['fixture-plain:a'] }]],
      [plain, [item('a', 1, { requires: ['fixture-navigation:archive'] })]],
    ]);
    assert.deepEqual(stateOf(cyclic, 'fixture-plain:a'), ['unresolved', 'dependency-cycle']);
    assert.deepEqual(stateOf(cyclic, 'fixture-navigation:archive'), ['unresolved', 'dependency-cycle']);
    assert.deepEqual(cyclic.get('fixture-plain:a')?.related, ['fixture-navigation:archive', 'fixture-plain:a']);
  });

  it('finds a cycle at the end of a long chain without overflowing', () => {
    const chain = Array.from({ length: LIMITS.contributionsPerFamily }, (_, i) =>
      item(`item-${i}`, i, { requires: [`item-${(i + 1) % LIMITS.contributionsPerFamily}`] }),
    );
    const resolution = resolveAll('workspace', [[plain, chain]]);
    assert.ok(resolution.contributions.every(contribution => contribution.reason === 'dependency-cycle'));
  });

  it('a requirement on a repeated id is unresolved, not missing', () => {
    const resolution = resolveAll('workspace', [
      [plain, [item('a', 1), item('a', 2), item('b', 3, { requires: ['a'] })]],
    ]);
    assert.deepEqual(stateOf(resolution, 'fixture-plain:b'), ['unresolved', 'dependency-unresolved']);
  });

  it('reaches every state in the required-states table', async () => {
    const family = defineFamily({
      id: 'fixture-states',
      apiVersion: 1,
      groups: ['main'],
      hosts: ['workspace', 'popup', 'background'],
      ceilings: { chromePermissions: ['contextMenus'] },
    });
    /** @param {string} id @param {number} rank @param {Partial<Descriptor>} [extra] @returns {Descriptor} */
    const at = (id, rank, extra = {}) => ({ ...item(id, rank), ...extra });
    const resolution = resolveAll(
      'workspace',
      [
        [
          family,
          [
            at('enabled', 1),
            at('disabled', 2),
            at('elsewhere', 3, { hosts: ['popup'] }),
            at('setup', 4, { probe: () => ({ state: 'needs-setup' }) }),
            at('pending', 5, { probe: () => new Promise(() => {}) }),
            at('placeholder', 6, { notImplemented: true }),
            at('broken', 7, { rank: 7.5 }),
            at('newer', 8, { apiVersion: 2 }),
            at('needs-disabled', 9, { requires: ['disabled'] }),
            at('later', 10, { probe: () => ({ state: 'temporarily-unavailable' }) }),
            at('inapplicable', 11, { probe: () => ({ state: 'not-applicable' }) }),
          ],
        ],
      ],
      { 'fixture-states': ['disabled', 'placeholder'] },
    );
    const runtime = createRuntime(resolution);
    await Promise.race([runtime.probe(), new Promise(resolve => setTimeout(resolve, 20))]);
    const snapshot = runtime.snapshot();
    const seen = Object.fromEntries(
      snapshot.contributions.map(contribution => [
        contribution.id ?? contribution.rawId,
        [contribution.state, contribution.reason],
      ]),
    );
    assert.deepEqual(seen, {
      enabled: ['enabled', 'ok'],
      disabled: ['disabled-by-user', 'disabled-by-user'],
      elsewhere: ['not-applicable', 'other-host'],
      setup: ['needs-setup', 'needs-setup'],
      pending: ['temporarily-unavailable', 'probe-pending'],
      placeholder: ['not-implemented', 'not-implemented'],
      broken: ['unresolved', 'invalid-order'],
      newer: ['unresolved', 'incompatible-api-version'],
      'needs-disabled': ['not-applicable', 'dependency-disabled'],
      later: ['temporarily-unavailable', 'unavailable'],
      inapplicable: ['not-applicable', 'not-applicable'],
    });

    // needs-permission, from a declared Chrome permission the root says isn't held
    const background = resolveAll('background', [
      [family, [at('menu', 1, { hosts: ['background'], chromePermissions: ['contextMenus'] })]],
    ]);
    const denied = createRuntime(background, { permissions: { contains: async () => false } });
    await denied.probe();
    assert.deepEqual(denied.status('fixture-states:menu'), { state: 'needs-permission', reason: 'missing-permission' });

    const states = new Set([
      ...snapshot.contributions.map(contribution => contribution.state),
      denied.status('fixture-states:menu').state,
    ]);
    assert.deepEqual([...states].sort(), [...STATES].sort());
  });

  it('never enables a placeholder: no probe, no load, and turning it on changes nothing', async () => {
    let calls = 0;
    const resolution = resolveAll('workspace', [
      [
        providers,
        [
          {
            ...providerBuiltIns[1],
            probe: () => {
              calls++;
              return { state: 'enabled' };
            },
          },
        ],
      ],
    ]);
    const runtime = createRuntime(resolution);
    await runtime.probe();
    assert.equal(calls, 0);
    assert.deepEqual(runtime.status('fixture-providers:gdrive'), {
      state: 'not-implemented',
      reason: 'not-implemented',
    });
    assert.deepEqual(await runtime.load('fixture-providers:gdrive'), {
      ok: false,
      state: 'not-implemented',
      reason: 'not-implemented',
    });
    assert.deepEqual(stateOf(resolution, 'fixture-providers:gdrive'), ['not-implemented', 'not-implemented']);
    // Something that requires a placeholder can't resolve either
    const dependent = resolveAll('workspace', [
      [providers, providerBuiltIns],
      [plain, [item('sync-now', 1, { requires: ['fixture-providers:dropbox'] })]],
    ]);
    assert.deepEqual(stateOf(dependent, 'fixture-plain:sync-now'), ['unresolved', 'dependency-unresolved']);
  });

  it('checks every descriptor rule', () => {
    const cases = /** @type {[Family, unknown, string][]} */ ([
      [plain, null, 'invalid-descriptor'],
      [plain, ['not', 'an', 'object'], 'invalid-descriptor'],
      [plain, item('a', 1, { id: 'Label Text' }), 'invalid-id'],
      [plain, item('a', 1, { version: 0 }), 'invalid-version'],
      [plain, item('a', 1, { apiVersion: 1.5 }), 'invalid-version'],
      [plain, item('a', 1, { apiVersion: 3 }), 'incompatible-api-version'],
      [plain, { ...item('a', 1), extra: true }, 'unknown-field'],
      [plain, item('a', 1, { group: 'nowhere' }), 'invalid-order'],
      [plain, item('a', 1, { rank: Number.MAX_SAFE_INTEGER + 2 }), 'invalid-order'],
      [plain, item('a', 1, { hosts: [] }), 'invalid-host'],
      [plain, item('a', 1, { hosts: ['workspace', 'workspace'] }), 'invalid-host'],
      [plain, item('a', 1, { hosts: ['sidepanel'] }), 'invalid-host'],
      [plain, item('a', 1, { requires: ['b', 'b'] }), 'invalid-requires'],
      [plain, item('a', 1, { requires: Array.from({ length: 33 }, (_, i) => `r${i}`) }), 'invalid-requires'],
      [plain, item('a', 1, { label: ' ' }), 'invalid-text'],
      [plain, item('a', 1, { label: 'x'.repeat(201) }), 'invalid-text'],
      [plain, item('a', 1, { description: '' }), 'invalid-text'],
      [plain, item('a', 1, { keywords: ['ok', 'ok'] }), 'invalid-text'],
      [plain, item('a', 1, { icon: 'Not An Icon' }), 'invalid-text'],
      [plain, item('a', 1, { accessibility: { role: 'button' } }), 'invalid-text'],
      [plain, item('a', 1, { aiScopes: ['everything'] }), 'invalid-permissions'],
      [plain, item('a', 1, { destinations: 'webdav' }), 'invalid-permissions'],
      [plain, item('a', 1, { authorization: 'Any Policy' }), 'invalid-permissions'],
      [plain, item('a', 1, { aiScopes: ['metadata'] }), 'unauthorized'],
      [plain, item('a', 1, { destinations: ['webdav-server'] }), 'unauthorized'],
      [plain, item('a', 1, { load: {} }), 'invalid-loader'],
      [plain, item('a', 1, { implementation: null }), 'invalid-loader'],
      [plain, item('a', 1, { load: async () => ({}), implementation: {} }), 'invalid-loader'],
      [plain, item('a', 1, { hosts: ['background'], load: async () => ({}) }), 'dynamic-loader-on-background'],
      [plain, item('a', 1, { probe: 'yes' }), 'invalid-probe'],
      [plain, item('a', 1, { chords: { default: ['Mod+K'] } }), 'unknown-field'],
      [plain, item('a', 1, { fixtures: 'round-trip' }), 'invalid-descriptor'],
      [plain, item('a', 1, { notImplemented: 'yes' }), 'invalid-descriptor'],
      [providers, { ...providerBuiltIns[0], load: undefined, probe: undefined }, 'missing-loader'],
      [navigation, { ...navigationBuiltIns[0], placement: () => 'rail' }, 'invalid-field'],
      [navigation, { ...navigationBuiltIns[0], placement: undefined }, 'invalid-field'],
      [commands, { ...commandBuiltIns[1], contexts: undefined }, 'invalid-field'],
    ]);
    for (const [family, descriptor, code] of cases) {
      const root = createRegistryRoot({ host: family.hosts[0] });
      root.register(family, [descriptor]);
      const [contribution] = root.resolve().contributions;
      assert.deepEqual([contribution.state, contribution.reason], ['unresolved', code], JSON.stringify(descriptor));
    }
    // A family field's check that throws counts as a bad value, not a crash
    const throwing = defineFamily({
      id: 'fixture-throwing',
      apiVersion: 1,
      groups: ['main'],
      fields: {
        shape: () => {
          throw new Error('no');
        },
      },
    });
    assert.deepEqual(
      stateOf(resolveAll('workspace', [[throwing, [item('a', 1, { shape: 1 })]]]), 'fixture-throwing:a'),
      ['unresolved', 'invalid-field'],
    );
    // A static implementation is fine on background, and a placeholder needs no loader
    assert.deepEqual(
      stateOf(
        resolveAll('background', [[plain, [item('a', 1, { hosts: ['background'], implementation: { run() {} } })]]]),
        'fixture-plain:a',
      ),
      ['enabled', 'ok'],
    );
    assert.deepEqual(
      stateOf(resolveAll('workspace', [[providers, [providerBuiltIns[2]]]]), 'fixture-providers:dropbox'),
      ['not-implemented', 'not-implemented'],
    );
  });

  it('lists every problem in a descriptor, and the first is its reason', () => {
    const resolution = resolveAll('workspace', [
      [plain, [item('a', 1, { group: 'nowhere', label: '', aiScopes: ['workspace'] })]],
    ]);
    assert.deepEqual(
      resolution.problems.map(problem => [problem.code, problem.field]),
      [
        ['invalid-order', 'group'],
        ['invalid-text', 'label'],
        ['unauthorized', 'aiScopes'],
      ],
    );
    assert.deepEqual(stateOf(resolution, 'fixture-plain:a'), ['unresolved', 'invalid-order']);
  });

  it('marks a contribution privileged when it reaches a destination or an AI scope beyond metadata', () => {
    const resolution = resolveAll('workspace', [
      [providers, providerBuiltIns],
      [producers, producerBuiltIns],
    ]);
    assert.equal(resolution.get('fixture-providers:webdav')?.privileged, true);
    assert.equal(resolution.get('fixture-producers:summary')?.privileged, true);
    assert.equal(resolution.get('fixture-producers:word-count')?.privileged, false);
  });
});

describe('registry runtime: probes', () => {
  const resolution = resolveAll('workspace', [[providers, providerBuiltIns]]);

  it('is temporarily unavailable until a probe answers, then takes the answer and its family reason', async () => {
    const runtime = createRuntime(resolution, { context: { configured: true, online: false } });
    assert.deepEqual(runtime.status('fixture-providers:webdav'), {
      state: 'temporarily-unavailable',
      reason: 'probe-pending',
    });
    await runtime.probe();
    assert.deepEqual(runtime.status('fixture-providers:webdav'), {
      state: 'temporarily-unavailable',
      reason: 'offline',
    });
    const ready = createRuntime(resolution, { context: { configured: true, online: true } });
    await ready.probe('fixture-providers:webdav');
    assert.deepEqual(ready.status('fixture-providers:webdav'), { state: 'enabled', reason: 'ok' });
    const unset = createRuntime(resolution, { context: { configured: false } });
    await unset.probe();
    assert.deepEqual(unset.status('fixture-providers:webdav'), { state: 'needs-setup', reason: 'needs-server' });
  });

  it('treats a throw, a malformed answer, or a reason it has no text for as probe-failed', async () => {
    for (const probe of [
      () => {
        throw new Error('boom');
      },
      async () => {
        throw new Error('boom');
      },
      () => undefined,
      () => 'enabled',
      () => ({ state: 'unresolved' }),
      () => ({ state: 'disabled-by-user' }),
      () => ({ state: 'not-implemented' }),
      () => ({ state: 'enabled', reason: 'offline' }),
      () => ({ state: 'needs-setup', reason: 'offline' }),
      () => ({ state: 'needs-setup', reason: 'made-up' }),
      () => ({ state: 'needs-setup', reason: 7 }),
    ]) {
      const one = resolveAll('workspace', [[providers, [{ ...providerBuiltIns[0], probe }]]]);
      const runtime = createRuntime(one);
      await runtime.probe();
      assert.deepEqual(
        runtime.status('fixture-providers:webdav'),
        { state: 'temporarily-unavailable', reason: 'probe-failed' },
        String(probe),
      );
    }
  });

  it('gives a probe only the injected context, frozen', async () => {
    /** @type {unknown[]} */
    const seen = [];
    const one = resolveAll('workspace', [
      [
        plain,
        [
          item('a', 1, {
            probe: context => {
              seen.push(context);
              return { state: 'enabled' };
            },
          }),
        ],
      ],
    ]);
    const context = { client: { ping: () => true } };
    const runtime = createRuntime(one, { context });
    await runtime.probe();
    assert.equal(seen.length, 1);
    assert.notEqual(seen[0], context);
    assert.deepEqual(Object.keys(/** @type {object} */ (seen[0])), ['client']);
    assert.ok(Object.isFrozen(seen[0]));
  });

  it('drops an answer older than the newest probe, and keeps the last answer while it asks again', async () => {
    /** @type {((answer: unknown) => void)[]} */
    const waiting = [];
    const one = resolveAll('workspace', [
      [plain, [item('a', 1, { probe: () => new Promise(resolve => waiting.push(resolve)) })]],
    ]);
    const runtime = createRuntime(one);
    const first = runtime.probe();
    const second = runtime.probe();
    waiting[1]({ state: 'needs-setup' });
    await second;
    waiting[0]({ state: 'enabled' });
    await first;
    assert.deepEqual(runtime.status('fixture-plain:a'), { state: 'needs-setup', reason: 'needs-setup' });
    const third = runtime.probe();
    assert.deepEqual(runtime.status('fixture-plain:a'), { state: 'needs-setup', reason: 'needs-setup' });
    waiting[2]({ state: 'enabled' });
    await third;
    assert.deepEqual(runtime.status('fixture-plain:a'), { state: 'enabled', reason: 'ok' });
  });

  it('checks declared Chrome permissions through the root, failing closed without a port', async () => {
    const one = resolveAll('background', [[commands, commandBuiltIns]]);
    /** @type {(readonly string[])[]} */
    const asked = [];
    const held = createRuntime(one, {
      permissions: {
        contains: async names => {
          asked.push(names);
          return true;
        },
      },
    });
    await held.probe();
    assert.deepEqual(asked, [['contextMenus']]);
    assert.deepEqual(held.status('fixture-commands:capture-page'), { state: 'enabled', reason: 'ok' });
    const none = createRuntime(one);
    await none.probe();
    assert.deepEqual(none.status('fixture-commands:capture-page'), {
      state: 'needs-permission',
      reason: 'missing-permission',
    });
    const throws = createRuntime(one, {
      permissions: {
        contains: () => {
          throw new Error('no');
        },
      },
    });
    await throws.probe();
    assert.deepEqual(throws.status('fixture-commands:capture-page'), {
      state: 'temporarily-unavailable',
      reason: 'probe-failed',
    });
  });

  it('is unavailable while something it requires is', async () => {
    const one = resolveAll('workspace', [
      [plain, [item('a', 1, { probe: () => ({ state: 'needs-setup' }) }), item('b', 2, { requires: ['a'] })]],
    ]);
    const runtime = createRuntime(one);
    assert.deepEqual(runtime.status('fixture-plain:b'), {
      state: 'temporarily-unavailable',
      reason: 'dependency-unavailable',
    });
    await runtime.probe();
    assert.deepEqual(runtime.status('fixture-plain:b'), {
      state: 'temporarily-unavailable',
      reason: 'dependency-unavailable',
    });
    assert.deepEqual(runtime.status('fixture-plain:missing'), { state: 'unresolved', reason: 'not-registered' });
  });
});

describe('registry runtime: loaders', () => {
  it('retries a failed load once, and a second try that works loads it', async () => {
    let tries = 0;
    const one = resolveAll('workspace', [
      [
        plain,
        [
          item('a', 1, {
            load: async () => {
              tries++;
              if (tries === 1) throw new Error('flaky');
              return { run: () => 1 };
            },
          }),
        ],
      ],
    ]);
    const runtime = createRuntime(one);
    const outcome = await runtime.load('fixture-plain:a');
    assert.equal(outcome.ok, true);
    assert.equal(tries, 2);
    assert.equal(runtime.loaderState('fixture-plain:a'), 'loaded');
  });

  it('counts a loader that resolves to nothing, or throws synchronously, as a failure', async () => {
    for (const load of [
      async () => undefined,
      async () => null,
      async () => 42,
      () => {
        throw new Error('sync');
      },
    ]) {
      let tries = 0;
      const one = resolveAll('workspace', [
        [
          plain,
          [
            item('a', 1, {
              load: () => {
                tries++;
                return load();
              },
            }),
          ],
        ],
      ]);
      const runtime = createRuntime(one);
      assert.deepEqual(await runtime.load('fixture-plain:a'), {
        ok: false,
        state: 'unresolved',
        reason: 'load-failed',
      });
      assert.equal(tries, 2);
      assert.equal(runtime.loaderState('fixture-plain:a'), 'load-failed');
      assert.deepEqual(runtime.snapshot().get('fixture-plain:a')?.state, 'unresolved');
    }
  });

  it('shows loading while a load is in flight, and loads nothing that is not enabled', async () => {
    /** @type {(value: unknown) => void} */
    let finish = () => {};
    const one = resolveAll(
      'workspace',
      [
        [
          plain,
          [
            item('a', 1, {
              load: () =>
                new Promise(resolve => {
                  finish = resolve;
                }),
            }),
            item('b', 2, { load: async () => ({}) }),
            item('c', 3, { implementation: { run() {} } }),
            item('d', 4),
          ],
        ],
      ],
      { 'fixture-plain': ['b'] },
    );
    const runtime = createRuntime(one);
    const pending = runtime.load('fixture-plain:a');
    assert.equal(runtime.loaderState('fixture-plain:a'), 'loading');
    finish({ run() {} });
    assert.equal((await pending).ok, true);
    assert.deepEqual(await runtime.load('fixture-plain:b'), {
      ok: false,
      state: 'disabled-by-user',
      reason: 'disabled-by-user',
    });
    assert.equal(runtime.loaderState('fixture-plain:b'), 'not-loaded');
    assert.equal(runtime.loaderState('fixture-plain:c'), 'loaded');
    assert.equal((await runtime.load('fixture-plain:c')).ok, true);
    assert.deepEqual(await runtime.load('fixture-plain:d'), { ok: true, implementation: null });
    assert.deepEqual(await runtime.load('fixture-plain:nothing'), {
      ok: false,
      state: 'unresolved',
      reason: 'not-registered',
    });
    assert.equal(runtime.loaderState('fixture-plain:nothing'), null);
  });
});

describe('registry resolution report', () => {
  it('is a pure function of the resolution: one row per contribution with code-owned text', () => {
    const resolution = resolveAll('workspace', [
      [providers, providerBuiltIns],
      [plain, [item('a', 1), item('a', 2), item('Bad Id', 3), item('BadId', 4)]],
    ]);
    const report = resolutionReport(resolution);
    assert.deepEqual(resolutionReport(resolution), report);
    assert.ok(Object.isFrozen(report) && Object.isFrozen(report[0]));
    assert.deepEqual(
      report.map(row => [row.family, row.id, row.state, row.reason]),
      [
        ['fixture-plain', 'a', 'unresolved', 'duplicate-id'],
        ['fixture-plain', 'a', 'unresolved', 'duplicate-id'],
        // An invalid id is reported only when it has an id's characters, so no free text gets in
        ['fixture-plain', null, 'unresolved', 'invalid-id'],
        ['fixture-plain', 'BadId', 'unresolved', 'invalid-id'],
        ['fixture-providers', 'webdav', 'enabled', 'ok'],
        ['fixture-providers', 'gdrive', 'not-implemented', 'not-implemented'],
        ['fixture-providers', 'dropbox', 'not-implemented', 'not-implemented'],
      ],
    );
    const gdrive = /** @type {import('../../js/kernel/registry/report.js').ReportRow} */ (report[5]);
    assert.equal(gdrive.message, 'Not available in this version.');
    assert.equal(gdrive.message, REASONS['not-implemented'].message);
  });

  it('explains every kit reason with text', () => {
    for (const [code, reason] of Object.entries(REASONS)) {
      assert.ok(STATES.includes(reason.state), code);
      assert.ok(reason.message.length > 0 && !/[\u2013\u2014]/.test(reason.message + reason.remediation), code);
      if (reason.state === 'unresolved') assert.ok(reason.remediation.length > 0, `${code} needs a remediation`);
    }
  });

  it('never holds note content, whatever a probe, loader, or context carries', async () => {
    const secret = 'Private note: my bank PIN is 4321';
    const family = defineFamily({
      id: 'fixture-content',
      apiVersion: 1,
      groups: ['main'],
      reasons: {
        'note-locked': { state: 'temporarily-unavailable', message: 'The note is locked.', remediation: 'Unlock it.' },
      },
    });
    const resolution = resolveAll('workspace', [
      [
        family,
        [
          item('throws', 1, {
            probe: () => {
              throw new Error(secret);
            },
          }),
          item('answers', 2, {
            probe: () => ({ state: 'temporarily-unavailable', reason: 'note-locked', note: secret, message: secret }),
          }),
          item('fails', 3, {
            load: async () => {
              throw new Error(secret);
            },
          }),
          item('reads', 4, { probe: context => ({ state: 'needs-setup', reason: String(context.note) }) }),
        ],
      ],
    ]);
    const runtime = createRuntime(resolution, { context: { note: secret } });
    await runtime.probe();
    await runtime.load('fixture-content:fails');
    const report = resolutionReport(runtime.snapshot());
    assert.deepEqual(
      report.map(row => [row.id, row.state, row.reason]),
      [
        ['throws', 'temporarily-unavailable', 'probe-failed'],
        ['answers', 'temporarily-unavailable', 'note-locked'],
        ['fails', 'unresolved', 'load-failed'],
        ['reads', 'temporarily-unavailable', 'probe-failed'],
      ],
    );
    assert.equal(report[1].message, 'The note is locked.');
    const text = JSON.stringify(report);
    assert.ok(!text.includes('4321') && !text.includes('Private note'), text);
    assert.ok(!text.includes('Item throws'), 'the report holds a label');
  });
});

describe('registry review fixes', () => {
  it('keeps what a root resolves fixed after the lock, however a registered descriptor changes', () => {
    const descriptor = {
      ...item('a', 1),
      requires: /** @type {string[]} */ ([]),
      keywords: ['first'],
    };
    const chorded = {
      ...commandBuiltIns[1],
      chords: { default: ['Alt+N'] },
      contexts: ['global'],
    };
    const root = createRegistryRoot({ host: 'workspace' });
    root.register(plain, [descriptor]);
    root.register(commands, [chorded]);
    const before = root.resolve();
    /** @type {any} */ (descriptor.hosts)[0] = 'popup';
    descriptor.requires.push('absent');
    descriptor.keywords.push('second');
    chorded.chords.default.push('Mod+Shift+N');
    /** @type {any} */ (chorded.contexts)[0] = 'nowhere';
    const after = root.resolve();
    for (const ref of ['fixture-plain:a', 'fixture-commands:new-note']) {
      assert.deepEqual(stateOf(after, ref), stateOf(before, ref), ref);
      assert.deepEqual(stateOf(after, ref), ['enabled', 'ok'], ref);
    }
    assert.deepEqual(after.get('fixture-plain:a')?.data.keywords, ['first']);
    assert.deepEqual(after.get('fixture-commands:new-note')?.chords?.windows, ['Alt+N']);
  });

  it('loads only what is enabled now: not while a probe is pending, says no, or a requirement is unavailable', async () => {
    let loads = 0;
    const load = async () => {
      loads++;
      return { run() {} };
    };
    /** @type {((answer: unknown) => void)[]} */
    const answers = [];
    const resolution = resolveAll('workspace', [
      [
        plain,
        [
          item('probed', 1, { load, probe: () => new Promise(resolve => answers.push(resolve)) }),
          item('setup', 2, { load, probe: () => ({ state: 'needs-setup' }) }),
          item('dependent', 3, { load, requires: ['setup'] }),
        ],
      ],
    ]);
    const runtime = createRuntime(resolution);
    assert.deepEqual(await runtime.load('fixture-plain:probed'), {
      ok: false,
      state: 'temporarily-unavailable',
      reason: 'probe-pending',
    });
    const probing = runtime.probe();
    answers[0]({ state: 'enabled' });
    await probing;
    assert.deepEqual(await runtime.load('fixture-plain:setup'), { ok: false, state: 'needs-setup', reason: 'needs-setup' });
    assert.deepEqual(await runtime.load('fixture-plain:dependent'), {
      ok: false,
      state: 'temporarily-unavailable',
      reason: 'dependency-unavailable',
    });
    assert.equal(loads, 0);
    assert.equal((await runtime.load('fixture-plain:probed')).ok, true);
    assert.equal(loads, 1);
  });

  it('finds chord conflicts only between contributions that share a host', () => {
    /** @param {string} id @param {number} rank @param {Host[]} hosts @returns {Descriptor} */
    const chord = (id, rank, hosts) => ({
      ...commandBuiltIns[1],
      id,
      rank,
      hosts,
      chords: { default: ['Mod+K'] },
    });
    const apart = resolveAll('workspace', [[commands, [chord('here', 1, ['workspace']), chord('there', 2, ['popup'])]]]);
    assert.deepEqual(stateOf(apart, 'fixture-commands:here'), ['enabled', 'ok']);
    assert.deepEqual(stateOf(apart, 'fixture-commands:there'), ['not-applicable', 'other-host']);
    const together = resolveAll('popup', [
      [commands, [chord('here', 1, ['workspace', 'popup']), chord('there', 2, ['popup'])]],
    ]);
    assert.deepEqual(stateOf(together, 'fixture-commands:here'), ['unresolved', 'chord-conflict']);
    assert.deepEqual(stateOf(together, 'fixture-commands:there'), ['unresolved', 'chord-conflict']);
  });

  it('orders repeated ids by version too, so registration order never shows', () => {
    const descriptors = [item('a', 1, { version: 2 }), item('a', 1, { version: 1 }), item('a', 1, { version: 3 })];
    const versions = (/** @type {Descriptor[]} */ list) =>
      resolveAll('workspace', [[plain, list]]).contributions.map(contribution => contribution.version);
    assert.deepEqual(versions(descriptors), [1, 2, 3]);
    assert.deepEqual(versions([...descriptors].reverse()), [1, 2, 3]);
  });

  it("doesn't count a malformed apiVersion as compatible, so it has no place in browse order", () => {
    const resolution = resolveAll('workspace', [[plain, [item('a', 0, { apiVersion: 'one' }), item('b', 1)]]]);
    assert.deepEqual(
      resolution.list('fixture-plain').map(contribution => contribution.rawId),
      ['b', 'a'],
    );
  });
});
