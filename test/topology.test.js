'use strict';

// Continuity Canvas topology (#1 slice 2): js/product/topology.js against
// docs/product/continuity-canvas.md. The module is an ES module, so this
// CommonJS suite imports it.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

/** @type {typeof import('../js/product/topology.js')} */
let T;
before(async () => {
  T = await import('../js/product/topology.js');
});

const BARE = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/newtab.html';
const at = hash => `${BARE}${hash}`;

function layout(documentTabs, activeIndex = 0, split = { enabled: false, secondaryNoteId: null }, inspector = null) {
  return { version: 1, documentTabs, activeIndex, split, inspector };
}

function session(aperture, route, noteId, sessionLayout) {
  return { version: 1, aperture, route, noteId, layout: sessionLayout };
}

const PRISTINE = Object.freeze(session('moment', null, null, null));
const EMPTY_LAYOUT = Object.freeze(layout([]));

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const record = value => ({ version: 1, value });
const lastUsedRecord = (value, when = 1000) => ({ version: 1, value, at: when });

/** The hash a URL fixture carries, or '' */
function hashIn(url) {
  const start = url.indexOf('#');
  return start === -1 || start === url.length - 1 ? '' : url.slice(start);
}

/** Rule 3's history step: replace whenever the session differs from the URL, except Moment over a bare URL */
function expectedHistory(expected, url) {
  const hash = hashIn(url);
  if (expected.aperture === 'moment' && hash === '') return { history: 'none' };
  const next = T.formatRoute(expected);
  return next === hash ? { history: 'none' } : { history: 'replace', url: next };
}

// ============ parseRoute and formatRoute ============

test('parseRoute reads Moment and Workspace routes from a URL or a bare hash', () => {
  const rows = [
    ['#/moment', { kind: 'route', aperture: 'moment', route: null, noteId: null }],
    ['#/moment?note=n1', { kind: 'route', aperture: 'moment', route: null, noteId: 'n1' }],
    ['#/workspace/inbox', { kind: 'route', aperture: 'workspace', route: 'inbox', noteId: null }],
    ['#/workspace/settings?note=1729-abc', { kind: 'route', aperture: 'workspace', route: 'settings', noteId: '1729-abc' }],
    ['#/workspace/projects?note=a%20b%26c%3Dd%23e', { kind: 'route', aperture: 'workspace', route: 'projects', noteId: 'a b&c=d#e' }],
  ];
  for (const [hash, expected] of rows) {
    assert.deepEqual(T.parseRoute(hash), expected, hash);
    assert.deepEqual(T.parseRoute(at(hash)), expected, at(hash));
  }
  for (const route of T.WORKSPACE_ROUTES) {
    assert.deepEqual(T.parseRoute(at(`#/workspace/${route}`)), { kind: 'route', aperture: 'workspace', route, noteId: null });
  }
});

test('parseRoute gives none for a URL with no hash, which a fresh Moment keeps', () => {
  for (const url of [BARE, `${BARE}#`, '', '#', null, undefined]) {
    assert.deepEqual(T.parseRoute(url), { kind: 'none' }, String(url));
  }
});

test('parseRoute gives unknown-route for a known aperture with a missing or unknown route', () => {
  const rows = [
    ['#/workspace/bogus', 'workspace', null],
    ['#/workspace/bogus?note=n1', 'workspace', 'n1'],
    ['#/workspace', 'workspace', null],
    ['#/workspace/', 'workspace', null],
    ['#/workspace/inbox/extra', 'workspace', null],
    ['#/workspace/settings/data', 'workspace', null],
    ['#/workspace/Inbox', 'workspace', null],
    ['#/moment/inbox?note=n1', 'moment', 'n1'],
    ['#/moment/', 'moment', null],
  ];
  for (const [hash, aperture, noteId] of rows) {
    assert.deepEqual(T.parseRoute(at(hash)), { kind: 'unknown-route', aperture, noteId }, hash);
  }
});

test('parseRoute gives invalid for an unknown aperture or a query other than one note', () => {
  const rows = [
    '#/bogus', '#/bogus?note=n1', '#/Moment', '#moment', '#/', '#//moment', '#workspace/inbox',
    '#/moment?', '#/moment?note=', '#/moment?id=n1', '#/moment?note=n1&note=n2', '#/moment?note=n1&x=1',
    '#/workspace/inbox?note=%E0%A4%A', '#/workspace/inbox?q=secret',
  ];
  for (const hash of rows) {
    assert.deepEqual(T.parseRoute(at(hash)), { kind: 'invalid' }, hash);
  }
});

test('formatRoute round-trips through parseRoute, note IDs encoded', () => {
  const ids = ['n1', '1729000000000-abc123def', 'a b', 'a&b=c', 'a#b?c/d', 'ünï ✓', '%41', '+plus'];
  for (const noteId of [null, ...ids]) {
    const moment = T.formatRoute({ aperture: 'moment', route: null, noteId });
    assert.deepEqual(T.parseRoute(moment), { kind: 'route', aperture: 'moment', route: null, noteId }, moment);
    for (const route of T.WORKSPACE_ROUTES) {
      const workspace = T.formatRoute({ aperture: 'workspace', route, noteId });
      assert.deepEqual(T.parseRoute(workspace), { kind: 'route', aperture: 'workspace', route, noteId }, workspace);
    }
  }
  assert.equal(T.formatRoute({ aperture: 'moment', route: null, noteId: 'a b&c' }), '#/moment?note=a%20b%26c');
  assert.equal(T.formatRoute({ aperture: 'workspace', route: 'daily', noteId: null }), '#/workspace/daily');
});

test('AC6: formatRoute emits only the aperture, the route, and an encoded note ID', () => {
  const noteText = ['Quarterly plan', 'call the bank at 9', 'secret search', 'https://example.com/page'];
  const sessions = [
    { ...session('moment', 'settings', 'n1', layout(['n1'])), title: noteText[0], content: noteText[1] },
    { ...session('workspace', 'search', 'n1', layout(['n1'])), searchText: noteText[2], pageUrl: noteText[3] },
    { ...session('workspace', 'projects', null, layout([])), name: noteText[0], preview: noteText[1] },
  ];
  const shape = /^#\/(moment|workspace\/[a-z]+)(\?note=[A-Za-z0-9\-_.!~*'()%]+)?$/;
  for (const value of sessions) {
    const hash = T.formatRoute(value);
    assert.match(hash, shape);
    for (const text of noteText) {
      assert.ok(!hash.includes(text) && !hash.includes(encodeURIComponent(text)), `${hash} leaks ${text}`);
    }
  }
  // A Moment hash carries no route: the route waits in the session
  assert.equal(T.formatRoute(session('moment', 'settings', 'n1', layout(['n1']))), '#/moment?note=n1');
});

test('formatRoute refuses a target it can\'t format', () => {
  const targets = [
    { aperture: 'workspace', route: null, noteId: null },
    { aperture: 'workspace', route: 'bogus', noteId: null },
    { aperture: 'last-used', route: null, noteId: null },
    { aperture: 'moment', route: null, noteId: '' },
    { aperture: 'moment', route: null, noteId: '\uD800' },
    { aperture: 'moment', route: null, noteId: 7 },
  ];
  for (const target of targets) {
    assert.throws(() => T.formatRoute(target), TypeError, JSON.stringify(target));
  }
});

// ============ ProductSession and layout records ============

test('validateProductSession accepts sessions the module produces and returns a copy', () => {
  const sessions = [
    PRISTINE,
    session('moment', null, 'n1', null),
    session('moment', 'settings', 'n1', layout(['n0', 'n1'], 1, { enabled: true, secondaryNoteId: 'n0' }, 'history')),
    session('workspace', 'inbox', null, layout([])),
    session('workspace', 'trash', 'n1', layout(['n1'], 0, { enabled: true, secondaryNoteId: null }, 'ai')),
  ];
  for (const value of sessions) {
    const result = T.validateProductSession(deepFreeze(structuredClone(value)));
    assert.equal(result.ok, true, JSON.stringify(value));
    assert.deepEqual(result.value, value);
    assert.notEqual(result.value, value);
  }
});

test('AC6: validateProductSession rejects any field beyond version, aperture, route, noteId, and layout', () => {
  const valid = session('workspace', 'projects', 'n1', layout(['n1']));
  for (const field of ['title', 'content', 'name', 'preview', 'searchText', 'url', 'pane', 'caret', 'selection', 'editorSession']) {
    const result = T.validateProductSession({ ...valid, [field]: 'Quarterly plan' });
    assert.equal(result.ok, false, field);
    assert.match(result.reason, new RegExp(`unexpected field "${field}"`));
  }
  const nested = T.validateProductSession({ ...valid, layout: { ...valid.layout, noteTitles: ['Quarterly plan'] } });
  assert.equal(nested.ok, false);
  assert.match(nested.reason, /unexpected field "noteTitles"/);
});

test('validateProductSession rejects malformed sessions', () => {
  const valid = session('workspace', 'projects', 'n1', layout(['n1']));
  const { layout: _layout, ...withoutLayout } = valid;
  const rows = [
    ['not an object', null],
    ['an array', []],
    ['a JSON string', JSON.stringify(valid)],
    ['a missing field', withoutLayout],
    ['an unknown version', { ...valid, version: 2 }],
    ['an unknown aperture', { ...valid, aperture: 'last-used' }],
    ['an unknown route', { ...valid, route: 'bogus' }],
    ['a Workspace session with no route', { ...valid, route: null }],
    ['a Workspace session with no layout', { ...valid, layout: null }],
    ['an empty note ID', { ...valid, noteId: '' }],
    ['a numeric note ID', { ...valid, noteId: 12 }],
    ['activeIndex past the end', { ...valid, layout: layout(['n1'], 1) }],
    ['activeIndex not 0 with no tabs', { ...valid, layout: layout([], 1) }],
    ['a fractional activeIndex', { ...valid, layout: layout(['n1', 'n2'], 0.5) }],
    ['a tab that isn\'t a note ID', { ...valid, layout: layout(['n1', '']) }],
    ['split.enabled not a boolean', { ...valid, layout: layout(['n1'], 0, { enabled: 'yes', secondaryNoteId: null }) }],
    ['split with an extra field', { ...valid, layout: layout(['n1'], 0, { enabled: false, secondaryNoteId: null, ratio: 0.5 }) }],
    ['an unknown inspector', { ...valid, layout: layout(['n1'], 0, undefined, 'graph') }],
    ['a layout version 2', { ...valid, layout: { ...layout(['n1']), version: 2 } }],
  ];
  for (const [label, value] of rows) {
    assert.equal(T.validateProductSession(value).ok, false, label);
  }
});

test('validateWorkspaceLayout reads a workspaceLayout record and returns a copy', () => {
  const snapshot = deepFreeze(layout(['n1', 'n2'], 1, { enabled: true, secondaryNoteId: 'n1' }, 'backlinks'));
  const result = T.validateWorkspaceLayout(snapshot);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, snapshot);
  assert.notEqual(result.value.documentTabs, snapshot.documentTabs);
  assert.equal(T.validateWorkspaceLayout(null).ok, false);
  assert.equal(T.validateWorkspaceLayout({ ...snapshot, activeIndex: 2 }).ok, false);
});

// ============ Preferences ============

test('AC3: readAperturePreferences maps missing records to the defaults', () => {
  const expected = { defaultAperture: 'moment', lastUsedAperture: null, excerptVisibility: 'excerpts', invalid: [] };
  assert.deepEqual(T.readAperturePreferences(), expected);
  assert.deepEqual(T.readAperturePreferences({}), expected);
  assert.deepEqual(T.readAperturePreferences({ defaultAperture: null, lastUsedAperture: null, excerptVisibility: null }), expected);
  assert.deepEqual(T.readAperturePreferences(null), expected);
});

test('AC3: readAperturePreferences reads each value of each record', () => {
  for (const value of ['moment', 'workspace', 'last-used']) {
    assert.equal(T.readAperturePreferences({ defaultAperture: record(value) }).defaultAperture, value);
  }
  for (const value of ['moment', 'workspace']) {
    assert.equal(T.readAperturePreferences({ lastUsedAperture: lastUsedRecord(value) }).lastUsedAperture, value);
  }
  for (const value of ['excerpts', 'titles', 'none']) {
    assert.equal(T.readAperturePreferences({ excerptVisibility: record(value) }).excerptVisibility, value);
  }
});

test('AC3: readAperturePreferences maps malformed or unknown-version records to the defaults and lists them', () => {
  const malformed = [
    'workspace',
    ['workspace'],
    {},
    { value: 'workspace' },
    { version: 1 },
    { version: '1', value: 'workspace' },
    { version: 2, value: 'workspace' },
    { version: 0, value: 'workspace' },
    { version: 1, value: 'Workspace' },
    { version: 1, value: 'workspace', extra: true },
  ];
  for (const bad of malformed) {
    const label = JSON.stringify(bad);
    const result = T.readAperturePreferences({ defaultAperture: bad, lastUsedAperture: bad, excerptVisibility: bad });
    assert.deepEqual(result, {
      defaultAperture: 'moment',
      lastUsedAperture: null,
      excerptVisibility: 'excerpts',
      invalid: ['defaultAperture', 'lastUsedAperture', 'excerptVisibility'],
    }, label);
  }
  for (const bad of [{ version: 1, value: 'moment' }, lastUsedRecord('moment', -1), lastUsedRecord('moment', Infinity), lastUsedRecord('moment', '5')]) {
    assert.deepEqual(T.readAperturePreferences({ lastUsedAperture: bad }).invalid, ['lastUsedAperture'], JSON.stringify(bad));
  }
  assert.deepEqual(T.readAperturePreferences({ excerptVisibility: { version: 1, value: 'none', at: 5 } }).invalid, ['excerptVisibility']);
});

test('AC3: readAperturePreferences returns no write and leaves its input alone', () => {
  const records = deepFreeze({ defaultAperture: { version: 2, value: 'workspace' }, lastUsedAperture: lastUsedRecord('workspace') });
  const result = T.readAperturePreferences(records);
  assert.deepEqual(Object.keys(result).sort(), ['defaultAperture', 'excerptVisibility', 'invalid', 'lastUsedAperture']);
  for (const value of Object.values(result)) {
    assert.ok(typeof value === 'string' || value === null || Array.isArray(value), 'values only, no record to write');
  }
});

test('AC3: nextLastUsed returns a record only for Open Workspace and Return to Moment', () => {
  assert.deepEqual(T.nextLastUsed('open-workspace', 1729000000000), { version: 1, value: 'workspace', at: 1729000000000 });
  assert.deepEqual(T.nextLastUsed('return-to-moment', 1729000000001), { version: 1, value: 'moment', at: 1729000000001 });
  for (const event of ['boot', 'reload', 'back-forward', 'deep-link', 'popstate', 'default-change', 'bogus']) {
    assert.equal(T.nextLastUsed(event, 1729000000000), null, event);
  }
  assert.throws(() => T.nextLastUsed('open-workspace', NaN), TypeError);
  assert.throws(() => T.nextLastUsed('return-to-moment', undefined), TypeError);
});

test('nextLastUsed\'s record reads back through readAperturePreferences', () => {
  for (const event of ['open-workspace', 'return-to-moment']) {
    const written = T.nextLastUsed(event, 1729000000000);
    const read = T.readAperturePreferences({ defaultAperture: record('last-used'), lastUsedAperture: written });
    assert.equal(read.lastUsedAperture, written.value);
    assert.deepEqual(read.invalid, []);
  }
});

// ============ resolveLaunch ============

test('launchTriggerFor maps navigation types to triggers, duplicated and restored tabs included', () => {
  assert.equal(T.launchTriggerFor('navigate'), 'boot');
  assert.equal(T.launchTriggerFor('reload'), 'reload');
  assert.equal(T.launchTriggerFor('back_forward'), 'back-forward');
  assert.equal(T.launchTriggerFor('prerender'), 'boot');
  assert.equal(T.launchTriggerFor(undefined), 'boot');
});

test('AC2: a brand-new tab gets a pristine Moment session when the default is missing, invalid, or moment', () => {
  const defaults = [
    ['missing', undefined],
    ['null', null],
    ['a bare value', 'workspace'],
    ['an unknown value', { version: 1, value: 'bogus' }],
    ['an unknown version', { version: 2, value: 'workspace' }],
    ['an extra field', { version: 1, value: 'workspace', extra: 1 }],
    ['moment', record('moment')],
  ];
  const snapshot = deepFreeze(layout(['snap-a', 'snap-b'], 1));
  for (const [label, defaultAperture] of defaults) {
    const result = T.resolveLaunch({
      trigger: 'boot',
      url: BARE,
      defaultAperture,
      lastUsedAperture: lastUsedRecord('workspace'),
      layoutSnapshot: snapshot,
      homeRoute: 'projects',
    });
    const invalid = label !== 'missing' && label !== 'null' && label !== 'moment';
    assert.deepEqual(result, {
      session: PRISTINE,
      pane: null,
      notice: invalid ? 'invalid-preference' : null,
      history: 'none',
    }, label);
  }
});

test('resolveLaunch is table-driven over trigger, default, last used, URL, saved session, and snapshot', () => {
  const triggers = ['boot', 'reload', 'back-forward', 'popstate'];
  const defaults = {
    missing: undefined,
    malformed: 'workspace',
    'unknown version': { version: 2, value: 'workspace' },
    moment: record('moment'),
    workspace: record('workspace'),
    'last-used': record('last-used'),
  };
  const lastUsed = { missing: undefined, moment: lastUsedRecord('moment'), workspace: lastUsedRecord('workspace') };
  const urls = {
    none: BARE,
    valid: at('#/workspace/projects?note=url-note'),
    'unknown route': at('#/workspace/bogus?note=url-note'),
    'unknown aperture': at('#/bogus?note=url-note'),
  };
  const savedLayout = layout(['session-tab', 'session-note'], 1, { enabled: false, secondaryNoteId: null }, 'outline');
  const validSession = session('workspace', 'settings', 'session-note', savedLayout);
  const sessions = { none: undefined, valid: validSession, invalid: { ...validSession, title: 'Quarterly plan' } };
  const snapshotLayout = layout(['snap-a', 'snap-b'], 1, { enabled: true, secondaryNoteId: 'snap-a' }, 'history');
  const snapshots = { none: null, valid: snapshotLayout };
  const homeRoute = 'projects'; // snap-b's home collection

  // Rule 3, as a table: which input decides
  const sourceOf = (trigger, urlKind, sessionKind) => {
    const url = urlKind === 'valid' || urlKind === 'unknown route';
    const saved = sessionKind === 'valid';
    if (trigger === 'reload') return saved ? 'session' : url ? 'url' : 'default';
    if (trigger === 'boot') return url ? (saved ? 'url over session' : 'url') : saved ? 'session' : 'default';
    return saved ? (url ? 'url over session' : 'moment on session') : url ? 'url' : 'default';
  };

  let rows = 0;
  for (const trigger of triggers) {
    for (const [defaultKind, defaultAperture] of Object.entries(defaults)) {
      for (const [lastUsedKind, lastUsedAperture] of Object.entries(lastUsed)) {
        for (const [urlKind, url] of Object.entries(urls)) {
          for (const [sessionKind, savedSession] of Object.entries(sessions)) {
            for (const [snapshotKind, layoutSnapshot] of Object.entries(snapshots)) {
              const label = `${trigger} / default ${defaultKind} / last used ${lastUsedKind} / URL ${urlKind} / session ${sessionKind} / snapshot ${snapshotKind}`;
              const input = deepFreeze(structuredClone({
                trigger, url, pane: 'inspector', savedSession, defaultAperture, lastUsedAperture, layoutSnapshot, homeRoute,
              }));
              const source = sourceOf(trigger, urlKind, sessionKind);
              const urlRoute = urlKind === 'valid' ? 'projects' : 'inbox';

              let expected;
              let notice = null;
              if (source === 'session') {
                expected = validSession;
              } else if (source === 'moment on session') {
                expected = { ...validSession, aperture: 'moment' };
              } else if (source === 'url over session') {
                expected = session('workspace', urlRoute, 'url-note', savedLayout);
                if (urlKind === 'unknown route') notice = 'unknown-route';
              } else if (source === 'url') {
                const entered = snapshotKind === 'valid'
                  ? layout(['snap-a', 'snap-b', 'url-note'], 2, snapshotLayout.split, 'history')
                  : layout(['url-note']);
                expected = session('workspace', urlRoute, 'url-note', entered);
                if (urlKind === 'unknown route') notice = 'unknown-route';
              } else {
                const readable = defaultKind !== 'malformed' && defaultKind !== 'unknown version';
                if (!readable) notice = 'invalid-preference';
                const aperture = !readable || defaultKind === 'missing' ? 'moment'
                  : defaultKind === 'last-used' ? (lastUsedKind === 'missing' ? 'moment' : lastUsedKind)
                    : defaultKind;
                expected = aperture === 'moment' ? PRISTINE
                  : snapshotKind === 'valid' ? session('workspace', homeRoute, 'snap-b', snapshotLayout)
                    : session('workspace', 'inbox', null, EMPTY_LAYOUT);
              }

              const pane = source !== 'default' && expected.aperture === 'workspace' ? 'inspector' : null;
              const result = T.resolveLaunch(input);
              assert.deepEqual(result, { session: expected, pane, notice, ...expectedHistory(expected, url) }, label);
              assert.equal(T.validateProductSession(result.session).ok, true, label);
              rows += 1;
            }
          }
        }
      }
    }
  }
  assert.equal(rows, 4 * 6 * 3 * 4 * 3 * 2);
});

test('popstate and back-forward to the bare first entry give Moment on the session\'s note', () => {
  const live = deepFreeze(session('workspace', 'settings', 'n1', layout(['n0', 'n1'], 1, { enabled: true, secondaryNoteId: 'n0' }, 'ai')));
  for (const trigger of ['popstate', 'back-forward']) {
    const result = T.resolveLaunch({ trigger, url: BARE, pane: null, savedSession: live, defaultAperture: record('workspace') });
    assert.deepEqual(result, {
      session: { ...live, aperture: 'moment' },
      pane: null,
      notice: null,
      history: 'none',
    }, trigger);
  }
  const pristineCanvas = deepFreeze(session('workspace', 'inbox', null, layout([])));
  const result = T.resolveLaunch({ trigger: 'popstate', url: BARE, savedSession: pristineCanvas });
  assert.deepEqual(result.session, { ...pristineCanvas, aperture: 'moment' });
  assert.equal(result.history, 'none');
});

test('popstate across a one-pane collection-to-note step restores the pane and note and keeps the layout', () => {
  const tabs = layout(['n1', 'n2'], 1);
  const live = deepFreeze(session('workspace', 'projects', 'n2', tabs));
  const back = T.resolveLaunch({ trigger: 'popstate', url: at('#/workspace/projects?note=n1'), pane: 'collection', savedSession: live });
  assert.deepEqual(back, { session: session('workspace', 'projects', 'n1', tabs), pane: 'collection', notice: null, history: 'none' });

  const forward = T.resolveLaunch({ trigger: 'popstate', url: at('#/workspace/projects?note=n2'), pane: 'canvas', savedSession: back.session });
  assert.deepEqual(forward, { session: session('workspace', 'projects', 'n2', tabs), pane: 'canvas', notice: null, history: 'none' });

  const firstStep = T.resolveLaunch({ trigger: 'popstate', url: at('#/workspace/projects'), pane: 'collection', savedSession: live });
  assert.deepEqual(firstStep.session, session('workspace', 'projects', null, tabs));
  assert.equal(firstStep.pane, 'collection');

  const inspector = T.resolveLaunch({ trigger: 'popstate', url: at('#/workspace/projects?note=n2'), pane: 'inspector', savedSession: live });
  assert.equal(inspector.pane, 'inspector');
  for (const pane of ['rail', 'Canvas', 3, null, undefined, { pane: 'canvas' }]) {
    assert.equal(T.resolveLaunch({ trigger: 'popstate', url: at('#/workspace/projects?note=n2'), pane, savedSession: live }).pane, null, String(pane));
  }
});

test('a URL note that differs from the session\'s: reload gives the session\'s with a replace, popstate the URL\'s', () => {
  const tabs = layout(['session-note', 'url-note'], 0);
  const saved = deepFreeze(session('workspace', 'projects', 'session-note', tabs));
  const url = at('#/workspace/projects?note=url-note');
  assert.deepEqual(T.resolveLaunch({ trigger: 'reload', url, savedSession: saved }), {
    session: saved,
    pane: null,
    notice: null,
    history: 'replace',
    url: '#/workspace/projects?note=session-note',
  });
  assert.deepEqual(T.resolveLaunch({ trigger: 'popstate', url, savedSession: saved }), {
    session: session('workspace', 'projects', 'url-note', tabs),
    pane: null,
    notice: null,
    history: 'none',
  });

  const moment = deepFreeze(session('moment', 'settings', 'session-note', tabs));
  assert.deepEqual(T.resolveLaunch({ trigger: 'reload', url: at('#/moment?note=url-note'), savedSession: moment }), {
    session: moment, pane: null, notice: null, history: 'replace', url: '#/moment?note=session-note',
  });
  assert.deepEqual(T.resolveLaunch({ trigger: 'popstate', url: at('#/moment?note=url-note'), savedSession: moment }).session,
    session('moment', 'settings', 'url-note', tabs));
});

test('a URL with no ?note= beside a session note: reload keeps the note, popstate gives none and keeps the layout', () => {
  const tabs = layout(['n1'], 0, { enabled: true, secondaryNoteId: null }, 'properties');
  const moment = deepFreeze(session('moment', 'archive', 'n1', tabs));
  assert.deepEqual(T.resolveLaunch({ trigger: 'reload', url: at('#/moment'), savedSession: moment }), {
    session: moment, pane: null, notice: null, history: 'replace', url: '#/moment?note=n1',
  });
  // On popstate a #/moment URL also keeps the session's route
  assert.deepEqual(T.resolveLaunch({ trigger: 'popstate', url: at('#/moment'), savedSession: moment }), {
    session: session('moment', 'archive', null, tabs), pane: null, notice: null, history: 'none',
  });

  const workspace = deepFreeze(session('workspace', 'daily', 'n1', tabs));
  assert.deepEqual(T.resolveLaunch({ trigger: 'reload', url: at('#/workspace/daily'), savedSession: workspace }), {
    session: workspace, pane: null, notice: null, history: 'replace', url: '#/workspace/daily?note=n1',
  });
  assert.deepEqual(T.resolveLaunch({ trigger: 'popstate', url: at('#/workspace/daily'), savedSession: workspace }), {
    session: session('workspace', 'daily', null, tabs), pane: null, notice: null, history: 'none',
  });
});

test('boot with a valid URL and a stale saved session: the URL wins', () => {
  const stale = deepFreeze(session('moment', 'settings', 'old-capture', layout(['old-tab'], 0)));
  const workspace = T.resolveLaunch({ trigger: 'boot', url: at('#/workspace/trash?note=deep-link'), savedSession: stale });
  assert.deepEqual(workspace.session, session('workspace', 'trash', 'deep-link', layout(['old-tab'], 0)));
  assert.equal(workspace.history, 'none');

  const moment = T.resolveLaunch({ trigger: 'boot', url: at('#/moment?note=deep-link'), savedSession: stale });
  assert.deepEqual(moment.session, session('moment', 'settings', 'deep-link', layout(['old-tab'], 0)));

  // A stale session that never entered Workspace: the URL opens a new instance from the snapshot
  const neverOpened = deepFreeze(session('moment', null, 'old-capture', null));
  const fresh = T.resolveLaunch({
    trigger: 'boot',
    url: at('#/workspace/projects'),
    savedSession: neverOpened,
    layoutSnapshot: layout(['snap-a', 'snap-b'], 1),
  });
  assert.deepEqual(fresh, {
    session: session('workspace', 'projects', 'snap-b', layout(['snap-a', 'snap-b'], 1)),
    pane: null,
    notice: null,
    history: 'replace',
    url: '#/workspace/projects?note=snap-b',
  });
});

test('a duplicated or restored tab gives the session\'s result under boot and back-forward', () => {
  const tabs = layout(['n0', 'n1'], 1, { enabled: true, secondaryNoteId: 'n0' }, 'history');
  const cases = [
    ['a bare Moment with a capture', BARE, session('moment', null, 'capture', null), null],
    ['a bare Moment back from Workspace', BARE, session('moment', 'settings', 'n1', tabs), null],
    ['a Moment with a hash', at('#/moment?note=n1'), session('moment', 'settings', 'n1', tabs), null],
    ['a pristine Moment with a hash', at('#/moment'), session('moment', 'projects', null, tabs), null],
    ['a Workspace tab', at('#/workspace/projects?note=n1'), session('workspace', 'projects', 'n1', tabs), 'canvas'],
    ['a Workspace tab on a route destination', at('#/workspace/graph?note=n1'), session('workspace', 'graph', 'n1', tabs), null],
    ['a Workspace tab with a pristine canvas', at('#/workspace/inbox'), session('workspace', 'inbox', null, layout([])), 'collection'],
  ];
  for (const [label, url, saved, pane] of cases) {
    for (const trigger of ['boot', 'back-forward']) {
      const result = T.resolveLaunch({
        trigger,
        url,
        pane,
        savedSession: deepFreeze(structuredClone(saved)),
        defaultAperture: record('workspace'),
        layoutSnapshot: layout(['other'], 0),
        homeRoute: 'inbox',
      });
      assert.deepEqual(result, {
        session: saved,
        pane: saved.aperture === 'workspace' ? pane : null,
        notice: null,
        history: 'none',
      }, `${label} under ${trigger}`);
    }
  }
});

test('a default-Workspace boot replaces the URL, so it leaves no Back entry', () => {
  const snapshot = deepFreeze(layout(['snap-a'], 0));
  const result = T.resolveLaunch({
    trigger: 'boot',
    url: BARE,
    defaultAperture: record('workspace'),
    layoutSnapshot: snapshot,
    homeRoute: 'daily',
  });
  assert.deepEqual(result, {
    session: session('workspace', 'daily', 'snap-a', snapshot),
    pane: null,
    notice: null,
    history: 'replace',
    url: '#/workspace/daily?note=snap-a',
  });
  const lastUsed = T.resolveLaunch({ trigger: 'boot', url: BARE, defaultAperture: record('last-used'), lastUsedAperture: lastUsedRecord('workspace') });
  assert.deepEqual(lastUsed, {
    session: session('workspace', 'inbox', null, EMPTY_LAYOUT),
    pane: null,
    notice: null,
    history: 'replace',
    url: '#/workspace/inbox',
  });
});

test('a default read from a malformed last-used record opens Moment with a notice', () => {
  const result = T.resolveLaunch({
    trigger: 'boot',
    url: BARE,
    defaultAperture: record('last-used'),
    lastUsedAperture: { version: 1, value: 'workspace' },
  });
  assert.deepEqual(result, { session: PRISTINE, pane: null, notice: 'invalid-preference', history: 'none' });
  // A malformed last-used record that the default doesn't read gives no notice
  assert.equal(T.resolveLaunch({ trigger: 'boot', url: BARE, lastUsedAperture: 'workspace' }).notice, null);
});

test('an unknown route opens the aperture\'s default destination with a notice, and an unknown aperture counts as no URL', () => {
  const unknown = T.resolveLaunch({ trigger: 'boot', url: at('#/workspace/settings/data?note=n1') });
  assert.deepEqual(unknown, {
    session: session('workspace', 'inbox', 'n1', layout(['n1'])),
    pane: null,
    notice: 'unknown-route',
    history: 'replace',
    url: '#/workspace/inbox?note=n1',
  });
  const momentUnknown = T.resolveLaunch({ trigger: 'boot', url: at('#/moment/inbox?note=n1') });
  assert.deepEqual(momentUnknown, {
    session: session('moment', null, 'n1', null), pane: null, notice: 'unknown-route', history: 'replace', url: '#/moment?note=n1',
  });
  const noAperture = T.resolveLaunch({ trigger: 'boot', url: at('#/bogus?note=n1') });
  assert.deepEqual(noAperture, { session: PRISTINE, pane: null, notice: null, history: 'replace', url: '#/moment' });
  const query = T.resolveLaunch({ trigger: 'boot', url: at('#/workspace/inbox?q=secret') });
  assert.deepEqual(query, { session: PRISTINE, pane: null, notice: null, history: 'replace', url: '#/moment' });
});

test('a deep link to a note opens it without creating anything', () => {
  const result = T.resolveLaunch({ trigger: 'boot', url: at('#/moment?note=deep-link'), defaultAperture: record('workspace') });
  assert.deepEqual(result, { session: session('moment', null, 'deep-link', null), pane: null, notice: null, history: 'none' });
  const workspace = T.resolveLaunch({
    trigger: 'boot',
    url: at('#/workspace/archive?note=n2'),
    layoutSnapshot: layout(['n1', 'n2'], 0),
  });
  assert.deepEqual(workspace.session, session('workspace', 'archive', 'n2', layout(['n1', 'n2'], 1)));
  assert.equal(workspace.history, 'none');
});

test('AC5: tabs stay independent, tested with fake open sessions', () => {
  const persisted = deepFreeze(layout(['snap-a', 'snap-b'], 0, { enabled: true, secondaryNoteId: 'snap-b' }, null));
  // Tab A: a Workspace tab whose live layout moved on after it last wrote the snapshot
  const tabA = deepFreeze(session('workspace', 'projects', 'live-a', layout(['snap-a', 'snap-b', 'live-a'], 2)));
  // Tab B: a Moment tab with a capture, also lastOpenedNoteId in 1.4.0 terms
  const tabB = deepFreeze(session('moment', null, 'capture-b', null));
  const otherNotes = [tabA.noteId, tabB.noteId];

  const defaults = [undefined, record('moment'), record('workspace'), record('last-used')];
  for (const defaultAperture of defaults) {
    const result = T.resolveLaunch({
      trigger: 'boot',
      url: BARE,
      defaultAperture,
      lastUsedAperture: lastUsedRecord('workspace'),
      layoutSnapshot: persisted,
      homeRoute: 'inbox',
    });
    const label = JSON.stringify(defaultAperture);
    assert.ok(!otherNotes.includes(result.session.noteId), label);
    if (result.session.aperture === 'moment') {
      assert.deepEqual(result.session, PRISTINE, label);
    } else {
      assert.deepEqual(result.session.layout, persisted, label);
      assert.notEqual(result.session.layout, persisted, label);
      assert.notDeepEqual(result.session.layout, tabA.layout, label);
    }
  }

  // Open Workspace changes only the current tab, and any number of Workspace tabs may exist
  const bInWorkspace = T.resolveTransition(tabB, 'open-workspace', persisted, 'inbox').session;
  assert.deepEqual(bInWorkspace, session('workspace', 'inbox', 'capture-b', layout(['snap-a', 'snap-b', 'capture-b'], 2, persisted.split)));
  const newTab = T.resolveLaunch({ trigger: 'boot', url: BARE, defaultAperture: record('workspace'), layoutSnapshot: persisted }).session;
  newTab.layout.documentTabs.push('typed-in-new-tab');
  newTab.layout.split.enabled = false;
  assert.deepEqual(bInWorkspace.layout.documentTabs, ['snap-a', 'snap-b', 'capture-b']);
  assert.equal(bInWorkspace.layout.split.enabled, true);
  assert.deepEqual(persisted.documentTabs, ['snap-a', 'snap-b']);
  assert.equal(tabA.noteId, 'live-a');
  assert.equal(tabB.aperture, 'moment');
});

test('resolveLaunch reads only what it\'s given: an invalid snapshot reads as none', () => {
  for (const layoutSnapshot of [{ version: 2 }, 'layout', layout(['n1'], 3), { ...layout(['n1']), name: 'x' }]) {
    const result = T.resolveLaunch({ trigger: 'boot', url: BARE, defaultAperture: record('workspace'), layoutSnapshot, homeRoute: 'projects' });
    assert.deepEqual(result.session, session('workspace', 'inbox', null, EMPTY_LAYOUT), JSON.stringify(layoutSnapshot));
  }
});

test('resolveLaunch refuses an unknown trigger', () => {
  for (const trigger of ['navigate', 'back_forward', undefined, 'open-workspace']) {
    assert.throws(() => T.resolveLaunch({ trigger, url: BARE }), TypeError, String(trigger));
  }
});

// ============ resolveTransition ============

test('Return to Moment from a saved settings route keeps the note, and the route and layout wait', () => {
  const tabs = layout(['n0', 'n1'], 1, { enabled: true, secondaryNoteId: 'n0' }, 'history');
  const withNote = deepFreeze(session('workspace', 'settings', 'n1', tabs));
  assert.deepEqual(T.resolveTransition(withNote, 'return-to-moment'), {
    session: session('moment', 'settings', 'n1', tabs),
    history: 'push',
    url: '#/moment?note=n1',
  });
  const withoutNote = deepFreeze(session('workspace', 'settings', null, tabs));
  assert.deepEqual(T.resolveTransition(withoutNote, 'return-to-moment'), {
    session: session('moment', 'settings', null, tabs),
    history: 'push',
    url: '#/moment',
  });
});

test('Open Workspace from a saved settings route opens the canvas note\'s home collection, or Inbox with no note', () => {
  const tabs = layout(['n0', 'n1'], 0, { enabled: false, secondaryNoteId: null }, 'ai');
  const withNote = deepFreeze(session('moment', 'settings', 'n1', tabs));
  assert.deepEqual(T.resolveTransition(withNote, 'open-workspace', null, 'daily'), {
    session: session('workspace', 'daily', 'n1', layout(['n0', 'n1'], 1, tabs.split, 'ai')),
    history: 'push',
    url: '#/workspace/daily?note=n1',
  });

  // No note: the restored layout's active document, in its home collection
  const withoutNote = deepFreeze(session('moment', 'settings', null, tabs));
  assert.equal(T.noteOnOpenWorkspace(withoutNote), 'n0');
  assert.deepEqual(T.resolveTransition(withoutNote, 'open-workspace', layout(['snap'], 0), 'projects'), {
    session: session('workspace', 'projects', 'n0', tabs),
    history: 'push',
    url: '#/workspace/projects?note=n0',
  });

  // No note and nothing open: Inbox beside a pristine canvas, whatever homeRoute says
  const nothingOpen = deepFreeze(session('moment', 'settings', null, layout([])));
  assert.deepEqual(T.resolveTransition(nothingOpen, 'open-workspace', null, 'projects'), {
    session: session('workspace', 'inbox', null, layout([])),
    history: 'push',
    url: '#/workspace/inbox',
  });
});

test('Open Workspace restores a saved note destination', () => {
  for (const route of T.NOTE_DESTINATIONS) {
    const result = T.resolveTransition(session('moment', route, 'n1', layout(['n1'])), 'open-workspace', null, 'projects');
    assert.equal(result.session.route, route, route);
  }
  for (const route of ['insights', 'trust', 'settings', 'graph', 'analytics']) {
    const result = T.resolveTransition(session('moment', route, 'n1', layout(['n1'])), 'open-workspace', null, 'projects');
    assert.equal(result.session.route, 'projects', route);
  }
});

test('Open Workspace from a pristine Moment, with and without a snapshot', () => {
  const snapshot = deepFreeze(layout(['snap-a', 'snap-b'], 1, { enabled: true, secondaryNoteId: 'snap-a' }, 'outline'));
  assert.equal(T.noteOnOpenWorkspace(null, snapshot), 'snap-b');
  const withSnapshot = T.resolveTransition(PRISTINE, 'open-workspace', snapshot, 'templates');
  assert.deepEqual(withSnapshot, {
    session: session('workspace', 'templates', 'snap-b', snapshot),
    history: 'push',
    url: '#/workspace/templates?note=snap-b',
  });
  assert.notEqual(withSnapshot.session.layout, snapshot);
  assert.notEqual(withSnapshot.session.layout.split, snapshot.split);

  assert.equal(T.noteOnOpenWorkspace(null, null), null);
  assert.deepEqual(T.resolveTransition(PRISTINE, 'open-workspace', null, 'templates'), {
    session: session('workspace', 'inbox', null, EMPTY_LAYOUT),
    history: 'push',
    url: '#/workspace/inbox',
  });
});

test('Open Workspace from a Moment with a capture keeps it in the canvas as the active tab', () => {
  const snapshot = deepFreeze(layout(['snap-a', 'capture', 'snap-b'], 2));
  const capture = deepFreeze(session('moment', null, 'capture', null));
  assert.equal(T.noteOnOpenWorkspace(capture, snapshot), 'capture');
  assert.deepEqual(T.resolveTransition(capture, 'open-workspace', snapshot, 'inbox').session,
    session('workspace', 'inbox', 'capture', layout(['snap-a', 'capture', 'snap-b'], 1)));

  const newCapture = deepFreeze(session('moment', null, 'new-capture', null));
  assert.deepEqual(T.resolveTransition(newCapture, 'open-workspace', snapshot, 'inbox').session,
    session('workspace', 'inbox', 'new-capture', layout(['snap-a', 'capture', 'snap-b', 'new-capture'], 3)));

  // A session that already has a layout restores its own, not the snapshot
  const returned = deepFreeze(session('moment', 'inbox', 'other', layout(['mine'], 0)));
  assert.deepEqual(T.resolveTransition(returned, 'open-workspace', snapshot, 'projects').session,
    session('workspace', 'inbox', 'other', layout(['mine', 'other'], 1)));
});

test('resolveTransition ignores a homeRoute that isn\'t a note destination', () => {
  for (const homeRoute of ['settings', 'graph', 'bogus', 7, undefined]) {
    const result = T.resolveTransition(session('moment', null, 'n1', null), 'open-workspace', null, homeRoute);
    assert.equal(result.session.route, 'inbox', String(homeRoute));
  }
});

test('a transition into the aperture a tab is already in changes nothing', () => {
  const workspace = deepFreeze(session('workspace', 'graph', 'n1', layout(['n1'])));
  assert.deepEqual(T.resolveTransition(workspace, 'open-workspace', layout(['other']), 'inbox'), { session: workspace, history: 'none' });
  const moment = deepFreeze(session('moment', 'graph', 'n1', layout(['n1'])));
  assert.deepEqual(T.resolveTransition(moment, 'return-to-moment'), { session: moment, history: 'none' });
});

test('Open Workspace then Return to Moment then Open Workspace comes back to the same place', () => {
  const opened = T.resolveTransition(session('moment', null, 'n1', null), 'open-workspace', layout(['n0'], 0), 'projects').session;
  const back = T.resolveTransition(opened, 'return-to-moment').session;
  const again = T.resolveTransition(back, 'open-workspace', layout(['other'], 0), 'projects').session;
  assert.deepEqual(again, opened);
});

test('resolveTransition refuses an invalid session or an unknown event', () => {
  assert.throws(() => T.resolveTransition({ ...PRISTINE, title: 'x' }, 'open-workspace'), TypeError);
  assert.throws(() => T.resolveTransition(null, 'open-workspace'), TypeError);
  assert.throws(() => T.resolveTransition(PRISTINE, 'popstate'), TypeError);
  assert.throws(() => T.noteOnOpenWorkspace({ ...PRISTINE, version: 2 }), TypeError);
});

// ============ resolveOpenNote ============

const OPEN_TABS = [
  { tabId: 1, windowId: 10, url: BARE, lastAccessed: 500 },
  { tabId: 2, windowId: 10, url: at('#/moment?note=n1'), lastAccessed: 100 },
  { tabId: 3, windowId: 10, url: at('#/workspace/projects?note=n1'), lastAccessed: 300 },
  { tabId: 4, windowId: 20, url: at('#/moment?note=n1'), lastAccessed: 900 },
  { tabId: 5, windowId: 10, url: at('#/workspace/inbox'), lastAccessed: 200 },
  { tabId: 6, windowId: 10, url: at('#/workspace/bogus?note=n1'), lastAccessed: 999 },
  { tabId: 7, windowId: 20, url: at('#/workspace/inbox'), lastAccessed: 950 },
  { tabId: 8, windowId: 10, url: 'https://example.com/#/moment?note=n1', lastAccessed: 998 },
];

test('AC6: resolveOpenNote activates the latest current-window tab whose URL names the note', () => {
  const tabs = deepFreeze(structuredClone(OPEN_TABS));
  assert.deepEqual(T.resolveOpenNote({ noteId: 'n1', windowId: 10, tabs }), { action: 'activate', tabId: 3 });
  assert.deepEqual(T.resolveOpenNote({ noteId: 'n1', windowId: 20, tabs }), { action: 'activate', tabId: 4 });
  const momentOnly = tabs.filter(tab => tab.tabId === 2);
  assert.deepEqual(T.resolveOpenNote({ noteId: 'n1', windowId: 10, tabs: momentOnly, defaultAperture: record('workspace') }),
    { action: 'activate', tabId: 2 });
});

test('resolveOpenNote never matches a bare tab, another window, or an unknown route', () => {
  // A fresh Moment tab holding the note stays bare, so it never matches
  const tabs = [
    { tabId: 1, windowId: 10, url: BARE, lastAccessed: 500 },
    { tabId: 4, windowId: 20, url: at('#/moment?note=n1'), lastAccessed: 900 },
    { tabId: 6, windowId: 10, url: at('#/workspace/bogus?note=n1'), lastAccessed: 999 },
    { tabId: 9, windowId: 10, url: at('#/moment?note=n2'), lastAccessed: 999 },
    { tabId: 10, windowId: '10', url: at('#/moment?note=n1'), lastAccessed: 999 },
    null,
  ];
  assert.deepEqual(T.resolveOpenNote({ noteId: 'n1', windowId: 10, tabs }), { action: 'open', url: 'newtab.html#/moment?note=n1' });
});

test('resolveOpenNote opens a new tab in the default aperture when no tab matches', () => {
  const rows = [
    [undefined, undefined, undefined, 'newtab.html#/moment?note=n9'],
    [record('moment'), lastUsedRecord('workspace'), 'daily', 'newtab.html#/moment?note=n9'],
    [record('workspace'), undefined, 'daily', 'newtab.html#/workspace/daily?note=n9'],
    [record('workspace'), undefined, undefined, 'newtab.html#/workspace/inbox?note=n9'],
    [record('workspace'), undefined, 'settings', 'newtab.html#/workspace/inbox?note=n9'],
    [record('last-used'), lastUsedRecord('workspace'), 'trash', 'newtab.html#/workspace/trash?note=n9'],
    [record('last-used'), lastUsedRecord('moment'), 'trash', 'newtab.html#/moment?note=n9'],
    [record('last-used'), undefined, 'trash', 'newtab.html#/moment?note=n9'],
    [{ version: 3, value: 'workspace' }, undefined, 'daily', 'newtab.html#/moment?note=n9'],
  ];
  for (const [defaultAperture, lastUsedAperture, homeRoute, url] of rows) {
    const result = T.resolveOpenNote({ noteId: 'n9', windowId: 10, tabs: OPEN_TABS, defaultAperture, lastUsedAperture, homeRoute });
    assert.deepEqual(result, { action: 'open', url }, JSON.stringify([defaultAperture, lastUsedAperture, homeRoute]));
  }
  assert.deepEqual(T.resolveOpenNote({ noteId: 'a b&c', windowId: 10 }), { action: 'open', url: 'newtab.html#/moment?note=a%20b%26c' });
});

test('resolveOpenNote with no note activates the current window\'s latest Workspace tab, else opens Inbox', () => {
  assert.deepEqual(T.resolveOpenNote({ windowId: 10, tabs: OPEN_TABS }), { action: 'activate', tabId: 3 });
  assert.deepEqual(T.resolveOpenNote({ noteId: null, windowId: 20, tabs: OPEN_TABS }), { action: 'activate', tabId: 7 });
  const noWorkspace = OPEN_TABS.filter(tab => !tab.url.includes('#/workspace/'));
  assert.deepEqual(T.resolveOpenNote({ windowId: 10, tabs: noWorkspace, defaultAperture: record('moment') }),
    { action: 'open', url: 'newtab.html#/workspace/inbox' });
  assert.deepEqual(T.resolveOpenNote({ windowId: 30, tabs: OPEN_TABS }), { action: 'open', url: 'newtab.html#/workspace/inbox' });
});

test('resolveOpenNote breaks lastAccessed ties by tab order and ranks a missing lastAccessed last', () => {
  const tabs = [
    { tabId: 1, windowId: 10, url: at('#/workspace/inbox') },
    { tabId: 2, windowId: 10, url: at('#/workspace/inbox'), lastAccessed: 50 },
    { tabId: 3, windowId: 10, url: at('#/workspace/daily'), lastAccessed: 50 },
  ];
  assert.deepEqual(T.resolveOpenNote({ windowId: 10, tabs }), { action: 'activate', tabId: 2 });
  assert.deepEqual(T.resolveOpenNote({ windowId: 10, tabs: tabs.slice(0, 1) }), { action: 'activate', tabId: 1 });
});

test('resolveOpenNote refuses a note ID it can\'t put in a URL', () => {
  for (const noteId of ['', 5, '\uDC00']) {
    assert.throws(() => T.resolveOpenNote({ noteId, windowId: 10 }), TypeError, String(noteId));
  }
});

// ============ seedWorkspaceLayout ============

test('AC8: seedWorkspaceLayout maps the four legacy keys, drops names and missing notes, and keeps the active tab', () => {
  const legacy = deepFreeze({
    openTabs: [
      { noteId: 'n1', name: 'Untitled 2' },
      { noteId: 'gone', name: 'Deleted note' },
      { noteId: 'n2', name: 'Plan' },
      { noteId: 'n3', name: '   ' },
    ],
    activeTabIndex: 2,
    splitViewEnabled: true,
    secondaryNoteId: 'n3',
  });
  const seeded = T.seedWorkspaceLayout(legacy, new Set(['n1', 'n2', 'n3', 'unopened']));
  // 1.4.0's loadSavedTabs clamps the saved index after filtering and would show n3
  assert.deepEqual(seeded, {
    version: 1,
    documentTabs: ['n1', 'n2', 'n3'],
    activeIndex: 1,
    split: { enabled: true, secondaryNoteId: 'n3' },
    inspector: null,
  });
  assert.equal(T.validateWorkspaceLayout(seeded).ok, true);
  assert.ok(!JSON.stringify(seeded).includes('Plan') && !JSON.stringify(seeded).includes('Untitled'));
  // The legacy keys are only read: the frozen input is unchanged, and nothing else comes back
  assert.deepEqual(Object.keys(seeded).sort(), ['activeIndex', 'documentTabs', 'inspector', 'split', 'version']);
  assert.equal(legacy.openTabs.length, 4);
});

test('seedWorkspaceLayout edge fixtures', () => {
  const ids = ['n1', 'n2', 'n3'];
  const rows = [
    ['activeTabIndex past the end',
      { openTabs: [{ noteId: 'n1' }, { noteId: 'n2' }], activeTabIndex: 7 }, ['n1', 'n2'], 1, false, null],
    ['the active tab\'s note gone, a later tab kept',
      { openTabs: [{ noteId: 'n1' }, { noteId: 'gone' }, { noteId: 'n2' }], activeTabIndex: 1 }, ['n1', 'n2'], 1, false, null],
    ['the active tab\'s note gone, no later tab',
      { openTabs: [{ noteId: 'n1' }, { noteId: 'n2' }, { noteId: 'gone' }], activeTabIndex: 2 }, ['n1', 'n2'], 1, false, null],
    ['every note gone',
      { openTabs: [{ noteId: 'gone' }], activeTabIndex: 0, splitViewEnabled: true }, [], 0, true, null],
    ['split view with no secondaryNoteId',
      { openTabs: [{ noteId: 'n1' }], activeTabIndex: 0, splitViewEnabled: true, secondaryNoteId: null }, ['n1'], 0, true, null],
    ['split view with secondaryNoteId never written',
      { openTabs: [{ noteId: 'n1' }], splitViewEnabled: true }, ['n1'], 0, true, null],
    ['split view on a missing secondary note',
      { openTabs: [{ noteId: 'n1' }], splitViewEnabled: true, secondaryNoteId: 'gone' }, ['n1'], 0, true, null],
    ['a secondary note kept with split view off',
      { openTabs: [{ noteId: 'n1' }], splitViewEnabled: false, secondaryNoteId: 'n2' }, ['n1'], 0, false, 'n2'],
    ['openTabs: null',
      { openTabs: null, activeTabIndex: 0, splitViewEnabled: false, secondaryNoteId: null }, [], 0, false, null],
    ['openTabs: null with split view',
      { openTabs: null, activeTabIndex: 3, splitViewEnabled: true, secondaryNoteId: 'n2' }, [], 0, true, 'n2'],
    ['no legacy keys at all', {}, [], 0, false, null],
    ['malformed tab entries',
      { openTabs: ['n1', null, { noteId: 5 }, {}, { noteId: '' }, { noteId: 'n2', name: 7 }], activeTabIndex: 5 }, ['n2'], 0, false, null],
    ['duplicate tabs kept, as 1.4.0 keeps them',
      { openTabs: [{ noteId: 'n1' }, { noteId: 'n1' }, { noteId: 'n2' }], activeTabIndex: 1 }, ['n1', 'n1', 'n2'], 1, false, null],
  ];
  for (const [label, legacy, documentTabs, activeIndex, enabled, secondaryNoteId] of rows) {
    const seeded = T.seedWorkspaceLayout(deepFreeze(legacy), ids);
    assert.deepEqual(seeded, { version: 1, documentTabs, activeIndex, split: { enabled, secondaryNoteId }, inspector: null }, label);
    assert.equal(T.validateWorkspaceLayout(seeded).ok, true, label);
  }
  for (const activeTabIndex of ['1', -1, 1.5, NaN, null, undefined, Infinity]) {
    const seeded = T.seedWorkspaceLayout({ openTabs: [{ noteId: 'n1' }, { noteId: 'n2' }], activeTabIndex }, ids);
    assert.equal(seeded.activeIndex, 0, String(activeTabIndex));
  }
  assert.deepEqual(T.seedWorkspaceLayout(null, ids), layout([]));
  assert.deepEqual(T.seedWorkspaceLayout({ openTabs: [{ noteId: 'n1' }] }, undefined), layout([]));
});

test('AC8: the first Open Workspace after the upgrade shows the seeded tabs and split view', () => {
  const seeded = T.seedWorkspaceLayout({
    openTabs: [{ noteId: 'n1', name: 'One' }, { noteId: 'n2', name: 'Two' }],
    activeTabIndex: 1,
    splitViewEnabled: true,
    secondaryNoteId: 'n1',
  }, ['n1', 'n2']);
  assert.equal(T.noteOnOpenWorkspace(PRISTINE, seeded), 'n2');
  assert.deepEqual(T.resolveTransition(PRISTINE, 'open-workspace', seeded, 'projects').session, {
    version: 1,
    aperture: 'workspace',
    route: 'projects',
    noteId: 'n2',
    layout: { version: 1, documentTabs: ['n1', 'n2'], activeIndex: 1, split: { enabled: true, secondaryNoteId: 'n1' }, inspector: null },
  });
});

// ============ documentTitle ============

test('documentTitle is "NewTabNote" in Moment and "<route label> · NewTabNote" in Workspace', () => {
  const titles = {
    inbox: 'Inbox · NewTabNote',
    daily: 'Daily · NewTabNote',
    projects: 'Projects · NewTabNote',
    templates: 'Templates · NewTabNote',
    search: 'Search · NewTabNote',
    insights: 'Insights · NewTabNote',
    trust: 'Trust · NewTabNote',
    settings: 'Settings · NewTabNote',
    graph: 'Graph · NewTabNote',
    analytics: 'Analytics · NewTabNote',
    archive: 'Archive · NewTabNote',
    trash: 'Trash · NewTabNote',
  };
  assert.deepEqual(Object.keys(titles).sort(), [...T.WORKSPACE_ROUTES].sort());
  for (const [route, title] of Object.entries(titles)) {
    assert.equal(T.documentTitle(session('workspace', route, 'n1', layout(['n1']))), title);
    assert.equal(T.documentTitle(session('moment', route, 'n1', layout(['n1']))), 'NewTabNote');
  }
  assert.equal(T.documentTitle(PRISTINE), 'NewTabNote');
  for (const value of [null, undefined, {}, { aperture: 'workspace' }, { aperture: 'workspace', route: 'bogus' }]) {
    assert.equal(T.documentTitle(value), 'NewTabNote', JSON.stringify(value));
  }
});

test('AC6: documentTitle never contains note text', () => {
  const allowed = new Set(['NewTabNote', ...T.WORKSPACE_ROUTES.map(route => `${T.ROUTE_LABELS[route]} · NewTabNote`)]);
  const noteText = ['Quarterly plan', 'Inbox zero tips', 'Daily standup notes', 'Projects · secret', 'call mom'];
  for (const aperture of ['moment', 'workspace']) {
    for (const route of [null, ...T.WORKSPACE_ROUTES]) {
      for (const text of noteText) {
        const value = { ...session(aperture, route, text, null), title: text, name: text, preview: text, content: [text] };
        const title = T.documentTitle(value);
        assert.ok(allowed.has(title), title);
        assert.ok(!title.includes(text), `${title} contains ${text}`);
      }
    }
  }
});
