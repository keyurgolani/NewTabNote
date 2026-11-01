'use strict';

// #12 slice 2: docs/architecture/write-paths.md maps every mutating persistence call
// outside js/storage.js to the kernel command it becomes. scripts/write-paths.js finds the
// calls and writes the doc; these tests keep the doc, the script, and the code in step.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  WRITES, READS, MODE_WRITES, COMMANDS, RULES, STATUSES, DOC,
  scanSource, storageMembers, staleListings, classify, collect, check, main,
} = require('../scripts/write-paths.js');

const ROOT = path.join(__dirname, '..');

/** The calls one file's source makes, as `op key` strings, and its problems */
function ops(source, file = 'js/x.js', options = {}) {
  const { hits, problems } = scanSource(file, source, options);
  return { calls: hits.map(h => (h.key ? `${h.op} ${h.key}` : h.op)), hits, problems };
}

/**
 * A js/storage.js whose DatabaseManager defines every method the lists name, as the real one
 * does, and transaction() and getStore(), which it lost in #17 PR 4b, so a case can open one
 */
const STORAGE_STUB = `class DatabaseManager {\n${[...WRITES, ...MODE_WRITES, ...READS].map(op => `  ${op}() {}`).join('\n')}\n}\n`;

/**
 * A scratch repository holding only `files`, and STORAGE_STUB as js/storage.js unless they give
 * their own, or null for none, removed after `body`
 */
function withRepo(files, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'write-paths-'));
  try {
    for (const [file, text] of Object.entries({ 'js/storage.js': STORAGE_STUB, ...files })) {
      if (text === null) continue;
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    return body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** The rows a scratch repository's files give, as `method | call | command | status` */
function rowsOf(files) {
  return withRepo(files, (root) => {
    const { rows, problems } = collect(root);
    return { rows: rows.map(r => `${r.method} | ${r.call} | ${r.command} | ${r.status}`), problems };
  });
}

const quiet = { log() {}, error() {} };

describe('the write-path doc', () => {
  it(`${DOC} matches the code`, () => {
    assert.deepEqual(check(ROOT), []);
  });

  it('Storage has no deletes of its own, so every delete leaves its tombstone (#17 PR 2b, PR 4b)', () => {
    // DatabaseManager's deletes left no tombstone, so a note they deleted would stay in the
    // recovery points. #12 slice 7 and #17 PR 4a deleted their callers, and #17 PR 4b the
    // methods, so a call to one fails the scan as a method DatabaseManager doesn't define
    const members = storageMembers(ROOT);
    const deletes = ['permanentlyDeleteNote', 'deleteFolder', 'deleteElements', 'deleteElementsByNote', 'deleteMediaByNote', 'deleteSnapshotsByNote'];
    assert.deepEqual(deletes.filter(op => members.has(op)), []);
    const { rows } = collect(ROOT);
    assert.deepEqual(rows.filter(row => deletes.includes(row.op)), []);
  });

  it('no DatabaseManager method is listed as both a read and a write', () => {
    const listed = [...WRITES, ...MODE_WRITES, ...READS];
    assert.equal(listed.length, new Set(listed).size);
  });

  it("lists only what DatabaseManager defines, and rules only ops something writes with (R88's read of #17 PR 4a)", () => {
    const members = storageMembers(ROOT);
    assert.deepEqual([...WRITES, ...READS].filter(op => !members.has(op)), []);
    assert.deepEqual(staleListings(members), []);
    // A DatabaseManager that loses a listed method fails the check until the lists drop it
    const { problems } = withRepo({ 'js/storage.js': 'class DatabaseManager {\n  getSetting() {}\n}\n' }, root => collect(root));
    assert.ok(problems.some(p => /^WRITES in scripts\/write-paths\.js lists setSetting, which DatabaseManager doesn't define: drop it$/.test(p)), problems[0]);
    assert.ok(problems.some(p => /^READS in scripts\/write-paths\.js lists getAllNotes, which DatabaseManager doesn't define/.test(p)));
    assert.ok(!problems.some(p => / lists getSetting,/.test(p)));
  });

  it('every rule names a command, and every command has a slice, a PR, or a ledger issue', () => {
    const statuses = STATUSES.map(([status]) => status);
    for (const rule of RULES) {
      assert.ok(Object.hasOwn(COMMANDS, rule.command), `${rule.command} isn't in COMMANDS`);
      if (rule.status !== undefined) assert.ok(statuses.includes(rule.status), `${rule.command}'s rule has no such status`);
    }
    for (const [command, entry] of Object.entries(COMMANDS)) {
      const routes = [[4, 5, 6].includes(entry.slice), entry.pr === '#17 PR 4b', [11, 19, 22].includes(entry.ledger)];
      assert.equal(routes.filter(Boolean).length, 1, `${command} needs exactly one of slice 4 to 6, #17 PR 4b, or ledger #11, #19, or #22`);
    }
    assert.equal(statuses.length, new Set(statuses).size);
  });

  it("the facade's derived writes are kernel commands, and sync's remote apply has no live path (#17 PR 4b)", () => {
    const { rows } = collect(ROOT);
    const status = (op) => [...new Set(rows.filter(row => row.op === op).map(row => row.status))];
    for (const op of ['setSearchIndex', 'setSearchIndexEntry', 'removeSearchIndexEntry', 'saveVector']) {
      assert.deepEqual(status(op), ['kernel command, #17 PR 4b'], op);
    }
    for (const op of ['importNote', 'importAll', 'saveElement']) assert.deepEqual(status(op), ['no live path'], op);
  });

  it('scopes every rule that names a file or a method to the methods it calls', () => {
    for (const rule of RULES) {
      if (rule.file !== undefined || rule.method !== undefined) assert.ok(rule.op !== undefined, `${rule.command}'s rule needs an op`);
    }
  });
});

describe('scanning', () => {
  it('finds writes on every route to the Storage global, and not reads', () => {
    const { calls, problems } = ops(`
      function appStorage() { return /** @type {any} */ (globalThis).Storage; }
      class A {
        _getStorage() { return this.storage; }
        run(note) {
          Storage.setSearchIndexEntry(note);
          self.Storage.removeSearchIndexEntry(note.id);
          (typeof window !== 'undefined' ? window : self).Storage.saveVector(note.id, []);
          this.storage.setSetting('theme', 'dark');
          appStorage().setSearchIndex([]);
          this._getStorage().saveElement({});
          const storage = this.storage;
          storage.importNote(note);
          const { storage: db } = this;
          db.importAll(note);
          Storage.transaction(['canvases'], 'readwrite');
          Storage.getStore('canvases', 'readwrite');
          Storage.getAllNotes(true);
          Storage.getSetting('theme');
          Storage.transaction('canvases');
          this.notesManager.saveVector(note.id);
        }
      }`);
    assert.deepEqual(problems, []);
    assert.deepEqual(calls, ['setSearchIndexEntry', 'removeSearchIndexEntry', 'saveVector', 'setSetting theme', 'setSearchIndex', 'saveElement',
      'importNote', 'importAll', 'transaction canvases', 'getStore canvases']);
  });

  it('shows the receiver it resolved, never a local name', () => {
    const { hits } = ops(`
      function editorStorage() { return globalThis.Storage; }
      class A {
        run(note) {
          const db = this.storage;
          db.saveVector(note.id, []);
          editorStorage().setSearchIndexEntry(note);
        }
      }
      function add(db, note) {
        const tx = db.transaction('canvases', 'readwrite');
        const notesStore = tx.objectStore('canvases');
        notesStore.add(note);
      }
      function cursorWrite(request) { const cursorOverNotes = request.result; cursorOverNotes.delete(); }
      function cache(id) { const api = A._chromeApi(); const area = api.storage.local; area.set({ lastOpenedNoteId: id }); }`);
    assert.deepEqual(hits.map(h => h.call), [
      'this.storage.saveVector(…)',
      'Storage.setSearchIndexEntry(…)',
      "objectStore('canvases').add(…)",
      'cursor.delete(…)',
      'chrome.storage.local.set({lastOpenedNoteId})',
    ]);
  });

  it('records setting keys as written, through constants too', () => {
    const { calls } = ops(`
      const SIDEBAR_KEY = 'sidebarOpen';
      const KEYS = { width: 'sidebarWidth' };
      Storage.setSetting(\`insightsExtracting_\${id}\`, 1);
      Storage.setSetting(name, 2);
      Storage.setSetting(SIDEBAR_KEY, true);
      Storage.setSetting(KEYS.width, 300);`);
    assert.deepEqual(calls, ['setSetting insightsExtracting_${…}', 'setSetting (computed)', 'setSetting sidebarOpen', 'setSetting sidebarWidth']);
  });

  it('finds chrome.storage, raw IndexedDB, and Web Storage writes', () => {
    const { calls, problems } = ops(`
      chrome.storage.local.set({ lastOpenedNoteId: id });
      chrome.storage.sync.remove(['a', 'b']);
      chrome.storage.local.get('lastOpenedNoteId', () => {});
      function add(db, note) {
        const tx = db.transaction('canvases', 'readwrite');
        const store = tx.objectStore('canvases');
        store.add(note);
      }
      function wipe(db) { db.transaction(['settings'], 'readwrite'); }
      function read(db) { db.transaction('canvases', 'readonly').objectStore('canvases').get(1); }
      function cursorWrite(request) { const cursor = request.result; cursor.delete(); }
      indexedDB.open('NewTabNoteDB');
      indexedDB.open('NewTabNoteDB', 9);
      localStorage.setItem('k', 'v');
      sessionStorage.getItem('k');
    `);
    assert.deepEqual(problems, []);
    assert.deepEqual(calls, ['set lastOpenedNoteId', 'remove a, b', 'add canvases', 'transaction settings', 'delete',
      'open', 'setItem k']);
  });

  it('counts a readwrite transaction with no store write of its own, even beside one that has', () => {
    const { calls } = ops(`
      function both(db, note) {
        db.transaction('settings', 'readwrite');
        const tx = db.transaction('canvases', 'readwrite');
        tx.objectStore('canvases').put(note);
      }`);
    assert.deepEqual(calls, ['transaction settings', 'put canvases']);
  });

  it("keeps the class for a function declared inside a method", () => {
    const { hits } = ops(`
      class App {
        run() {
          async function helper() { await Storage.saveVector(id, []); }
          return helper();
        }
      }`);
    assert.deepEqual(hits.map(h => h.method), ['App.run > helper']);
  });

  it('fails on writes it can only see part of', () => {
    const problemsOf = source => ops(source).problems.map(p => p.replace(/^js\/x\.js:\d+ /, ''));
    const cases = {
      'a getStore mode in a variable': 'function f(mode) { Storage.getStore("canvases", mode).put(n); }',
      'a getStore store in a variable': 'function f(mode) { const s = Storage.getStore(x, mode); s.put(n); }',
      'a transaction mode in a variable': 'function f(db, mode) { db.transaction("canvases", mode); }',
      'Storage kept on another property': 'class A { constructor() { this.db = Storage; } f(n) { this.db.saveVector(n); } }',
      'Storage passed as a parameter': 'function f(storage, n) { storage.saveVector(n); }',
      'the opener window': 'function f(n) { window.opener.Storage.saveVector(n); }',
      'a dependency bag': 'class A { f(n) { this.deps.storage.saveVector(n); } }',
      'a ternary alias': 'function f(n, other) { const s = n ? Storage : other; s.saveVector(n); }',
      'a store bound with let': 'function f(tx, n) { let store; store = tx.objectStore("canvases"); store.put(n); }',
      'a chrome.storage area bound with let': 'function f(id) { let area = chrome.storage.local; area.set({ id }); }',
    };
    for (const [name, source] of Object.entries(cases)) {
      assert.equal(problemsOf(source).length, 1, `${name}: ${JSON.stringify(problemsOf(source))}`);
    }
  });

  it('lets write-named calls on App components, this, and new objects through', () => {
    const { problems, calls } = ops(`
      class App {
        constructor() { this.searchEngine = new SearchEngine(); }
        run(id) {
          this.saveVector(id);
          this.notesManager.saveVector(id);
          this.sidebarController.setSetting(id);
          this.searchEngine.setSearchIndex(id);
        }
      }
      const storage = new PopupStorage();
      storage.setSearchIndexEntry('Quick');`);
    assert.deepEqual(problems, []);
    assert.deepEqual(calls, []);
  });

  it("fails a call to a method DatabaseManager doesn't define though a list names it, as Storage.isUpgraded() since #17 PR 4a (R88)", () => {
    const members = storageMembers(ROOT);
    assert.equal(members.has('isUpgraded'), false, 'js/storage.js lost it');
    const { calls, problems } = ops('Storage.isUpgraded();\nStorage.getAllNotes(true);\n', 'js/x.js', { members });
    assert.deepEqual(calls, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /calls Storage\.isUpgraded, which DatabaseManager doesn't define/);
    // A read and a write the lists name fail the same way once DatabaseManager loses them
    const lost = ops('Storage.getAllNotes(true);\nStorage.saveVector(id, v);\n', 'js/x.js', { members: new Set(['constructor']) });
    assert.deepEqual(lost.calls, []);
    assert.match(lost.problems[0], /calls Storage\.getAllNotes, which DatabaseManager doesn't define/);
    assert.match(lost.problems[1], /calls Storage\.saveVector, which DatabaseManager doesn't define/);
  });

  it("fails a call to what js/storage.js's shell doesn't have, its transaction() and getStore() among them (#17 PR 4b)", () => {
    const members = storageMembers(ROOT);
    const { calls, problems } = ops(`
      Storage.transaction(['canvases'], 'readwrite');
      Storage.getStore('canvases', 'readwrite').put(note);
      Storage.getStore('links').getAll();
      this.storage.transaction('settings', 'readwrite');
      Storage.createNote('x');
      Storage.getNote(id);
      db.transaction('canvases', 'readwrite');
    `, 'js/x.js', { members });
    assert.deepEqual(calls, ['transaction canvases']);
    assert.deepEqual(problems.map(p => p.replace(/^js\/x\.js:\d+ /, '')), [
      "calls Storage.transaction, which DatabaseManager doesn't define: fix the call",
      "calls Storage.getStore, which DatabaseManager doesn't define: fix the call",
      "calls Storage.getStore, which DatabaseManager doesn't define: fix the call",
      "calls this.storage.transaction, which DatabaseManager doesn't define: fix the call",
      "calls Storage.createNote, which DatabaseManager doesn't define: fix the call, or list it in UNDEFINED_WRITES",
      "calls Storage.getNote, which DatabaseManager doesn't define: fix the call, or list it in UNDEFINED_WRITES",
    ]);
  });

  it('reports a Storage method DatabaseManager lacks, one it has but nobody classified, and one handed on uncalled', () => {
    const { calls, problems } = ops(`
      Storage.saveEverything();
      Storage.newThing();
      const save = Storage.saveVector;
      if (typeof Storage.importAll === 'function') Storage.importAll(data);
    `, 'js/x.js', { members: new Set(['newThing', 'saveVector']) });
    assert.deepEqual(calls, ['importAll']);
    assert.equal(problems.length, 3);
    assert.match(problems[0], /saveEverything, which DatabaseManager doesn't define/);
    assert.match(problems[1], /DatabaseManager\.newThing isn't in WRITES or READS/);
    assert.match(problems[2], /passes Storage\.saveVector on without calling it/);
  });

  it('names the method each call sits in, and what an anonymous function is for', () => {
    const { hits } = ops(`
      let ready = Storage.setSetting('a', 1);
      async function capture() { await Storage.saveElement({}); }
      class SidebarController {
        bind() {
          button.addEventListener('click', async () => { await this.storage.setSearchIndex([]); });
          this.panel.onResizeEnd = (w) => this.storage.setSetting('sidebarWidth', w);
          const items = [{ label: 'Delete', action: async () => { await this.storage.removeSearchIndexEntry(f.id); } }];
          chrome.runtime.onInstalled.addListener(() => Storage.saveVector(id, []));
          [1].forEach(() => Storage.setSearchIndexEntry(e));
        }
      }`);
    assert.deepEqual(hits.map(h => h.method), [
      '(top level)',
      'capture',
      'SidebarController.bind > click listener',
      'SidebarController.bind > onResizeEnd',
      'SidebarController.bind > action',
      'SidebarController.bind > runtime.onInstalled listener',
      'SidebarController.bind',
    ]);
  });
});

describe('classifying', () => {
  const hit = fields => ({ file: 'js/controllers/sidebar-controller.js', line: 1, method: 'SidebarController.x', kind: 'storage', key: null, fields: [], call: '', ...fields });

  it('gives a call its command and status', () => {
    const vector = classify(hit({ method: 'NotesManager.updateMissingEmbeddings', op: 'saveVector' }));
    assert.deepEqual([vector.command, vector.status], ['saveVector', 'kernel command, #17 PR 4b']);
    const key = classify(hit({ file: 'js/llm.js', method: 'LLMService.setApiKey', op: 'setSetting', key: 'llmApiKey' }));
    assert.deepEqual([key.command, key.status], ['saveProviderSettings', 'ledgered to #11']);
  });

  it("leaves a call outside a file-scoped rule's file unclassified", () => {
    assert.equal(classify(hit({ file: 'js/editor.js', method: 'BlockEditor.x', op: 'saveElement' })).command, null);
    const remote = classify(hit({ file: 'js/services/sync-service.js', method: 'SyncService._applyResolution', op: 'saveElement' }));
    assert.deepEqual([remote.command, remote.status], ['applyRemoteChanges', 'no live path']);
  });

  it('ledgers every write in a ledgered file to its issue', () => {
    const vector = classify(hit({ file: 'js/services/sync-service.js', method: 'SyncService.x', op: 'saveVector' }));
    assert.equal(vector.status, 'ledgered to #19');
  });

  it('leaves a call no rule covers unclassified', () => {
    assert.equal(classify(hit({ op: 'deleteMediaByNote' })).command, null);
  });
});

describe('statuses from the code', () => {
  it("classifies App's writes as any file's, since #12 slice 7 deleted its copies of controller paths", () => {
    const { rows } = rowsOf({
      'js/app.js': `class App {
  init() {
    this.sidebarController = new SidebarController();
    this.sidebarController.onToggleSidebar = () => this.toggleSidebar();
  }
  toggleSidebar() {
    Storage.setSetting('sidebarWidth', 1);
  }
  saveVector(id) {
    return Storage.saveVector(id, []);
  }
}
window.App = App;
`,
    });
    assert.deepEqual(rows, [
      "App.toggleSidebar | Storage.setSetting('sidebarWidth', …) | setPreferences | kernel command, slice 6",
      'App.saveVector | Storage.saveVector(…) | saveVector | no live caller',
    ]);
    assert.ok(!STATUSES.some(([status]) => status === 'deleted in slice 7'));
  });

  it('marks a write in a method nothing calls as having no live caller', () => {
    const { rows } = rowsOf({
      'js/controllers/notes-manager.js': `class NotesManager {
  init() { this.ready = true; }
  async updateAutoTitleSettings(enabled) {
    await this.storage.setSetting('autoTitleEnabled', enabled);
  }
  async updateInsightsSettings(enabled) {
    await this.storage.setSetting('insightsEnabled', enabled);
  }
}
const manager = new NotesManager();
manager.updateInsightsSettings(true);
`,
    });
    assert.deepEqual(rows, [
      "NotesManager.updateAutoTitleSettings | this.storage.setSetting('autoTitleEnabled', …) | setPreferences | no live caller",
      "NotesManager.updateInsightsSettings | this.storage.setSetting('insightsEnabled', …) | setPreferences | kernel command, slice 6",
    ]);
  });
});

describe('the check', () => {
  const source = (extra = '') => `class SidebarController {
  saveEmbedding(note) {
    this.storage.saveVector(note.id, []);${extra}
  }
}
new SidebarController().saveEmbedding(n);
`;

  it('fails until the doc is written, then passes when only line numbers move', () => {
    withRepo({ 'js/sidebar.js': source() }, (root) => {
      assert.match(check(root).join('\n'), /write-paths\.md is missing/);
      assert.equal(main(['--write'], { root, ...quiet }), 0);
      assert.deepEqual(check(root), []);
      fs.writeFileSync(path.join(root, 'js/sidebar.js'), `\n\n\n${source()}`);
      assert.deepEqual(check(root), []);
      assert.equal(main([], { root, ...quiet }), 0);
    });
  });

  it('passes when a menu label or a local name changes', () => {
    const menu = (label, local) => `class SidebarController {
  showNoteContextMenu(note) {
    const items = [{ label: '${label}', action: async () => {
      const ${local} = this.storage;
      await ${local}.saveVector(note.id, []);
    } }];
    return items;
  }
}
new SidebarController().showNoteContextMenu(n);
`;
    withRepo({ 'js/sidebar.js': menu('Pin', 'db') }, (root) => {
      assert.equal(main(['--write'], { root, ...quiet }), 0);
      fs.writeFileSync(path.join(root, 'js/sidebar.js'), menu('Pin note', 'notes'));
      assert.deepEqual(check(root), []);
    });
  });

  it('fails when a write path is added or removed without rewriting the doc', () => {
    withRepo({ 'js/sidebar.js': source() }, (root) => {
      main(['--write'], { root, ...quiet });
      fs.writeFileSync(path.join(root, 'js/sidebar.js'), source('\n    this.storage.setSearchIndexEntry(note);'));
      assert.match(check(root).join('\n'), /missing from docs\/architecture\/write-paths\.md: .*setSearchIndexEntry/);
      assert.equal(main([], { root, ...quiet }), 1);
      fs.writeFileSync(path.join(root, 'js/sidebar.js'), 'class SidebarController {}\n');
      assert.match(check(root).join('\n'), /in docs\/architecture\/write-paths\.md but not in the code: .*saveVector/);
    });
  });

  it('refuses to write or pass a call no rule covers', () => {
    withRepo({ 'js/sidebar.js': source("\n    this.storage.setSetting('mystery', 1);") }, (root) => {
      assert.equal(main(['--write'], { root, ...quiet }), 1);
      assert.ok(!fs.existsSync(path.join(root, DOC)));
      assert.match(check(root).join('\n'), /setSetting\('mystery', …\) has no rule/);
    });
  });

  it('skips js/storage.js, js/lib/, and js/kernel/', () => {
    withRepo({
      'js/storage.js': `${STORAGE_STUB}Storage.saveVector(n);\n`,
      'js/lib/vendor.js': 'Storage.saveVector(n);',
      'js/kernel/adapters/legacy/notes.js': 'Storage.saveVector(n);',
    }, (root) => {
      assert.equal(main(['--write'], { root, ...quiet }), 0);
      assert.match(fs.readFileSync(path.join(root, DOC), 'utf8'), /\| Total \| 0 \|/);
    });
  });

  it("fails when js/storage.js has no class DatabaseManager, or there's no js/storage.js, where the lookup let every call through (R88's read of #17 PR 4b)", () => {
    for (const [what, storage] of [['no class', 'window.Storage = {};\n'], ['no file', null]]) {
      withRepo({ 'js/storage.js': storage, 'js/sidebar.js': source() }, (root) => {
        assert.equal(storageMembers(root), null, what);
        assert.deepEqual(collect(root).problems, [
          'js/storage.js has no class DatabaseManager, so no call to it can be checked: keep the class, or take Storage out of scripts/write-paths.js',
        ], what);
        assert.equal(main(['--write'], { root, ...quiet }), 1, what);
        assert.ok(!fs.existsSync(path.join(root, DOC)), `${what}: the doc was written`);
      });
    }
    // The same repository with the class passes
    withRepo({ 'js/sidebar.js': source() }, (root) => {
      assert.deepEqual(collect(root).problems, []);
    });
  });
});
