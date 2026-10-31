#!/usr/bin/env node

/**
 * Write-path map for #12 (application kernel). docs/architecture/write-paths.md lists every
 * mutating persistence call outside js/storage.js, the intent-level kernel command it
 * becomes, and when.
 *
 * A mutating persistence call is, in js/ outside js/lib/, js/kernel/, and js/storage.js:
 * - a DatabaseManager method that writes (WRITES, or UNDEFINED_WRITES for the ones callers
 *   use that it doesn't define), called on the Storage global (bare, or through self,
 *   window, or globalThis), on this.storage, on a function or method that returns one of
 *   those (appStorage(), editorStorage(), this._getStorage()), or on a local bound to one;
 * - an add, put, delete, or clear on an object store, from an IndexedDB transaction or
 *   Storage.getStore(), and a readwrite transaction or getStore() whose own stores write
 *   nothing, which counts once by itself;
 * - a chrome.storage write: `<chrome>.storage.<area>.set|remove|clear(...)`, or the same on
 *   a const bound to `<chrome>.storage.<area>`;
 * - update or delete on a cursor, indexedDB.deleteDatabase, or indexedDB.open with a version;
 * - a Web Storage write: localStorage or sessionStorage setItem, removeItem, or clear.
 *
 * Anything it can only see part of fails as a problem: a transaction or getStore() mode
 * that isn't a literal, a DatabaseManager write name called on a receiver it can't place,
 * and an object store or chrome.storage area bound with anything but const.
 *
 * RULES give each call its command, and COMMANDS give each command the #12 slice or the PR
 * that routes it, or the issue it's ledgered to. A call no rule matches fails the check, so a
 * new write path can't land without a decision. A rule can give its calls a status of its own:
 * "no live path" for calls on a handle that has no such method (#17 PR 4b). One status comes
 * from the code instead: "no live caller" for writes in methods nothing refers to, App's
 * included, since #12 slice 7 deleted App's copies of controller paths.
 *
 *   npm run check:write-paths              fail when the doc and the code differ, line numbers aside
 *   npm run check:write-paths -- --write   rewrite the doc
 *
 * test/write-paths.test.js runs the check, so `npm test` fails when a write path is added,
 * removed, moved to another function, or reclassified until the doc is rewritten. Line
 * numbers are where the calls were when the doc was written, and rewriting refreshes them.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT_DIR = path.join(__dirname, '..');
const DOC = 'docs/architecture/write-paths.md';
const SKIP_DIRS = ['js/lib', 'js/kernel'];
const SKIP_FILES = ['js/storage.js'];
const WRITE_COMMAND = 'npm run check:write-paths -- --write';

/**
 * DatabaseManager methods that write to IndexedDB or chrome.storage.local. Each is one
 * DatabaseManager defines, as READS' are (collect() holds both to js/storage.js): #17 PR 4a
 * deleted the writers nothing called once the new tab wrote through #17's adapter.
 */
const WRITES = new Set([
  'init', 'checkAndRepairDatabase', 'initializeDefaultSettings',
  '_writeMissingStoresCopy', '_writeMissingStoresCopyIfNone', '_writeRecoveryBackup', 'createAutoBackup',
  'createNote', 'updateNote',
  'archiveNote', 'unarchiveNote', 'trashNote', 'permanentlyDeleteNote',
  'setSearchIndex', 'setSearchIndexEntry', 'removeSearchIndexEntry', 'updateNoteNameInSearchIndex',
  'createFolder', 'deleteFolder',
  'saveElement', 'deleteElements', 'deleteElementsByNote',
  'deleteMediaByNote',
  'setSetting',
  'importData', '_commitImport', '_writeImport',
  'saveVector',
  'deleteSnapshotsByNote',
]);

/** DatabaseManager methods that open a transaction, which writes only in 'readwrite' mode */
const MODE_WRITES = new Set(['transaction', 'getStore']);

/** DatabaseManager methods that only read */
const READS = new Set([
  'constructor', '_chromeApi', '_codedError', 'hasStore', '_sleep', 'withRetry', '_newerSchemaError',
  '_throwIfCoreStoresMissing', '_openUnversioned', '_readOnDiskVersion', 'isPageContext',
  '_readStoreForCopy', '_blobsToDataUrls', '_hasBlob', '_blobToDataUrl', 'getAutoBackups',
  '_getAutoBackupKeys', '_getStorageValue', '_getAllNoteIds', 'validateDatabase', '_getAllKeys', '_countOrphanIndexKeys',
  '_readAux', 'getTodayNote', 'getAllNotes', 'getNoteNames', 'getArchivedNotes', 'getTemplates', 'getSearchIndex',
  'isNoteEmpty', 'isNoteUntitled', 'isEmptyTextBlock', 'getTrashedNotes', 'getElements', 'getNote',
  'getAllFolders', 'getFolder', 'getBacklinks', 'getElementsByNote', 'getMedia', 'getSetting',
  'readSetting', 'getAllSettings', 'exportAll', 'exportAllAsBlob', '_readExport', '_exportMediaRow',
  '_getAllMedia', 'validateImport', '_dataUrlToBlob', 'getCustomThemes', 'getVector', 'getAllVectors',
  'getSnapshots',
]);

/**
 * Write methods callers use that DatabaseManager doesn't define, and why they're listed.
 * Any other undefined method on Storage fails the check.
 */
const UNDEFINED_WRITES = {
  importNote: "sync-service's remote-only merge calls it, so that path throws today (#19)",
  importAll: "sync-service's remote apply checks for it first, so that path never runs (#19)",
};

/**
 * Reads a holder's handle answers that DatabaseManager doesn't define: the facade's queries
 * (js/kernel/composition/storage-facade.js), until js/storage.js is the facade's shell (#17 PR 4b)
 */
const HANDLE_READS = {
  listLinks: "GraphView's links, the listLinks query",
};

/** Write names too common to flag on receivers the scanner can't place */
const GENERIC_WRITE_NAMES = new Set(['init']);

/**
 * App's components: a write-named call on `this.<component>` is that component's own method.
 * `documentClient` is the editors' document client (js/kernel/composition/document.js), and
 * `settings` the page's settings port (js/kernel/composition/settings.js), whose writes are
 * kernel commands, so nothing either calls is a Storage write.
 */
const COMPONENTS = new Set([
  'sidebarController', 'tabController', 'aiChatController', 'settingsController', 'themeBuilderController',
  'analyticsController', 'notesManager', 'shortcutsManager', 'exportImportService', 'syncService', 'graphView', 'domRefs',
  'documentClient', 'settings',
]);

/** Files whose every write stays outside the kernel for an issue ("Allowed at close") */
const LEDGERED_FILES = { 'js/llm.js': 11, 'js/services/sync-service.js': 19, 'js/ui/graph-view.js': 22 };

const CHROME_AREAS = new Set(['local', 'sync', 'session', 'managed']);
const CHROME_WRITES = new Set(['set', 'remove', 'clear']);
const STORE_WRITES = new Set(['add', 'put', 'delete', 'clear']);
const CURSOR_WRITES = new Set(['update', 'delete']);
const WEB_STORAGE_WRITES = new Set(['setItem', 'removeItem', 'clear']);

/**
 * The commands, from #12's catalog or named here for an intent it doesn't list, each with
 * the #12 slice that routes its calls through the kernel, or the issue it's ledgered to
 * under "Allowed at close".
 */
const COMMANDS = {
  // Slice 4: notes and blocks
  runStartupMaintenance: { slice: 4 },
  // An imported note is a new note with its first blocks (#12 slice 4c2), so createNote takes import's rows
  createNote: { slice: 4 },
  ensureDailyNote: { slice: 4 },
  captureToDailyNote: { slice: 4 },
  saveNoteContent: { slice: 4 },
  insertBlocks: { slice: 4 },
  deleteBlocks: { slice: 4 },
  saveSnapshot: { slice: 4 },
  restoreSnapshot: { slice: 4 },
  renameNote: { slice: 4 },
  setPinned: { slice: 4 },
  archiveNote: { slice: 4 },
  unarchiveNote: { slice: 4 },
  applyDerivedTitle: { slice: 4 },
  attachInsights: { slice: 4 },
  setInsightsPending: { slice: 4 },
  recordJobRun: { slice: 4 },
  // Slice 5: folders, templates, trash
  createFolder: { slice: 5 },
  renameFolder: { slice: 5 },
  moveFolder: { slice: 5 },
  setFolderCollapsed: { slice: 5 },
  deleteFolder: { slice: 5 },
  moveNoteToFolder: { slice: 5 },
  convertNoteToTemplate: { slice: 5 },
  convertTemplateToNote: { slice: 5 },
  trashNote: { slice: 5 },
  restoreNote: { slice: 5 },
  deleteNotePermanently: { slice: 5 },
  emptyTrash: { slice: 5 },
  runTrashCleanup: { slice: 5 },
  runBulkAction: { slice: 5 },
  // Slice 6: preferences and session
  setPreferences: { slice: 6 },
  saveWorkspaceSession: { slice: 6 },
  saveChatHistory: { slice: 6 },
  savePromptTemplates: { slice: 6 },
  saveTheme: { slice: 6 },
  completeOnboarding: { slice: 6 },
  recordBackup: { slice: 6 },
  recordExportNotice: { slice: 6 },
  snoozeSpaceNotice: { slice: 6 },
  createAutoBackup: { slice: 6 },
  importBackup: { slice: 6 },
  // #22's derived writes, which the search index handle runs as commands (#17 PR 4b's facade)
  updateSearchIndex: { pr: '#17 PR 4b' },
  saveVector: { pr: '#17 PR 4b' },
  // Left outside the kernel for their own issues
  saveProviderSettings: { ledger: 11 },
  saveSyncSettings: { ledger: 19 },
  applyRemoteChanges: { ledger: 19 },
};

/** Settings that are preferences, which the kernel's settings port owns (#25 owns their schemas) */
const PREFERENCE_KEYS = [
  'theme', 'font', 'width', 'trashRetention', 'dailyNoteTemplate', 'autoBackupEnabled', 'autoBackupFrequency',
  'sidebarOpen', 'sidebarSortMode', 'sidebarWidth', 'sidebarViewMode', 'aiSidebarWidth',
  'autoTitleEnabled', 'autoTitleInterval', 'insightsEnabled', 'insightsInterval', 'embeddingsEnabled',
];
/** The workspace session #12's state ownership table gives TabController */
const SESSION_KEYS = ['openTabs', 'activeTabIndex', 'splitViewEnabled', 'secondaryNoteId', 'lastOpenedNoteId'];
const CHAT_KEYS = ['aiChatHistory', 'noteChatMessages', 'globalChatHistory', 'globalChatMessages'];
const PROVIDER_KEYS = ['llmEndpoint', 'llmProvider', 'llmApiKey', 'llmApiKeyProvider', 'llmModel', 'ollamaUrl'];
const SYNC_KEYS = ['syncProvider', 'syncWebdavConfig', 'syncLastSyncAt'];

/**
 * Which command each call becomes: the first rule whose fields all match. `file` and
 * `method` are exact or a RegExp on the File and Method cells, `op` is the method called
 * (exact or a list), `key` the setting key, chrome.storage key, or object store (exact, a
 * list, or a RegExp), and `fields` a field the call's update sets. A rule that names a file
 * or a method also names its ops, so a new call there fails until it's classified.
 */
const RULES = [
  // A new note and its first blocks are one intent, an imported one's included
  { command: 'createNote', method: /\.(runOnboarding|createNoteFromAIResponse|_createNoteFromBlock|importNote)$/, op: ['createNote', 'saveElement'] },
  { command: 'createNote', op: 'createNote' },
  { command: 'convertNoteToTemplate', method: /\.convertNoteToTemplate$/, op: 'updateNote' },
  { command: 'convertTemplateToNote', method: /\.convertTemplateToNote$/, op: 'updateNote' },
  // The editor's save, the links and search-index name it refreshes, and template blocks inserted as an edit
  { command: 'saveNoteContent', method: /^BlockEditor\.(_writeSaveState|_afterSaveWrite|selectTemplateItem)$/, op: ['updateNoteNameInSearchIndex', 'saveElement'] },
  { command: 'restoreSnapshot', method: 'BlockEditor._revertToSnapshot', op: ['deleteElements', 'saveElement', 'updateNote'] },
  { command: 'insertBlocks', method: /\.(appendAIResponseToNote|refreshNoteMetadataAfterInsert|_appendBlockToNote)$/, op: ['saveElement', 'updateNote'] },
  // Titles the user asked for are renames; automatic ones yield to titleManuallySet
  { command: 'renameNote', method: /\.(generateTitleForNote|applyGeneratedTitle)$/, op: 'updateNote' },
  { command: 'applyDerivedTitle', method: /\.(runAutoTitle|generateTitleForNewNote)$/, op: 'updateNote' },
  { command: 'attachInsights', op: 'updateNote', fields: 'insights' },
  { command: 'setPinned', op: 'updateNote', fields: 'pinned' },
  { command: 'moveNoteToFolder', op: 'updateNote', fields: 'folderId' },
  { command: 'deleteFolder', op: 'deleteFolder' },
  { command: 'createFolder', op: 'createFolder' },
  { command: 'archiveNote', op: 'archiveNote' },
  { command: 'unarchiveNote', op: 'unarchiveNote' },
  { command: 'trashNote', op: 'trashNote' },
  { command: 'deleteNotePermanently', op: 'permanentlyDeleteNote' },
  { command: 'recordJobRun', op: 'setSetting', key: ['lastAutoTitleRun', 'lastInsightsRun'] },
  // A running extraction, kept across reloads
  { command: 'setInsightsPending', op: 'setSetting', key: /^insightsExtracting_/ },
  { command: 'updateSearchIndex', op: ['setSearchIndex', 'setSearchIndexEntry', 'removeSearchIndexEntry'] },
  { command: 'saveVector', op: 'saveVector' },
  { command: 'saveProviderSettings', op: 'setSetting', key: PROVIDER_KEYS },
  { command: 'saveSyncSettings', op: 'setSetting', key: SYNC_KEYS },
  // Sync's handle has none of the three (js/kernel/composition/newtab.js): sync has never applied a remote note (#17 PR 4b)
  { command: 'applyRemoteChanges', file: 'js/services/sync-service.js', op: ['importNote', 'importAll', 'saveElement'], status: 'no live path' },
  { command: 'saveWorkspaceSession', op: ['setSetting', 'set'], key: SESSION_KEYS },
  { command: 'saveChatHistory', op: 'setSetting', key: CHAT_KEYS },
  { command: 'savePromptTemplates', op: 'setSetting', key: 'aiPromptTemplates' },
  { command: 'completeOnboarding', op: 'setSetting', key: 'hasCompletedOnboarding' },
  { command: 'recordBackup', op: 'setSetting', key: ['lastBackupAt', 'lastFullExportAt'] },
  // The pre-migration export notice's outcome (#18 slice 0)
  { command: 'recordExportNotice', op: 'setSetting', key: 'preMigrationNotice' },
  // The space-blocked notice's Not now and Done (#17 PR 1b)
  { command: 'snoozeSpaceNotice', op: 'setSetting', key: 'spaceNoticeSnoozedAt' },
  { command: 'createAutoBackup', op: 'createAutoBackup' },
  { command: 'importBackup', op: 'importData' },
  { command: 'setPreferences', op: 'setSetting', key: PREFERENCE_KEYS },
];

/** Each status, in the doc's order, and what it means */
const STATUSES = [
  ['kernel command, slice 4', '#12 slice 4 (notes and blocks) routes it through the command.'],
  ['kernel command, slice 5', '#12 slice 5 (folders, templates, trash) routes it through the command.'],
  ['kernel command, slice 6', '#12 slice 6 (preferences and session) routes it through the command.'],
  ['kernel command, #17 PR 4b', "#17 PR 4b's facade (`js/kernel/composition/storage-facade.js`) runs it as the command on the new tab's kernel, under the name its holder has always called."],
  ['no live caller', 'Nothing in `js/` refers to the method or function the write sits in, so the write never runs. Deleting it drops the row. The command is what the call would become.'],
  ['no live path', "The holder's handle has no such method (`js/kernel/composition/newtab.js`), so the call throws or is skipped and never writes. Sync has never applied a remote note, and its paths stay as they are until #19 wires the command."],
  ['ledgered to #11', "Provider settings and keys, which #11's provider registry takes over (#21 reviews the key rows)."],
  ['ledgered to #19', "The sync service, which #19's sync engine replaces."],
  ['ledgered to #22', "The search index and vectors, which #22's pipelines own."],
  ['UI-only', 'Persists nothing a kernel aggregate or the settings port owns.'],
];

// ─── Reading the code ───

function strip(node) {
  let n = node;
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n))) n = n.expression;
  return n;
}

function isGlobalObject(node) {
  const n = strip(node);
  if (ts.isIdentifier(n)) return ['window', 'self', 'globalThis'].includes(n.text);
  if (ts.isConditionalExpression(n)) return isGlobalObject(n.whenTrue) && isGlobalObject(n.whenFalse);
  return false;
}

function isThis(node) {
  return strip(node).kind === ts.SyntaxKind.ThisKeyword;
}

function isThisProperty(node, name) {
  const n = strip(node);
  return ts.isPropertyAccessExpression(n) && isThis(n.expression) && n.name.text === name;
}

function nearestScope(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) || ts.isSourceFile(n)) return n;
  }
  return null;
}

function isConst(decl) {
  return (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
}

function propertyName(name) {
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : '(computed)';
}

function className(node) {
  if (node.name) return node.name.text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return '(class)';
}

/** The names a file binds with const to a string literal, or to an object of string literals */
function constantsOf(sf) {
  const strings = new Map();
  const objects = new Map();
  const seen = new Map();
  (function walk(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isConst(n)) {
      const name = n.name.text;
      seen.set(name, (seen.get(name) || 0) + 1);
      const init = strip(n.initializer);
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) strings.set(name, init.text);
      if (ts.isObjectLiteralExpression(init)) {
        const props = new Map();
        for (const p of init.properties) {
          if (ts.isPropertyAssignment(p) && (ts.isStringLiteral(strip(p.initializer)) || ts.isNoSubstitutionTemplateLiteral(strip(p.initializer)))) {
            props.set(propertyName(p.name), strip(p.initializer).text);
          }
        }
        objects.set(name, props);
      }
    }
    ts.forEachChild(n, walk);
  })(sf);
  // A name declared twice could mean either value
  for (const [name, count] of seen) {
    if (count > 1) {
      strings.delete(name);
      objects.delete(name);
    }
  }
  return { strings, objects };
}

/** What an anonymous function is for, from where it sits: a variable, a property, or a listener */
function purposeOf(fn) {
  const p = fn.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p)) return propertyName(p.name);
  if (ts.isBinaryExpression(p) && p.right === fn && ts.isPropertyAccessExpression(p.left)) return p.left.name.text;
  if (ts.isCallExpression(p) && p.arguments.includes(fn) && ts.isPropertyAccessExpression(p.expression)) {
    const callee = p.expression.name.text;
    if (callee === 'addEventListener') {
      const event = strip(p.arguments[0]);
      return `${event && (ts.isStringLiteral(event) || ts.isNoSubstitutionTemplateLiteral(event)) ? event.text : '(event)'} listener`;
    }
    if (callee === 'addListener') return `${p.expression.expression.getText().replace(/^(chrome|browser)\./, '')} listener`;
  }
  return null;
}

/**
 * The Method cell and what holds the call: Class.method or the function, then what the
 * innermost anonymous or nested function around the call is for, when it says
 */
function describe(node) {
  let purpose = null;
  const label = base => (purpose ? `${base} > ${purpose}` : base);
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isConstructorDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) {
      const name = ts.isConstructorDeclaration(n) ? 'constructor' : propertyName(n.name);
      if (ts.isClassLike(n.parent)) {
        const owner = className(n.parent);
        return { method: label(`${owner}.${name}`), holder: { kind: ts.isMethodDeclaration(n) ? 'method' : 'other', name, owner, node: n } };
      }
      purpose = purpose || name;
      continue;
    }
    if (ts.isFunctionDeclaration(n) && n.name) {
      if (ts.isSourceFile(nearestScope(n))) return { method: label(n.name.text), holder: { kind: 'function', name: n.name.text, node: n } };
      purpose = purpose || n.name.text;
      continue;
    }
    if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
      const what = purposeOf(n);
      if (what && ts.isVariableDeclaration(n.parent) && ts.isSourceFile(nearestScope(n.parent))) {
        return { method: label(what), holder: { kind: 'function', name: what, node: n.parent } };
      }
      purpose = purpose || what;
    }
  }
  return { method: label('(top level)'), holder: { kind: 'top' } };
}

// ─── Scanning ───

/**
 * Scan one file's source for mutating persistence calls. Returns { hits, problems }: each
 * hit is { file, line, method, kind, op, key, fields, call, holder }, and each problem a
 * string. `members` (DatabaseManager's method names) sharpens the message for a method
 * nobody classified.
 */
function scanSource(file, text, { members = null } = {}) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const lineOf = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const hits = [];
  const problems = [];
  const problem = (node, message) => problems.push(`${file}:${lineOf(node)} ${message}`);
  const constants = constantsOf(sf);

  /** A string an expression always has: a literal, or a const bound to one */
  function constantString(node) {
    const n = node && strip(node);
    if (!n) return null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isIdentifier(n)) return constants.strings.get(n.text) ?? null;
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      const props = constants.objects.get(n.expression.text);
      return (props && props.get(n.name.text)) ?? null;
    }
    return null;
  }

  /** A setting key as written: a constant, a template with ${…} for its expressions, or (computed) */
  function keyText(node) {
    const n = node && strip(node);
    if (n && ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map(s => `\${…}${s.literal.text}`).join('');
    return constantString(n) ?? '(computed)';
  }

  /** The keys an object literal, a string, or a string array names, or null */
  function keysOf(node) {
    const n = node && strip(node);
    if (!n) return null;
    if (ts.isObjectLiteralExpression(n)) return n.properties.map(p => (p.name ? propertyName(p.name) : '…')).join(', ');
    if (ts.isArrayLiteralExpression(n)) return n.elements.map(e => constantString(e) || '…').join(', ');
    return constantString(n);
  }

  const accessorFunctions = new Map(); // name -> root
  const accessorMethods = new Map();
  const storageAliases = new Map(); // scope -> Map(name, root)
  const storeAliases = new Map(); // scope -> Map(name, {store, root, tx})
  const areaAliases = new Map(); // scope -> Map(name, area)
  const txAliases = new Map(); // scope -> Map(name, transaction call)
  const cursorAliases = new Map(); // scope -> Map(name, true)
  const newLocals = new Map(); // scope -> Map(name, true)
  const newProps = new Set(); // this.<name> = new X()

  const lookup = (map, node, name) => {
    for (let scope = nearestScope(node); scope; scope = nearestScope(scope)) {
      const names = map.get(scope);
      if (names && names.has(name)) return names.get(name);
      if (ts.isSourceFile(scope)) break;
    }
    return undefined;
  };
  const bind = (map, decl, name, value) => {
    const scope = nearestScope(decl);
    if (!map.has(scope)) map.set(scope, new Map());
    map.get(scope).set(name, value);
  };

  /** 'Storage' or 'this.storage' when an expression is the DatabaseManager, else null */
  function storageRoot(node) {
    const n = strip(node);
    if (!n) return null;
    if (ts.isIdentifier(n)) return n.text === 'Storage' ? 'Storage' : (lookup(storageAliases, n, n.text) || null);
    if (ts.isPropertyAccessExpression(n)) {
      if (n.name.text === 'Storage' && isGlobalObject(n.expression)) return 'Storage';
      return isThisProperty(n, 'storage') ? 'this.storage' : null;
    }
    if (ts.isCallExpression(n) && n.arguments.length === 0) {
      const callee = strip(n.expression);
      if (ts.isIdentifier(callee)) return accessorFunctions.get(callee.text) || null;
      if (ts.isPropertyAccessExpression(callee) && isThis(callee.expression)) return accessorMethods.get(callee.name.text) || null;
    }
    return null;
  }

  function returnedRoot(fn) {
    if (!fn.body) return null;
    if (!ts.isBlock(fn.body)) return storageRoot(fn.body);
    const returns = [];
    (function walk(n) {
      if (n !== fn.body && ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n)) returns.push(n);
      ts.forEachChild(n, walk);
    })(fn.body);
    const roots = new Set(returns.map(r => (r.expression ? storageRoot(r.expression) : null)));
    return roots.size === 1 && !roots.has(null) ? [...roots][0] : null;
  }

  /** `<x>.storage.<area>` gives the area's name */
  function chromeArea(node) {
    const n = strip(node);
    if (ts.isPropertyAccessExpression(n) && CHROME_AREAS.has(n.name.text)) {
      const parent = strip(n.expression);
      if (ts.isPropertyAccessExpression(parent) && parent.name.text === 'storage' && !isThis(parent.expression)) return n.name.text;
    }
    if (ts.isIdentifier(n)) return lookup(areaAliases, n, n.text) || null;
    return null;
  }

  /** A transaction call: `<db>.transaction(...)` on anything, or Storage.getStore(...) */
  const isTransaction = n => ts.isCallExpression(n) && ts.isPropertyAccessExpression(strip(n.expression))
    && (strip(n.expression).name.text === 'transaction' || (strip(n.expression).name.text === 'getStore' && storageRoot(strip(n.expression).expression)));

  /** The object store an expression is, as {store, root, tx}, or null */
  function storeOf(node) {
    const n = strip(node);
    if (ts.isIdentifier(n)) return lookup(storeAliases, n, n.text) || null;
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(strip(n.expression))) return null;
    const callee = strip(n.expression);
    if (callee.name.text === 'objectStore') {
      const from = strip(callee.expression);
      let tx = null;
      if (ts.isIdentifier(from)) tx = lookup(txAliases, from, from.text) || null;
      else if (isTransaction(from)) tx = from;
      const root = tx ? storageRoot(strip(tx.expression).expression) : null;
      return { store: constantString(n.arguments[0]) || '(store)', root, tx };
    }
    if (callee.name.text === 'getStore' && storageRoot(callee.expression)) {
      return { store: constantString(n.arguments[0]) || '(store)', root: storageRoot(callee.expression), tx: n };
    }
    return null;
  }

  // Settle accessors and aliases first: each can come from the other
  let changed = true;
  while (changed) {
    changed = false;
    (function walk(n) {
      if ((ts.isFunctionDeclaration(n) && n.name) || (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name))) {
        const map = ts.isFunctionDeclaration(n) ? accessorFunctions : accessorMethods;
        const root = !map.has(n.name.text) && returnedRoot(n);
        if (root) {
          map.set(n.name.text, root);
          changed = true;
        }
      }
      if (ts.isVariableDeclaration(n) && n.initializer) {
        if (ts.isIdentifier(n.name) && lookup(storageAliases, n, n.name.text) === undefined) {
          const root = storageRoot(n.initializer);
          if (root) {
            bind(storageAliases, n, n.name.text, root);
            changed = true;
          }
        }
        // const { storage } = this;
        if (ts.isObjectBindingPattern(n.name) && isThis(n.initializer)) {
          for (const el of n.name.elements) {
            const from = el.propertyName ? propertyName(el.propertyName) : ts.isIdentifier(el.name) ? el.name.text : null;
            if (from === 'storage' && ts.isIdentifier(el.name) && lookup(storageAliases, el, el.name.text) === undefined) {
              bind(storageAliases, el, el.name.text, 'this.storage');
              changed = true;
            }
          }
        }
      }
      ts.forEachChild(n, walk);
    })(sf);
  }

  // Transactions, stores, chrome.storage areas, cursors, and objects made with new
  (function walk(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = strip(n.initializer);
      const name = n.name.text;
      if (isTransaction(init)) bind(txAliases, n, name, init);
      if (ts.isNewExpression(init)) bind(newLocals, n, name, true);
      if (ts.isPropertyAccessExpression(init) && init.name.text === 'result' && /cursor/i.test(name)) bind(cursorAliases, n, name, true);
      const store = storeOf(init);
      const area = chromeArea(init);
      if ((store || area) && !isConst(n)) problem(n, `binds ${store ? 'an object store' : 'a chrome.storage area'} to ${name} with let or var, so its writes can't be traced: use const`);
      else if (store) bind(storeAliases, n, name, store);
      else if (area) bind(areaAliases, n, name, area);
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const right = strip(n.right);
      if (ts.isPropertyAccessExpression(n.left) && isThis(n.left.expression) && ts.isNewExpression(right)) newProps.add(n.left.name.text);
      if (storeOf(right) || chromeArea(right)) problem(n, `assigns ${storeOf(right) ? 'an object store' : 'a chrome.storage area'} to ${n.left.getText(sf)}, so its writes can't be traced: bind it with const`);
    }
    ts.forEachChild(n, walk);
  })(sf);

  /** Whether a write-named call's receiver is something other than Storage the scanner knows */
  function knownOther(node) {
    const n = strip(node);
    if (isThis(n)) return true;
    if (ts.isPropertyAccessExpression(n) && isThis(n.expression)) return COMPONENTS.has(n.name.text) || newProps.has(n.name.text);
    if (ts.isIdentifier(n)) return lookup(newLocals, n, n.text) === true;
    return false;
  }

  /** The fields an update call's record has set on it in the same function before the call */
  function fieldsSet(call) {
    const arg = call.arguments[0] && strip(call.arguments[0]);
    if (!arg || !(ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg))) return [];
    const target = arg.getText(sf);
    const scope = nearestScope(call);
    const fields = new Set();
    (function walk(n) {
      if (n !== scope && ts.isFunctionLike(n)) return;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        && ts.isPropertyAccessExpression(n.left) && strip(n.left.expression).getText(sf) === target && n.end <= call.getStart(sf)) {
        fields.add(n.left.name.text);
      }
      ts.forEachChild(n, walk);
    })(scope);
    return [...fields].sort();
  }

  const add = (node, fields) => {
    const { method, holder } = describe(node);
    const hit = { file, line: lineOf(node), method, fields: [], ...fields, holder };
    hits.push(hit);
    return hit;
  };

  // Every transaction first: a store write in a chain is visited before its transaction
  const transactions = new Map(); // call -> { readwrite, root, written }
  (function walk(n) {
    if (isTransaction(n)) {
      const callee = strip(n.expression);
      const mode = n.arguments[1];
      if (mode && constantString(mode) === null) {
        problem(n, `opens ${callee.name.text}() with a mode that isn't a literal, so whether it writes can't be told`);
      } else {
        transactions.set(n, { readwrite: constantString(mode) === 'readwrite', root: storageRoot(callee.expression), written: false });
      }
    }
    ts.forEachChild(n, walk);
  })(sf);

  (function walk(n) {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(strip(n.expression))) {
      const callee = strip(n.expression);
      const op = callee.name.text;
      const receiver = strip(callee.expression);
      const args = n.arguments;
      const root = storageRoot(receiver);

      if (MODE_WRITES.has(op) && (op === 'transaction' || root)) {
        // The pass above counts transactions
      } else if (root) {
        const shown = (args.length > 0 ? '…' : '');
        if (Object.hasOwn(HANDLE_READS, op)) {
          // A read, which the facade answers on the holder's handle
        } else if (members && !members.has(op) && !Object.hasOwn(UNDEFINED_WRITES, op)) {
          // Whatever the lists say: they named the writers #17 PR 4a deleted until R88's read
          problem(n, `calls ${root}.${op}, which DatabaseManager doesn't define: fix the call, or list it in UNDEFINED_WRITES`);
        } else if (WRITES.has(op) || Object.hasOwn(UNDEFINED_WRITES, op)) {
          if (op === 'setSetting') {
            const key = keyText(args[0]);
            add(n, { kind: 'storage', op, key, call: `${root}.setSetting('${key}'${args.length > 1 ? ', …' : ''})` });
          } else if (op === 'updateNote') {
            const fields = fieldsSet(n);
            add(n, { kind: 'storage', op, key: null, fields, call: `${root}.${op}(${fields.length > 0 ? `{${fields.join(', ')}}` : shown})` });
          } else {
            add(n, { kind: 'storage', op, key: null, call: `${root}.${op}(${shown})` });
          }
        } else if (!READS.has(op)) {
          problem(n, members && members.has(op)
            ? `calls ${root}.${op}, but DatabaseManager.${op} isn't in WRITES or READS: classify it`
            : `calls ${root}.${op}, which DatabaseManager doesn't define: fix the call, or list it in UNDEFINED_WRITES`);
        }
      } else if (STORE_WRITES.has(op) && storeOf(receiver)) {
        const { store, root: storeRoot, tx } = storeOf(receiver);
        if (tx && transactions.has(tx)) transactions.get(tx).written = true;
        const from = storeRoot ? `${storeRoot}.getStore('${store}')` : `objectStore('${store}')`;
        add(n, { kind: storeRoot ? 'storage' : 'indexedDB', op, key: store, call: `${from}.${op}(…)` });
      } else if (CHROME_WRITES.has(op) && chromeArea(receiver)) {
        const area = chromeArea(receiver);
        const key = keysOf(args[0]);
        add(n, { kind: 'chrome.storage', op, key, call: `chrome.storage.${area}.${op}(${key ? `{${key}}` : '…'})` });
      } else if (CURSOR_WRITES.has(op) && ts.isIdentifier(receiver) && lookup(cursorAliases, receiver, receiver.text)) {
        add(n, { kind: 'indexedDB', op, key: null, call: `cursor.${op}(…)` });
      } else if (ts.isIdentifier(receiver) && receiver.text === 'indexedDB' && (op === 'deleteDatabase' || (op === 'open' && args.length > 1))) {
        add(n, { kind: 'indexedDB', op, key: null, call: `indexedDB.${op}(…)` });
      } else if (WEB_STORAGE_WRITES.has(op) && /^((window|self|globalThis)\.)?(localStorage|sessionStorage)$/.test(receiver.getText(sf))) {
        const key = constantString(args[0]);
        add(n, { kind: 'web storage', op, key, call: `${receiver.getText(sf)}.${op}(${key ? `'${key}'` : '…'})` });
      } else if ((WRITES.has(op) || Object.hasOwn(UNDEFINED_WRITES, op)) && !GENERIC_WRITE_NAMES.has(op) && !knownOther(receiver)) {
        problem(n, `calls ${op}() on ${receiver.getText(sf).replace(/\s+/g, ' ').slice(0, 60)}, which the scanner can't place: reach Storage directly, or add the component to COMPONENTS`);
      }
    }
    // A write method handed on without being called can't be traced
    if (ts.isPropertyAccessExpression(n) && (WRITES.has(n.name.text) || Object.hasOwn(UNDEFINED_WRITES, n.name.text)) && storageRoot(n.expression)) {
      let use = n;
      while (ts.isParenthesizedExpression(use.parent)) use = use.parent;
      const called = ts.isCallExpression(use.parent) && use.parent.expression === use;
      if (!called && !ts.isTypeOfExpression(use.parent)) problem(n, `passes ${n.getText(sf)} on without calling it, so its write path can't be traced`);
    }
    ts.forEachChild(n, walk);
  })(sf);

  for (const [tx, { readwrite, root, written }] of transactions) {
    if (!readwrite || written) continue;
    const op = strip(tx.expression).name.text;
    const key = keysOf(tx.arguments[0]);
    add(tx, { kind: root ? 'storage' : 'indexedDB', op, key, call: `${root ? `${root}.` : ''}${op}(${key ? `'${key}'` : '…'}, 'readwrite')` });
  }

  hits.sort((a, b) => a.line - b.line);
  return { hits, problems };
}

/** The files scanned, as repository-relative paths */
function listFiles(root = ROOT_DIR) {
  const files = [];
  (function walk(dir) {
    if (!fs.existsSync(path.join(root, dir))) return;
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.includes(rel)) walk(rel);
      } else if (/\.m?js$/.test(entry.name) && !SKIP_FILES.includes(rel)) {
        files.push(rel);
      }
    }
  })('js');
  return files.sort();
}

/** DatabaseManager's method names, from js/storage.js, or null when there's no such class */
function storageMembers(root = ROOT_DIR) {
  const file = path.join(root, 'js/storage.js');
  if (!fs.existsSync(file)) return null;
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let cls = null;
  sf.forEachChild(n => {
    if (ts.isClassDeclaration(n) && n.name && n.name.text === 'DatabaseManager') cls = n;
  });
  if (!cls) return null;
  return new Set(cls.members
    .filter(m => ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m))
    .map(m => (ts.isConstructorDeclaration(m) ? 'constructor' : propertyName(m.name))));
}

/** Where each name is referred to: property reads, bare identifiers, and strings, as {file, pos} */
function referencesOf(sources) {
  const index = new Map();
  const note = (name, file, pos) => {
    if (!index.has(name)) index.set(name, []);
    index.get(name).push({ file, pos });
  };
  for (const [file, sf] of sources) {
    (function walk(n) {
      if (ts.isIdentifier(n)) {
        const p = n.parent;
        const declares = (ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isMethodDeclaration(p)
          || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)
          || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isPropertyAssignment(p))
          && p.name === n;
        if (!declares) note(n.text, file, n.getStart(sf));
      } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        note(n.text, file, n.getStart(sf));
      }
      ts.forEachChild(n, walk);
    })(sf);
  }
  return index;
}

/** Whether nothing refers to the method or function a hit sits in */
function noLiveCaller(hit, index) {
  const { holder } = hit;
  if (!holder || (holder.kind !== 'method' && holder.kind !== 'function')) return false;
  const start = holder.node.getStart();
  const end = holder.node.end;
  return !(index.get(holder.name) || []).some(ref => ref.file !== hit.file || ref.pos < start || ref.pos >= end);
}

// ─── Classifying ───

function matches(want, value) {
  if (want === undefined) return true;
  if (want instanceof RegExp) return value !== null && value !== undefined && want.test(value);
  if (Array.isArray(want)) return want.includes(value);
  return want === value;
}

/** A command's status in the Commands table: the slice or PR that routes it, or the issue it's ledgered to */
function commandStatus(entry) {
  if (entry.ledger) return `ledgered to #${entry.ledger}`;
  return entry.pr ? `kernel command, ${entry.pr}` : `kernel command, slice ${entry.slice}`;
}

function statusOf(rule, hit) {
  if (hit.noLiveCaller) return 'no live caller';
  if (rule.status) return rule.status;
  if (Object.hasOwn(LEDGERED_FILES, hit.file)) return `ledgered to #${LEDGERED_FILES[hit.file]}`;
  return commandStatus(COMMANDS[rule.command]);
}

/** The hit with its command and status, or with command null when no rule matches */
function classify(hit) {
  const rule = RULES.find(r => matches(r.file, hit.file) && matches(r.method, hit.method) && matches(r.op, hit.op)
    && matches(r.key, hit.key) && (r.fields === undefined || (hit.fields || []).includes(r.fields)));
  const { holder, ...row } = hit;
  if (!rule) return { ...row, command: null, status: null };
  return { ...row, command: rule.command, status: statusOf(rule, hit) };
}

/** The other writes the scan finds, which RULES may name besides DatabaseManager's */
const OTHER_WRITES = new Set([...CHROME_WRITES, ...STORE_WRITES, ...CURSOR_WRITES, ...WEB_STORAGE_WRITES, 'deleteDatabase', 'open']);

/**
 * What the lists name that nothing has: a name in WRITES or READS that DatabaseManager doesn't
 * define, which would let a call to a method it lost through as a write or a read (R88's read
 * of #17 PR 4a), and an op in RULES no list or other write has
 * @param {Set<string> | null} members - DatabaseManager's, or null when there's no such class
 * @returns {string[]}
 */
function staleListings(members) {
  const problems = [];
  if (members) {
    for (const [name, list] of [['WRITES', WRITES], ['READS', READS]]) {
      for (const op of list) {
        if (!members.has(op)) problems.push(`${name} in scripts/write-paths.js lists ${op}, which DatabaseManager doesn't define: drop it`);
      }
    }
    for (const op of Object.keys(HANDLE_READS)) {
      if (members.has(op)) problems.push(`HANDLE_READS in scripts/write-paths.js lists ${op}, which DatabaseManager defines: move it to READS`);
    }
  }
  for (const rule of RULES) {
    for (const op of [].concat(rule.op ?? [])) {
      const known = WRITES.has(op) || MODE_WRITES.has(op) || Object.hasOwn(UNDEFINED_WRITES, op) || OTHER_WRITES.has(op);
      if (!known) problems.push(`the ${rule.command} rule in scripts/write-paths.js names ${op}, which nothing writes with: drop it`);
    }
  }
  return problems;
}

/** Every write path in js/, classified, and what keeps the doc from being written */
function collect(root = ROOT_DIR) {
  const files = listFiles(root);
  const texts = new Map(files.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  const sources = new Map(files.map(file => [file, ts.createSourceFile(file, texts.get(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)]));
  const members = storageMembers(root);
  const index = referencesOf(sources);
  const rows = [];
  const problems = staleListings(members);
  for (const file of files) {
    const result = scanSource(file, texts.get(file), { members });
    for (const hit of result.hits) {
      hit.noLiveCaller = noLiveCaller(hit, index);
      rows.push(classify(hit));
    }
    problems.push(...result.problems);
  }
  for (const row of rows.filter(r => !r.command)) {
    problems.push(`${row.file}:${row.line} ${row.method}: ${row.call} has no rule; add one to RULES in scripts/write-paths.js`);
  }
  return { rows, problems };
}

// ─── The doc ───

const cell = text => text.replace(/\|/g, '\\|');

function renderDoc(rows) {
  const count = (field, value) => rows.filter(r => r[field] === value).length;
  const lines = [
    '# Write paths',
    '',
    "Every mutating persistence call in `js/` outside `js/storage.js` (and outside `js/lib/` and `js/kernel/`), the intent-level kernel command it becomes, and when. #12's acceptance criteria need each row to go through a kernel command or stay ledgered to #11, #19, or #22. #12 slice 2 mapped them.",
    '',
    "Network writes (sync uploads, AI provider requests) aren't listed. They go through `fetch`, which the kernel boundary rules ledger to #19 and #11.",
    '',
    `Written by \`${WRITE_COMMAND}\` from \`scripts/write-paths.js\`, which says what counts as a mutating call and holds the rules below. \`npm test\` fails when a call is added, removed, moved to another function, or reclassified until this file is rewritten. Line numbers are where the calls were when it was last written.`,
    '',
    '## Statuses',
    '',
    '| Status | Rows | Meaning |',
    '| --- | --- | --- |',
    ...STATUSES.map(([status, meaning]) => `| ${status} | ${count('status', status)} | ${cell(meaning)} |`),
    `| Total | ${rows.length} | |`,
    '',
    "No row is UI-only. Presentation state (panels, the palette index, selection mode, the calendar month) isn't persisted, and every persisted preference goes through the settings port.",
    '',
    '## Commands',
    '',
    '| Command | Status | Rows |',
    '| --- | --- | --- |',
    ...Object.entries(COMMANDS).map(([command, entry]) => `| \`${command}\` | ${commandStatus(entry)} | ${count('command', command)} |`),
    '',
    'Rows marked "no live caller" or "no live path" are counted under the command the call would become.',
    '',
    "Routed ahead of their slice: the sidebar folder menu's Add Note to Folder files its new note with `createNote`'s `folderId` (#12 slice 4c2), so the slice 5 `moveNoteToFolder` row that set the folder after the create went with the slice 4 `createNote` row.",
    '',
    '## Calls',
    '',
    "Method is the class method or function the call sits in. After `>` comes the anonymous or nested function inside it, when where it sits says what it's for: a listener, a callback property such as `onResizeEnd`, or a menu item's `action`. An update's Call lists the fields it sets.",
    '',
    '| File | Line | Method | Call | Command | Status |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(r => `| \`${r.file}\` | [${r.line}](../../${r.file}#L${r.line}) | \`${cell(r.method)}\` | \`${cell(r.call)}\` | \`${r.command}\` | ${r.status} |`),
    '',
  ];
  return lines.join('\n');
}

const CALL_ROW = /^\| `js\/[^`]+` \| \[\d+\]\([^)]+\) \|/;

/** The doc with each Calls row's line cell blanked and the rows in a stable order */
function withoutLines(doc) {
  const out = [];
  const callRows = [];
  for (const line of doc.split('\n')) {
    if (CALL_ROW.test(line)) callRows.push(line.replace(/^(\| `js\/[^`]+` \| )\[\d+\]\([^)]+\)( \|)/, '$1L$2'));
    else out.push(line);
  }
  return { rest: out.join('\n'), rows: callRows.sort() };
}

/** Multiset difference: the items of `a` not in `b` */
function minus(a, b) {
  const left = new Map();
  for (const item of b) left.set(item, (left.get(item) || 0) + 1);
  return a.filter(item => {
    const n = left.get(item) || 0;
    if (n === 0) return true;
    left.set(item, n - 1);
    return false;
  });
}

/**
 * Compare the doc with the code. Returns problems, empty when they agree apart from line
 * numbers.
 */
function check(root = ROOT_DIR) {
  const { rows, problems } = collect(root);
  if (problems.length > 0) return problems;
  const docPath = path.join(root, DOC);
  if (!fs.existsSync(docPath)) return [`${DOC} is missing; write it with \`${WRITE_COMMAND}\``];
  const want = withoutLines(renderDoc(rows));
  const have = withoutLines(fs.readFileSync(docPath, 'utf8'));
  const out = [];
  for (const row of minus(want.rows, have.rows)) out.push(`missing from ${DOC}: ${row}`);
  for (const row of minus(have.rows, want.rows)) out.push(`in ${DOC} but not in the code: ${row}`);
  if (out.length === 0 && want.rest !== have.rest) out.push(`${DOC}'s text or counts differ from what the script writes`);
  if (out.length > 0) out.push(`Rewrite it with \`${WRITE_COMMAND}\``);
  return out;
}

function main(argv = process.argv.slice(2), { root = ROOT_DIR, log = console.log, error = console.error } = {}) {
  const write = argv.includes('--write');
  if (argv.some(arg => arg !== '--write')) {
    error('usage: node scripts/write-paths.js [--write]');
    return 2;
  }
  if (write) {
    const { rows, problems } = collect(root);
    if (problems.length > 0) {
      error(`write-paths: ${DOC} was not written:`);
      problems.forEach(p => error(`  - ${p}`));
      return 1;
    }
    fs.mkdirSync(path.dirname(path.join(root, DOC)), { recursive: true });
    fs.writeFileSync(path.join(root, DOC), renderDoc(rows));
    log(`write-paths: wrote ${DOC} with ${rows.length} rows`);
    return 0;
  }
  const problems = check(root);
  if (problems.length > 0) {
    error('write-paths check failed:');
    problems.forEach(p => error(`  - ${p}`));
    return 1;
  }
  log(`write-paths: OK, ${DOC} matches the code`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  WRITES, READS, MODE_WRITES, UNDEFINED_WRITES, COMMANDS, RULES, STATUSES, PREFERENCE_KEYS, PROVIDER_KEYS, SYNC_KEYS,
  COMPONENTS, LEDGERED_FILES, DOC, scanSource, listFiles, storageMembers, staleListings, classify, collect, renderDoc,
  withoutLines, check, main,
};
