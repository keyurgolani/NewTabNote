'use strict';

// Placement and the capture verbs (#1 slice 2): js/product/placement.js against
// docs/product/continuity-canvas.md. The module is an ES module, so this
// CommonJS suite imports it.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

/** @type {typeof import('../js/product/placement.js')} */
let P;
before(async () => {
  P = await import('../js/product/placement.js');
});

const LIVE_FOLDERS = new Set(['f-live', 'f-nested']);

/** A 1.4.0 note record, as createNote writes it, with overrides */
function legacyNote(overrides = {}) {
  return {
    id: '1729000000000-abc123def',
    name: 'Untitled',
    archived: false,
    archivedAt: null,
    pinned: false,
    isDaily: false,
    dateStr: null,
    isTemplate: false,
    folderId: null,
    ...overrides,
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// ============ placementOf ============

test('AC7: placementOf gives exactly one Placement plus the separate states for every baseline flag combination', () => {
  const dailies = {
    'not daily': {},
    'daily with a date': { isDaily: true, dateStr: '2026-03-14' },
    'daily with no date': { isDaily: true, dateStr: null },
    'daily with a malformed date': { isDaily: true, dateStr: '2026-3-14' },
  };
  const folders = { root: { folderId: null }, live: { folderId: 'f-live' }, stale: { folderId: 'f-deleted' } };
  const names = { untitled: { name: 'Untitled 2' }, titled: { name: 'Sprint plan' } };
  const flags = ['isTemplate', 'archived', 'trashed', 'pinned'];

  // The record's placement rules in order: live folder, dated daily, stale folder, root by title
  const expectedPlacement = (daily, folder, name) => {
    if (folder === 'live') return { kind: 'collection', folderId: 'f-live' };
    if (daily === 'daily with a date') return { kind: 'daily', dateKey: '2026-03-14' };
    if (folder === 'stale') return { kind: 'collection', folderId: null };
    return name === 'untitled' ? { kind: 'inbox' } : { kind: 'collection', folderId: null };
  };

  let rows = 0;
  for (const [daily, dailyFields] of Object.entries(dailies)) {
    for (const [folder, folderFields] of Object.entries(folders)) {
      for (const [name, nameFields] of Object.entries(names)) {
        for (let mask = 0; mask < 2 ** flags.length; mask += 1) {
          const set = flags.filter((_, bit) => mask & (1 << bit));
          const stateFields = Object.fromEntries(flags.map(flag => [flag, set.includes(flag)]));
          const note = deepFreeze(legacyNote({ ...dailyFields, ...folderFields, ...nameFields, ...stateFields }));
          const label = `${daily} / ${folder} folder / ${name} / ${set.join('+') || 'no flags'}`;

          const result = P.placementOf(note, LIVE_FOLDERS);
          assert.deepEqual(Object.keys(result).sort(), ['dailyKey', 'findings', 'placement', 'states'], label);
          const checked = P.validatePlacement(result.placement);
          assert.equal(checked.ok, true, label);
          assert.deepEqual(result.placement, expectedPlacement(daily, folder, name), label);
          assert.deepEqual(result.states, {
            template: set.includes('isTemplate'),
            archived: set.includes('archived'),
            trashed: set.includes('trashed'),
            pinned: set.includes('pinned'),
          }, label);
          assert.equal(result.dailyKey, daily === 'daily with a date' ? '2026-03-14' : null, label);
          const findings = [];
          if (daily === 'daily with no date' || daily === 'daily with a malformed date') findings.push({ code: 'daily-without-date' });
          if (folder === 'stale') findings.push({ code: 'stale-folder' });
          assert.deepEqual(result.findings, findings, label);
          rows += 1;
        }
      }
    }
  }
  assert.equal(rows, 4 * 3 * 2 * 16);
});

test('a Daily Note in a live folder is that collection and keeps its date as dailyKey', () => {
  const result = P.placementOf(legacyNote({ name: 'Daily Note - Mar 14, 2026', isDaily: true, dateStr: '2026-03-14', folderId: 'f-nested' }), LIVE_FOLDERS);
  assert.deepEqual(result, {
    placement: { kind: 'collection', folderId: 'f-nested' },
    states: { template: false, archived: false, trashed: false, pinned: false },
    dailyKey: '2026-03-14',
    findings: [],
  });
  assert.equal(P.homeRouteOf(result), 'projects');
});

test('a root Daily Note is daily, its dateStr copied as dateKey for #17 to re-key', () => {
  const result = P.placementOf(legacyNote({ name: 'Daily Note - Jan 28, 2026', isDaily: true, dateStr: '2026-01-28' }), []);
  assert.deepEqual(result.placement, { kind: 'daily', dateKey: '2026-01-28' });
  assert.equal(result.dailyKey, '2026-01-28');
  assert.equal(P.homeRouteOf(result), 'daily');
});

test('a stale folderId is Unfiled with a migration finding, titled or not', () => {
  for (const name of ['Untitled', 'Untitled 2', '   ', 'Budget']) {
    const result = P.placementOf(legacyNote({ name, folderId: 'f-deleted' }), LIVE_FOLDERS);
    assert.deepEqual(result.placement, { kind: 'collection', folderId: null }, name);
    assert.deepEqual(result.findings, [{ code: 'stale-folder' }], name);
  }
  // A Daily Note with a stale folderId is daily, and #17 still hears about the folder
  const daily = P.placementOf(legacyNote({ isDaily: true, dateStr: '2026-03-14', folderId: 'f-deleted' }), LIVE_FOLDERS);
  assert.deepEqual(daily.placement, { kind: 'daily', dateKey: '2026-03-14' });
  assert.deepEqual(daily.findings, [{ code: 'stale-folder' }]);
  // A truthy folderId that isn't a string names no folder either
  const numeric = P.placementOf(legacyNote({ folderId: 42 }), ['42']);
  assert.deepEqual(numeric.placement, { kind: 'collection', folderId: null });
  assert.deepEqual(numeric.findings, [{ code: 'stale-folder' }]);
});

test('a root note is Inbox when isNoteUntitled says so, else Unfiled', () => {
  const untitled = ['Untitled', 'untitled', 'UNTITLED', 'Untitled 2', 'Untitled12', '  Untitled 3  ', '', '   ', '\t\n', ' ', null, undefined];
  for (const name of untitled) {
    assert.deepEqual(P.placementOf(legacyNote({ name }), LIVE_FOLDERS).placement, { kind: 'inbox' }, JSON.stringify(name));
  }
  const titled = ['Untitled Plan', 'Untitled-2', 'My untitled note', 'Sprint plan', '2'];
  for (const name of titled) {
    assert.deepEqual(P.placementOf(legacyNote({ name }), LIVE_FOLDERS).placement, { kind: 'collection', folderId: null }, name);
  }
  // A falsy folderId is a root note, as 1.4.0's sidebar treats it
  for (const folderId of [null, undefined, '', 0, false]) {
    const result = P.placementOf(legacyNote({ name: 'Untitled', folderId }), LIVE_FOLDERS);
    assert.deepEqual(result.placement, { kind: 'inbox' }, String(folderId));
    assert.deepEqual(result.findings, [], String(folderId));
  }
});

test('templates take placement like any note', () => {
  const inFolder = P.placementOf(legacyNote({ name: 'Weekly review', isTemplate: true, folderId: 'f-live' }), LIVE_FOLDERS);
  assert.deepEqual(inFolder.placement, { kind: 'collection', folderId: 'f-live' });
  assert.equal(inFolder.states.template, true);
  const root = P.placementOf(legacyNote({ name: 'Untitled', isTemplate: true }), LIVE_FOLDERS);
  assert.deepEqual(root.placement, { kind: 'inbox' });
  assert.equal(P.homeRouteOf(root), 'templates');
});

test('placementOf reads only what it\'s given', () => {
  const note = deepFreeze(legacyNote({ name: 'Plan', folderId: 'f-live' }));
  const folders = Object.freeze(['f-live']);
  assert.deepEqual(P.placementOf(note, folders).placement, { kind: 'collection', folderId: 'f-live' });
  assert.deepEqual(P.placementOf(note, new Set()).placement, { kind: 'collection', folderId: null });
  assert.deepEqual(P.placementOf({}, []), {
    placement: { kind: 'inbox' },
    states: { template: false, archived: false, trashed: false, pinned: false },
    dailyKey: null,
    findings: [],
  });
});

test('homeRouteOf is Trash, Archive, or Templates for those states, else the placement\'s collection', () => {
  const states = (overrides = {}) => ({ template: false, archived: false, trashed: false, pinned: false, ...overrides });
  const rows = [
    [{ kind: 'inbox' }, states(), 'inbox'],
    [{ kind: 'daily', dateKey: '2026-03-14' }, states(), 'daily'],
    [{ kind: 'collection', folderId: null }, states(), 'projects'],
    [{ kind: 'collection', folderId: 'f-live' }, states({ pinned: true }), 'projects'],
    [{ kind: 'inbox' }, states({ template: true }), 'templates'],
    [{ kind: 'daily', dateKey: '2026-03-14' }, states({ archived: true }), 'archive'],
    [{ kind: 'collection', folderId: 'f-live' }, states({ archived: true, template: true }), 'archive'],
    [{ kind: 'inbox' }, states({ trashed: true, archived: true, template: true }), 'trash'],
  ];
  for (const [placement, noteStates, route] of rows) {
    assert.equal(P.homeRouteOf({ placement, states: noteStates }), route, JSON.stringify([placement, noteStates]));
  }
});

test('isNoteUntitled follows 1.4.0\'s rule', () => {
  for (const name of ['', '   ', 'Untitled', 'untitled 7', 'UNTITLED  12', null, undefined, 0]) {
    assert.equal(P.isNoteUntitled({ name }), true, JSON.stringify(name));
  }
  for (const name of ['Untitled Plan', 'Plan', 'untitled-1', 'Untitled 2b']) {
    assert.equal(P.isNoteUntitled({ name }), false, name);
  }
  assert.equal(P.isNoteUntitled(null), true);
});

// ============ Date keys ============

test('isDateKey accepts real calendar dates only', () => {
  for (const key of ['2026-01-28', '2024-02-29', '2000-02-29', '1999-12-31', '2026-04-30']) {
    assert.equal(P.isDateKey(key), true, key);
  }
  for (const key of ['2023-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-01-32',
    '26-01-01', '2026-1-1', '2026-01-28T00:00', ' 2026-01-28', 20260128, null, undefined]) {
    assert.equal(P.isDateKey(key), false, String(key));
  }
});

test('localDateKey uses the local date, which 1.4.0\'s UTC dateStr gets wrong near midnight', () => {
  const zone = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const lateEvening = Date.UTC(2026, 0, 1, 3, 30); // 19:30 on Dec 31 in Los Angeles
    assert.equal(P.localDateKey(lateEvening), '2025-12-31');
    assert.equal(P.localDateKey(new Date(lateEvening)), '2025-12-31');
    assert.equal(new Date(lateEvening).toISOString().split('T')[0], '2026-01-01');

    process.env.TZ = 'Asia/Kolkata';
    const earlyMorning = Date.UTC(2026, 6, 4, 20, 0); // 01:30 on Jul 5 in Kolkata
    assert.equal(P.localDateKey(earlyMorning), '2026-07-05');
    assert.equal(P.isDateKey(P.localDateKey(earlyMorning)), true);
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
  assert.throws(() => P.localDateKey(new Date('not a date')), TypeError);
  assert.throws(() => P.localDateKey('2026-01-01'), TypeError);
});

// ============ Placement records ============

test('validatePlacement accepts the three placements and returns a copy', () => {
  for (const placement of [{ kind: 'inbox' }, { kind: 'collection', folderId: null }, { kind: 'collection', folderId: 'f1' }, { kind: 'daily', dateKey: '2026-03-14' }]) {
    const result = P.validatePlacement(Object.freeze({ ...placement }));
    assert.deepEqual(result, { ok: true, value: placement });
    assert.notEqual(result.value, placement);
  }
});

test('validatePlacement rejects anything else', () => {
  const rows = [
    null, 'inbox', [], {}, { kind: 'Inbox' }, { kind: 'archive' },
    { kind: 'inbox', folderId: null },
    { kind: 'collection' },
    { kind: 'collection', folderId: '' },
    { kind: 'collection', folderId: 7 },
    { kind: 'collection', folderId: null, pinned: true },
    { kind: 'daily' },
    { kind: 'daily', dateKey: '2026-02-30' },
    { kind: 'daily', dateKey: '2026-03-14', folderId: 'f1' },
  ];
  for (const value of rows) {
    assert.equal(P.validatePlacement(value).ok, false, JSON.stringify(value));
  }
});

// ============ Capture verbs ============

const BLOCKS = Object.freeze([Object.freeze({ id: 'b1', type: 'text', content: 'call the bank' })]);

test('validateCreateRequest accepts a create in a destination and keeps the block records', () => {
  const rows = [
    { verb: 'create', surface: 'moment', placement: { kind: 'inbox' }, blocks: BLOCKS },
    { verb: 'create', surface: 'popup', placement: { kind: 'inbox' }, blocks: BLOCKS },
    { verb: 'create', surface: 'side-panel', placement: { kind: 'collection', folderId: null }, blocks: BLOCKS },
    { verb: 'create', surface: 'workspace', placement: { kind: 'collection', folderId: 'f1' }, blocks: BLOCKS },
  ];
  for (const request of rows) {
    const result = P.validateCreateRequest(deepFreeze({ ...request }));
    assert.equal(result.ok, true, JSON.stringify(request));
    assert.deepEqual(result.value, request);
    assert.equal(result.value.blocks[0], BLOCKS[0]);
  }
});

test('validateCreateRequest rejects a Moment capture outside Inbox, a create in Daily, and malformed requests', () => {
  const valid = { verb: 'create', surface: 'popup', placement: { kind: 'inbox' }, blocks: BLOCKS };
  const rows = [
    ['a Moment capture in a collection', { ...valid, surface: 'moment', placement: { kind: 'collection', folderId: null } }, /Moment capture is created in Inbox/],
    ['a create in Daily', { ...valid, placement: { kind: 'daily', dateKey: '2026-03-14' } }, /Daily/],
    ['no blocks', { ...valid, blocks: [] }, /blocks/],
    ['blocks that aren\'t records', { ...valid, blocks: ['text'] }, /blocks/],
    ['an unknown surface', { ...valid, surface: 'sync' }, /surface/],
    ['the append verb', { ...valid, verb: 'append' }, /verb/],
    ['an extra field', { ...valid, title: 'Plan' }, /unexpected field "title"/],
    ['a missing field', { verb: 'create', surface: 'popup', blocks: BLOCKS }, /missing field "placement"/],
    ['a malformed placement', { ...valid, placement: { kind: 'collection' } }, /placement/],
    ['not an object', 'create', /not an object/],
  ];
  for (const [label, request, reason] of rows) {
    const result = P.validateCreateRequest(request);
    assert.equal(result.ok, false, label);
    assert.match(result.reason, reason, label);
  }
});

test('validateCreateOutcome checks the new note against its request', () => {
  const request = { verb: 'create', surface: 'workspace', placement: { kind: 'collection', folderId: 'f1' }, blocks: BLOCKS };
  assert.deepEqual(P.validateCreateOutcome(request, { noteId: 'n1', placement: { kind: 'collection', folderId: 'f1' } }),
    { ok: true, value: { noteId: 'n1', placement: { kind: 'collection', folderId: 'f1' } } });
  const rows = [
    { noteId: 'n1', placement: { kind: 'collection', folderId: null } },
    { noteId: 'n1', placement: { kind: 'inbox' } },
    { noteId: '', placement: { kind: 'collection', folderId: 'f1' } },
    { noteId: 'n1' },
    { noteId: 'n1', placement: { kind: 'collection', folderId: 'f1' }, created: true },
    null,
  ];
  for (const outcome of rows) {
    assert.equal(P.validateCreateOutcome(request, outcome).ok, false, JSON.stringify(outcome));
  }
});

test('validateAppendRequest accepts a note target and a daily target', () => {
  const rows = [
    { verb: 'append', surface: 'popup', target: { kind: 'note', noteId: 'n1' }, blocks: BLOCKS },
    { verb: 'append', surface: 'background', target: { kind: 'daily', dateKey: '2026-03-14' }, blocks: BLOCKS },
    { verb: 'append', surface: 'moment', target: { kind: 'daily', dateKey: '2024-02-29' }, blocks: [...BLOCKS, { id: 'b2' }] },
  ];
  for (const request of rows) {
    const result = P.validateAppendRequest(deepFreeze(structuredClone(request)));
    assert.deepEqual(result, { ok: true, value: request }, JSON.stringify(request));
  }
});

test('validateAppendRequest rejects malformed targets and requests', () => {
  const valid = { verb: 'append', surface: 'popup', target: { kind: 'note', noteId: 'n1' }, blocks: BLOCKS };
  const rows = [
    ['a daily target with an impossible date', { ...valid, target: { kind: 'daily', dateKey: '2026-02-30' } }],
    ['a daily target with a UTC timestamp', { ...valid, target: { kind: 'daily', dateKey: '2026-03-14T00:00:00Z' } }],
    ['a note target with no ID', { ...valid, target: { kind: 'note', noteId: '' } }],
    ['a note target that also names a date', { ...valid, target: { kind: 'note', noteId: 'n1', dateKey: '2026-03-14' } }],
    ['a folder target', { ...valid, target: { kind: 'collection', folderId: 'f1' } }],
    ['no blocks', { ...valid, blocks: [] }],
    ['the create verb', { ...valid, verb: 'create' }],
    ['an extra field', { ...valid, placement: { kind: 'inbox' } }],
    ['an unknown surface', { ...valid, surface: 'offscreen' }],
  ];
  for (const [label, request] of rows) {
    assert.equal(P.validateAppendRequest(request).ok, false, label);
  }
});

test('validateAppendOutcome: a note target keeps its ID and creates nothing, and blockIds name each appended block once', () => {
  const toNote = { verb: 'append', surface: 'popup', target: { kind: 'note', noteId: 'n1' }, blocks: [{ id: 'b1' }, { id: 'b2' }] };
  assert.deepEqual(P.validateAppendOutcome(toNote, { noteId: 'n1', createdTarget: false, blockIds: ['b1', 'b2'] }),
    { ok: true, value: { noteId: 'n1', createdTarget: false, blockIds: ['b1', 'b2'] } });
  const rejected = [
    ['another note', { noteId: 'n2', createdTarget: false, blockIds: ['b1', 'b2'] }],
    ['a created target', { noteId: 'n1', createdTarget: true, blockIds: ['b1', 'b2'] }],
    ['too few block IDs', { noteId: 'n1', createdTarget: false, blockIds: ['b1'] }],
    ['a repeated block ID', { noteId: 'n1', createdTarget: false, blockIds: ['b1', 'b1'] }],
    ['an empty block ID', { noteId: 'n1', createdTarget: false, blockIds: ['b1', ''] }],
    ['createdTarget not a boolean', { noteId: 'n1', createdTarget: 'no', blockIds: ['b1', 'b2'] }],
    ['an extra field', { noteId: 'n1', createdTarget: false, blockIds: ['b1', 'b2'], placement: { kind: 'inbox' } }],
  ];
  for (const [label, outcome] of rejected) {
    assert.equal(P.validateAppendOutcome(toNote, outcome).ok, false, label);
  }

  const toDaily = { verb: 'append', surface: 'background', target: { kind: 'daily', dateKey: '2026-03-14' }, blocks: [{ id: 'b1' }] };
  for (const createdTarget of [true, false]) {
    assert.equal(P.validateAppendOutcome(toDaily, { noteId: 'daily-1', createdTarget, blockIds: ['b9'] }).ok, true, String(createdTarget));
  }
  assert.equal(P.validateAppendOutcome(toDaily, { noteId: null, createdTarget: true, blockIds: ['b9'] }).ok, false);
});

test('CAPTURE_SURFACES lists the surfaces that call the verbs', () => {
  assert.deepEqual([...P.CAPTURE_SURFACES], ['moment', 'workspace', 'popup', 'side-panel', 'background']);
  assert.ok(Object.isFrozen(P.CAPTURE_SURFACES));
});
