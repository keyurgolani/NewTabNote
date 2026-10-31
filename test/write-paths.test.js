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
  scanSource, classify, collect, check, main,
} = require('../scripts/write-paths.js');

const ROOT = path.join(__dirname, '..');

/** The calls one file's source makes, as `op key` strings, and its problems */
function ops(source, file = 'js/x.js', options = {}) {
  const { hits, problems } = scanSource(file, source, options);
  return { calls: hits.map(h => (h.key ? `${h.op} ${h.key}` : h.op)), hits, problems };
}

/** A scratch repository holding only `files`, removed after `body` */
function withRepo(files, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'write-paths-'));
  try {
    for (const [file, text] of Object.entries(files)) {
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

  it("Storage's own deletes run on no live path, so every delete leaves its tombstone (#17 PR 2b)", () => {
    // DatabaseManager's deletes leave no tombstone, so a note they deleted would stay in the
    // recovery points: each call is App's copy of a controller path, for slice 7 to delete
    const { rows } = collect(ROOT);
    const deletes = rows.filter(row => /\.(permanentlyDeleteNote|emptyTrash|cleanupTrash|deleteFolder|bulkNoteAction)\(/.test(row.call));
    assert.ok(deletes.length >= 3, `${deletes.length} delete calls`);
    for (const row of deletes) {
      assert.ok(['deleted in slice 7', 'no live caller'].includes(row.status), `${row.method}: ${row.call} is ${row.status}`);
    }
  });

  it('no DatabaseManager method is listed as both a read and a write', () => {
    const listed = [...WRITES, ...MODE_WRITES, ...READS];
    assert.equal(listed.length, new Set(listed).size);
  });

  it('every rule names a command, and every command has a slice or a ledger issue', () => {
    for (const rule of RULES) assert.ok(Object.hasOwn(COMMANDS, rule.command), `${rule.command} isn't in COMMANDS`);
    for (const [command, entry] of Object.entries(COMMANDS)) {
      const slice = [4, 5, 6].includes(entry.slice);
      const ledger = [11, 19, 22].includes(entry.ledger);
      assert.ok(slice !== ledger, `${command} needs exactly one of slice 4 to 6 or ledger #11, #19, or #22`);
    }
    const statuses = STATUSES.map(([status]) => status);
    assert.equal(statuses.length, new Set(statuses).size);
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
          Storage.updateNote(note);
          self.Storage.trashNote(note.id);
          (typeof window !== 'undefined' ? window : self).Storage.emptyTrash();
          this.storage.setSetting('theme', 'dark');
          appStorage().createNote('x');
          this._getStorage().saveElement({});
          const storage = this.storage;
          storage.archiveNote(note.id);
          const { storage: db } = this;
          db.restoreNote(note.id);
          Storage.transaction(['canvases'], 'readwrite');
          Storage.getStore('canvases', 'readwrite');
          Storage.getNote(note.id);
          Storage.getSetting('theme');
          Storage.transaction('canvases');
          this.notesManager.archiveNote(note.id);
        }
      }`);
    assert.deepEqual(problems, []);
    assert.deepEqual(calls, ['updateNote', 'trashNote', 'emptyTrash', 'setSetting theme', 'createNote', 'saveElement',
      'archiveNote', 'restoreNote', 'transaction canvases', 'getStore canvases']);
  });

  it('shows the receiver it resolved, never a local name', () => {
    const { hits } = ops(`
      function editorStorage() { return globalThis.Storage; }
      class A {
        run(note) {
          const db = this.storage;
          db.archiveNote(note.id);
          editorStorage().saveNoteWithBlocks(note, []);
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
      'this.storage.archiveNote(…)',
      'Storage.saveNoteWithBlocks(…)',
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

  it('lists the fields an update sets', () => {
    const { hits } = ops(`
      class S {
        rename(folder, name) { folder.name = name; this.storage.updateFolder(folder); }
        pin(note) { note.pinned = !note.pinned; note.updatedAt = Date.now(); this.storage.updateNote(note); }
        insights(found) { this.noteData.insights = found; Storage.updateNote(this.noteData); }
      }`);
    assert.deepEqual(hits.map(h => h.call), [
      'this.storage.updateFolder({name})',
      'this.storage.updateNote({pinned, updatedAt})',
      'Storage.updateNote({insights})',
    ]);
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
          async function helper() { await Storage.emptyTrash(); }
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
      'Storage kept on another property': 'class A { constructor() { this.db = Storage; } f(n) { this.db.updateNote(n); } }',
      'Storage passed as a parameter': 'function f(storage, n) { storage.updateNote(n); }',
      'the opener window': 'function f(n) { window.opener.Storage.updateNote(n); }',
      'a dependency bag': 'class A { f(n) { this.deps.storage.updateNote(n); } }',
      'a ternary alias': 'function f(n, other) { const s = n ? Storage : other; s.updateNote(n); }',
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
          this.archiveNote(id);
          this.notesManager.archiveNote(id);
          this.sidebarController.emptyTrash();
          this.searchEngine.updateNote(id);
          LLM.init();
        }
      }
      const storage = new PopupStorage();
      storage.createNote('Quick');`);
    assert.deepEqual(problems, []);
    assert.deepEqual(calls, []);
  });

  it('reports a Storage method DatabaseManager lacks, one it has but nobody classified, and one handed on uncalled', () => {
    const { calls, problems } = ops(`
      Storage.saveEverything();
      Storage.newThing();
      const save = Storage.updateNote;
      if (typeof Storage.importAll === 'function') Storage.importAll(data);
    `, 'js/x.js', { members: new Set(['newThing', 'updateNote']) });
    assert.deepEqual(calls, ['importAll']);
    assert.equal(problems.length, 3);
    assert.match(problems[0], /saveEverything, which DatabaseManager doesn't define/);
    assert.match(problems[1], /DatabaseManager\.newThing isn't in WRITES or READS/);
    assert.match(problems[2], /passes Storage\.updateNote on without calling it/);
  });

  it('names the method each call sits in, and what an anonymous function is for', () => {
    const { hits } = ops(`
      let ready = Storage.init();
      async function capture() { await Storage.saveElement({}); }
      class SidebarController {
        bind() {
          button.addEventListener('click', async () => { await this.storage.createFolder('x'); });
          this.panel.onResizeEnd = (w) => this.storage.setSetting('sidebarWidth', w);
          const items = [{ label: 'Rename', action: async () => { await this.storage.updateFolder(f); } }];
          chrome.runtime.onInstalled.addListener(() => Storage.init());
          [1].forEach(() => Storage.emptyTrash());
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
    const pin = classify(hit({ method: 'SidebarController.toggleNotePin', op: 'updateNote', fields: ['pinned'] }));
    assert.deepEqual([pin.command, pin.status], ['setPinned', 'kernel command, slice 4']);
    const key = classify(hit({ file: 'js/llm.js', method: 'LLMService.setApiKey', op: 'setSetting', key: 'llmApiKey' }));
    assert.deepEqual([key.command, key.status], ['saveProviderSettings', 'ledgered to #11']);
  });

  it('matches folder writes on the fields they set, not on menu text', () => {
    const write = (fields) => classify(hit({ method: 'SidebarController.showFolderContextMenu > action', op: 'updateFolder', fields })).command;
    assert.equal(write(['name']), 'renameFolder');
    assert.equal(write(['parentId']), 'moveFolder');
    assert.equal(write(['collapsed']), 'setFolderCollapsed');
  });

  it('leaves a new call in a method-scoped rule unclassified', () => {
    assert.equal(classify(hit({ file: 'js/controllers/tab-controller.js', method: 'TabController.saveTabs', op: 'updateNote' })).command, null);
    assert.notEqual(classify(hit({ file: 'js/editor.js', method: 'BlockEditor._afterSaveWrite', op: 'setSetting', key: 'theme' })).command, 'saveNoteContent');
  });

  it('ledgers every write in a ledgered file to its issue', () => {
    const created = classify(hit({ file: 'js/services/sync-service.js', method: 'SyncService.x', op: 'createNote' }));
    assert.equal(created.status, 'ledgered to #19');
  });

  it('leaves a call no rule covers unclassified', () => {
    assert.equal(classify(hit({ op: 'saveMedia' })).command, null);
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
  archiveNote(id) {
    return Storage.archiveNote(id);
  }
}
window.App = App;
`,
    });
    assert.deepEqual(rows, [
      "App.toggleSidebar | Storage.setSetting('sidebarWidth', …) | setPreferences | kernel command, slice 6",
      'App.archiveNote | Storage.archiveNote(…) | archiveNote | no live caller',
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
  toggleNotePin(note) {
    note.pinned = !note.pinned;
    this.storage.updateNote(note);${extra}
  }
}
new SidebarController().toggleNotePin(n);
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
  showFolderContextMenu(folder) {
    const items = [{ label: '${label}', action: async () => {
      folder.name = 'x';
      const ${local} = this.storage;
      await ${local}.updateFolder(folder);
    } }];
    return items;
  }
}
new SidebarController().showFolderContextMenu(f);
`;
    withRepo({ 'js/sidebar.js': menu('Rename', 'db') }, (root) => {
      assert.equal(main(['--write'], { root, ...quiet }), 0);
      fs.writeFileSync(path.join(root, 'js/sidebar.js'), menu('Rename folder', 'folders'));
      assert.deepEqual(check(root), []);
    });
  });

  it('fails when a write path is added or removed without rewriting the doc', () => {
    withRepo({ 'js/sidebar.js': source() }, (root) => {
      main(['--write'], { root, ...quiet });
      fs.writeFileSync(path.join(root, 'js/sidebar.js'), source('\n    this.storage.archiveNote(note.id);'));
      assert.match(check(root).join('\n'), /missing from docs\/architecture\/write-paths\.md: .*archiveNote/);
      assert.equal(main([], { root, ...quiet }), 1);
      fs.writeFileSync(path.join(root, 'js/sidebar.js'), 'class SidebarController {}\n');
      assert.match(check(root).join('\n'), /in docs\/architecture\/write-paths\.md but not in the code: .*updateNote/);
    });
  });

  it('refuses to write or pass a call no rule covers', () => {
    withRepo({ 'js/sidebar.js': source('\n    this.storage.saveMedia(id, note.id, blob, type);') }, (root) => {
      assert.equal(main(['--write'], { root, ...quiet }), 1);
      assert.ok(!fs.existsSync(path.join(root, DOC)));
      assert.match(check(root).join('\n'), /saveMedia\(…\) has no rule/);
    });
  });

  it('skips js/storage.js, js/lib/, and js/kernel/', () => {
    withRepo({
      'js/storage.js': 'Storage.updateNote(n);',
      'js/lib/vendor.js': 'Storage.updateNote(n);',
      'js/kernel/adapters/legacy/notes.js': 'Storage.updateNote(n);',
    }, (root) => {
      assert.equal(main(['--write'], { root, ...quiet }), 0);
      assert.match(fs.readFileSync(path.join(root, DOC), 'utf8'), /\| Total \| 0 \|/);
    });
  });
});
