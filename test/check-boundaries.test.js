'use strict';

// scripts/check-boundaries.js: the ledger rules with canned hits, then the real
// eslint.config.mjs on the repository and on a copy of js/ with forbidden code added.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const boundaries = require('../scripts/check-boundaries.js');
const { excerpt, MARKERS } = require('../scripts/ci/failure-excerpt.js');

const temps = [];
after(() => temps.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntn-boundaries-'));
  temps.push(dir);
  return dir;
}

/**
 * Canned hits as lint gives them. A named rule's hit lists its names' counts in `names`, and
 * its count is theirs together.
 */
function hitMap(hits) {
  return new Map(hits.map(({ file, rule, count, names }) => {
    if (!names) return [`${file}\0${rule}`, { file, rule, count, at: Array.from({ length: count }, (_, i) => `${i + 1}:1`) }];
    let line = 0;
    const named = new Map(Object.entries(names).map(([name, n]) => [name, {
      count: n, at: Array.from({ length: n }, () => `${++line}:1`),
    }]));
    const at = [...named.values()].flatMap(hit => hit.at);
    return [`${file}\0${rule}`, { file, rule, count: at.length, at, names: named }];
  }));
}

function row(file, rule, count, owner = 12, extra = {}) {
  return { file, rule, count, owner, removeWhen: 'the hits are gone', verify: 'npm run check:boundaries', ...extra };
}

function writeLedger(root, rows, extra = {}) {
  const file = path.join(root, boundaries.LEDGER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ about: 'test', ...extra, rows }, null, 2)}\n`);
}

function readRows(root) {
  return JSON.parse(fs.readFileSync(path.join(root, boundaries.LEDGER), 'utf8')).rows;
}

/**
 * Run the check on `root` with canned hits; `base` maps a ref to the rows of its ledger, or
 * to the whole ledger (with its shrinkOnly), or to null for a ref without one
 */
/**
 * An adapter module a test says declares gaps, since none does once #17 PR 4a deleted the
 * legacy adapter, so the declared-gap checks still run
 */
const EXAMPLE_ADAPTER = 'js/kernel/adapters/example/adapter.js';

async function run(root, argv, { hits = [], errors = [], base = {}, gapOwners } = {}) {
  const lines = [];
  const code = await boundaries.main(argv, {
    root,
    ...(gapOwners ? { declaredGapOwners: gapOwners } : {}),
    lint: async () => ({ hits: hitMap(hits), errors, files: 3 }),
    readBase: ref => {
      if (!Object.hasOwn(base, ref)) throw new Error(`git can't resolve ${ref} to a commit`);
      if (base[ref] === null) return { missing: true };
      const ledger = Array.isArray(base[ref]) ? { about: 'base', rows: base[ref] } : base[ref];
      return { text: JSON.stringify(ledger) };
    },
    log: line => lines.push(line),
    error: line => lines.push(line),
  });
  return { code, output: lines.join('\n') };
}

function assertFails(result, ...expected) {
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /^check:boundaries failed: /);
  for (const text of expected) assert.ok(result.output.includes(text), `"${text}" missing from:\n${result.output}`);
}

describe('scripts/check-boundaries.js with canned hits', () => {
  it('seeds a missing ledger from the hits, sorted by file then rule, with each owner from the seed table', async () => {
    const root = tempRoot();
    assertFails(await run(root, []), 'is missing. Seed it once with `npm run check:boundaries -- --write-baseline`');

    const hits = [
      { file: 'js/b.js', rule: 'Storage', count: 2 },
      { file: 'js/a.js', rule: 'scheduler-timer', count: 1 },
      { file: 'js/a.js', rule: 'LLM', count: 3 },
      { file: 'js/services/sync-service.js', rule: 'fetch', count: 4 },
      { file: 'js/a.js', rule: 'this.storage', count: 1 },
    ];
    const seeded = await run(root, ['--write-baseline'], { hits });
    assert.equal(seeded.code, 0, seeded.output);
    assert.match(seeded.output, /seeded docs\/architecture\/kernel-ledger\.json with 5 rows for 11 hits/);
    assert.deepEqual(readRows(root).map(({ file, rule, count, owner, verify }) => [file, rule, count, owner, verify]), [
      ['js/a.js', 'LLM', 3, 11, 'npm run check:boundaries'],
      ['js/a.js', 'scheduler-timer', 1, 35, 'npm run check:boundaries'],
      ['js/a.js', 'this.storage', 1, 12, 'npm run check:boundaries'],
      ['js/b.js', 'Storage', 2, 12, 'npm run check:boundaries'],
      ['js/services/sync-service.js', 'fetch', 4, 19, 'npm run check:boundaries'],
    ]);
    assert.equal(readRows(root)[1].removeWhen, '#8 deletes them');
    assert.deepEqual(Object.keys(readRows(root)[0]), ['file', 'rule', 'count', 'owner', 'removeWhen', 'verify']);

    const checked = await run(root, [], { hits });
    assert.equal(checked.code, 0, checked.output);
    assert.match(checked.output, /^check:boundaries: OK, 11 hits in 3 files match 5 rows of docs\/architecture\/kernel-ledger\.json$/);
  });

  it('fails on a hit no row covers and on more hits than a row allows, with where they are', async () => {
    const root = tempRoot();
    writeLedger(root, [row('js/a.js', 'Storage', 2)]);
    const result = await run(root, [], { hits: [{ file: 'js/a.js', rule: 'Storage', count: 3 }, { file: 'js/b.js', rule: 'window.app', count: 1 }] });
    assertFails(result,
      'js/a.js: 3 Storage hits, 2 allowed by the ledger',
      'at 1:1, 2:1, 3:1',
      'js/b.js: 1 window.app hit no ledger row covers');
    const lines = excerpt(`${'npm output\n'.repeat(30)}${result.output}`, MARKERS.kernel).split('\n');
    assert.match(lines[0], /^check:boundaries failed: 2 problems against /);
  });

  it('fails on fewer hits than a row allows, until --write-baseline lowers it or deletes the row', async () => {
    const root = tempRoot();
    writeLedger(root, [row('js/a.js', 'Storage', 2), row('js/b.js', 'fetch', 1, 11)]);
    const hits = [{ file: 'js/a.js', rule: 'Storage', count: 1 }];
    assertFails(await run(root, [], { hits }),
      "js/a.js: 1 Storage hit, below the ledger's 2: lower its count to 1 in this PR",
      "js/b.js: 0 fetch hits, below the ledger's 1: delete the row in this PR");

    const recorded = await run(root, ['--write-baseline'], { hits });
    assert.equal(recorded.code, 0, recorded.output);
    assert.deepEqual(readRows(root), [row('js/a.js', 'Storage', 1)]);
    assert.equal((await run(root, [], { hits })).code, 0);
  });

  it('--write-baseline never raises a count or adds a row once the ledger exists', async () => {
    const root = tempRoot();
    writeLedger(root, [row('js/a.js', 'Storage', 1)]);
    const before = fs.readFileSync(path.join(root, boundaries.LEDGER), 'utf8');
    const result = await run(root, ['--write-baseline'], { hits: [{ file: 'js/a.js', rule: 'Storage', count: 2 }, { file: 'js/c.js', rule: 'LLM', count: 1 }] });
    assertFails(result, 'was not written', 'js/a.js: 2 Storage hits, 1 allowed', 'js/c.js: 1 LLM hit no ledger row covers');
    assert.equal(fs.readFileSync(path.join(root, boundaries.LEDGER), 'utf8'), before);
  });

  it('fails on a row with a missing or unknown field, an unknown rule, a bad count or owner, or a repeat', async () => {
    const root = tempRoot();
    const { verify, ...noVerify } = row('js/a.js', 'Storage', 1);
    writeLedger(root, [
      noVerify,
      row('js/b.js', 'Storage', 1, 12, { note: 'extra' }),
      row('js/c.js', 'localStorage', 1),
      row('js/d.js', 'LLM', 0),
      row('js/e.js', 'LLM', 1, '#11'),
      row('js/f.js', 'fetch', 1, 11, { removeWhen: ' ' }),
      row('css/g.css', 'fetch', 1, 11),
      row('js/h.js', 'fetch', 1, 11),
      row('js/h.js', 'fetch', 2, 11),
    ]);
    assertFails(await run(root, []),
      'js/a.js Storage is missing verify',
      "js/b.js Storage has fields the ledger doesn't define: note",
      "js/c.js localStorage names a rule #12 doesn't define",
      'js/d.js LLM needs a count of 1 or more',
      'js/e.js LLM needs an owner issue number',
      'js/f.js fetch needs a removeWhen',
      'css/g.css fetch needs a file under js/',
      'js/h.js fetch appears twice');
  });

  it('takes no declared-gap row since #17 PR 4a, which deleted the legacy adapter, the one module that declared gaps', async () => {
    assert.deepEqual(boundaries.DECLARED_GAP_OWNERS, {});
    const root = tempRoot();
    const adapter = 'js/kernel/adapters/legacy/adapter.js';
    fs.mkdirSync(path.join(root, path.dirname(adapter)), { recursive: true });
    fs.writeFileSync(path.join(root, adapter), '');
    writeLedger(root, [row(adapter, 'declared-gap', 1, 17, { verify: 'contract suite: legacy adapter, atomicMultiStore' })]);
    assertFails(await run(root, []),
      `${adapter} declared-gap (contract suite: legacy adapter, atomicMultiStore) is a declared-gap row, which no adapter module declares`);
  });

  it('never compares declared-gap rows with hits, but needs count 1 and the adapter module to exist', async () => {
    const root = tempRoot();
    const adapter = EXAMPLE_ADAPTER;
    const gapOwners = { [adapter]: 17 };
    const gap = row(adapter, 'declared-gap', 1, 17, { verify: 'contract suite: example adapter, atomicMultiStore' });
    const hits = [{ file: 'js/a.js', rule: 'Storage', count: 1 }];
    writeLedger(root, [gap, row('js/a.js', 'Storage', 1)]);
    assertFails(await run(root, [], { hits, gapOwners }), `names ${adapter}, which doesn't exist`);

    fs.mkdirSync(path.join(root, path.dirname(adapter)), { recursive: true });
    fs.writeFileSync(path.join(root, adapter), '');
    assert.equal((await run(root, [], { hits, gapOwners })).code, 0);
    assert.equal((await run(root, ['--write-baseline'], { hits, gapOwners })).code, 0);
    assert.deepEqual(readRows(root), [row('js/a.js', 'Storage', 1), gap]);

    writeLedger(root, [{ ...gap, count: 2 }]);
    assertFails(await run(root, [], { gapOwners }),
      `${adapter} declared-gap (contract suite: example adapter, atomicMultiStore) is a declared-gap row, so its count is 1`);
  });

  it("takes a declared-gap row only on an adapter module that declares gaps, owned by the issue that closes them", async () => {
    const root = tempRoot();
    const gapOwners = { [EXAMPLE_ADAPTER]: 17 };
    for (const file of [EXAMPLE_ADAPTER, 'js/kernel/adapters/indexeddb/adapter.js', 'js/editor.js']) {
      fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), '');
    }
    const gaps = ['atomicMultiStore', 'idempotency', 'revisions', 'two contexts'].map(name =>
      row(EXAMPLE_ADAPTER, 'declared-gap', 1, 17, { verify: `contract suite: ${name}` }));
    const elsewhere = row('js/editor.js', 'declared-gap', 1, 35, { verify: 'editor saves race' });
    const fifth = row(EXAMPLE_ADAPTER, 'declared-gap', 1, 2, { verify: 'contract suite: moment' });
    // #17's adapter declares none since its PR 4a runs the backup tasks, so the row #18 owned
    // until then is one on a module that declares no gaps
    const backups = row('js/kernel/adapters/indexeddb/adapter.js', 'declared-gap', 1, 18, { verify: 'contract suite: backups' });
    writeLedger(root, [...gaps, backups, elsewhere, fifth]);
    const base = { 'origin/next': [...gaps, backups, elsewhere, fifth] };
    assertFails(await run(root, ['--base', 'origin/next'], { base, gapOwners }),
      `js/editor.js declared-gap (editor saves race) is a declared-gap row, so its file is ${EXAMPLE_ADAPTER}`,
      `${EXAMPLE_ADAPTER} declared-gap (contract suite: moment) is a declared-gap row, so #17 owns it`,
      'js/kernel/adapters/indexeddb/adapter.js declared-gap (contract suite: backups) is a declared-gap row, so its file is '
        + EXAMPLE_ADAPTER);
  });

  it('tells declared-gap rows on one file apart by verify, and rejects two with the same verify', async () => {
    const root = tempRoot();
    const adapter = EXAMPLE_ADAPTER;
    const gapOwners = { [adapter]: 17 };
    fs.mkdirSync(path.join(root, path.dirname(adapter)), { recursive: true });
    fs.writeFileSync(path.join(root, adapter), '');
    const gap = verify => row(adapter, 'declared-gap', 1, 17, { verify });
    const gaps = ['contract suite: revisions', 'contract suite: atomicMultiStore', 'contract suite: two contexts', 'contract suite: idempotency'].map(gap);
    const hits = [{ file: 'js/a.js', rule: 'Storage', count: 1 }];
    writeLedger(root, [...gaps, row('js/a.js', 'Storage', 1)]);
    const checked = await run(root, [], { hits, gapOwners });
    assert.equal(checked.code, 0, checked.output);
    assert.match(checked.output, /match 5 rows/);

    // --write-baseline keeps every one, in verify order, and --base finds each one
    assert.equal((await run(root, ['--write-baseline'], { hits, gapOwners })).code, 0);
    assert.deepEqual(readRows(root).filter(r => r.rule === 'declared-gap').map(r => r.verify), gaps.map(g => g.verify).sort());
    const based = await run(root, ['--base', 'origin/next'], { hits, gapOwners, base: { 'origin/next': [...gaps, row('js/a.js', 'Storage', 1)] } });
    assert.equal(based.code, 0, based.output);

    writeLedger(root, [...gaps, gap('contract suite: revisions'), row('js/a.js', 'Storage', 1), row('js/a.js', 'Storage', 1)]);
    assertFails(await run(root, [], { hits, gapOwners }),
      `${adapter} declared-gap (contract suite: revisions) appears twice`,
      'js/a.js Storage appears twice');
  });

  it('--base fails on a count that rose since the base and on a new row owned by #12', async () => {
    const root = tempRoot();
    const base = { 'origin/next': [row('js/a.js', 'Storage', 2), row('js/a.js', 'scheduler-timer', 1, 35)] };
    const hits = [{ file: 'js/a.js', rule: 'Storage', count: 3 }, { file: 'js/a.js', rule: 'scheduler-timer', count: 1 }, { file: 'js/b.js', rule: 'LLM', count: 1 }];

    writeLedger(root, [row('js/a.js', 'Storage', 3), row('js/a.js', 'scheduler-timer', 1, 35), row('js/b.js', 'LLM', 1, 12)]);
    assertFails(await run(root, ['--base', 'origin/next'], { hits, base }),
      'js/a.js Storage: count 2 at origin/next rose to 3; fix the new hits instead',
      'js/b.js LLM: a row added since origin/next names #12 as owner');
    // Without --base the ledger only has to match the hits
    assert.equal((await run(root, [], { hits })).code, 0);

    // A new row for another issue is fine, and so is a new owner on an existing row
    writeLedger(root, [row('js/a.js', 'Storage', 2), row('js/a.js', 'scheduler-timer', 1, 8), row('js/b.js', 'LLM', 1, 11)]);
    const allowed = await run(root, ['--base', 'origin/next'], { hits: [{ ...hits[0], count: 2 }, hits[1], hits[2]], base });
    assert.equal(allowed.code, 0, allowed.output);
    assert.match(allowed.output, /; no row rose or was added for #12 since origin\/next$/);
  });

  it('--base on a ref without a ledger takes every row as new, and fails on a ref git cannot resolve', async () => {
    const root = tempRoot();
    writeLedger(root, [row('js/a.js', 'Storage', 1)]);
    const hits = [{ file: 'js/a.js', rule: 'Storage', count: 1 }];
    const seeding = await run(root, ['--base', 'HEAD^1'], { hits, base: { 'HEAD^1': null } });
    assert.equal(seeding.code, 0, seeding.output);
    assert.match(seeding.output, /; HEAD\^1 has no ledger, so every row is new$/);
    assertFails(await run(root, ['--base', 'nowhere'], { hits }), "can't read the ledger at nowhere");
  });

  it("fails when ESLint reports something no ledger rule counts, such as a file it can't parse", async () => {
    const root = tempRoot();
    writeLedger(root, []);
    assertFails(await run(root, [], { errors: ["js/a.js:3:1 doesn't parse: Unexpected token"] }),
      "1 ESLint message that no ledger rule counts, so the hits can't be trusted",
      "js/a.js:3:1 doesn't parse: Unexpected token");
  });

  describe("app-callback and legacy-store rows, which may each name the callback or handle they count", () => {
    const callback = (name, count = 1) => row('js/app.js', 'app-callback', count, 3, { name });
    const store = (name, count, owner) => row('js/app.js', 'legacy-store', count, owner, { name });
    const ledger = [
      row('js/app.js', 'app-callback', 2, 3),
      callback('sidebarController.onArchiveNote'),
      callback('tabController.onCreateNote'),
      store('syncStore', 2, 19),
    ];
    const hitsWith = (callbacks, stores = { syncStore: 2 }) => [
      { file: 'js/app.js', rule: 'app-callback', names: callbacks },
      { file: 'js/app.js', rule: 'legacy-store', names: stores },
    ];
    const today = { 'sidebarController.onArchiveNote': 1, 'tabController.onCreateNote': 1, 'sidebarController.onOpenNewTab': 1, 'tabController.getEditor': 1 };

    it("counts a named row's hits by its name, and the file and rule's row the rest", async () => {
      const root = tempRoot();
      writeLedger(root, ledger);
      const result = await run(root, [], { hits: hitsWith(today) });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /OK, 6 hits in 3 files match 4 rows/);
    });

    it("fails on a second hit for a named callback, even with room in the rest, and on a new one past the rest's count", async () => {
      const root = tempRoot();
      writeLedger(root, [{ ...ledger[0], count: 3 }, ...ledger.slice(1)]);
      assertFails(await run(root, [], { hits: hitsWith({ ...today, 'sidebarController.onArchiveNote': 2 }) }),
        'js/app.js: 2 app-callback hits for sidebarController.onArchiveNote, 1 allowed by the ledger',
        "js/app.js: 2 app-callback hits, below the ledger's 3: lower its count to 2 in this PR");

      writeLedger(root, ledger);
      assertFails(await run(root, [], { hits: hitsWith({ ...today, 'sidebarController.onProbe': 1 }) }),
        'js/app.js: 3 app-callback hits, 2 allowed by the ledger');
    });

    it('names the hits no row covers, such as a handle App was never given', async () => {
      const root = tempRoot();
      writeLedger(root, ledger);
      const result = await run(root, [], { hits: hitsWith(today, { syncStore: 3, legacyStorage: 1 }) });
      assertFails(result,
        'js/app.js: 3 legacy-store hits for syncStore, 2 allowed by the ledger',
        'js/app.js: 1 legacy-store hit (legacyStorage) no ledger row covers');
    });

    it('fails on a named row whose hits are gone, until --write-baseline deletes it and keeps the rest as they are', async () => {
      const root = tempRoot();
      writeLedger(root, ledger);
      const hits = hitsWith(Object.fromEntries(Object.entries(today).filter(([name]) => name !== 'tabController.onCreateNote')));
      assertFails(await run(root, [], { hits }),
        "js/app.js: 0 app-callback hits for tabController.onCreateNote, below the ledger's 1: delete the row in this PR");
      const recorded = await run(root, ['--write-baseline'], { hits });
      assert.equal(recorded.code, 0, recorded.output);
      assert.deepEqual(readRows(root), [ledger[0], ledger[1], ledger[3]]);
      assert.deepEqual(Object.keys(readRows(root)[1]), ['file', 'rule', 'name', 'count', 'owner', 'removeWhen', 'verify']);
    });

    it('takes a name only on a row of a named rule, as its rule reports it, once per file and rule', async () => {
      const root = tempRoot();
      writeLedger(root, [
        row('js/a.js', 'Storage', 1, 19, { name: 'syncStore' }),
        callback('not a callback'),
        callback(7),
        callback('sidebarController.onArchiveNote'),
        callback('sidebarController.onArchiveNote'),
      ]);
      assertFails(await run(root, []),
        'js/a.js Storage syncStore names a hit, which only a row of app-callback or legacy-store may',
        'js/app.js app-callback not a callback needs a name its rule reports',
        'js/app.js app-callback needs a name its rule reports',
        'js/app.js app-callback sidebarController.onArchiveNote appears twice');
    });

    it('--base fails on a named row added for #12 or one whose count rose, and takes a row split into named ones for another owner', async () => {
      const root = tempRoot();
      const base = { 'origin/next': [row('js/app.js', 'app-callback', 4, 12), store('syncStore', 2, 19)] };
      writeLedger(root, [row('js/app.js', 'app-callback', 2, 3), callback('sidebarController.onArchiveNote'), callback('tabController.onCreateNote'), store('syncStore', 2, 19)]);
      const split = await run(root, ['--base', 'origin/next'], { hits: hitsWith(today), base });
      assert.equal(split.code, 0, split.output);

      writeLedger(root, [row('js/app.js', 'app-callback', 2, 3), { ...callback('sidebarController.onArchiveNote'), owner: 12 }, callback('tabController.onCreateNote'), store('syncStore', 3, 19)]);
      assertFails(await run(root, ['--base', 'origin/next'], { hits: hitsWith(today, { syncStore: 3 }), base }),
        'js/app.js app-callback sidebarController.onArchiveNote: a row added since origin/next names #12 as owner',
        'js/app.js legacy-store syncStore: count 2 at origin/next rose to 3; fix the new hits instead');
    });

    it('reads the name a message reports after its rule, and nothing from one that names none', () => {
      const message = text => ({ ruleId: 'kernel/app-callback', message: text });
      assert.equal(boundaries.nameOf(message('[app-callback] sidebarController.onArchiveNote: A controller callback into App')), 'sidebarController.onArchiveNote');
      assert.equal(boundaries.nameOf(message('[legacy-store] syncStore: A handle on js/storage.js')), 'syncStore');
      assert.equal(boundaries.nameOf(message('[app-callback] A controller callback into App')), null);
      assert.equal(boundaries.nameOf(message('[app-callback] this[key]: A controller callback into App')), null);
    });
  });

  it('rejects unknown arguments, --base without a ref, and --base with --write-baseline', async () => {
    const root = tempRoot();
    assert.equal((await run(root, ['--fix'])).code, 2);
    assert.equal((await run(root, ['--base'])).code, 2);
    assert.equal((await run(root, ['--write-baseline', '--base', 'origin/next'])).code, 2);
  });

  describe("#17's storage-access rules, whose exemption list only shrinks", () => {
    const SHRINK_ONLY = ['chrome.storage.local', 'getStore', 'legacyBlindWrite', 'objectStore'];
    const seeded = [
      row('js/storage.js', 'getStore', 3, 17),
      row('js/storage.js', 'objectStore', 2, 17),
      row('js/popup.js', 'objectStore', 1, 17),
      row('js/storage.js', 'chrome.storage.local', 2, 17),
    ];
    const hitsOf = rows => rows.map(({ file, rule, count }) => ({ file, rule, count }));
    const base = { 'origin/next': { about: 'base', shrinkOnly: SHRINK_ONLY, rows: seeded } };

    it('seeds its rows by hand in the PR that first lists the rules in shrinkOnly', async () => {
      const root = tempRoot();
      writeLedger(root, seeded, { shrinkOnly: SHRINK_ONLY });
      const result = await run(root, ['--base', 'origin/next'], { hits: hitsOf(seeded), base: { 'origin/next': [] } });
      assert.equal(result.code, 0, result.output);
    });

    it('--base fails on a new row or a higher count for a rule the base lists in shrinkOnly, even owned by #17', async () => {
      const root = tempRoot();
      const rows = [
        row('js/storage.js', 'getStore', 4, 17),
        row('js/storage.js', 'objectStore', 2, 17),
        row('js/popup.js', 'objectStore', 1, 17),
        row('js/storage.js', 'chrome.storage.local', 2, 17),
        row('js/editor.js', 'chrome.storage.local', 1, 25),
        row('js/editor.js', 'legacyBlindWrite', 1, 17),
      ];
      writeLedger(root, rows, { shrinkOnly: SHRINK_ONLY });
      assertFails(await run(root, ['--base', 'origin/next'], { hits: hitsOf(rows), base }),
        "js/storage.js getStore: count 3 at origin/next rose to 4, but getStore's exemption list only shrinks",
        "js/editor.js chrome.storage.local: a row added since origin/next, but chrome.storage.local's exemption list only shrinks",
        "js/editor.js legacyBlindWrite: a row added since origin/next, but legacyBlindWrite's exemption list only shrinks, except by as much as getStore and objectStore hits in the same file fall");
      // Lower counts and dropped rows are what it's for
      const shrunk = [row('js/storage.js', 'getStore', 1, 17), row('js/storage.js', 'objectStore', 2, 17)];
      writeLedger(root, shrunk, { shrinkOnly: SHRINK_ONLY });
      const ok = await run(root, ['--base', 'origin/next'], { hits: hitsOf(shrunk), base });
      assert.equal(ok.code, 0, ok.output);
      assert.match(ok.output, /, and no shrinkOnly list grew$/);
    });

    it('lets a blind write replace raw access in the same file, by as much as that access falls and no more', async () => {
      const root = tempRoot();
      // Two getStore calls and one objectStore call in storage.js become blind writes
      const converted = [
        row('js/storage.js', 'getStore', 1, 17),
        row('js/storage.js', 'objectStore', 1, 17),
        row('js/storage.js', 'legacyBlindWrite', 3, 17),
        row('js/popup.js', 'objectStore', 1, 17),
        row('js/storage.js', 'chrome.storage.local', 2, 17),
      ];
      writeLedger(root, converted, { shrinkOnly: SHRINK_ONLY });
      const ok = await run(root, ['--base', 'origin/next'], { hits: hitsOf(converted), base });
      assert.equal(ok.code, 0, ok.output);
      // One more than the raw access that went, or one in a file whose raw access stayed
      const over = [
        ...converted.filter(r => r.rule !== 'legacyBlindWrite'),
        row('js/storage.js', 'legacyBlindWrite', 4, 17),
        row('js/popup.js', 'legacyBlindWrite', 1, 17),
      ];
      writeLedger(root, over, { shrinkOnly: SHRINK_ONLY });
      assertFails(await run(root, ['--base', 'origin/next'], { hits: hitsOf(over), base }),
        'js/storage.js legacyBlindWrite: a row added since origin/next',
        'js/popup.js legacyBlindWrite: a row added since origin/next');
    });

    it('--base fails when shrinkOnly drops a rule the base lists, and the ledger fails on a bad shrinkOnly', async () => {
      const root = tempRoot();
      writeLedger(root, seeded, { shrinkOnly: ['getStore', 'legacyBlindWrite', 'objectStore'] });
      assertFails(await run(root, ['--base', 'origin/next'], { hits: hitsOf(seeded), base }),
        'shrinkOnly no longer lists chrome.storage.local, which it lists at origin/next; that exemption list only shrinks');
      for (const [shrinkOnly, problem] of [
        ['getStore', "shrinkOnly isn't a list of rules"],
        [['getStore', 'getStore'], 'shrinkOnly names getStore twice'],
        [['localStorage'], 'shrinkOnly names "localStorage", which isn\'t a rule with hits'],
        [['declared-gap'], 'shrinkOnly names "declared-gap", which isn\'t a rule with hits'],
      ]) {
        writeLedger(root, seeded, { shrinkOnly });
        assertFails(await run(root, [], { hits: hitsOf(seeded) }), problem);
      }
    });

    it('--write-baseline keeps shrinkOnly as it lowers counts', async () => {
      const root = tempRoot();
      writeLedger(root, seeded, { shrinkOnly: SHRINK_ONLY });
      const lower = hitsOf(seeded).map(hit => (hit.rule === 'getStore' ? { ...hit, count: 2 } : hit));
      assert.equal((await run(root, ['--write-baseline'], { hits: lower })).code, 0);
      const written = JSON.parse(fs.readFileSync(path.join(root, boundaries.LEDGER), 'utf8'));
      assert.deepEqual(written.shrinkOnly, SHRINK_ONLY);
      assert.equal(written.rows.find(r => r.rule === 'getStore').count, 2);
    });
  });
});

describe('eslint.config.mjs boundary rules', () => {
  it('every message names a ledger rule the check defines', async () => {
    const config = (await import(pathToFileURL(path.join(ROOT, 'eslint.config.mjs')).href)).default;
    const messages = [];
    for (const { rules = {} } of config) {
      for (const [name, [, ...options]] of Object.entries(rules)) {
        if (name === 'no-restricted-globals') {
          const globals = options[0] && options[0].globals ? options[0].globals : options;
          messages.push(...globals.map(entry => [name, entry.message]));
        } else if (name === 'no-restricted-syntax') {
          messages.push(...options.map(entry => [name, entry.message]));
        } else if (name.startsWith('kernel/')) {
          messages.push([name, `[${options[0].rule}] ${options[0].message}`]);
        } else {
          assert.equal(name, 'no-undef', `${name} has no ledger rule; give its messages one or drop it`);
        }
      }
    }
    assert.ok(messages.length >= 10, `found only ${messages.length} messages`);
    for (const [ruleId, message] of messages) {
      const rule = boundaries.ruleOf({ ruleId, message: `Unexpected use of 'x'. ${message}` });
      assert.ok(rule, `${ruleId} message names no ledger rule: ${message}`);
      assert.ok(message.startsWith(`[${rule}] `), `${ruleId} message should start with [${rule}]: ${message}`);
    }
    assert.equal(boundaries.ruleOf({ ruleId: 'no-undef', message: "'chrome' is not defined." }), 'core-global');
    assert.equal(
      boundaries.ruleOf({ ruleId: 'no-undef', message: "'chrome' is not defined." }, 'js/kernel/registry/probe.js'),
      'registry-global',
    );
  });

  it("matches today's hits in js/ to docs/architecture/kernel-ledger.json", async () => {
    const lines = [];
    const code = await boundaries.main([], { log: line => lines.push(line), error: line => lines.push(line) });
    assert.equal(code, 0, lines.join('\n'));
  });

  it('has no row #12 owns, since #12 closed with slice 7c: each belongs to the issue that removes it', () => {
    const { rows } = JSON.parse(fs.readFileSync(path.join(ROOT, boundaries.LEDGER), 'utf8'));
    assert.deepEqual(rows.filter(r => r.owner === 12).map(r => `${r.file} ${r.rule}`), []);
  });

  it("counts each forbidden use in a copy of js/, and inline comments can't switch a rule off", async () => {
    const root = tempRoot();
    fs.cpSync(path.join(ROOT, 'js'), path.join(root, 'js'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'eslint.config.mjs'), path.join(root, 'eslint.config.mjs'));
    fs.cpSync(path.join(ROOT, 'docs', 'architecture'), path.join(root, 'docs', 'architecture'), { recursive: true });
    const append = (file, text) => fs.appendFileSync(path.join(root, file), `\n${text}\n`);
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };

    append('js/sidebar-utils.js', "export function probe() { return indexedDB.open('probe'); }");
    append('js/editor.js', "Storage.updateNote({ id: 'probe' });");
    append('js/search.js', [
      '/* eslint-disable */',
      '// eslint-disable-next-line no-restricted-globals',
      'const probeApp = window.app;',
      'const probeFetch = globalThis.fetch;',
      "const probeLocal = self['Storage'];",
      'export { probeApp, probeFetch, probeLocal };',
    ].join('\n'));
    append('js/shortcut-utils.js', "import './kernel/adapters/legacy/notes.js';");
    // Chrome resolves a leading / from the extension root, and a chrome-extension:// URL by
    // its path, so both reach the adapters too
    append('js/block-placeholders.js', "import '/js/kernel/adapters/legacy/notes.js';");
    append('js/command-palette-utils.js', "import 'chrome-extension://emildbpnneonfcanpfnafkphiflbddig/js/kernel/adapters/legacy/notes.js';");
    append('js/resizable-panel.js', 'export const later = () => import(`./kernel/adapters/legacy/notes.js`);');
    // An import() whose specifier isn't a fixed string can't be checked, so it counts
    append('js/virtual-scroller.js', 'export const named = name => import(`./kernel/${name}.js`);');
    // Other spellings Chrome resolves to the same file: %XX escapes, a scheme-relative URL,
    // .. past the root, and backslashes, which a standard scheme's path reads as slashes
    append('js/image-compression.js', "import './kern%65l/adapters/legacy/notes.js';");
    append('js/stream-renderer.js', "import '/js/kern%65l/adapters/legacy/notes.js';");
    append('js/scroll-state-machine.js', "import '//emildbpnneonfcanpfnafkphiflbddig/js/kernel/adapters/legacy/notes.js';");
    append('js/chat-ui-components.js', "import '/../js/kernel/adapters/legacy/notes.js';");
    append('js/ai-prompt-templates.js', "import '../../js/kernel/adapters/legacy/notes.js';");
    append('js/utils/sanitize.js', "import './../kernel\\\\adapters\\\\legacy\\\\notes.js';");
    // Empty path segments, which the file system reads as one slash
    append('js/blocks.js', "import './kernel//adapters/legacy/notes.js';");
    append('js/embeddings.js', "import '/js//kernel/adapters/legacy/notes.js';");
    append('js/core/storage-error.js', "import '/.//js/kernel/adapters/legacy/notes.js';");
    append('js/utils.js', "import 'chrome-extension://emildbpnneonfcanpfnafkphiflbddig//js/kernel/adapters/legacy/notes.js';");
    // macOS and Windows open the file in any case
    append('js/core/dom-refs.js', "import '/JS/Kernel/Adapters/legacy/notes.js';");
    // A specifier that doesn't resolve counts, and a malformed one doesn't stop the lint
    append('js/ai-response-utils.js', "import 'chrome-extension://emildbpnneonfcanpfnafkphiflbddig/js/%E0%A4%A.js';");
    append('js/core/logger.js', "import 'kernel/adapters/legacy/notes.js';");
    // A URL of another protocol names no file in the package, so it isn't an adapter
    // import, though core may not import one either
    append('js/ui/confirm-dialog.js', "import 'https://cdn.example.test/js/kernel/adapters/legacy/notes.js';");
    write('js/kernel/core/probe.js', [
      "import '../../storage.js';",
      "import 'https://cdn.example.test/valibot.js';",
      "import 'valibot';",
      // Allowed: core itself and the vendored Valibot, however the specifier is written
      "import { sibling } from './domain/sibling.js';",
      "import * as v from '../../lib/valibot/index.mjs';",
      "import '/js/lib/valibot/index.mjs';",
      "import '/js/kernel/core/domain/sibling.js';",
      "import 'chrome-extension://emildbpnneonfcanpfnafkphiflbddig/js/kernel/core/domain/sibling.js';",
      'export const lazy = () => import(`./domain/sibling.js`);',
      'export const lazyValibot = () => import(`../../lib/valibot/index.mjs`);',
      'export const id = chrome.runtime.id;',
      'export const kind = typeof window;',
      'export const ok = [sibling, v, new Map(), Promise.resolve()];',
    ].join('\n'));
    write('js/kernel/core/domain/sibling.js', 'export const sibling = 1;\n');
    // Allowed: the kernel outside core may use legacy objects and its own adapters, and
    // storage.js is the legacy store itself
    write('js/kernel/composition/probe.js', "import '../adapters/legacy/notes.js';\nexport const db = indexedDB;\n");
    write('js/kernel/adapters/legacy/notes.js', 'export const store = self.Storage;\n');
    append('js/storage.js', "indexedDB.open('probe');");
    // App (#12 slice 7c): the whole of Storage again, by name or as a handle it was never
    // given, a new use of a handle it has, a new callback, and a second of one that routes a
    // command; and a controller that takes Storage again
    append('js/app.js', [
      "Storage.updateNote({ id: 'probe' });",
      'export const probeApp = window.app;',
      "export function probeWrite() { return this.legacyStorage.updateNote({ id: 'probe' }); }",
      'export function probeSync() { return this.syncStore.importAll({}); }',
      'export function probeTaken() { const { recovery } = this; return recovery.exportRawStores(); }',
      'export function probeWire() {',
      '  this.sidebarController.onProbe = () => this.probe();',
      '  this.sidebarController.onArchiveNote = () => this.probe();',
      '}',
    ].join('\n'));
    append('js/controllers/tab-controller.js', "function probeStorage() { return this.storage.updateNote({ id: 'probe' }); }");
    // What the ledger allows App today, so the probes count one past it
    const allowed = (rule, name) => JSON.parse(fs.readFileSync(path.join(ROOT, boundaries.LEDGER), 'utf8')).rows
      .find(r => r.file === 'js/app.js' && r.rule === rule && r.name === name).count;
    const over = (rule, name) => {
      const count = allowed(rule, name);
      return `js/app.js: ${count + 1} ${rule} hits${name ? ` for ${name}` : ''}, ${count} allowed by the ledger`;
    };

    const lines = [];
    const code = await boundaries.main([], { root, log: line => lines.push(line), error: line => lines.push(line) });
    const output = lines.join('\n');
    assert.equal(code, 1, output);
    for (const expected of [
      over('Storage'),
      'js/app.js: 1 window.app hit no ledger row covers',
      'js/app.js: 1 legacy-store hit (legacyStorage) no ledger row covers',
      over('legacy-store', 'syncStore'),
      over('legacy-store', 'recovery'),
      over('app-callback'),
      over('app-callback', 'sidebarController.onArchiveNote'),
      'js/controllers/tab-controller.js: 1 this.storage hit no ledger row covers',
      'js/sidebar-utils.js: 1 indexedDB hit no ledger row covers',
      'js/editor.js: 1 Storage hit no ledger row covers',
      'js/search.js: 1 window.app hit no ledger row covers',
      'js/search.js: 1 fetch hit no ledger row covers',
      'js/search.js: 1 Storage hit no ledger row covers',
      'js/shortcut-utils.js: 1 adapter-import hit no ledger row covers',
      'js/block-placeholders.js: 1 adapter-import hit no ledger row covers',
      'js/command-palette-utils.js: 1 adapter-import hit no ledger row covers',
      'js/resizable-panel.js: 1 adapter-import hit no ledger row covers',
      'js/virtual-scroller.js: 1 adapter-import hit no ledger row covers',
      'js/image-compression.js: 1 adapter-import hit no ledger row covers',
      'js/stream-renderer.js: 1 adapter-import hit no ledger row covers',
      'js/scroll-state-machine.js: 1 adapter-import hit no ledger row covers',
      'js/chat-ui-components.js: 1 adapter-import hit no ledger row covers',
      'js/ai-prompt-templates.js: 1 adapter-import hit no ledger row covers',
      'js/utils/sanitize.js: 1 adapter-import hit no ledger row covers',
      'js/blocks.js: 1 adapter-import hit no ledger row covers',
      'js/embeddings.js: 1 adapter-import hit no ledger row covers',
      'js/core/storage-error.js: 1 adapter-import hit no ledger row covers',
      'js/utils.js: 1 adapter-import hit no ledger row covers',
      'js/core/dom-refs.js: 1 adapter-import hit no ledger row covers',
      'js/ai-response-utils.js: 1 adapter-import hit no ledger row covers',
      'js/core/logger.js: 1 adapter-import hit no ledger row covers',
      'js/kernel/core/probe.js: 3 core-import hits no ledger row covers',
      'js/kernel/core/probe.js: 2 core-global hits no ledger row covers',
    ]) {
      assert.ok(output.includes(expected), `"${expected}" missing from:\n${output}`);
    }
    assert.doesNotMatch(output, /js\/kernel\/(composition|adapters)\/|js\/storage\.js|js\/ui\/confirm-dialog\.js/);
    assert.equal(output.split('\n').filter(line => line.startsWith('  - ')).length, 33, output);
  });

  it("keeps #15's registry kit host-neutral in a copy of js/: no browser API, legacy global, or outside import", async () => {
    const root = tempRoot();
    fs.cpSync(path.join(ROOT, 'js'), path.join(root, 'js'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'eslint.config.mjs'), path.join(root, 'eslint.config.mjs'));
    fs.cpSync(path.join(ROOT, 'docs', 'architecture'), path.join(root, 'docs', 'architecture'), { recursive: true });
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    write('js/kernel/registry/probe.js', [
      "import '../core/contracts/limits.js';",
      "import '../../storage.js';",
      "import 'https://cdn.example.test/registry.js';",
      'export const later = name => import(`./${name}.js`);',
      // Allowed: the kit itself and the vendored Valibot
      "import { isId } from './ids.js';",
      "import * as v from '../../lib/valibot/index.mjs';",
      "import '/js/kernel/registry/chords.js';",
      // Each a browser API or legacy global
      'export const id = () => chrome.runtime.id;',
      "export const get = () => fetch('https://example.test/');",
      "export const open = () => indexedDB.open('probe');",
      'export const read = () => Storage.getSetting;',
      'export const kind = typeof document;',
      'export const all = globalThis;',
      'export const wait = () => setTimeout(() => {}, 1);',
      // ECMAScript's own globals are fine
      'export const ok = [isId, v, new Map(), Promise.resolve(), JSON.stringify({}), Object.freeze([])];',
    ].join('\n'));

    const lines = [];
    const code = await boundaries.main([], { root, log: line => lines.push(line), error: line => lines.push(line) });
    const output = lines.join('\n');
    assert.equal(code, 1, output);
    for (const expected of [
      'js/kernel/registry/probe.js: 4 registry-import hits no ledger row covers',
      'js/kernel/registry/probe.js: 7 registry-global hits no ledger row covers',
    ]) {
      assert.ok(output.includes(expected), `"${expected}" missing from:\n${output}`);
    }
    assert.doesNotMatch(output, /core-global|core-import/);
    assert.equal(output.split('\n').filter(line => line.startsWith('  - ')).length, 2, output);
  });

  it("counts #17's storage access in a copy of js/: object stores, getStore, blind writes, and chrome.storage.local", async () => {
    const root = tempRoot();
    fs.cpSync(path.join(ROOT, 'js'), path.join(root, 'js'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'eslint.config.mjs'), path.join(root, 'eslint.config.mjs'));
    fs.cpSync(path.join(ROOT, 'docs', 'architecture'), path.join(root, 'docs', 'architecture'), { recursive: true });
    const append = (file, text) => fs.appendFileSync(path.join(root, file), `\n${text}\n`);
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };

    append('js/sidebar-utils.js', [
      "export const probeStore = tx => tx.objectStore('canvases');",
      "export const probeComputed = tx => tx['objectStore']('elements');",
      "export const probeGet = storage => storage.getStore('links');",
      "export const probeBlind = adapter => adapter.legacyBlindWrite(['notes'], () => {});",
      "export const probeLocal = () => chrome.storage.local.get('x');",
      // Through an alias, a computed property, and optional chaining, as storage.js reaches it
      'export const probeAlias = api => api.storage.local.set({});',
      "export const probeSelf = () => self.chrome['storage']['local'];",
      'export const probeOptional = () => chrome.storage?.local;',
    ].join('\n'));
    // Called through .call, .apply, or a bound copy, passed on, or taken apart, under its own
    // name or another, and chrome.storage.local taken apart the same ways
    write('js/probe-access.js', [
      "export const viaCall = tx => tx.objectStore.call(tx, 'canvases');",
      "export const viaApply = tx => tx.objectStore.apply(tx, ['canvases']);",
      "export const viaBind = tx => tx.objectStore.bind(tx)('canvases');",
      "export const taken = tx => { const { objectStore: open } = tx; return open.call(tx, 'canvases'); };",
      "export const passed = storage => [storage.getStore].map(get => get('links'));",
      'export const param = ({ getStore }) => getStore;',
      "export const blind = adapter => { const { legacyBlindWrite } = adapter; return legacyBlindWrite.apply(adapter, [['notes'], () => {}]); };",
      'export const local = () => { const { local } = chrome.storage; return local; };',
      'export const nested = () => { const { storage: { local } } = chrome; return local; };',
      'export const renamed = () => { const { storage: area } = self.chrome; return area; };',
      'export const later = () => { const { storage } = chrome; return storage.local; };',
      // Where it's defined isn't a use
      'export const defines = holder => { holder.getStore = () => null; };',
    ].join('\n'));
    // Through a name bound to a storage or to chrome, before or after it's bound, and a blind
    // write imported or passed on under another name
    write('js/probe-alias.js', [
      "import { legacyBlindWrite as write } from './probe-blind.js';",
      "export { legacyBlindWrite as blind } from './probe-blind.js';",
      "export const viaConst = () => { const area = chrome.storage; return area.local.get('x'); };",
      'export const viaLet = () => { let area; area = self.chrome.storage; return area.local; };',
      "export const viaAlias = () => { const area = chrome.storage; const again = area; return again['local']; };",
      'export const viaRenamed = () => { const { storage: area } = chrome; return area.local; };',
      'export const fromAlias = () => { const area = chrome.storage; const { local } = area; return local; };',
      'export const fromChromeAlias = () => { const api = chrome; const { storage } = api; return storage; };',
      'export const early = () => later.local;',
      'const later = chrome.storage;',
      // An alias bound, in reading order, before what it's bound to
      'export const backward = () => { const copy = forward; return copy.local; };',
      'const forward = chrome.storage;',
      'export const writes = () => write;',
    ].join('\n'));
    // js/storage.js is outside #12's rules, but not #17's
    append('js/storage.js', "function probeBlind(adapter) { return adapter.legacyBlindWrite(['notes'], () => {}); }");
    append('js/storage.js', 'function probeAlias() { const area = chrome.storage; return area.local; }');
    // Kernel core isn't exempt
    write('js/kernel/core/probe-store.js', "export const raw = tx => tx.objectStore('canvases');\n");
    // Allowed: #17's adapter opens stores, and adapters and composition roots reach
    // chrome.storage.local; a method named getStore counts only where it's used, not where
    // it's defined
    write('js/kernel/adapters/indexeddb/probe.js', "export const raw = tx => tx.objectStore('canvases');\nexport const get = s => s.getStore('x');\n");
    write('js/kernel/adapters/legacy/probe.js', 'export const settings = () => chrome.storage.local;\nexport const { local } = chrome.storage;\n');
    write('js/kernel/composition/probe.js', 'export const settings = () => chrome.storage.local;\nexport const { storage } = chrome;\n');
    append('js/search.js', 'export const holder = { getStore() { return null; } };');

    const lines = [];
    const code = await boundaries.main([], { root, log: line => lines.push(line), error: line => lines.push(line) });
    const output = lines.join('\n');
    assert.equal(code, 1, output);
    for (const expected of [
      'js/sidebar-utils.js: 2 objectStore hits no ledger row covers',
      'js/sidebar-utils.js: 1 getStore hit no ledger row covers',
      'js/sidebar-utils.js: 1 legacyBlindWrite hit no ledger row covers',
      'js/sidebar-utils.js: 4 chrome.storage.local hits no ledger row covers',
      'js/sidebar-utils.js: 3 chrome.storage hits no ledger row covers',
      'js/probe-access.js: 4 objectStore hits no ledger row covers',
      'js/probe-access.js: 2 getStore hits no ledger row covers',
      'js/probe-access.js: 1 legacyBlindWrite hit no ledger row covers',
      // `storage` taken from chrome, then storage.local on it, is two
      'js/probe-access.js: 5 chrome.storage.local hits no ledger row covers',
      'js/probe-access.js: 1 chrome.storage hit no ledger row covers',
      // `storage` taken from chrome, then `area.local` on it, is two again
      'js/probe-alias.js: 9 chrome.storage.local hits no ledger row covers',
      'js/probe-alias.js: 6 chrome.storage hits no ledger row covers',
      'js/probe-alias.js: 2 legacyBlindWrite hits no ledger row covers',
      'js/storage.js: 1 legacyBlindWrite hit no ledger row covers',
      'js/storage.js: 13 chrome.storage.local hits, 12 allowed by the ledger',
      'js/kernel/core/probe-store.js: 1 objectStore hit no ledger row covers',
    ]) {
      assert.ok(output.includes(expected), `"${expected}" missing from:\n${output}`);
    }
    assert.doesNotMatch(output, /js\/kernel\/(composition|adapters)\/|js\/search\.js/);
    assert.equal(output.split('\n').filter(line => line.startsWith('  - ')).length, 16, output);
  });
});
