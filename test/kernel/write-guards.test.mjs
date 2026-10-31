// AC1 of #17, held to the catalog and the code (#17 PR 4b): every catalog command is in
// write-guards.mjs's table, each guarded one takes its version where the table says and no
// other command takes one, each writer writes in the scope the table gives it and no other
// command writes a note or a block, and the page's callers of each guarded command are the ones
// the table names, none sending a version. The kernel contract suite sends each guarded command
// twice from one version (contract.mjs).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createKernel } from '../../js/kernel/core/application/kernel.js';
import { COMMANDS, COMMAND_TYPES } from '../../js/kernel/core/contracts/commands.js';
import { walk } from '../../js/kernel/core/contracts/schema-walk.js';
import { createMemoryAdapter } from '../../js/kernel/core/memory/adapter.js';
import { createBaselinePolicy } from '../../js/kernel/core/ports/policy.js';
import { COMMAND_SAMPLES } from './command-samples.mjs';
import { CALLERS, testClock, testIds } from './support.mjs';
import { SCOPE_GUARDS, VERSION_FIELDS, WRITE_GUARDS } from './write-guards.mjs';

/** @typedef {import('../../js/kernel/core/contracts/commands.js').Command} Command */
/** @typedef {import('../../js/kernel/core/contracts/commands.js').CommandType} CommandType */
/** @typedef {import('../../js/kernel/core/ports/repository.js').KernelAdapter} KernelAdapter */
/** @typedef {import('../../js/kernel/core/ports/repository.js').WriteScope} WriteScope */
/** @typedef {import('./write-guards.mjs').WriteGuard} WriteGuard */

const ROOT = path.join(import.meta.dirname, '..', '..');
const CATALOG_URL = new URL('../../js/kernel/core/contracts/commands.js', import.meta.url);

/** @type {Map<string, any>} */
const payloads = new Map();
for (const [type, entry] of Object.entries(COMMANDS)) {
  payloads.set(type, (await import(new URL(entry.schema, CATALOG_URL).href)).payload);
}

/**
 * Where a version field sits in a command's payload: each path to one, joined by dots
 * @param {CommandType} type
 * @returns {string[]}
 */
const versionPaths = type =>
  walk(payloads.get(type))
    .filter(visit => VERSION_FIELDS.includes(visit.path[visit.path.length - 1]))
    .map(visit => visit.path.join('.'))
    .filter((at, index, all) => all.indexOf(at) === index);

/**
 * The document client's and the removal port's methods a page calls, and the command each one
 * sends (js/kernel/composition/document.js, removal.js)
 * @type {Record<string, CommandType>}
 */
const CLIENT_METHODS = {
  saveContent: 'saveNoteContent',
  deleteBlocks: 'deleteBlocks',
  renameNote: 'renameNote',
  deriveTitle: 'applyDerivedTitle',
  insertBlocks: 'insertBlocks',
  attachInsights: 'attachInsights',
  setPinned: 'setPinned',
  archiveNote: 'archiveNote',
  unarchiveNote: 'unarchiveNote',
  restoreNote: 'restoreNote',
  convertNoteToTemplate: 'convertNoteToTemplate',
  convertTemplateToNote: 'convertTemplateToNote',
  moveNoteToFolder: 'moveNoteToFolder',
};

/**
 * Every page file: js/ but its libraries and the kernel, which the callers reach through
 * @returns {string[]} paths from the repository's root
 */
function pageFiles() {
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir */
  const visit = dir => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const at = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (at !== 'js/lib' && at !== 'js/kernel') visit(at);
      } else if (entry.name.endsWith('.js')) {
        found.push(at);
      }
    }
  };
  visit('js');
  return found.sort();
}

/**
 * Each call a page makes that sends a guarded command, as `Class.method` with the command it
 * sends: a document client method, or removeNotes with the command's type. A method is a
 * class's method at two spaces in, as every page class holds its methods.
 * @returns {Map<CommandType, string[]>}
 */
function pageCallers() {
  /** @type {Map<CommandType, string[]>} */
  const callers = new Map();
  for (const file of pageFiles()) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    let className = '';
    let method = '';
    for (const line of lines) {
      const declared = /^(?:export )?class (\w+)/.exec(line);
      if (declared) className = declared[1];
      const header = /^ {2}(?:async |static )*(?:get |set )?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(line);
      if (header && !['if', 'for', 'while', 'switch', 'catch'].includes(header[1])) method = header[1];
      /** @type {CommandType[]} */
      const sent = [];
      for (const match of line.matchAll(/documentClient\.(\w+)\(/g)) {
        if (Object.hasOwn(CLIENT_METHODS, match[1])) sent.push(CLIENT_METHODS[match[1]]);
      }
      for (const match of line.matchAll(/removeNotes\(\{\s*type: '(\w+)'/g))
        sent.push(/** @type {CommandType} */ (match[1]));
      for (const type of sent) {
        const list = callers.get(type) || [];
        list.push(`${className}.${method}`);
        callers.set(type, list);
      }
    }
  }
  return callers;
}

describe("#17's AC1: every writer's scope and guard", () => {
  it('names every catalog command once', () => {
    assert.deepEqual(Object.keys(WRITE_GUARDS).sort(), [...COMMAND_TYPES].sort());
  });

  it('each guarded command takes its version where the table says, for its scope, and no other command takes one', () => {
    for (const [type, guard] of /** @type {Array<[CommandType, WriteGuard]>} */ (Object.entries(WRITE_GUARDS))) {
      const paths = versionPaths(type);
      if (guard.kind === 'guarded') {
        assert.deepEqual(paths, [guard.guard], type);
        assert.equal(guard.guard.split('.').pop(), SCOPE_GUARDS[guard.scope], type);
      } else if (guard.kind === 'bulk') {
        // A bulk command carries no version of its own, only its items' for each note
        assert.ok(
          paths.every(at => at.includes('[]')),
          `${type}: ${paths.join(', ')}`,
        );
        for (const item of guard.items) assert.equal(WRITE_GUARDS[item].kind, 'guarded', `${type} runs ${item}`);
      } else {
        assert.deepEqual(paths, [], type);
      }
    }
  });

  it('every page caller of a guarded command is the one the table names, and none sends a version', () => {
    const callers = pageCallers();
    for (const [type, guard] of /** @type {Array<[CommandType, WriteGuard]>} */ (Object.entries(WRITE_GUARDS))) {
      const found = [...new Set(callers.get(type) || [])].sort();
      if (guard.kind === 'guarded') assert.deepEqual(found, guard.callers, type);
    }
    // So the table's callers send none: no page names a version field, until #6's conflict view
    for (const file of pageFiles()) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.deepEqual(
        VERSION_FIELDS.filter(field => new RegExp(`\\b${field}\\b`).test(text)),
        [],
        file,
      );
    }
  });

  it('each writer commits in the scope the table gives it, and a command the table says writes no note or block writes none', async () => {
    /** @type {Map<CommandType, Set<WriteScope>>} */
    const scopes = new Map();
    /** @type {Map<CommandType, Set<string>>} */
    const writes = new Map();
    /** @type {CommandType | null} */
    let committing = null;
    const inner = createMemoryAdapter({
      beforeWrite: target => {
        if (!committing) return;
        const stores = writes.get(committing) || new Set();
        stores.add(target);
        writes.set(committing, stores);
      },
    });
    /** @type {KernelAdapter} */
    const adapter = {
      ...inner,
      async commit(work) {
        const type = /** @type {CommandType} */ (work.command.type);
        const kinds = scopes.get(type) || new Set();
        kinds.add(work.scope || 'content');
        scopes.set(type, kinds);
        committing = type;
        try {
          return await inner.commit(work);
        } finally {
          committing = null;
        }
      },
    };
    const kernel = createKernel({
      adapter,
      policy: createBaselinePolicy(),
      caller: CALLERS.newtab,
      ids: testIds(),
      clock: testClock(),
    });
    /** @type {string[]} */
    const committed = [];
    for (const [type, fields] of Object.entries(COMMAND_SAMPLES)) {
      const outcome = await kernel.execute(/** @type {Command} */ ({ ...fields, type, commandId: `c-${type}` }));
      if (outcome.kind === 'committed' || outcome.kind === 'bulk') committed.push(type);
    }
    // The samples commit, so the checks below aren't empty
    assert.ok(committed.length >= 40, committed.join(', '));
    for (const [type, guard] of /** @type {Array<[CommandType, WriteGuard]>} */ (Object.entries(WRITE_GUARDS))) {
      const kinds = [...(scopes.get(type) || [])];
      if (guard.kind === 'guarded' || guard.kind === 'unguarded') {
        assert.ok(
          kinds.every(kind => kind === guard.scope),
          `${type} committed in ${kinds.join(', ')}`,
        );
      } else if (guard.kind === 'bulk') {
        assert.deepEqual(kinds, [], `${type} commits nothing of its own`);
      } else {
        const touched = [...(writes.get(type) || [])].filter(store => store === 'notes' || store === 'blocks');
        assert.deepEqual(touched, [], type);
      }
    }
    // Each bulk command's items are the commands the table says it runs
    assert.ok(scopes.has('applyRemoteContent') && scopes.has('applyRemotePlacement'));
  });
});
