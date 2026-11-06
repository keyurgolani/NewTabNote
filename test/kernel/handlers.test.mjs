// Each page's kernel runs the table of handlers its composition root gives it (#17 PR 4b, the
// lead's ruling on Popup's and Side Panel's start; core/application/handlers.js). Each table
// holds every command and query its page sends, read from the modules the page loads, so a
// page that sends one its table lacks fails here, never in a user's hands. Popup's, Side
// Panel's and the worker's tables hold nothing else, so neither Popup's nor Side Panel's start
// loads the remote apply or the index commands. A table that holds a bulk command holds its
// refusal too. A command or query the policy allows that a table lacks is refused as
// not-registered and logged as an error, never run. Each page's table is on the shared catalog,
// and the worker's on its own part composed with it (contracts/worker-catalog.js), which no
// page's start loads.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { ALL_HANDLERS, NEWTAB_HANDLERS } from '../../js/kernel/core/application/handlers-all.js';
import { CONTEXT_HANDLERS } from '../../js/kernel/core/application/handlers-newtab.js';
import { POPUP_HANDLERS } from '../../js/kernel/core/application/handlers-popup.js';
import { RECOVERY_HANDLERS } from '../../js/kernel/core/application/handlers-recovery.js';
import { SIDEPANEL_HANDLERS } from '../../js/kernel/core/application/handlers-sidepanel.js';
import { WORKER_HANDLERS } from '../../js/kernel/core/application/handlers-worker.js';
import { handlerTable } from '../../js/kernel/core/application/handlers.js';
import { NOT_REGISTERED, createKernel } from '../../js/kernel/core/application/kernel.js';
import { COMMANDS } from '../../js/kernel/core/contracts/commands.js';
import { QUERIES } from '../../js/kernel/core/contracts/queries.js';
import {
  WORKER_CATALOG,
  WORKER_COMMAND_TYPES,
  WORKER_QUERY_TYPES,
} from '../../js/kernel/core/contracts/worker-catalog.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { importGraph, reachGraph } from './import-graph.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';

/** @typedef {import('../../js/kernel/core/application/handlers.js').HandlerTable} HandlerTable */
/** @typedef {import('../../js/kernel/core/contracts/surfaces.js').Surface} Surface */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').Command} Command */

const ROOT = path.join(import.meta.dirname, '..', '..');

/** Every command and query type the catalog has, the worker's part's with the shared ones */
/** @type {ReadonlySet<string>} */
const CATALOG_TYPES = new Set([...WORKER_COMMAND_TYPES, ...WORKER_QUERY_TYPES]);

/**
 * The modules only the worker loads: its part of the catalog, its table, the capture, the drain,
 * the records' catch-up and the integrity check's command (#35 slice 3c), and the coordinator
 * with its queue and the worker's own router and client (slice 4a)
 */
const WORKER_ONLY_MODULES =
  /^js\/kernel\/(core\/contracts\/worker-catalog|core\/application\/(capture|handlers-worker|handlers-all|journal|journal-drain|record-catch-up|integrity-check)|composition\/(coordinator|worker-internal))\.js$/;

/** The worker's handler modules #35 slice 3c took off the new tab's start */
const CUT_MODULES = Object.freeze([
  'js/kernel/core/application/record-catch-up.js',
  'js/kernel/core/application/integrity-check.js',
]);

/** The close-time drafts' applier, which only the pages run (#33, #35 slice 3b) */
const APPLIER_MODULES =
  /^js\/kernel\/core\/(application\/close-drafts|domain\/(close-draft|close-draft-format|close-draft-keys|recovered-note))\.js$/;

/**
 * Each page with a kernel: the modules its HTML loads, its surface, its root's table, whether
 * its root runs startup maintenance as the kernel opens, which sends runStartupMaintenance from
 * the kernel itself (kernel.js, maintain), and whether it writes notes, so its root applies a
 * closing tab's edits and journals what it sends (#33, #35 slice 3b). recovery.html reads only
 * its theme through its kernel, so it does neither (#20 slice 4b).
 * @type {ReadonlyArray<{page: string, entries: string[], surface: Surface, table: HandlerTable, maintains: boolean, writesNotes: boolean}>}
 */
const PAGES = [
  { page: 'Popup', entries: ['js/popup.js'], surface: 'popup', table: POPUP_HANDLERS, maintains: false, writesNotes: true },
  {
    page: 'Side Panel',
    entries: ['js/sidepanel.js', 'js/insights-summary.js'],
    surface: 'sidepanel',
    table: SIDEPANEL_HANDLERS,
    maintains: false,
    writesNotes: true,
  },
  {
    page: 'the service worker',
    entries: ['js/background.js'],
    surface: 'worker-internal',
    table: WORKER_HANDLERS,
    maintains: true,
    writesNotes: true,
  },
  {
    page: 'the new tab',
    entries: ['js/entries/newtab.js'],
    surface: 'newtab',
    table: NEWTAB_HANDLERS,
    maintains: true,
    writesNotes: true,
  },
  {
    page: 'recovery.html',
    entries: ['js/recovery.js'],
    surface: 'recovery',
    table: RECOVERY_HANDLERS,
    maintains: false,
    writesNotes: false,
  },
];

/**
 * The modules a page loads, its own code and its root's, through static imports and each
 * import() of a literal, vendored libraries left out
 * @param {string[]} entries
 * @returns {string[]}
 */
function pageModules(entries) {
  const { modules } = reachGraph(entries.map(entry => path.join(ROOT, entry)));
  return [...modules].filter(file => !path.relative(ROOT, file).startsWith('js/lib/')).sort();
}

/** The kernel's own module, whose one send is the startup maintenance a root that maintains runs */
const KERNEL = path.join(ROOT, 'js', 'kernel', 'core', 'application', 'kernel.js');

/** The contracts, where the planted case puts a schema module */
const CONTRACTS = path.join(ROOT, 'js', 'kernel', 'core', 'contracts') + path.sep;

/**
 * Whether `node` is a schema's own name for what it defines, which isn't a send: the first
 * argument of commandPayload() or queryPayload(), a schema's `type`, or of v.literal(), as a
 * change op's name. The service worker loads the journaled commands' schemas since #35 slice 3,
 * to read a journal entry before its drain replays it.
 * @param {ts.Node} node
 * @returns {boolean}
 */
const isSchemaName = node => {
  const { parent } = node;
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== node) return false;
  const called = parent.expression;
  if (ts.isIdentifier(called)) return called.text === 'commandPayload' || called.text === 'queryPayload';
  return ts.isPropertyAccessExpression(called) && called.name.text === 'literal';
};

/**
 * The list of every command name the worker's catalog holds (contracts/command-names.js, #35 slice
 * 4b-1), whose strings name commands and send none: it imports nothing, so nothing in it can reach a
 * kernel, and test/kernel/catalog.test.mjs pins that it imports nothing. So its strings are read for
 * no unread send, by this path alone. A `type` it names, or an `.execute({...})` or a
 * `.query({...})` in it, is read as anywhere else.
 */
const COMMAND_NAMES_MODULE = path.join(ROOT, 'js', 'kernel', 'core', 'contracts', 'command-names.js');

/**
 * @param {ts.PropertyName | undefined} name
 * @returns {boolean} whether a property so named is an object's `type`
 */
const isTypeName = name => !!name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'type';

/**
 * @param {ts.Expression} node
 * @returns {ts.Expression} `node` without the parentheses around it, a JSDoc cast's too
 */
const unwrapped = node => (ts.isParenthesizedExpression(node) ? unwrapped(node.expression) : node);

/**
 * Where the object a send is built in goes: the property it's the value of, and the call that
 * takes it, or the object holding that property, as an argument. In
 * `commitOrThrow(adapter, { command: { type: 'setPreferences' } })`, `key` is `command` and `call`
 * is `commitOrThrow`. Each is null where the object has none.
 * @param {ts.Node} object - the object literal whose `type` names the send
 * @param {ts.SourceFile} source
 * @returns {{key: string | null, call: string | null}}
 */
const holderOf = (object, source) => {
  /** @param {ts.Node} node */
  const outside = node => {
    let { parent } = node;
    while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
    return parent;
  };
  let around = outside(object);
  /** @type {string | null} */
  let key = null;
  if (around && ts.isPropertyAssignment(around) && ts.isIdentifier(around.name)) {
    key = around.name.text;
    around = outside(around.parent);
  }
  return { key, call: around && ts.isCallExpression(around) ? around.expression.getText(source) : null };
};

/**
 * What `files` send to a kernel, as the scan reads them: every catalog type an object's `type`
 * names as a string, wherever the object is built, apart from the kernel's own, each with its
 * site (file:line, and where its object goes: holderOf); and, as file:line, what it can't read: an `.execute({...})` or `.query({...})` whose object's type
 * isn't a string (computed, shorthand, or behind a spread), and a catalog type's name in any
 * other string but another property's key or value, which names something else: a table's key,
 * BULK_ACTIONS' item commands, a change op's name. A call handed a variable is read where its
 * object is built, as the worker's client forwards what js/background.js builds. A schema's own
 * name for what it defines (isSchemaName) is read for none of it. It finds a send a table lacks
 * by accident, not one written to get past it. `readFile` reads a module's text, from disk
 * unless given, so a test can plant a send.
 * @param {string[]} files
 * @param {{readFile?: (file: string) => string}} [options]
 * @returns {{types: Set<string>, sites: Site[], own: Set<string>, unread: string[]}}
 */
function sendsIn(files, { readFile = file => fs.readFileSync(file, 'utf8') } = {}) {
  /** @type {Set<string>} */
  const types = new Set();
  /** @type {Site[]} */
  const sites = [];
  /** @type {Set<string>} */
  const own = new Set();
  /** @type {string[]} */
  const unread = [];
  for (const file of files) {
    const text = readFile(file);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    /** @param {ts.Node} node */
    const at = node =>
      `${path.relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    /** @param {ts.Node} node */
    const walk = node => {
      if (ts.isStringLiteralLike(node) && CATALOG_TYPES.has(node.text) && !isSchemaName(node)) {
        const { parent } = node;
        if (!ts.isPropertyAssignment(parent)) {
          if (file !== COMMAND_NAMES_MODULE) unread.push(at(node));
        } else if (parent.initializer === node && isTypeName(parent.name)) {
          if (file === KERNEL) own.add(node.text);
          else {
            types.add(node.text);
            sites.push({ type: node.text, file: path.relative(ROOT, file), at: at(node), ...holderOf(parent.parent, source) });
          }
        }
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === 'execute' || node.expression.name.text === 'query') &&
        node.arguments.length > 0
      ) {
        const object = unwrapped(node.arguments[0]);
        if (ts.isObjectLiteralExpression(object)) {
          const literal = object.properties.some(
            property =>
              ts.isPropertyAssignment(property) &&
              isTypeName(property.name) &&
              ts.isStringLiteralLike(property.initializer),
          );
          const unknown = object.properties.some(
            property =>
              ts.isSpreadAssignment(property) ||
              (property.name !== undefined && (isTypeName(property.name) || ts.isComputedPropertyName(property.name))),
          );
          if (!literal && unknown) unread.push(at(node));
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return { types, sites, own, unread };
}

/**
 * One send the scan read
 * @typedef {{type: string, file: string, at: string, key: string | null, call: string | null}} Site
 */

/** @param {HandlerTable} table */
const registered = table => new Set([...Object.keys(table.commands), ...Object.keys(table.queries)]);

/**
 * The bulk commands `table` holds without their refusal, which turns down one refused for its
 * payload before the adapter recalls it, so its commandId isn't reserved (kernel.js)
 * @param {HandlerTable} table
 */
const bulkWithoutRefusal = table =>
  Object.keys(table.commands).filter(
    type => table.catalog.commands[type]?.bulk && !Object.hasOwn(table.refusals, type),
  );

/**
 * Whether the catalog `table` runs on, which its root builds its policy on, lets `surface` send
 * `type`
 * @param {string} type
 * @param {Surface} surface
 * @param {HandlerTable} table
 */
const allowedOn = (type, surface, table) => {
  const { commands, queries } = table.catalog;
  const entry = Object.hasOwn(commands, type) ? commands[type] : Object.hasOwn(queries, type) ? queries[type] : null;
  return !!entry && entry.surfaces.includes(surface);
};

/**
 * The sends the scan reads in a page's modules that never reach its kernel, by page, each pinned
 * to its one call. recovery.html bundles the trust remediations' catalog
 * (js/trust/core/remediation/catalog.js), whose safe-disable builds a `setPreferences` command
 * and hands it to commitOrThrow, which commits it through the remediation's adapter port
 * (`adapter.commit`, #17's adapter), never a kernel client's execute, so it's adapter-only: no
 * handler table runs it. And the page's rows run only rebuild-index (js/trust/core/router-rows.js),
 * so safe-disable never runs there at all (#20 slice 4b). Only that call is left out: the file
 * builds the type once, there, or the pin fails, and any other send, in that file or any other,
 * still counts.
 * @type {Readonly<Record<string, ReadonlyArray<{file: string, type: string, call: string, key: string}>>>}
 */
const ADAPTER_ONLY_SENDS = Object.freeze({
  'recovery.html': Object.freeze([
    Object.freeze({ file: 'js/trust/core/remediation/catalog.js', type: 'setPreferences', call: 'commitOrThrow', key: 'command' }),
  ]),
});

describe("each page's kernel registers what its page sends (#17 PR 4b)", () => {
  /**
   * What a page sends: what its modules send, and the kernel's own maintenance when its root
   * runs it as the kernel opens, less the one call ADAPTER_ONLY_SENDS pins for the page. A pin's
   * file has to build its type exactly once, at that call, so a second one there fails, as does
   * a pin whose call is gone. `readFile`, as sendsIn's, lets a test plant a send.
   * @param {{page?: string, entries: string[], maintains: boolean}} page
   * @param {{readFile?: (file: string) => string}} [options]
   */
  const sentBy = ({ page, entries, maintains }, options = {}) => {
    const { sites, own, unread } = sendsIn(pageModules(entries), options);
    /** @type {Set<Site>} */
    const adapterOnly = new Set();
    for (const pin of (page && ADAPTER_ONLY_SENDS[page]) || []) {
      const ofType = sites.filter(site => site.file === pin.file && site.type === pin.type);
      assert.deepEqual(
        ofType.map(site => `${site.call}'s ${site.key}`),
        [`${pin.call}'s ${pin.key}`],
        `${pin.file} builds ${pin.type} once, as ${pin.call}'s ${pin.key}`,
      );
      adapterOnly.add(ofType[0]);
    }
    const types = sites.filter(site => !adapterOnly.has(site)).map(site => site.type);
    return { sent: new Set([...types, ...(maintains ? own : [])]), own, unread };
  };

  for (const { page, entries, surface, table, maintains } of PAGES) {
    it(`${page}: its table holds every command and query its code and its root send`, () => {
      const { sent, own, unread } = sentBy({ page, entries, maintains });
      assert.ok(sent.size > 0, `${page} sends something`);
      assert.deepEqual([...own], ['runStartupMaintenance'], "the kernel's own send");
      assert.deepEqual(
        [...sent].filter(type => !registered(table).has(type)),
        [],
        `${page} sends what its table doesn't hold`,
      );
      if (surface === 'newtab') {
        // The new tab's facade sends types the scan can't read, so its table holds every one
        // the catalog allows there
        assert.deepEqual(
          [...registered(table)].sort(),
          [...CATALOG_TYPES].filter(type => allowedOn(type, 'newtab', table)).sort(),
        );
      } else {
        assert.deepEqual(unread, [], `${page} sends what the scan can't read`);
      }
    });

    if (surface !== 'newtab') {
      it(`${page}: its table holds nothing else, so its start loads no handler it never runs`, () => {
        assert.deepEqual([...registered(table)].sort(), [...sentBy({ page, entries, maintains }).sent].sort());
      });
    }

    it(`${page}: its table is on the catalog its root builds its policy on, which allows on ${surface} every type it holds, and each bulk command it holds comes with its refusal`, () => {
      if (surface === 'worker-internal') assert.equal(table.catalog, WORKER_CATALOG);
      else assert.deepEqual([table.catalog.commands, table.catalog.queries], [COMMANDS, QUERIES]);
      assert.deepEqual(
        [...registered(table)].filter(type => !allowedOn(type, surface, table)),
        [],
      );
      assert.deepEqual(
        Object.keys(table.refusals).filter(type => !Object.hasOwn(table.commands, type)),
        [],
        'a refusal only for a command it runs',
      );
      // Without it, a bulk action refused for its payload keeps its commandId reserved, and the
      // corrected one sent under that id is refused as idempotency-key-reuse (R131)
      assert.deepEqual(bulkWithoutRefusal(table), [], 'every bulk command with its refusal');
    });
  }

  it('the scan reads a send wherever its object is built, and says what it cannot read', () => {
    const page = [
      "const command = { type: 'createNote', commandId: 'c1' };",
      'kernel.execute(command);',
      "kernel.query(/** @type {any} */ ({ type: 'listNotes' }));",
      "const named = { createNote: 1, 'getNote': 2, archive: 'archiveNote' };",
      'kernel.execute({ ...fields, commandId });',
      'kernel.execute({ type, commandId });',
      "kernel.execute({ type: names['renameNote'] });",
      "chrome.tabs.query({ active: true, type: 'normal' });",
      "const ops = [{ op: 'createFolder' }];",
      "built.type = 'trashNote';",
    ].join('\n');
    const kernel = "dispatch({ type: 'runStartupMaintenance', commandId: ids.next() });";
    // A schema module names the operation it defines, which isn't a send, and a send in it is
    // read as anywhere else
    const contract = path.join(CONTRACTS, 'operations', 'create-note.js');
    const read = sendsIn(['page.js', KERNEL, contract], {
      readFile: file => {
        if (file === contract)
          return [
            "export const payload = commandPayload('createNote', { op: v.literal('createFolder') });",
            "export const read = queryPayload('getNote', {});",
            "kernel.query({ type: 'getNoteBlocks' });",
          ].join('\n');
        return file === KERNEL ? kernel : page;
      },
    });
    assert.deepEqual([...read.types].sort(), ['createNote', 'getNoteBlocks', 'listNotes']);
    assert.deepEqual([...read.own], ['runStartupMaintenance']);
    // The spread, the shorthand type, the type read from a name, its call and its string, and a
    // type set on an object after it's built
    assert.deepEqual(
      read.unread.map(at => at.slice(at.lastIndexOf(':') + 1)),
      ['5', '6', '7', '7', '10'],
    );
  });

  it("leaves out of recovery.html's sends only safe-disable's one adapter-only call, so a send planted anywhere else still fails, in remediation/catalog.js too (#20 slice 4b)", () => {
    const recovery = /** @type {(typeof PAGES)[number]} */ (PAGES.find(entry => entry.page === 'recovery.html'));
    const catalog = 'js/trust/core/remediation/catalog.js';
    /**
     * What recovery.html sends with `planted` added to the end of `file`, or with `file`'s text
     * changed by `edit`
     * @param {string} file
     * @param {{planted?: string, edit?: (text: string) => string}} change
     */
    const sentWith = (file, { planted = '', edit = text => text }) =>
      sentBy(recovery, {
        readFile: read => {
          const text = fs.readFileSync(read, 'utf8');
          return path.relative(ROOT, read) === file ? `${edit(text)}\n${planted}\n` : text;
        },
      });
    /** @param {Set<string>} sent */
    const unheld = sent => [...sent].filter(type => !registered(recovery.table).has(type));
    // The pin's failure, whose message the diff of the sites it found follows
    const pinFails = { message: /^js\/trust\/core\/remediation\/catalog\.js builds setPreferences once, as commitOrThrow's command\n/ };
    // As the page is: the one call is left out, and its table holds what's left
    const site = sendsIn([path.join(ROOT, catalog)]).sites.filter(found => found.type === 'setPreferences');
    assert.deepEqual(site.map(found => [found.call, found.key]), [['commitOrThrow', 'command']]);
    assert.deepEqual([...sentBy(recovery).sent], ['getPreferences']);
    // A second setPreferences in the same file, sent to a kernel or committed the same way
    for (const planted of [
      "export const plantedSend = kernel => kernel.execute({ type: 'setPreferences', commandId: 'p', values: {} });",
      "export const plantedCommit = adapter => commitOrThrow(adapter, { command: { type: 'setPreferences', commandId: 'p' } });",
    ]) {
      assert.throws(() => sentWith(catalog, { planted }), pinFails, planted);
    }
    // Another type in the same file, and a setPreferences in another of the page's modules
    assert.deepEqual(unheld(sentWith(catalog, { planted: "export const planted = { type: 'saveNoteContent', commandId: 'p' };" }).sent), ['saveNoteContent']);
    assert.deepEqual(
      unheld(sentWith('js/trust/ui/view.js', { planted: "export const planted = kernel => kernel.execute({ type: 'setPreferences', commandId: 'p', values: {} });" }).sent),
      ['setPreferences'],
    );
    // A pin whose call is gone fails too, so it can't outlive what it pins
    assert.throws(() => sentWith(catalog, { edit: text => text.replace("type: 'setPreferences'", "type: 'renamedPreferences'") }), pinFails);
  });

  it('reads the names in command-names.js for no send, since it imports nothing and so sends nothing, and the same names in any other file as unread, as before (#35 slice 4b-1)', () => {
    const names = "export const COMMAND_NAMES = Object.freeze(['createNote', 'captureToDailyNote']);";
    // Another module of the worker's graph, planted with the same strings
    const elsewhere = path.join(ROOT, 'js', 'kernel', 'composition', 'coordinator.js');
    const read = sendsIn([COMMAND_NAMES_MODULE, elsewhere], { readFile: () => names });
    assert.deepEqual(read.unread, ['js/kernel/composition/coordinator.js:1', 'js/kernel/composition/coordinator.js:1']);
    assert.deepEqual([...read.types], []);
    // A send in it is read as anywhere else: the type it names, and one the scan can't read
    const sending = sendsIn([COMMAND_NAMES_MODULE], {
      readFile: () =>
        ["kernel.execute({ type: 'trashNote', commandId: 'c1' });", 'kernel.execute({ ...fields, commandId });'].join(
          '\n',
        ),
    });
    assert.deepEqual([...sending.types], ['trashNote']);
    assert.deepEqual(sending.unread, ['js/kernel/core/contracts/command-names.js:2']);
  });

  it("ALL_HANDLERS, the tests' table, holds every command and query the catalog has", () => {
    assert.equal(ALL_HANDLERS.catalog, WORKER_CATALOG);
    assert.deepEqual([...registered(ALL_HANDLERS)].sort(), [...CATALOG_TYPES].sort());
    assert.deepEqual(Object.keys(ALL_HANDLERS.refusals).sort(), ['applyRemoteChanges', 'runBulkAction']);
    assert.deepEqual(bulkWithoutRefusal(ALL_HANDLERS), []);
  });

  it("the close-time drafts' apply is in the table of each page whose root applies them, and not the worker's, which leaves a journaled editor save to the pages (#33, #35 slice 3)", () => {
    for (const { page, entries, surface, table, maintains, writesNotes } of PAGES) {
      const applies = surface !== 'worker-internal' && writesNotes;
      assert.equal(sentBy({ page, entries, maintains }).sent.has('applyCloseDraft'), applies, `${page} sends it`);
      assert.equal(registered(table).has('applyCloseDraft'), applies, `${page}'s table holds it`);
    }
  });

  it("the worker's table holds what its journal drain sends, and no page loads the worker's part, the capture or the drain, at its start or later (#35 slice 3)", () => {
    const worker = sentBy({ entries: ['js/background.js'], maintains: true }).sent;
    for (const type of ['createNote', 'insertBlocks', 'captureToDailyNote', 'keepJournalEntry', 'findTombstones']) {
      assert.ok(worker.has(type), type);
    }
    for (const { page, entries, surface } of PAGES) {
      if (surface === 'worker-internal') continue;
      const loaded = pageModules(entries).map(file => path.relative(ROOT, file));
      assert.deepEqual(
        loaded.filter(file => WORKER_ONLY_MODULES.test(file)),
        [],
        page,
      );
    }
    // The capture is the worker's alone, so the new tab's table doesn't hold it
    assert.equal(registered(NEWTAB_HANDLERS).has('captureToDailyNote'), false);
  });

  it("no page loads the records' catch-up or the integrity check's command, at its start or later, and the worker loads both (#35 slice 3c)", () => {
    for (const { page, entries, surface } of PAGES) {
      if (surface === 'worker-internal') continue;
      const loaded = pageModules(entries).map(file => path.relative(ROOT, file));
      assert.deepEqual(CUT_MODULES.filter(file => loaded.includes(file)), [], page);
    }
    const worker = pageModules(['js/background.js']).map(file => path.relative(ROOT, file));
    for (const file of CUT_MODULES) assert.ok(worker.includes(file), `the worker loads ${file}`);
  });

  it("the new tab's start holds no handler of a type the shared catalog doesn't have, before its table keeps what the catalog allows there (#35 slice 3c)", () => {
    assert.deepEqual(Object.keys(CONTEXT_HANDLERS.commands).filter(type => !Object.hasOwn(COMMANDS, type)), []);
    assert.deepEqual(Object.keys(CONTEXT_HANDLERS.queries).filter(type => !Object.hasOwn(QUERIES, type)), []);
  });

  it("the worker loads none of the close-time drafts' applier, which only the pages run (#33, #35 slice 3b)", () => {
    const loaded = pageModules(['js/background.js']).map(file => path.relative(ROOT, file));
    assert.deepEqual(
      loaded.filter(file => APPLIER_MODULES.test(file)),
      [],
    );
    // And the new tab loads all five, at its first apply (close-drafts-on-demand.js), so the
    // check above isn't empty
    const newtab = pageModules(['js/entries/newtab.js']).map(file => path.relative(ROOT, file));
    assert.equal(newtab.filter(file => APPLIER_MODULES.test(file)).length, 5);
  });

  it("each page loads its journal chunk later, never at its start, and the chunk holds none of the worker's part (#35 slice 3b)", () => {
    const chunk = 'js/kernel/composition/journal-chunk.js';
    // What no page's start holds: the chunk, the journaling, the apply of editor saves, which the
    // chunk loads only when it finds one, and the journal's database
    const chunkOnly = [
      chunk,
      'js/kernel/core/application/journaling.js',
      'js/kernel/core/application/journal-apply.js',
      'js/kernel/adapters/in-context.js',
      'js/kernel/adapters/indexeddb/journal.js',
    ];
    for (const { page, entries, surface, writesNotes } of PAGES) {
      if (surface === 'worker-internal') continue;
      // What a page loads before it's ready: its own modules' static imports, and on the new tab
      // the workspace chunk its entry loads at once (js/entries/newtab.js)
      const starts = surface === 'newtab' ? [...entries, 'js/workspace.js'] : entries;
      const start = new Set(
        starts.flatMap(entry => [...importGraph(path.join(ROOT, entry))].map(file => path.relative(ROOT, file))),
      );
      assert.ok(start.has('js/kernel/composition/host.js'), `${page}'s start holds the shim`);
      const loaded = pageModules(entries).map(file => path.relative(ROOT, file));
      // A page that writes no note loads no journal, at its start or later
      assert.equal(loaded.includes(chunk), writesNotes, `${page} loads the chunk`);
      assert.deepEqual(
        chunkOnly.filter(file => start.has(file)),
        [],
        `${page}'s start`,
      );
    }
    const held = [...reachGraph([path.join(ROOT, chunk)]).modules].map(file => path.relative(ROOT, file));
    assert.deepEqual(
      held.filter(
        file => WORKER_ONLY_MODULES.test(file) || file === 'js/kernel/core/messaging/journaled-operations.js',
      ),
      [],
    );
  });

  it("neither Popup's nor Side Panel's start loads the remote apply or the index commands while #19 isn't live", () => {
    for (const entries of [['js/popup.js'], ['js/sidepanel.js', 'js/insights-summary.js']]) {
      const loaded = pageModules(entries).map(file => path.relative(ROOT, file));
      assert.deepEqual(
        loaded.filter(file => /^js\/kernel\/core\/application\/(remote|indexing|handlers-all)\.js$/.test(file)),
        [],
        entries.join(', '),
      );
    }
  });
});

describe('a command or query the policy allows that a table lacks (#17 PR 4b)', () => {
  /**
   * A kernel for `caller` on its own memory adapter with `table`, and what its logger was told
   * @param {HandlerTable} table
   * @param {{surface: Surface, contextId: string}} caller
   * @param {{error?: boolean}} [options] - whether the logger has an error method
   */
  const kernelOf = (table, caller, { error = true } = {}) => {
    /** @type {Array<[string, string, Record<string, unknown>]>} */
    const logged = [];
    const adapter = createMemoryAdapter();
    const logger = {
      warn: (/** @type {string} */ event, /** @type {Record<string, unknown>} */ detail) =>
        logged.push(['warn', event, detail]),
      ...(error
        ? {
            error: (/** @type {string} */ event, /** @type {Record<string, unknown>} */ detail) =>
              logged.push(['error', event, detail]),
          }
        : {}),
    };
    const kernel = createKernel({
      adapter,
      policy: createBaselinePolicy(),
      caller,
      handlers: table,
      ids: testIds(),
      clock: testClock(),
      logger,
    });
    const reader = createKernel({
      adapter,
      policy: createBaselinePolicy(),
      caller: CALLERS.newtab,
      handlers: ALL_HANDLERS,
      ids: testIds('reader'),
      clock: testClock(),
    });
    return { kernel, reader, logged };
  };

  it('is refused as not-registered, writes nothing, and is logged as an error with the surface and the type, never the payload', async () => {
    // Popup's table with its quick note dropped
    const table = handlerTable({ queries: POPUP_HANDLERS.queries });
    const { kernel, reader, logged } = kernelOf(table, CALLERS.popup);
    const outcome = await kernel.execute({
      type: 'createNote',
      commandId: 'c1',
      noteId: 'n1',
      name: 'Call the plumber',
    });
    assert.deepEqual(outcome, {
      kind: 'rejected',
      reason: 'policy',
      code: NOT_REGISTERED,
      messageKey: 'rejected.not-registered',
      severity: 'error',
    });
    assert.deepEqual(logged, [
      ['error', 'handler-missing', { surface: 'popup', type: 'createNote', code: NOT_REGISTERED }],
    ]);
    assert.equal((await reader.query({ type: 'getNote', noteId: 'n1' })).kind, 'empty');
    // A query too
    const listed = await kernel.query({ type: 'getNote', noteId: 'n1' });
    assert.deepEqual(listed, { kind: 'failed', cause: 'policy', code: NOT_REGISTERED });
    assert.deepEqual(logged.at(-1), [
      'error',
      'handler-missing',
      { surface: 'popup', type: 'getNote', code: NOT_REGISTERED },
    ]);
  });

  it('holds no key, so the same command commits once the page has its handler', async () => {
    const adapter = createMemoryAdapter();
    /** @param {HandlerTable} table */
    const on = table =>
      createKernel({
        adapter,
        policy: createBaselinePolicy(),
        caller: CALLERS.popup,
        handlers: table,
        ids: testIds(),
        clock: testClock(),
      });
    /** @type {Command} */
    const command = { type: 'createNote', commandId: 'c1', noteId: 'n1', name: 'Kept' };
    assert.equal((await on(handlerTable({})).execute(command)).code, NOT_REGISTERED);
    assert.equal((await on(POPUP_HANDLERS).execute(command)).kind, 'committed');
  });

  it("a type the policy refuses on the surface is still the policy's not-on-surface, and logs nothing", async () => {
    const { kernel, logged } = kernelOf(POPUP_HANDLERS, CALLERS.popup);
    const outcome = await kernel.execute({
      type: 'applyRemoteChanges',
      commandId: 'c1',
      changes: [{ note: { id: 'r1' }, blocks: [] }],
    });
    assert.deepEqual([outcome.kind, outcome.kind === 'rejected' && outcome.code], ['rejected', 'not-on-surface']);
    const indexed = await kernel.query({ type: 'listVectors' });
    assert.deepEqual(indexed, { kind: 'failed', cause: 'policy', code: 'not-on-surface' });
    assert.deepEqual(logged, []);
  });

  it('a logger with no error method is told as a warning, and one that throws changes nothing the kernel answers', async () => {
    const warned = kernelOf(handlerTable({}), CALLERS.sidepanel, { error: false });
    const listed = await warned.kernel.query({ type: 'listNotes', view: 'sidePanel' });
    assert.deepEqual(listed, { kind: 'failed', cause: 'policy', code: NOT_REGISTERED });
    assert.deepEqual(warned.logged, [
      ['warn', 'handler-missing', { surface: 'sidepanel', type: 'listNotes', code: NOT_REGISTERED }],
    ]);

    const kernel = createKernel({
      adapter: createMemoryAdapter(),
      policy: createBaselinePolicy(),
      caller: CALLERS.popup,
      handlers: handlerTable({}),
      ids: testIds(),
      clock: testClock(),
      logger: {
        warn: () => {
          throw new Error('logger down');
        },
        error: () => {
          throw new Error('logger down');
        },
      },
    });
    assert.equal((await kernel.execute({ type: 'createNote', commandId: 'c1', noteId: 'n1' })).code, NOT_REGISTERED);
  });

  it('a root that maintains as it opens and lacks runStartupMaintenance never opens, and says why', async () => {
    /** @type {Array<[string, string]>} */
    const logged = [];
    const kernel = createKernel({
      adapter: createMemoryAdapter(),
      policy: createBaselinePolicy(WORKER_CATALOG),
      caller: CALLERS['worker-internal'],
      handlers: handlerTable(
        { commands: { captureToDailyNote: WORKER_HANDLERS.commands.captureToDailyNote } },
        WORKER_CATALOG,
      ),
      ids: testIds(),
      clock: testClock(),
      maintainOnOpen: true,
      logger: {
        warn: (/** @type {string} */ event) => logged.push(['warn', event]),
        error: (/** @type {string} */ event) => logged.push(['error', event]),
      },
    });
    const failure = await kernel.whenReady();
    assert.deepEqual(failure && [failure.kind, failure.cause, failure.code], [
      'unavailable',
      'storage',
      'maintenance-failed',
    ]);
    assert.deepEqual(logged, [
      ['error', 'handler-missing'],
      ['warn', 'storage-unavailable'],
    ]);
    // And every command after it answers that, the capture too
    const captured = await kernel.execute({
      type: 'captureToDailyNote',
      commandId: 'c1',
      noteId: 'n1',
      blockId: 'b1',
      capture: { type: 'text', content: 'kept' },
    });
    assert.deepEqual(
      [captured.kind, captured.kind === 'unavailable' && captured.code],
      ['unavailable', 'maintenance-failed'],
    );
  });

  it('a kernel built with no table is a bug in its root, found as it starts', () => {
    assert.throws(
      () =>
        createKernel(
          /** @type {any} */ ({
            adapter: createMemoryAdapter(),
            policy: createBaselinePolicy(),
            caller: CALLERS.popup,
            ids: testIds(),
          }),
        ),
      TypeError,
    );
  });
});
