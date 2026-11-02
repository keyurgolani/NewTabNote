// Each page's kernel runs the table of handlers its composition root gives it (#17 PR 4b, the
// lead's ruling on Popup's and Side Panel's start; core/application/handlers.js). Each table
// holds every command and query its page sends, read from the modules the page loads, so a
// page that sends one its table lacks fails here, never in a user's hands. Popup's, Side
// Panel's and the worker's tables hold nothing else, so neither Popup's nor Side Panel's start
// loads the remote apply or the index commands. A table that holds a bulk command holds its
// refusal too. A command or query the policy allows that a table lacks is refused as
// not-registered and logged as an error, never run.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { ALL_HANDLERS, NEWTAB_HANDLERS } from '../../js/kernel/core/application/handlers-all.js';
import { POPUP_HANDLERS } from '../../js/kernel/core/application/handlers-popup.js';
import { SIDEPANEL_HANDLERS } from '../../js/kernel/core/application/handlers-sidepanel.js';
import { WORKER_HANDLERS } from '../../js/kernel/core/application/handlers-worker.js';
import { handlerTable } from '../../js/kernel/core/application/handlers.js';
import { NOT_REGISTERED, createKernel } from '../../js/kernel/core/application/kernel.js';
import { COMMANDS, COMMAND_TYPES } from '../../js/kernel/core/contracts/commands.js';
import { QUERIES, QUERY_TYPES } from '../../js/kernel/core/contracts/queries.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { reachGraph } from './import-graph.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';

/** @typedef {import('../../js/kernel/core/application/handlers.js').HandlerTable} HandlerTable */
/** @typedef {import('../../js/kernel/core/contracts/surfaces.js').Surface} Surface */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').Command} Command */

const ROOT = path.join(import.meta.dirname, '..', '..');

/** Every command and query type the catalog has */
/** @type {ReadonlySet<string>} */
const CATALOG_TYPES = new Set([...COMMAND_TYPES, ...QUERY_TYPES]);

/**
 * Each page with a kernel: the modules its HTML loads, its surface, its root's table, and
 * whether its root runs startup maintenance as the kernel opens, which sends
 * runStartupMaintenance from the kernel itself (kernel.js, maintain)
 * @type {ReadonlyArray<{page: string, entries: string[], surface: Surface, table: HandlerTable, maintains: boolean}>}
 */
const PAGES = [
  { page: 'Popup', entries: ['js/popup.js'], surface: 'popup', table: POPUP_HANDLERS, maintains: false },
  {
    page: 'Side Panel',
    entries: ['js/sidepanel.js', 'js/insights-summary.js'],
    surface: 'sidepanel',
    table: SIDEPANEL_HANDLERS,
    maintains: false,
  },
  {
    page: 'the service worker',
    entries: ['js/background.js'],
    surface: 'worker-internal',
    table: WORKER_HANDLERS,
    maintains: true,
  },
  {
    page: 'the new tab',
    entries: ['js/entries/newtab.js'],
    surface: 'newtab',
    table: NEWTAB_HANDLERS,
    maintains: true,
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
 * What `files` send to a kernel, as the scan reads them: every catalog type an object's `type`
 * names as a string, wherever the object is built, apart from the kernel's own; and, as
 * file:line, what it can't read: an `.execute({...})` or `.query({...})` whose object's type
 * isn't a string (computed, shorthand, or behind a spread), and a catalog type's name in any
 * other string but another property's key or value, which names something else: a table's key,
 * BULK_ACTIONS' item commands, a change op's name. A call handed a variable is read where its
 * object is built, as the worker's client forwards what js/background.js builds. It finds a
 * send a table lacks by accident, not one written to get past it. `readFile` reads a module's
 * text, from disk unless given, so a test can plant a send.
 * @param {string[]} files
 * @param {{readFile?: (file: string) => string}} [options]
 * @returns {{types: Set<string>, own: Set<string>, unread: string[]}}
 */
function sendsIn(files, { readFile = file => fs.readFileSync(file, 'utf8') } = {}) {
  /** @type {Set<string>} */
  const types = new Set();
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
      if (ts.isStringLiteralLike(node) && CATALOG_TYPES.has(node.text)) {
        const { parent } = node;
        if (!ts.isPropertyAssignment(parent)) unread.push(at(node));
        else if (parent.initializer === node && isTypeName(parent.name)) (file === KERNEL ? own : types).add(node.text);
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
  return { types, own, unread };
}

/** @param {HandlerTable} table */
const registered = table => new Set([...Object.keys(table.commands), ...Object.keys(table.queries)]);

/**
 * The bulk commands `table` holds without their refusal, which turns down one refused for its
 * payload before the adapter recalls it, so its commandId isn't reserved (kernel.js)
 * @param {HandlerTable} table
 */
const bulkWithoutRefusal = table =>
  Object.keys(table.commands).filter(
    type => COMMANDS[/** @type {keyof typeof COMMANDS} */ (type)].bulk && !Object.hasOwn(table.refusals, type),
  );

/**
 * Whether the catalog lets `surface` send `type`
 * @param {string} type
 * @param {Surface} surface
 */
const allowedOn = (type, surface) => {
  const entry = Object.hasOwn(COMMANDS, type)
    ? COMMANDS[/** @type {keyof typeof COMMANDS} */ (type)]
    : QUERIES[/** @type {keyof typeof QUERIES} */ (type)];
  return entry.surfaces.includes(surface);
};

describe("each page's kernel registers what its page sends (#17 PR 4b)", () => {
  /**
   * What a page sends: what its modules send, and the kernel's own maintenance when its root
   * runs it as the kernel opens
   * @param {{entries: string[], maintains: boolean}} page
   */
  const sentBy = ({ entries, maintains }) => {
    const { types, own, unread } = sendsIn(pageModules(entries));
    return { sent: new Set([...types, ...(maintains ? own : [])]), own, unread };
  };

  for (const { page, entries, surface, table, maintains } of PAGES) {
    it(`${page}: its table holds every command and query its code and its root send`, () => {
      const { sent, own, unread } = sentBy({ entries, maintains });
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
          [...CATALOG_TYPES].filter(type => allowedOn(type, 'newtab')).sort(),
        );
      } else {
        assert.deepEqual(unread, [], `${page} sends what the scan can't read`);
      }
    });

    if (surface !== 'newtab') {
      it(`${page}: its table holds nothing else, so its start loads no handler it never runs`, () => {
        assert.deepEqual([...registered(table)].sort(), [...sentBy({ entries, maintains }).sent].sort());
      });
    }

    it(`${page}: the catalog allows on ${surface} every type its table holds, and each bulk command it holds comes with its refusal`, () => {
      assert.deepEqual(
        [...registered(table)].filter(type => !allowedOn(type, surface)),
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
    const read = sendsIn(['page.js', KERNEL], { readFile: file => (file === KERNEL ? kernel : page) });
    assert.deepEqual([...read.types].sort(), ['createNote', 'listNotes']);
    assert.deepEqual([...read.own], ['runStartupMaintenance']);
    // The spread, the shorthand type, the type read from a name, its call and its string, and a
    // type set on an object after it's built
    assert.deepEqual(
      read.unread.map(at => at.slice(at.lastIndexOf(':') + 1)),
      ['5', '6', '7', '7', '10'],
    );
  });

  it("ALL_HANDLERS, the tests' table, holds every command and query the catalog has", () => {
    assert.deepEqual([...registered(ALL_HANDLERS)].sort(), [...CATALOG_TYPES].sort());
    assert.deepEqual(Object.keys(ALL_HANDLERS.refusals).sort(), ['applyRemoteChanges', 'runBulkAction']);
    assert.deepEqual(bulkWithoutRefusal(ALL_HANDLERS), []);
  });

  it("the close-time drafts' apply is in the table of each page whose root applies them: the new tab's, Popup's and Side Panel's (#33)", () => {
    for (const { page, entries, surface, table, maintains } of PAGES) {
      const applies = surface !== 'worker-internal';
      assert.equal(sentBy({ entries, maintains }).sent.has('applyCloseDraft'), applies, `${page} ${applies ? 'sends' : "doesn't send"} it`);
      assert.equal(registered(table).has('applyCloseDraft'), applies, `${page}'s table ${applies ? 'holds' : "doesn't hold"} it`);
    }
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
      policy: createBaselinePolicy(),
      caller: CALLERS['worker-internal'],
      handlers: handlerTable({ commands: { captureToDailyNote: WORKER_HANDLERS.commands.captureToDailyNote } }),
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
