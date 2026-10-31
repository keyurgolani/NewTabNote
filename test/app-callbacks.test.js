'use strict';

// #12 slice 7c (Q7): the fifteen callbacks through which a controller asks App to run a note
// command stay as UI glue until #3's workspace shell wires the controllers itself. Each has a
// ledger row of its own (docs/architecture/kernel-ledger.json, owned by #3), and none reads or
// writes App's state: each calls one of App's methods, which reach only the controller or the
// kernel client that runs the command, never a copy App keeps of the lists, the tabs, or a note.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLegacyEnv, FakeDocument } = require('./helpers/legacy-env');

const ROOT = path.join(__dirname, '..');
const FILE = { name: 'Recipe.md' };

// Each callback, what it's called with, and the calls it makes on what App holds
const ROUTING = [
  ['sidebarController.onArchiveNote', 'n1', ['notesManager.archiveNote("n1")']],
  ['sidebarController.onUnarchiveNote', 'n1', ['notesManager.unarchiveNote("n1")']],
  ['sidebarController.onTrashNote', 'n1', ['notesManager.trashNoteById("n1")']],
  ['sidebarController.onRestoreNote', 'n1', ['notesManager.restoreNoteById("n1")']],
  ['sidebarController.onPermanentlyDeleteNote', 'n1', ['notesManager.permanentlyDeleteNoteById("n1")']],
  ['sidebarController.onGenerateTitle', 'n1', ['notesManager.generateTitleForNote("n1")']],
  ['sidebarController.onExportNote', 'n1', ['notesManager.exportNoteById("n1")']],
  ['sidebarController.onExtractInsights', 'n1', ['notesManager.extractInsightsForNote("n1")']],
  ['sidebarController.onConvertNoteToTemplate', 'n1', ['notesManager.convertNoteToTemplate("n1")']],
  ['sidebarController.onConvertTemplateToNote', 'n1', ['notesManager.convertTemplateToNote("n1")']],
  ['sidebarController.onImportNote', FILE, ['notesManager.importNote({"name":"Recipe.md"})']],
  ['tabController.onCreateNote', undefined, [
    'documentClient.newId()',
    'documentClient.createNote({"noteId":"new-1","name":"Untitled"})',
  ]],
  ['aiChatController.onEnsureDailyNote', undefined, ['documentClient.ensureDailyNote()', 'noteList.settled()']],
  ['shortcutsManager.onEnsureDailyNote', undefined, ['documentClient.ensureDailyNote()', 'noteList.settled()']],
  ['notesManager.onCreateFirstNote', undefined, [
    'documentClient.newId()',
    'documentClient.createNote({"name":"Untitled","noteId":"new-1"})',
    'noteList.settled()',
    'tabController.openNoteInNewTab("new-1")',
  ]],
];

// What App holds that isn't its state: the controllers and the tab's kernel clients
const CONTROLLERS = {
  SidebarController: 'sidebarController',
  TabController: 'tabController',
  AIChatController: 'aiChatController',
  SettingsController: 'settingsController',
  ThemeBuilderController: 'themeBuilderController',
  AnalyticsController: 'analyticsController',
  NotesManager: 'notesManager',
  ShortcutsManager: 'shortcutsManager',
  ExportImportService: 'exportImportService',
};
const CLIENTS = ['kernel', 'documentClient', 'settings', 'ai', 'noteList', 'removal', 'events'];
const HANDLES = new Set([...Object.values(CONTROLLERS), ...CLIENTS]);

/**
 * A stand-in for something App holds, which keeps what's set on it and records each call to
 * anything else as `name.method(args)`, answering with `results[method]` where there's one
 */
function recorder(name, calls, results = {}) {
  return new Proxy({}, {
    get(target, prop) {
      if (Object.hasOwn(target, prop)) return target[prop];
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (...args) => {
        calls.push(`${name}.${prop}(${args.map(arg => JSON.stringify(arg)).join(', ')})`);
        return Object.hasOwn(results, prop) ? results[prop](...args) : undefined;
      };
    },
  });
}

/**
 * App as js/app.js has it, with stand-ins for its controllers and kernel clients, wired by
 * buildControllers through a proxy that, once `watch` runs a callback, records each property
 * of App read or written
 */
function wiredApp() {
  const env = createLegacyEnv({ document: new FakeDocument() });
  env.document.stub(['page-title']);
  env.load('js/app.js');
  const calls = [];
  for (const [constructor, name] of Object.entries(CONTROLLERS)) {
    env.global[constructor] = function Controller() { return recorder(name, calls); };
  }
  env.global.SearchEngine = function SearchEngine() { return recorder('searchEngine', calls); };
  env.global.LLM = recorder('LLM', calls);
  const App = env.get('App');
  const clients = Object.fromEntries(CLIENTS.map(name => [name, recorder(name, calls)]));
  clients.documentClient = recorder('documentClient', calls, {
    newId: () => 'new-1',
    createNote: async () => ({ kind: 'committed' }),
    ensureDailyNote: async () => ({ outcome: { kind: 'committed' }, note: { id: 'daily' } }),
  });
  // The lists' views answer, so a callback that reads App's notes is caught by what it read
  clients.noteList = recorder('noteList', calls, { settled: async () => {}, view: () => [] });
  const app = new App(clients);

  let seen = null;
  const watched = new Proxy(app, {
    get(target, prop, receiver) {
      if (seen && typeof prop === 'string') seen.reads.push(prop);
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value) {
      if (seen && typeof prop === 'string') seen.writes.push(prop);
      target[prop] = value;
      return true;
    },
  });
  App.prototype.buildControllers.call(watched);
  const methods = new Set(Object.getOwnPropertyNames(App.prototype)
    .filter(name => name !== 'constructor' && typeof Object.getOwnPropertyDescriptor(App.prototype, name).value === 'function'));

  /** Run `fn`, and say what of App it read and wrote, and what it called */
  const watch = async (fn) => {
    calls.length = 0;
    seen = { reads: [], writes: [] };
    try {
      await fn();
      return { ...seen, calls: [...calls] };
    } finally {
      seen = null;
    }
  };
  return { app, methods, watch };
}

describe("App's command-routing callbacks (#12 slice 7c, Q7)", () => {
  for (const [name, argument, expected] of ROUTING) {
    it(`${name} calls one of App's methods, which reads none of App's state and writes nothing on it`, async () => {
      const { app, methods, watch } = wiredApp();
      const [controller, property] = name.split('.');
      const callback = app[controller][property];
      assert.equal(typeof callback, 'function', `App sets ${name}`);

      const { reads, writes, calls } = await watch(() => callback(argument));
      assert.deepEqual(writes, [], `${name} wrote App's ${writes.join(', ')}`);
      const state = reads.filter(read => !methods.has(read) && !HANDLES.has(read));
      assert.deepEqual(state, [], `${name} read App's ${state.join(', ')}`);
      assert.deepEqual(calls, expected);
    });
  }

  it('each has a ledger row of its own, owned by #3, and no other callback has one', () => {
    const { rows } = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/architecture/kernel-ledger.json'), 'utf8'));
    const named = rows.filter(row => row.file === 'js/app.js' && row.rule === 'app-callback' && row.name !== undefined);
    assert.deepEqual(named.map(row => row.name).sort(), ROUTING.map(([name]) => name).sort());
    for (const row of named) assert.deepEqual([row.count, row.owner], [1, 3], row.name);
  });
});
